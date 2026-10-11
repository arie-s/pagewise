const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function loadMainHandlers(overrides = {}) {
  const handlers = new Map();
  const app = {
    whenReady: () => ({ then: () => {} }),
    on: () => {}, quit: () => {}, exit: () => {}, getPath: () => root
  };
  const electron = {
    app, BrowserWindow: class {}, ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: () => {} },
    dialog: {}, Menu: {}, shell: {}, clipboard: {}, net: {}, ...overrides.electron
  };
  const source = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
  const pdfLib = require('@cantoo/pdf-lib');
  const pdfDocumentFacade = Object.create(pdfLib.PDFDocument);
  pdfDocumentFacade.create = async (...args) => {
      const doc = await pdfLib.PDFDocument.create(...args);
      const addPage = doc.addPage.bind(doc);
      doc.addPage = size => addPage(Array.isArray(size) ? Array.from(size) : size);
      return doc;
  };
  const wrappedPdfLib = { ...pdfLib, PDFDocument: pdfDocumentFacade };
  const context = {
    require(name) {
      if (name === 'electron') return electron;
      if (name === '@cantoo/pdf-lib') return wrappedPdfLib;
      return require(name);
    },
    __dirname: path.join(root, 'src'), __filename: path.join(root, 'src/main.js'),
    process: { ...process, argv: ['node', 'main.js'] }, Buffer, Array, console,
    setTimeout, clearTimeout, setInterval, clearInterval, globalThis: {}
  };
  vm.runInNewContext(source, context, { filename: 'src/main.js' });
  return { handlers, context, electron };
}

function extractFunction(source, name) {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`, 'g');
  const match = re.exec(source);
  if (!match) throw new Error(`Function ${name} not found`);
  const open = source.indexOf('{', re.lastIndex);
  let depth = 0, quote = null, lineComment = false, blockComment = false, escaped = false;
  for (let i = open; i < source.length; i++) {
    const c = source[i], n = source[i + 1];
    if (lineComment) { if (c === '\n') lineComment = false; continue; }
    if (blockComment) { if (c === '*' && n === '/') { blockComment = false; i++; } continue; }
    if (quote) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && n === '/') { lineComment = true; i++; continue; }
    if (c === '/' && n === '*') { blockComment = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) return source.slice(match.index, i + 1);
  }
  throw new Error(`Unbalanced function ${name}`);
}

function loadRendererFunctions(names, { state = {}, api = {}, elements = {}, extra = {}, helperNames = [] } = {}) {
  const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error('Renderer script not found');
  const declarations = [...helperNames, ...names].map(name => extractFunction(script, name)).join('\n');
  const context = {
    state,
    window: { pdfAPI: api },
    document: { getElementById: id => elements[id] || (elements[id] = { textContent: '', innerHTML: '', value: '', disabled: false, classList: { toggle() {}, add() {}, remove() {} } }), ...extra.document },
    console, Buffer, Uint8Array, atob: s => Buffer.from(s, 'base64').toString('binary'),
    confirm: () => true, setTimeout: () => 0, ...extra
  };
  context.$ = id => context.document.getElementById(id);
  vm.runInNewContext(`${declarations}\n;globalThis.__functions = { ${names.join(', ')} };`, context);
  return { functions: context.__functions, context, state, elements };
}

module.exports = { root, loadMainHandlers, extractFunction, loadRendererFunctions };

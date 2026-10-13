const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { root, loadRendererFunctions } = require('./helpers.cjs');

const inert = async () => {};
const basicDeps = state => ({
  setLoading: () => {}, showNotification: () => {}, updateUIState: () => {},
  setUnsavedChanges: value => { state.hasUnsavedChanges = value; },
  renderThumbnails: inert, renderAllPages: inert, goToPage: () => {},
  updateUndoRedo: () => {}, updateAnnotationCount: () => {},
  pdfjsLib: { getDocument: ({ data }) => ({ promise: Promise.resolve({ numPages: 1, data, destroy: inert }) }) }
});

test('saveDocument reports cancel and save failures as false and success as true', async () => {
  const state = { pdfDoc: { numPages: 1 }, originalData: 'AQ==', filePath: null, fileName: 'draft.pdf', currentPage: 1, annotations: {}, redactionMarks: {}, textEdits: {}, undoStack: [], redoStack: [], hasUnsavedChanges: true };
  const results = [
    { success: false, canceled: true },
    { success: false, error: 'disk error' },
    { success: true, path: '/tmp/draft.pdf' }
  ];
  const { functions } = loadRendererFunctions(['saveDocument'], {
    state,
    api: { saveFileAs: async () => results.shift() },
    extra: { ...basicDeps(state), buildDocumentData: async () => 'AQ==', collectModifications: () => [] }
  });
  assert.equal(await functions.saveDocument(), false);
  assert.equal(await functions.saveDocument(), false);
  assert.equal(await functions.saveDocument(), true);
  assert.equal(state.hasUnsavedChanges, false);
});

test('an in-flight save blocks duplicate saves and document replacement without discarding edits', async () => {
  const state = { pdfDoc: { numPages: 1 }, originalData: 'OLD', filePath: null, fileName: 'draft.pdf', currentPage: 1,
    annotations: { 1: ['pending'] }, redactionMarks: { 1: ['mark'] }, hasUnsavedChanges: true };
  let finishBuild, builds = 0, dialogs = 0;
  const { functions } = loadRendererFunctions(['saveDocument', 'confirmDocumentReplacement'], {
    state, api: {
      saveFileAs: async () => ({ success: false, canceled: true }),
      showMessageBox: async () => { dialogs++; return { response: 1 }; }
    },
    extra: { ...basicDeps(), buildDocumentData: () => { builds++; return new Promise(resolve => { finishBuild = resolve; }); } }
  });
  const pendingSave = functions.saveDocument();
  assert.equal(await functions.saveDocument(), false);
  assert.equal(await functions.confirmDocumentReplacement(), false);
  assert.equal(builds, 1);
  assert.equal(dialogs, 0);
  finishBuild('AQ==');
  assert.equal(await pendingSave, false);
  assert.equal(state.saving, false);
  assert.equal(state.originalData, 'OLD');
  assert.deepEqual(state.annotations, { 1: ['pending'] });
  assert.deepEqual(state.redactionMarks, { 1: ['mark'] });
  assert.equal(state.hasUnsavedChanges, true);
});

test('a page mutation informs the close guard before rendering the changed document', async () => {
  const state = { pdfDoc: { numPages: 3 }, originalData: 'OLD', currentPage: 1,
    annotations: {}, redactionMarks: {}, textEdits: {}, undoStack: [], redoStack: [], hasUnsavedChanges: false };
  const flags = [];
  const { functions } = loadRendererFunctions(['deletePage'], {
    state, helperNames: ['remapForReorder', 'setUnsavedChanges'],
    api: { applyModifications: async () => ({ success: true, data: 'AQ==' }), setUnsaved: flag => flags.push(flag) },
    extra: { ...basicDeps(), pdfjsLib: { getDocument: () => ({ promise: Promise.resolve({ numPages: 2 }) }) },
      renderThumbnails: async () => { assert.deepEqual(flags, [true]); assert.equal(state.hasUnsavedChanges, true); } }
  });
  await functions.deletePage();
  assert.deepEqual(flags, [true]);
});

test('loadPdf checks replacement and parses the new PDF before committing it', async () => {
  const oldDoc = { numPages: 3, destroy: inert };
  const state = { pdfDoc: oldDoc, originalData: 'OLD', filePath: '/old.pdf', fileName: 'old.pdf', hasUnsavedChanges: true,
    annotations: { 1: ['old'] }, redactionMarks: { 1: ['mark'] }, textEdits: { 1: ['edit'] }, undoStack: ['undo'], redoStack: ['redo'] };
  let allow = false;
  let parse = true;
  const nextDoc = { numPages: 1, destroy: inert };
  const { functions } = loadRendererFunctions(['loadPdf'], {
    state,
    api: {},
    extra: { ...basicDeps(state), confirmDocumentReplacement: async () => allow,
      pdfjsLib: { getDocument: () => ({ promise: parse ? Promise.resolve(nextDoc) : Promise.reject(new Error('bad PDF')) }) } }
  });
  assert.equal(await functions.loadPdf({ data: 'AQ==', path: '/new.pdf', name: 'new.pdf' }), false);
  assert.equal(state.originalData, 'OLD');
  assert.equal(state.pdfDoc, oldDoc);
  allow = true;
  parse = false;
  assert.equal(await functions.loadPdf({ data: 'AQ==', path: '/new.pdf', name: 'new.pdf' }), false);
  assert.equal(state.originalData, 'OLD');
  assert.equal(state.pdfDoc, oldDoc);
  parse = true;
  assert.equal(await functions.loadPdf({ data: 'AQ==', path: '/new.pdf', name: 'new.pdf' }), true);
  assert.equal(state.pdfDoc, nextDoc);
  assert.equal(Object.keys(state.redactionMarks).length, 0);
  assert.equal(Object.keys(state.textEdits).length, 0);
  assert.equal(state.undoStack.length, 0);
  assert.equal(Object.keys(state.annotations).length, 0);
});

test('confirmDocumentReplacement returns an explicit decision for unsaved work', async () => {
  const answers = [{ response: 2 }, { response: 1 }, { response: 0 }];
  const { functions } = loadRendererFunctions(['confirmDocumentReplacement'], {
    state: { hasUnsavedChanges: true },
    api: { showMessageBox: async () => answers.shift() },
    extra: { saveDocument: async () => false }
  });
  assert.equal(await functions.confirmDocumentReplacement(), false);
  assert.equal(await functions.confirmDocumentReplacement(), true);
  assert.equal(await functions.confirmDocumentReplacement(), false);
});

test('Split uses the document fileName when no file path is available', async () => {
  const state = { pdfDoc: { numPages: 3 }, fileName: 'annual.pdf', filePath: null };
  let captured;
  let saved;
  const { functions } = loadRendererFunctions(['showSplitDialog'], {
    state,
    api: {
      splitPdf: async request => { captured = request; return { success: true, files: [{ name: 'part-1.pdf', data: 'AQ==' }] }; },
      saveMultipleFiles: async request => { saved = request.files; return { success: true, folder: '/tmp' }; }
    },
    extra: { buildDocumentData: async () => 'AQ==', setLoading: () => {}, showNotification: () => {},
      showModal: (_title, _content, buttons) => {
        const values = { 'input[name=splitMode]:checked': { value: 'every' }, '#splitEvery': { value: '2' } };
        buttons[1].handler({ querySelector: key => values[key] });
      } }
  });
  await functions.showSplitDialog();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(captured.ranges)), [{ start: 1, end: 2 }, { start: 3, end: 3 }]);
  assert.equal(saved[0].name, 'annual_part-1.pdf');
});

test('document properties place metadata into DOM properties, never HTML attributes', async () => {
  const dangerous = `Title <img src=x onerror="alert(1)">`;
  const nodes = Object.fromEntries(['propTitle', 'propAuthor', 'propSubject', 'propPages', 'propCreator'].map(id => [id, { value: '', textContent: '' }]));
  let modalContent = '';
  const { functions } = loadRendererFunctions(['showDocumentProperties'], {
    state: { originalData: 'AQ==' },
    api: { getDocumentInfo: async () => ({ success: true, info: { title: dangerous, author: 'A', subject: 'S', pageCount: 7, creator: dangerous } }) },
    extra: { showNotification: () => {}, showModal: (_title, content) => {
      modalContent = content;
      return { querySelector: selector => nodes[selector.slice(1)] };
    } }
  });
  await functions.showDocumentProperties();
  assert.equal(modalContent.includes(dangerous), false);
  assert.equal(nodes.propTitle.value, dangerous);
  assert.equal(nodes.propCreator.textContent, dangerous);
  assert.equal(nodes.propPages.textContent, 7);
});

test('every main-process menu action reaches a preload and renderer subscription', () => {
  const main = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'src/preload.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
  const events = [...new Set([...main.matchAll(/\.send\('(menu-[^']+)'/g)].map(match => match[1]))];
  for (const event of events) {
    if (event === 'menu-quit-save') {
      assert.match(preload, /onQuitSave:/);
      assert.match(html, /\.onQuitSave\(/);
      continue;
    }
    const method = 'onMenu' + event.slice(5).split('-').map(part => part[0].toUpperCase() + part.slice(1)).join('');
    assert.match(preload, new RegExp(`${method}:`), `${event} is exposed by preload`);
    assert.ok(html.includes(`${method}(`), `${event} is connected by the renderer`);
  }
});

test('page delete and insert operations remap edits and discard old undo snapshots', async () => {
  for (const operation of ['deletePage', 'insertBlankPage', 'showInsertFromFile']) {
    const inserting = operation !== 'deletePage';
    const state = {
      pdfDoc: { numPages: 3 }, originalData: 'AQ==', currentPage: operation === 'deletePage' ? 2 : 1,
      annotations: { 1: ['a1'], 2: ['a2'], 3: ['a3'] },
      redactionMarks: { 1: ['r1'], 2: ['r2'], 3: ['r3'] },
      textEdits: { '1-0': 't1', '2-0': 't2', '3-0': 't3' },
      undoStack: ['stale undo'], redoStack: ['stale redo'], hasUnsavedChanges: false
    };
    let loadedPageCount = inserting ? (operation === 'showInsertFromFile' ? 4 : 4) : 2;
    const api = {
      applyModifications: async () => ({ success: true, data: 'AQ==' }),
      openMultipleFiles: async () => [{ data: 'Ag==' }],
      insertPagesFromFile: async () => ({ success: true, data: 'AQ==' }),
      getDocumentInfo: async () => ({ success: true, info: { pageCount: 4 } })
    };
    const { functions } = loadRendererFunctions([operation], {
      state, api, helperNames: ['remapForReorder'],
      extra: {
        pdfjsLib: { getDocument: () => ({ promise: Promise.resolve({ numPages: loadedPageCount }) }) },
        confirm: () => true, setLoading: () => {}, setUnsavedChanges: value => { state.hasUnsavedChanges = value; },
        showNotification: () => {}, updateUndoRedo: () => {}, renderThumbnails: inert, renderAllPages: inert, goToPage: () => {}
      }
    });
    await functions[operation]();
    const expected = operation === 'deletePage' ? [1, 3] : [1, 2, 3];
    const mappedPages = operation === 'deletePage' ? [1, 2] : [1, 3, 4];
    assert.equal(state.pdfDoc.numPages, loadedPageCount, `${operation} loads the changed document`);
    for (let i = 0; i < expected.length; i++) {
      const sourcePage = expected[i], targetPage = mappedPages[i];
      assert.deepEqual(state.annotations[targetPage], [`a${sourcePage}`], `${operation} remaps annotations`);
      assert.deepEqual(state.redactionMarks[targetPage], [`r${sourcePage}`], `${operation} remaps redactions`);
      assert.equal(state.textEdits[`${targetPage}-0`], `t${sourcePage}`, `${operation} remaps text edits`);
    }
    assert.equal(state.undoStack.length, 0);
    assert.equal(state.redoStack.length, 0);
  }
});

test('undo and redo restore redaction marks with annotations and text edits', async () => {
  const state = {
    annotations: { 1: [{ id: 'old annotation' }] },
    redactionMarks: { 1: [{ id: 'old redaction' }] },
    textEdits: { '1-0': 'old edit' }, undoStack: [], redoStack: [], hasUnsavedChanges: false
  };
  const { functions } = loadRendererFunctions(['saveState', 'undo', 'redo'], {
    state, helperNames: ['editSnapshot'],
    extra: { setUnsavedChanges: flag => { state.hasUnsavedChanges = flag; }, updateUndoRedo: () => {},
      renderAllPages: inert, updateAnnotationCount: () => {} }
  });
  functions.saveState();
  state.annotations = { 1: [{ id: 'new annotation' }] };
  state.redactionMarks = { 1: [{ id: 'new redaction' }] };
  state.textEdits = { '1-0': 'new edit' };

  await functions.undo();
  assert.deepEqual(JSON.parse(JSON.stringify(state.annotations)), { 1: [{ id: 'old annotation' }] });
  assert.deepEqual(JSON.parse(JSON.stringify(state.redactionMarks)), { 1: [{ id: 'old redaction' }] });
  assert.deepEqual(JSON.parse(JSON.stringify(state.textEdits)), { '1-0': 'old edit' });

  await functions.redo();
  assert.deepEqual(JSON.parse(JSON.stringify(state.annotations)), { 1: [{ id: 'new annotation' }] });
  assert.deepEqual(JSON.parse(JSON.stringify(state.redactionMarks)), { 1: [{ id: 'new redaction' }] });
  assert.deepEqual(JSON.parse(JSON.stringify(state.textEdits)), { '1-0': 'new edit' });
});

test('save-then-quit only force-closes after saveDocument returns true', async () => {
  const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
  const match = html.match(/window\.pdfAPI\.onQuitSave\((async\s*\(\)\s*=>\s*\{[\s\S]*?\})\);/);
  assert.ok(match, 'renderer registers the quit-save callback');
  const calls = [];
  const { context } = loadRendererFunctions([], { extra: {
    saveDocument: async () => false,
    window: { pdfAPI: { onQuitSave: fn => calls.push(fn), forceClose: async () => calls.push('close') } }
  } });
  vmRunQuitCallback(match[1], context);
  await calls[0]();
  assert.deepEqual(calls, [calls[0]]);
});

function vmRunQuitCallback(callbackSource, context) {
  const vm = require('node:vm');
  vm.runInNewContext(`window.pdfAPI.onQuitSave(${callbackSource});`, context);
}

test('extractScale renders small images at their own size, never above 2x, never blurs text pages, and caps at 4 MP', async () => {
  const OPS = { showText: 44, showSpacedText: 45, paintImageXObject: 85 };
  const mod = await import(require('node:url').pathToFileURL(path.join(root, 'src/extract-scale.mjs')).href);
  const functions = { extractScale: page => mod.extractScale(page, OPS) };
  const page = (w, h, ops) => ({
    getViewport: ({ scale }) => ({ width: w * scale, height: h * scale }),
    getOperatorList: async () => ({ fnArray: ops.map(o => o[0]), argsArray: ops.map(o => o[1]) })
  });
  const img = (w, h) => [OPS.paintImageXObject, ['img', w, h]], text = [OPS.showText, []];
  const px = async (w, h, ops) => { const s = await functions.extractScale(page(w, h, ops)); return Math.round(w * s) * Math.round(h * s); };
  const near = (a, b) => assert.ok(Math.abs(a - b) / b < 0.01, `${a} vs ${b}`);
  // vector text page keeps the old 2x
  assert.equal(await functions.extractScale(page(612, 792, [text])), 2);
  // small screenshot is rendered at its own size, not upscaled
  near(await px(792, 594, [img(800, 600)]), 800 * 600);
  // 12 MP phone photo stays at 2x (higher renders read no better and are much slower)
  assert.equal(await functions.extractScale(page(792, 594, [img(4032, 3024)])), 2);
  // low-res logo on a text page does not lower the scale
  assert.equal(await functions.extractScale(page(612, 792, [text, img(100, 100)])), 2);
  // low-res scan with an invisible OCR text layer is not lowered (text present)
  assert.equal(await functions.extractScale(page(612, 792, [img(600, 800), text])), 2);
  // a huge vector page is scaled down to the cap instead of overflowing the context
  near(await px(2000, 3000, [text]), 4e6);
});

test('openDroppedFiles converts dropped images and loads them without a path; mixed drops only warn', async () => {
  class FileReaderStub { readAsDataURL(f) { this.result = 'data:;base64,' + f.b64; setTimeout_(() => this.onload()); } }
  const setTimeout_ = fn => Promise.resolve().then(fn);
  const calls = { convert: null, loaded: [], notes: [] };
  const mk = (name, b64) => ({ name, b64 });
  const { functions } = loadRendererFunctions(['openDroppedFiles'], {
    api: { imagesToPdf: async files => { calls.convert = files; return { success: true, data: 'UERG', name: 'a.pdf' }; } },
    extra: { FileReader: FileReaderStub, loadPdf: async r => { calls.loaded.push(r); }, showNotification: (m, t) => calls.notes.push([m, t]) }
  });
  await functions.openDroppedFiles([mk('a.png', 'QQ=='), mk('b.jpg', 'Qg==')]);
  assert.equal(JSON.stringify(calls.convert), JSON.stringify([{ name: 'a.png', data: 'QQ==' }, { name: 'b.jpg', data: 'Qg==' }]));
  assert.equal(JSON.stringify(calls.loaded), JSON.stringify([{ data: 'UERG', path: null, name: 'a.pdf' }]));
  await functions.openDroppedFiles([mk('a.pdf', 'QQ=='), mk('b.png', 'Qg==')]);
  assert.equal(calls.loaded.length, 1);
  assert.equal(JSON.stringify(calls.notes.at(-1)), JSON.stringify(['Drop one PDF, or one or more PNG/JPEG images', 'warning']));
});

test('runSmartExtract goes straight to extraction when the engine is installed but not running', async () => {
  let setup = 0, extracted = 0;
  const page = { getViewport: ({ scale }) => ({ width: scale, height: scale }), render: () => ({ promise: Promise.resolve() }) };
  const { functions } = loadRendererFunctions(['runSmartExtract'], {
    helperNames: ['needScanModel'],
    state: { pdfDoc: { numPages: 1, getPage: async () => page } },
    api: { engineStatus: async () => ({ installed: true, running: false }), smartExtract: async () => { extracted++; return { success: false, error: 'x' }; } },
    extra: {
      setLoading: () => {}, showNotification: () => {}, showEngineSetup: () => { setup++; }, extractScale: async () => 1, pdfjsLib: { OPS: {} },
      document: { getElementById: () => ({}), createElement: () => ({ getContext: () => ({}), toDataURL: () => 'data:image/png;base64,AQ==' }) }
    }
  });
  await functions.runSmartExtract();
  assert.equal(setup, 0);
  assert.equal(extracted, 1);
});

test('runSmartExtract asks for an engine update when files exist but the install is outdated', async () => {
  const setups = [];
  const { functions } = loadRendererFunctions(['runSmartExtract'], {
    helperNames: ['needScanModel'],
    state: { pdfDoc: { numPages: 1 } },
    api: { engineStatus: async () => ({ installed: false, hasFiles: true }) },
    extra: { setLoading: () => {}, showNotification: () => {}, showEngineSetup: o => setups.push(o) }
  });
  await functions.runSmartExtract();
  assert.equal(setups.length, 1);
  assert.equal(setups[0].focus, 'scan');
  assert.match(setups[0].reason, /Scan reading model needs a small update/);
});

function extractResultHarness(tables, over = {}) {
  const fake = () => ({ children: [], style: {}, appendChild(c) { this.children.push(c); }, append(...c) { this.children.push(...c); }, remove() { this.removed = true; } });
  const container = fake(), calls = { copied: [], exported: [], md: [], notes: [] };
  const { functions } = loadRendererFunctions(['showExtractResult'], {
    state: { fileName: 'scan.pdf' },
    api: { extractTables: async () => tables, copyToClipboard: t => calls.copied.push(t), copyTables: async t => { calls.copied.push(t); },
      exportTables: async o => { calls.exported.push(o); return over.exportResult || { success: true }; },
      saveMarkdown: async o => { calls.md.push(o); return { success: true }; } },
    elements: { modalContainer: container },
    extra: { showNotification: (m, t) => calls.notes.push([m, t]), document: { createElement: () => fake(), getElementById: () => container } }
  });
  const buttons = () => {
    const out = {}, walk = n => { if (n.className?.startsWith('modal-btn')) out[n.textContent] = n; (n.children || []).forEach(walk); };
    walk(container); return out;
  };
  return { functions, container, calls, buttons };
}

test('showExtractResult offers table copy/export and saves markdown', async () => {
  const tables = [{ page: 1, rows: [['a', 'b\tc'], ['d\ne', '']] }, { page: 2, rows: [['x']] }];
  const h = extractResultHarness(tables);
  const pages = [{ page: 1, text: 'one' }, { page: 2, text: 'two' }];
  await h.functions.showExtractResult(pages);
  const b = h.buttons();
  assert.deepEqual(Object.keys(b), ['Copy', 'Copy table', 'Export CSV (2 tables)', 'Export Excel', 'Save Markdown', 'Close']);
  await b['Copy table'].onclick();
  assert.equal(h.calls.copied[0], tables);
  await b['Export CSV (2 tables)'].onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.exported)), [{ tables, baseName: 'scan' }]);
  assert.deepEqual(h.calls.notes.at(-1), ['Exported 2 table(s)', undefined]);
  await b['Save Markdown'].onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.md)), [{ text: '## Page 1\n\none\n\n---\n\n## Page 2\n\ntwo', baseName: 'scan' }]);
});

test('showExtractResult stays silent on export cancel and reports errors', async () => {
  const h = extractResultHarness([{ page: 1, rows: [['a']] }], { exportResult: { success: false, canceled: true } });
  await h.functions.showExtractResult([{ page: 1, text: 't' }]);
  const b = h.buttons();
  assert.ok(b['Export CSV']);
  await b['Export CSV'].onclick();
  assert.equal(h.calls.notes.length, 0);
  const e = extractResultHarness([{ page: 1, rows: [['a']] }], { exportResult: { success: false, error: 'disk full' } });
  await e.functions.showExtractResult([{ page: 1, text: 't' }]);
  await e.buttons()['Export CSV'].onclick();
  assert.deepEqual(e.calls.notes[0], ['Export error: disk full', 'error']);
});

test('showExtractResult hides table buttons without tables and shows model text as text', async () => {
  const h = extractResultHarness([]);
  const evil = '<img src=x onerror=alert(1)>';
  await h.functions.showExtractResult([{ page: 1, text: evil }]);
  assert.deepEqual(Object.keys(h.buttons()), ['Copy', 'Save Markdown', 'Close']);
  const find = n => n.tagName === undefined && n.textContent?.includes(evil) ? n : (n.children || []).map(find).find(Boolean);
  assert.equal(find(h.container).textContent, '## Page 1\n\n' + evil);
  assert.equal(find(h.container).innerHTML, undefined);
});

function formHarness(annots) {
  const store = new Map();
  const storage = {
    getAll: () => store.size ? Object.fromEntries([...store].map(([k, v]) => [k, { ...v }])) : null,
    setValue: (id, v) => store.set(id, { ...(store.get(id) || {}), ...v })
  };
  const state = {
    pdfDoc: { numPages: 1, annotationStorage: storage, getPage: async () => ({ getAnnotations: async () => annots }) },
    annotations: {}, redactionMarks: {}, textEdits: {}, undoStack: [], redoStack: [], hasUnsavedChanges: false
  };
  const { functions } = loadRendererFunctions(['saveState', 'undo', 'redo'], {
    state, helperNames: ['editSnapshot', 'restoreForms'],
    extra: { setUnsavedChanges: flag => { state.hasUnsavedChanges = flag; }, updateUndoRedo: () => {}, renderAllPages: inert, updateAnnotationCount: () => {} }
  });
  const values = () => JSON.parse(JSON.stringify(storage.getAll() || {}));
  return { state, functions, storage, values };
}

test('editSnapshot includes the typed form values and nothing else from the storage entries', () => {
  const { state, functions, storage } = formHarness([]);
  const snap = () => JSON.parse(state.undoStack[state.undoStack.length - 1]);
  functions.saveState();
  assert.deepEqual(snap().forms, {});
  storage.setValue('12R', { value: 'Jane', extra: 1 });
  storage.setValue('13R', { value: true });
  functions.saveState();
  assert.deepEqual(snap().forms, { '12R': { value: 'Jane' }, '13R': { value: true } });
  assert.deepEqual(Object.keys(snap()).sort(), ['annotations', 'forms', 'redactionMarks', 'textEdits']);
});

test('undo after a fill restores the previous form values and redo applies them again', async () => {
  const { state, functions, storage, values } = formHarness([
    { id: '12R', fieldType: 'Tx', fieldValue: 'printed' }, { id: '13R', fieldType: 'Tx' }, { id: '14R', fieldType: 'Btn', checkBox: true, exportValue: 'Yes', fieldValue: 'Off' }
  ]);
  storage.setValue('12R', { value: 'typed' });
  functions.saveState(); // what Fill does before applying
  storage.setValue('12R', { value: 'Jane Q. Doe' });
  storage.setValue('13R', { value: '555-1234' });
  storage.setValue('14R', { value: true });
  await functions.undo();
  assert.deepEqual(values(), { '12R': { value: 'typed' }, '13R': { value: '' }, '14R': { value: false } });
  assert.equal(state.undoStack.length, 0);
  await functions.redo();
  assert.deepEqual(values(), { '12R': { value: 'Jane Q. Doe' }, '13R': { value: '555-1234' }, '14R': { value: true } });
  await functions.undo();
  assert.equal(values()['12R'].value, 'typed');
});

test('a field first typed into after the snapshot goes back to the value the document holds', async () => {
  const { functions, storage, values } = formHarness([{ id: '5R', fieldType: 'Tx', fieldValue: 'printed' }, { id: '6R', fieldType: 'Tx' }]);
  functions.saveState();
  storage.setValue('5R', { value: 'x' });
  storage.setValue('6R', { value: 'y' });
  await functions.undo();
  assert.deepEqual(values(), { '5R': { value: 'printed' }, '6R': { value: '' } });
});

const plain = value => JSON.parse(JSON.stringify(value)); // values built inside the renderer sandbox live in another realm

test('dragging a crop rectangle asks to crop this page, all pages or cancel, and applies a crop modification', async () => {
  const applied = [], modals = [];
  const state = { scale: 1, currentPath: [{ x: 20, y: 10 }, { x: 120, y: 60 }, { x: 20, y: 60 }] };
  const { functions } = loadRendererFunctions(['confirmCrop'], { state, extra: {
    renderAnnotations: () => {}, drawCurrentPath: () => {}, selectTool: () => {}, allPageIndexes: () => [0, 1, 2],
    applyPageMods: async (mods, message) => { applied.push(mods); },
    showModal: (title, content, buttons) => { modals.push({ title, content, buttons }); }
  } });
  functions.confirmCrop(2, { width: 200, height: 100, getContext: () => ({}) });
  assert.deepEqual(plain(state.currentPath), []);
  assert.equal(modals.length, 1);
  assert.match(modals[0].content, /hidden, not deleted/);
  assert.deepEqual(plain(modals[0].buttons.map(b => b.label)), ['Cancel', 'Crop all pages', 'Crop this page']);
  await modals[0].buttons[2].handler();
  assert.deepEqual(plain(applied[0]), [{ type: 'crop', pageIndex: 1, x: 0.1, y: 0.1, width: 0.5, height: 0.5 }]);
  await modals[0].buttons[1].handler();
  assert.deepEqual(plain(applied[1].map(m => m.pageIndex)), [0, 1, 2]);
  assert.ok(applied[1].every(m => m.type === 'crop' && m.width === 0.5));
  state.currentPath = [{ x: 5, y: 5 }, { x: 8, y: 9 }]; // too small to be a crop
  functions.confirmCrop(1, { width: 200, height: 100, getContext: () => ({}) });
  assert.equal(modals.length, 1);
});

test('the note tool stores an undoable stickyNote and Cancel adds nothing', () => {
  const state = { scale: 1, annotations: {} }, calls = [], modals = [];
  const { functions } = loadRendererFunctions(['addNote'], { state, helperNames: ['noteForm'], extra: {
    saveState: () => calls.push('save'), renderAnnotations: () => calls.push('render'), updateAnnotationCount: () => {}, selectTool: () => {},
    showModal: (title, content, buttons) => { modals.push(buttons); return { querySelector: () => ({ focus() {} }) }; }
  } });
  functions.addNote(1, 50, 20, { width: 200, height: 100 });
  const add = modals[0].find(b => b.action === 'add');
  assert.equal(add.handler({ querySelector: () => ({ value: '   ' }) }), 'keep-open');
  assert.deepEqual(plain(state.annotations), {});
  add.handler({ querySelector: () => ({ value: ' Müller 東京 ' }) });
  assert.deepEqual(plain(state.annotations[1]), [{ type: 'stickyNote', x: 0.25, y: 0.2, text: 'Müller 東京' }]);
  assert.deepEqual(plain(calls), ['save', 'render']);
  assert.equal(modals[0].find(b => b.action === 'cancel').handler, undefined);
  functions.addNote(1, 199, 99, { width: 200, height: 100 });
  modals[1].find(b => b.action === 'add').handler({ querySelector: () => ({ value: 'edge' }) });
  assert.deepEqual([state.annotations[1][1].x, state.annotations[1][1].y], [176 / 200, 76 / 100]); // the 24pt icon stays on the page
});

test('a note can be deleted from its modal and the deletion is undoable', () => {
  const state = { scale: 1, annotations: { 1: [{ type: 'stickyNote', x: 0, y: 0, text: 'a' }, { type: 'stickyNote', x: 0.5, y: 0.5, text: 'b' }] } }, calls = [];
  let buttons, body = { textContent: '' };
  const { functions } = loadRendererFunctions(['showNote'], { state, extra: {
    saveState: () => calls.push('save'), renderAnnotations: () => {}, updateAnnotationCount: () => {}, editNote: () => {},
    showModal: (title, content, b) => { buttons = b; return { querySelector: () => body }; }
  } });
  functions.showNote(1, 1);
  assert.equal(body.textContent, 'b');
  assert.deepEqual(plain(buttons.map(b => b.label)), ['Close', 'Delete', 'Edit']);
  buttons[1].handler();
  assert.deepEqual(plain(state.annotations[1].map(n => n.text)), ['a']);
  assert.deepEqual(plain(calls), ['save']);
});

// ---------- signatures: image helpers, aspect-correct placement, move and resize ----------
test('trimCanvasData returns the box of visible pixels, or null for a blank image', () => {
  const { functions } = loadRendererFunctions(['trimCanvasData']);
  const img = { width: 6, height: 4, data: new Uint8Array(6 * 4 * 4) };
  assert.equal(functions.trimCanvasData(img), null);
  for (const [x, y] of [[2, 1], [3, 2]]) img.data[(y * 6 + x) * 4 + 3] = 255;
  assert.deepEqual(plain(functions.trimCanvasData(img)), { x: 2, y: 1, w: 2, h: 2 });
});
test('whiteToAlpha clears white, keeps ink, and fades the grey edge', () => {
  const { functions } = loadRendererFunctions(['whiteToAlpha']);
  const px = [[255, 255, 255, 255], [0, 0, 0, 255], [185, 185, 185, 255], [172, 172, 172, 255], [250, 250, 250, 0]];
  const data = Uint8Array.from(px.flat());
  functions.whiteToAlpha(data);
  const alpha = Array.from(data).filter((v, i) => i % 4 === 3);
  assert.equal(alpha[0], 0, 'white');
  assert.equal(alpha[1], 255, 'ink');
  assert.ok(alpha[2] > 100 && alpha[2] < 155, 'mid grey is half transparent: ' + alpha[2]);
  assert.ok(alpha[3] > 230 && alpha[3] < 255, 'near the ink side of the ramp: ' + alpha[3]);
  assert.equal(alpha[4], 0);
});
test('whiteToAlpha with the image size clears shaded paper from a photo and keeps the ink', () => {
  const { functions } = loadRendererFunctions(['whiteToAlpha']);
  const w = 200, h = 60, data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { // paper fading from 245 to 150 left to right, a dark stroke along the middle
    const i = (y * w + x) * 4, ink = Math.abs(y - 30) < 2, v = ink ? 40 : Math.round(245 - 95 * x / (w - 1));
    data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255;
  }
  functions.whiteToAlpha(data, w, h);
  let paper = 0, inkKept = 0, inkN = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const a = data[(y * w + x) * 4 + 3]; if (Math.abs(y - 30) < 2) { inkN++; if (a === 255) inkKept++; } else if (a > 0) paper++; }
  assert.equal(paper, 0, 'shaded paper left visible');
  assert.equal(inkKept, inkN, 'ink stays opaque');
});
test('fitContain keeps the proportions, left aligned or centred, and centres vertically', () => {
  const { functions } = loadRendererFunctions(['fitContain']);
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  let r = functions.fitContain({ x: 10, y: 20, width: 200, height: 50 }, 300, 100);
  [r.x, r.y, r.width, r.height].forEach((v, i) => near(v, [10, 20, 150, 50][i]));
  r = functions.fitContain({ x: 10, y: 20, width: 200, height: 50 }, 300, 100, true);
  near(r.x, 10 + 25);
  r = functions.fitContain({ x: 0, y: 0, width: 100, height: 100 }, 200, 50);
  [r.x, r.y, r.width, r.height].forEach((v, i) => near(v, [0, 37.5, 100, 25][i]));
  r = functions.fitContain({ x: 5, y: 5, width: 100, height: 100 }, 50, 200);
  [r.x, r.width, r.height].forEach((v, i) => near(v, [5, 25, 100][i]));
});
function signatureHarness(pending) {
  const state = { scale: 1, annotations: {}, pendingSignature: pending }, calls = [];
  const { functions } = loadRendererFunctions(['addSignature'], { state, helperNames: ['signatureBox', 'fitContain'], extra: {
    saveState: () => calls.push('save'), setSigSel: sel => { state.sigSel = sel; }, renderAnnotations: () => {}, updateAnnotationCount: () => {}, setUnsavedChanges: () => {},
    selectTool: t => calls.push('tool:' + t), showNotification: () => {}
  } });
  return { state, calls, add: functions.addSignature };
}
test('a clicked signature keeps its own proportions on the page, whatever the zoom', () => {
  for (const scale of [1, 1.5]) {
    const { state, add, calls } = signatureHarness({ dataUrl: 'data:image/png;base64,AA', width: 300, height: 100, kind: 'signature' });
    state.scale = scale;
    const canvas = { width: 612 * scale, height: 792 * scale }, p = { x: 300, y: 400 };
    add(1, p, p, canvas);
    const [a] = state.annotations[1];
    assert.equal(a.type, 'signature');
    assert.ok(Math.abs(a.width * 612 - 130) < 1e-6, 'about 1.8 in wide: ' + a.width * 612);
    assert.ok(Math.abs((a.width * 612) / (a.height * 792) - 3) < 1e-6, 'the 3:1 picture stays 3:1 on the page');
    assert.ok(Math.abs((a.x + a.width / 2) * 612 - 300) < 1e-6, 'centred on the click');
    assert.deepEqual(plain(calls), ['save', 'tool:select']);
    assert.equal(state.pendingSignature, null);
  }
});
test('initials are 0.6 in wide, and a click near the edge stays on the page', () => {
  const { state, add } = signatureHarness({ dataUrl: 'x', width: 100, height: 100, kind: 'initials' });
  add(2, { x: 611, y: 5 }, { x: 611, y: 5 }, { width: 612, height: 792 });
  const [a] = state.annotations[2];
  assert.ok(Math.abs(a.width * 612 - 43.2) < 1e-6);
  assert.ok(a.x >= 0 && a.x + a.width <= 1 + 1e-9 && a.y >= 0);
});
test('dragging a box fits the signature inside it, centred', () => {
  const { state, add } = signatureHarness({ dataUrl: 'x', width: 200, height: 100, kind: 'signature' });
  add(1, { x: 400, y: 100 }, { x: 100, y: 200 }, { width: 612, height: 792 }); // dragged right to left
  const [a] = state.annotations[1], pt = [a.x * 612, a.y * 792, a.width * 612, a.height * 792];
  [150, 100, 200, 100].forEach((v, i) => assert.ok(Math.abs(pt[i] - v) < 1e-6, `${pt}`));
});
test('a placed signature moves, resizes keeping its proportions, and deletes; each gesture is one undo step', () => {
  const listeners = {}, calls = [];
  const sig = () => ({ type: 'signature', x: 0.1, y: 0.1, width: 0.2, height: 0.05, imageData: 'x' });
  const state = { scale: 1, annotations: { 1: [sig()] }, sigSel: null };
  const { functions } = loadRendererFunctions(['dragAnnotation', 'deleteSelectedAnnotation'], { state, extra: {
    document: { addEventListener: (t, f) => { listeners[t] = f; }, removeEventListener: t => { delete listeners[t]; } },
    saveState: () => calls.push('save'), setSigSel: sel => { state.sigSel = sel; }, renderAnnotations: () => {}, updateAnnotationCount: () => {}
  } });
  const canvas = { width: 612, height: 792 }, ev = (x, y) => ({ clientX: x, clientY: y, preventDefault() {}, stopPropagation() {} });
  const aspect = a => (a.width * 612) / (a.height * 792), before = aspect(state.annotations[1][0]);
  functions.dragAnnotation(ev(0, 0), 1, 0, canvas, true);
  listeners.mousemove(ev(30, 0)); listeners.mousemove(ev(61.2, 3)); listeners.mouseup();
  const a = state.annotations[1][0];
  assert.ok(Math.abs(a.width - 0.3) < 1e-9, 'grew by the drag: ' + a.width);
  assert.ok(Math.abs(aspect(a) - before) < 1e-9, 'proportions kept');
  assert.deepEqual(plain(calls), ['save'], 'one undo step');
  assert.deepEqual([a.x, a.y], [0.1, 0.1]);
  functions.dragAnnotation(ev(100, 100), 1, 0, canvas, false);
  listeners.mousemove(ev(100 + 61.2, 100 + 79.2)); listeners.mouseup();
  assert.ok(Math.abs(a.x - 0.2) < 1e-9 && Math.abs(a.y - 0.2) < 1e-9);
  assert.deepEqual(plain(calls), ['save', 'save']);
  functions.dragAnnotation(ev(0, 0), 1, 0, canvas, false);
  listeners.mousemove(ev(5000, -5000)); listeners.mouseup();
  assert.ok(a.x + a.width <= 1 + 1e-9 && a.y === 0, 'stays on the page');
  functions.dragAnnotation(ev(0, 0), 1, 0, canvas, false); listeners.mouseup(); // a plain click selects without an undo step
  assert.equal(calls.length, 3);
  functions.deleteSelectedAnnotation();
  assert.deepEqual(plain(state.annotations[1]), []);
  assert.equal(calls.length, 4);
  functions.deleteSelectedAnnotation();
  assert.equal(calls.length, 4);
});

// ---------- Find & Replace ----------
const findFns = () => loadRendererFunctions(['findRegex', 'pageSearchText', 'findPageMatches', 'partBox', 'matchPdfBox', 'matchViewportRects', 'describeReplace'], {
  extra: { pdfjsLib: { Util: { transform: (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]] } } }
}).functions;
const item = (str, x, y, width, extra = {}) => ({ str, transform: [12, 0, 0, 12, x, y], width, height: 12, hasEOL: false, ...extra });
const plainJson = x => JSON.parse(JSON.stringify(x));

test('find: whitespace in the query matches any run of whitespace, case and whole word options', () => {
  const f = findFns(), items = [item('The  Cat sat on', 10, 100, 100), item('concat cats', 10, 80, 60)];
  const count = (q, c, w) => f.findPageMatches(items, q, c, w).length;
  assert.equal(count('cat', false, false), 3); // Cat, concat, cats
  assert.equal(count('cat', true, false), 2);
  assert.equal(count('cat', false, true), 1);
  assert.equal(count('Cat', true, true), 1);
  assert.equal(count('the cat', false, false), 1);
  assert.equal(count('sat   on', false, false), 1);
  assert.equal(count('  ', false, false), 0);
  assert.equal(count('', false, false), 0);
  assert.equal(count('a.c', false, false), 0, 'the query is text, not a pattern');
  assert.equal(count('on concat', false, false), 1, 'the end of a line reads as a space');
});
test('find: items are joined with a space where there is a gap, a line break or a new line, and a match keeps one part per item', () => {
  const f = findFns();
  const items = [item('Hel', 10, 100, 20), item('lo', 30, 100, 14), item('wor', 60, 100, 20), item('ld', 80, 100, 14), item('next', 10, 80, 30)];
  const text = f.pageSearchText(items).text;
  assert.equal(text, 'Hello world next', 'no space inside a word split between items; a gap or a new line gets one');
  const [m] = f.findPageMatches(items, 'llo wor', true, false);
  assert.deepEqual(plainJson(m.parts), [{ item: 0, from: 2, to: 3 }, { item: 1, from: 0, to: 2 }, { item: 2, from: 0, to: 3 }]);
  const eol = [item('end', 10, 100, 20, { hasEOL: true }), item('start', 10, 100, 25)];
  assert.equal(f.pageSearchText(eol).text, 'end start');
  assert.deepEqual(plainJson(f.pageSearchText([item('a ', 10, 100, 10), item('b', 20, 100, 5)]).text), 'a b', 'no second space after a space');
});
test('find: the PDF-space box of a match splits an item by an equal width per character, and the highlight is placed like the text layer', () => {
  const f = findFns(), items = [item('abcdefghij', 100, 200, 100)];
  const [m] = f.findPageMatches(items, 'cde', true, false);
  assert.deepEqual(plainJson(f.matchPdfBox(items, m)), [120, 200, 150, 212]);
  const [rect] = f.matchViewportRects(items, m, { scale: 2, transform: [2, 0, 0, -2, 0, 800] });
  assert.deepEqual(plainJson(rect), { x: 240, y: 800 - 400 - 24, w: 60, h: 24 });
});
test('describeReplace names what could not be replaced and on which pages', () => {
  const { describeReplace } = findFns();
  assert.equal(describeReplace(3, { replaced: 3, skipped: [] }, [1, 1, 2]), 'Replaced 3 of 3.');
  assert.equal(describeReplace(14, { replaced: 12, skipped: [{ page: 3, reason: 'font without text mapping' }, { page: 3, reason: 'font without text mapping' }, { page: 9, reason: 'font without text mapping' }] }, [1, 3, 3]),
    'Replaced 12 of 14. 2 could not be replaced: font without text mapping (page 3)');
  assert.equal(describeReplace(4, { replaced: 1, skipped: [{ page: 2, reason: 'not found' }, { page: 5, reason: 'the match starts or ends inside a ligature' }, { page: 4, reason: 'not found' }] }, [1, 2, 4, 5]),
    'Replaced 1 of 4. 3 could not be replaced: not found (pages 2, 4); the match starts or ends inside a ligature (page 5)');
  assert.equal(describeReplace(2, { replaced: 0, skipped: [] }, [6, 7]), 'Replaced 0 of 2. 2 could not be replaced: not found (pages 6, 7)');
});

// ---------- undo of an operation that changes the document ----------
const docs = n => Array.from({ length: n }, (_, i) => ({ doc: JSON.stringify({ originalData: 'D' + i }) }));
test('trimDocSnapshots keeps the bytes of the newest 5 snapshots and cuts the stack below the oldest one dropped', () => {
  const { functions } = loadRendererFunctions(['trimDocSnapshots']);
  const trim = functions.trimDocSnapshots, [d0, d1, d2, d3, d4, d5, d6] = docs(7);
  assert.deepEqual(plainJson(trim([d0, d1, d2, d3, d4])), plainJson([d0, d1, d2, d3, d4]), 'five are kept');
  assert.deepEqual(plainJson(trim([d0, d1, d2, d3, d4, d5])), plainJson([d1, d2, d3, d4, d5]));
  assert.deepEqual(plainJson(trim(['p0', d0, 'p1', d1, 'p2', d2, 'p3', d3, 'p4', d4, 'p5', d5, 'p6', d6])), plainJson(['p2', d2, 'p3', d3, 'p4', d4, 'p5', d5, 'p6', d6]), 'plain snapshots below the oldest kept document snapshot go with it');
  assert.deepEqual(plainJson(trim(['a', 'b', d0, 'c'])), ['a', 'b', plainJson(d0), 'c'], 'plain snapshots are never counted');
  assert.deepEqual(plainJson(trim(['a', 'b'])), ['a', 'b']);
  assert.deepEqual(plainJson(trim([d0, d1, d2], 2)), plainJson([d1, d2]));
});
test('undo and redo of a document snapshot reload the document bytes, and the history around it still works', async () => {
  const loaded = [], state = {
    originalData: 'T0xE', annotations: { 1: ['pending'] }, redactionMarks: {}, textEdits: {}, undoStack: [], redoStack: [], hasUnsavedChanges: false, currentPage: 2,
    pdfDoc: { numPages: 3, annotationStorage: { getAll: () => ({}), setValue() {} }, destroy: inert }
  };
  const { functions } = loadRendererFunctions(['saveState', 'undo', 'redo', 'pushDocSnapshot', 'trimDocSnapshots', 'docSnapshot', 'restoreDocSnapshot', 'swapDocument'], {
    state, helperNames: ['editSnapshot', 'restoreForms'],
    extra: { setUnsavedChanges: flag => { state.hasUnsavedChanges = flag; }, updateUndoRedo: () => {}, renderAllPages: inert, updateAnnotationCount: () => {}, renderThumbnails: inert, goToPage: p => { state.shown = p; },
      pdfjsLib: { getDocument: ({ data }) => { loaded.push(Buffer.from(data).toString('latin1')); return { promise: Promise.resolve({ numPages: 3, annotationStorage: { getAll: () => ({}), setValue() {} }, destroy: inert }) }; } } }
  });
  functions.saveState(); // a plain step before: pending annotations were empty
  functions.pushDocSnapshot(functions.docSnapshot()); // what Replace does, before it changes anything
  state.originalData = 'TkVX'; state.annotations = {};
  assert.equal(state.undoStack.length, 2);
  await functions.undo();
  assert.equal(state.originalData, 'T0xE');
  assert.deepEqual(plainJson(state.annotations), { 1: ['pending'] }, 'the edits that were pending come back');
  assert.deepEqual(loaded, ['OLD'], 'the old bytes were loaded again');
  assert.equal(state.redoStack.length, 1);
  await functions.redo();
  assert.equal(state.originalData, 'TkVX');
  assert.deepEqual(plainJson(state.annotations), {});
  assert.deepEqual(loaded, ['OLD', 'NEW']);
  await functions.undo();
  state.annotations = { 1: ['x'] };
  await functions.undo(); // the plain step below
  assert.equal(state.originalData, 'T0xE', 'plain steps leave the document alone');
  assert.deepEqual(loaded.length, 3);
});
test('pushDocSnapshot clears redo, and keeps document bytes in at most 5 snapshots', () => {
  const state = { undoStack: ['p'], redoStack: ['r'] };
  const { functions } = loadRendererFunctions(['pushDocSnapshot', 'trimDocSnapshots'], { state, extra: { updateUndoRedo: () => {} } });
  docs(8).forEach(d => functions.pushDocSnapshot(d));
  assert.deepEqual(plainJson(state.redoStack), []);
  assert.equal(state.undoStack.length, 5);
  assert.equal(JSON.parse(state.undoStack[0].doc).originalData, 'D3');
});

// ---------- the Replace buttons ----------
function replaceHarness({ pending = [], signed = false, replaced = 1, matchCount = 3, redaction = false } = {}) {
  const calls = [], notes = [], match = n => ({ page: 1, parts: [{ item: 0, from: 4 * n, to: 4 * n + 3 }] });
  const state = {
    pdfDoc: { numPages: 1, destroy: inert }, originalData: 'T0xE', annotations: pending.length ? { 1: pending } : {}, redactionMarks: redaction ? { 1: [{ x: 0, y: 0, width: 0.1, height: 0.1 }] } : {}, textEdits: { '1-1': 'x' },
    undoStack: ['older'], redoStack: ['stale'], currentPage: 1, formsDirty: false, hasUnsavedChanges: false,
    find: { query: 'cat', matchCase: false, wholeWord: true, matches: Array.from({ length: matchCount }, (_, n) => match(n)), index: 1 }
  };
  const { functions } = loadRendererFunctions(['replaceMatches', 'describeReplace', 'docSnapshot', 'pushDocSnapshot', 'trimDocSnapshots', 'matchPdfBox', 'partBox', 'collectModifications', 'editSnapshot', 'bakePending'], {
    state, elements: { replaceInput: { value: 'dog' }, searchBar: { classList: { toggle() {}, add() {}, remove() {} } } },
    api: {
      applyModifications: async req => { calls.push(['bake', req.originalData, req.modifications.length]); return { success: true, data: 'QkFLRUQ=' }; },
      replaceText: async req => { calls.push(['replace', req.data, req.query, req.replacement, req.wholeWord, JSON.parse(JSON.stringify(req.targets))]); return { success: true, data: 'TkVX', replaced, skipped: [], signedWarning: signed }; }
    },
    extra: {
      setLoading: () => {}, showNotification: (msg, type) => notes.push([msg, type]), setUnsavedChanges: flag => { state.hasUnsavedChanges = flag; }, updateUndoRedo: () => {}, updateAnnotationCount: () => {},
      swapDocument: async data => { calls.push(['swap', data]); }, renderAllPages: inert, goToPage: () => {}, gotoMatch: () => calls.push(['next']),
      pageItems: async () => [{ str: 'cat cat cat', transform: [12, 0, 0, 12, 100, 200], width: 110, height: 12 }],
      runFind: async () => calls.push(['find']), confirm: () => { calls.push(['confirm']); return !signed; },
      document: { activeElement: null, getElementById: id => ({ value: 'dog', textContent: '', classList: { toggle() {}, add() {}, remove() {} } }) }
    }
  });
  return { state, calls, notes, replaceMatches: functions.replaceMatches };
}
test('Replace sends the current match as a rect in PDF space, makes the change undoable, and moves on', async () => {
  const h = replaceHarness({ pending: [{ type: 'text' }] });
  await h.replaceMatches(false);
  assert.deepEqual(plainJson(h.calls[0]), ['bake', 'T0xE', 1], 'pending annotations are baked first');
  assert.deepEqual(plainJson(h.calls[1]), ['replace', 'QkFLRUQ=', 'cat', 'dog', true, [{ page: 1, rect: [140, 200, 170, 212] }]]);
  assert.equal(h.state.originalData, 'TkVX');
  assert.deepEqual(plainJson(h.state.annotations), {});
  assert.deepEqual(plainJson(h.state.textEdits), {});
  assert.equal(h.state.undoStack.length, 2);
  assert.equal(JSON.parse(h.state.undoStack[1].doc).originalData, 'T0xE', 'undo returns to the document as it was, with the pending edits');
  assert.deepEqual(plainJson(JSON.parse(h.state.undoStack[1].doc).annotations), { 1: [{ type: 'text' }] });
  assert.equal(h.state.undoStack[0], 'older', 'the earlier history is kept');
  assert.deepEqual(plainJson(h.state.redoStack), []);
  assert.equal(h.state.hasUnsavedChanges, true);
  assert.deepEqual(plainJson(h.notes.at(-1)), ['Replaced 1 of 1.', 'success']);
});
test('Replace All asks for every match and reports what could not be done', async () => {
  const h = replaceHarness({ replaced: 2 });
  await h.replaceMatches(true);
  assert.equal(h.calls[0][0], 'replace');
  assert.equal(h.calls[0][5], 'all');
  assert.equal(h.calls[0][1], 'T0xE', 'nothing pending: the document as it is');
  assert.deepEqual(plainJson(h.notes.at(-1)), ['Replaced 2 of 3. 1 could not be replaced: not found (page 1)', 'warning']);
});
test('Replace refuses while redaction marks are pending, and asks first on a signed PDF', async () => {
  const h = replaceHarness({ redaction: true });
  await h.replaceMatches(true);
  assert.deepEqual(plainJson(h.calls), []);
  assert.match(h.notes.at(-1)[0], /redaction marks first/);
  const s = replaceHarness({ signed: true });
  await s.replaceMatches(true);
  assert.deepEqual(plainJson(s.calls.map(c => c[0])), ['replace', 'confirm']);
  assert.equal(s.state.originalData, 'T0xE', 'declined: nothing changed');
  assert.equal(s.state.undoStack.length, 1);
});
test('Replace changes nothing when nothing could be replaced', async () => {
  const h = replaceHarness({ replaced: 0 });
  await h.replaceMatches(false);
  assert.equal(h.state.originalData, 'T0xE');
  assert.equal(h.state.undoStack.length, 1);
  assert.deepEqual(plainJson(h.notes.at(-1)), ['Replaced 0 of 1. 1 could not be replaced: not found (page 1)', 'warning']);
  assert.deepEqual(plainJson(h.calls.at(-1)), ['next'], 'moves on to the next match');
});

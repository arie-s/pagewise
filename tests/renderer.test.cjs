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
  const { functions } = loadRendererFunctions(['extractScale'], { extra: { pdfjsLib: { OPS } } });
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
    state: { pdfDoc: { numPages: 1, getPage: async () => page } },
    api: { engineStatus: async () => ({ installed: true, running: false }), smartExtract: async () => { extracted++; return { success: false, error: 'x' }; } },
    extra: {
      setLoading: () => {}, showNotification: () => {}, showEngineSetup: () => { setup++; }, extractScale: async () => 1,
      document: { getElementById: () => ({}), createElement: () => ({ getContext: () => ({}), toDataURL: () => 'data:image/png;base64,AQ==' }) }
    }
  });
  await functions.runSmartExtract();
  assert.equal(setup, 0);
  assert.equal(extracted, 1);
});

test('runSmartExtract asks for an engine update when files exist but the install is outdated', async () => {
  let setup = 0; const notes = [];
  const { functions } = loadRendererFunctions(['runSmartExtract'], {
    state: { pdfDoc: { numPages: 1 } },
    api: { engineStatus: async () => ({ installed: false, hasFiles: true }) },
    extra: { setLoading: () => {}, showNotification: m => notes.push(m), showEngineSetup: () => { setup++; } }
  });
  await functions.runSmartExtract();
  assert.equal(setup, 1);
  assert.match(notes[0], /AI engine update \(small download\)/);
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
  assert.deepEqual(Object.keys(b), ['Copy', 'Copy table', 'Export CSV (2 tables)', 'Save Markdown', 'Close']);
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

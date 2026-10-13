const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererFunctions } = require('./helpers.cjs');

const inert = async () => {};
function setup({ words = [{ text: 'visible', x0: 2, y0: 2, x1: 20, y1: 12 }], failFinalParse = false, failOcr = false } = {}) {
  const oldDoc = { numPages: 1, getPage: async () => { throw new Error('old unmasked document used'); }, destroy: async () => { oldDoc.destroyed = true; } };
  const stagingDoc = {
    numPages: 1,
    destroy: async () => { stagingDoc.destroyed = true; },
    getPage: async () => ({
      getViewport: () => ({ width: 100, height: 100 }),
      render: ({ canvasContext }) => { canvasContext.layer = 'masked-baked-page'; return { promise: Promise.resolve() }; }
    })
  };
  const finalDoc = { numPages: 1 };
  const state = { pdfDoc: oldDoc, originalData: 'OLD', currentPage: 1,
    annotations: { 1: ['annotation'] }, redactionMarks: { 1: ['secret'] }, textEdits: { 1: ['edit'] },
    undoStack: ['undo'], redoStack: ['redo'] };
  const notices = [], ocrInputs = [];
  let documentLoads = 0, undoUpdates = 0, annotationUpdates = 0;
  const { functions } = loadRendererFunctions(['runOcr'], {
    state, helperNames: ['setPdfDoc'],
    api: {
      ocrPage: async request => { ocrInputs.push(request.pngBase64); return failOcr ? { success: false, error: 'recognition failed' } : { success: true, words }; },
      applyModifications: async () => ({ success: true, data: Buffer.from('FINAL').toString('base64') })
    },
    extra: {
      buildDocumentData: async () => Buffer.from('MASKED').toString('base64'),
      pdfjsLib: { getDocument: () => ({ promise: ++documentLoads === 1 ? Promise.resolve(stagingDoc) : failFinalParse ? Promise.reject(new Error('invalid final PDF')) : Promise.resolve(finalDoc) }) },
      document: { getElementById: () => ({ textContent: '' }), createElement: () => { const ctx = {}; return { width: 0, height: 0, getContext: () => ctx,
        toDataURL: () => 'data:image/png;base64,' + Buffer.from(ctx.layer || '').toString('base64') }; } },
      setLoading: () => {}, showNotification: (...args) => notices.push(args),
      updateUndoRedo: () => undoUpdates++, updateAnnotationCount: () => annotationUpdates++,
      renderThumbnails: inert, renderAllPages: inert, goToPage: () => {}, setUnsavedChanges: () => {},
      URL: undefined
    }
  });
  // The canvas encodes which document page was rasterized.
  const context = functions.runOcr;
  return { state, oldDoc, stagingDoc, notices, ocrInputs, get updates() { return [undoUpdates, annotationUpdates]; }, run: context };
}

test('OCR recognizes the baked masked document and destroys its staging document', async () => {
  const env = setup();
  await env.run();
  assert.equal(env.ocrInputs.length, 1);
  assert.equal(Buffer.from(env.ocrInputs[0], 'base64').toString(), 'masked-baked-page');
  assert.equal(env.stagingDoc.destroyed, true);
  assert.equal(env.oldDoc.destroyed, true);
  assert.equal(env.state.originalData, Buffer.from('FINAL').toString('base64'));
  assert.notEqual(env.state.pdfDoc.numPages, undefined);
  assert.deepEqual(env.updates, [1, 1]);
});

test('OCR failure preserves the prior document and pending overlays', async () => {
  const env = setup({ failOcr: true });
  const priorDoc = env.state.pdfDoc, annotations = env.state.annotations, marks = env.state.redactionMarks;
  await env.run();
  assert.equal(env.state.pdfDoc, priorDoc);
  assert.equal(env.state.originalData, 'OLD');
  assert.equal(env.state.annotations, annotations);
  assert.equal(env.state.redactionMarks, marks);
  assert.equal(env.stagingDoc.destroyed, true);
  assert.match(env.notices.at(-1)[0], /recognition failed/);
});

test('invalid final OCR PDF preserves pending state and zero words reports no text', async () => {
  const failed = setup({ failFinalParse: true });
  const priorDoc = failed.state.pdfDoc, annotations = failed.state.annotations;
  await failed.run();
  assert.equal(failed.state.pdfDoc, priorDoc);
  assert.equal(failed.oldDoc.destroyed, undefined);
  assert.equal(failed.state.originalData, 'OLD');
  assert.equal(failed.state.annotations, annotations);

  const empty = setup({ words: [] });
  await empty.run();
  assert.match(empty.notices.at(-1)[0], /no text was recognized/i);
  assert.equal(empty.state.annotations && Object.keys(empty.state.annotations).length, 0);
});

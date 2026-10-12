const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PDFDocument } = require('@cantoo/pdf-lib');
const { root, loadMainHandlers, loadRendererFunctions } = require('./helpers.cjs');

const FW9 = fs.readFileSync(path.join(root, 'tests/fixtures/forms/fw9.pdf'));
const TEXT = 'topmostSubform[0].Page1[0].f1_01[0]';
const BOX = 'topmostSubform[0].Page1[0].Boxes3a-b_ReadOrder[0].c1_1[0]';
const b64 = bytes => Buffer.from(bytes).toString('base64');
const load = async (data = FW9) => (await import('pdfjs-dist/legacy/build/pdf.mjs')).getDocument({ data: new Uint8Array(data), verbosity: 0 }).promise;

async function filledFw9() {
  const doc = await load();
  const fields = await doc.getFieldObjects();
  doc.annotationStorage.setValue(fields[TEXT][0].id, { value: 'Jane Müller' });
  doc.annotationStorage.setValue(fields[BOX][0].id, { value: true });
  return Buffer.from(await doc.saveDocument());
}

test('form values typed in pdf.js survive the apply-modifications save path', async () => {
  const { handlers } = loadMainHandlers();
  const r = await handlers.get('apply-modifications')(null, {
    originalData: b64(await filledFw9()),
    modifications: [{ type: 'text', pageIndex: 0, text: 'stamp', x: 0.1, y: 0.1, fontSize: 12, opacity: 1 }]
  });
  assert.equal(r.success, true, r.error);
  const form = (await PDFDocument.load(Buffer.from(r.data, 'base64'))).getForm();
  assert.equal(form.getTextField(TEXT).getText(), 'Jane Müller');
  assert.equal(form.getCheckBox(BOX).isChecked(), true);
});

test('flatten-form turns filled fields into page content', async () => {
  const { handlers } = loadMainHandlers();
  const r = await handlers.get('flatten-form')(null, { data: b64(await filledFw9()) });
  assert.equal(r.success, true, r.error);
  const out = Buffer.from(r.data, 'base64');
  assert.equal((await PDFDocument.load(out)).getForm().getFields().length, 0);
  const page = await (await load(out)).getPage(1);
  const text = (await page.getTextContent()).items.map(i => i.str).join(' ');
  assert.match(text, /Jane Müller/);
});

test('flatten-form reports a PDF without fields and unreadable data', async () => {
  const { handlers } = loadMainHandlers();
  const plain = await PDFDocument.create(); plain.addPage([200, 200]);
  const none = await handlers.get('flatten-form')(null, { data: b64(await plain.save()) });
  assert.equal(none.success, false);
  assert.equal(none.error, 'This PDF has no form fields');
  const bad = await handlers.get('flatten-form')(null, { data: b64('not a pdf') });
  assert.equal(bad.success, false);
  assert.ok(bad.error);
});

test('commitFormValues replaces originalData only when form values were modified', async () => {
  let saves = 0;
  const bytes = new Uint8Array([1, 2, 3, 250]);
  let resets = 0;
  const state = {
    originalData: 'OLD', formsDirty: false,
    pdfDoc: { saveDocument: async () => { saves++; return bytes; }, annotationStorage: { resetModified: () => { resets++; } } }
  };
  const { functions } = loadRendererFunctions(['commitFormValues'], { state, helperNames: ['bytesToBase64'], extra: { btoa: s => Buffer.from(s, 'binary').toString('base64') } });
  await functions.commitFormValues();
  assert.equal(state.originalData, 'OLD');
  assert.equal(saves, 0);
  state.formsDirty = true;
  await functions.commitFormValues();
  assert.equal(state.originalData, Buffer.from(bytes).toString('base64'));
  assert.equal(state.formsDirty, false);
  assert.equal(resets, 1);
  await functions.commitFormValues();
  assert.equal(saves, 1);
});

test('bytesToBase64 handles files larger than one chunk', () => {
  const big = new Uint8Array(200000).map((_, i) => i % 256);
  const { context } = loadRendererFunctions(['bytesToBase64'], { extra: { btoa: s => Buffer.from(s, 'binary').toString('base64') } });
  assert.equal(context.__functions.bytesToBase64(big), Buffer.from(big).toString('base64'));
});

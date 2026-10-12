const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { PDFDocument, StandardFonts, rgb, PDFTextField, PDFCheckBox } = require('@cantoo/pdf-lib');
const { root, loadMainHandlers } = require('./helpers.cjs');

const { handlers, context: m } = loadMainHandlers();
const dir = path.join(root, 'tests/fixtures/forms');
const truth = JSON.parse(fs.readFileSync(path.join(dir, 'fields.json'), 'utf8'));
// Prototype scores with the same ink mask: [fields matched, detections]
const PROTOTYPE = { fw9: [22, 53], f8822: [25, 43], f4506t: [27, 45], fss4: [86, 110], f8822_scan: [23, 45] };
const b64 = bytes => Buffer.from(bytes).toString('base64');

async function grayOf(name) {
  const img = await loadImage(path.join(dir, name + '.png'));
  const c = createCanvas(img.width, img.height), ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, img.width, img.height).data, data = new Uint8Array(img.width * img.height);
  for (let i = 0; i < data.length; i++) data[i] = Math.round(0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]);
  return { width: img.width, height: img.height, data };
}
// For each truth field in order, the first unused detection whose centre lies in the truth box (y +/- 4 px)
function score(name, detections) {
  const used = new Set();
  let matched = 0, checks = 0, checkTotal = 0;
  for (const f of truth[name].fields) {
    const [x0, y0, x1, y1] = f.box;
    if (f.kind === 'check') checkTotal++;
    const j = detections.findIndex((d, i) => {
      if (used.has(i)) return false;
      const cx = (d.box[0] + d.box[2]) / 2, cy = (d.box[1] + d.box[3]) / 2;
      return cx >= x0 && cx <= x1 && cy >= y0 - 4 && cy <= y1 + 4;
    });
    if (j < 0) continue;
    used.add(j); matched++;
    if (f.kind === 'check' && detections[j].kind === 'check') checks++;
  }
  return { matched, checks, checkTotal };
}
const results = {};
const detect = async name => results[name] ||= (async () => {
  const gray = await grayOf(name);
  const t0 = process.hrtime.bigint();
  const fields = m.detectFormFields(gray);
  return { fields, ms: Number(process.hrtime.bigint() - t0) / 1e6, ...score(name, fields) };
})();

for (const name of Object.keys(PROTOTYPE)) {
  test(`detectFormFields finds the blank fields of ${name}`, async () => {
    const r = await detect(name), [floor, count] = PROTOTYPE[name], total = truth[name].fields.length;
    console.log(`${name.padEnd(11)} matched ${r.matched}/${total}  detections ${r.fields.length}  checkboxes ${r.checks}/${r.checkTotal}  ${r.ms.toFixed(0)} ms`);
    assert.ok(r.matched >= floor - 1, `${name}: matched ${r.matched}, floor ${floor - 1}`);
    assert.ok(r.fields.length <= count * 1.1, `${name}: ${r.fields.length} detections, ceiling ${Math.floor(count * 1.1)}`);
    if (name !== 'f8822_scan') assert.equal(r.checks, r.checkTotal, `${name}: every checkbox is detected as a check`);
  });
}

test('comb boxes merge into one field per group of cells (W-9 social security number is 3/2/4)', async () => {
  const { fields } = await detect('fw9');
  const ssn = fields.filter(f => f.kind === 'text' && f.box[1] >= 770 && f.box[3] <= 830 && f.box[0] >= 860);
  assert.deepEqual(Array.from(ssn, f => f.cells), [3, 2, 4]);
  assert.deepEqual(Array.from(ssn, f => Math.round(f.box[0] / 10) * 10), [870, 990, 1080]);
});

const W = (text, x0, y0, x1, y1) => ({ text, box: [x0, y0, x1, y1] });
test('labelFor prefers the line to the left, then the line above', () => {
  const field = { kind: 'text', box: [300, 200, 600, 224] };
  const left = [W('Name', 100, 205, 160, 222), W('of', 168, 205, 190, 222), W('payee:', 198, 205, 270, 222), W('Elsewhere', 100, 100, 200, 117)];
  assert.equal(m.labelFor(field, left), 'Name of payee:');
  // A far-away word on the same line is not part of the run
  assert.equal(m.labelFor(field, [W('Far', 0, 205, 30, 222), ...left]), 'Name of payee:');
  const above = [W('Street', 310, 170, 380, 190), W('address', 390, 170, 470, 190), W('Unrelated', 700, 170, 800, 190), W('Older', 310, 120, 380, 140)];
  assert.equal(m.labelFor(field, above), 'Street address');
  assert.equal(m.labelFor(field, [W('Too', 310, 100, 360, 120)], 1, 7), 'Field 7');
  assert.equal(m.labelFor(field, []), 'Field 1');
});
test('labelFor keeps a long left label whose start is far from the box', () => {
  const field = { kind: 'text', box: [520, 200, 900, 224] };
  const words = [W('Applicant\'s', 104, 205, 190, 222), W('legal', 196, 205, 236, 222), W('surname', 242, 205, 320, 222)];
  assert.equal(m.labelFor(field, words), 'Applicant\'s legal surname');
  // a short label at the margin, 266 px from its box
  assert.equal(m.labelFor(field, [W('Given', 104, 205, 170, 222), W('name(s)', 176, 205, 254, 222)]), 'Given name(s)');
  assert.equal(m.labelFor(field, [W('Far', 0, 205, 60, 222)]), 'Field 1');
});
test('labelFor reads a checkbox label to the right first', () => {
  const box = { kind: 'check', box: [100, 200, 120, 220] };
  const words = [W('Individual', 130, 202, 220, 220), W('or', 228, 202, 250, 220), W('sole', 258, 202, 300, 220), W('Partner', 20, 202, 90, 220)];
  assert.equal(m.labelFor(box, words), 'Individual or sole');
  assert.equal(m.labelFor(box, [W('Partner', 20, 202, 90, 220)]), 'Partner');
});
test('labelFor cleans arrows, leaders, bullets and item numbers', () => {
  const field = { kind: 'text', box: [500, 200, 800, 224] };
  const one = text => m.labelFor(field, [W(text, 100, 205, 400, 222)]);
  assert.equal(one('3a ▶ Business name .......'), 'Business name');
  assert.equal(one('1. Name'), 'Name');
  assert.equal(one('• Phone number ……'), 'Phone number');
  assert.equal(one('12 Month'), 'Month');
  assert.equal(one('x'.repeat(100)).length, 60);
  assert.equal(one('. . . . .'), 'Field 1');
  assert.equal(one('» Decedent\'s | name'), 'Decedent\'s name');
  for (const junk of ['|', '6a', '[J]', '> 2']) assert.equal(one(junk), 'Field 1', junk);
});
test('uniqueFieldNames replaces dots and numbers duplicates', () => {
  assert.deepEqual(m.uniqueFieldNames(['Name', 'Name', 'Name', 'a.b', 'Dr. Who', 'Name (2)']), ['Name', 'Name (2)', 'Name (3)', 'a b', 'Dr Who', 'Name (2) (2)']);
  assert.deepEqual(m.uniqueFieldNames(['Name', 'City'], ['Name']), ['Name (2)', 'City']);
});

async function blankWithText() {
  const doc = await PDFDocument.create(), page = doc.addPage([300, 200]);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  page.drawText('UNDERNEATH', { x: 30, y: 148, size: 20, font, color: rgb(0, 0, 0) });
  return b64(await doc.save());
}
const pdfjs = () => import('pdfjs-dist/legacy/build/pdf.mjs');
const FONTS = path.join(root, 'node_modules/pdfjs-dist/standard_fonts/');
async function darkPixels(data, rect) {
  const doc = await (await pdfjs()).getDocument({ data: new Uint8Array(Buffer.from(data, 'base64')), standardFontDataUrl: FONTS, verbosity: 0 }).promise;
  const page = await doc.getPage(1), vp = page.getViewport({ scale: 2 });
  const canvas = createCanvas(vp.width, vp.height), ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, vp.width, vp.height);
  await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
  const [x0, y0, x1, y1] = rect.map(v => v * 2), px = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
  let dark = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i] < 100) dark++;
  return dark;
}
const FIELDS = [
  { pageIndex: 0, kind: 'text', name: 'Code', cells: 4, rect: { x: 20, y: 140, width: 160, height: 28 } },
  { pageIndex: 0, kind: 'text', name: 'Notes', cells: 1, rect: { x: 20, y: 40, width: 200, height: 60 } },
  { pageIndex: 0, kind: 'check', name: 'Agree.now', cells: 1, rect: { x: 240, y: 150, width: 14, height: 14 } }
];

test('add-form-fields adds real text, multiline, comb and checkbox fields over the page', async () => {
  const base = await blankWithText();
  const r = await handlers.get('add-form-fields')(null, { data: base, fields: FIELDS });
  assert.equal(r.success, true, r.error);
  const form = (await PDFDocument.load(Buffer.from(r.data, 'base64'))).getForm();
  assert.equal(form.getFields().length, 3);
  const code = form.getTextField('Code'), notes = form.getTextField('Notes'), check = form.getCheckBox('Agree now');
  assert.ok(code instanceof PDFTextField && check instanceof PDFCheckBox);
  assert.equal(code.getMaxLength(), 4);
  assert.equal(code.isCombed(), true);
  assert.equal(code.isMultiline(), false);
  assert.equal(notes.isMultiline(), true);
  assert.equal(notes.isCombed(), false);
  const page = await (await (await pdfjs()).getDocument({ data: new Uint8Array(Buffer.from(r.data, 'base64')), verbosity: 0 }).promise).getPage(1);
  const widgets = (await page.getAnnotations()).filter(a => a.subtype === 'Widget');
  assert.equal(widgets.length, 3);
  for (const f of FIELDS) {
    const w = widgets.find(a => a.fieldName === (f.name === 'Agree.now' ? 'Agree now' : f.name));
    assert.ok(w, f.name);
    const [x0, y0, x1, y1] = w.rect;
    for (const [got, want] of [[x0, f.rect.x], [y0, f.rect.y], [x1, f.rect.x + f.rect.width], [y1, f.rect.y + f.rect.height]]) assert.ok(Math.abs(got - want) <= 1, `${f.name}: ${got} vs ${want}`);
  }
});

test('added fields keep the page underneath visible', async () => {
  const base = await blankWithText();
  const r = await handlers.get('add-form-fields')(null, { data: base, fields: FIELDS });
  const flipped = [25, 200 - 170, 180, 200 - 140]; // the drawn text sits at PDF y 148..163, inside the Code field
  const before = await darkPixels(base, flipped), after = await darkPixels(r.data, flipped);
  assert.ok(before > 300, 'the reference text renders: ' + before);
  assert.ok(after >= before * 0.95, `text pixels survive: ${after} vs ${before}`);
});

test('add-form-fields makes names unique against existing fields and within the batch', async () => {
  const base = await blankWithText();
  const once = await handlers.get('add-form-fields')(null, { data: base, fields: FIELDS });
  const twice = await handlers.get('add-form-fields')(null, { data: once.data, fields: [FIELDS[0], FIELDS[0]].map(f => ({ ...f })) });
  assert.equal(twice.success, true, twice.error);
  const names = (await PDFDocument.load(Buffer.from(twice.data, 'base64'))).getForm().getFields().map(f => f.getName()).sort();
  assert.deepEqual(names, ['Agree now', 'Code', 'Code (2)', 'Code (3)', 'Notes']);
  const bad = await handlers.get('add-form-fields')(null, { data: base, fields: [{ ...FIELDS[0], pageIndex: 5 }] });
  assert.equal(bad.success, false);
});

test('remove-form-field removes one field and leaves the rest', async () => {
  const added = await handlers.get('add-form-fields')(null, { data: await blankWithText(), fields: FIELDS });
  const r = await handlers.get('remove-form-field')(null, { data: added.data, name: 'Notes' });
  assert.equal(r.success, true, r.error);
  const form = (await PDFDocument.load(Buffer.from(r.data, 'base64'))).getForm();
  assert.deepEqual(form.getFields().map(f => f.getName()).sort(), ['Agree now', 'Code']);
  const missing = await handlers.get('remove-form-field')(null, { data: added.data, name: 'Nope' });
  assert.equal(missing.success, false);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PDFDocument, PDFName, StandardFonts } = require('@cantoo/pdf-lib');
const { root, loadMainHandlers } = require('./helpers.cjs');

const { handlers } = loadMainHandlers();
const call = (name, arg) => handlers.get(name)(null, arg);
const b64 = bytes => Buffer.from(bytes).toString('base64');
const load = async data => (await import('pdfjs-dist/legacy/build/pdf.mjs')).getDocument({ data: new Uint8Array(Buffer.from(data, 'base64')), verbosity: 0 }).promise;
const widgetsOf = async data => (await (await load(data)).getPage(1)).getAnnotations().then(a => a.filter(x => x.subtype === 'Widget'));
const TEXT = { pageIndex: 0, kind: 'text', name: 'Amount', rect: { x: 100, y: 600, width: 200, height: 20 } };
const CHECK = { pageIndex: 0, kind: 'check', name: 'Agree', rect: { x: 100, y: 500, width: 12, height: 12 } };

async function blank(fields = [TEXT, CHECK]) {
  const doc = await PDFDocument.create(), page = doc.addPage([612, 792]);
  page.drawText('Surname', { x: 40, y: 604, size: 12, font: await doc.embedFont(StandardFonts.Helvetica) });
  const r = await call('add-form-fields', { data: b64(await doc.save()), fields });
  assert.equal(r.success, true, r.error);
  return r.data;
}
const field = async (data, name) => (await PDFDocument.load(Buffer.from(data, 'base64'))).getForm().getField(name);
const widgetDict = async (data, name) => (await field(data, name)).acroField.getWidgets()[0].dict;

test('add-form-fields creates a dropdown with its options at the rectangle', async () => {
  const data = await blank([{ pageIndex: 0, kind: 'dropdown', name: 'Colour', options: ['Red', ' Green ', 'Blue'], rect: { x: 50, y: 400, width: 120, height: 18 } }]);
  const dd = (await PDFDocument.load(Buffer.from(data, 'base64'))).getForm().getDropdown('Colour');
  assert.deepEqual(dd.getOptions(), ['Red', 'Green', 'Blue']);
  const [w] = await widgetsOf(data);
  assert.equal(w.fieldType, 'Ch');
  assert.deepEqual(w.rect.map(Math.round), [50, 400, 170, 418]);
});

test('add-form-fields rejects bad dropdown options', async () => {
  const doc = await PDFDocument.create(); doc.addPage([200, 200]);
  const data = b64(await doc.save()), rect = { x: 10, y: 10, width: 100, height: 20 };
  for (const options of [undefined, [], [''], ['x'.repeat(201)], Array(101).fill('a')]) {
    const r = await call('add-form-fields', { data, fields: [{ pageIndex: 0, kind: 'dropdown', name: 'D', options, rect }] });
    assert.equal(r.success, false, JSON.stringify(options)?.slice(0, 30));
  }
});

const W = (text, x0, y0, x1, y1) => ({ text, box: [x0, y0, x1, y1] });
test('suggest-field-name names a box after the label on its left and numbers duplicates', async () => {
  const data = await blank([{ ...TEXT, name: 'Surname' }]);
  const words = [W('Given', 100, 300, 160, 318), W('names', 168, 300, 230, 318)];
  const base = { data, kind: 'text', box: [300, 295, 600, 322], words, width: 1275 };
  assert.equal((await call('suggest-field-name', base)).name, 'Given names');
  const dup = await call('suggest-field-name', { ...base, words: [W('Surname', 100, 300, 190, 318)] });
  assert.equal(dup.name, 'Surname (2)');
  const none = await call('suggest-field-name', { ...base, words: [] });
  assert.equal(none.success, true); assert.match(none.name, /^Field/);
});

test('move-form-widget changes the rectangle, drops /AP of a text field and sets NeedAppearances', async () => {
  const data = await blank();
  const [text] = await widgetsOf(data);
  assert.ok((await widgetDict(data, 'Amount')).get(PDFName.of('AP')), 'the unmoved field has an appearance');
  const r = await call('move-form-widget', { data, ref: text.id, rect: [200, 650, 380, 690] });
  assert.equal(r.success, true, r.error);
  const doc = await PDFDocument.load(Buffer.from(r.data, 'base64'));
  const w = doc.getForm().getField('Amount').acroField.getWidgets()[0];
  assert.deepEqual(w.getRectangle(), { x: 200, y: 650, width: 180, height: 40 });
  assert.equal(w.dict.get(PDFName.of('AP')), undefined, '/AP removed');
  assert.equal(doc.getForm().acroForm.dict.get(PDFName.of('NeedAppearances')).toString(), 'true');
  const moved = (await widgetsOf(r.data)).find(x => x.fieldName === 'Amount');
  assert.deepEqual(moved.rect.map(Math.round), [200, 650, 380, 690]);
  // the other field is untouched, and a checkbox keeps the appearance streams it needs to show a tick
  const other = await call('move-form-widget', { data: r.data, ref: (await widgetsOf(r.data)).find(x => x.fieldName === 'Agree').id, rect: [300, 300, 330, 330] });
  assert.equal(other.success, true, other.error);
  assert.ok((await widgetDict(other.data, 'Agree')).get(PDFName.of('AP')));
});

test('move-form-widget rejects bad references, non-widgets and rectangles', async () => {
  const data = await blank(), [text] = await widgetsOf(data), rect = [100, 100, 200, 130];
  const fail = async (arg, re) => { const r = await call('move-form-widget', { data, rect, ...arg }); assert.equal(r.success, false, JSON.stringify(arg)); assert.match(r.error, re); };
  await fail({ ref: 'abc' }, /reference/);
  await fail({ ref: '9999R' }, /not a form field/);
  await fail({ ref: '1R' }, /not a form field/); // the catalog / pages tree, not a widget
  await fail({ ref: text.id, rect: [100, 100, 200] }, /rectangle/);
  await fail({ ref: text.id, rect: [100, 100, 103, 103] }, /at least 6/);
  await fail({ ref: text.id, rect: [-5, 100, 100, 130] }, /inside the page/);
  await fail({ ref: text.id, rect: [500, 100, 700, 130] }, /inside the page/);
  assert.match((await call('move-form-widget', { data: 'not a pdf', ref: text.id, rect })).error, /./);
});

test('a moved field still takes a pdf.js value and flattens with the text where it was moved', async () => {
  const data = await blank(), [text] = await widgetsOf(data);
  const moved = await call('move-form-widget', { data, ref: text.id, rect: [300, 300, 480, 330] });
  assert.equal(moved.success, true, moved.error);
  // (a) pdf.js reads it back, and (c) a value set through annotationStorage saves with an appearance
  const doc = await load(moved.data), widget = (await (await doc.getPage(1)).getAnnotations()).find(a => a.fieldName === 'Amount');
  assert.deepEqual(widget.rect.map(Math.round), [300, 300, 480, 330]);
  doc.annotationStorage.setValue(widget.id, { value: 'Forty two' });
  const saved = b64(await doc.saveDocument());
  assert.equal((await field(saved, 'Amount')).getText(), 'Forty two');
  // With NeedAppearances set pdf.js stores the value but writes no appearance of its own; Pagewise's save path (pdf-lib) draws it for the new size
  const baked = await call('apply-modifications', { originalData: saved, modifications: [] });
  assert.equal(baked.success, true, baked.error);
  const ap = (await widgetDict(baked.data, 'Amount')).get(PDFName.of('AP'));
  assert.ok(ap, 'the save path draws an appearance for the moved field');
  assert.equal((await field(baked.data, 'Amount')).getText(), 'Forty two');
  // (b) flatten-form works on it
  const flat = await call('flatten-form', { data: saved });
  assert.equal(flat.success, true, flat.error);
  assert.equal((await PDFDocument.load(Buffer.from(flat.data, 'base64'))).getForm().getFields().length, 0);
  const item = (await (await (await load(flat.data)).getPage(1)).getTextContent()).items.find(i => i.str.includes('Forty two'));
  assert.ok(item, 'value visible after flattening');
  assert.ok(item.transform[4] >= 300 && item.transform[4] < 480 && item.transform[5] >= 300 && item.transform[5] <= 330, 'text sits in the new rectangle: ' + item.transform.slice(4));
  // the same without pdf.js: a value set by pdf-lib on the moved field flattens in place too
  const f = await PDFDocument.load(Buffer.from(moved.data, 'base64')); f.getForm().getTextField('Amount').setText('Via pdf-lib');
  const flat2 = await call('flatten-form', { data: b64(await f.save()) });
  assert.equal(flat2.success, true, flat2.error);
  const item2 = (await (await (await load(flat2.data)).getPage(1)).getTextContent()).items.find(i => i.str.includes('Via pdf-lib'));
  assert.ok(item2 && item2.transform[5] >= 300 && item2.transform[5] <= 330);
});

const update = async (data, name, props) => call('update-form-field', { data, name, props });
test('update-form-field renames the field and keeps its value', async () => {
  let data = await blank();
  const f = await PDFDocument.load(Buffer.from(data, 'base64')); f.getForm().getTextField('Amount').setText('12.50'); data = b64(await f.save());
  const r = await update(data, 'Amount', { name: '  Total due ' });
  assert.equal(r.success, true, r.error);
  const form = (await PDFDocument.load(Buffer.from(r.data, 'base64'))).getForm();
  assert.deepEqual(form.getFields().map(x => x.getName()).sort(), ['Agree', 'Total due']);
  assert.equal(form.getTextField('Total due').getText(), '12.50');
  assert.equal((await widgetsOf(r.data)).find(w => w.fieldName === 'Total due').fieldValue, '12.50');
});

test('update-form-field sets comb, multi-line, font size, max length and flags on a text field', async () => {
  const data = await blank();
  let r = await update(data, 'Amount', { maxLength: 8, comb: true, fontSize: 14, readOnly: true, required: true });
  assert.equal(r.success, true, r.error);
  let t = (await PDFDocument.load(Buffer.from(r.data, 'base64'))).getForm().getTextField('Amount');
  assert.equal(t.getMaxLength(), 8); assert.equal(t.isCombed(), true); assert.equal(t.isReadOnly(), true); assert.equal(t.isRequired(), true);
  assert.equal(t.acroField.getDefaultAppearance().match(/([\d.]+) Tf/)[1], '14');
  const info = await call('get-form-field', { data: r.data, name: 'Amount' });
  assert.deepEqual({ ...info.field }, { kind: 'text', name: 'Amount', readOnly: true, required: true, multiline: false, maxLength: 8, comb: true, fontSize: 14 });
  r = await update(r.data, 'Amount', { comb: false, maxLength: 0, multiline: true, fontSize: 0, readOnly: false, required: false });
  assert.equal(r.success, true, r.error);
  t = (await PDFDocument.load(Buffer.from(r.data, 'base64'))).getForm().getTextField('Amount');
  assert.equal(t.isMultiline(), true); assert.equal(t.isCombed(), false); assert.equal(t.getMaxLength(), undefined); assert.equal(t.isReadOnly(), false);
  assert.equal(t.acroField.getDefaultAppearance().match(/([\d.]+) Tf/)[1], '0');
  assert.equal((await call('get-form-field', { data: r.data, name: 'Amount' })).field.fontSize, 0);
});

test('update-form-field edits dropdown options and typing, and checkbox flags', async () => {
  const data = await blank([{ pageIndex: 0, kind: 'dropdown', name: 'Colour', options: ['Red'], rect: { x: 50, y: 400, width: 120, height: 18 } }, CHECK]);
  const r = await update(data, 'Colour', { options: ['A', 'B'], editable: true, required: true });
  assert.equal(r.success, true, r.error);
  const dd = (await PDFDocument.load(Buffer.from(r.data, 'base64'))).getForm().getDropdown('Colour');
  assert.deepEqual(dd.getOptions(), ['A', 'B']); assert.equal(dd.isEditable(), true); assert.equal(dd.isRequired(), true);
  const c = await update(r.data, 'Agree', { readOnly: true, name: 'Consent', maxLength: 5 });
  assert.equal(c.success, true, c.error);
  const cb = (await PDFDocument.load(Buffer.from(c.data, 'base64'))).getForm().getCheckBox('Consent');
  assert.equal(cb.isReadOnly(), true);
});

test('update-form-field rejects invalid input and changes nothing', async () => {
  const data = await blank();
  const bad = [
    [{ name: '' }, /empty/], [{ name: '   ' }, /empty/], [{ name: 'Agree' }, /already named/], [{ name: 'a.b' }, /period/], [{ name: 'x'.repeat(101) }, /at most 100/],
    [{ comb: true }, /max length/], [{ comb: true, maxLength: 1 }, /max length/], [{ maxLength: -1 }, /Max length/], [{ maxLength: 1.5 }, /Max length/],
    [{ comb: true, maxLength: 5, multiline: true }, /multi-line/],
    [{ fontSize: 3 }, /Font size/], [{ fontSize: 73 }, /Font size/], [{ fontSize: 'big' }, /Font size/],
    [{ readOnly: 'yes' }, /true or false/], [{ required: 1 }, /true or false/]
  ];
  for (const [props, re] of bad) {
    const r = await update(data, 'Amount', props);
    assert.equal(r.success, false, JSON.stringify(props)); assert.match(r.error, re, JSON.stringify(props));
  }
  const dd = await blank([{ pageIndex: 0, kind: 'dropdown', name: 'D', options: ['x'], rect: { x: 50, y: 400, width: 120, height: 18 } }]);
  for (const options of [[], [' '], ['y'.repeat(201)], Array(101).fill('o'), 'x'])
    assert.equal((await update(dd, 'D', { options })).success, false, JSON.stringify(options).slice(0, 30));
  assert.equal((await update(data, 'Nope', { readOnly: true })).success, false);
});

test('the Forms menu reaches the tools the renderer handles', () => {
  const main = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8'), html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
  for (const tool of ['fieldText', 'fieldCheck', 'fieldDropdown', 'editFields']) {
    assert.ok(main.includes(`send('menu-tool', '${tool}')`), tool + ' is in the menu');
    assert.match(html, new RegExp(`FIELD_TOOL_LABELS = \\{[^}]*\\b${tool}:`), tool + ' is a renderer tool');
  }
});

test('suggest-field-name finds the label of a box drawn on the underline just below it', async () => {
  const data = await blank([]);
  const words = [W('Daytime', 100, 300, 180, 318), W('telephone', 186, 300, 280, 318)];
  // the drawn box starts 12 px below the label's top and only overlaps its last few px
  const r = await call('suggest-field-name', { data, kind: 'text', box: [300, 312, 600, 334], words, width: 1275 });
  assert.equal(r.name, 'Daytime telephone');
});

test('the Forms menu holds every form channel and Page holds none', () => {
  const main = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8').replace(/\r\n/g, '\n'); // Windows checkouts use CRLF
  const top = label => { // the text of one top-level menu: from its label to the next top-level label
    const start = main.indexOf(`\n    {\n      label: '${label}',`);
    assert.ok(start >= 0, label + ' menu exists');
    const end = main.indexOf('\n    {\n      label: ', start + 1);
    return main.slice(start, end);
  };
  const labels = [...main.matchAll(/\n    \{\n      label: '([^']+)'/g)].map(m => m[1]);
  assert.ok(labels.indexOf('Page') < labels.indexOf('Forms') && labels.indexOf('Forms') < labels.indexOf('Security'), 'Forms sits between Page and Security');
  const forms = top('Forms'), page = top('Page');
  const channels = ['menu-autofill', 'menu-sign-document', 'menu-make-fillable', 'menu-profiles', 'menu-save-answers', 'menu-profile-from-doc', 'menu-flatten-form',
    "menu-tool', 'fieldText", "menu-tool', 'fieldCheck", "menu-tool', 'fieldDropdown", "menu-tool', 'editFields"];
  for (const c of channels) { assert.ok(forms.includes(`send('${c}'`), c + ' is in Forms'); assert.ok(!page.includes(`send('${c}'`), c + ' is not in Page'); }
});

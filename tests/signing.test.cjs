const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { PDFDocument, PDFName, PDFString } = require('@cantoo/pdf-lib');
const { root, loadMainHandlers, loadRendererFunctions } = require('./helpers.cjs');

const plain = x => JSON.parse(JSON.stringify(x)); // values built inside the main-process sandbox live in another realm
const b64 = bytes => Buffer.from(bytes).toString('base64');
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p1sAAAAASUVORK5CYII=';
// A PNG header with the given size (the checks read only the signature and IHDR), padded to `bytes`
function fakePng(w, h, bytes = 64) {
  const buf = Buffer.alloc(bytes);
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]).copy(buf);
  buf.writeUInt32BE(13, 8); buf.write('IHDR', 12, 'latin1'); buf.writeUInt32BE(w, 16); buf.writeUInt32BE(h, 20);
  return buf.toString('base64');
}
function boot({ encrypt = true } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pagewise-sig-'));
  const safeStorage = {
    isEncryptionAvailable: () => encrypt,
    encryptString: s => Buffer.from('ENC:' + Buffer.from(s).toString('hex')),
    decryptString: b => { const t = b.toString(); if (!t.startsWith('ENC:')) throw new Error('cannot decrypt'); return Buffer.from(t.slice(4), 'hex').toString(); }
  };
  const app = { whenReady: () => ({ then: () => {} }), on: () => {}, quit: () => {}, exit: () => {}, getPath: () => userData, setPath: () => {} };
  const { handlers, context } = loadMainHandlers({ electron: { app, safeStorage } });
  return { handlers, m: context, userData, file: path.join(userData, 'profiles.json') };
}
const call = (t, name, arg) => t.handlers.get(name)(null, arg).then(plain);

test('saved signatures: add, list and remove, newest last, with the PNG data', async () => {
  const t = boot();
  assert.deepEqual((await call(t, 'signatures-get')).signatures, []);
  const a = await call(t, 'signatures-add', { kind: 'signature', png: PNG_1X1, w: 1, h: 1 });
  assert.equal(a.success, true, a.error);
  const b = await call(t, 'signatures-add', { kind: 'initials', png: PNG_1X1, w: 1, h: 1 });
  const list = (await call(t, 'signatures-get')).signatures;
  assert.deepEqual(list.map(s => s.kind), ['signature', 'initials']);
  assert.equal(list[0].png, PNG_1X1);
  assert.deepEqual([list[0].w, list[0].h], [1, 1]);
  assert.equal((await call(t, 'signatures-remove', { id: a.signature.id })).success, true);
  assert.deepEqual((await call(t, 'signatures-get')).signatures.map(s => s.id), [b.signature.id]);
});

test('at most 10 signatures are kept', async () => {
  const t = boot();
  for (let i = 0; i < 10; i++) assert.equal((await call(t, 'signatures-add', { kind: 'signature', png: PNG_1X1 })).success, true);
  const r = await call(t, 'signatures-add', { kind: 'signature', png: PNG_1X1 });
  assert.equal(r.success, false);
  assert.match(r.error, /At most 10/);
  assert.equal((await call(t, 'signatures-get')).signatures.length, 10);
});

test('only PNG data within the size limits is stored', async () => {
  const t = boot();
  const jpeg = b64(Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(60)]));
  const bad = [
    ['JPEG data', { kind: 'signature', png: jpeg }, /PNG/],
    ['text', { kind: 'signature', png: 'not base64!' }, /PNG/],
    ['a data URL', { kind: 'signature', png: 'data:image/png;base64,' + PNG_1X1 }, /PNG/],
    ['over 2 MB', { kind: 'signature', png: fakePng(10, 10, 2 * 1024 * 1024 + 3) }, /PNG/],
    ['over 2000 px wide', { kind: 'signature', png: fakePng(2001, 10) }, /2000/],
    ['over 2000 px tall', { kind: 'signature', png: fakePng(10, 2001) }, /2000/],
    ['zero size', { kind: 'signature', png: fakePng(0, 10) }, /2000/],
    ['an unknown kind', { kind: 'photo', png: PNG_1X1 }, /signature or initials/]
  ];
  for (const [what, arg, re] of bad) {
    const r = await call(t, 'signatures-add', arg);
    assert.equal(r.success, false, what);
    assert.match(r.error, re, what);
  }
  assert.equal((await call(t, 'signatures-add', { kind: 'signature', png: fakePng(2000, 2000) })).success, true);
  assert.deepEqual((await call(t, 'signatures-get')).signatures.length, 1);
});

test('signatures are encrypted with the profiles, and not readable from the file', async () => {
  const t = boot({ encrypt: true });
  const png = fakePng(40, 20, 400);
  await call(t, 'signatures-add', { kind: 'signature', png });
  const file = fs.readFileSync(t.file, 'utf8');
  assert.ok(JSON.parse(file).enc, 'encrypted envelope');
  assert.ok(!file.includes(png) && !file.includes(png.slice(0, 40)), 'no raw PNG base64 in the file');
  assert.equal((await call(t, 'signatures-get')).signatures[0].png, png);
  const plainBoot = boot({ encrypt: false });
  await call(plainBoot, 'signatures-add', { kind: 'signature', png });
  assert.ok(JSON.parse(fs.readFileSync(plainBoot.file, 'utf8')).plain.signatures[0].png === png, 'stored in the clear only when there is no keyring');
});

test('saving profiles keeps the signatures, and an old profiles file without them still loads', async () => {
  const t = boot();
  await call(t, 'signatures-add', { kind: 'signature', png: PNG_1X1 });
  const got = await call(t, 'profiles-get');
  assert.equal(got.signatures, undefined, 'profiles-get does not ship signature images');
  assert.equal((await call(t, 'profiles-set', { profiles: [{ id: 'p1', name: 'Me', details: { firstName: 'Jane' } }], lastSelf: 'p1', lastSpouse: null })).success, true);
  assert.equal((await call(t, 'profiles-remember', { lastSelf: 'p1', lastSpouse: null })).success, true);
  assert.equal((await call(t, 'signatures-get')).signatures.length, 1);
  assert.equal((await call(t, 'profiles-get')).profiles[0].details.firstName, 'Jane');

  const old = boot();
  fs.writeFileSync(old.file, JSON.stringify({ v: 2, plain: { profiles: [{ id: 'p1', name: 'Old', details: { firstName: 'Ann' } }], lastSelf: 'p1', lastSpouse: null } }));
  assert.equal((await call(old, 'profiles-get')).profiles[0].name, 'Old');
  assert.deepEqual((await call(old, 'signatures-get')).signatures, []);
  assert.equal((await call(old, 'signatures-add', { kind: 'initials', png: PNG_1X1 })).success, true);
  assert.equal((await call(old, 'profiles-get')).profiles[0].details.firstName, 'Ann');
});

test('a corrupt saved signature is dropped without losing the profiles', async () => {
  const t = boot({ encrypt: false });
  fs.writeFileSync(t.file, JSON.stringify({ v: 2, plain: { profiles: [{ id: 'p1', name: 'Me', details: {} }], signatures: [{ id: 'x', kind: 'signature', png: 'AAAA' }, { id: 'y', kind: 'signature', png: PNG_1X1 }] } }));
  assert.deepEqual((await call(t, 'signatures-get')).signatures.map(s => s.id), ['y']);
  assert.equal((await call(t, 'profiles-get')).profiles.length, 1);
});

// ---------- placing in the saved file ----------
async function jpegDataUrl() {
  const c = createCanvas(60, 20), ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 60, 20); ctx.fillStyle = '#000'; ctx.fillRect(5, 5, 50, 10);
  return 'data:image/jpeg;base64,' + c.toBuffer('image/jpeg').toString('base64');
}
async function placeOne(mod) {
  const { handlers } = loadMainHandlers();
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]);
  const r = await handlers.get('apply-modifications')(null, { originalData: b64(await doc.save()), modifications: [{ pageIndex: 0, ...mod }] });
  assert.equal(r.success, true, r.error);
  return Buffer.from(r.data, 'base64');
}
// [width, height, x, y] of every image drawn on page 1: the cm matrices before each Do, multiplied, from the inflated content streams
async function drawn(bytes) {
  const pdf = await PDFDocument.load(bytes), pg = pdf.getPage(0), contents = pg.node.Contents();
  const refs = contents.asArray ? contents.asArray() : [pg.node.get(PDFName.of('Contents'))];
  const text = refs.map(r => zlib.inflateSync(Buffer.from(pdf.context.lookup(r).contents)).toString('latin1')).join('\n');
  const mul = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
  const out = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  for (const tok of text.matchAll(/(?:(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) cm)|(\/\S+ Do)|(^q$)/gm)) {
    if (tok[7]) out.push([ctm[0], ctm[3], ctm[4], ctm[5]]);
    else if (tok[8]) ctm = [1, 0, 0, 1, 0, 0];
    else ctm = mul(tok.slice(1, 7).map(Number), ctm);
  }
  return out;
}

test('a JPEG signature embeds and is drawn at the requested size', async () => {
  const out = await placeOne({ type: 'signature', x: 0.1, y: 0.2, width: 0.4, height: 0.1333, imageData: await jpegDataUrl() });
  const [[w, h, x, y]] = await drawn(out);
  assert.ok(Math.abs(w - 120) < 0.5 && Math.abs(h - 40) < 0.5, `size ${w} x ${h}`);
  assert.ok(Math.abs(x - 30) < 0.5 && Math.abs(y - (300 - 60 - 40)) < 0.5, `at ${x}, ${y}`);
  assert.equal((await PDFDocument.load(out)).getPageCount(), 1);
});
test('PNG signatures and mislabelled images embed by their real format', async () => {
  const png = await placeOne({ type: 'signature', x: 0, y: 0, width: 0.5, height: 0.25, imageData: 'data:image/png;base64,' + PNG_1X1 });
  assert.equal((await drawn(png)).length, 1);
  const jpeg = (await jpegDataUrl()).split(',')[1];
  assert.equal((await drawn(await placeOne({ type: 'image', imageType: 'png', x: 0, y: 0, width: 0.5, height: 0.25, imageData: jpeg }))).length, 1, 'JPEG data labelled png');
  assert.equal((await drawn(await placeOne({ type: 'image', imageType: 'jpeg', x: 0, y: 0, width: 0.5, height: 0.25, imageData: PNG_1X1 }))).length, 1, 'PNG data labelled jpeg');
});
test('an image that is neither PNG nor JPEG is refused', async () => {
  const { handlers } = loadMainHandlers();
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]);
  const r = await handlers.get('apply-modifications')(null, { originalData: b64(await doc.save()), modifications: [{ type: 'signature', pageIndex: 0, x: 0, y: 0, width: 0.2, height: 0.1, imageData: 'data:image/webp;base64,' + b64(Buffer.from('RIFFxxxxWEBP')) }] });
  assert.equal(r.success, false);
});

test('signing over a form field hides that widget so its background cannot cover the signature', async () => {
  const doc = await PDFDocument.create(), pg = doc.addPage([300, 300]), form = doc.getForm();
  form.createTextField('sig').addToPage(pg, { x: 20, y: 100, width: 150, height: 22 });
  form.createTextField('other').addToPage(pg, { x: 20, y: 50, width: 150, height: 22 });
  const ref = name => form.getTextField(name).acroField.getWidgets()[0], refOf = name => doc.context.getObjectRef(ref(name).dict);
  const id = r => r.objectNumber + 'R' + (r.generationNumber ? r.generationNumber : '');
  const { handlers } = loadMainHandlers();
  const sig = { type: 'signature', pageIndex: 0, x: 0.1, y: 0.6, width: 0.3, height: 0.1, imageData: 'data:image/png;base64,' + PNG_1X1 };
  const r = await handlers.get('apply-modifications')(null, { originalData: b64(await doc.save()), modifications: [{ ...sig, field: id(refOf('sig')) }, { ...sig, field: 'junk' }] });
  assert.equal(r.success, true, r.error);
  const out = (await PDFDocument.load(Buffer.from(r.data, 'base64'))).getForm(), flags = name => { const f = out.getTextField(name).acroField.getWidgets()[0].dict.get(PDFName.of('F')); return f ? f.asNumber() : 0; };
  assert.equal(flags('sig') & 2, 2, 'the signed field is hidden');
  assert.equal(flags('other') & 2, 0, 'other fields stay visible');
});

// ---------- where to sign ----------
const W = (text, x0, y0, x1, y1) => ({ text, box: [x0, y0, x1, y1] });
const field = (id, label, box) => ({ id, name: label, alt: label, maxLen: 0, comb: false, box });
const page = (over = {}) => ({ page: 1, width: 1275, height: 1650, scale: 150 / 72, fields: [], sigFields: [], words: [], ...over });
const NOW = new Date(2026, 9, 5);

test('sign-places finds the signature place on the W-9, which has no field for it', async () => {
  const { context: m } = loadMainHandlers();
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(path.join(root, 'tests/fixtures/forms/fw9.pdf'))) }).promise;
  const pg = await doc.getPage(1), vp = pg.getViewport({ scale: 150 / 72 });
  const { functions } = loadRendererFunctions(['pageWords'], { extra: { pdfjsLib: { Util: pdfjs.Util } } });
  const words = functions.pageWords((await pg.getTextContent()).items, vp);
  const img = await loadImage(path.join(root, 'tests/fixtures/forms/fw9.png')), c = createCanvas(img.width, img.height), ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, img.width, img.height).data, gray = new Uint8Array(img.width * img.height);
  for (let i = 0; i < gray.length; i++) gray[i] = Math.round(0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]);
  // what the sign-places handler does with the rendered page, minus the Electron image decoding
  const detected = m.detectFormFields({ width: img.width, height: img.height, data: gray }).filter(f => f.kind === 'text').map(f => { const out = {}; return { box: f.box, label: m.labelFor(f, words, img.width / 1275, 1, out), lineLeft: out.lineLeft }; });
  const places = plain(m.findSignPlaces({ pages: [page({ width: img.width, height: img.height, words, detected })], self: null, now: NOW }));
  assert.equal(places.length, 1, JSON.stringify(places));
  const [p] = places;
  assert.equal(p.kind, 'detected');
  assert.match(p.label, /^Signature/);
  assert.ok(p.box[1] > 1150 && p.box[3] < 1300 && p.box[0] < 400, `box ${p.box}`); // the line after "Signature of U.S. person"
  assert.ok(p.x > 0 && p.width > 0.3 && p.height > 0 && p.y > 0.7 && p.y < 0.8);
  assert.equal(p.date, null, 'the W-9 date line is not a form field, so nothing is filled');
});

test('sign-places finds a signature field, the date beside it, and skips a spouse', () => {
  const { context: m } = loadMainHandlers();
  const pages = [page({ fields: [
    field('1R', 'Your signature', [100, 400, 500, 440]), field('2R', 'Date', [560, 400, 700, 440]),
    field('3R', "Spouse's signature", [100, 500, 500, 540]), field('4R', "Spouse's date", [560, 500, 700, 540]),
    field('5R', 'Preparer signature', [100, 600, 500, 640]),
    field('6R', 'Date of birth', [560, 700, 700, 740]), field('7R', 'Full name', [100, 700, 500, 740])
  ] })];
  const places = plain(m.findSignPlaces({ pages, self: { dateFormat: 'DD/MM/YYYY' }, now: NOW }));
  assert.deepEqual(places.map(p => p.id), ['1R'], 'spouse and preparer signatures are not offered');
  assert.deepEqual(places[0].date, { id: '2R', label: 'Date', value: '05/10/2026' });
  assert.equal(places[0].kind, 'field');
  assert.deepEqual([places[0].x, places[0].y], [100 / 1275, 400 / 1650]);
});

test('a blank line found on the page image is not offered again when a field already covers it', () => {
  const { context: m } = loadMainHandlers();
  const sigField = field('1R', 'Signature', [100, 400, 500, 440]);
  const pages = [page({ fields: [sigField], detected: [{ box: [104, 404, 498, 436], label: 'Signature' }, { box: [100, 800, 500, 840], label: 'Signature of taxpayer' }] })];
  const places = plain(m.findSignPlaces({ pages, now: NOW }));
  assert.deepEqual(places.map(p => [p.kind, p.id]), [['field', '1R'], ['detected', null]]);
});

test('a caption split over two lines beside the rule still names the signature place (the W-9 as the app sees it)', () => {
  const { context: m } = loadMainHandlers();
  const words = [W('Sign', 75, 1201, 119, 1222), W('Here', 75, 1222, 122, 1242), W('Signature', 158, 1210, 222, 1224), W('of', 229, 1210, 243, 1224), W('U.S.', 158, 1227, 188, 1242), W('person', 195, 1227, 239, 1242), W('Date', 803, 1227, 836, 1242)];
  const detect = (box, label) => { const out = {}, f = { kind: 'text', box }; return { box, label: m.labelFor(f, words, 1, 1, out), lineLeft: out.lineLeft }; };
  const sig = detect([239, 1201, 804, 1249]), date = detect([836, 1201, 1198, 1249]);
  assert.equal(sig.label, 'person', 'the nearest word alone says nothing');
  const places = plain(m.findSignPlaces({ pages: [page({ words, detected: [sig, date] })], now: NOW }));
  assert.deepEqual(places.map(p => [p.kind, p.box[0]]), [['detected', 239]], 'the Date blank is not a signature place');
  assert.match(places[0].label, /^Signature.*person$/);
  const spouse = detect([239, 1201, 804, 1249]);
  spouse.lineLeft = "Spouse's signature";
  assert.deepEqual(plain(m.findSignPlaces({ pages: [page({ words, detected: [spouse] })], now: NOW })), []);
});

test('the date is the field to the right within 3 inches, or directly below, in the profile format', () => {
  const { context: m } = loadMainHandlers();
  const find = (fields, over = {}) => plain(m.findSignPlaces({ pages: [page({ fields })], self: { dateFormat: 'YYYY-MM-DD' }, now: NOW, ...over }))[0];
  const sig = field('1R', 'Sign here', [100, 400, 500, 440]);
  assert.equal(find([sig, field('2R', 'Date', [560, 405, 700, 445])]).date.value, '2026-10-05');
  assert.equal(find([sig, field('2R', 'Date', [1000, 400, 1100, 440])]).date, null, 'more than 3 inches (450 px) away');
  assert.equal(find([sig, field('2R', 'Date', [150, 470, 300, 500])]).date.id, '2R', 'directly below');
  assert.equal(find([sig, field('2R', 'Date', [150, 900, 300, 930])]).date, null, 'far below');
  assert.equal(find([sig, field('2R', 'Date', [560, 400, 700, 440]), field('3R', 'Date', [520, 400, 540, 440])]).date.id, '3R', 'nearest wins');
  assert.equal(find([sig, field('2R', 'Date', [560, 400, 700, 440])], { skipIds: ['2R'] }).date, null, 'a date already filled is left alone');
  assert.equal(find([sig, field('2R', 'Date of birth', [560, 400, 700, 440])]).date, null);
  assert.equal(find([sig, field('2R', 'Date signed', [560, 400, 700, 440])]).date.id, '2R');
});

test('signature widgets are places, labelled by their tooltip; their other-person labels are skipped', async () => {
  const { context: m } = loadMainHandlers();
  const pdf = await PDFDocument.create(), pg = pdf.addPage([612, 792]);
  const sigs = [['Applicant signature', [100, 600, 300, 640]], ["Spouse's signature", [100, 500, 300, 540]]].map(([tip, rect], i) => pdf.context.register(pdf.context.obj({ FT: 'Sig', T: PDFString.of('Sig' + i), TU: PDFString.of(tip), Type: 'Annot', Subtype: 'Widget', Rect: rect, F: 4, P: pg.ref })));
  const text = pdf.getForm().createTextField('Date'); text.addToPage(pg, { x: 320, y: 605, width: 80, height: 20 });
  pg.node.set(PDFName.of('Annots'), pdf.context.obj([...sigs, ...pg.node.Annots().asArray()]));
  pdf.getForm().acroForm.dict.set(PDFName.of('Fields'), pdf.context.obj([...sigs, ...pdf.getForm().acroForm.dict.lookup(PDFName.of('Fields')).asArray()]));
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await pdf.save()) }).promise;
  const p = await doc.getPage(1), vp = p.getViewport({ scale: 150 / 72 });
  const widgets = (await p.getAnnotations()).filter(a => a.subtype === 'Widget'), box = a => { const [ax, ay, bx, by] = vp.convertToViewportRectangle(a.rect); return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)]; };
  const f = a => ({ id: a.id, name: a.fieldName, alt: a.alternativeText, maxLen: 0, comb: false, box: box(a) });
  const sigFields = widgets.filter(a => a.fieldType === 'Sig').map(f), fields = widgets.filter(a => a.fieldType === 'Tx').map(f);
  assert.equal(sigFields.length, 2);
  const places = plain(m.findSignPlaces({ pages: [{ page: 1, width: vp.width, height: vp.height, scale: 150 / 72, fields, sigFields, words: [W('Date', 600, 352, 655, 385)] }], now: NOW })); // the printed label beside the field
  assert.deepEqual(places.map(x => [x.kind, x.label]), [['sigfield', 'Applicant signature']]);
  assert.equal(places[0].date.label, 'Date');
});

// ---------- the menu ----------
test('Forms has Sign Document, wired from the menu to the renderer', () => {
  const read = f => fs.readFileSync(path.join(root, f), 'utf8');
  assert.match(read('src/main.js'), /label: 'Sign Document\.\.\.',\s*click: \(\) => mainWindow\.webContents\.send\('menu-sign-document'\)/);
  assert.match(read('src/preload.js'), /onMenuSignDocument:/);
  assert.match(read('src/index.html'), /onMenuSignDocument\(showSignDocument\)/);
});

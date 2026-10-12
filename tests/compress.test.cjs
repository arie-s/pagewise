const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { PDFDocument, PDFName, PDFNumber, PDFRawStream, StandardFonts, PDFString, rgb } = require('@cantoo/pdf-lib');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { loadMainHandlers } = require('./helpers.cjs');

const plain = x => JSON.parse(JSON.stringify(x));
const { handlers, context: m } = loadMainHandlers();
m.loadJpegImage = async () => (await import('pdfjs-dist/image_decoders/pdf.image_decoders.min.mjs')).JpegImage; // vm scripts cannot import()
const pdfjs = () => import('pdfjs-dist/legacy/build/pdf.mjs');
const openPdf = async d => (await pdfjs()).getDocument({ data: new Uint8Array(d), verbosity: 0 }).promise;

// Test codec: the packaged app uses Electron's nativeImage
const decode = async buf => { const i = await loadImage(buf); const c = createCanvas(i.width, i.height); c.getContext('2d').drawImage(i, 0, 0); return c; };
m.imageCodec = {
  fromRgba: ({ width, height, data }) => { const c = createCanvas(width, height), x = c.getContext('2d'), id = x.createImageData(width, height); id.data.set(data); x.putImageData(id, 0, 0); return c; },
  resize: (c, w, h) => { const o = createCanvas(w, h), x = o.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(c, 0, 0, w, h); return o; },
  toJpeg: (c, q) => c.toBuffer('image/jpeg', q),
  size: c => ({ width: c.width, height: c.height })
};

let seed = 12345;
const rnd = () => { let t = (seed = (seed + 0x6D2B79F5) | 0); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
// Four flat colour quadrants plus noise, as RGB samples
function quadrants(w, h, colors, noise = 16) {
  const out = Buffer.alloc(w * h * colors[0].length), n = colors[0].length;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = colors[(y < h / 2 ? 0 : 2) + (x < w / 2 ? 0 : 1)];
    for (let k = 0; k < n; k++) out[(y * w + x) * n + k] = Math.max(0, Math.min(255, c[k] + (rnd() - 0.5) * noise));
  }
  return out;
}
const QUAD = [[220, 30, 30], [30, 200, 40], [30, 40, 220], [230, 220, 30]];
const centre = (w, h) => [[w / 4, h / 4], [3 * w / 4, h / 4], [w / 4, 3 * h / 4], [3 * w / 4, 3 * h / 4]].map(([x, y]) => [Math.round(x), Math.round(y)]);
function noisyJpeg(w, h, q = 95) {
  const c = createCanvas(w, h), x = c.getContext('2d'), id = x.createImageData(w, h);
  for (let i = 0; i < w * h; i++) { const b = (i % w) / w * 200; id.data[i * 4] = b + rnd() * 55; id.data[i * 4 + 1] = 255 - b + rnd() * 55 - 55; id.data[i * 4 + 2] = rnd() * 255; id.data[i * 4 + 3] = 255; }
  x.putImageData(id, 0, 0);
  return c.toBuffer('image/jpeg', q);
}
const crc = (() => { const t = Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xEDB88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; }); return b => { let c = ~0; for (const v of b) c = t[(c ^ v) & 255] ^ (c >>> 8); return ~c >>> 0; }; })();
function png(w, h, rgbData) { // opaque 8-bit RGB PNG, filter 0
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) rgbData.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  const chunk = (type, data) => { const b = Buffer.concat([Buffer.from(type), data]), o = Buffer.alloc(b.length + 8); o.writeUInt32BE(data.length, 0); b.copy(o, 4); o.writeUInt32BE(crc(b), b.length + 4); return o; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function predicted(data, w, h, n) { // PNG-filter rows cycling through Sub, Up, Average, Paeth
  const stride = w * n, out = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const t = 1 + (y % 4); out[y * (stride + 1)] = t;
    for (let i = 0; i < stride; i++) {
      const a = i >= n ? data[y * stride + i - n] : 0, b = y ? data[(y - 1) * stride + i] : 0, c = y && i >= n ? data[(y - 1) * stride + i - n] : 0;
      let p = t === 1 ? a : t === 2 ? b : t === 3 ? (a + b) >> 1 : (() => { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; })();
      out[y * (stride + 1) + 1 + i] = (data[y * stride + i] - p) & 255;
    }
  }
  return out;
}
// Embed a hand-built image stream on a page of the given size (full page)
function rawImage(doc, dict, bytes) {
  const ctx = doc.context, ref = ctx.register(PDFRawStream.of(ctx.obj(dict), bytes));
  return ref;
}
function drawRaw(page, ref, name = 'Im1') {
  const { width, height } = page.getSize(), res = page.node.normalizedEntries().Resources;
  res.set(PDFName.of('XObject'), page.doc.context.obj({ [name]: ref }));
  page.pushOperators(...[]);
  page.node.addContentStream(page.doc.context.register(page.doc.context.flateStream(Buffer.from(`q ${width} 0 0 ${height} 0 0 cm /${name} Do Q`))));
}
async function singleImagePdf(pageW, pageH, make) {
  const doc = await PDFDocument.create(), page = doc.addPage([pageW, pageH]);
  const ref = make(doc);
  drawRaw(page, ref);
  return Buffer.from(await doc.save());
}
async function images(bytes) {
  const doc = await PDFDocument.load(bytes), out = [];
  for (const [, o] of doc.context.enumerateIndirectObjects()) {
    if (!(o instanceof PDFRawStream) || o.dict.lookup(PDFName.of('Subtype')) !== PDFName.of('Image')) continue;
    const g = k => o.dict.lookup(PDFName.of(k));
    out.push({ width: g('Width').asNumber(), height: g('Height').asNumber(), cs: g('ColorSpace')?.toString(), filter: g('Filter')?.toString(), mask: !!g('SMask'), raw: Buffer.from(o.contents) });
  }
  return out;
}
const pixel = async (jpeg, x, y) => Array.from((await decode(jpeg)).getContext('2d').getImageData(x, y, 1, 1).data).slice(0, 3);
const near = (a, b, tol, msg) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) <= tol, `${msg}: ${a} vs ${b}`));
const stats = r => plain(r.images);

test('a big JPEG is downsampled to the standard preset and the file shrinks a lot', async () => {
  const jpg = noisyJpeg(3000, 4000);
  const doc = await PDFDocument.create(), page = doc.addPage([612, 792]);
  page.drawImage(await doc.embedJpg(jpg), { x: 0, y: 0, width: 612, height: 792 });
  const bytes = Buffer.from(await doc.save());
  const r = await m.compressPdf(bytes, 'standard');
  assert.deepEqual(stats(r), { total: 1, recompressed: 1, skipped: 0 });
  const [img] = await images(r.data);
  assert.equal(Math.max(img.width, img.height), 1650);
  assert.equal(img.height, 1650);
  assert.ok(r.after < r.before / 4, `${r.before} -> ${r.after}`);
  assert.equal(r.after, r.data.length);
  await (await openPdf(r.data)).getPage(1);
});

test('presets pick their own resolution', async () => {
  const bytes = await singleImagePdf(612, 792, doc => doc.context.register(PDFRawStream.of(doc.context.obj({ Type: 'XObject', Subtype: 'Image', Width: 2400, Height: 3000, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode' }), noisyJpeg(2400, 3000))));
  const sizes = {};
  for (const p of ['screen', 'standard', 'print']) sizes[p] = (await images((await m.compressPdf(bytes, p)).data))[0].height;
  assert.deepEqual(sizes, { screen: 1100, standard: 1650, print: 2420 });
  await assert.rejects(m.compressPdf(bytes, 'nope'));
});

test('an opaque PNG embedded by pdf-lib (Flate with a PNG predictor) is re-encoded', async () => {
  const w = 600, h = 800, samples = quadrants(w, h, QUAD);
  const doc = await PDFDocument.create(), page = doc.addPage([200, 267]);
  page.drawImage(await doc.embedPng(png(w, h, samples)), { x: 0, y: 0, width: 200, height: 267 });
  const bytes = Buffer.from(await doc.save());
  const r = await m.compressPdf(bytes, 'standard');
  assert.deepEqual(stats(r), { total: 1, recompressed: 1, skipped: 0 });
  const [img] = await images(r.data);
  assert.equal(img.filter, '/DCTDecode');
  assert.equal(img.height, Math.ceil(150 * 267 / 72));
  for (const [i, [x, y]] of centre(img.width, img.height).entries()) near(await pixel(img.raw, x, y), QUAD[i], 14, 'quadrant ' + i);
  assert.ok(r.after < r.before / 3);
});

test('a hand-built Flate image with Sub/Up/Average/Paeth predictor rows decodes correctly', async () => {
  const w = 500, h = 400, samples = quadrants(w, h, QUAD);
  const bytes = await singleImagePdf(180, 144, doc => rawImage(doc, { Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'FlateDecode', DecodeParms: { Predictor: 15, Colors: 3, Columns: w, BitsPerComponent: 8 } }, zlib.deflateSync(predicted(samples, w, h, 3))));
  const r = await m.compressPdf(bytes, 'standard');
  assert.deepEqual(stats(r), { total: 1, recompressed: 1, skipped: 0 });
  const [img] = await images(r.data);
  assert.equal(img.width, Math.ceil(150 * 180 / 72));
  for (const [i, [x, y]] of centre(img.width, img.height).entries()) near(await pixel(img.raw, x, y), QUAD[i], 14, 'quadrant ' + i);
});

test('an unfiltered, unpredicted Flate image works too', async () => {
  const w = 400, h = 300, samples = quadrants(w, h, QUAD);
  const bytes = await singleImagePdf(100, 75, doc => rawImage(doc, { Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'FlateDecode' }, zlib.deflateSync(samples)));
  const r = await m.compressPdf(bytes, 'standard');
  assert.equal(r.images.recompressed, 1);
  const [img] = await images(r.data);
  for (const [i, [x, y]] of centre(img.width, img.height).entries()) near(await pixel(img.raw, x, y), QUAD[i], 14, 'quadrant ' + i);
});

test('a PNG with transparency (SMask) is skipped and the page still renders', async () => {
  const c = createCanvas(800, 800), x = c.getContext('2d');
  for (let i = 0; i < 4000; i++) { x.fillStyle = `rgba(${rnd() * 255 | 0},${rnd() * 255 | 0},${rnd() * 255 | 0},${0.3 + rnd() * 0.5})`; x.fillRect(rnd() * 800, rnd() * 800, 40, 40); }
  const doc = await PDFDocument.create(), page = doc.addPage([200, 200]);
  page.drawImage(await doc.embedPng(c.toBuffer('image/png')), { x: 0, y: 0, width: 200, height: 200 });
  const r = await m.compressPdf(Buffer.from(await doc.save()), 'screen');
  assert.deepEqual(stats(r), { total: 1, recompressed: 0, skipped: 1 });
  const [img] = (await images(r.data)).filter(i => i.filter === '/FlateDecode' && i.cs === '/DeviceRGB');
  assert.equal(img.mask, true);
  const canvas = createCanvas(200, 200), page1 = await (await openPdf(r.data)).getPage(1);
  await page1.render({ canvasContext: canvas.getContext('2d'), viewport: page1.getViewport({ scale: 1 }) }).promise;
});

test('gray images stay gray', async () => {
  const w = 700, h = 700, g = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = Math.max(0, Math.min(255, 140 + (rnd() - 0.5) * 60));
  const bytes = await singleImagePdf(200, 200, doc => rawImage(doc, { Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceGray', BitsPerComponent: 8, Filter: 'FlateDecode' }, zlib.deflateSync(g)));
  const r = await m.compressPdf(bytes, 'standard');
  assert.equal(r.images.recompressed, 1);
  const [img] = await images(r.data), px = await pixel(img.raw, 100, 100);
  assert.ok(Math.max(...px) - Math.min(...px) <= 3, 'channels differ: ' + px);
  near(px, [140, 140, 140], 25, 'gray level');
});

test('CMYK Flate images are converted to RGB with the right colours', async () => {
  const w = 700, h = 700, C = [[255, 0, 0, 0], [0, 0, 0, 255], [0, 255, 0, 0], [0, 0, 0, 0]];
  const samples = quadrants(w, h, C, 10);
  const bytes = await singleImagePdf(200, 200, doc => rawImage(doc, { Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceCMYK', BitsPerComponent: 8, Filter: 'FlateDecode' }, zlib.deflateSync(samples)));
  const r = await m.compressPdf(bytes, 'standard');
  assert.equal(r.images.recompressed, 1);
  const [img] = await images(r.data);
  assert.equal(img.cs, '/DeviceRGB');
  const want = [[0, 255, 255], [0, 0, 0], [255, 0, 255], [255, 255, 255]];
  for (const [i, [x, y]] of centre(img.width, img.height).entries()) near(await pixel(img.raw, x, y), want[i], 30, 'cmyk quadrant ' + i);
});

test('Adobe CMYK JPEGs are decoded with pdf.js and come out as RGB with the right colours', async () => {
  const jpg = fs.readFileSync(path.join(__dirname, 'fixtures/cmyk-quadrants.jpg')); // PIL CMYK JPEG: Adobe marker, inverted ink values
  const make = extra => singleImagePdf(200, 200, doc => rawImage(doc, { Type: 'XObject', Subtype: 'Image', Width: 256, Height: 256, ColorSpace: 'DeviceCMYK', BitsPerComponent: 8, Filter: 'DCTDecode', ...extra }, jpg));
  const r = await m.compressPdf(await make({}), 'standard');
  assert.equal(r.images.recompressed, 1);
  const [img] = await images(r.data);
  assert.equal(img.cs, '/DeviceRGB');
  // pdf.js uses a press-like CMYK conversion (cyan is about 0,174,239), so check the colour families
  const ok = [([r, g, b]) => r < 30 && g > 150 && b > 200, ([r, g, b]) => r < 70 && g < 70 && b < 70, ([r, g, b]) => r > 200 && g < 50 && b > 100, ([r, g, b]) => r > 235 && g > 235 && b > 235];
  for (const [i, [x, y]] of centre(img.width, img.height).entries()) { const px = await pixel(img.raw, x, y); assert.ok(ok[i](px), `cmyk jpeg quadrant ${i}: ${px}`); }
  const inv = await m.compressPdf(await make({ Decode: [1, 0, 1, 0, 1, 0, 1, 0] }), 'standard');
  assert.deepEqual(stats(inv), { total: 1, recompressed: 0, skipped: 1 });
});

test('text, vectors, form fields, annotations and the outline survive', async () => {
  const doc = await PDFDocument.create(), page = doc.addPage([612, 792]), font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Quarterly report 2026', { x: 50, y: 700, size: 20, font });
  page.drawRectangle({ x: 50, y: 400, width: 200, height: 100, color: rgb(0.2, 0.4, 0.8) });
  page.drawImage(await doc.embedJpg(noisyJpeg(1800, 1800)), { x: 300, y: 300, width: 250, height: 250 });
  const tf = doc.getForm().createTextField('name'); tf.setText('Jane Müller'); tf.addToPage(page, { x: 50, y: 600, width: 200, height: 24 });
  const ctx = doc.context;
  const annot = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [60, 300, 80, 320], Contents: PDFString.of('check this'), Name: 'Comment' }));
  page.node.set(PDFName.of('Annots'), ctx.obj([...page.node.Annots().asArray(), annot]));
  const outlines = ctx.nextRef(), item = ctx.nextRef();
  ctx.assign(outlines, ctx.obj({ Type: 'Outlines', First: item, Last: item, Count: 1 }));
  ctx.assign(item, ctx.obj({ Title: PDFString.of('Chapter 1'), Parent: outlines, Dest: [page.ref, 'Fit'] }));
  doc.catalog.set(PDFName.of('Outlines'), outlines);
  page.node.set(PDFName.of('Thumb'), ctx.register(ctx.stream('x')));
  doc.catalog.set(PDFName.of('PieceInfo'), ctx.obj({ App: {} }));
  const bytes = Buffer.from(await doc.save());
  const r = await m.compressPdf(bytes, 'standard');
  assert.equal(r.images.recompressed, 1);
  assert.ok(r.after < r.before);
  const [a, b] = [await openPdf(bytes), await openPdf(r.data)];
  const text = async d => (await (await d.getPage(1)).getTextContent()).items.map(i => i.str).join('|');
  assert.equal(await text(b), await text(a));
  assert.match(await text(b), /Quarterly report 2026/);
  const fields = plain(await b.getFieldObjects());
  assert.equal(fields.name.find(f => f.type === 'text').value, 'Jane Müller');
  assert.deepEqual(fields, plain(await a.getFieldObjects()));
  const annots = (await (await b.getPage(1)).getAnnotations()).filter(x => x.subtype === 'Text');
  assert.equal(annots.length, 1);
  assert.equal(annots[0].contentsObj.str, 'check this');
  assert.deepEqual(plain(await b.getOutline()).map(o => o.title), ['Chapter 1']);
  assert.deepEqual(plain(await b.getOutline()), plain(await a.getOutline()));
  const out = await PDFDocument.load(r.data);
  assert.equal(out.getPage(0).node.has(PDFName.of('Thumb')), false);
  assert.equal(out.catalog.has(PDFName.of('PieceInfo')), false);
});

test('an already compact PDF comes back unchanged and never bigger', async () => {
  const doc = await PDFDocument.create(), page = doc.addPage([612, 792]);
  page.drawText('Just text', { x: 50, y: 700, size: 12 });
  const bytes = Buffer.from(await doc.save({ useObjectStreams: true }));
  const r = await m.compressPdf(bytes, 'standard');
  assert.equal(r.after, r.before);
  assert.equal(r.before, bytes.length);
  assert.ok(Buffer.from(r.data).equals(bytes));
  assert.equal(r.images.recompressed, 0);
});

test('encrypted PDFs are refused with a clear message', async () => {
  const doc = await PDFDocument.create(); doc.addPage([200, 200]);
  doc.encrypt({ userPassword: 'pw', ownerPassword: 'pw' });
  const bytes = Buffer.from(await doc.save());
  await assert.rejects(m.compressPdf(bytes, 'standard'), /Remove the password first/);
  const r = await handlers.get('compress-pdf')(null, { data: bytes.toString('base64'), preset: 'standard' });
  assert.equal(r.success, false);
  assert.match(r.error, /Remove the password first \(Security → Remove Password\)/);
});

test('the compress-pdf handler returns base64 data and the stats', async () => {
  const doc = await PDFDocument.create(), page = doc.addPage([612, 792]);
  page.drawImage(await doc.embedJpg(noisyJpeg(1500, 1500)), { x: 0, y: 0, width: 300, height: 300 });
  const bytes = Buffer.from(await doc.save());
  const r = await handlers.get('compress-pdf')(null, { data: bytes.toString('base64'), preset: 'screen' });
  assert.equal(r.success, true, r.error);
  assert.equal(Buffer.from(r.data, 'base64').length, r.after);
  assert.equal(r.before, bytes.length);
  assert.equal(r.images.recompressed, 1);
});

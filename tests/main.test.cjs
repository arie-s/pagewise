const test = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument, PDFDict, PDFName, rgb } = require('@cantoo/pdf-lib');
const { loadMainHandlers } = require('./helpers.cjs');

const b64 = bytes => Buffer.from(bytes).toString('base64');

test('apply-modifications preserves an explicit zero text opacity', async () => {
  const { handlers } = loadMainHandlers();
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]);
  const originalData = b64(await doc.save());
  const result = await handlers.get('apply-modifications')(null, {
    originalData, modifications: [{ type: 'text', pageIndex: 0, text: 'searchable', x: 0.1, y: 0.1, fontSize: 12, opacity: 0 }]
  });
  assert.equal(result.success, true, result.error);
  const pdf = await PDFDocument.load(Buffer.from(result.data, 'base64'));
  const serialized = Buffer.from(await pdf.save()).toString('latin1');
  assert.match(serialized, /\/ca\s+0(?:\.0+)?\b/);
});

test('a visual redaction request without a rasterized replacement fails closed', async () => {
  const { handlers } = loadMainHandlers();
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 300]);
  page.drawText('SECRET-REDUCTION-CANARY', { x: 20, y: 200, size: 18, color: rgb(0, 0, 0) });
  const originalData = b64(await doc.save());
  const result = await handlers.get('apply-modifications')(null, {
    originalData, modifications: [{ type: 'redaction', pageIndex: 0, x: 0.05, y: 0.1, width: 0.8, height: 0.2 }]
  });
  assert.equal(result.success, false, 'a black rectangle must not be reported as secure redaction');
});

test('redact-pdf rebuilds a fresh document from page images without source content', async () => {
  const { handlers } = loadMainHandlers();
  const handler = handlers.get('redact-pdf');
  assert.equal(typeof handler, 'function', 'redact-pdf IPC handler is registered');
  const source = await PDFDocument.create();
  source.addPage().drawText('SECRET-ORIGINAL-METADATA', { x: 20, y: 700, size: 18 });
  source.setTitle('PRIVATE-TITLE-CANARY');
  await source.attach(Buffer.from('PRIVATE-ATTACHMENT-CANARY'), 'private.txt');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p1sAAAAASUVORK5CYII=',
    'base64'
  );
  const result = await handler(null, { originalData: b64(await source.save()), pages: [{ imageData: b64(png), width: 1, height: 1 }] });
  assert.equal(result.success, true, result.error);
  const rebuilt = await PDFDocument.load(Buffer.from(result.data, 'base64'));
  assert.equal(rebuilt.getPageCount(), 1);
  assert.ok(!rebuilt.getTitle());
  const names = rebuilt.catalog.get(PDFName.of('Names'));
  if (names) assert.equal(rebuilt.context.lookup(names, PDFDict).has(PDFName.of('EmbeddedFiles')), false);
  const bytes = Buffer.from(await rebuilt.save());
  assert.equal(bytes.includes(Buffer.from('SECRET-ORIGINAL-METADATA')), false);
  assert.equal(bytes.includes(Buffer.from('PRIVATE-ATTACHMENT-CANARY')), false);
});

// ---------- image import ----------
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buf => { let c = 0xFFFFFFFF; for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
const pngChunk = (type, data) => { const t = Buffer.from(type), len = Buffer.alloc(4), crc = Buffer.alloc(4); len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); };
function makePng(w, h) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}
// Build a valid baseline JPEG from a real encoder-free route: embed via pdf-lib is not possible, so use a hardcoded 2x1 JPEG.
const JPEG_2x1 = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAIBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=', 'base64');
const withExif = (jpg, orientation, le = false) => {
  const t = Buffer.alloc(8 + 2 + 12 + 4);
  t.write(le ? 'II' : 'MM'); le ? t.writeUInt16LE(42, 2) : t.writeUInt16BE(42, 2); le ? t.writeUInt32LE(8, 4) : t.writeUInt32BE(8, 4);
  const w16 = (v, o) => le ? t.writeUInt16LE(v, o) : t.writeUInt16BE(v, o);
  w16(1, 8); w16(0x0112, 10); w16(3, 12); le ? t.writeUInt32LE(1, 14) : t.writeUInt32BE(1, 14); w16(orientation, 18);
  const body = Buffer.concat([Buffer.from('Exif\0\0'), t]), len = Buffer.alloc(2); len.writeUInt16BE(body.length + 2);
  return Buffer.concat([jpg.subarray(0, 2), Buffer.from([0xFF, 0xE1]), len, body, jpg.subarray(2)]);
};
const imgArg = (name, buf) => ({ name, data: buf.toString('base64') });
const loadPages = async r => (await PDFDocument.load(Buffer.from(r.data, 'base64'))).getPages();

test('images-to-pdf makes one page per image, long side 792, sorted naturally', async () => {
  const { handlers } = loadMainHandlers();
  const r = await handlers.get('images-to-pdf')(null, [imgArg('img10.jpg', JPEG_2x1), imgArg('img2.png', makePng(4, 8))]);
  assert.equal(r.success, true, r.error);
  assert.equal(r.name, 'img2.pdf');
  const pages = await loadPages(r);
  assert.equal(pages.length, 2);
  const [a, b] = pages.map(p => p.getSize());
  assert.ok(Math.abs(a.height - 792) < 1e-6 && Math.abs(a.width - 396) < 1e-6, 'png first (img2), 1:2 portrait');
  assert.ok(Math.abs(b.width - 792) < 1e-6 && Math.abs(b.height - 396) < 1e-6, 'jpeg second (img10), 2:1 landscape');
});

test('images-to-pdf applies JPEG EXIF orientation (both byte orders) and ignores mirrored/malformed EXIF', async () => {
  const { handlers } = loadMainHandlers();
  for (const le of [false, true]) {
    const r = await handlers.get('images-to-pdf')(null, [imgArg('a.jpg', withExif(JPEG_2x1, 6, le))]);
    assert.equal(r.success, true, r.error);
    const [p] = await loadPages(r);
    assert.equal(p.getRotation().angle, 90);
    const { width, height } = p.getSize();
    assert.ok(Math.abs(width - 792) < 1e-6 && Math.abs(height - 396) < 1e-6, 'stored dims; displayed as 396x792 after rotation');
  }
  const angle = async buf => (await loadPages(await handlers.get('images-to-pdf')(null, [imgArg('a.jpg', buf)])))[0].getRotation().angle;
  assert.equal(await angle(withExif(JPEG_2x1, 3)), 180);
  assert.equal(await angle(withExif(JPEG_2x1, 8)), 270);
  assert.equal(await angle(withExif(JPEG_2x1, 5)), 0);
  const bad = withExif(JPEG_2x1, 6); bad.writeUInt32BE(0xFFFFFF, 16 + 4);
  assert.equal(await angle(bad), 0);
});

test('images-to-pdf rejects unsupported and corrupt images', async () => {
  const { handlers } = loadMainHandlers();
  const bad = await handlers.get('images-to-pdf')(null, [imgArg('x.gif', Buffer.from('GIF89a....'))]);
  assert.equal(bad.success, false);
  assert.match(bad.error, /Unsupported image: x\.gif/);
  const trunc = await handlers.get('images-to-pdf')(null, [imgArg('t.png', makePng(4, 4).subarray(0, 20))]);
  assert.equal(trunc.success, false);
  assert.match(trunc.error, /Unsupported image: t\.png/);
});

test('opening an image yields a path-less PDF and Save goes to Save As without touching the image', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagewise-img-'));
  const imgPath = path.join(dir, 'photo.JPG');
  fs.writeFileSync(imgPath, JPEG_2x1);
  let dialogCalls = 0;
  const { handlers } = loadMainHandlers({ electron: { app: { whenReady: () => ({ then: () => {} }), on: () => {}, quit: () => {}, exit: () => {}, getPath: () => os.tmpdir() }, dialog: { showSaveDialog: async () => { dialogCalls++; return { canceled: true }; } } } });
  const r = await handlers.get('open-specific-file')(null, imgPath);
  assert.equal(r.error, undefined);
  assert.equal(r.path, null);
  assert.equal(r.name, 'photo.pdf');
  assert.equal((await loadPages(r)).length, 1);
  const s = await handlers.get('save-file')(null, { data: r.data, path: null });
  assert.equal(dialogCalls, 1);
  assert.equal(s.canceled, true);
  assert.deepEqual(fs.readFileSync(imgPath), JPEG_2x1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('open-specific-file still returns the path for a PDF and rejects mixed or multiple opens', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagewise-pdf-'));
  const doc = await PDFDocument.create(); doc.addPage();
  const pdfPath = path.join(dir, 'doc.pdf');
  fs.writeFileSync(pdfPath, await doc.save());
  const noExtPath = path.join(dir, 'report');
  fs.copyFileSync(pdfPath, noExtPath);
  const imgPath = path.join(dir, 'a.jpg');
  fs.writeFileSync(imgPath, JPEG_2x1);
  const picks = [[pdfPath, imgPath], [pdfPath, noExtPath]];
  const { handlers } = loadMainHandlers({ electron: { app: { whenReady: () => ({ then: () => {} }), on: () => {}, quit: () => {}, exit: () => {}, getPath: () => os.tmpdir() }, dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: picks.shift() }) } } });
  const r = await handlers.get('open-specific-file')(null, pdfPath);
  assert.equal(r.path, pdfPath);
  assert.equal(r.name, 'doc.pdf');
  const noExt = await handlers.get('open-specific-file')(null, noExtPath);
  assert.equal(noExt.path, noExtPath);
  const missing = await handlers.get('open-specific-file')(null, path.join(dir, 'nope.pdf'));
  assert.ok(missing.error);
  assert.match((await handlers.get('open-file')()).error, /one PDF or one or more images/);
  assert.match((await handlers.get('open-file')()).error, /one PDF or one or more images/);
  fs.rmSync(dir, { recursive: true, force: true });
});

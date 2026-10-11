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

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createCanvas } = require('@napi-rs/canvas');
const { PDFDocument, degrees } = require('@cantoo/pdf-lib');
const { root, loadMainHandlers } = require('./helpers.cjs');

const { handlers } = loadMainHandlers();
const pdfjs = () => import('pdfjs-dist/legacy/build/pdf.mjs');

// Edits are placed in fractions of the page as the viewer shows it; on a rotated or cropped page they must land in the same spot
for (const [name, rot, crop] of [['unrotated', 0], ['rotated 90', 90], ['rotated 180', 180], ['rotated 270', 270], ['cropped', 0, [100, 150, 400, 500]], ['cropped and rotated 90', 90, [100, 150, 400, 500]]]) {
  test(`edits land where they were placed on a ${name} page`, async () => {
    const doc = await PDFDocument.create(), page = doc.addPage([612, 792]);
    page.setRotation(degrees(rot)); if (crop) page.setCropBox(...crop);
    const cover = { type: 'cover', pageIndex: 0, x: 0.1, y: 0.5, width: 0.3, height: 0.1, color: { r: 0.2, g: 0.4, b: 0.8 } };
    const hl = { type: 'highlight', pageIndex: 0, x: 0.1, y: 0.1, width: 0.4, height: 0.05 };
    const note = { type: 'stickyNote', pageIndex: 0, x: 0.7, y: 0.2, text: 'n' };
    const r = await handlers.get('apply-modifications')(null, { originalData: Buffer.from(await doc.save()).toString('base64'), modifications: [cover, hl, note] });
    assert.equal(r.success, true, r.error);
    const pdf = await (await pdfjs()).getDocument({ data: new Uint8Array(Buffer.from(r.data, 'base64')), standardFontDataUrl: path.join(root, 'node_modules/pdfjs-dist/standard_fonts/'), verbosity: 0 }).promise;
    const pg = await pdf.getPage(1), vp = pg.getViewport({ scale: 1 }), W = vp.width, H = vp.height;
    const canvas = createCanvas(Math.ceil(W), Math.ceil(H)), ctx = canvas.getContext('2d');
    await pg.render({ canvasContext: ctx, viewport: vp, background: 'rgb(255,255,255)' }).promise;
    const px = (fx, fy) => Array.from(ctx.getImageData(Math.round(fx * W), Math.round(fy * H), 1, 1).data.slice(0, 3));
    assert.deepEqual(px(0.25, 0.55), [51, 102, 204], 'the cover is inside its box');
    assert.deepEqual(px(0.6, 0.55), [255, 255, 255], 'and not beside it');
    const annots = await pg.getAnnotations(), box = a => { const [x1, y1, x2, y2] = vp.convertToViewportRectangle(a.rect); return [Math.min(x1, x2) / W, Math.min(y1, y2) / H, Math.max(x1, x2) / W, Math.max(y1, y2) / H]; };
    const near = (got, want, what) => got.forEach((v, i) => assert.ok(Math.abs(v - want[i]) < 0.01, `${what}: ${got.map(n => n.toFixed(3))} vs ${want}`));
    near(box(annots.find(a => a.subtype === 'Highlight')), [0.1, 0.1, 0.5, 0.15], 'highlight');
    const n = box(annots.find(a => a.subtype === 'Text'));
    near(n.slice(0, 2), [0.7, 0.2], 'note corner');
    await pdf.destroy();
  });
}

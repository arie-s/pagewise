const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { PDFDocument, PDFName, PDFArray, PDFDict, StandardFonts, degrees } = require('@cantoo/pdf-lib');
const { loadMainHandlers, loadRendererFunctions, root } = require('./helpers.cjs');

const pdfjs = () => import('pdfjs-dist/legacy/build/pdf.mjs');
const FONTS = path.join(root, 'node_modules/pdfjs-dist/standard_fonts/') ;
const { handlers } = loadMainHandlers();
const apply = async (data, modifications) => {
  const r = await handlers.get('apply-modifications')(null, { originalData: data, modifications });
  assert.equal(r.success, true, r.error);
  return r.data;
};
const open = async data => (await pdfjs()).getDocument({ data: new Uint8Array(Buffer.from(data, 'base64')), standardFontDataUrl: FONTS, verbosity: 0 }).promise;
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.01, `${msg || ''} ${a} vs ${b}`);

// One page with a marker text at (100, 50) and, optionally, a text-field widget; returns base64
async function makePdf({ size = [200, 100], rotation = 0, cropBox, widget = false, noAnnots = false } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage(size);
  if (cropBox) page.setCropBox(...cropBox);
  page.drawText('MARK', { x: 100, y: 50, size: 10, font });
  if (widget) doc.getForm().createTextField('f').addToPage(page, { x: 20, y: 10, width: 60, height: 20 });
  if (rotation) page.setRotation(degrees(rotation));
  if (noAnnots) page.node.delete(PDFName.of('Annots'));
  return Buffer.from(await doc.save()).toString('base64');
}
// Marker position, viewport size and widget rect as the user sees them (pdf.js, scale 1)
async function view(data) {
  const P = await pdfjs(), doc = await open(data), page = await doc.getPage(1), vp = page.getViewport({ scale: 1 });
  const item = (await page.getTextContent()).items.find(i => i.str === 'MARK');
  const t = P.Util.transform(vp.transform, item.transform);
  const w = (await page.getAnnotations()).find(a => a.subtype === 'Widget');
  return { x: t[4], y: t[5], width: vp.width, height: vp.height, widget: w && vp.convertToViewportRectangle(w.rect), numPages: doc.numPages };
}

test('crop maps view coordinates onto the page for every rotation', async () => {
  const rect = { x: 0.1, y: 0.15, width: 0.8, height: 0.7 };
  for (const rotation of [0, 90, 180, 270]) {
    const before = await view(await makePdf({ rotation }));
    const after = await view(await apply(await makePdf({ rotation }), [{ type: 'crop', pageIndex: 0, ...rect }]));
    near(after.width, before.width * rect.width, `width @${rotation}`);
    near(after.height, before.height * rect.height, `height @${rotation}`);
    near(after.x, before.x - rect.x * before.width, `marker x @${rotation}`);
    near(after.y, before.y - rect.y * before.height, `marker y @${rotation}`);
  }
});

test('cropping an already cropped page is relative to the current crop box', async () => {
  const first = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, second = { x: 0.25, y: 0.5, width: 0.5, height: 0.5 };
  const combined = { x: 0.1 + 0.8 * 0.25, y: 0.1 + 0.8 * 0.5, width: 0.4, height: 0.4 };
  const box = async data => (await PDFDocument.load(Buffer.from(data, 'base64'))).getPage(0).getCropBox();
  for (const rotation of [0, 90, 180, 270]) {
    const src = await makePdf({ rotation, cropBox: [10, 5, 160, 80] });
    const nested = await box(await apply(src, [{ type: 'crop', pageIndex: 0, ...first }, { type: 'crop', pageIndex: 0, ...second }]));
    const single = await box(await apply(src, [{ type: 'crop', pageIndex: 0, ...combined }]));
    for (const k of ['x', 'y', 'width', 'height']) near(nested[k], single[k], `${k} @${rotation}`);
    assert.ok(nested.width < 150 && nested.height < 80 && nested.x >= 10 && nested.y >= 5, 'stays inside the old crop box');
  }
});

test('uncrop restores the crop box to the media box', async () => {
  const cropped = await apply(await makePdf({ rotation: 90 }), [{ type: 'crop', pageIndex: 0, x: 0.2, y: 0.2, width: 0.3, height: 0.3 }]);
  const mid = (await PDFDocument.load(Buffer.from(cropped, 'base64'))).getPage(0);
  assert.notDeepEqual(mid.getCropBox(), mid.getMediaBox());
  const page = (await PDFDocument.load(Buffer.from(await apply(cropped, [{ type: 'uncrop', pageIndex: 0 }]), 'base64'))).getPage(0);
  assert.deepEqual(page.getCropBox(), page.getMediaBox());
  assert.deepEqual(page.getMediaBox(), { x: 0, y: 0, width: 200, height: 100 });
});

test('crop rejects an empty rectangle', async () => {
  const r = await handlers.get('apply-modifications')(null, { originalData: await makePdf(), modifications: [{ type: 'crop', pageIndex: 0, x: 0.5, y: 0.5, width: 0, height: 0.2 }] });
  assert.equal(r.success, false);
});

test('resize changes the page size and scales content and widgets, centred', async () => {
  const cases = [
    { name: 'plain', opts: {}, W: 595, H: 842 },
    { name: 'landscape letter', opts: {}, W: 792, H: 612 },
    { name: 'rotated 90', opts: { rotation: 90 }, W: 612, H: 792 },
    { name: 'rotated 270', opts: { rotation: 270 }, W: 420, H: 595 },
    { name: 'cropped, offset box', opts: { cropBox: [50, 10, 120, 60] }, W: 612, H: 1008 }
  ];
  for (const { name, opts, W, H } of cases) {
    const src = await makePdf({ ...opts, widget: true });
    const before = await view(src);
    const out = await apply(src, [{ type: 'resize', pageIndex: 0, width: W, height: H }]);
    const after = await view(out);
    near(after.width, W, name + ' width'); near(after.height, H, name + ' height');
    const s = Math.min(W / before.width, H / before.height), ox = (W - s * before.width) / 2, oy = (H - s * before.height) / 2;
    near(after.x, s * before.x + ox, name + ' marker x'); near(after.y, s * before.y + oy, name + ' marker y');
    const [bx1, by1, bx2, by2] = before.widget, [ax1, ay1, ax2, ay2] = after.widget;
    near(ax1, s * bx1 + ox, name + ' widget x1'); near(ay1, s * by1 + oy, name + ' widget y1');
    near(ax2, s * bx2 + ox, name + ' widget x2'); near(ay2, s * by2 + oy, name + ' widget y2');
  }
});

test('resize only touches the requested pages', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([200, 100]); doc.addPage([300, 300]);
  const data = await apply(Buffer.from(await doc.save()).toString('base64'), [{ type: 'resize', pageIndex: 1, width: 612, height: 792 }]);
  const out = await PDFDocument.load(Buffer.from(data, 'base64'));
  assert.deepEqual(out.getPage(0).getSize(), { width: 200, height: 100 });
  assert.deepEqual(out.getPage(1).getSize(), { width: 612, height: 792 });
});

test('replace-page swaps in the chosen source page and leaves the rest alone', async () => {
  const build = async sizes => { const d = await PDFDocument.create(); for (const s of sizes) d.addPage(s); return Buffer.from(await d.save()).toString('base64'); };
  const data = await build([[100, 100], [200, 200], [300, 300]]), sourceData = await build([[400, 400], [500, 450]]);
  const replace = handlers.get('replace-page');
  const r = await replace(null, { data, pageIndex: 1, sourceData, sourcePage: 2 });
  assert.equal(r.success, true, r.error);
  const out = await PDFDocument.load(Buffer.from(r.data, 'base64'));
  assert.equal(out.getPageCount(), 3);
  assert.deepEqual(out.getPages().map(p => p.getSize()), [{ width: 100, height: 100 }, { width: 500, height: 450 }, { width: 300, height: 300 }]);
  const first = await replace(null, { data, pageIndex: 0, sourceData, sourcePage: 1 });
  assert.deepEqual((await PDFDocument.load(Buffer.from(first.data, 'base64'))).getPage(0).getSize(), { width: 400, height: 400 });
  assert.equal((await replace(null, { data, pageIndex: 5, sourceData, sourcePage: 1 })).success, false);
  assert.equal((await replace(null, { data, pageIndex: 0, sourceData, sourcePage: 3 })).success, false);
});

test('sticky notes are real /Text comments that round-trip ASCII and non-ASCII text', async () => {
  const texts = ['Check this figure', 'Müller & Söhne', '東京 office'];
  const mods = texts.map((text, i) => ({ type: 'stickyNote', pageIndex: 0, x: 0.1 + i * 0.2, y: 0.25, text }));
  const data = await apply(await makePdf(), mods);
  const raw = (await PDFDocument.load(Buffer.from(data, 'base64'))).getPage(0).node.Annots();
  assert.deepEqual(raw.lookup(0, PDFDict).lookup(PDFName.of('Rect'), PDFArray).asArray().map(n => n.asNumber()), [20, 51, 44, 75]); // x = 0.1 * 200, top at y = 100 - 0.25 * 100, 24 x 24
  const notes = (await (await (await open(data)).getPage(1)).getAnnotations()).filter(a => a.subtype === 'Text');
  assert.deepEqual(notes.map(n => n.contentsObj.str), texts);
  for (const n of notes) assert.equal(n.titleObj.str, require('os').userInfo().username || 'Pagewise');
  const dict = (await PDFDocument.load(Buffer.from(data, 'base64'))).getPage(0).node.Annots().lookup(0, PDFDict);
  assert.equal(dict.get(PDFName.of('Name')).toString(), '/Comment');
  assert.equal(dict.get(PDFName.of('F')).asNumber(), 4);
  assert.equal(dict.get(PDFName.of('Open')).toString(), 'false');
  assert.equal(dict.lookup(PDFName.of('C'), PDFArray).size(), 3);
  assert.match(dict.lookup(PDFName.of('M')).decodeText(), /^D:\d{14}Z/);
});

test('sticky notes create the /Annots array when missing and append when present', async () => {
  const bare = await makePdf({ noAnnots: true });
  assert.equal((await PDFDocument.load(Buffer.from(bare, 'base64'))).getPage(0).node.Annots(), undefined);
  const one = await apply(bare, [{ type: 'stickyNote', pageIndex: 0, x: 0.1, y: 0.1, text: 'first' }]);
  assert.equal((await PDFDocument.load(Buffer.from(one, 'base64'))).getPage(0).node.Annots().size(), 1);
  const withWidget = await apply(await makePdf({ widget: true }), [{ type: 'stickyNote', pageIndex: 0, x: 0.5, y: 0.5, text: 'second' }]);
  const two = await apply(withWidget, [{ type: 'stickyNote', pageIndex: 0, x: 0.6, y: 0.6, text: 'third' }]);
  const annots = await (await (await open(two)).getPage(1)).getAnnotations();
  assert.deepEqual(annots.map(a => a.subtype).sort(), ['Text', 'Text', 'Widget']);
  assert.deepEqual(annots.filter(a => a.subtype === 'Text').map(a => a.contentsObj.str).sort(), ['second', 'third']);
});

// A tiny DOM: enough for renderOutline / updateBookmarks
class El {
  constructor(tag) { this.tag = tag; this.children = []; this.style = {}; this.className = ''; this.textContent = ''; this.title = ''; this._c = new Set(); this.classList = { toggle: (n, f) => { const on = f === undefined ? !this._c.has(n) : f; on ? this._c.add(n) : this._c.delete(n); return on; }, contains: n => this._c.has(n), add: n => this._c.add(n), remove: n => this._c.delete(n) }; }
  appendChild(c) { this.children.push(c); return c; }
  removeChild(c) { this.children.splice(this.children.indexOf(c), 1); }
  get firstChild() { return this.children[0] || null; }
}
function outlineHarness(pdfDoc) {
  const elements = { bookmarksContainer: new El('div') }, went = [];
  const { functions } = loadRendererFunctions(['resolveDestPage', 'renderOutline', 'updateBookmarks'], {
    state: { pdfDoc },
    extra: { goToPage: p => went.push(p), document: { createElement: t => new El(t), getElementById: id => elements[id] } }
  });
  return { ...functions, elements, went };
}
const outlineDoc = (outline) => ({
  numPages: 6, getOutline: async () => outline,
  getDestination: async name => name === 'chapter2' ? [{ num: 7, gen: 0 }, { name: 'XYZ' }] : null,
  getPageIndex: async ref => { if (ref.num !== 7) throw new Error('bad ref'); return 3; }
});

test('outline: nesting, arrows, textContent titles, and destination resolution', async () => {
  const outline = [
    { title: '<img src=x onerror=alert(1)>', dest: 'chapter2', items: [{ title: 'Section', dest: [{ num: 7, gen: 0 }], items: [{ title: 'Deep', dest: [4] }] }] },
    { title: 'Website', url: 'https://example.com', dest: null, items: [] },
    { title: 'Gone', dest: 'missing' }
  ];
  const h = outlineHarness(outlineDoc(outline));
  const list = h.renderOutline(outline);
  assert.equal(list.children.length, 3);
  const [top, link, gone] = list.children;
  assert.equal(top.children[0].children[1].textContent, '<img src=x onerror=alert(1)>');
  const kids = top.children[1];
  assert.equal(kids.classList.contains('hidden'), false, 'top level starts expanded');
  const arrow = top.children[0].children[0];
  arrow.onclick({ stopPropagation() {} });
  assert.equal(kids.classList.contains('hidden'), true, 'arrow collapses');
  arrow.onclick({ stopPropagation() {} });
  assert.equal(kids.classList.contains('hidden'), false, 'arrow expands');
  const section = kids.children[0];
  assert.equal(section.children[1].classList.contains('hidden'), true, 'deeper levels start collapsed');
  assert.equal(link.children.length, 1, 'no arrow target without children');
  await top.children[0].onclick();
  await section.children[0].onclick();
  await section.children[1].children[0].children[0].onclick();
  assert.deepEqual(h.went, [4, 4, 5]); // named dest and ref dest -> page index 3 -> page 4; explicit [4] -> page 5
  assert.equal(link.children[0].title, 'https://example.com');
  assert.equal(link.children[0].onclick, undefined);
  await gone.children[0].onclick();
  assert.deepEqual(h.went, [4, 4, 5], 'unresolvable destination does nothing');
});

test('bookmarks panel shows the outline, and "No bookmarks" when there is none', async () => {
  const h = outlineHarness(outlineDoc([{ title: 'Intro', dest: [0] }]));
  await h.updateBookmarks();
  assert.equal(h.elements.bookmarksContainer.children.length, 1);
  assert.equal(h.elements.bookmarksContainer.children[0].children[0].children[0].children[1].textContent, 'Intro');
  for (const outline of [null, []]) {
    const e = outlineHarness(outlineDoc(outline));
    await e.updateBookmarks();
    assert.equal(e.elements.bookmarksContainer.children.length, 1);
    assert.equal(e.elements.bookmarksContainer.children[0].textContent, 'No bookmarks');
  }
  const failing = outlineHarness({ getOutline: async () => { throw new Error('broken'); } });
  await failing.updateBookmarks();
  assert.equal(failing.elements.bookmarksContainer.children[0].textContent, 'No bookmarks');
});

test('a real outline in a PDF is read by pdf.js the way the panel expects', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([100, 100]); const p2 = doc.addPage([100, 100]);
  const ctx = doc.context, item = ctx.obj({ Title: 'Second', Parent: undefined, Dest: [p2.ref, 'Fit'] });
  const root = ctx.obj({ Type: 'Outlines' });
  const itemRef = ctx.register(item), rootRef = ctx.register(root);
  item.set(PDFName.of('Parent'), rootRef); root.set(PDFName.of('First'), itemRef); root.set(PDFName.of('Last'), itemRef); root.set(PDFName.of('Count'), ctx.obj(1));
  doc.catalog.set(PDFName.of('Outlines'), rootRef);
  const pdf = await open(Buffer.from(await doc.save()).toString('base64'));
  const outline = await pdf.getOutline();
  const h = outlineHarness(pdf);
  await h.renderOutline(outline).children[0].children[0].onclick();
  assert.deepEqual(h.went, [2]);
});

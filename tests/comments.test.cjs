const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createCanvas } = require('@napi-rs/canvas');
const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFString, PDFHexString, StandardFonts, decodePDFRawStream } = require('@cantoo/pdf-lib');
const { root, loadMainHandlers, loadRendererFunctions } = require('./helpers.cjs');

const { handlers, context: m } = loadMainHandlers();
const pdfjs = () => import('pdfjs-dist/legacy/build/pdf.mjs');
const call = async (name, arg) => { const r = JSON.parse(JSON.stringify(await handlers.get(name)(null, arg))); return r; };
// settings.json goes to a temporary folder, never into the repository
const isolated = () => loadMainHandlers({ electron: { app: { whenReady: () => ({ then: () => {} }), on: () => {}, quit: () => {}, exit: () => {}, getPath: () => require('node:fs').mkdtempSync(path.join(require('node:os').tmpdir(), 'pagewise-author-')) } } });
const b64 = bytes => Buffer.from(bytes).toString('base64');

// A 400 x 300 page with a line of text at the top and a clear white area below it
async function basePdf(extra) {
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 300]);
  page.drawText('The quick brown fox jumps over the lazy dog', { x: 40, y: 260, size: 12, font });
  if (extra) await extra(doc, page);
  return b64(await doc.save());
}
const mods = async (data, modifications) => { const r = await call('apply-modifications', { originalData: data, modifications }); assert.ok(r.success, r.error); return r.data; };
async function annotsOf(data, pageIndex = 0) {
  const doc = await PDFDocument.load(Buffer.from(data, 'base64')), out = [], annots = doc.getPage(pageIndex).node.Annots();
  if (annots) for (const r of annots.asArray()) out.push({ ref: r, dict: doc.context.lookup(r) });
  return { doc, list: out };
}
const text = (dict, key) => { const v = dict.lookup(PDFName.of(key)); return v ? (v.decodeText ? v.decodeText() : v.asString ? v.asString() : String(v)) : undefined; };
const nums = (dict, key) => dict.lookup(PDFName.of(key)).asArray().map(n => n.asNumber());
const subtype = dict => dict.get(PDFName.of('Subtype')).decodeText();
async function pdfjsDoc(data) { return (await pdfjs()).getDocument({ data: new Uint8Array(Buffer.from(data, 'base64')), standardFontDataUrl: path.join(root, 'node_modules/pdfjs-dist/standard_fonts/'), verbosity: 0 }).promise; }
async function pdfjsAnnots(data, intent = 'any') { const d = await pdfjsDoc(data); try { return JSON.parse(JSON.stringify(await (await d.getPage(1)).getAnnotations({ intent }))); } finally { await d.destroy(); } }
async function render(data, scale = 2) {
  const doc = await pdfjsDoc(data), page = await doc.getPage(1), vp = page.getViewport({ scale }), canvas = createCanvas(vp.width, vp.height), ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport: vp, background: 'rgb(255,255,255)' }).promise;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height); await doc.destroy();
  return { img, vp, at: (x, y) => { const i = (Math.round((300 - y) * scale) * img.width + Math.round(x * scale)) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2]]; } };
}
const YELLOW = { r: 1, g: 0.94, b: 0.2 };
// The rectangle is x 40..160, y 200..230 in PDF points
const HL = { type: 'highlight', pageIndex: 0, x: 0.1, y: 70 / 300, width: 0.3, height: 30 / 300, color: YELLOW, contents: 'check this' };

// ---------- markup mods become real annotations ----------
test('a highlight is a real /Highlight annotation with quads, colour, opacity, author, id and an appearance', async () => {
  const out = await mods(await basePdf(), [HL]);
  const { list } = await annotsOf(out), d = list[0].dict;
  assert.equal(list.length, 1);
  assert.equal(subtype(d), 'Highlight');
  assert.deepEqual(nums(d, 'QuadPoints').map(Math.round), [40, 230, 160, 230, 40, 200, 160, 200]);
  assert.deepEqual(nums(d, 'Rect').map(Math.round), [40, 200, 160, 230]);
  assert.equal(nums(d, 'C').length, 3);
  assert.equal(d.lookup(PDFName.of('CA')).asNumber(), 0.4);
  assert.equal(text(d, 'T'), m.getAuthor());
  assert.equal(text(d, 'Contents'), 'check this');
  assert.match(text(d, 'NM'), /^[0-9a-f-]{36}$/);
  assert.match(text(d, 'M'), /^D:\d{14}/); assert.match(text(d, 'CreationDate'), /^D:\d{14}/);
  assert.equal(d.lookup(PDFName.of('F')).asNumber(), 4);
  assert.ok(d.lookup(PDFName.of('AP')).lookup(PDFName.of('N')), 'has /AP /N');
});

test('pdf.js lists the markup annotations with their subtype, author and contents', async () => {
  const out = await mods(await basePdf(), [HL, { type: 'underline', pageIndex: 0, x: 0.1, y: 0.4, width: 0.3, height: 0.05, color: { r: 0, g: 0, b: 1 }, strokeWidth: 2 }, { type: 'strikethrough', pageIndex: 0, x: 0.1, y: 0.6, width: 0.3, height: 0.05, color: { r: 1, g: 0, b: 0 }, strokeWidth: 2 }]);
  const a = await pdfjsAnnots(out);
  assert.deepEqual(a.map(x => x.subtype), ['Highlight', 'Underline', 'StrikeOut']);
  assert.equal(a[0].titleObj.str, m.getAuthor()); assert.equal(a[0].contentsObj.str, 'check this');
});

test('the highlight renders as multiplied colour inside its rectangle and nothing outside', async () => {
  const r = await render(await mods(await basePdf(), [HL]));
  const [pr, pg, pb] = r.at(100, 215);
  assert.ok(pr >= 250 && Math.abs(pg - 245) <= 4 && Math.abs(pb - 173) <= 6, `inside is yellow (${[pr, pg, pb]})`);
  for (const [x, y] of [[100, 190], [100, 240], [30, 215], [170, 215], [300, 100]]) assert.deepEqual(r.at(x, y), [255, 255, 255], `outside at ${x},${y}`);
});

test('the appearance stream alone draws the highlight (a viewer that ignores /C and /CA still shows it)', async () => {
  const doc = await PDFDocument.load(Buffer.from(await mods(await basePdf(), [HL]), 'base64'));
  const d = doc.getPage(0).node.Annots().lookup(0, PDFDict); d.delete(PDFName.of('C')); d.delete(PDFName.of('CA'));
  const r = await render(b64(await doc.save())), [pr, pg, pb] = r.at(100, 215);
  assert.ok(pr >= 250 && Math.abs(pg - 245) <= 4 && Math.abs(pb - 173) <= 6, `inside is yellow (${[pr, pg, pb]})`);
  assert.deepEqual(r.at(100, 190), [255, 255, 255]);
});

test('a highlight over text multiplies, so the text stays dark', async () => {
  const over = { ...HL, y: 28 / 300, height: 20 / 300, width: 0.8 };
  const r = await render(await mods(await basePdf(), [over]), 4);
  let darkest = 255; for (let x = 40; x < 250; x++) darkest = Math.min(darkest, r.at(x + 0.1, 257 - 0.2)[0], r.at(x, 262)[0]);
  assert.ok(darkest < 120, 'text is still visible through the highlight');
});

test('underline and strikeout draw a line in their colour', async () => {
  const out = await mods(await basePdf(), [
    { type: 'underline', pageIndex: 0, x: 0.1, y: 100 / 300, width: 0.3, height: 20 / 300, color: { r: 0, g: 0, b: 1 }, strokeWidth: 2 },
    { type: 'strikethrough', pageIndex: 0, x: 0.1, y: 160 / 300, width: 0.3, height: 20 / 300, color: { r: 1, g: 0, b: 0 }, strokeWidth: 2 }]);
  const r = await render(out, 4), ink = (y, test) => { let n = 0; for (let x = 50; x < 150; x++) { const p = r.at(x, y); if (test(p)) n++; } return n; };
  const blue = p => p[2] > 200 && p[0] < 80, red = p => p[0] > 200 && p[1] < 80;
  assert.ok(ink(180 - 1, blue) + ink(180 - 0.5, blue) + ink(181, blue) > 50, 'blue underline at the bottom of the rect (y=180)');
  assert.ok(ink(300 - 170, red) > 50, 'red line through the middle of the rect (y=130)');
  assert.equal(ink(300 - 170 + 20, red), 0);
});

test('a selection of several lines is one annotation with one quad per line', async () => {
  const rects = [{ x: 0.1, y: 0.1, width: 0.5, height: 0.05 }, { x: 0.1, y: 0.2, width: 0.3, height: 0.05 }];
  const { list } = await annotsOf(await mods(await basePdf(), [{ type: 'highlight', pageIndex: 0, ...rects[0], rects, color: YELLOW }]));
  assert.equal(list.length, 1);
  assert.equal(nums(list[0].dict, 'QuadPoints').length, 16);
});

test('the old drawn rectangle is no longer in the page content', async () => {
  const doc = await PDFDocument.load(Buffer.from(await mods(await basePdf(), [HL]), 'base64')), c = doc.getPage(0).node.Contents();
  const streams = c instanceof PDFArray ? c.asArray().map(r => doc.context.lookup(r)) : [c];
  const body = streams.map(st => Buffer.from(decodePDFRawStream(st).decode()).toString('latin1')).join('\n');
  assert.match(body, /Tj/, 'the text is there');
  assert.ok(!/\bre\b/.test(body) && !/ f\b/.test(body), 'no re / f operators on the page');
});

test('a note gets the author name, an id and dates', async () => {
  const out = await mods(await basePdf(), [{ type: 'stickyNote', pageIndex: 0, x: 0.5, y: 0.5, text: 'hello' }]);
  const d = (await annotsOf(out)).list[0].dict;
  assert.equal(subtype(d), 'Text'); assert.equal(text(d, 'T'), m.getAuthor()); assert.equal(text(d, 'Contents'), 'hello');
  assert.ok(text(d, 'NM'));
});

// ---------- reply, update, delete, status ----------
// A page with a note, a highlight with a popup, a reply to the highlight, a reply to that reply, a widget and a link
async function threaded() {
  let refs = {};
  const data = await basePdf(async (doc, page) => {
    const ctx = doc.context, add = o => ctx.register(ctx.obj(o));
    const hl = add({ Type: 'Annot', Subtype: 'Highlight', Rect: [40, 200, 160, 230], QuadPoints: [40, 230, 160, 230, 40, 200, 160, 200], C: [1, 1, 0], T: PDFString.of('Ann'), Contents: PDFString.of('original'), F: 4 });
    const popup = add({ Type: 'Annot', Subtype: 'Popup', Rect: [200, 200, 300, 250], Parent: hl, Open: false });
    ctx.lookup(hl).set(PDFName.of('Popup'), popup);
    const r1 = add({ Type: 'Annot', Subtype: 'Text', Rect: [40, 200, 160, 230], IRT: hl, RT: 'R', T: PDFString.of('Bob'), Contents: PDFString.of('first reply'), F: 32 });
    const r2 = add({ Type: 'Annot', Subtype: 'Text', Rect: [40, 200, 160, 230], IRT: r1, RT: 'R', T: PDFString.of('Ann'), Contents: PDFString.of('second level'), F: 32 });
    const note = add({ Type: 'Annot', Subtype: 'Text', Rect: [300, 100, 324, 124], T: PDFString.of('Cy'), Contents: PDFString.of('another note'), F: 4 });
    const widget = add({ Type: 'Annot', Subtype: 'Widget', FT: 'Tx', T: PDFString.of('field'), Rect: [50, 50, 150, 70], F: 4 });
    const link = add({ Type: 'Annot', Subtype: 'Link', Rect: [50, 100, 150, 120], Border: [0, 0, 0] });
    page.node.set(PDFName.of('Annots'), ctx.obj([hl, popup, r1, r2, note, widget, link]));
    refs = { hl, popup, r1, r2, note, widget, link };
  });
  const id = r => `${r.objectNumber}R${r.generationNumber ? r.generationNumber : ''}`;
  return { data, refs, id };
}

test('a reply is a /Text annotation in reply to the parent, hidden from the page, by the author', async () => {
  const { data, refs, id } = await threaded();
  const r = await call('comment-reply', { data, ref: id(refs.hl), text: 'my reply' });
  assert.ok(r.success, r.error);
  const { list } = await annotsOf(r.data), added = list[list.length - 1].dict;
  assert.equal(list.length, 8);
  assert.equal(subtype(added), 'Text'); assert.equal(added.get(PDFName.of('IRT')).tag, refs.hl.tag);
  assert.equal(added.lookup(PDFName.of('RT')).decodeText(), 'R'); assert.equal(text(added, 'T'), m.getAuthor()); assert.equal(text(added, 'Contents'), 'my reply');
  assert.equal(added.lookup(PDFName.of('F')).asNumber() & 32, 32, 'NoView');
  assert.deepEqual(nums(added, 'Rect'), [40, 200, 160, 230]);
  const a = await pdfjsAnnots(r.data), reply = a.find(x => x.contentsObj && x.contentsObj.str === 'my reply');
  assert.equal(reply.inReplyTo, id(refs.hl)); assert.equal(reply.replyType, 'R');
  assert.equal((await pdfjsAnnots(r.data, 'display')).filter(x => x.subtype === 'Text').length, 1, 'only the original note draws on the page');
});

test('a reply needs text and a comment to reply to', async () => {
  const { data, refs, id } = await threaded();
  for (const bad of [{ data, ref: id(refs.hl), text: '   ' }, { data, ref: id(refs.hl), text: 'x'.repeat(10001) }, { data, ref: id(refs.hl), text: 5 }, { data, ref: id(refs.widget), text: 'hi' }, { data, ref: id(refs.link), text: 'hi' }, { data, ref: '9999R', text: 'hi' }, { data, ref: 'nonsense', text: 'hi' }, { data: 42, ref: id(refs.hl), text: 'hi' }, {}])
    assert.equal((await call('comment-reply', bad)).success, false);
  assert.equal((await call('comment-reply', { data, ref: id(refs.hl), text: 'x'.repeat(10000) })).success, true);
});

test('update changes the contents and the modified date, only for comments', async () => {
  const { data, refs, id } = await threaded();
  const r = await call('comment-update', { data, ref: id(refs.hl), text: 'edited text' });
  assert.ok(r.success, r.error);
  const d = (await annotsOf(r.data)).list[0].dict;
  assert.equal(text(d, 'Contents'), 'edited text'); assert.match(text(d, 'M'), /^D:\d{14}/);
  for (const ref of [refs.widget, refs.link, refs.popup]) assert.equal((await call('comment-update', { data, ref: id(ref), text: 'x' })).success, false, 'not a comment');
  assert.equal((await call('comment-update', { data, ref: id(refs.hl), text: '' })).success, false);
});

test('editing a FreeText drops its stale appearance', async () => {
  let ft;
  const data = await basePdf(async (doc, page) => {
    const ctx = doc.context, ap = ctx.register(ctx.flateStream('0 0 m', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 20] }));
    ft = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'FreeText', Rect: [50, 50, 150, 70], Contents: PDFString.of('old'), DA: PDFString.of('/Helv 12 Tf 0 g'), AP: { N: ap }, F: 4 }));
    page.node.set(PDFName.of('Annots'), ctx.obj([ft]));
  });
  const r = await call('comment-update', { data, ref: `${ft.objectNumber}R`, text: 'new' });
  const d = (await annotsOf(r.data)).list[0].dict;
  assert.equal(text(d, 'Contents'), 'new'); assert.equal(d.get(PDFName.of('AP')), undefined);
});

test('delete removes the comment, its popup and all nested replies, and nothing else', async () => {
  const { data, refs, id } = await threaded();
  const r = await call('comment-delete', { data, ref: id(refs.hl) });
  assert.ok(r.success, r.error);
  const { list } = await annotsOf(r.data);
  assert.deepEqual(list.map(a => subtype(a.dict)).sort(), ['Link', 'Text', 'Widget']);
  assert.equal(text(list.find(a => subtype(a.dict) === 'Text').dict, 'Contents'), 'another note');
});

test('deleting a reply keeps its parent; widgets, links and unknown refs are refused', async () => {
  const { data, refs, id } = await threaded();
  const r = await call('comment-delete', { data, ref: id(refs.r1) });
  assert.deepEqual((await annotsOf(r.data)).list.map(a => subtype(a.dict)), ['Highlight', 'Popup', 'Text', 'Widget', 'Link']);
  for (const ref of [id(refs.widget), id(refs.link), '9999R', 'x']) assert.equal((await call('comment-delete', { data, ref })).success, false);
  assert.equal((await call('comment-delete', { data: 5, ref: id(refs.hl) })).success, false);
});

test('status: Completed adds a hidden review reply, None reopens it, and the newest wins', async () => {
  const { data, refs, id } = await threaded();
  const done = await call('comment-status', { data, ref: id(refs.hl), state: 'Completed' });
  assert.ok(done.success, done.error);
  const reopened = await call('comment-status', { data: done.data, ref: id(refs.hl), state: 'None' });
  const { list } = await annotsOf(reopened.data), states = list.filter(a => a.dict.get(PDFName.of('StateModel'))).map(a => text(a.dict, 'State'));
  assert.deepEqual(states, ['Completed', 'None']);
  const s = list[list.length - 1].dict;
  assert.equal(text(s, 'StateModel'), 'Review'); assert.equal(s.get(PDFName.of('IRT')).tag, refs.hl.tag); assert.equal(s.lookup(PDFName.of('F')).asNumber() & 34, 34);
  const seen = await pdfjsAnnots(reopened.data), review = seen.filter(a => a.stateModel === 'Review').map(a => a.state);
  assert.deepEqual(review, ['Completed', 'None']);
  assert.equal((await call('comment-status', { data, ref: id(refs.hl), state: 'Done' })).success, false);
  assert.equal((await call('comment-status', { data, ref: id(refs.widget), state: 'Completed' })).success, false);
});

// ---------- author ----------
test('the author defaults to the OS user, can be set, trimmed and is limited to 100 characters', async () => {
  const { handlers: h } = isolated();
  assert.equal(await h.get('settings-author-get')(), require('os').userInfo().username || 'Pagewise');
  assert.deepEqual(JSON.parse(JSON.stringify(await h.get('settings-author-set')(null, '  Dana  '))), { success: true, author: 'Dana' });
  assert.equal(await h.get('settings-author-get')(), 'Dana');
  assert.equal((await h.get('settings-author-set')(null, 'x'.repeat(101))).success, false);
  assert.equal((await h.get('settings-author-set')(null, 7)).success, false);
  assert.equal(await h.get('settings-author-get')(), 'Dana');
  assert.equal((await h.get('settings-author-set')(null, 'y'.repeat(100))).success, true);
  await h.get('settings-author-set')(null, '   ');
  assert.equal(await h.get('settings-author-get')(), require('os').userInfo().username || 'Pagewise', 'blank goes back to the default');
});

test('a new note and a new highlight carry the author that was set', async () => {
  const { handlers: h } = isolated();
  await h.get('settings-author-set')(null, 'Dana');
  const r = await h.get('apply-modifications')(null, { originalData: await basePdf(), modifications: [{ type: 'stickyNote', pageIndex: 0, x: 0.5, y: 0.5, text: 'hello' }, HL] });
  const { list } = await annotsOf(r.data);
  assert.deepEqual(list.map(a => text(a.dict, 'T')), ['Dana', 'Dana']);
  const rep = await h.get('comment-reply')(null, { data: r.data, ref: `${list[0].ref.objectNumber}R`, text: 'x' });
  assert.equal(text((await annotsOf(rep.data)).list[2].dict, 'T'), 'Dana');
});

// ---------- the panel's pure logic (renderer) ----------
const html = require('node:fs').readFileSync(path.join(root, 'src/index.html'), 'utf8');
const LABELS = eval('(' + html.match(/const COMMENT_LABELS = (\{.*?\});/)[1] + ')');
const PENDING = eval('(' + html.match(/const PENDING_COMMENTS = (\{.*?\});/)[1] + ')');
const R = loadRendererFunctions(['pdfDateMs', 'commentStatus', 'threadComments', 'coveredText', 'commentVisible', 'mergeLineRects']).functions;
const plain = x => JSON.parse(JSON.stringify(x));
const c = (id, over = {}) => ({ id, page: 1, top: 0, left: 0, created: 0, author: 'A', contents: '', inReplyTo: null, stateModel: null, state: null, ...over });

test('PDF dates are read with their time zone', () => {
  assert.equal(R.pdfDateMs('D:20260304103000Z'), Date.UTC(2026, 2, 4, 10, 30));
  assert.equal(R.pdfDateMs("D:20260304103000+02'00'"), Date.UTC(2026, 2, 4, 8, 30));
  assert.equal(R.pdfDateMs("D:20260304103000-05'30'"), Date.UTC(2026, 2, 4, 16, 0));
  assert.equal(R.pdfDateMs('D:2026'), Date.UTC(2026, 0, 1));
  assert.ok(Number.isNaN(R.pdfDateMs('yesterday'))); assert.ok(Number.isNaN(R.pdfDateMs(undefined)));
});

test('the review state is the newest state reply; a tie goes to the later one', () => {
  const rev = (state, created) => ({ state, created });
  assert.equal(R.commentStatus([]), '');
  assert.equal(R.commentStatus([rev('Completed', 1)]), 'Completed');
  assert.equal(R.commentStatus([rev('Completed', 5), rev('None', 5)]), '', 'reopened: same second, later in the file');
  assert.equal(R.commentStatus([rev('Completed', 5), rev('None', 6)]), '');
  assert.equal(R.commentStatus([rev('None', 6), rev('Completed', 5)]), '', 'file order does not beat dates');
  assert.equal(R.commentStatus([rev('None', 5), rev('Completed', 5), rev('Rejected', 7), rev('Accepted', 6)]), 'Rejected');
  assert.equal(R.commentStatus([rev('Marked', 5)]), '');
});

test('status replies from the real IPC derive Completed, then Open, and are not listed as replies', async () => {
  const { data, refs, id } = await threaded();
  const done = await call('comment-status', { data, ref: id(refs.hl), state: 'Completed' });
  const flat = async d => { const doc = await pdfjsDoc(d), out = []; try { for (const a of await (await doc.getPage(1)).getAnnotations({ intent: 'any' })) if (LABELS[a.subtype]) out.push(c(a.id, { subtype: a.subtype, created: R.pdfDateMs(a.creationDate), inReplyTo: a.inReplyTo, stateModel: a.stateModel, state: a.state, rect: a.rect })); } finally { await doc.destroy(); } return out; };
  const one = R.threadComments(await flat(done.data)).find(n => n.id === id(refs.hl));
  assert.equal(one.status, 'Completed');
  assert.deepEqual(plain(one.replies.map(r => r.id)), [id(refs.r1)], 'only the real reply, not the state reply');
  const reopened = await call('comment-status', { data: done.data, ref: id(refs.hl), state: 'None' });
  assert.equal(R.threadComments(await flat(reopened.data)).find(n => n.id === id(refs.hl)).status, '');
});

test('threading nests replies oldest first, keeps orphans on their own and puts state replies on the parent', () => {
  const tree = R.threadComments(plain([
    c('b', { inReplyTo: 'a', created: 20 }), c('a', { created: 10, top: 50 }), c('b2', { inReplyTo: 'a', created: 15 }),
    c('c', { inReplyTo: 'b', created: 30 }), c('orphan', { inReplyTo: 'gone', created: 5, top: 10 }), c('d', { page: 2 }),
    c('s1', { inReplyTo: 'a', stateModel: 'Review', state: 'Completed', created: 40 }), c('s2', { inReplyTo: 'a', stateModel: 'Review', state: 'None', created: 41 }),
    c('s3', { inReplyTo: 'd', stateModel: 'Review', state: 'Accepted', created: 1 }), c('lost', { inReplyTo: 'nowhere', stateModel: 'Review', state: 'Completed' })]));
  assert.deepEqual(plain(tree.map(n => n.id)), ['orphan', 'a', 'd'], 'by page, then position');
  const a = tree.find(n => n.id === 'a');
  assert.deepEqual(plain(a.replies.map(r => r.id)), ['b2', 'b']);
  assert.deepEqual(plain(a.replies[1].replies.map(r => r.id)), ['c'], 'two levels');
  assert.equal(a.status, ''); assert.equal(tree.find(n => n.id === 'd').status, 'Accepted');
  const all = [], walk = n => { all.push(n.id); n.replies.forEach(walk); }; tree.forEach(walk);
  assert.ok(!all.some(i => i.startsWith('s') || i === 'lost'), 'state replies are not comments');
});

test('threading survives a loop of replies', () => {
  const tree = R.threadComments(plain([c('x', { inReplyTo: 'y' }), c('y', { inReplyTo: 'x' }), c('z', { inReplyTo: 'z' })]));
  assert.deepEqual(plain(tree.map(n => n.id)).sort(), ['x', 'y', 'z']);
});

test('the covered text of a highlight comes from the text items under its quads', () => {
  const item = (str, x, y, width, height = 10) => ({ str, transform: [height, 0, 0, height, x, y], width, height });
  const items = [item('The quick brown fox', 10, 100, 190), item('jumps over', 10, 85, 100), item('far away', 10, 20, 80)];
  assert.equal(R.coveredText([{ l: 0, r: 300, b: 98, t: 112 }], items), 'The quick brown fox');
  assert.equal(R.coveredText([{ l: 0, r: 300, b: 83, t: 112 }], items), 'The quick brown fox jumps over', 'one quad over two lines');
  assert.equal(R.coveredText([{ l: 10, r: 105, b: 98, t: 112 }], items), 'The quick', 'an item cut by the quad gives its covered part');
  assert.equal(R.coveredText([{ l: 10, r: 105, b: 98, t: 112 }, { l: 10, r: 110, b: 83, t: 97 }], items), 'The quick jumps over', 'one quad per line');
  assert.equal(R.coveredText([{ l: 0, r: 300, b: 50, t: 70 }], items), '');
  assert.equal(R.coveredText([{ l: 0, r: 400, b: 0, t: 120 }], [item('x'.repeat(300), 0, 50, 300)]).length, 100, 'at most 100 characters');
});

test('the filter looks at author, contents and covered text of the comment and its replies, and at the status', () => {
  const node = { author: 'Dana', contents: 'Check the ledger', covered: 'ready for review', status: '', replies: [{ author: 'Eli', contents: 'done', replies: [] }] };
  const v = (q, f = 'all', n = node) => R.commentVisible(n, q, f);
  assert.ok(v('')); assert.ok(v('dana')); assert.ok(v('LEDGER')); assert.ok(v('for review')); assert.ok(v('eli'), 'a reply matches'); assert.ok(!v('nothing'));
  assert.ok(v('', 'open')); assert.ok(!v('', 'done'));
  assert.ok(R.commentVisible({ ...node, status: 'Completed' }, '', 'done')); assert.ok(!R.commentVisible({ ...node, status: 'Completed' }, '', 'open'));
});

test('the pieces of a selection become one rectangle per line', () => {
  const box = (left, top, right, bottom) => ({ left, top, right, bottom });
  const lines = plain(R.mergeLineRects([box(10, 100, 40, 118), box(40, 101, 44, 117), box(46, 100, 90, 118), box(10, 120, 60, 138)]));
  assert.deepEqual(lines.map(l => [l.left, l.top, l.right, l.bottom, l.width, l.height]), [[10, 100, 90, 118, 80, 18], [10, 120, 60, 138, 50, 18]]);
  assert.deepEqual(plain(R.mergeLineRects([])), []);
});

// ---------- loading from a real document ----------
test('the loader lists markup from pdf.js with author, date, contents and covered text, and skips widgets, links and popups', async () => {
  const { data } = await threaded();
  const out = await mods(data, [{ type: 'highlight', pageIndex: 0, x: 35 / 400, y: 32 / 300, width: 0.5, height: 20 / 300, color: YELLOW }, { type: 'stickyNote', pageIndex: 0, x: 0.8, y: 0.8, text: 'unsaved? no, saved' }]);
  const doc = await pdfjsDoc(out);
  const { functions } = loadRendererFunctions(['loadSavedComments', 'quadsOfAnnotation', 'coveredText', 'pdfDateMs'], { extra: { COMMENT_LABELS: LABELS, pageItems: async p => (await (await doc.getPage(p)).getTextContent()).items } });
  const list = plain(await functions.loadSavedComments(doc));
  assert.deepEqual(list.map(x => x.subtype), ['Highlight', 'Text', 'Text', 'Text', 'Highlight', 'Text']);
  assert.equal(list[0].author, 'Ann'); assert.equal(list[0].contents, 'original');
  assert.equal(list[1].inReplyTo, list[0].id); assert.equal(list[2].inReplyTo, list[1].id);
  const mine = list[4];
  assert.equal(mine.author, m.getAuthor()); assert.ok(Number.isFinite(mine.date) && Math.abs(mine.date - Date.now()) < 60000);
  assert.equal(mine.covered, 'The quick brown fox jumps over the lazy dog'.slice(0, mine.covered.length)); assert.ok(mine.covered.length > 10, mine.covered);
  assert.equal(list[5].contents, 'unsaved? no, saved');
  await doc.destroy();
});

// ---------- a PDF written by another tool ----------
test('comments written by LibreOffice are listed with their author and text, and can be replied to, edited, completed and deleted', async () => {
  const data = require('node:fs').readFileSync(path.join(root, 'tests/fixtures/libreoffice-comments.pdf')).toString('base64');
  const doc = await pdfjsDoc(data);
  const { functions } = loadRendererFunctions(['loadSavedComments', 'quadsOfAnnotation', 'coveredText', 'pdfDateMs', 'threadComments'], { extra: { COMMENT_LABELS: LABELS, pageItems: async p => (await (await doc.getPage(p)).getTextContent()).items } });
  const list = plain(await functions.loadSavedComments(doc));
  const notes = list.filter(x => x.subtype === 'Text');
  // LibreOffice writes "author, date, time" into /T; the panel shows what the file says
  assert.deepEqual(notes.map(n => [n.author.split(',')[0], n.contents]).sort(), [['Dana Reviewer', 'Please check these figures against the ledger.'], ['Eli Editor', 'Shorter please.']]);
  assert.ok(notes.every(n => Number.isFinite(n.date)));
  assert.ok(!list.some(x => x.subtype === 'Popup'));
  const ref = notes[0].id;
  let cur = (await call('comment-reply', { data, ref, text: 'will do' })).data;
  cur = (await call('comment-status', { data: cur, ref, state: 'Completed' })).data;
  cur = (await call('comment-update', { data: cur, ref, text: 'Please check against the ledger.' })).data;
  const d2 = await pdfjsDoc(cur);
  const f2 = loadRendererFunctions(['loadSavedComments', 'quadsOfAnnotation', 'coveredText', 'pdfDateMs', 'threadComments', 'commentStatus'], { extra: { COMMENT_LABELS: LABELS, pageItems: async p => (await (await d2.getPage(p)).getTextContent()).items } }).functions;
  const tree = f2.threadComments(plain(await f2.loadSavedComments(d2))), top = tree.find(n => n.id === ref);
  assert.equal(top.contents, 'Please check against the ledger.'); assert.equal(top.status, 'Completed'); assert.deepEqual(plain(top.replies.map(r => r.contents)), ['will do']);
  const gone = await call('comment-delete', { data: cur, ref });
  assert.ok(gone.success);
  const d3 = await pdfjsDoc(gone.data);
  assert.deepEqual((await (await d3.getPage(1)).getAnnotations({ intent: 'any' })).filter(a => a.subtype === 'Text').map(a => a.contentsObj.str), ['Shorter please.']);
  await Promise.all([doc, d2, d3].map(d => d.destroy()));
});

// ---------- markup survives flattening a form ----------
test('flattening form fields keeps the markup annotations', async () => {
  const data = await basePdf(async (doc, page) => { doc.getForm().createTextField('name').addToPage(page, { x: 50, y: 50, width: 100, height: 20 }); });
  const marked = await mods(data, [HL, { type: 'stickyNote', pageIndex: 0, x: 0.5, y: 0.5, text: 'n' }]);
  const r = await call('flatten-form', { data: marked });
  assert.ok(r.success, r.error);
  assert.deepEqual((await annotsOf(r.data)).list.map(a => subtype(a.dict)).sort(), ['Highlight', 'Text']);
});

test('pending annotation kinds listed in the panel are the ones apply-modifications turns into annotations', () => {
  assert.deepEqual(Object.keys(PENDING).sort(), ['highlight', 'stickyNote', 'strikethrough', 'underline']);
});

test('every comment channel is registered in main and exposed by the preload', () => {
  const preload = require('node:fs').readFileSync(path.join(root, 'src/preload.js'), 'utf8');
  for (const channel of ['comment-reply', 'comment-update', 'comment-delete', 'comment-status', 'settings-author-get', 'settings-author-set']) {
    assert.ok(handlers.has(channel), channel + ' is handled'); assert.ok(preload.includes(`'${channel}'`), channel + ' is in the preload');
  }
});

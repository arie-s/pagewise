const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createCanvas } = require('@napi-rs/canvas');
const { PDFDocument, PDFName, PDFString, PDFDict, PDFArray, PDFRawStream, PDFRef, StandardFonts, decodePDFRawStream } = require('@cantoo/pdf-lib');
const { root, loadMainHandlers, loadRendererFunctions } = require('./helpers.cjs');

const { handlers, context: m } = loadMainHandlers();
const R = loadRendererFunctions(['findRegex', 'pageSearchText', 'findPageMatches', 'partBox', 'matchPdfBox']).functions;
const FIXTURES = path.join(root, 'tests/fixtures');
const read = f => fs.readFileSync(path.join(FIXTURES, f));
const pdfjs = () => import('pdfjs-dist/legacy/build/pdf.mjs');
const plain = x => JSON.parse(JSON.stringify(x)); // values built inside the main-process sandbox live in another realm
const replace = async (bytes, query, replacement = '', opts = {}) => { const { data, ...rest } = await m.replaceText(bytes, { query, replacement, ...opts }); return { data: Buffer.from(data), ...plain(rest) }; };

// ---------- helpers: build PDFs, read them back with pdf.js, render them ----------
async function build(pages, { fonts = {}, extra } = {}) { // pages: content stream strings; F1 Helvetica, F2 Helvetica-Bold, F3 Courier, plus custom fonts
  const doc = await PDFDocument.create(), ctx = doc.context;
  const std = { F1: StandardFonts.Helvetica, F2: StandardFonts.HelveticaBold, F3: StandardFonts.Courier };
  const refs = {};
  for (const [k, v] of Object.entries(std)) refs[k] = doc.embedStandardFont(v).ref;
  for (const [k, v] of Object.entries(fonts)) refs[k] = ctx.register(ctx.obj(v));
  for (const content of pages) {
    const page = doc.addPage([400, 300]);
    for (const [k, ref] of Object.entries(refs)) page.node.setFontDictionary(PDFName.of(k), ref);
    page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(content)));
  }
  if (extra) await extra(doc);
  return Buffer.from(await doc.save());
}
async function open(bytes) { return (await pdfjs()).getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: path.join(root, 'node_modules/pdfjs-dist/standard_fonts/'), verbosity: 0 }).promise; }
async function itemsOf(bytes, n = 1) {
  const doc = await open(bytes);
  try { return (await (await doc.getPage(n)).getTextContent()).items.filter(i => i.str !== '').map(i => ({ str: i.str, x: i.transform[4], y: i.transform[5], w: i.width, h: i.height, transform: i.transform, width: i.width, height: i.height, hasEOL: i.hasEOL })); }
  finally { await doc.destroy(); }
}
// pdf.js decides for itself where spaces go around kerning, so texts are compared without whitespace
const textOf = async (bytes, n = 1) => (await itemsOf(bytes, n)).map(i => i.str).join('');
const squash = s => s.replace(/\s+/g, '');
// Every content stream of the file inflated, plus the raw bytes
async function rawAndInflated(bytes) {
  const doc = await PDFDocument.load(bytes), parts = [Buffer.from(bytes)];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) if (obj instanceof PDFRawStream) { try { parts.push(Buffer.from(decodePDFRawStream(obj).decode())); } catch (e) { /* not a text stream */ } }
  return Buffer.concat(parts).toString('latin1');
}
async function contentOf(bytes, pageIndex = 0) {
  const doc = await PDFDocument.load(bytes), c = doc.getPage(pageIndex).node.Contents();
  return { raw: Buffer.from(doc.context.lookup(c).contents).toString('hex'), text: Buffer.from(decodePDFRawStream(doc.context.lookup(c)).decode()).toString('latin1') };
}
async function render(bytes, n = 1, scale = 2) {
  const doc = await open(bytes), page = await doc.getPage(n), vp = page.getViewport({ scale }), canvas = createCanvas(vp.width, vp.height), ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport: vp, background: 'rgb(255,255,255)' }).promise;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  await doc.destroy();
  return { img, vp };
}
// Where the ink of the line at height y (PDF points) ends: pdf.js item widths change with how it splits a line, the pixels do not
function inkEnd({ img, vp }, y) {
  const pageH = vp.height / vp.scale, top = Math.max(0, Math.floor((pageH - y - 9) * vp.scale)), bottom = Math.min(img.height - 1, Math.ceil((pageH - y + 3) * vp.scale));
  let right = 0;
  for (let row = top; row <= bottom; row++) for (let x = img.width - 1; x > right; x--) { const i = (row * img.width + x) * 4; if (img.data[i] + img.data[i + 1] + img.data[i + 2] < 384) { right = x; break; } }
  return right / vp.scale;
}
const inkEndOf = async (bytes, y, n = 1) => inkEnd(await render(bytes, n, 4), y);
// Fraction of pixels that differ outside the boxes (PDF points), each grown by 2 pt
function outsideDiff(a, b, boxes) {
  const { img: A, vp } = a, B = b.img, grown = boxes.map(box => { const r = vp.convertToViewportRectangle(box), pad = 2 * vp.scale; return [Math.min(r[0], r[2]) - pad, Math.min(r[1], r[3]) - pad, Math.max(r[0], r[2]) + pad, Math.max(r[1], r[3]) + pad]; });
  let diff = 0;
  for (let y = 0; y < A.height; y++) for (let x = 0; x < A.width; x++) {
    if (grown.some(g => x >= g[0] && x <= g[2] && y >= g[1] && y <= g[3])) continue;
    const i = (y * A.width + x) * 4;
    if (Math.abs(A.data[i] - B.data[i]) + Math.abs(A.data[i + 1] - B.data[i + 1]) + Math.abs(A.data[i + 2] - B.data[i + 2]) > 48) diff++;
  }
  return diff / (A.width * A.height);
}
async function boxOf(bytes, text, n = 1, nth = 0) { // PDF-space box of the nth occurrence of text, as the renderer finds it
  const items = await itemsOf(bytes, n), found = R.findPageMatches(items, text, true, false);
  assert.ok(found[nth], `"${text}" is on the page`);
  return R.matchPdfBox(items, found[nth]);
}
// Width of a text in a standard font as the engine lays it out (size, Tz, Tc and Tw included)
const adv = (text, { font = 'Helvetica', size = 14, tz = 100, tc = 0, tw = 0 } = {}) => [...text].reduce((sum, ch) => sum + (m.standardGlyphWidth(font, ch) / 1000 * size + tc + (ch === ' ' ? tw : 0)) * tz / 100, 0);
// Replace, then check the old text is gone, the new is there, the rest of the line moved by exactly the change in width
// (fmt: the font of the line, to work that out; without it the change is taken from the boxes, within 5 pt) and every other line stayed put
async function checkEdit(bytes, query, replacement, { page = 1, expectText, boxes = [], lineY, fmt = {}, replaceOpts } = {}) {
  const before = await itemsOf(bytes, page), oldBox = await boxOf(bytes, query, page);
  const r = await replace(bytes, query, replacement, replaceOpts), sc = fmt ? 4 : 2, rb = await render(bytes, page, sc), ra = await render(r.data, page, sc);
  assert.ok(r.replaced >= 1, JSON.stringify(r.skipped));
  const after = await itemsOf(r.data, page), afterText = after.map(i => i.str).join('');
  assert.ok(!squash(afterText).includes(squash(query)), 'old text is gone from the text layer');
  assert.ok(squash(afterText).includes(squash(replacement)), 'new text is present');
  if (expectText) assert.ok(squash(afterText).includes(expectText), squash(afterText));
  const newBox = replacement ? await boxOf(r.data, replacement, page).catch(() => oldBox) : oldBox;
  const extra = [];
  if (lineY !== undefined) {
    const expected = fmt ? adv(replacement, fmt) - adv(query, fmt) : (newBox[2] - newBox[0]) - (oldBox[2] - oldBox[0]);
    const moved = inkEnd(ra, lineY) - inkEnd(rb, lineY);
    assert.ok(Math.abs(moved - expected) < (fmt ? 0.5 : 8), `the line end moved by ${moved}, expected ${expected}`);
    extra.push([oldBox[0] - 1, lineY - 4, Math.max(inkEnd(rb, lineY), inkEnd(ra, lineY)) + 1, lineY + 14]); // this line is allowed to change
  }
  const diff = outsideDiff(rb, ra, [oldBox, newBox, ...extra, ...boxes]);
  assert.ok(diff < 0.001, `${(diff * 100).toFixed(3)}% of the pixels outside the match changed`);
  return { r, before, after };
}

const PAGE = [
  'BT /F1 14 Tf 40 250 Td [(The qu) -30 (ick bro) 20 (wn fox)] TJ ET',
  'BT /F1 14 Tf 40 220 Td (Total: ) Tj 0 0 Td (2025 dollars) Tj ET',
  'BT /F1 14 Tf 40 190 Td (Second line of text) Tj ET'
].join('\n');

// ---------- the tokenizer and the CMap reader ----------
test('tokenizer: strings, names, arrays, dictionaries, comments, inline images and operator ranges', () => {
  const src = Buffer.from('% a comment (not a string)\nq 1 0 0 1 10 20 cm\n/Span <</MCID 3 /K [1 2]>> BDC\nBT (a\\(b\\) (nested) \\101\\n) Tj <48 656C6c6F2> Tj [(x) -20.5 <41>]TJ ET\nBI /W 2 /H 2 /BPC 8 /CS /G ID \x00\x01EI \x02 EI\nQ (end)\'', 'latin1');
  const ops = plain(m.tokenizeContent(src)).map(o => ({ op: o.op, text: src.toString('latin1', o.s, o.e) }));
  assert.deepEqual(ops.map(o => o.op), ['q', 'cm', 'BDC', 'BT', 'Tj', 'Tj', 'TJ', 'ET', 'BI', 'Q', "'"]);
  const tj = m.tokenizeContent(src).filter(o => o.op === 'Tj');
  assert.equal(Buffer.from(tj[0].args[0].bytes).toString('latin1'), 'a(b) (nested) A\n');
  assert.deepEqual(plain(tj[1].args[0].bytes), [0x48, 0x65, 0x6c, 0x6c, 0xf0 - 0xf0 + 0x6f, 0x20].slice(0, 5).concat([0x20]));
  assert.equal(ops[4].text, '(a\\(b\\) (nested) \\101\\n) Tj');
  assert.equal(ops[2].text, '/Span <</MCID 3 /K [1 2]>> BDC');
  assert.equal(ops[8].op, 'BI');
  assert.ok(ops[8].text.endsWith('\x02 EI'), 'binary data containing EI does not end the inline image early');
  assert.equal(ops[9].text, 'Q');
});
test('tokenizer: malformed content is an error, not a guess', () => {
  for (const bad of ['BT (unterminated Tj ET', '[(a) 1 TJ', '<</A 1 BT', 'BT <4Z> Tj ET']) assert.throws(() => m.tokenizeContent(Buffer.from(bad)), /Cannot read the page content/, bad);
});
test('ToUnicode: bfchar, both bfrange forms, 1 and 2 byte codes, surrogate pairs and ligatures', () => {
  const cmap = Buffer.from(`/CIDInit /ProcSet findresource begin 12 dict begin begincmap
1 begincodespacerange <0000> <FFFF> endcodespacerange
3 beginbfchar <0003> <0020> <0010> <D83DDE00> <0011> <00660069> endbfchar
2 beginbfrange <0020> <0023> <0041> <0030> <0032> [<0058> <00590059> <005A>] endbfrange
endcmap`);
  const map = m.parseToUnicode(cmap);
  const got = Object.fromEntries([...map].map(([k, v]) => [k, v]));
  assert.deepEqual(got, { 3: ' ', 16: '\u{1F600}', 17: 'fi', 32: 'A', 33: 'B', 34: 'C', 35: 'D', 48: 'X', 49: 'YY', 50: 'Z' });
  assert.equal(m.parseToUnicode(Buffer.from('1 beginbfchar <41> <0061> endbfchar')).get(0x41), 'a');
});

// ---------- the engine on WinAnsi standard fonts ----------
test('replaces a word inside a TJ: the old text is gone from the stream, the new text is there, nothing else moves or changes', async () => {
  const bytes = await build([PAGE]);
  const { r } = await checkEdit(bytes, 'Total', 'Sum', { lineY: 220 });
  assert.equal(r.sameFont, 1);
  assert.ok(!(await rawAndInflated(r.data)).includes('Total'), 'the old characters are not left in the file');
});
test('kerning inside a word and a match that spans two TJ elements', async () => {
  const bytes = await build([PAGE]);
  await checkEdit(bytes, 'quick', 'slow', { lineY: 250, expectText: 'Theslowbrownfox' });
  await checkEdit(bytes, 'ck bro', 'ck cow', { lineY: 250 });
  await checkEdit(bytes, 'quick', 'extraordinarily', { lineY: 250 });
});
test('a match that spans two Tj operations on the same line', async () => {
  const bytes = await build([PAGE]);
  const { r, after } = await checkEdit(bytes, 'al: 2025', 'al: 2026', { lineY: 220 });
  assert.equal(r.replaced, 1);
  assert.ok(squash(after.map(i => i.str).join('')).includes('Total:2026dollars'));
});
test('Tz, Tc, Tw and TL are part of the advance, so the rest of the line stays put', async () => {
  const bytes = await build([['BT /F1 12 Tf 150 Tz 0.4 Tc 6 Tw 14 TL 40 250 Td (Hello big wide world) Tj ET', 'BT /F2 12 Tf 70 Tz -0.5 Tc 40 200 Td [(Howdy) -300 (small tight room)] TJ ET'].join('\n')]);
  const { r } = await checkEdit(bytes, 'big wide', 'x', { lineY: 250, fmt: { size: 12, tz: 150, tc: 0.4, tw: 6 } });
  assert.equal(r.replaced, 1);
  await checkEdit(bytes, 'Howdy', 'Hey', { lineY: 200, fmt: { font: 'Helvetica-Bold', size: 12, tz: 70, tc: -0.5, tw: 6 } });
  await checkEdit(bytes, 'small tight', 'x', { lineY: 200, fmt: { font: 'Helvetica-Bold', size: 12, tz: 70, tc: -0.5, tw: 6 } });
});
test("the ' and \" operators move to the next line and set spacing: the lines after an edit stay where they were", async () => {
  const bytes = await build(['BT /F1 12 Tf 14 TL 40 250 Td (First line) Tj (Second line here) \' 3 0 (Third line text) " (Fourth) \' ET']);
  await checkEdit(bytes, 'Second', '2nd', { lineY: 236, fmt: { size: 12 } });
  const { r, after } = await checkEdit(bytes, 'Third', 'Last', { lineY: 222, fmt: { size: 12, tw: 3 } });
  assert.equal(r.replaced, 1);
  assert.ok(after.some(i => i.str.includes('Fourth') && Math.abs(i.y - 208) < 1), 'the line after still follows at the same place');
  await checkEdit(bytes, 'Third line', '', { lineY: 222, fmt: { size: 12, tw: 3 } });
});
test('the line reflows on both paths: a shorter and a longer replacement, in the font of the PDF and in a standard font', async () => {
  const font = { Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding', FirstChar: 32, LastChar: 126, Widths: Array.from({ length: 95 }, (_, i) => i + 32 === 81 ? 0 : 600) };
  const bytes = await build(['BT /F4 14 Tf 40 250 Td (one two three) Tj ET BT /F1 14 Tf 40 200 Td (other line) Tj ET'], { fonts: { F4: font } });
    const tz = await build(['BT /F4 14 Tf 150 Tz 40 150 Td (one two three) Tj ET BT /F1 14 Tf 100 Tz 1 0 0 1 250 150 Tm (end) Tj ET'], { fonts: { F4: font } });
  const rz = await replace(tz, 'two', 'Q'), after = await itemsOf(rz.data), before = await itemsOf(tz);
  assert.equal(rz.standardFont, 1, JSON.stringify(rz.skipped));
  const x = (items, str) => items.find(i => i.str.includes(str)).x, expected = adv('Q', { size: 14, tz: 150 }) - 3 * 8.4 * 1.5;
  assert.ok(Math.abs(x(after, 'end') - x(before, 'end') - expected) < 0.5, 'a later block moves by the change under Tz');
  for (const [q, repl, path] of [['two', 'x', 'sameFont'], ['two', 'twelve', 'sameFont'], ['two', 'Q', 'standardFont'], ['two', 'Qwerty!', 'standardFont']]) {
    const r = await replace(bytes, q, repl);
    assert.equal(r[path], 1, `${repl} goes through ${path}`);
    const expected = path === 'sameFont' ? (repl.length - q.length) * 8.4 : adv(repl, { font: 'Helvetica', size: 14 }) - 3 * 8.4;
    const moved = await inkEndOf(r.data, 250) - await inkEndOf(bytes, 250);
    assert.ok(Math.abs(moved - expected) < 0.5, `${q} -> ${repl}: moved ${moved}, expected ${expected}`);
    assert.equal(await inkEndOf(r.data, 200), await inkEndOf(bytes, 200), 'another line stays put');
  }
});
test('text positioned on its own after the match, in the same BT or in a later block on the same baseline, moves with the line; other lines do not', async () => {
  const bytes = await build([['BT /F1 14 Tf 40 250 Td (Hello big) Tj 100 0 Td (and more) Tj ET', 'BT /F2 14 Tf 1 0 0 1 200 250 Tm (bold) Tj ET', 'BT /F1 14 Tf 1 0 0 1 260 250 Tm (tail) Tj ET', 'BT /F1 14 Tf 1 0 0 1 20 250 Tm (head) Tj ET', 'BT /F1 14 Tf 1 0 0 1 200 220 Tm (bold) Tj ET'].join('\n')]);
  const before = await itemsOf(bytes), r = await replace(bytes, 'Hello', 'Hi');
  const after = await itemsOf(r.data), delta = adv('Hi') - adv('Hello');
  const x = (items, s, y) => items.find(i => i.str.includes(s) && Math.abs(i.y - y) < 1).x;
  for (const [s, y] of [['and more', 250], ['bold', 250], ['tail', 250]]) assert.ok(Math.abs(x(after, s, y) - x(before, s, y) - delta) < 0.5, `${s} moved by ${x(after, s, y) - x(before, s, y)}, expected ${delta}`);
  assert.equal(x(after, 'head', 250), x(before, 'head', 250), 'before the match: stays');
  assert.equal(x(after, 'bold', 220), x(before, 'bold', 220), 'another baseline: stays');
  const lines = await replace(bytes, 'big', 'a very long replacement'); // two matches on one line add up
  assert.equal(lines.overflow, 1, 'a line that got more than 2 pt longer is counted');
  const twice = await replace(bytes, 'o', 'oo');
  const t = await itemsOf(twice.data);
  assert.ok(Math.abs(x(t, 'tail', 250) - x(before, 'tail', 250) - (adv('o') * 2 + adv('o', { font: 'Helvetica-Bold' }))) < 0.5, 'three matches before the tail accumulate');
});
test('an empty replacement deletes the text', async () => {
  const bytes = await build([PAGE]);
  const { r, after } = await checkEdit(bytes, 'Second line', '', { lineY: 190 });
  assert.equal(r.replaced, 1);
  assert.equal(after.filter(i => Math.abs(i.y - 190) < 1).map(i => i.str).join('').trim(), 'of text');
});
test('match case and whole word, whitespace in the query matches any run of whitespace', async () => {
  const bytes = await build(['BT /F1 12 Tf 40 250 Td (Cat cat concat cats  the   cat) Tj ET']);
  assert.equal((await replace(bytes, 'cat')).found, 5);
  assert.equal((await replace(bytes, 'cat', 'dog', { matchCase: true })).found, 4);
  const w = await replace(bytes, 'cat', 'dog', { wholeWord: true });
  assert.equal(w.replaced, 3);
  assert.equal(squash(await textOf(w.data)), 'dogdogconcatcatsthedog');
  assert.equal((await replace(bytes, 'cat', 'dog', { wholeWord: true, matchCase: true })).replaced, 2);
  assert.equal((await replace(bytes, 'the cat', 'a dog')).replaced, 1, 'one space in the query matches three');
});
test('targets: only the occurrence that overlaps the rect most is replaced', async () => {
  const bytes = await build([['BT /F1 12 Tf 40 250 Td (one cat) Tj ET', 'BT /F1 12 Tf 40 200 Td (two cat) Tj ET', 'BT /F1 12 Tf 200 200 Td (three cat) Tj ET'].join('\n')]);
  const second = await boxOf(bytes, 'cat', 1, 1);
  const r = await replace(bytes, 'cat', 'dog', { targets: [{ page: 1, rect: second }] });
  assert.equal(r.replaced, 1);
  assert.equal(squash(await textOf(r.data)), 'onecattwodogthreecat');
  const miss = await replace(bytes, 'cat', 'dog', { targets: [{ page: 1, rect: [300, 10, 320, 20] }] });
  assert.equal(miss.replaced, 0);
  assert.deepEqual(miss.skipped, [{ page: 1, reason: 'not found' }]);
  const partial = await replace(bytes, 'cat', 'dog', { targets: [{ page: 1, rect: [second[0] + 10, second[1], second[0] + 30, second[3]] }] });
  assert.equal(partial.replaced, 0, 'less than half of the smaller box is not a match');
});
test('an untouched page keeps its content stream byte for byte', async () => {
  const bytes = await build([PAGE, 'BT /F1 12 Tf 40 250 Td (nothing here) Tj ET']);
  const r = await replace(bytes, 'Total', 'Sum');
  assert.equal(r.replaced, 1);
  assert.deepEqual(await contentOf(r.data, 1), await contentOf(bytes, 1));
  assert.notEqual((await contentOf(r.data, 0)).raw, (await contentOf(bytes, 0)).raw);
});
test('a page that cannot be parsed is skipped and left alone, the other pages are still done', async () => {
  const bytes = await build(['BT /F1 12 Tf 40 250 Td (cat ) Tj (unterminated Tj ET', 'BT /F1 12 Tf 40 250 Td (cat) Tj ET']);
  const r = await replace(bytes, 'cat', 'dog');
  assert.equal(r.replaced, 1);
  assert.deepEqual(r.skipped, [{ page: 1, reason: 'the page content could not be read' }]);
  assert.deepEqual(await contentOf(r.data, 0), await contentOf(bytes, 0));
  assert.equal(await textOf(r.data, 2), 'dog');
});
test('the same-font path is used when the font has the characters, the standard font otherwise', async () => {
  const lo = read('text/libreoffice.pdf');
  const same = await replace(lo, '2025', '2026'); // 6 is in the subset (5678)
  assert.deepEqual([same.replaced, same.sameFont, same.standardFont], [1, 1, 0]);
  assert.ok((await textOf(same.data)).includes('2026'));
  const std = await replace(lo, 'fox', 'Zebra'); // no Z in the subset
  assert.deepEqual([std.replaced, std.sameFont, std.standardFont], [1, 0, 1]);
  assert.ok((await textOf(std.data)).includes('Zebra'));
  assert.ok(!(await textOf(std.data)).includes('fox'));
  const mixed = await replace(lo, 'dog', 'cow');
  assert.equal(mixed.sameFont, 1);
});
test("characters the PDF's fonts cannot write are skipped with a reason", async () => {
  const lo = read('text/libreoffice.pdf');
  const r = await replace(lo, 'fox', '狐狸');
  assert.equal(r.replaced, 0);
  assert.deepEqual(r.skipped, [{ page: 1, reason: "the replacement uses characters this PDF's font does not have" }]);
  assert.ok((await textOf(r.data)).includes('fox'));
});

// ---------- real-world files ----------
test('LibreOffice: the text after the match keeps its place and other lines are unchanged', async () => {
  const lo = read('text/libreoffice.pdf');
  const { after, before } = await checkEdit(lo, 'quick brown', 'slow', { lineY: (await itemsOf(lo))[0].y, fmt: null });
  assert.ok(after.length >= before.length - 1);
  await checkEdit(lo, 'invoice total', 'invoice sum', { lineY: (await itemsOf(lo)).find(i => i.str.includes('invoice')).y, fmt: null });
});
test('LibreOffice: a match that starts or ends inside a ligature is skipped, a whole ligature is replaced', async () => {
  const lo = read('text/libreoffice.pdf');
  assert.ok((await textOf(lo)).includes('find'));
  const inside = await replace(lo, 'ind', 'ond');
  assert.equal(inside.replaced, 0);
  assert.deepEqual(inside.skipped.map(s => s.reason), ['the match starts or ends inside a ligature']);
  const endsInside = await replace(lo, 'of', 'oz'); // the first f of the ff in "office"
  assert.equal(endsInside.replaced, 0);
  assert.equal(endsInside.skipped.length, 1);
  const whole = await replace(lo, 'find', 'fund');
  assert.equal(whole.replaced, 1);
  assert.ok((await textOf(whole.data)).includes('fund'));
  assert.equal((await replace(lo, 'office', 'office')).replaced, 1);
  const fi = await replace(lo, 'fi', 'fo'); // the fi in "find" is a whole ligature, the fi in "office" starts inside the ff
  assert.deepEqual([fi.replaced, fi.skipped.length], [1, 1]);
});
test('LibreOffice: a bold word is replaced in its own font', async () => {
  const lo = read('text/libreoffice.pdf');
  const r = await replace(lo, 'bold', 'bolder');
  assert.equal(r.replaced, 1);
  const items = await itemsOf(r.data);
  assert.ok(items.some(i => i.str.includes('bolder')));
});
test('Chromium (Type0 Identity-H subsets): same font for characters in the subset, the standard font for others', async () => {
  const ch = read('text/chromium.pdf');
  const same = await replace(ch, '1234', '4321'); // the body font has all four digits
  assert.deepEqual([same.replaced, same.sameFont, same.standardFont], [1, 1, 0]);
  assert.ok((await textOf(same.data)).includes('4321'));
  const heading = await replace(ch, '2025', '2125'); // the bold heading font has no 1
  assert.deepEqual([heading.replaced, heading.sameFont, heading.standardFont], [1, 0, 1]);
  const { r } = await checkEdit(ch, 'Total due', 'Amount', { lineY: (await itemsOf(ch)).find(i => i.str.includes('Total')).y, fmt: null });
  assert.equal(r.standardFont, 1);
  const bold = await replace(ch, 'Quarterly', 'Annual');
  assert.equal(bold.standardFont, 1, 'the heading is drawn in Helvetica-Bold');
  const doc = await PDFDocument.load(bold.data);
  assert.ok((await rawAndInflated(bold.data)).includes('/Helvetica-Bold'));
  assert.equal(doc.getPageCount(), 1);
});
test('Chromium: a match on one line only changes that line', async () => {
  const ch = read('text/chromium.pdf');
  const before = await itemsOf(ch), r = await replace(ch, 'billing', 'accounts');
  assert.equal(r.replaced, 1);
  const after = await itemsOf(r.data);
  const y = before.find(i => i.str.includes('billing')).y;
  assert.deepEqual(plain(after.filter(i => Math.abs(i.y - y) > 1).map(i => [i.str, i.x, i.y])), plain(before.filter(i => Math.abs(i.y - y) > 1).map(i => [i.str, i.x, i.y])));
});
test('the W-9: a title phrase is replaced and the form is intact', async () => {
  const fw9 = read('forms/fw9.pdf');
  const before = await PDFDocument.load(fw9), names = d => d.getForm().getFields().map(f => f.getName()).sort();
  const r = await replace(fw9, 'Request for Taxpayer', 'Asked of Payer');
  assert.equal(r.replaced, 1);
  const text = await textOf(r.data);
  assert.ok(text.includes('Asked of Payer') && !text.includes('Request for Taxpayer'));
  const after = await PDFDocument.load(r.data);
  assert.deepEqual(names(after), names(before));
  const links = d => d.getPages().map(p => { const a = p.node.Annots(); return a ? a.size() : 0; });
  assert.deepEqual(links(after), links(before));
  const o1 = await open(fw9), o2 = await open(r.data);
  assert.deepEqual(plain(await o2.getOutline()), plain(await o1.getOutline()));
  const diff = outsideDiff(await render(fw9), await render(r.data), [await boxOf(fw9, 'Request for Taxpayer'), await boxOf(r.data, 'Asked of Payer')]);
  assert.ok(diff < 0.001, `${diff * 100}% differ`);
  assert.equal(r.signedWarning, false);
});

// ---------- fonts and encodings ----------
test('a simple font with /Differences and no ToUnicode is decoded through glyph names', async () => {
  const font = { Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: { Type: 'Encoding', BaseEncoding: 'WinAnsiEncoding', Differences: [128, 'Euro', 'bullet', 200, 'uni20AC', 'u0041'] } };
  const bytes = await build(['BT /F4 14 Tf 40 250 Td <80812e30> Tj 20 0 Td <c8c9> Tj ET'], { fonts: { F4: font } });
  const r = await replace(bytes, '€•', 'EUR');
  assert.equal(r.replaced, 1);
  const lines = await textOf(r.data);
  assert.ok(lines.includes('EUR') && lines.includes('A'));
  assert.equal((await replace(bytes, '\u20ACA', 'x')).replaced, 1, 'uniXXXX and uXXXX names');
});
test('StandardEncoding and MacRoman fonts without ToUnicode', async () => {
  const mac = { Type: 'Font', Subtype: 'TrueType', BaseFont: 'Helvetica', Encoding: 'MacRomanEncoding' };
  const std = { Type: 'Font', Subtype: 'Type1', BaseFont: 'Times-Roman' };
  const bytes = await build(['BT /F4 14 Tf 40 250 Td <8e20636166> Tj ET BT /F5 14 Tf 40 200 Td <a4a720bb> Tj ET'], { fonts: { F4: mac, F5: std } });
  assert.equal((await replace(bytes, 'é caf', 'X')).replaced, 1, 'MacRoman 0x8E is e-acute');
  assert.equal((await replace(bytes, '⁄§', 'X')).replaced, 1, 'StandardEncoding 0xA4 is fraction, 0xA7 is section');
});
test('Type0 without a ToUnicode map, Type3 and vertical writing are skipped with a reason', async () => {
  const ch = read('text/chromium.pdf');
  const noMap = await PDFDocument.load(ch);
  for (const [, o] of noMap.context.enumerateIndirectObjects()) if (o instanceof PDFDict && o.get(PDFName.of('ToUnicode'))) o.delete(PDFName.of('ToUnicode'));
  const stripped = Buffer.from(await noMap.save());
  const r = await replace(stripped, 'invoice', 'bill');
  assert.equal(r.replaced, 0);
  assert.ok(r.skipped.some(s => s.page === 1 && s.reason === 'font without text mapping'), JSON.stringify(r.skipped));
  const type3 = { Type: 'Font', Subtype: 'Type3', FontBBox: [0, 0, 1, 1], FontMatrix: [1, 0, 0, 1, 0, 0], CharProcs: {}, Encoding: { Type: 'Encoding', Differences: [] }, FirstChar: 0, LastChar: 0, Widths: [1] };
  const t3 = await build(['BT /F4 14 Tf 40 250 Td (abc) Tj ET'], { fonts: { F4: type3 } });
  assert.ok((await replace(t3, 'abc', 'x')).skipped.some(s => /Type3/.test(s.reason)));
  const vertical = await PDFDocument.load(ch);
  for (const [, o] of vertical.context.enumerateIndirectObjects()) if (o instanceof PDFDict && o.get(PDFName.of('Encoding'))?.toString() === '/Identity-H') o.set(PDFName.of('Encoding'), PDFName.of('Identity-V'));
  assert.ok((await replace(Buffer.from(await vertical.save()), 'invoice', 'bill')).skipped.some(s => s.reason === 'vertical writing'));
});
test('fills: the replacement drawn in a standard font uses the colour of the text it replaces', async () => {
  const font = { Type: 'Font', Subtype: 'Type1', BaseFont: 'ABCDEF+Garamond-BoldItalic', Encoding: 'WinAnsiEncoding', FirstChar: 65, LastChar: 66, Widths: [600, 600] };
  const bytes = await build([['BT /F4 20 Tf 1 0 0 rg 40 250 Td (AB AB) Tj ET', 'BT /F4 20 Tf 0 0.5 0 0.2 k 40 200 Td (AB) Tj ET', 'BT /F4 20 Tf /Cs1 cs 0.1 0.2 0.3 sc 40 150 Td (AB) Tj ET'].join('\n')], { fonts: { F4: font } });
  const r = await replace(bytes, 'AB', 'Q', {});
  assert.equal(r.replaced, 4);
  assert.equal(r.standardFont, 4, 'Q has no width in the font');
  const { text } = await contentOf(r.data);
  assert.match(text, /1 0 0 rg 0 Tc 0 Tw 100 Tz 0 Ts 0 Tr \(Q\) Tj ET Q/);
  assert.match(text, /0 0\.5 0 0\.2 k 0 Tc/);
  assert.match(text, /\/PW\d+ 20 Tf/);
  assert.match(text, /0 0\.5 0 0\.2 k 0 Tc 0 Tw 100 Tz 0 Ts 0 Tr \(Q\) Tj ET Q\nq/);
  assert.match(text, /0 g 0 Tc 0 Tw 100 Tz 0 Ts 0 Tr \(Q\) Tj ET Q\n$/, 'a colour space the engine does not know is drawn black');
  const fonts = (await rawAndInflated(r.data));
  assert.ok(fonts.includes('/Times-BoldItalic'), 'Garamond bold italic maps to Times-BoldItalic');
});
test('standardFontFor picks the family and style from the name of the original font', () => {
  const pick = n => m.standardFontFor(n);
  assert.equal(pick('ABCDEF+DejaVuSerif-Bold'), 'Times-Bold');
  assert.equal(pick('DejaVuSans'), 'Helvetica');
  assert.equal(pick('LiberationMono-Italic'), 'Courier-Oblique');
  assert.equal(pick('Consolas-BoldItalic'), 'Courier-BoldOblique');
  assert.equal(pick('Georgia'), 'Times-Roman');
  assert.equal(pick('Arial-Black'), 'Helvetica-Bold');
  assert.equal(pick('Calibri-Light'), 'Helvetica');
  assert.equal(pick('TimesNewRomanPS-ItalicMT'), 'Times-Italic');
  assert.equal(pick('HelveticaNeueLTStd-Roman'), 'Helvetica');
});

// ---------- Form XObjects ----------
async function withForms(shared) {
  return build(['q 1 0 0 1 0 0 cm /Fm1 Do Q', shared ? 'q 1 0 0 1 0 -50 cm /Fm1 Do Q' : 'BT /F1 12 Tf 40 100 Td (page text) Tj ET'], {
    extra: async doc => {
      const ctx = doc.context, font = doc.getPage(0).node.Resources().lookup(PDFName.of('Font'), PDFDict).get(PDFName.of('F1'));
      const form = ctx.stream('BT /F1 12 Tf 40 250 Td (form text here) Tj ET', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 400, 300], Resources: { Font: { F1: font } } });
      const ref = ctx.register(form);
      for (const p of doc.getPages()) p.node.setXObject(PDFName.of('Fm1'), ref);
    }
  });
}
test('text in a Form XObject drawn once is edited', async () => {
  const bytes = await withForms(false);
  const r = await replace(bytes, 'form text', 'FORM TEXT');
  assert.equal(r.replaced, 1);
  assert.ok(squash(await textOf(r.data)).includes('FORMTEXThere'));
  assert.ok(!(await rawAndInflated(r.data)).includes('form text'));
});
test('a Form XObject drawn in several places is not edited (the edit would change every copy)', async () => {
  const bytes = await withForms(true);
  const r = await replace(bytes, 'form text', 'FORM TEXT');
  assert.equal(r.replaced, 0);
  assert.ok(r.skipped.some(s => /shared by several/.test(s.reason)), JSON.stringify(r.skipped));
  assert.ok((await rawAndInflated(r.data)).includes('form text'));
});
test('a content stream shared by two pages is not edited for one of them', async () => {
  const bytes = await build(['BT /F1 12 Tf 40 250 Td (shared cat) Tj ET'], { extra: async doc => { const p2 = doc.addPage([400, 300]); p2.node.set(PDFName.of('Contents'), doc.getPage(0).node.get(PDFName.of('Contents'))); p2.node.set(PDFName.of('Resources'), doc.getPage(0).node.get(PDFName.of('Resources'))); } });
  const r = await replace(bytes, 'cat', 'dog');
  assert.equal(r.replaced, 0);
  assert.ok(r.skipped.every(s => /shared/.test(s.reason)));
});

// ---------- must not break ----------
test('encrypted PDFs are refused with the way out', async () => {
  const bytes = await build([PAGE]);
  const enc = await handlers.get('encrypt-pdf')(null, { data: bytes.toString('base64'), userPassword: 'pw', ownerPassword: 'owner' });
  assert.equal(enc.success, true, enc.error);
  await assert.rejects(m.replaceText(Buffer.from(enc.data, 'base64'), { query: 'Total', replacement: 'Sum' }), /Remove the password first \(Security → Remove Password\)/);
  const viaIpc = await handlers.get('replace-text')(null, { data: enc.data, query: 'Total', replacement: 'Sum' });
  assert.equal(viaIpc.success, false);
  assert.match(viaIpc.error, /Remove the password first/);
});
test('signed PDFs are flagged so the renderer can ask first', async () => {
  const flagged = await build([PAGE], { extra: async doc => { doc.catalog.set(PDFName.of('AcroForm'), doc.context.obj({ SigFlags: 3, Fields: [] })); } });
  assert.equal((await replace(flagged, 'Total', 'Sum')).signedWarning, true);
  const signed = await build([PAGE], { extra: async doc => {
    const ctx = doc.context, sig = ctx.register(ctx.obj({ Type: 'Sig', Filter: 'Adobe.PPKLite', ByteRange: [0, 1, 2, 3], Contents: '<00>' }));
    const field = ctx.register(ctx.obj({ FT: 'Sig', T: 'Signature1', V: sig, Subtype: 'Widget', Rect: [0, 0, 0, 0] }));
    doc.catalog.set(PDFName.of('AcroForm'), ctx.obj({ Fields: [field] }));
  } });
  const r = await replace(signed, 'Total', 'Sum');
  assert.equal(r.signedWarning, true);
  assert.equal(r.replaced, 1);
  assert.equal((await replace(await build([PAGE]), 'Total', 'Sum')).signedWarning, false);
});
test('form fields, annotations and the outline survive', async () => {
  const bytes = await build([PAGE], { extra: async doc => {
    const page = doc.getPage(0), form = doc.getForm();
    form.createTextField('name').addToPage(page, { x: 40, y: 100, width: 100, height: 20 });
    form.getTextField('name').setText('Ada');
    const ctx = doc.context, link = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [40, 240, 100, 260], Border: [0, 0, 0], A: { S: 'URI', URI: 'https://example.com' } }));
    page.node.set(PDFName.of('Annots'), ctx.obj([...page.node.Annots().asArray(), link]));
    const out1 = ctx.nextRef(), root = ctx.nextRef();
    ctx.assign(out1, ctx.obj({ Title: PDFString.of('Intro'), Parent: root, Dest: [page.ref, 'Fit'] }));
    ctx.assign(root, ctx.obj({ Type: 'Outlines', First: out1, Last: out1, Count: 1 }));
    doc.catalog.set(PDFName.of('Outlines'), root);
  } });
  const r = await replace(bytes, 'Total', 'Sum');
  assert.equal(r.replaced, 1);
  const after = await PDFDocument.load(r.data), fields = after.getForm().getFields();
  assert.deepEqual(fields.map(f => f.getName()), ['name']);
  assert.equal(after.getForm().getTextField('name').getText(), 'Ada');
  assert.equal(after.getPage(0).node.Annots().size(), 2);
  const doc = await open(r.data);
  assert.deepEqual(plain((await doc.getOutline()).map(o => o.title)), ['Intro']);
  const orig = await open(bytes);
  assert.deepEqual(plain((await (await doc.getPage(1)).getAnnotations()).map(a => [a.subtype, a.rect])), plain((await (await orig.getPage(1)).getAnnotations()).map(a => [a.subtype, a.rect])));
});
test('nothing matched: the bytes come back as they went in', async () => {
  const bytes = await build([PAGE]);
  const r = await replace(bytes, 'absent', 'x');
  assert.equal(r.replaced, 0);
  assert.ok(r.data.equals(bytes));
  assert.deepEqual([(await replace(bytes, '   ', 'x')).replaced, (await replace(bytes, '', 'x')).replaced], [0, 0]);
});
test('replace-text over IPC takes and returns base64', async () => {
  const bytes = await build([PAGE]);
  const r = plain(await handlers.get('replace-text')(null, { data: bytes.toString('base64'), query: 'Total', replacement: 'Sum', matchCase: true, wholeWord: true, targets: 'all' }));
  assert.equal(r.success, true, r.error);
  assert.equal(r.replaced, 1);
  assert.ok(squash(await textOf(Buffer.from(r.data, 'base64'))).includes('Sum:2025'));
});

test('a hostile ToUnicode map is capped: 2000 ranges of 65536 codes finish quickly and the first codes still decode', () => {
  const ranges = Array.from({ length: 2000 }, () => '<0000> <FFFF> <0041>').join('\n');
  const t0 = Date.now(), map = m.parseToUnicode(Buffer.from('2000 beginbfrange\n' + ranges + '\nendbfrange'));
  assert.ok(Date.now() - t0 < 1000, 'took ' + (Date.now() - t0) + ' ms');
  assert.equal(map.size, 65536);
  assert.equal(map.get(0), 'A');
  assert.equal(m.parseToUnicode(Buffer.from('1 beginbfrange <00> <FF> <0041> endbfrange 1 beginbfrange <00> <FF> <0100> endbfrange'), 256).size, 256, 'one byte fonts: at most 256');
});
test('a hostile /W array is capped', async () => {
  const w = []; for (let i = 0; i < 2000; i++) w.push(0, 65535, 500);
  const ch = await PDFDocument.load(read('text/chromium.pdf'));
  for (const [, o] of ch.context.enumerateIndirectObjects()) if (o instanceof PDFDict && o.get(PDFName.of('W'))) o.set(PDFName.of('W'), ch.context.obj(w));
  const t0 = Date.now(), r = await replace(Buffer.from(await ch.save()), 'invoice', 'bill');
  assert.ok(Date.now() - t0 < 2000, 'took ' + (Date.now() - t0) + ' ms');
  assert.ok(r.found >= 1);
});
test('replace-text rejects bad input', async () => {
  const data = (await build([PAGE])).toString('base64'), ok = { data, query: 'Total', replacement: 'Sum' };
  const call = args => handlers.get('replace-text')(null, args).then(plain);
  assert.equal((await call(ok)).success, true);
  const bad = [
    ['no data', { ...ok, data: undefined }], ['data that is not a string', { ...ok, data: 5 }],
    ['an empty query', { ...ok, query: '' }], ['a query that is not text', { ...ok, query: 7 }], ['a query over 500 characters', { ...ok, query: 'a'.repeat(501) }],
    ['a replacement that is not text', { ...ok, replacement: 7 }], ['a replacement over 2000 characters', { ...ok, replacement: 'a'.repeat(2001) }],
    ['targets that are not all or a list', { ...ok, targets: 'some' }], ['more than 1000 targets', { ...ok, targets: Array.from({ length: 1001 }, () => ({ page: 1, rect: [0, 0, 1, 1] })) }],
    ['a page of 0', { ...ok, targets: [{ page: 0, rect: [0, 0, 1, 1] }] }], ['a page that is not whole', { ...ok, targets: [{ page: 1.5, rect: [0, 0, 1, 1] }] }],
    ['a rect of 3 numbers', { ...ok, targets: [{ page: 1, rect: [0, 0, 1] }] }], ['a rect with NaN', { ...ok, targets: [{ page: 1, rect: [0, 0, 1, NaN] }] }],
    ['a rect with text', { ...ok, targets: [{ page: 1, rect: [0, 0, 1, '2'] }] }], ['a null target', { ...ok, targets: [null] }]
  ];
  for (const [what, args] of bad) { const r = await call(args); assert.equal(r.success, false, what); assert.ok(r.error, what); }
  assert.equal((await handlers.get('replace-text')(null)).success, false);
  const coerced = await call({ ...ok, matchCase: 'yes', wholeWord: 1, targets: [{ page: 1, rect: [0, 0, 400, 300] }] });
  assert.equal(coerced.success, true);
});

test('the same font is only used for glyphs the embedded font is known to have', async () => {
  const fw9 = read('forms/fw9.pdf');
  const r = await replace(fw9, 'Request for Taxpayer', 'Demand from Payer'); // the title subset has no D or P
  assert.deepEqual([r.replaced, r.sameFont, r.standardFont], [1, 0, 1]);
  const text = await textOf(r.data);
  assert.ok(text.includes('Demand from Payer'));
  const w = (await boxOf(r.data, 'Demand from Payer'))[2] - (await boxOf(r.data, 'Demand from Payer'))[0];
  assert.ok(w > 80, 'drawn in a font that has the letters');
  assert.equal((await replace(fw9, 'Request for Taxpayer', 'Request for Taxes')).sameFont, 1, 'letters the subset shows elsewhere are fine');
  const widths = Array.from({ length: 95 }, () => 600);
  const subset = { Type: 'Font', Subtype: 'Type1', BaseFont: 'ABCDEF+Sample', Encoding: 'WinAnsiEncoding', FirstChar: 32, LastChar: 126, Widths: widths };
  const bytes = await build(['BT /F4 14 Tf 40 250 Td (AB) Tj ET BT /F4 14 Tf 40 200 Td (A) Tj ET'], { fonts: { F4: subset } });
  assert.deepEqual([(await replace(bytes, 'AB', 'BA')).sameFont, (await replace(bytes, 'AB', 'BC')).standardFont], [1, 1], 'C has a width but is never shown');
  const listed = { ...subset, BaseFont: 'Sample', FontDescriptor: { Type: 'FontDescriptor', FontName: 'Sample', Flags: 32, CharSet: PDFString.of('/A/B/space') } };
  const named = await build(['BT /F4 14 Tf 40 250 Td (ABC) Tj ET'], { fonts: { F4: listed } });
  assert.deepEqual([(await replace(named, 'ABC', 'BA')).sameFont, (await replace(named, 'A', 'D')).standardFont], [1, 1], '/CharSet says which glyphs there are');
});

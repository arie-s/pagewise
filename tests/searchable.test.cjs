const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { loadMainHandlers, root } = require('./helpers.cjs');

const { context: m } = loadMainHandlers();
const { parseLayout, layoutTokens, normToken, mergeLayout } = m;
const dir = path.join(root, 'tests/fixtures/searchable');
const pages = JSON.parse(fs.readFileSync(path.join(dir, 'pages.json'), 'utf8'));

async function grayOf(name) {
  const img = await loadImage(path.join(dir, name + '.png'));
  const c = createCanvas(img.width, img.height), ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, img.width, img.height).data, data = new Uint8Array(img.width * img.height);
  for (let i = 0; i < data.length; i++) data[i] = Math.round(0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]);
  return { width: img.width, height: img.height, data };
}
const iou = (a, b) => {
  const iw = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), ih = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (iw <= 0 || ih <= 0) return 0;
  const i = iw * ih;
  return i / ((a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - i);
};
function score(truth, words) {
  const used = new Set();
  let found = 0, onWord = 0, n = 0;
  for (const t of truth) {
    const [x0, y0, x1, y1] = t.box, tn = normToken(t.text);
    if (!tn) continue;
    n++;
    let best = -1, bi = -1;
    words.forEach((w, i) => { if (used.has(i) || normToken(w.text) !== tn) return; const v = iou(w, { x0, y0, x1, y1 }); if (v > bi) { best = i; bi = v; } });
    if (best < 0) continue;
    used.add(best); found++;
    const w = words[best], cx = (w.x0 + w.x1) / 2, cy = (w.y0 + w.y1) / 2;
    if (cx >= x0 && cx <= x1 && cy >= y0 - 8 && cy <= y1 + 8) onWord++;
  }
  return { found: 100 * found / n, onWord: 100 * onWord / n };
}
const box = ([x0, y0, x1, y1]) => ({ x0, y0, x1, y1 });

test('hybrid text layer is at least as good as Tesseract alone on every fixture page', async () => {
  const rows = [], res = {};
  for (const name of Object.keys(pages)) {
    const p = pages[name], tessWords = p.tesseract.map(w => ({ text: w.text, ...box(w.box) }));
    const hybrid = mergeLayout({ blocks: p.layout, tessWords, gray: await grayOf(name) });
    const h = score(p.truth, hybrid), t = score(p.truth, tessWords);
    res[name] = { h, t };
    rows.push(`${name.padEnd(9)} hybrid ${h.found.toFixed(1).padStart(5)}% / ${h.onWord.toFixed(1).padStart(5)}%   tesseract ${t.found.toFixed(1).padStart(5)}% / ${t.onWord.toFixed(1).padStart(5)}%`);
  }
  console.log('page      found / on-word (hybrid vs tesseract)\n' + rows.join('\n'));
  for (const [name, { h, t }] of Object.entries(res)) {
    assert.ok(h.found >= t.found - 0.5, `${name} found ${h.found} vs ${t.found}`);
    assert.ok(h.onWord >= t.onWord - 2, `${name} on-word ${h.onWord} vs ${t.onWord}`);
  }
  assert.ok(res.fax.h.found >= 70, 'fax found ' + res.fax.h.found);
  assert.ok(res.shadow.h.found >= 95, 'shadow found ' + res.shadow.h.found);
  // Tesseract finds ~nothing on these, so lock in the ink-estimated positions directly (measured: fax 40.4, shadow 99.6).
  assert.ok(res.fax.h.onWord >= 37, 'fax on-word ' + res.fax.h.onWord);
  assert.ok(res.shadow.h.onWord >= 95, 'shadow on-word ' + res.shadow.h.onWord);
});

test('parseLayout handles fences, wrappers, garbage and invalid boxes', () => {
  const b = { bbox: [1, 2, 3, 4], category: 'Text', text: 'hi' };
  assert.equal(parseLayout('```json\n' + JSON.stringify([b]) + '\n```').length, 1);
  assert.equal(parseLayout(JSON.stringify({ note: 'x', elements: [b] })).length, 1);
  assert.equal(parseLayout('not json {').length, 0);
  assert.equal(parseLayout(null).length, 0);
  assert.equal(parseLayout(JSON.stringify([b, { ...b, bbox: [1, 2, 3] }, { ...b, bbox: [1, 2, 3, 'x'] }, { ...b, text: 5 }, null])).length, 1);
});

test('layoutTokens splits tables by cell and strips markdown', () => {
  assert.deepEqual(Array.from(layoutTokens({ category: 'Table', bbox: [0, 0, 1, 1], text: '<table><tr><th>Item no</th><th>Qty</th></tr><tr><td>Bolt</td><td>4</td></tr></table>' })), ['Item', 'no', 'Qty', 'Bolt', '4']);
  assert.deepEqual(Array.from(layoutTokens({ category: 'Text', bbox: [0, 0, 1, 1], text: '# **Hello** _big_ world\n- item `one`' })), ['Hello', 'big', 'world', 'item', 'one']);
  assert.deepEqual(Array.from(layoutTokens({ category: 'Picture', bbox: [0, 0, 1, 1], text: 'x' })), []);
});

test('mergeLayout uses Tesseract boxes when matched, ink boxes otherwise, and keeps outside words', () => {
  const W = 200, H = 60, data = new Uint8Array(W * H).fill(255);
  const ink = (x0, x1) => { for (let y = 20; y < 30; y++) for (let x = x0; x < x1; x++) data[y * W + x] = 0; };
  ink(20, 50); ink(70, 100); ink(120, 150);
  const tess = [{ text: 'alpha', x0: 21, y0: 19, x1: 51, y1: 31 }, { text: 'gamma', x0: 121, y0: 19, x1: 151, y1: 31 }, { text: 'stray', x0: 20, y0: 50, x1: 60, y1: 58 }];
  const out = mergeLayout({ blocks: [{ bbox: [10, 10, 160, 40], category: 'Text', text: 'alpha beta gamma' }], tessWords: tess, gray: { width: W, height: H, data } });
  assert.deepEqual(Array.from(out.map(w => w.text)), ['alpha', 'beta', 'gamma', 'stray']);
  assert.equal(out[0].x0, 21);
  assert.deepEqual([out[1].x0, out[1].x1, out[1].y0, out[1].y1], [70, 100, 20, 30]);
  assert.equal(out[2].x0, 121);
  assert.equal(out[3].x0, 20);
});

test('alignment skips Tesseract junk words instead of losing the AI words after them', () => {
  const { context } = loadMainHandlers();
  const gray = { width: 400, height: 100, data: new Uint8Array(400 * 100).fill(255) };
  const tw = (text, x) => ({ text, x0: x, y0: 10, x1: x + 30, y1: 30 });
  const tessWords = [tw('alpha', 10), tw('~~', 50), tw('beta', 90), tw('gamma', 130), tw('delta', 170)];
  const out = context.mergeLayout({ blocks: [{ bbox: [0, 0, 400, 40], category: 'Text', text: 'alpha beta gamma delta' }], tessWords, gray });
  assert.deepEqual(Array.from(out, w => `${w.text}@${w.x0}`), ['alpha@10', 'beta@90', 'gamma@130', 'delta@170']);
});

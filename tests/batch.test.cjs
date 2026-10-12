const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadMainHandlers } = require('./helpers.cjs');

const { context } = loadMainHandlers();
const plain = v => JSON.parse(JSON.stringify(v));

test('collectExtractInputs takes files and folders, sorts folders naturally, ignores other files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-batch-'));
  try {
    for (const n of ['img10.PNG', 'img2.jpg', 'img1.JPEG', 'doc.pdf', 'notes.txt']) fs.writeFileSync(path.join(dir, n), 'x');
    fs.mkdirSync(path.join(dir, 'sub.pdf'));
    const single = path.join(dir, 'notes.txt');
    const got = plain(context.collectExtractInputs([dir, single]));
    assert.deepEqual(got.map(i => i.name), ['doc.pdf', 'img1.JPEG', 'img2.jpg', 'img10.PNG', 'notes.txt']);
    assert.equal(got[0].path, path.join(dir, 'doc.pdf'));
    assert.throws(() => context.collectExtractInputs([path.join(dir, 'missing.pdf')]), /not found/);
    assert.deepEqual(plain(context.collectExtractInputs([])), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('combineTables merges same-header tables with a Source column and splits different headers', () => {
  const docs = [
    { name: 'a.pdf', tables: [[['Item', 'Qty'], ['x', '1']], [['Name'], ['n']]] },
    { name: 'b.png', tables: [[[' item ', 'QTY'], ['y', '2'], ['z', '3']]] },
    { name: 'c.pdf', tables: [] }
  ];
  assert.deepEqual(plain(context.combineTables(docs)), [
    [['Source', 'Item', 'Qty'], ['a.pdf', 'x', '1'], ['b.png', 'y', '2'], ['b.png', 'z', '3']],
    [['Source', 'Name'], ['a.pdf', 'n']]
  ]);
  assert.deepEqual(plain(context.combineTables([{ name: 'a', tables: [[['A', 'B']]] }, { name: 'b', tables: [[['A']]] }])).map(t => t.length), [1, 1]);
  assert.deepEqual(plain(context.combineTables([])), []);
});

test('uniqueStem numbers repeated stems', () => {
  const used = new Set();
  assert.deepEqual(['a', 'a', 'b', 'a'].map(s => context.uniqueStem(s, used)), ['a', 'a_2', 'b', 'a_3']);
});

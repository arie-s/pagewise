const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { root, loadMainHandlers, loadRendererFunctions } = require('./helpers.cjs');

const { context } = loadMainHandlers();
const plain = v => JSON.parse(JSON.stringify(v));

// Tiny ZIP reader: central directory, inflateRaw, CRC check
function unzip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, 'end of central directory');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl);
    assert.equal(buf.readUInt32LE(off), 0x04034b50);
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28), body = buf.subarray(start, start + csize);
    const data = method === 8 ? zlib.inflateRawSync(body) : body;
    assert.equal(data.length, usize, name + ' size');
    assert.equal(zlib.crc32 ? zlib.crc32(data) : crc, crc, name + ' crc');
    files[name] = { data, method, crc };
    p += 46 + nl + el + cl;
  }
  return files;
}
const part = (zip, name) => zip[name].data.toString('utf8');
function assertWellFormed(zip) {
  const py = spawnSync('python3', ['-c', 'import sys, xml.dom.minidom\nfor f in sys.argv[1:]: xml.dom.minidom.parse(f)'], { encoding: 'utf8' });
  if (py.error) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-xml-'));
  try {
    const paths = Object.keys(zip).map((n, i) => { const f = path.join(dir, i + '.xml'); fs.writeFileSync(f, zip[n].data); return f; });
    const r = spawnSync('python3', ['-c', 'import sys, xml.dom.minidom\nfor f in sys.argv[1:]: xml.dom.minidom.parse(f)', ...paths], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('zip writer round-trips stored and deflated files with UTF-8 names and valid CRCs', () => {
  const big = 'Grüße, 東京! '.repeat(200);
  const input = [{ name: 'a.txt', data: 'x' }, { name: 'dir/größe-東京.txt', data: big }, { name: 'b.bin', data: Buffer.alloc(5000, 7) }];
  const zip = unzip(context.zipFiles(input));
  assert.deepEqual(Object.keys(zip), ['a.txt', 'dir/größe-東京.txt', 'b.bin']);
  assert.equal(zip['a.txt'].method, 0);
  assert.equal(zip['dir/größe-東京.txt'].method, 8);
  assert.equal(zip['b.bin'].method, 8);
  assert.equal(part(zip, 'dir/größe-東京.txt'), big);
  assert.ok(zip['b.bin'].data.equals(Buffer.alloc(5000, 7)));
  assert.equal(zip['a.txt'].crc, 0x8CDC1683);
});

const sample = [
  { type: 'h1', runs: [{ text: 'Annual <Report> & "Plans"' }] },
  { type: 'p', runs: [{ text: 'Plain ' }, { text: 'bold part', bold: true }, { text: ' Müller 東京\tTabbed\nNext line' }] },
  { type: 'li', runs: [{ text: '• item one' }] },
  { type: 'table', rows: [['Name', 'Qty'], ['Müller', '3'], ['a&b', '<4>']] },
  { type: 'pagebreak' },
  { type: 'h2', runs: [{ text: 'Second' }] },
  { type: 'p', runs: [{ text: 'bad\u0001char\uD800 ok' }] }
];

test('buildDocx writes headings, bold runs, tables, page breaks, escaped and non-ASCII text', () => {
  const zip = unzip(context.buildDocx(sample, { title: 'Doc <1>', pageSize: 'a4' }));
  for (const n of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/_rels/document.xml.rels', 'docProps/core.xml', 'docProps/app.xml']) assert.ok(zip[n], n);
  const doc = part(zip, 'word/document.xml');
  assert.match(doc, /<w:pStyle w:val="Heading1"\/>.*Annual &lt;Report&gt; &amp; &quot;Plans&quot;/);
  assert.match(doc, /<w:pStyle w:val="Heading2"\/>/);
  assert.match(doc, /<w:pStyle w:val="ListParagraph"\/>/);
  assert.match(doc, /<w:r><w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">bold part<\/w:t><\/w:r>/);
  assert.ok(doc.includes('Müller 東京') && doc.includes('<w:tab/>') && doc.includes('<w:br/>'));
  assert.equal((doc.match(/<w:tr>/g) || []).length, 3);
  assert.equal((doc.match(/<w:tc>/g) || []).length, 6);
  assert.ok(doc.includes('a&amp;b') && doc.includes('&lt;4&gt;'));
  assert.match(doc, /<w:tr><w:tc>.*?<w:b\/>.*?Name/);
  assert.equal((doc.match(/<w:br w:type="page"\/>/g) || []).length, 1);
  assert.ok(doc.includes('badchar ok'), 'control char and lone surrogate stripped');
  assert.ok(doc.includes('<w:pgSz w:w="11906" w:h="16838"/>'));
  assert.ok(part(zip, 'docProps/core.xml').includes('Doc &lt;1&gt;') && part(zip, 'docProps/core.xml').includes('<dc:creator>Pagewise</dc:creator>'));
  for (const s of ['Heading1', 'Heading2', 'Heading3', 'ListParagraph', 'TableGrid', 'Normal']) assert.ok(part(zip, 'word/styles.xml').includes('w:styleId="' + s + '"'), s);
  assert.ok(part(zip, 'docProps/app.xml').includes('xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"'));
  assertWellFormed(zip);
});

test('buildXlsx cells: numbers, text and formula-looking strings', () => {
  const zip = unzip(context.buildXlsx([{ page: 1, rows: [['Item', 'Amount'], ['$1,234.50', '007'], ['1,5', '=SUM(A1)'], ['2026-10-12', '-42'], ['12,34', '0.5']] }], { title: 'T' }));
  const sheet = part(zip, 'xl/worksheets/sheet1.xml');
  assert.ok(sheet.includes('<c r="A2"><v>1234.5</v></c>'));
  assert.ok(sheet.includes('<c r="B2" t="inlineStr"><is><t xml:space="preserve">007</t></is></c>'));
  assert.ok(sheet.includes('<c r="A3" t="inlineStr"><is><t xml:space="preserve">1,5</t></is></c>'));
  assert.ok(sheet.includes('<c r="B3" t="inlineStr"><is><t xml:space="preserve">=SUM(A1)</t></is></c>'));
  assert.ok(sheet.includes('<c r="A4" t="inlineStr"><is><t xml:space="preserve">2026-10-12</t></is></c>'));
  assert.ok(sheet.includes('<c r="B4"><v>-42</v></c>') && sheet.includes('<c r="B5"><v>0.5</v></c>'));
  assert.ok(sheet.includes('<c r="A5" t="inlineStr">'), '12,34 is not a thousands group');
  assert.ok(!sheet.includes('<f>'));
  assertWellFormed(zip);
});

test('buildXlsx freezes and bolds the first row, sizes columns, and names sheets safely', () => {
  const long = 'x'.repeat(100);
  const zip = unzip(context.buildXlsx([{ page: 2, rows: [['H1', 'H2'], [long, 'b']] }, { page: 2, rows: [['a']] }, { page: 2, rows: [['a']] }], { title: 'T' }));
  const sheet = part(zip, 'xl/worksheets/sheet1.xml');
  assert.ok(sheet.includes('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'));
  assert.ok(sheet.includes('<c r="A1" s="1" t="inlineStr">') && sheet.includes('<c r="B1" s="1" t="inlineStr">'));
  assert.ok(!sheet.includes('<c r="A2" s="1"'));
  assert.ok(sheet.includes('<col min="1" max="1" width="60" customWidth="1"/>'));
  assert.ok(part(zip, 'xl/styles.xml').includes('<cellXfs count="2">'));
  const wb = part(zip, 'xl/workbook.xml');
  assert.ok(wb.includes('xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'));
  assert.ok(wb.includes('name="Page 2"') && wb.includes('name="Page 2 (2)"') && wb.includes('name="Page 2 (3)"'));
  assert.ok(zip['xl/worksheets/sheet3.xml']);
  const names = plain(context.xlsxSheetNames([{ page: 1 }, { page: 1 }]));
  assert.deepEqual(names, ['Page 1', 'Page 1 (2)']);
  assertWellFormed(zip);
});

test('sheet names stay within Excel rules', () => {
  for (const nm of plain(context.xlsxSheetNames([{ page: 'x[]:*?/\\' }, { page: 7 }]))) assert.ok(nm.length <= 31 && !/[\[\]:*?\/\\]/.test(nm));
});

test('export-docx and export-xlsx validate their input before building', async () => {
  const dialog = { showSaveDialog: async () => ({ canceled: true }) };
  const { handlers } = loadMainHandlers({ electron: { dialog } });
  const docx = handlers.get('export-docx'), xlsx = handlers.get('export-xlsx');
  const bad = [[], null, [{ type: 'script', runs: [] }], [{ type: 'p', runs: [{ text: 5 }] }], [{ type: 'table', rows: [Array(51).fill('a')] }], [{ type: 'table', rows: Array(10001).fill(['a']) }], [{ type: 'p' }]];
  for (const blocks of bad) assert.equal((await docx({}, { blocks, baseName: 'x' })).success, false);
  assert.equal((await docx({}, { blocks: [{ type: 'p', runs: [{ text: 'ok' }] }], baseName: 'x' })).canceled, true);
  assert.equal((await xlsx({}, { tables: [], baseName: 'x' })).success, false);
  assert.equal((await xlsx({}, { tables: [{ page: 1, rows: [[1]] }], baseName: 'x' })).success, false);
  assert.equal((await xlsx({}, { tables: [{ page: 1, rows: [['a']] }], baseName: 'x' })).canceled, true);
});

test('blocksFromMarkdown handles headings, bold, lists, HTML tables and LaTeX', () => {
  const md = '# Title\n\nSome **bold** text\ncontinued.\n\n## Part\n### Sub\n\n- one\n* two\n1. three\n\n![img](x.png)\n\n<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>x &amp; y</td></tr></table>\n\nEnergy $E=mc^2$ here';
  const b = plain(context.blocksFromMarkdown(md));
  assert.deepEqual(b, [
    { type: 'h1', runs: [{ text: 'Title' }] },
    { type: 'p', runs: [{ text: 'Some ' }, { text: 'bold', bold: true }, { text: ' text\ncontinued.' }] },
    { type: 'h2', runs: [{ text: 'Part' }] },
    { type: 'h3', runs: [{ text: 'Sub' }] },
    { type: 'li', runs: [{ text: '• one' }] },
    { type: 'li', runs: [{ text: '• two' }] },
    { type: 'li', runs: [{ text: '1. three' }] },
    { type: 'table', rows: [['A', 'B'], ['1', 'x & y']] },
    { type: 'p', runs: [{ text: 'Energy $E=mc^2$ here' }] }
  ]);
});

const item = (str, x, y, size, extra = {}) => ({ str, transform: [size, 0, 0, size, x, y], width: str.length * size * 0.5, height: size, fontName: 'f1', ...extra });
const { functions: R } = loadRendererFunctions(['blocksFromTextItems', 'parsePageRange']);

test('blocksFromTextItems detects headings, joins lines, splits paragraphs and finds bullets', () => {
  const items = [
    item('Big Title', 72, 740, 24),
    item('Section', 72, 700, 16),
    item('Hello', 72, 670, 12), item('world', 72 + 30 + 4, 670, 12),
    item('same paragraph', 72, 656, 12),
    item('New paragraph far below', 72, 600, 12),
    item('• first bullet', 72, 580, 12),
    item('- second bullet', 72, 566, 12),
    item('Bold', 72, 540, 12, { fontName: 'f2' }), item('words', 72 + 4 * 6 + 20, 540, 12),
    item('after', 72 + 40 + 20 + 40, 540.5, 12)
  ];
  const b = plain(R.blocksFromTextItems(items, { f2: { name: 'ABCDEF+Arial-BoldMT' } }));
  assert.deepEqual(b.map(x => x.type), ['h1', 'h2', 'p', 'p', 'li', 'li', 'p']);
  assert.equal(b[0].runs[0].text, 'Big Title');
  assert.equal(b[2].runs.map(r => r.text).join(''), 'Hello world same paragraph');
  assert.equal(b[3].runs[0].text, 'New paragraph far below');
  assert.equal(b[4].runs[0].text, '• first bullet');
  assert.deepEqual(b[6].runs, [{ text: 'Bold ', bold: true }, { text: 'words after' }]);
});

test('blocksFromTextItems joins adjacent items without a gap and splits on font-size change', () => {
  const b = plain(R.blocksFromTextItems([item('Hel', 10, 100, 10), item('lo', 10 + 15, 100, 10), item('Small text', 10, 88, 10), item('Larger', 10, 74, 13)]));
  assert.equal(b[0].runs[0].text, 'Hello Small text');
  assert.equal(b[1].runs[0].text, 'Larger');
  assert.equal(b.length, 2);
  assert.deepEqual(plain(R.blocksFromTextItems([item('  ', 0, 0, 10)])), []);
});

test('parsePageRange accepts all, lists and ranges and rejects bad input', () => {
  assert.deepEqual(plain(R.parsePageRange('', 4)), [1, 2, 3, 4]);
  assert.deepEqual(plain(R.parsePageRange('All', 2)), [1, 2]);
  assert.deepEqual(plain(R.parsePageRange('1-3, 5,3', 6)), [1, 2, 3, 5]);
  for (const bad of ['0', '7', '3-2', 'a', '1-', '1,,2']) assert.equal(R.parsePageRange(bad, 6), null, bad);
});

test('File > Export has Word and Excel items wired through preload and renderer', () => {
  const main = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8'), preload = fs.readFileSync(path.join(root, 'src/preload.js'), 'utf8'), html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
  for (const [ev, fn, label] of [['menu-export-docx', 'onMenuExportDocx', 'Word Document (.docx)...'], ['menu-export-xlsx', 'onMenuExportXlsx', 'Excel Workbook (.xlsx)...']]) {
    assert.ok(main.includes(`label: '${label}'`) && main.includes(`send('${ev}')`));
    assert.match(preload, new RegExp(fn + ':'));
    assert.ok(html.includes(fn + '('));
  }
  assert.ok(html.includes("btn('Export Excel'"));
});

const soffice = spawnSync('soffice', ['--version'], { encoding: 'utf8' });
test('LibreOffice opens the generated .docx and .xlsx', { skip: soffice.error || soffice.status !== 0 ? 'soffice not available' : false }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-lo-'));
  try {
    fs.writeFileSync(path.join(dir, 'doc.docx'), context.buildDocx(sample, { title: 'T' }));
    fs.writeFileSync(path.join(dir, 'book.xlsx'), context.buildXlsx([{ page: 1, rows: [['Item', 'Amount'], ['Müller 東京', '$1,234.50'], ['=SUM(A1)', '007']] }], { title: 'T' }));
    const run = (file, fmt) => {
      const r = spawnSync('soffice', ['--headless', '-env:UserInstallation=file://' + path.join(dir, 'profile'), '--convert-to', fmt, '--outdir', path.join(dir, 'out'), path.join(dir, file)], { encoding: 'utf8', timeout: 120000 });
      assert.equal(r.status, 0, r.stderr + r.stdout);
    };
    run('doc.docx', 'txt:Text'); run('book.xlsx', 'csv');
    const txt = fs.readFileSync(path.join(dir, 'out/doc.txt'), 'utf8');
    for (const s of ['Annual <Report> & "Plans"', 'bold part', 'Müller 東京', 'item one', 'a&b', '<4>', 'Second', 'badchar ok']) assert.ok(txt.includes(s), s + ' in ' + JSON.stringify(txt));
    const csv = fs.readFileSync(path.join(dir, 'out/book.csv'), 'utf8');
    assert.ok(csv.includes('Item,Amount') && csv.includes('Müller 東京,1234.5') && csv.includes('=SUM(A1),007'), csv);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('blocksFromTextItems keeps space items between styled runs and treats short bold lines as headings', () => {
  const B = { fontName: 'f2' }, st = { f2: { name: 'Calibri-Bold' } };
  // Word export: "still" + separate " " item + bold run, all one size
  const items = [
    item('Animal Proteins', 72, 700, 12, B),
    item('Your body is still', 72, 675, 12), item(' ', 72 + 108, 675, 12, { width: 3, height: 0 }), item('growing', 72 + 111, 675, 12, B), item('.', 72 + 153, 675, 12),
    item('Examples:', 72, 650, 12, B)
  ];
  const b = plain(R.blocksFromTextItems(items, st));
  assert.deepEqual(b[0], { type: 'h2', runs: [{ text: 'Animal Proteins', bold: true }] });
  assert.equal(b[1].type, 'p');
  assert.equal(b[1].runs.map(r => r.text).join(''), 'Your body is still growing.');
  assert.equal(b[2].type, 'p', 'a bold line ending with ":" is a label, not a heading');
});

test('blocksFromTextItems measures body size by characters, so many small bullet glyphs do not make body text a heading', () => {
  const items = [];
  for (let k = 0; k < 8; k++) items.push(item('•', 90, 700 - k * 25, 10), item(' ', 95, 700 - k * 25, 10, { width: 13, height: 0 }), item('Bullet text number ' + k, 108, 700 - k * 25, 12));
  const b = plain(R.blocksFromTextItems(items, {}));
  assert.ok(b.every(x => x.type === 'li'), JSON.stringify(b.map(x => x.type)));
});

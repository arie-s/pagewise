const test = require('node:test');
const assert = require('node:assert/strict');
const { loadMainHandlers } = require('./helpers.cjs');

const { context } = loadMainHandlers();

test('toCsv quotes commas, quotes and newlines and ends rows with CRLF', () => {
  assert.equal(context.toCsv([['a', 'b,c'], ['say "hi"', 'two\nlines'], ['', null]]),
    'a,"b,c"\r\n"say ""hi""","two\nlines"\r\n,\r\n');
});

test('csvCell neutralizes formula-looking cells', () => {
  for (const s of ['=1+1', '=HYPERLINK("http://x","y")', '@SUM(A1)', '  =cmd', '\t=1', '\rx',
    '+HYPERLINK("x")', '-cmd|\' /C calc\'!A0', '+1+cmd', '-2,850.00 USD'])
    assert.ok(context.csvCell(s).replace(/^"/, '').startsWith("'"), `not guarded: ${JSON.stringify(s)}`);
});

test('csvCell leaves numbers, amounts, phone numbers and ordinary text unchanged', () => {
  for (const s of ['-$2,850.00', '+5%', '-12.5', '+1 (555) 123-4567', '€1.234,56', '(42.00)', '09-02', 'Total: $768.52', 'a=b', 'x@y.com'])
    assert.equal(context.csvCell(s), s.includes(',') ? `"${s}"` : s);
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fixture = n => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');
const plain = v => JSON.parse(JSON.stringify(v));
const tables = t => plain(context.tablesFromText(t));

test('invoice fixture parses to one 7x5 table with colspan footer', () => {
  const t = tables(fixture('dots-invoice.md'));
  assert.equal(t.length, 1);
  assert.equal(t[0].length, 7);
  assert.ok(t[0].every(r => r.length === 5));
  assert.deepEqual(t[0][0], ['#', 'Description', 'Qty', 'Unit price', 'Amount']);
  assert.deepEqual(t[0][1], ['1', 'A4 copy paper, 80 g (box)', '12', '$24.50', '$294.00']);
  assert.deepEqual(t[0][6], ['Total: $768.52', '', '', '', '']);
});

test('statement fixture parses to one table of 7 rows', () => {
  const t = tables(fixture('dots-statement.md'));
  assert.equal(t.length, 1);
  assert.equal(t[0].length, 7);
});

test('rowspan reserves columns in following rows', () => {
  const t = tables('<table><tr><td rowspan="2">A</td><td>B</td></tr><tr><td>C</td></tr><tr><td>D</td><td>E</td></tr></table>');
  assert.deepEqual(t[0], [['A', 'B'], ['', 'C'], ['D', 'E']]);
  const u = tables('<table><tr><td>x</td><td rowspan=2 colspan=2>y</td></tr><tr><td>z</td></tr></table>');
  assert.deepEqual(u[0], [['x', 'y', ''], ['z', '', '']]);
});

test('cell text: br, tags, entities, whitespace, th, case-insensitivity', () => {
  const t = tables('<TABLE><TR><TH>Name</TH><Th>a<BR/>b<br>c</Th></TR><tr><td> <b>x</b>\n  &amp; &lt;y&gt; &quot;q&quot; &#39;s&#39; &apos; &#65;&#x42;&nbsp;z </td><td>&amp;lt;</td></tr></TABLE>');
  assert.deepEqual(t[0], [['Name', 'a b c'], ['x & <y> "q" \'s\' \' AB z', '&lt;']]);
});

test('multiple tables, missing </table>, junk and no tables', () => {
  assert.equal(tables('<table><tr><td>1</td></tr></table> text <table><tr><td>2</td></tr></table>').length, 2);
  assert.deepEqual(tables('<table><tr><td>1</td></tr></table><table><tr><td>oops</td></tr>'), [[['1']]]);
  assert.deepEqual(tables('<table><tr><td>1<td>2<tr><td>3</table>'), [[['1', '2'], ['3', '']]]);
  assert.deepEqual(tables('just # markdown | a | b |'), []);
  assert.deepEqual(tables(''), []);
});

test('mergeTables folds a repeated header across pages', () => {
  const merged = plain(context.mergeTables([
    { page: 1, rows: tables(fixture('dots-statement.md'))[0] },
    { page: 2, rows: tables('<table><tr><td> DATE </td><td>description</td><td>Ref</td><td>Debit</td><td>Balance</td></tr><tr><td>1</td><td>2</td><td>3</td><td>4</td><td>5</td></tr><tr><td>6</td><td>7</td><td>8</td><td>9</td><td>10</td></tr></table>')[0] }
  ]));
  assert.equal(merged.length, 1);
  assert.equal(merged[0].page, 1);
  assert.equal(merged[0].rows.length, 9);
});

test('mergeTables keeps tables with different header or width apart', () => {
  const a = { page: 1, rows: [['A', 'B'], ['1', '2']] };
  assert.equal(context.mergeTables([a, { page: 2, rows: [['A', 'C'], ['3', '4']] }]).length, 2);
  assert.equal(context.mergeTables([a, { page: 2, rows: [['A', 'B', ''], ['3', '4', '']] }]).length, 2);
});

test('extract-tables merges across pages', async () => {
  const { handlers } = loadMainHandlers();
  const t = '<table><tr><td>H</td></tr><tr><td>1</td></tr></table>';
  const r = plain(await handlers.get('extract-tables')({}, [{ page: 1, text: t }, { page: 2, text: 'x ' + t }, { page: 3, text: 'none' }]));
  assert.deepEqual(r, [{ page: 1, rows: [['H'], ['1'], ['1']] }]);
});

function exportHarness() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-export-'));
  const dialog = { calls: [], answer: null,
    showSaveDialog: async (_w, o) => { dialog.calls.push(o); return dialog.answer ?? { canceled: false, filePath: path.join(tmp, o.defaultPath) }; },
    showOpenDialog: async (_w, o) => { dialog.calls.push(o); return dialog.answer ?? { canceled: false, filePaths: [path.join(tmp, 'out')] }; } };
  fs.mkdirSync(path.join(tmp, 'out'));
  const h = loadMainHandlers({ electron: { dialog, app: { whenReady: () => ({ then() {} }), on() {}, quit() {}, exit() {}, getPath: () => tmp } } });
  return { ...h, dialog, tmp };
}

test('export-tables writes one table as BOM + toCsv', async () => {
  const { handlers, context: c, dialog, tmp } = exportHarness();
  const rows = [['a', 'b,c'], ['€1', '=x']];
  const r = await handlers.get('export-tables')({}, { tables: [{ page: 1, rows }], baseName: 'scan' });
  assert.equal(r.success, true, r.error);
  assert.equal(dialog.calls[0].defaultPath, 'scan.csv');
  assert.equal(r.paths[0], path.join(tmp, 'scan.csv'));
  assert.equal(fs.readFileSync(r.paths[0], 'utf8'), '﻿' + c.toCsv(rows));
});

test('export-tables writes several tables into a folder with _p{page}_t{k} names', async () => {
  const { handlers, tmp } = exportHarness();
  const mk = v => [['h'], [v]];
  const r = await handlers.get('export-tables')({}, { tables: [{ page: 1, rows: mk('1') }, { page: 1, rows: mk('2') }, { page: 3, rows: mk('3') }], baseName: 'doc' });
  assert.equal(r.success, true);
  assert.deepEqual(plain(r.paths.map(p => path.basename(p))), ['doc_p1_t1.csv', 'doc_p1_t2.csv', 'doc_p3_t1.csv']);
  assert.equal(fs.readFileSync(path.join(tmp, 'out', 'doc_p1_t2.csv'), 'utf8'), '﻿h\r\n2\r\n');
});

test('export-tables reports cancel and cannot escape the chosen folder', async () => {
  const h = exportHarness();
  const exp = h.handlers.get('export-tables'), t = { page: 1, rows: [['h']] };
  h.dialog.answer = { canceled: true };
  assert.deepEqual(plain(await exp({}, { tables: [t], baseName: 'x' })), { success: false, canceled: true });
  assert.deepEqual(plain(await exp({}, { tables: [t, t], baseName: 'x' })), { success: false, canceled: true });
  h.dialog.answer = null;
  const r = await exp({}, { tables: [t, t], baseName: '../../evil/..\\x' });
  assert.equal(r.success, true);
  for (const p of r.paths) assert.equal(path.dirname(p), path.join(h.tmp, 'out'));
  const one = await exp({}, { tables: [t], baseName: '../../evil' });
  assert.equal(path.dirname(one.paths[0]), h.tmp);
  assert.equal((await exp({}, { tables: [t], baseName: '' })).paths[0], path.join(h.tmp, 'document.csv'));
  assert.equal((await exp({}, { tables: [], baseName: 'x' })).success, false);
});

test('save-markdown writes the text and honours cancel', async () => {
  const h = exportHarness();
  const r = await h.handlers.get('save-markdown')({}, { text: '# Hi\n€', baseName: 'scan' });
  assert.equal(h.dialog.calls[0].defaultPath, 'scan.md');
  assert.equal(fs.readFileSync(r.paths[0], 'utf8'), '# Hi\n€');
  h.dialog.answer = { canceled: true };
  assert.equal((await h.handlers.get('save-markdown')({}, { text: 'x', baseName: 'a' })).canceled, true);
});

test('copied tables are tab-separated with the formula guard and no tabs or newlines inside cells', () => {
  assert.equal(context.toTsv([[['a', 'b\tc'], ['d\ne', '=HYPERLINK("x")']], [['-$5.00', '+cmd']]]),
    'a\tb c\nd e\t\'=HYPERLINK("x")\n\n-$5.00\t\'+cmd');
});

test('export file names keep non-ASCII letters', async () => {
  const { handlers, tmp } = exportHarness();
  const r = await handlers.get('export-tables')({}, { tables: [{ page: 1, rows: [['h']] }], baseName: 'Rechnung_Müller 東京' });
  assert.equal(r.paths[0], path.join(tmp, 'Rechnung_Müller 東京.csv'));
});

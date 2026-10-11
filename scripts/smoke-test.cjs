// Smoke-tests a packaged Pagewise build through its CLI.
// Usage: node scripts/smoke-test.cjs <path-to-app-executable> [extra electron args...]
// Checks results by reading output files, because Windows GUI builds don't attach stdout.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PDFDocument } = require('@cantoo/pdf-lib');

const [exe, ...extra] = process.argv.slice(2);
if (!exe || !fs.existsSync(exe)) {
  console.error(`executable not found: ${exe}`);
  process.exit(2);
}

async function makePdf(file, pages) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]).drawText(`page ${i + 1}`, { x: 72, y: 700 });
  fs.writeFileSync(file, await doc.save());
}

function cli(...args) {
  execFileSync(exe, [...extra, 'cli', ...args], { stdio: 'inherit', timeout: 120000 });
}

async function pageCount(file, password) {
  if (!fs.existsSync(file)) throw new Error(`missing output: ${file}`);
  const doc = await PDFDocument.load(fs.readFileSync(file), password ? { password } : {});
  return doc.getPageCount();
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagewise-smoke-'));
  const a = path.join(dir, 'a.pdf'), b = path.join(dir, 'b.pdf');
  await makePdf(a, 2);
  await makePdf(b, 3);

  const merged = path.join(dir, 'merged.pdf');
  cli('merge', merged, a, b);
  if (await pageCount(merged) !== 5) throw new Error('merge: expected 5 pages');

  const enc = path.join(dir, 'enc.pdf'), dec = path.join(dir, 'dec.pdf');
  cli('encrypt', merged, '--password', 'smoke', '--out', enc);
  const encrypted = fs.readFileSync(enc).toString('latin1').includes('/Encrypt');
  if (!encrypted) throw new Error('encrypt: output has no /Encrypt dictionary');
  cli('decrypt', enc, '--password', 'smoke', '--out', dec);
  if (await pageCount(dec) !== 5) throw new Error('decrypt: expected 5 pages');

  console.log('smoke test passed');
})().catch(err => { console.error(err.message); process.exit(1); });

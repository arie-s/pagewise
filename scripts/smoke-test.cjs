// Smoke-tests a packaged Pagewise build through its CLI.
// Usage: node scripts/smoke-test.cjs <path-to-app-executable> [extra electron args...]
// Checks results by reading output files, because Windows GUI builds don't attach stdout.
// Then opens the app window on a PDF over the DevTools protocol and checks that the page
// renders and OCR works, which exercises the packaged renderer and OCR dependencies.
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PDFDocument } = require('@cantoo/pdf-lib');

const [exe, ...extra] = process.argv.slice(2);
// Fresh app-data folder so the test never reads or writes real settings (Linux and Windows;
// macOS CI runners start clean).
const configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pagewise-smoke-config-'));
const env = { ...process.env, XDG_CONFIG_HOME: configHome, APPDATA: configHome };
if (!exe || !fs.existsSync(exe)) {
  console.error(`executable not found: ${exe}`);
  process.exit(2);
}

async function makePdf(file, pages) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]).drawText(`page ${i + 1}`, { x: 72, y: 650, size: 72 });
  fs.writeFileSync(file, await doc.save());
}

function cli(...args) {
  execFileSync(exe, [...extra, 'cli', ...args], { stdio: 'inherit', timeout: 120000, env });
}

async function pageCount(file, password) {
  if (!fs.existsSync(file)) throw new Error(`missing output: ${file}`);
  const doc = await PDFDocument.load(fs.readFileSync(file), password ? { password } : {});
  return doc.getPageCount();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function guiCheck(pdf) {
  const port = 9333;
  const app = spawn(exe, [...extra, `--remote-debugging-port=${port}`, pdf], { stdio: 'ignore', env });
  try {
    let target;
    for (let i = 0; i < 60 && !target; i++) {
      await sleep(1000);
      try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page'); } catch {}
    }
    if (!target) throw new Error('gui: app window did not appear');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0; const pending = {};
    ws.onmessage = m => { const d = JSON.parse(m.data); if (pending[d.id]) { pending[d.id](d); delete pending[d.id]; } };
    const evaluate = expression => new Promise(res => {
      const i = ++id; pending[i] = d => res(d.result?.result?.value);
      ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });

    let inked = 0;
    for (let i = 0; i < 30 && inked < 50; i++) {
      await sleep(1000);
      inked = await evaluate(`(() => { const c = document.querySelector('#page-1 canvas.page-canvas'); if (!c || !c.width) return 0;
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0;
        for (let j = 0; j < d.length; j += 4) if (d[j] < 128) n++; return n; })()`) || 0;
    }
    if (inked < 50) throw new Error('gui: PDF page did not render');

    const words = await evaluate(`(async () => {
      const c = document.createElement('canvas'); c.width = 700; c.height = 160;
      const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 700, 160);
      x.fillStyle = '#000'; x.font = 'bold 64px sans-serif'; x.fillText('PAGEWISE SMOKE', 20, 105);
      const r = await window.pdfAPI.ocrPage({ pngBase64: c.toDataURL('image/png').split(',')[1], lang: 'eng' });
      return r.success ? r.words.map(w => w.text).join(' ') : 'ERROR ' + r.error; })()`);
    if (!/SMOKE/i.test(words || '')) throw new Error(`gui: OCR failed: ${words}`);
    console.log(`gui: page rendered (${inked} dark pixels), OCR read "${words}"`);
    ws.close();
  } finally {
    app.kill();
  }
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

  await guiCheck(merged);
  console.log('smoke test passed');
})().catch(err => { console.error(err.message); process.exit(1); });

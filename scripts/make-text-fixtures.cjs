// Generates the real-world text fixtures in tests/fixtures/text/ (run once, the PDFs are committed).
//   node scripts/make-text-fixtures.cjs
// libreoffice.pdf comes from LibreOffice (TrueType subsets with arbitrary codes + ToUnicode, ligatures);
// chromium.pdf comes from Electron's printToPDF (Type0 Identity-H subsets with ToUnicode).
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const out = path.join(__dirname, '..', 'tests', 'fixtures', 'text');

const LO_HTML = `<html><body style="font-family:'DejaVu Serif';font-size:12pt">
<p>The quick brown fox jumps over the lazy dog in 2025. Please find the office report.</p>
<p>Second line has a <b>bold word</b> and the invoice total is 1234 dollars, ref 5678.</p>
</body></html>`;

const CHROMIUM_HTML = `<html><body style="font-family:'DejaVu Sans';font-size:16px;margin:40px">
<h1>Quarterly invoice 2025</h1>
<p>Total due: 1234 dollars. Please pay the invoice by March 18.</p>
<p>Questions about this invoice go to billing. Thank you!</p>
</body></html>`;

async function chromium(file) {
  const { app, BrowserWindow } = require('electron');
  await app.whenReady();
  const win = new BrowserWindow({ show: false });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(CHROMIUM_HTML));
  fs.writeFileSync(file, await win.webContents.printToPDF({ pageSize: { width: 6, height: 4 } }));
  app.quit();
}

if (process.versions.electron) {
  chromium(process.argv[process.argv.length - 1]);
} else {
  fs.mkdirSync(out, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pagewise-fixtures-'));
  fs.writeFileSync(path.join(tmp, 'libreoffice.html'), LO_HTML);
  execFileSync('soffice', ['--headless', `-env:UserInstallation=file://${tmp}/profile`, '--convert-to', 'pdf:writer_web_pdf_Export', '--outdir', out, path.join(tmp, 'libreoffice.html')], { stdio: 'inherit' });
  // an isolated config folder, so the real app data is never touched
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(tmp, 'config'), APPDATA: path.join(tmp, 'config') };
  execFileSync(require('electron'), [__filename, path.join(out, 'chromium.pdf')], { stdio: 'inherit', env });
}

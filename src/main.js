const { app, BrowserWindow, ipcMain, dialog, Menu, shell, clipboard, net } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
// Reuse settings and downloaded models after the app rename, without moving user data.
const hasUserData = dir => ['settings.json', 'ocr-engine', 'tesseract-data']
  .some(name => fs.existsSync(path.join(dir, name)));
if (!hasUserData(app.getPath('userData'))) {
  const legacyData = ['Local PDF Desk', 'local-pdf-desk', 'PDF Studio Pro', 'pdf-studio-pro']
    .map(name => path.join(app.getPath('appData'), name))
    .find(hasUserData);
  if (legacyData) app.setPath('userData', legacyData);
}
// @cantoo/pdf-lib encryption needs Web Crypto; Electron <=28's bundled Node lacks the global
if (!globalThis.crypto) globalThis.crypto = require('crypto').webcrypto;
const { PDFDocument, rgb, degrees, StandardFonts, PDFName, PDFArray, PDFDict, PDFString, PDFNumber, grayscale, cmyk } = require('@cantoo/pdf-lib');

let mainWindow;
let currentFilePath = null;
let recentFiles = [];
let forceClose = false;
let unsavedFlag = false;

// ---------- persistent settings ----------
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
let settings = { recentFiles: [], lastFile: null, bounds: null, theme: '' };
function loadSettings() {
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) }; } catch (e) {}
  recentFiles = Array.isArray(settings.recentFiles) ? settings.recentFiles : [];
}
function saveSettings() {
  try { fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2)); } catch (e) {}
}
function rememberFile(filePath) {
  if (!recentFiles.includes(filePath)) {
    recentFiles.unshift(filePath);
    if (recentFiles.length > 10) recentFiles.pop();
    settings.recentFiles = recentFiles;
  }
  settings.lastFile = filePath;
  saveSettings();
}

let boundsTimer = null;
function persistBoundsSoon() {
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    if (mainWindow) { settings.bounds = mainWindow.getBounds(); saveSettings(); }
  }, 500);
}

// Single-letter tool shortcuts are handled by the renderer, which ignores keys typed into
// text fields. Menu accelerators would capture them first, so only display them (Windows/Linux);
// macOS can't display without registering, so it omits them.
const toolKey = key => process.platform === 'darwin' ? {} : { accelerator: key, registerAccelerator: false };

function createWindow() {
  forceClose = false; unsavedFlag = false;
  const b = settings.bounds || {};
  mainWindow = new BrowserWindow({
    width: b.width || 1600,
    height: b.height || 1000,
    x: b.x, y: b.y,
    minWidth: 1200,
    minHeight: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    titleBarStyle: 'default',
    show: false,
    icon: path.join(__dirname, 'icon.png')
  });

  // Create application menu
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'New Blank PDF',
          accelerator: 'CmdOrCtrl+N',
          click: () => mainWindow.webContents.send('menu-new')
        },
        {
          label: 'Open PDF',
          accelerator: 'CmdOrCtrl+O',
          click: () => mainWindow.webContents.send('menu-open')
        },
        {
          label: 'Open Recent',
          submenu: recentFiles.length > 0 ? recentFiles.map(f => ({
            label: path.basename(f),
            click: () => mainWindow.webContents.send('menu-open-recent', f)
          })) : [{ label: 'No recent files', enabled: false }]
        },
        { type: 'separator' },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () => mainWindow.webContents.send('menu-save')
        },
        {
          label: 'Save As',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => mainWindow.webContents.send('menu-save-as')
        },
        { type: 'separator' },
        {
          label: 'Merge PDFs...',
          click: () => mainWindow.webContents.send('menu-merge')
        },
        {
          label: 'Split PDF...',
          click: () => mainWindow.webContents.send('menu-split')
        },
        { type: 'separator' },
        {
          label: 'Export',
          submenu: [
            {
              label: 'Export as Images (PNG)',
              click: () => mainWindow.webContents.send('menu-export-images', 'png')
            },
            {
              label: 'Export as Images (JPEG)',
              click: () => mainWindow.webContents.send('menu-export-images', 'jpeg')
            },
            {
              label: 'Export Selected Pages...',
              click: () => mainWindow.webContents.send('menu-export-pages')
            }
          ]
        },
        { type: 'separator' },
        {
          label: 'Document Properties',
          accelerator: 'CmdOrCtrl+D',
          click: () => mainWindow.webContents.send('menu-properties')
        },
        {
          label: 'Print',
          accelerator: 'CmdOrCtrl+P',
          click: () => mainWindow.webContents.send('menu-print')
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        {
          label: 'Undo',
          accelerator: 'CmdOrCtrl+Z',
          click: () => mainWindow.webContents.send('menu-undo')
        },
        {
          label: 'Redo',
          accelerator: 'CmdOrCtrl+Y',
          click: () => mainWindow.webContents.send('menu-redo')
        },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'delete' },
        { type: 'separator' },
        {
          label: 'Find',
          accelerator: 'CmdOrCtrl+F',
          click: () => mainWindow.webContents.send('menu-find')
        },
        { type: 'separator' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+Plus',
          click: () => mainWindow.webContents.send('menu-zoom-in')
        },
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          click: () => mainWindow.webContents.send('menu-zoom-out')
        },
        {
          label: 'Actual Size',
          accelerator: 'CmdOrCtrl+0',
          click: () => mainWindow.webContents.send('menu-zoom-reset')
        },
        { type: 'separator' },
        {
          label: 'Light / Dark Theme',
          accelerator: 'CmdOrCtrl+Shift+T',
          click: () => mainWindow.webContents.send('menu-toggle-theme')
        },
        {
          label: 'Show Bookmarks Panel',
          accelerator: 'CmdOrCtrl+B',
          click: () => mainWindow.webContents.send('menu-toggle-bookmarks')
        },
        {
          label: 'Show Thumbnails',
          click: () => mainWindow.webContents.send('menu-toggle-thumbnails')
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' }
      ]
    },
    {
      label: 'Tools',
      submenu: [
        {
          label: 'Selection Tools',
          submenu: [
            {
              label: 'Select',
              ...toolKey('V'),
              click: () => mainWindow.webContents.send('menu-tool', 'select')
            },
            {
              label: 'Hand Tool',
              ...toolKey('H'),
              click: () => mainWindow.webContents.send('menu-tool', 'hand')
            }
          ]
        },
        {
          label: 'Annotation Tools',
          submenu: [
            {
              label: 'Add Text',
              ...toolKey('T'),
              click: () => mainWindow.webContents.send('menu-tool', 'text')
            },
            {
              label: 'Highlight',
              click: () => mainWindow.webContents.send('menu-tool', 'highlight')
            },
            {
              label: 'Underline',
              click: () => mainWindow.webContents.send('menu-tool', 'underline')
            },
            {
              label: 'Strikethrough',
              click: () => mainWindow.webContents.send('menu-tool', 'strikethrough')
            }
          ]
        },
        {
          label: 'Drawing Tools',
          submenu: [
            {
              label: 'Pen',
              ...toolKey('P'),
              click: () => mainWindow.webContents.send('menu-tool', 'draw')
            },
            {
              label: 'Eraser',
              ...toolKey('E'),
              click: () => mainWindow.webContents.send('menu-tool', 'eraser')
            }
          ]
        },
        {
          label: 'Shape Tools',
          submenu: [
            {
              label: 'Rectangle',
              ...toolKey('R'),
              click: () => mainWindow.webContents.send('menu-tool', 'rectangle')
            },
            {
              label: 'Circle',
              ...toolKey('C'),
              click: () => mainWindow.webContents.send('menu-tool', 'circle')
            },
            {
              label: 'Line',
              ...toolKey('L'),
              click: () => mainWindow.webContents.send('menu-tool', 'line')
            },
            {
              label: 'Arrow',
              ...toolKey('A'),
              click: () => mainWindow.webContents.send('menu-tool', 'arrow')
            }
          ]
        },
        { type: 'separator' },
        {
          label: 'Stamp',
          submenu: [
            {
              label: 'Approved',
              click: () => mainWindow.webContents.send('menu-stamp', 'approved')
            },
            {
              label: 'Rejected',
              click: () => mainWindow.webContents.send('menu-stamp', 'rejected')
            },
            {
              label: 'Draft',
              click: () => mainWindow.webContents.send('menu-stamp', 'draft')
            },
            {
              label: 'Confidential',
              click: () => mainWindow.webContents.send('menu-stamp', 'confidential')
            },
            {
              label: 'Final',
              click: () => mainWindow.webContents.send('menu-stamp', 'final')
            },
            {
              label: 'Custom Stamp...',
              click: () => mainWindow.webContents.send('menu-stamp', 'custom')
            }
          ]
        },
        {
          label: 'Add Image',
          accelerator: 'CmdOrCtrl+I',
          click: () => mainWindow.webContents.send('menu-add-image')
        },
        {
          label: 'Make Searchable — offline OCR (any computer)',
          click: () => mainWindow.webContents.send('menu-ocr')
        },
        {
          label: 'Smart Extract — AI reading (tables, handwriting)',
          click: () => mainWindow.webContents.send('menu-smart-extract')
        },
        {
          label: 'Setup AI Reading Engine...',
          click: () => mainWindow.webContents.send('menu-engine-setup')
        },
        { type: 'separator' },
        {
          label: 'Redact',
          submenu: [
            {
              label: 'Mark for Redaction',
              click: () => mainWindow.webContents.send('menu-tool', 'redact')
            },
            {
              label: 'Apply Redactions (Save)',
              accelerator: 'CmdOrCtrl+Shift+L',
              click: () => mainWindow.webContents.send('menu-save')
            }
          ]
        }
      ]
    },
    {
      label: 'Page',
      submenu: [
        {
          label: 'Rotate Clockwise',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => mainWindow.webContents.send('menu-rotate', 90)
        },
        {
          label: 'Rotate Counter-Clockwise',
          click: () => mainWindow.webContents.send('menu-rotate', -90)
        },
        {
          label: 'Rotate All Clockwise',
          click: () => mainWindow.webContents.send('menu-rotate-all', 90)
        },
        {
          label: 'Rotate All Counter-Clockwise',
          click: () => mainWindow.webContents.send('menu-rotate-all', -90)
        },
        { type: 'separator' },
        {
          label: 'Delete Page',
          click: () => mainWindow.webContents.send('menu-delete-page')
        },
        {
          label: 'Insert Blank Page',
          click: () => mainWindow.webContents.send('menu-insert-page')
        },
        {
          label: 'Insert Pages From File...',
          click: () => mainWindow.webContents.send('menu-insert-from-file')
        },
        {
          label: 'Extract Pages...',
          click: () => mainWindow.webContents.send('menu-extract-pages')
        },
        { type: 'separator' },
        {
          label: 'Add Watermark',
          click: () => mainWindow.webContents.send('menu-add-watermark')
        },
        {
          label: 'Add Header & Footer',
          click: () => mainWindow.webContents.send('menu-add-header-footer')
        },
        {
          label: 'Add Page Numbers',
          click: () => mainWindow.webContents.send('menu-add-page-numbers')
        },
        { type: 'separator' },
        {
          label: 'Go to Page...',
          accelerator: 'CmdOrCtrl+G',
          click: () => mainWindow.webContents.send('menu-goto-page')
        },
        {
          label: 'First Page',
          accelerator: 'Home',
          click: () => mainWindow.webContents.send('menu-goto', 'first')
        },
        {
          label: 'Last Page',
          accelerator: 'End',
          click: () => mainWindow.webContents.send('menu-goto', 'last')
        },
        {
          label: 'Previous Page',
          accelerator: 'PageUp',
          click: () => mainWindow.webContents.send('menu-goto', 'prev')
        },
        {
          label: 'Next Page',
          accelerator: 'PageDown',
          click: () => mainWindow.webContents.send('menu-goto', 'next')
        }
      ]
    },
    {
      label: 'Security',
      submenu: [
        {
          label: 'Set Password Protection...',
          click: () => mainWindow.webContents.send('menu-set-password')
        },
        {
          label: 'Remove Password',
          click: () => mainWindow.webContents.send('menu-remove-password')
        }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'User Guide',
          accelerator: 'F1',
          click: () => openGuide()
        },
        {
          label: 'Keyboard Shortcuts',
          accelerator: 'CmdOrCtrl+/',
          click: () => mainWindow.webContents.send('menu-shortcuts')
        },
        { type: 'separator' },
        {
          label: 'About Pagewise',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About Pagewise',
              message: `Pagewise v${app.getVersion()}`,
              detail: `Private PDF editing with local AI.

Features:
• View, create, and edit PDFs
• Annotations and markup tools
• Page management
• Merge, split, and extract
• Watermarks, headers, and page numbers
• AES-256 password protection
• Export to images
• CLI for batch automation

Everything stays on your machine.`
            });
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  mainWindow.on('close', async (e) => {
    if (forceClose || !unsavedFlag) return;
    e.preventDefault();
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Unsaved changes',
      message: 'You have unsaved changes.',
      detail: 'Do you want to save before closing?',
      buttons: ['Save', 'Discard Changes', 'Cancel'],
      defaultId: 0, cancelId: 2, noLink: true
    });
    if (response === 2) return;
    if (response === 1) { forceClose = true; mainWindow.close(); return; }
    mainWindow.webContents.send('menu-quit-save');
  });
  mainWindow.on('resize', persistBoundsSoon);
  mainWindow.on('move', persistBoundsSoon);

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// CLI mode (agent-ready headless operations)
// Usage: electron . cli <command> [args]
//   cli merge output.pdf input1.pdf input2.pdf ...
//   cli split input.pdf [--every N] [--ranges 1-3,5-7]
//   cli encrypt input.pdf --password <pw> [--owner <pw>]
//   cli decrypt input.pdf --password <pw>
//   cli info input.pdf

function getCliArgs() {
  const raw = process.argv;
  const i = raw.indexOf('cli');
  return i === -1 ? null : raw.slice(i + 1);
}

async function runCli(args) {
  const cmd = args[0];
  const flag = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
  const loadPdf = async (p) => PDFDocument.load(await fs.promises.readFile(p), { ignoreEncryption: true });

  try {
    if (cmd === 'merge') {
      const out = args[1];
      const inputs = args.slice(2).filter(a => !a.startsWith('-'));
      if (!out || inputs.length < 2) throw new Error('usage: cli merge output.pdf input1.pdf input2.pdf ...');
      const merged = await PDFDocument.create();
      for (const f of inputs) {
        const doc = await loadPdf(f);
        const pages = await merged.copyPages(doc, doc.getPageIndices());
        pages.forEach(p => merged.addPage(p));
      }
      await fs.promises.writeFile(out, await merged.save());
      console.log(`merged ${inputs.length} files -> ${out} (${merged.getPageCount()} pages)`);

    } else if (cmd === 'split') {
      const input = args[1];
      if (!input) throw new Error('usage: cli split input.pdf [--every N] [--ranges 1-3,5-7]');
      const doc = await loadPdf(input);
      const total = doc.getPageCount();
      const every = flag('--every');
      const rangesFlag = flag('--ranges');
      let ranges = [];
      if (every) {
        const n = parseInt(every, 10); if (!n || n < 1) throw new Error('--every must be a positive integer');
        for (let s = 1; s <= total; s += n) ranges.push({ start: s, end: Math.min(s + n - 1, total) });
      } else if (rangesFlag) {
        for (const part of rangesFlag.split(',')) {
          const m = part.split('-');
          ranges.push({ start: parseInt(m[0], 10), end: m[1] ? parseInt(m[1], 10) : parseInt(m[0], 10) });
        }
      } else {
        ranges = Array.from({ length: total }, (_, i) => ({ start: i + 1, end: i + 1 }));
      }
      const base = path.basename(input, '.pdf');
      const dir = path.dirname(input);
      for (const r of ranges) {
        const out = await PDFDocument.create();
        const idx = [];
        for (let i = r.start - 1; i <= Math.min(r.end, total) - 1; i++) if (i >= 0) idx.push(i);
        const pages = await out.copyPages(doc, idx);
        pages.forEach(p => out.addPage(p));
        const outFile = path.join(dir, `${base}_${r.start}-${r.end}.pdf`);
        await fs.promises.writeFile(outFile, await out.save());
        console.log(`wrote ${outFile}`);
      }

    } else if (cmd === 'encrypt') {
      const input = args[1];
      const password = flag('--password');
      if (!input || !password) throw new Error('usage: cli encrypt input.pdf --password <pw> [--owner <pw>]');
      const doc = await loadPdf(input);
      doc.encrypt({ userPassword: password, ownerPassword: flag('--owner') || password });
      const outFile = flag('--out') || input.replace(/\.pdf$/, '.encrypted.pdf');
      await fs.promises.writeFile(outFile, await doc.save());
      console.log(`encrypted -> ${outFile}`);

    } else if (cmd === 'decrypt') {
      const input = args[1];
      const password = flag('--password');
      if (!input || !password) throw new Error('usage: cli decrypt input.pdf --password <pw>');
      const src = await PDFDocument.load(await fs.promises.readFile(input), { password });
      // Copy pages into a fresh document so no encryption state is carried over
      const out = await PDFDocument.create();
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach(p => out.addPage(p));
      const outFile = flag('--out') || input.replace(/\.pdf$/, '.decrypted.pdf');
      await fs.promises.writeFile(outFile, await out.save());
      console.log(`decrypted -> ${outFile}`);

    } else if (cmd === 'engine-install') {
      const opts = {};
      if (flag('--repo')) opts.modelRepo = flag('--repo');
      const out = await installEngine(opts);
      if (!out.success) throw new Error(out.error);
    } else if (cmd === 'engine-start') {
      const out = await startEngine();
      if (!out.success) throw new Error(out.error);
      console.log('engine running at ' + out.endpoint);
    } else if (cmd === 'engine-stop') {
      stopEngine(); console.log('engine stopped');
    } else if (cmd === 'engine-remove') {
      const r = removeEngine(); if (!r.success) throw new Error(r.error);
      console.log(`engine removed (${Math.round(r.freedBytes / 1048576)} MB freed)`);
    } else if (cmd === 'engine-extract') {
      const img = args[1];
      if (!img) throw new Error('usage: cli engine-extract <image.png>');
      const png = fs.readFileSync(img).toString('base64');
      const promptIdx = args.indexOf('--prompt');
      const out = await smartExtract(png, promptIdx !== -1 ? args[promptIdx + 1] : undefined);
      console.log(out.content);
    } else if (cmd === 'info') {
      const input = args[1];
      if (!input) throw new Error('usage: cli info input.pdf');
      const doc = await loadPdf(input);
      console.log(JSON.stringify({ pages: doc.getPageCount(), title: doc.getTitle(), author: doc.getAuthor() }, null, 2));

    } else {
      throw new Error('unknown command. Available: merge, split, encrypt, decrypt, info, engine-install, engine-start, engine-stop, engine-remove, engine-extract');
    }
    app.exit(0);
  } catch (e) {
    console.error('Error:', e.message);
    app.exit(1);
  }
}

function openGuide() {
  const g = new BrowserWindow({ width: 920, height: 880, title: 'Pagewise — User Guide',
    webPreferences: { contextIsolation: true }, autoHideMenuBar: true });
  g.loadFile(path.join(__dirname, 'guide.html'));
  g.once('ready-to-show', () => g.show());
}

const cliArgs = getCliArgs();
app.whenReady().then(() => { loadSettings(); cliArgs ? runCli(cliArgs) : createWindow(); });

// Don't leave llama-server running (and holding engine files) after the app exits.
app.on('will-quit', () => { if (engineProc) stopEngine(); });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// IPC Handlers

// ---------- image import ----------
const IMAGE_EXT = /\.(png|jpe?g)$/i;
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
function jpegOrientation(buf) {
  try {
    let i = 2;
    while (i + 4 <= buf.length && buf[i] === 0xFF) {
      const m = buf[i + 1], len = buf.readUInt16BE(i + 2);
      if (m === 0xDA) return 1;
      if (m === 0xE1 && buf.toString('latin1', i + 4, i + 10) === 'Exif\0\0') {
        const t = i + 10, le = buf.toString('latin1', t, t + 2) === 'II';
        const r16 = o => le ? buf.readUInt16LE(o) : buf.readUInt16BE(o);
        const r32 = o => le ? buf.readUInt32LE(o) : buf.readUInt32BE(o);
        const ifd = t + r32(t + 4), n = r16(ifd);
        for (let k = 0; k < n; k++) if (r16(ifd + 2 + k * 12) === 0x0112) return r16(ifd + 2 + k * 12 + 8);
        return 1;
      }
      i += 2 + len;
    }
  } catch (e) {}
  return 1;
}
async function imagesToPdf(images) {
  const doc = await PDFDocument.create();
  for (const { name, buffer } of images) {
    const isPng = buffer.length > 4 && buffer.readUInt32BE(0) === 0x89504E47;
    const isJpg = buffer.length > 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;
    let img;
    try {
      if (isPng) img = await doc.embedPng(buffer);
      else if (isJpg) img = await doc.embedJpg(buffer);
    } catch (e) { img = null; }
    if (!img) throw new Error(`Unsupported image: ${name}`);
    const rot = isJpg ? { 3: 180, 6: 90, 8: 270 }[jpegOrientation(buffer)] || 0 : 0;
    const k = 792 / Math.max(img.width, img.height), w = img.width * k, h = img.height * k;
    const page = doc.addPage([w, h]);
    page.drawImage(img, { x: 0, y: 0, width: w, height: h });
    if (rot) page.setRotation(degrees(rot));
  }
  return Buffer.from(await doc.save());
}
const isImagePath = p => IMAGE_EXT.test(p);

async function readDocument(filePaths) {
  const images = filePaths.filter(isImagePath), pdfs = filePaths.filter(p => !isImagePath(p));
  if (filePaths.length === 0 || (images.length && pdfs.length) || pdfs.length > 1) {
    throw new Error('Open either one PDF or one or more images');
  }
  if (pdfs.length) {
    const buffer = await fs.promises.readFile(pdfs[0]);
    currentFilePath = pdfs[0];
    rememberFile(pdfs[0]);
    return { path: pdfs[0], name: path.basename(pdfs[0]), data: buffer.toString('base64') };
  }
  const sorted = images.map(p => ({ name: path.basename(p), p })).sort(byName);
  const pdf = await imagesToPdf(await Promise.all(sorted.map(async f => ({ name: f.name, buffer: await fs.promises.readFile(f.p) }))));
  currentFilePath = null;
  if (sorted.length === 1) rememberFile(sorted[0].p);
  return { path: null, name: sorted[0].name.replace(/\.[^.]*$/, '') + '.pdf', data: pdf.toString('base64') };
}

// Open file dialog
ipcMain.handle('open-file', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'PDF and Images', extensions: ['pdf', 'png', 'jpg', 'jpeg'] }, { name: 'PDF Files', extensions: ['pdf'] }, { name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }]
    });
    if (result.canceled) return null;
    return await readDocument(result.filePaths);
  } catch (error) {
    return { error: error.message };
  }
});

// Open specific file
ipcMain.handle('open-specific-file', async (event, filePath) => {
  try {
    return await readDocument([filePath]);
  } catch (error) {
    return { error: error.message };
  }
});

// Convert images (e.g. dropped files) to a PDF
ipcMain.handle('images-to-pdf', async (event, files) => {
  try {
    const sorted = [...files].sort(byName);
    const pdf = await imagesToPdf(sorted.map(f => ({ name: f.name, buffer: Buffer.from(f.data, 'base64') })));
    return { success: true, data: pdf.toString('base64'), name: sorted[0].name.replace(/\.[^.]*$/, '') + '.pdf' };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Open multiple files for merge
ipcMain.handle('open-multiple-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF and Images', extensions: ['pdf', 'png', 'jpg', 'jpeg'] }, { name: 'PDF Files', extensions: ['pdf'] }, { name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }]
  });

  if (result.canceled) return null;

  const files = [];
  for (const filePath of result.filePaths) {
    let buffer = await fs.promises.readFile(filePath);
    if (isImagePath(filePath)) {
      try { buffer = await imagesToPdf([{ name: path.basename(filePath), buffer }]); }
      catch (error) { return { error: error.message }; }
    }
    files.push({
      path: filePath,
      name: path.basename(filePath),
      data: buffer.toString('base64')
    });
  }

  return files;
});

// Save file
ipcMain.handle('save-file', async (event, { data, path: savePath }) => {
  try {
    const targetPath = savePath || currentFilePath;
    if (!targetPath) {
      return await saveFileAs(data);
    }

    const buffer = Buffer.from(data, 'base64');
    await fs.promises.writeFile(targetPath, buffer);
    currentFilePath = targetPath;

    return { success: true, path: targetPath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Save file as
ipcMain.handle('save-file-as', async (event, { data, defaultName }) => {
  return await saveFileAs(data, defaultName);
});

async function saveFileAs(data, defaultName = 'document.pdf') {
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: defaultName,
      filters: [{ name: 'PDF Files', extensions: ['pdf'] }]
    });

    if (result.canceled) return { success: false, canceled: true };

    const buffer = Buffer.from(data, 'base64');
    await fs.promises.writeFile(result.filePath, buffer);
    currentFilePath = result.filePath;

    return { success: true, path: result.filePath };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Set password protection (AES-256 via @cantoo/pdf-lib)
ipcMain.handle('encrypt-pdf', async (event, { data, userPassword, ownerPassword }) => {
  try {
    const buffer = Buffer.from(data, 'base64');
    const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    pdfDoc.encrypt({ userPassword, ownerPassword: ownerPassword || userPassword });
    const pdfBytes = await pdfDoc.save();
    return { success: true, data: Buffer.from(pdfBytes).toString('base64') };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Remove password protection (copy pages into a fresh doc — guaranteed clean)
ipcMain.handle('decrypt-pdf', async (event, { data, password }) => {
  try {
    const buffer = Buffer.from(data, 'base64');
    const src = await PDFDocument.load(buffer, { password });
    const out = await PDFDocument.create();
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach(p => out.addPage(p));
    const pdfBytes = await out.save();
    return { success: true, data: Buffer.from(pdfBytes).toString('base64') };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Reorder pages: newOrder = array of 0-based old indices in their new sequence
ipcMain.handle('reorder-pages', async (event, { data, newOrder }) => {
  try {
    const src = await PDFDocument.load(Buffer.from(data, 'base64'), { ignoreEncryption: true });
    const out = await PDFDocument.create();
    const pages = await out.copyPages(src, newOrder);
    pages.forEach(p => out.addPage(p));
    const pdfBytes = await out.save();
    return { success: true, data: Buffer.from(pdfBytes).toString('base64') };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ---------- OCR (tesseract.js, runs locally in main process) ----------
let _tesseract = null;
const ocrWorkers = new Map();
async function getOcrWorker(lang) {
  if (!_tesseract) _tesseract = require('tesseract.js');
  const key = lang || 'eng';
  if (!ocrWorkers.has(key)) {
    const w = await _tesseract.createWorker(key, 1, {
      cachePath: path.join(app.getPath('userData'), 'tesseract-data')
    });
    ocrWorkers.set(key, w);
  }
  return ocrWorkers.get(key);
}

ipcMain.handle('ocr-page', async (event, { pngBase64, lang }) => {
  try {
    const worker = await getOcrWorker(lang);
    const { data } = await worker.recognize(Buffer.from(pngBase64, 'base64'), {}, { blocks: true });
    const words = [];
    (data.blocks || []).forEach(b => b.paragraphs.forEach(pa => pa.lines.forEach(l => l.words.forEach(w => words.push({
      text: w.text, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1
    })))));
    return { success: true, words };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ---------- Advanced OCR engine (two-tier system, llama.cpp direct) ----------
// Tier 1 (base): always available, CPU-only (tesseract, everything else in the app).
// Tier 2 (advanced): OPTIONAL. On-demand install of llama-server + dots.ocr GGUF.
//   Runs entirely on the user's machine; GPU optional (CPU/Vulkan/iGPU fine, just slower).

const ENGINE_PORT = 8731;
let engineProc = null;

function enginePaths() {
  const d = path.join(app.getPath('userData'), 'ocr-engine');
  const isWin = process.platform === 'win32';
  return {
    dir: d,
    bin: path.join(d, isWin ? 'llama-server.exe' : 'llama-server'),
    model: path.join(d, 'dots-ocr-text-Q8_0.gguf'),
    mmproj: path.join(d, 'dots-ocr-mmproj.gguf'),
    pid: path.join(d, 'server.pid'),
    device: path.join(d, 'device.txt')
  };
}

function engineInstalled() {
  const ep = enginePaths();
  return fs.existsSync(ep.bin) && fs.existsSync(ep.model) && fs.existsSync(ep.mmproj);
}

// llama.cpp release asset for this OS. Linux/Windows have separate Vulkan (GPU) and CPU builds;
// macOS builds use Metal on Apple Silicon.
function engineAssetPattern(platform, arch, gpu) {
  if (platform === 'darwin') return new RegExp(`bin-macos-${arch === 'arm64' ? 'arm64' : 'x64'}\\.(zip|tar\\.gz)$`);
  if (platform === 'win32') return gpu ? /bin-win-vulkan-x64\.zip$/ : /bin-win-cpu-x64\.zip$/;
  return gpu ? /bin-ubuntu-vulkan-x64\.(zip|tar\.gz)$/ : /bin-ubuntu-x64\.(zip|tar\.gz)$/;
}

// Cheap pre-check before downloading the Vulkan build: a GPU render node and the Vulkan loader.
function linuxGpuLikely() {
  let node = false;
  try { node = fs.readdirSync('/dev/dri').some(f => f.startsWith('renderD')); } catch (e) {}
  return node && ['/usr/lib/x86_64-linux-gnu', '/lib/x86_64-linux-gnu', '/usr/lib64', '/usr/lib']
    .some(d => fs.existsSync(path.join(d, 'libvulkan.so.1')));
}

// Real GPUs llama.cpp can use, from `llama-server --list-devices`. Software renderers don't count.
function parseEngineDevices(text) {
  return text.split('\n').map(l => l.match(/^\s+\w+: (.+?) \(/)).filter(Boolean).map(m => m[1])
    .filter(name => !/llvmpipe|lavapipe|swiftshader/i.test(name));
}

// Resolves null if the binary can't run at all.
function engineDevices(bin) {
  return new Promise(resolve => execFile(bin, ['--list-devices'], { timeout: 30000 },
    (e, stdout, stderr) => resolve(e ? null : parseEngineDevices(stdout + '\n' + stderr))));
}

// Removes a previously unpacked llama.cpp build; downloaded models (.gguf) stay.
function clearEngineBinary(ep) {
  for (const f of fs.readdirSync(ep.dir)) {
    if (!f.endsWith('.gguf')) fs.rmSync(path.join(ep.dir, f), { recursive: true, force: true });
  }
}

async function downloadTo(url, dest, phase, lastPctRef) {
  return new Promise((resolve, reject) => {
    const req = net.request(url);
    let received = 0, total = 0;
    const file = fs.createWriteStream(dest);
    req.setHeader('User-Agent', 'pagewise');
    req.on('response', res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.end(); fs.unlink(dest, () => {});
        downloadTo(res.headers.location, dest, phase, lastPctRef).then(resolve, reject); return;
      }
      if (res.statusCode !== 200) { file.end(); fs.unlink(dest, () => {}); reject(new Error('HTTP ' + res.statusCode + ' for ' + url)); return; }
      total = parseInt(res.headers['content-length'] || '0', 10);
      res.on('data', c => {
        received += c.length; file.write(c);
        if (total) {
          const pct = Math.floor(received / total * 100);
          if (pct !== lastPctRef.pct) {
            lastPctRef.pct = pct;
            const msg = { phase, pct };
            if (mainWindow) mainWindow.webContents.send('engine-progress', msg); else console.log(`  ${phase}: ${pct}%`);
          }
        }
      });
      res.on('end', () => file.end());
      file.on('finish', () => resolve());
      res.on('error', e => { file.end(); reject(e); });
    });
    req.on('error', e => { file.end(); reject(e); });
    req.end();
  });
}

// Downloads and unpacks the llama.cpp release asset matching `pattern` into the engine dir.
async function downloadEngineBinary(ep, pattern, prog, ref) {
  prog('Fetching llama.cpp release info', 0);
  const apiRes = await new Promise((resolve, reject) => {
    const req = net.request({ method: 'GET', url: 'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=30' });
    req.setHeader('User-Agent', 'pagewise');
    req.on('response', resolve); req.on('error', reject); req.end();
  });
  let body = '';
  apiRes.setEncoding('utf8');
  for await (const chunk of apiRes) body += chunk;
  const releases = JSON.parse(body);
  let asset = null;
  for (const rel of releases) { asset = rel.assets.find(a => pattern.test(a.name)); if (asset) break; }
  if (!asset) throw new Error('No llama.cpp release asset matching ' + pattern);
  prog('Downloading llama-server', 1);
  const archive = path.join(ep.dir, asset.name);
  await downloadTo(asset.browser_download_url, archive, 'Downloading llama-server', ref);
  prog('Extracting', 50);
  if (process.platform === 'win32') {
    await new Promise((res, rej) => execFile('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${ep.dir}' -Force`], e => e ? rej(e) : res()));
  } else if (archive.endsWith('.zip')) {
    try { await new Promise((res, rej) => execFile('unzip', ['-o', archive, '-d', ep.dir], e => e ? rej(e) : res())); }
    catch (e) { await new Promise((res, rej) => execFile('python3', ['-c', `import zipfile,sys;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])`, archive, ep.dir], e => e ? rej(e) : res())); }
  } else {
    await new Promise((res, rej) => execFile('tar', ['xzf', archive, '-C', ep.dir], e => e ? rej(e) : res()));
  }
  // binary may be nested in the archive's top-level dir
  if (!fs.existsSync(ep.bin)) {
    const found = (function find(start) {
      for (const f of fs.readdirSync(start, { withFileTypes: true })) {
        const full = path.join(start, f.name);
        if (f.isDirectory()) { const r = find(full); if (r) return r; }
        if (f.name === (process.platform === 'win32' ? 'llama-server.exe' : 'llama-server')) return full;
      }
      return null;
    })(ep.dir);
    if (!found) throw new Error('llama-server not found in archive');
    const libDir = path.dirname(found);
    for (const f of fs.readdirSync(libDir, { withFileTypes: true })) {
      if ((f.isFile() || f.isSymbolicLink()) && (f.name.startsWith('lib') || f.name.startsWith('ggml') || f.name === (process.platform === 'win32' ? 'llama-server.exe' : 'llama-server') || f.name.endsWith('.dll') || f.name.endsWith('.so') || /\.so\.\d/.test(f.name))) {
        // Keep versioned .so symlinks (libfoo.so.0 -> libfoo.so.0.6.0) as links; the binary loads them by link name.
        if (f.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(path.join(libDir, f.name)), path.join(ep.dir, f.name));
        else fs.copyFileSync(path.join(libDir, f.name), path.join(ep.dir, f.name));
      }
    }
    if (process.platform !== 'win32') {
      fs.chmodSync(ep.bin, 0o755);
      for (const f of fs.readdirSync(ep.dir)) if (f.endsWith('.so') || /\.so\.\d/.test(f)) try { fs.chmodSync(path.join(ep.dir, f), 0o755); } catch (e) {}
    }
  }
}

async function installEngine(opts = {}) {
  const ep = enginePaths();
  if (!fs.existsSync(ep.dir)) fs.mkdirSync(ep.dir, { recursive: true });
  const ref = { pct: -1 };
  const prog = (phase, pct) => { const m = { phase, pct }; if (mainWindow) mainWindow.webContents.send('engine-progress', m); else console.log(`  ${phase}: ${pct}%`); };

  // 1. llama-server binary (llama.cpp release). Try the GPU build where one may work;
  // fall back to the CPU build if llama.cpp can't see a real GPU with it.
  if (!fs.existsSync(ep.bin) || opts.forceBinary) {
    clearEngineBinary(ep);
    const tryGpu = process.platform === 'win32' || (process.platform === 'linux' && linuxGpuLikely());
    await downloadEngineBinary(ep, engineAssetPattern(process.platform, process.arch, tryGpu), prog, ref);
    if (tryGpu && !(await engineDevices(ep.bin) || []).length) {
      prog('No usable GPU found, switching to CPU build', 50);
      clearEngineBinary(ep);
      await downloadEngineBinary(ep, engineAssetPattern(process.platform, process.arch, false), prog, ref);
    }
    const devices = await engineDevices(ep.bin);
    if (!devices) throw new Error('llama-server failed to run after install');
    fs.writeFileSync(ep.device, devices.length ? 'GPU (' + [...new Set(devices)].join(', ') + ')' : 'CPU');
  }

  // 2. model + mmproj from Hugging Face
  const repo = opts.modelRepo || 'ggml-org/dots.ocr-GGUF';
  prog('Fetching model listing', 0);
  const treeRes = await new Promise((resolve, reject) => {
    const req = net.request({ method: 'GET', url: `https://huggingface.co/api/models/${repo}/tree/main` });
    req.setHeader('User-Agent', 'pagewise');
    req.on('response', resolve); req.on('error', reject); req.end();
  });
  let tbody = '';
  treeRes.setEncoding('utf8');
  for await (const chunk of treeRes) tbody += chunk;
  const files = JSON.parse(tbody).map(f => f.path).filter(p => p.endsWith('.gguf'));
  const mmproj = files.find(f => /mmproj/i.test(f) && /F16|f16|BF16|bf16/i.test(f)) || files.find(f => /mmproj/i.test(f));
  const text = files.filter(f => !/mmproj/i.test(f)).sort((a, b) => (b.includes('Q8_0') ? 1 : 0) - (a.includes('Q8_0') ? 1 : 0))[0] || files.filter(f => !/mmproj/i.test(f))[0];
  if (!mmproj || !text) throw new Error('Could not find model files in ' + repo);
  await downloadTo(`https://huggingface.co/${repo}/resolve/main/${mmproj}`, ep.mmproj, 'Downloading vision encoder', ref);
  await downloadTo(`https://huggingface.co/${repo}/resolve/main/${text}`, ep.model, 'Downloading OCR model', ref);
  prog('Done', 100);
  return { success: true };
}

async function startEngine() {
  if (engineProc) return { success: true, running: true, endpoint: `http://127.0.0.1:${ENGINE_PORT}` };
  const ep = enginePaths();
  if (!engineInstalled()) return { success: false, error: 'Engine not installed' };
  engineProc = require('child_process').spawn(ep.bin, [
    '-m', ep.model, '--mmproj', ep.mmproj,
    '--host', '127.0.0.1', '--port', String(ENGINE_PORT),
    '--no-webui', '-ngl', '999',
    // One request at a time; 16k fits a page image (≤ ~5k tokens at the renderer's 4 MP cap) plus 4096 output tokens.
    // Without this llama-server reserves a 131k-token context (~12 GB RAM on CPU).
    '-c', '16384', '-np', '1'
  ], { stdio: 'ignore' });
  fs.writeFileSync(ep.pid, String(engineProc.pid));
  // wait for health
  for (let i = 0; i < 90; i++) {
    if (engineProc.exitCode !== null) { engineProc = null; return { success: false, error: 'llama-server exited immediately' }; }
    try {
      const ok = await new Promise((resolve) => {
        const req = net.request(`http://127.0.0.1:${ENGINE_PORT}/health`);
        req.on('response', r => { r.resume(); resolve(r.statusCode === 200); });
        req.on('error', () => resolve(false));
        req.end();
      });
      if (ok) return { success: true, running: true, endpoint: `http://127.0.0.1:${ENGINE_PORT}` };
    } catch (e) {}
    await new Promise(r => setTimeout(r, 1000));
  }
  return { success: false, error: 'Server did not become healthy in 90s' };
}

function stopEngine() {
  try {
    const ep = enginePaths();
    if (engineProc) { engineProc.kill(); engineProc = null; }
    else if (fs.existsSync(ep.pid)) { try { process.kill(parseInt(fs.readFileSync(ep.pid, 'utf8').trim(), 10)); } catch (e) {} }
    if (fs.existsSync(ep.pid)) fs.unlinkSync(ep.pid);
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(p) : fs.lstatSync(p).size;
  }
  return total;
}

// Deletes llama.cpp and the model; settings and OCR language data stay.
function removeEngine() {
  try {
    stopEngine();
    const dir = enginePaths().dir;
    if (!fs.existsSync(dir)) return { success: true, freedBytes: 0 };
    const freedBytes = dirSize(dir);
    // Retries cover a just-killed llama-server still holding files on Windows.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    return { success: true, freedBytes };
  } catch (e) { return { success: false, error: e.message }; }
}

async function smartExtract(pngBase64, prompt) {
  const r = engineProc ? {} : await startEngine();
  if (r.success === false) throw new Error(r.error);
  const body = JSON.stringify({
    messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: 'data:image/png;base64,' + pngBase64 } },
      { type: 'text', text: prompt || 'Convert the document to markdown.' }
    ]}],
    max_tokens: 4096, temperature: 0
  });
  return new Promise((resolve, reject) => {
    const req = net.request({ method: 'POST', url: `http://127.0.0.1:${ENGINE_PORT}/v1/chat/completions` });
    req.setHeader('Content-Type', 'application/json');
    req.on('response', res => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', c => out += c);
      res.on('end', () => {
        try { const j = JSON.parse(out); resolve({ success: true, content: (j.choices?.[0]?.message?.content || '').trim() }); }
        catch (e) { reject(new Error('Bad engine response: ' + out.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

ipcMain.handle('engine-status', () => ({ installed: engineInstalled(), hasFiles: fs.existsSync(enginePaths().dir), running: !!engineProc, device: fs.existsSync(enginePaths().device) ? fs.readFileSync(enginePaths().device, 'utf8') : null, endpoint: `http://127.0.0.1:${ENGINE_PORT}` }));
ipcMain.handle('engine-install', async (event, opts) => { try { return await installEngine(opts || {}); } catch (e) { return { success: false, error: e.message }; } });
ipcMain.handle('engine-start', async () => { try { return await startEngine(); } catch (e) { return { success: false, error: e.message }; } });
ipcMain.handle('engine-stop', () => stopEngine());
ipcMain.handle('engine-remove', () => removeEngine());
ipcMain.handle('smart-extract', async (event, { pngBase64, prompt }) => { try { return await smartExtract(pngBase64, prompt); } catch (e) { return { success: false, error: e.message }; } });

// CLI: cli engine-install | cli engine-start | cli engine-stop | cli engine-remove | cli engine-extract <image.png>

// Unsaved-changes flag synced from renderer
ipcMain.on('set-unsaved', (event, flag) => { unsavedFlag = !!flag; });

// Force close after renderer finished saving
ipcMain.handle('force-close', () => { forceClose = true; if (mainWindow) mainWindow.close(); return true; });

// Theme persistence
ipcMain.handle('get-theme', () => settings.theme || '');
ipcMain.handle('save-theme', (event, theme) => { settings.theme = theme; saveSettings(); return true; });

// Get PDF.js worker path
ipcMain.handle('get-pdfjs-worker-path', () => {
  return path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.mjs');
});

// Initial file passed on command line (open-with / drag-drop support)
let initialPdfPath = null;
(function findInitialPdf() {
  const raw = process.argv;
  for (let i = 1; i < raw.length; i++) {
    if (/\.(pdf|png|jpe?g)$/i.test(raw[i])) { initialPdfPath = raw[i]; break; }
  }
})();

ipcMain.handle('get-initial-file', () => initialPdfPath || settings.lastFile || null);

// Apply annotations and modifications to PDF
ipcMain.handle('apply-modifications', async (event, { originalData, modifications }) => {
  try {
    if (modifications.some(m => m.type === 'redaction')) {
      throw new Error('Redactions must be flattened before saving; an overlay does not remove content.');
    }
    const buffer = Buffer.from(originalData, 'base64');
    const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const helveticaFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const helveticaOblique = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);
    const timesBold = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);

    const pages = pdfDoc.getPages();

    for (const mod of modifications) {
      if (mod.type === 'deletePage' || mod.type === 'insertPage') continue;
      if (mod.pageIndex >= pages.length) continue;

      const page = pages[mod.pageIndex];
      const { width, height } = page.getSize();

      switch (mod.type) {
        case 'text':
          const textFont = mod.bold ? helveticaBold : (mod.italic ? helveticaOblique : helveticaFont);
          page.drawText(mod.text, {
            x: mod.x * width,
            y: height - (mod.y * height),
            size: mod.fontSize || 12,
            font: textFont,
            color: rgb(mod.color?.r || 0, mod.color?.g || 0, mod.color?.b || 0),
            opacity: mod.opacity ?? 1
          });
          break;

        case 'highlight':
          page.drawRectangle({
            x: mod.x * width,
            y: height - (mod.y * height) - (mod.height * height),
            width: mod.width * width,
            height: mod.height * height,
            color: rgb(mod.color?.r || 1, mod.color?.g || 1, mod.color?.b || 0),
            opacity: 0.3
          });
          break;

        case 'underline':
          page.drawLine({
            start: { x: mod.x * width, y: height - (mod.y * height) },
            end: { x: (mod.x + mod.width) * width, y: height - (mod.y * height) },
            thickness: mod.strokeWidth || 1,
            color: rgb(mod.color?.r || 0, mod.color?.g || 0, mod.color?.b || 1)
          });
          break;

        case 'strikethrough':
          page.drawLine({
            start: { x: mod.x * width, y: height - (mod.y * height) + (mod.height * height / 2) },
            end: { x: (mod.x + mod.width) * width, y: height - (mod.y * height) + (mod.height * height / 2) },
            thickness: mod.strokeWidth || 1,
            color: rgb(mod.color?.r || 1, mod.color?.g || 0, mod.color?.b || 0)
          });
          break;

        case 'cover':
          // White rectangle to cover original text for text editing
          page.drawRectangle({
            x: mod.x * width,
            y: height - (mod.y * height) - (mod.height * height),
            width: mod.width * width,
            height: mod.height * height,
            color: rgb(mod.color?.r || 1, mod.color?.g || 1, mod.color?.b || 1),
            opacity: 1
          });
          break;

        case 'rectangle':
          page.drawRectangle({
            x: mod.x * width,
            y: height - (mod.y * height) - (mod.height * height),
            width: mod.width * width,
            height: mod.height * height,
            borderColor: rgb(mod.color?.r || 0, mod.color?.g || 0, mod.color?.b || 0),
            borderWidth: mod.strokeWidth || 2,
            color: mod.fillColor ? rgb(mod.fillColor.r, mod.fillColor.g, mod.fillColor.b) : undefined,
            opacity: mod.fillOpacity || 0
          });
          break;

        case 'circle':
          const centerX = (mod.x + mod.width / 2) * width;
          const centerY = height - (mod.y + mod.height / 2) * height;
          const radiusX = (mod.width / 2) * width;
          const radiusY = (mod.height / 2) * height;
          page.drawEllipse({
            x: centerX,
            y: centerY,
            xScale: radiusX,
            yScale: radiusY,
            borderColor: rgb(mod.color?.r || 0, mod.color?.g || 0, mod.color?.b || 0),
            borderWidth: mod.strokeWidth || 2,
            color: mod.fillColor ? rgb(mod.fillColor.r, mod.fillColor.g, mod.fillColor.b) : undefined,
            opacity: mod.fillOpacity || 0
          });
          break;

        case 'line':
          page.drawLine({
            start: { x: mod.x1 * width, y: height - (mod.y1 * height) },
            end: { x: mod.x2 * width, y: height - (mod.y2 * height) },
            thickness: mod.strokeWidth || 2,
            color: rgb(mod.color?.r || 0, mod.color?.g || 0, mod.color?.b || 0),
            dashArray: mod.dashed ? [5, 5] : undefined
          });
          break;

        case 'arrow':
          // Draw line
          const ax1 = mod.x1 * width;
          const ay1 = height - (mod.y1 * height);
          const ax2 = mod.x2 * width;
          const ay2 = height - (mod.y2 * height);

          page.drawLine({
            start: { x: ax1, y: ay1 },
            end: { x: ax2, y: ay2 },
            thickness: mod.strokeWidth || 2,
            color: rgb(mod.color?.r || 0, mod.color?.g || 0, mod.color?.b || 0)
          });

          // Draw arrowhead
          const angle = Math.atan2(ay2 - ay1, ax2 - ax1);
          const arrowSize = 10 * (mod.strokeWidth || 2) / 2;
          const arrowAngle = Math.PI / 6;

          page.drawLine({
            start: { x: ax2, y: ay2 },
            end: {
              x: ax2 - arrowSize * Math.cos(angle - arrowAngle),
              y: ay2 - arrowSize * Math.sin(angle - arrowAngle)
            },
            thickness: mod.strokeWidth || 2,
            color: rgb(mod.color?.r || 0, mod.color?.g || 0, mod.color?.b || 0)
          });
          page.drawLine({
            start: { x: ax2, y: ay2 },
            end: {
              x: ax2 - arrowSize * Math.cos(angle + arrowAngle),
              y: ay2 - arrowSize * Math.sin(angle + arrowAngle)
            },
            thickness: mod.strokeWidth || 2,
            color: rgb(mod.color?.r || 0, mod.color?.g || 0, mod.color?.b || 0)
          });
          break;

        case 'path':
          // Draw freehand path as series of lines
          if (mod.points && mod.points.length > 1) {
            for (let i = 1; i < mod.points.length; i++) {
              page.drawLine({
                start: {
                  x: mod.points[i-1].x * width,
                  y: height - (mod.points[i-1].y * height)
                },
                end: {
                  x: mod.points[i].x * width,
                  y: height - (mod.points[i].y * height)
                },
                thickness: mod.strokeWidth || 2,
                color: rgb(mod.color?.r || 0, mod.color?.g || 0, mod.color?.b || 0),
                opacity: mod.opacity || 1
              });
            }
          }
          break;

        case 'stamp':
          const stampFont = timesBold;
          const stampText = mod.text || 'STAMP';
          const stampSize = mod.fontSize || 24;
          const stampColor = mod.color || { r: 1, g: 0, b: 0 };

          page.drawText(stampText, {
            x: mod.x * width,
            y: height - (mod.y * height),
            size: stampSize,
            font: stampFont,
            color: rgb(stampColor.r, stampColor.g, stampColor.b),
            rotate: degrees(mod.rotation || -15),
            opacity: mod.opacity || 0.5
          });
          break;

        case 'stickyNote':
          // Draw sticky note icon
          const noteSize = 20;
          const noteX = mod.x * width;
          const noteY = height - (mod.y * height) - noteSize;

          page.drawRectangle({
            x: noteX,
            y: noteY,
            width: noteSize,
            height: noteSize,
            color: rgb(1, 0.9, 0.5),
            borderColor: rgb(0.8, 0.7, 0.2),
            borderWidth: 1
          });
          break;

        case 'watermark':
          const wmFont = helveticaBold;
          const wmText = mod.text || 'WATERMARK';
          const wmSize = mod.fontSize || 48;

          page.drawText(wmText, {
            x: width / 2 - (wmText.length * wmSize * 0.3),
            y: height / 2,
            size: wmSize,
            font: wmFont,
            color: rgb(mod.color?.r || 0.8, mod.color?.g || 0.8, mod.color?.b || 0.8),
            rotate: degrees(mod.rotation || -45),
            opacity: mod.opacity || 0.3
          });
          break;

        case 'image':
          if (mod.imageData) {
            let image;
            if (mod.imageType === 'png') {
              image = await pdfDoc.embedPng(Buffer.from(mod.imageData, 'base64'));
            } else {
              image = await pdfDoc.embedJpg(Buffer.from(mod.imageData, 'base64'));
            }

            page.drawImage(image, {
              x: mod.x * width,
              y: height - (mod.y * height) - (mod.height * height),
              width: mod.width * width,
              height: mod.height * height,
              opacity: mod.opacity || 1,
              rotate: degrees(mod.rotation || 0)
            });
          }
          break;

        case 'signature':
          if (mod.imageData) {
            // Handle base64 data URL
            let imageData = mod.imageData;
            if (imageData.startsWith('data:')) {
              imageData = imageData.split(',')[1];
            }
            const sigImage = await pdfDoc.embedPng(Buffer.from(imageData, 'base64'));
            page.drawImage(sigImage, {
              x: mod.x * width,
              y: height - (mod.y * height) - (mod.height * height),
              width: mod.width * width,
              height: mod.height * height,
              opacity: 1
            });
          }
          break;

        case 'rotate':
          const currentRotation = page.getRotation().angle;
          page.setRotation(degrees(currentRotation + mod.angle));
          break;

        case 'pageNumber':
          page.drawText(mod.text, {
            x: mod.x * width,
            y: mod.position === 'bottom' ? 20 : height - 20,
            size: mod.fontSize || 10,
            font: helveticaFont,
            color: rgb(0, 0, 0)
          });
          break;

        case 'headerFooter':
          const hfFont = helveticaFont;
          if (mod.header) {
            page.drawText(mod.header, {
              x: width / 2 - (mod.header.length * 5),
              y: height - 30,
              size: mod.fontSize || 10,
              font: hfFont,
              color: rgb(0, 0, 0)
            });
          }
          if (mod.footer) {
            page.drawText(mod.footer, {
              x: width / 2 - (mod.footer.length * 5),
              y: 20,
              size: mod.fontSize || 10,
              font: hfFont,
              color: rgb(0, 0, 0)
            });
          }
          break;
      }
    }

    // Handle page deletions (process in reverse order to maintain indices)
    const pagesToDelete = modifications
      .filter(m => m.type === 'deletePage')
      .map(m => m.pageIndex)
      .sort((a, b) => b - a);

    for (const pageIndex of pagesToDelete) {
      if (pageIndex < pdfDoc.getPageCount()) {
        pdfDoc.removePage(pageIndex);
      }
    }

    // Handle page insertions
    const pagesToInsert = modifications.filter(m => m.type === 'insertPage');
    for (const insert of pagesToInsert) {
      const pageWidth = insert.width || 612;
      const pageHeight = insert.height || 792;
      pdfDoc.insertPage(insert.pageIndex, [pageWidth, pageHeight]);
    }

    const modifiedBytes = await pdfDoc.save();
    return {
      success: true,
      data: Buffer.from(modifiedBytes).toString('base64')
    };
  } catch (error) {
    console.error('Modification error:', error);
    return { success: false, error: error.message };
  }
});

// Redaction output contains only the rendered, masked pixels. Never copy source
// objects: old content streams, attachments and metadata can retain secrets.
ipcMain.handle('redact-pdf', async (event, { pages }) => {
  try {
    if (!Array.isArray(pages) || !pages.length) throw new Error('No redacted pages supplied');
    const out = await PDFDocument.create();
    for (const page of pages) {
      if (!Number.isFinite(page.width) || !Number.isFinite(page.height) || page.width <= 0 || page.height <= 0) {
        throw new Error('Invalid redacted page dimensions');
      }
      const image = await out.embedPng(Buffer.from(page.imageData, 'base64'));
      out.addPage([page.width, page.height]).drawImage(image, { x: 0, y: 0, width: page.width, height: page.height });
    }
    return { success: true, data: Buffer.from(await out.save()).toString('base64') };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Merge PDFs
ipcMain.handle('merge-pdfs', async (event, { files }) => {
  try {
    const mergedPdf = await PDFDocument.create();

    for (const fileData of files) {
      const buffer = Buffer.from(fileData.data, 'base64');
      const pdf = await PDFDocument.load(buffer, { ignoreEncryption: true });
      const pages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
      pages.forEach(page => mergedPdf.addPage(page));
    }

    const mergedBytes = await mergedPdf.save();
    return {
      success: true,
      data: Buffer.from(mergedBytes).toString('base64')
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Split PDF
ipcMain.handle('split-pdf', async (event, { data, ranges }) => {
  try {
    const buffer = Buffer.from(data, 'base64');
    const originalPdf = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const results = [];

    for (const range of ranges) {
      const newPdf = await PDFDocument.create();
      const pageIndices = [];

      for (let i = range.start - 1; i < range.end; i++) {
        if (i >= 0 && i < originalPdf.getPageCount()) {
          pageIndices.push(i);
        }
      }

      const pages = await newPdf.copyPages(originalPdf, pageIndices);
      pages.forEach(page => newPdf.addPage(page));

      const pdfBytes = await newPdf.save();
      results.push({
        name: `split_${range.start}-${range.end}.pdf`,
        data: Buffer.from(pdfBytes).toString('base64')
      });
    }

    return { success: true, files: results };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Extract pages
ipcMain.handle('extract-pages', async (event, { data, pageNumbers }) => {
  try {
    const buffer = Buffer.from(data, 'base64');
    const originalPdf = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const newPdf = await PDFDocument.create();

    const pageIndices = pageNumbers.map(n => n - 1).filter(i => i >= 0 && i < originalPdf.getPageCount());
    const pages = await newPdf.copyPages(originalPdf, pageIndices);
    pages.forEach(page => newPdf.addPage(page));

    const pdfBytes = await newPdf.save();
    return {
      success: true,
      data: Buffer.from(pdfBytes).toString('base64')
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Get document info
ipcMain.handle('get-document-info', async (event, { data }) => {
  try {
    const buffer = Buffer.from(data, 'base64');
    const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });

    return {
      success: true,
      info: {
        pageCount: pdfDoc.getPageCount(),
        title: pdfDoc.getTitle() || '',
        author: pdfDoc.getAuthor() || '',
        subject: pdfDoc.getSubject() || '',
        creator: pdfDoc.getCreator() || '',
        producer: pdfDoc.getProducer() || '',
        creationDate: pdfDoc.getCreationDate()?.toISOString() || '',
        modificationDate: pdfDoc.getModificationDate()?.toISOString() || '',
        keywords: pdfDoc.getKeywords() || ''
      }
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Set document info
ipcMain.handle('set-document-info', async (event, { data, info }) => {
  try {
    const buffer = Buffer.from(data, 'base64');
    const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });

    if (info.title) pdfDoc.setTitle(info.title);
    if (info.author) pdfDoc.setAuthor(info.author);
    if (info.subject) pdfDoc.setSubject(info.subject);
    if (info.keywords) pdfDoc.setKeywords([info.keywords]);
    if (info.creator) pdfDoc.setCreator(info.creator);

    const pdfBytes = await pdfDoc.save();
    return {
      success: true,
      data: Buffer.from(pdfBytes).toString('base64')
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Create new blank PDF
ipcMain.handle('create-blank-pdf', async (event, { pageCount, width, height }) => {
  try {
    const pdfDoc = await PDFDocument.create();

    for (let i = 0; i < (pageCount || 1); i++) {
      pdfDoc.addPage([width || 612, height || 792]);
    }

    const pdfBytes = await pdfDoc.save();
    return {
      success: true,
      data: Buffer.from(pdfBytes).toString('base64')
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Insert pages from another PDF
ipcMain.handle('insert-pages-from-file', async (event, { targetData, sourceData, insertIndex, pageNumbers }) => {
  try {
    const targetBuffer = Buffer.from(targetData, 'base64');
    const sourceBuffer = Buffer.from(sourceData, 'base64');

    const targetPdf = await PDFDocument.load(targetBuffer, { ignoreEncryption: true });
    const sourcePdf = await PDFDocument.load(sourceBuffer, { ignoreEncryption: true });

    const pageIndices = pageNumbers ?
      pageNumbers.map(n => n - 1).filter(i => i >= 0 && i < sourcePdf.getPageCount()) :
      sourcePdf.getPageIndices();

    const pages = await targetPdf.copyPages(sourcePdf, pageIndices);

    let idx = insertIndex;
    for (const page of pages) {
      targetPdf.insertPage(idx++, page);
    }

    const pdfBytes = await targetPdf.save();
    return {
      success: true,
      data: Buffer.from(pdfBytes).toString('base64')
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Export pages as images
ipcMain.handle('select-export-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select Export Folder'
  });

  if (result.canceled) return null;
  return result.filePaths[0];
});

ipcMain.handle('save-image', async (event, { folderPath, fileName, imageData }) => {
  try {
    const base64Data = imageData.replace(/^data:image\/(png|jpeg);base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    const filePath = path.join(folderPath, fileName);
    await fs.promises.writeFile(filePath, buffer);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Select image file
ipcMain.handle('select-image', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'] }
    ]
  });

  if (result.canceled) return null;

  const filePath = result.filePaths[0];
  const buffer = await fs.promises.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();

  return {
    path: filePath,
    name: path.basename(filePath),
    data: buffer.toString('base64'),
    type: ext === '.png' ? 'png' : 'jpeg'
  };
});

// Print document
ipcMain.handle('print-document', async () => {
  mainWindow.webContents.print({
    silent: false,
    printBackground: true
  });
});

// Copy text to clipboard
ipcMain.handle('copy-to-clipboard', async (event, text) => {
  clipboard.writeText(text);
  return { success: true };
});

// Show input dialog
ipcMain.handle('show-input-dialog', async (event, { title, label, defaultValue, type }) => {
  // For now, we'll handle this in the renderer with a custom dialog
  return { canceled: true };
});

// Show message box
ipcMain.handle('show-message-box', async (event, options) => {
  return await dialog.showMessageBox(mainWindow, options);
});

// Show error box
ipcMain.handle('show-error', async (event, { title, message }) => {
  dialog.showErrorBox(title, message);
});

// Save multiple files (for split)
ipcMain.handle('save-multiple-files', async (event, { files, folder }) => {
  try {
    let targetFolder = folder;
    if (!targetFolder) {
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory', 'createDirectory'],
        title: 'Select Output Folder'
      });
      if (result.canceled) return { success: false, canceled: true };
      targetFolder = result.filePaths[0];
    }

    for (const file of files) {
      const buffer = Buffer.from(file.data, 'base64');
      await fs.promises.writeFile(path.join(targetFolder, file.name), buffer);
    }

    return { success: true, folder: targetFolder };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

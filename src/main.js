const { app, BrowserWindow, ipcMain, dialog, Menu, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
// @cantoo/pdf-lib encryption needs Web Crypto; Electron <=28's bundled Node lacks the global
if (!globalThis.crypto) globalThis.crypto = require('crypto').webcrypto;
const { PDFDocument, rgb, degrees, StandardFonts, PDFName, PDFArray, PDFDict, PDFString, PDFNumber, grayscale, cmyk } = require('@cantoo/pdf-lib');

let mainWindow;
let currentFilePath = null;
let recentFiles = [];

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
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
              accelerator: 'V',
              click: () => mainWindow.webContents.send('menu-tool', 'select')
            },
            {
              label: 'Hand Tool',
              accelerator: 'H',
              click: () => mainWindow.webContents.send('menu-tool', 'hand')
            }
          ]
        },
        {
          label: 'Annotation Tools',
          submenu: [
            {
              label: 'Add Text',
              accelerator: 'T',
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
              accelerator: 'P',
              click: () => mainWindow.webContents.send('menu-tool', 'draw')
            },
            {
              label: 'Eraser',
              accelerator: 'E',
              click: () => mainWindow.webContents.send('menu-tool', 'eraser')
            }
          ]
        },
        {
          label: 'Shape Tools',
          submenu: [
            {
              label: 'Rectangle',
              accelerator: 'R',
              click: () => mainWindow.webContents.send('menu-tool', 'rectangle')
            },
            {
              label: 'Circle',
              accelerator: 'C',
              click: () => mainWindow.webContents.send('menu-tool', 'circle')
            },
            {
              label: 'Line',
              accelerator: 'L',
              click: () => mainWindow.webContents.send('menu-tool', 'line')
            },
            {
              label: 'Arrow',
              accelerator: 'A',
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
          label: 'Keyboard Shortcuts',
          accelerator: 'CmdOrCtrl+/',
          click: () => mainWindow.webContents.send('menu-shortcuts')
        },
        { type: 'separator' },
        {
          label: 'About PDF Studio Pro',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About PDF Studio Pro',
              message: 'PDF Studio Pro v2.1.0',
              detail: `A local-first PDF editor.

Features:
• View, create, and edit PDFs
• Annotations and markup tools
• Page management
• Merge, split, and extract
• Watermarks, headers, and page numbers
• AES-256 password protection
• Export to images
• Headless CLI for batch automation

Everything stays on your machine.`
            });
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

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

    } else if (cmd === 'info') {
      const input = args[1];
      if (!input) throw new Error('usage: cli info input.pdf');
      const doc = await loadPdf(input);
      console.log(JSON.stringify({ pages: doc.getPageCount(), title: doc.getTitle(), author: doc.getAuthor() }, null, 2));

    } else {
      throw new Error('unknown command. Available: merge, split, encrypt, decrypt, info');
    }
    app.exit(0);
  } catch (e) {
    console.error('Error:', e.message);
    app.exit(1);
  }
}

const cliArgs = getCliArgs();
app.whenReady().then(() => (cliArgs ? runCli(cliArgs) : createWindow()));

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

// Open file dialog
ipcMain.handle('open-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'PDF Files', extensions: ['pdf'] }]
  });

  if (result.canceled) return null;

  const filePath = result.filePaths[0];
  const buffer = await fs.promises.readFile(filePath);
  currentFilePath = filePath;

  // Add to recent files
  if (!recentFiles.includes(filePath)) {
    recentFiles.unshift(filePath);
    if (recentFiles.length > 10) recentFiles.pop();
  }

  return {
    path: filePath,
    name: path.basename(filePath),
    data: buffer.toString('base64')
  };
});

// Open specific file
ipcMain.handle('open-specific-file', async (event, filePath) => {
  try {
    const buffer = await fs.promises.readFile(filePath);
    currentFilePath = filePath;

    return {
      path: filePath,
      name: path.basename(filePath),
      data: buffer.toString('base64')
    };
  } catch (error) {
    return { error: error.message };
  }
});

// Open multiple files for merge
ipcMain.handle('open-multiple-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF Files', extensions: ['pdf'] }]
  });

  if (result.canceled) return null;

  const files = [];
  for (const filePath of result.filePaths) {
    const buffer = await fs.promises.readFile(filePath);
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

// Get PDF.js worker path
ipcMain.handle('get-pdfjs-worker-path', () => {
  return path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.mjs');
});

// Initial file passed on command line (open-with / drag-drop support)
let initialPdfPath = null;
(function findInitialPdf() {
  const raw = process.argv;
  for (let i = 1; i < raw.length; i++) {
    if (raw[i].endsWith('.pdf')) { initialPdfPath = raw[i]; break; }
  }
})();

ipcMain.handle('get-initial-file', () => initialPdfPath);

// Apply annotations and modifications to PDF
ipcMain.handle('apply-modifications', async (event, { originalData, modifications }) => {
  try {
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
            opacity: mod.opacity || 1
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

        case 'redaction':
          page.drawRectangle({
            x: mod.x * width,
            y: height - (mod.y * height) - (mod.height * height),
            width: mod.width * width,
            height: mod.height * height,
            color: rgb(0, 0, 0)
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

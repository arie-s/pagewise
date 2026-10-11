# Local PDF Desk

**Private PDF editing with local AI.** A desktop PDF editor built with Electron, [pdf-lib](https://github.com/cantoo-scribe/pdf-lib) and [pdf.js](https://mozilla.github.io/pdf.js/), with build targets for Windows, Linux and macOS.

Document editing, OCR and optional AI extraction run on your computer. There are no accounts, subscriptions, telemetry or cloud inference. Internet access is needed to install dependencies, download OCR language data on first use, and install the optional AI engine/model. After those downloads, document processing works offline.

## Features

- **Read and search:** thumbnails, zoom, selectable text, find, bookmarks and printing.
- **Edit and annotate:** text, highlights, underline, strikethrough, pen, shapes, stamps, images and drawn signatures. Annotations are baked into the PDF on save.
- **Organize pages:** drag to reorder, rotate one or all pages, insert blank pages or pages from another PDF, extract and delete.
- **Document tools:** merge, split by page count or ranges, add page numbers, headers, footers and watermarks; export pages as PNG/JPEG.
- **Protect documents:** AES-256 password protection and decryption.
- **Make scans searchable:** local Tesseract OCR adds an invisible text layer at recognized word positions.
- **Redact:** marked regions are masked and the entire output PDF is rebuilt from rendered images, removing the original content and hidden objects.
- **Smart Extract (optional):** the local `dots.ocr` vision-language model transcribes a page into Markdown, including tables, formulas and handwriting. Output quality depends on the document and model.
- **Desktop conveniences:** light/dark themes, recent files, last-document restore and unsaved-change prompts.

Text replacement covers the original text with a white rectangle and adds new text; it does not remove the underlying text or reflow paragraphs. Use **Redact** for sensitive content. Applying redactions flattens **every page**, removing existing selectable text, interactive forms, links, bookmarks, attachments and source metadata. Keep an original copy if you need those features.

## Run from source

Install [Node.js 24 or newer](https://nodejs.org/en/download) with npm, and Git. Node 24 is the recommended development baseline; the test command uses Node's `--test-isolation` option. Packaged apps include their own runtime and do **not** require Node.js or Git.

The same commands work in Windows PowerShell, a Linux terminal and macOS Terminal:

```sh
git clone https://github.com/arie-s/local-pdf-desk.git local-pdf-desk
cd local-pdf-desk
npm ci
npm start
```

The repository URL still uses the previous name. For an existing checkout, run `npm ci` and `npm start` from its root. Linux needs a graphical desktop and Electron's system libraries; a minimal server installation may not have them.

## Build and install

Run the source setup above before building. Build on the target operating system for the simplest path; macOS builds should be produced on a Mac. Output goes into `dist/`. Builds can require internet access to fetch Electron and packaging tools. See [electron-builder's platform guidance](https://www.electron.build/docs/features/multi-platform-build/) for cross-platform limitations.

| Platform | Build targets | Architecture |
|---|---|---|
| Windows | NSIS installer or portable EXE | x64 |
| Linux | AppImage or Debian package | x64 |
| macOS | DMG and ZIP | Apple Silicon arm64 or Intel x64, built separately |

Windows and macOS installation have not been verified in this checkout. The commands below use version `1.0.0`; substitute the filename actually produced by your build.

### Windows

Build the installer from PowerShell in the repository root:

```powershell
npm run build
```

Open `dist\Local PDF Desk Setup 1.0.0.exe`, follow the installation wizard, choose an installation directory, then launch **Local PDF Desk** from the Start menu or desktop shortcut.

For a portable app:

```powershell
npm run build:portable -- --x64
```

Run `dist\Local PDF Desk 1.0.0.exe`. No installation wizard is needed; settings and model downloads are still stored in your user profile. Signing credentials are not configured in this repository, so a locally built executable may show an unknown-publisher warning.

### Linux

Build both formats:

```sh
npx electron-builder --linux AppImage deb --x64
```

**AppImage:** make it executable and launch it:

```sh
chmod +x "dist/Local PDF Desk-1.0.0.AppImage"
"./dist/Local PDF Desk-1.0.0.AppImage"
```

For a permanent installation in your home directory and an application-menu entry, run from the repository root:

```sh
mkdir -p "$HOME/.local/bin" "$HOME/.local/share/icons" "$HOME/.local/share/applications"
install -m 755 "dist/Local PDF Desk-1.0.0.AppImage" "$HOME/.local/bin/local-pdf-desk"
install -m 644 build/icon.png "$HOME/.local/share/icons/local-pdf-desk.png"
cat > "$HOME/.local/share/applications/local-pdf-desk.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Local PDF Desk
Comment=Private PDF editing with local AI
Exec="$HOME/.local/bin/local-pdf-desk" %f
Icon=$HOME/.local/share/icons/local-pdf-desk.png
Terminal=false
Categories=Office;
MimeType=application/pdf;
EOF
```

Launch it from your application menu or with `~/.local/bin/local-pdf-desk`. To use the shorter command `local-pdf-desk`, ensure `~/.local/bin` is on your `PATH`. Set the default PDF viewer through your desktop's **Open With** settings if desired.

If the AppImage reports a FUSE error, follow the [AppImage FUSE instructions](https://docs.appimage.org/user-guide/troubleshooting/fuse.html). On Ubuntu 24.04 the compatibility package is `libfuse2t64`; Ubuntu 22.04 uses `libfuse2`. Alternatively, run without a FUSE mount:

```sh
"./dist/Local PDF Desk-1.0.0.AppImage" --appimage-extract-and-run
```

**Debian/Ubuntu package:** install the `.deb` and launch from your application menu:

```sh
sudo apt install ./dist/local-pdf-desk_1.0.0_amd64.deb
```

### macOS

Build for your Mac's processor from Terminal in the repository root:

```sh
# Apple Silicon (M-series)
npx electron-builder --mac dmg zip --arm64

# Intel: use this instead
npx electron-builder --mac dmg zip --x64
```

Open the generated `.dmg` in `dist/`, drag **Local PDF Desk.app** into **Applications**, eject the disk image, and open the app from Applications. The ZIP is an alternative: extract it and move the app into Applications.

Signing and notarization credentials are not configured in this repository. If macOS blocks an unsigned build that you trust, try opening it once, then use **System Settings → Privacy & Security → Open Anyway**, following [Apple's instructions](https://support.apple.com/en-us/102445).

The base editor can be built for Intel or Apple Silicon; the automatic AI engine installer currently selects an **arm64** macOS binary, so Intel Macs do not have a supported automatic AI setup.

### Updating and the previous name

Rebuild after source changes; existing files in `dist/` do not update automatically. Replace an AppImage/portable executable or install the newly built package. There is no automatic update service configured.

This app was previously named **PDF Studio Pro**. On first launch, when the new app data directory has no settings or OCR downloads, it reuses existing `PDF Studio Pro` or `pdf-studio-pro` data under Electron's app-data directory. Settings, cached OCR languages and downloaded AI models remain in that legacy directory. Your PDF files are not moved. The operating system may keep an old app shortcut or installation alongside the renamed app.

## OCR and local AI setup

**Searchable PDF OCR:** choose **Tools → Make Searchable — offline OCR**. The first use of a language downloads and caches its Tesseract language data; subsequent use can work offline. No GPU is needed.

**Smart Extract:** choose **Tools → Setup AI Reading Engine…**, then **Download & Install**, and **Test Engine**. The installer downloads [llama.cpp](https://github.com/ggml-org/llama.cpp) from GitHub and a `dots.ocr` model plus vision encoder from Hugging Face. Allow several GB of free disk space; the exact download size depends on the selected model files. Linux/macOS extraction needs `unzip` (or Python 3 for ZIP files), or `tar` for a tar archive.

The current automatic installer selects Windows Vulkan x64, Ubuntu/Linux x64 and macOS arm64 release assets. Availability depends on matching upstream assets and system compatibility; it does not provide every CUDA/Vulkan/Metal variant or support every architecture. GPU acceleration and speed depend on the build, drivers and hardware. CPU inference can be much slower.

The AI server binds to `127.0.0.1:8731`; page images are sent to that local server, not a cloud service. Use **Tools → Smart Extract** after setup. Smart Extract produces a Markdown transcript and does not add a searchable text layer to the PDF.

## CLI

From a source checkout, use `npm run cli --` followed by a command:

```sh
npm run cli -- merge out.pdf a.pdf b.pdf c.pdf
npm run cli -- split doc.pdf --every 5
npm run cli -- split doc.pdf --ranges 1-3,5,7-10
npm run cli -- encrypt doc.pdf --password secret --out protected.pdf
npm run cli -- decrypt protected.pdf --password secret --out unlocked.pdf
npm run cli -- info doc.pdf
npm run cli -- engine-install
npm run cli -- engine-extract page.png --prompt "Convert the document to markdown."
npm run cli -- engine-stop
```

`npx electron . cli <command>` is equivalent. A packaged executable takes the literal `cli` argument, for example `~/.local/bin/local-pdf-desk cli info doc.pdf` on Linux. Merge writes to the specified output; split writes numbered files beside the input. Encrypt/decrypt accept `--out` and otherwise use `.encrypted.pdf`/`.decrypted.pdf` filenames.

Supported commands are `merge`, `split`, `encrypt`, `decrypt`, `info`, `engine-install`, `engine-start`, `engine-stop` and `engine-extract`. GUI editing and base OCR are not exposed as CLI commands. The CLI runs through Electron; operation on a Linux server without a display has not been verified. `engine-extract` starts the engine if necessary; `engine-stop` stops the local server.

## Keyboard shortcuts and help

Use **Ctrl** on Windows/Linux and **Cmd** on macOS for menu shortcuts: **O** open, **S** save, **F** find and **/** the full shortcut list. Single-key tools include `V H T P E` (select/hand/text/pen/eraser) and `L A R C` (line/arrow/rectangle/circle).

The bundled [user guide](src/guide.html) is available through **Help → User Guide** (`F1`).

## Development and tests

```sh
npm test
```

Use Node.js 24 or newer. Regression checks cover save/cancel behavior, document replacement, page edit remapping, metadata safety, menu wiring, OCR, redaction and preserving user data after the rename. Redaction integration tests use real PDF rendering; Electron dialogs and the renderer DOM are mocked. These checks do not replace manual installation and GUI testing on each operating system.

| Layer | Implementation |
|---|---|
| UI | Electron renderer, plain JavaScript and CSS themes |
| Document operations | `@cantoo/pdf-lib`, including AES-256 encryption |
| Rendering | `pdfjs-dist` |
| Searchable OCR | `tesseract.js` in the main process |
| AI extraction | Local `llama-server` child process with a `dots.ocr` GGUF model |
| Persistence | `settings.json`, `tesseract-data/` and `ocr-engine/` in Electron's userData directory |
| CLI | Command dispatch in `src/main.js`, without opening the editor window |

## License

MIT, as declared in `package.json`.

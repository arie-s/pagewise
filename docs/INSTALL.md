# Installing and building Pagewise

See the [README](../README.md) for an overview.

## Run from source

Install [Node.js 24 or newer](https://nodejs.org/en/download) with npm, and Git. Node 24 is the recommended development baseline; the test command uses Node's `--test-isolation` option. Packaged apps include their own runtime and do **not** require Node.js or Git.

The same commands work in Windows PowerShell, a Linux terminal and macOS Terminal:

```sh
git clone https://github.com/arie-s/pagewise.git
cd pagewise
npm ci
npm start
```

For an existing checkout, run `npm ci` and `npm start` from its root. Linux needs a graphical desktop and Electron's system libraries; a minimal server installation may not have them.

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

Open `dist\Pagewise-Setup-1.0.0.exe`, follow the installation wizard, choose an installation directory, then launch **Pagewise** from the Start menu or desktop shortcut.

For a portable app:

```powershell
npm run build:portable -- --x64
```

Run `dist\Pagewise 1.0.0.exe`. No installation wizard is needed; settings and model downloads are still stored in your user profile. Signing credentials are not configured in this repository, so a locally built executable may show an unknown-publisher warning.

### Linux

Build both formats:

```sh
npx electron-builder --linux AppImage deb --x64
```

**AppImage:** make it executable and launch it:

```sh
chmod +x "dist/Pagewise-1.0.0.AppImage"
"./dist/Pagewise-1.0.0.AppImage"
```

For a permanent installation in your home directory and an application-menu entry, run from the repository root:

```sh
mkdir -p "$HOME/.local/bin" "$HOME/.local/share/icons" "$HOME/.local/share/applications"
install -m 755 "dist/Pagewise-1.0.0.AppImage" "$HOME/.local/bin/pagewise"
install -m 644 build/icon.png "$HOME/.local/share/icons/pagewise.png"
cat > "$HOME/.local/share/applications/pagewise.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Pagewise
Comment=Private PDF editor that reads your documents with local AI
Exec="$HOME/.local/bin/pagewise" %f
Icon=$HOME/.local/share/icons/pagewise.png
Terminal=false
Categories=Office;
MimeType=application/pdf;
EOF
```

Launch it from your application menu or with `~/.local/bin/pagewise`. To use the shorter command `pagewise`, ensure `~/.local/bin` is on your `PATH`. Set the default PDF viewer through your desktop's **Open With** settings if desired.

If the AppImage reports a FUSE error, follow the [AppImage FUSE instructions](https://docs.appimage.org/user-guide/troubleshooting/fuse.html). On Ubuntu 24.04 the compatibility package is `libfuse2t64`; Ubuntu 22.04 uses `libfuse2`. Alternatively, run without a FUSE mount:

```sh
"./dist/Pagewise-1.0.0.AppImage" --appimage-extract-and-run
```

**Debian/Ubuntu package:** install the `.deb` and launch from your application menu:

```sh
sudo apt install ./dist/pagewise_1.0.0_amd64.deb
```

### macOS

Build for your Mac's processor from Terminal in the repository root:

```sh
# Apple Silicon (M-series)
npx electron-builder --mac dmg zip --arm64

# Intel: use this instead
npx electron-builder --mac dmg zip --x64
```

Open the generated `.dmg` in `dist/`, drag **Pagewise.app** into **Applications**, eject the disk image, and open the app from Applications. The ZIP is an alternative: extract it and move the app into Applications.

Signing and notarization credentials are not configured in this repository. If macOS blocks an unsigned build that you trust, try opening it once, then use **System Settings → Privacy & Security → Open Anyway**, following [Apple's instructions](https://support.apple.com/en-us/102445).

The base editor can be built for Intel or Apple Silicon; the Scan reading model installer downloads the matching arm64 or x64 macOS llama.cpp build. Intel Macs run Read Tables & Handwriting on the CPU.

### Updating and the previous name

Rebuild after source changes; existing files in `dist/` do not update automatically. Replace an AppImage/portable executable or install the newly built package. There is no automatic update service configured.

This app was previously named **Local PDF Desk** and, before that, **PDF Studio Pro**. On first launch, when the new app data directory has no settings or OCR downloads, it reuses existing `Local PDF Desk`, `local-pdf-desk`, `PDF Studio Pro` or `pdf-studio-pro` data under Electron's app-data directory. Settings, cached OCR languages and downloaded AI models remain in that old directory. Your PDF files are not moved. The operating system may keep an old app shortcut or installation alongside the renamed app.

## OCR and local AI setup

**Searchable PDF OCR:** choose **Tools → Scanned Pages → Recognize Text (fast, built-in)**. The first use of a language downloads and caches its Tesseract language data; subsequent use can work offline. No GPU is needed.

**Optional AI models:** choose **Tools → AI Models…**. It lists the Scan reading model (about 4.5 GB: Recognize Text with AI, Read Tables & Handwriting, Word/Excel export of scanned pages), the Assistant model (about 3.1 GB: Ask and AI suggestions in forms) and Page images for the assistant (about 1 GB: lets Ask read the page itself), each with its own **Download** and **Remove**. For the Scan reading model, **Check it works** starts it once to confirm it runs. The installer downloads [llama.cpp](https://github.com/ggml-org/llama.cpp) from GitHub and a `dots.ocr` model plus vision encoder from Hugging Face. Allow several GB of free disk space; the exact download size depends on the selected model files. Linux/macOS extraction needs `unzip` (or Python 3 for ZIP files), or `tar` for a tar archive.

On Windows and Linux x64 the installer tries the Vulkan (GPU) build of llama.cpp and keeps it only if llama.cpp finds a real GPU; otherwise it installs the CPU build. On Linux the Vulkan build is tried only when a GPU device and the Vulkan loader (`libvulkan.so.1`) are present. macOS uses the arm64 or x64 build. The AI Models window shows whether the Scan reading model uses the graphics card or the processor. A Scan reading model installed by an older version keeps its previous build until you remove it and download it again. Speed depends on the hardware: as a rough guide, a page takes a few seconds on a GPU and around a minute on a fast desktop CPU.

The AI server binds to `127.0.0.1:8731`; page images are sent to that local server, not a cloud service. Use **Tools → Scanned Pages → Read Tables & Handwriting with AI** after setup. Read Tables & Handwriting produces a Markdown transcript, which can be saved as a `.md` file, and exports any tables it finds as CSV. It does not add a searchable text layer to the PDF.

The Assistant model runs on the processor in its own local server on `127.0.0.1:8733`, started on the first Ask question or AI suggestion and stopped when the app closes. It needs about 4.5 GB of free memory, about 5.5 GB once Ask has loaded page images. Questions and page images go only to that local server unless you point Ask at a model server of your own.

**Removing a model:** open **Tools → AI Models…** and choose **Remove** on its row; only that model is deleted (removing the Assistant model also removes its page images). The shared llama.cpp program files are deleted with the last model. `pagewise cli engine-remove` removes the Scan reading model the same way. Settings and OCR language data are kept, and any model can be downloaded again later.

## Uninstalling and removing data

Pagewise keeps settings, OCR language data (`tesseract-data`) and the optional AI models (`ocr-engine`) in its app-data folder:

| Platform | App-data folder |
|---|---|
| Windows | `%APPDATA%\Pagewise` |
| macOS | `~/Library/Application Support/Pagewise` |
| Linux | `~/.config/Pagewise` |

If you used an earlier version, the data may be in a folder with an old name instead: `Local PDF Desk`, `local-pdf-desk`, `PDF Studio Pro` or `pdf-studio-pro`, in the same parent folder.

- **Windows:** the uninstaller asks whether to delete this data, including the AI models. Updating the app never deletes it.
- **macOS and Linux:** removing the app, the AppImage or the `.deb` package leaves this folder in place. To free the space, first remove the models in **Tools → AI Models…** as above, or delete the app-data folder yourself after uninstalling.

Your PDF files are never stored there and are not affected.

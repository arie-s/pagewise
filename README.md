# PDF Studio Pro

A local-first PDF editor for Windows, macOS and Linux. Your documents never leave your machine — no accounts, no telemetry, no subscriptions, no cloud inference.

Built with Electron + [pdf-lib](https://github.com/cantoo-scribe/pdf-lib) + [pdf.js](https://mozilla.github.io/pdf.js/). Not a web wrapper: a real desktop app with a headless CLI for automation.

## Features

**Base tier — works on any computer, fully offline:**

- **Viewer** — thumbnails, zoom, text layer with selection & copy
- **Annotations** — text, highlight, underline, strikethrough, pen, shapes, eraser, stamps, images, draw-in signatures; baked into the file on save
- **Page tools** — reorder by dragging thumbnails, rotate (single/all), insert from file, extract, delete
- **Document ops** — merge, split (every N / custom ranges), page numbers (4 formats), header & footer, watermarks
- **Security** — AES-256 password protection & decryption
- **Offline OCR** — make scanned PDFs searchable with an invisible text layer (word-position accurate)
- **Close protection** — unsaved-changes guard, recent files & last document restore
- **Instant tooltips** everywhere, light/dark theme, drag-and-drop open

**AI tier — optional, opt-in (`Tools → Setup AI Reading Engine...`):**

- Smart Extract: VLM-powered (`dots.ocr`) page → clean **markdown**, with reading order, tables, formulas and handwriting intact
- Runs 100% locally via **[llama.cpp](https://github.com/ggml-org/llama.cpp)** (`llama-server`, downloaded on demand — no Ollama, no cloud)
- GPU recommended but not required: CPU-only inference works (slower); Vulkan/CUDA/Metal all supported by the downloaded build

## CLI

All document operations are scriptable (the app binary followed by `cli`):

```bash
pdf-studio-pro cli merge out.pdf a.pdf b.pdf c.pdf
pdf-studio-pro cli split doc.pdf --every 5            # or --ranges 1-3,5,7-10
pdf-studio-pro cli encrypt doc.pdf --password pw      # AES-256
pdf-studio-pro cli decrypt doc.pdf --password pw
pdf-studio-pro cli info doc.pdf                       # JSON metadata
pdf-studio-pro cli engine-install                     # tier-2: llama-server + dots.ocr (~4.5GB)
pdf-studio-pro cli engine-start | engine-stop
pdf-studio-pro cli engine-extract page.png [--prompt "..."]
```

## Keyboard shortcuts

`Ctrl+O/S/F/G/I` · `Ctrl+/` full list · `V H T P E` select/hand/text/pen/eraser · `L A R C` line/arrow/rect/circle

## Build & install

```bash
npm install
npx electron-builder --linux AppImage     # or --win, --mac
```

Linux install (user level):

```bash
cp dist/"PDF Studio Pro-1.0.0.AppImage" ~/.local/bin/pdf-studio-pro
cp build/icon.png ~/.local/share/icons/pdf-studio-pro.png
# desktop entry: ~/.local/share/applications/pdf-studio-pro.desktop (MimeType=application/pdf)
```

The in-app user guide lives in `src/guide.html` — it is bundled with every build (`Help → User Guide`, F1).

## Architecture notes

| Layer | Choice |
|---|---|
| UI | Electron renderer, plain JS, themable via CSS variables |
| Document ops | [pdf-lib fork w/ AES-256](https://www.npmjs.com/package/@cantoo/pdf-lib) |
| Rendering | pdf.js (pdfjs-dist) |
| Base OCR | tesseract.js (main process, WASM) |
| AI OCR | llama-server (llama.cpp) child process, OpenAI-compatible HTTP, dots.ocr GGUF |
| Settings | `settings.json` in Electron userData (recents, bounds, theme, engine state) |
| CLI | same main-process handlers, headless |

## License

MIT
# Pagewise

**Private PDF editor that reads your documents with local AI.**

![Pagewise editor with an invoice open](docs/images/editor.png)

## Why Pagewise

- **Offline AI reading.** Smart Extract runs a local `dots.ocr` vision model through llama.cpp and transcribes pages to Markdown, including tables, formulas and handwriting. Output quality depends on the document and model.
- **Nothing leaves your machine.** Editing, OCR and AI extraction run locally; page images go only to a server bound to `127.0.0.1`.
- **No accounts, subscriptions or telemetry.** Internet access is needed only to install dependencies, download OCR language data on first use, and install the optional AI engine and model. After that, document processing works offline.
- **Free and MIT licensed.**

## Features

- **Open images as PDFs:** open or drop PNG/JPEG photos, screenshots and scans; each image becomes a page (phone-photo rotation is applied), ready for OCR, Smart Extract and editing. Saving writes a new PDF and never overwrites the images.
- **Read and search:** thumbnails, zoom, selectable text, find, a clickable bookmarks panel (the document outline) and printing.
- **Edit and annotate:** text, highlights, underline, strikethrough, pen, shapes, stamps, images, signatures and initials (drawn, typed or uploaded, saved for reuse, movable and resizable once placed; **Tools > Sign Document** finds the signature lines in a form and dates them) and sticky notes (saved as real PDF comments, shown by other viewers). Annotations are baked into the PDF on save.
- **Organize pages:** drag to reorder, rotate one or all pages, insert blank pages or pages from another PDF or image, replace a page with one from another PDF, crop (hides content, doesn't delete it), resize pages to A4/Letter/Legal/A5, extract and delete.
- **Reduce file size:** *File → Reduce File Size...* downsamples and re-encodes large images (Smallest, Balanced or High quality); text and vector graphics are untouched.
- **Document tools:** merge, split by page count or ranges, add page numbers, headers, footers and watermarks; export pages as PNG/JPEG.
- **Fill forms:** click fields in a fillable PDF and type; values save as real form data, and *Tools → Flatten Form* makes them fixed page content. *Tools → Make Fillable* finds the blank lines and boxes on a flat or scanned form and turns them into real fields, with no AI model involved. *Tools → Form Fields* adds a text field, checkbox or dropdown by hand (named after the printed text beside it), *Edit Form Fields* drags and resizes the fields on the page, and right-clicking a field offers *Field Properties* (name, multi-line, max length, comb, font size, read-only, required, dropdown options). *Tools → Profiles* stores one or more profiles (your name, address and so on, for example one for you and one for your spouse) on this computer, encrypted when the system keyring is available, and *Fill from Profile* proposes matching values for you to review before anything is written; pick which profile to fill as and, optionally, a spouse profile for fields about the spouse. SSN and date of birth stay unticked, and fields about other people are skipped. For fields the rules leave empty, *Suggest the rest with AI* uses an optional local model (one-time 3.1 GB download, runs on the CPU, nothing leaves the computer); its suggestions are never pre-ticked, labels that try to give the AI instructions are never sent to it, and `npm run eval:writer -- --model <file.gguf>` scores a candidate model on the same prompts. To avoid typing a profile by hand, *Tools → Save Answers to Profile* turns the values in a filled form into details to review, and *Tools → New Profile from Document* reads an ID card, bill or letter (scanned pages go through Smart Extract) with the local model; both end in a review dialog and nothing is saved until you click Save.
- **Protect documents:** AES-256 password protection and decryption.
- **Make scans searchable:** local Tesseract OCR adds an invisible text layer at recognized word positions.
- **Redact:** marked regions are masked and the entire output PDF is rebuilt from rendered images, removing the original content and hidden objects.
- **Smart Extract (optional):** the local `dots.ocr` vision-language model transcribes a page into Markdown, including tables, formulas and handwriting. Output quality depends on the document and model.
- **Make Searchable (AI) (optional):** uses the same AI engine to read hard scans (faxes, shadowed photos) and adds an invisible text layer, placing each word with Tesseract's box where it matches and an estimate from the page image otherwise.
- **Tables to spreadsheets:** export the tables Smart Extract finds as CSV, or copy them straight into Excel or Google Sheets. A table that continues onto the next page with a repeated header is exported as one table, and cells that a spreadsheet would run as formulas are neutralized. The transcript can be saved as Markdown.
- **Export to Word and Excel:** *File → Export → Word Document (.docx)* converts digital pages locally (headings, bold, lists) and scanned pages, or every page if you tick the AI option, through Smart Extract, with real Word tables; *Excel Workbook (.xlsx)* writes one sheet per table Smart Extract finds. Both are written by Pagewise itself, and spreadsheet cells are never formulas.
- **Desktop conveniences:** light/dark themes, recent files, last-document restore and unsaved-change prompts.

Text replacement covers the original text with a white rectangle and adds new text; it does not remove the underlying text or reflow paragraphs. Use **Redact** for sensitive content. Applying redactions flattens **every page**, removing existing selectable text, interactive forms, links, bookmarks, attachments and source metadata. Keep an original copy if you need those features.

![Tools menu](docs/images/tools-menu.png)

![Dark theme](docs/images/dark.png)

## Quick start

**Download** the latest build from the [Releases](https://github.com/arie-s/pagewise/releases) page:

| Platform | File |
|---|---|
| Windows x64 | `Pagewise.Setup.<version>.exe` (installer) or `Pagewise.<version>.exe` (portable) |
| macOS Apple Silicon | `Pagewise-<version>-arm64.dmg` |
| macOS Intel | `Pagewise-<version>.dmg` |
| Linux x64 | `Pagewise-<version>.AppImage` or `pagewise_<version>_amd64.deb` |

The builds are not code-signed yet. On Windows, SmartScreen may show "Windows protected your PC": choose **More info**, then **Run anyway**. On macOS, open the app once, then allow it under **System Settings > Privacy & Security > Open Anyway**. Windows and macOS builds pass automated checks in CI but have had limited hands-on testing; please open an issue if something doesn't work.

**Run from source** (Node.js 24 or newer, and Git):

```sh
git clone https://github.com/arie-s/pagewise.git
cd pagewise
npm ci
npm start
```

Linux needs a graphical desktop and Electron's system libraries. To build installers for Windows, Linux or macOS, set up the AI engine, or troubleshoot AppImage/FUSE issues, see [docs/INSTALL.md](docs/INSTALL.md). It also covers removing the AI engine and uninstalling.

## CLI

```sh
npm run cli -- merge out.pdf a.pdf b.pdf c.pdf
npm run cli -- split doc.pdf --ranges 1-3,5,7-10
npm run cli -- encrypt doc.pdf --password secret --out protected.pdf
npm run cli -- info doc.pdf
npm run cli -- engine-extract page.png --prompt "Convert the document to markdown."
npm run cli -- engine-extract invoice.png --csv invoice.csv
npm run cli -- extract receipts/ --out results --csv all-tables.csv --skip-existing
```

Commands: `merge`, `split`, `encrypt`, `decrypt`, `info`, `engine-install`, `engine-start`, `engine-stop`, `engine-remove`, `engine-extract`, `extract` (batch: PDFs, PNG/JPEG images or folders in, one Markdown file and CSVs per document out). A packaged app takes the literal `cli` argument (for example `pagewise cli info doc.pdf` on Linux). GUI editing and base OCR are not exposed as CLI commands. The CLI runs through Electron; operation on a Linux server without a display has not been verified.

Menu shortcuts use **Ctrl** (Windows/Linux) or **Cmd** (macOS): **O** open, **S** save, **F** find, **/** full shortcut list.

The bundled [user guide](src/guide.html) is available through **Help -> User Guide** (`F1`).

## Development and tests

```sh
npm test
```

Regression checks cover save/cancel behavior, document replacement, page edit remapping, metadata safety, menu wiring, OCR, redaction and preserving user data after renames. Redaction integration tests use real PDF rendering; Electron dialogs and the renderer DOM are mocked. These checks do not replace manual installation and GUI testing on each operating system.

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

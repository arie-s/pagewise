# PDF Studio Pro - Full-Featured PDF Editor

A desktop PDF editor for Windows with visual editing capabilities similar to Adobe Acrobat. View, annotate, and modify PDF documents with an intuitive interface.

![PDF Studio Pro](https://via.placeholder.com/800x500/1e1e1e/ffffff?text=PDF+Studio+Pro)

## Features

### View & Navigate
- **Visual PDF viewing** - See your entire PDF rendered on screen
- **Page thumbnails** - Quick navigation sidebar with page previews
- **Zoom controls** - Zoom in/out, fit to width, fit to page
- **Multi-page support** - Scroll through all pages seamlessly

### Annotation Tools
- **Add Text** - Click anywhere to add text annotations
- **Highlight** - Draw highlight boxes over text
- **Freehand Drawing** - Draw with your mouse/pen
- **Shapes** - Add rectangles and other shapes
- **Eraser** - Remove any annotation

### Page Management
- **Rotate pages** - Rotate clockwise or counter-clockwise
- **Delete pages** - Remove unwanted pages
- **Insert blank pages** - Add new pages to your document

### File Operations
- **Open any PDF** - Load local PDF files
- **Save** - Save changes to the original file
- **Save As** - Export to a new file
- **Keyboard shortcuts** - Ctrl+O, Ctrl+S, etc.

## Installation

### Prerequisites

1. **Install Node.js** (version 18 or newer)
   - Download from: https://nodejs.org/
   - Choose the **LTS** version
   - Run the installer with default settings

2. **Verify installation** - Open Command Prompt or PowerShell:
   ```
   node --version
   npm --version
   ```
   Both commands should show version numbers.

### Build Steps

1. **Extract this folder** to your desired location (e.g., `C:\PDFStudio`)

2. **Open a terminal** in the project folder:
   - Windows 11: Right-click folder → "Open in Terminal"
   - Windows 10: Hold Shift + Right-click → "Open PowerShell window here"
   - Or: Open Command Prompt and type `cd C:\path\to\pdf-studio-pro`

3. **Install dependencies:**
   ```
   npm install
   ```
   This may take a few minutes to download all required packages.

4. **Test the application:**
   ```
   npm start
   ```
   The application should open. Try loading a PDF!

5. **Build the Windows executable:**
   ```
   npm run build
   ```

   Windows builds use the icon at `build/icon.ico`.
   
6. **Find your installer** in the `dist` folder:
   - `PDF Studio Pro Setup x.x.x.exe` - Windows installer

## Usage Guide

### Opening a PDF
- Click the folder icon in the toolbar, or
- Press `Ctrl+O`, or
- Use File → Open PDF from the menu

### Annotation Tools

| Tool | Shortcut | Description |
|------|----------|-------------|
| Select | V | Default mode, no drawing |
| Text | T | Click to add text |
| Highlight | H | Drag to create highlight box |
| Draw | D | Freehand drawing |
| Rectangle | R | Draw rectangles |
| Eraser | E | Click annotations to remove |

### Tool Settings
- **Color picker** - Change annotation color
- **Size** - Adjust stroke width for drawing
- **Font size** - Change text annotation size

### Page Operations
- Use the right panel buttons to:
  - Rotate current page left/right
  - Insert a blank page after current
  - Delete current page

### Saving
- `Ctrl+S` - Save to current file
- `Ctrl+Shift+S` - Save As (new file)
- File → Save / Save As from menu

## Keyboard Shortcuts

| Action | Shortcut |
|--------|----------|
| Open file | Ctrl+O |
| Save | Ctrl+S |
| Save As | Ctrl+Shift+S |
| Zoom in | Ctrl++ |
| Zoom out | Ctrl+- |
| Select tool | V |
| Text tool | T |
| Highlight | H |
| Draw | D |
| Rectangle | R |
| Eraser | E |
| Fullscreen | F11 |

## Troubleshooting

### "npm is not recognized"
- Node.js is not installed or not in PATH
- Reinstall Node.js, making sure to check "Add to PATH"
- Restart your terminal after installation

### Build fails with errors
1. Delete the `node_modules` folder
2. Delete `package-lock.json`
3. Run `npm install` again
4. Run `npm run build`

### PDF doesn't load
- Make sure the file is a valid PDF
- Try a different PDF file
- Check if the PDF is password-protected (not supported)

### Application is slow
- Very large PDFs may take time to render
- Try reducing zoom level
- Close other applications to free up memory

### Annotations don't appear in saved file
- Make sure to click "Save" after making changes
- Annotations are burned into the PDF when saved

## Technical Details

- **Framework**: Electron 28
- **PDF Rendering**: PDF.js (Mozilla)
- **PDF Editing**: pdf-lib
- **Platform**: Windows 10/11 (64-bit)

## File Structure

```
pdf-studio-pro/
├── src/
│   ├── main.js        # Electron main process
│   ├── preload.js     # IPC bridge
│   └── index.html     # UI and renderer
├── package.json       # Dependencies and scripts
└── README.md          # This file
```

## License

MIT License - Free to use, modify, and distribute.

## Support

For issues or feature requests, please check common solutions above first.

---

**PDF Studio Pro** - Edit PDFs like a pro! 📄✨

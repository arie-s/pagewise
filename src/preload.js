const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pdfAPI', {
  // File operations
  openFile: () => ipcRenderer.invoke('open-file'),
  openSpecificFile: (path) => ipcRenderer.invoke('open-specific-file', path),
  imagesToPdf: (files) => ipcRenderer.invoke('images-to-pdf', files),
  openMultipleFiles: () => ipcRenderer.invoke('open-multiple-files'),
  saveFile: (options) => ipcRenderer.invoke('save-file', options),
  saveFileAs: (options) => ipcRenderer.invoke('save-file-as', options),
  saveMultipleFiles: (options) => ipcRenderer.invoke('save-multiple-files', options),

  // PDF.js
  getPdfjsWorkerPath: () => ipcRenderer.invoke('get-pdfjs-worker-path'),
  getInitialFile: () => ipcRenderer.invoke('get-initial-file'),

  // PDF modifications
  applyModifications: (options) => ipcRenderer.invoke('apply-modifications', options),
  redactPdf: (options) => ipcRenderer.invoke('redact-pdf', options),
  mergePdfs: (options) => ipcRenderer.invoke('merge-pdfs', options),
  splitPdf: (options) => ipcRenderer.invoke('split-pdf', options),
  extractPages: (options) => ipcRenderer.invoke('extract-pages', options),
  reorderPages: (options) => ipcRenderer.invoke('reorder-pages', options),
  replacePage: (options) => ipcRenderer.invoke('replace-page', options),
  insertPagesFromFile: (options) => ipcRenderer.invoke('insert-pages-from-file', options),

  // Document operations
  createBlankPdf: (options) => ipcRenderer.invoke('create-blank-pdf', options),
  getDocumentInfo: (options) => ipcRenderer.invoke('get-document-info', options),
  flattenForm: (options) => ipcRenderer.invoke('flatten-form', options),
  detectFormFields: (options) => ipcRenderer.invoke('detect-form-fields', options),
  addFormFields: (options) => ipcRenderer.invoke('add-form-fields', options),
  removeFormField: (options) => ipcRenderer.invoke('remove-form-field', options),
  profilesGet: () => ipcRenderer.invoke('profiles-get'),
  profilesSet: (store) => ipcRenderer.invoke('profiles-set', store),
  profilesRemember: (choice) => ipcRenderer.invoke('profiles-remember', choice),
  autofillPlan: (options) => ipcRenderer.invoke('autofill-plan', options),
  aiSuggest: (options) => ipcRenderer.invoke('ai-suggest', options),
  answersToProfile: (options) => ipcRenderer.invoke('answers-to-profile', options),
  profileApply: (options) => ipcRenderer.invoke('profile-apply', options),
  profileFromText: (options) => ipcRenderer.invoke('profile-from-text', options),
  writerStatus: () => ipcRenderer.invoke('writer-status'),
  writerInstall: () => ipcRenderer.invoke('writer-install'),
  writerRemove: () => ipcRenderer.invoke('writer-remove'),
  setDocumentInfo: (options) => ipcRenderer.invoke('set-document-info', options),

  // OCR
  ocrPage: (options) => ipcRenderer.invoke('ocr-page', options),
  aiTextLayer: (options) => ipcRenderer.invoke('ai-text-layer', options),

  // Advanced OCR engine (tier 2)
  engineStatus: () => ipcRenderer.invoke('engine-status'),
  engineInstall: (opts) => ipcRenderer.invoke('engine-install', opts),
  engineStart: () => ipcRenderer.invoke('engine-start'),
  engineStop: () => ipcRenderer.invoke('engine-stop'),
  engineRemove: () => ipcRenderer.invoke('engine-remove'),
  smartExtract: (options) => ipcRenderer.invoke('smart-extract', options),
  extractTables: (pages) => ipcRenderer.invoke('extract-tables', pages),
  exportTables: (options) => ipcRenderer.invoke('export-tables', options),
  copyTables: (tables) => ipcRenderer.invoke('copy-tables', tables),
  saveMarkdown: (options) => ipcRenderer.invoke('save-markdown', options),
  onEngineProgress: (callback) => ipcRenderer.on('engine-progress', (ev, m) => callback(m)),
  onMenuSmartExtract: (callback) => ipcRenderer.on('menu-smart-extract', callback),
  onMenuEngineSetup: (callback) => ipcRenderer.on('menu-engine-setup', callback),

  // Security
  encryptPdf: (options) => ipcRenderer.invoke('encrypt-pdf', options),
  decryptPdf: (options) => ipcRenderer.invoke('decrypt-pdf', options),

  // Export operations
  selectExportFolder: () => ipcRenderer.invoke('select-export-folder'),
  saveImage: (options) => ipcRenderer.invoke('save-image', options),
  selectImage: () => ipcRenderer.invoke('select-image'),

  // System operations
  printDocument: () => ipcRenderer.invoke('print-document'),
  copyToClipboard: (text) => ipcRenderer.invoke('copy-to-clipboard', text),
  showMessageBox: (options) => ipcRenderer.invoke('show-message-box', options),
  showError: (options) => ipcRenderer.invoke('show-error', options),

  // Session / theme
  setUnsaved: (flag) => ipcRenderer.send('set-unsaved', flag),
  forceClose: () => ipcRenderer.invoke('force-close'),
  getTheme: () => ipcRenderer.invoke('get-theme'),
  saveTheme: (theme) => ipcRenderer.invoke('save-theme', theme),
  onQuitSave: (callback) => ipcRenderer.on('menu-quit-save', callback),
  onMenuToggleTheme: (callback) => ipcRenderer.on('menu-toggle-theme', callback),

  // Menu event listeners - File
  onMenuNew: (callback) => ipcRenderer.on('menu-new', callback),
  onMenuOpen: (callback) => ipcRenderer.on('menu-open', callback),
  onMenuOpenRecent: (callback) => ipcRenderer.on('menu-open-recent', (event, path) => callback(path)),
  onMenuSave: (callback) => ipcRenderer.on('menu-save', callback),
  onMenuSaveAs: (callback) => ipcRenderer.on('menu-save-as', callback),
  onMenuMerge: (callback) => ipcRenderer.on('menu-merge', callback),
  onMenuSplit: (callback) => ipcRenderer.on('menu-split', callback),
  onMenuExportImages: (callback) => ipcRenderer.on('menu-export-images', (event, format) => callback(format)),
  onMenuExportPages: (callback) => ipcRenderer.on('menu-export-pages', callback),
  onMenuProperties: (callback) => ipcRenderer.on('menu-properties', callback),
  onMenuPrint: (callback) => ipcRenderer.on('menu-print', callback),

  // Menu event listeners - Edit
  onMenuUndo: (callback) => ipcRenderer.on('menu-undo', callback),
  onMenuRedo: (callback) => ipcRenderer.on('menu-redo', callback),
  onMenuFind: (callback) => ipcRenderer.on('menu-find', callback),
  onMenuReplace: (callback) => ipcRenderer.on('menu-replace', callback),
  onMenuPreferences: (callback) => ipcRenderer.on('menu-preferences', callback),

  // Menu event listeners - View
  onMenuZoomIn: (callback) => ipcRenderer.on('menu-zoom-in', callback),
  onMenuZoomOut: (callback) => ipcRenderer.on('menu-zoom-out', callback),
  onMenuZoomReset: (callback) => ipcRenderer.on('menu-zoom-reset', callback),
  onMenuFitWidth: (callback) => ipcRenderer.on('menu-fit-width', callback),
  onMenuFitPage: (callback) => ipcRenderer.on('menu-fit-page', callback),
  onMenuViewMode: (callback) => ipcRenderer.on('menu-view-mode', (event, mode) => callback(mode)),
  onMenuToggleBookmarks: (callback) => ipcRenderer.on('menu-toggle-bookmarks', callback),
  onMenuToggleThumbnails: (callback) => ipcRenderer.on('menu-toggle-thumbnails', callback),

  // Menu event listeners - Tools
  onMenuTool: (callback) => ipcRenderer.on('menu-tool', (event, tool) => callback(tool)),
  onMenuStamp: (callback) => ipcRenderer.on('menu-stamp', (event, stamp) => callback(stamp)),
  onMenuAddImage: (callback) => ipcRenderer.on('menu-add-image', callback),
  onMenuApplyRedactions: (callback) => ipcRenderer.on('menu-apply-redactions', callback),
  onMenuFormTool: (callback) => ipcRenderer.on('menu-form-tool', (event, tool) => callback(tool)),
  onMenuFillSignMode: (callback) => ipcRenderer.on('menu-fill-sign-mode', callback),
  onMenuResetForm: (callback) => ipcRenderer.on('menu-reset-form', callback),

  // Menu event listeners - Page
  onMenuRotate: (callback) => ipcRenderer.on('menu-rotate', (event, angle) => callback(angle)),
  onMenuRotateAll: (callback) => ipcRenderer.on('menu-rotate-all', (event, angle) => callback(angle)),
  onMenuOcr: (callback) => ipcRenderer.on('menu-ocr', callback),
  onMenuOcrAi: (callback) => ipcRenderer.on('menu-ocr-ai', callback),
  onMenuDeletePage: (callback) => ipcRenderer.on('menu-delete-page', callback),
  onMenuInsertPage: (callback) => ipcRenderer.on('menu-insert-page', callback),
  onMenuInsertFromFile: (callback) => ipcRenderer.on('menu-insert-from-file', callback),
  onMenuExtractPages: (callback) => ipcRenderer.on('menu-extract-pages', callback),
  onMenuReplacePage: (callback) => ipcRenderer.on('menu-replace-page', callback),
  onMenuRemoveCrop: (callback) => ipcRenderer.on('menu-remove-crop', callback),
  onMenuCropPage: (callback) => ipcRenderer.on('menu-crop-page', callback),
  onMenuResizePage: (callback) => ipcRenderer.on('menu-resize-page', callback),
  onMenuFlattenForm: (callback) => ipcRenderer.on('menu-flatten-form', callback),
  onMenuMakeFillable: (callback) => ipcRenderer.on('menu-make-fillable', callback),
  onMenuProfiles: (callback) => ipcRenderer.on('menu-profiles', callback),
  onMenuAutofill: (callback) => ipcRenderer.on('menu-autofill', callback),
  onMenuSaveAnswers: (callback) => ipcRenderer.on('menu-save-answers', callback),
  onMenuProfileFromDoc: (callback) => ipcRenderer.on('menu-profile-from-doc', callback),
  onMenuAddWatermark: (callback) => ipcRenderer.on('menu-add-watermark', callback),
  onMenuAddHeaderFooter: (callback) => ipcRenderer.on('menu-add-header-footer', callback),
  onMenuAddPageNumbers: (callback) => ipcRenderer.on('menu-add-page-numbers', callback),
  onMenuAddBackground: (callback) => ipcRenderer.on('menu-add-background', callback),
  onMenuGotoPage: (callback) => ipcRenderer.on('menu-goto-page', callback),
  onMenuGoto: (callback) => ipcRenderer.on('menu-goto', (event, direction) => callback(direction)),

  // Menu event listeners - Security
  onMenuSetPassword: (callback) => ipcRenderer.on('menu-set-password', callback),
  onMenuRemovePassword: (callback) => ipcRenderer.on('menu-remove-password', callback),
  onMenuSignDocument: (callback) => ipcRenderer.on('menu-sign-document', callback),
  onMenuValidateSignatures: (callback) => ipcRenderer.on('menu-validate-signatures', callback),
  onMenuManageCertificates: (callback) => ipcRenderer.on('menu-manage-certificates', callback),
  onMenuSetPermissions: (callback) => ipcRenderer.on('menu-set-permissions', callback),

  // Menu event listeners - Bookmarks
  onMenuAddBookmark: (callback) => ipcRenderer.on('menu-add-bookmark', callback),
  onMenuEditBookmark: (callback) => ipcRenderer.on('menu-edit-bookmark', callback),
  onMenuDeleteBookmark: (callback) => ipcRenderer.on('menu-delete-bookmark', callback),
  onMenuGenerateBookmarks: (callback) => ipcRenderer.on('menu-generate-bookmarks', callback),

  // Menu event listeners - Help
  onMenuShortcuts: (callback) => ipcRenderer.on('menu-shortcuts', callback),
  onMenuCheckUpdates: (callback) => ipcRenderer.on('menu-check-updates', callback)
});

; Included automatically by electron-builder (build/installer.nsh).
; On uninstall (not on update), offer to delete settings and downloaded data,
; including the AI engine and model, which can be several GB.

!macro pagewiseRemoveLegacyData DIR
  ; Earlier versions used these folder names. Delete only this app's own items,
  ; never the whole folder, in case another program uses the same name.
  RMDir /r "$APPDATA\${DIR}\ocr-engine"
  RMDir /r "$APPDATA\${DIR}\tesseract-data"
  Delete "$APPDATA\${DIR}\settings.json"
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    SetShellVarContext current
    MessageBox MB_YESNO|MB_ICONQUESTION "Also delete Pagewise settings and downloaded data, including the AI engine and model?$\r$\n$\r$\nYour PDF files are not affected." /SD IDNO IDNO pagewiseKeepData
      RMDir /r "$APPDATA\Pagewise"
      !insertmacro pagewiseRemoveLegacyData "Local PDF Desk"
      !insertmacro pagewiseRemoveLegacyData "local-pdf-desk"
      !insertmacro pagewiseRemoveLegacyData "PDF Studio Pro"
      !insertmacro pagewiseRemoveLegacyData "pdf-studio-pro"
    pagewiseKeepData:
  ${endIf}
!macroend

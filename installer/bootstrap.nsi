;
; bootstrap.nsi — Nexia IDE source-only installer
;
; Ships SOURCE ONLY (~3 MB). Everything heavy is fetched from its official
; origin at install time, so nexia's own hosting serves ~3 MB per install
; instead of ~80 MB:
;
;   Node.js  -> nodejs.org
;   Electron -> github.com/electron/electron/releases
;   packages -> registry.npmjs.org
;
; Flow: build env in %TEMP% -> compile -> install -> wipe temp + build dirs.
;
; Downloads use urlmon's URLDownloadToFile and the shell's own zip support --
; both present on every Windows since XP, so nothing here depends on PowerShell
; or .NET being installed. The NSIS-bundled NSISdl plugin is not usable: it is
; HTTP-only and every origin here is HTTPS.
;

; Must precede anything that emits data or changes the header.
Unicode true

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "WinVer.nsh"
!include "FileFunc.nsh"

!define APPNAME       "Nexia IDE"
!define COMPANY       "Nexia"
!define NODE_VER      "20.18.0"
!define NODE_URL      "https://nodejs.org/dist/v${NODE_VER}/node-v${NODE_VER}-win-x64.zip"
!define ELECTRON_VER  "22.3.27"
!define ELECTRON_URL  "https://github.com/electron/electron/releases/download/v${ELECTRON_VER}/electron-v${ELECTRON_VER}-win32-x64.zip"
!define REGKEY        "Software\Microsoft\Windows\CurrentVersion\Uninstall\NexiaIDE"

Name "${APPNAME}"
OutFile "..\dist\NexiaSetup-Web.exe"
InstallDir "$LOCALAPPDATA\Programs\NexiaIDE"
InstallDirRegKey HKCU "${REGKEY}" "InstallLocation"
; Per-user: no elevation, so updates never need a UAC prompt.
RequestExecutionLevel user
ShowInstDetails show
; LZMA solid: this installer is almost entirely text (TypeScript/CSS/HTML),
; which compresses far better under LZMA than the zlib default.
SetCompressor /SOLID lzma

Var BuildDir
Var NodeDir
Var NpmCmd

!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

; ── Native download / unzip ───────────────────────────────────────
;
; No PowerShell, no .NET. Both mechanisms below ship with Windows itself and
; work from XP through 11:
;
;   urlmon::URLDownloadToFile  — Win32 API in urlmon.dll, speaks HTTPS via
;                                WinINet and honours the system proxy.
;   Shell.Application CopyHere — the shell's own zip support, driven by cscript.
;
; An earlier version used PowerShell's Net.WebClient and
; System.IO.Compression.ZipFile, which need .NET 4.5 — not present on a stock
; Windows 7, the exact platform this app pins Electron 22 for.

; Download URL -> FILE. Sets $0 to 0 on success.
!macro NetGet URL FILE
  System::Call 'urlmon::URLDownloadToFileW(i 0, w "${URL}", w "${FILE}", i 0, i 0) i .r0'
!macroend

; Extract ZIP -> DIR (must exist). Sets $0 to the cscript exit code.
!macro Unzip ZIP DIR
  FileOpen $9 "$BuildDir\unzip.js" w
  FileWrite $9 'var a=WScript.Arguments;$\r$\n'
  FileWrite $9 'var fso=new ActiveXObject("Scripting.FileSystemObject");$\r$\n'
  FileWrite $9 'var sh=new ActiveXObject("Shell.Application");$\r$\n'
  FileWrite $9 'if(!fso.FolderExists(a(1)))fso.CreateFolder(a(1));$\r$\n'
  FileWrite $9 'var items=sh.NameSpace(a(0)).Items();$\r$\n'
  ; 16 = yes-to-all, 4 = no progress dialog
  FileWrite $9 'sh.NameSpace(a(1)).CopyHere(items,20);$\r$\n'
  ; CopyHere is asynchronous — it returns immediately and the shell keeps
  ; extracting in the background. Without waiting for the item count to settle,
  ; the installer would race ahead and find a half-extracted folder.
  FileWrite $9 'var n=-1,same=0;$\r$\n'
  FileWrite $9 'while(same<6){WScript.Sleep(500);$\r$\n'
  FileWrite $9 '  var c=fso.GetFolder(a(1)).Files.Count+fso.GetFolder(a(1)).SubFolders.Count;$\r$\n'
  FileWrite $9 '  if(c==n&&c>0)same++;else same=0; n=c;}$\r$\n'
  FileClose $9
  nsExec::ExecToLog 'cscript //nologo "$BuildDir\unzip.js" "${ZIP}" "${DIR}"'
  Pop $0
  Delete "$BuildDir\unzip.js"
!macroend

; ── Install ───────────────────────────────────────────────────────

Section "Install"

  ; Electron 22 (Chromium 108) needs Windows 7 SP1 or later.
  ${IfNot} ${AtLeastWin7}
    MessageBox MB_OK|MB_ICONSTOP "Nexia IDE requires Windows 7 Service Pack 1 or later."
    Abort
  ${EndIf}

  StrCpy $BuildDir "$TEMP\NexiaBuild"
  StrCpy $NodeDir  "$BuildDir\node"

  ; ---- 1. Fresh build environment -------------------------------
  DetailPrint "Preparing build environment..."
  RMDir /r "$BuildDir"
  CreateDirectory "$BuildDir"
  SetOutPath "$BuildDir"

  ; The only thing this installer actually carries: the source.
  ;
  ; Note the "\*.*" and the explicit SetOutPath. `File /r "..\src"` looks like it
  ; means "the ..\src folder", but /r treats the argument as a PATTERN and
  ; recurses looking for any directory of that name — it swept in every
  ; node_modules\*\src\ in the tree, 33 MB of unrelated packages.
  SetOutPath "$BuildDir\src"
  File /r "..\src\*.*"
  SetOutPath "$BuildDir\resources"
  File /r "..\resources\*.*"
  SetOutPath "$BuildDir\scripts"
  File "..\scripts\copy-assets.js"
  SetOutPath "$BuildDir"
  File "..\package.json"
  File "..\package-lock.json"
  File "..\tsconfig.json"

  ; ---- 2. Node.js from nodejs.org -------------------------------
  DetailPrint "Downloading Node.js ${NODE_VER} (~28 MB) from nodejs.org..."
  !insertmacro NetGet "${NODE_URL}" "$BuildDir\node.zip"
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "Could not download Node.js.$\r$\n$\r$\nNexia IDE is built on your machine during installation and needs an internet connection."
    Abort
  ${EndIf}

  DetailPrint "Extracting Node.js..."
  CreateDirectory "$BuildDir\nodetmp"
  !insertmacro Unzip "$BuildDir\node.zip" "$BuildDir\nodetmp"
  ${IfNot} ${FileExists} "$BuildDir\nodetmp\node-v${NODE_VER}-win-x64\node.exe"
    MessageBox MB_OK|MB_ICONSTOP "Could not extract Node.js."
    Abort
  ${EndIf}
  ; The zip contains a single versioned top-level folder.
  Rename "$BuildDir\nodetmp\node-v${NODE_VER}-win-x64" "$NodeDir"
  RMDir /r "$BuildDir\nodetmp"
  Delete "$BuildDir\node.zip"

  StrCpy $NpmCmd "$NodeDir\npm.cmd"
  ${IfNot} ${FileExists} "$NpmCmd"
    MessageBox MB_OK|MB_ICONSTOP "Node.js extraction did not produce npm."
    Abort
  ${EndIf}

  ; ---- 3. Runtime packages from npm -----------------------------
  ; --omit=dev matters: electron and electron-builder are devDependencies, and
  ; pulling them here would download ~340 MB we do not need. Electron comes
  ; straight from GitHub below; the build only needs TypeScript.
  DetailPrint "Installing runtime packages from npm (this takes a few minutes)..."
  nsExec::ExecToLog '"$NpmCmd" ci --omit=dev --no-audit --no-fund --prefix "$BuildDir"'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "npm install failed. Check your internet connection."
    Abort
  ${EndIf}

  DetailPrint "Installing the TypeScript compiler..."
  nsExec::ExecToLog '"$NpmCmd" install typescript@5.3.3 --no-save --no-audit --no-fund --prefix "$BuildDir"'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "Could not install the TypeScript compiler."
    Abort
  ${EndIf}

  ; ---- 4. Compile ------------------------------------------------
  DetailPrint "Compiling Nexia IDE..."
  nsExec::ExecToLog '"$NodeDir\node.exe" "$BuildDir\node_modules\typescript\bin\tsc" -p "$BuildDir\tsconfig.json"'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "Compilation failed."
    Abort
  ${EndIf}

  DetailPrint "Copying assets..."
  nsExec::ExecToLog '"$NodeDir\node.exe" "$BuildDir\scripts\copy-assets.js"'
  Pop $0

  ${IfNot} ${FileExists} "$BuildDir\dist\main\main.js"
    MessageBox MB_OK|MB_ICONSTOP "The build did not produce dist\main\main.js."
    Abort
  ${EndIf}

  ; ---- 5. Electron from GitHub -----------------------------------
  DetailPrint "Downloading Electron ${ELECTRON_VER} (~92 MB) from GitHub..."
  !insertmacro NetGet "${ELECTRON_URL}" "$BuildDir\electron.zip"
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "Could not download Electron from GitHub."
    Abort
  ${EndIf}

  ; ---- 6. Assemble the installation ------------------------------
  DetailPrint "Installing Electron runtime..."
  CreateDirectory "$INSTDIR"
  !insertmacro Unzip "$BuildDir\electron.zip" "$INSTDIR"
  ${IfNot} ${FileExists} "$INSTDIR\electron.exe"
    MessageBox MB_OK|MB_ICONSTOP "Could not extract Electron."
    Abort
  ${EndIf}

  ; Electron runs an unpacked app from resources\app — no asar packing needed.
  DetailPrint "Installing Nexia IDE..."
  CreateDirectory "$INSTDIR\resources\app"
  CopyFiles /SILENT "$BuildDir\dist\*.*"         "$INSTDIR\resources\app\dist"
  CopyFiles /SILENT "$BuildDir\node_modules\*.*" "$INSTDIR\resources\app\node_modules"
  CopyFiles /SILENT "$BuildDir\package.json"     "$INSTDIR\resources\app\package.json"
  CopyFiles /SILENT "$BuildDir\resources\*.*"    "$INSTDIR\resources\app\resources"

  ; electron.exe IS the app once resources\app is in place.
  Rename "$INSTDIR\electron.exe" "$INSTDIR\NexiaIDE.exe"

  ; ---- 7. Shortcuts, registry ------------------------------------
  CreateShortcut "$SMPROGRAMS\${APPNAME}.lnk" "$INSTDIR\NexiaIDE.exe"
  CreateShortcut "$DESKTOP\${APPNAME}.lnk"    "$INSTDIR\NexiaIDE.exe"

  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr   HKCU "${REGKEY}" "DisplayName"     "${APPNAME}"
  WriteRegStr   HKCU "${REGKEY}" "DisplayVersion"  "${VERSION}"
  WriteRegStr   HKCU "${REGKEY}" "Publisher"       "${COMPANY}"
  WriteRegStr   HKCU "${REGKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr   HKCU "${REGKEY}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegStr   HKCU "${REGKEY}" "DisplayIcon"     "$INSTDIR\NexiaIDE.exe"
  WriteRegDWORD HKCU "${REGKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${REGKEY}" "NoRepair" 1

  ; ---- 8. Wipe the build environment -----------------------------
  ;
  ; Detached, and deliberately so. The build environment is ~10,000 files, and
  ; Windows has no tree-delete: RMDir /r, rd /s /q and Explorer all unlink files
  ; one at a time, so it costs ~5 seconds no matter which is used. (robocopy /MIR
  ; /MT:32 was measured at 8.4s vs rd's 4.8s — parallelism loses to its own
  ; startup and diffing overhead.)
  ;
  ; Nothing depends on the cleanup finishing, so Exec (not ExecWait) hands it to
  ; a detached cmd and lets setup finish immediately. The deletion still takes as
  ; long; the user simply never waits on it.
  DetailPrint "Cleaning up build files in the background..."
  Exec 'cmd.exe /c rd /s /q "$BuildDir"'

  DetailPrint "Done."
SectionEnd

; ── Uninstall ─────────────────────────────────────────────────────

Section "Uninstall"
  Delete "$SMPROGRAMS\${APPNAME}.lnk"
  Delete "$DESKTOP\${APPNAME}.lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${REGKEY}"
SectionEnd

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
; Stamps our icon and version onto the renamed electron.exe. Without it the app
; shows Electron's icon and reports "Electron 22.3.27" in Explorer. Cosmetic
; only — app.getVersion() reads package.json, not the exe — but a program that
; calls itself Electron in its own properties looks broken.
!define RCEDIT_URL    "https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe"
!define REGKEY        "Software\Microsoft\Windows\CurrentVersion\Uninstall\NexiaIDE"

Name "${APPNAME}"
OutFile "..\dist\NexiaSetup.exe"
InstallDir "$LOCALAPPDATA\Programs\NexiaIDE"

; No InstallDirRegKey.
;
; It set $INSTDIR from whatever InstallLocation the LAST run recorded, which
; makes a stale or wrong key silently redirect the install: a run with /D= writes
; that path into the key, and the next run without /D= reads it back and installs
; there instead. That turned two updates into 6-minute builds into a deleted temp
; folder, both reporting "Done." while the real install sat untouched.
;
; The install location is not a thing that should be remembered and replayed:
; it is $LOCALAPPDATA\Programs\NexiaIDE unless the caller says otherwise with
; /D=, and /D= overrides InstallDir directly. A user who installs somewhere
; custom passes /D= again, which is the same thing the updater does.
; Per-user: no elevation, so updates never need a UAC prompt.
RequestExecutionLevel user
ShowInstDetails show
; LZMA solid: this installer is almost entirely text (TypeScript/CSS/HTML),
; which compresses far better under LZMA than the zlib default.
SetCompressor /SOLID lzma

Var BuildDir
Var NodeDir
Var NpmCmd
Var ForceRun
Var Updated

/**
 * Abort with a reason.
 *
 * A silent install has nobody to click OK, so a MessageBox there hangs the
 * updater forever holding a modal no one can see. Under /S the reason goes to
 * the log and setup exits non-zero instead, which is what the caller can act on.
 */
!macro Fail MSG
  !insertmacro Log "FAIL: ${MSG}"
  ${If} ${Silent}
    !insertmacro Log "ERROR: ${MSG}"
    DetailPrint "ERROR: ${MSG}"
    SetErrorLevel 1
  ${Else}
    MessageBox MB_OK|MB_ICONSTOP "${MSG}"
  ${EndIf}
  Abort
!macroend

/**
 * Append a line to %TEMP%\nexia-install.log.
 *
 * A silent install shows nothing and NSIS's own logging is a compile-time option
 * the bundled makensis was not built with, so without this a failure is just an
 * exit code with no story attached.
 */
!macro Log MSG
  Push $8
  FileOpen $8 "$TEMP\nexia-install.log" a
  FileSeek $8 0 END
  FileWrite $8 "${MSG}$\r$\n"
  FileClose $8
  Pop $8
!macroend

; The installer's own icon and version info.
;
; Without these NexiaSetup.exe ships with NSIS's default icon and completely
; empty file properties — no product name, no version, no company. The old
; hand-written installer embedded both via installer.rc; they were lost in the
; port to NSIS. This is the file people download, so it is the first thing
; anyone sees of the project.
;
; MUI_ICON must be defined before the page macros are inserted.
!define MUI_ICON   "..\resources\icon.ico"
!define MUI_UNICON "..\resources\icon.ico"

; VIProductVersion demands four numeric parts; ${VERSION} carries three.
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName"     "${APPNAME}"
VIAddVersionKey "FileDescription" "${APPNAME} Setup"
VIAddVersionKey "CompanyName"     "${COMPANY}"
VIAddVersionKey "LegalCopyright"  "Copyright ${COMPANY}"
VIAddVersionKey "FileVersion"     "${VERSION}"
VIAddVersionKey "ProductVersion"  "${VERSION}"
VIAddVersionKey "OriginalFilename" "NexiaSetup.exe"

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
  !insertmacro Log "  urlmon -> $0  for ${FILE}"
!macroend

/**
 * Move SRC -> DST, falling back to a copy across volumes.
 *
 * node_modules is ~10,000 files. CopyFiles walks every one; Rename on the same
 * volume is a metadata change and effectively free. %TEMP% and the install dir
 * are both on C: for almost everyone — but not always, and Rename cannot cross
 * volumes, so the copy stays as a fallback rather than an assumption.
 */
!macro MoveOrCopy SRC DST
  ; Rename refuses to overwrite, so an existing destination makes it fail every
  ; time — which is every update, since the destination is the previous install.
  ; Fresh-folder testing never hit this: the destination only exists when there
  ; is something to update.
  RMDir /r "${DST}"
  ClearErrors
  Rename "${SRC}" "${DST}"
  ${If} ${Errors}
    !insertmacro Log "  move failed (different volume?), copying instead: ${SRC}"
    CreateDirectory "${DST}"
    CopyFiles /SILENT "${SRC}\*.*" "${DST}"
  ${EndIf}
!macroend

/**
 * Extract ZIP -> DIR (must exist).
 *
 * Two paths, fastest first:
 *
 *   tar.exe            — bsdtar, in System32 since Windows 10 1803. Reads ZIP,
 *                        native, and far quicker than driving the shell's COM
 *                        extractor file by file.
 *   Shell.Application  — the fallback, and the only option on Windows 7, which
 *                        is the whole reason this app is pinned to Electron 22.
 *
 * $7 carries "did tar handle it", because NSIS macros can't return values and
 * labels inside a macro collide when it's inserted more than once.
 */
!macro Unzip ZIP DIR
  StrCpy $7 "0"
  ${If} ${FileExists} "$SYSDIR\tar.exe"
    !insertmacro Log "  unzip: tar.exe"
    nsExec::ExecToLog '"$SYSDIR\tar.exe" -xf "${ZIP}" -C "${DIR}"'
    Pop $0
    ${If} $0 == 0
      StrCpy $7 "1"
    ${Else}
      !insertmacro Log "  tar failed ($0) — falling back to the shell"
    ${EndIf}
  ${EndIf}

  ${If} $7 != "1"
  !insertmacro Log "  unzip: Shell.Application"
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
  ${EndIf}
!macroend

; ── Install ───────────────────────────────────────────────────────

Section "Install"

  ; Flags the updater passes. NSIS suppresses the wizard pages under /S on its
  ; own, but these have to be read explicitly:
  ;   --force-run  relaunch the IDE when the install finishes. Without it a
  ;                silent update leaves the user with nothing running.
  ;   --updated    this replaces an existing install rather than being a first
  ;                run, so don't re-create desktop shortcuts the user may have
  ;                deliberately deleted.
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--force-run" $R1
  ${IfNot} ${Errors}
    StrCpy $ForceRun "1"
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "--updated" $R1
  ${IfNot} ${Errors}
    StrCpy $Updated "1"
  ${EndIf}

  ; Electron 22 (Chromium 108) needs Windows 7 SP1 or later.
  ${IfNot} ${AtLeastWin7}
    !insertmacro Fail "Nexia IDE requires Windows 7 Service Pack 1 or later."
  ${EndIf}

  ; A silent install replaces a running copy, so wait for it to let go of its
  ; files first. The wizard never hit this because a human takes seconds to
  ; click through, by which time the app has exited.
  ; findstr's exit code does the work: 0 = the process was listed, 1 = it wasn't.
  ; LogicLib has no "contains" operator, so matching tasklist's text directly
  ; isn't an option.
  ${If} ${Silent}
    !insertmacro Log "Waiting for Nexia IDE to close..."
    DetailPrint "Waiting for Nexia IDE to close..."
    StrCpy $R2 0
    ${Do}
      nsExec::ExecToStack 'cmd /c tasklist /FI "IMAGENAME eq NexiaIDE.exe" /NH | findstr /I /C:NexiaIDE.exe'
      Pop $R1     ; exit code
      Pop $R3     ; output (unused)
      ${If} $R1 != 0
        ${ExitDo}   ; not running
      ${EndIf}
      Sleep 500
      IntOp $R2 $R2 + 1
      ${If} $R2 > 60   ; ~30s, then stop waiting and let the file ops report it
        !insertmacro Log "Nexia IDE is still running; continuing anyway."
        DetailPrint "Nexia IDE is still running; continuing anyway."
        ${ExitDo}
      ${EndIf}
    ${Loop}
  ${EndIf}

  StrCpy $BuildDir "$TEMP\NexiaBuild"
  StrCpy $NodeDir  "$BuildDir\node"

  ; ---- 1. Fresh build environment -------------------------------
  !insertmacro Log "Preparing build environment..."
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
  ; /x icon-512.png: 376 KB, referenced nowhere in the project. PNG is already
  ; compressed, so it survives LZMA intact — it was a third of the download,
  ; shipped to every user, for nothing. icon.png IS used (main.ts sets it as the
  ; window icon) and icon.ico is what rcedit stamps onto the exe.
  SetOutPath "$BuildDir\resources"
  File /r /x icon-512.png "..\resources\*.*"
  SetOutPath "$BuildDir\scripts"
  File "..\scripts\copy-assets.js"
  SetOutPath "$BuildDir"
  File "..\package.json"
  File "..\package-lock.json"
  File "..\tsconfig.json"

  ; ---- 2. Node.js from nodejs.org -------------------------------
  !insertmacro Log "Downloading Node.js ${NODE_VER} (~28 MB) from nodejs.org..."
  DetailPrint "Downloading Node.js ${NODE_VER} (~28 MB) from nodejs.org..."
  !insertmacro NetGet "${NODE_URL}" "$BuildDir\node.zip"
  ${If} $0 != 0
    !insertmacro Fail "Could not download Node.js.$\r$\n$\r$\nNexia IDE is built on your machine during installation and needs an internet connection."
  ${EndIf}

  !insertmacro Log "Extracting Node.js..."

  DetailPrint "Extracting Node.js..."
  CreateDirectory "$BuildDir\nodetmp"
  !insertmacro Unzip "$BuildDir\node.zip" "$BuildDir\nodetmp"
  ${IfNot} ${FileExists} "$BuildDir\nodetmp\node-v${NODE_VER}-win-x64\node.exe"
    !insertmacro Fail "Could not extract Node.js."
  ${EndIf}
  ; The zip contains a single versioned top-level folder.
  Rename "$BuildDir\nodetmp\node-v${NODE_VER}-win-x64" "$NodeDir"
  RMDir /r "$BuildDir\nodetmp"
  Delete "$BuildDir\node.zip"

  StrCpy $NpmCmd "$NodeDir\npm.cmd"
  ${IfNot} ${FileExists} "$NpmCmd"
    !insertmacro Fail "Node.js extraction did not produce npm."
  ${EndIf}

  ; ---- 3. Packages from npm -------------------------------------
  ;
  ; The FULL tree, dev included — the compiler needs it. --omit=dev here looks
  ; obviously right and silently breaks the build: @types/node and electron are
  ; both devDependencies, and without them tsc has no types for require/process
  ; or for `import { app } from 'electron'`. It still writes its output, then
  ; exits non-zero, so the damage shows up as "Compilation failed" long after
  ; the actual mistake.
  ;
  ; The dev packages are pruned after compiling, below — that is the step that
  ; keeps them out of the install, not this one.
  ; ---- 3a. Start Electron downloading in the background ----------
  ;
  ; npm ci takes minutes and barely touches the network after the first seconds,
  ; so Electron's 97 MB can come down alongside it instead of after. Node is
  ; already extracted, so it does the fetching — no extra dependency.
  ;
  ; It writes electron.zip.part and renames on completion: the rename is atomic,
  ; so the presence of electron.zip means "finished", never "still arriving".
  ; Without that marker the install could race ahead and unzip a partial file.
  !insertmacro Log "Starting Electron download in the background..."
  DetailPrint "Starting Electron download in the background..."
  FileOpen $9 "$BuildDir\dl.js" w
  FileWrite $9 'var https=require("https"),fs=require("fs");$\r$\n'
  FileWrite $9 'function get(u,cb){https.get(u,{headers:{"User-Agent":"nexia"}},function(r){$\r$\n'
  FileWrite $9 '  if(r.statusCode>=300&&r.statusCode<400&&r.headers.location){r.resume();return get(r.headers.location,cb);}$\r$\n'
  FileWrite $9 '  if(r.statusCode!==200){r.resume();return;}$\r$\n'
  FileWrite $9 '  var f=fs.createWriteStream(process.argv[2]+".part");$\r$\n'
  FileWrite $9 '  r.pipe(f); f.on("close",function(){try{fs.renameSync(process.argv[2]+".part",process.argv[2]);}catch(e){}});$\r$\n'
  FileWrite $9 '}).on("error",function(){});}$\r$\n'
  FileWrite $9 'get(process.argv[3],0);$\r$\n'
  FileClose $9
  Exec '"$NodeDir\node.exe" "$BuildDir\dl.js" "$BuildDir\electron.zip" "${ELECTRON_URL}"'

  ; --ignore-scripts: electron's postinstall runs `node install.js`, which
  ; downloads the entire Electron binary (~97 MB) into node_modules\electron\dist
  ; (105 MB on disk). We fetch Electron from GitHub ourselves below, so without
  ; this flag the installer downloads Electron TWICE. Skipping the script still
  ; leaves electron.d.ts, which is the only part the compiler ever reads.
  ;
  ; Nothing else here needs its install scripts: monaco, marked and highlight.js
  ; are plain JS, and app-builder-bin/7zip-bin ship their binaries in the tarball.
  !insertmacro Log "Installing packages from npm (this takes a few minutes)..."
  DetailPrint "Installing packages from npm (this takes a few minutes)..."
  nsExec::ExecToLog '"$NpmCmd" ci --ignore-scripts --no-audit --no-fund --prefix "$BuildDir"'
  Pop $0
  ${If} $0 != 0
    !insertmacro Fail "npm install failed. Check your internet connection."
  ${EndIf}

  ; TypeScript is a devDependency, so the full npm ci above already installed it
  ; at the version package-lock.json pins. Installing it separately was only
  ; needed back when --omit=dev had excluded it.
  ${IfNot} ${FileExists} "$BuildDir\node_modules\typescript\bin\tsc"
    !insertmacro Fail "npm did not install the TypeScript compiler."
  ${EndIf}

  ; ---- 4. Compile ------------------------------------------------
  !insertmacro Log "Compiling Nexia IDE..."
  DetailPrint "Compiling Nexia IDE..."
  nsExec::ExecToLog '"$NodeDir\node.exe" "$BuildDir\node_modules\typescript\bin\tsc" -p "$BuildDir\tsconfig.json"'
  Pop $0
  ${If} $0 != 0
    !insertmacro Fail "Compilation failed."
  ${EndIf}

  !insertmacro Log "Copying assets..."

  DetailPrint "Copying assets..."
  nsExec::ExecToLog '"$NodeDir\node.exe" "$BuildDir\scripts\copy-assets.js"'
  Pop $0

  ${IfNot} ${FileExists} "$BuildDir\dist\main\main.js"
    !insertmacro Fail "The build did not produce dist\main\main.js."
  ${EndIf}

  ; ---- 5. Collect the background Electron download ---------------
  ;
  ; Started before npm ci, so by now it has usually finished. Wait for
  ; electron.zip to appear (the rename only happens on completion), then fall
  ; back to a foreground urlmon fetch if the background job died — a background
  ; process that fails silently must not become an install that fails silently.
  !insertmacro Log "Waiting for the Electron download..."
  DetailPrint "Waiting for Electron ${ELECTRON_VER} (~92 MB)..."
  StrCpy $R2 0
  ${DoUntil} ${FileExists} "$BuildDir\electron.zip"
    Sleep 1000
    IntOp $R2 $R2 + 1
    ; No .part either means the background node never got going.
    ${IfNot} ${FileExists} "$BuildDir\electron.zip.part"
    ${AndIf} $R2 > 10
      !insertmacro Log "  background download not running — fetching in the foreground"
      ${ExitDo}
    ${EndIf}
    ${If} $R2 > 600      ; 10 min, then stop waiting on it
      !insertmacro Log "  background download timed out"
      ${ExitDo}
    ${EndIf}
  ${Loop}

  ${IfNot} ${FileExists} "$BuildDir\electron.zip"
    !insertmacro Log "  falling back to foreground download"
    DetailPrint "Downloading Electron ${ELECTRON_VER} (~92 MB) from GitHub..."
    !insertmacro NetGet "${ELECTRON_URL}" "$BuildDir\electron.zip"
    ${If} $0 != 0
      !insertmacro Fail "Could not download Electron from GitHub."
    ${EndIf}
  ${EndIf}
  Delete "$BuildDir\dl.js"

  ; ---- 6. Assemble the installation ------------------------------
  !insertmacro Log "Installing Electron runtime..."
  DetailPrint "Installing Electron runtime..."
  CreateDirectory "$INSTDIR"
  !insertmacro Unzip "$BuildDir\electron.zip" "$INSTDIR"
  ${IfNot} ${FileExists} "$INSTDIR\electron.exe"
    !insertmacro Fail "Could not extract Electron."
  ${EndIf}

  ; Now that the compiler has run, drop the dev packages. This is what keeps
  ; electron (221 MB) and app-builder-bin (122 MB) out of resources\app —
  ; without it the installer ships Electron a second time, as an npm package,
  ; inside the app that Electron is already running.
  !insertmacro Log "Removing build-only packages..."
  DetailPrint "Removing build-only packages..."
  nsExec::ExecToLog '"$NpmCmd" prune --omit=dev --no-audit --no-fund --prefix "$BuildDir"'
  Pop $0
  ; Not fatal: a failed prune costs disk, not correctness. Say so and continue.
  ${If} $0 != 0
    !insertmacro Log "  prune failed ($0) — install will be larger than it should be"
    DetailPrint "Warning: could not remove build-only packages."
  ${EndIf}

  ; Drop what the packaged build excludes but a plain npm install leaves behind.
  ; package.json's build.files already lists these; nothing enforces them here,
  ; so monaco arrives at 89 MB instead of ~12 MB.
  !insertmacro Log "Trimming unused package files..."
  DetailPrint "Trimming unused package files..."
  RMDir /r "$BuildDir\node_modules\monaco-editor\dev"
  RMDir /r "$BuildDir\node_modules\monaco-editor\esm"
  RMDir /r "$BuildDir\node_modules\monaco-editor\min-maps"

  ; Electron runs an unpacked app from resources\app — no asar packing needed.
  ;
  ; MOVE, don't copy. node_modules is ~10,000 files; CopyFiles walks every one of
  ; them, while Rename on the same volume is a metadata change and effectively
  ; instant. %TEMP% and the install dir are both on C: for almost everyone, but
  ; not guaranteed — if they differ, Rename fails and we fall back to copying.
  !insertmacro Log "Installing Nexia IDE..."
  DetailPrint "Installing Nexia IDE..."

  ; Remove a packed app from an earlier electron-builder install.
  ;
  ; Electron loads resources\app.asar in preference to resources\app, so leaving
  ; the old asar in place means it keeps winning: the update lands, reports
  ; success, and the machine goes on running the previous version forever while
  ; every version number claims otherwise. Silent, and invisible without
  ; comparing what is on disk against what the app reports.
  ${If} ${FileExists} "$INSTDIR\resources\app.asar"
    !insertmacro Log "  removing old app.asar (it would shadow the new build)"
    Delete "$INSTDIR\resources\app.asar"
    Delete "$INSTDIR\resources\app.asar.unpacked"
    RMDir /r "$INSTDIR\resources\app.asar.unpacked"
  ${EndIf}

  CreateDirectory "$INSTDIR\resources\app"

  !insertmacro MoveOrCopy "$BuildDir\node_modules" "$INSTDIR\resources\app\node_modules"
  !insertmacro MoveOrCopy "$BuildDir\dist"         "$INSTDIR\resources\app\dist"
  !insertmacro MoveOrCopy "$BuildDir\resources"    "$INSTDIR\resources\app\resources"
  CopyFiles /SILENT "$BuildDir\package.json"       "$INSTDIR\resources\app\package.json"

  ; electron.exe IS the app once resources\app is in place.
  ; Delete first: Rename will not overwrite, and on an update NexiaIDE.exe is
  ; already sitting there from the previous install.
  Delete "$INSTDIR\NexiaIDE.exe"
  ClearErrors
  Rename "$INSTDIR\electron.exe" "$INSTDIR\NexiaIDE.exe"
  ${If} ${Errors}
    !insertmacro Fail "Could not replace NexiaIDE.exe. Close Nexia IDE and try again."
  ${EndIf}

  ; Stamp our icon and version onto it. Straight from electron.exe it carries
  ; Electron's icon and reports "Electron 22.3.27" in its properties, which reads
  ; as a broken build even though the app itself is fine.
  ;
  ; Non-fatal throughout: a stamp failure is cosmetic, and refusing to install
  ; over an icon would be a worse outcome than an unstamped exe.
  !insertmacro Log "Applying icon and version..."
  DetailPrint "Applying icon and version..."
  !insertmacro NetGet "${RCEDIT_URL}" "$BuildDir\rcedit.exe"
  ${If} $0 == 0
    ; One line: NSIS has no line-continuation, so a wrapped command would be
    ; parsed as several broken instructions.
    nsExec::ExecToLog '"$BuildDir\rcedit.exe" "$INSTDIR\NexiaIDE.exe" --set-icon "$INSTDIR\resources\app\resources\icon.ico" --set-version-string "ProductName" "${APPNAME}" --set-version-string "FileDescription" "${APPNAME}" --set-version-string "CompanyName" "${COMPANY}" --set-version-string "LegalCopyright" "Copyright ${COMPANY}" --set-version-string "OriginalFilename" "NexiaIDE.exe" --set-file-version "${VERSION}" --set-product-version "${VERSION}"'
    Pop $0
    ${If} $0 != 0
      !insertmacro Log "  rcedit failed ($0) — exe keeps Electron's icon/version"
    ${EndIf}
  ${Else}
    !insertmacro Log "  rcedit download failed — exe keeps Electron's icon/version"
  ${EndIf}
  Delete "$BuildDir\rcedit.exe"

  ; ---- 7. Shortcuts, registry ------------------------------------
  CreateShortcut "$SMPROGRAMS\${APPNAME}.lnk" "$INSTDIR\NexiaIDE.exe"
  ; Skip the desktop shortcut on an update — the user may have deleted it
  ; deliberately, and putting it back every release is the kind of thing that
  ; makes people hate an updater.
  ${If} $Updated != "1"
    CreateShortcut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\NexiaIDE.exe"
  ${EndIf}

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
  !insertmacro Log "Cleaning up build files in the background..."
  DetailPrint "Cleaning up build files in the background..."
  Exec 'cmd.exe /c rd /s /q "$BuildDir"'

  ; Relaunch after a silent update, or the user is left with nothing running
  ; and assumes the update broke the app.
  ;
  ; ExecShell rather than Exec: setup runs as the user here, but ExecShell also
  ; keeps the new process off setup's handles so the app doesn't hold this
  ; installer alive.
  ${If} $ForceRun == "1"
    !insertmacro Log "Starting Nexia IDE..."
    DetailPrint "Starting Nexia IDE..."
    ExecShell "open" "$INSTDIR\NexiaIDE.exe"
  ${EndIf}

  !insertmacro Log "Done."

  DetailPrint "Done."
SectionEnd

; ── Uninstall ─────────────────────────────────────────────────────

Section "Uninstall"
  Delete "$SMPROGRAMS\${APPNAME}.lnk"
  Delete "$DESKTOP\${APPNAME}.lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${REGKEY}"
SectionEnd

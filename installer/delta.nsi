;
; delta.nsi — Nexia IDE delta update
;
; Replaces resources\app\dist and nothing else. That is the only part of an
; install that changes between releases: Electron (151 MB) moves when Electron
; is upgraded, node_modules (23 MB) when package.json changes, and the icons
; never. Everything else in a release is the compiled app — ~3 MB, 0.4 MB packed.
;
; So an update is a 0.4 MB download and a few seconds of file copying, instead of
; NexiaSetup.exe's ~250 MB of fetching Node/npm/Electron and ~10 minutes of
; rebuilding to arrive at a byte-identical Electron and node_modules.
;
; No new client code: the IDE already downloads whatever the manifest points at,
; verifies its SHA-256, and runs it with /S --force-run --updated. This accepts
; the same switches, so pointing the manifest here is the whole integration.
;
; WHEN A DELTA IS NOT VALID — do not publish one, publish NexiaSetup.exe:
;   - package.json dependencies changed  -> node_modules would be stale
;   - the Electron version changed       -> the runtime would be wrong
; scripts/build-delta.js enforces both by refusing to build in those cases.
;

Unicode true

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

!define APPNAME  "Nexia IDE"
!define COMPANY  "Nexia"
!define REGKEY   "Software\Microsoft\Windows\CurrentVersion\Uninstall\NexiaIDE"

Name "${APPNAME} Update"
OutFile "..\dist\NexiaUpdate.exe"
InstallDir "$LOCALAPPDATA\Programs\NexiaIDE"
RequestExecutionLevel user
ShowInstDetails show
SetCompressor /SOLID lzma

; Only our own status lines — this copies hundreds of files and the default
; prints one line each.
!define MUI_ICON "..\resources\icon.ico"

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName"      "${APPNAME}"
VIAddVersionKey "FileDescription"  "${APPNAME} Update"
VIAddVersionKey "CompanyName"      "${COMPANY}"
VIAddVersionKey "LegalCopyright"   "Copyright ${COMPANY}"
VIAddVersionKey "FileVersion"      "${VERSION}"
VIAddVersionKey "ProductVersion"   "${VERSION}"
VIAddVersionKey "OriginalFilename" "NexiaUpdate.exe"

!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Var ForceRun

!macro Log MSG
  Push $8
  FileOpen $8 "$TEMP\nexia-install.log" a
  FileSeek $8 0 END
  FileWrite $8 "${MSG}$\r$\n"
  FileClose $8
  Pop $8
!macroend

!macro Fail MSG
  !insertmacro Log "FAIL: ${MSG}"
  ${If} ${Silent}
    DetailPrint "ERROR: ${MSG}"
    SetErrorLevel 1
  ${Else}
    MessageBox MB_OK|MB_ICONSTOP "${MSG}"
  ${EndIf}
  Abort
!macroend

Section "Update"
  SetDetailsPrint textonly

  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--force-run" $R1
  ${IfNot} ${Errors}
    StrCpy $ForceRun "1"
  ${EndIf}

  !insertmacro Log "=== delta update to ${VERSION} ==="

  ; A delta can only patch an install built the way this one is. An older
  ; electron-builder install has resources\app.asar and no resources\app, and
  ; dropping dist next to a packed asar would do nothing at all: Electron loads
  ; the asar in preference, so the update would silently not apply.
  ${IfNot} ${FileExists} "$INSTDIR\resources\app\package.json"
    !insertmacro Fail "Nexia IDE isn't installed here, or is too old for a quick update. Download the full installer instead."
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\resources\app.asar"
    !insertmacro Fail "This install needs the full installer, not a quick update."
  ${EndIf}

  ; Wait for the running copy to let go of its files.
  ${If} ${Silent}
    !insertmacro Log "waiting for Nexia IDE to close"
    DetailPrint "Waiting for Nexia IDE to close..."
    StrCpy $R2 0
    ${Do}
      nsExec::ExecToStack 'cmd /c tasklist /FI "IMAGENAME eq NexiaIDE.exe" /NH | findstr /I /C:NexiaIDE.exe'
      Pop $R1
      Pop $R3
      ${If} $R1 != 0
        ${ExitDo}
      ${EndIf}
      Sleep 500
      IntOp $R2 $R2 + 1
      ${If} $R2 > 60
        !insertmacro Log "still running after 30s; continuing"
        ${ExitDo}
      ${EndIf}
    ${Loop}
  ${EndIf}

  ; Stage beside the target, then swap. Extracting straight over the live dist
  ; would leave a half-updated app if this failed midway — a mix of old and new
  ; JavaScript, which fails in ways nobody can diagnose.
  !insertmacro Log "extracting"
  DetailPrint "Updating Nexia IDE..."
  RMDir /r "$INSTDIR\resources\app\dist.new"
  SetOutPath "$INSTDIR\resources\app\dist.new"
  File /r "..\dist\main"
  File /r "..\dist\renderer"
  File /r "..\dist\shared"

  ${IfNot} ${FileExists} "$INSTDIR\resources\app\dist.new\main\main.js"
    RMDir /r "$INSTDIR\resources\app\dist.new"
    !insertmacro Fail "The update package is incomplete. Nothing was changed."
  ${EndIf}

  ; Swap. Renames on one volume, so the window where dist is absent is a few
  ; milliseconds rather than the length of a file copy.
  SetOutPath "$INSTDIR"
  RMDir /r "$INSTDIR\resources\app\dist.old"
  ClearErrors
  Rename "$INSTDIR\resources\app\dist" "$INSTDIR\resources\app\dist.old"
  ${If} ${Errors}
    RMDir /r "$INSTDIR\resources\app\dist.new"
    !insertmacro Fail "Couldn't replace the old files — is Nexia IDE still running?"
  ${EndIf}
  ClearErrors
  Rename "$INSTDIR\resources\app\dist.new" "$INSTDIR\resources\app\dist"
  ${If} ${Errors}
    ; Put it back rather than leave the user with no app at all.
    Rename "$INSTDIR\resources\app\dist.old" "$INSTDIR\resources\app\dist"
    !insertmacro Fail "Couldn't install the new files. Your previous version is intact."
  ${EndIf}
  RMDir /r "$INSTDIR\resources\app\dist.old"

  ; package.json last: it carries the version the app reports, so it must not
  ; move ahead of the code it describes.
  SetOutPath "$INSTDIR\resources\app"
  File "..\package.json"

  WriteRegStr HKCU "${REGKEY}" "DisplayVersion" "${VERSION}"

  !insertmacro Log "done"
  DetailPrint "Done."

  ${If} $ForceRun == "1"
    DetailPrint "Starting Nexia IDE..."
    ExecShell "open" "$INSTDIR\NexiaIDE.exe"
  ${EndIf}
SectionEnd

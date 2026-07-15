; installer.nsh — Nexia IDE NSIS customisations
;
; electron-builder generates the installer; this file supplies the pieces that
; are specific to Nexia IDE. It replaces installer.c, which hand-wrote an entire
; wizard, silent mode, per-user install, uninstaller and Add/Remove registration
; that NSIS already provides.
;
; What genuinely remains ours:
;   - the Windows 7 SP1 requirement
;   - the VC++ 2010 runtime the Xbox 360 SDK tools need
;   - extracting the SDK from a user-supplied XDK installer (extract_sdk.exe)
;
; electron-builder macro hooks used: customWelcomePage, preInit, customInstall.

!include "WinVer.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!include "TextFunc.nsh"
!insertmacro TrimNewLines

; ── Welcome page ───────────────────────────────────────────────────
; electron-builder does not show one by default; without this the first thing a
; user sees is "Choose Installation Options".
!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
!macroend

; ── Windows version gate ───────────────────────────────────────────
; Nexia IDE pins Electron 22, the last release supporting Windows 7 — but 7 RTM
; is not enough, Chromium requires SP1. Mirrors the OSVERSIONINFOEX check the
; old installer did by hand.
!macro preInit
  ${IfNot} ${AtLeastWin7}
    MessageBox MB_OK|MB_ICONSTOP "Nexia IDE requires Windows 7 Service Pack 1 or later.$\r$\n$\r$\nThis version of Windows is not supported."
    Abort
  ${EndIf}
  ${If} ${IsWin7}
  ${AndIfNot} ${AtLeastServicePack} 1
    MessageBox MB_OK|MB_ICONSTOP "Nexia IDE requires Windows 7 Service Pack 1.$\r$\n$\r$\nPlease install Service Pack 1 from Windows Update, then run this installer again."
    Abort
  ${EndIf}
!macroend

; ── Post-install work ──────────────────────────────────────────────
!macro customInstall

  ; ---- VC++ 2010 runtime -----------------------------------------
  ; The Xbox 360 SDK tools (cl.exe, link.exe) are MSVC 2010 era and need
  ; msvcr100.dll / msvcp100.dll. Only install when they are actually missing —
  ; on most machines this is skipped entirely, so updates never see a prompt.
  ;
  ; ExecShell, NOT ExecWait: vcredist_x86.exe requires administrator, and
  ; ExecWait goes through CreateProcess, which cannot elevate — Windows fails it
  ; with ERROR_ELEVATION_REQUIRED. ShellExecute raises the UAC prompt properly.
  ; This is the same trap that made the old updater crash with EACCES.
  StrCpy $R0 "0"
  ${If} ${FileExists} "$WINDIR\SysWOW64\msvcr100.dll"
    StrCpy $R0 "1"
  ${ElseIf} ${FileExists} "$WINDIR\System32\msvcr100.dll"
    StrCpy $R0 "1"
  ${EndIf}

  ${If} $R0 == "0"
  ${AndIf} ${FileExists} "$INSTDIR\resources\vcredist_x86.exe"
    DetailPrint "Installing Microsoft Visual C++ 2010 runtime..."
    ExecShellWait "open" "$INSTDIR\resources\vcredist_x86.exe" "/q /norestart"
  ${Else}
    DetailPrint "Visual C++ 2010 runtime already present — skipping."
  ${EndIf}

  ; ---- Xbox 360 SDK extraction -----------------------------------
  ; Opportunistic: if the user has an XDK installer lying around (next to setup,
  ; on the Desktop, in Downloads), offer to extract it. The XDK is a licensed
  ; Microsoft product and is never bundled — this only ever reads a file the user
  ; already has, and never executes it.
  ;
  ; Skipped entirely in silent mode: an unattended update must not stop to ask.
  ${IfNot} ${Silent}
  ${AndIf} ${FileExists} "$INSTDIR\resources\extract_sdk.exe"
    nsExec::ExecToStack '"$INSTDIR\resources\extract_sdk.exe" --find'
    Pop $0   ; exit code
    Pop $1   ; stdout — the installer path when found
    ${If} $0 == "0"
      ; nsExec captures stdout verbatim, including the trailing newline —
      ; without trimming, the path passed back would end in CRLF and every
      ; FileExists / Exec against it would fail.
      ${TrimNewLines} "$1" $1
      MessageBox MB_YESNO|MB_ICONQUESTION \
        "An Xbox 360 SDK installer was found:$\r$\n$\r$\n$1$\r$\n$\r$\nExtract the SDK into Nexia IDE now?$\r$\n$\r$\n(This reads the file only — it is never run. You can skip this and point Nexia IDE at an existing SDK later.)" \
        IDNO skip_sdk
      DetailPrint "Extracting Xbox 360 SDK — this can take several minutes..."
      nsExec::ExecToLog '"$INSTDIR\resources\extract_sdk.exe" "$1" "$INSTDIR"'
      Pop $0
      ${If} $0 == "0"
        DetailPrint "Xbox 360 SDK extracted."
      ${Else}
        DetailPrint "SDK extraction failed — Nexia IDE will still detect an installed SDK."
      ${EndIf}
      skip_sdk:
    ${EndIf}
  ${EndIf}

  ; ---- Runtime DLLs into the SDK's bin ---------------------------
  ; The SDK tools look for these beside themselves. Only meaningful if an SDK
  ; was extracted into the install directory.
  ${If} ${FileExists} "$INSTDIR\SDK\XDK\bin\win32"
    ${IfNot} ${FileExists} "$INSTDIR\SDK\XDK\bin\win32\msvcr100.dll"
      ${If} ${FileExists} "$WINDIR\SysWOW64\msvcr100.dll"
        CopyFiles /SILENT "$WINDIR\SysWOW64\msvcr100.dll" "$INSTDIR\SDK\XDK\bin\win32"
        CopyFiles /SILENT "$WINDIR\SysWOW64\msvcp100.dll" "$INSTDIR\SDK\XDK\bin\win32"
      ${ElseIf} ${FileExists} "$WINDIR\System32\msvcr100.dll"
        CopyFiles /SILENT "$WINDIR\System32\msvcr100.dll" "$INSTDIR\SDK\XDK\bin\win32"
        CopyFiles /SILENT "$WINDIR\System32\msvcp100.dll" "$INSTDIR\SDK\XDK\bin\win32"
      ${EndIf}
      DetailPrint "Copied VC++ 2010 runtime into the SDK bin folder."
    ${EndIf}
  ${EndIf}

!macroend

; ── Preserve the extracted SDK across updates ──────────────────────
;
; On an upgrade, NSIS runs the old uninstaller to clear $INSTDIR before laying
; down the new build. The extracted Xbox 360 SDK lives at $INSTDIR\SDK and is
; ~5 GB / 6500 files, so the default sweep deletes it — every update would
; silently destroy it and force a re-extract that takes minutes.
;
; customRemoveFiles replaces that sweep entirely, so it must delete everything
; the installer owns. $INSTDIR\SDK is deliberately excluded when this is an
; update ($isUpdated); on a real uninstall it goes, in customUnInstall below.
!macro customRemoveFiles
  ${if} ${isUpdated}
    DetailPrint "Updating - keeping the extracted Xbox 360 SDK."
    ; Remove everything except SDK\, one entry at a time.
    FindFirst $0 $1 "$INSTDIR\*.*"
    ${DoWhile} $1 != ""
      ${If} $1 != "."
      ${AndIf} $1 != ".."
      ${AndIf} $1 != "SDK"
        ${If} ${FileExists} "$INSTDIR\$1\*.*"
          RMDir /r "$INSTDIR\$1"
        ${Else}
          Delete "$INSTDIR\$1"
        ${EndIf}
      ${EndIf}
      FindNext $0 $1
    ${Loop}
    FindClose $0
  ${else}
    ; Full uninstall: take the lot, SDK included.
    RMDir /r "$INSTDIR"
  ${endif}
!macroend

; ── Uninstall ──────────────────────────────────────────────────────
!macro customUnInstall
  ; Belt and braces: on a real uninstall the SDK must not survive. It is written
  ; after install time, so NSIS has no record of it and would otherwise leave
  ; several GB behind.
  ${IfNot} ${isUpdated}
    ${If} ${FileExists} "$INSTDIR\SDK"
      DetailPrint "Removing extracted Xbox 360 SDK..."
      RMDir /r "$INSTDIR\SDK"
    ${EndIf}
  ${EndIf}
!macroend

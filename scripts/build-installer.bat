@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0\.."

REM -- Flags --
set "FULL="
set "NOCOMPRESS="
for %%a in (%*) do (
    if /i "%%a"=="--full" set "FULL=1"
    if /i "%%a"=="--fast" set "NOCOMPRESS=1"
    if /i "%%a"=="--clean" set "FULL=1"
)

echo.
echo  +==========================================+
echo  :   Nexia IDE - Smart Installer Builder    :
echo  +==========================================+
echo.
if defined FULL (
echo  Mode: FULL REBUILD
) else if defined NOCOMPRESS (
echo  Mode: INCREMENTAL ^(no compression^)
) else (
echo  Mode: INCREMENTAL ^(use --full to rebuild all^)
)
echo.

for /f "tokens=1-4 delims=:. " %%a in ("%TIME%") do set "START_H=%%a" & set "START_M=%%b" & set "START_S=%%c"

REM ======================================
REM  Cache directory
REM ======================================
set "CACHE_DIR=dist\.build-cache"
if defined FULL (
    echo  [*] Full rebuild — clearing cache...
    rd /s /q "%CACHE_DIR%" 2>nul
    rd /s /q "dist\win-unpacked" 2>nul
    del "dist\NexiaSetup.exe" 2>nul
    del "dist\setup_base.exe" 2>nul
    del "dist\packer.exe" 2>nul
)
if not exist "%CACHE_DIR%" mkdir "%CACHE_DIR%"

REM ======================================
REM  STEP 1: Pre-flight
REM ======================================
echo  [1/6] Pre-flight checks...

where node >nul 2>nul
if errorlevel 1 ( echo    [X] Node.js not found! & goto :error )
for /f "tokens=*" %%v in ('node -v') do echo    [OK] Node.js %%v

set "CC="
set "WR="
for %%G in (i686-w64-mingw32-gcc.exe) do if not "%%~$PATH:G"=="" set "CC=i686-w64-mingw32-gcc.exe" & set "WR=i686-w64-mingw32-windres.exe"
if "!CC!"=="" for %%G in (x86_64-w64-mingw32-gcc.exe) do if not "%%~$PATH:G"=="" set "CC=x86_64-w64-mingw32-gcc.exe" & set "WR=x86_64-w64-mingw32-windres.exe"
if "!CC!"=="" for %%G in (gcc.exe) do if not "%%~$PATH:G"=="" set "CC=gcc.exe" & set "WR=windres.exe"
if "!CC!"=="" ( echo    [X] No MinGW compiler found! & goto :error )
echo    [OK] Compiler: !CC!

REM -- Verify windres is actually on PATH; try fallbacks if not --
set "WR_OK="
for %%G in (!WR!) do if not "%%~$PATH:G"=="" set "WR_OK=1"
if not defined WR_OK (
    REM Prefixed windres not found — try plain windres.exe
    for %%G in (windres.exe) do if not "%%~$PATH:G"=="" set "WR=windres.exe" & set "WR_OK=1"
)
if not defined WR_OK (
    REM Try to find windres next to the compiler
    for %%G in (!CC!) do set "CC_DIR=%%~dp$PATH:G"
    if exist "!CC_DIR!windres.exe" set "WR=!CC_DIR!windres.exe" & set "WR_OK=1"
)
if defined WR_OK (
    echo    [OK] Resource compiler: !WR!
) else (
    echo    [^^!^^!] WARNING: windres not found — resources will not be embedded
)

if exist "node_modules\.bin\electron-builder.cmd" (
    echo    [OK] electron-builder found
) else (
    echo    [!!] Installing dependencies...
    call npm install --no-audit --no-fund 2>nul
)
echo.

REM ======================================
REM  STEP 2: TypeScript (incremental)
REM ======================================
echo  [2/6] Compiling TypeScript...

call node_modules\.bin\tsc --incremental 2> ts_errors.tmp
if errorlevel 1 (
    echo    [X] TypeScript compilation failed!
    type ts_errors.tmp
    del ts_errors.tmp 2>nul
    goto :error
)
del ts_errors.tmp 2>nul
call node scripts/copy-assets.js
echo    [OK] TypeScript compiled (incremental)
echo.

REM ======================================
REM  STEP 3: Electron packaging
REM ======================================
echo  [3/6] Packaging with electron-builder...

set "NEED_ELECTRON_BUILD=0"
if not exist "dist\win-unpacked\NexiaIDE.exe" set "NEED_ELECTRON_BUILD=1"

for /f %%r in ('node scripts\check-hash.js package.json') do set "PKG_HASH=%%r"
if "!PKG_HASH!"=="changed" set "NEED_ELECTRON_BUILD=1"

if "!NEED_ELECTRON_BUILD!"=="1" (
    echo    Electron app needs full rebuild...
    call node --no-deprecation scripts/build-portable.js
    if errorlevel 1 ( echo    [X] electron-builder failed! & goto :error )
    if not exist "dist\win-unpacked\NexiaIDE.exe" ( echo    [X] No output found! & goto :error )
    call node scripts\check-hash.js --commit package.json
    set "UNPACKED_FILES=0"
    for /r "dist\win-unpacked" %%f in (*) do set /a UNPACKED_FILES+=1
    echo    [OK] Full Electron build: !UNPACKED_FILES! files
) else (
    echo    Electron unchanged — rebuilding asar only...
    del "dist\win-unpacked\resources\app.asar" 2>nul
    call node --no-deprecation scripts/build-portable.js
    if errorlevel 1 ( echo    [X] electron-builder failed! & goto :error )
    set "UNPACKED_FILES=0"
    for /r "dist\win-unpacked" %%f in (*) do set /a UNPACKED_FILES+=1
    echo    [OK] Asar updated: !UNPACKED_FILES! files (Electron cached)
)
echo.

REM ======================================
REM  STEP 4: Native installer
REM ======================================
echo  [4/6] Compiling native installer...

if not exist "dist" mkdir "dist"

REM -- Generate the version header from package.json (single source of truth) --
call node scripts/gen-version.js
if errorlevel 1 ( echo    [X] Version header generation failed! & goto :error )

REM -- Check installer source --
REM    version_generated.h MUST be in this hash: a version bump touches neither
REM    installer.c nor installer.h, so without it the installer stays cached and
REM    ships the previous version's string.
set "NEED_INSTALLER_BUILD=0"
if not exist "dist\setup_base.exe" set "NEED_INSTALLER_BUILD=1"
for /f %%r in ('node scripts\check-hash.js installer\installer.c installer\installer.h installer\version_generated.h') do set "INS_HASH=%%r"
if "!INS_HASH!"=="changed" set "NEED_INSTALLER_BUILD=1"

if "!NEED_INSTALLER_BUILD!"=="1" (
    call :compile_installer
    if errorlevel 1 goto :error
    call node scripts\check-hash.js --commit installer\installer.c installer\installer.h installer\version_generated.h
) else (
    for %%A in ("dist\setup_base.exe") do echo    [OK] Installer unchanged (cached^): %%~zA bytes
)

REM -- Check packer source --
REM    install_pack.c includes installer.h, which defines NXI_PAYLOAD_VERSION and
REM    the payload structs. Without installer.h here, changing the payload format
REM    rebuilds the installer but leaves a cached packer writing the old format.
set "NEED_PACKER_BUILD=0"
if not exist "dist\packer.exe" set "NEED_PACKER_BUILD=1"
for /f %%r in ('node scripts\check-hash.js installer\install_pack.c installer\nxcompress.h installer\installer.h installer\version_generated.h') do set "PACK_HASH=%%r"
if "!PACK_HASH!"=="changed" set "NEED_PACKER_BUILD=1"

if "!NEED_PACKER_BUILD!"=="1" (
    call :compile_packer
    if errorlevel 1 goto :error
    call node scripts\check-hash.js --commit installer\install_pack.c installer\nxcompress.h installer\installer.h installer\version_generated.h
) else (
    echo    [OK] Packer unchanged (cached^)
)
echo.

REM ======================================
REM  STEP 5: Pack payload
REM ======================================
echo  [5/6] Packing Electron app into installer...

REM -- Ensure build tools are NOT in the payload --
del "dist\win-unpacked\packer.exe" 2>nul
del "dist\win-unpacked\setup_base.exe" 2>nul

REM -- Copy extra files from PackedFiles into the payload directory --
if exist "PackedFiles" (
    echo    Copying extra files from PackedFiles...
    xcopy /s /y /q "PackedFiles\*" "dist\win-unpacked\" >nul 2>nul
    set "EXTRA_COUNT=0"
    for /r "PackedFiles" %%f in (*) do set /a EXTRA_COUNT+=1
    echo    [OK] Copied !EXTRA_COUNT! extra files from PackedFiles
)

if defined NOCOMPRESS (
    "dist\packer.exe" "dist\setup_base.exe" "dist\win-unpacked" "dist\NexiaSetup.exe" --raw
) else (
    "dist\packer.exe" "dist\setup_base.exe" "dist\win-unpacked" "dist\NexiaSetup.exe"
)
if errorlevel 1 ( echo    [X] Packing failed! & goto :error )
if not exist "dist\NexiaSetup.exe" ( echo    [X] NexiaSetup.exe was not created! & goto :error )

for %%A in ("dist\NexiaSetup.exe") do (
    set "SETUP_SIZE=%%~zA"
    set /a "SETUP_MB=%%~zA / 1048576"
    echo    [OK] NexiaSetup.exe — !SETUP_MB! MB
)
echo.

REM ======================================
REM  STEP 6: Clean up
REM ======================================
echo  [6/6] Cleaning up...

del "dist\installer.res.o" 2>nul

for /f "tokens=1-4 delims=:. " %%a in ("%TIME%") do set "END_H=%%a" & set "END_M=%%b" & set "END_S=%%c"
set /a "ELAPSED_S=(END_H*3600 + END_M*60 + END_S) - (START_H*3600 + START_M*60 + START_S)"
if !ELAPSED_S! lss 0 set /a ELAPSED_S+=86400
set /a "ELAPSED_M=ELAPSED_S / 60"
set /a "ELAPSED_R=ELAPSED_S %% 60"

echo.
echo  +==========================================+
echo  :     INSTALLER BUILD SUCCESSFUL           :
echo  +==========================================+
echo  :  Output: dist\NexiaSetup.exe             :
echo  :  Size:   !SETUP_MB! MB                   :
echo  :  Time:   !ELAPSED_M!m !ELAPSED_R!s       :
echo  +==========================================+
echo.
pause
exit /b 0

:error
echo.
echo  BUILD FAILED — check errors above.
echo.
pause
exit /b 1

REM ======================================
REM  Subroutines (outside main flow)
REM ======================================

:compile_installer
set "INS_CFLAGS=-O2 -Wall -Wno-unused-parameter -Wno-missing-field-initializers -DUNICODE -D_UNICODE -DWINVER=0x0500 -D_WIN32_WINNT=0x0500 -Iinstaller"
set "INS_RES="
if not exist "installer\installer.rc" goto :skip_res
if not defined WR_OK goto :skip_res

REM Use --include-dir so windres resolves paths in the .rc file
REM (e.g. "installer.manifest", "resources\icon.ico") relative to
REM the installer\ directory — not relative to the project root.
"!WR!" --include-dir installer installer\installer.rc -o dist\installer.res.o
if errorlevel 1 (
    echo    [X] Resource compilation failed.
    echo        The UAC manifest will NOT be embedded. Installer will not request admin.
    echo        Check that installer.manifest and resources\icon.ico exist in installer\.
    exit /b 1
)
set "INS_RES=dist\installer.res.o"
echo    [OK] Resources compiled (manifest + icon embedded)
goto :do_cc

:skip_res
echo    [^^!^^!] WARNING: Skipping resources — windres not found or installer.rc missing.
echo        The installer will have no icon and no UAC manifest.

:do_cc
%CC% %INS_CFLAGS% -mwindows installer\installer.c %INS_RES% -o dist\setup_base.exe -luser32 -lgdi32 -lcomctl32 -lshell32 -lshlwapi -lole32 -ladvapi32 -lcomdlg32 -luuid -lcabinet -static -static-libgcc
if errorlevel 1 (
    echo    [X] Installer compilation failed!
    exit /b 1
)
for %%A in ("dist\setup_base.exe") do echo    [OK] Installer rebuilt: %%~zA bytes
exit /b 0

:compile_packer
set "INS_CFLAGS=-O2 -Wall -Wno-unused-parameter -Wno-missing-field-initializers -DUNICODE -D_UNICODE -DWINVER=0x0500 -D_WIN32_WINNT=0x0500 -Iinstaller"
%CC% %INS_CFLAGS% -mconsole installer\install_pack.c -o dist\packer.exe -luser32 -lshlwapi -lshell32 -ladvapi32 -static -static-libgcc
if errorlevel 1 (
    echo    [X] Packer compilation failed!
    exit /b 1
)
echo    [OK] Packer rebuilt
exit /b 0

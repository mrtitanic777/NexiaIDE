/**
 * build-extract-sdk.js — Compile installer/extract_sdk.c -> dist/extract_sdk.exe
 *
 * The Xbox 360 SDK extractor is the one piece of the old hand-written installer
 * that NSIS has no equivalent for: it scans a user-supplied XDK installer for
 * embedded MSCF cabinets and decompresses them via the FDI Cabinet API. It ships
 * as a small standalone tool that the NSIS installer invokes.
 *
 * Requires MinGW (the same toolchain the old installer used). If no compiler is
 * found this FAILS rather than warning: extraResources references the binary, so
 * a missing one would break the packaging step anyway — better to say why here
 * than to emit a confusing error later.
 *
 * Skips recompiling when the binary is newer than the source.
 */
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'installer', 'extract_sdk.c');
const outDir = path.join(root, 'dist');
const out = path.join(outDir, 'extract_sdk.exe');

function findCompiler() {
    const candidates = [
        'x86_64-w64-mingw32-gcc',
        'i686-w64-mingw32-gcc',
        'gcc',
    ];
    for (const cc of candidates) {
        const r = spawnSync(cc, ['--version'], { stdio: 'ignore', shell: true });
        if (r.status === 0) return cc;
    }
    return null;
}

if (!fs.existsSync(src)) {
    console.error(`   [X] ${src} not found`);
    process.exit(1);
}

// Skip if already up to date.
if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs) {
    console.log('   [OK] extract_sdk.exe up to date');
    process.exit(0);
}

const cc = findCompiler();
if (!cc) {
    console.error('   [X] No MinGW compiler found (tried x86_64-w64-mingw32-gcc, i686-w64-mingw32-gcc, gcc).');
    console.error('       extract_sdk.exe is referenced by extraResources and must exist to package.');
    process.exit(1);
}

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const args = [
    '-O2', '-Wall', '-Wno-unused-parameter',
    '-DUNICODE', '-D_UNICODE',
    // XP-era target: the extractor must run anywhere the IDE does, and the FDI
    // API in cabinet.dll has shipped with Windows since 95.
    '-DWINVER=0x0501', '-D_WIN32_WINNT=0x0501',
    '-municode', '-mconsole',
    src, '-o', out,
    '-lshell32', '-lshlwapi', '-lcabinet',
    '-static', '-static-libgcc',
];

try {
    execFileSync(cc, args, { stdio: 'inherit', cwd: root });
    const kb = (fs.statSync(out).size / 1024).toFixed(0);
    console.log(`   [OK] extract_sdk.exe compiled (${kb} KB)`);
} catch (err) {
    console.error('   [X] extract_sdk.exe compilation failed');
    process.exit(1);
}

/**
 * build-core.js — compile core/*.c -> dist/nexia-core.exe
 *
 * nexia-core is the Xbox-specific logic that never needed Electron: SDK
 * detection, the toolchain, and in time the devkit and the build driver. It
 * ships as a standalone tool the IDE spawns, the same shape as extract_sdk.exe,
 * so the boundary is a process rather than an ABI — no node-gyp, no rebuilding
 * against each Electron release, and it can be run from a shell with no app.
 *
 * Requires MinGW, like build-extract-sdk.js. Fails rather than warns: a missing
 * binary would surface later as a confusing runtime error instead of a build
 * one.
 */
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const srcDir = path.join(root, 'core');
const outDir = path.join(root, 'dist');
const out = path.join(outDir, 'nexia-core.exe');

const sources = fs.existsSync(srcDir)
    ? fs.readdirSync(srcDir).filter(f => f.endsWith('.c')).map(f => path.join(srcDir, f))
    : [];

if (!sources.length) {
    console.error('   [X] no C sources in core/');
    process.exit(1);
}

function findCompiler() {
    for (const cc of ['x86_64-w64-mingw32-gcc', 'i686-w64-mingw32-gcc', 'gcc']) {
        if (spawnSync(cc, ['--version'], { stdio: 'ignore', shell: true }).status === 0) return cc;
    }
    return null;
}

// Rebuild when any source or header is newer than the binary.
const inputs = [...sources, ...fs.readdirSync(srcDir).filter(f => f.endsWith('.h')).map(f => path.join(srcDir, f))];
if (fs.existsSync(out)) {
    const built = fs.statSync(out).mtimeMs;
    if (inputs.every(f => fs.statSync(f).mtimeMs <= built)) {
        console.log('   [OK] nexia-core.exe up to date');
        process.exit(0);
    }
}

const cc = findCompiler();
if (!cc) {
    console.error('   [X] No MinGW compiler found (tried x86_64-w64-mingw32-gcc, i686-w64-mingw32-gcc, gcc).');
    process.exit(1);
}

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const args = [
    '-O2', '-Wall', '-Wextra', '-Wno-unused-parameter',
    '-DUNICODE', '-D_UNICODE',
    // Windows 7 is the floor for the IDE itself (it pins Electron 22 for the
    // same reason), so this must not require anything newer.
    '-DWINVER=0x0601', '-D_WIN32_WINNT=0x0601',
    '-municode', '-mconsole',
    ...sources, '-o', out,
    '-ladvapi32', '-lshlwapi',
    // Static: this is spawned by an app that cannot assume any particular
    // MinGW runtime is installed on the user's machine.
    '-static', '-static-libgcc',
];

try {
    execFileSync(cc, args, { stdio: 'inherit', cwd: root });
    console.log(`   [OK] nexia-core.exe compiled (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
} catch {
    console.error('   [X] nexia-core.exe compilation failed');
    process.exit(1);
}

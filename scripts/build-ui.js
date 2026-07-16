/*
 * build-ui.js — compile the native UI spike (nexia-ui/) -> dist/nexia-ui.exe.
 *
 * A standalone native C++ app, built with the same MinGW toolchain as
 * nexia-core, that reuses core/json_parse.c + core/util.c to read nexia-core's
 * JSON. Built into dist/ beside nexia-core.exe so it finds the backend at
 * runtime. Nothing in src/ (the Electron IDE) is involved.
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const R = path.join(__dirname, '..');
const OUT = path.join(R, 'dist', 'nexia-ui.exe');
const OBJ = path.join(R, 'dist', '.ui-build');

function findTool(cands) {
    for (const c of cands) {
        if (spawnSync(c, ['--version'], { shell: true }).status === 0) return c;
    }
    return null;
}

const GXX = findTool(['x86_64-w64-mingw32-g++', 'g++']);
const GCC = findTool(['x86_64-w64-mingw32-gcc', 'gcc']);
if (!GXX || !GCC) {
    console.error('   [X] No MinGW g++/gcc found (tried x86_64-w64-mingw32-*, then plain).');
    process.exit(1);
}

fs.mkdirSync(OBJ, { recursive: true });
fs.mkdirSync(path.join(R, 'dist'), { recursive: true });

function run(tool, args, label) {
    const r = spawnSync(tool, args, { cwd: R, encoding: 'utf8', shell: false });
    if (r.status !== 0) {
        console.error(`   [X] ${label} failed:`);
        console.error((r.stderr || r.stdout || '').split('\n').slice(0, 25).join('\n'));
        process.exit(1);
    }
}

const cFlags = ['-O2', '-std=c11', '-Icore'];
const cxxFlags = ['-O2', '-std=c++17', '-Icore'];

// core C the UI reuses (the JSON reader + its string helpers)
const cObjs = [];
for (const src of ['core/json_parse.c', 'core/util.c']) {
    const o = path.join(OBJ, path.basename(src).replace(/\.c$/, '.o'));
    run(GCC, ['-c', ...cFlags, src, '-o', o], `compile ${src}`);
    cObjs.push(o);
}

// the UI itself
const uiObj = path.join(OBJ, 'main.o');
run(GXX, ['-c', ...cxxFlags, 'nexia-ui/main.cpp', '-o', uiObj], 'compile nexia-ui/main.cpp');

// link (static so it ships as one exe; console subsystem for now so --probe works)
run(GXX, [
    uiObj, ...cObjs, '-o', OUT,
    '-static', '-static-libgcc', '-static-libstdc++',
    '-luser32', '-lgdi32',
], 'link nexia-ui.exe');

const kb = Math.round(fs.statSync(OUT).size / 1024);
console.log(`   [OK] nexia-ui.exe compiled (${kb} KB)`);

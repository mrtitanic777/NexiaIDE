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

const IMGUI = 'nexia-ui/third_party/imgui';
const cFlags = ['-O2', '-std=c11', '-Icore'];
const cxxFlags = ['-O2', '-std=c++17', '-Icore', `-I${IMGUI}`, `-I${IMGUI}/backends`];

// core C the UI reuses (the JSON reader + its string helpers)
const cObjs = [];
for (const src of ['core/json_parse.c', 'core/util.c']) {
    const o = path.join(OBJ, path.basename(src).replace(/\.c$/, '.o'));
    run(GCC, ['-c', ...cFlags, src, '-o', o], `compile ${src}`);
    cObjs.push(o);
}

// Dear ImGui (vendored, pinned v1.90.9) + the DX9/Win32 backends
const cppObjs = [];
const imguiSrc = [
    `${IMGUI}/imgui.cpp`, `${IMGUI}/imgui_draw.cpp`, `${IMGUI}/imgui_tables.cpp`,
    `${IMGUI}/imgui_widgets.cpp`,
    `${IMGUI}/backends/imgui_impl_win32.cpp`, `${IMGUI}/backends/imgui_impl_dx9.cpp`,
];
for (const src of imguiSrc) {
    const o = path.join(OBJ, 'imgui_' + path.basename(src).replace(/\.cpp$/, '.o'));
    run(GXX, ['-c', ...cxxFlags, src, '-o', o], `compile ${src}`);
    cppObjs.push(o);
}

// the UI's own modules (core_bridge, app, ui, main, and any future panels)
const uiSrc = fs.readdirSync(path.join(R, 'nexia-ui'))
    .filter(f => f.endsWith('.cpp'))
    .sort();
for (const f of uiSrc) {
    const o = path.join(OBJ, f.replace(/\.cpp$/, '.o'));
    run(GXX, ['-c', ...cxxFlags, path.join('nexia-ui', f), '-o', o], `compile nexia-ui/${f}`);
    cppObjs.push(o);
}

// link (static so it ships as one exe; console subsystem for now so --probe works)
run(GXX, [
    ...cppObjs, ...cObjs, '-o', OUT,
    '-static', '-static-libgcc', '-static-libstdc++',
    '-ld3d9', '-luser32', '-lgdi32', '-ldwmapi',
], 'link nexia-ui.exe');

const kb = Math.round(fs.statSync(OUT).size / 1024);
console.log(`   [OK] nexia-ui.exe compiled (${kb} KB)`);

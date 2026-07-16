/**
 * names-parity.js — prove core/project.c's nx_safe_name and nx_safe_filename
 * agree with projectManager.ts's createSafeName and safeFileName.
 *
 * These two decide what a project's directory is called and what gets
 * substituted into its source, so a disagreement is a disagreement about where
 * a user's files land. `project create` is built on them and is not written yet;
 * proving the foundation now beats debugging it through the building later.
 *
 * The TypeScript side is evaluated out of _ts-backup/projectManager.ts.bak
 * rather than dist/main/projectManager.js, for the usual reason: once create()
 * moves to C, the live file will be asking nexia-core and comparing against it
 * would compare the C with itself. The .bak still has the real implementations.
 * Delete it and this test retires — see _ts-backup/README.md.
 *
 *   node core/test/names-parity.js
 */
const path = require('path'), fs = require('fs');
const { execFileSync } = require('child_process');

const R = process.cwd();
const CORE = path.join(R, 'dist', 'nexia-core.exe');
if (!fs.existsSync(CORE)) {
    console.error('   [X] dist/nexia-core.exe missing — run: node scripts/build-core.js');
    process.exit(1);
}

const BAK = path.join(R, 'src', 'main', '_ts-backup', 'projectManager.ts.bak');
if (!fs.existsSync(BAK)) {
    console.log('  _ts-backup/projectManager.ts.bak is gone - nothing left to compare against.');
    process.exit(0);
}

/* The two functions are module-private in the .bak, so lift them out by source
 * rather than importing. Evaluated as written — no reimplementation here, which
 * is the only way this test cannot be wrong in the same direction as the code. */
const src = fs.readFileSync(BAK, 'utf8');
function lift(name) {
    const at = src.indexOf(`function ${name}(`);
    if (at < 0) throw new Error(`${name} not found in ${path.basename(BAK)}`);
    // Walk braces from the first { after the signature.
    let i = src.indexOf('{', at), depth = 0, end = -1;
    for (let k = i; k < src.length; k++) {
        if (src[k] === '{') depth++;
        else if (src[k] === '}') { depth--; if (depth === 0) { end = k + 1; break; } }
    }
    const ts = src.slice(at, end);
    // Strip the TypeScript type annotations this pair happens to use.
    const js = ts.replace(/\(name: string\): string/, '(name)').replace(/: string/g, '');
    return new Function(js + `; return ${name};`)();
}
const createSafeName = lift('createSafeName');
const safeFileName = lift('safeFileName');

const core = (name) => {
    const raw = execFileSync(CORE, ['project', 'names', name], { encoding: 'utf8' });
    return JSON.parse(raw);
};

/* Ordinary names, then every rule and every claim the C's comments make. */
const CASES = [
    'Proj', 'MyGame', 'test_1',
    '3D Engine',                 // leading digit -> My3DEngine
    'My Game',                   // space dropped by safeName, kept by fileName
    'hello-world',               // hyphen
    '...',                       // safeName empty -> My; fileName -> trailing dots stripped -> Main
    '   ',                       // both fall back
    '',                          // empty
    '../../evil',                // separators -> _
    'a/b\\c',                    // both separators
    'con:port',                  // colon
    'q?mark*star<lt>gt"quote|pipe',
    'trail...',                  // trailing dots
    'trail   ',                  // trailing spaces
    'trail. . .',                // mixed trailing
    'tab\there',                 // \x09 -> _ before any trim can see it
    'nl\nhere',                  // \x0a -> _
    'nb space',             // NBSP in the middle - kept
    ' lead',                // NBSP leading  - JS trim() strips it
    'trail ',               // NBSP trailing - JS trim() strips it
    '　ideographic　',   // Zs, both ends
    '﻿bom',                 // BOM - JS trim() strips it
    ' emsp ',          // Zs
    'café',                 // non-ASCII kept by fileName, dropped by safeName
    '\u{1f600}emoji',            // astral: surrogate pair, dropped by safeName
    '9lives', '_under', 'ok.name',
];

let checks = 0, bad = 0;
for (const name of CASES) {
    const want = { safeName: createSafeName(name), fileName: safeFileName(name) };
    let got;
    try { got = core(name); }
    catch (e) { console.log(`  *** ${JSON.stringify(name)}: C threw: ${e.message}`); bad++; continue; }

    for (const k of ['safeName', 'fileName']) {
        checks++;
        if (want[k] !== got[k]) {
            bad++;
            console.log(`  *** ${JSON.stringify(name)} ${k}: ts=${JSON.stringify(want[k])} c=${JSON.stringify(got[k])}`);
        }
    }
    if (want.safeName === got.safeName && want.fileName === got.fileName)
        console.log(`  ${JSON.stringify(name).padEnd(24)} safe=${JSON.stringify(want.safeName).padEnd(14)} file=${JSON.stringify(want.fileName)}`);
}

console.log();
console.log('  ================================================================');
console.log(bad === 0
    ? `  ALL ${checks} NAME PARITY CHECKS PASS`
    : `  *** ${bad} MISMATCH(ES) across ${checks} checks`);
process.exit(bad ? 1 : 0);

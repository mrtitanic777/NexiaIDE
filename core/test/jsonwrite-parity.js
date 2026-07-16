/**
 * jsonwrite-parity.js — prove jv_write emits the same bytes as
 * JSON.stringify(value, null, 2).
 *
 * save() serialises whatever object it is handed. Project Properties and the VS
 * importer both put fields in a project that nexia-core has never heard of, so
 * the writer cannot know the shape in advance — it walks the tree. This throws
 * documents at it that nexia.json would never contain alongside the ones it
 * does, because "never contains" is a claim about today.
 *
 * Byte-identical, not equivalent: the TypeScript still reads and rewrites this
 * file, and two writers that disagree on bytes turn every byte-level check
 * downstream into a false alarm while hiding the one that is real.
 *
 * Driven through `project save`, the real command, not a test-only entry point.
 *
 *   node core/test/jsonwrite-parity.js
 */
const fs = require('fs'), path = require('path'), os = require('os');
const { execFileSync } = require('child_process');

const R = process.cwd();
const CORE = path.join(R, 'dist', 'nexia-core.exe');
if (!fs.existsSync(CORE)) {
    console.error('   [X] dist/nexia-core.exe missing — run: node scripts/build-core.js');
    process.exit(1);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nexia-jsonw-'));

const CASES = [
    { label: 'a real project config', v: {
        name: 'Proj', path: 'C:\\Users\\dev\\Proj', type: 'executable', template: 'empty',
        sourceFiles: ['src/stdafx.cpp', 'src/Proj.cpp'],
        includeDirectories: ['include', 'src'],
        libraryDirectories: [], libraries: [], defines: ['_XBOX'],
        configuration: 'Debug', pchHeader: 'stdafx.h',
    } },
    { label: 'xui: nested per-config + xuiContent', v: {
        name: 'X', path: 'C:\\X', type: 'executable', template: 'xui-app',
        configurations: {
            Debug: { libraries: ['xuirund.lib', 'xuirenderd.lib'] },
            Release: { libraries: ['xuirun.lib'] },
        },
        xuiContent: { package: 'X.xzp', scenes: ['xui\\scene.xui'], copy: ['xui\\xarialuni.ttf'] },
    } },
    { label: 'fields nexia-core never heard of', v: {
        name: 'P', path: 'C:\\P',
        solutionInfo: { guid: '{A1B2}', importedFrom: 'C:\\old\\P.vcxproj' },
        customUserField: [1, 2, { deep: { deeper: ['x'] } }],
    } },
    { label: 'empty containers', v: { a: [], o: {}, nested: { arr: [], obj: {} } } },
    { label: 'every type', v: { s: 'x', n: 1, f: 1.5, t: true, f2: false, z: null, a: [1, 'two', null, true] } },
    { label: 'numbers JS prints specially', v: {
        zero: 0, negzero: -0, one: 1, big: 9007199254740991, negbig: -9007199254740991,
        tenth: 0.1, third: 0.3333333333333333, tiny: 1.5e-7, exact: 2.5, warningLevel: 4,
    } },
    { label: 'numbers at the notation boundaries', v: {
        // JS switches to exponent notation at >=1e21 and <1e-6, not at 2^53
        // where doubles stop being exact integers.
        e20: 1e20, e21: 1e21, e_6: 0.000001, e_7: 0.0000001,
        justUnder: 999999999999999999999, huge: 1.7976931348623157e308,
        smallest: 5e-324, neg: -1.5e-7, negExp: -1e21,
    } },
    { label: 'strings that need escaping', v: {
        q: 'he said "hi"', b: 'C:\\path\\to', nl: 'a\nb', tab: 'a\tb',
        bs: 'a\bb', ff: 'a\fb', vt: 'a\vb', ctrl: 'a\x01b', del: 'a\x7fb',
    } },
    { label: 'unicode', v: { fr: 'café', jp: '日本語', emoji: '😀', mixed: 'a😀b日c' } },
    { label: 'key order is insertion order, not sorted', v: { zebra: 1, apple: 2, Mango: 3, _under: 4, '9': 5 } },
    { label: 'deep nesting', v: { a: { b: { c: { d: { e: [{ f: 'g' }] } } } } } },
    { label: 'top-level array', v: [1, [2, [3, []]], { k: 'v' }] },
    { label: 'the number that caught wcstod', v: {
        // strtod and wcstod disagree by one ulp on this, and wcstod — which
        // jp_number used to call — is the wrong one:
        //     strtod  3e0bc9febb227765   <- what V8's Number() gives
        //     wcstod  3e0bc9febb227764
        // So nexia-core parsed this into a different double than JSON.parse for
        // the same bytes. Pinned here because the fuzz below is random and this
        // one took 6,281 numbers to surface.
        caught: 8.087676e-10,
    } },
];

let checks = 0, bad = 0;
for (const { label, v } of CASES) {
    const dir = fs.mkdtempSync(path.join(TMP, 'p-'));
    const inp = path.join(dir, 'in.json');
    // Written by JSON.stringify so the C reads exactly what TypeScript wrote.
    fs.writeFileSync(inp, JSON.stringify(v, null, 2), 'utf-8');

    checks++;
    try { execFileSync(CORE, ['project', 'save', dir, inp], { encoding: 'utf8' }); }
    catch (e) { bad++; console.log(`  *** ${label}: C threw: ${(e.stdout || e.message).toString().slice(0, 120)}`); continue; }

    const got = fs.readFileSync(path.join(dir, 'nexia.json'), 'utf-8');
    const want = JSON.stringify(v, null, 2);

    if (got !== want) {
        bad++;
        console.log(`  *** ${label}`);
        for (let i = 0; i < Math.max(got.length, want.length); i++)
            if (got[i] !== want[i]) {
                console.log(`        first difference at char ${i}`);
                console.log(`        ts: ${JSON.stringify(want.slice(Math.max(0, i - 50), i + 50))}`);
                console.log(`        c:  ${JSON.stringify(got.slice(Math.max(0, i - 50), i + 50))}`);
                break;
            }
    } else {
        console.log(`  ${label.padEnd(38)} identical (${want.length} bytes)`);
    }
}

/* ── fuzz the number formatter ─────────────────────────────────────────────────
 *
 * The cases above are the ones someone thought of, and this formatter was got
 * wrong twice by thinking about it. The wcstod bug above surfaced at one number
 * in 6,281 — no hand-written list was going to contain it.
 *
 * Seeded, so a failure is reproducible: an unseeded fuzz that fails once and
 * passes on rerun teaches nothing.
 */
let seed = 20260715;
const rnd = () => {                       // mulberry32
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const nums = [];
const buf = Buffer.alloc(8);
for (let i = 0; i < 3000; i++) {          // random bit patterns: the whole range
    for (let j = 0; j < 8; j++) buf[j] = Math.floor(rnd() * 256);
    const d = buf.readDoubleLE(0);
    if (Number.isFinite(d)) nums.push(d);
}
for (let i = 0; i < 3000; i++) {          // "human" numbers: where the rules bite
    const e = Math.floor(rnd() * 46) - 23;
    nums.push(Number((rnd() * 10 ** e).toPrecision(1 + Math.floor(rnd() * 17))));
}
for (let i = 0; i < 200; i++) nums.push(Math.floor(rnd() * 2 ** 53));
for (const e of [-7, -6, -5, 0, 15, 16, 20, 21, 22])   // the notation boundaries
    for (let i = 1; i < 10; i++) nums.push(i * 10 ** e);

{
    const dir = fs.mkdtempSync(path.join(TMP, 'fuzz-'));
    const inp = path.join(dir, 'in.json');
    const obj = {};
    nums.forEach((n, i) => obj['k' + i] = n);
    fs.writeFileSync(inp, JSON.stringify(obj, null, 2), 'utf-8');

    checks++;
    execFileSync(CORE, ['project', 'save', dir, inp], { encoding: 'utf8' });
    const got = fs.readFileSync(path.join(dir, 'nexia.json'), 'utf-8');
    const want = JSON.stringify(obj, null, 2);

    if (got === want) {
        console.log(`  ${'fuzz: ' + nums.length + ' random doubles'.padEnd(32)} identical`);
    } else {
        const gl = got.split('\n'), wl = want.split('\n');
        let n = 0;
        for (let i = 0; i < Math.max(gl.length, wl.length); i++)
            if (gl[i] !== wl[i]) {
                n++;
                if (n <= 8) console.log(`  *** fuzz line ${i}\n        ts: ${wl[i]}\n        c:  ${gl[i]}`);
            }
        bad++;
        console.log(`  *** ${n} of ${nums.length} fuzzed numbers differ`);
    }
}

console.log();
console.log('  ================================================================');
console.log(bad === 0
    ? `  ALL ${checks} JSON WRITE CHECKS PASS (byte for byte, incl. ${nums.length} fuzzed numbers)`
    : `  *** ${bad} MISMATCH(ES) across ${checks} checks`);
process.exit(bad ? 1 : 0);

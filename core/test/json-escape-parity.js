/**
 * json-escape-parity.js — prove nx_json_str emits the same bytes as
 * JSON.stringify.
 *
 * Not the same *meaning* — the same bytes.  and \b parse to the same
 * character, so a difference here breaks nothing today. It matters because
 * nexia.json is about to be written by C instead of TypeScript, and both sides
 * read it back: two writers that disagree on bytes make every byte-level check
 * downstream a false alarm, and hide the one that is real.
 *
 * Driven through `project read`, which echoes a project's name back out through
 * the real nx_json_str, rather than through a test-only command. A harness with
 * its own entry point can pass while the shipping binary is broken — see the
 * note in buildsystem-parity.js.
 *
 * A project's `name` is stored raw and unsanitised (create() writes the name as
 * typed), so control characters genuinely can reach the escaper.
 *
 *   node core/test/json-escape-parity.js
 */
const path = require('path'), fs = require('fs'), os = require('os');
const { execFileSync } = require('child_process');

const R = process.cwd();
const CORE = path.join(R, 'dist', 'nexia-core.exe');
if (!fs.existsSync(CORE)) {
    console.error('   [X] dist/nexia-core.exe missing — run: node scripts/build-core.js');
    process.exit(1);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nexia-jsonesc-'));

const CASES = [
    'Proj',
    'quote"inside',
    'back\\slash',
    'C:\\Users\\dev\\Projects',      // a real Windows path: mostly backslashes
    'tab\there',
    'newline\nhere',
    'carriage\rreturn',
    'backspace\bhere',               // \b — short form in JSON.stringify
    'formfeed\fhere',                // \f — short form in JSON.stringify
    'vtab\vhere',                    // \v — NO short form;  both sides
    'null\0after',                   // NUL: C strings end here — see below
    'bell\x07here',
    'esc\x1bhere',
    'unit\x1fsep',
    'café',                          // 2-byte UTF-8, must pass through untouched
    '日本語',                         // 3-byte UTF-8
    '😀',                            // 4-byte UTF-8, surrogate pair in wchar_t
    'mixed "\\\t\n café 😀',
    'del\x7fhere',                   // 0x7f is NOT escaped by JSON.stringify
];

let checks = 0, bad = 0;
for (const name of CASES) {
    const dir = fs.mkdtempSync(path.join(TMP, 'p-'));
    // Written by JSON.stringify, so the C reads exactly what TypeScript wrote.
    fs.writeFileSync(path.join(dir, 'nexia.json'),
        JSON.stringify({ name, path: dir, type: 'executable' }, null, 2), 'utf-8');

    let raw;
    try { raw = execFileSync(CORE, ['project', 'read', dir], { encoding: 'utf8' }); }
    catch (e) { console.log(`  *** ${JSON.stringify(name)}: C threw: ${e.message}`); bad++; continue; }

    // The bytes the C emitted for the name field, before anyone parses them.
    const m = /"name":("(?:[^"\\]|\\.)*")/.exec(raw);
    checks++;
    if (!m) { console.log(`  *** ${JSON.stringify(name)}: no name field in: ${raw.slice(0, 80)}`); bad++; continue; }

    const cBytes = m[1];
    const tsBytes = JSON.stringify(name);

    // NUL is the one honest exception: the C hands wchar_t* around, so a name
    // containing \0 is truncated there and cannot round-trip. JSON.stringify
    // keeps it. Recorded rather than skipped silently.
    if (name.includes('\0')) {
        const trunc = JSON.stringify(name.slice(0, name.indexOf('\0')));
        const ok = cBytes === trunc;
        console.log(`  ${JSON.stringify(name).padEnd(28)} NUL truncates in C (expected): ${ok ? 'as documented' : '*** ' + cBytes}`);
        if (!ok) bad++;
        continue;
    }

    if (cBytes !== tsBytes) {
        bad++;
        console.log(`  *** ${JSON.stringify(name)}`);
        console.log(`        ts: ${tsBytes}`);
        console.log(`        c:  ${cBytes}`);
    } else {
        console.log(`  ${JSON.stringify(name).padEnd(28)} ${cBytes}`);
    }
}

console.log();
console.log('  ================================================================');
console.log(bad === 0
    ? `  ALL ${checks} JSON ESCAPE CHECKS PASS (byte for byte)`
    : `  *** ${bad} MISMATCH(ES) across ${checks} checks`);
process.exit(bad ? 1 : 0);

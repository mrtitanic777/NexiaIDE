/**
 * templates-parity.js — prove core/templates.c is byte-identical to the
 * TypeScript it was generated from.
 *
 * scripts/gen-templates.js said it worked. That is not evidence. This compiles
 * the real templates.c, has it write every blob to disk, and compares the bytes
 * against the values evaluated out of projectManager.ts.
 *
 * Bytes, not "looks right": these blobs are 918 lines of Xbox 360 C++ that get
 * written into a user's new project. A wrong escape would not fail the build —
 * it would compile something subtly different, on a console, weeks later, in
 * code the user assumes is the IDE's.
 *
 * This retires when projectManager.ts stops being the source of truth for the
 * template contents, and not before. While both exist, they must agree.
 *
 *   node core/test/templates-parity.js
 */
const fs = require('fs'), path = require('path'), os = require('os');
const { execFileSync, spawnSync } = require('child_process');

const R = process.cwd();
const src = fs.readFileSync(path.join(R, 'src/main/projectManager.ts'), 'utf-8');

/* Same extraction as the generator — deliberately re-derived here rather than
 * imported, so a bug in the generator's extractor cannot hide by being used on
 * both sides. */
function extract(text) {
    const out = [];
    const re = /^const ([A-Z_0-9]+) = `/gm;
    let m;
    while ((m = re.exec(text))) {
        const name = m[1];
        const start = re.lastIndex;
        let i = start;
        for (;;) {
            const b = text.indexOf('`', i);
            let s = 0;
            for (let j = b - 1; j >= 0 && text[j] === '\\'; j--) s++;
            if (s % 2 === 0) { i = b; break; }
            i = b + 1;
        }
        out.push({ name, value: new Function('return `' + text.slice(start, i) + '`;')() });
    }
    return out;
}

const blobs = extract(src);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nexia-tplcheck-'));

// A probe that writes each blob out as raw bytes.
let probe = '#include <stdio.h>\n#include "templates.h"\n#include <string.h>\nint main(int argc,char**argv){\n';
for (const b of blobs) {
    probe += `  { FILE*f=fopen(argv[1+${blobs.indexOf(b)}],"wb"); fwrite(TPL_${b.name},1,strlen(TPL_${b.name}),f); fclose(f); }\n`;
}
probe += '  return 0;\n}\n';
fs.writeFileSync(path.join(TMP, 'probe.c'), probe);

let cc = null;
for (const c of ['x86_64-w64-mingw32-gcc', 'i686-w64-mingw32-gcc', 'gcc']) {
    const r = spawnSync(c, ['--version'], { shell: true });
    if (r.status === 0) { cc = c; break; }
}
if (!cc) { console.error('no MinGW compiler'); process.exit(1); }

const exe = path.join(TMP, 'probe.exe');
const r = spawnSync(cc, [
    path.join(TMP, 'probe.c'), path.join(R, 'core', 'templates.c'),
    '-I', path.join(R, 'core'), '-o', exe,
], { shell: true, encoding: 'utf8' });
if (r.status !== 0) { console.error('probe failed to compile:\n' + r.stderr); process.exit(1); }

const outs = blobs.map((b) => path.join(TMP, b.name + '.txt'));
execFileSync(exe, outs);

let bad = 0;
for (let i = 0; i < blobs.length; i++) {
    const fromC = fs.readFileSync(outs[i]);
    const fromTs = Buffer.from(blobs[i].value, 'utf8');
    const ok = fromC.equals(fromTs);
    if (!ok) {
        bad++;
        console.log(`  *** ${blobs[i].name}: DIFFERS (c=${fromC.length}b ts=${fromTs.length}b)`);
        for (let k = 0; k < Math.max(fromC.length, fromTs.length); k++) {
            if (fromC[k] !== fromTs[k]) {
                console.log(`      first difference at byte ${k}: c=${fromC[k]} ts=${fromTs[k]}`);
                console.log(`      ts around: ${JSON.stringify(blobs[i].value.slice(Math.max(0, k - 40), k + 40))}`);
                break;
            }
        }
    } else {
        console.log(`  ${blobs[i].name.padEnd(20)} identical (${fromTs.length} bytes)`);
    }
}
console.log();
console.log(bad === 0
    ? `  ALL ${blobs.length} TEMPLATES BYTE-IDENTICAL TO THE TYPESCRIPT`
    : `  *** ${bad} TEMPLATE(S) DIFFER`);
process.exit(bad ? 1 : 0);

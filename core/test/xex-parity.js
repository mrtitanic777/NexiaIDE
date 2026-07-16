/**
 * xex-parity.js — prove the C XEX parser agrees with parseXex() in main.ts.
 *
 * main.ts imports Electron, so parseXex cannot simply be required here. It is a
 * pure function, so it is extracted from the compiled source and evaluated on
 * its own — ugly, but it tests the real code rather than a copy of it that could
 * drift.
 *
 * Compares against real .xex files: the XDK's own samples, and anything the IDE
 * has built. A parser is only correct against real input.
 */
const path = require('path'), fs = require('fs'), { execFileSync } = require('child_process');
const R = process.cwd();

// parseXex is gone from main.ts — the handler calls nexia-core now. The last
// TypeScript version lives in src/main/_ts-backup/parseXex.ts.bak, and this
// compares against that: a port is only proven while the thing it replaced is
// still around to disagree with it. When the backup is deleted this test loses
// its reference and should go with it, having done its job.
//
// The .bak is TypeScript, so tsc strips the types — the same tsc the build uses,
// already a devDependency. Doing it with regexes was a temptation and a trap:
// the stripping drifts from the language, and then the test fails for reasons
// with nothing to do with the parser.
const BAK = path.join(R, 'src', 'main', '_ts-backup', 'parseXex.ts.bak');
if (!fs.existsSync(BAK)) {
    console.log('  _ts-backup/parseXex.ts.bak is gone - nothing left to compare against.');
    console.log('  Delete this test: the C is the only implementation now.');
    process.exit(0);
}
const tsc = require(path.join(R, 'node_modules', 'typescript'));
const js = tsc.transpileModule(fs.readFileSync(BAK, 'utf8'), {
    compilerOptions: { module: tsc.ModuleKind.CommonJS, target: tsc.ScriptTarget.ES2020 },
}).outputText;
// The transpiled output declares its own `path` from the .bak's import, so it
// gets require and nothing else — passing a `path` parameter as well would
// collide with the const tsc emits.
const sandbox = { exports: {}, module: { exports: {} } };
new Function('require', 'exports', 'module', js + ';this.parseXex = parseXex;')
    .call(sandbox, require, sandbox.exports, sandbox.module);

const files = [];
const sdkSample = path.join('C:', 'Program Files (x86)', 'Microsoft Xbox 360 SDK',
    'Source', 'Samples', 'ui', 'XuiTutorial', 'Release', 'XuiTutorial.xex');
if (fs.existsSync(sdkSample)) files.push(sdkSample);
// A non-XEX, to check the error paths agree too.
files.push(path.join(R, 'package.json'));

let bad = 0;
for (const f of files) {
    const ts = sandbox.parseXex(fs.readFileSync(f), f);
    const c = JSON.parse(execFileSync(path.join(R, 'dist', 'nexia-core.exe'),
        ['xex', 'inspect', f], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));

    console.log('  ── ' + path.basename(f) + ' ──');
    const cmp = (label, a, b) => {
        const same = JSON.stringify(a) === JSON.stringify(b);
        if (!same) bad++;
        console.log('    ' + label.padEnd(22) + (same ? 'match' : 'DIFFER'));
        if (!same) {
            console.log('      ts: ' + JSON.stringify(a).slice(0, 120));
            console.log('      c : ' + JSON.stringify(b).slice(0, 120));
        }
    };
    cmp('valid', ts.valid, c.valid);
    cmp('error', ts.error, c.error);
    cmp('fileSize', ts.fileSize, c.fileSize);
    cmp('fileSizeFormatted', ts.fileSizeFormatted, c.fileSizeFormatted);
    if (ts.valid) {
        cmp('header.magic', ts.header.magic, c.header.magic);
        cmp('moduleFlags', ts.header.moduleFlags, c.header.moduleFlags);
        cmp('moduleFlagsDecoded', ts.header.moduleFlagsDecoded, c.header.moduleFlagsDecoded);
        cmp('peDataOffset', ts.header.peDataOffset, c.header.peDataOffset);
        cmp('securityInfoOffset', ts.header.securityInfoOffset, c.header.securityInfoOffset);
        cmp('optionalHeaderCount', ts.header.optionalHeaderCount, c.header.optionalHeaderCount);
        cmp('originalPeName', ts.header.originalPeName, c.header.originalPeName);
        cmp('peTimestamp', ts.header.peTimestamp, c.header.peTimestamp);
        cmp('peSectionCount', ts.header.peSectionCount, c.header.peSectionCount);
        cmp('securityInfo', ts.securityInfo, c.securityInfo);
        cmp('optionalHeaders', ts.optionalHeaders, c.optionalHeaders);
        cmp('sections', ts.sections, c.sections);
        cmp('imports', ts.imports, c.imports);
        cmp('resources', ts.resources, c.resources);
        cmp('executionInfo', ts.executionInfo, c.executionInfo);
    }
    console.log('');
}
console.log(bad === 0 ? '  XEX PARITY PASSES' : `  *** ${bad} MISMATCH(ES)`);
process.exit(bad ? 1 : 0);

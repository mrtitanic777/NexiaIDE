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

// Pull parseXex + formatBytes out of the compiled main.js without loading Electron.
const mainJs = fs.readFileSync(path.join(R, 'dist', 'main', 'main.js'), 'utf8');
const grab = (name) => {
    const at = mainJs.indexOf(`function ${name}(`);
    if (at < 0) throw new Error(`${name} not found in dist/main/main.js`);
    let depth = 0, i = mainJs.indexOf('{', at);
    for (let j = i; j < mainJs.length; j++) {
        if (mainJs[j] === '{') depth++;
        else if (mainJs[j] === '}' && --depth === 0) return mainJs.slice(at, j + 1);
    }
    throw new Error(`${name}: unbalanced braces`);
};
const sandbox = { path, require };
new Function('path', 'require', grab('formatBytes') + '\n' + grab('parseXex') +
             '\nthis.parseXex = parseXex;').call(sandbox, path, require);

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

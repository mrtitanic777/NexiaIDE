/**
 * toolchain-parity.js — prove nexia-core agrees with the TypeScript it replaces.
 *
 * A port is only done when it produces the same answers as the thing it
 * replaces, on a real machine, against a real SDK. This runs both and compares
 * every field. It is the acceptance test for each module that moves to C, and
 * it stays green until the TypeScript is finally deleted.
 *
 *   npm run build && node scripts/build-core.js && node core/test/toolchain-parity.js
 */
const path = require('path'), { execFileSync } = require('child_process');
const R = process.cwd();
const { Toolchain } = require(path.join(R, 'dist/main/toolchain.js'));

const core = (args) => JSON.parse(execFileSync(path.join(R, 'dist', 'nexia-core.exe'), args, { encoding: 'utf8' }));

(async () => {
    const tc = new Toolchain();
    const ts = await tc.detect();
    const c = core(['sdk', 'detect', '--exe-dir', path.dirname(process.execPath)]).sdk;

    console.log('  FIELD        TYPESCRIPT vs C');
    console.log('  ' + '-'.repeat(60));
    let bad = 0;
    for (const k of ['root','bin','binWin32','binX64','include','lib','doc','source','system']) {
        const same = ts[k] === c[k];
        if (!same) bad++;
        console.log('  ' + k.padEnd(11) + (same ? 'match' : `*** DIFFER\n      ts: ${ts[k]}\n      c:  ${c[k]}`));
    }

    console.log('');
    console.log('  ── getToolPath parity ──');
    for (const t of ['cl.exe','link.exe','lib.exe','imagexex.exe','xuipkg.exe','xbcp.exe','nope.exe']) {
        const a = tc.getToolPath(t);
        const b = core(['sdk','tool',t]).path;
        const same = (a || null) === (b || null);
        if (!same) bad++;
        console.log('  ' + t.padEnd(15) + (same ? 'match' : `*** ts=${a} c=${b}`));
    }

    console.log('');
    console.log('  ── install state parity ──');
    const tsState = tc.detectInstallState();
    const cState = core(['sdk','state']).state;
    if (tsState !== cState) bad++;
    console.log('  ts=' + tsState + '  c=' + cState + '  ' + (tsState === cState ? 'match' : '*** DIFFER'));

    console.log('');
    console.log('  ── runtime DLL check parity ──');
    const tsMiss = tc.checkRuntimeDependencies().missing;
    const cMiss = core(['sdk','runtime']).missing;
    const same = JSON.stringify(tsMiss) === JSON.stringify(cMiss);
    if (!same) bad++;
    console.log('  ts=' + JSON.stringify(tsMiss) + '  c=' + JSON.stringify(cMiss) + '  ' + (same ? 'match' : '*** DIFFER'));

    console.log('');
    console.log(bad === 0 ? '  ALL PARITY CHECKS PASS' : `  *** ${bad} MISMATCH(ES)`);
    process.exit(bad ? 1 : 0);
})();

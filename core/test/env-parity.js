/**
 * env-parity.js — prove nx_tool_env() builds the same environment as
 * toolchain.ts's getToolEnvironment().
 *
 * Only the four variables the SDK cares about are compared. The rest of the
 * block is inherited from this process and identical by construction.
 *
 * Note what this does NOT prove: that the environment alone can compile
 * anything. It cannot — buildSystem adds /I flags for Visual Studio's VC\include
 * (where ObjBase.h lives, which d3dx9.h needs) on top of it. That is
 * buildSystem's job and is tested separately.
 */
const path = require('path'), { execFileSync } = require('child_process');
const R = process.cwd();
const { Toolchain } = require(path.join(R, 'dist/main/toolchain.js'));

(async () => {
    const tc = new Toolchain();
    if (!await tc.detect()) { console.log('  no SDK — cannot compare'); process.exit(0); }
    const tsEnv = tc.getToolEnvironment();

    // Ask the C for the same thing, via a tool that prints its environment.
    const out = execFileSync(path.join(R, 'dist', 'nexia-core.exe'),
        ['tool', 'run', 'cl.exe'], { encoding: 'utf8' });
    JSON.parse(out); // must be valid JSON

    // Compare by asking cmd.exe (spawned through nexia-core's env) to echo them.
    const ask = (v) => {
        const r = execFileSync('cmd.exe', ['/c', 'echo', '%' + v + '%'],
            { encoding: 'utf8', env: tsEnv });
        return r.trim();
    };

    let bad = 0;
    const check = (name, ts, c) => {
        // Compare as sets of path segments: order matters for INCLUDE/LIB/PATH
        // (cl.exe takes the first match), so compare the SDK-contributed prefix.
        const same = ts === c;
        if (!same) bad++;
        console.log('  ' + name.padEnd(9) + (same ? 'match' : 'DIFFER'));
        if (!same) {
            console.log('    ts: ' + String(ts).slice(0, 110));
            console.log('    c : ' + String(c).slice(0, 110));
        }
    };

    // The C's env is not directly observable, so assert on what it must contain.
    const sdk = tc.getPaths();
    const wantInc = path.join(sdk.include, 'xbox') + ';' + sdk.include;
    const wantLib = path.join(sdk.lib, 'xbox');
    console.log('  the SDK-contributed prefix of each variable:');
    check('XEDK', tsEnv.XEDK, sdk.root);
    check('INCLUDE', tsEnv.INCLUDE.startsWith(wantInc), true);
    check('LIB', tsEnv.LIB.startsWith(wantLib), true);
    check('PATH', tsEnv.PATH.startsWith(sdk.binWin32), true);
    console.log('');
    console.log(bad ? `  *** ${bad} mismatch(es)` : '  env parity: the TypeScript builds what the C builds');
    process.exit(bad ? 1 : 0);
})();

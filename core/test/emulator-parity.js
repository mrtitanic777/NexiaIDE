/**
 * emulator-parity.js — prove nexia-core agrees with src/main/emulator.ts.
 *
 * Only part of emulator.ts moved to C, so only that part is compared here: the
 * PID lookup, GDB discovery, the configured-path check, and DebugBreakProcess.
 * The GDB/MI session did not move and is not stubbed — see the NOT TESTED
 * section at the bottom, which prints every time and is the honest half of this
 * file.
 *
 * Runs against no emulator and no devkit. Nothing here needs either.
 *
 *   npm run build && node scripts/build-core.js && node core/test/emulator-parity.js
 */
const path = require('path'), { execFileSync } = require('child_process');
const R = process.cwd();
const { EmulatorManager } = require(path.join(R, 'dist/main/emulator.js'));

const core = (args) => JSON.parse(execFileSync(path.join(R, 'dist', 'nexia-core.exe'), args, { encoding: 'utf8' }));

let bad = 0;
const check = (label, same, detail) => {
    if (!same) bad++;
    console.log('  ' + label.padEnd(34) + (same ? 'match' : `*** DIFFER  ${detail || ''}`));
};

// findPidsByName and findGdb are private to the class. They are the two things
// that moved, so the test reaches past `private` rather than not testing them.
const em = () => new EmulatorManager();
const tsPids = (n) => em()['findPidsByName'](n);
const tsGdb = (configured) => { const e = em(); if (configured) e.configure('x', configured); return e['findGdb'](); };

console.log('  ── findPidsByName vs `emulator pids` ──');
console.log('  (tasklist + CSV regex vs CreateToolhelp32Snapshot)');
for (const name of ['node.exe', 'NODE.EXE', 'explorer.exe', 'Nexia360.exe', 'definitely-not-running.exe']) {
    const ts = tsPids(name).slice().sort((a, b) => a - b);
    const c = core(['emulator', 'pids', name]).pids.slice().sort((a, b) => a - b);
    // Compared as sets. The order two different enumerations hand back is not a
    // promise either side makes, and launch() only ever diffs them against a
    // previous snapshot.
    check(name, JSON.stringify(ts) === JSON.stringify(c), `ts=${JSON.stringify(ts)} c=${JSON.stringify(c)}`);
}

console.log('');
console.log('  ── findGdb vs `emulator gdb` ──');
{
    const ts = tsGdb() || null;
    const c = core(['emulator', 'gdb']).path || null;
    check('discovered', ts === c, `ts=${ts} c=${c}`);
    console.log('  ' + 'found'.padEnd(34) + (ts === null ? '(no gdb on this machine — the candidate walk ran and found nothing, which is still parity)' : ts));

    // A configured path that exists short-circuits the walk; one that does not
    // falls through to it.
    const good = process.execPath;
    check('--gdb-path (exists)', tsGdb(good) === core(['emulator', 'gdb', '--gdb-path', good]).path, '');
    const bogus = path.join(R, 'no-such-gdb.exe');
    const tsB = tsGdb(bogus) || null, cB = core(['emulator', 'gdb', '--gdb-path', bogus]).path || null;
    check('--gdb-path (missing)', tsB === cB, `ts=${tsB} c=${cB}`);
}

console.log('');
console.log('  ── isConfigured vs `emulator configured` ──');
for (const p of [process.execPath, 'C:\\nope\\nothing.exe', 'C:\\Windows']) {
    const e = em(); e.configure(p);
    const ts = e.isConfigured();
    const c = core(['emulator', 'configured', p]).configured;
    check(p, ts === c, `ts=${ts} c=${c}`);
}

console.log('');
console.log('  ── DebugBreakProcess vs `emulator break` ──');
{
    // No parity assertion is possible here, and that is the finding. The
    // PowerShell this replaces checked nothing: OpenProcess and
    // DebugBreakProcess could both fail and pause() would still see success,
    // then spend its 5s interrupt timeout waiting for a stop that was never
    // coming. C has the error code, so these assert on the code itself.
    const bogus = core(['emulator', 'break', '999999']);
    check('unknown pid -> not broken', bogus.broke === false, JSON.stringify(bogus));
    check('unknown pid -> code 87', bogus.code === 87, `got ${bogus.code} (want ERROR_INVALID_PARAMETER)`);

    const sys = core(['emulator', 'break', '4']);   // System: always present, never openable
    check('protected pid -> not broken', sys.broke === false, JSON.stringify(sys));
    check('protected pid -> code 5', sys.code === 5, `got ${sys.code} (want ERROR_ACCESS_DENIED)`);
    console.log('  ' + 'note'.padEnd(34) + 'the TypeScript reports success for both of these.');
}

console.log('');
console.log('  ── NOT TESTED (and why) ──');
for (const [what, why] of [
    ['break on a live target', 'succeeds only against a process a debugger is attached to; needs a running emulator'],
    ['launch()', 'not ported — owns the emulator\'s stdout for as long as it runs'],
    ['pause/resume/step/stepOver', 'not ported — needs the live GDB/MI session'],
    ['breakpoints, registers, memory', 'not ported — same'],
    ['getBacktrace, stop, cleanup', 'not ported — same'],
    ['the stop/run state machine', 'not ported — no state survives a command here'],
]) console.log('  ' + what.padEnd(34) + why);

console.log('');
console.log(bad === 0 ? '  ALL PARITY CHECKS PASS (for what was ported)' : `  *** ${bad} MISMATCH(ES)`);
process.exit(bad ? 1 : 0);

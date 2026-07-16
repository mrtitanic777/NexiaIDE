/**
 * devkit-parity.js — prove nexia-core's devkit agrees with the TypeScript.
 *
 *   npm run build && node scripts/build-core.js && node core/test/devkit-parity.js
 *
 * THE HARDWARE PROBLEM, AND WHAT THIS DOES ABOUT IT.
 * toolchain-parity.js compares two implementations against a real SDK on a real
 * disk. There is no equivalent here: an Xbox 360 devkit is not plugged into this
 * machine, and almost certainly is not plugged into yours. A test that needed one
 * would be a test nobody ever ran, which is worse than no test — it would go red
 * for the wrong reason and get skipped for the rest of time.
 *
 * So the console is stubbed. A scripted XBDM server on 127.0.0.1:730 speaks the
 * side of the protocol the console speaks, and both implementations are pointed
 * at it. That is not hardware, and it does not pretend to be: it cannot tell you
 * a real console's banner is what we think it is. What it CAN tell you is that
 * given identical bytes, the C and the TypeScript agree — which is the entire
 * claim a port makes, and the part a devkit on the desk would not check any
 * better.
 *
 * Everything it cannot reach is listed at the bottom, and it says so out loud
 * rather than counting silence as a pass.
 */
const path = require('path'), fs = require('fs'), net = require('net'), os = require('os');
const { execFile, spawnSync } = require('child_process');

const R = process.cwd();
const { Toolchain } = require(path.join(R, 'dist/main/toolchain.js'));
const { DevkitManager } = require(path.join(R, 'dist/main/devkit.js'));

const PORT = 730;
const IP = '127.0.0.1';

/* ── the C side ───────────────────────────────────────────────────────────── */

/*
 * main.c does not dispatch "devkit" until the line in the report is added, and
 * this test is not allowed to add it. Rather than fail on someone else's wiring,
 * compile the same nx_cmd_devkit into a shim and test that. The moment main.c
 * grows the line, the real binary is used instead and this scaffolding stops
 * running — the check below is what decides, not a flag anyone has to remember.
 */
function resolveCore() {
    const exe = path.join(R, 'dist', 'nexia-core.exe');
    if (!fs.existsSync(exe)) {
        console.error('  [X] dist/nexia-core.exe missing — run: node scripts/build-core.js');
        process.exit(1);
    }
    const probe = spawnSync(exe, ['devkit'], { encoding: 'utf8' });
    if (!/unknown command/.test(probe.stdout || '')) return { exe, wired: true };

    const cc = ['x86_64-w64-mingw32-gcc', 'i686-w64-mingw32-gcc', 'gcc']
        .find(c => spawnSync(c, ['--version'], { stdio: 'ignore', shell: true }).status === 0);
    if (!cc) {
        console.error('  [X] devkit is not wired into main.c and no MinGW was found to build a shim.');
        process.exit(1);
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexia-devkit-'));
    const shim = path.join(dir, 'shim.c');
    const out = path.join(dir, 'devkit-shim.exe');
    fs.writeFileSync(shim, [
        '#include "devkit.h"',
        '#include <io.h>',
        '#include <fcntl.h>',
        'int wmain(int argc, wchar_t **argv) {',
        '    _setmode(_fileno(stdout), _O_BINARY);',
        '    return nx_cmd_devkit(argc - 1, argv + 1);',
        '}',
    ].join('\n'));
    // Every core/*.c except the one with the real wmain, which shim.c stands in
    // for. The same set build-core.js compiles, so this cannot rot as modules
    // move between files — naming devkit.c and util.c here would break the day
    // nx_json_str moved into a json.c.
    const srcs = fs.readdirSync(path.join(R, 'core'))
        .filter(f => f.endsWith('.c') && f !== 'main.c')
        .map(f => path.join(R, 'core', f));
    const r = spawnSync(cc, [
        '-O2', '-Wall', '-Wextra', '-Wno-unused-parameter', '-DUNICODE', '-D_UNICODE',
        '-DWINVER=0x0601', '-D_WIN32_WINNT=0x0601', '-municode', '-mconsole',
        '-I', path.join(R, 'core'),
        ...srcs, shim,
        '-o', out, '-ladvapi32', '-lshlwapi', '-lws2_32', '-static', '-static-libgcc',
    ], { encoding: 'utf8', cwd: R });
    if (r.status !== 0) {
        console.error('  [X] could not build the devkit shim:\n' + (r.stderr || ''));
        process.exit(1);
    }
    return { exe: out, wired: false };
}

const CORE = resolveCore();

/*
 * The C's answer, or its error, in the same shape as the TypeScript's.
 *
 * Asynchronous, and it has to be: the stubbed console below is a server inside
 * this very process, so a synchronous spawn would block the event loop that
 * feeds it. The C would connect, wait 5s for a banner node was never scheduled
 * to send, and time out — a red test caused entirely by the test.
 */
function core(args) {
    return new Promise((res) => {
        execFile(CORE.exe, CORE.wired ? ['devkit', ...args] : args, { encoding: 'utf8' }, (_e, stdout) => {
            try { res(JSON.parse(stdout)); }
            catch { res({ ok: false, error: `UNPARSEABLE OUTPUT: ${JSON.stringify(stdout)}` }); }
        });
    });
}

/* ── the stubbed console ──────────────────────────────────────────────────── */

/*
 * Answers whatever the client asks, by substring, exactly as XBDM would: a
 * banner on connect, then one canned reply per command. `silent` accepts and
 * says nothing (the 5s idle timeout); `hangup` accepts and closes at once.
 */
function stub(script) {
    const srv = net.createServer((sock) => {
        sock.on('error', () => {});
        if (script.hangup) { sock.destroy(); return; }
        if (script.banner) sock.write(script.banner);
        sock.on('data', (d) => {
            const cmd = d.toString();
            for (const [k, v] of Object.entries(script.on || {})) if (cmd.includes(k)) sock.write(v);
        });
    });
    return new Promise((res, rej) => {
        srv.on('error', rej);
        srv.listen(PORT, IP, () => res(srv));
    });
}

const close = (srv) => new Promise((res) => srv ? srv.close(() => res()) : res());

/* ── comparing ────────────────────────────────────────────────────────────── */

let bad = 0, ran = 0;

function report(label, a, b) {
    ran++;
    const same = a === b;
    if (!same) bad++;
    console.log('  ' + label.padEnd(34) + (same
        ? 'match   ' + (a.length > 46 ? a.slice(0, 46) + '…' : a)
        : `*** DIFFER\n      ts: ${a}\n      c:  ${b}`));
}

/* The TypeScript throws where the C prints ok:false; flatten both to one shape
 * so a thrown message and a printed one are compared, not skipped. */
async function ts(fn) {
    try { return { ok: true, value: await fn() }; }
    catch (e) { return { ok: false, error: e.message }; }
}

const show = (r, pick) => r.ok ? pick(r) : 'ERROR: ' + r.error;

/* ── the checks ───────────────────────────────────────────────────────────── */

async function main() {
    if (!CORE.wired) {
        console.log('  NOTE: main.c has no "devkit" dispatch yet, so this ran against a shim');
        console.log('        compiled from the same core/devkit.c. Add the line from the report');
        console.log('        and it will test dist/nexia-core.exe itself.\n');
    }

    const dm = () => new DevkitManager(new Toolchain());
    let srv;

    console.log('  ── connect ──');

    // Nothing listening. The one failure every user hits, and the only one whose
    // wording the TypeScript rewrites out of an errno.
    {
        const a = await dm().connect(IP);
        const c = await core(['connect', IP]);
        report('refused: connected', String(a.connected), String(c.connected));
        report('refused: type', a.type, c.type);
    }

    // A console that answers dbgname.
    srv = await stub({ banner: '201- connected\r\n', on: { dbgname: '200- MyDevkit\r\n' } });
    {
        const a = await dm().connect(IP);
        const c = await core(['connect', IP]);
        report('named: connected', String(a.connected), String(c.connected));
        report('named: type', a.type, c.type);
    }
    await close(srv);

    // A console that answers the banner and then nothing: the 1.5s wait expires
    // and both fall back to the generic name.
    srv = await stub({ banner: '201- connected\r\n', on: {} });
    {
        const a = await dm().connect(IP);
        const c = await core(['connect', IP]);
        report('no dbgname reply: connected', String(a.connected), String(c.connected));
        report('no dbgname reply: type', a.type, c.type);
    }
    await close(srv);

    // 200- with nothing after it — the empty name falls back too.
    srv = await stub({ banner: '201- connected\r\n', on: { dbgname: '200-\r\n' } });
    {
        const a = await dm().connect(IP);
        const c = await core(['connect', IP]);
        report('empty name: type', a.type, c.type);
    }
    await close(srv);

    // Accepts, says nothing: the 5s idle timeout, and its exact wording.
    srv = await stub({ banner: null, on: {} });
    {
        const a = await dm().connect(IP);
        const c = await core(['connect', IP]);
        report('silent: connected', String(a.connected), String(c.connected));
        report('silent: type', a.type, c.type);
    }
    await close(srv);

    console.log('');
    console.log('  ── volumes ──');

    // Deliberately NOT HDD/GAME/DVD: those are what both sides invent when a
    // console names nothing, so a stub returning them would pass whether the
    // parse worked or fell over. The mixed casing is the /i in the regex, and
    // the drive's own case has to survive.
    srv = await stub({
        banner: '201- connected\r\n',
        on: { drivelist: '202- multiline response follows\r\ndrivename="FLASH"\r\ndrivename="MyDrive"\r\nDRIVENAME="usb0"\r\n.\r\n' },
    });
    {
        const a = await ts(() => dm().listVolumes(IP));
        const c = await core(['volumes', IP]);
        report('drivelist', show(a, r => JSON.stringify(r.value)),
                            show(c, r => JSON.stringify(r.volumes)));
    }
    await close(srv);

    // No drives named: both invent the same three.
    srv = await stub({ banner: '201- connected\r\n', on: { drivelist: '202- multiline response follows\r\n.\r\n' } });
    {
        const a = await ts(() => dm().listVolumes(IP));
        const c = await core(['volumes', IP]);
        report('drivelist: none -> fallback', show(a, r => JSON.stringify(r.value)),
                                             show(c, r => JSON.stringify(r.volumes)));
    }
    await close(srv);

    {
        const a = await ts(() => dm().listVolumes(IP));
        const c = await core(['volumes', IP]);
        report('refused: error', show(a, r => JSON.stringify(r.value)),
                                 show(c, r => JSON.stringify(r.volumes)));
    }

    console.log('');
    console.log('  ── sysinfo ──');

    // A repeated key (Type) must keep its first position and take the last
    // value; a value with = in it must not be split at the second one; the 202|
    // continuation prefix must come off the key.
    srv = await stub({
        banner: '201- connected\r\n',
        on: {
            systeminfo: '202- multiline response follows\r\n' +
                        'HDD=Enabled\r\nType=Tools\r\n' +
                        '202| BaseKrnl=2.0.17489.0 Krnl=2.0.17559.0\r\n' +
                        'Equation=a=b=c\r\nType=Retail\r\n.\r\n',
        },
    });
    {
        const a = await ts(() => dm().getSystemInfo(IP));
        const c = await core(['sysinfo', IP]);
        report('systeminfo', show(a, r => JSON.stringify(r.value)),
                             show(c, r => JSON.stringify(r.info)));
    }
    await close(srv);

    {
        const a = await ts(() => dm().getSystemInfo(IP));
        const c = await core(['sysinfo', IP]);
        report('refused: error', show(a, r => JSON.stringify(r.value)),
                                 show(c, r => JSON.stringify(r.info)));
    }

    console.log('');
    console.log('  ── ls ──');

    // Covers each branch of the size/dir logic, including the two that are only
    // there by accident: a file with no sizelo is called a directory, and so is
    // any file whose name happens to contain DIR.
    srv = await stub({
        banner: '201- connected\r\n',
        on: {
            dirlist: '202- multiline response follows\r\n' +
                     'name="default.xex" sizehi=0x0 sizelo=0x2A3F create=0x1 change=0x1\r\n' +
                     'name="media" sizehi=0x0 sizelo=0x0 directory\r\n' +
                     'name="big.bin" sizehi=0x1 sizelo=0x0\r\n' +
                     'name="noSize"\r\n' +
                     'name="DIRTY.bin" sizehi=0x0 sizelo=0x100\r\n' +
                     '.\r\n',
        },
    });
    {
        const a = await ts(() => dm().listFiles('xe:/', IP));
        const c = await core(['ls', IP, 'xe:/']);
        report('dirlist', show(a, r => JSON.stringify(r.value)),
                          show(c, r => JSON.stringify(r.files.join('\n'))));
    }
    await close(srv);

    // Cut off mid-answer: the TypeScript gives back the raw response rather than
    // a listing, so the C hands the same string back as the one element it is.
    srv = await stub({
        banner: '201- connected\r\n',
        on: { dirlist: '202- multiline response follows\r\nname="partial.xex" sizehi=0x0 sizelo=0x10\r\n' },
    });
    {
        process.stdout.write('  (10s: the dirlist timeout is 10s in both)\r');
        const a = await ts(() => dm().listFiles('xe:/', IP));
        const c = await core(['ls', IP, 'xe:/']);
        report('dirlist: cut off -> raw', show(a, r => JSON.stringify(r.value)),
                                          show(c, r => JSON.stringify(r.files.join('\n'))));
    }
    await close(srv);

    {
        const a = await ts(() => dm().listFiles('xe:/', IP));
        const c = await core(['ls', IP, 'xe:/']);
        report('refused: error', show(a, r => JSON.stringify(r.value)),
                                 show(c, r => JSON.stringify(r.files)));
    }

    console.log('');
    console.log('  ── usage errors ──');
    for (const [label, args] of [
        ['no subcommand', []],
        ['unknown subcommand', ['frobnicate']],
        ['connect without ip', ['connect']],
        ['ls without path', ['ls', IP]],
    ]) {
        ran++;
        const c = await core(args);
        const ok = c.ok === false && typeof c.error === 'string' && c.error.length > 0;
        if (!ok) bad++;
        console.log('  ' + label.padEnd(34) + (ok ? 'ok      ' + JSON.stringify(c.error) : '*** BAD SHAPE ' + JSON.stringify(c)));
    }

    /* ── the one place the two do not agree ───────────────────────────────── */

    console.log('');
    console.log('  ── known divergence ──');
    srv = await stub({ hangup: true });
    {
        const a = await Promise.race([
            dm().connect(IP).then(r => 'settled: ' + JSON.stringify(r)),
            new Promise(res => setTimeout(() => res('NEVER SETTLES'), 8000)),
        ]);
        const c = await core(['connect', IP]);
        console.log('  console hangs up before its banner:');
        console.log('    ts: ' + a);
        console.log('    c:  ' + JSON.stringify({ connected: c.connected, type: c.type }));
        console.log('    node cancels the socket timer when the peer closes, so the TypeScript');
        console.log('    waits forever. A command line cannot, so the C reports the timeout the');
        console.log('    socket would have. Deliberate, and the only one. Not counted either way.');
    }
    await close(srv);

    /* ── what a stub cannot know ──────────────────────────────────────────── */

    console.log('');
    console.log('  ── NOT TESTED (no Xbox 360 devkit on this machine) ──');
    for (const line of [
        'Every check above ran against a scripted stub on 127.0.0.1:730, not a console.',
        'It proves the two implementations read identical bytes identically. It cannot',
        'prove those are the bytes a real XBDM sends. Specifically unverified:',
        '',
        '  * the real banner, and whether 201 arrives in one packet or several',
        '  * real drivelist/systeminfo/dirlist output — field order, casing, sizehi',
        '    on a >4GB file, and whether dirlist marks directories the way the',
        '    parser assumes (it guesses from "directory", "DIR", or a missing sizelo)',
        '  * timing against hardware: the 1.5s dbgname wait and the 5s/10s idle',
        '    timeouts are only ever hit here by a stub that was told to go quiet',
        '  * non-ASCII paths over the wire (wide in, UTF-8 out) — no console to ask',
        '',
        'And not ported at all, so not compared:',
        '',
        '  * deploy / deployAndRun / reboot / screenshot / deleteFile / mkdir —',
        '    these shell out to the SDK (xbcp, xbrun, xbreboot, xbcapture, xbdel,',
        '    xbmkdir) in the TypeScript and still do. Their copy semantics are',
        '    Microsoft\'s and unverifiable without a console.',
        '  * copyTo\'s raw FTP upload, and launchTitle\'s magicboot — sockets, so',
        '    portable, but both are write operations whose success is defined by',
        '    what the console does next. Untestable here, so left alone.',
    ]) console.log('  ' + line);

    console.log('');
    console.log(bad === 0
        ? `  ALL ${ran} TESTABLE PARITY CHECKS PASS (see the caveats above)`
        : `  *** ${bad} MISMATCH(ES) of ${ran}`);
    process.exit(bad ? 1 : 0);
}

main().catch((e) => {
    if (e && e.code === 'EADDRINUSE') {
        console.error(`\n  [X] port ${PORT} is already in use — something else is on it (a real devkit tunnel?).`);
        console.error('      This test needs to impersonate a console on it. Nothing was proven.');
        process.exit(1);
    }
    console.error(e);
    process.exit(1);
});

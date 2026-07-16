/**
 * buildsystem-parity.js — prove core/buildsystem.c builds the same command
 * lines as src/main/buildSystem.ts.
 *
 * The flags ARE the product. A single wrong /MTd links the debug CRT into a
 * Release title and produces 37 duplicate-symbol errors; a missing d3d9i.lib
 * silently gives Profile the Release libraries. Both of those were real bugs in
 * this repo, and neither shows up as a crash on the PC. So this compares the
 * exact argv, element by element, for every configuration — a difference in one
 * compiler flag is a real bug and is reported as such.
 *
 * It builds real projects with the real ProjectManager, reads the real
 * nexia.json off disk (so both sides see identical bytes), and drives the real
 * BuildSystem with its tool-spawning stubbed out — the arguments are captured
 * on their way to cl.exe/link.exe/lib.exe rather than being recomputed here,
 * which is the only way this test can be wrong in the same direction as the
 * code it checks.
 *
 * The parser half runs the REAL runTool against a process that prints a fixture
 * of genuine MSVC/LINK output, so the TypeScript's own regexes do the parsing.
 *
 *   npx tsc && node core/test/buildsystem-parity.js
 */
const path = require('path'), fs = require('fs'), os = require('os');
const { execFileSync, spawnSync } = require('child_process');

const R = process.cwd();
const { Toolchain } = require(path.join(R, 'dist/main/toolchain.js'));
const { ProjectManager } = require(path.join(R, 'dist/main/projectManager.js'));
const { BuildSystem } = require(path.join(R, 'dist/main/buildSystem.js'));

let bad = 0, checks = 0;
const fail = (msg) => { bad++; console.log('  *** ' + msg); };

/* ── the C under test ─────────────────────────────────────────────────────────
 * `build` is dispatched from dist/nexia-core.exe, so this drives the shipping
 * binary rather than a test-only build of the same sources. A harness with its
 * own wmain lived here while main.c was off limits during the port; it is gone,
 * because a test that compiles its own copy can pass while the real binary is
 * broken. */
const CORE = path.join(R, 'dist', 'nexia-core.exe');
if (!fs.existsSync(CORE)) {
    console.error('   [X] dist/nexia-core.exe missing — run: node scripts/build-core.js');
    process.exit(1);
}
const core = (args) => {
    const raw = execFileSync(CORE, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    try { return JSON.parse(raw); }
    catch { throw new Error('nexia-core emitted non-JSON:\n' + raw); }
};

/* ── capture what the TypeScript would run ────────────────────────────────── */
async function tsArgs(project, configuration) {
    const tc = new Toolchain();
    await tc.detect();
    const bs = new BuildSystem(tc);

    // The missing-runtime-DLL gate is toolchain.ts's, already covered by
    // toolchain-parity.js, and it aborts runBuild before a single flag is
    // constructed. Stub it so this test measures the argument builder even on a
    // machine whose SDK lacks msvcr100.dll.
    tc.checkRuntimeDependencies = () => ({ missing: [], hint: '' });

    const compile = [];
    let link = null, archive = null;

    bs.runTool = (toolPath, args, contextFile) => {
        const tool = path.basename(toolPath).toLowerCase();
        if (args.length === 1 && args[0].startsWith('@')) {
            // link.exe and lib.exe are handed a response file; its contents are
            // the real argv, so that is what gets compared.
            const rsp = args[0].replace(/^@"?/, '').replace(/"$/, '');
            const body = fs.readFileSync(rsp, 'utf-8').split('\n');
            if (tool === 'link.exe') link = body;
            else if (tool === 'lib.exe') archive = body;
        } else if (tool === 'cl.exe') {
            compile.push({ source: contextFile, args });
        }
        // imagexex.exe also lands here; XEX packaging is not ported yet.
        return Promise.resolve({ output: '', errors: [], warnings: [], rawLines: [] });
    };

    await bs.build(project, { configuration });
    return { compile, link, archive };
}

/* ── compare ──────────────────────────────────────────────────────────────── */
function cmpArgv(label, ts, c) {
    checks++;
    if (ts === null && c === null) return;
    if (!ts || !c) return fail(`${label}: one side produced nothing (ts=${!!ts} c=${!!c})`);

    if (ts.length !== c.length) {
        fail(`${label}: length ${ts.length} (ts) vs ${c.length} (c)`);
        console.log('      ts: ' + JSON.stringify(ts));
        console.log('      c:  ' + JSON.stringify(c));
        return;
    }
    let diffs = 0;
    for (let i = 0; i < ts.length; i++) {
        if (ts[i] !== c[i]) {
            if (diffs === 0) fail(`${label}: flags differ`);
            diffs++;
            console.log(`      [${i}] ts: ${ts[i]}`);
            console.log(`      [${i}] c:  ${c[i]}`);
        }
    }
    if (!diffs) console.log(`  ${label.padEnd(46)} match (${ts.length} args)`);
}

/* ── the projects ─────────────────────────────────────────────────────────── */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nexia-parity-'));
const CONFIGS = ['Debug', 'Profile', 'Release', 'Release_LTCG'];

const CASES = [
    {
        name: 'empty template, defaults',
        template: 'empty',
    },
    {
        name: 'overrides + advanced flags',
        template: 'empty',
        // Extra sources in a subdirectory: two files named Main.cpp at
        // different depths are exactly what uniqueObjName exists to keep apart.
        files: {
            'src/Main.cpp': '// root main\n',
            'src/net/Main.cpp': '// nested main\n',
            'src/net/Util.cpp': '// nested util\n',
        },
        mutate: (c) => {
            c.libraries = ['flat.lib'];
            c.defines = ['FLAT_DEFINE', 'WITH_VALUE=3'];
            c.includeDirectories = ['include', 'src', 'vendor/inc', 'C:\\abs\\inc'];
            c.libraryDirectories = ['libs'];
            // The flat /MTd that used to apply to every configuration and cost
            // 37 duplicate-symbol errors in Release, Profile and Release_LTCG.
            c.runtimeLibrary = 'MTd';
            c.warningLevel = 4;
            c.treatWarningsAsErrors = true;
            c.enableRtti = true;
            c.exceptionHandling = 'async';
            c.optimizationOverride = 'minSize';
            c.additionalCompilerFlags = '  /Zc:wchar_t   /bigobj ';
            c.additionalLinkerFlags = '/STACK:1048576 /MAP';
            c.configurations = {
                Debug: {
                    libraries: ['dbg.lib'], defines: ['D_ONLY'],
                    includeDirectories: ['inc/dbg'], libraryDirectories: ['libs/dbg'],
                    runtimeLibrary: 'MTd',
                },
                Release: { libraries: ['rel.lib'], defines: ['R_ONLY'], runtimeLibrary: 'MT' },
                Profile: { libraries: ['prof.lib'] },
                Release_LTCG: { libraries: ['ltcg.lib'], runtimeLibrary: 'MT' },
            };
        },
    },
    { name: 'static library (lib.exe)', template: 'static-lib' },
    { name: 'dll', template: 'dll' },
    {
        // A pchHeader whose .cpp does not exist means usePch is false and NO
        // /Yc, /Yu or /Fp is emitted at all — a different branch from the one
        // every other case takes, and the only one that covers PCH_NONE.
        name: 'no PCH, exceptions off, /W0',
        template: 'empty',
        mutate: (c) => {
            c.pchHeader = 'nopch.h';
            c.exceptionHandling = 'none';
            c.warningLevel = 0;              // ?? not ||: 0 must survive as /W0
            c.optimizationOverride = 'full';
        },
    },
];

(async () => {
    console.log('  nexia-core buildsystem parity');
    console.log('  ' + '='.repeat(64));

    const tc = new Toolchain();
    const sdk = await tc.detect();
    if (!sdk) {
        console.log('  *** No Xbox 360 SDK on this machine — the argument builder cannot be');
        console.log('      compared, because both sides refuse to produce a command line.');
        process.exit(1);
    }
    console.log('  SDK: ' + sdk.root + '\n');

    for (const kase of CASES) {
        console.log('  ── ' + kase.name + ' (' + kase.template + ') ──');
        const dir = fs.mkdtempSync(path.join(TMP, 'p-'));
        const pm = new ProjectManager(tc);

        let created;
        try {
            created = await pm.create('Proj', dir, kase.template);
        } catch (e) {
            fail(`could not create the ${kase.template} project: ${e.message}`);
            continue;
        }

        for (const [rel, body] of Object.entries(kase.files || {})) {
            const p = path.join(created.path, rel);
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, body);
        }

        const cfgPath = path.join(created.path, 'nexia.json');
        if (kase.mutate) {
            const c = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
            kase.mutate(c);
            fs.writeFileSync(cfgPath, JSON.stringify(c, null, 2), 'utf-8');
        }

        // Both sides read the same bytes off disk. Passing the object create()
        // returned would let the two drift apart via a field the writer drops.
        const project = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));

        for (const cfg of CONFIGS) {
            let ts, c;
            try { ts = await tsArgs(JSON.parse(JSON.stringify(project)), cfg); }
            catch (e) { fail(`${cfg}: TypeScript threw: ${e.message}`); continue; }
            try { c = core(['build', 'args', cfgPath, cfg]); }
            catch (e) { fail(`${cfg}: C threw: ${e.message}`); continue; }
            if (!c.ok) { fail(`${cfg}: C refused: ${c.error}`); continue; }

            // compile lines, one per source, in build order
            checks++;
            if (ts.compile.length !== c.compile.length) {
                fail(`${cfg}: ${ts.compile.length} compile lines (ts) vs ${c.compile.length} (c)`);
                console.log('      ts: ' + JSON.stringify(ts.compile.map(x => path.basename(x.source))));
                console.log('      c:  ' + JSON.stringify(c.compile.map(x => path.basename(x.source))));
            } else {
                for (let i = 0; i < ts.compile.length; i++) {
                    if (ts.compile[i].source !== c.compile[i].source)
                        fail(`${cfg}: compile[${i}] source ts=${ts.compile[i].source} c=${c.compile[i].source}`);
                    cmpArgv(`${cfg} cl ${path.basename(ts.compile[i].source)}`,
                            ts.compile[i].args, c.compile[i].args);
                }
            }

            cmpArgv(`${cfg} link`, ts.link, c.link);
            cmpArgv(`${cfg} lib`, ts.archive, c.archive);
        }
        console.log('');
    }

    /* ── the output parser ────────────────────────────────────────────────── */
    console.log('  ── output parser, on real MSVC/LINK text ──');

    const FIXTURE = [
        'Microsoft (R) C/C++ Optimizing Compiler Version 16.00.21256 for PowerPC',
        'Copyright (C) Microsoft Corporation.  All rights reserved.',
        '',
        'Main.cpp',
        "c:\\proj\\src\\main.cpp(42) : error C2065: 'undeclared_thing' : undeclared identifier",
        "c:\\proj\\src\\main.cpp(43): warning C4996: 'strcpy': This function or variable may be unsafe.",
        // A path with parentheses that are NOT the line number: the lazy .+?
        // must reject "(x86)" and carry on to "(120)".
        "c:\\program files (x86)\\sdk\\include\\xtl.h(120) : error C2143: syntax error : missing ';' before '}'",
        // A path with a parenthesised NUMBER that is not the line number — the
        // regex must backtrack past "(1)" to "(7)".
        'c:\\a(1)\\b.cpp(7) : error C4700: uninitialized local variable',
        "LINK : fatal error LNK1104: cannot open file 'xapilibd.lib'",
        'main.obj : error LNK2019: unresolved external symbol "void __cdecl foo(void)" referenced in function main',
        "LINK : warning LNK4098: defaultlib 'libcmt.lib' conflicts with use of other libs",
        'Generating Code...',
        '   Creating library Proj.lib and object Proj.exp',
    ].join('\r\n');

    const fixPath = path.join(TMP, 'toolout.txt');
    fs.writeFileSync(fixPath, FIXTURE, 'utf-8');

    // Drive the REAL runTool: a process that prints the fixture, so the
    // TypeScript's own parseLine does the work rather than a copy of it here.
    const printer = path.join(TMP, 'print.js');
    fs.writeFileSync(printer,
        `process.stdout.write(require('fs').readFileSync(${JSON.stringify(fixPath)}, 'utf-8'))`);

    const tc2 = new Toolchain();
    await tc2.detect();
    const bs2 = new BuildSystem(tc2);
    const tsParsed = await BuildSystem.prototype.runTool.call(
        bs2, process.execPath, [`"${printer}"`], '');

    const cParsed = core(['build', 'parse', fixPath]);

    const norm = (a) => JSON.stringify(a.map(m => ({
        file: m.file, line: m.line, column: m.column, message: m.message, severity: m.severity,
    })), null, 1);

    for (const [label, a, b] of [
        ['errors', norm(tsParsed.errors), norm(cParsed.errors)],
        ['warnings', norm(tsParsed.warnings), norm(cParsed.warnings)],
        ['raw lines', JSON.stringify(tsParsed.rawLines, null, 1), JSON.stringify(cParsed.raw, null, 1)],
    ]) {
        checks++;
        if (a === b) console.log(`  ${label.padEnd(46)} match`);
        else {
            fail(`${label} differ`);
            console.log('      ts: ' + a.replace(/\n\s*/g, ' '));
            console.log('      c:  ' + b.replace(/\n\s*/g, ' '));
        }
    }

    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

    console.log('');
    console.log('  ' + '='.repeat(64));
    console.log(bad === 0
        ? `  ALL ${checks} PARITY CHECKS PASS`
        : `  *** ${bad} MISMATCH(ES) across ${checks} checks`);
    process.exit(bad ? 1 : 0);
})();

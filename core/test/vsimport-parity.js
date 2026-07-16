/**
 * vsimport-parity.js — prove vsimport.c agrees with vsImporter.ts.
 *
 * Two layers so far:
 *   map      — the pure value mappers (mapWarningLevel, mapExceptions, ...)
 *   solution — parseSolution over real .sln text on disk
 *
 * The extraction that reads .vcxproj/.vcproj is not ported yet. Each layer is
 * proven before the one that builds on it, the order projectManager went in.
 *
 * The TypeScript side is lifted from the live vsImporter.ts and transpiled with
 * the real tsc — these functions have not moved, so there is no risk of comparing
 * the C against itself yet. That switches to the .bak when the importer moves.
 *
 *   npx tsc && node core/test/vsimport-parity.js
 */
const fs = require('fs'), path = require('path'), os = require('os');
const { execFileSync } = require('child_process');

const R = process.cwd();
const CORE = path.join(R, 'dist', 'nexia-core.exe');
if (!fs.existsSync(CORE)) {
    console.error('   [X] dist/nexia-core.exe missing — run: node scripts/build-core.js');
    process.exit(1);
}

const src = fs.readFileSync(path.join(R, 'src', 'main', 'vsImporter.ts'), 'utf8');
const tsc = require(path.join(R, 'node_modules', 'typescript'));

/*
 * Transpile the whole module and expose every module-private function, rather
 * than lifting them one at a time — parseSolution calls toHostPath calls
 * unescapeMsbuild, and a piecemeal lift does not carry those inner references.
 * The only imports are fs, path and types; the types elide, so this evaluates
 * cleanly with fs and path provided. Same technique as xex-parity.js.
 */
const mod = (() => {
    const js = tsc.transpileModule(src, {
        compilerOptions: { module: tsc.ModuleKind.CommonJS, target: tsc.ScriptTarget.ES2019 },
    }).outputText;
    // Names to hoist out of module scope for the tests.
    const wanted = ['mapWarningLevel', 'mapOptimization', 'mapRuntimeLibrary', 'mapExceptions',
        'mapConfigurationType', 'unescapeMsbuild', 'isUnresolvableMacro', 'parseSolution'];
    const tail = '\n' + wanted.map(n => `try{exports.${n}=${n}}catch(e){}`).join(';');
    const box = { exports: {} };
    new Function('require', 'exports', 'module', js + tail)
        .call(box, require, box.exports, box);
    return box.exports;
})();
const lift = (name) => { if (typeof mod[name] !== 'function') throw new Error(`${name} not liftable`); return mod[name]; };

let checks = 0, bad = 0;
const jsNorm = (v) => v === undefined ? null : v;
function fail(m) { bad++; console.log('  *** ' + m); }

/* ── layer 1: the value mappers ─────────────────────────────────────────────── */
{
    const mapWarningLevel = lift('mapWarningLevel');
    const mapOptimization = lift('mapOptimization');
    const mapRuntimeLibrary = lift('mapRuntimeLibrary');
    const mapExceptions = lift('mapExceptions');
    const mapConfigurationType = lift('mapConfigurationType');
    const unescapeMsbuild = lift('unescapeMsbuild');
    const isUnresolvableMacro = lift('isUnresolvableMacro');
    const core = (v) => JSON.parse(execFileSync(CORE, ['vsimport', 'map', v], { encoding: 'utf8' }));

    const CASES = [
        'Level0', 'Level1', 'Level4', 'Level9', 'TurnOffAllWarnings', '3', '7', '-2', 'EnableAllWarnings',
        'Disabled', 'MinSpace', 'MaxSpeed', 'Full', '0', '1', '2', '3', 'Something',
        'MultiThreaded', 'MultiThreadedDebug', 'MultiThreadedDLL', 'MultiThreadedDebugDLL',
        '  MultiThreadedDebug  ', 'MultiThreadedDLLx',
        'Sync', 'Async', 'Cpp', 'true', 'false', 'SyncCThrow', '1', '2',
        'StaticLibrary', 'DynamicLibrary', 'Application', '4', '2', '1',
        'a%3Bb', 'C:\\Path%20With%20Spaces', '$(ProjectDir)include', '%(AdditionalIncludeDirectories)',
        'plain', '$(XEDK)\\lib', 'no%2gescape', '',
        'level3', 'sTaTiClIbRaRy', 'maxspeed',
    ];
    for (const v of CASES) {
        let c;
        try { c = core(v); } catch (e) { fail(`${JSON.stringify(v)}: C threw: ${e.message}`); continue; }
        const want = {
            unescape: unescapeMsbuild(v),
            unresolvable: isUnresolvableMacro(v),
            warningLevel: jsNorm(mapWarningLevel(v)),
            optimization: jsNorm(mapOptimization(v)),
            runtimeLibrary: jsNorm(mapRuntimeLibrary(v)),
            exceptions: jsNorm(mapExceptions(v)),
            configurationType: mapConfigurationType(v),
        };
        for (const k of Object.keys(want)) {
            checks++;
            if (JSON.stringify(want[k]) !== JSON.stringify(c[k]))
                fail(`${JSON.stringify(v)} .${k}: ts=${JSON.stringify(want[k])} c=${JSON.stringify(c[k])}`);
        }
    }
    console.log(`  map:      ${CASES.length} values`);
}

/* ── layer 2: parseSolution ─────────────────────────────────────────────────── */
{
    const parseSolution = lift('parseSolution');
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nexia-sln-'));

    // A .sln with everything that trips a naive line scanner: CRLF, a tab before
    // '=', a solution folder (no .vcxproj), a C# project (wrong extension), a
    // legacy .vcproj, a nested path, and a real one that exists on disk.
    const mk = (dir, rel) => {
        const p = path.join(dir, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, '<Project/>');
        return p;
    };
    const dir = fs.mkdtempSync(path.join(TMP, 's-'));
    mk(dir, 'Game\\Game.vcxproj');          // exists
    mk(dir, 'Legacy\\Old.vcproj');           // exists, legacy
    // Menu.vcxproj deliberately NOT created — exists:false

    const sln = [
        'Microsoft Visual Studio Solution File, Format Version 11.00',
        '# Visual Studio 2010',
        'Project("{8BC9CEB8-8B4A-11D0-8D11-00A0C91BC942}") = "Game", "Game\\Game.vcxproj", "{AAAA}"',
        'Project("{8BC9CEB8-8B4A-11D0-8D11-00A0C91BC942}")\t=\t"Menu", "Menu\\Menu.vcxproj", "{BBBB}"',
        'Project("{8BC9CEB8-8B4A-11D0-8D11-00A0C91BC942}") = "Old", "Legacy\\Old.vcproj", "{CCCC}"',
        'Project("{2150E333-8FDC-42A3-9474-1A3956D46DE8}") = "Solution Items", "Solution Items", "{DDDD}"',
        'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Tools", "Tools\\Tools.csproj", "{EEEE}"',
        'Global',
        'EndGlobal',
    ].join('\r\n');
    const slnPath = path.join(dir, 'Game.sln');
    fs.writeFileSync(slnPath, sln, 'utf-8');

    const ts = parseSolution(slnPath);
    let c;
    try { c = JSON.parse(execFileSync(CORE, ['vsimport', 'solution', slnPath], { encoding: 'utf8' })); }
    catch (e) { fail(`solution: C threw: ${e.message}`); c = null; }

    if (c) {
        checks++;
        if (path.resolve(ts.solutionPath) !== path.resolve(c.solutionPath)) fail(`solutionPath: ts=${ts.solutionPath} c=${c.solutionPath}`);
        checks++;
        if (ts.name !== c.name) fail(`name: ts=${ts.name} c=${c.name}`);
        checks++;
        if (ts.projects.length !== c.projects.length) {
            fail(`project count: ts=${ts.projects.length} c=${c.projects.length}`);
            console.log('      ts: ' + JSON.stringify(ts.projects.map(p => p.name)));
            console.log('      c:  ' + JSON.stringify(c.projects.map(p => p.name)));
        } else {
            for (let i = 0; i < ts.projects.length; i++) {
                checks += 3;
                const a = ts.projects[i], b = c.projects[i];
                if (a.name !== b.name) fail(`project[${i}].name: ts=${a.name} c=${b.name}`);
                if (path.resolve(a.path) !== path.resolve(b.path)) fail(`project[${i}].path: ts=${a.path} c=${b.path}`);
                if (a.exists !== b.exists) fail(`project[${i}].exists (${a.name}): ts=${a.exists} c=${b.exists}`);
            }
            console.log(`  solution: ${ts.projects.length} projects (skipped a folder + a .csproj), exists flags checked`);
        }
    }
}

console.log();
console.log('  ================================================================');
console.log(bad === 0
    ? `  ALL ${checks} VSIMPORT CHECKS PASS`
    : `  *** ${bad} MISMATCH(ES) across ${checks} checks`);
process.exit(bad ? 1 : 0);

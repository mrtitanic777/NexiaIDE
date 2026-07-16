/**
 * vsimport-parity.js — prove vsimport.c's leaf mappers agree with
 * vsImporter.ts's, value for value.
 *
 * These are the functions that decide every imported field's final form:
 * mapWarningLevel, mapOptimization, mapRuntimeLibrary, mapExceptions,
 * mapConfigurationType, unescapeMsbuild and isUnresolvableMacro. The extraction
 * that feeds them (the .vcxproj/.vcproj scanners) is not ported yet; this proves
 * the leaves before the tree, the same order projectManager went in.
 *
 * The TypeScript side is lifted out of vsImporter.ts — the live source, because
 * these functions have not moved yet, so there is no risk of comparing the C
 * against itself. When the importer moves to C this switches to the .bak, as the
 * others did.
 *
 *   npx tsc && node core/test/vsimport-parity.js
 */
const fs = require('fs'), path = require('path');
const { execFileSync } = require('child_process');

const R = process.cwd();
const CORE = path.join(R, 'dist', 'nexia-core.exe');
if (!fs.existsSync(CORE)) {
    console.error('   [X] dist/nexia-core.exe missing — run: node scripts/build-core.js');
    process.exit(1);
}

/* Lift the module-private functions out of vsImporter.ts by source. path.sep is
 * referenced by some of them via toHostPath, but the ones under test here do not
 * touch it. Each is evaluated as written — no reimplementation, so the test
 * cannot be wrong in the same direction as the code. */
const src = fs.readFileSync(path.join(R, 'src', 'main', 'vsImporter.ts'), 'utf8');
const tsc = require(path.join(R, 'node_modules', 'typescript'));
function lift(name) {
    const at = src.indexOf(`function ${name}(`);
    if (at < 0) throw new Error(`${name} not found`);
    let i = src.indexOf('{', at), depth = 0, end = -1;
    for (let k = i; k < src.length; k++) {
        if (src[k] === '{') depth++;
        else if (src[k] === '}') { depth--; if (depth === 0) { end = k + 1; break; } }
    }
    // Transpile with the real tsc — the same strip the build uses — rather than
    // hand-written regexes that miss a signature spelling.
    const js = tsc.transpileModule(src.slice(at, end), {
        compilerOptions: { target: tsc.ScriptTarget.ES2019 },
    }).outputText;
    return new Function('path', js + `; return ${name};`)(path);
}

const mapWarningLevel = lift('mapWarningLevel');
const mapOptimization = lift('mapOptimization');
const mapRuntimeLibrary = lift('mapRuntimeLibrary');
const mapExceptions = lift('mapExceptions');
const mapConfigurationType = lift('mapConfigurationType');
const unescapeMsbuild = lift('unescapeMsbuild');
const isUnresolvableMacro = lift('isUnresolvableMacro');

const core = (v) => JSON.parse(execFileSync(CORE, ['vsimport', 'map', v], { encoding: 'utf8' }));

const CASES = [
    // warning level
    'Level0', 'Level1', 'Level4', 'Level9', 'TurnOffAllWarnings', '3', '7', '-2', 'EnableAllWarnings',
    // optimization
    'Disabled', 'MinSpace', 'MaxSpeed', 'Full', '0', '1', '2', '3', 'Something',
    // runtime library
    'MultiThreaded', 'MultiThreadedDebug', 'MultiThreadedDLL', 'MultiThreadedDebugDLL',
    '  MultiThreadedDebug  ', 'MultiThreadedDLLx',
    // exceptions — SyncCThrow is the trap: matches the false/0 arm but returns sync
    'Sync', 'Async', 'Cpp', 'true', 'false', 'SyncCThrow', '1', '2',
    // configuration type
    'StaticLibrary', 'DynamicLibrary', 'Application', '4', '2', '1',
    // msbuild unescape + macros
    'a%3Bb', 'C:\\Path%20With%20Spaces', '$(ProjectDir)include', '%(AdditionalIncludeDirectories)',
    'plain', '$(XEDK)\\lib', 'no%2gescape', '',
    // case
    'level3', 'sTaTiClIbRaRy', 'maxspeed',
];

let checks = 0, bad = 0;
const jsNorm = (v) => v === undefined ? null : v;

for (const v of CASES) {
    let c;
    try { c = core(v); } catch (e) { fail(v, 'C threw: ' + e.message); continue; }
    const want = {
        unescape: unescapeMsbuild(v),
        unresolvable: isUnresolvableMacro(v),
        warningLevel: jsNorm(mapWarningLevel(v)),
        optimization: jsNorm(mapOptimization(v)),
        runtimeLibrary: jsNorm(mapRuntimeLibrary(v)),
        exceptions: jsNorm(mapExceptions(v)),
        configurationType: mapConfigurationType(v),
    };
    let ok = true;
    for (const k of Object.keys(want)) {
        checks++;
        if (JSON.stringify(want[k]) !== JSON.stringify(c[k])) {
            ok = false; bad++;
            console.log(`  *** ${JSON.stringify(v)} .${k}: ts=${JSON.stringify(want[k])} c=${JSON.stringify(c[k])}`);
        }
    }
    if (ok) console.log(`  ${JSON.stringify(v).padEnd(34)} ok`);
}

function fail(v, m) { bad++; console.log(`  *** ${JSON.stringify(v)}: ${m}`); }

console.log();
console.log('  ================================================================');
console.log(bad === 0
    ? `  ALL ${checks} VSIMPORT MAP CHECKS PASS`
    : `  *** ${bad} MISMATCH(ES) across ${checks} checks`);
process.exit(bad ? 1 : 0);

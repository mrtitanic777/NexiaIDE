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

// _ts-backup/vsImporter.ts.bak, not the live module: the live parseSolution /
// parseVsProject / resolveProjectReference now spawn nexia-core, so lifting them
// would compare the C against itself. The .bak holds the original TypeScript
// implementation. Delete it and this test retires — see _ts-backup/README.md.
const BAK = path.join(R, 'src', 'main', '_ts-backup', 'vsImporter.ts.bak');
if (!fs.existsSync(BAK)) {
    console.log('  _ts-backup/vsImporter.ts.bak is gone - nothing left to compare against.');
    process.exit(0);
}
const src = fs.readFileSync(BAK, 'utf8');
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
        'mapConfigurationType', 'unescapeMsbuild', 'isUnresolvableMacro', 'parseSolution',
        'parseVcproj', 'parseVcxproj'];
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

/* deep-equal that respects array order but not object key order, and treats a
 * missing key and an undefined value as the same (JSON.stringify drops both). */
function deepEq(a, b, pathStr = '') {
    if (a === b) return true;
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
            fail(`${pathStr}: array differs ts=${JSON.stringify(a)} c=${JSON.stringify(b)}`); return false;
        }
        let ok = true;
        for (let i = 0; i < a.length; i++) if (!deepEq(a[i], b[i], `${pathStr}[${i}]`)) ok = false;
        return ok;
    }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
        const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter(k => a[k] !== undefined || b[k] !== undefined));
        let ok = true;
        for (const k of keys) if (!deepEq(a[k], b[k], pathStr ? `${pathStr}.${k}` : k)) ok = false;
        return ok;
    }
    fail(`${pathStr}: ts=${JSON.stringify(a)} c=${JSON.stringify(b)}`);
    return false;
}

/* ── layer 3: parseVcproj on a realistic legacy fixture ─────────────────────── */
{
    const parseVcproj = lift('parseVcproj');
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nexia-vcproj-'));
    const dir = fs.mkdtempSync(path.join(TMP, 'p-'));
    const proj = path.join(dir, 'Legacy.vcproj');
    const vcproj = `<?xml version="1.0" encoding="Windows-1252"?>
<VisualStudioProject ProjectType="Visual C++" Version="9.00" Name="Legacy">
  <Files>
    <File RelativePath=".\\src\\stdafx.cpp"></File>
    <File RelativePath=".\\src\\stdafx.h"></File>
    <File RelativePath="src\\main.cpp"></File>
    <File RelativePath=".\\readme.txt"></File>
    <File RelativePath="$(XEDK)\\gen.cpp"></File>
  </Files>
  <Configurations>
    <Configuration Name="Debug|Xbox 360" ConfigurationType="1">
      <Tool Name="VCCLCompilerTool"
        Optimization="0" AdditionalIncludeDirectories="include;$(XEDK)\\include;$(ProjectDir)src"
        PreprocessorDefinitions="_XBOX;_DEBUG;%(Foo)" RuntimeLibrary="1" WarningLevel="3"
        RuntimeTypeInfo="false" ExceptionHandling="2" WarnAsError="true"
        UsePrecompiledHeader="2" PrecompiledHeaderThrough="stdafx.h" />
      <Tool Name="VCLinkerTool"
        AdditionalDependencies="xapilib.lib   d3d9d.lib  xgraphicsd.lib"
        AdditionalLibraryDirectories="$(XEDK)\\lib\\xbox;lib" />
    </Configuration>
    <Configuration Name="Release|Xbox 360" ConfigurationType="1">
      <Tool Name="VCCLCompilerTool" Optimization="2" RuntimeLibrary="0" />
    </Configuration>
  </Configurations>
</VisualStudioProject>`;
    fs.writeFileSync(proj, vcproj, 'utf-8');

    const ts = parseVcproj(proj);
    let c;
    try { c = JSON.parse(execFileSync(CORE, ['vsimport', 'vcproj', proj], { encoding: 'utf8' })); }
    catch (e) { fail(`vcproj: C threw: ${e.message}`); c = null; }
    if (c) {
        delete c.ok;
        checks++;
        if (deepEq(ts, c, 'vcproj')) console.log(`  vcproj:   ${ts.sources.length} src, ${ts.headers.length} hdr, flags + warnings match`);
    }
}

/* ── layer 4: parseVcxproj on a reference-free MSBuild project ───────────────── */
{
    const parseVcxproj = lift('parseVcxproj');
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nexia-vcxproj-'));
    const dir = fs.mkdtempSync(path.join(TMP, 'p-'));
    const proj = path.join(dir, 'Game.vcxproj');
    // Per-configuration ItemDefinitionGroups so all four config paths are hit,
    // with Debug/Release differing in RuntimeLibrary — the /MTd-vs-/MT split that
    // was a real bug when it was collapsed to one project-wide value. Release and
    // Release_LTCG present; Profile deliberately absent, so its key is omitted.
    const g = (cfg, rt, extraLib) => `
  <ItemDefinitionGroup Condition="'$(Configuration)|$(Platform)'=='${cfg}|Xbox 360'">
    <ClCompile>
      <AdditionalIncludeDirectories>include;$(XEDK)\\include;$(ProjectDir)src;%(AdditionalIncludeDirectories)</AdditionalIncludeDirectories>
      <PreprocessorDefinitions>_XBOX;${cfg === 'Debug' ? '_DEBUG' : 'NDEBUG'};%(PreprocessorDefinitions)</PreprocessorDefinitions>
      <RuntimeLibrary>${rt}</RuntimeLibrary>
      <WarningLevel>Level3</WarningLevel>
      <ExceptionHandling>Sync</ExceptionHandling>
      <RuntimeTypeInfo>false</RuntimeTypeInfo>
      <Optimization>${cfg === 'Debug' ? 'Disabled' : 'MaxSpeed'}</Optimization>
      <PrecompiledHeader>Use</PrecompiledHeader>
    </ClCompile>
    <Link>
      <AdditionalDependencies>xapilib.lib;${extraLib};%(AdditionalDependencies)</AdditionalDependencies>
      <AdditionalLibraryDirectories>$(XEDK)\\lib\\xbox;lib</AdditionalLibraryDirectories>
    </Link>
  </ItemDefinitionGroup>`;
    const vcxproj = `<?xml version="1.0" encoding="utf-8"?>
<Project DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup Label="Globals">
    <ProjectName>GameTitle</ProjectName>
    <ConfigurationType>Application</ConfigurationType>
  </PropertyGroup>
  <ItemGroup>
    <ClCompile Include="src\\stdafx.cpp" />
    <ClCompile Include="src\\main.cpp" />
    <ClInclude Include="src\\stdafx.h" />
    <None Include="readme.txt" />
    <Image Include="art\\icon.png" />
    <ClCompile Include="$(XEDK)\\generated.cpp" />
  </ItemGroup>${g('Debug', 'MultiThreadedDebug', 'd3d9d.lib')}${g('Release', 'MultiThreaded', 'd3d9i.lib')}${g('Release_LTCG', 'MultiThreaded', 'd3d9ltcg.lib')}
</Project>`;
    fs.writeFileSync(proj, vcxproj, 'utf-8');

    const ts = parseVcxproj(proj);
    let c;
    try { c = JSON.parse(execFileSync(CORE, ['vsimport', 'vcxproj', proj], { encoding: 'utf8' })); }
    catch (e) { fail(`vcxproj: C threw: ${e.message}`); c = null; }
    if (c) {
        delete c.ok;
        checks++;
        const cfgKeys = Object.keys(ts.configurations).join(',');
        if (deepEq(ts, c, 'vcxproj'))
            console.log(`  vcxproj:  ${ts.sources.length} src, configs [${cfgKeys}] (Profile absent), flags + warnings match`);
    }
}

/* ── layer 5: parseVcxproj WITH a project reference (the ATG case) ───────────── */
{
    const parseVcxproj = lift('parseVcxproj');
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nexia-ref-'));
    // A "SDK" so insideSdk is exercised; the referenced project lives inside it.
    const sdk = fs.mkdtempSync(path.join(TMP, 'sdk-'));
    const common = path.join(sdk, 'Source', 'Samples', 'Common');
    fs.mkdirSync(common, { recursive: true });

    // The referenced static-lib project, ATG-shaped: ProjectName differs from the
    // file stem, OutDir/OutputFile use macros, and it builds per configuration.
    const atg = path.join(common, 'AtgFramework2010.vcxproj');
    fs.writeFileSync(atg, `<?xml version="1.0" encoding="utf-8"?>
<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup Label="Globals"><ProjectName>AtgFramework</ProjectName></PropertyGroup>
  <PropertyGroup Condition="'$(Configuration)|$(Platform)'=='Debug|Xbox 360'"><ConfigurationType>StaticLibrary</ConfigurationType></PropertyGroup>
  <PropertyGroup Condition="'$(Configuration)|$(Platform)'=='Release|Xbox 360'"><ConfigurationType>StaticLibrary</ConfigurationType></PropertyGroup>
  <PropertyGroup Condition="'$(Configuration)|$(Platform)'=='Profile|Xbox 360'"><ConfigurationType>StaticLibrary</ConfigurationType></PropertyGroup>
  <ItemDefinitionGroup Condition="'$(Configuration)|$(Platform)'=='Debug|Xbox 360'">
    <Link><OutputFile>$(OutDir)$(ProjectName).lib</OutputFile></Link>
    <OutDir>$(ProjectDir)$(Configuration)\\</OutDir>
  </ItemDefinitionGroup>
</Project>`, 'utf-8');
    // Build AtgFramework.lib for Debug and Release, but NOT Profile — the exact
    // SDK reality the "no Profile build" warning describes.
    for (const cfg of ['Debug', 'Release']) {
        fs.mkdirSync(path.join(common, cfg), { recursive: true });
        fs.writeFileSync(path.join(common, cfg, 'AtgFramework.lib'), 'x');
    }

    // The importing project references it and has all four configurations.
    const dir = fs.mkdtempSync(path.join(TMP, 'game-'));
    const proj = path.join(dir, 'Menu.vcxproj');
    const rel = path.relative(dir, atg).replace(/\//g, '\\');
    const grp = (cfg, rt) => `
  <ItemDefinitionGroup Condition="'$(Configuration)|$(Platform)'=='${cfg}|Xbox 360'">
    <ClCompile><RuntimeLibrary>${rt}</RuntimeLibrary><PreprocessorDefinitions>_XBOX</PreprocessorDefinitions></ClCompile>
    <Link><AdditionalDependencies>xapilib.lib</AdditionalDependencies></Link>
  </ItemDefinitionGroup>`;
    fs.writeFileSync(proj, `<?xml version="1.0" encoding="utf-8"?>
<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup Label="Globals"><ProjectName>Menu</ProjectName><ConfigurationType>Application</ConfigurationType></PropertyGroup>
  <ItemGroup><ClCompile Include="src\\main.cpp" /></ItemGroup>
  <ItemGroup><ProjectReference Include="${rel}"><Project>{1234}</Project></ProjectReference></ItemGroup>${grp('Debug','MultiThreadedDebug')}${grp('Release','MultiThreaded')}${grp('Profile','MultiThreaded')}${grp('Release_LTCG','MultiThreaded')}
</Project>`, 'utf-8');

    const ts = parseVcxproj(proj, sdk);
    let c;
    try { c = JSON.parse(execFileSync(CORE, ['vsimport', 'vcxproj', proj, '--sdk', sdk], { encoding: 'utf8' })); }
    catch (e) { fail(`vcxproj+ref: C threw: ${e.message}`); c = null; }
    if (c) {
        delete c.ok;
        checks++;
        if (deepEq(ts, c, 'vcxproj+ref')) {
            const dbgLibs = ts.configurations.Debug.libraries.join(',');
            console.log(`  vcxproj+ref: ref resolved (insideSdk=${ts.projectReferences[0].insideSdk}), ` +
                `Debug libs [${dbgLibs}], ${ts.warnings.length} warnings (incl. Profile-missing)`);
        }
    }
}

console.log();
console.log('  ================================================================');
console.log(bad === 0
    ? `  ALL ${checks} VSIMPORT CHECKS PASS`
    : `  *** ${bad} MISMATCH(ES) across ${checks} checks`);
process.exit(bad ? 1 : 0);

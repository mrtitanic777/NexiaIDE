/*
 * build-ui.js — build the WPF UI (nexia-ui/NexiaUI.csproj) -> dist/nexia-ui.exe.
 *
 * A .NET Framework WPF app, built with the MSBuild that ships with the framework
 * (no dotnet SDK, no NuGet). It lands in dist/ beside nexia-core.exe, which it
 * spawns for every backend operation — the same C backend the Electron IDE uses.
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const R = path.join(__dirname, '..');

const MSBUILD = [
    'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\MSBuild.exe',
    'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\MSBuild.exe',
].find(p => fs.existsSync(p));

if (!MSBUILD) {
    console.error('   [X] MSBuild (.NET Framework v4) not found.');
    process.exit(1);
}

const r = spawnSync(MSBUILD, [
    'nexia-ui\\NexiaUI.csproj',
    '-nologo', '-verbosity:minimal',
    '-property:Configuration=Release',
], { cwd: R, encoding: 'utf8' });

// The framework has no v4.5 targeting pack here, so MSBuild warns and resolves
// from the GAC — harmless. Filter that noise; surface anything real.
const noise = /warning MSB(3644|3270|4011)|reference assemblies|processor architecture|Configuration Manager|align the processor|take a dependency|which is the runtime/;
const lines = (r.stdout || '').split('\n').filter(l => l.trim() && !noise.test(l));
if (lines.length) console.log(lines.join('\n'));
if (r.stderr && r.stderr.trim()) console.error(r.stderr.trim());

if (r.status !== 0) { console.error('   [X] WPF build failed.'); process.exit(1); }

const out = path.join(R, 'dist', 'nexia-ui.exe');
const kb = fs.existsSync(out) ? Math.round(fs.statSync(out).size / 1024) : 0;
console.log(`   [OK] nexia-ui.exe built (${kb} KB)`);

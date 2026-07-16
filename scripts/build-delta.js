/**
 * build-delta.js — build a delta update package, or refuse to.
 *
 * A delta replaces resources\app\dist and nothing else. That is safe only while
 * everything it does NOT ship is unchanged:
 *
 *   dependencies   -> node_modules is not in the delta, so a new or bumped
 *                     dependency would leave the app importing something that
 *                     isn't installed
 *   electron       -> the runtime is not in the delta either
 *
 * Both are silent failures if you get them wrong: the update installs happily
 * and the app breaks on launch, or worse, only on the code path that uses the
 * new dependency. So this compares against the last published release and
 * refuses rather than warns.
 *
 * Usage:
 *   node scripts/build-delta.js --baseline <path-to-previous-package.json>
 *   node scripts/build-delta.js --force        (skip the check; you own it)
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const args = process.argv.slice(2);
const force = args.includes('--force');
const baselineIdx = args.indexOf('--baseline');
const baselinePath = baselineIdx >= 0 ? args[baselineIdx + 1] : null;

function fail(msg) {
    console.error('\n  REFUSING to build a delta:\n');
    console.error('  ' + msg.split('\n').join('\n  '));
    console.error('\n  Publish NexiaSetup.exe for this release instead.\n');
    process.exit(1);
}

if (!force) {
    if (!baselinePath) {
        fail('No baseline given, so there is nothing to compare against.\n' +
             'Pass --baseline <previous package.json>, or --force if you are certain\n' +
             'dependencies and the Electron version have not changed.');
    }
    if (!fs.existsSync(baselinePath)) fail(`Baseline not found: ${baselinePath}`);

    const base = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    const problems = [];

    const cmp = (label, a, b) => {
        const ka = Object.keys(a || {}).sort();
        const kb = Object.keys(b || {}).sort();
        for (const k of new Set([...ka, ...kb])) {
            if ((a || {})[k] !== (b || {})[k]) {
                problems.push(`${label}.${k}: ${(a || {})[k] ?? '(absent)'} -> ${(b || {})[k] ?? '(absent)'}`);
            }
        }
    };
    cmp('dependencies', base.dependencies, pkg.dependencies);

    const be = (base.devDependencies || {}).electron;
    const pe = (pkg.devDependencies || {}).electron;
    if (be !== pe) problems.push(`electron: ${be} -> ${pe}`);

    if (problems.length) {
        fail('These changed since the baseline, and a delta does not carry them:\n\n' +
             problems.map(p => '  - ' + p).join('\n'));
    }
    console.log('  baseline check: dependencies and Electron unchanged — delta is valid');
}

// dist/ must be current, or the delta ships stale code.
const mainJs = path.join(ROOT, 'dist', 'main', 'main.js');
if (!fs.existsSync(mainJs)) fail('dist/main/main.js is missing — run `npm run build` first.');

const NSIS = path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache', 'nsis',
                       'nsis-3.0.4.1', 'Bin', 'makensis.exe');
if (!fs.existsSync(NSIS)) fail(`makensis not found at ${NSIS}`);

// The numeric part alone, for the Windows version resource: it takes four
// numbers, so "3.3.0-dev" has to arrive there as "3.3.0". The full string keeps
// its tag everywhere a human reads it.
const versionNum = /^(\d+(?:\.\d+)*)/.exec(pkg.version)?.[1] || '0.0.0';

console.log(`  building delta for ${pkg.version}...`);
execFileSync(NSIS, [`-DVERSION=${pkg.version}`, `-DVERSION_NUM=${versionNum}`,
                    path.join(ROOT, 'installer', 'delta.nsi')],
             { stdio: 'inherit' });

const out = path.join(ROOT, 'dist', 'NexiaUpdate.exe');
const size = fs.statSync(out).size;
const sha = require('crypto').createHash('sha256').update(fs.readFileSync(out)).digest('hex');
console.log('');
console.log('  ' + out);
console.log('  size:   ' + size + ' bytes (' + (size / 1048576).toFixed(2) + ' MB)');
console.log('  sha256: ' + sha);

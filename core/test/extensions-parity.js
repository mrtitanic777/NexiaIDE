/**
 * extensions-parity.js — prove nexia-core agrees with src/main/extensions.ts.
 *
 * Only the filesystem half of extensions.ts moved to C; the manifest parsing,
 * the validation and the state file stayed in TypeScript on purpose. So this
 * compares the half that moved — the scan, the copy, the delete and the
 * template writer — and prints what it did not compare, and why, at the bottom.
 *
 * Both sides are pointed at a temp directory via USERPROFILE, which is what
 * os.homedir() reads and what C reads. Nothing here touches the real
 * ~/.nexia-ide.
 *
 *   npm run build && node scripts/build-core.js && node core/test/extensions-parity.js
 */
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const R = process.cwd();
const { ExtensionManager } = require(path.join(R, 'dist/main/extensions.js'));

const EXE = path.join(R, 'dist', 'nexia-core.exe');
const temps = [];
const newHome = (tag) => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), `nx-ext-${tag}-`));
    temps.push(h);
    return h;
};

// Both sides resolve the home the same way, so the env is the only thing set.
/*
 * `mayFail` is for the cases where refusing IS the correct answer: nexia-core
 * exits non-zero and execFileSync throws, but the JSON on stdout is still what
 * we came for.
 */
const core = (home, args, mayFail) => {
    const opts = { encoding: 'utf8', env: { ...process.env, USERPROFILE: home } };
    try {
        return JSON.parse(execFileSync(EXE, args, opts));
    } catch (e) {
        if (mayFail && e.stdout) return JSON.parse(e.stdout);
        throw e;
    }
};
const mgr = (home) => { process.env.USERPROFILE = home; return new ExtensionManager(); };
const extdir = (home) => path.join(home, '.nexia-ide', 'extensions');

let bad = 0;
const check = (label, same, detail) => {
    if (!same) bad++;
    console.log('  ' + label.padEnd(32) + (same ? 'match' : `*** DIFFER  ${detail || ''}`));
};

/* A directory as {relative path: contents}, so a copy can be compared to a copy
 * byte for byte rather than by name. */
const tree = (dir) => {
    const out = {};
    const walk = (d, rel) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const p = path.join(d, e.name), r = rel ? rel + '/' + e.name : e.name;
            if (e.isDirectory()) walk(p, r);
            else out[r] = fs.readFileSync(p).toString('hex');
        }
    };
    if (fs.existsSync(dir)) walk(dir, '');
    return out;
};

/* An extension as it actually arrives: nested folders, a non-ASCII filename,
 * and bytes that are not text. The non-ASCII name is the whole reason this
 * module is wchar_t — the narrow API would mangle it. */
const fixture = (id, name) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-src-'));
    temps.push(d);
    fs.writeFileSync(path.join(d, 'manifest.json'),
        JSON.stringify({ id, name, version: '1.0.0', author: 'A', description: 'd', type: 'tool' }, null, 2));
    fs.mkdirSync(path.join(d, 'nested', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(d, 'nested', 'deep', 'ünïcødé — файл.txt'), 'héllo wörld\n');
    fs.writeFileSync(path.join(d, 'nested', 'blob.bin'), Buffer.from([0, 1, 2, 255, 254, 0]));
    fs.writeFileSync(path.join(d, 'README.md'), '# ' + name + '\n');
    return d;
};

(async () => {
    try {
        console.log('  ── getExtensionsDir vs `extensions dir` ──');
        {
            const h = newHome('dir');
            const ts = mgr(h).getExtensionsDir();
            const c = core(h, ['extensions', 'dir']).path;
            check('extensions dir', ts === c, `\n      ts: ${ts}\n      c:  ${c}`);
            check('created on construction', fs.existsSync(c), c);
            // --home must agree with the USERPROFILE it stands in for.
            check('--home == USERPROFILE', core(h, ['extensions', 'dir', '--home', h]).path === c, '');
        }

        console.log('');
        console.log('  ── createTemplate vs `extensions template` ──');
        console.log('  (id slug, then manifest.json and README.md byte for byte)');
        for (const [name, type] of [
            ['My Cool Tool!', 'tool'], ['ALLCAPS', 'template'], ['  spaced  out  ', 'snippet'],
            ['---dashes---', 'theme'], ['mixed123Numbers', 'library'], ['Ünïcödé Näme', 'plugin'],
            ['quote"and\\slash', 'tool'], ['KELVIN', 'tool'], ['İstanbul', 'tool'],
            ['unknown-type-icon', 'wat'], ['a', 'tool'],
        ]) {
            const th = newHome('t-ts'), ch = newHome('t-c');
            const tsDir = mgr(th).createTemplate(name, type);
            const cRes = core(ch, ['extensions', 'template', name, type]);
            // The directory each side landed on, not the slug beside a
            // basename: a name of "!!!" slugs to "" and both sides then write
            // into the extensions directory itself, where the basename is
            // "extensions" but the id is "". Comparing the paths says they
            // agree, which is true; comparing basename to id says they do not,
            // which is the test being wrong rather than the port.
            check(`slug ${JSON.stringify(name)}`, path.relative(th, tsDir) === path.relative(ch, cRes.path),
                `ts=${JSON.stringify(path.relative(th, tsDir))} c=${JSON.stringify(path.relative(ch, cRes.path))}`);
            const t1 = tree(extdir(th)), t2 = tree(extdir(ch));
            check(`  files ${JSON.stringify(name)}`, JSON.stringify(t1) === JSON.stringify(t2),
                `\n      ts: ${JSON.stringify(t1)}\n      c:  ${JSON.stringify(t2)}`);
        }

        // A name with nothing alphanumeric in it used to slug to "", and
        // path.join(extensionsDir, "") is the extensions directory itself — so
        // manifest.json and README.md were written into the root and the next
        // template overwrote them. Both sides refuse now. This case was in the
        // loop above asserting that they agreed on doing the wrong thing.
        {
            const th = newHome('t-bad'), ch = newHome('c-bad');
            let tsThrew = false;
            try { mgr(th).createTemplate('!!!', 'tool'); } catch { tsThrew = true; }
            const cRes = core(ch, ['extensions', 'template', '!!!', 'tool'], true);
            check('"!!!" — TypeScript refuses', tsThrew, 'it did not throw');
            check('"!!!" — C refuses', cRes.ok === false, JSON.stringify(cRes));
            check('"!!!" — nothing written to the root',
                  Object.keys(tree(extdir(ch))).length === 0 && Object.keys(tree(extdir(th))).length === 0,
                  'files appeared: ts=' + JSON.stringify(Object.keys(tree(extdir(th)))) +
                  ' c=' + JSON.stringify(Object.keys(tree(extdir(ch)))));
        }

        console.log('');
        console.log('  ── installFromFolder vs `extensions install` ──');
        {
            const src = fixture('acme.widget', 'Widget');
            const th = newHome('i-ts'), ch = newHome('i-c');
            const tsRes = await mgr(th).installFromFolder(src);
            // The id is the manifest's, which the TypeScript parses and hands over.
            const cRes = core(ch, ['extensions', 'install', src, 'acme.widget']);
            check('dest path', path.relative(th, tsRes.path) === path.relative(ch, cRes.path),
                `\n      ts: ${tsRes.path}\n      c:  ${cRes.path}`);
            const t1 = tree(extdir(th)), t2 = tree(extdir(ch));
            check('copied tree', JSON.stringify(t1) === JSON.stringify(t2),
                `\n      ts: ${Object.keys(t1)}\n      c:  ${Object.keys(t2)}`);
            check('non-ASCII filename survived', Object.keys(t2).some(k => k.includes('ünïcødé — файл')),
                Object.keys(t2).join(','));

            // Reinstall over the top: both must replace the tree, not merge into it.
            const stale = path.join(extdir(th), 'acme.widget', 'stale.txt');
            fs.writeFileSync(stale, 'x');
            fs.writeFileSync(path.join(extdir(ch), 'acme.widget', 'stale.txt'), 'x');
            await mgr(th).installFromFolder(src);
            core(ch, ['extensions', 'install', src, 'acme.widget']);
            check('reinstall replaces', JSON.stringify(tree(extdir(th))) === JSON.stringify(tree(extdir(ch))), '');
            check('  stale file gone', !fs.existsSync(stale), '');

            const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-empty-'));
            temps.push(empty);
            let tsErr = '', cErr = '';
            try { await mgr(th).installFromFolder(empty); } catch (e) { tsErr = e.message; }
            try { core(ch, ['extensions', 'install', empty, 'x']); } catch (e) { cErr = JSON.parse(e.stdout).error; }
            check('missing manifest: error', tsErr === cErr, `\n      ts: ${JSON.stringify(tsErr)}\n      c:  ${JSON.stringify(cErr)}`);
        }

        console.log('');
        console.log('  ── uninstall vs `extensions uninstall` ──');
        {
            const src = fixture('acme.widget', 'Widget');
            const th = newHome('u-ts'), ch = newHome('u-c');
            await mgr(th).installFromFolder(src);
            core(ch, ['extensions', 'install', src, 'acme.widget']);
            mgr(th).uninstall('acme.widget');
            core(ch, ['extensions', 'uninstall', 'acme.widget']);
            const t1 = tree(extdir(th)), t2 = tree(extdir(ch));
            check('tree after uninstall', JSON.stringify(t1) === JSON.stringify(t2),
                `ts=${JSON.stringify(t1)} c=${JSON.stringify(t2)}`);
            check('  nothing left', Object.keys(t2).length === 0, '');
            // rmSync({force:true}) does not mind an id that was never there.
            check('  unknown id is not an error', core(ch, ['extensions', 'uninstall', 'never-installed']).ok === true, '');
        }

        console.log('');
        console.log('  ── getInstalled vs `extensions list` ──');
        {
            const h = newHome('list');
            for (const [id, name] of [['zeta.ext', 'Zeta'], ['alpha.ext', 'Alpha'], ['mid.ext', 'Mid']])
                core(h, ['extensions', 'install', fixture(id, name), id]);
            // A directory with no manifest is not an extension to either side.
            fs.mkdirSync(path.join(extdir(h), 'junk'), { recursive: true });
            // Nor is a loose file.
            fs.writeFileSync(path.join(extdir(h), 'loose.txt'), 'x');

            const ts = mgr(h).getInstalled();
            const c = core(h, ['extensions', 'list']).extensions;
            const tsIds = ts.map(e => e.manifest.id).sort(), cIds = c.map(e => e.id).sort();
            check('discovered set', JSON.stringify(tsIds) === JSON.stringify(cIds), `\n      ts: ${tsIds}\n      c:  ${cIds}`);
            // C reports the folder name where the TypeScript reports manifest.id.
            // They agree because install names the folder after the id — asserted
            // here rather than assumed.
            check('folder name == manifest.id', JSON.stringify(ts.map(e => path.basename(e.path)).sort()) === JSON.stringify(cIds), '');
            check('paths', JSON.stringify(ts.map(e => e.path).sort()) === JSON.stringify(c.map(e => e.path).sort()), '');
            check('junk dir ignored', !cIds.includes('junk'), '');
            check('loose file ignored', !cIds.includes('loose.txt'), '');
            // Not a parity requirement, only a note: getInstalled sorts by
            // manifest.name once it has parsed them, so C's scan order is never
            // the order a user sees.
            console.log('  ' + 'scan order (C)'.padEnd(32) + JSON.stringify(c.map(e => e.id)));
        }

        console.log('');
        console.log('  ── NOT TESTED (and why) ──');
        for (const [what, why] of [
            ['manifest parsing', 'not ported — json.c emits, never parses (see extensions.c)'],
            ['manifest validation', 'not ported — needs the parsed manifest'],
            ['loadState/saveState/setEnabled', 'not ported — the state file is a JSON read-modify-write'],
            ['installedAt, enabled flags', 'not ported — they live in that state file'],
            ['installFromZip', 'not ported — unzip stays with PowerShell\'s Expand-Archive'],
            ['openExtensionsDir', 'ported as `extensions open`, not asserted — it opens a window'],
            ['read-only / locked files', 'not compared — both sides fail, not necessarily alike'],
        ]) console.log('  ' + what.padEnd(36) + why);

        console.log('');
        console.log(bad === 0 ? '  ALL PARITY CHECKS PASS (for what was ported)' : `  *** ${bad} MISMATCH(ES)`);
    } finally {
        for (const t of temps) { try { fs.rmSync(t, { recursive: true, force: true }); } catch {} }
    }
    process.exit(bad ? 1 : 0);
})();

/**
 * create-parity.js — prove `nexia-core project create` builds the same project
 * on disk as projectManager.ts's create().
 *
 * Both make a project from the same template, into two directories, and every
 * byte of both trees is compared: the file list, each file's contents, and
 * nexia.json itself byte for byte — because the TypeScript still reads and
 * rewrites that file, so the two writers must agree on more than meaning.
 *
 * The TypeScript side is _ts-backup/projectManager.ts.bak, not the live module.
 * Once create() moves, the live one asks nexia-core and comparing against it
 * would compare the C with itself — which is how the parser half of
 * buildsystem-parity.js spent a commit proving nothing. Delete the .bak and this
 * test retires; see _ts-backup/README.md.
 *
 *   npx tsc && node core/test/create-parity.js
 */
const fs = require('fs'), path = require('path'), os = require('os');
const { execFileSync } = require('child_process');

const R = process.cwd();
const CORE = path.join(R, 'dist', 'nexia-core.exe');
if (!fs.existsSync(CORE)) {
    console.error('   [X] dist/nexia-core.exe missing — run: node scripts/build-core.js');
    process.exit(1);
}

const BAK = path.join(R, 'src', 'main', '_ts-backup', 'projectManager.ts.bak');
if (!fs.existsSync(BAK)) {
    console.log('  _ts-backup/projectManager.ts.bak is gone - nothing left to compare against.');
    process.exit(0);
}

const tsc = require(path.join(R, 'node_modules', 'typescript'));
const js = tsc.transpileModule(fs.readFileSync(BAK, 'utf8'), {
    compilerOptions: { module: tsc.ModuleKind.CommonJS, target: tsc.ScriptTarget.ES2019 },
}).outputText;
const box = { exports: {}, module: { exports: {} } };
new Function('require', 'exports', 'module', '__dirname', js)
    .call(box, require, box.exports, box.module, path.join(R, 'dist', 'main'));
const ProjectManager = box.exports.ProjectManager;
if (typeof ProjectManager !== 'function') {
    console.error('   [X] could not load ProjectManager out of projectManager.ts.bak');
    process.exit(1);
}

const { Toolchain } = require(path.join(R, 'dist/main/toolchain.js'));

let checks = 0, bad = 0;
const fail = (m) => { bad++; console.log('  *** ' + m); };

/* Walk a tree to a sorted list of [relpath, bytes]. */
function walk(dir, base = dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, base, out);
        else out.push([path.relative(base, p).replace(/\\/g, '/'), fs.readFileSync(p)]);
    }
    return out;
}

(async () => {
    const tc = new Toolchain();
    const sdk = await tc.detect();
    if (!sdk) { console.log('  NO SDK — cannot compare the templates that copy from it'); }

    const pm = new ProjectManager(tc);
    const TEMPLATES = pm.getTemplates().map(t => t.id);
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nexia-create-'));

    // Names chosen to exercise the substitution, not just the happy path.
    const NAMES = ['Proj', '3D Engine', 'my-game'];

    for (const id of TEMPLATES) {
        for (const name of NAMES) {
            const tsDir = fs.mkdtempSync(path.join(TMP, 'ts-'));
            const cDir  = fs.mkdtempSync(path.join(TMP, 'c-'));

            let tsErr = null;
            try { await pm.create(name, tsDir, id); }
            catch (e) { tsErr = e.message; }

            const args = ['project', 'create', name, cDir, id];
            if (sdk) args.push('--sdk', sdk.root);
            let cOut;
            try { cOut = JSON.parse(execFileSync(CORE, args, { encoding: 'utf8' })); }
            catch (e) {
                try { cOut = JSON.parse(e.stdout?.toString() || '{}'); }
                catch { cOut = { ok: false, error: '(no JSON) ' + e.message }; }
            }

            checks++;
            if (tsErr && cOut.ok) { fail(`${id}/${name}: ts refused (${tsErr}) but C succeeded`); continue; }
            if (!tsErr && !cOut.ok) { fail(`${id}/${name}: C refused: ${cOut.error}`); continue; }
            if (tsErr && !cOut.ok) { console.log(`  ${id}/${name}: both refused (ok)`); continue; }

            // create() joins the *raw* name, not the sanitised one — safeFileName
            // names the entry-point file, not the directory.
            const tsProjDir = path.join(tsDir, name);
            const cProjDir  = path.join(cDir, name);
            const tsFiles = walk(tsProjDir);
            const cFiles  = walk(cProjDir);

            checks++;
            const tsNames = tsFiles.map(f => f[0]), cNames = cFiles.map(f => f[0]);
            if (JSON.stringify(tsNames) !== JSON.stringify(cNames)) {
                fail(`${id}/${name}: file list differs`);
                console.log('      ts: ' + JSON.stringify(tsNames));
                console.log('      c:  ' + JSON.stringify(cNames));
                continue;
            }

            // nexia.json records the project's absolute path, and the two
            // projects are deliberately in different directories, so that one
            // field must differ. Normalise it away — but assert first that each
            // side recorded its own real directory, because "path is wrong" is
            // exactly the sort of bug this file exists to catch and blanket
            // normalisation would hide it.
            const norm = (rel, buf, root) => {
                if (rel !== 'nexia.json') return buf;
                const txt = buf.toString('utf8');
                const rec = JSON.parse(txt).path;
                checks++;
                if (path.resolve(rec) !== path.resolve(root))
                    fail(`${id}/${name}: nexia.json path is ${rec}, expected ${root}`);
                return Buffer.from(txt.split(JSON.stringify(rec).slice(1, -1)).join('<PROJDIR>'), 'utf8');
            };

            let same = true;
            for (let i = 0; i < tsFiles.length; i++) {
                checks++;
                tsFiles[i][1] = norm(tsNames[i], tsFiles[i][1], tsProjDir);
                cFiles[i][1]  = norm(cNames[i],  cFiles[i][1],  cProjDir);
                if (!tsFiles[i][1].equals(cFiles[i][1])) {
                    same = false;
                    fail(`${id}/${name}: ${tsNames[i]} differs (ts=${tsFiles[i][1].length}b c=${cFiles[i][1].length}b)`);
                    const a = tsFiles[i][1].toString('utf8'), b = cFiles[i][1].toString('utf8');
                    for (let k = 0; k < Math.max(a.length, b.length); k++)
                        if (a[k] !== b[k]) {
                            console.log(`      first difference at char ${k}`);
                            console.log(`      ts: ${JSON.stringify(a.slice(Math.max(0, k - 60), k + 60))}`);
                            console.log(`      c:  ${JSON.stringify(b.slice(Math.max(0, k - 60), k + 60))}`);
                            break;
                        }
                }
            }
            if (same) console.log(`  ${(id + '/' + name).padEnd(26)} ${String(tsFiles.length).padStart(2)} files identical`);
        }
    }

    /* ── open ──────────────────────────────────────────────────────────────
     *
     * open() hands its caller the whole config, so `project open` has to as well.
     * `project read` names the fields it knows, which is enough to build with and
     * not enough to open with: Project Properties and the VS importer both store
     * things in a project that nexia-core has never heard of.
     *
     * The stale path is the point of the last field — open() overrides path with
     * where the project was actually found, so a project that has been moved
     * still opens. */
    {
        const dir = fs.mkdtempSync(path.join(TMP, 'open-'));
        const cfg = {
            name: 'P', path: 'C:\\WRONG\\STALE\\PATH', type: 'executable', template: 'empty',
            sourceFiles: ['src/P.cpp'], defines: ['_XBOX'], warningLevel: 4, enableRtti: false,
            solutionInfo: { guid: '{A1B2}', importedFrom: 'C:\\old\\P.vcxproj' },
            weirdField: [1, 2, { deep: 'yes' }], nullish: null, frac: 0.1,
        };
        fs.writeFileSync(path.join(dir, 'nexia.json'), JSON.stringify(cfg, null, 2), 'utf-8');

        checks++;
        const ts = await new ProjectManager().open(dir);
        let c;
        try { c = JSON.parse(execFileSync(CORE, ['project', 'open', dir], { encoding: 'utf8' })).project; }
        catch (e) { fail(`open: C threw: ${e.message}`); c = null; }

        if (c) {
            const a = JSON.stringify(ts), b = JSON.stringify(c);
            if (a !== b) {
                fail('open: the config differs');
                console.log('      ts: ' + a);
                console.log('      c:  ' + b);
            } else {
                console.log(`  open: whole config identical (unknown fields kept, stale path overridden)`);
            }
        }

        checks++;
        const missing = fs.mkdtempSync(path.join(TMP, 'nocfg-'));
        let tsThrew = false;
        try { await new ProjectManager().open(missing); } catch { tsThrew = true; }
        let cOk = true;
        try { execFileSync(CORE, ['project', 'open', missing], { encoding: 'utf8' }); }
        catch (e) { cOk = false; }
        if (tsThrew !== !cOk) fail(`open with no nexia.json: ts threw=${tsThrew}, C failed=${!cOk}`);
        else console.log(`  open: both refuse a directory with no nexia.json`);
    }

    console.log();
    console.log('  ================================================================');
    console.log(bad === 0
        ? `  ALL ${checks} CREATE/OPEN PARITY CHECKS PASS`
        : `  *** ${bad} MISMATCH(ES) across ${checks} checks`);
    process.exit(bad ? 1 : 0);
})().catch(e => { console.error('FAILED:', e.message, '\n', e.stack); process.exit(1); });

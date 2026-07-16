/**
 * project-parity.js — prove the C file-tree scanner and config reader agree
 * with projectManager.ts.
 *
 * The tree is compared whole, recursively, on real projects: order included.
 * Order is the thing most likely to drift — the TypeScript sorts with
 * localeCompare and the C uses CompareStringW — and a tree in a different order
 * is a visibly different Explorer.
 */
const path = require('path'), fs = require('fs'), os = require('os'), { execFileSync } = require('child_process');
const R = process.cwd();
const { Toolchain } = require(path.join(R, 'dist/main/toolchain.js'));
const { ProjectManager } = require(path.join(R, 'dist/main/projectManager.js'));

const core = (args) => JSON.parse(execFileSync(path.join(R, 'dist', 'nexia-core.exe'), args,
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));

(async () => {
    const tc = new Toolchain(); await tc.detect();
    const mgr = new ProjectManager(tc);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nxproj-'));

    let bad = 0;
    for (const tpl of ['empty', 'dll', 'static-lib', 'xui-app']) {
        const dir = path.join(root, tpl);
        fs.mkdirSync(dir, { recursive: true });
        const p = await mgr.create('TreeTest', dir, tpl);

        // A file the tree must hide, and one it must not.
        fs.writeFileSync(path.join(p.path, '.gitignore'), 'out/\n');
        fs.writeFileSync(path.join(p.path, '.hidden'), 'x');
        fs.mkdirSync(path.join(p.path, 'node_modules'), { recursive: true });

        const ts = mgr.getFileTree(p.path);
        const c = core(['project', 'tree', p.path]).tree;

        // Compare shape and order exactly.
        const norm = (n) => n.map(x => ({
            name: x.name, isDirectory: !!x.isDirectory,
            extension: x.isDirectory ? undefined : x.extension,
            children: x.isDirectory ? norm(x.children || []) : undefined,
        }));
        const a = JSON.stringify(norm(ts)), b = JSON.stringify(norm(c));
        const same = a === b;
        if (!same) bad++;
        console.log('  ' + tpl.padEnd(12) + 'tree: ' + (same ? 'match' : 'DIFFER'));
        if (!same) {
            console.log('    ts: ' + a.slice(0, 200));
            console.log('    c : ' + b.slice(0, 200));
        }

        // nexia.json must not appear; .gitignore must.
        const names = ts.map(x => x.name);
        const cnames = c.map(x => x.name);
        for (const [label, want, present] of [['nexia.json hidden', false, cnames.includes('nexia.json')],
                                              ['.gitignore shown', true, cnames.includes('.gitignore')],
                                              ['.hidden hidden', false, cnames.includes('.hidden')],
                                              ['node_modules hidden', false, cnames.includes('node_modules')]]) {
            if (present !== want) { bad++; console.log('    *** ' + label + ' — got ' + present); }
        }
        if (JSON.stringify(names) !== JSON.stringify(cnames)) { bad++; console.log('    *** top-level names differ'); }

        // config reader
        const cr = core(['project', 'read', p.path]);
        if (cr.name !== p.name) { bad++; console.log('    *** name: ts=' + p.name + ' c=' + cr.name); }
        if (cr.type !== p.type) { bad++; console.log('    *** type: ts=' + p.type + ' c=' + cr.type); }
        if (JSON.stringify(cr.sourceFiles) !== JSON.stringify(p.sourceFiles)) {
            bad++; console.log('    *** sourceFiles: ts=' + JSON.stringify(p.sourceFiles) + ' c=' + JSON.stringify(cr.sourceFiles));
        }
    }

    console.log('');
    console.log(bad === 0 ? '  PROJECT PARITY PASSES' : `  *** ${bad} MISMATCH(ES)`);
    process.exit(bad ? 1 : 0);
})();

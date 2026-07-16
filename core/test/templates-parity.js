/**
 * templates-parity.js — prove core/templates.c is byte-identical to
 * projectManager.ts's getTemplates().
 *
 * scripts/gen-templates.js saying it worked is not evidence. This compiles the
 * real templates.c, walks NX_TEMPLATES, writes every file's content out as raw
 * bytes, and compares all of it against what getTemplates() actually returns.
 *
 * Bytes, not "looks right": this table is 37 KB of Xbox 360 C++ that gets written
 * into a user's new project. A wrong escape would not fail the build — it would
 * compile something subtly different, on a console, weeks later, in code the user
 * assumes is the IDE's.
 *
 * The first version of this compared eight named blobs and passed. It missed six
 * contents — three declared inline at the call site, two composed with +, one a
 * plain quoted string — and every sdkFile, per-configuration library list and
 * xuiContent in the table. It proved less than its name claimed. This compares
 * the whole structure, so what it misses is what getTemplates() does not return.
 *
 * Retires when projectManager.ts stops being the source of truth. While both
 * exist, they must agree.
 *
 *   npx tsc && node core/test/templates-parity.js
 */
const fs = require('fs'), path = require('path'), os = require('os');
const { execFileSync, spawnSync } = require('child_process');

const R = process.cwd();
const JS = path.join(R, 'dist', 'main', 'projectManager.js');
if (!fs.existsSync(JS)) {
    console.error('   [X] dist/main/projectManager.js missing — run: npx tsc');
    process.exit(1);
}
const { ProjectManager } = require(JS);
const want = new ProjectManager().getTemplates();

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nexia-tpl-'));

/* A probe that dumps the table: metadata as JSON-ish lines, contents as raw
 * bytes on disk. Raw bytes because that is what a template *is* — comparing a
 * decoded string would let an encoding bug pass. */
const probe = `
#include <stdio.h>
#include <string.h>
#include "templates.h"

/* This probe's own JSON escaper, deliberately not nx_json_str: a harness that
 * shares a helper with the code it checks cannot catch a bug in that helper.
 * (json-escape-parity.js is what proves nx_json_str.) */
static void js(FILE *f, const char *s) {
    fputc('"', f);
    for (; *s; s++) {
        unsigned char c = (unsigned char)*s;
        if (c == '"' || c == '\\\\') { fputc('\\\\', f); fputc(c, f); }
        else if (c < 0x20) fprintf(f, "\\\\u%04x", c);
        else fputc(c, f);
    }
    fputc('"', f);
}

static void arr(FILE *f, const char *key, const char **a, int n) {
    fprintf(f, "  \\"%s\\": [", key);
    for (int i = 0; i < n; i++) { if (i) fputc(',', f); js(f, a[i]); }
    fprintf(f, "],\\n");
}

int main(int argc, char **argv) {
    char p[1024];
    FILE *m = fopen(argv[1], "wb");
    fprintf(m, "[\\n");
    for (int i = 0; i < NX_TEMPLATE_COUNT; i++) {
        const nx_template *t = &NX_TEMPLATES[i];
        fprintf(m, " {\\n");
        fprintf(m, "  \\"id\\": "); js(m, t->id); fprintf(m, ",\\n");
        fprintf(m, "  \\"type\\": "); js(m, t->type); fprintf(m, ",\\n");
        fprintf(m, "  \\"template\\": "); js(m, t->template_id); fprintf(m, ",\\n");
        fprintf(m, "  \\"nfiles\\": %d,\\n", t->nfiles);
        fprintf(m, "  \\"filepaths\\": [");
        for (int k = 0; k < t->nfiles; k++) { if (k) fputc(',', m); js(m, t->files[k].path); }
        fprintf(m, "],\\n");
        fprintf(m, "  \\"sdk\\": [");
        for (int k = 0; k < t->nsdk_files; k++) {
            if (k) fputc(',', m);
            fputc('[', m); js(m, t->sdk_files[k].from); fputc(',', m); js(m, t->sdk_files[k].to); fputc(']', m);
        }
        fprintf(m, "],\\n");
        arr(m, "sourceFiles", t->source_files, t->nsource_files);
        arr(m, "defines", t->defines, t->ndefines);
        arr(m, "libraries", t->libraries, t->nlibraries);
        arr(m, "includeDirectories", t->include_dirs, t->ninclude_dirs);
        fprintf(m, "  \\"configurations\\": [");
        for (int k = 0; k < t->nconfigurations; k++) {
            if (k) fputc(',', m);
            fprintf(m, "{\\"name\\":"); js(m, t->configurations[k].name);
            fprintf(m, ",\\"libraries\\":[");
            for (int j = 0; j < t->configurations[k].nlibraries; j++) {
                if (j) fputc(',', m);
                js(m, t->configurations[k].libraries[j]);
            }
            fprintf(m, "]}");
        }
        fprintf(m, "],\\n");
        if (t->xui_package) {
            fprintf(m, "  \\"xuiPackage\\": "); js(m, t->xui_package); fprintf(m, ",\\n");
            arr(m, "xuiScenes", t->xui_scenes, t->nxui_scenes);
            arr(m, "xuiCopy", t->xui_copy, t->nxui_copy);
        }
        fprintf(m, "  \\"end\\": 1\\n }%s\\n", i + 1 < NX_TEMPLATE_COUNT ? "," : "");

        for (int k = 0; k < t->nfiles; k++) {
            sprintf(p, "%s/%s.%d.bin", argv[2], t->id, k);
            FILE *f = fopen(p, "wb");
            fwrite(t->files[k].content, 1, strlen(t->files[k].content), f);
            fclose(f);
        }
    }
    fprintf(m, "]\\n");
    fclose(m);
    return 0;
}
`;
fs.writeFileSync(path.join(TMP, 'probe.c'), probe);

let cc = null;
for (const c of ['x86_64-w64-mingw32-gcc', 'i686-w64-mingw32-gcc', 'gcc']) {
    if (spawnSync(c, ['--version'], { shell: true }).status === 0) { cc = c; break; }
}
if (!cc) { console.error('   [X] no MinGW compiler'); process.exit(1); }

const exe = path.join(TMP, 'probe.exe');
const r = spawnSync(cc, [path.join(TMP, 'probe.c'), path.join(R, 'core', 'templates.c'),
    '-I', path.join(R, 'core'), '-o', exe], { shell: true, encoding: 'utf8' });
if (r.status !== 0) { console.error('   [X] probe failed to compile:\n' + r.stderr); process.exit(1); }

const meta = path.join(TMP, 'meta.json');
execFileSync(exe, [meta, TMP]);
const got = JSON.parse(fs.readFileSync(meta, 'utf-8'));

let checks = 0, bad = 0;
const cmp = (label, a, b) => {
    checks++;
    const x = JSON.stringify(a), y = JSON.stringify(b);
    if (x !== y) { bad++; console.log(`  *** ${label}\n        ts: ${x}\n        c:  ${y}`); return false; }
    return true;
};

cmp('template count', want.length, got.length);

for (let i = 0; i < Math.min(want.length, got.length); i++) {
    const w = want[i], g = got[i], cfg = w.config || {};
    cmp(`[${i}] id`, w.id, g.id);
    cmp(`${w.id} type`, cfg.type || 'executable', g.type);
    cmp(`${w.id} template`, cfg.template || 'empty', g.template);
    cmp(`${w.id} file count`, (w.files || []).length, g.nfiles);
    cmp(`${w.id} file paths`, (w.files || []).map(f => f.path), g.filepaths);
    cmp(`${w.id} sdkFiles`, (w.sdkFiles || []).map(f => [f.from, f.to]), g.sdk);
    cmp(`${w.id} sourceFiles`, cfg.sourceFiles || [], g.sourceFiles);
    cmp(`${w.id} defines`, cfg.defines || [], g.defines);
    cmp(`${w.id} libraries`, cfg.libraries || [], g.libraries);
    cmp(`${w.id} includeDirectories`, cfg.includeDirectories || [], g.includeDirectories);
    cmp(`${w.id} configurations`,
        Object.entries(cfg.configurations || {}).map(([name, o]) => ({ name, libraries: o.libraries || [] })),
        g.configurations);
    if (cfg.xuiContent) {
        cmp(`${w.id} xuiContent.package`, cfg.xuiContent.package, g.xuiPackage);
        cmp(`${w.id} xuiContent.scenes`, cfg.xuiContent.scenes, g.xuiScenes);
        cmp(`${w.id} xuiContent.copy`, cfg.xuiContent.copy, g.xuiCopy);
    } else {
        checks++;
        if (g.xuiPackage !== undefined) { bad++; console.log(`  *** ${w.id}: C has xuiContent, TypeScript does not`); }
    }

    // The contents, byte for byte.
    for (let k = 0; k < (w.files || []).length; k++) {
        checks++;
        const f = path.join(TMP, `${w.id}.${k}.bin`);
        if (!fs.existsSync(f)) { bad++; console.log(`  *** ${w.id}[${k}]: C wrote no content`); continue; }
        const cB = fs.readFileSync(f), tB = Buffer.from(w.files[k].content, 'utf8');
        if (!cB.equals(tB)) {
            bad++;
            console.log(`  *** ${w.id} ${w.files[k].path}: content differs (c=${cB.length}b ts=${tB.length}b)`);
            for (let j = 0; j < Math.max(cB.length, tB.length); j++)
                if (cB[j] !== tB[j]) {
                    console.log(`        first difference at byte ${j}`);
                    console.log(`        ts: ${JSON.stringify(w.files[k].content.slice(Math.max(0, j - 30), j + 30))}`);
                    break;
                }
        }
    }
    if (!bad) console.log(`  ${w.id.padEnd(12)} ${String((w.files || []).length).padStart(2)} files, ` +
        `${String((w.files || []).reduce((n, f) => n + Buffer.byteLength(f.content, 'utf8'), 0)).padStart(6)} bytes  identical`);
}

console.log();
console.log('  ================================================================');
console.log(bad === 0
    ? `  ALL ${checks} TEMPLATE CHECKS PASS (${want.length} templates, byte for byte)`
    : `  *** ${bad} MISMATCH(ES) across ${checks} checks`);
process.exit(bad ? 1 : 0);

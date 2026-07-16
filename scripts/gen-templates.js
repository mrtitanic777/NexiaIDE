/**
 * gen-templates.js — emit the project template table as C, generated from the
 * TypeScript that currently defines it.
 *
 * Generated rather than retyped, and that is the point. The table carries 918+
 * lines of Xbox 360 C++ that get written into a user's new project. Hand-copying
 * it into C string literals is one slip away from a template that still compiles
 * and does something subtly wrong — a bug that surfaces on a console, weeks
 * later, in code the user assumes is the IDE's fault.
 *
 * It calls getTemplates() rather than parsing projectManager.ts for `const NAME
 * = \`...\`` blocks. The first version of this did the latter and silently missed
 * six contents: three templates declare theirs inline at the call site, two
 * compose theirs (STDAFX_H + '\n// XUI\n#include <xui.h>\n...'), and one is a
 * plain quoted string. Regexing a source file for the shapes you remember finds
 * the shapes you remember. Evaluating the function returns what the IDE actually
 * uses, resolved, with nothing left to miss.
 *
 *   node scripts/gen-templates.js
 *
 * Writes core/templates.c and core/templates.h. Do not edit those by hand — run
 * this instead. It is idempotent, so a diff after running it is a real change.
 */
const fs = require('fs');
const path = require('path');

const R = path.join(__dirname, '..');
const OUT_C = path.join(R, 'core', 'templates.c');
const OUT_H = path.join(R, 'core', 'templates.h');

const JS = path.join(R, 'dist', 'main', 'projectManager.js');
if (!fs.existsSync(JS)) {
    console.error('   [X] dist/main/projectManager.js missing — run: npx tsc');
    process.exit(1);
}
const { ProjectManager } = require(JS);

// getTemplates() does not touch the toolchain — sdkFiles are resolved by
// create(), not here — so it needs no argument.
const templates = new ProjectManager().getTemplates();
if (!Array.isArray(templates) || templates.length === 0) {
    console.error('   [X] getTemplates() returned nothing');
    process.exit(1);
}

/* ── C string literal, one source line per line of content ───────────────────── */
function cstr(s) {
    const enc = (line) => {
        let o = '';
        for (let k = 0; k < line.length; k++) {
            const ch = line[k], c = line.charCodeAt(k);
            if (ch === '\\') o += '\\\\';
            else if (ch === '"') o += '\\"';
            else if (ch === '\t') o += '\\t';
            else if (ch === '\r') o += '\\r';
            else if (ch === '?') o += '\\?';          // no accidental trigraphs
            else if (c >= 0x20 && c < 0x7f) o += ch;
            else {
                // Octal, not \x: \x is greedy in C and would swallow the next
                // hex digit of real text. UTF-8 bytes, because the TypeScript
                // writes these files as UTF-8 and the C must produce the same.
                for (const b of Buffer.from(ch, 'utf8')) o += '\\' + b.toString(8).padStart(3, '0');
            }
        }
        return o;
    };
    const lines = s.split('\n');
    if (lines.length === 1) return '"' + enc(lines[0]) + '"';
    return '\n' + lines.map((l, i) => '        "' + enc(l) + (i < lines.length - 1 ? '\\n' : '') + '"').join('\n');
}

const arr = (a) => (a && a.length) ? a.map(cstr).join(', ') : null;

let c = '';
let nfiles = 0, nbytes = 0;

/* ── per-template arrays ─────────────────────────────────────────────────────── */
for (const t of templates) {
    const id = t.id.replace(/[^a-z0-9]/gi, '_');

    c += `/* ── ${t.id} — ${t.name} ── */\n`;

    c += `static const nx_tpl_file FILES_${id}[] = {\n`;
    for (const f of t.files || []) {
        nfiles++; nbytes += Buffer.byteLength(f.content, 'utf8');
        c += `    { ${cstr(f.path)},\n      ${cstr(f.content)} },\n`;
    }
    c += `};\n\n`;

    if (t.sdkFiles?.length) {
        c += `static const nx_tpl_sdk SDK_${id}[] = {\n`;
        for (const f of t.sdkFiles) c += `    { ${cstr(f.from)}, ${cstr(f.to)} },\n`;
        c += `};\n\n`;
    }

    const cfg = t.config || {};
    for (const [k, v] of [['SRC', cfg.sourceFiles], ['DEF', cfg.defines],
                          ['LIB', cfg.libraries], ['INC', cfg.includeDirectories]]) {
        if (v?.length) c += `static const char *${k}_${id}[] = { ${arr(v)} };\n`;
    }

    if (cfg.configurations) {
        for (const [name, o] of Object.entries(cfg.configurations))
            if (o.libraries?.length)
                c += `static const char *CFGLIB_${id}_${name}[] = { ${arr(o.libraries)} };\n`;
        c += `static const nx_tpl_cfg CFGS_${id}[] = {\n`;
        for (const [name, o] of Object.entries(cfg.configurations))
            c += `    { "${name}", ${o.libraries?.length ? `CFGLIB_${id}_${name}` : 'NULL'}, ${o.libraries?.length || 0} },\n`;
        c += `};\n`;
    }

    if (cfg.xuiContent) {
        const x = cfg.xuiContent;
        if (x.scenes?.length) c += `static const char *XSCN_${id}[] = { ${arr(x.scenes)} };\n`;
        if (x.copy?.length)   c += `static const char *XCPY_${id}[] = { ${arr(x.copy)} };\n`;
    }
    c += `\n`;
}

/* ── the table ───────────────────────────────────────────────────────────────── */
c += `const nx_template NX_TEMPLATES[] = {\n`;
for (const t of templates) {
    const id = t.id.replace(/[^a-z0-9]/gi, '_');
    const cfg = t.config || {};
    const x = cfg.xuiContent;
    const n = (v, name) => v?.length ? `${name}_${id}, ${v.length}` : `NULL, 0`;
    c += `    {
        ${cstr(t.id)}, ${cstr(t.name)},
        ${cstr(t.description)},
        ${cstr(t.icon || '')},
        FILES_${id}, ${(t.files || []).length},
        ${t.sdkFiles?.length ? `SDK_${id}, ${t.sdkFiles.length}` : 'NULL, 0'},
        ${cstr(cfg.type || 'executable')}, ${cstr(cfg.template || 'empty')},
        ${n(cfg.sourceFiles, 'SRC')},
        ${n(cfg.defines, 'DEF')},
        ${n(cfg.libraries, 'LIB')},
        ${n(cfg.includeDirectories, 'INC')},
        ${cfg.configurations ? `CFGS_${id}, ${Object.keys(cfg.configurations).length}` : 'NULL, 0'},
        ${x ? cstr(x.package) : 'NULL'},
        ${x?.scenes?.length ? `XSCN_${id}, ${x.scenes.length}` : 'NULL, 0'},
        ${x?.copy?.length ? `XCPY_${id}, ${x.copy.length}` : 'NULL, 0'},
    },\n`;
}
c += `};\nconst int NX_TEMPLATE_COUNT = ${templates.length};\n`;

const banner = `/*
 * GENERATED by scripts/gen-templates.js. Do not edit — regenerate with:
 *
 *     npx tsc && node scripts/gen-templates.js
 *
 * The project template table, from projectManager.ts's getTemplates().
 * ${templates.length} templates, ${nfiles} files, ${nbytes} bytes of content.
 *
 * Proven byte-for-byte against the TypeScript by core/test/templates-parity.js.
 */
`;

fs.writeFileSync(OUT_C, banner + '\n#include "templates.h"\n\n' + c, 'utf-8');

fs.writeFileSync(OUT_H, banner + `
#ifndef NEXIA_TEMPLATES_H
#define NEXIA_TEMPLATES_H

/* For NULL: templates.c is nothing but a table, and the empty slots in it are
 * NULL. Included here rather than there so anything that includes this header
 * gets a table it can actually name. */
#include <stddef.h>

typedef struct { const char *path; const char *content; } nx_tpl_file;
typedef struct { const char *from; const char *to; } nx_tpl_sdk;
typedef struct { const char *name; const char **libraries; int nlibraries; } nx_tpl_cfg;

typedef struct {
    const char *id, *name, *description, *icon;
    const nx_tpl_file *files;      int nfiles;
    const nx_tpl_sdk  *sdk_files;  int nsdk_files;
    const char *type, *template_id;
    const char **source_files;      int nsource_files;
    const char **defines;           int ndefines;
    const char **libraries;         int nlibraries;
    const char **include_dirs;      int ninclude_dirs;
    const nx_tpl_cfg *configurations; int nconfigurations;
    /* NULL when the template has no xuiContent. */
    const char *xui_package;
    const char **xui_scenes;        int nxui_scenes;
    const char **xui_copy;          int nxui_copy;
} nx_template;

extern const nx_template NX_TEMPLATES[];
extern const int NX_TEMPLATE_COUNT;

#endif
`, 'utf-8');

console.log(`  ${templates.length} templates, ${nfiles} files, ${nbytes} bytes -> core/templates.c`);
for (const t of templates)
    console.log(`    ${t.id.padEnd(12)} ${String((t.files || []).length).padStart(2)} files, ` +
        `${String((t.files || []).reduce((n, f) => n + Buffer.byteLength(f.content, 'utf8'), 0)).padStart(6)} bytes` +
        `${t.sdkFiles?.length ? `, ${t.sdkFiles.length} from SDK` : ''}` +
        `${t.config?.configurations ? ', per-config libs' : ''}` +
        `${t.config?.xuiContent ? ', xui content' : ''}`);

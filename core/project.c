/*
 * project.c — the project's files, and the project's config.
 *
 * Ported from projectManager.ts. Only the logic came across: two thirds of that
 * file is C++ source held in template literals, which is data the IDE writes to
 * disk, not behaviour. It stays where it is until the templates themselves move.
 *
 * The tree scan is the part that wanted to be in C. The IDE walks it on every
 * refresh, and Node does a syscall per entry through a layer that allocates an
 * object for each one; FindFirstFile/FindNextFile hands back the name and the
 * attributes in the same struct, already filled in.
 */
#include "nexia.h"
#include "json_parse.h"
#include <string.h>

#define PROJECT_FILE L"nexia.json"

/* ── the wizard's two names ───────────────────────────────────────────────────
 *
 * Both of these turn a project name typed into a text box into something safe.
 * They are `create`'s foundation, ported ahead of it: every template path, every
 * substituted identifier and the project directory itself come out of these two
 * functions, so a disagreement here is a disagreement about where files land.
 */

/*
 * Visual Studio's CreateSafeName, reproduced exactly.
 *
 * From VC#\VC#Wizards\1033\common.js: keep only [A-Za-z0-9_], prepend "My" if
 * the result is empty or starts with a digit, because an identifier cannot begin
 * with one. "3D Engine" becomes My3DEngine, which is what the wizard would have
 * called it.
 *
 * The TypeScript iterates `for (const ch of name)`, which walks code points, not
 * UTF-16 units. Walking wchar_t here walks units, and for a character outside the
 * BMP that is two surrogates instead of one code point. It makes no difference:
 * the filter keeps only ASCII, and both halves of a surrogate pair fail that test
 * exactly as the single code point would. It would matter the moment this filter
 * accepted anything above 0x7f, so it is written down rather than relied upon.
 */
void nx_safe_name(const wchar_t *name, wchar_t *out, size_t cap)
{
    size_t n = 0;
    for (const wchar_t *p = name; *p && n + 1 < cap; p++) {
        wchar_t c = *p;
        if ((c >= L'A' && c <= L'Z') || (c >= L'a' && c <= L'z') ||
            c == L'_' || (c >= L'0' && c <= L'9'))
            out[n++] = c;
    }
    out[n] = 0;

    if (n == 0) { nx_copy(out, cap, L"My"); return; }
    if (out[0] >= L'0' && out[0] <= L'9') {
        wchar_t tmp[NX_PATH];
        nx_copy(tmp, NX_PATH, out);
        _snwprintf(out, cap - 1, L"My%ls", tmp);
        out[cap - 1] = 0;
    }
}

/*
 * JavaScript's String.prototype.trim, for what can still reach it here.
 *
 * Not just the space bar. trim() strips WhiteSpace and LineTerminator as ECMA-262
 * defines them, which includes NBSP, the Unicode Zs category, LS/PS and the BOM.
 * A project named with a non-breaking space — pasted from a web page, which is
 * exactly where one comes from — would otherwise keep it in C and lose it in
 * TypeScript, and the two would disagree about the directory's name.
 *
 * Everything below 0x20 is already gone by the time this runs: safeFileName
 * replaces \x00-\x1f first, which covers TAB, VT, FF, LF and CR. So this only
 * needs the whitespace at 0x20 and above.
 */
static int js_trimmable(wchar_t c)
{
    return c == 0x20 || c == 0xa0 || c == 0x1680 ||
           (c >= 0x2000 && c <= 0x200a) ||
           c == 0x2028 || c == 0x2029 || c == 0x202f || c == 0x205f ||
           c == 0x3000 || c == 0xfeff;
}

/*
 * Make a project name safe to use as a filename.
 *
 * This value becomes a path, and it arrives straight from a text box. Anything
 * Windows forbids goes, and every path separator with it: "../../evil" as a
 * project name must not write outside the project directory.
 *
 * Order is load-bearing and matches the TypeScript's chain: replace the
 * forbidden characters, then strip trailing dots and spaces, then trim. Stripping
 * before replacing would let a name ending in "\t" keep an underscore that
 * TypeScript drops.
 */
void nx_safe_filename(const wchar_t *name, wchar_t *out, size_t cap)
{
    /* .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') */
    size_t n = 0;
    for (const wchar_t *p = name; *p && n + 1 < cap; p++) {
        wchar_t c = *p;
        int bad = (c == L'<' || c == L'>' || c == L':' || c == L'"' || c == L'/' ||
                   c == L'\\' || c == L'|' || c == L'?' || c == L'*' || c < 0x20);
        out[n++] = bad ? L'_' : c;
    }
    out[n] = 0;

    /* .replace(/[. ]+$/, '') — trailing dots and spaces only, and only at the end */
    while (n > 0 && (out[n - 1] == L'.' || out[n - 1] == L' ')) out[--n] = 0;

    /* .trim() */
    while (n > 0 && js_trimmable(out[n - 1])) out[--n] = 0;
    size_t lead = 0;
    while (out[lead] && js_trimmable(out[lead])) lead++;
    if (lead) memmove(out, out + lead, (n - lead + 1) * sizeof(wchar_t));

    /* || 'Main' */
    if (!out[0]) nx_copy(out, cap, L"Main");
}

/*
 * Names the tree never shows.
 *
 * nexia.json is on the list because the IDE writes it through Project
 * Properties: showing it invites hand-editing the file the IDE is actively
 * rewriting. It stays on disk — only the tree hides it.
 */
static int ignored(const wchar_t *name)
{
    static const wchar_t *skip[] = {
        L"node_modules", L".git", L"out", L".vs", L"__pycache__", PROJECT_FILE,
    };
    for (size_t i = 0; i < sizeof(skip) / sizeof(skip[0]); i++)
        if (!_wcsicmp(name, skip[i])) return 1;
    /* Dotfiles are hidden, except the one people expect to edit. */
    if (name[0] == L'.' && _wcsicmp(name, L".gitignore")) return 1;
    return 0;
}

typedef struct {
    wchar_t name[NX_PATH];
    int     is_dir;
} entry;

/*
 * Directories first, then by name — the order Explorer and the IDE both use.
 *
 * CompareStringW, not wcscmp: the TypeScript sorted with localeCompare, so
 * "Ä" sorts next to "A" rather than after "Z", and a project whose files are
 * not ASCII would otherwise list in a different order than it does today.
 */
static int __cdecl by_name(const void *a, const void *b)
{
    const entry *x = (const entry *)a, *y = (const entry *)b;
    if (x->is_dir != y->is_dir) return y->is_dir - x->is_dir;
    int r = CompareStringW(LOCALE_USER_DEFAULT, 0, x->name, -1, y->name, -1);
    return r ? r - CSTR_EQUAL : 0;
}

static void ext_of(const wchar_t *name, wchar_t *out, size_t cap)
{
    out[0] = 0;
    const wchar_t *dot = wcsrchr(name, L'.');
    /* A leading dot is the whole name, not an extension — path.extname('.gitignore')
     * is '' — so start the search past the first character. */
    if (!dot || dot == name) return;
    nx_copy(out, cap, dot);
    _wcslwr(out);
}

/* Emit one directory's worth of FileNode objects, recursing into subdirectories. */
static void scan(const wchar_t *dir, FILE *f)
{
    wchar_t glob[NX_PATH];
    nx_join(glob, NX_PATH, dir, L"*");

    WIN32_FIND_DATAW fd;
    HANDLE h = FindFirstFileW(glob, &fd);
    if (h == INVALID_HANDLE_VALUE) { fputs("[]", f); return; }

    entry *list = NULL;
    int n = 0, cap = 0;
    do {
        if (!wcscmp(fd.cFileName, L".") || !wcscmp(fd.cFileName, L"..")) continue;
        if (ignored(fd.cFileName)) continue;
        if (n >= cap) {
            cap = cap ? cap * 2 : 64;
            entry *g = (entry *)realloc(list, (size_t)cap * sizeof(entry));
            if (!g) break;
            list = g;
        }
        nx_copy(list[n].name, NX_PATH, fd.cFileName);
        list[n].is_dir = (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
        n++;
    } while (FindNextFileW(h, &fd));
    FindClose(h);

    qsort(list, (size_t)n, sizeof(entry), by_name);

    fputc('[', f);
    for (int i = 0; i < n; i++) {
        if (i) fputc(',', f);
        wchar_t full[NX_PATH];
        nx_join(full, NX_PATH, dir, list[i].name);

        fputc('{', f);
        nx_json_field(f, "name", list[i].name);
        fputc(',', f);
        nx_json_field(f, "path", full);
        if (list[i].is_dir) {
            fputs(",\"isDirectory\":true,\"children\":", f);
            scan(full, f);
        } else {
            wchar_t ext[64];
            ext_of(list[i].name, ext, 64);
            fputs(",\"isDirectory\":false,", f);
            nx_json_field(f, "extension", ext);
        }
        fputc('}', f);
    }
    fputc(']', f);
    free(list);
}

/*
 *   nexia-core project tree <dir>
 *   nexia-core project read <dir>     — the project's nexia.json, validated
 *   nexia-core project names <name>   — the wizard's two names for a project name
 */
int nx_cmd_project(int argc, wchar_t **argv)
{
    if (argc < 2) { nx_json_error("project: expected 'tree <dir>', 'read <dir>' or 'names <name>'"); return 2; }

    /* Exists so nx_safe_name and nx_safe_filename can be proven against the
     * TypeScript before `project create` — the thing that needs them — is
     * written. Porting the foundation first and testing it later is how you end
     * up debugging the foundation through the building. */
    if (!wcscmp(argv[0], L"names")) {
        wchar_t safe[NX_PATH], file[NX_PATH];
        nx_safe_name(argv[1], safe, NX_PATH);
        nx_safe_filename(argv[1], file, NX_PATH);
        printf("{\"ok\":true,");
        nx_json_field(stdout, "safeName", safe); printf(",");
        nx_json_field(stdout, "fileName", file);
        printf("}\n");
        return 0;
    }

    if (!wcscmp(argv[0], L"tree")) {
        /* An absent directory is an empty tree, not an error: the IDE asks for
         * one before a project is open. */
        if (!nx_is_dir(argv[1])) { printf("{\"ok\":true,\"tree\":[]}\n"); return 0; }
        printf("{\"ok\":true,\"tree\":");
        scan(argv[1], stdout);
        printf("}\n");
        return 0;
    }

    if (!wcscmp(argv[0], L"read")) {
        wchar_t cfg[NX_PATH];
        nx_join(cfg, NX_PATH, argv[1], PROJECT_FILE);

        const char *err = NULL;
        jv *root = jv_parse_file(cfg, &err);
        if (!root) { nx_json_error(err ? err : "no nexia.json found"); return 1; }

        printf("{\"ok\":true,");
        nx_json_field(stdout, "name", jv_get_str(root, L"name", L""));       printf(",");
        nx_json_field(stdout, "type", jv_get_str(root, L"type", L""));       printf(",");
        nx_json_field(stdout, "template", jv_get_str(root, L"template", L"")); printf(",");
        /* The path is where we found it, not what the file says. A project that
         * has been moved still opens: open() in the TypeScript does the same, and
         * it is why the six projects in the old Documents folder still work. */
        nx_json_field(stdout, "path", argv[1]);

        const jv *srcs = jv_get(root, L"sourceFiles");
        printf(",\"sourceFiles\":[");
        for (int i = 0; i < jv_count(srcs); i++) {
            const wchar_t *s = jv_str_or(jv_at(srcs, i), NULL);
            if (!s) continue;
            if (i) printf(",");
            nx_json_str(stdout, s);
        }
        printf("]}\n");

        jv_free(root);
        return 0;
    }

    nx_json_error("project: unknown subcommand");
    return 2;
}

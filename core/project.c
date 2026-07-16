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
 */
int nx_cmd_project(int argc, wchar_t **argv)
{
    if (argc < 2) { nx_json_error("project: expected 'tree <dir>' or 'read <dir>'"); return 2; }

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

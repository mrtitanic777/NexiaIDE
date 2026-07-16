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
#include "templates.h"
#include <string.h>
#include <stdlib.h>

/* calloc that does not come back empty-handed. Same as buildsystem.c's: a
 * one-shot process that cannot allocate has nowhere useful to go. */
static void *bz(size_t n)
{
    void *m = calloc(1, n);
    if (!m) { fwprintf(stderr, L"nexia-core: out of memory\n"); exit(3); }
    return m;
}

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

/* ── create ───────────────────────────────────────────────────────────────── */

/* UTF-8 for the table's sake: template paths and contents are char*, and the
 * names substituted into them can be non-ASCII ("café" survives safeFileName).
 * Substitution happens in UTF-8 so the bytes written are the bytes intended. */
static char *to_u8(const wchar_t *w)
{
    int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, NULL, 0, NULL, NULL);
    if (n <= 0) return NULL;
    char *s = (char *)bz((size_t)n);
    WideCharToMultiByte(CP_UTF8, 0, w, -1, s, n, NULL, NULL);
    return s;
}

static wchar_t *to_w(const char *s)
{
    int n = MultiByteToWideChar(CP_UTF8, 0, s, -1, NULL, 0);
    if (n <= 0) return NULL;
    wchar_t *w = (wchar_t *)bz((size_t)n * sizeof(wchar_t));
    MultiByteToWideChar(CP_UTF8, 0, s, -1, w, n);
    return w;
}

/* replace-all, returning a fresh buffer. */
static char *replace_all(const char *s, const char *find, const char *with)
{
    size_t lf = strlen(find), lw = strlen(with);
    if (!lf) return _strdup(s);

    size_t hits = 0;
    for (const char *p = s; (p = strstr(p, find)); p += lf) hits++;
    if (!hits) return _strdup(s);

    char *out = (char *)bz(strlen(s) + hits * (lw > lf ? lw - lf : 0) + 1);
    char *o = out;
    for (const char *p = s;;) {
        const char *h = strstr(p, find);
        if (!h) { strcpy(o, p); break; }
        memcpy(o, p, (size_t)(h - p)); o += h - p;
        memcpy(o, with, lw);           o += lw;
        p = h + lf;
    }
    return out;
}

/*
 * The wizard's three names, substituted.
 *
 * Longest first. __PROJECT__ cannot actually match inside __PROJECT_UPPER__ —
 * the character after __PROJECT_ is a U, not a second underscore — but relying
 * on that is one rename away from a token that quietly half-substitutes.
 */
static char *expand(const char *text, const char *fileName, const char *safeName, const char *upper)
{
    char *a = replace_all(text, "__PROJECT_UPPER__", upper);
    char *b = replace_all(a, "__PROJECT_SAFE__", safeName);
    char *c = replace_all(b, "__PROJECT__", fileName);
    free(a); free(b);
    return c;
}

static void upper_u8(char *s) { for (; *s; s++) if (*s >= 'a' && *s <= 'z') *s -= 32; }

/* mkdir -p */
static int mkdir_p(const wchar_t *dir)
{
    wchar_t tmp[NX_PATH];
    nx_copy(tmp, NX_PATH, dir);
    for (wchar_t *p = tmp + 1; *p; p++) {
        if (*p == L'\\') { *p = 0; CreateDirectoryW(tmp, NULL); *p = L'\\'; }
    }
    return CreateDirectoryW(tmp, NULL) || GetLastError() == ERROR_ALREADY_EXISTS;
}

static const nx_template *find_template(const char *id)
{
    for (int i = 0; i < NX_TEMPLATE_COUNT; i++)
        if (!strcmp(NX_TEMPLATES[i].id, id)) return &NX_TEMPLATES[i];
    return NULL;
}

/* ── nexia.json, as JSON.stringify(config, null, 2) writes it ─────────────────
 *
 * Two spaces per level, and the key order is the order create() builds the
 * object — JSON.stringify preserves insertion order, so that order is part of
 * the file's shape, not a detail. An empty array is [] on one line; a non-empty
 * one is a line per element. This has to match byte for byte because the
 * TypeScript still reads and rewrites this file.
 */
static void ind(FILE *f, int n) { for (int i = 0; i < n * 2; i++) fputc(' ', f); }

static void arr_u8(FILE *f, int lvl, const char *key, const char **v, int n, int comma)
{
    ind(f, lvl); fprintf(f, "\"%s\": ", key);
    if (!n) { fprintf(f, "[]%s\n", comma ? "," : ""); return; }
    fprintf(f, "[\n");
    for (int i = 0; i < n; i++) {
        ind(f, lvl + 1); nx_json_str_u8(f, v[i]);
        fprintf(f, "%s\n", i + 1 < n ? "," : "");
    }
    ind(f, lvl); fprintf(f, "]%s\n", comma ? "," : "");
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
 * Create a project from a template.
 *
 *   nexia-core project create <name> <directory> <templateId> [--sdk <root>]
 *
 * --sdk rather than detecting: only the templates with sdkFiles need it (XUI's
 * scene, skin and font), and the caller already knows where the SDK is. Asking
 * for it here would make every create pay for a detect.
 */
static int cmd_create(int argc, wchar_t **argv)
{
    if (argc < 3) { nx_json_error("project create: expected <name> <directory> <templateId> [--sdk <root>]"); return 2; }

    const wchar_t *name = argv[0], *directory = argv[1];
    char *tplId = to_u8(argv[2]);
    const wchar_t *sdkRoot = NULL;
    for (int i = 3; i + 1 < argc; i += 2)
        if (!wcscmp(argv[i], L"--sdk")) sdkRoot = argv[i + 1];

    const nx_template *t = find_template(tplId);
    if (!t) { printf("{\"ok\":false,\"error\":\"Template '%s' not found\"}\n", tplId); return 2; }

    /*
     * Resolve everything that can fail before creating any directories. A
     * template whose SDK assets are missing must not leave a half-written
     * project behind — and create() refuses a non-empty folder, so the user
     * could not simply try again afterwards.
     */
    wchar_t sdkSrc[8][NX_PATH];
    if (t->nsdk_files > 0) {
        if (!sdkRoot) {
            printf("{\"ok\":false,\"error\":\"The %s template copies its content from the Xbox 360 SDK, "
                   "which isn't configured yet. Set it up in Settings \\u2192 Advanced \\u2192 SDK Setup, then try again.\"}\n",
                   t->name);
            return 2;
        }
        for (int i = 0; i < t->nsdk_files && i < 8; i++) {
            wchar_t *from = to_w(t->sdk_files[i].from);
            nx_join(sdkSrc[i], NX_PATH, sdkRoot, from);
            if (GetFileAttributesW(sdkSrc[i]) == INVALID_FILE_ATTRIBUTES) {
                printf("{\"ok\":false,\"error\":");
                wchar_t msg[NX_PATH * 2];
                _snwprintf(msg, NX_PATH * 2 - 1,
                    L"Your SDK is missing a file this template needs:\n%ls\n\nIt should be at:\n%ls",
                    from, sdkSrc[i]);
                msg[NX_PATH * 2 - 1] = 0;
                nx_json_str(stdout, msg);
                printf("}\n");
                return 2;
            }
            free(from);
        }
    }

    wchar_t projDir[NX_PATH];
    nx_join(projDir, NX_PATH, directory, name);

    /*
     * Never write into a directory that already holds something.
     *
     * mkdir -p succeeds on an existing directory and the template files are then
     * written straight over whatever is there — including nexia.json. Creating a
     * project whose name collided with an existing one silently destroyed it: an
     * imported project lost its sources, libraries and per-configuration
     * settings to a template's nexia.json while its .cpp files sat on disk
     * unreferenced.
     */
    if (nx_is_dir(projDir)) {
        wchar_t glob[NX_PATH];
        nx_join(glob, NX_PATH, projDir, L"*");
        WIN32_FIND_DATAW fd;
        HANDLE h = FindFirstFileW(glob, &fd);
        int any = 0, isProject = 0;
        if (h != INVALID_HANDLE_VALUE) {
            do {
                if (!wcscmp(fd.cFileName, L".") || !wcscmp(fd.cFileName, L"..")) continue;
                any = 1;
                if (!_wcsicmp(fd.cFileName, PROJECT_FILE)) isProject = 1;
            } while (FindNextFileW(h, &fd));
            FindClose(h);
        }
        if (any) {
            wchar_t msg[NX_PATH * 2];
            if (isProject)
                _snwprintf(msg, NX_PATH * 2 - 1,
                    L"A project named \"%ls\" already exists here. Open it, or pick a different name.", name);
            else
                _snwprintf(msg, NX_PATH * 2 - 1,
                    L"\"%ls\" already exists and isn't empty. Pick a different name or an empty folder.", name);
            msg[NX_PATH * 2 - 1] = 0;
            printf("{\"ok\":false,\"error\":");
            nx_json_str(stdout, msg);
            printf("}\n");
            return 2;
        }
    }

    /* "Media", not "assets" — it is what the XDK calls this. Every sample in
     * Source\Samples loads from a media\ folder, and XUI resource locators are
     * literally "file://game:/media/...". */
    static const wchar_t *DIRS[] = { L"src", L"include", L"Media", L"out" };
    if (!mkdir_p(projDir)) { nx_json_error("project create: cannot create the project directory"); return 1; }
    for (int i = 0; i < 4; i++) {
        wchar_t d[NX_PATH];
        nx_join(d, NX_PATH, projDir, DIRS[i]);
        mkdir_p(d);
    }

    wchar_t wSafe[NX_PATH], wFile[NX_PATH];
    nx_safe_name(name, wSafe, NX_PATH);
    nx_safe_filename(name, wFile, NX_PATH);
    char *safeName = to_u8(wSafe), *fileName = to_u8(wFile);
    char *upper = _strdup(safeName);
    upper_u8(upper);

    wchar_t projFull[NX_PATH];
    if (!GetFullPathNameW(projDir, NX_PATH, projFull, NULL)) nx_copy(projFull, NX_PATH, projDir);

    for (int i = 0; i < t->nfiles; i++) {
        char *rel = expand(t->files[i].path, fileName, safeName, upper);
        wchar_t *wrel = to_w(rel);
        wchar_t dest[NX_PATH];
        nx_join(dest, NX_PATH, projDir, wrel);

        /* safeFileName strips separators, so a substituted path cannot climb out
         * of projDir. Templates are ours, but this is the line where a typo'd
         * literal `..` in one would become an arbitrary file write. */
        wchar_t full[NX_PATH];
        if (!GetFullPathNameW(dest, NX_PATH, full, NULL)) nx_copy(full, NX_PATH, dest);
        size_t n = wcslen(projFull);
        if (_wcsnicmp(full, projFull, n) || (full[n] != L'\\')) {
            printf("{\"ok\":false,\"error\":\"Template '%s' tried to write outside the project: %s\"}\n",
                   tplId, t->files[i].path);
            return 2;
        }

        wchar_t parent[NX_PATH];
        nx_copy(parent, NX_PATH, full);
        wchar_t *slash = wcsrchr(parent, L'\\');
        if (slash) { *slash = 0; mkdir_p(parent); }

        char *body = expand(t->files[i].content, fileName, safeName, upper);
        FILE *f = _wfopen(full, L"wb");
        if (!f) { nx_json_error("project create: cannot write a template file"); return 1; }
        fwrite(body, 1, strlen(body), f);
        fclose(f);
        free(rel); free(wrel); free(body);
    }

    /* Already verified to exist, so a failure here is a real I/O problem. */
    for (int i = 0; i < t->nsdk_files && i < 8; i++) {
        char *rel = expand(t->sdk_files[i].to, fileName, safeName, upper);
        wchar_t *wrel = to_w(rel);
        wchar_t dest[NX_PATH], parent[NX_PATH];
        nx_join(dest, NX_PATH, projDir, wrel);
        nx_copy(parent, NX_PATH, dest);
        wchar_t *slash = wcsrchr(parent, L'\\');
        if (slash) { *slash = 0; mkdir_p(parent); }
        if (!CopyFileW(sdkSrc[i], dest, FALSE)) {
            nx_json_error("project create: cannot copy a file out of the SDK");
            return 1;
        }
        free(rel); free(wrel);
    }

    /* ── nexia.json ── */
    wchar_t cfgPath[NX_PATH];
    nx_join(cfgPath, NX_PATH, projDir, PROJECT_FILE);
    FILE *f = _wfopen(cfgPath, L"wb");
    if (!f) { nx_json_error("project create: cannot write nexia.json"); return 1; }

    char *u8name = to_u8(name), *u8path = to_u8(projDir);

    /* Expanded, as the TypeScript does — sourceFiles carry __PROJECT__ and the
     * DLL template's defines carry __PROJECT_UPPER___EXPORTS. */
    const char *src[16], *def[16];
    for (int i = 0; i < t->nsource_files && i < 16; i++)
        src[i] = expand(t->source_files[i], fileName, safeName, upper);
    for (int i = 0; i < t->ndefines && i < 16; i++)
        def[i] = expand(t->defines[i], fileName, safeName, upper);

    /* A template's own include directories are kept, not replaced. Set semantics
     * and insertion order: 'include', 'src', then anything the template adds
     * that is not already there. */
    const char *inc[16]; int ninc = 0;
    inc[ninc++] = "include"; inc[ninc++] = "src";
    for (int i = 0; i < t->ninclude_dirs && ninc < 16; i++) {
        int seen = 0;
        for (int j = 0; j < ninc; j++) if (!strcmp(inc[j], t->include_dirs[i])) seen = 1;
        if (!seen) inc[ninc++] = t->include_dirs[i];
    }

    fprintf(f, "{\n");
    ind(f, 1); fprintf(f, "\"name\": ");     nx_json_str_u8(f, u8name); fprintf(f, ",\n");
    ind(f, 1); fprintf(f, "\"path\": ");     nx_json_str_u8(f, u8path); fprintf(f, ",\n");
    ind(f, 1); fprintf(f, "\"type\": ");     nx_json_str_u8(f, t->type); fprintf(f, ",\n");
    ind(f, 1); fprintf(f, "\"template\": "); nx_json_str_u8(f, t->template_id); fprintf(f, ",\n");
    arr_u8(f, 1, "sourceFiles", src, t->nsource_files, 1);
    arr_u8(f, 1, "includeDirectories", inc, ninc, 1);
    arr_u8(f, 1, "libraryDirectories", NULL, 0, 1);
    arr_u8(f, 1, "libraries", t->libraries, t->nlibraries, 1);
    arr_u8(f, 1, "defines", def, t->ndefines, 1);
    ind(f, 1); fprintf(f, "\"configuration\": \"Debug\",\n");
    ind(f, 1); fprintf(f, "\"pchHeader\": \"stdafx.h\"");

    if (t->nconfigurations > 0) {
        fprintf(f, ",\n");
        ind(f, 1); fprintf(f, "\"configurations\": {\n");
        for (int i = 0; i < t->nconfigurations; i++) {
            ind(f, 2); nx_json_str_u8(f, t->configurations[i].name); fprintf(f, ": {\n");
            arr_u8(f, 3, "libraries", t->configurations[i].libraries, t->configurations[i].nlibraries, 0);
            ind(f, 2); fprintf(f, "}%s\n", i + 1 < t->nconfigurations ? "," : "");
        }
        ind(f, 1); fprintf(f, "}");
    }

    if (t->xui_package) {
        char *pkg = expand(t->xui_package, fileName, safeName, upper);
        fprintf(f, ",\n");
        ind(f, 1); fprintf(f, "\"xuiContent\": {\n");
        ind(f, 2); fprintf(f, "\"package\": "); nx_json_str_u8(f, pkg); fprintf(f, ",\n");
        arr_u8(f, 2, "scenes", t->xui_scenes, t->nxui_scenes, 1);
        arr_u8(f, 2, "copy", t->xui_copy, t->nxui_copy, 0);
        ind(f, 1); fprintf(f, "}");
        free(pkg);
    }
    fprintf(f, "\n}");
    fclose(f);

    printf("{\"ok\":true,");
    nx_json_field(stdout, "path", projDir);
    printf("}\n");
    return 0;
}

/*
 *   nexia-core project tree <dir>
 *   nexia-core project read <dir>     — the project's nexia.json, validated
 *   nexia-core project names <name>   — the wizard's two names for a project name
 *   nexia-core project create <name> <dir> <templateId> [--sdk <root>]
 */
int nx_cmd_project(int argc, wchar_t **argv)
{
    if (argc < 2) { nx_json_error("project: expected 'tree <dir>', 'read <dir>', 'names <name>' or 'create ...'"); return 2; }

    if (!wcscmp(argv[0], L"create")) return cmd_create(argc - 1, argv + 1);

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

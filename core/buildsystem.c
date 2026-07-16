/*
 * buildsystem.c — construct the compiler driver's command lines, and read what
 * the tools say back.
 *
 * A port of the argument construction and output parsing halves of
 * src/main/buildSystem.ts. The flag lists here look like they want tidying.
 * They do not. Every one of them is the answer to a build that failed on a real
 * machine, and the comments that survived the port from TypeScript are the
 * reasons — the four-way LIBS table and the /NODEFAULTLIB handling especially.
 * Reordering or "simplifying" them silently changes which libraries a user's
 * title links against, which is the kind of bug that surfaces on the console
 * rather than on the PC.
 *
 * WHY THIS PRINTS RATHER THAN SPAWNS.
 * The command line IS the product. `build args` emits exactly what would be
 * run, so parity against the TypeScript can be proved by string comparison on
 * any machine with an SDK — no compiler licence, no devkit, no 40-second build
 * per assertion. Spawning is the easy part and deliberately not done yet.
 *
 * PATHS ARE NODE'S, NOT WINDOWS'.
 * The TypeScript builds these strings with path.join, whose normalisation is
 * observable in the output: path.join(root, 'src/stdafx.cpp') yields a string
 * with backslashes throughout, and cl.exe echoes the path we hand it into the
 * error messages the IDE parses. So win_norm below reimplements node's
 * normalisation rather than leaving separators as they fell — a '/' surviving
 * into /Fo"..." would be a real parity break, not a cosmetic one.
 */
#include "nexia.h"
#include "buildsystem.h"
#include "json_parse.h"
#include <wctype.h>
#include <stdarg.h>

/* ── a growable argv ──────────────────────────────────────────────────────── */

typedef struct { wchar_t **v; int n; int cap; } args;

static void *bz(size_t n)
{
    void *m = calloc(1, n);
    if (!m) { fwprintf(stderr, L"nexia-core: out of memory\n"); exit(3); }
    return m;
}

static void arg_grow(args *a)
{
    if (a->n < a->cap) return;
    int cap = a->cap ? a->cap * 2 : 32;
    wchar_t **nv = (wchar_t **)bz((size_t)cap * sizeof(wchar_t *));
    for (int i = 0; i < a->n; i++) nv[i] = a->v[i];
    free(a->v);
    a->v = nv;
    a->cap = cap;
}

static void arg_push(args *a, const wchar_t *fmt, ...)
{
    wchar_t buf[NX_PATH * 2];
    va_list ap;
    va_start(ap, fmt);
    _vsnwprintf(buf, NX_PATH * 2 - 1, fmt, ap);
    va_end(ap);
    buf[NX_PATH * 2 - 1] = 0;

    arg_grow(a);
    size_t n = wcslen(buf) + 1;
    a->v[a->n] = (wchar_t *)bz(n * sizeof(wchar_t));
    memcpy(a->v[a->n], buf, n * sizeof(wchar_t));
    a->n++;
}

static void arg_remove_at(args *a, int i)
{
    if (i < 0 || i >= a->n) return;
    for (int j = i; j < a->n - 1; j++) a->v[j] = a->v[j + 1];
    a->n--;
}

/* Array.prototype.findIndex over the arg list. */
static int arg_find_prefix(const args *a, const wchar_t *prefix)
{
    size_t n = wcslen(prefix);
    for (int i = 0; i < a->n; i++)
        if (!wcsncmp(a->v[i], prefix, n)) return i;
    return -1;
}

static int arg_find_exact(const args *a, const wchar_t *s)
{
    for (int i = 0; i < a->n; i++)
        if (!wcscmp(a->v[i], s)) return i;
    return -1;
}

/* `str.trim().split(/\s+/).filter(f => f)` — the shape both additionalFlags
 * fields take. An all-whitespace string yields nothing, matching the filter. */
static void arg_push_split(args *a, const wchar_t *s)
{
    if (!s) return;
    while (*s) {
        while (*s && iswspace(*s)) s++;
        if (!*s) break;
        const wchar_t *start = s;
        while (*s && !iswspace(*s)) s++;
        wchar_t tmp[NX_PATH];
        size_t n = (size_t)(s - start);
        if (n >= NX_PATH) n = NX_PATH - 1;
        memcpy(tmp, start, n * sizeof(wchar_t));
        tmp[n] = 0;
        arg_push(a, L"%ls", tmp);
    }
}

/* ── node's path, the parts of it that are observable here ────────────────── */

/*
 * path.win32.normalize, in place.
 *
 * Only the behaviour a project file can actually reach: drive-rooted paths,
 * rooted paths, relative paths, and UNC shares. wcstok collapses runs of
 * separators for free, which is the same thing node does explicitly.
 */
static void win_norm(wchar_t *s)
{
    for (wchar_t *p = s; *p; p++) if (*p == L'/') *p = L'\\';

    size_t len = wcslen(s);
    if (!len) { wcscpy(s, L"."); return; }
    int trailing = (s[len - 1] == L'\\');

    wchar_t root[NX_PATH];
    root[0] = 0;
    size_t i = 0;
    int absolute = 0;

    if (len >= 2 && iswalpha(s[0]) && s[1] == L':') {
        root[0] = s[0]; root[1] = L':'; root[2] = 0; i = 2;
        if (len >= 3 && s[2] == L'\\') { wcscat(root, L"\\"); i = 3; absolute = 1; }
    } else if (len >= 2 && s[0] == L'\\' && s[1] == L'\\') {
        /* \\server\share — both components belong to the root, so a '..' can
         * never climb out of the share. */
        size_t j = 2;
        while (j < len && s[j] != L'\\') j++;
        if (j < len) j++;
        while (j < len && s[j] != L'\\') j++;
        wcsncpy(root, s, j);
        root[j] = 0;
        if (j < len) { wcscat(root, L"\\"); j++; }
        i = j;
        absolute = 1;
    } else if (s[0] == L'\\') {
        wcscpy(root, L"\\"); i = 1; absolute = 1;
    }

    wchar_t rest[NX_PATH];
    nx_copy(rest, NX_PATH, s + i);

    wchar_t *segs[256];
    int ns = 0;
    wchar_t *ctx = NULL;
    for (wchar_t *t = wcstok(rest, L"\\", &ctx); t; t = wcstok(NULL, L"\\", &ctx)) {
        if (!wcscmp(t, L".")) continue;
        if (!wcscmp(t, L"..")) {
            if (ns > 0 && wcscmp(segs[ns - 1], L"..")) ns--;
            else if (!absolute && ns < 256) segs[ns++] = t;
            continue;
        }
        if (ns < 256) segs[ns++] = t;
    }

    wchar_t out[NX_PATH];
    nx_copy(out, NX_PATH, root);
    for (int k = 0; k < ns; k++) {
        size_t have = wcslen(out);
        if (have && out[have - 1] != L'\\') wcsncat(out, L"\\", NX_PATH - have - 1);
        wcsncat(out, segs[k], NX_PATH - wcslen(out) - 1);
    }

    if (!out[0]) { nx_copy(out, NX_PATH, absolute ? L"\\" : L"."); }
    else if (trailing && ns > 0) {
        size_t have = wcslen(out);
        if (have && out[have - 1] != L'\\' && have + 1 < NX_PATH) { out[have] = L'\\'; out[have + 1] = 0; }
    }
    nx_copy(s, NX_PATH, out);
}

/* path.win32.join for two components: concatenate, then normalise. nx_join
 * cannot be used directly — it does not normalise, and 'src/stdafx.cpp' out of
 * nexia.json would keep its forward slash all the way into /Fo"...". */
static void bs_join(wchar_t *out, size_t cap, const wchar_t *a, const wchar_t *b)
{
    wchar_t tmp[NX_PATH];
    if (!a || !*a) nx_copy(tmp, NX_PATH, b ? b : L"");
    else if (!b || !*b) nx_copy(tmp, NX_PATH, a);
    else { _snwprintf(tmp, NX_PATH - 1, L"%ls\\%ls", a, b); tmp[NX_PATH - 1] = 0; }
    if (!tmp[0]) { nx_copy(out, cap, L"."); return; }
    win_norm(tmp);
    nx_copy(out, cap, tmp);
}

static void bs_join3(wchar_t *out, size_t cap, const wchar_t *a, const wchar_t *b, const wchar_t *c)
{
    wchar_t tmp[NX_PATH];
    bs_join(tmp, NX_PATH, a, b);
    bs_join(out, cap, tmp, c);
}

static int win_is_abs(const wchar_t *p)
{
    if (!p || !*p) return 0;
    if (p[0] == L'\\' || p[0] == L'/') return 1;
    if (iswalpha(p[0]) && p[1] == L':' && (p[2] == L'\\' || p[2] == L'/')) return 1;
    return 0;
}

static const wchar_t *win_base(const wchar_t *p)
{
    const wchar_t *b = p;
    for (const wchar_t *q = p; *q; q++) if (*q == L'\\' || *q == L'/') b = q + 1;
    return b;
}

/*
 * path.win32.relative, for two paths that are already absolute.
 *
 * NTFS compares case-insensitively, so the common prefix is found that way —
 * but the remainder is emitted in `to`'s original case, exactly as node does.
 * Different drives have no relative path between them; node returns `to`.
 */
static void win_relative(wchar_t *out, size_t cap, const wchar_t *from, const wchar_t *to)
{
    if (!_wcsicmp(from, to)) { nx_copy(out, cap, L""); return; }

    wchar_t f[NX_PATH], t[NX_PATH];
    nx_copy(f, NX_PATH, from); win_norm(f);
    nx_copy(t, NX_PATH, to);   win_norm(t);

    if (iswalpha(f[0]) && f[1] == L':' && iswalpha(t[0]) && t[1] == L':' &&
        towlower(f[0]) != towlower(t[0])) { nx_copy(out, cap, to); return; }

    wchar_t fb[NX_PATH], tb[NX_PATH];
    nx_copy(fb, NX_PATH, f);
    nx_copy(tb, NX_PATH, t);

    wchar_t *fs[256], *ts[256];
    int nf = 0, nt = 0, i;
    wchar_t *ctx = NULL;
    for (wchar_t *p = wcstok(fb, L"\\", &ctx); p && nf < 256; p = wcstok(NULL, L"\\", &ctx)) fs[nf++] = p;
    ctx = NULL;
    for (wchar_t *p = wcstok(tb, L"\\", &ctx); p && nt < 256; p = wcstok(NULL, L"\\", &ctx)) ts[nt++] = p;

    int common = 0;
    while (common < nf && common < nt && !_wcsicmp(fs[common], ts[common])) common++;

    wchar_t r[NX_PATH];
    r[0] = 0;
    for (i = common; i < nf; i++) {
        if (r[0]) wcsncat(r, L"\\", NX_PATH - wcslen(r) - 1);
        wcsncat(r, L"..", NX_PATH - wcslen(r) - 1);
    }
    for (i = common; i < nt; i++) {
        if (r[0]) wcsncat(r, L"\\", NX_PATH - wcslen(r) - 1);
        wcsncat(r, ts[i], NX_PATH - wcslen(r) - 1);
    }
    nx_copy(out, cap, r);
}

/* ── the project file ─────────────────────────────────────────────────────── */

/*
 * effectiveSettings(project, cfg) — the per-configuration override, else the
 * flat field, else nothing.
 *
 * `??` in the TypeScript falls through on null and undefined only, so a present
 * empty array wins over the flat field. JV_NULL is treated as absent for the
 * same reason: JSON.stringify writes null where a value was explicitly null and
 * omits it where it was undefined, and every optional field here means the same
 * thing either way.
 */
static const jv *eff(const jv *proj, const wchar_t *cfg, const wchar_t *key)
{
    const jv *o = jv_get(jv_get(proj, L"configurations"), cfg);
    const jv *v = jv_get(o, key);
    if (v && v->type != JV_NULL) return v;
    v = jv_get(proj, key);
    if (v && v->type != JV_NULL) return v;
    return NULL;
}

static const wchar_t *eff_str(const jv *proj, const wchar_t *cfg, const wchar_t *key, const wchar_t *fb)
{
    return jv_str_or(eff(proj, cfg, key), fb);
}

/* ── source discovery ─────────────────────────────────────────────────────── */

static int is_source(const wchar_t *name)
{
    const wchar_t *dot = wcsrchr(name, L'.');
    if (!dot) return 0;
    return !_wcsicmp(dot, L".cpp") || !_wcsicmp(dot, L".c") ||
           !_wcsicmp(dot, L".cc")  || !_wcsicmp(dot, L".cxx");
}

static int is_skipped_dir(const wchar_t *name)
{
    return !wcscmp(name, L"out") || !wcscmp(name, L"obj") ||
           !wcscmp(name, L".git") || !wcscmp(name, L"node_modules");
}

/*
 * The TypeScript's scanDir: pre-order, recursing the moment a directory is
 * seen, in readdir order. Node's readdirSync and FindFirstFileW both take their
 * order from the same NTFS enumeration, so the resulting source list — and
 * therefore the .obj order on the link line — matches without sorting either.
 */
static void scan_sources(const wchar_t *dir, args *out)
{
    if (!nx_exists(dir)) return;

    wchar_t pat[NX_PATH];
    bs_join(pat, NX_PATH, dir, L"*");

    WIN32_FIND_DATAW fd;
    HANDLE h = FindFirstFileW(pat, &fd);
    if (h == INVALID_HANDLE_VALUE) return;

    do {
        if (!wcscmp(fd.cFileName, L".") || !wcscmp(fd.cFileName, L"..")) continue;
        wchar_t full[NX_PATH];
        bs_join(full, NX_PATH, dir, fd.cFileName);
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
            if (!is_skipped_dir(fd.cFileName)) scan_sources(full, out);
        } else if (is_source(fd.cFileName)) {
            arg_push(out, L"%ls", full);
        }
    } while (FindNextFileW(h, &fd));

    FindClose(h);
}

static void discover_sources(const wchar_t *projectPath, args *out)
{
    wchar_t srcDir[NX_PATH];
    bs_join(srcDir, NX_PATH, projectPath, L"src");
    scan_sources(srcDir, out);

    /* Loose sources in the project root. Not recursive — the TypeScript only
     * looks one level here. */
    if (!nx_exists(projectPath)) return;
    wchar_t pat[NX_PATH];
    bs_join(pat, NX_PATH, projectPath, L"*");
    WIN32_FIND_DATAW fd;
    HANDLE h = FindFirstFileW(pat, &fd);
    if (h == INVALID_HANDLE_VALUE) return;
    do {
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) continue;
        if (!is_source(fd.cFileName)) continue;
        wchar_t full[NX_PATH];
        bs_join(full, NX_PATH, projectPath, fd.cFileName);
        arg_push(out, L"%ls", full);
    } while (FindNextFileW(h, &fd));
    FindClose(h);
}

/*
 * A unique .obj name from a source path, so src\Main.cpp and src\net\Main.cpp
 * do not both want Main.obj and overwrite each other in a flat output folder.
 *
 *   src/Main.cpp      -> Main.obj
 *   src/net/Main.cpp  -> net_Main.obj
 */
static void unique_obj_name(wchar_t *out, size_t cap, const wchar_t *src, const wchar_t *root)
{
    wchar_t srcDir[NX_PATH];
    bs_join(srcDir, NX_PATH, root, L"src");

    /* JS startsWith is case-sensitive, and both sides were built from the same
     * projectRoot string, so the cases always agree. Mirrored rather than
     * "improved" to _wcsnicmp: a case-insensitive test here would pick a
     * different branch than the TypeScript on a path that differed only in
     * case, and produce a different .obj name. */
    wchar_t rel[NX_PATH];
    size_t n = wcslen(srcDir);
    if (!wcsncmp(src, srcDir, n) && (src[n] == L'\\' || src[n] == L'/'))
        win_relative(rel, NX_PATH, srcDir, src);
    else
        win_relative(rel, NX_PATH, root, src);

    /* rel.replace(/\.[^.]+$/, '') — the last dot that has something after it. */
    wchar_t *dot = wcsrchr(rel, L'.');
    if (dot && dot[1]) *dot = 0;

    for (wchar_t *p = rel; *p; p++) if (*p == L'\\' || *p == L'/') *p = L'_';
    _snwprintf(out, cap - 1, L"%ls.obj", rel);
    out[cap - 1] = 0;
}

/* ── cl.exe ───────────────────────────────────────────────────────────────── */

/*
 * The MSVC CRT headers (excpt.h, stdarg.h) that xtl.h needs, in the order the
 * TypeScript checks them. The TechPreview entry is the one that matters on a
 * machine with no Visual Studio: it has a public excpt.h without the internal
 * #error guard that Source\crt's copy carries.
 */
static const wchar_t *VC_INCLUDE_FIXED[] = {
    L"C:\\Program Files (x86)\\Microsoft Visual Studio 10.0\\VC\\include",
    L"C:\\Program Files\\Microsoft Visual Studio 10.0\\VC\\include",
    L"C:\\Program Files (x86)\\Microsoft Visual Studio 9.0\\VC\\include",
    L"C:\\Program Files\\Microsoft Visual Studio 9.0\\VC\\include",
};

static int vc_include(const nx_sdk *sdk, wchar_t *out, size_t cap)
{
    wchar_t c[8][NX_PATH];
    int n = 0;
    bs_join3(c[n++], NX_PATH, sdk->root, L"vc", L"include");
    bs_join3(c[n++], NX_PATH, sdk->root, L"include", L"msvc");
    bs_join3(c[n++], NX_PATH, sdk->root, L"msvc", L"include");
    {
        wchar_t t[NX_PATH];
        bs_join3(t, NX_PATH, sdk->root, L"TechPreview", L"Jul12Compiler");
        bs_join3(c[n++], NX_PATH, t, L"include", L"xbox");
    }
    for (int i = 0; i < 4; i++) nx_copy(c[n++], NX_PATH, VC_INCLUDE_FIXED[i]);

    for (int i = 0; i < n; i++) {
        wchar_t e[NX_PATH];
        bs_join(e, NX_PATH, c[i], L"excpt.h");
        if (nx_exists(c[i]) && nx_exists(e)) { nx_copy(out, cap, c[i]); return 1; }
    }
    return 0;
}

typedef enum { PCH_NONE = 0, PCH_CREATE, PCH_USE } pch_mode;

static void compile_args(args *a, const jv *proj, const wchar_t *projPath,
                         const nx_sdk *sdk, const wchar_t *cfg, const wchar_t *outDir,
                         const wchar_t *src, const wchar_t *obj,
                         pch_mode pm, const wchar_t *pchHeader, const wchar_t *pchFile)
{
    arg_push(a, L"/nologo");
    arg_push(a, L"/c");
    arg_push(a, L"/Fo\"%ls\"", obj);

    if (pm != PCH_NONE) {
        /* /Yc builds the .pch from this source; /Yu consumes it. */
        arg_push(a, pm == PCH_CREATE ? L"/Yc\"%ls\"" : L"/Yu\"%ls\"", pchHeader);
        arg_push(a, L"/Fp\"%ls\"", pchFile);
    }

    /* Xbox headers first: Source\crt\ holds internal CRT headers that shadow
     * the real ones if the SDK's own include\ is reached first. */
    wchar_t xboxInc[NX_PATH];
    bs_join(xboxInc, NX_PATH, sdk->include, L"xbox");
    if (nx_exists(xboxInc)) arg_push(a, L"/I\"%ls\"", xboxInc);
    arg_push(a, L"/I\"%ls\"", sdk->include);

    wchar_t vcInc[NX_PATH];
    if (vc_include(sdk, vcInc, NX_PATH)) arg_push(a, L"/I\"%ls\"", vcInc);

    wchar_t psrc[NX_PATH];
    bs_join(psrc, NX_PATH, projPath, L"src");
    arg_push(a, L"/I\"%ls\"", psrc);
    arg_push(a, L"/I\"%ls\"", projPath);

    const jv *incs = eff(proj, cfg, L"includeDirectories");
    for (int i = 0; i < jv_count(incs); i++) {
        const wchar_t *inc = jv_str_or(jv_at(incs, i), NULL);
        if (!inc) continue;
        wchar_t p[NX_PATH];
        if (win_is_abs(inc)) { nx_copy(p, NX_PATH, inc); win_norm(p); }
        else bs_join(p, NX_PATH, projPath, inc);
        arg_push(a, L"/I\"%ls\"", p);
    }

    wchar_t pdb[NX_PATH];
    bs_join(pdb, NX_PATH, outDir, L"vc100.pdb");

    if (!wcscmp(cfg, L"Debug")) {
        arg_push(a, L"/Od"); arg_push(a, L"/Zi"); arg_push(a, L"/Fd\"%ls\"", pdb);
        arg_push(a, L"/D_DEBUG"); arg_push(a, L"/DDEBUG"); arg_push(a, L"/RTC1"); arg_push(a, L"/GS");
    } else if (!wcscmp(cfg, L"Release")) {
        arg_push(a, L"/O2"); arg_push(a, L"/Ox"); arg_push(a, L"/DNDEBUG"); arg_push(a, L"/GS-");
    } else if (!wcscmp(cfg, L"Profile")) {
        arg_push(a, L"/O2"); arg_push(a, L"/Zi"); arg_push(a, L"/Fd\"%ls\"", pdb);
        arg_push(a, L"/DNDEBUG"); arg_push(a, L"/DPROFILE"); arg_push(a, L"/GS-");
    } else if (!wcscmp(cfg, L"Release_LTCG")) {
        /* /GL defers codegen to the linker so it can optimise across
         * translation units. It pairs with /LTCG on the link step — a /GL .obj
         * is not a real object file and a plain link fails on it. */
        arg_push(a, L"/O2"); arg_push(a, L"/Ox"); arg_push(a, L"/DNDEBUG");
        arg_push(a, L"/DLTCG"); arg_push(a, L"/GS-"); arg_push(a, L"/GL");
    }

    /*
     * The C runtime must agree with the configuration's _DEBUG.
     *
     * Left to itself cl.exe defaults to /MT while a Debug build defines _DEBUG.
     * The CRT and STL headers then emit debug-only assertion calls
     * (_CrtDbgReportW out of std::vector::operator[], vcompd.lib and friends)
     * that exist only in the debug CRT, and the link fails with one baffling
     * unresolved external. Defaults match Visual Studio's Xbox 360 defaults:
     * MultiThreadedDebug for Debug, MultiThreaded otherwise.
     */
    const wchar_t *crt = eff_str(proj, cfg, L"runtimeLibrary", NULL);
    if (!crt) crt = !wcscmp(cfg, L"Debug") ? L"MTd" : L"MT";
    arg_push(a, L"/%ls", crt);

    arg_push(a, L"/D_XBOX");
    arg_push(a, L"/DXBOX");
    arg_push(a, L"/D_XBOX_VER=200");

    const jv *defs = eff(proj, cfg, L"defines");
    for (int i = 0; i < jv_count(defs); i++) {
        const wchar_t *d = jv_str_or(jv_at(defs, i), NULL);
        if (d) arg_push(a, L"/D%ls", d);
    }

    const wchar_t *ehv = jv_get_str(proj, L"exceptionHandling", L"sync");
    if (!wcscmp(ehv, L"sync")) arg_push(a, L"/EHsc");
    else if (!wcscmp(ehv, L"async")) arg_push(a, L"/EHa");
    /* 'none' omits /EH entirely. */

    int wl = (int)jv_num_or(jv_get(proj, L"warningLevel"), 3);
    arg_push(a, L"/W%d", wl);

    if (jv_bool_or(jv_get(proj, L"treatWarningsAsErrors"), 0)) arg_push(a, L"/WX");

    if (jv_bool_or(jv_get(proj, L"enableRtti"), 0)) arg_push(a, L"/GR");
    else arg_push(a, L"/GR-");

    const wchar_t *oo = jv_get_str(proj, L"optimizationOverride", NULL);
    if (oo && wcscmp(oo, L"default")) {
        /* Pull out whatever the configuration block chose and append the
         * override at the end — the TypeScript splices and pushes, so the
         * override lands last rather than in place, and cl.exe's last-wins rule
         * makes that observable only in the argv. Reproduced exactly. */
        int oIdx = arg_find_prefix(a, L"/O");
        if (oIdx == -1) oIdx = arg_find_exact(a, L"/Od");
        if (oIdx != -1) arg_remove_at(a, oIdx);
        int oxIdx = arg_find_exact(a, L"/Ox");
        if (oxIdx != -1) arg_remove_at(a, oxIdx);

        if (!wcscmp(oo, L"disabled")) arg_push(a, L"/Od");
        else if (!wcscmp(oo, L"minSize")) arg_push(a, L"/O1");
        else if (!wcscmp(oo, L"maxSpeed")) arg_push(a, L"/O2");
        else if (!wcscmp(oo, L"full")) arg_push(a, L"/Ox");
    }

    arg_push_split(a, jv_get_str(proj, L"additionalCompilerFlags", NULL));

    /* config.compilerFlags — the IDE's runtime overrides — are always empty on
     * this path: `build args` has a project and a configuration, not a live
     * BuildConfig. Named here so the omission is deliberate rather than lost. */

    arg_push(a, L"\"%ls\"", src);
}

/* ── link.exe ─────────────────────────────────────────────────────────────── */

/*
 * Default Xbox 360 libraries, per configuration.
 *
 * The XDK ships FOUR flavours of most libs, not two, and the suffix is
 * per-configuration — taken from what VS2010 puts in AdditionalDependencies:
 *
 *   Debug         d3d9d.lib      xact3d.lib      xmcored.lib     (+xbdm)
 *   Profile       d3d9i.lib      xact3i.lib      xmcorei.lib     (+xbdm)  "i" = instrumented
 *   Release       d3d9.lib       xact3.lib       xmcore.lib
 *   Release_LTCG  d3d9ltcg.lib   xact3ltcg.lib   xmcoreltcg.lib
 *
 * This used to be `isDebug ? 'd3d9d.lib' : 'd3d9.lib'`, which meant Profile
 * silently linked the Release libs rather than the instrumented ones, and
 * Release_LTCG had no libs of its own at all.
 */
static const wchar_t *LIBS_DEBUG[] = {
    L"xapilibd.lib", L"xboxkrnl.lib",
    L"d3d9d.lib", L"d3dx9d.lib", L"xgraphicsd.lib",
    L"xaudiod2.lib", L"xactd3.lib", L"x3daudiod.lib",
    L"xmcored.lib", L"xnetd.lib", L"xinput2d.lib", L"vcompd.lib",
    L"xbdm.lib", NULL,
};
static const wchar_t *LIBS_PROFILE[] = {
    L"xapilibi.lib", L"xboxkrnl.lib",
    L"d3d9i.lib", L"d3dx9.lib", L"xgraphics.lib",
    L"xaudio2.lib", L"xact3i.lib", L"x3daudioi.lib",
    L"xmcorei.lib", L"xnet.lib", L"xinput2.lib", L"vcomp.lib",
    L"xbdm.lib", NULL,
};
static const wchar_t *LIBS_RELEASE[] = {
    L"xapilib.lib", L"xboxkrnl.lib",
    L"d3d9.lib", L"d3dx9.lib", L"xgraphics.lib",
    L"xaudio2.lib", L"xact3.lib", L"x3daudio.lib",
    L"xmcore.lib", L"xnet.lib", L"xinput2.lib", L"vcomp.lib", NULL,
};
static const wchar_t *LIBS_LTCG[] = {
    L"xapilib.lib", L"xboxkrnl.lib",
    L"d3d9ltcg.lib", L"d3dx9.lib", L"xgraphics.lib",
    L"xaudio2.lib", L"xact3ltcg.lib", L"x3daudioltcg.lib",
    L"xmcoreltcg.lib", L"xnet.lib", L"xinput2.lib", L"vcomp.lib", NULL,
};

/* `LIBS[cfg] || LIBS.Release` — an unrecognised configuration gets the Release
 * set rather than nothing at all. */
static const wchar_t **libs_for(const wchar_t *cfg)
{
    if (!wcscmp(cfg, L"Debug")) return LIBS_DEBUG;
    if (!wcscmp(cfg, L"Profile")) return LIBS_PROFILE;
    if (!wcscmp(cfg, L"Release")) return LIBS_RELEASE;
    if (!wcscmp(cfg, L"Release_LTCG")) return LIBS_LTCG;
    return LIBS_RELEASE;
}

static void link_args(args *a, const jv *proj, const wchar_t *projPath,
                      const nx_sdk *sdk, const wchar_t *cfg,
                      const wchar_t *outPath, const args *objs)
{
    const wchar_t *type = jv_get_str(proj, L"type", L"executable");

    arg_push(a, L"/nologo");
    arg_push(a, L"/OUT:\"%ls\"", outPath);

    if (!wcscmp(type, L"dll")) arg_push(a, L"/DLL");

    /* Xbox 360 link.exe infers MACHINE/SUBSYSTEM/ENTRY on its own. */

    wchar_t xboxLib[NX_PATH];
    bs_join(xboxLib, NX_PATH, sdk->lib, L"xbox");
    if (nx_exists(xboxLib)) arg_push(a, L"/LIBPATH:\"%ls\"", xboxLib);

    const jv *libDirs = eff(proj, cfg, L"libraryDirectories");
    for (int i = 0; i < jv_count(libDirs); i++) {
        const wchar_t *d = jv_str_or(jv_at(libDirs, i), NULL);
        if (!d) continue;
        wchar_t p[NX_PATH];
        if (win_is_abs(d)) { nx_copy(p, NX_PATH, d); win_norm(p); }
        else bs_join(p, NX_PATH, projPath, d);
        arg_push(a, L"/LIBPATH:\"%ls\"", p);
    }

    for (const wchar_t **l = libs_for(cfg); *l; l++) arg_push(a, L"%ls", *l);

    /* The SDK headers auto-link xapilib.lib via #pragma comment(lib). Suppress
     * it wherever we link a different flavour, or both end up on the command
     * line and the linker reports duplicate symbols. Release and Release_LTCG
     * link xapilib itself, so they must NOT suppress it. */
    if (!wcscmp(cfg, L"Debug")) arg_push(a, L"/NODEFAULTLIB:xapilib.lib");
    else if (!wcscmp(cfg, L"Profile")) arg_push(a, L"/NODEFAULTLIB:xapilib.lib");

    const jv *libs = eff(proj, cfg, L"libraries");
    for (int i = 0; i < jv_count(libs); i++) {
        const wchar_t *l = jv_str_or(jv_at(libs, i), NULL);
        if (l) arg_push(a, L"%ls", l);
    }

    /* /LTCG must match the /GL used when compiling. It is incompatible with
     * /INCREMENTAL, so it goes before the debug block and Release_LTCG
     * deliberately takes neither. */
    if (!wcscmp(cfg, L"Release_LTCG")) arg_push(a, L"/LTCG");

    if (!wcscmp(cfg, L"Debug") || !wcscmp(cfg, L"Profile")) {
        arg_push(a, L"/INCREMENTAL");
        arg_push(a, L"/DEBUG");
        wchar_t pdb[NX_PATH];
        nx_copy(pdb, NX_PATH, outPath);
        size_t n = wcslen(pdb);
        /* outputPath.replace(/\.(exe|dll)$/i, '.pdb') */
        if (n >= 4 && (!_wcsicmp(pdb + n - 4, L".exe") || !_wcsicmp(pdb + n - 4, L".dll")))
            wcscpy(pdb + n - 4, L".pdb");
        arg_push(a, L"/PDB:\"%ls\"", pdb);
    }

    arg_push_split(a, jv_get_str(proj, L"additionalLinkerFlags", NULL));

    for (int i = 0; i < objs->n; i++) arg_push(a, L"\"%ls\"", objs->v[i]);

    /* XEX generation is a separate imagexex.exe pass, not link.exe's. */
    arg_push(a, L"/XEX:NO");
}

/* lib.exe. Far shorter than the link line, and deliberately so: an archive has
 * no libraries, no configuration flavour and no XEX. */
static void archive_args(args *a, const jv *proj, const wchar_t *outPath, const args *objs)
{
    arg_push(a, L"/nologo");
    arg_push(a, L"/OUT:\"%ls\"", outPath);
    arg_push_split(a, jv_get_str(proj, L"additionalLinkerFlags", NULL));
    for (int i = 0; i < objs->n; i++) arg_push(a, L"\"%ls\"", objs->v[i]);
}

/* ── the tools' output ────────────────────────────────────────────────────── */

typedef struct {
    wchar_t file[NX_PATH];
    int line;
    int column;
    wchar_t message[NX_PATH * 2];
    int is_error;
} diag;

static const wchar_t *skip_ws(const wchar_t *p) { while (*p && iswspace(*p)) p++; return p; }

static int word_ci(const wchar_t **p, const wchar_t *word)
{
    size_t n = wcslen(word);
    if (_wcsnicmp(*p, word, n)) return 0;
    *p += n;
    return 1;
}

/*
 * /^(.+?)\((\d+)\)\s*:\s*(error|warning)\s+(\w+)\s*:\s*(.+)/i
 *
 * The classic MSVC diagnostic: "file(line): error C2065: message". `.+?` is
 * lazy, so the earliest "(digits)" that lets the REST of the pattern match
 * wins — which is why this loops over candidate positions and backtracks rather
 * than taking the first parenthesis it sees. A path like
 * "c:\p (x86)\a.cpp(12): error C1: m" has an earlier "(" that must be rejected.
 */
static int parse_msvc(const wchar_t *line, diag *d)
{
    for (size_t p = 1; line[p]; p++) {
        if (line[p] != L'(') continue;
        size_t q = p + 1;
        if (!iswdigit(line[q])) continue;
        while (iswdigit(line[q])) q++;
        if (line[q] != L')') continue;

        const wchar_t *r = skip_ws(line + q + 1);
        if (*r != L':') continue;
        r = skip_ws(r + 1);

        int is_err;
        if (word_ci(&r, L"error")) is_err = 1;
        else if (word_ci(&r, L"warning")) is_err = 0;
        else continue;

        if (!iswspace(*r)) continue;          /* \s+ */
        r = skip_ws(r);

        const wchar_t *code = r;              /* (\w+) */
        while (iswalnum(*r) || *r == L'_') r++;
        if (r == code) continue;
        size_t codelen = (size_t)(r - code);

        const wchar_t *s = skip_ws(r);
        if (*s != L':') continue;
        s = skip_ws(s + 1);
        if (!*s) continue;                    /* (.+) needs at least one char */

        size_t flen = p < NX_PATH - 1 ? p : NX_PATH - 1;
        memcpy(d->file, line, flen * sizeof(wchar_t));
        d->file[flen] = 0;
        d->line = (int)wcstol(line + p + 1, NULL, 10);
        d->column = 0;
        d->is_error = is_err;
        _snwprintf(d->message, NX_PATH * 2 - 1, L"%.*ls: %ls", (int)codelen, code, s);
        d->message[NX_PATH * 2 - 1] = 0;
        return 1;
    }
    return 0;
}

/*
 * /LINK\s*:\s*(fatal\s+error|error|warning)\s+(\w+)\s*:\s*(.+)/i
 *
 * Unanchored, so it matches "LINK : fatal error LNK1104: ..." wherever it
 * starts. The alternation is ordered: "fatal error" is tried before "error",
 * because the regex engine takes the first branch that matches, not the
 * longest.
 */
static int parse_link(const wchar_t *line, const wchar_t *ctxFile, diag *d)
{
    for (size_t i = 0; line[i]; i++) {
        if (_wcsnicmp(line + i, L"LINK", 4)) continue;
        const wchar_t *r = skip_ws(line + i + 4);
        if (*r != L':') continue;
        r = skip_ws(r + 1);

        int is_err;
        const wchar_t *save = r;
        if (word_ci(&r, L"fatal")) {
            if (!iswspace(*r)) { r = save; continue; }
            r = skip_ws(r);
            if (!word_ci(&r, L"error")) { r = save; continue; }
            is_err = 1;
        } else if (word_ci(&r, L"error")) is_err = 1;
        else if (word_ci(&r, L"warning")) is_err = 0;
        else continue;

        if (!iswspace(*r)) continue;
        r = skip_ws(r);

        const wchar_t *code = r;
        while (iswalnum(*r) || *r == L'_') r++;
        if (r == code) continue;
        size_t codelen = (size_t)(r - code);

        const wchar_t *s = skip_ws(r);
        if (*s != L':') continue;
        s = skip_ws(s + 1);
        if (!*s) continue;

        nx_copy(d->file, NX_PATH, (ctxFile && *ctxFile) ? ctxFile : L"LINK");
        d->line = 0;
        d->column = 0;
        d->is_error = is_err;
        _snwprintf(d->message, NX_PATH * 2 - 1, L"%.*ls: %ls", (int)codelen, code, s);
        d->message[NX_PATH * 2 - 1] = 0;
        return 1;
    }
    return 0;
}

/*
 * /error\s+(LNK\d+)\s*:\s*(.+)/i — the unresolved-external shape, which names
 * the .obj rather than a source line and so never matches the MSVC pattern.
 */
static int parse_unresolved(const wchar_t *line, const wchar_t *ctxFile, diag *d)
{
    for (size_t i = 0; line[i]; i++) {
        const wchar_t *r = line + i;
        if (!word_ci(&r, L"error")) continue;
        if (!iswspace(*r)) continue;
        r = skip_ws(r);

        const wchar_t *code = r;
        if (_wcsnicmp(r, L"LNK", 3)) continue;
        r += 3;
        if (!iswdigit(*r)) continue;
        while (iswdigit(*r)) r++;
        size_t codelen = (size_t)(r - code);

        const wchar_t *s = skip_ws(r);
        if (*s != L':') continue;
        s = skip_ws(s + 1);
        if (!*s) continue;

        nx_copy(d->file, NX_PATH, (ctxFile && *ctxFile) ? ctxFile : L"LINK");
        d->line = 0;
        d->column = 0;
        d->is_error = 1;
        _snwprintf(d->message, NX_PATH * 2 - 1, L"%.*ls: %ls", (int)codelen, code, s);
        d->message[NX_PATH * 2 - 1] = 0;
        return 1;
    }
    return 0;
}

/* The catch-all that decides what reaches the Output window: not the banner,
 * not cl.exe's echo of the filename it is compiling, not blanks. */
static int is_noise(const wchar_t *line)
{
    if (!_wcsnicmp(line, L"Microsoft", 9)) return 1;
    if (!_wcsnicmp(line, L"Copyright", 9)) return 1;
    if (!*line) return 1;

    /* /^\w+\.(cpp|c|cc|cxx|obj|h)$/i — a bare filename with no directory. */
    const wchar_t *p = line;
    while (iswalnum(*p) || *p == L'_') p++;
    if (p == line || *p != L'.') return 0;
    const wchar_t *ext = p + 1;
    if (!_wcsicmp(ext, L"cpp") || !_wcsicmp(ext, L"c") || !_wcsicmp(ext, L"cc") ||
        !_wcsicmp(ext, L"cxx") || !_wcsicmp(ext, L"obj") || !_wcsicmp(ext, L"h")) return 1;
    return 0;
}

/* ── output ───────────────────────────────────────────────────────────────── */

static void print_args(const args *a)
{
    printf("[");
    for (int i = 0; i < a->n; i++) { if (i) printf(","); nx_json_str(stdout, a->v[i]); }
    printf("]");
}

static void print_diag(const diag *d)
{
    printf("{");
    nx_json_field(stdout, "file", d->file);
    printf(",\"line\":%d,\"column\":%d,", d->line, d->column);
    nx_json_field(stdout, "message", d->message);
    printf(",\"severity\":\"%s\"}", d->is_error ? "error" : "warning");
}

/* ── build args ───────────────────────────────────────────────────────────── */

static int is_known_cfg(const wchar_t *c)
{
    return !wcscmp(c, L"Debug") || !wcscmp(c, L"Release") ||
           !wcscmp(c, L"Profile") || !wcscmp(c, L"Release_LTCG");
}

static int cmd_args(int argc, wchar_t **argv)
{
    if (argc < 2) { nx_json_error("build args: expected <project.json> <Configuration>"); return 2; }

    const wchar_t *cfgPath = argv[0];
    const wchar_t *cfg = argv[1];
    if (!is_known_cfg(cfg)) {
        /* Not fatal in the TypeScript — an unknown configuration just misses
         * every flag block and takes the Release libs. Refused here because
         * reaching that state from a command line is a typo, not a project. */
        nx_json_error("build args: configuration must be Debug, Release, Profile or Release_LTCG");
        return 2;
    }

    const char *err = NULL;
    jv *proj = jv_parse_file(cfgPath, &err);
    if (!proj || proj->type != JV_OBJ) {
        printf("{\"ok\":false,\"error\":\"cannot read project: %s\"}\n", err ? err : "not a JSON object");
        return 2;
    }

    /* project.path as recorded. The TypeScript's BuildSystem is handed a
     * ProjectConfig whose .path came from the same field, so this matches; a
     * project file with no path at all falls back to where it was found. */
    wchar_t projPath[NX_PATH];
    const wchar_t *p = jv_get_str(proj, L"path", NULL);
    if (p && *p) { nx_copy(projPath, NX_PATH, p); win_norm(projPath); }
    else {
        wchar_t full[NX_PATH];
        if (!GetFullPathNameW(cfgPath, NX_PATH, full, NULL)) nx_copy(full, NX_PATH, cfgPath);
        wchar_t *b = (wchar_t *)win_base(full);
        if (b > full) b[-1] = 0;
        nx_copy(projPath, NX_PATH, full);
    }

    if (jv_count(jv_get(proj, L"projectReferences")) > 0) {
        /* Resolving a reference means building it, which means spawning — the
         * part deliberately not ported. Refusing beats emitting a link line
         * that is missing its dependency's .lib and looks correct. */
        nx_json_error("build args: projects with projectReferences are not supported yet (they require building the referenced project)");
        return 2;
    }

    nx_hints h;
    h.custom = NULL; h.resources = NULL; h.exe_dir = NULL;
    nx_sdk sdk;
    if (!nx_sdk_detect(&h, &sdk)) { nx_json_error("Xbox 360 SDK not configured"); return 2; }

    wchar_t clPath[NX_PATH], linkPath[NX_PATH], libPath[NX_PATH];
    int haveCl = nx_tool_path(&sdk, L"cl.exe", clPath, NX_PATH);
    int haveLink = nx_tool_path(&sdk, L"link.exe", linkPath, NX_PATH);
    int haveLib = nx_tool_path(&sdk, L"lib.exe", libPath, NX_PATH);
    if (!haveCl) { nx_json_error("cl.exe not found in SDK"); return 2; }

    const wchar_t *name = jv_get_str(proj, L"name", L"project");
    const wchar_t *type = jv_get_str(proj, L"type", L"executable");

    wchar_t outDir[NX_PATH];
    bs_join3(outDir, NX_PATH, projPath, L"out", cfg);

    /* ── the source list, exactly as runBuild assembles it ── */
    args srcs;
    memset(&srcs, 0, sizeof srcs);

    const jv *conf = jv_get(proj, L"sourceFiles");
    for (int i = 0; i < jv_count(conf); i++) {
        const wchar_t *f = jv_str_or(jv_at(conf, i), NULL);
        if (!f || !is_source(f)) continue;
        wchar_t abs[NX_PATH];
        if (win_is_abs(f)) { nx_copy(abs, NX_PATH, f); win_norm(abs); }
        else bs_join(abs, NX_PATH, projPath, f);
        arg_push(&srcs, L"%ls", abs);
    }

    args disc;
    memset(&disc, 0, sizeof disc);
    discover_sources(projPath, &disc);
    for (int i = 0; i < disc.n; i++) arg_push(&srcs, L"%ls", disc.v[i]);

    /* Dedup, case-insensitively — NTFS treats main.cpp and Main.cpp as one
     * file, and the configured list and the directory scan will name the same
     * source in whichever case each happened to record. First occurrence wins,
     * preserving the Set's insertion order. */
    args files;
    memset(&files, 0, sizeof files);
    for (int i = 0; i < srcs.n; i++) {
        int seen = 0;
        for (int j = 0; j < files.n && !seen; j++)
            if (!_wcsicmp(files.v[j], srcs.v[i])) seen = 1;
        if (!seen) arg_push(&files, L"%ls", srcs.v[i]);
    }

    /* ── PCH ── */
    const wchar_t *pchHeader = jv_get_str(proj, L"pchHeader", L"stdafx.h");
    wchar_t pchCppName[NX_PATH], pchFile[NX_PATH], pchBase[NX_PATH];
    nx_copy(pchBase, NX_PATH, pchHeader);
    {   /* pchHeader.replace(/\.h$/i, '.cpp') and .replace(/\.h$/i, '.pch') */
        size_t n = wcslen(pchBase);
        wchar_t stem[NX_PATH];
        nx_copy(stem, NX_PATH, pchBase);
        if (n >= 2 && !_wcsicmp(stem + n - 2, L".h")) stem[n - 2] = 0;
        else nx_copy(stem, NX_PATH, pchBase);
        int replaced = (n >= 2 && !_wcsicmp(pchBase + n - 2, L".h"));
        _snwprintf(pchCppName, NX_PATH - 1, replaced ? L"%ls.cpp" : L"%ls", stem);
        pchCppName[NX_PATH - 1] = 0;
        wchar_t pchName[NX_PATH];
        _snwprintf(pchName, NX_PATH - 1, replaced ? L"%ls.pch" : L"%ls", stem);
        pchName[NX_PATH - 1] = 0;
        bs_join(pchFile, NX_PATH, outDir, pchName);
    }

    int pchIdx = -1;
    for (int i = 0; i < files.n; i++)
        if (!_wcsicmp(win_base(files.v[i]), pchCppName)) { pchIdx = i; break; }
    int usePch = (pchIdx >= 0);

    /* ── compile lines, in runBuild's order: the PCH first with /Yc, then the
     *    rest with /Yu ── */
    printf("{\"ok\":true,");
    nx_json_field(stdout, "configuration", cfg);
    printf(",");
    nx_json_field(stdout, "outputDir", outDir);
    printf(",");
    nx_json_field(stdout, "compileTool", clPath);
    printf(",\"compile\":[");

    args objs;
    memset(&objs, 0, sizeof objs);
    int first = 1;

    for (int pass = 0; pass < 2; pass++) {
        for (int i = 0; i < files.n; i++) {
            int isPch = (i == pchIdx);
            if (pass == 0 && !isPch) continue;
            if (pass == 1 && isPch) continue;

            wchar_t objName[NX_PATH], objPath[NX_PATH];
            unique_obj_name(objName, NX_PATH, files.v[i], projPath);
            bs_join(objPath, NX_PATH, outDir, objName);
            arg_push(&objs, L"%ls", objPath);

            args a;
            memset(&a, 0, sizeof a);
            pch_mode pm = !usePch ? PCH_NONE : (isPch ? PCH_CREATE : PCH_USE);
            compile_args(&a, proj, projPath, &sdk, cfg, outDir, files.v[i], objPath,
                         pm, pchHeader, pchFile);

            if (!first) printf(",");
            first = 0;
            printf("{");
            nx_json_field(stdout, "source", files.v[i]);
            printf(",");
            nx_json_field(stdout, "obj", objPath);
            printf(",\"args\":");
            print_args(&a);
            printf("}");
        }
    }
    printf("],");

    /* ── link or archive ── */
    if (!wcscmp(type, L"library")) {
        wchar_t out[NX_PATH], libName[NX_PATH];
        _snwprintf(libName, NX_PATH - 1, L"%ls.lib", name);
        libName[NX_PATH - 1] = 0;
        bs_join(out, NX_PATH, outDir, libName);

        args a;
        memset(&a, 0, sizeof a);
        archive_args(&a, proj, out, &objs);

        nx_json_field(stdout, "archiveTool", haveLib ? libPath : L"");
        printf(",");
        nx_json_field(stdout, "output", out);
        printf(",\"link\":null,\"archive\":");
        print_args(&a);
    } else {
        wchar_t out[NX_PATH], exeName[NX_PATH];
        _snwprintf(exeName, NX_PATH - 1, L"%ls%ls", name, !wcscmp(type, L"dll") ? L".dll" : L".exe");
        exeName[NX_PATH - 1] = 0;
        bs_join(out, NX_PATH, outDir, exeName);

        args a;
        memset(&a, 0, sizeof a);
        link_args(&a, proj, projPath, &sdk, cfg, out, &objs);

        nx_json_field(stdout, "linkTool", haveLink ? linkPath : L"");
        printf(",");
        nx_json_field(stdout, "output", out);
        printf(",\"archive\":null,\"link\":");
        print_args(&a);
    }

    printf("}\n");
    return 0;
}

/* ── build parse ──────────────────────────────────────────────────────────── */

static int cmd_parse(int argc, wchar_t **argv)
{
    if (argc < 1) { nx_json_error("build parse: expected <toolOutputFile>"); return 2; }

    FILE *f = _wfopen(argv[0], L"rb");
    if (!f) { nx_json_error("build parse: cannot open file"); return 2; }
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (n < 0) { fclose(f); nx_json_error("build parse: cannot size file"); return 2; }
    char *buf = (char *)bz((size_t)n + 1);
    size_t got = fread(buf, 1, (size_t)n, f);
    fclose(f);
    buf[got] = 0;

    /* The tools speak the console's code page, not UTF-8. CP_ACP is what
     * node's default decoding of a piped stdout amounts to on this machine, and
     * a diagnostic quoting a non-ASCII identifier is the only case where the
     * two disagree. */
    int wn = MultiByteToWideChar(CP_ACP, 0, buf, (int)got, NULL, 0);
    wchar_t *w = (wchar_t *)bz((size_t)(wn + 1) * sizeof(wchar_t));
    MultiByteToWideChar(CP_ACP, 0, buf, (int)got, w, wn);
    w[wn] = 0;

    /* Heap, not stack. A diag is ~6 KB (two fixed path/message buffers), so
     * 512 of each on the stack is 6 MB against a 1 MB default and the process
     * dies with STATUS_STACK_OVERFLOW before it parses a line. */
    enum { MAX_DIAG = 512 };
    diag *errs = (diag *)bz(MAX_DIAG * sizeof(diag));
    diag *warns = (diag *)bz(MAX_DIAG * sizeof(diag));
    int ne = 0, nw = 0;
    args raw;
    memset(&raw, 0, sizeof raw);

    /* runTool splits on '\n', trims each line and drops the blanks before any
     * pattern is tried, so '\r' never reaches a matcher. */
    wchar_t *ctx = NULL;
    for (wchar_t *line = wcstok(w, L"\n", &ctx); line; line = wcstok(NULL, L"\n", &ctx)) {
        while (*line && iswspace(*line)) line++;
        size_t len = wcslen(line);
        while (len && iswspace(line[len - 1])) line[--len] = 0;
        if (!len) continue;

        diag d;
        memset(&d, 0, sizeof d);

        if (parse_msvc(line, &d)) {
            if (d.is_error) { if (ne < MAX_DIAG) errs[ne++] = d; }
            else { if (nw < MAX_DIAG) warns[nw++] = d; }
            arg_push(&raw, L"%ls", line);
            continue;
        }
        if (parse_link(line, L"", &d)) {
            if (d.is_error) { if (ne < MAX_DIAG) errs[ne++] = d; }
            else { if (nw < MAX_DIAG) warns[nw++] = d; }
            arg_push(&raw, L"%ls", line);
            continue;
        }
        if (parse_unresolved(line, L"", &d)) {
            if (ne < MAX_DIAG) errs[ne++] = d;
            arg_push(&raw, L"%ls", line);
            continue;
        }
        if (!is_noise(line)) arg_push(&raw, L"%ls", line);
    }

    printf("{\"ok\":true,\"errors\":[");
    for (int i = 0; i < ne; i++) { if (i) printf(","); print_diag(&errs[i]); }
    printf("],\"warnings\":[");
    for (int i = 0; i < nw; i++) { if (i) printf(","); print_diag(&warns[i]); }
    printf("],\"raw\":");
    print_args(&raw);
    printf("}\n");
    return 0;
}

int nx_cmd_build(int argc, wchar_t **argv)
{
    if (argc < 1) { nx_json_error("build: expected a subcommand"); return 2; }
    if (!wcscmp(argv[0], L"args"))  return cmd_args(argc - 1, argv + 1);
    if (!wcscmp(argv[0], L"parse")) return cmd_parse(argc - 1, argv + 1);
    nx_json_error("build: unknown subcommand");
    return 2;
}

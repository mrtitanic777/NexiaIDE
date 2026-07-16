/*
 * vsimport.c — read Visual Studio projects, the way vsImporter.ts does.
 *
 * The TypeScript does not use an XML parser: it runs regexes over the raw file
 * text. .vcxproj is MSBuild XML and .vcproj is the older attribute format, and
 * both are matched by pattern rather than parsed into a tree. So this ports the
 * patterns, not a parser — C has no regex, so each one becomes a small scanner,
 * and the scanners have to make the same decisions the regexes did, down to the
 * case-insensitivity and the trimming.
 *
 * This first layer is the leaf functions: the pure value mappers and the list
 * and macro helpers that everything above them calls. They touch no files and
 * decide every field's final value, so they are ported and proven before the
 * extraction that feeds them. Names first, building second.
 */
#include "nexia.h"
#include "json_parse.h"
#include <string.h>
#include <stdlib.h>
#include <wctype.h>

/* ── small wide-string helpers ────────────────────────────────────────────── */

/* JavaScript's trim (the edges) — ASCII is all these tokens can be, but the
 * whitespace set matches String.prototype.trim so a value copied from the XML
 * lands the same. */
static int ws(wchar_t c)
{
    return c == 0x20 || c == 0x09 || c == 0x0a || c == 0x0d || c == 0x0b || c == 0x0c ||
           c == 0xa0 || c == 0xfeff;
}

static void trim(wchar_t *s)
{
    size_t n = wcslen(s);
    while (n && ws(s[n - 1])) s[--n] = 0;
    size_t lead = 0;
    while (s[lead] && ws(s[lead])) lead++;
    if (lead) memmove(s, s + lead, (n - lead + 1) * sizeof(wchar_t));
}

/* case-insensitive equality, ASCII — the mappers all compare against ASCII
 * literals, and _wcsicmp's locale folding is not wanted here. */
static int ieq(const wchar_t *a, const wchar_t *b)
{
    for (; *a && *b; a++, b++) {
        wchar_t ca = (*a >= L'A' && *a <= L'Z') ? *a + 32 : *a;
        wchar_t cb = (*b >= L'A' && *b <= L'Z') ? *b + 32 : *b;
        if (ca != cb) return 0;
    }
    return *a == *b;
}

/* case-insensitive substring, ASCII. For the /Level(\d)/i-style tests. */
static const wchar_t *istr(const wchar_t *hay, const wchar_t *needle)
{
    size_t nl = wcslen(needle);
    if (!nl) return hay;
    for (; *hay; hay++) {
        size_t i = 0;
        for (; i < nl; i++) {
            wchar_t h = hay[i], n = needle[i];
            if (h >= L'A' && h <= L'Z') h += 32;
            if (n >= L'A' && n <= L'Z') n += 32;
            if (h != n) break;
        }
        if (i == nl) return hay;
    }
    return NULL;
}

/* ── the leaf mappers, one per vsImporter.ts function ─────────────────────── */

/*
 * unescapeMsbuild: %XX hex escapes -> the character.
 *
 * MSBuild percent-encodes reserved characters in attribute values (a semicolon
 * in a path becomes %3B). In place, since the result is never longer.
 */
void vs_unescape_msbuild(wchar_t *s)
{
    wchar_t *o = s;
    for (wchar_t *p = s; *p; ) {
        if (p[0] == L'%' && iswxdigit(p[1]) && iswxdigit(p[2])) {
            wchar_t hex[3] = { p[1], p[2], 0 };
            *o++ = (wchar_t)wcstol(hex, NULL, 16);
            p += 3;
        } else {
            *o++ = *p++;
        }
    }
    *o = 0;
}

/* isUnresolvableMacro: contains $( or %(. */
int vs_is_unresolvable_macro(const wchar_t *v)
{
    for (const wchar_t *p = v; *p; p++)
        if ((p[0] == L'$' || p[0] == L'%') && p[1] == L'(') return 1;
    return 0;
}

/*
 * mapWarningLevel -> 0..4, or -1 for "undefined" (the caller omits the field).
 *
 *   /Level(\d)/i          -> that digit, clamped 0..4
 *   /TurnOffAllWarnings/i -> 0
 *   a bare integer        -> clamped 0..4
 */
int vs_map_warning_level(const wchar_t *v)
{
    if (!v || !*v) return -1;
    const wchar_t *lvl = istr(v, L"level");
    if (lvl && iswdigit(lvl[5])) {
        int n = lvl[5] - L'0';
        return n < 0 ? 0 : n > 4 ? 4 : n;
    }
    if (istr(v, L"turnoffallwarnings")) return 0;
    wchar_t *end = NULL;
    long n = wcstol(v, &end, 10);
    if (end == v) return -1;
    return n < 0 ? 0 : n > 4 ? 4 : (int)n;
}

/* mapOptimization -> one of the strings, or NULL for undefined. */
const char *vs_map_optimization(const wchar_t *v)
{
    if (!v || !*v) return NULL;
    if (ieq(v, L"Disabled") || ieq(v, L"0")) return "disabled";
    if (ieq(v, L"MinSpace") || ieq(v, L"1")) return "minSize";
    if (ieq(v, L"MaxSpeed") || ieq(v, L"2")) return "maxSpeed";
    if (ieq(v, L"Full") || ieq(v, L"3")) return "full";
    return "default";
}

/* mapRuntimeLibrary -> MT/MTd/MD/MDd, or NULL to let the build system choose. */
const char *vs_map_runtime_library(const wchar_t *v)
{
    wchar_t t[64];
    nx_copy(t, 64, v ? v : L"");
    trim(t);
    if (!wcscmp(t, L"MultiThreaded"))         return "MT";
    if (!wcscmp(t, L"MultiThreadedDebug"))    return "MTd";
    if (!wcscmp(t, L"MultiThreadedDLL"))      return "MD";
    if (!wcscmp(t, L"MultiThreadedDebugDLL")) return "MDd";
    if (!wcscmp(t, L"0")) return "MT";
    if (!wcscmp(t, L"1")) return "MTd";
    if (!wcscmp(t, L"2")) return "MD";
    if (!wcscmp(t, L"3")) return "MDd";
    return NULL;
}

/*
 * mapExceptions -> sync/async/none, or NULL for undefined.
 *
 * The one with a twist: SyncCThrow matches the /^(false|0|SyncCThrow)$/ arm but
 * returns 'sync', not 'none' — so it has to be tested before the plain false/0.
 */
const char *vs_map_exceptions(const wchar_t *v)
{
    if (!v || !*v) return NULL;
    if (ieq(v, L"Sync") || ieq(v, L"true") || ieq(v, L"1") || ieq(v, L"Cpp")) return "sync";
    if (ieq(v, L"Async") || ieq(v, L"2")) return "async";
    if (ieq(v, L"SyncCThrow")) return "sync";
    if (ieq(v, L"false") || ieq(v, L"0")) return "none";
    return NULL;
}

/* mapConfigurationType -> executable/dll/library. */
const char *vs_map_configuration_type(const wchar_t *v)
{
    if (!v || !*v) return "executable";
    if (istr(v, L"StaticLibrary") || ieq(v, L"4")) return "library";
    if (istr(v, L"DynamicLibrary") || ieq(v, L"2")) return "dll";
    return "executable";
}

/* ── files and paths ──────────────────────────────────────────────────────── */

/*
 * Read a whole file as a wide string, decoding UTF-8.
 *
 * These files are read with fs.readFileSync(p, 'utf-8') in the TypeScript, so
 * UTF-8 is what they are. Returns a malloc'd buffer the caller frees, or NULL
 * if the file will not open.
 */
static wchar_t *read_utf8(const wchar_t *path)
{
    FILE *f = _wfopen(path, L"rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (n < 0) { fclose(f); return NULL; }

    char *bytes = (char *)malloc((size_t)n + 1);
    if (!bytes) { fclose(f); return NULL; }
    size_t got = fread(bytes, 1, (size_t)n, f);
    fclose(f);
    bytes[got] = 0;

    /* A UTF-8 BOM would otherwise become U+FEFF at the front of the document and
     * throw off a match anchored at the start. */
    const char *start = bytes;
    if (got >= 3 && (unsigned char)bytes[0] == 0xEF &&
        (unsigned char)bytes[1] == 0xBB && (unsigned char)bytes[2] == 0xBF)
        start = bytes + 3;

    int wn = MultiByteToWideChar(CP_UTF8, 0, start, -1, NULL, 0);
    wchar_t *w = (wchar_t *)malloc((size_t)wn * sizeof(wchar_t));
    if (w) MultiByteToWideChar(CP_UTF8, 0, start, -1, w, wn);
    free(bytes);
    return w;
}

/* toHostPath: unescape %XX, turn every / and \ into a backslash, trim. */
static void to_host_path(wchar_t *s)
{
    vs_unescape_msbuild(s);
    for (wchar_t *p = s; *p; p++)
        if (*p == L'/' || *p == L'\\') *p = L'\\';
    trim(s);
}

/* path.basename(p, ext) with the extension stripped — the file's stem. */
static void base_stem(const wchar_t *p, wchar_t *out, size_t cap)
{
    const wchar_t *b = p;
    for (const wchar_t *q = p; *q; q++)
        if (*q == L'\\' || *q == L'/') b = q + 1;
    nx_copy(out, cap, b);
    wchar_t *dot = wcsrchr(out, L'.');
    if (dot && dot != out) *dot = 0;
}

/* path.basename(p) keeping the extension — the last path segment. */
static void base_stem_keepext(const wchar_t *p, wchar_t *out, size_t cap)
{
    const wchar_t *b = p;
    for (const wchar_t *q = p; *q; q++)
        if (*q == L'\\' || *q == L'/') b = q + 1;
    nx_copy(out, cap, b);
}

/* case-insensitive equality after trimming s (b is a trimmed ASCII literal). */
static int ieq_trim(const wchar_t *s, const wchar_t *b)
{
    wchar_t t[64];
    nx_copy(t, 64, s ? s : L"");
    trim(t);
    return ieq(t, b);
}

/*
 * path.resolve(dir, rel): rel if it is already absolute, else dir\rel, and in
 * either case run through GetFullPathName so '.' and '..' collapse. Node
 * resolves against dir; GetFullPathName resolves against the process CWD, so the
 * join has to happen first.
 */
static void resolve_against(const wchar_t *dir, const wchar_t *rel, wchar_t *out, size_t cap)
{
    wchar_t joined[NX_PATH];
    int abs = (rel[0] && rel[1] == L':') || (rel[0] == L'\\' && rel[1] == L'\\');
    if (abs) nx_copy(joined, NX_PATH, rel);
    else     nx_join(joined, NX_PATH, dir, rel);
    if (!GetFullPathNameW(joined, (DWORD)cap, out, NULL)) nx_copy(out, cap, joined);
}

/* case-insensitive suffix test, ASCII — for ".vcxproj"/".vcproj". */
static int iends(const wchar_t *s, const wchar_t *suf)
{
    size_t ls = wcslen(s), lf = wcslen(suf);
    if (lf > ls) return 0;
    const wchar_t *t = s + (ls - lf);
    for (size_t i = 0; i < lf; i++) {
        wchar_t a = t[i], b = suf[i];
        if (a >= L'A' && a <= L'Z') a += 32;
        if (b >= L'A' && b <= L'Z') b += 32;
        if (a != b) return 0;
    }
    return 1;
}

/*
 * parseSolution.
 *
 * A .sln is plain text, one project per line:
 *   Project("{GUID}") = "Name", "relative\path.vcxproj", "{GUID}"
 * matched by /^Project\("\{[^}]+\}"\)\s*=\s*"([^"]+)",\s*"([^"]+)"/gm — anchored
 * at line start, so this scans line by line and pulls the first two quoted
 * fields. Solution folders and C#/other projects are skipped by the extension,
 * exactly as the .test(rel) guard does.
 */
static int parse_solution(const wchar_t *slnPath)
{
    wchar_t *raw = read_utf8(slnPath);
    if (!raw) { nx_json_error("vsimport solution: cannot read the .sln"); return 1; }

    wchar_t dir[NX_PATH];
    nx_copy(dir, NX_PATH, slnPath);
    wchar_t *slash = wcsrchr(dir, L'\\');
    if (!slash) slash = wcsrchr(dir, L'/');
    if (slash) *slash = 0; else nx_copy(dir, NX_PATH, L".");

    wchar_t name[NX_PATH];
    base_stem(slnPath, name, NX_PATH);

    printf("{\"ok\":true,");
    nx_json_field(stdout, "solutionPath", slnPath); printf(",");
    nx_json_field(stdout, "name", name);
    printf(",\"projects\":[");

    int first = 1;
    for (wchar_t *line = raw; *line; ) {
        wchar_t *eol = line;
        while (*eol && *eol != L'\n' && *eol != L'\r') eol++;
        wchar_t saved = *eol; *eol = 0;

        /* ^Project("{...}") = "..." , "..." */
        const wchar_t *p = line;
        while (*p == L' ' || *p == L'\t') p++;
        if (!wcsncmp(p, L"Project(\"{", 10)) {   /* Project("{ */
            /* the two quoted fields after the ) = */
            const wchar_t *q = wcschr(p, L')');
            if (q) {
                q = wcschr(q, L'=');
                if (q) {
                    /* first quoted string: name */
                    const wchar_t *n1 = wcschr(q, L'"');
                    const wchar_t *n2 = n1 ? wcschr(n1 + 1, L'"') : NULL;
                    /* comma, then second quoted string: rel path */
                    const wchar_t *c = n2 ? wcschr(n2 + 1, L',') : NULL;
                    const wchar_t *r1 = c ? wcschr(c, L'"') : NULL;
                    const wchar_t *r2 = r1 ? wcschr(r1 + 1, L'"') : NULL;
                    if (n1 && n2 && r1 && r2) {
                        wchar_t pname[NX_PATH], rel[NX_PATH];
                        size_t nl = (size_t)(n2 - n1 - 1), rl = (size_t)(r2 - r1 - 1);
                        if (nl < NX_PATH && rl < NX_PATH) {
                            wcsncpy(pname, n1 + 1, nl); pname[nl] = 0; trim(pname);
                            wcsncpy(rel, r1 + 1, rl);   rel[rl] = 0;   trim(rel);

                            if (iends(rel, L".vcxproj") || iends(rel, L".vcproj")) {
                                to_host_path(rel);
                                wchar_t abs[NX_PATH];
                                resolve_against(dir, rel, abs, NX_PATH);
                                int exists = GetFileAttributesW(abs) != INVALID_FILE_ATTRIBUTES;

                                if (!first) printf(",");
                                first = 0;
                                printf("{");
                                nx_json_field(stdout, "name", pname); printf(",");
                                nx_json_field(stdout, "path", abs); printf(",");
                                printf("\"exists\":%s}", exists ? "true" : "false");
                            }
                        }
                    }
                }
            }
        }

        *eol = saved;
        line = (saved == 0) ? eol : eol + 1;
    }

    printf("]}\n");
    free(raw);
    return 0;
}

/* ── a growable wide-string list ──────────────────────────────────────────── */

typedef struct { wchar_t **v; int n, cap; } wlist;

static void wl_push(wlist *l, const wchar_t *s)
{
    if (l->n == l->cap) {
        l->cap = l->cap ? l->cap * 2 : 8;
        l->v = (wchar_t **)realloc(l->v, (size_t)l->cap * sizeof(wchar_t *));
    }
    l->v[l->n++] = _wcsdup(s);
}

static void wl_free(wlist *l)
{
    for (int i = 0; i < l->n; i++) free(l->v[i]);
    free(l->v);
    l->v = NULL; l->n = l->cap = 0;
}

static int wl_has_ci(const wlist *l, const wchar_t *s)
{
    for (int i = 0; i < l->n; i++) if (!_wcsicmp(l->v[i], s)) return 1;
    return 0;
}

static void emit_wl(FILE *f, const wlist *l)
{
    fputc('[', f);
    for (int i = 0; i < l->n; i++) { if (i) fputc(',', f); nx_json_str(f, l->v[i]); }
    fputc(']', f);
}

/* ── the string extraction the regexes did ────────────────────────────────── */

/*
 * splitList: a VS semicolon list -> trimmed non-empty entries, dropping the
 * /^%\(.*\)$/ inherit markers. Appends to l.
 */
static void split_list(const wchar_t *raw, wlist *l)
{
    if (!raw) return;
    const wchar_t *p = raw;
    while (*p) {
        const wchar_t *semi = wcschr(p, L';');
        size_t len = semi ? (size_t)(semi - p) : wcslen(p);
        wchar_t item[NX_PATH];
        if (len >= NX_PATH) len = NX_PATH - 1;
        wcsncpy(item, p, len); item[len] = 0;
        trim(item);
        /* drop empties and a bare %(...) inherit marker */
        size_t il = wcslen(item);
        int inherit = (il >= 3 && item[0] == L'%' && item[1] == L'(' && item[il - 1] == L')');
        if (il && !inherit) wl_push(l, item);
        if (!semi) break;
        p = semi + 1;
    }
}

/*
 * resolveProjectMacros: strip a leading $(ProjectDir)/$(MSBuildProjectDirectory)/
 * $(MSBuildThisFileDirectory) and one following separator, then a leading ./ or
 * .\, then trim. In place.
 */
static void resolve_project_macros(wchar_t *s)
{
    static const wchar_t *M[] = {
        L"$(ProjectDir)", L"$(MSBuildProjectDirectory)", L"$(MSBuildThisFileDirectory)"
    };
    for (int i = 0; i < 3; i++) {
        size_t ml = wcslen(M[i]);
        /* case-insensitive prefix */
        int pre = 1;
        for (size_t k = 0; k < ml; k++) {
            wchar_t a = s[k], b = M[i][k];
            if (a >= L'A' && a <= L'Z') a += 32;
            if (b >= L'A' && b <= L'Z') b += 32;
            if (a != b) { pre = 0; break; }
        }
        if (pre) {
            size_t skip = ml;
            if (s[skip] == L'\\' || s[skip] == L'/') skip++;
            memmove(s, s + skip, (wcslen(s + skip) + 1) * sizeof(wchar_t));
            break;
        }
    }
    if (s[0] == L'.' && (s[1] == L'\\' || s[1] == L'/'))
        memmove(s, s + 2, (wcslen(s + 2) + 1) * sizeof(wchar_t));
    trim(s);
}

/*
 * filterPaths: resolveProjectMacros each, drop the ones that were just the
 * project root, drop (into `dropped`) any still carrying an unresolvable macro,
 * toHostPath the rest into `kept`.
 */
static void filter_paths(const wlist *in, wlist *kept, wlist *dropped)
{
    for (int i = 0; i < in->n; i++) {
        wchar_t r[NX_PATH];
        nx_copy(r, NX_PATH, in->v[i]);
        resolve_project_macros(r);
        if (!r[0]) continue;                         /* was just "$(ProjectDir)" */
        if (vs_is_unresolvable_macro(r)) { wl_push(dropped, in->v[i]); continue; }
        to_host_path(r);
        wl_push(kept, r);
    }
}

/* attr(block, name): the regex `name="([^"]*)"`, first match. Returns 1 + fills
 * out, else 0. Case-insensitive on the name, as the /i flag was. */
static int attr(const wchar_t *block, const wchar_t *name, wchar_t *out, size_t cap)
{
    size_t nl = wcslen(name);
    for (const wchar_t *p = block; *p; p++) {
        /* match name (ci) then =" */
        size_t k = 0;
        for (; k < nl; k++) {
            wchar_t a = p[k], b = name[k];
            if (a >= L'A' && a <= L'Z') a += 32;
            if (b >= L'A' && b <= L'Z') b += 32;
            if (a != b) break;
        }
        if (k == nl && p[nl] == L'=' && p[nl + 1] == L'"') {
            const wchar_t *v = p + nl + 2;
            const wchar_t *end = wcschr(v, L'"');
            if (!end) return 0;
            size_t len = (size_t)(end - v);
            if (len >= cap) len = cap - 1;
            wcsncpy(out, v, len); out[len] = 0;
            return 1;
        }
    }
    return 0;
}

/* parseBool: undefined for null/empty (returned as -1), else /^(true|1)$/i. */
static int parse_bool(const wchar_t *v)
{
    if (!v || !v[0]) return -1;
    wchar_t t[16];
    nx_copy(t, 16, v);
    trim(t);
    if (ieq(t, L"true") || ieq(t, L"1")) return 1;
    return 0;
}

/* SOURCE_RE / HEADER_RE. */
static int is_source(const wchar_t *p)
{
    return iends(p, L".cpp") || iends(p, L".c") || iends(p, L".cc") || iends(p, L".cxx");
}
static int is_header(const wchar_t *p)
{
    return iends(p, L".h") || iends(p, L".hpp") || iends(p, L".hxx") || iends(p, L".inl");
}

/*
 * inferPch: explicit if given; else the basename of a stdafx/pch header in the
 * project when the mode is Use/2, or when one is simply present. -1 sentinel is
 * "undefined" (the field is omitted).
 */
static void infer_pch(const wchar_t *explicit_, const wchar_t *mode, const wlist *headers,
                      wchar_t *out, size_t cap, int *have)
{
    *have = 0;
    if (explicit_ && explicit_[0]) { nx_copy(out, cap, explicit_); *have = 1; return; }

    /* /(^|[\\/])(stdafx|pch)\.h$/i over the headers */
    const wchar_t *known = NULL;
    for (int i = 0; i < headers->n; i++) {
        const wchar_t *h = headers->v[i];
        if (iends(h, L"stdafx.h") || iends(h, L"pch.h")) {
            /* the char before the stem must be start or a separator */
            size_t hl = wcslen(h);
            size_t stem = iends(h, L"stdafx.h") ? 8 : 5;   /* len of stdafx.h / pch.h */
            const wchar_t *before = (hl > stem) ? h + (hl - stem - 1) : NULL;
            if (!before || *before == L'\\' || *before == L'/') { known = h; break; }
        }
    }
    wchar_t base[NX_PATH];
    if (known) base_stem_keepext(known, base, NX_PATH);

    int useMode = mode && (ieq_trim(mode, L"Use") || ieq_trim(mode, L"2"));
    if (useMode) { nx_copy(out, cap, known ? base : L"stdafx.h"); *have = 1; return; }
    if (known) { nx_copy(out, cap, base); *have = 1; return; }
    /* undefined */
}

/* ── .vcproj (VS2005/2008 legacy) ─────────────────────────────────────────── */

/* find `<Tool\s+Name="TOOL"...>` and return the attribute blob after the Name
 * quote, up to the tag's closing '>' (a trailing '/' excluded), as the regex
 * `<Tool\s+Name="TOOL"([\s\S]*?)\/?>` captured it. NULL if not present. The blob
 * is copied into out. */
static int tool_blob(const wchar_t *xml, const wchar_t *tool, wchar_t *out, size_t cap)
{
    wchar_t needle[64];
    _snwprintf(needle, 64, L"Name=\"%ls\"", tool);
    for (const wchar_t *p = wcsstr(xml, L"<Tool"); p; p = wcsstr(p + 1, L"<Tool")) {
        /* require whitespace, then Name="TOOL" as the first attribute */
        const wchar_t *q = p + 5;
        if (!iswspace(*q)) continue;
        while (iswspace(*q)) q++;
        if (wcsncmp(q, needle, wcslen(needle))) continue;
        const wchar_t *blob = q + wcslen(needle);
        const wchar_t *gt = wcschr(blob, L'>');
        if (!gt) return 0;
        const wchar_t *endb = gt;
        if (endb > blob && endb[-1] == L'/') endb--;   /* drop the trailing / of /> */
        size_t len = (size_t)(endb - blob);
        if (len >= cap) len = cap - 1;
        wcsncpy(out, blob, len); out[len] = 0;
        return 1;
    }
    return 0;
}

/* the full `<Configuration ...>...</Configuration>` block chosen by parseVcproj:
 * the one whose Name attribute starts "Debug", else the first. */
static int vcproj_config(const wchar_t *xml, wchar_t *out, size_t cap)
{
    const wchar_t *first = NULL; size_t firstLen = 0;
    for (const wchar_t *p = wcsstr(xml, L"<Configuration"); p; p = wcsstr(p + 1, L"<Configuration")) {
        const wchar_t *close = wcsstr(p, L"</Configuration>");
        if (!close) break;
        size_t len = (size_t)(close + 16 - p);
        if (!first) { first = p; firstLen = len; }
        /* /Name="Debug/i somewhere in the block header */
        wchar_t head[512];
        size_t hl = len < 511 ? len : 511;
        wcsncpy(head, p, hl); head[hl] = 0;
        if (istr(head, L"Name=\"Debug")) {
            if (len >= cap) len = cap - 1;
            wcsncpy(out, p, len); out[len] = 0;
            return 1;
        }
    }
    if (first) {
        if (firstLen >= cap) firstLen = cap - 1;
        wcsncpy(out, first, firstLen); out[firstLen] = 0;
        return 1;
    }
    out[0] = 0;
    return 0;
}

/* whitespace runs -> a single ';', for AdditionalDependencies' space list. */
static void ws_to_semi(wchar_t *s)
{
    wchar_t *o = s;
    int inws = 0;
    for (wchar_t *p = s; *p; p++) {
        if (iswspace(*p)) { if (!inws) { *o++ = L';'; inws = 1; } }
        else { *o++ = *p; inws = 0; }
    }
    *o = 0;
}

/* emit the shared tail of both parsers: the flag fields and warnings. `cl` and
 * `link` are the compiler/linker attribute (or tag) blocks. */
static void emit_flags(FILE *f,
                       const char *type,
                       const wlist *inc, const wlist *libDirs, const wlist *libs, const wlist *defs,
                       const wchar_t *pch, int havePch,
                       int rtti, const char *eh, const char *rt, int wl, int twae, const char *opt,
                       const wlist *warnings)
{
    printf("\"type\":\"%s\",", type);
    printf("\"includeDirectories\":");  emit_wl(f, inc);     printf(",");
    printf("\"libraryDirectories\":");  emit_wl(f, libDirs); printf(",");
    printf("\"libraries\":");           emit_wl(f, libs);    printf(",");
    printf("\"defines\":");             emit_wl(f, defs);    printf(",");
    if (havePch) { printf("\"pchHeader\":"); nx_json_str(f, pch); printf(","); }
    if (rtti >= 0) printf("\"enableRtti\":%s,", rtti ? "true" : "false");
    if (eh) printf("\"exceptionHandling\":\"%s\",", eh);
    if (rt) printf("\"runtimeLibrary\":\"%s\",", rt);
    if (wl >= 0) printf("\"warningLevel\":%d,", wl);
    if (twae >= 0) printf("\"treatWarningsAsErrors\":%s,", twae ? "true" : "false");
    if (opt) printf("\"optimizationOverride\":\"%s\",", opt);
    printf("\"warnings\":"); emit_wl(f, warnings);
}

static int parse_vcproj(const wchar_t *projPath)
{
    wchar_t *xml = read_utf8(projPath);
    if (!xml) { nx_json_error("vsimport project: cannot read the .vcproj"); return 1; }

    wlist sources = {0}, headers = {0}, others = {0}, warnings = {0};

    /* <File RelativePath="..."> items */
    for (const wchar_t *p = wcsstr(xml, L"<File"); p; p = wcsstr(p + 1, L"<File")) {
        const wchar_t *q = p + 5;
        if (!iswspace(*q)) continue;
        while (iswspace(*q)) q++;
        if (wcsncmp(q, L"RelativePath=\"", 14)) continue;
        const wchar_t *v = q + 14, *end = wcschr(v, L'"');
        if (!end) continue;
        wchar_t rel[NX_PATH];
        size_t len = (size_t)(end - v); if (len >= NX_PATH) len = NX_PATH - 1;
        wcsncpy(rel, v, len); rel[len] = 0;
        to_host_path(rel);
        /* strip a leading .\ or ./ (already backslashed by to_host_path) */
        if (rel[0] == L'.' && rel[1] == L'\\') memmove(rel, rel + 2, (wcslen(rel + 2) + 1) * sizeof(wchar_t));
        if (vs_is_unresolvable_macro(rel)) {
            wchar_t w[NX_PATH]; _snwprintf(w, NX_PATH, L"Skipped item with unresolved macro: %ls", rel);
            wl_push(&warnings, w); continue;
        }
        if (is_source(rel)) wl_push(&sources, rel);
        else if (is_header(rel)) wl_push(&headers, rel);
        else wl_push(&others, rel);
    }

    wchar_t cfg[8192];
    vcproj_config(xml, cfg, 8192);

    wchar_t clTool[8192] = L"", linkTool[8192] = L"";
    tool_blob(cfg, L"VCCLCompilerTool", clTool, 8192);
    tool_blob(cfg, L"VCLinkerTool", linkTool, 8192);

    wchar_t v[NX_PATH];
    wlist rawInc = {0}, rawLibDirs = {0}, rawLibs = {0}, rawDefs = {0};
    if (attr(clTool, L"AdditionalIncludeDirectories", v, NX_PATH)) split_list(v, &rawInc);
    if (attr(linkTool, L"AdditionalLibraryDirectories", v, NX_PATH)) split_list(v, &rawLibDirs);
    if (attr(linkTool, L"AdditionalDependencies", v, NX_PATH)) { ws_to_semi(v); split_list(v, &rawLibs); }
    if (attr(clTool, L"PreprocessorDefinitions", v, NX_PATH)) split_list(v, &rawDefs);

    wlist inc = {0}, dropInc = {0}, libDirs = {0}, dropLib = {0};
    filter_paths(&rawInc, &inc, &dropInc);
    filter_paths(&rawLibDirs, &libDirs, &dropLib);
    for (int i = 0; i < dropInc.n; i++) { wchar_t w[NX_PATH]; _snwprintf(w, NX_PATH, L"Include path not imported (VS/SDK macro): %ls", dropInc.v[i]); wl_push(&warnings, w); }
    for (int i = 0; i < dropLib.n; i++) { wchar_t w[NX_PATH]; _snwprintf(w, NX_PATH, L"Library path not imported (VS/SDK macro): %ls", dropLib.v[i]); wl_push(&warnings, w); }

    /* libraries: drop unresolvable */
    wlist libs = {0};
    for (int i = 0; i < rawLibs.n; i++) if (!vs_is_unresolvable_macro(rawLibs.v[i])) wl_push(&libs, rawLibs.v[i]);
    wlist defs = {0};
    for (int i = 0; i < rawDefs.n; i++) if (!vs_is_unresolvable_macro(rawDefs.v[i])) wl_push(&defs, rawDefs.v[i]);

    /* type from ConfigurationType="<digit>" in the config block */
    wchar_t ctype[8] = L"";
    const wchar_t *ct = istr(cfg, L"ConfigurationType=\"");
    if (ct) { ct += 19; if (iswdigit(*ct)) { ctype[0] = *ct; ctype[1] = 0; } }
    const char *type = vs_map_configuration_type(ctype[0] ? ctype : NULL);

    /* pch */
    wchar_t pthrough[NX_PATH] = L"", puse[NX_PATH] = L"", pch[NX_PATH]; int havePch = 0;
    int hasThrough = attr(clTool, L"PrecompiledHeaderThrough", pthrough, NX_PATH);
    int hasUse = attr(clTool, L"UsePrecompiledHeader", puse, NX_PATH);
    infer_pch(hasThrough ? pthrough : NULL, hasUse ? puse : NULL, &headers, pch, NX_PATH, &havePch);

    /* flag fields */
    wchar_t rttiV[16] = L"", ehV[32] = L"", rtV[32] = L"", wlV[32] = L"", twaeV[16] = L"", optV[32] = L"";
    int rtti = parse_bool(attr(clTool, L"RuntimeTypeInfo", rttiV, 16) ? rttiV : NULL);
    const char *eh = vs_map_exceptions(attr(clTool, L"ExceptionHandling", ehV, 32) ? ehV : NULL);
    const char *rt = vs_map_runtime_library(attr(clTool, L"RuntimeLibrary", rtV, 32) ? rtV : NULL);
    int wl = vs_map_warning_level(attr(clTool, L"WarningLevel", wlV, 32) ? wlV : NULL);
    int twae = parse_bool(attr(clTool, L"WarnAsError", twaeV, 16) ? twaeV : NULL);
    const char *opt = vs_map_optimization(attr(clTool, L"Optimization", optV, 32) ? optV : NULL);

    wchar_t name[NX_PATH];
    base_stem(projPath, name, NX_PATH);

    printf("{\"ok\":true,");
    printf("\"name\":");        nx_json_str(stdout, name);     printf(",");
    printf("\"projectPath\":"); nx_json_str(stdout, projPath); printf(",");
    printf("\"format\":\"vcproj\",");
    printf("\"projectReferences\":[],");
    printf("\"configurations\":{},");
    printf("\"sources\":");   emit_wl(stdout, &sources); printf(",");
    printf("\"headers\":");   emit_wl(stdout, &headers); printf(",");
    printf("\"otherFiles\":");emit_wl(stdout, &others);  printf(",");
    emit_flags(stdout, type, &inc, &libDirs, &libs, &defs, pch, havePch,
               rtti, eh, rt, wl, twae, opt, &warnings);
    printf("}\n");

    wl_free(&sources); wl_free(&headers); wl_free(&others); wl_free(&warnings);
    wl_free(&rawInc); wl_free(&rawLibDirs); wl_free(&rawLibs); wl_free(&rawDefs);
    wl_free(&inc); wl_free(&dropInc); wl_free(&libDirs); wl_free(&dropLib);
    wl_free(&libs); wl_free(&defs);
    free(xml);
    return 0;
}

/* ── .vcxproj (MSBuild) scanners ──────────────────────────────────────────── */

/*
 * block_literal: `<Tag>([\s\S]*?)</Tag>`, the strict form with no attributes —
 * what parseVcxproj uses for <ClCompile> and <Link>. First match, inner copied
 * to out (not trimmed; the callers trim per-field via tagText). Returns 1/0.
 */
static int block_literal(const wchar_t *xml, const wchar_t *tag, wchar_t *out, size_t cap)
{
    wchar_t open[64], close[64];
    _snwprintf(open, 64, L"<%ls>", tag);
    _snwprintf(close, 64, L"</%ls>", tag);
    const wchar_t *a = wcsstr(xml, open);
    if (!a) { out[0] = 0; return 0; }
    a += wcslen(open);
    const wchar_t *b = wcsstr(a, close);
    if (!b) { out[0] = 0; return 0; }
    size_t len = (size_t)(b - a);
    if (len >= cap) len = cap - 1;
    wcsncpy(out, a, len); out[len] = 0;
    return 1;
}

/*
 * tagText: `<Tag[^>]*>([\s\S]*?)</Tag>`, allowing attributes on the open tag.
 * First match, inner trimmed. Returns 1 + fills out, else 0.
 *
 * Faithful to the regex, `[^>]*` does not stop at a longer tag name, so this
 * matches the opening `<Tag` then scans to the first `>` that is not inside the
 * name — which is what the regex does too. The values it reads (RuntimeLibrary,
 * PreprocessorDefinitions, ...) have no longer-named siblings, so the quirk is
 * inert, but it is reproduced rather than tightened.
 */
static int tag_text(const wchar_t *xml, const wchar_t *tag, wchar_t *out, size_t cap)
{
    size_t tl = wcslen(tag);
    for (const wchar_t *p = xml; (p = wcschr(p, L'<')); p++) {
        if (wcsncmp(p + 1, tag, tl)) continue;
        const wchar_t *gt = wcschr(p + 1 + tl, L'>');
        if (!gt) return 0;
        /* the open tag must not itself be a close tag */
        if (p[1] == L'/') continue;
        const wchar_t *inner = gt + 1;
        wchar_t close[64];
        _snwprintf(close, 64, L"</%ls>", tag);
        const wchar_t *end = wcsstr(inner, close);
        if (!end) return 0;
        size_t len = (size_t)(end - inner);
        if (len >= cap) len = cap - 1;
        wcsncpy(out, inner, len); out[len] = 0;
        trim(out);
        return 1;
    }
    return 0;
}

/*
 * condProp: a `<Tag Condition="...'CFG|...">inner</Tag>`, else fall back to
 * tagText. The conditional value is unescapeMsbuild'd; the fallback is not (it
 * goes through tagText, which the TypeScript leaves as-is). Returns 1/0.
 */
static int cond_prop(const wchar_t *xml, const wchar_t *tag, const wchar_t *cfg, wchar_t *out, size_t cap)
{
    size_t tl = wcslen(tag);
    wchar_t marker[64];
    _snwprintf(marker, 64, L"'%ls|", cfg);   /* 'Debug| */

    for (const wchar_t *p = xml; (p = wcschr(p, L'<')); p++) {
        if (wcsncmp(p + 1, tag, tl)) continue;
        if (p[1] == L'/') continue;
        const wchar_t *gt = wcschr(p + 1 + tl, L'>');
        if (!gt) break;
        /* opening tag text between <Tag and > */
        /* require a Condition="..." whose quoted value contains 'CFG| */
        const wchar_t *cond = NULL;
        for (const wchar_t *q = p + 1 + tl; q < gt; q++)
            if (!wcsncmp(q, L"Condition=\"", 11)) { cond = q + 11; break; }
        if (!cond) continue;
        const wchar_t *cend = wcschr(cond, L'"');
        if (!cend || cend > gt) continue;
        /* is 'CFG| inside cond..cend ? */
        int match = 0;
        for (const wchar_t *r = cond; r + wcslen(marker) <= cend; r++)
            if (!wcsncmp(r, marker, wcslen(marker))) { match = 1; break; }
        if (!match) continue;

        const wchar_t *inner = gt + 1;
        wchar_t close[64];
        _snwprintf(close, 64, L"</%ls>", tag);
        const wchar_t *end = wcsstr(inner, close);
        if (!end) return 0;
        size_t len = (size_t)(end - inner);
        if (len >= cap) len = cap - 1;
        wcsncpy(out, inner, len); out[len] = 0;
        trim(out);
        vs_unescape_msbuild(out);
        return 1;
    }
    return tag_text(xml, tag, out, cap);
}

/*
 * parseConfigGroup: the ClCompile/Link settings for one configuration, from the
 * ItemDefinitionGroup whose text contains 'CFG| (so Release does not also match
 * Release_LTCG). Emits the ConfigurationSettings object, or nothing (the caller
 * omits the key) when there is no such group. Returns 1 if emitted.
 */
/*
 * parseConfigGroup: when the project has an ItemDefinitionGroup for cfg, print
 * `[,]"cfg": {...}` into f and clear *first. Nothing when absent, so the key is
 * omitted exactly as `if (parsed) configurations[cfg] = parsed` does. The
 * find-then-print-key order is why this owns the comma rather than the caller:
 * it cannot know whether to print the key until it has found the group.
 */
static void parse_config_group(const wchar_t *xml, const wchar_t *cfg, FILE *f, int *first)
{
    wchar_t marker[64];
    _snwprintf(marker, 64, L"'%ls|", cfg);

    wchar_t group[16384]; group[0] = 0;
    for (const wchar_t *p = wcsstr(xml, L"<ItemDefinitionGroup"); p;
         p = wcsstr(p + 1, L"<ItemDefinitionGroup")) {
        const wchar_t *close = wcsstr(p, L"</ItemDefinitionGroup>");
        if (!close) break;
        size_t len = (size_t)(close + 22 - p);
        wchar_t buf[16384];
        size_t bl = len < 16383 ? len : 16383;
        wcsncpy(buf, p, bl); buf[bl] = 0;
        if (istr(buf, marker)) { nx_copy(group, 16384, buf); break; }
    }
    if (!group[0]) return;

    wchar_t cl[16384], link[16384];
    block_literal(group, L"ClCompile", cl, 16384);
    block_literal(group, L"Link", link, 16384);

    wchar_t v[NX_PATH];
    wlist rawInc = {0}, rawLibDirs = {0}, kept = {0}, dropped = {0}, libDirs = {0}, dropped2 = {0};
    if (tag_text(cl, L"AdditionalIncludeDirectories", v, NX_PATH)) split_list(v, &rawInc);
    if (tag_text(link, L"AdditionalLibraryDirectories", v, NX_PATH)) split_list(v, &rawLibDirs);
    filter_paths(&rawInc, &kept, &dropped);
    filter_paths(&rawLibDirs, &libDirs, &dropped2);

    wlist libs = {0}, defs = {0}, rawLibs = {0}, rawDefs = {0};
    if (tag_text(link, L"AdditionalDependencies", v, NX_PATH)) split_list(v, &rawLibs);
    if (tag_text(cl, L"PreprocessorDefinitions", v, NX_PATH)) split_list(v, &rawDefs);
    for (int i = 0; i < rawLibs.n; i++) if (!vs_is_unresolvable_macro(rawLibs.v[i])) wl_push(&libs, rawLibs.v[i]);
    for (int i = 0; i < rawDefs.n; i++) if (!vs_is_unresolvable_macro(rawDefs.v[i])) wl_push(&defs, rawDefs.v[i]);

    wchar_t rtV[32];
    const char *rt = vs_map_runtime_library(tag_text(cl, L"RuntimeLibrary", rtV, 32) ? rtV : NULL);

    if (!*first) fprintf(f, ",");
    *first = 0;
    fprintf(f, "\"%ls\":", cfg);
    fprintf(f, "{\"libraries\":"); emit_wl(f, &libs);
    fprintf(f, ",\"defines\":"); emit_wl(f, &defs);
    fprintf(f, ",\"includeDirectories\":"); emit_wl(f, &kept);
    fprintf(f, ",\"libraryDirectories\":"); emit_wl(f, &libDirs);
    if (rt) fprintf(f, ",\"runtimeLibrary\":\"%s\"", rt);
    fprintf(f, "}");

    wl_free(&rawInc); wl_free(&rawLibDirs); wl_free(&kept); wl_free(&dropped);
    wl_free(&libDirs); wl_free(&dropped2); wl_free(&libs); wl_free(&defs);
    wl_free(&rawLibs); wl_free(&rawDefs);
}

static const wchar_t *VS_CONFIGS[] = { L"Debug", L"Release", L"Profile", L"Release_LTCG" };

static int parse_vcxproj(const wchar_t *projPath, const wchar_t *sdkRoot)
{
    (void)sdkRoot;   /* project references land in the next commit */
    wchar_t *xml = read_utf8(projPath);
    if (!xml) { nx_json_error("vsimport project: cannot read the .vcxproj"); return 1; }

    wlist sources = {0}, headers = {0}, others = {0}, warnings = {0};

    /* items: <(ClCompile|ClInclude|None|Text|Image|CustomBuild)\s+Include="..."> */
    static const wchar_t *KINDS[] = { L"ClCompile", L"ClInclude", L"None", L"Text", L"Image", L"CustomBuild" };
    for (const wchar_t *p = xml; (p = wcschr(p, L'<')); p++) {
        const wchar_t *kind = NULL; size_t kl = 0;
        for (int i = 0; i < 6; i++) {
            size_t l = wcslen(KINDS[i]);
            if (!wcsncmp(p + 1, KINDS[i], l) && iswspace(p[1 + l])) { kind = KINDS[i]; kl = l; break; }
        }
        if (!kind) continue;
        const wchar_t *q = p + 1 + kl;
        while (iswspace(*q)) q++;
        if (wcsncmp(q, L"Include=\"", 9)) continue;
        const wchar_t *v = q + 9, *end = wcschr(v, L'"');
        if (!end) continue;
        wchar_t rawInc[NX_PATH], rel[NX_PATH];
        size_t len = (size_t)(end - v); if (len >= NX_PATH) len = NX_PATH - 1;
        wcsncpy(rawInc, v, len); rawInc[len] = 0;
        nx_copy(rel, NX_PATH, rawInc);
        to_host_path(rel);
        if (vs_is_unresolvable_macro(rel)) {
            wchar_t w[NX_PATH]; _snwprintf(w, NX_PATH, L"Skipped item with unresolved macro: %ls", rawInc);
            wl_push(&warnings, w); continue;
        }
        if (!wcscmp(kind, L"ClCompile") || is_source(rel)) wl_push(&sources, rel);
        else if (!wcscmp(kind, L"ClInclude") || is_header(rel)) wl_push(&headers, rel);
        else wl_push(&others, rel);
    }

    /* the Debug ItemDefinitionGroup, else the first, for the flat fields */
    wchar_t debugGroup[16384]; debugGroup[0] = 0;
    for (const wchar_t *p = wcsstr(xml, L"<ItemDefinitionGroup"); p;
         p = wcsstr(p + 1, L"<ItemDefinitionGroup")) {
        const wchar_t *close = wcsstr(p, L"</ItemDefinitionGroup>");
        if (!close) break;
        size_t len = (size_t)(close + 22 - p), bl = len < 16383 ? len : 16383;
        wchar_t buf[16384];
        wcsncpy(buf, p, bl); buf[bl] = 0;
        if (!debugGroup[0]) nx_copy(debugGroup, 16384, buf);   /* first */
        if (istr(buf, L"Debug|")) { nx_copy(debugGroup, 16384, buf); break; }
    }

    wchar_t cl[16384], link[16384];
    block_literal(debugGroup, L"ClCompile", cl, 16384);
    block_literal(debugGroup, L"Link", link, 16384);

    wchar_t v[NX_PATH];
    wlist rawInc = {0}, rawLibDirs = {0}, inc = {0}, dropInc = {0}, libDirs = {0}, dropLib = {0};
    if (tag_text(cl, L"AdditionalIncludeDirectories", v, NX_PATH)) split_list(v, &rawInc);
    if (tag_text(link, L"AdditionalLibraryDirectories", v, NX_PATH)) split_list(v, &rawLibDirs);
    filter_paths(&rawInc, &inc, &dropInc);
    filter_paths(&rawLibDirs, &libDirs, &dropLib);
    for (int i = 0; i < dropInc.n; i++) { wchar_t w[NX_PATH]; _snwprintf(w, NX_PATH, L"Include path not imported (VS/SDK macro — Nexia adds the XDK paths itself): %ls", dropInc.v[i]); wl_push(&warnings, w); }
    for (int i = 0; i < dropLib.n; i++) { wchar_t w[NX_PATH]; _snwprintf(w, NX_PATH, L"Library path not imported (VS/SDK macro — Nexia adds the XDK paths itself): %ls", dropLib.v[i]); wl_push(&warnings, w); }

    wlist rawLibs = {0}, rawDefs = {0}, libs = {0}, defs = {0};
    if (tag_text(link, L"AdditionalDependencies", v, NX_PATH)) split_list(v, &rawLibs);
    if (tag_text(cl, L"PreprocessorDefinitions", v, NX_PATH)) split_list(v, &rawDefs);
    for (int i = 0; i < rawDefs.n; i++) if (!vs_is_unresolvable_macro(rawDefs.v[i])) wl_push(&defs, rawDefs.v[i]);

    /* the opening configuration's libraries feed the flat `libraries`. With no
     * per-config parse wired to the flat field yet, this mirrors the fallback
     * branch: rawLibs minus unresolvable. (The opening-config path arrives with
     * project references, next commit.) */
    for (int i = 0; i < rawLibs.n; i++) if (!vs_is_unresolvable_macro(rawLibs.v[i])) wl_push(&libs, rawLibs.v[i]);

    wchar_t ctypeV[64];
    const char *type = vs_map_configuration_type(tag_text(xml, L"ConfigurationType", ctypeV, 64) ? ctypeV : NULL);

    /* pch */
    wchar_t pfileV[NX_PATH], pmodeV[64], pch[NX_PATH]; int havePch = 0;
    int hasFile = tag_text(cl, L"PrecompiledHeaderFile", pfileV, NX_PATH);
    int hasMode = tag_text(cl, L"PrecompiledHeader", pmodeV, 64);
    infer_pch(hasFile ? pfileV : NULL, hasMode ? pmodeV : NULL, &headers, pch, NX_PATH, &havePch);

    /* flags */
    wchar_t b1[16], b2[32], b3[32], b4[32], b5[16], b6[32];
    int rtti = parse_bool(tag_text(cl, L"RuntimeTypeInfo", b1, 16) ? b1 : NULL);
    const char *eh = vs_map_exceptions(tag_text(cl, L"ExceptionHandling", b2, 32) ? b2 : NULL);
    const char *rt = vs_map_runtime_library(tag_text(cl, L"RuntimeLibrary", b3, 32) ? b3 : NULL);
    int wl = vs_map_warning_level(tag_text(cl, L"WarningLevel", b4, 32) ? b4 : NULL);
    int twae = parse_bool(tag_text(cl, L"TreatWarningAsError", b5, 16) ? b5 : NULL);
    const char *opt = vs_map_optimization(tag_text(cl, L"Optimization", b6, 32) ? b6 : NULL);

    wchar_t nameV[NX_PATH], name[NX_PATH];
    if (tag_text(xml, L"ProjectName", nameV, NX_PATH) && nameV[0]) nx_copy(name, NX_PATH, nameV);
    else base_stem(projPath, name, NX_PATH);

    printf("{\"ok\":true,");
    printf("\"name\":");        nx_json_str(stdout, name);     printf(",");
    printf("\"projectPath\":"); nx_json_str(stdout, projPath); printf(",");
    printf("\"format\":\"vcxproj\",");
    printf("\"projectReferences\":[],");
    printf("\"configurations\":{");
    int firstCfg = 1;
    for (int i = 0; i < 4; i++) parse_config_group(xml, VS_CONFIGS[i], stdout, &firstCfg);
    printf("},");
    printf("\"sources\":");   emit_wl(stdout, &sources); printf(",");
    printf("\"headers\":");   emit_wl(stdout, &headers); printf(",");
    printf("\"otherFiles\":");emit_wl(stdout, &others);  printf(",");
    emit_flags(stdout, type, &inc, &libDirs, &libs, &defs, pch, havePch,
               rtti, eh, rt, wl, twae, opt, &warnings);
    printf("}\n");

    wl_free(&sources); wl_free(&headers); wl_free(&others); wl_free(&warnings);
    wl_free(&rawInc); wl_free(&rawLibDirs); wl_free(&inc); wl_free(&dropInc);
    wl_free(&libDirs); wl_free(&dropLib); wl_free(&rawLibs); wl_free(&rawDefs);
    wl_free(&libs); wl_free(&defs);
    free(xml);
    return 0;
}

/* ── the CLI, for the parity test ─────────────────────────────────────────── */

/*
 *   nexia-core vsimport map <value>
 *
 * Runs one input through every leaf mapper and prints the lot, so the parity
 * test can drive the real functions with one spawn per value and compare each
 * field. Exists for the same reason `project names` did: prove the foundation
 * before the thing built on it.
 */
int nx_cmd_vsimport(int argc, wchar_t **argv)
{
    if (argc < 1) { nx_json_error("vsimport: expected a subcommand"); return 2; }

    if (!wcscmp(argv[0], L"map")) {
        const wchar_t *v = argc >= 2 ? argv[1] : L"";

        wchar_t unesc[NX_PATH];
        nx_copy(unesc, NX_PATH, v);
        vs_unescape_msbuild(unesc);

        int wl = vs_map_warning_level(v);
        const char *opt = vs_map_optimization(v);
        const char *rt = vs_map_runtime_library(v);
        const char *eh = vs_map_exceptions(v);
        const char *ct = vs_map_configuration_type(v);

        printf("{\"ok\":true,");
        printf("\"unescape\":"); nx_json_str(stdout, unesc); printf(",");
        printf("\"unresolvable\":%s,", vs_is_unresolvable_macro(v) ? "true" : "false");
        if (wl < 0) printf("\"warningLevel\":null,");
        else        printf("\"warningLevel\":%d,", wl);
        printf("\"optimization\":");    if (opt) { printf("\""); printf("%s", opt); printf("\""); } else printf("null"); printf(",");
        printf("\"runtimeLibrary\":");  if (rt)  { printf("\"%s\"", rt); } else printf("null"); printf(",");
        printf("\"exceptions\":");      if (eh)  { printf("\"%s\"", eh); } else printf("null"); printf(",");
        printf("\"configurationType\":\"%s\"", ct);
        printf("}\n");
        return 0;
    }

    if (!wcscmp(argv[0], L"solution")) {
        if (argc < 2) { nx_json_error("vsimport solution: expected <path.sln>"); return 2; }
        return parse_solution(argv[1]);
    }

    if (!wcscmp(argv[0], L"vcproj")) {
        if (argc < 2) { nx_json_error("vsimport vcproj: expected <path.vcproj>"); return 2; }
        return parse_vcproj(argv[1]);
    }

    if (!wcscmp(argv[0], L"vcxproj")) {
        if (argc < 2) { nx_json_error("vsimport vcxproj: expected <path.vcxproj> [--sdk <root>]"); return 2; }
        const wchar_t *sdk = NULL;
        for (int i = 2; i + 1 < argc; i += 2) if (!wcscmp(argv[i], L"--sdk")) sdk = argv[i + 1];
        return parse_vcxproj(argv[1], sdk);
    }

    nx_json_error("vsimport: unknown subcommand");
    return 2;
}

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

    nx_json_error("vsimport: unknown subcommand");
    return 2;
}

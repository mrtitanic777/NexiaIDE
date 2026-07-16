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

    nx_json_error("vsimport: unknown subcommand");
    return 2;
}

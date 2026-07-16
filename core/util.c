/*
 * util.c — paths and JSON output.
 *
 * Small enough to keep together. Everything here is what TypeScript gave away
 * for free (fs.existsSync, path.join, JSON.stringify) and C makes you write.
 */
#include "nexia.h"

int nx_exists(const wchar_t *path)
{
    if (!path || !*path) return 0;
    return GetFileAttributesW(path) != INVALID_FILE_ATTRIBUTES;
}

int nx_is_dir(const wchar_t *path)
{
    if (!path || !*path) return 0;
    DWORD a = GetFileAttributesW(path);
    return a != INVALID_FILE_ATTRIBUTES && (a & FILE_ATTRIBUTE_DIRECTORY);
}

void nx_copy(wchar_t *out, size_t cap, const wchar_t *src)
{
    if (!cap) return;
    if (!src) { out[0] = 0; return; }
    wcsncpy(out, src, cap - 1);
    out[cap - 1] = 0;
}

/*
 * path.join for two components.
 *
 * Only adds a separator when one is missing, so join("C:\\x\\", "y") is
 * "C:\\x\\y" rather than "C:\\x\\\\y" — Windows tolerates the double, but it
 * ends up in output the user reads.
 */
void nx_join(wchar_t *out, size_t cap, const wchar_t *a, const wchar_t *b)
{
    if (!cap) return;
    if (!a || !*a) { nx_copy(out, cap, b); return; }
    if (!b || !*b) { nx_copy(out, cap, a); return; }

    size_t la = wcslen(a);
    int has_sep = (a[la - 1] == L'\\' || a[la - 1] == L'/');
    _snwprintf(out, cap - 1, L"%ls%ls%ls", a, has_sep ? L"" : L"\\", b);
    out[cap - 1] = 0;
}

/*
 * Emit an already-UTF-8 string as a quoted JSON string.
 *
 * Backslashes matter — a Windows path is mostly backslashes, and an unescaped
 * one would make the whole document unparseable on the other side.
 *
 * Two entry points, one escaper. The template table is UTF-8 char* (it is C++
 * source, generated as bytes) while every path is wchar_t*, and both have to
 * come out of nexia.json escaped identically. Writing the loop twice would mean
 * two answers to "how is a backslash escaped", which is exactly the duplication
 * this port exists to remove.
 */
void nx_json_str_u8(FILE *f, const char *s)
{
    fputc('"', f);
    if (!s) { fputc('"', f); return; }

    for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
        switch (*p) {
        case '"':  fputs("\\\"", f); break;
        case '\\': fputs("\\\\", f); break;
        case '\n': fputs("\\n", f);  break;
        case '\r': fputs("\\r", f);  break;
        case '\t': fputs("\\t", f);  break;
        /* \b and \f have short forms in JSON, and JSON.stringify uses them.
         *  parses to the same character, so this is not about correctness
         * — it is about these bytes being identical to the ones the TypeScript
         * writes, because nexia.json is written by whichever of the two got
         * there first and both sides read it back. A project's `name` is stored
         * raw, unsanitised, so a control character can reach here. */
        case '\b': fputs("\\b", f);  break;
        case '\f': fputs("\\f", f);  break;
        default:
            /* Control characters must be escaped; UTF-8 continuation bytes
             * (>= 0x80) must not be touched — they are already valid JSON.
             * Lowercase hex, as JSON.stringify emits. */
            if (*p < 0x20) fprintf(f, "\\u%04x", *p);
            else fputc(*p, f);
        }
    }
    fputc('"', f);
}

void nx_json_str(FILE *f, const wchar_t *s)
{
    if (!s) { fputs("\"\"", f); return; }

    /* The conversion to UTF-8 happens here and only here: this is the one place
     * a path leaves the program. */
    int need = WideCharToMultiByte(CP_UTF8, 0, s, -1, NULL, 0, NULL, NULL);
    if (need <= 0) { fputs("\"\"", f); return; }

    char *buf = (char *)malloc((size_t)need);
    if (!buf) { fputs("\"\"", f); return; }
    WideCharToMultiByte(CP_UTF8, 0, s, -1, buf, need, NULL, NULL);

    nx_json_str_u8(f, buf);
    free(buf);
}

void nx_json_field(FILE *f, const char *key, const wchar_t *val)
{
    fprintf(f, "\"%s\":", key);
    nx_json_str(f, val);
}

/* Errors go to stdout as JSON too: the caller parses one thing, always. */
void nx_json_error(const char *msg)
{
    printf("{\"ok\":false,\"error\":\"%s\"}\n", msg);
}

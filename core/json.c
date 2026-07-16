/*
 * json.c — just enough JSON to read the files this program owns.
 *
 * nexia.json, settings, the release manifest. All of them are written by this
 * project, so this parser answers to a known shape rather than to the spec: it
 * reads objects, arrays, strings, numbers, booleans and null, and it does not
 * do \u escapes beyond the BMP, exponents, or anything else nothing here emits.
 * That is a deliberate limit, not an oversight — a general parser is a
 * dependency, and the rule for this port is that a module moves to C only when C
 * makes it better.
 *
 * Everything is parsed in place: values point into the caller's buffer rather
 * than copying. The buffer must outlive the tree.
 */
#include "nexia.h"
#include "json.h"
#include <string.h>

static void skip_ws(const char **p)
{
    while (**p == ' ' || **p == '\t' || **p == '\n' || **p == '\r') (*p)++;
}

static int parse_value(const char **p, nx_json *out, nx_json *pool, int *used, int cap);

/* Decode a JSON string into `out`, resolving escapes. Returns chars written. */
static int decode_str(const char *s, size_t len, char *out, size_t cap)
{
    size_t w = 0;
    for (size_t i = 0; i < len && w + 1 < cap; i++) {
        if (s[i] != '\\') { out[w++] = s[i]; continue; }
        if (++i >= len) break;
        switch (s[i]) {
        case 'n': out[w++] = '\n'; break;
        case 't': out[w++] = '\t'; break;
        case 'r': out[w++] = '\r'; break;
        case 'b': out[w++] = '\b'; break;
        case 'f': out[w++] = '\f'; break;
        case 'u': {
            /* \uXXXX. Anything outside Latin-1 is written as '?' rather than
             * silently truncated: this parser reads paths and identifiers, and a
             * wrong byte in a path is worse than a visible placeholder. */
            if (i + 4 >= len) { i = len; break; }
            unsigned cp = 0;
            for (int k = 1; k <= 4; k++) {
                char c = s[i + k];
                cp <<= 4;
                if (c >= '0' && c <= '9') cp |= (unsigned)(c - '0');
                else if (c >= 'a' && c <= 'f') cp |= (unsigned)(c - 'a' + 10);
                else if (c >= 'A' && c <= 'F') cp |= (unsigned)(c - 'A' + 10);
            }
            i += 4;
            out[w++] = cp < 256 ? (char)cp : '?';
            break;
        }
        default: out[w++] = s[i];    /* \" \\ \/ and anything else: literal */
        }
    }
    out[w] = 0;
    return (int)w;
}

static int parse_string(const char **p, const char **start, size_t *len)
{
    if (**p != '"') return 0;
    (*p)++;
    *start = *p;
    while (**p && **p != '"') {
        if (**p == '\\' && (*p)[1]) (*p)++;   /* skip the escaped char */
        (*p)++;
    }
    if (**p != '"') return 0;
    *len = (size_t)(*p - *start);
    (*p)++;
    return 1;
}

static nx_json *alloc(nx_json *pool, int *used, int cap)
{
    if (*used >= cap) return NULL;
    nx_json *n = &pool[(*used)++];
    memset(n, 0, sizeof *n);
    return n;
}

static int parse_value(const char **p, nx_json *out, nx_json *pool, int *used, int cap)
{
    skip_ws(p);
    memset(out, 0, sizeof *out);

    if (**p == '"') {
        out->type = NX_JSON_STRING;
        return parse_string(p, &out->str, &out->len);
    }
    if (**p == '{' || **p == '[') {
        int is_obj = (**p == '{');
        out->type = is_obj ? NX_JSON_OBJECT : NX_JSON_ARRAY;
        (*p)++;
        nx_json **tail = &out->child;
        skip_ws(p);
        if (**p == (is_obj ? '}' : ']')) { (*p)++; return 1; }
        for (;;) {
            skip_ws(p);
            nx_json *item = alloc(pool, used, cap);
            if (!item) return 0;
            if (is_obj) {
                if (!parse_string(p, &item->key, &item->keylen)) return 0;
                skip_ws(p);
                if (**p != ':') return 0;
                (*p)++;
            }
            nx_json tmp;
            if (!parse_value(p, &tmp, pool, used, cap)) return 0;
            /* Copy the parsed value in, keeping the key we already set. */
            const char *k = item->key; size_t kl = item->keylen;
            *item = tmp;
            item->key = k; item->keylen = kl;
            *tail = item;
            tail = &item->next;
            skip_ws(p);
            if (**p == ',') { (*p)++; continue; }
            if (**p == (is_obj ? '}' : ']')) { (*p)++; return 1; }
            return 0;
        }
    }
    if (!strncmp(*p, "true", 4))  { out->type = NX_JSON_BOOL; out->num = 1; *p += 4; return 1; }
    if (!strncmp(*p, "false", 5)) { out->type = NX_JSON_BOOL; out->num = 0; *p += 5; return 1; }
    if (!strncmp(*p, "null", 4))  { out->type = NX_JSON_NULL; *p += 4; return 1; }

    /* number */
    {
        char *end = NULL;
        double v = strtod(*p, &end);
        if (end == *p) return 0;
        out->type = NX_JSON_NUMBER;
        out->num = v;
        *p = end;
        return 1;
    }
}

int nx_json_parse(const char *text, nx_json *root, nx_json *pool, int cap)
{
    int used = 0;
    const char *p = text;
    if (!parse_value(&p, root, pool, &used, cap)) return 0;
    skip_ws(&p);
    return 1;
}

const nx_json *nx_json_get(const nx_json *obj, const char *key)
{
    if (!obj || obj->type != NX_JSON_OBJECT) return NULL;
    size_t kl = strlen(key);
    for (const nx_json *c = obj->child; c; c = c->next)
        if (c->keylen == kl && !strncmp(c->key, key, kl)) return c;
    return NULL;
}

int nx_json_wstr(const nx_json *v, wchar_t *out, size_t cap)
{
    if (!out || !cap) return 0;
    out[0] = 0;
    if (!v || v->type != NX_JSON_STRING) return 0;
    char *tmp = (char *)malloc(v->len + 1);
    if (!tmp) return 0;
    decode_str(v->str, v->len, tmp, v->len + 1);
    int n = MultiByteToWideChar(CP_UTF8, 0, tmp, -1, out, (int)cap);
    free(tmp);
    return n > 0;
}

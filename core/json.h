/*
 * json.h — a small JSON reader for the files this program owns.
 *
 * Deliberately not a general parser. See json.c for what it does not do and why.
 * Values point into the text buffer they were parsed from; that buffer must
 * outlive the tree.
 */
#ifndef NX_JSON_H
#define NX_JSON_H

#include <stddef.h>
#include <wchar.h>

typedef enum {
    NX_JSON_NULL = 0, NX_JSON_BOOL, NX_JSON_NUMBER,
    NX_JSON_STRING, NX_JSON_ARRAY, NX_JSON_OBJECT
} nx_json_type;

typedef struct nx_json {
    nx_json_type type;
    const char  *key;    /* NULL unless this is an object member. not NUL-terminated */
    size_t       keylen;
    const char  *str;    /* NX_JSON_STRING: raw, still escaped. not NUL-terminated */
    size_t       len;
    double       num;    /* NX_JSON_NUMBER, and 0/1 for NX_JSON_BOOL */
    struct nx_json *child;
    struct nx_json *next;
} nx_json;

/*
 * Parse `text` into `root`, allocating members from `pool` (caller-provided, no
 * malloc). Returns 0 on malformed input or if the pool runs out — the two are
 * not distinguished, because the caller's response to both is the same.
 */
int nx_json_parse(const char *text, nx_json *root, nx_json *pool, int cap);

/* An object member by name, or NULL. */
const nx_json *nx_json_get(const nx_json *obj, const char *key);

/* A string value as wide chars, escapes resolved. 0 if `v` is not a string. */
int nx_json_wstr(const nx_json *v, wchar_t *out, size_t cap);

#endif

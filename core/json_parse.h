/*
 * json_parse.h — just enough JSON to read nexia.json.
 *
 * nexia.h says "output only. We emit JSON; we never parse it." That stopped
 * being true the moment the build driver moved: the project file IS JSON, and
 * the compiler driver cannot construct a command line without it. So this is a
 * reader, deliberately kept beside the one module that needs it rather than
 * promoted into nexia.h, because nothing else should grow a taste for it.
 *
 * WHAT IT DOES NOT SUPPORT, honestly:
 *   - Comments, trailing commas, single quotes. nexia.json is machine-written
 *     by projectManager.ts via JSON.stringify, so it is always strict JSON.
 *   - Numbers are kept as double, which is what JavaScript has too, so nothing
 *     is lost that JSON.parse would have kept. Parsed with strtod, deliberately
 *     not wcstod: on this toolchain wcstod is not correctly rounded and disagrees
 *     with V8 by one ulp on values like 8.087676e-10. See jp_number.
 *   - Duplicate keys: the first wins. JSON.stringify cannot emit them.
 *   - Nothing is ever freed. This is a one-shot CLI that parses one document
 *     and exits; an arena that dies with the process is the honest lifetime,
 *     and it means no accessor can hand back a dangling pointer.
 *
 * Strings come out as wchar_t (UTF-16), matching the rest of nexia-core: the
 * document arrives as UTF-8 bytes and is converted once, at parse time.
 * \uXXXX escapes are stored as the code unit they name, so a surrogate pair in
 * the source becomes a surrogate pair in the wchar_t — which is exactly what
 * Windows wants.
 */
#ifndef NEXIA_JSON_PARSE_H
#define NEXIA_JSON_PARSE_H

#include <wchar.h>
#include <stddef.h>
#include <stdio.h>   /* FILE, for jv_write */

typedef enum {
    JV_NULL = 0, JV_BOOL, JV_NUM, JV_STR, JV_ARR, JV_OBJ
} jv_type;

typedef struct jv jv;

struct jv {
    jv_type type;
    /* JV_BOOL / JV_NUM */
    int      b;
    double   num;
    /* JV_STR */
    wchar_t *str;
    /* JV_ARR / JV_OBJ: a flat list. Objects carry `key` on each child. */
    jv     **items;
    wchar_t **keys;
    int      count;
};

/* Parse a whole UTF-8 document. Returns NULL on malformed input; `err` (may be
 * NULL) receives a static English description of what went wrong. */
jv *jv_parse_utf8(const char *text, size_t len, const char **err);

/* Read a file and parse it. NULL if unreadable or malformed. */
jv *jv_parse_file(const wchar_t *path, const char **err);

/* Accessors. Every one tolerates NULL and the wrong type, returning the
 * supplied fallback — nexia.json's fields are nearly all optional, so a caller
 * that had to check each type by hand would be mostly error handling. */
const jv     *jv_get(const jv *obj, const wchar_t *key);
const wchar_t *jv_str_or(const jv *v, const wchar_t *fallback);
int           jv_bool_or(const jv *v, int fallback);
double        jv_num_or(const jv *v, double fallback);
int           jv_count(const jv *v);
const jv     *jv_at(const jv *v, int i);

/* Convenience: obj.key as a string, else fallback. */
const wchar_t *jv_get_str(const jv *obj, const wchar_t *key, const wchar_t *fallback);

/*
 * Release a tree from jv_parse_utf8 / jv_parse_file. NULL is a no-op.
 *
 * This existed as a comment saying the parser never frees, which was true and
 * harmless while nexia-core only ever ran as a one-shot CLI that exited: the
 * kernel reclaims faster than any free() loop, and unwinding on the way out is
 * work for nobody. It stops being harmless the moment these sources are linked
 * into something that stays running — a native UI, which is the point of moving
 * this code to C at all. A leak per project opened is invisible in a process
 * that lives for 40ms and is a bug in one that lives all day.
 *
 * Pointers into a freed tree — anything from jv_str_or or jv_get_str — dangle
 * afterwards. Copy what you need first.
 */
void jv_free(jv *v);

/*
 * Write a tree back out exactly as JSON.stringify(value, null, indent) would.
 *
 * The reader existed because the build driver needed to read nexia.json. This
 * exists because save() has to write one, and save() serialises whatever object
 * it is handed — Project Properties and the VS importer both put fields in there
 * that nexia-core has never heard of. A writer that only knew the fields in the
 * template table would silently drop them, so this walks the tree instead: any
 * document in, the same document out, keys in the order they were read.
 *
 * Byte-identical, not merely equivalent: the TypeScript still reads and rewrites
 * this file, and two writers that disagree on bytes make every byte-level check
 * downstream a false alarm.
 *
 * indent 0 emits the compact form (no spaces, no newlines), matching
 * JSON.stringify(v) with no third argument.
 *
 * Numbers follow ECMA-262's Number::toString rather than anything %g-shaped:
 * the shortest decimal that reads back as the same double, then placed by where
 * the point falls — exponent form only outside 1e-6 .. 1e21, and no zero-padded
 * exponent. Two %g-based attempts at this looked right and were not; see
 * write_num, and jsonwrite-parity.js, which fuzzes it against JSON.stringify.
 */
void jv_write(FILE *f, const jv *v, int indent);

/* Set obj.key to a string, replacing or appending. For open(), which overrides
 * `path` with where the project was actually found while keeping every other
 * field — including the ones nexia-core has never heard of. See json_parse.c. */
void jv_set_str(jv *obj, const wchar_t *key, const wchar_t *val);

#endif

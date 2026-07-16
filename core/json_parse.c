/*
 * json_parse.c — the reader described in json_parse.h.
 *
 * A recursive-descent parser over UTF-16, because converting the whole document
 * from UTF-8 once up front is cheaper and far less error-prone than decoding
 * multi-byte sequences at every string boundary. After the conversion there is
 * no such thing as a partial character, so the scanner only ever compares
 * against ASCII punctuation and everything else falls through into a string.
 *
 * Depth is capped. A hand-edited nexia.json full of '[' would otherwise recurse
 * until the stack gives out, and a stack overflow is a crash the caller cannot
 * report — whereas a refusal is just an error message.
 */
#include "nexia.h"
#include "json_parse.h"
#include <math.h>     /* floor, fabs — jv_write's number formatting */
#include <string.h>

#define JV_MAX_DEPTH 64

typedef struct {
    const wchar_t *p;      /* cursor */
    const wchar_t *end;
    int depth;
    const char *err;
} jp;

static jv *jp_value(jp *s);

static void *jz(size_t n)
{
    void *m = calloc(1, n);
    /* Out of memory in a tool this small means the machine is finished. There
     * is nothing useful to unwind to, and pretending otherwise would put a
     * NULL check on every allocation in the file. */
    if (!m) { fwprintf(stderr, L"nexia-core: out of memory\n"); exit(3); }
    return m;
}

static void jp_ws(jp *s)
{
    while (s->p < s->end &&
           (*s->p == L' ' || *s->p == L'\t' || *s->p == L'\n' || *s->p == L'\r'))
        s->p++;
}

static int jp_lit(jp *s, const wchar_t *word)
{
    size_t n = wcslen(word);
    if ((size_t)(s->end - s->p) < n) return 0;
    if (wcsncmp(s->p, word, n)) return 0;
    s->p += n;
    return 1;
}

static int hex4(const wchar_t *p, unsigned *out)
{
    unsigned v = 0;
    for (int i = 0; i < 4; i++) {
        wchar_t c = p[i];
        v <<= 4;
        if (c >= L'0' && c <= L'9') v |= (unsigned)(c - L'0');
        else if (c >= L'a' && c <= L'f') v |= (unsigned)(c - L'a' + 10);
        else if (c >= L'A' && c <= L'F') v |= (unsigned)(c - L'A' + 10);
        else return 0;
    }
    *out = v;
    return 1;
}

/* A JSON string. The result is never longer than the source, so one allocation
 * of the remaining span is always enough and there is no growth loop. */
static wchar_t *jp_string(jp *s)
{
    if (s->p >= s->end || *s->p != L'"') { s->err = "expected a string"; return NULL; }
    s->p++;

    wchar_t *out = (wchar_t *)jz((size_t)(s->end - s->p + 1) * sizeof(wchar_t));
    size_t n = 0;

    while (s->p < s->end) {
        wchar_t c = *s->p++;
        if (c == L'"') { out[n] = 0; return out; }
        if (c != L'\\') {
            /* A raw control character is malformed JSON, but rejecting it would
             * fail the whole build over a stray tab someone hand-typed into a
             * define. Pass it through: we are reading our own project file, not
             * validating the internet. */
            out[n++] = c;
            continue;
        }
        if (s->p >= s->end) { s->err = "unterminated escape"; return NULL; }
        wchar_t e = *s->p++;
        switch (e) {
        case L'"':  out[n++] = L'"';  break;
        case L'\\': out[n++] = L'\\'; break;
        case L'/':  out[n++] = L'/';  break;
        case L'b':  out[n++] = L'\b'; break;
        case L'f':  out[n++] = L'\f'; break;
        case L'n':  out[n++] = L'\n'; break;
        case L'r':  out[n++] = L'\r'; break;
        case L't':  out[n++] = L'\t'; break;
        case L'u': {
            unsigned v;
            if (s->end - s->p < 4 || !hex4(s->p, &v)) { s->err = "bad \\u escape"; return NULL; }
            s->p += 4;
            /* Stored as the code unit it names. wchar_t is UTF-16 here, so a
             * surrogate pair in the document becomes a surrogate pair in the
             * string with no special handling — which is what Windows wants. */
            out[n++] = (wchar_t)v;
            break;
        }
        default: s->err = "unknown escape"; return NULL;
        }
    }
    s->err = "unterminated string";
    return NULL;
}

/* Append to a jv's flat child list. Doubling growth: a project's arrays are
 * tens of entries, so the reallocs never get interesting. */
static void jp_push(jv *v, wchar_t *key, jv *child)
{
    if ((v->count & (v->count + 1)) == 0) {   /* count is 0,1,3,7,... -> grow */
        int cap = (v->count + 1) * 2;
        jv **ni = (jv **)jz((size_t)cap * sizeof(jv *));
        wchar_t **nk = (wchar_t **)jz((size_t)cap * sizeof(wchar_t *));
        for (int i = 0; i < v->count; i++) { ni[i] = v->items[i]; nk[i] = v->keys[i]; }
        v->items = ni;
        v->keys = nk;
    }
    v->items[v->count] = child;
    v->keys[v->count] = key;
    v->count++;
}

static jv *jp_array(jp *s)
{
    jv *v = (jv *)jz(sizeof(jv));
    v->type = JV_ARR;
    s->p++;                     /* '[' */
    jp_ws(s);
    if (s->p < s->end && *s->p == L']') { s->p++; return v; }

    for (;;) {
        jv *item = jp_value(s);
        if (!item) return NULL;
        jp_push(v, NULL, item);
        jp_ws(s);
        if (s->p < s->end && *s->p == L',') { s->p++; jp_ws(s); continue; }
        if (s->p < s->end && *s->p == L']') { s->p++; return v; }
        s->err = "expected ',' or ']' in array";
        return NULL;
    }
}

static jv *jp_object(jp *s)
{
    jv *v = (jv *)jz(sizeof(jv));
    v->type = JV_OBJ;
    s->p++;                     /* '{' */
    jp_ws(s);
    if (s->p < s->end && *s->p == L'}') { s->p++; return v; }

    for (;;) {
        jp_ws(s);
        wchar_t *key = jp_string(s);
        if (!key) return NULL;
        jp_ws(s);
        if (s->p >= s->end || *s->p != L':') { s->err = "expected ':' after key"; return NULL; }
        s->p++;
        jv *item = jp_value(s);
        if (!item) return NULL;
        jp_push(v, key, item);
        jp_ws(s);
        if (s->p < s->end && *s->p == L',') { s->p++; continue; }
        if (s->p < s->end && *s->p == L'}') { s->p++; return v; }
        s->err = "expected ',' or '}' in object";
        return NULL;
    }
}

/*
 * A number, via strtod rather than wcstod — they are not the same function.
 *
 * On this toolchain wcstod is not correctly rounded and strtod is. They disagree
 * by one ulp on, for instance, 8.087676e-10:
 *
 *     strtod  3e0bc9febb227765     <- what V8's Number() gives
 *     wcstod  3e0bc9febb227764
 *
 * which means wcstod parsed nexia.json into a different double than JSON.parse
 * would, for the same bytes. That is latent rather than harmless: every number
 * this file currently holds is an integer (warningLevel, 0-4), and integers are
 * exact either way. It stops being latent the moment anything fractional is
 * stored, and it would show up as a value that changes very slightly each time
 * the project is saved by whichever side wrote it last.
 *
 * Found by fuzzing jv_write against JSON.stringify — one number in 6,281 — while
 * looking for a bug in the writer. The writer was fine.
 *
 * A JSON number is ASCII by grammar ([-+0-9.eE]), so narrowing the token to char
 * cannot lose anything. Anything that is not a number character ends the token
 * and lets strtod's own parse fail, exactly as wcstod's did.
 */
static jv *jp_number(jp *s)
{
    char buf[64];
    size_t n = 0;
    const wchar_t *q = s->p;
    while (q < s->end && n + 1 < sizeof buf) {
        wchar_t c = *q;
        if ((c >= L'0' && c <= L'9') || c == L'-' || c == L'+' ||
            c == L'.' || c == L'e' || c == L'E') { buf[n++] = (char)c; q++; }
        else break;
    }
    buf[n] = 0;

    char *stop = NULL;
    double d = strtod(buf, &stop);
    if (stop == buf) { s->err = "bad number"; return NULL; }

    s->p += (stop - buf);
    jv *v = (jv *)jz(sizeof(jv));
    v->type = JV_NUM;
    v->num = d;
    return v;
}

static jv *jp_value(jp *s)
{
    if (++s->depth > JV_MAX_DEPTH) { s->err = "nested too deeply"; return NULL; }
    jp_ws(s);
    if (s->p >= s->end) { s->err = "unexpected end of document"; s->depth--; return NULL; }

    jv *r = NULL;
    wchar_t c = *s->p;
    if (c == L'{') r = jp_object(s);
    else if (c == L'[') r = jp_array(s);
    else if (c == L'"') {
        wchar_t *str = jp_string(s);
        if (str) { r = (jv *)jz(sizeof(jv)); r->type = JV_STR; r->str = str; }
    }
    else if (jp_lit(s, L"true"))  { r = (jv *)jz(sizeof(jv)); r->type = JV_BOOL; r->b = 1; }
    else if (jp_lit(s, L"false")) { r = (jv *)jz(sizeof(jv)); r->type = JV_BOOL; r->b = 0; }
    else if (jp_lit(s, L"null"))  { r = (jv *)jz(sizeof(jv)); r->type = JV_NULL; }
    else if (c == L'-' || (c >= L'0' && c <= L'9')) r = jp_number(s);
    else s->err = "unexpected character";

    s->depth--;
    return r;
}

jv *jv_parse_utf8(const char *text, size_t len, const char **err)
{
    if (err) *err = NULL;
    if (!text) { if (err) *err = "no document"; return NULL; }

    /* Skip a UTF-8 BOM. Node writes nexia.json without one, but a user who has
     * opened it in Notepad may well have added one, and a BOM would otherwise
     * look like "unexpected character" at offset 0. */
    if (len >= 3 && (unsigned char)text[0] == 0xEF &&
        (unsigned char)text[1] == 0xBB && (unsigned char)text[2] == 0xBF) {
        text += 3; len -= 3;
    }

    int wn = MultiByteToWideChar(CP_UTF8, 0, text, (int)len, NULL, 0);
    if (wn < 0) { if (err) *err = "not valid UTF-8"; return NULL; }
    wchar_t *w = (wchar_t *)jz((size_t)(wn + 1) * sizeof(wchar_t));
    MultiByteToWideChar(CP_UTF8, 0, text, (int)len, w, wn);
    w[wn] = 0;

    jp s;
    s.p = w; s.end = w + wn; s.depth = 0; s.err = NULL;
    jv *v = jp_value(&s);
    if (!v) { if (err) *err = s.err ? s.err : "malformed JSON"; return NULL; }
    jp_ws(&s);
    if (s.p != s.end) { if (err) *err = "trailing content after the document"; return NULL; }
    return v;
}

jv *jv_parse_file(const wchar_t *path, const char **err)
{
    if (err) *err = NULL;
    FILE *f = _wfopen(path, L"rb");
    if (!f) { if (err) *err = "cannot open file"; return NULL; }

    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (n < 0) { fclose(f); if (err) *err = "cannot size file"; return NULL; }

    char *buf = (char *)jz((size_t)n + 1);
    size_t got = fread(buf, 1, (size_t)n, f);
    fclose(f);
    buf[got] = 0;

    return jv_parse_utf8(buf, got, err);
}

const jv *jv_get(const jv *obj, const wchar_t *key)
{
    if (!obj || obj->type != JV_OBJ || !key) return NULL;
    for (int i = 0; i < obj->count; i++)
        if (obj->keys[i] && !wcscmp(obj->keys[i], key)) return obj->items[i];
    return NULL;
}

/* JV_NULL reads as absent throughout. JSON.stringify omits undefined fields but
 * writes an explicit null for a null one, and every optional field in
 * ProjectConfig treats the two the same way. */
const wchar_t *jv_str_or(const jv *v, const wchar_t *fallback)
{
    return (v && v->type == JV_STR) ? v->str : fallback;
}

int jv_bool_or(const jv *v, int fallback)
{
    if (!v) return fallback;
    if (v->type == JV_BOOL) return v->b;
    return fallback;
}

double jv_num_or(const jv *v, double fallback)
{
    return (v && v->type == JV_NUM) ? v->num : fallback;
}

int jv_count(const jv *v)
{
    return (v && (v->type == JV_ARR || v->type == JV_OBJ)) ? v->count : 0;
}

const jv *jv_at(const jv *v, int i)
{
    if (!v || (v->type != JV_ARR && v->type != JV_OBJ)) return NULL;
    if (i < 0 || i >= v->count) return NULL;
    return v->items[i];
}

const wchar_t *jv_get_str(const jv *obj, const wchar_t *key, const wchar_t *fallback)
{
    return jv_str_or(jv_get(obj, key), fallback);
}

/*
 * Free a tree, depth first.
 *
 * Every allocation in this file comes from jz(), which is calloc, so every
 * pointer here is free()able and a NULL member is simply one that was never
 * populated — free(NULL) is defined, so the checks are for clarity rather than
 * safety.
 *
 * Recursion depth is the document's nesting depth. nexia.json nests three
 * levels; a hostile file could nest thousands, but jp_value already recurses to
 * parse it, so anything deep enough to overflow here overflowed on the way in.
 */
void jv_free(jv *v)
{
    if (!v) return;

    if (v->type == JV_STR) free(v->str);

    for (int i = 0; i < v->count; i++) {
        if (v->keys) free(v->keys[i]);   /* objects carry a key per child; arrays do not */
        jv_free(v->items[i]);
    }
    free(v->items);
    free(v->keys);
    free(v);
}

/* ── writing ──────────────────────────────────────────────────────────────── */

/*
 * A number, the way JavaScript prints one.
 *
 * JSON.stringify emits the shortest string that reads back as the same double:
 * 1 rather than 1.0, 0.1 rather than 0.10000000000000001. That is not a
 * formatting preference — it is the rule, and %.17g breaks it in the common case
 * while %g breaks it in the precise one. Trying each precision and taking the
 * first that round-trips *is* the rule, stated directly.
 *
 * Integers are handled first because that is every number nexia.json actually
 * holds, and because %g would turn a big one into 1e+06.
 */
static void write_num(FILE *f, double d)
{
    /* JSON has no Infinity or NaN; JSON.stringify emits null for both. */
    if (d != d || d > 1.7976931348623157e308 || d < -1.7976931348623157e308) {
        fputs("null", f);
        return;
    }

    /* JSON.stringify(-0) is "0", not "-0". */
    if (d == 0) { fputc('0', f); return; }
    if (d < 0) { fputc('-', f); d = -d; }

    /*
     * ECMA-262's Number::toString, rather than something %g-shaped that agrees
     * with it most of the time.
     *
     * Two attempts at this were wrong, and both looked right: %.17g breaks 0.1,
     * and %g picks exponent notation whenever the exponent drops below -4, so it
     * calls 0.000001 "1e-6" where JavaScript says "0.000001". C also pads an
     * exponent to two digits — 1.5e-07 against 1.5e-7 — for the same double. The
     * tests found all three; reading the standard was what fixed them.
     *
     * The rule has two halves. First the digits: the shortest decimal that reads
     * back as this exact double, which is what the loop below finds. Then the
     * placement, which depends only on where the point falls (n) and how many
     * digits there are (k) — and notably switches to exponent form only outside
     * 1e-6 .. 1e21, not at 2^53 where doubles stop being exact integers.
     */
    char buf[64];
    int k = 17;
    for (int p = 1; p <= 17; p++) {
        snprintf(buf, sizeof buf, "%.*e", p - 1, d);
        if (strtod(buf, NULL) == d) { k = p; break; }
    }

    /* "d.dddde±XX" -> the digits, and the exponent. */
    char digits[32];
    int nd = 0;
    char *ep = strchr(buf, 'e');
    for (char *q = buf; q < ep; q++)
        if (*q >= '0' && *q <= '9') digits[nd++] = *q;
    digits[nd] = 0;
    /* Trailing zeros are not part of the shortest form: %.*e pads to the width
     * asked for, so 1e21 comes back as "1" with k=1 but 100 would be "1.00e+02"
     * at p=3 had an earlier p not already round-tripped. */
    while (nd > 1 && digits[nd - 1] == '0') digits[--nd] = 0;
    k = nd;

    int n = atoi(ep + 1) + 1;   /* the decimal point sits after digit n */

    if (k <= n && n <= 21) {
        /* 100000000000000000000 — integer, padded with zeros. */
        fwrite(digits, 1, (size_t)k, f);
        for (int i = 0; i < n - k; i++) fputc('0', f);
    } else if (0 < n && n <= 21) {
        /* 1.5 — a point somewhere inside the digits. */
        fwrite(digits, 1, (size_t)n, f);
        fputc('.', f);
        fwrite(digits + n, 1, (size_t)(k - n), f);
    } else if (-6 < n && n <= 0) {
        /* 0.000001 — leading zeros, no exponent. This is the one %g got wrong. */
        fputs("0.", f);
        for (int i = 0; i < -n; i++) fputc('0', f);
        fwrite(digits, 1, (size_t)k, f);
    } else {
        /* 1e+21, 1.5e-7 — exponent form, and no zero padding on the exponent. */
        fputc(digits[0], f);
        if (k > 1) { fputc('.', f); fwrite(digits + 1, 1, (size_t)(k - 1), f); }
        fprintf(f, "e%c%d", n - 1 >= 0 ? '+' : '-', abs(n - 1));
    }
}

static void write_indent(FILE *f, int n)
{
    for (int i = 0; i < n; i++) fputc(' ', f);
}

static void write_val(FILE *f, const jv *v, int indent, int depth)
{
    if (!v) { fputs("null", f); return; }

    switch (v->type) {
    case JV_NULL: fputs("null", f); return;
    case JV_BOOL: fputs(v->b ? "true" : "false", f); return;
    case JV_NUM:  write_num(f, v->num); return;
    case JV_STR:  nx_json_str(f, v->str ? v->str : L""); return;

    case JV_ARR:
    case JV_OBJ: {
        int obj = (v->type == JV_OBJ);
        /* An empty container is [] or {} on one line — JSON.stringify does not
         * put a newline inside one however deep the indent is. */
        if (v->count == 0) { fputs(obj ? "{}" : "[]", f); return; }

        fputc(obj ? '{' : '[', f);
        for (int i = 0; i < v->count; i++) {
            if (i) fputc(',', f);
            if (indent) { fputc('\n', f); write_indent(f, indent * (depth + 1)); }
            if (obj) {
                nx_json_str(f, v->keys && v->keys[i] ? v->keys[i] : L"");
                fputc(':', f);
                if (indent) fputc(' ', f);
            }
            write_val(f, v->items[i], indent, depth + 1);
        }
        if (indent) { fputc('\n', f); write_indent(f, indent * depth); }
        fputc(obj ? '}' : ']', f);
        return;
    }
    }
}

void jv_write(FILE *f, const jv *v, int indent)
{
    write_val(f, v, indent, 0);
}

/*
 * Set obj.key to a string, replacing what is there or appending if it is not.
 *
 * Exists for open(), which reads a project and then overrides `path` with the
 * directory it was actually found in — a project that has been moved still
 * opens, and the file's own recollection of where it lives is not to be trusted.
 * Doing that by walking the tree keeps every other field, including the ones
 * Project Properties and the VS importer put there that nexia-core has never
 * heard of. Rebuilding the object from the fields we know would drop them.
 *
 * Allocated with the same calloc/free the rest of this file uses, so jv_free
 * still owns everything afterwards.
 */
void jv_set_str(jv *obj, const wchar_t *key, const wchar_t *val)
{
    if (!obj || obj->type != JV_OBJ) return;

    size_t vn = (wcslen(val) + 1) * sizeof(wchar_t);

    for (int i = 0; i < obj->count; i++) {
        if (obj->keys && obj->keys[i] && !wcscmp(obj->keys[i], key)) {
            jv *child = obj->items[i];
            if (child->type == JV_STR) free(child->str);
            child->type = JV_STR;
            child->str = (wchar_t *)jz(vn);
            memcpy(child->str, val, vn);
            return;
        }
    }

    /* Not present: append, which puts it last — the same place JavaScript puts
     * a key assigned to an object that did not have it. */
    jv **items = (jv **)realloc(obj->items, (size_t)(obj->count + 1) * sizeof(jv *));
    wchar_t **keys = (wchar_t **)realloc(obj->keys, (size_t)(obj->count + 1) * sizeof(wchar_t *));
    if (!items || !keys) { fwprintf(stderr, L"nexia-core: out of memory\n"); exit(3); }
    obj->items = items;
    obj->keys = keys;

    size_t kn = (wcslen(key) + 1) * sizeof(wchar_t);
    obj->keys[obj->count] = (wchar_t *)jz(kn);
    memcpy(obj->keys[obj->count], key, kn);

    jv *child = (jv *)jz(sizeof(jv));
    child->type = JV_STR;
    child->str = (wchar_t *)jz(vn);
    memcpy(child->str, val, vn);
    obj->items[obj->count] = child;
    obj->count++;
}

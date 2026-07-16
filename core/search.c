/*
 * search.c — the Learn panel's video and web search, ported from
 * searchService.ts.
 *
 * Two halves. The mapping — turning a provider's JSON into the panel's result
 * shape, with HTML entities decoded and Brave's markup stripped — is pure and is
 * proven offline against fixture responses by search-parity.js. The fetch is
 * nx_http_get (WinHTTP); it cannot be parity-tested without live API keys, so the
 * `map` subcommand exposes the mapping on its own, and the full subcommands do
 * fetch-then-map.
 *
 * Keys are passed per call and never logged. redact() scrubs anything key-shaped
 * out of a message bound for the UI, exactly as the TypeScript did.
 */
#include "nexia.h"
#include "http.h"
#include "json_parse.h"
#include <string.h>
#include <stdlib.h>

static void *sz(size_t n) { void *m = calloc(1, n); if (!m) { fwprintf(stderr, L"oom\n"); exit(3); } return m; }

/*
 * WideCharToMultiByte into a fixed buffer, always NUL-terminated.
 *
 * The bare API leaves the destination undefined when the source does not fit
 * (ERROR_INSUFFICIENT_BUFFER), and every caller here immediately strlen()s or
 * urlenc()s the result — an unbounded read of stack garbage, and for a query it
 * would be percent-encoded straight into the outgoing URL. Returns 0 with an
 * empty string when the source is too long, so an over-long query or key becomes
 * "nothing" rather than a crash or a stack-memory disclosure.
 */
static int w2u8(char *dst, int cap, const wchar_t *src)
{
    int n = WideCharToMultiByte(CP_UTF8, 0, src ? src : L"", -1, dst, cap, NULL, NULL);
    if (n <= 0) { dst[0] = 0; return 0; }
    dst[cap - 1] = 0;
    return 1;
}

/* ── string helpers, matching searchService.ts ────────────────────────────── */

/* decodeEntities: &#d; &#xh; &quot; &apos; &lt; &gt; and &amp; last. In place;
 * the result is never longer than the source. Operates on UTF-8 bytes, emitting
 * UTF-8 for a decoded code point. */
static void emit_cp(char **o, unsigned cp)
{
    char *p = *o;
    if (cp < 0x80) *p++ = (char)cp;
    else if (cp < 0x800) { *p++ = (char)(0xC0 | (cp >> 6)); *p++ = (char)(0x80 | (cp & 0x3F)); }
    else if (cp < 0x10000) { *p++ = (char)(0xE0 | (cp >> 12)); *p++ = (char)(0x80 | ((cp >> 6) & 0x3F)); *p++ = (char)(0x80 | (cp & 0x3F)); }
    else { *p++ = (char)(0xF0 | (cp >> 18)); *p++ = (char)(0x80 | ((cp >> 12) & 0x3F)); *p++ = (char)(0x80 | ((cp >> 6) & 0x3F)); *p++ = (char)(0x80 | (cp & 0x3F)); }
    *o = p;
}

static char *decode_entities(const char *s)
{
    /* worst case an entity expands, but numeric ones like &#128512; (8 chars)
     * become at most 4 UTF-8 bytes, and named ones shrink, so source length + 1
     * is always enough. */
    char *out = (char *)sz(strlen(s) + 1), *o = out;
    for (const char *p = s; *p; ) {
        if (*p != '&') { *o++ = *p++; continue; }
        if (p[1] == '#') {
            int hex = (p[2] == 'x' || p[2] == 'X');
            const char *d = p + (hex ? 3 : 2);
            unsigned v = 0; const char *q = d;
            while (*q && *q != ';') {
                int dig;
                if (*q >= '0' && *q <= '9') dig = *q - '0';
                else if (hex && *q >= 'a' && *q <= 'f') dig = *q - 'a' + 10;
                else if (hex && *q >= 'A' && *q <= 'F') dig = *q - 'A' + 10;
                else { q = NULL; break; }
                v = v * (hex ? 16 : 10) + dig; q++;
            }
            if (q && *q == ';') { emit_cp(&o, v); p = q + 1; continue; }
        }
        /* named — longest handled set from searchService, amp last by order of
         * the source scan (we decode &amp; to & and never re-scan it) */
        if (!strncmp(p, "&quot;", 6)) { *o++ = '"'; p += 6; continue; }
        if (!strncmp(p, "&apos;", 6)) { *o++ = '\''; p += 6; continue; }
        if (!strncmp(p, "&lt;", 4)) { *o++ = '<'; p += 4; continue; }
        if (!strncmp(p, "&gt;", 4)) { *o++ = '>'; p += 4; continue; }
        if (!strncmp(p, "&amp;", 5)) { *o++ = '&'; p += 5; continue; }
        *o++ = *p++;
    }
    *o = 0;
    return out;
}

/* stripTags: drop <...> runs. In place-ish, into a fresh buffer. */
static char *strip_tags(const char *s)
{
    char *out = (char *)sz(strlen(s) + 1), *o = out;
    int in = 0;
    for (const char *p = s; *p; p++) {
        if (*p == '<') in = 1;
        else if (*p == '>') in = 0;
        else if (!in) *o++ = *p;
    }
    *o = 0;
    return out;
}

/* decodeEntities(stripTags(x)) — Brave's title/snippet path. */
static char *decode_stripped(const char *s)
{
    char *st = strip_tags(s);
    char *de = decode_entities(st);
    free(st);
    return de;
}

/* siteOf: hostname without a leading www., or "" on a bad URL. */
static void site_of(const char *url, char *out, size_t cap)
{
    out[0] = 0;
    const char *p = strstr(url, "://");
    if (!p) return;
    p += 3;
    const char *e = p;
    while (*e && *e != '/' && *e != '?' && *e != '#' && *e != ':') e++;
    size_t n = (size_t)(e - p);
    if (n >= cap) n = cap - 1;
    memcpy(out, p, n); out[n] = 0;
    if (!strncmp(out, "www.", 4)) memmove(out, out + 4, strlen(out + 4) + 1);
}

/* ── emitting: a decoded UTF-8 string as a JSON string ────────────────────── */

/* nx_json_str_u8 handles escaping; decode/strip produce the bytes. */
static void emit_decoded(FILE *f, const jv *obj, const wchar_t *key, int strip)
{
    const jv *v = jv_get(obj, key);
    const wchar_t *w = jv_str_or(v, L"");
    /* to UTF-8 */
    int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, NULL, 0, NULL, NULL);
    char *u8 = (char *)sz((size_t)(n > 0 ? n : 1));
    if (n > 0) WideCharToMultiByte(CP_UTF8, 0, w, -1, u8, n, NULL, NULL);
    char *dec = strip ? decode_stripped(u8) : decode_entities(u8);
    nx_json_str_u8(f, dec);
    free(dec); free(u8);
}

static char *field_u8(const jv *obj, const wchar_t *key)
{
    const wchar_t *w = jv_str_or(jv_get(obj, key), L"");
    int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, NULL, 0, NULL, NULL);
    char *u8 = (char *)sz((size_t)(n > 0 ? n : 1));
    if (n > 0) WideCharToMultiByte(CP_UTF8, 0, w, -1, u8, n, NULL, NULL);
    return u8;
}

/* ── the three mappers, emitting SearchResponse<T> success bodies ─────────── */

static void map_youtube(const jv *root, FILE *f)
{
    const jv *items = jv_get(root, L"items");
    printf("{\"success\":true,\"results\":[");
    int first = 1;
    for (int i = 0; i < jv_count(items); i++) {
        const jv *it = jv_at(items, i);
        const jv *id = jv_get(it, L"id");
        const wchar_t *vid = jv_get_str(id, L"videoId", NULL);
        if (!vid || !vid[0]) continue;   /* deleted-but-indexed: no videoId */
        const jv *sn = jv_get(it, L"snippet");
        const jv *th = jv_get(sn, L"thumbnails");
        /* (th.medium || th.default || {}).url || '' */
        const jv *thumbObj = jv_get(th, L"medium");
        if (!thumbObj) thumbObj = jv_get(th, L"default");

        if (!first) printf(",");
        first = 0;
        char *vidU8 = field_u8(id, L"videoId");
        printf("{\"id\":"); nx_json_str_u8(f, vidU8);
        printf(",\"title\":"); emit_decoded(f, sn, L"title", 0);
        printf(",\"channel\":"); emit_decoded(f, sn, L"channelTitle", 0);
        printf(",\"published\":"); { char *p = field_u8(sn, L"publishedAt"); nx_json_str_u8(f, p); free(p); }
        printf(",\"thumbnail\":"); { char *t = field_u8(thumbObj, L"url"); nx_json_str_u8(f, t); free(t); }
        printf(",\"description\":"); emit_decoded(f, sn, L"description", 0);
        printf(",\"url\":"); { char pre[512]; snprintf(pre, 512, "https://www.youtube.com/watch?v=%s", vidU8); nx_json_str_u8(f, pre); }
        printf("}");
        free(vidU8);
    }
    printf("]}\n");
}

static void map_brave(const jv *root, FILE *f)
{
    const jv *web = jv_get(root, L"web");
    const jv *results = jv_get(web, L"results");
    printf("{\"success\":true,\"results\":[");
    for (int i = 0; i < jv_count(results); i++) {
        const jv *r = jv_at(results, i);
        if (i) printf(",");
        char *url = field_u8(r, L"url");
        char site[256]; site_of(url, site, 256);
        printf("{\"title\":"); emit_decoded(f, r, L"title", 1);
        printf(",\"url\":"); nx_json_str_u8(f, url);
        printf(",\"snippet\":"); emit_decoded(f, r, L"description", 1);
        printf(",\"site\":"); nx_json_str_u8(f, site);
        printf("}");
        free(url);
    }
    printf("]}\n");
}

static void map_google(const jv *root, FILE *f)
{
    const jv *items = jv_get(root, L"items");
    printf("{\"success\":true,\"results\":[");
    for (int i = 0; i < jv_count(items); i++) {
        const jv *r = jv_at(items, i);
        if (i) printf(",");
        char *link = field_u8(r, L"link");
        /* site: r.displayLink || siteOf(r.link). displayLink is used as-is. */
        char site[256];
        char *disp = field_u8(r, L"displayLink");
        if (disp[0]) { strncpy(site, disp, 255); site[255] = 0; }
        else site_of(link, site, 256);
        free(disp);
        printf("{\"title\":"); emit_decoded(f, r, L"title", 0);
        printf(",\"url\":"); nx_json_str_u8(f, link);
        printf(",\"snippet\":"); emit_decoded(f, r, L"snippet", 0);
        printf(",\"site\":"); nx_json_str_u8(f, site);
        printf("}");
        free(link);
    }
    printf("]}\n");
}

/* ── the live path: fetch, then map or explain ────────────────────────────── */

/* percent-encode for a query value (encodeURIComponent's unreserved set). */
static void urlenc(const char *s, char *out, size_t cap)
{
    static const char *hex = "0123456789ABCDEF";
    size_t o = 0;
    for (const unsigned char *p = (const unsigned char *)s; *p && o + 3 < cap; p++) {
        unsigned char c = *p;
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
            c == '-' || c == '_' || c == '.' || c == '!' || c == '~' || c == '*' || c == '\'' || c == '(' || c == ')')
            out[o++] = (char)c;
        else { out[o++] = '%'; out[o++] = hex[c >> 4]; out[o++] = hex[c & 15]; }
    }
    out[o] = 0;
}

/*
 * redact: scrub key/token query values out of a message, in a buffer of `cap`.
 *
 * The replacement ("[redacted]", 10 bytes) can be longer than the value it
 * replaces, so this GROWS the string — and without a bound that memmove can walk
 * off the end of a fixed buffer. An error message from a hostile endpoint
 * containing "?key=x" near the 512-byte boundary is a stack overflow driven by
 * network content, which is why `cap` is threaded through and every shift is
 * clamped to it.
 */
static void redact(char *s, size_t cap)
{
    for (char *p = s; *p; p++) {
        if ((*p == '?' || *p == '&') &&
            (!_strnicmp(p + 1, "key=", 4) || !_strnicmp(p + 1, "token=", 6))) {
            char *v = strchr(p + 1, '=') + 1;
            char *e = v;
            while (*e && *e != '&') e++;
            const char *rep = "[redacted]";
            size_t rl = strlen(rep);
            size_t voff = (size_t)(v - s), tail = strlen(e);
            /* need room for: v-prefix + rep + tail + NUL */
            if (voff + rl + tail + 1 > cap) {
                /* would overflow — truncate: drop the value, keep what fits */
                size_t room = voff < cap ? cap - voff - 1 : 0;
                size_t w = rl < room ? rl : room;
                memcpy(v, rep, w);
                v[w] = 0;
                return;
            }
            memmove(v + rl, e, tail + 1);
            memcpy(v, rep, rl);
            p = v + rl - 1;
        }
    }
}

/* explain(err) → the message the panel shows. status/reason from the response. */
static void explain(long status, const char *reason, const char *apiMsg, const char *provider,
                    char *out, size_t cap)
{
    if (status == 403 && reason && !strcmp(reason, "quotaExceeded"))
        snprintf(out, cap, "%s has cut you off for the day \342\200\224 the free quota is spent. It resets at midnight Pacific.", provider);
    else if (status == 403 || status == 401)
        snprintf(out, cap, "%s rejected the API key. Check it in Settings \342\206\222 Learn.", provider);
    else if (status == 429)
        snprintf(out, cap, "%s is rate limiting you. Wait a moment and try again.", provider);
    else if (status == 400)
        snprintf(out, cap, "%s rejected the request: %s", provider, apiMsg ? apiMsg : "");
    else if (status == 0)
        snprintf(out, cap, "No connection to the internet.");   /* transport failure */
    else
        snprintf(out, cap, "%s", apiMsg ? apiMsg : "");
    redact(out, cap);
}

/* emit {success:false, error, needsKey?} */
static void emit_error(const char *msg, int needsKey)
{
    printf("{\"success\":false,\"error\":");
    nx_json_str_u8(stdout, msg);
    if (needsKey) printf(",\"needsKey\":true");
    printf("}\n");
}

/* Fetch a URL and hand the parsed body + status to the caller. Emits the error
 * response and returns NULL when the fetch itself failed or the status is not
 * 200; on 200 returns the parsed JSON (caller frees). */
static jv *fetch_json(const wchar_t *url, const wchar_t **hdrs, int nh, const char *provider)
{
    nx_http_resp resp;
    if (!nx_http_get(url, hdrs, nh, &resp)) {
        char msg[512];
        explain(0, NULL, NULL, provider, msg, 512);   /* transport → "no connection" */
        emit_error(msg, 0);
        nx_http_free(&resp);
        return NULL;
    }

    const char *perr = NULL;
    jv *root = resp.body ? jv_parse_utf8(resp.body, resp.len, &perr) : NULL;

    if (resp.status != 200) {
        const char *apiMsg = NULL, *reason = NULL;
        if (root) {
            const jv *e = jv_get(root, L"error");
            /* apiMsg = error.message || message; reason = error.errors[0].reason */
            static char am[512], rs[128];
            const wchar_t *m = jv_get_str(e, L"message", NULL);
            if (!m) m = jv_get_str(root, L"message", NULL);
            if (m) { w2u8(am, 512, m); apiMsg = am; }
            const jv *errs = jv_get(e, L"errors");
            const wchar_t *r0 = jv_get_str(jv_at(errs, 0), L"reason", NULL);
            if (r0) { w2u8(rs, 128, r0); reason = rs; }
        }
        char msg[512];
        if (!apiMsg) { char code[32]; snprintf(code, 32, "HTTP %ld", resp.status); explain(resp.status, reason, code, provider, msg, 512); }
        else explain(resp.status, reason, apiMsg, provider, msg, 512);
        emit_error(msg, 0);
        if (root) jv_free(root);
        nx_http_free(&resp);
        return NULL;
    }

    nx_http_free(&resp);
    if (!root) { emit_error("The response was not valid JSON", 0); return NULL; }
    return root;
}

static int live_youtube(const wchar_t *key, const wchar_t *query, int max)
{
    char q[4096]; w2u8(q, 4096, query);
    /* trim */
    char *qs = q; while (*qs == ' ') qs++;
    char *qe = qs + strlen(qs); while (qe > qs && qe[-1] == ' ') *--qe = 0;
    if (!*qs) { printf("{\"success\":true,\"results\":[]}\n"); return 0; }
    if (!key || !key[0]) { emit_error("Video search needs a YouTube Data API key.", 1); return 0; }

    char keyU8[1024]; w2u8(keyU8, 1024, key);
    char qenc[3072], kenc[1536];
    urlenc(qs, qenc, 3072); urlenc(keyU8, kenc, 1536);
    int m = max < 1 ? 1 : max > 50 ? 50 : max;

    char url[8192];
    snprintf(url, 8192, "https://www.googleapis.com/youtube/v3/search"
        "?part=snippet&type=video&safeSearch=moderate&maxResults=%d&q=%s&key=%s", m, qenc, kenc);
    wchar_t wurl[8192]; MultiByteToWideChar(CP_UTF8, 0, url, -1, wurl, 8192);

    jv *root = fetch_json(wurl, NULL, 0, "YouTube");
    if (!root) return 0;
    map_youtube(root, stdout);
    jv_free(root);
    return 0;
}

static int live_web(const wchar_t *provider, const wchar_t *key, const wchar_t *engineId, const wchar_t *query)
{
    char q[4096]; w2u8(q, 4096, query);
    char *qs = q; while (*qs == ' ') qs++;
    char *qe = qs + strlen(qs); while (qe > qs && qe[-1] == 0x20) *--qe = 0;
    if (!*qs) { printf("{\"success\":true,\"results\":[]}\n"); return 0; }

    int brave = !wcscmp(provider, L"brave");
    if (!key || !key[0]) {
        emit_error(brave ? "Web search needs a Brave Search API key."
                         : "Web search needs a Google Programmable Search key.", 1);
        return 0;
    }
    if (!brave && (!engineId || !engineId[0])) {
        emit_error("Google Programmable Search also needs a Search engine ID.", 1);
        return 0;
    }

    char keyU8[2048]; w2u8(keyU8, 2048, key);
    char qenc[3072]; urlenc(qs, qenc, 3072);

    if (brave) {
        char url[8192];
        snprintf(url, 8192, "https://api.search.brave.com/res/v1/web/search?count=20&q=%s", qenc);
        wchar_t wurl[8192]; MultiByteToWideChar(CP_UTF8, 0, url, -1, wurl, 8192);
        wchar_t hdr[2048]; _snwprintf(hdr, 2048, L"X-Subscription-Token: %ls", key); hdr[2047] = 0;
        const wchar_t *hdrs[1] = { hdr };
        jv *root = fetch_json(wurl, hdrs, 1, "Brave Search");
        if (!root) return 0;
        map_brave(root, stdout);
        jv_free(root);
        return 0;
    }

    char kenc[6144], cxenc[1536], cxU8[512];
    w2u8(cxU8, 512, engineId);
    urlenc(keyU8, kenc, 6144); urlenc(cxU8, cxenc, 1536);
    char url[16384];
    snprintf(url, 16384, "https://www.googleapis.com/customsearch/v1?key=%s&cx=%s&num=10&q=%s", kenc, cxenc, qenc);
    wchar_t wurl[16384]; MultiByteToWideChar(CP_UTF8, 0, url, -1, wurl, 16384);
    jv *root = fetch_json(wurl, NULL, 0, "Google");
    if (!root) return 0;
    map_google(root, stdout);
    jv_free(root);
    return 0;
}

/* ── CLI ──────────────────────────────────────────────────────────────────── */

static int map_file(const wchar_t *provider, const wchar_t *path)
{
    const char *err = NULL;
    jv *root = jv_parse_file(path, &err);
    if (!root) { nx_json_error(err ? err : "cannot read the response"); return 1; }
    if (!wcscmp(provider, L"youtube")) map_youtube(root, stdout);
    else if (!wcscmp(provider, L"brave")) map_brave(root, stdout);
    else if (!wcscmp(provider, L"google")) map_google(root, stdout);
    else { jv_free(root); nx_json_error("search map: unknown provider"); return 2; }
    jv_free(root);
    return 0;
}

int nx_cmd_search(int argc, wchar_t **argv)
{
    if (argc < 1) { nx_json_error("search: expected a subcommand"); return 2; }

    /* offline: map a fixture response, no network — this is what the parity test
     * drives. */
    if (!wcscmp(argv[0], L"map")) {
        if (argc < 3) { nx_json_error("search map: expected <provider> <file>"); return 2; }
        return map_file(argv[1], argv[2]);
    }

    /* search youtube <apiKey> <query> [max] */
    if (!wcscmp(argv[0], L"youtube")) {
        if (argc < 3) { nx_json_error("search youtube: expected <apiKey> <query> [max]"); return 2; }
        int max = argc >= 4 ? _wtoi(argv[3]) : 20;
        return live_youtube(argv[1], argv[2], max);
    }

    /* search web <google|brave> <apiKey> <query> [--cx <engineId>] */
    if (!wcscmp(argv[0], L"web")) {
        if (argc < 4) { nx_json_error("search web: expected <google|brave> <apiKey> <query> [--cx <id>]"); return 2; }
        const wchar_t *cx = NULL;
        for (int i = 4; i + 1 < argc; i += 2) if (!wcscmp(argv[i], L"--cx")) cx = argv[i + 1];
        return live_web(argv[1], argv[2], cx, argv[3]);
    }

    nx_json_error("search: unknown subcommand");
    return 2;
}

/*
 * xex.c — read an Xbox 360 executable's headers.
 *
 * Ported from parseXex() in main.ts, where 241 lines of binary parsing had ended
 * up inside the one file that imports Electron. It never belonged there: it is a
 * pure function — bytes in, structure out — and it is the kind of work C exists
 * for. Extracting it shrinks the Electron-coupled surface rather than just
 * moving code between languages.
 *
 * TWO BYTE ORDERS, AND THAT IS NOT A MISTAKE.
 * The XEX wrapper is big-endian, because the console is PowerPC. The PE image
 * inside it is little-endian, because it is still a PE and Microsoft's format
 * did not change. So rd32be reads the XEX's own fields and rd32le reads
 * anything from the MZ header inwards. Mixing them up yields plausible-looking
 * nonsense — huge section counts, timestamps in 1970 — rather than an error.
 *
 * EVERY READ IS BOUNDS-CHECKED.
 * The offsets come from the file being parsed, so a corrupt or hostile XEX can
 * point them anywhere. The TypeScript wrapped whole blocks in try/catch and let
 * an out-of-range read throw; C has no such net, and an unchecked read here is
 * a crash in the IDE at best.
 */
#include "nexia.h"
#include <string.h>
#include <time.h>

typedef struct { const unsigned char *p; size_t n; } buf;

static int have(const buf *b, size_t off, size_t len)
{
    return off <= b->n && len <= b->n - off;
}

static unsigned rd32be(const buf *b, size_t off)
{
    if (!have(b, off, 4)) return 0;
    const unsigned char *p = b->p + off;
    return ((unsigned)p[0] << 24) | ((unsigned)p[1] << 16) | ((unsigned)p[2] << 8) | p[3];
}

static unsigned rd32le(const buf *b, size_t off)
{
    if (!have(b, off, 4)) return 0;
    const unsigned char *p = b->p + off;
    return ((unsigned)p[3] << 24) | ((unsigned)p[2] << 16) | ((unsigned)p[1] << 8) | p[0];
}

static unsigned short rd16le(const buf *b, size_t off)
{
    if (!have(b, off, 2)) return 0;
    return (unsigned short)((b->p[off + 1] << 8) | b->p[off]);
}

static unsigned short rd16be(const buf *b, size_t off)
{
    if (!have(b, off, 2)) return 0;
    return (unsigned short)((b->p[off] << 8) | b->p[off + 1]);
}

static unsigned char rd8(const buf *b, size_t off)
{
    return have(b, off, 1) ? b->p[off] : 0;
}

/* An ASCII run, NULs stripped, as the TypeScript's toString('ascii').replace(/\0/g,'') did. */
static void ascii(const buf *b, size_t off, size_t len, char *out, size_t cap)
{
    size_t w = 0;
    for (size_t i = 0; i < len && w + 1 < cap; i++) {
        if (!have(b, off + i, 1)) break;
        unsigned char c = b->p[off + i];
        if (c) out[w++] = (char)c;
    }
    out[w] = 0;
}

static void json_ascii(FILE *f, const char *s)
{
    wchar_t w[512];
    int n = MultiByteToWideChar(CP_ACP, 0, s, -1, w, 512);
    nx_json_str(f, n > 0 ? w : L"");
}

/* Mirrors formatBytes() in main.ts. The IDE shows these strings to the user, so
 * they have to match exactly, units and decimals and all. */
static void fmt_bytes(double n, char *out, size_t cap)
{
    static const char *u[] = { "B", "KB", "MB", "GB", "TB" };
    int i = 0;
    while (n >= 1024 && i < 4) { n /= 1024; i++; }
    if (i == 0) _snprintf(out, cap - 1, "%d B", (int)n);
    else _snprintf(out, cap - 1, "%.2f %s", n, u[i]);
    out[cap - 1] = 0;
}

static const struct { unsigned id; const char *name; } known[] = {
    { 0x000002FF, "Resource Info" },            { 0x000003FF, "Base File Format" },
    { 0x000005FF, "Delta Patch Descriptor" },   { 0x00008001, "Bounding Path" },
    { 0x00008105, "Device ID" },                { 0x000080FF, "Original Base Address" },
    { 0x00008102, "Entry Point" },              { 0x00008103, "Image Base Address" },
    { 0x00008104, "Import Libraries" },         { 0x000100FF, "Checksum Timestamp" },
    { 0x000101FF, "Enabled For Callcap" },      { 0x000102FF, "Enabled For Fastcap" },
    { 0x000103FF, "Original PE Name" },         { 0x00018002, "Static Libraries" },
    { 0x000183FF, "TLS Info" },                 { 0x000200FF, "Default Stack Size" },
    { 0x000201FF, "Default Filesystem Cache Size" },
    { 0x000300FF, "Default Heap Size" },        { 0x00040006, "System Flags" },
    { 0x000400FF, "Execution Info" },           { 0x000401FF, "Service ID List" },
    { 0x000402FF, "Title Workspace Size" },     { 0x000403FF, "Game Ratings" },
    { 0x000405FF, "LAN Key" },                  { 0x000406FF, "Xbox 360 Logo" },
    { 0x000407FF, "Multidisc Media IDs" },      { 0x000408FF, "Alternate Title IDs" },
    { 0x000409FF, "Additional Title Memory" },  { 0x0004050B, "Export Table" },
};

static const char *header_name(unsigned id, char *fallback, size_t cap)
{
    for (size_t i = 0; i < sizeof(known) / sizeof(known[0]); i++)
        if (known[i].id == id) return known[i].name;
    _snprintf(fallback, cap - 1, "Unknown (0x%08x)", id);
    fallback[cap - 1] = 0;
    return fallback;
}

static const char *module_flags[] = {
    "TITLE_MODULE", "EXPORTS_TO_TITLE", "SYSTEM_DEBUGGER", "DLL_MODULE",
    "MODULE_PATCH", "PATCH_FULL", "PATCH_DELTA", "USER_MODE",
};

/*
 * nexia-core xex inspect <file>
 *
 * The JSON shape mirrors parseXex()'s return exactly: the renderer already
 * consumes it, so a renamed field is a broken panel.
 */
int nx_cmd_xex(int argc, wchar_t **argv)
{
    if (argc < 2 || wcscmp(argv[0], L"inspect")) { nx_json_error("xex: expected 'inspect <file>'"); return 2; }

    HANDLE h = CreateFileW(argv[1], GENERIC_READ, FILE_SHARE_READ, NULL,
                           OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) { nx_json_error("cannot open file"); return 1; }

    LARGE_INTEGER sz;
    if (!GetFileSizeEx(h, &sz) || sz.QuadPart > 512u * 1024 * 1024) {
        CloseHandle(h); nx_json_error("file too large or unreadable"); return 1;
    }
    unsigned char *data = (unsigned char *)malloc((size_t)sz.QuadPart + 1);
    if (!data) { CloseHandle(h); nx_json_error("out of memory"); return 1; }
    DWORD got = 0;
    ReadFile(h, data, (DWORD)sz.QuadPart, &got, NULL);
    CloseHandle(h);

    buf b = { data, got };
    char tmp[512];

    printf("{");
    nx_json_field(stdout, "filePath", argv[1]);
    printf(",");
    const wchar_t *base = wcsrchr(argv[1], L'\\');
    nx_json_field(stdout, "fileName", base ? base + 1 : argv[1]);
    printf(",\"fileSize\":%lu,\"fileSizeFormatted\":", (unsigned long)got);
    fmt_bytes(got, tmp, sizeof tmp);
    json_ascii(stdout, tmp);

    /* 24 bytes is the fixed XEX2 header. Below that there is nothing to read. */
    if (got < 24) {
        printf(",\"valid\":false,\"error\":\"File too small to be a valid XEX\"}\n");
        free(data);
        return 0;
    }

    char magic[8];
    ascii(&b, 0, 4, magic, sizeof magic);
    /* "XEX\0" reaches here as "XEX" — ascii() drops the NUL, and the TypeScript's
     * .replace(/\0/g,'') did the same, so the comparison matches on 3 chars. */
    int ok_magic = !strcmp(magic, "XEX2") || !strcmp(magic, "XEX1") || !strcmp(magic, "XEX");
    if (!ok_magic) {
        printf(",\"valid\":false,\"error\":");
        _snprintf(tmp, sizeof tmp - 1, "Invalid magic: \"%s\" (expected \"XEX2\")", magic);
        json_ascii(stdout, tmp);
        printf("}\n");
        free(data);
        return 0;
    }

    unsigned mod_flags = rd32be(&b, 4);
    unsigned pe_off    = rd32be(&b, 8);
    unsigned sec_off   = rd32be(&b, 16);
    unsigned opt_count = rd32be(&b, 20);

    printf(",\"valid\":true,\"error\":null,\"header\":{\"magic\":");
    json_ascii(stdout, magic);
    printf(",\"moduleFlags\":%u,\"peDataOffset\":%u,\"reserved\":%u,"
           "\"securityInfoOffset\":%u,\"optionalHeaderCount\":%u,\"moduleFlagsDecoded\":[",
           mod_flags, pe_off, rd32be(&b, 12), sec_off, opt_count);
    int first = 1;
    for (int i = 0; i < 8; i++)
        if (mod_flags & (1u << i)) { if (!first) printf(","); json_ascii(stdout, module_flags[i]); first = 0; }
    printf("]");

    /* Collected while walking the optional headers, emitted after. */
    char pe_name[256] = "";
    char exec_json[1024] = "";
    char imports_json[4096] = "";
    char resources_json[8192] = "";
    size_t rj = 0, ij = 0;

    /* ── optional headers ── */
    char opts_json[16384];
    size_t oj = 0;
    oj += (size_t)_snprintf(opts_json + oj, sizeof opts_json - oj, "%s", "");

    size_t off = 24;
    for (unsigned i = 0; i < opt_count && have(&b, off, 8); i++, off += 8) {
        unsigned id = rd32be(&b, off), val = rd32be(&b, off + 4);
        char fb[64];
        const char *name = header_name(id, fb, sizeof fb);

        char entry[2048];
        int n = _snprintf(entry, sizeof entry - 1,
            "%s{\"id\":%u,\"idHex\":\"0x%08x\",\"name\":\"%s\",\"dataOrOffset\":%u,\"dataHex\":\"0x%08x\"",
            oj ? "," : "", id, id, name, val, val);

        if (id == 0x000200FF || id == 0x000300FF) {          /* stack / heap size */
            char f[64]; fmt_bytes(val, f, sizeof f);
            n += _snprintf(entry + n, sizeof entry - (size_t)n - 1,
                           ",\"value\":%u,\"valueFormatted\":\"%s\"", val, f);
        } else if (id == 0x000103FF && val > 0 && have(&b, val, 4)) {   /* original PE name */
            unsigned len = rd32be(&b, val);
            if (len > 0 && len < 256 && have(&b, val + 4, len)) {
                ascii(&b, val + 4, len, pe_name, sizeof pe_name);
                n += _snprintf(entry + n, sizeof entry - (size_t)n - 1, ",\"value\":\"%s\"", pe_name);
            }
        } else if (id == 0x00008102) {
            _snprintf(exec_json + strlen(exec_json), sizeof exec_json - strlen(exec_json) - 1,
                      "%s\"entryPoint\":\"0x%08x\"", *exec_json ? "," : "", val);
        } else if (id == 0x00008103) {
            _snprintf(exec_json + strlen(exec_json), sizeof exec_json - strlen(exec_json) - 1,
                      "%s\"imageBaseAddress\":\"0x%08x\"", *exec_json ? "," : "", val);
        } else if (id == 0x000080FF) {
            _snprintf(exec_json + strlen(exec_json), sizeof exec_json - strlen(exec_json) - 1,
                      "%s\"originalBaseAddress\":\"0x%08x\"", *exec_json ? "," : "", val);
        } else if (id == 0x000400FF && have(&b, val, 24)) {   /* execution info */
            _snprintf(exec_json + strlen(exec_json), sizeof exec_json - strlen(exec_json) - 1,
                "%s\"mediaId\":\"0x%08x\",\"version\":\"%u.%u.%u.%u\",\"baseVersion\":\"%u.%u.%u.%u\","
                "\"titleId\":\"0x%08x\",\"platform\":%u,\"executableType\":%u,\"discNumber\":%u,\"discCount\":%u",
                *exec_json ? "," : "",
                rd32be(&b, val),
                rd8(&b, val + 4), rd8(&b, val + 5), rd16be(&b, val + 6), rd8(&b, val + 8),
                rd8(&b, val + 9), rd8(&b, val + 10), rd16be(&b, val + 11), rd8(&b, val + 13),
                rd32be(&b, val + 14), rd8(&b, val + 18), rd8(&b, val + 19),
                rd8(&b, val + 20), rd8(&b, val + 21));
        } else if (id == 0x00008104 && have(&b, val, 8)) {    /* import libraries */
            unsigned tbl = rd32be(&b, val), count = rd32be(&b, val + 4);
            size_t p = val + 8, end = val + 8 + tbl;
            char libs[1024] = ""; int nlibs = 0;
            /* 16 is the TypeScript's cap, kept: a corrupt table would otherwise
             * walk the whole file one string at a time. */
            for (int k = 0; k < 16 && p < end && have(&b, p, 1); k++) {
                size_t e = p;
                while (e < end && have(&b, e, 1) && b.p[e]) e++;
                if (e <= p || e > end) break;
                char nm[128];
                ascii(&b, p, e - p, nm, sizeof nm);
                if (*nm) {
                    _snprintf(libs + strlen(libs), sizeof libs - strlen(libs) - 1,
                              "%s\"%s\"", nlibs ? "," : "", nm);
                    _snprintf(imports_json + ij, sizeof imports_json - ij, "%s{\"library\":\"%s\",\"functions\":[]}",
                              ij ? "," : "", nm);
                    ij = strlen(imports_json);
                    nlibs++;
                }
                p = e + 1;
                while (p < end && have(&b, p, 1) && !b.p[p]) p++;   /* padding */
            }
            n += _snprintf(entry + n, sizeof entry - (size_t)n - 1,
                           ",\"value\":\"%d libraries, %u total imports\",\"libraries\":[%s]",
                           nlibs, count, libs);
        } else if (id == 0x000002FF && have(&b, val, 4)) {     /* resources */
            unsigned rsz = rd32be(&b, val);
            unsigned rcount = rsz / 16;
            for (unsigned r = 0; r < rcount && have(&b, val + 4 + (size_t)(r + 1) * 16, 0); r++) {
                size_t ro = val + 4 + (size_t)r * 16;
                if (!have(&b, ro, 16)) break;
                char rn[16]; ascii(&b, ro, 8, rn, sizeof rn);
                unsigned addr = rd32be(&b, ro + 8), len = rd32be(&b, ro + 12);
                char f[64]; fmt_bytes(len, f, sizeof f);
                _snprintf(resources_json + rj, sizeof resources_json - rj,
                    "%s{\"name\":\"%s\",\"address\":\"0x%08x\",\"size\":%u,\"sizeFormatted\":\"%s\"}",
                    rj ? "," : "", rn, addr, len, f);
                rj = strlen(resources_json);
            }
        }

        n += _snprintf(entry + n, sizeof entry - (size_t)n - 1, "}");
        if (oj + (size_t)n < sizeof opts_json) { memcpy(opts_json + oj, entry, (size_t)n); oj += (size_t)n; }
    }
    opts_json[oj] = 0;

    if (*pe_name) { printf(",\"originalPeName\":"); json_ascii(stdout, pe_name); }

    /* ── security info, and the PE image inside ── */
    char sections_json[16384] = ""; size_t sj = 0;
    char sec_json[256] = "";
    char pe_extra[256] = "";

    if (sec_off > 0 && have(&b, sec_off, 296)) {
        unsigned hsz = rd32be(&b, sec_off), isz = rd32be(&b, sec_off + 4);
        char f[64]; fmt_bytes(isz, f, sizeof f);
        _snprintf(sec_json, sizeof sec_json - 1,
                  "\"headerSize\":%u,\"imageSize\":%u,\"imageSizeFormatted\":\"%s\"", hsz, isz, f);

        /* From here the bytes are a PE, so the reads become little-endian. */
        if (pe_off > 0 && have(&b, pe_off, 0x100)) {
            char mz[4]; ascii(&b, pe_off, 2, mz, sizeof mz);
            if (!strcmp(mz, "MZ")) {
                unsigned pe_hdr = rd32le(&b, pe_off + 0x3C);
                size_t abs = pe_off + pe_hdr;
                char sig[8]; ascii(&b, abs, 4, sig, sizeof sig);
                if (!strcmp(sig, "PE")) {          /* "PE\0\0" -> "PE" after NUL-stripping */
                    unsigned short nsec = rd16le(&b, abs + 6);
                    unsigned ts = rd32le(&b, abs + 8);
                    /* ISO-8601 in UTC, matching new Date(ts*1000).toISOString(). */
                    time_t t = (time_t)ts;
                    struct tm g;
                    if (gmtime_s(&g, &t) == 0) {
                        _snprintf(pe_extra, sizeof pe_extra - 1,
                            ",\"peTimestamp\":\"%04d-%02d-%02dT%02d:%02d:%02d.000Z\",\"peSectionCount\":%u",
                            g.tm_year + 1900, g.tm_mon + 1, g.tm_mday, g.tm_hour, g.tm_min, g.tm_sec, nsec);
                    }
                    unsigned short opt_sz = rd16le(&b, abs + 20);
                    size_t stab = abs + 24 + opt_sz;
                    for (unsigned s = 0; s < nsec && have(&b, stab + (size_t)(s + 1) * 40 - 40, 40); s++) {
                        size_t so = stab + (size_t)s * 40;
                        char sn[16]; ascii(&b, so, 8, sn, sizeof sn);
                        unsigned vs = rd32le(&b, so + 8), va = rd32le(&b, so + 12);
                        unsigned rs = rd32le(&b, so + 16), rp = rd32le(&b, so + 20);
                        unsigned ch = rd32le(&b, so + 36);
                        char flags[160] = ""; int nf = 0;
                        struct { unsigned m; const char *n; } cf[] = {
                            { 0x00000020, "CODE" }, { 0x00000040, "INITIALIZED_DATA" },
                            { 0x00000080, "UNINITIALIZED_DATA" }, { 0x20000000, "EXECUTE" },
                            { 0x40000000, "READ" }, { 0x80000000, "WRITE" } };
                        for (size_t k = 0; k < 6; k++)
                            if (ch & cf[k].m) { _snprintf(flags + strlen(flags), sizeof flags - strlen(flags) - 1,
                                                          "%s\"%s\"", nf++ ? "," : "", cf[k].n); }
                        char fv[64], fr[64]; fmt_bytes(vs, fv, sizeof fv); fmt_bytes(rs, fr, sizeof fr);
                        _snprintf(sections_json + sj, sizeof sections_json - sj,
                            "%s{\"name\":\"%s\",\"virtualSize\":%u,\"virtualSizeFormatted\":\"%s\","
                            "\"virtualAddress\":\"0x%08x\",\"rawDataSize\":%u,\"rawDataSizeFormatted\":\"%s\","
                            "\"rawDataPointer\":\"0x%08x\",\"characteristics\":[%s],\"characteristicsRaw\":\"0x%08x\"}",
                            sj ? "," : "", sn, vs, fv, va, rs, fr, rp, flags, ch);
                        sj = strlen(sections_json);
                    }
                }
            }
        }
    }

    printf("%s}", pe_extra);
    printf(",\"securityInfo\":{%s}", sec_json);
    printf(",\"optionalHeaders\":[%s]", opts_json);
    printf(",\"sections\":[%s]", sections_json);
    printf(",\"imports\":[%s]", imports_json);
    printf(",\"resources\":[%s]", resources_json);
    printf(",\"executionInfo\":{%s}}\n", exec_json);

    free(data);
    return 0;
}

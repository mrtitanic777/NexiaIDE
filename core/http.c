/*
 * http.c — an HTTPS GET, in C, over WinHTTP.
 *
 * searchService.ts reached the web through Node's https module; this is what
 * replaces it. WinHTTP rather than raw schannel because it does the TLS
 * handshake, the chunked decode and the redirects itself, and it ships on every
 * Windows from 7 on — no bundled TLS stack, no new redistributable.
 *
 * The one trap, and it is a real one: WinHTTP on Windows 7 defaults to TLS 1.0,
 * and every API worth calling now refuses anything below 1.2. So the protocol
 * set is forced to 1.2 explicitly below — without it the handshake fails on the
 * exact machines this project exists to support, and nowhere else, so it would
 * pass every test on a dev box and break in the field.
 */
#include "nexia.h"
#include "http.h"
#include <winhttp.h>
#include <string.h>
#include <stdlib.h>

void nx_http_free(nx_http_resp *r)
{
    if (r && r->body) { free(r->body); r->body = NULL; }
}

/*
 * GET url, with optional "Name: value" headers. Returns 1 when a response was
 * received (status may be any code), 0 on a transport failure with err set.
 * On success body is a NUL-terminated malloc'd buffer the caller frees via
 * nx_http_free.
 */
int nx_http_get(const wchar_t *url, const wchar_t **headers, int nheaders, nx_http_resp *out)
{
    memset(out, 0, sizeof *out);

    const DWORD MAX_BYTES = 4u * 1024 * 1024;   /* searchService's cap, same reason */

    /* crack the URL into scheme/host/path */
    URL_COMPONENTS uc;
    memset(&uc, 0, sizeof uc);
    uc.dwStructSize = sizeof uc;
    /* path holds path+query combined (no lpszExtraInfo set), and the query can be
     * a long encoded search string — search.c builds URLs into a 16 KB buffer —
     * so this must be at least as large or WinHttpCrackUrl fails a valid long
     * query with a misleading "bad URL". */
    wchar_t host[256], path[16384];
    uc.lpszHostName = host; uc.dwHostNameLength = 256;
    uc.lpszUrlPath = path; uc.dwUrlPathLength = 16384;
    if (!WinHttpCrackUrl(url, 0, 0, &uc)) {
        _snwprintf(out->err, 256, L"bad URL"); return 0;
    }
    int https = (uc.nScheme == INTERNET_SCHEME_HTTPS);

    HINTERNET s = WinHttpOpen(L"NexiaIDE",
        WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!s) { _snwprintf(out->err, 256, L"WinHttpOpen failed (%lu)", GetLastError()); return 0; }

    /* 15s across the board, matching searchService's TIMEOUT_MS */
    WinHttpSetTimeouts(s, 15000, 15000, 15000, 15000);

    /* TLS 1.2 — the Windows 7 default is 1.0 and the APIs refuse it. */
    DWORD proto = WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2;
    WinHttpSetOption(s, WINHTTP_OPTION_SECURE_PROTOCOLS, &proto, sizeof proto);

    HINTERNET c = WinHttpConnect(s, host, uc.nPort, 0);
    if (!c) { _snwprintf(out->err, 256, L"WinHttpConnect failed (%lu)", GetLastError()); WinHttpCloseHandle(s); return 0; }

    HINTERNET r = WinHttpOpenRequest(c, L"GET", path, NULL,
        WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, https ? WINHTTP_FLAG_SECURE : 0);
    if (!r) { _snwprintf(out->err, 256, L"WinHttpOpenRequest failed (%lu)", GetLastError()); WinHttpCloseHandle(c); WinHttpCloseHandle(s); return 0; }

    /* default headers, then the caller's. Accept and User-Agent match
     * searchService's getJson so a provider sees the same request. */
    WinHttpAddRequestHeaders(r, L"Accept: application/json\r\n", (DWORD)-1, WINHTTP_ADDREQ_FLAG_ADD);
    for (int i = 0; i < nheaders; i++) {
        wchar_t line[2100];
        /* _snwprintf does not NUL-terminate on truncation, and this is handed to
         * WinHttpAddRequestHeaders with length -1, which would then read past the
         * buffer. Force the terminator. */
        _snwprintf(line, 2100, L"%ls\r\n", headers[i]);
        line[2099] = 0;
        WinHttpAddRequestHeaders(r, line, (DWORD)-1, WINHTTP_ADDREQ_FLAG_ADD | WINHTTP_ADDREQ_FLAG_REPLACE);
    }

    int ok = 0;
    if (!WinHttpSendRequest(r, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0)) {
        _snwprintf(out->err, 256, L"request failed (%lu)", GetLastError());
        goto done;
    }
    if (!WinHttpReceiveResponse(r, NULL)) {
        _snwprintf(out->err, 256, L"no response (%lu)", GetLastError());
        goto done;
    }

    DWORD code = 0, csz = sizeof code;
    WinHttpQueryHeaders(r, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
        WINHTTP_HEADER_NAME_BY_INDEX, &code, &csz, WINHTTP_NO_HEADER_INDEX);
    out->status = (long)code;

    /* drain the body, capped */
    size_t cap = 65536, len = 0;
    char *buf = (char *)malloc(cap);
    if (!buf) { _snwprintf(out->err, 256, L"out of memory"); goto done; }
    for (;;) {
        DWORD avail = 0;
        if (!WinHttpQueryDataAvailable(r, &avail)) { _snwprintf(out->err, 256, L"read failed (%lu)", GetLastError()); free(buf); goto done; }
        if (avail == 0) break;
        if (len + avail + 1 > cap) {
            while (len + avail + 1 > cap) cap *= 2;
            if (cap > MAX_BYTES + 1) { _snwprintf(out->err, 256, L"response too large"); free(buf); goto done; }
            char *nb = (char *)realloc(buf, cap);
            if (!nb) { _snwprintf(out->err, 256, L"out of memory"); free(buf); goto done; }
            buf = nb;
        }
        DWORD got = 0;
        if (!WinHttpReadData(r, buf + len, avail, &got)) { _snwprintf(out->err, 256, L"read failed (%lu)", GetLastError()); free(buf); goto done; }
        if (got == 0) break;
        len += got;
        if (len > MAX_BYTES) { _snwprintf(out->err, 256, L"response too large"); free(buf); goto done; }
    }
    buf[len] = 0;
    out->body = buf;
    out->len = len;
    ok = 1;

done:
    WinHttpCloseHandle(r);
    WinHttpCloseHandle(c);
    WinHttpCloseHandle(s);
    return ok;
}

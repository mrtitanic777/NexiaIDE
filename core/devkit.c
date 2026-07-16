/*
 * devkit.c — talk to an Xbox 360 devkit over XBDM.
 *
 * A port of the socket half of src/main/devkit.ts. XBDM is the debug monitor a
 * devkit runs on port 730: a CRLF line protocol with FTP-shaped status codes —
 * 201 in the banner it sends on connect, 200 for a one-line answer, 202 for one
 * that runs until a lone "." on its own line.
 *
 * WHAT IS NOT HERE, AND WHY.
 * The TypeScript is half native: connect/drivelist/systeminfo/dirlist are raw
 * sockets, while deploy, launch, reboot, screenshot, delete and mkdir shell out
 * to the SDK's xbcp.exe, xbrun.exe, xbreboot.exe, xbcapture.exe, xbdel.exe and
 * xbmkdir.exe. Those stay in the SDK's hands. Their file-copy semantics are
 * Microsoft's, unversioned, and only observable against a real console — a
 * reimplementation would be a guess that corrupts a XEX on someone else's
 * hardware, which is not a thing to find out from a bug report.
 *
 * WHY THE PARSING IS NOT TIDIED.
 * Below is a transcription, quirks included: the doubled dbgname, the 1.5s wait
 * for a name that may never come, the drive list that invents three volumes when
 * the console names none. This decides what the IDE shows for hardware we cannot
 * put on the desk. "Obviously equivalent" is not a claim anyone here can check.
 */
#include "devkit.h"
#include <wctype.h>

/* ── time ─────────────────────────────────────────────────────────────────── */

/* Monotonic: the deadlines below must not move when the wall clock does. */
static long long now_ms(void) { return (long long)GetTickCount64(); }

/* ── JavaScript's idea of whitespace ──────────────────────────────────────── */

/*
 * The TypeScript trims with String.prototype.trim() and matches with \s, which
 * are the same set: Unicode space separators plus the line terminators plus the
 * BOM. wcschr(L" \t\r\n", c) would be close enough right up until a console
 * returned a name with a non-breaking space in it and the two ports disagreed.
 */
static int js_space(wchar_t c)
{
    return c == 0x20 || c == 0x09 || c == 0x0a || c == 0x0b || c == 0x0c || c == 0x0d ||
           c == 0xa0 || c == 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
           c == 0x2028 || c == 0x2029 || c == 0x202f || c == 0x205f || c == 0x3000 ||
           c == 0xfeff;
}

/* What "." in a JS regex refuses to match. A subset of js_space. */
static int js_terminator(wchar_t c)
{
    return c == 0x0a || c == 0x0d || c == 0x2028 || c == 0x2029;
}

static void js_trim(const wchar_t *s, size_t len, wchar_t *out, size_t cap)
{
    size_t a = 0, b = len;
    while (a < b && js_space(s[a])) a++;
    while (b > a && js_space(s[b - 1])) b--;
    size_t n = b - a;
    if (n > cap - 1) n = cap - 1;
    wmemcpy(out, s + a, n);
    out[n] = 0;
}

/* ── the conversation ─────────────────────────────────────────────────────── */

/*
 * Bytes in, bytes kept. The TypeScript accumulates responseData as a string and
 * re-scans the whole thing on every chunk, so the searches here are over
 * everything received so far, not over the latest chunk — a "201" split across
 * two packets still has to count.
 */
typedef struct {
    SOCKET     s;
    char      *data;
    size_t     len, cap;
    long long  idle_deadline;   /* node's socket.setTimeout is idle, not total */
    int        timeout_ms;
    int        err;             /* WSA code of whatever went wrong, 0 if nothing */
    wchar_t    msg[512];        /* that error, worded as node words it */
    wchar_t    addr[64];        /* the address we actually connected to */
} xbdm;

typedef enum { XB_OK, XB_DEADLINE, XB_EOF, XB_ERROR } xb_res;

static int buf_append(xbdm *x, const char *p, size_t n)
{
    if (x->len + n + 1 > x->cap) {
        size_t want = x->cap ? x->cap : 4096;
        while (want < x->len + n + 1) want *= 2;
        char *grown = (char *)realloc(x->data, want);
        if (!grown) return 0;
        x->data = grown;
        x->cap = want;
    }
    memcpy(x->data + x->len, p, n);
    x->len += n;
    x->data[x->len] = 0;
    return 1;
}

/* String.prototype.includes over the raw bytes. The needles are all ASCII and
 * UTF-8 never encodes an ASCII byte inside a longer sequence, so searching
 * before decoding cannot produce a false hit. */
static int buf_has(const xbdm *x, const char *needle)
{
    size_t nl = strlen(needle);
    if (x->len < nl) return 0;
    for (size_t i = 0; i + nl <= x->len; i++)
        if (!memcmp(x->data + i, needle, nl)) return 1;
    return 0;
}

/* The response as text, the way data.toString() gives it to the TypeScript:
 * UTF-8, with invalid sequences becoming U+FFFD rather than an error. */
static wchar_t *buf_text(const xbdm *x)
{
    if (!x->len) {
        wchar_t *e = (wchar_t *)malloc(sizeof(wchar_t));
        if (e) e[0] = 0;
        return e;
    }
    int n = MultiByteToWideChar(CP_UTF8, 0, x->data, (int)x->len, NULL, 0);
    if (n <= 0) return NULL;
    wchar_t *w = (wchar_t *)malloc(((size_t)n + 1) * sizeof(wchar_t));
    if (!w) return NULL;
    MultiByteToWideChar(CP_UTF8, 0, x->data, (int)x->len, w, n);
    w[n] = 0;
    return w;
}

/* ── errors, in node's words ──────────────────────────────────────────────── */

/*
 * The IDE surfaces these strings to the user, and the TypeScript surfaces
 * node's. Rewording them here would be a UI change smuggled in as a port, so
 * this reproduces libuv's error names and node's message shapes exactly:
 * "connect ECONNREFUSED 192.168.1.10:730", "getaddrinfo ENOTFOUND xenon".
 */
static const wchar_t *uv_name(int e)
{
    switch (e) {
    case WSAECONNREFUSED:  return L"ECONNREFUSED";
    case WSAETIMEDOUT:     return L"ETIMEDOUT";
    case WSAEHOSTUNREACH:  return L"EHOSTUNREACH";
    case WSAENETUNREACH:   return L"ENETUNREACH";
    case WSAENETDOWN:      return L"ENETDOWN";
    case WSAENETRESET:     return L"ENETRESET";
    case WSAECONNRESET:    return L"ECONNRESET";
    case WSAECONNABORTED:  return L"ECONNABORTED";
    case WSAEADDRNOTAVAIL: return L"EADDRNOTAVAIL";
    case WSAEADDRINUSE:    return L"EADDRINUSE";
    case WSAEACCES:        return L"EACCES";
    case WSAENOBUFS:       return L"ENOBUFS";
    case WSAEHOSTDOWN:     return L"EHOSTDOWN";
    case WSAEAFNOSUPPORT:  return L"EAFNOSUPPORT";
    case WSAEINVAL:        return L"EINVAL";
    default:               return L"UNKNOWN";
    }
}

static void fail_connect(xbdm *x, int e)
{
    x->err = e;
    _snwprintf(x->msg, 511, L"connect %ls %ls:%d", uv_name(e), x->addr, NX_XBDM_PORT);
    x->msg[511] = 0;
}

static void fail_read(xbdm *x, int e)
{
    x->err = e;
    _snwprintf(x->msg, 511, L"read %ls", uv_name(e));
    x->msg[511] = 0;
}

static void fail_write(xbdm *x, int e)
{
    x->err = e;
    _snwprintf(x->msg, 511, L"write %ls", uv_name(e));
    x->msg[511] = 0;
}

/* ── the socket ───────────────────────────────────────────────────────────── */

static void xbdm_close(xbdm *x)
{
    if (x->s != INVALID_SOCKET) { closesocket(x->s); x->s = INVALID_SOCKET; }
    free(x->data);
    x->data = NULL;
    x->len = x->cap = 0;
}

/*
 * Connect, with the 5s ceiling the TypeScript puts on it.
 *
 * socket.setTimeout is called before socket.connect there, so the clock covers
 * the connect too — Windows would otherwise spend ~21s on its own SYN retries
 * before admitting a console is off. Node restarts the timer once the
 * connection is up (afterConnect calls _unrefTimer), and so does this: the 5s is
 * idle time, not a budget for the whole exchange.
 */
static xb_res xbdm_open(xbdm *x, const wchar_t *ip, int timeout_ms)
{
    long long deadline = now_ms() + timeout_ms;

    memset(x, 0, sizeof *x);
    x->s = INVALID_SOCKET;
    x->timeout_ms = timeout_ms;

    wchar_t port[8];
    _snwprintf(port, 7, L"%d", NX_XBDM_PORT);
    port[7] = 0;

    ADDRINFOW hints, *res = NULL;
    memset(&hints, 0, sizeof hints);
    hints.ai_family = AF_UNSPEC;      /* as node's lookup does: family 0, first answer wins */
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_protocol = IPPROTO_TCP;

    if (GetAddrInfoW(ip, port, &hints, &res) != 0 || !res) {
        /* Node reports every lookup failure this way, whether the name did not
         * resolve or was never a name — "999.999.999.999" lands here too. */
        x->err = -1;
        _snwprintf(x->msg, 511, L"getaddrinfo ENOTFOUND %ls", ip);
        x->msg[511] = 0;
        return XB_ERROR;
    }

    /* The numeric address, because node's connect messages quote the address it
     * reached rather than the name it was given. */
    if (GetNameInfoW(res->ai_addr, (socklen_t)res->ai_addrlen, x->addr, 64, NULL, 0, NI_NUMERICHOST) != 0)
        nx_copy(x->addr, 64, ip);

    x->s = socket(res->ai_family, res->ai_socktype, res->ai_protocol);
    if (x->s == INVALID_SOCKET) {
        fail_connect(x, WSAGetLastError());
        FreeAddrInfoW(res);
        return XB_ERROR;
    }

    u_long nb = 1;
    ioctlsocket(x->s, FIONBIO, &nb);

    xb_res out = XB_OK;
    if (connect(x->s, res->ai_addr, (int)res->ai_addrlen) == SOCKET_ERROR) {
        int e = WSAGetLastError();
        if (e != WSAEWOULDBLOCK) { fail_connect(x, e); out = XB_ERROR; }
        else {
            for (;;) {
                long long ms = deadline - now_ms();
                if (ms <= 0) { out = XB_DEADLINE; break; }
                fd_set w, x_set;
                FD_ZERO(&w); FD_SET(x->s, &w);
                FD_ZERO(&x_set); FD_SET(x->s, &x_set);
                struct timeval tv;
                tv.tv_sec  = (long)(ms / 1000);
                tv.tv_usec = (long)((ms % 1000) * 1000);
                int n = select(0, NULL, &w, &x_set, &tv);
                if (n == 0) { out = XB_DEADLINE; break; }
                if (n == SOCKET_ERROR) { fail_connect(x, WSAGetLastError()); out = XB_ERROR; break; }
                /* Windows signals a refused connection through exceptfds and
                 * parks the reason in SO_ERROR; a success only sets writefds. */
                int so = 0, solen = (int)sizeof so;
                if (getsockopt(x->s, SOL_SOCKET, SO_ERROR, (char *)&so, &solen) == SOCKET_ERROR)
                    so = WSAGetLastError();
                if (so != 0) { fail_connect(x, so); out = XB_ERROR; }
                break;
            }
        }
    }

    FreeAddrInfoW(res);
    if (out != XB_OK) { closesocket(x->s); x->s = INVALID_SOCKET; return out; }

    x->idle_deadline = now_ms() + timeout_ms;
    return XB_OK;
}

/*
 * Wait for the next chunk, no later than `deadline`.
 *
 * The caller passes the earliest of every clock it cares about and works out
 * which one fired, because there is more than one: the socket's idle timeout and,
 * in connect, a plain setTimeout that is not tied to the socket at all.
 */
static xb_res xbdm_wait(xbdm *x, long long deadline)
{
    for (;;) {
        long long ms = deadline - now_ms();
        if (ms <= 0) return XB_DEADLINE;

        fd_set r;
        FD_ZERO(&r); FD_SET(x->s, &r);
        struct timeval tv;
        tv.tv_sec  = (long)(ms / 1000);
        tv.tv_usec = (long)((ms % 1000) * 1000);

        int n = select(0, &r, NULL, NULL, &tv);
        if (n == 0) return XB_DEADLINE;
        if (n == SOCKET_ERROR) { fail_read(x, WSAGetLastError()); return XB_ERROR; }

        char chunk[4096];
        int got = recv(x->s, chunk, sizeof chunk, 0);
        if (got == 0) return XB_EOF;
        if (got == SOCKET_ERROR) {
            int e = WSAGetLastError();
            if (e == WSAEWOULDBLOCK) continue;
            fail_read(x, e);
            return XB_ERROR;
        }
        if (!buf_append(x, chunk, (size_t)got)) { x->err = -1; nx_copy(x->msg, 512, L"out of memory"); return XB_ERROR; }
        x->idle_deadline = now_ms() + x->timeout_ms;
        return XB_OK;
    }
}

/* Commands go out as UTF-8, which is what node's socket.write does with a
 * string it was not given an encoding for. */
static int xbdm_send(xbdm *x, const wchar_t *cmd)
{
    int n = WideCharToMultiByte(CP_UTF8, 0, cmd, -1, NULL, 0, NULL, NULL);
    if (n <= 1) { x->err = -1; nx_copy(x->msg, 512, L"could not encode command"); return 0; }
    char *buf = (char *)malloc((size_t)n);
    if (!buf) { x->err = -1; nx_copy(x->msg, 512, L"out of memory"); return 0; }
    WideCharToMultiByte(CP_UTF8, 0, cmd, -1, buf, n, NULL, NULL);

    int len = n - 1, sent = 0, ok = 1;
    while (sent < len) {
        int w = send(x->s, buf + sent, len - sent, 0);
        if (w == SOCKET_ERROR) {
            int e = WSAGetLastError();
            if (e == WSAEWOULDBLOCK) continue;   /* commands are bytes, not files */
            fail_write(x, e);
            ok = 0;
            break;
        }
        sent += w;
    }
    free(buf);
    x->idle_deadline = now_ms() + x->timeout_ms;   /* node refreshes on write too */
    return ok;
}

/* ── output ───────────────────────────────────────────────────────────────── */

/* nx_json_error's shape, for a message we only have as wide characters. */
static void json_error_w(const wchar_t *msg)
{
    printf("{\"ok\":false,");
    nx_json_field(stdout, "error", msg);
    printf("}\n");
}

/* ── lines ────────────────────────────────────────────────────────────────── */

/*
 * split('\r\n'). A lone \n does not divide anything, here or in the TypeScript,
 * which matters: dirlist puts \r\n between entries and nothing else does.
 *
 * Each segment is copied into `line`, which the caller sizes at the whole text's
 * length so no name can ever be truncated into a different name.
 */
#define FOR_EACH_LINE(text, line)                                            \
    for (const wchar_t *_p = (text), *_e = NULL;                             \
         _p && (_e = wcsstr(_p, L"\r\n"),                                    \
                wmemcpy(line, _p, _e ? (size_t)(_e - _p) : wcslen(_p)),      \
                line[_e ? (size_t)(_e - _p) : wcslen(_p)] = 0, 1);           \
         _p = _e ? _e + 2 : NULL)

/* ── connect ──────────────────────────────────────────────────────────────── */

/* The first line that starts with "200-", minus the code, trimmed. */
static int line_200(const wchar_t *text, wchar_t *line, wchar_t *out, size_t cap)
{
    FOR_EACH_LINE(text, line) {
        if (!wcsncmp(line, L"200-", 4)) {
            js_trim(line + 4, wcslen(line + 4), out, cap);
            return 1;
        }
    }
    return 0;
}

/*
 * /200-\s*(.+)/ — the fallback when no line began with 200-.
 *
 * Transcribed rather than approximated, because \s* crosses line breaks and "."
 * does not: against "200-\r\nXenon" this regex captures "Xenon" off the *next*
 * line, and against "200- " it backtracks onto the space and captures a string
 * that trims away to nothing. Both are reachable from a console that answers
 * dbgname strangely, and both are what the IDE does today.
 */
static int match_200(const wchar_t *text, wchar_t *out, size_t cap)
{
    for (const wchar_t *at = wcsstr(text, L"200-"); at; at = wcsstr(at + 1, L"200-")) {
        const wchar_t *p = at + 4;
        const wchar_t *ws = p;
        while (js_space(*ws)) ws++;
        /* \s* is greedy, so the longest run that still leaves (.+) a character
         * wins; give it back one at a time until one does. */
        for (const wchar_t *k = ws; k >= p; k--) {
            if (!*k || js_terminator(*k)) continue;
            const wchar_t *end = k;
            while (*end && !js_terminator(*end)) end++;
            js_trim(k, (size_t)(end - k), out, cap);
            return 1;
        }
    }
    return 0;
}

static int cmd_connect(const wchar_t *ip)
{
    xbdm x;
    xb_res r = xbdm_open(&x, ip, NX_XBDM_TIMEOUT);

    wchar_t type[512];
    int connected = 0;

    if (r == XB_DEADLINE) {
        _snwprintf(type, 511, L"Timeout - no response from %ls:%d", ip, NX_XBDM_PORT);
        type[511] = 0;
        goto done;
    }
    if (r == XB_ERROR) {
        /* The four the TypeScript rewrites by errno; everything else keeps
         * node's own message. These are what the user reads when a console will
         * not answer, and they name the cable before they name the API. */
        switch (x.err) {
        case WSAECONNREFUSED: _snwprintf(type, 511, L"Connection refused - XBDM not running on %ls", ip); break;
        case WSAEHOSTUNREACH: nx_copy(type, 512, L"Host unreachable - check network cable and IP"); break;
        case WSAENETUNREACH:  nx_copy(type, 512, L"Network unreachable - check ethernet connection"); break;
        case WSAETIMEDOUT:    nx_copy(type, 512, L"Timed out - console may be off or wrong IP"); break;
        default:              nx_copy(type, 512, x.msg); break;
        }
        type[511] = 0;
        goto done;
    }

    {
        long long name_deadline = 0;
        int name_armed = 0;

        for (;;) {
            long long deadline = x.idle_deadline;
            if (name_armed && name_deadline < deadline) deadline = name_deadline;

            xb_res w = xbdm_wait(&x, deadline);

            if (w == XB_EOF) {
                /* The 1.5s wait is a bare setTimeout, not the socket's, so it
                 * still fires after the console hangs up — sit out the rest of
                 * it exactly as the TypeScript does.
                 *
                 * With no 201 seen there is nothing to wait for, and the
                 * TypeScript simply never settles: node clears the socket's
                 * timer when the peer closes, so no 'timeout' event ever
                 * arrives and the promise hangs. A command line cannot hang, so
                 * this reports the timeout the socket would have reported. It is
                 * the one place this port knowingly parts company. */
                if (!name_armed) {
                    _snwprintf(type, 511, L"Timeout - no response from %ls:%d", ip, NX_XBDM_PORT);
                    type[511] = 0;
                    goto done;
                }
                long long left = name_deadline - now_ms();
                if (left > 0) Sleep((DWORD)left);
                w = XB_DEADLINE;
            }

            if (w == XB_ERROR) { nx_copy(type, 512, x.msg); goto done; }

            if (w == XB_DEADLINE) {
                if (!name_armed || now_ms() >= x.idle_deadline) {
                    _snwprintf(type, 511, L"Timeout - no response from %ls:%d", ip, NX_XBDM_PORT);
                    type[511] = 0;
                    goto done;
                }
                wchar_t *text = buf_text(&x);
                if (!text) { nx_copy(type, 512, L"out of memory"); goto done; }
                connected = 1;
                if (!match_200(text, type, 512)) nx_copy(type, 512, L"Xbox 360 Development Kit");
                free(text);
                goto done;
            }

            /* XB_OK. The banner is "201- connected"; either half of it counts,
             * and the check runs against everything received so far. */
            if (!buf_has(&x, "201") && !buf_has(&x, "connected")) continue;

            /* Once per chunk, not once per connection: a console that answers in
             * two packets is asked its name twice. Harmless, and removing it
             * would be a change to what goes over the wire. */
            if (!xbdm_send(&x, L"dbgname\r\n")) { nx_copy(type, 512, x.msg); goto done; }

            wchar_t *text = buf_text(&x);
            if (!text) { nx_copy(type, 512, L"out of memory"); goto done; }
            wchar_t *line = (wchar_t *)malloc((wcslen(text) + 1) * sizeof(wchar_t));
            if (!line) { free(text); nx_copy(type, 512, L"out of memory"); goto done; }

            wchar_t name[512];
            int found = line_200(text, line, name, 512);
            free(line);
            free(text);

            if (found) {
                connected = 1;
                nx_copy(type, 512, *name ? name : L"Xbox 360 Development Kit");
                goto done;
            }

            /* Arm once. The TypeScript arms a fresh 1.5s timer per chunk, but
             * they are all guarded by the same `resolved` flag, so only the
             * first one can ever win. */
            if (!name_armed) { name_armed = 1; name_deadline = now_ms() + 1500; }
        }
    }

done:
    xbdm_close(&x);
    printf("{\"ok\":true,\"connected\":%s,", connected ? "true" : "false");
    nx_json_field(stdout, "type", type);
    printf("}\n");
    return 0;
}

/* ── a 202 multiline command ──────────────────────────────────────────────── */

/*
 * drivelist, systeminfo and dirlist share a shape: wait for the banner, send one
 * command, read until "\r\n.\r\n" closes the answer.
 *
 * The timeout is not a failure in two of the three — whatever arrived gets
 * parsed anyway — so this hands the caller the buffer and a flag rather than
 * deciding. `sent` matters: a clock that runs out before the banner means the
 * console never spoke at all, and that one really is an error.
 */
static xb_res run_multiline(xbdm *x, const wchar_t *ip, const wchar_t *cmd, int timeout_ms, int *sent)
{
    *sent = 0;
    xb_res r = xbdm_open(x, ip, timeout_ms);
    if (r != XB_OK) return r;

    for (;;) {
        xb_res w = xbdm_wait(x, x->idle_deadline);

        /* The peer hanging up leaves the TypeScript waiting on a timer node has
         * already cancelled — it never settles. Treat it as the timeout that
         * should have fired; the parse below is what the user would have got. */
        if (w == XB_EOF) return XB_DEADLINE;
        if (w != XB_OK) return w;

        if (!*sent && buf_has(x, "201")) {
            *sent = 1;
            if (!xbdm_send(x, cmd)) return XB_ERROR;
        }
        /* Checked in the same pass that sent the command, as there: a whole
         * answer can already be sitting in the buffer. */
        if (*sent && buf_has(x, "\r\n.\r\n")) return XB_OK;
    }
}

/* ── volumes ──────────────────────────────────────────────────────────────── */

static int cmd_volumes(const wchar_t *ip)
{
    xbdm x;
    int sent = 0;
    xb_res r = run_multiline(&x, ip, L"drivelist\r\n", NX_XBDM_TIMEOUT, &sent);

    if (r == XB_ERROR) { json_error_w(x.msg); xbdm_close(&x); return 1; }
    if (r == XB_DEADLINE && !sent) { xbdm_close(&x); json_error_w(L"Timeout"); return 1; }

    wchar_t *text = buf_text(&x);
    if (!text) { xbdm_close(&x); json_error_w(L"out of memory"); return 1; }
    wchar_t *line = (wchar_t *)malloc((wcslen(text) + 1) * sizeof(wchar_t));
    if (!line) { free(text); xbdm_close(&x); json_error_w(L"out of memory"); return 1; }

    printf("{\"ok\":true,\"volumes\":[");
    int n = 0;
    FOR_EACH_LINE(text, line) {
        /* /drivename="([^"]+)"/i — the i is not decoration: XBDM builds differ
         * on the case of the key. */
        const wchar_t *at = NULL;
        for (const wchar_t *q = line; *q; q++)
            if (!_wcsnicmp(q, L"drivename=\"", 11)) { at = q + 11; break; }
        if (!at) continue;
        const wchar_t *end = wcschr(at, L'"');
        if (!end || end == at) continue;   /* [^"]+ needs at least one */
        if (n++) printf(",");
        wchar_t name[NX_PATH];
        size_t len = (size_t)(end - at);
        if (len > NX_PATH - 2) len = NX_PATH - 2;
        wmemcpy(name, at, len);
        name[len] = L':';
        name[len + 1] = 0;
        nx_json_str(stdout, name);
    }
    /* A console that lists no drives is assumed to have the three every console
     * has. A guess, and one the IDE already shows. */
    if (!n) printf("\"HDD:\",\"GAME:\",\"DVD:\"");
    printf("]}\n");

    free(line);
    free(text);
    xbdm_close(&x);
    return 0;
}

/* ── sysinfo ──────────────────────────────────────────────────────────────── */

static int cmd_sysinfo(const wchar_t *ip)
{
    xbdm x;
    int sent = 0;
    xb_res r = run_multiline(&x, ip, L"systeminfo\r\n", NX_XBDM_TIMEOUT, &sent);

    if (r == XB_ERROR) { json_error_w(x.msg); xbdm_close(&x); return 1; }
    if (r == XB_DEADLINE && !sent) { xbdm_close(&x); json_error_w(L"Timeout"); return 1; }

    wchar_t *text = buf_text(&x);
    if (!text) { xbdm_close(&x); json_error_w(L"out of memory"); return 1; }
    size_t tl = wcslen(text);
    wchar_t *line = (wchar_t *)malloc((tl + 1) * sizeof(wchar_t));
    /* An object, so a repeated key overwrites in place and keeps its original
     * position. Two arrays are enough at systeminfo's size. */
    wchar_t **keys = (wchar_t **)calloc(tl + 1, sizeof(wchar_t *));
    wchar_t **vals = (wchar_t **)calloc(tl + 1, sizeof(wchar_t *));
    if (!line || !keys || !vals) {
        free(line); free(keys); free(vals); free(text); xbdm_close(&x);
        json_error_w(L"out of memory");
        return 1;
    }

    size_t n = 0;
    FOR_EACH_LINE(text, line) {
        if (!wcschr(line, L'=')) continue;

        /* The 202| prefix XBDM puts on continuation lines. Stripped before the
         * split, so a key never arrives wearing it. */
        wchar_t *l = line;
        if (!wcsncmp(l, L"202| ", 5)) l += 5;

        wchar_t *eq = wcschr(l, L'=');
        if (!eq || eq == l) continue;   /* `if (key && ...)`: an empty key is falsy */

        wchar_t *k = (wchar_t *)malloc(((size_t)(eq - l) + 1) * sizeof(wchar_t));
        wchar_t *v = (wchar_t *)malloc((wcslen(eq + 1) + 1) * sizeof(wchar_t));
        if (!k || !v) { free(k); free(v); continue; }
        js_trim(l, (size_t)(eq - l), k, (size_t)(eq - l) + 1);
        /* val.join('=') — only the first = splits, the rest belong to the value. */
        js_trim(eq + 1, wcslen(eq + 1), v, wcslen(eq + 1) + 1);

        size_t i = 0;
        while (i < n && wcscmp(keys[i], k)) i++;
        if (i < n) { free(keys[i]); free(vals[i]); keys[i] = k; vals[i] = v; }
        else { keys[n] = k; vals[n] = v; n++; }
    }

    printf("{\"ok\":true,\"info\":{");
    for (size_t i = 0; i < n; i++) {
        if (i) printf(",");
        nx_json_str(stdout, keys[i]);
        printf(":");
        nx_json_str(stdout, vals[i]);
        free(keys[i]);
        free(vals[i]);
    }
    printf("}}\n");

    free(keys); free(vals); free(line); free(text);
    xbdm_close(&x);
    return 0;
}

/* ── ls ───────────────────────────────────────────────────────────────────── */

/*
 * Number.prototype.toLocaleString() on an integer.
 *
 * The TypeScript formats sizes for whoever is reading them, so this asks Windows
 * for the same locale's separator and grouping rather than hard-coding a comma
 * every three digits — which is wrong in most of Europe and wrong differently in
 * India, where the groups are 3 then 2.
 *
 * LOCALE_NOUSEROVERRIDE on purpose: node formats from CLDR's data for the
 * locale, which does not know about a separator someone typed into Control
 * Panel. Without the flag the two ports would disagree on exactly the machines
 * whose owners had customised it.
 */
static void to_locale_string(double v, wchar_t *out, size_t cap)
{
    char digits[64];
    /* %.0f prints the double exactly; JS would print the shortest string that
     * round-trips. They differ only past 2^53, which is 9 petabytes of XEX. */
    snprintf(digits, sizeof digits, "%.0f", v);

    wchar_t sep[8];
    if (!GetLocaleInfoEx(LOCALE_NAME_USER_DEFAULT, LOCALE_STHOUSAND | LOCALE_NOUSEROVERRIDE, sep, 8))
        nx_copy(sep, 8, L",");
    wchar_t grp[16];
    if (!GetLocaleInfoEx(LOCALE_NAME_USER_DEFAULT, LOCALE_SGROUPING | LOCALE_NOUSEROVERRIDE, grp, 16))
        nx_copy(grp, 16, L"3;0");

    /* "3;0" is groups of three forever; "3;2;0" is three then twos; the trailing
     * 0 means "keep using the last size". */
    int sizes[8], ns = 0;
    for (const wchar_t *q = grp; *q && ns < 8; ) {
        if (*q >= L'0' && *q <= L'9') {
            int val = 0;
            while (*q >= L'0' && *q <= L'9') val = val * 10 + (*q++ - L'0');
            sizes[ns++] = val;
        } else q++;
    }
    if (!ns) { sizes[0] = 3; ns = 1; }

    wchar_t tmp[128];
    size_t ti = 127;
    tmp[ti] = 0;

    size_t nd = strlen(digits);
    size_t sl = wcslen(sep);
    int gi = 0, count = 0;
    for (size_t i = nd; i-- > 0; ) {
        if (sizes[gi] > 0 && count == sizes[gi]) {
            for (size_t k = sl; k-- > 0 && ti; ) tmp[--ti] = sep[k];
            count = 0;
            if (gi + 1 < ns && sizes[gi + 1] != 0) gi++;
        }
        if (ti) tmp[--ti] = (wchar_t)digits[i];
        count++;
    }
    nx_copy(out, cap, tmp + ti);
}

/* A hex run after `key`, as parseInt(m[1], 16) would read it. */
static int hex_after(const wchar_t *line, const wchar_t *key, unsigned long long *out)
{
    const wchar_t *at = wcsstr(line, key);
    if (!at) return 0;
    const wchar_t *p = at + wcslen(key);
    if (!iswxdigit(*p)) return 0;   /* [0-9a-fA-F]+ needs at least one */
    unsigned long long v = 0;
    for (; iswxdigit(*p); p++) {
        int d = (*p <= L'9') ? *p - L'0' : (towlower(*p) - L'a' + 10);
        v = v * 16 + (unsigned)d;
    }
    *out = v;
    return 1;
}

static int cmd_ls(const wchar_t *ip, const wchar_t *remote)
{
    /* XBDM_TIMEOUT + 5000 in the TypeScript: "Extra time for large dirs". */
    const int timeout_ms = NX_XBDM_TIMEOUT + 5000;

    wchar_t clean[NX_PATH];
    nx_copy(clean, NX_PATH, remote);
    for (wchar_t *p = clean; *p; p++) if (*p == L'/') *p = L'\\';

    wchar_t cmd[NX_PATH + 32];
    _snwprintf(cmd, NX_PATH + 31, L"dirlist name=\"%ls\"\r\n", clean);
    cmd[NX_PATH + 31] = 0;

    xbdm x;
    int sent = 0;
    xb_res r = run_multiline(&x, ip, cmd, timeout_ms, &sent);

    if (r == XB_ERROR) { json_error_w(x.msg); xbdm_close(&x); return 1; }
    if (r == XB_DEADLINE && (!sent || !x.len)) {
        xbdm_close(&x);
        json_error_w(L"Timeout listing directory");
        return 1;
    }

    wchar_t *text = buf_text(&x);
    if (!text) { xbdm_close(&x); json_error_w(L"out of memory"); return 1; }

    /* On timeout the TypeScript resolves with the raw response instead of the
     * parsed listing — unformatted, end marker and all. Carried across as the
     * single element it is, so that joining the array still reproduces the
     * string the TypeScript returns. */
    if (r == XB_DEADLINE) {
        printf("{\"ok\":true,\"files\":[");
        nx_json_str(stdout, text);
        printf("]}\n");
        free(text);
        xbdm_close(&x);
        return 0;
    }

    wchar_t *line = (wchar_t *)malloc((wcslen(text) + 1) * sizeof(wchar_t));
    if (!line) { free(text); xbdm_close(&x); json_error_w(L"out of memory"); return 1; }

    printf("{\"ok\":true,\"files\":[");
    int n = 0;
    FOR_EACH_LINE(text, line) {
        const wchar_t *at = wcsstr(line, L"name=\"");
        if (!at) continue;
        at += 6;
        const wchar_t *end = wcschr(at, L'"');
        if (!end || end == at) continue;

        wchar_t name[NX_PATH];
        size_t nl = (size_t)(end - at);
        if (nl > NX_PATH - 1) nl = NX_PATH - 1;
        wmemcpy(name, at, nl);
        name[nl] = 0;

        unsigned long long hi = 0, lo = 0;
        int has_hi = hex_after(line, L"sizehi=0x", &hi);
        int has_lo = hex_after(line, L"sizelo=0x", &lo);
        if (!has_hi) hi = 0;
        if (!has_lo) lo = 0;

        /* A double, as JS computes it — exact for anything a console can hold. */
        double total = (double)hi * 4294967296.0 + (double)lo;

        /* "DIR" is checked case-sensitively and "directory" is not the same
         * test, so a name containing either counts as a directory. The trailing
         * clause is the real one: no sizelo field at all. */
        int has_dir = wcsstr(line, L"directory") != NULL || wcsstr(line, L"DIR") != NULL;
        int is_dir  = has_dir || (total == 0.0 && !has_lo);

        wchar_t row[NX_PATH + 64];
        if (is_dir) {
            _snwprintf(row, NX_PATH + 63, L"<DIR>          %ls", name);
        } else {
            wchar_t size[64];
            to_locale_string(total, size, 64);
            _snwprintf(row, NX_PATH + 63, L"%ls  %ls", size, name);
        }
        row[NX_PATH + 63] = 0;

        if (n++) printf(",");
        nx_json_str(stdout, row);
    }
    printf("]}\n");

    free(line);
    free(text);
    xbdm_close(&x);
    return 0;
}

/* ── the command ──────────────────────────────────────────────────────────── */

int nx_cmd_devkit(int argc, wchar_t **argv)
{
    if (argc < 1) { nx_json_error("devkit: expected a subcommand"); return 2; }

    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) { nx_json_error("devkit: winsock unavailable"); return 1; }

    int rc;
    if (!wcscmp(argv[0], L"connect")) {
        if (argc < 2) { nx_json_error("devkit connect: expected an IP"); rc = 2; }
        else rc = cmd_connect(argv[1]);
    } else if (!wcscmp(argv[0], L"volumes")) {
        if (argc < 2) { nx_json_error("devkit volumes: expected an IP"); rc = 2; }
        else rc = cmd_volumes(argv[1]);
    } else if (!wcscmp(argv[0], L"sysinfo")) {
        if (argc < 2) { nx_json_error("devkit sysinfo: expected an IP"); rc = 2; }
        else rc = cmd_sysinfo(argv[1]);
    } else if (!wcscmp(argv[0], L"ls")) {
        if (argc < 3) { nx_json_error("devkit ls: expected an IP and a remote path"); rc = 2; }
        else rc = cmd_ls(argv[1], argv[2]);
    } else {
        nx_json_error("devkit: unknown subcommand");
        rc = 2;
    }

    WSACleanup();
    return rc;
}

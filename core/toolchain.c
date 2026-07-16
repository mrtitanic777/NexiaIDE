/*
 * toolchain.c — find the Xbox 360 SDK and the tools in it.
 *
 * A port of src/main/toolchain.ts. The candidate order below is not arbitrary
 * and is not tidied: it decides which SDK wins on a machine with more than one,
 * and the TypeScript's order is the one users' installs already resolve
 * against. Reordering it would silently change which compiler builds their code.
 *
 * The registry work this replaces spawned reg.exe twelve times and detected
 * failure by string-matching "Access is denied" out of an exception message.
 * Here it is RegCreateKeyEx and RegSetValueEx, with real error codes.
 */
#include "nexia.h"

/* A candidate root, and whether finding it there means it shipped with us. */
typedef struct { wchar_t path[NX_PATH]; int bundled; } cand;

static void push(cand *list, int *n, int cap, const wchar_t *p, int bundled)
{
    if (*n >= cap || !p || !*p) return;
    nx_copy(list[*n].path, NX_PATH, p);
    list[*n].bundled = bundled;
    (*n)++;
}

static void push_join(cand *list, int *n, int cap, const wchar_t *a, const wchar_t *b, int bundled)
{
    if (*n >= cap || !a || !*a) return;
    wchar_t tmp[NX_PATH];
    nx_join(tmp, NX_PATH, a, b);
    push(list, n, cap, tmp, bundled);
}

static void push_env(cand *list, int *n, int cap, const wchar_t *var, int bundled)
{
    wchar_t buf[NX_PATH];
    DWORD got = GetEnvironmentVariableW(var, buf, NX_PATH);
    if (got > 0 && got < NX_PATH) push(list, n, cap, buf, bundled);
}

/* The SDK the IDE ships with, if any. Mirrors getBundledSdkPath(). */
static int bundled_sdk(const nx_hints *h, wchar_t *out, size_t cap)
{
    wchar_t c[5][NX_PATH];
    int n = 0;
    if (h->resources && *h->resources) {
        nx_join(c[n++], NX_PATH, h->resources, L"sdk");
        wchar_t unpacked[NX_PATH];
        nx_join(unpacked, NX_PATH, h->resources, L"app.asar.unpacked");
        nx_join(c[n++], NX_PATH, unpacked, L"sdk");
        wchar_t app[NX_PATH];
        nx_join(app, NX_PATH, h->resources, L"app");
        nx_join(c[n++], NX_PATH, app, L"sdk");
    }
    if (h->exe_dir && *h->exe_dir) {
        nx_join(c[n++], NX_PATH, h->exe_dir, L"sdk");
    }

    for (int i = 0; i < n; i++) {
        /* Never a path inside an .asar: the OS cannot spawn an executable from
         * inside the archive, so a "found" SDK there is worse than none. */
        if (wcsstr(c[i], L".asar\\") && !wcsstr(c[i], L".asar.unpacked")) continue;
        wchar_t bin[NX_PATH], inc[NX_PATH];
        nx_join(bin, NX_PATH, c[i], L"bin");
        nx_join(inc, NX_PATH, c[i], L"include");
        if (nx_exists(bin) && nx_exists(inc)) { nx_copy(out, cap, c[i]); return 1; }
    }
    return 0;
}

/* Build the candidate list, in the order detect() checks them. */
static int candidates(const nx_hints *h, cand *list, int cap)
{
    int n = 0;

    /* An explicit path beats everything. */
    if (h->custom && *h->custom) push(list, &n, cap, h->custom, 0);

    /* Then whatever we shipped. */
    wchar_t b[NX_PATH];
    if (bundled_sdk(h, b, NX_PATH)) push(list, &n, cap, b, 1);

    /* Then beside the executable: the installer's cab extraction keeps
     * Microsoft's XDK\ prefix, so the SDK lands at <install>\SDK\XDK. */
    if (h->exe_dir && *h->exe_dir) {
        wchar_t sdk[NX_PATH], up[NX_PATH];
        nx_join(sdk, NX_PATH, h->exe_dir, L"SDK");
        push_join(list, &n, cap, sdk, L"XDK", 1);
        nx_join(sdk, NX_PATH, h->exe_dir, L"sdk");
        push_join(list, &n, cap, sdk, L"XDK", 1);
        push_join(list, &n, cap, h->exe_dir, L"SDK", 1);
        push_join(list, &n, cap, h->exe_dir, L"sdk", 1);
        nx_join(up, NX_PATH, h->exe_dir, L"..");
        nx_join(sdk, NX_PATH, up, L"SDK");
        push_join(list, &n, cap, sdk, L"XDK", 1);
        push_join(list, &n, cap, up, L"SDK", 1);
    }

    push(list, &n, cap, L"C:\\Program Files\\NexiaIDE\\SDK\\XDK", 1);
    push(list, &n, cap, L"C:\\Program Files\\NexiaIDE\\SDK", 1);
    push(list, &n, cap, L"C:\\Program Files (x86)\\NexiaIDE\\SDK\\XDK", 1);

    push_env(list, &n, cap, L"XEDK", 0);
    push_env(list, &n, cap, L"XEDK_DIR", 0);
    push_env(list, &n, cap, L"XBOX_SDK", 0);
    push_env(list, &n, cap, L"XDK", 0);

    push(list, &n, cap, L"C:\\Program Files (x86)\\Microsoft Xbox 360 SDK", 0);
    push(list, &n, cap, L"C:\\Program Files\\Microsoft Xbox 360 SDK", 0);
    push(list, &n, cap, L"D:\\Microsoft Xbox 360 SDK", 0);
    push(list, &n, cap, L"C:\\XEDK", 0);
    push(list, &n, cap, L"D:\\XEDK", 0);
    push(list, &n, cap, L"C:\\Program Files (x86)\\Microsoft Xbox SDK", 0);

    return n;
}

static void fill(nx_sdk *s, const wchar_t *root, int bundled)
{
    nx_copy(s->root, NX_PATH, root);
    nx_join(s->bin,       NX_PATH, root, L"bin");
    nx_join(s->bin_win32, NX_PATH, s->bin, L"win32");
    nx_join(s->bin_x64,   NX_PATH, s->bin, L"win64");
    nx_join(s->include,   NX_PATH, root, L"include");
    nx_join(s->lib,       NX_PATH, root, L"lib");
    nx_join(s->doc,       NX_PATH, root, L"doc");
    nx_join(s->source,    NX_PATH, root, L"Source");
    nx_join(s->system,    NX_PATH, root, L"system");
    s->bundled = bundled;
}

int nx_sdk_detect(const nx_hints *hints, nx_sdk *out)
{
    cand list[32];
    int n = candidates(hints, list, 32);

    for (int i = 0; i < n; i++) {
        if (!nx_exists(list[i].path)) continue;
        wchar_t bin[NX_PATH], inc[NX_PATH];
        nx_join(bin, NX_PATH, list[i].path, L"bin");
        nx_join(inc, NX_PATH, list[i].path, L"include");
        /* bin AND include: a bin-only tree is the installer's "minimum
         * installation", which cannot compile anything. nx_sdk_state_of names
         * that case for the caller. */
        if (nx_exists(bin) && nx_exists(inc)) {
            fill(out, list[i].path, list[i].bundled);
            return 1;
        }
    }
    return 0;
}

nx_sdk_state nx_sdk_state_of(const wchar_t *root)
{
    if (!nx_exists(root)) return NX_SDK_NONE;
    wchar_t bin[NX_PATH], inc[NX_PATH], lib[NX_PATH];
    nx_join(bin, NX_PATH, root, L"bin");
    nx_join(inc, NX_PATH, root, L"include");
    nx_join(lib, NX_PATH, root, L"lib");
    if (!nx_exists(bin)) return NX_SDK_NONE;
    return (nx_exists(inc) && nx_exists(lib)) ? NX_SDK_FULL : NX_SDK_PARTIAL;
}

nx_sdk_state nx_sdk_detect_state(const nx_hints *hints, wchar_t *found_root, size_t cap)
{
    cand list[32];
    int n = candidates(hints, list, 32);
    nx_sdk_state best = NX_SDK_NONE;

    for (int i = 0; i < n; i++) {
        nx_sdk_state st = nx_sdk_state_of(list[i].path);
        if (st > best) {
            best = st;
            if (found_root) nx_copy(found_root, cap, list[i].path);
            if (best == NX_SDK_FULL) break;   /* nothing beats full */
        }
    }
    return best;
}

int nx_bin_dirs(const nx_sdk *sdk, wchar_t dirs[3][NX_PATH])
{
    const wchar_t *c[3] = { sdk->bin_win32, sdk->bin_x64, sdk->bin };
    int n = 0;
    for (int i = 0; i < 3; i++)
        if (nx_exists(c[i])) nx_copy(dirs[n++], NX_PATH, c[i]);
    return n;
}

int nx_tool_path(const nx_sdk *sdk, const wchar_t *tool, wchar_t *out, size_t cap)
{
    const wchar_t *dirs[3] = { sdk->bin_win32, sdk->bin_x64, sdk->bin };
    for (int i = 0; i < 3; i++) {
        if (!nx_exists(dirs[i])) continue;
        wchar_t p[NX_PATH];
        nx_join(p, NX_PATH, dirs[i], tool);
        if (nx_exists(p)) { nx_copy(out, cap, p); return 1; }
        /* Callers ask for "cl.exe" and for "cl" alike. */
        wchar_t e[NX_PATH];
        _snwprintf(e, NX_PATH - 1, L"%ls.exe", p);
        e[NX_PATH - 1] = 0;
        if (nx_exists(e)) { nx_copy(out, cap, e); return 1; }
    }
    return 0;
}

/* Append "KEY=VALUE\0" to a growing environment block. */
static void env_add(wchar_t **blk, size_t *len, size_t *cap, const wchar_t *key, const wchar_t *val)
{
    size_t need = wcslen(key) + 1 + wcslen(val) + 1;
    if (*len + need + 1 > *cap) {
        size_t grow = (*cap ? *cap * 2 : 4096);
        while (grow < *len + need + 1) grow *= 2;
        wchar_t *n = (wchar_t *)realloc(*blk, grow * sizeof(wchar_t));
        if (!n) return;
        *blk = n; *cap = grow;
    }
    *len += (size_t)_snwprintf(*blk + *len, need, L"%ls=%ls", key, val) + 1;
}

/* Read a variable from our own environment, or "" if unset. */
static void env_get(const wchar_t *key, wchar_t *out, size_t cap)
{
    DWORD n = GetEnvironmentVariableW(key, out, (DWORD)cap);
    if (n == 0 || n >= cap) out[0] = 0;
}

/*
 * Build the environment an SDK tool needs.
 *
 * Mirrors getToolEnvironment() in toolchain.ts, including its two defensive
 * fallbacks: a packaged app can lose ComSpec and SystemRoot, and a child that
 * inherits an environment without them fails to start with an error that names
 * neither.
 */
wchar_t *nx_tool_env(const nx_sdk *sdk)
{
    wchar_t *blk = NULL;
    size_t len = 0, cap = 0;

    /* Inherit everything we have, minus the four we are about to override —
     * a stale INCLUDE or LIB from the parent would otherwise win by being
     * first, and cl.exe takes the first match. */
    wchar_t *ours = GetEnvironmentStringsW();
    if (ours) {
        for (wchar_t *p = ours; *p; p += wcslen(p) + 1) {
            if (!_wcsnicmp(p, L"PATH=", 5) || !_wcsnicmp(p, L"XEDK=", 5) ||
                !_wcsnicmp(p, L"INCLUDE=", 8) || !_wcsnicmp(p, L"LIB=", 4)) continue;
            size_t n = wcslen(p);
            if (len + n + 2 > cap) {
                size_t grow = (cap ? cap * 2 : 8192);
                while (grow < len + n + 2) grow *= 2;
                wchar_t *g = (wchar_t *)realloc(blk, grow * sizeof(wchar_t));
                if (!g) { FreeEnvironmentStringsW(ours); free(blk); return NULL; }
                blk = g; cap = grow;
            }
            wcscpy(blk + len, p);
            len += n + 1;
        }
        FreeEnvironmentStringsW(ours);
    }

    wchar_t old_path[8192], old_inc[8192], old_lib[8192], sysroot[NX_PATH], comspec[NX_PATH];
    env_get(L"PATH", old_path, 8192);
    env_get(L"INCLUDE", old_inc, 8192);
    env_get(L"LIB", old_lib, 8192);
    env_get(L"SystemRoot", sysroot, NX_PATH);
    env_get(L"ComSpec", comspec, NX_PATH);

    if (!*sysroot) {
        nx_copy(sysroot, NX_PATH, L"C:\\WINDOWS");
        env_add(&blk, &len, &cap, L"SystemRoot", sysroot);
    }
    if (!*comspec) {
        wchar_t sys32[NX_PATH], cs[NX_PATH];
        nx_join(sys32, NX_PATH, sysroot, L"system32");
        nx_join(cs, NX_PATH, sys32, L"cmd.exe");
        env_add(&blk, &len, &cap, L"ComSpec", cs);
    }

    /* PATH: the SDK's bin directories first. */
    wchar_t dirs[3][NX_PATH];
    int nd = nx_bin_dirs(sdk, dirs);
    wchar_t *path = (wchar_t *)malloc((8192 + 3 * NX_PATH) * sizeof(wchar_t));
    if (!path) { free(blk); return NULL; }
    path[0] = 0;
    for (int i = 0; i < nd; i++) { wcscat(path, dirs[i]); wcscat(path, L";"); }
    wcscat(path, old_path);
    env_add(&blk, &len, &cap, L"PATH", path);
    free(path);

    env_add(&blk, &len, &cap, L"XEDK", sdk->root);

    /* INCLUDE: include\xbox must precede include, or cl.exe finds the CRT's
     * internal headers under Source\crt first and the build fails in ways that
     * point nowhere near the cause. */
    wchar_t xbox_inc[NX_PATH];
    nx_join(xbox_inc, NX_PATH, sdk->include, L"xbox");
    wchar_t *inc = (wchar_t *)malloc((8192 + 2 * NX_PATH) * sizeof(wchar_t));
    if (!inc) { free(blk); return NULL; }
    inc[0] = 0;
    if (nx_exists(xbox_inc)) { wcscat(inc, xbox_inc); wcscat(inc, L";"); }
    wcscat(inc, sdk->include); wcscat(inc, L";"); wcscat(inc, old_inc);
    env_add(&blk, &len, &cap, L"INCLUDE", inc);
    free(inc);

    wchar_t xbox_lib[NX_PATH];
    nx_join(xbox_lib, NX_PATH, sdk->lib, L"xbox");
    wchar_t *lib = (wchar_t *)malloc((8192 + NX_PATH) * sizeof(wchar_t));
    if (!lib) { free(blk); return NULL; }
    _snwprintf(lib, 8192 + NX_PATH - 1, L"%ls;%ls", xbox_lib, old_lib);
    lib[8192 + NX_PATH - 1] = 0;
    env_add(&blk, &len, &cap, L"LIB", lib);
    free(lib);

    /* The block ends with a second NUL. */
    if (len + 1 > cap) {
        wchar_t *g = (wchar_t *)realloc(blk, (len + 1) * sizeof(wchar_t));
        if (!g) { free(blk); return NULL; }
        blk = g;
    }
    blk[len] = 0;
    return blk;
}

void nx_env_free(wchar_t *block) { free(block); }

/*
 * The SDK's tools are MSVC 2010 era and will not start without the 2010 CRT.
 * Missing DLLs produce a dialog from the loader, not an error we can catch, so
 * this is checked before the first build rather than diagnosed after it.
 */
int nx_missing_runtime(const nx_sdk *sdk, const wchar_t **missing, int cap)
{
    static const wchar_t *required[] = { L"msvcr100.dll", L"msvcp100.dll" };
    wchar_t dirs[3][NX_PATH];
    int nd = nx_bin_dirs(sdk, dirs);

    wchar_t sysroot[NX_PATH];
    if (!GetEnvironmentVariableW(L"SystemRoot", sysroot, NX_PATH)) nx_copy(sysroot, NX_PATH, L"C:\\WINDOWS");
    wchar_t wow[NX_PATH], sys32[NX_PATH];
    nx_join(wow, NX_PATH, sysroot, L"SysWOW64");
    nx_join(sys32, NX_PATH, sysroot, L"System32");

    int n = 0;
    for (int i = 0; i < 2 && n < cap; i++) {
        int found = 0;
        for (int d = 0; d < nd && !found; d++) {
            wchar_t p[NX_PATH];
            nx_join(p, NX_PATH, dirs[d], required[i]);
            if (nx_exists(p)) found = 1;
        }
        if (!found) {
            wchar_t p[NX_PATH];
            nx_join(p, NX_PATH, wow, required[i]);
            if (nx_exists(p)) found = 1;
            else { nx_join(p, NX_PATH, sys32, required[i]); if (nx_exists(p)) found = 1; }
        }
        if (!found) missing[n++] = required[i];
    }
    return n;
}

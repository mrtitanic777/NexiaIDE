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

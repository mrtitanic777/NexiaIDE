/*
 * run.c — spawn an SDK tool and collect what it says.
 *
 * Replaces sdkTools.ts, which was a set of one-line wrappers over a single
 * spawn: fxc, xma2encode, xwmaencode, makexui, xexdump, lzxcompress, imagexex.
 * The wrappers are not the interesting part and are not reproduced — the caller
 * names the tool. What matters is doing the spawn correctly, once.
 *
 * No shell. The TypeScript passed shell:true and hand-quoted paths containing
 * spaces, which is how "C:\Program Files (x86)\..." becomes a bug: cmd.exe
 * re-parses the line and the parentheses are its own syntax. CreateProcess takes
 * the command line as given.
 */
#include "nexia.h"

/* Drain a pipe to a growing buffer until the far end closes. */
static char *drain(HANDLE pipe)
{
    size_t cap = 8192, len = 0;
    char *buf = (char *)malloc(cap);
    if (!buf) return NULL;

    for (;;) {
        if (len + 4096 > cap) {
            char *g = (char *)realloc(buf, cap * 2);
            if (!g) break;
            buf = g; cap *= 2;
        }
        DWORD got = 0;
        if (!ReadFile(pipe, buf + len, 4096, &got, NULL) || got == 0) break;
        len += got;
    }
    buf[len] = 0;
    return buf;
}

int nx_run(const wchar_t *exe, const wchar_t *args, const wchar_t *cwd,
           const nx_sdk *sdk, char **out)
{
    if (out) *out = NULL;

    SECURITY_ATTRIBUTES sa = { sizeof(sa), NULL, TRUE };
    HANDLE rd = NULL, wr = NULL;
    if (!CreatePipe(&rd, &wr, &sa, 0)) return -1;
    /* The read end must not reach the child, or the pipe never reports EOF:
     * the child would hold a handle to it and we would wait forever. */
    SetHandleInformation(rd, HANDLE_FLAG_INHERIT, 0);

    /* CreateProcessW may modify its command line argument, so it cannot be a
     * literal or a const pointer. */
    size_t n = wcslen(exe) + (args ? wcslen(args) : 0) + 8;
    wchar_t *cmd = (wchar_t *)malloc(n * sizeof(wchar_t));
    if (!cmd) { CloseHandle(rd); CloseHandle(wr); return -1; }
    _snwprintf(cmd, n - 1, L"\"%ls\"%ls%ls", exe, args && *args ? L" " : L"", args ? args : L"");
    cmd[n - 1] = 0;

    wchar_t *env = sdk ? nx_tool_env(sdk) : NULL;

    STARTUPINFOW si = { 0 };
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdOutput = wr;
    si.hStdError = wr;          /* interleaved, as a console would show it */
    si.hStdInput = NULL;

    PROCESS_INFORMATION pi = { 0 };
    BOOL ok = CreateProcessW(NULL, cmd, NULL, NULL, TRUE,
                             CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
                             env, cwd, &si, &pi);
    free(cmd);
    CloseHandle(wr);            /* our copy: the child holds the only one now */

    if (!ok) {
        CloseHandle(rd);
        if (env) nx_env_free(env);
        return -1;
    }

    char *text = drain(rd);
    CloseHandle(rd);

    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD code = 1;
    GetExitCodeProcess(pi.hProcess, &code);
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    if (env) nx_env_free(env);

    if (out) *out = text; else free(text);
    return (int)code;
}

/*
 *   nexia-core tool run <name> [args...]
 *
 * Everything after the tool name is passed through untouched.
 */
int nx_cmd_tool(int argc, wchar_t **argv)
{
    if (argc < 2 || wcscmp(argv[0], L"run")) { nx_json_error("tool: expected 'run <name> [args...]'"); return 2; }

    nx_hints h = { NULL, NULL, NULL };
    nx_sdk sdk;
    if (!nx_sdk_detect(&h, &sdk)) { nx_json_error("no Xbox 360 SDK found"); return 1; }

    wchar_t exe[NX_PATH];
    if (!nx_tool_path(&sdk, argv[1], exe, NX_PATH)) {
        printf("{\"ok\":false,\"error\":\"tool not found in SDK\",");
        nx_json_field(stdout, "tool", argv[1]);
        printf("}\n");
        return 1;
    }

    /* Rebuild the tail as one command line. Anything with a space is quoted,
     * which is what the caller means by passing it as one argument. */
    wchar_t tail[8192] = L"";
    for (int i = 2; i < argc; i++) {
        if (*tail) wcscat(tail, L" ");
        int spaced = wcschr(argv[i], L' ') != NULL;
        if (spaced) wcscat(tail, L"\"");
        wcsncat(tail, argv[i], 8192 - wcslen(tail) - 4);
        if (spaced) wcscat(tail, L"\"");
    }

    wchar_t dir[NX_PATH];
    nx_copy(dir, NX_PATH, exe);
    wchar_t *slash = wcsrchr(dir, L'\\');
    if (slash) *slash = 0;

    char *out = NULL;
    int code = nx_run(exe, tail, dir, &sdk, &out);

    printf("{\"ok\":%s,\"exitCode\":%d,", code == 0 ? "true" : "false", code);
    nx_json_field(stdout, "tool", exe);
    printf(",\"output\":");
    /* nx_json_str takes wide; the tool's output is bytes from a console. */
    if (out) {
        int wn = MultiByteToWideChar(CP_ACP, 0, out, -1, NULL, 0);
        wchar_t *w = (wchar_t *)malloc((size_t)wn * sizeof(wchar_t));
        if (w) {
            MultiByteToWideChar(CP_ACP, 0, out, -1, w, wn);
            nx_json_str(stdout, w);
            free(w);
        } else nx_json_str(stdout, L"");
        free(out);
    } else nx_json_str(stdout, L"");
    printf("}\n");
    return code == 0 ? 0 : 1;
}

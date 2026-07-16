/*
 * emulator.c — find the emulator's process, and interrupt it.
 *
 * A partial port of src/main/emulator.ts. What moves here is the part that was
 * TypeScript pretending to be Windows. Finding the emulator's real PID ran
 * tasklist and pulled the number back out of its CSV with a regex. Pausing was
 * worse: it wrote a PowerShell script into %TEMP%, had it Add-Type a C# shim to
 * P/Invoke OpenProcess and DebugBreakProcess, shelled out to run it, and deleted
 * the script afterwards — to make three calls that are in kernel32 the whole
 * time, and to throw away the error code that says why they failed.
 *
 * WHAT DOES NOT MOVE.
 * The GDB/MI session — registers, breakpoints, memory reads, the stop/run state
 * machine, the token/callback table — is a live pipe and an event stream into
 * the renderer. It has to outlive a command, and this program does not:
 * nexia-core answers one question and exits. The same is true of launch(),
 * which owns the emulator's stdout for as long as the emulator runs, and of
 * stop(). Porting them means a daemon and a wire protocol, which is a different
 * program, not this one. They stay in TypeScript and call in here for the two
 * things they could not do themselves.
 */
#include "emulator.h"
#include <tlhelp32.h>

/*
 * PROCESS_ALL_ACCESS as it was defined before Vista widened it, which is the
 * literal the PowerShell asked for. Compiling against the modern 0x1FFFFF would
 * request rights the old mask never did and fail to open processes that the
 * TypeScript opens today.
 */
#define EMU_PROCESS_ALL_ACCESS 0x1F0FFF

static const wchar_t *opt(int argc, wchar_t **argv, const wchar_t *name)
{
    for (int i = 0; i < argc - 1; i++)
        if (!wcscmp(argv[i], name)) return argv[i + 1];
    return NULL;
}

/*
 * Mirrors findPidsByName(). tasklist's IMAGENAME filter is case-insensitive and
 * matches the image name only, which is exactly what a snapshot compares.
 */
static int pids_by_name(const wchar_t *exe, DWORD *out, int cap)
{
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE) return 0;

    PROCESSENTRY32W e;
    e.dwSize = sizeof(e);

    int n = 0;
    if (Process32FirstW(snap, &e)) {
        do {
            if (n >= cap) break;
            if (!_wcsicmp(e.szExeFile, exe)) out[n++] = e.th32ProcessID;
        } while (Process32NextW(snap, &e));
    }
    CloseHandle(snap);
    return n;
}

/*
 * Run "<exe> --version" and report whether it exited 0 — the test findGdb()
 * makes, which is execSync throwing or not.
 *
 * The child's handles go to NUL. execSync captured its output into a pipe that
 * nobody ever read, and anything gdb printed here would land in the middle of
 * our JSON instead.
 */
static int probe(const wchar_t *exe)
{
    wchar_t cmd[NX_PATH + 32];
    _snwprintf(cmd, NX_PATH + 31, L"\"%ls\" --version", exe);
    cmd[NX_PATH + 31] = 0;

    SECURITY_ATTRIBUTES sa;
    sa.nLength = sizeof(sa);
    sa.lpSecurityDescriptor = NULL;
    sa.bInheritHandle = TRUE;

    HANDLE nul = CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE,
                             FILE_SHARE_READ | FILE_SHARE_WRITE, &sa,
                             OPEN_EXISTING, 0, NULL);
    if (nul == INVALID_HANDLE_VALUE) return 0;

    STARTUPINFOW si;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = si.hStdOutput = si.hStdError = nul;

    PROCESS_INFORMATION pi;
    ZeroMemory(&pi, sizeof(pi));

    /* A bare "gdb" has to resolve against PATH, so the image name stays in the
     * command line rather than being lifted into lpApplicationName. */
    BOOL started = CreateProcessW(NULL, cmd, NULL, NULL, TRUE, CREATE_NO_WINDOW,
                                  NULL, NULL, &si, &pi);
    CloseHandle(nul);
    if (!started) return 0;

    /* No timeout, because execSync was given none. A gdb that never answers is
     * a broken install, and it should hang here exactly as it hangs today
     * rather than be quietly reported as absent. */
    WaitForSingleObject(pi.hProcess, INFINITE);

    DWORD code = 1;
    GetExitCodeProcess(pi.hProcess, &code);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return code == 0;
}

/*
 * Mirrors findGdb(), candidate for candidate. The order matters: a gdb on PATH
 * wins over any of the hard-coded installs, which is how a user who put their
 * own toolchain first gets it.
 */
static int find_gdb(const wchar_t *configured, wchar_t *out, size_t cap)
{
    static const wchar_t *candidates[] = {
        L"gdb", L"gdb.exe",
        L"C:\\msys64\\mingw64\\bin\\gdb.exe",
        L"C:\\msys64\\usr\\bin\\gdb.exe",
        L"C:\\mingw64\\bin\\gdb.exe",
        L"C:\\TDM-GCC-64\\bin\\gdb.exe",
    };

    if (configured && *configured && nx_exists(configured)) {
        nx_copy(out, cap, configured);
        return 1;
    }

    for (int i = 0; i < (int)(sizeof(candidates) / sizeof(candidates[0])); i++) {
        if (!probe(candidates[i])) continue;
        /* The candidate as written, not a path resolved from it: "gdb" is what
         * the TypeScript stored and later spawned, and re-resolving it against
         * PATH at spawn time is the behaviour installs already have. */
        nx_copy(out, cap, candidates[i]);
        return 1;
    }
    return 0;
}

/*
 * The whole of the PowerShell script, minus the script.
 *
 * The original checked nothing — DebugBreakProcess could return false and the
 * caller would see success, then sit through the five-second interrupt timeout
 * wondering why nothing stopped. The error code is reported here so the caller
 * can tell "denied" from "gone" and fall back deliberately.
 */
static int debug_break(DWORD pid, DWORD *err)
{
    HANDLE h = OpenProcess(EMU_PROCESS_ALL_ACCESS, FALSE, pid);
    if (!h) { *err = GetLastError(); return 0; }

    BOOL ok = DebugBreakProcess(h);
    if (!ok) *err = GetLastError();
    CloseHandle(h);
    return ok ? 1 : 0;
}

int nx_cmd_emulator(int argc, wchar_t **argv)
{
    if (argc < 1) { nx_json_error("emulator: expected a subcommand"); return 2; }

    if (!wcscmp(argv[0], L"pids")) {
        if (argc < 2) { nx_json_error("emulator pids: expected an executable name"); return 2; }
        DWORD pids[256];
        int n = pids_by_name(argv[1], pids, 256);
        printf("{\"ok\":true,\"pids\":[");
        for (int i = 0; i < n; i++) { if (i) printf(","); printf("%lu", (unsigned long)pids[i]); }
        printf("]}\n");
        return 0;
    }

    if (!wcscmp(argv[0], L"gdb")) {
        wchar_t p[NX_PATH];
        if (!find_gdb(opt(argc, argv, L"--gdb-path"), p, NX_PATH)) {
            printf("{\"ok\":true,\"path\":null}\n");
            return 0;
        }
        printf("{\"ok\":true,");
        nx_json_field(stdout, "path", p);
        printf("}\n");
        return 0;
    }

    if (!wcscmp(argv[0], L"configured")) {
        if (argc < 2) { nx_json_error("emulator configured: expected a path"); return 2; }
        printf("{\"ok\":true,\"configured\":%s}\n", nx_exists(argv[1]) ? "true" : "false");
        return 0;
    }

    if (!wcscmp(argv[0], L"break")) {
        if (argc < 2) { nx_json_error("emulator break: expected a pid"); return 2; }
        wchar_t *end = NULL;
        unsigned long pid = wcstoul(argv[1], &end, 10);
        if (!pid || (end && *end)) { nx_json_error("emulator break: pid is not a number"); return 2; }

        DWORD err = 0;
        if (debug_break((DWORD)pid, &err)) { printf("{\"ok\":true,\"broke\":true}\n"); return 0; }
        printf("{\"ok\":true,\"broke\":false,\"code\":%lu}\n", (unsigned long)err);
        return 0;
    }

    nx_json_error("emulator: unknown subcommand");
    return 2;
}

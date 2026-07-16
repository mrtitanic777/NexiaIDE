/*
 * nexia-ui/main.cpp — the native UI spike.
 *
 * A standalone native Win32 application that talks to nexia-core — the ported C
 * backend — exactly as the Electron IDE does: spawn nexia-core.exe, read the
 * JSON, parse it. The point of this spike is to prove the native UI can stand on
 * the existing backend with zero new backend work: everything the port already
 * did (open a project, walk its tree, detect the SDK, plan a build) is available
 * here through the same commands the TypeScript shims call.
 *
 * This is a parallel, independent app. src/ (the Electron IDE) is untouched and
 * keeps shipping; this grows in its own folder until it is good enough to replace
 * it. It reuses core/json_parse.c to read the responses — the same JSON reader
 * the backend writes with — which is the first taste of "core as a library".
 *
 * Console subsystem on purpose for now: it opens the window AND keeps a stdout,
 * so `nexia-ui.exe --probe` can run the backend calls and print them for headless
 * verification without blocking in the message loop.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <string>
#include <vector>

extern "C" {
#include "json_parse.h"
}

// ── nexia-core.exe, beside this executable ──────────────────────────────────
static std::wstring exeDir() {
    wchar_t buf[MAX_PATH];
    GetModuleFileNameW(NULL, buf, MAX_PATH);
    std::wstring p(buf);
    size_t s = p.find_last_of(L"\\/");
    return s == std::wstring::npos ? L"." : p.substr(0, s);
}

// ── spawn nexia-core with args, capture stdout as UTF-8 bytes ────────────────
static std::string runCore(const std::wstring& args) {
    std::wstring cmd = L"\"" + exeDir() + L"\\nexia-core.exe\" " + args;

    SECURITY_ATTRIBUTES sa = { sizeof(sa), NULL, TRUE };
    HANDLE rd = NULL, wr = NULL;
    if (!CreatePipe(&rd, &wr, &sa, 0)) return "";
    SetHandleInformation(rd, HANDLE_FLAG_INHERIT, 0);

    STARTUPINFOW si = { sizeof(si) };
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdOutput = wr;
    si.hStdError = wr;
    PROCESS_INFORMATION pi = {};

    std::vector<wchar_t> mut(cmd.begin(), cmd.end());
    mut.push_back(0);
    if (!CreateProcessW(NULL, mut.data(), NULL, NULL, TRUE,
                        CREATE_NO_WINDOW, NULL, NULL, &si, &pi)) {
        CloseHandle(rd); CloseHandle(wr);
        return "";
    }
    CloseHandle(wr);   // our copy of the write end must close, or ReadFile never sees EOF

    std::string out;
    char chunk[8192];
    DWORD got = 0;
    while (ReadFile(rd, chunk, sizeof chunk, &got, NULL) && got > 0)
        out.append(chunk, got);
    CloseHandle(rd);
    WaitForSingleObject(pi.hProcess, INFINITE);
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    return out;
}

// jv_get_str returns a pointer into the tree; copy it out so callers can free.
static std::wstring jvStr(const jv* obj, const wchar_t* key, const wchar_t* fb = L"") {
    const wchar_t* s = jv_get_str(obj, key, fb);
    return s ? std::wstring(s) : std::wstring(fb);
}

// ── app state, filled from nexia-core ───────────────────────────────────────
struct FileRow { std::wstring name; int depth; bool dir; };
struct AppState {
    std::wstring sdkRoot  = L"(not detected)";
    std::wstring projName = L"(no project)";
    std::wstring projPath;
    std::vector<FileRow> rows;
    std::wstring status;
} g_app;

static void collectTree(const jv* arr, int depth, std::vector<FileRow>& out) {
    for (int i = 0; i < jv_count(arr); i++) {
        const jv* n = jv_at(arr, i);
        const jv* children = jv_get(n, L"children");
        FileRow r;
        r.name  = jvStr(n, L"name");
        r.depth = depth;
        r.dir   = (jvStr(n, L"type") == L"directory") || (children != NULL);
        out.push_back(r);
        if (children) collectTree(children, depth + 1, out);
    }
}

static void loadProject(const std::wstring& path) {
    // Same hints the TypeScript toolchain.detect passes: where the app's
    // resources live and where the executable sits. sdk.root is nested under
    // "sdk", null when nothing is found.
    std::wstring resources = exeDir() + L"\\..\\resources";
    std::string sdk = runCore(L"sdk detect --resources \"" + resources +
                              L"\" --exe-dir \"" + exeDir() + L"\"");
    if (jv* j = jv_parse_utf8(sdk.c_str(), sdk.size(), NULL)) {
        const jv* s = jv_get(j, L"sdk");
        g_app.sdkRoot = s ? jvStr(s, L"root", L"(not detected)") : L"(not detected)";
        jv_free(j);
    }

    std::string po = runCore(L"project open \"" + path + L"\"");
    if (jv* j = jv_parse_utf8(po.c_str(), po.size(), NULL)) {
        const jv* p = jv_get(j, L"project");
        g_app.projName = jvStr(p, L"name", L"(open failed)");
        g_app.projPath = jvStr(p, L"path");
        jv_free(j);
    }

    std::string pt = runCore(L"project tree \"" + path + L"\"");
    if (jv* j = jv_parse_utf8(pt.c_str(), pt.size(), NULL)) {
        g_app.rows.clear();
        collectTree(jv_get(j, L"tree"), 0, g_app.rows);
        jv_free(j);
    }

    g_app.status = L"Loaded through nexia-core.exe — the same backend the Electron IDE uses.";
}

// ── rendering (GDI for the spike; DX9 + ImGui + a skin engine come next) ─────
static void paint(HWND h) {
    PAINTSTRUCT ps;
    HDC dc = BeginPaint(h, &ps);
    RECT rc; GetClientRect(h, &rc);
    HBRUSH bg = CreateSolidBrush(RGB(24, 24, 28));
    FillRect(dc, &rc, bg);
    DeleteObject(bg);
    SetBkMode(dc, TRANSPARENT);
    HFONT font = CreateFontW(-15, 0, 0, 0, FW_NORMAL, 0, 0, 0,
                             DEFAULT_CHARSET, 0, 0, 0, FIXED_PITCH, L"Consolas");
    HFONT old = (HFONT)SelectObject(dc, font);

    int y = 14;
    auto line = [&](const std::wstring& s, COLORREF c, int x) {
        SetTextColor(dc, c);
        TextOutW(dc, x, y, s.c_str(), (int)s.size());
        y += 20;
    };

    SetTextColor(dc, RGB(90, 220, 200));
    const wchar_t* title = L"Nexia IDE  —  native UI spike";
    TextOutW(dc, 14, y, title, (int)wcslen(title));
    y += 30;
    line(L"nexia-core (ported C backend) called directly. src/ untouched.", RGB(140, 140, 150), 14);
    y += 10;
    line(L"SDK:     " + g_app.sdkRoot,  RGB(225, 225, 225), 14);
    line(L"Project: " + g_app.projName, RGB(225, 225, 225), 14);
    line(L"Path:    " + g_app.projPath, RGB(150, 150, 150), 14);
    y += 10;
    line(L"Solution Explorer:", RGB(90, 220, 200), 14);
    for (const auto& r : g_app.rows) {
        std::wstring indent(r.depth * 3, L' ');
        std::wstring pre = r.dir ? L"[+] " : L".   ";
        line(indent + pre + r.name, r.dir ? RGB(210, 200, 130) : RGB(200, 200, 205), 26);
    }
    y += 12;
    line(g_app.status, RGB(120, 190, 130), 14);

    SelectObject(dc, old);
    DeleteObject(font);
    EndPaint(h, &ps);
}

static LRESULT CALLBACK WndProc(HWND h, UINT m, WPARAM w, LPARAM l) {
    switch (m) {
    case WM_PAINT:   paint(h); return 0;
    case WM_DESTROY: PostQuitMessage(0); return 0;
    }
    return DefWindowProcW(h, m, w, l);
}

// The real test project.
static const wchar_t* kProject = L"C:\\Users\\mrtit\\Documents\\NexiaIDE\\Projects\\CaveGame2";

static void print8(const std::wstring& s) {
    int n = WideCharToMultiByte(CP_UTF8, 0, s.c_str(), -1, NULL, 0, NULL, NULL);
    if (n <= 0) return;
    std::string b((size_t)n, 0);
    WideCharToMultiByte(CP_UTF8, 0, s.c_str(), -1, &b[0], n, NULL, NULL);
    printf("%s\n", b.c_str());
}

// Headless verification: run the backend calls, print, no window.
static int probe() {
    loadProject(kProject);
    print8(L"SDK:     " + g_app.sdkRoot);
    print8(L"Project: " + g_app.projName);
    print8(L"Path:    " + g_app.projPath);
    print8(L"Tree rows: " + std::to_wstring((unsigned)g_app.rows.size()));
    for (const auto& r : g_app.rows)
        print8(std::wstring((size_t)r.depth * 2, L' ') + (r.dir ? L"[dir] " : L"      ") + r.name);
    return 0;
}

int main(int argc, char** argv) {
    for (int i = 1; i < argc; i++)
        if (!strcmp(argv[i], "--probe")) return probe();

    loadProject(kProject);

    WNDCLASSW wc = {};
    wc.lpfnWndProc   = WndProc;
    wc.hInstance     = GetModuleHandleW(NULL);
    wc.lpszClassName = L"NexiaUiSpike";
    wc.hCursor       = LoadCursor(NULL, IDC_ARROW);
    wc.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1);
    RegisterClassW(&wc);

    HWND h = CreateWindowExW(0, wc.lpszClassName, L"Nexia IDE  —  native spike",
                             WS_OVERLAPPEDWINDOW, CW_USEDEFAULT, CW_USEDEFAULT,
                             920, 720, NULL, NULL, wc.hInstance, NULL);
    ShowWindow(h, SW_SHOW);
    UpdateWindow(h);

    MSG msg;
    while (GetMessageW(&msg, NULL, 0, 0)) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
    return 0;
}

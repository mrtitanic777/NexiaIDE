/*
 * core_bridge.cpp — see core_bridge.h.
 *
 * Reuses core/json_parse.c to read nexia-core's responses: the UI parses the
 * backend's output with the same reader the backend writes it with.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include "core_bridge.h"

extern "C" {
#include "json_parse.h"
}

AppState g_app;

std::string u8(const std::wstring& s) {
    if (s.empty()) return "";
    int n = WideCharToMultiByte(CP_UTF8, 0, s.c_str(), (int)s.size(), NULL, 0, NULL, NULL);
    std::string b((size_t)(n > 0 ? n : 0), 0);
    if (n > 0) WideCharToMultiByte(CP_UTF8, 0, s.c_str(), (int)s.size(), &b[0], n, NULL, NULL);
    return b;
}

// The directory this executable sits in — nexia-core.exe is beside it.
static std::wstring exeDir() {
    wchar_t buf[MAX_PATH];
    GetModuleFileNameW(NULL, buf, MAX_PATH);
    std::wstring p(buf);
    size_t s = p.find_last_of(L"\\/");
    return s == std::wstring::npos ? L"." : p.substr(0, s);
}

std::string core_run(const std::wstring& args) {
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
    CloseHandle(wr); // our write-end must close, or ReadFile never sees EOF

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

// jv_get_str points into the parsed tree; copy it out so callers can free.
static std::wstring jvStr(const jv* obj, const wchar_t* key, const wchar_t* fb = L"") {
    const wchar_t* s = jv_get_str(obj, key, fb);
    return s ? std::wstring(s) : std::wstring(fb);
}

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

void core_load_project(const std::wstring& path) {
    // Same hints toolchain.detect passes; sdk.root is nested under "sdk".
    std::wstring resources = exeDir() + L"\\..\\resources";
    std::string sdk = core_run(L"sdk detect --resources \"" + resources +
                               L"\" --exe-dir \"" + exeDir() + L"\"");
    if (jv* j = jv_parse_utf8(sdk.c_str(), sdk.size(), NULL)) {
        const jv* s = jv_get(j, L"sdk");
        g_app.sdkRoot = s ? jvStr(s, L"root", L"(not detected)") : L"(not detected)";
        jv_free(j);
    }

    std::string po = core_run(L"project open \"" + path + L"\"");
    if (jv* j = jv_parse_utf8(po.c_str(), po.size(), NULL)) {
        const jv* p = jv_get(j, L"project");
        g_app.projName = jvStr(p, L"name", L"(open failed)");
        g_app.projPath = jvStr(p, L"path");
        jv_free(j);
    }

    std::string pt = core_run(L"project tree \"" + path + L"\"");
    if (jv* j = jv_parse_utf8(pt.c_str(), pt.size(), NULL)) {
        g_app.rows.clear();
        collectTree(jv_get(j, L"tree"), 0, g_app.rows);
        jv_free(j);
    }
}

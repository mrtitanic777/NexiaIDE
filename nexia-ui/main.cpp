/*
 * nexia-ui/main.cpp — the native UI spike, now drawn with Dear ImGui on DX9.
 *
 * Still a standalone native C++ app that talks to nexia-core (the ported C
 * backend) by spawning it and reading its JSON — src/ (the Electron IDE) is
 * untouched. What changed from the first commit is the rendering: GDI TextOut is
 * gone, replaced by a DX9 device and an ImGui frame. DX9 because it is ideal for
 * Windows 7 (the whole reason this stack was chosen), and ImGui because the UI
 * must be custom-drawn to carry the skins later — immediate mode draws every
 * frame, which the cinematic engine will also want.
 *
 * `nexia-ui.exe --probe` still runs the backend calls and prints them with no
 * window, for headless verification.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <d3d9.h>
#include <stdio.h>
#include <string>
#include <vector>

#include "imgui.h"
#include "backends/imgui_impl_win32.h"
#include "backends/imgui_impl_dx9.h"

extern "C" {
#include "json_parse.h"
}

// ── UTF-16 <-> UTF-8 (ImGui speaks UTF-8) ───────────────────────────────────
static std::string u8(const std::wstring& s) {
    if (s.empty()) return "";
    int n = WideCharToMultiByte(CP_UTF8, 0, s.c_str(), (int)s.size(), NULL, 0, NULL, NULL);
    std::string b((size_t)(n > 0 ? n : 0), 0);
    if (n > 0) WideCharToMultiByte(CP_UTF8, 0, s.c_str(), (int)s.size(), &b[0], n, NULL, NULL);
    return b;
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
    CloseHandle(wr);

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
}

static const wchar_t* kProject = L"C:\\Users\\mrtit\\Documents\\NexiaIDE\\Projects\\CaveGame2";

// ── DX9 plumbing (standard ImGui example shape) ─────────────────────────────
static LPDIRECT3D9           g_pD3D = NULL;
static LPDIRECT3DDEVICE9     g_pd3dDevice = NULL;
static UINT                  g_ResizeW = 0, g_ResizeH = 0;
static D3DPRESENT_PARAMETERS g_d3dpp = {};

static bool CreateDeviceD3D(HWND hWnd) {
    if ((g_pD3D = Direct3DCreate9(D3D_SDK_VERSION)) == NULL) return false;
    ZeroMemory(&g_d3dpp, sizeof(g_d3dpp));
    g_d3dpp.Windowed = TRUE;
    g_d3dpp.SwapEffect = D3DSWAPEFFECT_DISCARD;
    g_d3dpp.BackBufferFormat = D3DFMT_UNKNOWN;
    g_d3dpp.EnableAutoDepthStencil = TRUE;
    g_d3dpp.AutoDepthStencilFormat = D3DFMT_D16;
    g_d3dpp.PresentationInterval = D3DPRESENT_INTERVAL_ONE; // vsync
    if (g_pD3D->CreateDevice(D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL, hWnd,
                             D3DCREATE_HARDWARE_VERTEXPROCESSING, &g_d3dpp, &g_pd3dDevice) < 0)
        return false;
    return true;
}
static void CleanupDeviceD3D() {
    if (g_pd3dDevice) { g_pd3dDevice->Release(); g_pd3dDevice = NULL; }
    if (g_pD3D) { g_pD3D->Release(); g_pD3D = NULL; }
}
static void ResetDevice() {
    ImGui_ImplDX9_InvalidateDeviceObjects();
    g_pd3dDevice->Reset(&g_d3dpp);
    ImGui_ImplDX9_CreateDeviceObjects();
}

extern LRESULT ImGui_ImplWin32_WndProcHandler(HWND, UINT, WPARAM, LPARAM);

static LRESULT WINAPI WndProc(HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    if (ImGui_ImplWin32_WndProcHandler(hWnd, msg, wParam, lParam)) return true;
    switch (msg) {
    case WM_SIZE:
        if (wParam == SIZE_MINIMIZED) return 0;
        g_ResizeW = (UINT)LOWORD(lParam);
        g_ResizeH = (UINT)HIWORD(lParam);
        return 0;
    case WM_SYSCOMMAND:
        if ((wParam & 0xfff0) == SC_KEYMENU) return 0; // disable alt menu
        break;
    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProcW(hWnd, msg, wParam, lParam);
}

// ── the frame ───────────────────────────────────────────────────────────────
static void drawUI() {
    const ImGuiViewport* vp = ImGui::GetMainViewport();
    ImGui::SetNextWindowPos(vp->WorkPos);
    ImGui::SetNextWindowSize(vp->WorkSize);
    ImGui::Begin("NexiaMain", NULL,
        ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_NoResize | ImGuiWindowFlags_NoMove |
        ImGuiWindowFlags_NoCollapse | ImGuiWindowFlags_NoBringToFrontOnFocus);

    ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(0.35f, 0.86f, 0.78f, 1.0f));
    ImGui::Text("Nexia IDE  \xE2\x80\x94  native UI  (Dear ImGui + Direct3D 9)");
    ImGui::PopStyleColor();
    ImGui::TextDisabled("nexia-core (ported C backend) called directly. src/ untouched.");
    ImGui::Separator();
    ImGui::Spacing();

    ImGui::Text("SDK:     %s", u8(g_app.sdkRoot).c_str());
    ImGui::Text("Project: %s", u8(g_app.projName).c_str());
    ImGui::TextDisabled("Path:    %s", u8(g_app.projPath).c_str());
    ImGui::Spacing();

    if (ImGui::CollapsingHeader("Solution Explorer", ImGuiTreeNodeFlags_DefaultOpen)) {
        for (const auto& r : g_app.rows) {
            float ind = r.depth * 16.0f;
            if (ind > 0) ImGui::Indent(ind);
            if (r.dir) {
                ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(0.82f, 0.78f, 0.5f, 1.0f));
                ImGui::Text("[+] %s", u8(r.name).c_str());
                ImGui::PopStyleColor();
            } else {
                ImGui::Text("     %s", u8(r.name).c_str());
            }
            if (ind > 0) ImGui::Unindent(ind);
        }
    }

    ImGui::Spacing();
    ImGui::Separator();
    if (ImGui::Button("Reload from nexia-core")) loadProject(kProject);
    ImGui::SameLine();
    ImGui::TextDisabled("Loaded through nexia-core.exe \xE2\x80\x94 the same backend the Electron IDE uses.");

    ImGui::End();
}

// ── headless probe (unchanged) ──────────────────────────────────────────────
static void print8(const std::wstring& s) {
    std::string b = u8(s);
    printf("%s\n", b.c_str());
}
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

    WNDCLASSEXW wc = { sizeof(wc), CS_CLASSDC, WndProc, 0L, 0L,
                       GetModuleHandleW(NULL), NULL, LoadCursor(NULL, IDC_ARROW),
                       NULL, NULL, L"NexiaUi", NULL };
    RegisterClassExW(&wc);
    HWND hwnd = CreateWindowW(wc.lpszClassName, L"Nexia IDE  \x2014  native",
                              WS_OVERLAPPEDWINDOW, 100, 80, 1100, 760,
                              NULL, NULL, wc.hInstance, NULL);

    if (!CreateDeviceD3D(hwnd)) {
        CleanupDeviceD3D();
        UnregisterClassW(wc.lpszClassName, wc.hInstance);
        MessageBoxW(NULL, L"Direct3D 9 device creation failed.", L"Nexia IDE", MB_OK | MB_ICONERROR);
        return 1;
    }
    ShowWindow(hwnd, SW_SHOWDEFAULT);
    UpdateWindow(hwnd);

    IMGUI_CHECKVERSION();
    ImGui::CreateContext();
    ImGuiIO& io = ImGui::GetIO();
    io.ConfigFlags |= ImGuiConfigFlags_NavEnableKeyboard;
    io.IniFilename = NULL; // no imgui.ini for the spike
    ImGui::StyleColorsDark();
    ImGui::GetStyle().WindowRounding = 0.0f;
    ImGui::GetStyle().FrameRounding = 3.0f;
    ImGui_ImplWin32_Init(hwnd);
    ImGui_ImplDX9_Init(g_pd3dDevice);

    bool done = false;
    while (!done) {
        MSG msg;
        while (PeekMessageW(&msg, NULL, 0U, 0U, PM_REMOVE)) {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
            if (msg.message == WM_QUIT) done = true;
        }
        if (done) break;

        if (g_ResizeW != 0 && g_ResizeH != 0) {
            g_d3dpp.BackBufferWidth = g_ResizeW;
            g_d3dpp.BackBufferHeight = g_ResizeH;
            g_ResizeW = g_ResizeH = 0;
            ResetDevice();
        }

        ImGui_ImplDX9_NewFrame();
        ImGui_ImplWin32_NewFrame();
        ImGui::NewFrame();
        drawUI();
        ImGui::EndFrame();

        g_pd3dDevice->SetRenderState(D3DRS_ZENABLE, FALSE);
        g_pd3dDevice->SetRenderState(D3DRS_ALPHABLENDENABLE, FALSE);
        g_pd3dDevice->SetRenderState(D3DRS_SCISSORTESTENABLE, FALSE);
        g_pd3dDevice->Clear(0, NULL, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER,
                            D3DCOLOR_RGBA(24, 24, 28, 255), 1.0f, 0);
        if (g_pd3dDevice->BeginScene() >= 0) {
            ImGui::Render();
            ImGui_ImplDX9_RenderDrawData(ImGui::GetDrawData());
            g_pd3dDevice->EndScene();
        }
        HRESULT pr = g_pd3dDevice->Present(NULL, NULL, NULL, NULL);
        if (pr == D3DERR_DEVICELOST && g_pd3dDevice->TestCooperativeLevel() == D3DERR_DEVICENOTRESET)
            ResetDevice();
    }

    ImGui_ImplDX9_Shutdown();
    ImGui_ImplWin32_Shutdown();
    ImGui::DestroyContext();
    CleanupDeviceD3D();
    DestroyWindow(hwnd);
    UnregisterClassW(wc.lpszClassName, wc.hInstance);
    return 0;
}

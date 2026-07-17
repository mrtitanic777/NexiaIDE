/*
 * nexia-ui/main.cpp — entry point, kept thin.
 *
 * Wires the three modules together: core_bridge (the backend client), app (the
 * DX9/Win32/ImGui host) and ui (the ImGui panels). Handles --probe for headless
 * verification, loads the project, then hands off to the frame loop.
 *
 * This is a standalone native app developed in parallel with the Electron IDE;
 * src/ is not involved. It reaches every Xbox-360 feature by spawning nexia-core,
 * the same backend the Electron IDE uses.
 */
#include <cstdio>
#include <cstring>

#include "core_bridge.h"
#include "app.h"
#include "ui.h"

// The real test project.
static const wchar_t* kProject = L"C:\\Users\\mrtit\\Documents\\NexiaIDE\\Projects\\CaveGame2";

static void print8(const std::wstring& s) { printf("%s\n", u8(s).c_str()); }

// Headless verification: run the backend calls, print, no window.
static int probe() {
    core_load_project(kProject);
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

    core_load_project(kProject);
    return app_run(ui_draw);
}

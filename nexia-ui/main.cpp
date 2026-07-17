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
#include "builder.h"
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

// Headless build: drive the native build loop and print its output.
static int buildProbe() {
    core_load_project(kProject);
    bool ok = core_build(kProject, L"Debug", [](const std::string& s) { fputs(s.c_str(), stdout); });
    return ok ? 0 : 1;
}

int main(int argc, char** argv) {
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--probe")) return probe();
        if (!strcmp(argv[i], "--build")) return buildProbe();
    }

    core_load_project(kProject);
    return app_run(ui_draw);
}

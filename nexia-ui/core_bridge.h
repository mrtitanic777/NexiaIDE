/*
 * core_bridge.h — the backend client.
 *
 * Everything that talks to nexia-core lives here: spawn the exe, read the JSON,
 * turn it into C++ state the UI can draw. No Win32, no DX9, no ImGui — this is
 * purely "call the ported C backend, get data back", which is why it can be
 * exercised on its own by `nexia-ui.exe --probe`.
 */
#pragma once
#include <string>
#include <vector>

// One row of the Solution Explorer, flattened with a depth for indentation.
struct FileRow { std::wstring name; std::wstring path; int depth; bool dir; };

// Everything the UI shows, filled from nexia-core.
struct AppState {
    std::wstring sdkRoot  = L"(not detected)";
    std::wstring projName = L"(no project)";
    std::wstring projPath;
    std::vector<FileRow> rows;
};
extern AppState g_app;

// UTF-16 -> UTF-8 (ImGui and stdout both speak UTF-8).
std::string u8(const std::wstring& s);

// Spawn nexia-core.exe (found beside this executable) with `args`, and return
// its stdout as UTF-8 bytes. Empty string if the process could not be started.
std::string core_run(const std::wstring& args);

// Detect the SDK, open the project at `path`, and read its file tree — all
// through nexia-core — into g_app.
void core_load_project(const std::wstring& path);

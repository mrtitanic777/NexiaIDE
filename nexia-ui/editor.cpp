/*
 * editor.cpp — see editor.h.
 */
#include "editor.h"
#include "core_bridge.h"
#include "imgui.h"
#include "misc/cpp/imgui_stdlib.h"

#include <windows.h>
#include <cstdio>

static std::wstring g_path;      // the open file, empty if none
static std::wstring g_name;      // its basename, for the tab label
static std::string  g_text;      // its contents (UTF-8)
static std::string  g_saved;     // last-saved contents, to detect edits

static std::wstring baseName(const std::wstring& p) {
    size_t s = p.find_last_of(L"\\/");
    return s == std::wstring::npos ? p : p.substr(s + 1);
}

void editor_open(const std::wstring& path) {
    FILE* f = _wfopen(path.c_str(), L"rb");
    if (!f) return;
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    std::string buf;
    if (n > 0) { buf.resize((size_t)n); fread(&buf[0], 1, (size_t)n, f); }
    fclose(f);
    g_path = path;
    g_name = baseName(path);
    g_text = buf;
    g_saved = buf;
}

void editor_save() {
    if (g_path.empty()) return;
    FILE* f = _wfopen(g_path.c_str(), L"wb");
    if (!f) return;
    if (!g_text.empty()) fwrite(g_text.data(), 1, g_text.size(), f);
    fclose(f);
    g_saved = g_text;
}

bool editor_dirty() { return !g_path.empty() && g_text != g_saved; }

void editor_draw() {
    if (g_path.empty()) {
        ImGui::TextDisabled("No file open. Click a file in the Solution Explorer.");
        return;
    }

    // header: file name, dirty marker, Save
    ImGui::Text("%s%s", u8(g_name).c_str(), editor_dirty() ? " *" : "");
    ImGui::SameLine();
    if (ImGui::SmallButton("Save") || (ImGui::GetIO().KeyCtrl && ImGui::IsKeyPressed(ImGuiKey_S)))
        editor_save();
    ImGui::Separator();

    // the text area, filling the pane, monospace
    ImGui::PushFont(NULL); // default font is fixed-pitch enough for the spike
    ImGui::InputTextMultiline("##code", &g_text,
        ImVec2(-FLT_MIN, -FLT_MIN),
        ImGuiInputTextFlags_AllowTabInput);
    ImGui::PopFont();
}

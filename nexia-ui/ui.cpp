/*
 * ui.cpp — see ui.h. The IDE shell: a menu bar, a resizable
 * tree | editor | output layout, and a status bar. The panels read g_app (filled
 * by core_bridge); the editor and output are placeholders that Scintilla and the
 * build loop will fill. As they gain substance they move to their own files.
 */
#include "ui.h"
#include "core_bridge.h"
#include "imgui.h"
#include <string>

static const ImVec4 kAccent(0.35f, 0.86f, 0.78f, 1.0f);
static const ImVec4 kFolder(0.82f, 0.78f, 0.50f, 1.0f);

// ── selection + output, UI-local for now ────────────────────────────────────
static std::wstring g_selected;
static std::string  g_output =
    "Nexia IDE native UI \xE2\x80\x94 ready.\n"
    "Select a file in the Solution Explorer.\n";

// ── draggable splitters (mutate a width/height, clamped) ─────────────────────
static void vsplitter(const char* id, float* width, float lo, float hi) {
    ImGui::PushStyleColor(ImGuiCol_Button,        ImVec4(0, 0, 0, 0));
    ImGui::PushStyleColor(ImGuiCol_ButtonHovered, ImVec4(0.40f, 0.40f, 0.48f, 0.6f));
    ImGui::PushStyleColor(ImGuiCol_ButtonActive,  ImVec4(0.40f, 0.40f, 0.55f, 0.9f));
    ImGui::Button(id, ImVec2(6.0f, -1.0f));
    ImGui::PopStyleColor(3);
    if (ImGui::IsItemActive())  *width += ImGui::GetIO().MouseDelta.x;
    if (ImGui::IsItemHovered() || ImGui::IsItemActive())
        ImGui::SetMouseCursor(ImGuiMouseCursor_ResizeEW);
    if (*width < lo) *width = lo;
    if (*width > hi) *width = hi;
}
static void hsplitter(const char* id, float* height, float lo, float hi) {
    ImGui::PushStyleColor(ImGuiCol_Button,        ImVec4(0, 0, 0, 0));
    ImGui::PushStyleColor(ImGuiCol_ButtonHovered, ImVec4(0.40f, 0.40f, 0.48f, 0.6f));
    ImGui::PushStyleColor(ImGuiCol_ButtonActive,  ImVec4(0.40f, 0.40f, 0.55f, 0.9f));
    ImGui::Button(id, ImVec2(-1.0f, 6.0f));
    ImGui::PopStyleColor(3);
    if (ImGui::IsItemActive())  *height -= ImGui::GetIO().MouseDelta.y; // drag down shrinks output
    if (ImGui::IsItemHovered() || ImGui::IsItemActive())
        ImGui::SetMouseCursor(ImGuiMouseCursor_ResizeNS);
    if (*height < lo) *height = lo;
    if (*height > hi) *height = hi;
}

// ── panels ──────────────────────────────────────────────────────────────────
static void panelTree() {
    ImGui::TextColored(kAccent, "SOLUTION EXPLORER");
    ImGui::Separator();
    int idx = 0;
    for (const auto& r : g_app.rows) {
        float ind = r.depth * 14.0f;
        if (ind > 0) ImGui::Indent(ind);
        std::string label = u8(r.name);
        if (r.dir) {
            ImGui::PushStyleColor(ImGuiCol_Text, kFolder);
            ImGui::TextUnformatted(("[+] " + label).c_str());
            ImGui::PopStyleColor();
        } else {
            bool sel = (r.name == g_selected);
            std::string sl = " " + label + "##" + std::to_string(idx);
            if (ImGui::Selectable(sl.c_str(), sel)) {
                g_selected = r.name;
                g_output += "Opened " + label + "\n";
            }
        }
        if (ind > 0) ImGui::Unindent(ind);
        idx++;
    }
}

static void panelEditor() {
    ImGui::TextColored(kAccent, "EDITOR");
    ImGui::Separator();
    if (g_selected.empty()) {
        ImGui::TextDisabled("No file open. Click a file in the Solution Explorer.");
    } else {
        ImGui::Text("Editing: %s", u8(g_selected).c_str());
        ImGui::Spacing();
        ImGui::TextDisabled("A Scintilla editor lands in this pane next \xE2\x80\x94 this is its placeholder.");
    }
}

static void panelOutput() {
    ImGui::TextColored(kAccent, "OUTPUT");
    ImGui::Separator();
    ImGui::BeginChild("out_scroll");
    ImGui::TextUnformatted(g_output.c_str());
    ImGui::EndChild();
}

// ── the frame ───────────────────────────────────────────────────────────────
void ui_draw() {
    const ImGuiViewport* vp = ImGui::GetMainViewport();
    ImGui::SetNextWindowPos(vp->WorkPos);
    ImGui::SetNextWindowSize(vp->WorkSize);
    ImGui::Begin("NexiaMain", NULL,
        ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_NoResize | ImGuiWindowFlags_NoMove |
        ImGuiWindowFlags_NoCollapse | ImGuiWindowFlags_NoBringToFrontOnFocus | ImGuiWindowFlags_MenuBar);

    if (ImGui::BeginMenuBar()) {
        if (ImGui::BeginMenu("File")) {
            if (ImGui::MenuItem("Reload from nexia-core") && !g_app.projPath.empty())
                core_load_project(g_app.projPath);
            ImGui::Separator();
            if (ImGui::MenuItem("Exit")) ImGui::GetIO().WantCaptureKeyboard = false, exit(0);
            ImGui::EndMenu();
        }
        if (ImGui::BeginMenu("Build")) {
            ImGui::MenuItem("Build (native loop lands here)", NULL, false, false);
            ImGui::EndMenu();
        }
        ImGui::EndMenuBar();
    }

    // reserve a status bar at the bottom
    const float statusH = ImGui::GetFrameHeightWithSpacing();
    const float availH  = ImGui::GetContentRegionAvail().y - statusH;

    static float leftW = 260.0f;
    static float outH  = 150.0f;
    const float fullW = ImGui::GetContentRegionAvail().x;

    // left: Solution Explorer
    ImGui::BeginChild("pane_tree", ImVec2(leftW, availH), true);
    panelTree();
    ImGui::EndChild();

    ImGui::SameLine(0.0f, 0.0f);
    vsplitter("##vsplit", &leftW, 160.0f, fullW - 260.0f);
    ImGui::SameLine(0.0f, 0.0f);

    // right column: editor over output
    ImGui::BeginChild("pane_right", ImVec2(0, availH));
    {
        const float rightH  = ImGui::GetContentRegionAvail().y;
        const float editorH = rightH - outH - 6.0f;
        ImGui::BeginChild("pane_editor", ImVec2(0, editorH > 40 ? editorH : 40), true);
        panelEditor();
        ImGui::EndChild();

        hsplitter("##hsplit", &outH, 60.0f, rightH - 60.0f);

        ImGui::BeginChild("pane_output", ImVec2(0, 0), true);
        panelOutput();
        ImGui::EndChild();
    }
    ImGui::EndChild();

    // status bar
    ImGui::Separator();
    ImGui::TextDisabled("SDK: %s", u8(g_app.sdkRoot).c_str());
    ImGui::SameLine(0.0f, 24.0f);
    ImGui::TextDisabled("Project: %s", u8(g_app.projName).c_str());
    ImGui::SameLine(0.0f, 24.0f);
    ImGui::TextColored(kAccent, "nexia-core");
    ImGui::SameLine(0.0f, 2.0f);
    ImGui::TextDisabled("(native)");

    ImGui::End();
}

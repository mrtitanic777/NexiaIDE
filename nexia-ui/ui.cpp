/*
 * ui.cpp — see ui.h. Reads g_app (filled by core_bridge) and draws it.
 */
#include "ui.h"
#include "core_bridge.h"
#include "imgui.h"

void ui_draw() {
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
    if (ImGui::Button("Reload from nexia-core") && !g_app.projPath.empty())
        core_load_project(g_app.projPath);
    ImGui::SameLine();
    ImGui::TextDisabled("Loaded through nexia-core.exe \xE2\x80\x94 the same backend the Electron IDE uses.");

    ImGui::End();
}

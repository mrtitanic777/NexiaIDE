/*
 * ui.h — the ImGui UI. One entry point for now; as the layout grows into a real
 * IDE (tree | editor | output) this splits into per-panel files.
 */
#pragma once

// Build one ImGui frame: the current Nexia IDE UI.
void ui_draw();

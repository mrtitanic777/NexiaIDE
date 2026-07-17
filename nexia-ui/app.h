/*
 * app.h — the host: the window, the Direct3D 9 device, ImGui, and the frame
 * loop. It knows how to put pixels on screen and pump events; it does not know
 * what is drawn. The UI is passed in as a callback so the two stay independent.
 */
#pragma once

// Create the window + DX9 device + ImGui, then loop — calling draw() to build
// one ImGui frame per iteration — until the window closes. Returns the exit
// code. draw() runs between ImGui::NewFrame and ImGui::Render.
int app_run(void (*draw)());

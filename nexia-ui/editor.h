/*
 * editor.h — the editor pane.
 *
 * Loads a file's text, lets you edit it, and writes it back. Reading and writing
 * a file is generic work, not Xbox logic, so this touches the disk directly
 * rather than going through nexia-core — the backend is for the Xbox-specific
 * decisions, not for fopen.
 *
 * Plain multiline editing for now; syntax highlighting is a later upgrade.
 */
#pragma once
#include <string>

// Open a file into the editor (replacing whatever was there). No-op on failure.
void editor_open(const std::wstring& path);

// Save the current buffer back to its file. No-op if nothing is open.
void editor_save();

// True if the buffer has unsaved edits.
bool editor_dirty();

// Draw the editor pane contents (an ImGui frame is already in progress).
void editor_draw();

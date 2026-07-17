/*
 * builder.h — the native build loop.
 *
 * Drives a full build from the native UI without reimplementing the toolchain:
 * it asks nexia-core for the compile plan (`build args`), then runs each cl.exe /
 * link.exe / imagexex step through nexia-core's `tool run`, which resolves the
 * tool and sets the SDK environment. So the loop is native, but every
 * Xbox-specific decision (the argv, the tool paths, the env) stays in the C
 * backend — the same split the whole port follows.
 */
#pragma once
#include <string>
#include <functional>

// Build the project at `projectPath` for `config` (e.g. L"Debug"). Emits output
// lines to `sink` as each tool runs. Returns true on success. Synchronous for
// now — it blocks until the build finishes.
bool core_build(const std::wstring& projectPath, const std::wstring& config,
                const std::function<void(const std::string&)>& sink);

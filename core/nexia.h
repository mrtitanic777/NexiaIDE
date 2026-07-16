/*
 * nexia.h — nexia-core: the Xbox-specific logic, in C.
 *
 * This is the part of Nexia IDE that knows about the Xbox 360: where the SDK
 * lives, how to drive its compiler, how to talk to a devkit. None of it ever
 * needed Electron — the TypeScript it replaces imported only fs, path and
 * child_process — and none of it needs a UI. It exists as a standalone tool the
 * IDE spawns, exactly like extract_sdk.exe and the SDK's own cl.exe, so the
 * boundary is a process rather than an ABI: no node-gyp, no rebuild per Electron
 * version, and it can be run and tested from a shell with no app at all.
 *
 * WIDE STRINGS EVERYWHERE INSIDE, UTF-8 ONLY AT THE EDGE.
 * Windows' narrow API uses the ANSI code page, not UTF-8, so a path containing a
 * character outside it would be mangled the moment it round-tripped. Everything
 * here is wchar_t; json_str converts once, on the way out.
 *
 * WHAT THIS CANNOT KNOW.
 * The host supplies the facts only it has — Electron's resourcesPath, the
 * executable's directory — as arguments. C does the deciding; the caller does
 * the introspecting. That keeps this runnable outside the IDE.
 */
#ifndef NEXIA_H
#define NEXIA_H

#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

#define NX_PATH 1024

/*
 * Mirrors SdkPaths in src/shared/types.ts. Every field is derived from `root`,
 * but they are stored rather than recomputed because the caller reads them
 * individually and the TypeScript it replaces did the same.
 */
typedef struct {
    wchar_t root[NX_PATH];
    wchar_t bin[NX_PATH];
    wchar_t bin_win32[NX_PATH];
    wchar_t bin_x64[NX_PATH];
    wchar_t include[NX_PATH];
    wchar_t lib[NX_PATH];
    wchar_t doc[NX_PATH];
    wchar_t source[NX_PATH];
    wchar_t system[NX_PATH];
    int     bundled;    /* shipped with the IDE rather than installed system-wide */
} nx_sdk;

/* An SDK install's completeness. The installer produces a 'partial' when it runs
 * without VS2010 present: bin/ but no include/ or lib/. */
typedef enum { NX_SDK_NONE = 0, NX_SDK_PARTIAL, NX_SDK_FULL } nx_sdk_state;

/* Where the host wants us to look, beyond what we can work out ourselves. */
typedef struct {
    const wchar_t *custom;      /* an explicit path, highest priority. may be NULL */
    const wchar_t *resources;   /* Electron's resourcesPath. may be NULL */
    const wchar_t *exe_dir;     /* directory of the host executable. may be NULL */
} nx_hints;

/* ── toolchain.c ── */
int          nx_sdk_detect(const nx_hints *hints, nx_sdk *out);
nx_sdk_state nx_sdk_state_of(const wchar_t *root);
nx_sdk_state nx_sdk_detect_state(const nx_hints *hints, wchar_t *found_root, size_t cap);
int          nx_tool_path(const nx_sdk *sdk, const wchar_t *tool, wchar_t *out, size_t cap);
int          nx_bin_dirs(const nx_sdk *sdk, wchar_t dirs[3][NX_PATH]);
int          nx_missing_runtime(const nx_sdk *sdk, const wchar_t **missing, int cap);

/*
 * The environment an SDK tool must be spawned with: PATH, XEDK, INCLUDE, LIB.
 *
 * Returns a CreateProcess environment block — a run of NUL-terminated
 * KEY=VALUE strings ending in a second NUL. Caller frees with nx_env_free.
 * Returns NULL on failure.
 */
wchar_t     *nx_tool_env(const nx_sdk *sdk);
void         nx_env_free(wchar_t *block);

/* ── run.c ── */
/*
 * Spawn a tool with the SDK environment and collect its output.
 *
 * `out` receives everything the tool wrote to stdout and stderr, interleaved as
 * the console would show it; caller frees. Returns the exit code, or -1 if the
 * process could not be started.
 */
int nx_run(const wchar_t *exe, const wchar_t *args, const wchar_t *cwd,
           const nx_sdk *sdk, char **out);
int nx_cmd_tool(int argc, wchar_t **argv);

/* ── xex.c ── */
int nx_cmd_xex(int argc, wchar_t **argv);

/* ── project.c ── */
int nx_cmd_project(int argc, wchar_t **argv);

/* ── emulator.c / extensions.c / buildsystem.c ── */
int nx_cmd_emulator(int argc, wchar_t **argv);
int nx_cmd_extensions(int argc, wchar_t **argv);
int nx_cmd_build(int argc, wchar_t **argv);


/* ── util.c ── */
int  nx_exists(const wchar_t *path);
int  nx_is_dir(const wchar_t *path);
void nx_join(wchar_t *out, size_t cap, const wchar_t *a, const wchar_t *b);
void nx_copy(wchar_t *out, size_t cap, const wchar_t *src);

/* ── json.c — output only. We emit JSON; we never parse it. ── */
void nx_json_str(FILE *f, const wchar_t *s);   /* a quoted, escaped UTF-8 string */
void nx_json_field(FILE *f, const char *key, const wchar_t *val);
void nx_json_error(const char *msg);

#endif

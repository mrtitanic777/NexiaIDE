# nexia-core integration status

What of the C is wired into the IDE, and what is not. Kept honest: every claim
here is something that was run, not something that was reasoned about.

## Where this is going

Every command listed below is wired. The port is not finished, because the goal
is not "the ported parts are called" — it is **`src/main` in C, with `main.ts`
left as the bridge to the UI and nothing else behind it**.

The UI is explicitly out of scope and is its own project: 25,167 lines of
TypeScript, 3,727 of CSS and 1,170 of HTML cannot leave while Electron draws the
window, and Monaco is a browser application that gets replaced (Scintilla), not
ported. Nothing below touches it.

C or C++ both fine — same toolchain, no new runtime. **Not C#**: it drags in
.NET, which is the same class of dependency Electron is being dropped to escape,
and it is painful on Windows 7.

### What is left, in order

**1. `projectManager.ts` — 1,486 lines, but only ~568 of logic.**
918 lines are embedded C++ template text (`XBOX_APP_MAIN` 354, `HELLO_MAIN` 296,
`XUI_MAIN` 131, `XBLA_MAIN` 72, `STDAFX_H` 25). `getFileTree` is already
`core/project.c`. What moves:
  - `project templates` — the blobs and their metadata. **Generate the C from the
    TypeScript with a script; do not retype it.** Hand-escaping 918 lines of C++
    into C string literals is precisely where a silent typo ends up in somebody's
    new project, and it would not fail the build — it would compile something
    subtly wrong.
  - `project create` — token substitution (`__PROJECT__`, `__PROJECT_UPPER__`,
    `__PROJECT_SAFE__`), directories, the `sdkFiles` copy out of the user's own
    XDK, and writing `nexia.json`.
  - `project open` / `project save` — ~35 lines together.
  - Proven by: a parity test against `_ts-backup/projectManager.ts.bak`, which
    already exists, plus creating a real project and building it. Not fixtures.

**2. `vsImporter.ts` — 836 lines.** Needs an XML reader in C. `json_parse.c` is
334 lines and is the shape to copy. `.vcxproj`/`.vcproj` need a subset, not a
conformant parser.

**3. `discord.ts` (836) + `searchService.ts` (280).** Needs HTTPS. Use
**WinHTTP**, not raw schannel — it does TLS and ships on Windows 7. One trap:
WinHTTP defaults to TLS 1.0 there and Discord requires 1.2, so
`WINHTTP_OPTION_SECURE_PROTOCOLS` must be set explicitly. This is the first
dependency in this port that is not simply "more C".

**4. `buildSystem.ts` (1,166) + `emulator.ts` (606). Read this before starting
either.** These are not ports. They change what nexia-core *is*.

nexia-core is strictly one-shot: `main.c` dispatches, prints one JSON object,
exits; `run.c` drains a pipe to EOF, waits, then prints once at the end.
  - The Output panel shows compiler lines *as they happen*. A C-owned build loop
    on the current shape would show nothing for thirty seconds and then
    everything. It requires **streaming** — newline-delimited events read
    incrementally — and a long-lived process.
  - The GDB/MI session is stateful across many calls (token counter, pending
    callbacks, a live child held open). One-shot cannot hold it. nexia-core would
    have to become **resident**.
  - And moving the build loop reverses **"the C never spawns a compiler"**. That
    rule is why `build args` refuses `projectReferences`. Once C owns the loop
    that refusal stops being a guard and becomes a bug.

So step 4 breaks the rule that made this port clean — *TypeScript orchestrates
and spawns, C computes* — because there would be nothing left to orchestrate.
That is unavoidable at the destination, but it should be one deliberate decision
made after 1–3, not something discovered halfway through a build-loop port.

**5. `toolchain.ts` (628), `devkit.ts` (548), `extensions.ts` (288),
`sdkTools.ts` (177).** 1,641 lines that are already mostly shims over the C.
These collapse rather than port, once `main.ts` calls nexia-core directly.

`main.ts` (1,505) does not port. It is `BrowserWindow` and 105 `ipcMain`
handlers; it evaporates when Electron does, and not before.

## Wired in

| Command | Caller | Proven by |
|---|---|---|
| `sdk detect` | `toolchain.detect()` | `toolchain-parity.js` |
| `sdk state` | `toolchain.detectInstallState()` | `toolchain-parity.js` |
| `sdk tool` | `toolchain.getToolPath()` | `toolchain-parity.js` |
| `tool run` | `toolchain.getToolEnvironment()` | `env-parity.js` |
| `xex inspect` | the XEX inspector IPC handler | `xex-parity.js`, against real XDK samples |
| `project tree` | `projectManager.getFileTree()` | `project-parity.js` |
| `emulator pids` | `emulator.findPidsByName()` | `emulator-parity.js` |
| `emulator break` | `emulator.breakInto()` | `emulator-parity.js` |
| `emulator gdb` | `emulator.findGdb()` | `emulator-parity.js` |
| `emulator configured` | `emulator.isConfigured()` | `emulator-parity.js` |
| `extensions dir` | `getExtensionsDir()` | `extensions-parity.js` |
| `extensions list` | `getInstalled()` | `extensions-parity.js` |
| `extensions install` | `installFromFolder()` | `extensions-parity.js` |
| `extensions template` | `createTemplate()` | `extensions-parity.js` |
| `extensions uninstall` | `uninstall()` | `extensions-parity.js` |
| `extensions open` | `openExtensionsDir()` | one caller, ShellExecute either way |
| `build parse` | `buildSystem.parseToolOutput()` | `buildsystem-parity.js` (115 checks) + a real failing build |
| `build args` | `buildSystem.plan()` | `buildsystem-parity.js` (115 argv checks) + a real build, a real incremental skip and a real C2065 |
| `devkit connect` | `devkit.connect()` | `devkit-hardware.js`, against a real Corona RGH |
| `devkit volumes` | `devkit.getDrives()` | `devkit-hardware.js` |
| `devkit sysinfo` | `devkit.getSystemInfo()` | `devkit-hardware.js` |
| `devkit ls` | `devkit.listDirectory()` | `devkit-hardware.js` |

`build parse` was verified end to end, not just against fixtures: a real C2065
injected into `Projects\Demo\src\main.cpp` came back with the right file, the
right line (7), the right message, and the build correctly failed.

## Not wired in

Nothing. All 23 commands are called.

## On the `build args` blockers that used to live here

This file said `build args` was blocked by two things. Neither survived being
looked at properly, and both are recorded here because the reasoning was wrong
in a way worth not repeating.

**"nexia-core refuses `projectReferences`."** It does, and it should — resolving
a reference means building it, which means spawning, which is not ported. But
the TypeScript already builds references *before* any flag is computed, and
folds each dependency's libraries and includes into a flattened project. The
argv computation never sees a reference. So `plan()` hands nexia-core that
flattened project with `projectReferences` dropped, and the C never has to
resolve anything. The refusal is still there and still correct for anyone
calling `build args` from a command line; it is simply unreachable from the IDE.
The feature was never at risk.

**"The C emits a whole plan while `compile()` runs per source file."** True, and
irrelevant. The plan is a lookup table, not a script: each entry says what argv
one source needs, and the per-file loop still decides which entries are stale
enough to run. The loop did not need restructuring. What the swap actually
deleted was the argv construction inside `compile()`, `link()` and `archive()` —
not the loop around them.

The pattern in both: a real constraint on the C *alone* was mistaken for a
constraint on the C *called from TypeScript*. The line between them — TypeScript
orchestrates and spawns, C computes — is the same line drawn everywhere else in
this port, and it was already drawn here.

## On the performance argument that used to live here

An earlier version of this file excluded `project tree`, `sdk tool` and
`emulator configured` on the grounds that a process spawn costs ~20 ms against
an in-process call's ~0.01 ms.

That reasoning was wrong and the exclusions have been reversed. 20 ms is not
perceptible. Neither is the measured `project tree` regression (104 ms → 139 ms
on a 4,835-node tree — larger than any real project, and about a third of an eye
blink). Neither is `getToolPath` at 8 spawns per build, on a build that takes
seconds.

The measurements were real; the conclusion drawn from them was not. A ratio
between two numbers that are both far below the threshold of perception is not
an argument for anything. The only thing those measurements establish is that
the C scan is not *faster* — which is a reason not to expect a speedup, not a
reason to keep a second implementation of the ignore rules and the sort alive in
another language.

If something is excluded from this file in future, the reason must be functional
(as `build args` is), not a latency figure nobody can feel.

## A note on the tests

Worse than a test that falsely accuses working code is a test that agrees with
it for the wrong reason. When `build parse` was wired in, `buildsystem-parity.js`
kept driving the live `runTool` — which by then called nexia-core. For one commit
it compared `build parse` against `build parse`, printed "match" three times a
run, and proved nothing. Both halves now drive the `_ts-backup` copy that still
does the work in TypeScript, which is the only thing either half can honestly be
compared against.

Five separate times during this work a test reported a failure in code that was
correct:

- `git show` (LF) compared against the working tree (CRLF) → false "MODIFIED"
- agent files diffed against the wrong base commit
- a global regex over `tasklist` CSV matching `"Console","1"` as a second pid
- a probe writing to `$HOME` (`/c/SPB_Data` under Git Bash) instead of
  `os.homedir()` — every fixture landed where nothing reads, and it looked like
  8 JSON disagreements and a broken `extensions list`
- an error injected above `#include "stdafx.h"` in a `/Yu` translation unit,
  which MSVC discards by design — it looked like the build was swallowing errors

Every time, the code was right. When a test disagrees with something that passes
115 checks, suspect the test first.

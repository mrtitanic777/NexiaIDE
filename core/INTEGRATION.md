# nexia-core integration status

What of the C is wired into the IDE, and what is not. Kept honest: every claim
here is something that was run, not something that was reasoned about.

## Where this landed

The rule this port settled on is *TypeScript orchestrates and spawns; C
computes.* Applied consistently, it has a natural finish line, and we are at it:
**every piece of compute logic in `src/main` is in C and wired.** What remains in
TypeScript is orchestration and the Electron shell, which the rule says stay in
the orchestrator — not in the spawned tool.

### Done — the compute, in C and wired

- `toolchain` — SDK detect/state/tool/runtime, tool env
- `xex` — the header parser
- `projectManager` — the tree, templates, create/open/save (save stays
  `JSON.stringify`: `jv_write` is byte-identical, so routing a live object
  through the C would serialise twice for the same bytes)
- `vsImporter` — `.sln`, `.vcxproj`, `.vcproj`, project-reference resolution
- `buildSystem` — the compiler/linker **argv** (`build args`) and the output
  **parser** (`build parse`)
- `emulator` — process discovery, break-in, gdb-locate, configured-check
- `extensions` — list/install/template/uninstall/dir
- `devkit` — the XBDM client
- `search` — YouTube/Brave/Google, over `core/http.c` (WinHTTP, TLS 1.2 forced)

### Not ported — and why they stay in the orchestrator

These are not unfinished. They are orchestration or shell, which the governing
rule keeps out of nexia-core-the-spawned-tool. Under the "no TypeScript" end
goal they are rewritten in the **native UI app**, alongside the renderer — not
added to nexia-core as more one-shot commands.

- **`buildSystem.ts` build loop (~600 lines).** It loops over sources, spawns
  `cl.exe`, streams the Output panel, links, runs ImageXex/XuiPackage, and builds
  project references first. That *is* orchestration and spawning. Moving it into
  nexia-core would invert the rule the port is built on and re-open "the C never
  spawns a compiler" (the guard behind `build args` refusing `projectReferences`).
  C already computes the argv and parses the output; the loop around them is the
  orchestrator's.
- **`emulator.ts` GDB/MI session (~400 lines).** A resident, stateful wrapper
  over a live gdb process — token counter, pending-callbacks map, breakpoints —
  where every step/breakpoint/read hits the same held-open child. A one-shot C
  command cannot hold it; it would need nexia-core to become a daemon, for logic
  that is a counter and a map. Near-zero value, high cost.
- **`discord.ts` (836).** A local OAuth callback server on 127.0.0.1, token
  exchange and an object holding the access token across calls. Desktop
  integration orchestration, with no clean compute to extract.
- **`main.ts` (1,505).** `BrowserWindow` and the `ipcMain` handlers. The Electron
  shell. It does not port; it evaporates when Electron does.

### The shims

`toolchain.ts` (628 → shim), `devkit.ts` (548), `extensions.ts` (288),
`sdkTools.ts` (177) are already thin fronts over the C. They collapse further
only when `main.ts` calls nexia-core directly — which is part of dropping
Electron, not a nexia-core task.

### The end goal beyond this

"No Electron, no TypeScript" needs the orchestration layer and the ~30k-line UI
(renderer + CSS + HTML, Monaco replaced by Scintilla) rewritten as a native
C/C++ app. That is a separate, ground-up project. The build loop and the gdb
session move *there*, into native orchestration code — not into nexia-core. C or
C++ both fine; **not C#** (drags in .NET, the same class of dependency Electron
is being dropped to escape, and painful on Windows 7).

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

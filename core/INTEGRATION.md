# nexia-core integration status

What of the C is wired into the IDE, and what is not. Kept honest: every claim
here is something that was run, not something that was reasoned about.

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
| `devkit connect` | `devkit.connect()` | `devkit-hardware.js`, against a real Corona RGH |
| `devkit volumes` | `devkit.getDrives()` | `devkit-hardware.js` |
| `devkit sysinfo` | `devkit.getSystemInfo()` | `devkit-hardware.js` |
| `devkit ls` | `devkit.listDirectory()` | `devkit-hardware.js` |

`build parse` was verified end to end, not just against fixtures: a real C2065
injected into `Projects\Demo\src\main.cpp` came back with the right file, the
right line (7), the right message, and the build correctly failed.

## Not wired in

**`build args`** — the only one left, and the reason is functional, not
performance.

nexia-core refuses a project with `projectReferences`, because resolving a
reference means building the referenced project, which means spawning a
compiler — deliberately not ported. The TypeScript supports them. No project on
this machine uses one, but "no project I looked at uses it" is not "the feature
does not exist", and swapping would silently drop it.

The port itself is sound: all 115 argv checks pass across Debug, Release,
Profile and Release_LTCG, with PCH on and off and exceptions on and off. What
blocks it is shape, not correctness — the C emits a whole build plan up front
and `buildSystem.compile()` is called per source file. Wiring it means
restructuring the build loop, and that is worth doing deliberately rather than
as a footnote to a parser swap.

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

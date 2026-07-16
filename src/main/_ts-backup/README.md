# TypeScript kept during the move to C

Each file here is the last TypeScript version of a module whose behaviour now
comes from `nexia-core.exe`. They are kept for one reason: if the C turns out to
be wrong on a machine that isn't this one, the fix is to restore a file, not to
debug C in production.

They are **not** a fallback the code selects at runtime. Nothing imports them.
A silent fallback would mean two implementations both live and only one tested,
and the bug would be in whichever one you weren't looking at.

Delete a file here once its C counterpart has survived a release.

| file | replaced by | proven by |
|---|---|---|
| `toolchain.ts.bak` | `core/toolchain.c` | `core/test/toolchain-parity.js`, `env-parity.js` |
| `parseXex.ts.bak` | `core/xex.c` | `core/test/xex-parity.js` — which compares against this file, so deleting it retires the test |
| `emulator.ts.bak` | `core/emulator.c` | `core/test/emulator-parity.js` |
| `extensionsManager.ts.bak` | `core/extensions.c` | `core/test/extensions-parity.js` |
| `projectManager.ts.bak` | `core/project.c` (`getFileTree`) | `core/test/project-parity.js` |
| `buildSystem-parser.ts.bak` | `core/buildsystem.c` (`build parse`) | `core/test/buildsystem-parity.js` — 115 checks, plus a real C2065 through a real build |
| `devkit.ts.bak` | `core/devkit.c` | `core/test/devkit-hardware.js`, against a real Corona RGH |

Several of these are whole-file copies where only part of the file moved:

- `emulator.ts.bak` — `findPidsByName`, `breakInto`, `findGdb` and `isConfigured`
  are C; the GDB/MI session is still live TypeScript.
- `projectManager.ts.bak` — only `getFileTree` moved.
- `buildSystem-parser.ts.bak` — only the output parser moved. `build args` has
  not been wired in; see `core/INTEGRATION.md` for why.
- `extensionsManager.ts.bak` — the filesystem half is C; manifest parsing stays
  in TypeScript deliberately, because nexia-core reports where a manifest is and
  never reads it, so there is no second JSON reader to disagree with
  `JSON.parse`.

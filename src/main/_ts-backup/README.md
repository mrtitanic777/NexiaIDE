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
| `buildSystem-parser.ts.bak` | `core/buildsystem.c` (`build parse`) | `core/test/buildsystem-parity.js` — which compares against this file, so deleting it retires the parser half |
| `buildSystem-args.ts.bak` | `core/buildsystem.c` (`build args`) | `core/test/buildsystem-parity.js` — which compares against this file, so deleting it retires the argv half. 115 checks, plus a real build and a real C2065 |
| `devkit.ts.bak` | `core/devkit.c` | `core/test/devkit-hardware.js`, against a real Corona RGH |

Several of these are whole-file copies where only part of the file moved:

- `emulator.ts.bak` — `findPidsByName`, `breakInto`, `findGdb` and `isConfigured`
  are C; the GDB/MI session is still live TypeScript.
- `projectManager.ts.bak` — only `getFileTree` moved.
- `buildSystem-parser.ts.bak` — the state of the file before the output parser
  moved, and the parity test's reference for the parser half.
- `buildSystem-args.ts.bak` — the state of the file before `compile()`, `link()`
  and `archive()` stopped building their own command lines, and the parity test's
  reference for the argv half. Two whole-file copies of the same module at two
  points in its life; each is the last TypeScript that really did the job its
  half of the test checks. Both are needed, because `buildsystem-parity.js`
  cannot compare the live file against anything — it now asks nexia-core for both
  the flags and the parse, so driving it would compare the C against itself.
- `extensionsManager.ts.bak` — the filesystem half is C; manifest parsing stays
  in TypeScript deliberately, because nexia-core reports where a manifest is and
  never reads it, so there is no second JSON reader to disagree with
  `JSON.parse`.

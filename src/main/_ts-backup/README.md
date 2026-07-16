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

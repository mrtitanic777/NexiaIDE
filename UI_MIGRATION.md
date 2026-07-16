# UI Migration Plan — Electron/TypeScript → Native C/C++

The nexia-core port moved every piece of *compute* logic out of `src/main` into C.
This document is the plan for the other half: the ~30,000-line **UI**, off Electron
and TypeScript entirely, into a native C/C++ application.

This is a separate, larger effort than the whole nexia-core port. Written down so
it is engaged deliberately, in phases, not as a big-bang rewrite.

## The decision (fixed)

- **No Electron, no TypeScript.** The end state is a native `nexia-ui.exe`.
- **Windows 7 must keep working.** This rules out WebView2 (Win10+), C#/.NET, and
  modern XAML. It rules *in* Win32 + a DX9-class renderer, which Win7 supports.
- **Keep the skins.** Blade / Devkit / Phosphor are 3,727 lines of CSS restyling
  the whole interface. No native-widget toolkit (wx/Qt) restyles like that, so the
  UI must be **custom-drawn**.
- **Not C#.** Same reason as the backend port: .NET is the class of dependency
  Electron is being dropped to escape.

### Toolkit direction

Custom-drawn + Win7 + animation-heavy (the cinematic engine redraws per frame)
points at **Dear ImGui on a DX9 backend** for the shell, with **Scintilla**
embedded as the actual code editor (a native HWND child), and **Direct2D/GDI+**
for the canvas-style visualizers. This is:

- Win7-native (DX9 is ideal for Win7; GDI+ is universal).
- Tiny — no large runtime, matching the reason Electron is being dropped.
- Fully custom-drawable, so the skins survive.
- Not an attempt to rebuild a Monaco-class editor from scratch — Scintilla is the
  native code editor (Notepad++, SciTE), and it is a linked component, not a
  rewrite.

The alternative — wxWidgets/Qt with native widgets — is faster to a working IDE
but cannot carry the skins, so it was rejected per the decision above. Revisit
only if the skins are dropped.

## Architecture: the UI calls nexia-core *directly*

This is the payoff of the backend port. Today the flow is:

    renderer (TS) → Electron IPC → main (TS shim) → spawn nexia-core.exe → JSON

The native UI collapses the middle entirely:

    nexia-ui (C/C++)  →  nexia-core functions, called directly

**`core/*.c` becomes a library linked into `nexia-ui.exe`.** No IPC, no process
spawn, no JSON round-trip — the UI calls `nx_sdk_detect`, `nx_cmd_build`'s
internals, the project reader, the importer, etc. as C functions.

Keep the `nexia-core.exe` wrapper too: the parity suites drive the shipping
binary, and that is how the backend stays verified. So the split is:

- `core/*.c` — the logic, built both as a **static lib** (linked into nexia-ui)
  and as **nexia-core.exe** (for the tests and any remaining shell use).
- `nexia-ui.exe` — the shell, links the lib.

The commands that were shaped for a one-shot CLI (JSON in, JSON out) get a
second, in-process entry point that returns structs instead of printing JSON.
Most already have one under the `printf` (e.g. `nx_sdk_detect` fills a struct;
`cmd_sdk` just prints it). Those are reused directly; the rest get factored the
same way.

## Inventory — the 25,173 lines of renderer, by difficulty

### Bucket A — mechanical native widgets (~30%)
Standard IDE chrome. Tedious, not hard. Custom-drawn but conventional.
- `app.ts` (6,294) — the shell, *in part*: window, menu bar, tab strip, panel
  layout, the tour/tips. (The Monaco and orchestration parts split out — see C/D.)
- `panels/fileTree.ts` (672) — Solution Explorer. Backend (`project tree`) is
  already C; this is a native tree view over it.
- `panels/projectProperties.ts` (506) — the VS2010-style property pages. A native
  tabbed dialog over `nexia.json` fields.
- `editor/searchPanel.ts` (266), `xexInspector.ts` (220, backend already C),
  `projectExport.ts` (63), `ui/contextMenu.ts` (44), `icons.ts` (175 → native
  icon atlas).

### Bucket B — logic that moves to C, barely UI (~15%)
Not really "UI" — moves to C the way `src/main` did.
- `learning/learningProfile.ts` (928) — mastery tracking, **spaced repetition**.
  Pure algorithm. Straight to C.
- `git.ts` (1,847) — git operations: spawn git, parse output. The same shape as
  the toolchain/devkit spawn layers already in C. The *panel* is UI (Bucket A);
  the operations are C.
- `learning/cinematicLessonData.ts` (391), `quizzes.ts` (292), `cinematicConfig.ts`
  (132), `cinematicStyles.ts` (176) — data and config. Become C tables /
  resource files, like `templates.c`.
- `appContext.ts` (101) — the shared-state bridge; disappears (native has direct
  state).

### Bucket C — network half → C (`http.c` exists), UI half native (~25%)
The port already built `core/http.c` (WinHTTP, TLS 1.2). These are its customers.
- `ai/aiService.ts` (1,900) — AI chat, streaming, markdown→DOM. Network to C
  (http.c, streaming); the chat view is native custom-drawn text.
- `admin/adminPanel.ts` (1,716) — server admin. Network to C; native forms/lists.
- `auth/authService.ts` (989) + `authUI.ts` (450) — accounts, cloud sync. Network
  to C; native login/settings forms.
- `panels/communityPanel.ts` (802) + `learnDiscover.ts` (273) — Discord feed,
  lesson browsing. Network to C; native lists. (Discord OAuth is the local-server
  flow flagged in INTEGRATION.md — it stays orchestration, now native.)

### Bucket D — hard: custom rendering & animation (~30%)
The genuinely difficult part. Where the months go.
- **The editor** — Monaco (56 refs across the renderer) → **Scintilla**, plus
  rebuilding on top of it: XDK API IntelliSense, C++ syntax highlighting, inline
  AI hints, the tab/document model. Scintilla gives the text editing; the IDE
  intelligence layered on Monaco is real work to reproduce.
- `learning/cinematicEngine.ts` (1,446) + `cinematicVisualizers.ts` (506) — the
  typing animations, token reveals, connection diagrams. Per-frame canvas
  animation. Immediate-mode (ImGui) suits this, but it is bespoke.
- `visualizer/codeVisualizer.ts` (1,286) — flow charts, class diagrams, memory
  layouts on Canvas 2D → **Direct2D** native drawing.
- **The skins** — `main.css`'s 3,727 lines, 149 skin-specific. Custom-drawn
  theming (blades, scanlines, brushed metal) is a large amount of rendering code,
  spread across every widget.
- `learning/lessonSystem.ts` (1,100), `lessonLoader.ts` (583), `genesisEngine.ts`
  (531), `learning.ts` (506) — the lesson runtime and the AI lesson generator.
  Logic-heavy but wired into the animated presentation.

## Phases

Each phase is independently useful — the IDE is usable earlier than it is
complete, and each phase de-risks the next.

**Phase 0 — Spike (≈1 week, throwaway-if-needed).**
A minimal `nexia-ui.exe`: a Win32/DX9/ImGui window that embeds Scintilla, loads a
real `.cpp`, draws the file tree for a real project, and **opens and builds
CaveGame2 by calling nexia-core directly**. Proves the two hardest foundations —
the native editor and the native↔core link — before committing. If it feels
wrong, one week lost, and the backend is reused regardless.

**Phase 1 — The core IDE loop.** Shell (window, menus, tab strip, panel layout),
Scintilla with C++/XDK highlighting, file tree, output panel, Build (F7) / Run /
Deploy driving nexia-core. Result: a native IDE you can *edit and build* in.
Skins minimal (one default look).

**Phase 2 — Project lifecycle.** New / Open / Close / Import (all backends already
C), project properties, recent projects, the welcome screen. Result: full project
management, native.

**Phase 3 — The skins.** The custom-drawn theming layer: Blade, Devkit, Phosphor,
plus the colour presets. The signature feature, deferred until the widgets it
restyles exist.

**Phase 4 — Editor intelligence.** XDK IntelliSense, inline AI explain/fix/refactor
(AI over http.c), the code visualizer (Direct2D).

**Phase 5 — Accounts & community.** AI chat, auth/cloud sync, community/Discord,
admin — network via http.c, native UI.

**Phase 6 — The cinematic learning system.** The animation engine, visualizers,
lessons, Genesis Lab. Largest and last; a candidate to keep optional or to be the
final milestone.

## Honest risks

- **Scope.** This is larger than the entire nexia-core port. Months of focused
  work, and Phase 6 alone rivals a small app.
- **The editor.** Scintilla is the easy 20%; the XDK IntelliSense and AI-hint
  layer that made the Monaco editor valuable is the hard 80%, and it is a rebuild.
- **The skins in custom-drawn UI** are a lot of per-widget rendering code —
  keeping them was a deliberate, expensive choice.
- **The cinematic engine's polish** is hard to match pixel-for-pixel natively.

## What does NOT get rewritten

- **nexia-core** — done. It becomes the UI's backend, called directly.
- **The installer** — already pure C/Win32.
- **The parity test suites** — they keep driving `nexia-core.exe`, unchanged.

## Governing rule (carried from the backend port)

*The UI draws and orchestrates; nexia-core computes.* The same line that kept the
backend port clean applies here: presentation and event handling live in
`nexia-ui`; anything that decides an Xbox-360 fact (SDK paths, build args, XEX
layout, importer results) stays in `core/*.c` and is called, not reimplemented.

# Changelog

## v2.2.2

### Fixed
- **Updates can now actually install themselves.** The update downloaded and verified correctly, then failed at the last step with `EACCES` and an Electron crash dialog. The installer's manifest requests administrator, and the launch went through `child_process.spawn` → `CreateProcess`, which cannot elevate — Windows rejects it with `ERROR_ELEVATION_REQUIRED`, surfaced as `EACCES`. The installer is now launched via the shell (`ShellExecute`), which raises the UAC prompt properly.
- **A failed install now reports itself instead of crashing.** `spawn` signals failure through an asynchronous `error` event rather than throwing, so the surrounding `try/catch` never saw it and Node escalated it to an uncaught exception. The launch path is promise-based now, so any failure is shown in the update dialog.

> Because 2.2.0 and 2.2.1 both carry the broken launch step, this build has to be installed by hand once. Updates from 2.2.2 onward install themselves.

## v2.2.1

### Fixed
- **Discord community works for everyone.** Signed-in users now receive the bot configuration from the Nexia server, so the forum feed and membership check work on every machine — not just one that had been configured by hand. Previously the server returned empty credentials, leaving everyone else with an empty Community panel.
- **Lesson Builder: blocks added after loading a lesson couldn't be positioned.** A newly added block had no layout entry, so the preview drew no rectangles at all — not even its spotlight — and the coordinate editors never appeared.

### Added
- **Token-level layout in the Lesson Builder.** Each token explanation can have its spotlight and mini-panel placed by hand via `◎ Place`, and the cinematic engine honours those baked positions at playback. Tokens without a placement keep auto-positioning.
- **Connection-level layout.** A connection's source and destination spotlights can be placed independently of the block spotlight they'd otherwise inherit.

As with block layout, the authored **x, width and panel height** are used while the **vertical position stays live**, so spotlights keep tracking their code line as it scrolls.

## v2.2.0

### Interoperability
- **Visual Studio import** — `File → Import from Visual Studio (.sln)`. Reads `.sln` solutions and both project formats the Xbox 360 XDK shipped against (`.vcxproj` MSBuild and legacy `.vcproj`), and maps them onto a Nexia project: sources, headers, include directories, library directories, libraries, preprocessor defines, precompiled header, RTTI, exception handling, warning level, optimization and configuration type. Multi-project solutions let you choose which project to bring over. Source files are **copied, never moved**, so the original VS project keeps building. A preview shows exactly what will be imported — including anything deliberately skipped — before a single file is written.

### Appearance
- **Structural skins** — three selectable skins that restyle the interface itself rather than recolouring it (`Settings → Appearance`):
  - **Blade** — the 2005 Xbox 360 dashboard: curved sliding blades, ring-of-light glow, deep green field.
  - **Devkit** — the IDE as hardware: brushed chassis, machined bezel, keycap rail, status LEDs, recessed screen.
  - **Phosphor** — CRT terminal brutalism: monospace throughout, hard 1px rules, scanlines and phosphor bloom.
- Colour presets still apply on top of any skin.

### Learning
- **Curriculum lesson viewer** — the built-in 8-module / 17-lesson curriculum is now playable. Steps through text, code, exercises (with hints and solutions), quizzes and visualizations, and records real progress against the adaptive learning profile.
- **Progress now actually tracks** — quizzes and lesson completion feed the mastery model (previously `recordInteraction`/`recordLessonProgress` were never called by anything).
- **Cloud lessons** — browse, download and update published lessons from the Learn panel, with version-aware update badges and a startup notice.
- **Progress sync** — the learning profile syncs to your Nexia account and merges across devices (monotonic field-wise merge, so two machines can't clobber each other).

### Software updates
- **Built-in updater** — the IDE checks a release manifest on the Nexia server and shows a release popup with the version, headline and changelog. Downloads report live progress and are **SHA-256 verified before anything is executed** — a mismatch is rejected.
- **Admin → Releases** — publish or pull a release from inside the IDE.

### Fixes
- **You stay signed in.** Sessions expired after 2 hours (`TOKEN_EXPIRY: '2h'`), and on expiry the client deleted its token file — losing your identity as well as your session. Tokens now last 30 days and the last account is remembered separately (username/email only, no secrets).
- **Welcome-back prompt** — signed-out users get a "sign in as *you* / different account / continue without an account" choice with the trade-offs spelled out. Signed-in users are only ever interrupted by a release popup.
- **Discord membership** — the IDE claimed you hadn't joined the Nexia server when you had. The check read the *user's* OAuth guild list (which silently fails without the `guilds` scope or with an expired token) and treated "couldn't check" as "not a member". Membership is now confirmed via the bot, and an undetermined result never nags.
- **Server Settings** was unreachable from the account menu.
- **Build from a path containing spaces** — `build-portable.js` invoked `electron-builder` unquoted, breaking any project path with a space in it.

### Security
- Update downloads are SHA-256 verified against the signed manifest before execution.
- Non-HTTPS download URLs are refused.
- Hardened login lockout (per-email serialization) and transactional registration.

## v2.1.0

### Compatibility
- **Windows 7/8/8.1 support** — pinned to Electron 22 (Chromium 108, Node.js 16), the last version with Windows 7 support. All IDE features work identically across Windows 7 through Windows 11.

### Installer
- **Native Win32 installer** — custom dark-themed wizard UI with welcome screen, license agreement, directory picker, component selection, animated progress bar, Start Menu and Desktop shortcuts, file associations, and Add/Remove Programs registration.
- **Self-extracting payload** — the installer packs the entire Electron app as a binary payload appended to the EXE. No NSIS, no WiX, no external frameworks.
- **`build-installer.bat`** — one-click script that compiles TypeScript, runs electron-builder, compiles the native installer with MinGW, and packs everything into `NexiaSetup.exe`.

## v2.0.0

### Architecture
- **TypeScript rewrite** — entire codebase ported from C/Win32 to TypeScript/Electron (18,000+ lines across 21 source files).
- **Modular decomposition** — `app.ts` decomposed into focused modules: `aiService.ts` (1,600 lines), `xexInspector.ts`, `searchPanel.ts`, connected via `appContext.ts` shared state bridge.
- **Monaco editor** — replaced custom text editor with Monaco (VS Code's editor core) with Xbox 360 C++ syntax highlighting and IntelliSense.

### AI Tutor Intelligence
- **Adaptive system prompt** — AI receives structured tutor context with categorized mastery levels, current lesson position, recent activity history, and time-since-last-session awareness.
- **Proactive tutoring** — AI automatically congratulates lesson completions, explains quiz failures, welcomes learners back after breaks, and helps diagnose build errors.
- **AI-triggered visualizations** — AI responses containing `[VIZ:...]` tags automatically render diagrams in the Visualizer panel.
- **Multi-provider support** — Anthropic, OpenAI, Ollama, and custom endpoint support with SSE streaming.

### Learning System
- **8-module curriculum** — expanded from 4 modules / 6 lessons to 8 modules / 17 lessons / 55+ content items covering: Getting Started, Control Flow, Functions, Pointers & Memory, Data & I/O, Arrays & Collections, Classes & OOP, Xbox 360 Specifics (Xenon architecture, D3D9, XInput).
- **Adaptive learning profile** — tracks mastery across 30 concepts (including 5 new Xbox 360 concepts) with spaced repetition, pattern analysis, and per-concept history.
- **Genesis Lab** — self-evolving AI lesson engine that generates lessons, critiques them, and refines through iterative evolution. Persistent across sessions with auto-save to `~/.nexia-ide-genesis.json` and HTML export.

### Code Visualizer
- **Ported from Direct2D to Canvas 2D** — cross-platform rendering with the same visual quality.
- **Flow chart renderer** — auto-layout with diamonds for decisions, pills for start/end, rectangles for processes, edge labels for branches.
- **Class diagram renderer** — UML-style boxes with name header, members section, methods section, and inheritance arrows.
- **New commands** — `FLOW:`, `IF:`, `LOOP:`, `CLASS:`, `INHERIT:` added to the visualization command parser.
- **Convenience methods** — `visualizeIfElse()`, `visualizeLoop()` for quick diagram generation.

### IDE
- **XEX Inspector** — parse and display Xbox 360 executable headers, base address, entry point, imports, and exports.
- **Find in Files** — project-wide search with regex support, extracted as standalone module.
- **AI settings dialog** — multi-provider configuration with API key management.
- **AI hint bar** — context menu actions for explain, fix, refactor, optimize, and generate on selected code.

## v1.1.0

### Build System
- Incremental compilation — only recompiles changed source files.
- Parallel compilation — up to 4 files concurrently.
- Response file for linker — fixes command line length errors on large projects.
- Case-insensitive source dedup and object name collision detection.
- Stale source file cleanup on project open.

### Project Properties
- New Project Properties dialog with persistent per-project compiler and linker settings (RTTI, exception handling, warning level, additional flags).

### Editor
- Find & Replace in Files with confirmation and live tab updates.

### Workspace
- Workspace state persistence (open tabs, expanded folders, sidebar/panel visibility).
- File type filtering and multi-file selection on import.
- Hidden project config files in explorer.

### Bug Fixes
- Fixed UTF-8 encoding corruption across all source files.
- Fixed build output double-spacing.
- Fixed `getSystemInfo` sending XBDM commands repeatedly.
- Fixed `listVolumes` using blind setTimeout instead of response marker detection.
- Fixed hardcoded IPC strings for project export/import.
- Fixed `elapsed()` centisecond calculation.

### Security Fixes
- Fixed command injection in project export/import and extension extraction.
- Added URL validation for Discord download handler.
- Replaced non-null assertions with proper null checks.

## v1.0.0

Initial release.

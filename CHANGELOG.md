# Changelog

## v2.2.7

### Fixed
- **The AI is no longer prompted when you open the IDE.** Startup fired a "welcome back" request at the model before you had typed anything, spending tokens on an API you pay for per call. v2.2.6 only *hid* the prompt text, so the reply still arrived — with no visible cause — and the tokens were still spent. The request is gone now, not hidden.
- **A failed build no longer sends your errors to the AI.** It did this on every failure whether or not you wanted an explanation. There was already an `aiAutoErrors` setting for exactly this and the code never read it. Ask deliberately from the AI panel's Errors tab instead.
- **The source tree opens expanded.** "Header Files" and "Source Files" were built collapsed and nothing ever opened them, so every project open needed two clicks to reach your own code.
- **`nexia.json` is hidden from the file tree.** It's the project's own config, written by the IDE through Project Properties. Still on disk — just not in the tree.
- **Profile builds linked the wrong libraries.** The linker picked libs with a simple `isDebug ? … : …`, but the Xbox 360 SDK ships four flavours, not two — so Profile silently linked the Release libraries instead of the instrumented ones (`xapilibi`, `d3d9i`, `xact3i`, `xmcorei`).

### Added
- **Release_LTCG builds.** The configuration didn't exist at all: `/GL` when compiling, `/LTCG` when linking, and its own `ltcg` libraries.
- **Per-configuration settings for imported projects.** All four Visual Studio configurations are read now, so switching to Release or Release_LTCG links *that* configuration's libraries — including the matching build of a referenced library — instead of whichever set Debug happened to import.
- **Solution Explorer.** An imported project shows the solution it came from, the other projects in it, and whether each dependency actually resolved — so a missing one is visible before the link fails rather than after. External Dependencies lists what's handed to the linker for the current configuration.
- **Editor colour customisation** — Settings → Appearance → Code Colors. Comments, keywords, strings, numbers, types, functions, variables and preprocessor, with live preview and a reset.

## v2.2.6

### Fixed
- **Updating no longer deletes your extracted Xbox 360 SDK.** Installing an update cleared the program folder first, and the SDK lives inside it — so several GB vanished and had to be extracted again. Updates leave it alone now; uninstalling still removes it.
- **Nexia IDE reopens itself after an update** instead of closing and staying closed. Setup only restarts the app when told to, and the IDE wasn't telling it.
- **The AI tutor no longer shows its own instructions in the chat.** Its prompts to itself — `[SYSTEM: The learner is returning after 3 days away…]` — were rendered as though you had typed them.

## v2.2.5

### Fixed
- **The AI chat input no longer scrolls away while the model is answering.** The AI panel had no rule of its own, so it inherited `.panel-body` — `flex: 1; overflow-y: auto`, which is written for the file tree. That made the *whole* panel scroll: mode tabs, status bar, transcript and the input box together. The input drifted off the bottom as output streamed and you had to scroll to keep up with it. The panel is now a fixed-height flex column, so the transcript is the only scrolling region and the input stays pinned to the bottom.
- **AI chat auto-scroll now works.** It was never actually broken: the code sets `scrollTop` on `#ai-messages` in five places while streaming, but that element had no overflow — the scrollbar was on the panel — so every one of those calls silently did nothing. With the transcript as the real scroll container, the view follows the output on its own.

### Changed
- **The installer is built with NSIS now** rather than by hand. It is **79.5 MB instead of 150.4 MB**: NSIS compresses with LZMA solid, while the old installer used LZNT1 — Windows' NTFS compression, which works in independent 4 KB blocks and so cannot find repetition beyond them.

## v2.2.4

Nexia IDE now installs per-user and updates itself without a UAC prompt, the way Chrome, Discord and VS Code (User Setup) do.

### Changed
- **Installs to `%LOCALAPPDATA%\Programs\NexiaIDE` instead of `C:\Program Files\NexiaIDE`.** Program Files is only writable by an administrator, which is what forced every single update through a UAC prompt. A per-user location is writable by the person using it, so updates need no elevation at all. The installer's manifest is now `asInvoker` rather than `requireAdministrator`.
- **The Add/Remove Programs entry is written to `HKCU`, always.** It previously tried `HKLM` first and fell back to `HKCU` "if no admin rights", so the hive depended on how setup happened to be launched. A per-user install advertised machine-wide would appear for every user on the PC while pointing into one user's private directory.
- **Existing `C:\Program Files` installs are migrated automatically.** The new install goes to the per-user location and the old copy is retired afterwards. Retiring Program Files needs administrator, so this costs one UAC prompt — once, on the upgrade that migrates the machine. Never again after that. If the prompt is declined, the old copy simply stays on disk; the new install already works.

### Fixed
- **An update could uninstall the IDE and leave nothing installed.** When setup found an existing install it showed a prompt whose `Yes` meant "uninstall and exit". During an update that reads naturally as "yes, replace the old files" — choosing it removed Nexia IDE and quit. Updates are now silent and never show this prompt at all; the interactive wording has been reversed so `Yes` means *update* and the destructive choice is explicit.
- **Updates install themselves with no clicks.** Setup accepts `/S`, and the IDE uses it.
- **A silent update could overwrite files the running IDE still had open.** The wizard never hit this because a human takes seconds to click through, by which time the app has exited; silent mode starts extracting immediately. Setup now waits for the previous copy to release its files before extracting.
- **`/uninstall` was matched against the whole command line, including the EXE path.** Any user whose path contained `/uninstall` or `-uninstall` would have had setup silently uninstall instead of install. Arguments are tokenised properly now.

## v2.2.3

### Fixed
- **The installer reported the wrong version.** `NXI_APP_VERSION` was a hand-maintained `#define` in `installer.h` that had drifted to `2.1.0`. It feeds both the version drawn on the wizard and the `DisplayVersion` written to Add/Remove Programs — so the v2.2.2 installer displayed "v2.1.0" and registered 2.1.0 while installing a genuine 2.2.2 payload. The version is now generated from `package.json` by `scripts/gen-version.js`, making `package.json` the single source of truth. Hardcoding it again is a compile error.
- **A version bump could not rebuild the installer.** The installer's build cache keyed on `installer.c` + `installer.h`. A version change touches neither, so a bumped build reused the cached binary and shipped the previous version's string. The generated version header is now part of the cache key.
- **A payload format change could not rebuild the packer.** `install_pack.c` includes `installer.h` — where `NXI_PAYLOAD_VERSION` and the payload structs live — but the packer's cache key omitted it. Changing the format would rebuild the installer while leaving a cached packer writing the old one, producing an installer that rejects its own payload. `installer.h` is now part of the packer's cache key.
- **A failed compile could silently ship a stale binary.** `check-hash.js` recorded the hash at the moment it reported "changed" — before anything was compiled. If the compile then failed, the hash stayed recorded, so the next build reported "same", skipped the compile, and packed the previously-built binary into an installer that looked shippable. Checking no longer writes; the hash is recorded via `--commit` only after the build step succeeds.

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

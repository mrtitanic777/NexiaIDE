# Changelog

## v3.3.0 (unreleased)

### Fixes

- **A local profile picture is shown to its owner only.** `userAvatarSrc`
  ignored the user it was asked about and answered with the local upload for
  anybody, so the developer panel — the one screen that draws other people —
  painted the local user's face onto all ten rows. Nothing was ever written to
  any account: `avatarDataUrl` has no path to the server, and lives in this
  machine's prefs file and nowhere else. The list asked "what picture for this
  user?" ten times and got the same answer, because the argument was never read.
  A local upload still wins for its owner, matched by id while signed in, and by
  email when nobody is — `LastAccount` stores no id, so an id-only check would
  have quietly dropped the picture from the welcome-back prompt instead. Users
  with an `avatarUrl` of their own keep it; the rest fall back to their initial.

### Under the hood

- **The toolchain is C.** SDK detection, the XEX parser, the project tree, the
  devkit (XBDM) client, extension management, the emulator process work, and now
  the build command lines and the compiler output parser all live in
  `nexia-core.exe` rather than in TypeScript. Nothing about the IDE looks
  different and nothing about it is faster — `cl.exe` dominates a build. What
  changes is that each of those was written twice, in two languages, and a fix to
  one could leave the other broken. They are now written once. TypeScript
  orchestrates and spawns; the C computes.

## v3.0.0

Everything below is measured against **v2.1.0**, the last release. The installer is
**0.72 MB instead of 150.4 MB**, updates install themselves without a permission
prompt, and Visual Studio projects come across and build.

### The installer

- **0.72 MB, down from 150.4 MB.** Nexia IDE's own code is about 2.6 MB; the rest of
  the old installer was Electron — a complete copy of the Chromium browser and
  Node.js, packed inside the download. The installer now carries the source and
  fetches Node from nodejs.org, packages from npm and Electron from GitHub while it
  installs, then builds the IDE on your machine. About a minute, and it needs an
  internet connection. The finished install is 246 MB, slightly smaller than before.
- **Installs to `%LOCALAPPDATA%\Programs\NexiaIDE`, not `C:\Program Files`.** Program
  Files can only be written by an administrator, which is what forced a UAC prompt on
  every single update. A folder you own needs no permission, so updates simply happen.
  This is the same reason Chrome, Discord and VS Code install where they do.
- **Existing Program Files installs are migrated.** The new copy is installed
  per-user and the old one retired afterwards. That retirement needs administrator,
  so it costs one prompt, once, on the upgrade that moves the machine — never again.
  Decline it and the old copy just stays on disk; the new install already works.
- **Updates install themselves and reopen the IDE.** No clicks, no prompts.
- **Updating keeps your extracted Xbox 360 SDK.** It lives inside the program folder,
  which an update used to clear — costing several GB and a re-extract.

### Visual Studio interoperability

- **Import a solution** — `File → Import from Visual Studio (.sln)`. Reads `.sln`
  files and both project formats the Xbox 360 XDK shipped against (`.vcxproj` and
  legacy `.vcproj`), mapping sources, headers, include and library directories,
  libraries, defines, precompiled header, RTTI, exception handling, warning level,
  optimization and configuration type. Your project is **copied, never moved**, so it
  keeps building in Visual Studio. A preview shows exactly what comes over —
  including anything skipped — before a single file is written.
- **Referenced projects are linked properly.** Visual Studio links a referenced
  static library *implicitly*, so the project file never names it — an import would
  bring across every SDK library except the one thing the project actually depended
  on, and the build failed at the link step with the headers resolving fine.
  Referenced projects are now resolved and linked, and anything living inside the
  Xbox 360 SDK (the ATG framework) is linked from there rather than copied in.
- **Every configuration keeps its own settings**, so Release and Release LTCG link
  *their* libraries — including the matching build of a referenced library — instead
  of whichever set Debug happened to import.
- **Solution Explorer** shows the solution an imported project came from, the other
  projects in it, and whether each dependency actually resolved — visible before the
  link fails rather than after.
- **Imports go straight to your projects folder.** No folder picker; there was only
  ever one right answer.

### Building

- **Release LTCG builds** — `/GL` when compiling, `/LTCG` when linking, against the
  LTCG libraries.
- **Profile builds link the right libraries.** The Xbox 360 SDK ships four flavours
  and Nexia only knew about two, so Profile quietly used the Release set instead of
  the instrumented one.
- **Debug builds link the debug C runtime.** `_DEBUG` was defined without telling the
  compiler which runtime to use, so it defaulted to the release CRT — and the
  debug-only assertion code the standard library emits had nowhere to resolve to.

### Learning

- **The curriculum is playable.** The built-in 8-module, 17-lesson course steps
  through text, code, exercises with hints and solutions, quizzes and visualizations.
- **Progress actually tracks.** Quizzes and lesson completion now feed the mastery
  model; previously nothing called into it.
- **Cloud lessons** — browse, download and update published lessons from the Learn
  panel, with version-aware update badges.
- **Progress syncs to your account** and merges across machines, so two computers
  can't overwrite each other.
- **Lesson Builder: hand-placed layouts.** A token explanation's spotlight and panel,
  and a connection's source and destination spotlights, can be positioned by hand;
  the cinematic engine follows them during playback. Authored **x, width and panel
  height** are used while the **vertical position stays live**, so spotlights keep
  tracking their code line as it scrolls.

### The AI assistant

- **It stays quiet until you ask it something.** Three separate things were sending
  it requests you never made — opening the IDE, a failed build, and an instruction
  buried in the system prompt telling it to greet you. Each one spent tokens on an
  API you pay for per call.
- **The chat box stays put while the model answers.** The whole panel used to scroll
  — tabs, status, transcript and the input together — so the place you type drifted
  off the bottom as text arrived.
- **The conversation follows the answer** on its own.

### Appearance

- **Structural skins** — three skins that restyle the interface rather than
  recolouring it (`Settings → Appearance`):
  - **Blade** — the 2005 Xbox 360 dashboard: curved sliding blades, ring-of-light
    glow, deep green field.
  - **Devkit** — the IDE as hardware: brushed chassis, machined bezel, keycap rail,
    status LEDs, recessed screen.
  - **Phosphor** — CRT terminal brutalism: monospace throughout, hard 1px rules,
    scanlines and phosphor bloom.
  - Colour presets still apply on top of any skin.
- **Choose your own syntax colours** — `Settings → Appearance → Code Colors`.
  Comments, keywords, strings, numbers, types, functions, variables and preprocessor,
  with live preview and a reset.

### Accounts and community

- **You stay signed in.** Sessions expired after two hours, and on expiry the client
  deleted its token — losing your identity along with your session. Sessions now last
  30 days, and the last account is remembered separately (username and email only, no
  secrets).
- **Welcome-back prompt** — signed-out users get a "sign in as *you* / different
  account / continue without an account" choice with the trade-offs spelled out.
  Signed-in users are only ever interrupted by a release popup.
- **Discord works for everyone.** Sign in and the Community feed loads; it previously
  only worked on a machine configured by hand.
- **No more "you haven't joined the Nexia server"** when you're already a member. The
  check read your own Discord guild list, which fails silently if your token predates
  the required scope, and treated "couldn't check" as "not a member".

### Software updates

- **Built-in updater** — the IDE checks a release manifest and shows a popup with the
  version, headline and changelog. Downloads are **SHA-256 verified before anything
  is executed**; a mismatch is rejected and non-HTTPS URLs are refused.
- **Admin → Releases** — publish or pull a release from inside the IDE.

### Smaller things

- **Your source files are visible when a project opens.** Header Files and Source
  Files were built collapsed with nothing to open them.
- **`nexia.json` is hidden from the file tree.** It's the project's own config,
  written by the IDE. Still on disk.
- **Server Settings** was unreachable from the account menu.
- **Building from a path containing spaces** no longer breaks the build.

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

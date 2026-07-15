# Nexia IDE — Module Signatures

> Last updated: Phase 1 (restructure)
> This file documents the public API of every module in the project.
> Updated as modules are added, split, or changed.

---

## src/shared/types.ts

Shared type definitions used by both the main process and renderer process.
Imported by main process modules via `import { ... } from '../shared/types'`.
Used in renderer via `require` or direct reference (renderer doesn't use ES imports).

```ts
export interface SdkPaths {
    // Paths to Xbox 360 SDK directories (bin, include, lib, etc.)
}

export interface SdkTool {
    // Individual SDK tool description (name, path, description)
}

export interface ProjectConfig {
    // Project settings: name, path, SDK paths, build config
}

export interface ProjectTemplate {
    // Template definition for "New Project" dialog
}

export interface BuildConfig {
    // Compiler/linker settings, output paths, defines
}

export interface BuildResult {
    // Build outcome: success/fail, errors, warnings, output path
}

export interface BuildMessage {
    // Single compiler/linker diagnostic (file, line, col, severity, text)
}

export interface DevkitConfig {
    // Development kit connection settings (IP, port, auth)
}

export interface DevkitStatus {
    // Current devkit state (connected, CPU/memory usage, etc.)
}

export interface FileNode {
    // File tree node (name, path, isDirectory, children)
}

export const IPC = {
    // All IPC channel names as string constants.
    // Used by main.ts to register handlers and by app.ts to invoke them.
    // Categories: SDK, PROJECT, FILE, BUILD, TOOL, EXT, DEVKIT, EMU, APP, DISCORD, XEX
}
```

---

## src/main/main.ts

Electron main process. Creates the BrowserWindow, registers all IPC handlers,
instantiates backend services, manages app lifecycle.

**Imports from local modules:**
```ts
import { Toolchain } from './toolchain';
import { BuildSystem } from './buildSystem';
import { DevkitManager } from './devkit';
import { EmulatorManager } from './emulator';
import { SdkTools } from './sdkTools';
import { ExtensionManager } from './extensions';
import { ProjectManager } from './projectManager';
import { DiscordFeed } from './discord';
import { IPC } from '../shared/types';
```

**Key behaviors:**
- Creates single BrowserWindow loading `dist/renderer/index.html`
- Registers ~70 IPC handlers (one per IPC channel)
- Forwards build output events to renderer via `mainWindow.webContents.send()`
- Manages recent projects list and app settings persistence

---

## src/main/toolchain.ts

Xbox 360 SDK toolchain detection and path resolution.

```ts
export class Toolchain {
    constructor()
    detect(): Promise<SdkPaths | null>    // Auto-detect SDK installation
    configure(sdkPath: string): void      // Manual SDK path
    getPaths(): SdkPaths                  // Current resolved paths
    getToolInventory(): SdkTool[]         // List all available SDK tools
    getBundledSdkPath(): string           // Path to IDE-bundled SDK
}
```

---

## src/main/buildSystem.ts

Xbox 360 compilation, linking, and XEX packaging.

```ts
export class BuildSystem {
    constructor(toolchain: Toolchain)
    build(config?: BuildConfig): Promise<BuildResult>
    rebuild(config?: BuildConfig): Promise<BuildResult>
    clean(): Promise<void>
    // Emits 'build:output' and 'build:complete' events via callback
}
```

**Depends on:** Toolchain (for compiler/linker paths)

---

## src/main/sdkTools.ts

Individual SDK tool wrappers (shader compiler, audio encoder, etc.).

```ts
export class SdkTools {
    constructor(toolchain: Toolchain)
    compileShader(input, output, profile, entry): Promise<string>
    buildXex(input, output): Promise<string>
    encodeAudio(input, output): Promise<string>
    compileXui(input, output): Promise<string>
    inspectBinary(input): Promise<any>
    compress(input, output): Promise<string>
    launchPix(): Promise<void>
    runTool(name, args): Promise<string>
}
```

**Depends on:** Toolchain (for tool paths)

---

## src/main/devkit.ts

Xbox 360 development kit management via XBDM protocol (port 730).

```ts
export class DevkitManager {
    constructor(toolchain: Toolchain)
    connect(ip: string): Promise<DevkitStatus>
    disconnect(): void
    getSystemInfo(): Promise<any>
    getStatus(): DevkitStatus
    getVolumes(): Promise<any[]>
    deploy(xexPath: string): Promise<void>
    launch(xexPath: string): Promise<void>
    reboot(): Promise<void>
    screenshot(): Promise<Buffer>
    fileManager(remotePath: string): Promise<any>
}
```

**Depends on:** Toolchain (for xbdm tool paths)

---

## src/main/emulator.ts

Nexia 360 emulator integration via GDB/MI protocol.

```ts
export class EmulatorManager {
    configure(emulatorPath: string, gdbPath?: string): void
    launch(xexPath: string): Promise<void>
    stop(): Promise<void>
    pause(): Promise<void>
    resume(): Promise<void>
    step(): Promise<void>
    stepOver(): Promise<void>
    getState(): { running, paused, pid }
    getRegisters(): Promise<any>
    setBreakpoint(addr: string): Promise<string>
    removeBreakpoint(id: string): Promise<void>
    listBreakpoints(): any[]
    backtrace(): Promise<string[]>
    readMemory(addr: string, size: number): Promise<string>
    writeMemory(addr: string, data: string): Promise<void>
}
```

---

## src/main/discord.ts

Discord community integration via Bot HTTP API.

```ts
export class DiscordFeed {
    configure(config: { botToken, channelId, clientId, clientSecret, enabled }): void
    getConfig(): any
    getFeed(force?: boolean): Promise<any[]>
    getMessages(threadId: string): Promise<any[]>
    getNewMessages(threadId: string, afterId: string): Promise<any[]>
    createThread(title: string, content: string): Promise<any>
    reply(threadId: string, content: string): Promise<any>
    startAuth(): Promise<string>      // OAuth2 flow
    getAuthUser(): Promise<any>
    logout(): void
    download(url: string, filename: string): Promise<string>
}
```

---

## src/main/extensions.ts

Extension manager for community tools, templates, and plugins.

```ts
export class ExtensionManager {
    list(): ExtensionManifest[]
    installFromZip(zipPath: string): Promise<ExtensionManifest>
    installFromFolder(folderPath: string): Promise<ExtensionManifest>
    uninstall(id: string): Promise<void>
    setEnabled(id: string, enabled: boolean): void
    create(name: string): Promise<string>    // Create extension scaffold
    openDir(id: string): void                // Open in Explorer
}
```

---

## src/main/projectManager.ts

Project creation, loading, saving, and template management.

```ts
export class ProjectManager {
    getTemplates(): ProjectTemplate[]
    create(name: string, directory: string, templateId: string): Promise<ProjectConfig>
    open(projectDir?: string): Promise<{ config: ProjectConfig, files: FileNode[] }>
    save(config?: ProjectConfig): Promise<void>
    getCurrent(): ProjectConfig | null
}
```

---

## src/renderer/app.ts

Renderer process monolith (~7,154 lines). Runs in the BrowserWindow.
Uses `require('electron').ipcRenderer` to communicate with main process.

**Globals (shared state accessed by all subsystems):**
```ts
let editor: any                  // Monaco editor instance
let openTabs: Tab[]              // Currently open file tabs
let activeTab: string | null     // Path of active tab
let currentProject: any          // Current project config
let userSettings: UserSettings   // Persisted user preferences (theme, AI config)
let userProfile: UserProfile     // Learning profile (achievements, skill level)
```

**Subsystems (to be extracted in later phases):**
- Monaco editor init + Xbox 360 completions (lines ~492–700)
- Tab management (lines ~824–950)
- File tree / Solution Explorer (lines ~1553–2010)
- Build UI + output panel (lines ~2069–2380)
- Devkit panel (lines ~2752–2930)
- Emulator panel (lines ~3082–3470)
- Settings + onboarding + tour (lines ~3483–3910)
- Learning / tips / study / community panels (lines ~3920–5250)
- Find in files (lines ~5252–5490)
- AI system — networking, chat, hints, code gen, tool calls (lines ~5610–6980)
- Bootstrap / init (lines ~7111–7154)

**IPC usage pattern:**
```ts
// Invoke main process (request-response):
const result = await ipcRenderer.invoke(IPC.BUILD_RUN, config);

// Listen for main process events (push):
ipcRenderer.on(IPC.BUILD_OUTPUT, (event, text) => appendOutput(text));
```

---

## src/renderer/learning/learning.ts

Tips database, curriculum milestones, and achievement definitions.
Loaded by app.ts via `require('./learning/learning')`.

```ts
// Exported data:
export const TIPS_DATABASE: Tip[]
export const ACHIEVEMENTS: Achievement[]
export const CURRICULUM: CurriculumMilestone[]

// Types:
interface Tip { id, title, body, category, icon }
interface Achievement { id, name, description, icon, category }
interface CurriculumMilestone { id, title, lessons[], requiredAchievements[], unlocksAchievement }
```

---

## src/renderer/learning/quizzes.ts

Quiz bank and study system data.
Loaded by app.ts via `require('./learning/quizzes')`.

```ts
export type QuizMode = 'multiple-choice' | 'fill-in'

export interface QuizQuestion {
    id: string
    question: string
    options?: string[]        // For multiple-choice
    answer: string
    explanation: string
    category: string
    difficulty: 'easy' | 'medium' | 'hard'
}

export const QUIZ_BANK: QuizQuestion[]
```

---

## Future Modules (Phase 2+)

These will be created during the merge phases:

### src/renderer/learning/learningProfile.ts
Ported from CodingTeacherOld. Adaptive mastery tracking.

```ts
export enum MasteryLevel {
    NotStarted = 0, Introduced = 1, Practicing = 2,
    Developing = 3, Proficient = 4, Mastered = 5
}

export const MASTERY_LABELS: Record<MasteryLevel, string>

export interface InteractionRecord {
    type: 'lesson' | 'exercise' | 'quiz' | 'chat'
    conceptId: string
    timestamp: number
    successful: boolean
    attemptNumber: number
    timeSpentSeconds: number
    notes: string
}

export interface ConceptProgress { conceptId, conceptName, level, timesIntroduced, timesPracticed, successfulAttempts, failedAttempts, totalTimeSpentSeconds, lastInteraction, history[] }
export interface LessonProgress { lessonId, started, completed, contentItemsCompleted, totalContentItems, completionPercentage, startTime, completionTime, totalTimeSpentSeconds, attempts }
export interface LearningPattern { prefersVisualLearning, needsMoreRepetition, strugglesWithPointers, strugglesWithSyntax, learnsQuickly, averageSessionMinutes, strongestArea, weakestArea, recommendedFocusAreas[] }

export class LearningProfile {
    learnerName: string
    conceptProgress: Map<string, ConceptProgress>
    lessonProgress: Map<string, LessonProgress>
    sessionCount: number

    load(profilePath?: string): boolean
    save(profilePath?: string): boolean
    recordInteraction(conceptId, type, successful, timeSpentSeconds): void
    recordLessonProgress(lessonId, contentItemsCompleted, totalContentItems, completed): void
    getConceptProgress(conceptId): ConceptProgress | undefined
    getLessonProgress(lessonId): LessonProgress | undefined
    getConceptsNeedingPractice(): string[]
    getOverallProgress(): number          // 0-100 percentage
    getTotalTimeSpentHours(): number
    getRecommendedNextLesson(): string
    analyzePatterns(): LearningPattern
    getAIContextSummary(): string         // For injection into AI system prompt
    startSession(): void
    endSession(): void
}

export const learningProfile: LearningProfile   // Singleton
```

Persistence: `~/.nexia-ide-learning-profile.json`

### src/renderer/learning/lessonSystem.ts
Ported from CodingTeacherOld. Structured lesson navigation.

```ts
export enum Difficulty { Beginner, Intermediate, Advanced }
export enum ContentType { Text, Code, Exercise, Quiz, Visualization }

export interface LessonContent { type, title, content, hint, solution, options[], correctOption }
export interface Lesson { id, title, description, difficulty, prerequisites[], concepts[], content[], estimatedMinutes }
export interface Module { id, title, description, lessons[] }
export interface Curriculum { id, title, description, modules[] }

export class LessonSystem {
    loadXbox360Curriculum(): void
    getCurricula(): Curriculum[]
    getActiveCurriculum(): Curriculum | null
    setActiveCurriculum(id): void
    getLesson(moduleId, lessonId): Lesson | null
    getCurrentLesson(): Lesson | null
    getCurrentModuleId(): string
    getCurrentLessonId(): string
    getCurrentContentIndex(): number
    getCurrentContent(): LessonContent | null
    goToLesson(moduleId, lessonId): void
    nextLesson(): void
    previousLesson(): void
    nextContent(): void
    previousContent(): void
}

export const lessonSystem: LessonSystem   // Singleton
```

Built-in curriculum: 4 modules, 6 lessons (Getting Started, Control Flow, Functions, Pointers & Memory)

### src/renderer/learning/genesisEngine.ts
Ported from Genesis. Self-evolving AI lesson engine.

```ts
export interface Generation { html: string; feedback: string | null }
export type LogCallback = (message: string) => void
export type AIFunction = (prompt: string, maxTokens: number) => Promise<string>
export const TOPICS: string[]   // 24 progressive C++ topic labels

export class GenesisEngine {
    setAIFunction(fn: AIFunction): void
    setLogCallback(fn: LogCallback): void
    setGuidance(text: string): void
    setMaxTokens(tokens: number): void

    getGenerationCount(): number
    getCurrentGenIndex(): number
    getGenerations(): Generation[]
    getCurrentHtml(): string
    getCurrentFeedback(): string | null
    getTopicLabel(genIndex: number): string
    isEvolving(): boolean
    isAutoEvolving(): boolean

    goToGeneration(index: number): void
    previousGeneration(): void
    nextGeneration(): void

    evolve(): Promise<boolean>              // Single evolution step
    startAutoEvolve(): void                 // Continuous evolution
    stopAutoEvolve(): void
    toggleAutoEvolve(): void

    exportGenerationHtml(genIndex: number): string
    exportAllHtml(): string
}

export const genesisEngine: GenesisEngine   // Singleton
```

Depends on: AI function provided via setAIFunction() (wired to aiComplete in app.ts)

### src/renderer/visualizer/codeVisualizer.ts
Ported from CodingTeacherOld. Memory/stack/pointer visualization (Canvas 2D).

```ts
export enum VisualizationType { Memory, Pointer, Stack, Variables, Array, LinkedList, Tree, FlowChart, ClassDiagram }

export interface Color { r: number; g: number; b: number; a: number }
export interface MemoryCell { address, label, value, type, color, isHighlighted, isPointer, pointsTo }
export interface VariableVis { name, type, value, address, size, isPointer, color }
export interface StackFrame { functionName, localVariables[], returnAddress, isActive }
export interface VisAnimation { isAnimating, progress, currentStep, totalSteps, description }

export class CodeVisualizer {
    attach(canvas: HTMLCanvasElement): void
    resizeCanvas(): void
    setType(type: VisualizationType): void
    clear(): void

    addMemoryCell(cell: MemoryCell): void
    addVariable(v: VariableVis): void
    addStackFrame(frame: StackFrame): void

    visualizeCode(code: string): void          // Parse C++ declarations → variable boxes
    visualizePointer(ptrName, pointeeName): void  // Two boxes with arrow
    visualizeArray(arrayName, values[]): void   // Horizontal indexed cells
    parseCommand(command: string): void         // Parse lesson system viz commands

    startAnimation(steps, description): void
    updateAnimation(deltaTime: number): void
    nextStep(): void
    getAnimation(): VisAnimation

    render(): void                              // Draw everything to canvas
}

export const codeVisualizer: CodeVisualizer   // Singleton
```

Render modes: Variables (row of boxes), Pointer (two boxes + arrow), Memory (vertical stack), Stack (frames with locals), Array (horizontal cells)

### src/renderer/ai/aiService.ts
Extract from app.ts. Multi-provider AI networking + SSE streaming.

### src/renderer/ai/aiChat.ts
Extract from app.ts. Chat panel rendering and message management.

### src/renderer/ai/aiHintBar.ts
Extract from app.ts. Select-code-to-action floating toolbar.

### src/renderer/ai/aiCodeGen.ts
Extract from app.ts. Code generation and inline suggestions.

### src/renderer/ai/aiToolCalls.ts
Extract from app.ts. fix_code / refactor_code XML parsers.

### src/renderer/editor/monacoSetup.ts
Extract from app.ts. Monaco initialization and Xbox 360 completions.

### src/renderer/editor/tabs.ts
Extract from app.ts. Tab management (open, close, switch, render).

### src/renderer/editor/fileTree.ts
Extract from app.ts. Solution Explorer file tree.

### src/renderer/editor/search.ts
Extract from app.ts. Find in Files.

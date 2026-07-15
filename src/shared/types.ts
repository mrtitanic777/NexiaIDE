/**
 * Shared types for Nexia IDE
 */

// ── SDK Types ──

export interface SdkPaths {
    root: string;
    bin: string;
    binWin32: string;
    binX64: string;
    include: string;
    lib: string;
    doc: string;
    source: string;
    system: string;
}

export interface SdkTool {
    name: string;
    path: string;
    description: string;
    category: 'compiler' | 'linker' | 'shader' | 'audio' | 'xui' | 'utility' | 'devkit' | 'debug' | 'profiler' | 'other';
    gui: boolean;  // true = windowed app, false = CLI tool (output to terminal)
}

// ── Project Types ──

export type BuildConfiguration = 'Debug' | 'Release' | 'Profile' | 'Release_LTCG';

/**
 * Settings that differ per configuration.
 *
 * The Xbox 360 SDK ships a different library flavour for each configuration
 * (d3d9d / d3d9i / d3d9 / d3d9ltcg), so a single flat library list cannot be
 * correct for more than one of them. Visual Studio stores these per
 * configuration in its ItemDefinitionGroups; Nexia used to keep only the Debug
 * set, which meant an imported project linked Debug's libs in every build.
 *
 * Anything omitted here falls back to the flat field on ProjectConfig, so
 * projects written before this existed keep working unchanged.
 */
export interface ConfigurationSettings {
    libraries?: string[];
    defines?: string[];
    includeDirectories?: string[];
    libraryDirectories?: string[];
    /**
     * The C runtime for THIS configuration.
     *
     * Must be per-configuration. Stored as a single top-level value it took the
     * Debug group's /MTd and applied it to every build: /MTd implies _DEBUG, so
     * the SDK headers then #pragma comment(lib, "xapilibd.lib") and the debug
     * XAPILIB linked alongside the release one — 37 duplicate-symbol errors in
     * Release, Profile and Release_LTCG, while Debug looked fine.
     */
    runtimeLibrary?: ProjectConfig['runtimeLibrary'];
}

/**
 * A project that sits alongside this one in the same solution.
 *
 * Visual Studio shows these at the top of Solution Explorer so you can see at a
 * glance whether your dependencies are actually attached. Nexia had nowhere to
 * record them, so an imported project silently forgot that AtgFramework existed
 * even though it links against it.
 */
export interface SolutionProject {
    name: string;
    /** Absolute path to the original .vcxproj/.vcproj it came from. */
    path: string;
    /** This is the project Nexia opened; the others are dependencies. */
    isCurrent: boolean;
    /** Lives inside the Xbox 360 SDK, so it is Microsoft's and ships prebuilt. */
    insideSdk: boolean;
    /** Absolute path to the library it contributes, per configuration. */
    libPaths?: Partial<Record<BuildConfiguration, string>>;
}

/**
 * The Visual Studio solution an imported project came from.
 *
 * Nexia builds one project, not a whole solution — this is what lets the
 * Explorer show what the solution contained and which dependencies resolved,
 * rather than pretending the project stands alone.
 */
export interface SolutionInfo {
    name: string;
    /** Absolute path to the original .sln, when the import came from one. */
    path?: string;
    projects: SolutionProject[];
}

/**
 * A XUI content build: .xui scenes in, one .xzp archive out.
 *
 * Paths are relative to the project's Media folder, and xuipkg is run with that
 * folder as its working directory. That is not incidental — xuipkg stores each
 * input's path *as given* inside the archive, so the resource locator a title
 * uses at runtime is determined by how the tool was invoked at build time. The
 * XDK's own sample is built from its project folder with `..\..\media\xui\`
 * inputs, so its archive holds entries literally named
 * `..\..\Media\xui\simple_scene.xur`, and it needs ATG's MediaLocator to scan
 * the archive at runtime and work out that prefix again.
 *
 * Running from Media with `xui\scene.xui` instead stores `xui\scene.xur`, so
 * the locator is just `file://game:/media/<archive>#xui\scene.xur` — a constant
 * the template can hardcode, with no scan and no ATG dependency.
 */
export interface XuiContent {
    /** Archive name, written to <OutDir>\media\<package>. */
    package: string;
    /** .xui sources to compile, relative to the project's Media folder. */
    scenes: string[];
    /** Files copied verbatim into <OutDir>\media — fonts, mostly. */
    copy: string[];
}

export interface ProjectConfig {
    name: string;
    path: string;
    type: 'executable' | 'library' | 'dll';
    /**
     * Which template the project was made from.
     *
     * 'dll' and 'static-lib' were missing here, so both library templates had to
     * declare themselves `template: 'empty'` with an `as any` on the type beside
     * it to compile — meaning every library project on disk claims to be an
     * empty project. Nothing reads this field to decide behaviour today, which
     * is the only reason that was survivable.
     */
    template: 'empty' | 'hello-world' | 'xui-app' | 'xbla' | 'dll' | 'static-lib';
    sourceFiles: string[];
    includeDirectories: string[];
    libraryDirectories: string[];
    libraries: string[];
    defines: string[];
    configuration: BuildConfiguration;
    /**
     * Per-configuration overrides. When a configuration has an entry here, it
     * wins over the flat fields above; otherwise the flat fields apply. Written
     * by the Visual Studio importer, which reads all four ItemDefinitionGroups.
     */
    configurations?: Partial<Record<BuildConfiguration, ConfigurationSettings>>;
    /** The VS solution this was imported from, for the Solution Explorer. */
    solution?: SolutionInfo;
    pchHeader?: string;  // Precompiled header name, e.g. "stdafx.h"

    /**
     * Other Nexia projects this one links against, as paths to their folders.
     *
     * Each is built before this project, and the .lib it produces is added to
     * this project's link line along with its include directory. Relative paths
     * are resolved against this project's folder, so a solution folder can be
     * moved or shared without every reference breaking.
     *
     * Before this existed, the only way to consume a static library you had
     * just built was to type its .lib name into Project Properties by hand and
     * add its output folder to the library paths — and nothing rebuilt it when
     * its sources changed.
     */
    projectReferences?: string[];

    /**
     * XUI content to build. Only XUI projects set this.
     *
     * Scenes are authored as .xui XML and are useless to the console in that
     * form: xuipkg compiles each to a binary .xur and packs them into an .xzp
     * archive, which the title opens at runtime through a resource locator.
     * Without this step a XUI project compiles, links, and then fails on the
     * console when it cannot find its scene.
     */
    xuiContent?: XuiContent;

    // ── Advanced Compiler/Linker Settings ──
    enableRtti?: boolean;                    // /GR (true) or /GR- (false, default)
    exceptionHandling?: 'sync' | 'async' | 'none';  // /EHsc, /EHa, or omitted

    /**
     * C runtime to link: /MT, /MTd, /MD, /MDd.
     *
     * Must agree with _DEBUG. A Debug build defines _DEBUG, which makes the CRT
     * and STL headers emit assertion calls (_CrtDbgReportW) that exist ONLY in
     * the debug CRT — so compiling Debug against /MT fails to link with exactly
     * one unresolved external. Defaults to /MTd for Debug and /MT otherwise,
     * matching Visual Studio's Xbox 360 defaults.
     */
    runtimeLibrary?: 'MT' | 'MTd' | 'MD' | 'MDd';
    warningLevel?: 0 | 1 | 2 | 3 | 4;      // /W0 through /W4 (default: 3)
    treatWarningsAsErrors?: boolean;         // /WX
    optimizationOverride?: 'disabled' | 'minSize' | 'maxSpeed' | 'full' | 'default';  // /Od, /O1, /O2, /Ox — overrides config defaults
    additionalCompilerFlags?: string;        // Extra flags appended to cl.exe
    additionalLinkerFlags?: string;          // Extra flags appended to link.exe

    // ── Extended VS2010-style Properties ──
    // Stored as a flexible bag so new properties can be added without schema changes
    properties?: Record<string, any>;
}

export interface ProjectTemplate {
    id: string;
    name: string;
    description: string;
    icon: string;
    files: { path: string; content: string }[];
    config: Partial<ProjectConfig>;
    /**
     * Files copied out of the installed XDK rather than generated.
     *
     * `from` is relative to the SDK root. This exists for XUI, whose skin is
     * 424 KB of generated XML and whose font is 6.6 MB — neither is something
     * to vendor into this repo, and both are already on the machine of anyone
     * who can build for the Xbox 360 at all. Copying from the user's own
     * install also means the assets always match their SDK version.
     *
     * A template that declares these cannot be created without a configured
     * SDK, so create() fails with that reason rather than half-writing.
     */
    sdkFiles?: { from: string; to: string }[];
}

// ── Build Types ──

export interface BuildConfig {
    configuration: 'Debug' | 'Release' | 'Profile' | 'Release_LTCG';
    compilerFlags: string[];
    linkerFlags: string[];
    defines: string[];
    outputDir: string;
}

export interface BuildResult {
    success: boolean;
    errors: BuildMessage[];
    warnings: BuildMessage[];
    output: string;
    duration: number;
    outputFile?: string;
}

export interface BuildMessage {
    file: string;
    line: number;
    column: number;
    message: string;
    severity: 'error' | 'warning' | 'info';
}

// ── Devkit Types ──

export interface DevkitConfig {
    name: string;
    ip: string;
    isDefault: boolean;
}

export interface DevkitStatus {
    connected: boolean;
    type?: string;
    cpuUsage?: number;
    memoryUsed?: number;
    memoryTotal?: number;
}

// ── IPC Channel Names ──

export const IPC = {
    // SDK
    SDK_DETECT: 'sdk:detect',
    SDK_CONFIGURE: 'sdk:configure',
    SDK_GET_PATHS: 'sdk:getPaths',
    SDK_GET_TOOLS: 'sdk:getTools',
    SDK_PREP_REGISTRY: 'sdk:prepRegistry',
    SDK_CLEANUP_REGISTRY: 'sdk:cleanupRegistry',
    SDK_INSTALL_STATE: 'sdk:installState',

    // Project
    PROJECT_NEW: 'project:new',
    PROJECT_OPEN: 'project:open',
    PROJECT_SAVE: 'project:save',
    PROJECT_GET_CONFIG: 'project:getConfig',
    PROJECT_GET_TEMPLATES: 'project:getTemplates',
    PROJECT_EXPORT: 'project:export',
    PROJECT_IMPORT: 'project:import',
    VS_PICK: 'vs:pick',
    VS_PREVIEW: 'vs:preview',
    VS_IMPORT: 'vs:import',

    // Files
    FILE_READ: 'file:read',
    FILE_WRITE: 'file:write',
    FILE_LIST: 'file:list',
    FILE_CREATE: 'file:create',
    FILE_DELETE: 'file:delete',
    FILE_RENAME: 'file:rename',
    FILE_SELECT_DIR: 'file:selectDir',
    FILE_SELECT_FILE: 'file:selectFile',

    // Build
    BUILD_RUN: 'build:run',
    BUILD_CLEAN: 'build:clean',
    BUILD_REBUILD: 'build:rebuild',
    BUILD_CANCEL: 'build:cancel',
    BUILD_OUTPUT: 'build:output',
    BUILD_COMPLETE: 'build:complete',

    // SDK Tools
    TOOL_COMPILE_SHADER: 'tool:compileShader',
    TOOL_BUILD_XEX: 'tool:buildXex',
    TOOL_ENCODE_AUDIO: 'tool:encodeAudio',
    TOOL_COMPILE_XUI: 'tool:compileXui',
    TOOL_INSPECT_BINARY: 'tool:inspectBinary',
    TOOL_COMPRESS: 'tool:compress',
    TOOL_LAUNCH_PIX: 'tool:launchPix',
    TOOL_RUN: 'tool:run',
    TOOL_LAUNCH: 'tool:launch',
    TOOL_OUTPUT: 'tool:output',

    // Extensions
    EXT_LIST: 'ext:list',
    EXT_INSTALL_ZIP: 'ext:installZip',
    EXT_INSTALL_FOLDER: 'ext:installFolder',
    EXT_UNINSTALL: 'ext:uninstall',
    EXT_SET_ENABLED: 'ext:setEnabled',
    EXT_CREATE: 'ext:create',
    EXT_OPEN_DIR: 'ext:openDir',

    // Devkit
    DEVKIT_CONNECT: 'devkit:connect',
    DEVKIT_DISCONNECT: 'devkit:disconnect',
    DEVKIT_SYSINFO: 'devkit:sysInfo',
    DEVKIT_VOLUMES: 'devkit:volumes',
    DEVKIT_DEPLOY: 'devkit:deploy',
    DEVKIT_LAUNCH: 'devkit:launch',
    DEVKIT_REBOOT: 'devkit:reboot',
    DEVKIT_SCREENSHOT: 'devkit:screenshot',
    DEVKIT_FILE_MANAGER: 'devkit:fileManager',
    DEVKIT_STATUS: 'devkit:status',
    DEVKIT_COPY_TO: 'devkit:copyTo',

    // Emulator
    EMU_LAUNCH: 'emu:launch',
    EMU_STOP: 'emu:stop',
    EMU_PAUSE: 'emu:pause',
    EMU_RESUME: 'emu:resume',
    EMU_STEP: 'emu:step',
    EMU_STEP_OVER: 'emu:stepOver',
    EMU_STATE: 'emu:state',
    EMU_REGISTERS: 'emu:registers',
    EMU_BREAKPOINT_SET: 'emu:bpSet',
    EMU_BREAKPOINT_REMOVE: 'emu:bpRemove',
    EMU_BREAKPOINT_LIST: 'emu:bpList',
    EMU_BACKTRACE: 'emu:backtrace',
    EMU_MEMORY_READ: 'emu:memRead',
    EMU_MEMORY_WRITE: 'emu:memWrite',
    EMU_CONFIGURE: 'emu:configure',
    EMU_GET_CONFIG: 'emu:getConfig',
    EMU_EVENT: 'emu:event',           // push events to renderer

    // App
    APP_GET_RECENT: 'app:getRecent',

    // XEX Inspector
    XEX_INSPECT: 'xex:inspect',
    APP_REMOVE_RECENT: 'app:removeRecent',
    APP_SHOW_SETUP: 'app:showSetup',
    APP_READY: 'app:ready',
    APP_MINIMIZE: 'app:minimize',
    APP_MAXIMIZE: 'app:maximize',
    APP_CLOSE: 'app:close',

    // Discord
    DISCORD_GET_FEED: 'discord:getFeed',
    DISCORD_CONFIGURE: 'discord:configure',
    DISCORD_GET_CONFIG: 'discord:getConfig',
    DISCORD_GET_MESSAGES: 'discord:getMessages',
    DISCORD_GET_NEW_MESSAGES: 'discord:getNewMessages',
    DISCORD_CREATE_THREAD: 'discord:createThread',
    DISCORD_REPLY: 'discord:reply',
    DISCORD_DOWNLOAD: 'discord:download',
    DISCORD_AUTH_START: 'discord:authStart',
    DISCORD_AUTH_USER: 'discord:authUser',
    DISCORD_AUTH_LOGOUT: 'discord:authLogout',
    DISCORD_CHECK_GUILDS: 'discord:checkGuilds',

    // Lessons
    LESSON_IMPORT: 'lesson:import',
    LESSON_EXPORT: 'lesson:export',
    LESSON_LIST: 'lesson:list',
    LESSON_READ: 'lesson:read',
    LESSON_DELETE: 'lesson:delete',
    LESSON_GET_DIR: 'lesson:getDir',

    // Learn panel search. Both run in main because the providers send no CORS
    // headers, so a renderer request would be blocked by the page origin.
    SEARCH_VIDEOS: 'search:videos',
    SEARCH_WEB: 'search:web',
} as const;

// ── File Tree Types ──

export interface FileNode {
    name: string;
    path: string;
    isDirectory: boolean;
    children?: FileNode[];
    extension?: string;
}

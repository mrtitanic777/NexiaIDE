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

export interface ProjectConfig {
    name: string;
    path: string;
    type: 'executable' | 'library' | 'dll';
    template: 'empty' | 'hello-world' | 'xui-app' | 'xbla';
    sourceFiles: string[];
    includeDirectories: string[];
    libraryDirectories: string[];
    libraries: string[];
    defines: string[];
    configuration: 'Debug' | 'Release' | 'Profile';
    pchHeader?: string;  // Precompiled header name, e.g. "stdafx.h"

    // ── Advanced Compiler/Linker Settings ──
    enableRtti?: boolean;                    // /GR (true) or /GR- (false, default)
    exceptionHandling?: 'sync' | 'async' | 'none';  // /EHsc, /EHa, or omitted
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
}

// ── Build Types ──

export interface BuildConfig {
    configuration: 'Debug' | 'Release' | 'Profile';
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
} as const;

// ── File Tree Types ──

export interface FileNode {
    name: string;
    path: string;
    isDirectory: boolean;
    children?: FileNode[];
    extension?: string;
}

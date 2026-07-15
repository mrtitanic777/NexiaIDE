/**
 * Nexia IDE — Renderer Process
 */

// Node.js require works normally here — all captured before Monaco loads
const { ipcRenderer, shell } = require('electron');
const nodePath = require('path');
const nodeOs = require('os');
const nodeFs = require('fs');

// Shared app context — used by extracted modules (ai/, editor/, etc.)
const appContext = require('./appContext');
const { ctx: appCtx, fn: appFn } = appContext;

const IPC = {
    SDK_DETECT: 'sdk:detect', SDK_CONFIGURE: 'sdk:configure',
    SDK_GET_PATHS: 'sdk:getPaths', SDK_GET_TOOLS: 'sdk:getTools',
    SDK_PREP_REGISTRY: 'sdk:prepRegistry', SDK_CLEANUP_REGISTRY: 'sdk:cleanupRegistry',
    SDK_INSTALL_STATE: 'sdk:installState',
    PROJECT_NEW: 'project:new', PROJECT_OPEN: 'project:open',
    PROJECT_SAVE: 'project:save', PROJECT_GET_CONFIG: 'project:getConfig',
    PROJECT_GET_TEMPLATES: 'project:getTemplates',
    PROJECT_EXPORT: 'project:export', PROJECT_IMPORT: 'project:import',
    VS_PICK: 'vs:pick', VS_PREVIEW: 'vs:preview', VS_IMPORT: 'vs:import',
    FILE_READ: 'file:read', FILE_WRITE: 'file:write', FILE_LIST: 'file:list',
    FILE_CREATE: 'file:create', FILE_DELETE: 'file:delete', FILE_RENAME: 'file:rename',
    FILE_SELECT_DIR: 'file:selectDir', FILE_SELECT_FILE: 'file:selectFile',
    BUILD_RUN: 'build:run', BUILD_CLEAN: 'build:clean', BUILD_REBUILD: 'build:rebuild',
    BUILD_OUTPUT: 'build:output', BUILD_COMPLETE: 'build:complete',
    TOOL_COMPILE_SHADER: 'tool:compileShader', TOOL_BUILD_XEX: 'tool:buildXex',
    TOOL_ENCODE_AUDIO: 'tool:encodeAudio', TOOL_COMPILE_XUI: 'tool:compileXui',
    TOOL_INSPECT_BINARY: 'tool:inspectBinary', TOOL_COMPRESS: 'tool:compress',
    TOOL_LAUNCH_PIX: 'tool:launchPix', TOOL_RUN: 'tool:run', TOOL_LAUNCH: 'tool:launch', TOOL_OUTPUT: 'tool:output',
    EXT_LIST: 'ext:list', EXT_INSTALL_ZIP: 'ext:installZip', EXT_INSTALL_FOLDER: 'ext:installFolder',
    EXT_UNINSTALL: 'ext:uninstall', EXT_SET_ENABLED: 'ext:setEnabled',
    EXT_CREATE: 'ext:create', EXT_OPEN_DIR: 'ext:openDir',
    DEVKIT_CONNECT: 'devkit:connect', DEVKIT_DISCONNECT: 'devkit:disconnect',
    DEVKIT_SYSINFO: 'devkit:sysInfo', DEVKIT_STATUS: 'devkit:status',
    DEVKIT_VOLUMES: 'devkit:volumes',
    DEVKIT_DEPLOY: 'devkit:deploy', DEVKIT_LAUNCH: 'devkit:launch', DEVKIT_REBOOT: 'devkit:reboot',
    DEVKIT_SCREENSHOT: 'devkit:screenshot', DEVKIT_FILE_MANAGER: 'devkit:fileManager',
    DEVKIT_COPY_TO: 'devkit:copyTo',
    EMU_LAUNCH: 'emu:launch', EMU_STOP: 'emu:stop', EMU_PAUSE: 'emu:pause',
    EMU_RESUME: 'emu:resume', EMU_STEP: 'emu:step', EMU_STEP_OVER: 'emu:stepOver',
    EMU_STATE: 'emu:state',
    EMU_REGISTERS: 'emu:registers', EMU_BREAKPOINT_SET: 'emu:bpSet',
    EMU_BREAKPOINT_REMOVE: 'emu:bpRemove', EMU_BREAKPOINT_LIST: 'emu:bpList',
    EMU_BACKTRACE: 'emu:backtrace',
    EMU_MEMORY_READ: 'emu:memRead', EMU_MEMORY_WRITE: 'emu:memWrite',
    EMU_CONFIGURE: 'emu:configure',
    EMU_GET_CONFIG: 'emu:getConfig', EMU_EVENT: 'emu:event',
    APP_GET_RECENT: 'app:getRecent', APP_REMOVE_RECENT: 'app:removeRecent', APP_SHOW_SETUP: 'app:showSetup',
    APP_READY: 'app:ready', APP_MINIMIZE: 'app:minimize',
    APP_MAXIMIZE: 'app:maximize', APP_CLOSE: 'app:close',
    DISCORD_GET_FEED: 'discord:getFeed', DISCORD_CONFIGURE: 'discord:configure',
    DISCORD_GET_CONFIG: 'discord:getConfig', DISCORD_GET_MESSAGES: 'discord:getMessages',
    DISCORD_GET_NEW_MESSAGES: 'discord:getNewMessages',
    DISCORD_CREATE_THREAD: 'discord:createThread', DISCORD_REPLY: 'discord:reply',
    DISCORD_DOWNLOAD: 'discord:download', DISCORD_AUTH_START: 'discord:authStart',
    DISCORD_AUTH_USER: 'discord:authUser', DISCORD_AUTH_LOGOUT: 'discord:authLogout',
    DISCORD_CHECK_GUILDS: 'discord:checkGuilds',
    XEX_INSPECT: 'xex:inspect',
    LESSON_IMPORT: 'lesson:import', LESSON_EXPORT: 'lesson:export',
    LESSON_LIST: 'lesson:list', LESSON_READ: 'lesson:read',
    LESSON_DELETE: 'lesson:delete', LESSON_GET_DIR: 'lesson:getDir',
};

// ── State ──
let editor: any = null;
let monacoReady: Promise<void>;
let monacoResolve: () => void;
monacoReady = new Promise(r => { monacoResolve = r; });
let openTabs: { path: string; name: string; model: any; modified: boolean }[] = [];
let activeTab: string | null = null;
let currentProject: any = null;
let lastBuiltXex: string | null = null;
let cinematicContainer: HTMLElement | null = null;
let defaultProjectsDir: string = '';
let bottomPanelVisible = false;
let sidebarVisible = true;

// ── File Watcher ──
// Tracks external modifications to open files (like VS "file changed outside editor" prompt)
const fileWatchers = new Map<string, { watcher: any; mtime: number; ignoreNext: boolean }>();

// ── Learning System ──
const learning = require('./learning/learning');
const quizzes = require('./learning/quizzes');
const { learningProfile, MasteryLevel, MASTERY_LABELS } = require('./learning/learningProfile');
const cinematicEngine = require('./learning/cinematicEngine');
const { codeVisualizer } = require('./visualizer/codeVisualizer');
const { lessonSystem } = require('./learning/lessonSystem');

// ── Icons (cached before Monaco overwrites window.require) ──
const icons = require('./icons');

// ── Auth & Admin ──
const authService = require('./auth/authService');
const authUI = require('./auth/authUI');
const adminPanel = require('./admin/adminPanel');
interface UserProfile {
    skillLevel: 'beginner' | 'intermediate' | 'expert';
    onboardingComplete: boolean;
    tipsEnabled: boolean;
    completedAchievements: string[];
    currentGoal: string | null;
    dismissedTips: string[];
    totalBuilds: number;
    totalDeploys: number;
    firstBuildDate: string | null;
}
const DEFAULT_PROFILE: UserProfile = {
    skillLevel: 'beginner', onboardingComplete: false, tipsEnabled: true,
    completedAchievements: [], currentGoal: 'first-build', dismissedTips: [],
    totalBuilds: 0, totalDeploys: 0, firstBuildDate: null,
};
let userProfile: UserProfile = { ...DEFAULT_PROFILE };
const PROFILE_FILE = nodePath.join(nodeOs.homedir(), '.nexia-ide-profile.json');

function loadProfile() {
    try {
        if (nodeFs.existsSync(PROFILE_FILE)) {
            const data = JSON.parse(nodeFs.readFileSync(PROFILE_FILE, 'utf-8'));
            userProfile = { ...DEFAULT_PROFILE, ...data };
        }
    } catch {}
}
function saveProfile() {
    try { nodeFs.writeFileSync(PROFILE_FILE, JSON.stringify(userProfile, null, 2)); } catch {}
}

let currentInlineTip: any = null;
let tipCooldown = false;

let currentCodeHint: any = null;
let codeHelperDismissed: Set<string> = new Set();
let lastHintLine = -1;

// ── User Settings (persisted) ──
interface UserSettings {
    fontSize: number;
    accentColor: string;
    bgDark: string;
    bgMain: string;
    bgPanel: string;
    bgSidebar: string;
    editorBg: string;
    textColor: string;
    textDim: string;
    fancyEffects: boolean;
    layout: string;
    cornerRadius: string;
    // AI settings
    aiProvider: 'anthropic' | 'openai' | 'local' | 'custom';
    aiApiKey: string;
    aiEndpoint: string;
    aiModel: string;
    aiSystemPrompt: string;
    aiAutoErrors: boolean;
    aiInlineSuggest: boolean;
    aiFileContext: boolean;
    // Learn panel search. Empty until the user supplies a key; the Videos and
    // Web tabs show setup instructions rather than an error in that state.
    youtubeApiKey: string;
    searchProvider: 'google' | 'brave';
    searchApiKey: string;
    /** Google Programmable Search only — its "cx". Unused by Brave. */
    searchEngineId: string;
    /**
     * The user's profile picture, as a data: URI. Empty means fall back to
     * their account's avatarUrl, then to their initial.
     *
     * Stored inline rather than as a path because a path breaks the moment the
     * file is moved or deleted, and the picture is small enough after
     * downscaling that the settings file stays a reasonable size.
     */
    avatarDataUrl: string;
    /**
     * Custom project-template icons, keyed by template id, as data: URIs.
     *
     * The built-in icons are emoji, which is fine as a default and useless if
     * you want the real thing — an isometric Minecraft block for the spinning
     * block demo is a picture, not a character in a font. A template id absent
     * from here falls back to its emoji, so this only ever holds what the user
     * actually replaced.
     */
    templateIcons: Record<string, string>;
    // Color mode
    colorMode: string;
    /** Structural skin: 'default' | 'blade' | 'devkit' | 'phosphor' */
    skin: string;
    /** Editor syntax colours, keyed by Monaco token type. Hex, with the '#'. */
    syntaxColors: SyntaxColors;
}

/**
 * Syntax highlighting colours, one per Monaco token type.
 *
 * Keys are Monaco token names, so they feed straight into defineTheme's rules.
 * Defaults are the VS Code dark palette these started as.
 */
interface SyntaxColors {
    comment: string;
    keyword: string;
    string: string;
    number: string;
    type: string;
    function: string;
    variable: string;
    preprocessor: string;
}

const DEFAULT_SYNTAX_COLORS: SyntaxColors = {
    comment: '#6a9955',
    keyword: '#569cd6',
    string: '#ce9178',
    number: '#b5cea8',
    type: '#4ec9b0',
    function: '#dcdcaa',
    variable: '#9cdcfe',
    preprocessor: '#c586c0',
};

/**
 * Syntax colour schemes.
 *
 * Ports of palettes people already know, rather than colours invented here — a
 * scheme is a set of hue relationships that took someone a long time to balance,
 * and picking eight colours freehand reliably produces something that looks
 * wrong without being able to say why.
 *
 * These are the editor's tokens only; the IDE's own colours are PRESETS above,
 * and the two apply independently.
 */
const SYNTAX_PRESETS: Record<string, { label: string; colors: SyntaxColors }> = {
    'vs-dark': {
        label: 'VS Dark',
        colors: { comment: '#6a9955', keyword: '#569cd6', string: '#ce9178', number: '#b5cea8',
                  type: '#4ec9b0', function: '#dcdcaa', variable: '#9cdcfe', preprocessor: '#c586c0' },
    },
    'vs2010': {
        label: 'Visual Studio 2010',
        // What the XDK's own IDE looked like: green comments, blue keywords,
        // dark red strings, everything else plain.
        colors: { comment: '#57a64a', keyword: '#569cd6', string: '#d69d85', number: '#b5cea8',
                  type: '#4ec9b0', function: '#dcdcaa', variable: '#dcdcdc', preprocessor: '#9b9b9b' },
    },
    monokai: {
        label: 'Monokai',
        colors: { comment: '#75715e', keyword: '#f92672', string: '#e6db74', number: '#ae81ff',
                  type: '#66d9ef', function: '#a6e22e', variable: '#f8f8f2', preprocessor: '#f92672' },
    },
    dracula: {
        label: 'Dracula',
        colors: { comment: '#6272a4', keyword: '#ff79c6', string: '#f1fa8c', number: '#bd93f9',
                  type: '#8be9fd', function: '#50fa7b', variable: '#f8f8f2', preprocessor: '#ff79c6' },
    },
    nord: {
        label: 'Nord',
        colors: { comment: '#616e88', keyword: '#81a1c1', string: '#a3be8c', number: '#b48ead',
                  type: '#8fbcbb', function: '#88c0d0', variable: '#d8dee9', preprocessor: '#5e81ac' },
    },
    'solarized-dark': {
        label: 'Solarized Dark',
        colors: { comment: '#586e75', keyword: '#859900', string: '#2aa198', number: '#d33682',
                  type: '#b58900', function: '#268bd2', variable: '#839496', preprocessor: '#cb4b16' },
    },
    'gruvbox': {
        label: 'Gruvbox',
        colors: { comment: '#928374', keyword: '#fb4934', string: '#b8bb26', number: '#d3869b',
                  type: '#fabd2f', function: '#8ec07c', variable: '#ebdbb2', preprocessor: '#fe8019' },
    },
    'high-contrast': {
        label: 'High Contrast',
        // For projectors, poor screens, and eyes that have had enough.
        colors: { comment: '#7ca668', keyword: '#569cd6', string: '#ce9178', number: '#b5cea8',
                  type: '#4ec9b0', function: '#dcdcaa', variable: '#ffffff', preprocessor: '#c586c0' },
    },
    phosphor: {
        label: 'Phosphor',
        // Pairs with the Phosphor skin: one hue, brightness does the work.
        colors: { comment: '#2a7a2a', keyword: '#33ff33', string: '#88ff88', number: '#55ff55',
                  type: '#66ff66', function: '#aaffaa', variable: '#33ff33', preprocessor: '#1f5f1f' },
    },
};

/** Human labels for the settings UI, in the order they're shown. */
const SYNTAX_COLOR_LABELS: [keyof SyntaxColors, string, string][] = [
    ['comment',      'Comments',      '// like this'],
    ['keyword',      'Keywords',      'if, for, class, return'],
    ['string',       'Strings',       '"text in quotes"'],
    ['number',       'Numbers',       '42, 3.14, 0xFF'],
    ['type',         'Types',         'int, float, MyClass'],
    ['function',     'Functions',     'DoSomething()'],
    ['variable',     'Variables',     'myVariable'],
    ['preprocessor', 'Preprocessor',  '#include, #define'],
];
const DEFAULT_SETTINGS: UserSettings = {
    fontSize: 14,
    accentColor: '#4ec9b0',
    bgDark: '#181818',
    bgMain: '#1e1e1e',
    bgPanel: '#1e1e1e',
    bgSidebar: '#252526',
    editorBg: '#1e1e1e',
    textColor: '#cccccc',
    textDim: '#858585',
    fancyEffects: true,
    layout: 'sidebar-left',
    cornerRadius: 'rounded',
    aiProvider: 'anthropic',
    aiApiKey: '',
    aiEndpoint: '',
    aiModel: 'auto',
    aiSystemPrompt: '',
    // Off by default: a failed build should not spend the user's tokens unasked.
    aiAutoErrors: false,
    aiInlineSuggest: false,
    aiFileContext: true,
    youtubeApiKey: '',
    searchProvider: 'google',
    searchApiKey: '',
    searchEngineId: '',
    avatarDataUrl: '',
    templateIcons: {},
    colorMode: 'dark',
    skin: 'default',
    syntaxColors: { ...DEFAULT_SYNTAX_COLORS },
};
let userSettings: UserSettings = { ...DEFAULT_SETTINGS, syntaxColors: { ...DEFAULT_SYNTAX_COLORS } };

/**
 * Define (or redefine) the editor theme from the current settings.
 *
 * Single source of truth. The rules used to be hardcoded in two places, so any
 * change had to be made twice or the two copies would drift — and a
 * user-configurable palette would have taken effect in only one of them.
 *
 * Monaco wants token colours WITHOUT the leading '#', while everything the user
 * picks has one, so it's stripped here rather than at each call site.
 */
function defineEditorTheme() {
    // Monaco is loaded at runtime onto window, so it isn't a module-scope symbol.
    // This can also be called from Settings before the editor exists (or if Monaco
    // failed to load), hence the guard rather than a crash.
    const monaco = (window as any).monaco;
    if (!monaco?.editor) return;

    const sc = { ...DEFAULT_SYNTAX_COLORS, ...(userSettings.syntaxColors || {}) };
    const hex = (c: string) => (c || '').replace(/^#/, '');
    monaco.editor.defineTheme('nexia-dark', {
        base: 'vs-dark', inherit: true,
        rules: (Object.keys(DEFAULT_SYNTAX_COLORS) as (keyof SyntaxColors)[])
            .map(token => ({ token, foreground: hex(sc[token]) })),
        colors: {
            'editor.background': userSettings.editorBg,
            'editor.foreground': userSettings.textColor,
            'editorLineNumber.foreground': userSettings.textDim,
            'editorLineNumber.activeForeground': userSettings.accentColor,
            'editor.selectionBackground': '#264f78',
            'editor.lineHighlightBackground': shiftColor(userSettings.editorBg, 10),
            'editorCursor.foreground': userSettings.accentColor,
            'editorSuggestWidget.background': userSettings.bgPanel,
            'editorSuggestWidget.border': '#3c3c3c',
        },
    });
}
const SETTINGS_FILE = nodePath.join(nodeOs.homedir(), '.nexia-ide-prefs.json');

function loadUserSettings() {
    try {
        if (nodeFs.existsSync(SETTINGS_FILE)) {
            const data = JSON.parse(nodeFs.readFileSync(SETTINGS_FILE, 'utf-8'));
            // syntaxColors is merged key-by-key, not by the outer spread: a saved
            // file holding only some of the tokens would otherwise replace the
            // whole object and lose the rest. The fresh object also matters —
            // spreading DEFAULT_SETTINGS would alias its syntaxColors, so editing
            // a colour would mutate the defaults themselves.
            userSettings = {
                ...DEFAULT_SETTINGS,
                ...data,
                syntaxColors: { ...DEFAULT_SYNTAX_COLORS, ...(data.syntaxColors || {}) },
                // Fresh object for the same reason as syntaxColors: without it,
                // setting a custom icon would write into DEFAULT_SETTINGS itself
                // and "reset to defaults" would hand back the customised copy.
                templateIcons: { ...(data.templateIcons || {}) },
            };
            // Migrate old default colors to new darker palette
            const OLD_DEFAULTS: Record<string, string> = {
                bgDark: '#0d0d1a', bgMain: '#1a1a2e', bgPanel: '#16213e',
                bgSidebar: '#0f1526', editorBg: '#1a1a2e', textDim: '#8888aa',
                // Also migrate v2 dark defaults
                // bgDark: '#06060f' etc already handled by spread with new DEFAULT_SETTINGS
            };
            let migrated = false;
            for (const [key, oldVal] of Object.entries(OLD_DEFAULTS)) {
                if ((userSettings as any)[key] === oldVal) {
                    (userSettings as any)[key] = (DEFAULT_SETTINGS as any)[key];
                    migrated = true;
                }
            }
            if (migrated) saveUserSettings();
        }
    } catch {}
}

function saveUserSettings() {
    try { nodeFs.writeFileSync(SETTINGS_FILE, JSON.stringify(userSettings, null, 2)); } catch {}
    // Also push to cloud if logged in (debounced)
    scheduleCloudSync();
}

let _cloudSyncTimer: ReturnType<typeof setTimeout> | null = null;
let _pullInFlight: Promise<void> | null = null;

function scheduleCloudSync() {
    if (_cloudSyncTimer) clearTimeout(_cloudSyncTimer);
    _cloudSyncTimer = setTimeout(async () => {
        _cloudSyncTimer = null;
        if (!authService.isLoggedIn()) return;
        // Don't push while a cloud pull is in flight — we'd overwrite the cloud
        // with pre-pull (stale) local data. Re-arm and try after it settles.
        if (_pullInFlight) { scheduleCloudSync(); return; }
        try {
            const cloudData: any = { ...userSettings };
            // Also include Discord auth if present
            const _dau = getDiscordAuthUser();
            if (_dau) {
                cloudData.discord = _dau;
            }
            // Include GitHub config if present
            const ghConfigFile = nodePath.join(nodeOs.homedir(), '.nexia-ide-github.json');
            try {
                if (nodeFs.existsSync(ghConfigFile)) {
                    cloudData.github = JSON.parse(nodeFs.readFileSync(ghConfigFile, 'utf-8'));
                }
            } catch {}
            await authService.saveCloudSettings(cloudData);
        } catch {}
    }, 2000); // 2 second debounce
}

async function pullCloudSettings() {
    if (!authService.isLoggedIn()) return;
    // Single-flight: a login fires this from both init() and the auth-state
    // listener — coalesce so two concurrent pulls don't both overwrite local
    // settings or interleave their file writes (last-writer-wins clobber).
    if (_pullInFlight) return _pullInFlight;
    // Cancel any pending debounced push so it can't fire with pre-pull (stale)
    // local data while we're pulling.
    if (_cloudSyncTimer) { clearTimeout(_cloudSyncTimer); _cloudSyncTimer = null; }

    _pullInFlight = (async () => {
    try {
        const result = await authService.loadCloudSettings();
        if (!result || !result.settings || Object.keys(result.settings).length === 0) return;
        const cloud = result.settings as any;

        // Merge cloud settings into local — cloud wins for preferences
        const prefKeys = [
            'fontSize', 'accentColor', 'bgDark', 'bgMain', 'bgPanel', 'bgSidebar',
            'editorBg', 'textColor', 'textDim', 'fancyEffects', 'layout', 'cornerRadius',
            'colorMode', 'aiProvider', 'aiApiKey', 'aiEndpoint', 'aiModel',
            'aiSystemPrompt', 'aiAutoErrors', 'aiInlineSuggest', 'aiFileContext',
            'skin', 'syntaxColors',
        ];
        for (const key of prefKeys) {
            if (cloud[key] === undefined) continue;
            if (key === 'syntaxColors') {
                // Merged, not assigned: a cloud copy written by an older client
                // may hold only some tokens, and a straight assignment would drop
                // the rest to undefined and render those tokens uncoloured.
                userSettings.syntaxColors = {
                    ...DEFAULT_SYNTAX_COLORS,
                    ...(userSettings.syntaxColors || {}),
                    ...cloud[key],
                };
                continue;
            }
            (userSettings as any)[key] = cloud[key];
        }
        // Save merged settings locally
        try { nodeFs.writeFileSync(SETTINGS_FILE, JSON.stringify(userSettings, null, 2)); } catch {}

        // Restore Discord auth from cloud
        if (cloud.discord && cloud.discord.accessToken) {
            setDiscordAuthUser({
                id: cloud.discord.id,
                username: cloud.discord.username,
                avatarUrl: cloud.discord.avatarUrl || null,
            });
            // Also persist to main process
            await ipcRenderer.invoke(IPC.DISCORD_AUTH_START).catch(() => {});
            // Store the discord user data for the main process
            const discordSettingsFile = nodePath.join(nodeOs.homedir(), '.nexia-ide-discord-user.json');
            try { nodeFs.writeFileSync(discordSettingsFile, JSON.stringify(cloud.discord, null, 2)); } catch {}
        }

        // Restore GitHub auth from cloud
        if (cloud.github && cloud.github.token) {
            const ghConfigFile = nodePath.join(nodeOs.homedir(), '.nexia-ide-github.json');
            try { nodeFs.writeFileSync(ghConfigFile, JSON.stringify(cloud.github, null, 2)); } catch {}
        }

        // Apply theme
        applyThemeColors();
        appendOutput('Cloud settings synced.\n');
    } catch {}

    // Fetch Discord bot config from Nexia server (token stays server-side, delivered to authenticated users)
    try {
        const discordConfig = await authService.fetchDiscordConfig();
        if (discordConfig && discordConfig.botToken) {
            await ipcRenderer.invoke(IPC.DISCORD_CONFIGURE, {
                botToken: discordConfig.botToken,
                channelId: discordConfig.channelId || '1459211832437903380',
                clientId: discordConfig.clientId || '1471724753730408622',
                clientSecret: discordConfig.clientSecret || '',
                enabled: true,
            });
        }
    } catch {}
    })();

    try {
        await _pullInFlight;
    } finally {
        _pullInFlight = null;
    }
}

// ── Learning-Profile Cloud Sync ──
// Mirrors the settings sync above: debounced push of the profile snapshot,
// single-flight pull-and-merge on login. Merge is monotonic (see
// learningProfile.mergeSnapshot) so devices never clobber each other.

let _progressSyncTimer: ReturnType<typeof setTimeout> | null = null;
let _progressPullInFlight: Promise<void> | null = null;

function scheduleProgressSync() {
    if (_progressSyncTimer) clearTimeout(_progressSyncTimer);
    _progressSyncTimer = setTimeout(async () => {
        _progressSyncTimer = null;
        if (!authService.isLoggedIn()) return;
        // Don't push mid-pull — we'd upload pre-merge (stale) data. Re-arm.
        if (_progressPullInFlight) { scheduleProgressSync(); return; }
        try { await authService.saveCloudProgress(learningProfile.serialize()); } catch {}
    }, 2500); // debounce
}

async function pullCloudProgress() {
    if (!authService.isLoggedIn()) return;
    if (_progressPullInFlight) return _progressPullInFlight;
    if (_progressSyncTimer) { clearTimeout(_progressSyncTimer); _progressSyncTimer = null; }

    _progressPullInFlight = (async () => {
        try {
            const result = await authService.loadCloudProgress();
            if (result && result.progress) {
                const changed = learningProfile.mergeSnapshot(result.progress);
                if (changed) {
                    learningProfile.save();
                    try { renderLearnPanel(); } catch {}
                    appendOutput('Cloud learning progress synced.\n');
                }
                // Push the merged union back so the cloud reflects both devices.
                try { await authService.saveCloudProgress(learningProfile.serialize()); } catch {}
            } else {
                // No cloud progress yet — seed it from local so other devices can pull.
                try { await authService.saveCloudProgress(learningProfile.serialize()); } catch {}
            }
        } catch {}
    })();

    try { await _progressPullInFlight; } finally { _progressPullInFlight = null; }
}

// ── Visual Studio import ──
// Pick a .sln/.vcxproj, show exactly what will be brought over, then copy it
// into a real Nexia project. Nothing is written until the user confirms.

async function importFromVisualStudio() {
    const picked = await ipcRenderer.invoke(IPC.VS_PICK);
    if (!picked.success) {
        if (picked.error && picked.error !== 'Cancelled') appendOutput('VS import: ' + picked.error + '\n');
        return;
    }

    const projects: any[] = picked.projects || [];
    let selected = projects[0];

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:100001;display:flex;align-items:center;justify-content:center';
    const modal = document.createElement('div');
    modal.style.cssText = 'width:min(620px,94vw);max-height:88vh;display:flex;flex-direction:column;background:var(--bg-panel);border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden;box-shadow:0 24px 70px rgba(0,0,0,0.6)';
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    async function render() {
        const prev = await ipcRenderer.invoke(IPC.VS_PREVIEW, selected.path);
        const p = prev.success ? prev.preview : null;

        modal.innerHTML = `
            <div style="padding:18px 20px 12px;border-bottom:1px solid var(--border)">
                <div style="font-size:15px;font-weight:600;color:var(--text)">Import from Visual Studio</div>
                <div style="font-size:11.5px;color:var(--text-muted);margin-top:3px">${escapeHtml(picked.kind === 'sln' ? picked.name + '.sln' : selected.name)}${(picked.totalProjects || projects.length) > 1 ? ` · ${picked.totalProjects || projects.length} projects` : ''}</div>
            </div>
            <div style="padding:16px 20px;overflow-y:auto;flex:1">
                ${projects.length > 1 ? `
                    <div style="font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--text-muted);margin-bottom:7px">Project to import</div>
                    <div style="display:flex;flex-direction:column;gap:4px;margin-bottom:16px">
                        ${projects.map((pr, i) => `
                            <button class="vs-proj" data-i="${i}" style="text-align:left;padding:8px 10px;border:1px solid ${pr.path === selected.path ? 'var(--green)' : 'var(--border)'};background:${pr.path === selected.path ? 'var(--green-bg)' : 'var(--bg-input)'};color:var(--text);border-radius:var(--radius-sm);cursor:pointer;font-size:12px">
                                ${escapeHtml(pr.name)}${pr.exists ? '' : ' <span style="color:var(--red)">(missing)</span>'}
                            </button>`).join('')}
                    </div>` : ''}
                ${!p ? `<div style="color:var(--red);font-size:12.5px">Couldn't read that project: ${escapeHtml(prev.error || 'unknown error')}</div>` : `
                    <div style="font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--text-muted);margin-bottom:7px">What comes over</div>
                    <div style="background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius-md);padding:12px 14px;font-size:12px;color:var(--text);line-height:1.9">
                        <div><b>${p.sourceCount}</b> source file${p.sourceCount === 1 ? '' : 's'} · <b>${p.headerCount}</b> header${p.headerCount === 1 ? '' : 's'}${p.otherCount ? ` · <b>${p.otherCount}</b> other` : ''}</div>
                        <div>Type: <b>${escapeHtml(p.type)}</b> · Format: <b>${escapeHtml(p.format)}</b>${p.pchHeader ? ` · PCH: <b>${escapeHtml(p.pchHeader)}</b>` : ''}</div>
                        ${p.libraries.length ? `<div>Libraries: <span style="color:var(--text-dim)">${escapeHtml(p.libraries.join(', '))}</span></div>` : ''}
                        ${p.defines.length ? `<div>Defines: <span style="color:var(--text-dim)">${escapeHtml(p.defines.join(', '))}</span></div>` : ''}
                        ${p.includeDirectories.length ? `<div>Include dirs: <span style="color:var(--text-dim)">${escapeHtml(p.includeDirectories.join(', '))}</span></div>` : ''}
                        <div>Goes to: <span style="color:var(--text-dim)">${escapeHtml((p.destination || '') + '\\' + selected.name)}</span></div>
                    </div>
                    ${(p.projectReferences || []).length ? `
                        <div style="font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--text-muted);margin:14px 0 6px">Depends on</div>
                        <div style="background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius-md);padding:10px 12px;font-size:11.5px;line-height:1.7">
                            ${p.projectReferences.map((r: any) => {
                                if (!r.isStaticLibrary) return `<div style="color:var(--text-dim)">${escapeHtml(r.name)} — not a library, nothing to link</div>`;
                                if (!r.resolved) return `<div style="color:var(--yellow)">⚠ ${escapeHtml(r.name)} — built library not found. Build it in Visual Studio first, or the link will fail.</div>`;
                                return `<div style="color:var(--text)">✓ ${escapeHtml(r.name)} <span style="color:var(--text-dim)">— ${r.insideSdk ? 'linked from your SDK, not copied' : 'linked from its build output'}</span></div>`;
                            }).join('')}
                        </div>` : ''}
                    ${p.warnings.length ? `
                        <div style="font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--yellow);margin:14px 0 6px">Worth knowing (${p.warnings.length})</div>
                        <div style="background:rgba(204,167,0,0.07);border:1px solid rgba(204,167,0,0.25);border-radius:var(--radius-md);padding:10px 12px;max-height:120px;overflow-y:auto">
                            ${p.warnings.map((w: string) => `<div style="font-size:11px;color:var(--text-dim);line-height:1.6">• ${escapeHtml(w)}</div>`).join('')}
                        </div>` : ''}
                    <div style="font-size:11px;color:var(--text-muted);margin-top:12px;line-height:1.6">
                        Your Visual Studio project is <b>copied, never moved</b> — the original keeps working.
                        Anything that lives in the Xbox 360 SDK is linked from there rather than copied in.
                    </div>`}
                <div id="vs-result" style="display:none;margin-top:14px;font-size:12px"></div>
            </div>
            <div style="display:flex;gap:8px;justify-content:flex-end;padding:14px 20px;border-top:1px solid var(--border)">
                <button id="vs-cancel" class="welcome-btn">Cancel</button>
                <button id="vs-go" class="welcome-btn" style="background:var(--green);color:#06120d;border-color:var(--green);font-weight:600" ${p ? '' : 'disabled'}>Import</button>
            </div>`;

        modal.querySelectorAll('.vs-proj').forEach(b => b.addEventListener('click', () => {
            selected = projects[parseInt((b as HTMLElement).dataset.i!, 10)];
            render();
        }));
        modal.querySelector('#vs-cancel')!.addEventListener('click', close);
        modal.querySelector('#vs-go')!.addEventListener('click', async () => {
            const go = modal.querySelector('#vs-go') as HTMLButtonElement;
            const res = modal.querySelector('#vs-result') as HTMLElement;
            go.disabled = true; go.textContent = 'Importing…';
            const r = await ipcRenderer.invoke(IPC.VS_IMPORT, {
                projectPath: selected.path,
                name: selected.name,
                // Lets the project record the solution it came from, so the
                // Explorer can show its sibling projects and dependencies.
                solutionPath: picked.solutionPath || undefined,
            });
            if (!r.success) {
                res.style.display = 'block';
                res.style.color = r.error === 'Cancelled' ? 'var(--text-dim)' : 'var(--red)';
                res.textContent = r.error === 'Cancelled' ? 'Import cancelled.' : 'Import failed: ' + r.error;
                go.disabled = false; go.textContent = 'Import';
                return;
            }
            const rep = r.report;
            appendOutput(`Imported "${rep.config.name}" from Visual Studio — ${rep.filesCopied} files (${(rep.bytesCopied / 1048576).toFixed(1)} MB).\n`);
            if (rep.skipped.length) appendOutput(`  ${rep.skipped.length} file(s) skipped: ${rep.skipped.slice(0, 5).join(', ')}${rep.skipped.length > 5 ? '…' : ''}\n`);
            close();
            try { await openProject(rep.config.path); } catch { appendOutput('Imported, but failed to open it automatically.\n'); }
        });
    }

    render();
}

// ── Welcome-back / account prompt ──
// Shown only when NOT signed in. Signed-in users are never interrupted by this —
// the release popup is the only thing that greets them.

function showAccountPrompt(onResolved?: () => void) {
    const last = authService.getLastAccount();

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:99998;display:flex;align-items:center;justify-content:center';
    const modal = document.createElement('div');
    modal.style.cssText = 'width:min(500px,92vw);background:var(--bg-panel);border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden;box-shadow:0 24px 70px rgba(0,0,0,0.6)';
    overlay.appendChild(modal);

    function done() {
        overlay.remove();
        document.removeEventListener('keydown', onKey);
        onResolved?.();
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') done(); }

    const src = userAvatarSrc(last as any);
    const face = src
        ? `<img src="${escapeHtml(src)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;border-radius:50%">`
        : escapeHtml(userInitial(last as any));

    modal.innerHTML = `
        <div style="padding:22px 22px 4px">
            ${last ? `
                <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
                    <div style="width:40px;height:40px;border-radius:50%;background:var(--green);color:#06120d;display:grid;place-items:center;font-weight:700;font-size:14px;overflow:hidden">${face}</div>
                    <div>
                        <div style="font-size:15px;font-weight:600;color:var(--text)">Welcome back, ${escapeHtml(last.username)}</div>
                        <div style="font-size:12px;color:var(--text-muted)">Last signed in as ${escapeHtml(last.email || '')}</div>
                    </div>
                </div>
                <div style="font-size:12.5px;color:var(--text-dim);line-height:1.6">Your session has ended. Sign back in to keep your progress, lessons and settings synced.</div>`
            : `
                <div style="font-size:15px;font-weight:600;color:var(--text);margin-bottom:6px">Sign in to Nexia</div>
                <div style="font-size:12.5px;color:var(--text-dim);line-height:1.6">An account syncs your progress and unlocks cloud lessons. You can also use the IDE without one.</div>`}
        </div>
        <div style="padding:16px 22px 4px">
            <div style="display:flex;gap:14px;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius-md);padding:12px 14px">
                <div style="flex:1">
                    <div style="font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--green);margin-bottom:6px">With an account</div>
                    <div style="font-size:11.5px;color:var(--text-dim);line-height:1.75">
                        ✓ Progress syncs across devices<br>
                        ✓ Download &amp; update cloud lessons<br>
                        ✓ Settings follow you everywhere<br>
                        ✓ Discord community features
                    </div>
                </div>
                <div style="width:1px;background:var(--border)"></div>
                <div style="flex:1">
                    <div style="font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--text-muted);margin-bottom:6px">Without one</div>
                    <div style="font-size:11.5px;color:var(--text-dim);line-height:1.75">
                        ✓ Editor, build &amp; SDK tools<br>
                        ✓ Devkit, emulator &amp; curriculum<br>
                        ✗ Progress stays on this PC only<br>
                        ✗ No cloud lessons or sync
                    </div>
                </div>
            </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;padding:16px 22px 20px">
            ${last
                ? `<button id="ap-same" class="welcome-btn" style="background:var(--green);color:#06120d;border-color:var(--green);font-weight:600;justify-content:center">Sign in as ${escapeHtml(last.username)}</button>
                   <button id="ap-diff" class="welcome-btn" style="justify-content:center">Use a different account</button>`
                : `<button id="ap-diff" class="welcome-btn" style="background:var(--green);color:#06120d;border-color:var(--green);font-weight:600;justify-content:center">Sign in</button>
                   <button id="ap-new" class="welcome-btn" style="justify-content:center">Create an account</button>`}
            <button id="ap-none" class="welcome-btn" style="justify-content:center;border-color:transparent;color:var(--text-dim)">Continue without an account</button>
        </div>`;

    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);

    modal.querySelector('#ap-same')?.addEventListener('click', () => { done(); authUI.showLogin(last?.email); });
    modal.querySelector('#ap-diff')?.addEventListener('click', () => { done(); authUI.showLogin(); });
    modal.querySelector('#ap-new')?.addEventListener('click', () => { done(); authUI.showRegister(); });
    modal.querySelector('#ap-none')?.addEventListener('click', () => {
        appendOutput('Continuing without an account — progress will stay on this PC.\n');
        done();
    });
}

// ── Software Updates ──
// Clients poll the release manifest on the Nexia server. If it advertises a
// newer version than this build, we surface the release popup. The installer
// is fetched from the CDN path and hash-verified in the main process.

let _updatePromptShown = false;

async function checkForUpdates(): Promise<void> {
    try {
        if (_updatePromptShown) return;
        const appVersion: string = await ipcRenderer.invoke('app:version');
        const resp = await fetch(authService.getServerUrl() + '/api/updates/latest', {
            signal: AbortSignal.timeout(8000),
        });
        if (!resp.ok) return;
        const data = await resp.json();
        const u = data?.update;
        if (!u?.version || !u?.downloadUrl) return;
        if (cmpVersions(u.version, appVersion) <= 0) return; // already current
        _updatePromptShown = true;
        showUpdateModal(u, appVersion);
    } catch { /* offline / server down — never block startup on this */ }
}

function showUpdateModal(u: any, currentVersion: string) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:100000;display:flex;align-items:center;justify-content:center';
    const modal = document.createElement('div');
    modal.style.cssText = 'width:min(520px,92vw);background:var(--bg-panel);border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden;box-shadow:0 24px 70px rgba(0,0,0,0.6)';
    overlay.appendChild(modal);

    const notes: string[] = Array.isArray(u.notes) ? u.notes : [];
    const sizeMb = u.size ? (u.size / 1048576).toFixed(1) + ' MB' : '';

    function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape' && !u.mandatory) close(); }

    modal.innerHTML = `
        <div style="padding:20px 22px 0">
            <div style="display:flex;align-items:center;gap:10px">
                <span style="font-size:20px">🚀</span>
                <div style="font-size:16px;font-weight:600;color:var(--text)">Nexia IDE v${escapeHtml(displayVersion(u.version))} has been released!</div>
            </div>
            <!--
                The manifest's title field used to render here as a grey
                subtitle. In practice it restated the headline directly above it
                - "Nexia IDE v3.1 has been released!" over "Nexia IDE 3.1" - so
                it was a line of noise between the reader and the actual changes.
                The notes below say what happened; the heading says which
                version. Nothing left for a subtitle to add.
            -->
        </div>
        <div style="padding:16px 22px">
            <div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--text-muted);margin-bottom:8px">What's new</div>
            <div id="upd-notes" style="max-height:210px;overflow-y:auto;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius-md);padding:12px 14px">
                ${notes.length
                    ? notes.map(n => `<div style="display:flex;gap:8px;font-size:12.5px;color:var(--text);line-height:1.6;margin-bottom:5px"><span style="color:var(--green)">•</span><span>${escapeHtml(n)}</span></div>`).join('')
                    : '<div style="font-size:12.5px;color:var(--text-dim)">General improvements and fixes.</div>'}
            </div>
            <div style="display:flex;gap:10px;font-size:11px;color:var(--text-muted);margin-top:10px">
                <span>You have v${escapeHtml(displayVersion(currentVersion))}</span>${sizeMb ? `<span>·</span><span>Download ${sizeMb}</span>` : ''}${u.mandatory ? '<span>·</span><span style="color:var(--yellow)">Required update</span>' : ''}
            </div>
            <div id="upd-prog" style="display:none;margin-top:14px">
                <div style="height:6px;background:var(--bg-dark);border-radius:3px;overflow:hidden"><div id="upd-bar" style="height:100%;width:0%;background:var(--green);transition:width .15s"></div></div>
                <div id="upd-stat" style="font-size:11px;color:var(--text-dim);margin-top:6px">Starting download…</div>
            </div>
        </div>
        <div style="display:flex;gap:8px;padding:14px 22px 18px;border-top:1px solid var(--border)">
            <div style="font-size:12.5px;color:var(--text-dim);align-self:center;flex:1">Would you like to install it?</div>
            ${u.mandatory ? '' : '<button id="upd-later" class="welcome-btn">Later</button>'}
            <button id="upd-install" class="welcome-btn" style="background:var(--green);color:#06120d;border-color:var(--green);font-weight:600">Install Now</button>
        </div>`;

    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
    modal.querySelector('#upd-later')?.addEventListener('click', close);

    modal.querySelector('#upd-install')!.addEventListener('click', async () => {
        const btn = modal.querySelector('#upd-install') as HTMLButtonElement;
        const later = modal.querySelector('#upd-later') as HTMLButtonElement | null;
        btn.disabled = true; btn.textContent = 'Downloading…';
        if (later) later.disabled = true;
        (modal.querySelector('#upd-prog') as HTMLElement).style.display = 'block';

        const bar = modal.querySelector('#upd-bar') as HTMLElement;
        const stat = modal.querySelector('#upd-stat') as HTMLElement;
        const onProg = (_e: any, p: any) => {
            bar.style.width = p.pct + '%';
            stat.textContent = `Downloading… ${p.pct}% (${(p.received / 1048576).toFixed(1)} / ${(p.total / 1048576).toFixed(1)} MB)`;
        };
        ipcRenderer.on('update:progress', onProg);

        const res = await ipcRenderer.invoke('update:download', {
            url: u.downloadUrl, sha256: u.sha256 || null, version: u.version,
        });
        ipcRenderer.removeListener('update:progress', onProg);

        if (!res?.success) {
            stat.textContent = 'Update failed: ' + (res?.error || 'unknown error');
            stat.style.color = 'var(--red)';
            btn.disabled = false; btn.textContent = 'Retry';
            if (later) later.disabled = false;
            return;
        }
        stat.textContent = 'Verified. Launching installer…';
        btn.textContent = 'Installing…';
        await ipcRenderer.invoke('update:install', res.path);
    });
}

// ── Session State (open tabs, active file, last project) ──
interface SessionState {
    lastProjectPath?: string;
    openFiles?: string[];
    activeFile?: string | null;
}

const SESSION_FILE = nodePath.join(nodeOs.homedir(), '.nexia-ide-session.json');

function loadSession(): SessionState {
    try {
        if (nodeFs.existsSync(SESSION_FILE)) {
            return JSON.parse(nodeFs.readFileSync(SESSION_FILE, 'utf-8'));
        }
    } catch {}
    return {};
}

function saveSession() {
    try {
        const session: SessionState = {
            lastProjectPath: currentProject?.path || undefined,
            openFiles: openTabs
                .filter(t => !t.path.startsWith('__'))  // Skip virtual tabs (XEX inspector, etc.)
                .map(t => t.path),
            activeFile: activeTab && !activeTab.startsWith('__') ? activeTab : null,
        };
        nodeFs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
    } catch {}
}

async function restoreSession() {
    const session = loadSession();
    if (!session.lastProjectPath || !session.openFiles?.length) return;

    // Only restore if the same project was reopened (or auto-opened)
    if (!currentProject || currentProject.path !== session.lastProjectPath) return;

    // Re-open each file that still exists
    for (const filePath of session.openFiles) {
        try {
            if (nodeFs.existsSync(filePath)) {
                await openFile(filePath);
            }
        } catch {}
    }

    // Switch to the previously active tab
    if (session.activeFile && openTabs.find(t => t.path === session.activeFile)) {
        switchToTab(session.activeFile);
    }
}

function applyThemeColors() {
    // Structural skin (Blade / Devkit / Phosphor) — CSS is scoped to [data-skin].
    document.documentElement.dataset.skin = userSettings.skin || 'default';

    const r = document.documentElement.style;
    r.setProperty('--green', userSettings.accentColor);
    // Compute dim/bg variants from accent
    r.setProperty('--green-dark', shiftColor(userSettings.accentColor, -20));
    r.setProperty('--green-dim', shiftColor(userSettings.accentColor, -60));
    r.setProperty('--green-bright', shiftColor(userSettings.accentColor, 30));
    r.setProperty('--green-bg', userSettings.accentColor + '14');
    r.setProperty('--green-bg-hover', userSettings.accentColor + '26');
    r.setProperty('--green-glow', userSettings.accentColor + '28');
    r.setProperty('--green-glow-strong', userSettings.accentColor + '55');
    r.setProperty('--green-glow-soft', userSettings.accentColor + '10');
    r.setProperty('--bg-dark', userSettings.bgDark);
    r.setProperty('--bg-base', userSettings.bgMain);
    r.setProperty('--bg-main', userSettings.bgMain);
    r.setProperty('--bg-panel', userSettings.bgPanel);
    r.setProperty('--bg-sidebar', userSettings.bgSidebar);
    r.setProperty('--bg-titlebar', shiftColor(userSettings.bgMain, 20));
    r.setProperty('--bg-activitybar', shiftColor(userSettings.bgSidebar, 14));
    r.setProperty('--bg-tab', shiftColor(userSettings.bgMain, 15));
    r.setProperty('--bg-tab-active', userSettings.bgMain);
    r.setProperty('--bg-elevated', shiftColor(userSettings.bgMain, 15));
    r.setProperty('--bg-input', shiftColor(userSettings.bgMain, 20));
    r.setProperty('--bg-hover', shiftColor(userSettings.bgMain, 12));
    r.setProperty('--bg-active', shiftColor(userSettings.bgMain, 25));
    r.setProperty('--text', userSettings.textColor);
    r.setProperty('--text-bright', shiftColor(userSettings.textColor, 30));
    r.setProperty('--text-dim', userSettings.textDim);
    r.setProperty('--text-muted', shiftColor(userSettings.textDim, -40));

    // Update Monaco editor theme if loaded
    const monaco = (window as any).monaco;
    if (monaco && editor) {
        defineEditorTheme();
        monaco.editor.setTheme('nexia-dark');
    }
}

function applyColorMode(mode: string) {
    document.documentElement.dataset.colorMode = mode;
    userSettings.colorMode = mode;
    saveUserSettings();

    if (mode === 'auto') {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        document.documentElement.classList.toggle('light-mode', !prefersDark);
    } else if (mode === 'light') {
        document.documentElement.classList.add('light-mode');
    } else {
        document.documentElement.classList.remove('light-mode');
    }
}

function applyFancyMode() {
    document.body.classList.toggle('fancy', userSettings.fancyEffects);
}

function applyLayout() {
    const layout = userSettings.layout || 'sidebar-left';
    const root = document.documentElement;

    /* Reset layout classes */
    document.body.classList.remove('layout-sidebar-left', 'layout-sidebar-right', 'layout-ai-right');

    if (layout === 'sidebar-right') {
        document.body.classList.add('layout-sidebar-right');
    } else if (layout === 'ai-right') {
        document.body.classList.add('layout-ai-right');
    } else {
        document.body.classList.add('layout-sidebar-left');
    }

    /* Mark active layout option in settings */
    document.querySelectorAll('.layout-option').forEach(o => {
        o.classList.toggle('active', (o as HTMLElement).dataset.layout === layout);
    });
}

function applyCornerRadius() {
    const radius = userSettings.cornerRadius || 'rounded';
    const root = document.documentElement;
    const map: Record<string, string[]> = {
        'sharp':   ['0px', '0px', '0px', '0px', '0px'],
        'subtle':  ['2px', '3px', '4px', '4px', '6px'],
        'rounded': ['3px', '4px', '6px', '8px', '12px'],
        'pill':    ['4px', '6px', '10px', '14px', '20px'],
    };
    const vals = map[radius] || map['rounded'];
    root.style.setProperty('--radius-xs', vals[0]);
    root.style.setProperty('--radius-sm', vals[1]);
    root.style.setProperty('--radius-md', vals[2]);
    root.style.setProperty('--radius-lg', vals[3]);
    root.style.setProperty('--radius-xl', vals[4]);

    const sel = document.getElementById('setting-corner-radius') as HTMLSelectElement;
    if (sel) sel.value = radius;
}

/**
 * Right-click → Cut, Copy, Paste on text anywhere in the IDE.
 *
 * There was no context menu at all: right-clicking a text box did nothing.
 *
 * The decision has to live here rather than on webContents' 'context-menu'
 * event, because that fires inside the Monaco editor too — Monaco types through
 * a hidden textarea, so it looks editable — and the OS menu would appear
 * stacked on top of Monaco's own, which carries Go to Definition and friends.
 *
 * Anything with its own contextmenu handler (the file tree, tab bar) calls
 * preventDefault, and this checks defaultPrevented so those keep their menus.
 */
function installContextMenu() {
    window.addEventListener('contextmenu', (e: MouseEvent) => {
        // Someone else already claimed this right-click.
        if (e.defaultPrevented) return;

        const t = e.target as HTMLElement | null;
        if (!t) return;

        // Monaco brings its own, with editor commands ours can't offer.
        if (t.closest('.monaco-editor')) return;

        const editable = !!t.closest('input, textarea, [contenteditable="true"]');
        const hasSelection = !!window.getSelection()?.toString().trim();
        if (!editable && !hasSelection) return;

        e.preventDefault();
        ipcRenderer.invoke('ui:contextMenu', { editable, hasSelection });
    });
}

/**
 * Clear compact mode from anyone who had it on.
 *
 * The setting is gone, but a saved prefs file can still carry compactMode:true —
 * and without removing the class those users would be stuck with a shrunken UI
 * and no control left to turn it off.
 */
function clearCompactMode() {
    document.body.classList.remove('compact-mode');
    if ((userSettings as any).compactMode) {
        delete (userSettings as any).compactMode;
        saveUserSettings();
    }
}

function shiftColor(hex: string, amount: number): string {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
    const r = Math.max(0, Math.min(255, parseInt(hex.substring(0,2), 16) + amount));
    const g = Math.max(0, Math.min(255, parseInt(hex.substring(2,4), 16) + amount));
    const b = Math.max(0, Math.min(255, parseInt(hex.substring(4,6), 16) + amount));
    return '#' + [r,g,b].map(c => c.toString(16).padStart(2,'0')).join('');
}

// ── DOM ──
const $ = (id: string) => document.getElementById(id)!;
const $$ = (sel: string) => document.querySelectorAll(sel);

// ══════════════════════════════════════
//  TITLE BAR
// ══════════════════════════════════════
$('btn-minimize').addEventListener('click', () => ipcRenderer.send(IPC.APP_MINIMIZE));
$('btn-maximize').addEventListener('click', () => ipcRenderer.send(IPC.APP_MAXIMIZE));
$('btn-close').addEventListener('click', () => confirmUnsavedAndClose());

// ══════════════════════════════════════
//  MENU BAR
// ══════════════════════════════════════
let openMenu: HTMLElement | null = null;

function closeAllMenus() {
    $$('.menu-item').forEach(m => m.classList.remove('open'));
    openMenu = null;
}

$$('.menu-item').forEach(item => {
    const el = item as HTMLElement;
    el.querySelector('.menu-label')!.addEventListener('click', (e) => {
        e.stopPropagation();
        if (el.classList.contains('open')) {
            closeAllMenus();
        } else {
            closeAllMenus();
            el.classList.add('open');
            openMenu = el;
        }
    });
    // Hover to switch menus while one is open
    el.addEventListener('mouseenter', () => {
        if (openMenu && openMenu !== el) {
            closeAllMenus();
            el.classList.add('open');
            openMenu = el;
        }
    });
});

document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    // Don't close menus when interacting with form controls inside dropdowns (e.g. <select>)
    if (target.closest('.menu-config-row') || target.tagName === 'SELECT' || target.tagName === 'OPTION') return;
    closeAllMenus();
});

// Extra safety: prevent the config select from bubbling events that could close the menu
$('config-select')?.addEventListener('mousedown', (e) => e.stopPropagation());

// Wire up menu actions
function menuAction(id: string, fn: () => void) {
    $(id)?.addEventListener('click', () => { closeAllMenus(); fn(); });
}

menuAction('menu-new-project', () => showNewProjectDialog());
menuAction('menu-open-project', () => openProject());
menuAction('menu-new-file', () => { if (currentProject) inlineCreateItem('file'); else showNewFileDialog(); });
menuAction('menu-save', () => saveCurrentFile());
menuAction('menu-save-all', () => saveAllFiles());
menuAction('menu-close-tab', () => { if (activeTab) closeTab(activeTab); });
menuAction('menu-close-all', () => closeAllTabs());
menuAction('menu-exit', () => confirmUnsavedAndClose());
menuAction('menu-undo', () => { if (editor) editor.trigger('menu', 'undo', null); });
menuAction('menu-redo', () => { if (editor) editor.trigger('menu', 'redo', null); });
menuAction('menu-find', () => { if (editor) editor.trigger('menu', 'actions.find', null); });
menuAction('menu-find-files', () => openFindInFiles());
menuAction('menu-replace', () => { if (editor) editor.trigger('menu', 'editor.action.startFindReplaceAction', null); });
menuAction('menu-goto-line', () => showGoToLine());
menuAction('menu-build', () => doBuild());
menuAction('menu-rebuild', () => doRebuild());
menuAction('menu-clean', () => doClean());
menuAction('menu-deploy', () => doDeploy());
menuAction('menu-project-props', () => openProjectProperties());
menuAction('menu-toggle-sidebar', () => toggleSidebar());
menuAction('menu-toggle-output', () => toggleBottomPanel());
menuAction('menu-extensions', () => {
    // Switch to extensions sidebar tab
    const tab = document.querySelector('.sidebar-tab[data-panel="extensions"]') as HTMLElement;
    if (tab) tab.click();
});
menuAction('menu-sdk-tools', () => showSdkToolsDialog());
menuAction('menu-xex-inspector', () => openXexInspector());
menuAction('menu-settings', () => showSettingsPanel());

// ══════════════════════════════════════
//  SIDEBAR TABS
// ══════════════════════════════════════
let activePanel = 'explorer';
$$('.sidebar-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        $$('.sidebar-tab').forEach(t => t.classList.remove('active'));
        $$('.sidebar-panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        const panel = (tab as HTMLElement).dataset.panel!;
        activePanel = panel;
        $(`panel-${panel}`).classList.add('active');
        // Refresh dynamic panels
        if (panel === 'learn') renderLearnPanel();
        if (panel === 'extensions') renderExtensionsPanel();
        if (panel === 'git') { renderGitPanel(); checkGitConfiguration(); }
        if (panel === 'search') setTimeout(() => ($('search-query') as HTMLInputElement).focus(), 50);
        if (panel === 'ai') checkAIConfiguration();
        if (panel === 'devkit') checkDevkitConfiguration();
    });
});

// ══════════════════════════════════════
//  BOTTOM PANEL TABS + CLOSE
// ══════════════════════════════════════
$$('.bottom-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        $$('.bottom-tab').forEach(t => t.classList.remove('active'));
        $$('.bottom-pane').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        $(`${(tab as HTMLElement).dataset.panel}-panel`).classList.add('active');
        // Refresh tips when switching to tips tab
        if ((tab as HTMLElement).dataset.panel === 'tips') renderTipsPanel();
        if ((tab as HTMLElement).dataset.panel === 'visualizer') {
            setTimeout(() => { codeVisualizer.resizeCanvas(); codeVisualizer.render(); }, 50);
        }
    });
});

$('btn-close-bottom').addEventListener('click', () => toggleBottomPanel());
$('btn-clear-output').addEventListener('click', () => clearOutput());

function toggleBottomPanel() {
    bottomPanelVisible = !bottomPanelVisible;
    $('bottom-panel').classList.toggle('hidden', !bottomPanelVisible);
    $('bottom-resize').classList.toggle('hidden', !bottomPanelVisible);
    $('main').classList.toggle('bottom-hidden', !bottomPanelVisible);
    if (editor) editor.layout();
}

function showBottomPanel() {
    if (!bottomPanelVisible) toggleBottomPanel();
}

function toggleSidebar() {
    sidebarVisible = !sidebarVisible;
    $('sidebar').classList.toggle('hidden', !sidebarVisible);
    $('sidebar-resize').style.display = sidebarVisible ? '' : 'none';
    if (editor) editor.layout();
}

// ══════════════════════════════════════
//  RESIZE HANDLES
// ══════════════════════════════════════
{
    const handle = $('sidebar-resize');
    const sidebar = $('sidebar');
    let resizing = false;
    handle.addEventListener('mousedown', (e) => { resizing = true; document.body.style.cursor = 'col-resize'; e.preventDefault(); });
    document.addEventListener('mousemove', (e) => {
        if (!resizing) return;
        sidebar.style.width = Math.max(180, Math.min(500, e.clientX)) + 'px';
        if (editor) editor.layout();
    });
    document.addEventListener('mouseup', () => { resizing = false; document.body.style.cursor = ''; });
}
{
    const handle = $('bottom-resize');
    const panel = $('bottom-panel');
    let resizing = false;
    handle.addEventListener('mousedown', (e) => { resizing = true; document.body.style.cursor = 'row-resize'; e.preventDefault(); });
    document.addEventListener('mousemove', (e) => {
        if (!resizing) return;
        const h = Math.max(100, Math.min(500, window.innerHeight - e.clientY - 24));
        panel.style.height = h + 'px';
        document.documentElement.style.setProperty('--bottom-h', h + 'px');
        if (editor) editor.layout();
    });
    document.addEventListener('mouseup', () => { resizing = false; document.body.style.cursor = ''; });
}

// ══════════════════════════════════════
//  MONACO EDITOR
// ══════════════════════════════════════
function initMonaco() {
    let monacoBase = '';
    const candidates = [
        nodePath.join(__dirname, '..', '..', 'node_modules', 'monaco-editor', 'min', 'vs'),
        nodePath.join(__dirname, '..', 'node_modules', 'monaco-editor', 'min', 'vs'),
        nodePath.join(process.resourcesPath || '', 'app.asar', 'node_modules', 'monaco-editor', 'min', 'vs'),
        nodePath.join(process.resourcesPath || '', 'app', 'node_modules', 'monaco-editor', 'min', 'vs'),
    ];

    for (const c of candidates) {
        try { if (nodeFs.existsSync(nodePath.join(c, 'loader.js'))) { monacoBase = c; break; } } catch {}
    }

    if (!monacoBase) {
        appendOutput('Error: Monaco editor not found. Tried:\n' + candidates.join('\n') + '\n');
        monacoResolve();
        return;
    }

    appendOutput('Loading editor from: ' + monacoBase + '\n');
    const monacoUrl = monacoBase.replace(/\\/g, '/');

    // CRITICAL: Use ASSIGNMENT (not delete) to override Node.js globals.
    // delete silently fails on Electron's non-configurable properties.
    // All require() calls above have already executed so this is safe.
    const savedRequire = (window as any).require;
    const savedExports = (window as any).exports;
    const savedModule = (window as any).module;
    (window as any).require = undefined;
    (window as any).exports = undefined;
    (window as any).module = undefined;

    const script = document.createElement('script');
    script.src = `file:///${monacoUrl}/loader.js`;

    script.onload = () => {
        const amdRequire = (window as any).require;
        if (!amdRequire || !amdRequire.config) {
            appendOutput('Error: Monaco AMD loader failed. typeof require = ' + typeof (window as any).require + '\n');
            (window as any).require = savedRequire;
            (window as any).exports = savedExports;
            (window as any).module = savedModule;
            monacoResolve();
            return;
        }
        amdRequire.config({
            paths: { vs: `file:///${monacoUrl}` },
            'vs/nls': { availableLanguages: { '*': '' } }
        });
        amdRequire(['vs/editor/editor.main'], () => {
            createEditor();
        }, (err: any) => {
            appendOutput('Error loading Monaco modules: ' + JSON.stringify(err) + '\n');
            monacoResolve();
        });
    };

    script.onerror = (e: any) => {
        appendOutput('Error: Failed to load Monaco loader script.\nURL: file:///' + monacoUrl + '/loader.js\n');
        (window as any).require = savedRequire;
        (window as any).exports = savedExports;
        (window as any).module = savedModule;
        monacoResolve();
    };

    document.head.appendChild(script);
}

function createEditor() {
    const monaco = (window as any).monaco;

    defineEditorTheme();

    editor = monaco.editor.create($('editor-container'), {
        value: '', language: 'cpp', theme: 'nexia-dark',
        fontSize: userSettings.fontSize, fontFamily: "'Cascadia Code', 'Consolas', monospace",
        lineNumbers: 'on', minimap: { enabled: true },
        scrollBeyondLastLine: false, automaticLayout: true,
        tabSize: 4, renderWhitespace: 'selection', wordWrap: 'off',
        suggestOnTriggerCharacters: true,
    });

    // Wire editor to shared context for extracted modules
    appCtx.editor = editor;
    appCtx.monaco = monaco;

    editor.onDidChangeCursorPosition((e: any) => {
        $('status-line').textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
    });

    editor.onDidChangeModelContent(() => {
        if (activeTab) {
            const tab = openTabs.find(t => t.path === activeTab);
            if (tab && !tab.modified) { tab.modified = true; renderTabs(); }
        }
    });

    // Editor font zoom
    let fontSize = userSettings.fontSize || 14;
    editor.updateOptions({ fontSize });
    $('status-zoom').textContent = `${Math.round((fontSize / 14) * 100)}%`;

    registerXbox360Completions(monaco);
    initCodeHelper();

    // ── AI integration with Monaco editor ──
    // Add right-click context menu actions
    editor.addAction({
        id: 'nexia-ai-ask',
        label: '🤖 Ask AI about this code',
        contextMenuGroupId: '9_ai',
        contextMenuOrder: 1,
        run: () => {
            const sel = editor.getModel()?.getValueInRange(editor.getSelection());
            switchToAIPanel();
            if (sel) setAIContext(sel);
            ($('ai-input') as HTMLTextAreaElement).focus();
        },
    });
    editor.addAction({
        id: 'nexia-ai-explain',
        label: '📖 Explain this code',
        contextMenuGroupId: '9_ai',
        contextMenuOrder: 2,
        precondition: 'editorHasSelection',
        run: () => {
            const sel = editor.getModel()?.getValueInRange(editor.getSelection());
            if (sel) { switchToAIPanel(); sendAIMessage('Explain this code in detail:', sel); }
        },
    });
    editor.addAction({
        id: 'nexia-ai-fix',
        label: '🔧 Fix / improve this code',
        contextMenuGroupId: '9_ai',
        contextMenuOrder: 3,
        precondition: 'editorHasSelection',
        run: () => {
            const sel = editor.getModel()?.getValueInRange(editor.getSelection());
            if (sel) { switchToAIPanel(); sendAIMessage('Fix any bugs and suggest improvements:', sel); }
        },
    });
    editor.addAction({
        id: 'nexia-ai-generate',
        label: '⚡ Generate code here',
        contextMenuGroupId: '9_ai',
        contextMenuOrder: 4,
        run: () => { switchToAIPanel(); switchAIMode('generate'); ($('ai-gen-prompt') as HTMLTextAreaElement).focus(); },
    });

    // Inline AI suggestions trigger (fires on content change with debounce)
    editor.onDidChangeModelContent(() => {
        if (userSettings.aiInlineSuggest) triggerInlineSuggestion();
    });

    monacoResolve();
}

function registerXbox360Completions(monaco: any) {
    monaco.languages.registerCompletionItemProvider('cpp', {
        provideCompletionItems: () => {
            const s = [
                { label: 'XOVERLAPPED', kind: 6, insertText: 'XOVERLAPPED', detail: 'Xbox async op' },
                { label: 'XINPUT_STATE', kind: 6, insertText: 'XINPUT_STATE', detail: 'Gamepad state' },
                { label: 'XInputGetState', kind: 1, insertText: 'XInputGetState(${1:dwUserIndex}, ${2:&state})', insertTextRules: 4, detail: 'Get gamepad state' },
                { label: 'Direct3DCreate9', kind: 1, insertText: 'Direct3DCreate9(D3D_SDK_VERSION)', detail: 'Create D3D9' },
                { label: '#include <xtl.h>', kind: 14, insertText: '#include <xtl.h>', detail: 'Xbox Top-Level' },
                { label: '#include <xam.h>', kind: 14, insertText: '#include <xam.h>', detail: 'Xbox App Model' },
                { label: '#include <d3d9.h>', kind: 14, insertText: '#include <d3d9.h>', detail: 'Direct3D 9' },
                { label: '#include <d3dx9.h>', kind: 14, insertText: '#include <d3dx9.h>', detail: 'D3DX9 utility' },
                { label: '#include <xui.h>', kind: 14, insertText: '#include <xui.h>', detail: 'Xbox UI' },
                { label: '#include <xonline.h>', kind: 14, insertText: '#include <xonline.h>', detail: 'Xbox Live' },
            ];
            return { suggestions: s };
        },
    });
}

// ══════════════════════════════════════
//  FILE OPERATIONS
// ══════════════════════════════════════
// ══════════════════════════════════════
//  FILE CHANGE WATCHER
// ══════════════════════════════════════

/**
 * Start watching a file for external changes.
 * When a change is detected, prompts the user to reload or keep their version.
 */
function watchFile(filePath: string) {
    // Don't watch virtual tabs (XEX inspector, etc.)
    if (filePath.startsWith('__')) return;
    // Already watching
    if (fileWatchers.has(filePath)) return;

    try {
        const stat = nodeFs.statSync(filePath);
        let lastMtime = stat.mtimeMs;
        let debounceTimer: any = null;

        const watcher = nodeFs.watch(filePath, { persistent: false }, (eventType: string) => {
            if (eventType !== 'change') return;

            const entry = fileWatchers.get(filePath);
            if (!entry) return;

            // If we just saved this file ourselves, ignore the next change event
            if (entry.ignoreNext) {
                entry.ignoreNext = false;
                return;
            }

            // Debounce — some editors/tools trigger multiple change events
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                try {
                    const newStat = nodeFs.statSync(filePath);
                    // Only prompt if mtime actually changed
                    if (newStat.mtimeMs <= lastMtime) return;
                    lastMtime = newStat.mtimeMs;
                    promptFileChanged(filePath);
                } catch {
                    // File may have been deleted — handled by rename event
                }
            }, 250);
        });

        fileWatchers.set(filePath, { watcher, mtime: lastMtime, ignoreNext: false });
    } catch {
        // File doesn't exist or can't be watched — ignore silently
    }
}

/**
 * Stop watching a file (called when tab is closed).
 */
function unwatchFile(filePath: string) {
    const entry = fileWatchers.get(filePath);
    if (entry) {
        try { entry.watcher.close(); } catch {}
        fileWatchers.delete(filePath);
    }
}

/**
 * Mark a file as "we're about to write to it" so the watcher ignores
 * the next change event (prevents self-triggering on save).
 */
function ignoreNextChange(filePath: string) {
    const entry = fileWatchers.get(filePath);
    if (entry) entry.ignoreNext = true;
}

/**
 * Show a prompt when a file has been changed externally.
 */
function promptFileChanged(filePath: string) {
    const tab = openTabs.find(t => t.path === filePath);
    if (!tab) return;

    const fileName = nodePath.basename(filePath);

    // If the tab has no unsaved changes, silently reload
    if (!tab.modified) {
        reloadFileContent(filePath);
        appendOutput(`Reloaded: ${fileName} (changed externally)\n`);
        return;
    }

    // Tab has unsaved changes — ask the user
    const reload = confirm(
        `"${fileName}" has been modified outside of Nexia IDE.\n\n` +
        `You have unsaved changes. Do you want to reload the file from disk?\n\n` +
        `Click OK to reload (your changes will be lost)\n` +
        `Click Cancel to keep your version`
    );

    if (reload) {
        reloadFileContent(filePath);
        appendOutput(`Reloaded: ${fileName} (changed externally)\n`);
    } else {
        appendOutput(`Kept local version: ${fileName} (external change ignored)\n`);
    }
}

/**
 * Reload a file's content from disk into its Monaco model.
 */
async function reloadFileContent(filePath: string) {
    const tab = openTabs.find(t => t.path === filePath);
    if (!tab) return;

    try {
        const content = await ipcRenderer.invoke(IPC.FILE_READ, filePath);
        // Update the model without triggering the modified flag
        tab.model.setValue(content);
        tab.modified = false;
        renderTabs();

        // Update mtime in watcher
        const entry = fileWatchers.get(filePath);
        if (entry) {
            try {
                const stat = nodeFs.statSync(filePath);
                entry.mtime = stat.mtimeMs;
            } catch {}
        }
    } catch (err: any) {
        appendOutput(`Failed to reload ${nodePath.basename(filePath)}: ${err.message}\n`);
    }
}

async function openFile(filePath: string) {
    await monacoReady;

    if (!editor) {
        appendOutput('Editor not available. Cannot open file.\n');
        return;
    }

    const existing = openTabs.find(t => t.path === filePath);
    if (existing) { switchToTab(filePath); return; }

    try {
        const content = await ipcRenderer.invoke(IPC.FILE_READ, filePath);
        const ext = nodePath.extname(filePath).toLowerCase();
        const langMap: Record<string, string> = {
            '.cpp': 'cpp', '.c': 'cpp', '.cc': 'cpp', '.cxx': 'cpp',
            '.h': 'cpp', '.hpp': 'cpp', '.hxx': 'cpp',
            '.hlsl': 'hlsl', '.fx': 'hlsl', '.vsh': 'hlsl', '.psh': 'hlsl',
            '.xml': 'xml', '.xui': 'xml', '.xur': 'xml',
            '.json': 'json', '.md': 'markdown', '.txt': 'plaintext',
            '.bat': 'bat', '.cmd': 'bat', '.py': 'python',
            '.js': 'javascript', '.ts': 'typescript',
        };

        const lang = langMap[ext] || 'plaintext';
        const monaco = (window as any).monaco;
        const model = monaco.editor.createModel(content, lang);

        openTabs.push({ path: filePath, name: nodePath.basename(filePath), model, modified: false });
        switchToTab(filePath);
        $('status-language').textContent = lang.toUpperCase();
        watchFile(filePath);
        onFileOpened(filePath);
        saveSession();
    } catch (err: any) {
        appendOutput(`Error opening file: ${err.message}\n`);
    }
}

function switchToTab(filePath: string) {
    const tab = openTabs.find(t => t.path === filePath);
    if (!tab) return;
    activeTab = filePath;

    // Handle XEX Inspector tabs
    if (filePath.startsWith('__xex_inspector__:')) {
        $('editor-container').style.display = 'none';
        $('welcome-screen').style.display = 'none';
        if (cinematicContainer) cinematicContainer.style.display = 'none';
        if (xexInspectorContainer) xexInspectorContainer.style.display = 'block';
    // Handle Cinematic Tutor tabs
    } else if (filePath.startsWith('__cinematic__:')) {
        $('editor-container').style.display = 'none';
        $('welcome-screen').style.display = 'none';
        if (xexInspectorContainer) xexInspectorContainer.style.display = 'none';
        if (cinematicContainer) {
            cinematicContainer.style.display = 'flex';
        }
    } else {
        if (xexInspectorContainer) xexInspectorContainer.style.display = 'none';
        if (cinematicContainer) cinematicContainer.style.display = 'none';
        if (editor) editor.setModel(tab.model);
        $('editor-container').style.display = 'block';
        $('welcome-screen').style.display = 'none';
        updateBreadcrumb(filePath);
    }
    renderTabs();
    saveSession();
}

function closeTab(filePath: string) {
    const idx = openTabs.findIndex(t => t.path === filePath);
    if (idx === -1) return;
    const tab = openTabs[idx];
    // Don't prompt save for special tabs
    if (!filePath.startsWith('__xex_inspector__:') && !filePath.startsWith('__cinematic__:') && tab.modified) {
        const save = confirm(`"${tab.name}" has unsaved changes. Save before closing?`);
        if (save) {
            ignoreNextChange(tab.path);
            ipcRenderer.invoke(IPC.FILE_WRITE, tab.path, tab.model.getValue());
        }
    }
    tab.model.dispose();
    unwatchFile(filePath);
    openTabs.splice(idx, 1);
    if (activeTab === filePath) {
        // Hide special containers if they were active
        if (xexInspectorContainer) xexInspectorContainer.style.display = 'none';
        if (cinematicContainer) { cinematicContainer.style.display = 'none'; cinematicEngine.unmount(); }
        if (openTabs.length > 0) {
            switchToTab(openTabs[Math.min(idx, openTabs.length - 1)].path);
        } else {
            activeTab = null;
            $('editor-container').style.display = 'none';
            $('welcome-screen').style.display = 'flex';
            updateBreadcrumb();
        }
    }
    renderTabs();
    saveSession();
}

function closeAllTabs() {
    for (const tab of openTabs) {
        unwatchFile(tab.path);
        tab.model.dispose();
    }
    openTabs = [];
    activeTab = null;
    $('editor-container').style.display = 'none';
    if (xexInspectorContainer) xexInspectorContainer.style.display = 'none';
    if (cinematicContainer) { cinematicContainer.style.display = 'none'; cinematicEngine.unmount(); }
    $('welcome-screen').style.display = 'flex';
    updateBreadcrumb();
    renderTabs();
    saveSession();
}

function renderTabs() {
    const bar = $('tab-bar');
    bar.innerHTML = '';
    for (const tab of openTabs) {
        const el = document.createElement('div');
        el.className = `editor-tab${tab.path === activeTab ? ' active' : ''}`;
        el.innerHTML = `<span class="${tab.modified ? 'tab-modified' : ''}">${tab.modified ? '● ' : ''}${tab.name}</span><button class="tab-close">✕</button>`;
        el.addEventListener('click', (e) => {
            if ((e.target as HTMLElement).closest('.tab-close')) closeTab(tab.path);
            else switchToTab(tab.path);
        });
        bar.appendChild(el);
    }
}

// ══════════════════════════════════════
//  XEX INSPECTOR — Extracted to editor/xexInspector.ts
// ══════════════════════════════════════
const xexMod = require('./editor/xexInspector');
const { openXexInspector, showXexInspector, switchToXexTab, setupXexDropZone } = xexMod;
let xexInspectorContainer = xexMod.xexInspectorContainer;


// ══════════════════════════════════════
//  SAVE
// ══════════════════════════════════════
async function saveCurrentFile() {
    if (!activeTab) return;
    const tab = openTabs.find(t => t.path === activeTab);
    if (!tab) return;
    ignoreNextChange(tab.path);
    await ipcRenderer.invoke(IPC.FILE_WRITE, tab.path, tab.model.getValue());
    tab.modified = false;
    renderTabs();
    appendOutput(`Saved: ${tab.name}\n`);
}

async function saveAllFiles(silent = false) {
    let saved = 0;
    for (const tab of openTabs) {
        if (tab.modified) {
            ignoreNextChange(tab.path);
            await ipcRenderer.invoke(IPC.FILE_WRITE, tab.path, tab.model.getValue());
            tab.modified = false;
            saved++;
        }
    }
    renderTabs();
    if (!silent && saved > 0) appendOutput(`Saved ${saved} file${saved > 1 ? 's' : ''}.\n`);
}

// ══════════════════════════════════════
//  PROJECT PROPERTIES — Extracted to panels/projectProperties.ts
// ══════════════════════════════════════
let _projectPropsMod: any;
try {
    _projectPropsMod = require('./panels/projectProperties');
} catch (err: any) {
    console.error('[ProjectProps] Module load failed:', err.message);
    _projectPropsMod = { initProjectProperties: () => {}, openProjectProperties: () => {} };
}
const { openProjectProperties } = _projectPropsMod;

// ══════════════════════════════════════
//  FILE TREE — Extracted to panels/fileTree.ts
// ══════════════════════════════════════
let _fileTreeMod: any;
try {
    _fileTreeMod = require('./panels/fileTree');
} catch (err: any) {
    console.error('[FileTree] Module load failed:', err.message);
    _fileTreeMod = { initFileTree: () => {}, refreshFileTree: async () => {}, inlineCreateItem: () => {}, getFileIcon: () => '📄' };
}
const { refreshFileTree, inlineCreateItem, getFileIcon } = _fileTreeMod;

// ══════════════════════════════════════
//  OUTPUT
// ══════════════════════════════════════
/**
 * MSVC error/warning patterns:
 *   filepath(line): error CODE: message
 *   filepath(line,col): warning CODE: message
 *   LINK : fatal error LNKXXXX: message
 */
const MSVC_DIAG_RE = /^(.+?)\((\d+)(?:,(\d+))?\)\s*:\s*(error|warning|fatal error)\s+(\w+)\s*:\s*(.*)$/;
const LINK_ERROR_RE = /^(.+?\.obj)\s*:\s*(error|warning)\s+(\w+)\s*:\s*(.*)$/;

function appendOutput(text: string) {
    const el = $('output-text');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip trailing empty segment from split (e.g. "hello\n".split('\n') → ["hello", ""])
        if (i === lines.length - 1 && line === '') {
            continue;
        }

        const msvcMatch = line.match(MSVC_DIAG_RE);
        const linkMatch = !msvcMatch ? line.match(LINK_ERROR_RE) : null;

        if (msvcMatch) {
            const [, file, lineNum, col, severity, code, msg] = msvcMatch;
            const isError = severity.includes('error');

            // Clickable file:line link
            const link = document.createElement('span');
            link.className = isError ? 'output-error-link' : 'output-warn-link';
            link.textContent = `${file}(${lineNum}${col ? ',' + col : ''})`;
            link.title = 'Click to jump to this location';
            link.addEventListener('click', () => {
                jumpToError({ file, line: parseInt(lineNum), column: col ? parseInt(col) : 1 });
            });

            // Rest of line
            const rest = document.createElement('span');
            rest.className = isError ? 'output-error-msg' : 'output-warn-msg';
            rest.textContent = `: ${severity} ${code}: ${msg}`;

            el.appendChild(link);
            el.appendChild(rest);
            el.appendChild(document.createTextNode('\n'));
        } else if (linkMatch) {
            const [, file, severity, code, msg] = linkMatch;
            const isError = severity === 'error';
            const span = document.createElement('span');
            span.className = isError ? 'output-error-msg' : 'output-warn-msg';
            span.textContent = line;
            el.appendChild(span);
            el.appendChild(document.createTextNode('\n'));
        } else {
            el.appendChild(document.createTextNode(line + '\n'));
        }
    }
    // Scroll to bottom
    const pane = el.parentElement;
    if (pane) pane.scrollTop = pane.scrollHeight;
}

function clearOutput() { $('output-text').innerHTML = ''; }

// ══════════════════════════════════════
//  CONTEXT MENU — Extracted to ui/contextMenu.ts
// ══════════════════════════════════════
const { showContextMenu, hideContextMenu, initContextMenu } = require('./ui/contextMenu');
initContextMenu();

// ══════════════════════════════════════
//  FILE OPERATIONS (rename, delete, new in folder)
// ══════════════════════════════════════
async function renameFile(filePath: string) {
    const oldName = nodePath.basename(filePath);
    const newName = prompt('Rename to:', oldName);
    if (!newName || newName === oldName) return;
    try {
        await ipcRenderer.invoke(IPC.FILE_RENAME, filePath, nodePath.join(nodePath.dirname(filePath), newName));
        // Update tab if open
        const tab = openTabs.find(t => t.path === filePath);
        if (tab) {
            tab.path = nodePath.join(nodePath.dirname(filePath), newName);
            tab.name = newName;
            if (activeTab === filePath) activeTab = tab.path;
            renderTabs();
        }
        await refreshFileTree();
    } catch (err: any) { appendOutput(`Rename failed: ${err.message}\n`); }
}

async function deleteFile(filePath: string) {
    const name = nodePath.basename(filePath);
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
    try {
        await ipcRenderer.invoke(IPC.FILE_DELETE, filePath);
        // Close tab if open
        const tab = openTabs.find(t => t.path === filePath);
        if (tab) closeTab(filePath);
        await refreshFileTree();
    } catch (err: any) { appendOutput(`Delete failed: ${err.message}\n`); }
}

async function newFileInFolder(folderPath: string) {
    const name = prompt('New file name:', 'newfile.cpp');
    if (!name) return;
    const fullPath = nodePath.join(folderPath, name);
    try {
        // Default content based on extension
        let content = '';
        if (/\.(cpp|c|cc|cxx)$/i.test(name)) content = '#include "stdafx.h"\n\n';
        else if (/\.(h|hpp)$/i.test(name)) {
            const guard = name.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_';
            content = `#pragma once\n#ifndef ${guard}\n#define ${guard}\n\n\n\n#endif // ${guard}\n`;
        }
        await ipcRenderer.invoke(IPC.FILE_CREATE, fullPath, content);
        await refreshFileTree();
        openFile(fullPath);
    } catch (err: any) { appendOutput(`Create failed: ${err.message}\n`); }
}

// ══════════════════════════════════════
//  TAB CONTEXT MENU
// ══════════════════════════════════════
function initTabContextMenu() {
    $('tab-bar').addEventListener('contextmenu', (e: MouseEvent) => {
        const tabEl = (e.target as HTMLElement).closest('.editor-tab') as HTMLElement;
        if (!tabEl) return;
        e.preventDefault();
        const idx = Array.from($('tab-bar').children).indexOf(tabEl);
        if (idx < 0 || idx >= openTabs.length) return;
        const tab = openTabs[idx];
        showContextMenu(e.clientX, e.clientY, [
            { label: 'Close', action: () => closeTab(tab.path) },
            { label: 'Close Others', action: () => closeOtherTabs(tab.path) },
            { label: 'Close All', action: () => closeAllTabs() },
            { label: '─', action: () => {} },
            { label: 'Copy Path', action: () => { navigator.clipboard.writeText(tab.path); } },
            { label: 'Reveal in Explorer', action: () => { shell.showItemInFolder(tab.path); } },
        ]);
    });
}

function closeOtherTabs(keepPath: string) {
    const toClose = openTabs.filter(t => t.path !== keepPath);
    for (const tab of toClose) {
        // Prompt to save unsaved changes (skip special tabs), and release the
        // file watcher — otherwise fs.watch handles leak for every closed tab.
        if (!tab.path.startsWith('__xex_inspector__:') && !tab.path.startsWith('__cinematic__:') && tab.modified) {
            const save = confirm(`"${tab.name}" has unsaved changes. Save before closing?`);
            if (save) {
                ignoreNextChange(tab.path);
                ipcRenderer.invoke(IPC.FILE_WRITE, tab.path, tab.model.getValue());
            }
        }
        unwatchFile(tab.path);
        tab.model.dispose();
    }
    openTabs = openTabs.filter(t => t.path === keepPath);
    if (!openTabs.find(t => t.path === activeTab)) {
        if (openTabs.length > 0) switchToTab(openTabs[0].path);
        else { activeTab = null; $('editor-container').style.display = 'none'; $('welcome-screen').style.display = 'flex'; }
    }
    renderTabs();
    saveSession();
}

// ══════════════════════════════════════
//  GO TO LINE (Ctrl+G)
// ══════════════════════════════════════
function showGoToLine() {
    if (!editor || !activeTab) return;
    const lineCount = editor.getModel()?.getLineCount() || 1;
    const input = prompt(`Go to Line (1-${lineCount}):`);
    if (!input) return;
    const line = parseInt(input, 10);
    if (isNaN(line) || line < 1) return;
    const target = Math.min(line, lineCount);
    editor.revealLineInCenter(target);
    editor.setPosition({ lineNumber: target, column: 1 });
    editor.focus();
}

// ══════════════════════════════════════
//  UNSAVED CHANGES PROMPT
// ══════════════════════════════════════
function hasUnsavedChanges(): boolean {
    return openTabs.some(t => t.modified);
}

function confirmUnsavedAndClose() {
    // Save learning progress before closing
    learningProfile.endSession();
    learningProfile.save();
    // Best-effort final push of learning progress to the cloud on exit.
    if (authService.isLoggedIn()) { try { authService.saveCloudProgress(learningProfile.serialize()); } catch {} }

    if (hasUnsavedChanges()) {
        const choice = confirm('You have unsaved changes. Save all before closing?');
        if (choice) {
            saveAllFiles().then(() => ipcRenderer.send(IPC.APP_CLOSE));
            return;
        }
    }
    ipcRenderer.send(IPC.APP_CLOSE);
}

// ══════════════════════════════════════
//  BUILD
// ══════════════════════════════════════
async function doBuild() {
    if (!currentProject) { appendOutput('No project open.\n'); return; }
    await saveAllFiles(true);
    clearOutput(); showBottomPanel();
    setBuildStatus('building');
    try {
        const result = await ipcRenderer.invoke(IPC.BUILD_RUN, { configuration: ($('config-select') as HTMLSelectElement).value });
        setBuildStatus(result.success ? 'succeeded' : 'failed');
    } catch { setBuildStatus('failed'); }
}
async function doRebuild() {
    if (!currentProject) { appendOutput('No project open.\n'); return; }
    await saveAllFiles(true);
    clearOutput(); showBottomPanel();
    setBuildStatus('building');
    try {
        const result = await ipcRenderer.invoke(IPC.BUILD_REBUILD, { configuration: ($('config-select') as HTMLSelectElement).value });
        setBuildStatus(result.success ? 'succeeded' : 'failed');
    } catch { setBuildStatus('failed'); }
}
async function doClean() {
    if (!currentProject) { appendOutput('No project open.\n'); return; }
    clearOutput(); showBottomPanel();
    await ipcRenderer.invoke(IPC.BUILD_CLEAN);
    appendOutput('Clean complete.\n');
    setBuildStatus('ready');
}

function setBuildStatus(state: 'ready' | 'building' | 'succeeded' | 'failed') {
    const el = $('status-build');
    const labels: Record<string, string> = {
        ready: '● Ready', building: '⏳ Building...', succeeded: '✔ Build Succeeded', failed: '✗ Build Failed'
    };
    el.textContent = labels[state];
    el.className = 'status-build-' + state;
}

ipcRenderer.on(IPC.BUILD_OUTPUT, (_e: any, data: string) => appendOutput(data));
ipcRenderer.on(IPC.TOOL_OUTPUT, (_e: any, data: string) => appendOutput(data));
ipcRenderer.on(IPC.BUILD_COMPLETE, (_e: any, result: any) => {
    const list = $('problems-list');
    list.innerHTML = '';
    const errCount = (result.errors || []).length;
    const warnCount = (result.warnings || []).length;
    // Update problems tab label
    const problemsTab = document.querySelector('[data-panel="problems"]');
    if (problemsTab) problemsTab.textContent = `PROBLEMS${errCount + warnCount > 0 ? ` (${errCount + warnCount})` : ''}`;

    for (const err of result.errors || []) {
        const item = document.createElement('div');
        item.className = 'problem-item problem-error';
        const shortFile = nodePath.basename(err.file || '');
        item.innerHTML = `<span class="problem-icon">✗</span><span class="problem-text">${err.message}</span><span class="problem-loc">${shortFile}${err.line ? ':' + err.line : ''}</span>`;
        item.addEventListener('click', () => jumpToError(err));
        list.appendChild(item);
    }
    for (const w of result.warnings || []) {
        const item = document.createElement('div');
        item.className = 'problem-item problem-warning';
        const shortFile = nodePath.basename(w.file || '');
        item.innerHTML = `<span class="problem-icon">⚠</span><span class="problem-text">${w.message}</span><span class="problem-loc">${shortFile}${w.line ? ':' + w.line : ''}</span>`;
        item.addEventListener('click', () => jumpToError(w));
        list.appendChild(item);
    }
    // Auto-switch to problems tab if errors
    if (errCount > 0) {
        const probBtn = document.querySelector('[data-panel="problems"]') as HTMLElement;
        if (probBtn) probBtn.click();
    }
    // After successful build, show "Run in Emulator" in output
    if (errCount === 0 && result.outputPath) {
        appendOutput(`\n  ▶ Press F6 to run in Nexia 360 emulator\n`);
        lastBuiltXex = result.outputPath;
    }
    // Learning system hook
    onBuildComplete(result);
});

async function jumpToError(err: any) {
    if (!err.file) return;
    // Resolve absolute path
    let filePath = err.file;
    if (!nodePath.isAbsolute(filePath) && currentProject) {
        filePath = nodePath.join(currentProject.path, 'src', filePath);
        if (!nodeFs.existsSync(filePath)) filePath = nodePath.join(currentProject.path, err.file);
    }
    await openFile(filePath);
    if (editor && err.line) {
        editor.revealLineInCenter(err.line);
        editor.setPosition({ lineNumber: err.line, column: err.column || 1 });
        editor.focus();
        // Flash highlight
        const decs = editor.deltaDecorations([], [{
            range: new (window as any).monaco.Range(err.line, 1, err.line, 1),
            options: { isWholeLine: true, className: 'error-line-highlight' }
        }]);
        setTimeout(() => editor.deltaDecorations(decs, []), 3000);
    }
}

// ══════════════════════════════════════
//  PROJECT OPERATIONS
// ══════════════════════════════════════
async function openProject(dir?: string) {
    const project = await ipcRenderer.invoke(IPC.PROJECT_OPEN, dir);
    if (!project) return;
    currentProject = project;
    $('titlebar-project').textContent = `— ${project.name}`;
    await refreshFileTree();

    // Try to restore previous session tabs for this project
    const session = loadSession();
    if (session.lastProjectPath === project.path && session.openFiles?.length) {
        await restoreSession();
    } else if (project.sourceFiles?.length > 0) {
        // No session — open main.cpp as default
        const mainFile = project.sourceFiles.find((f: string) => /main\.(cpp|c)$/i.test(f))
                      || project.sourceFiles[project.sourceFiles.length - 1];
        const f = nodePath.isAbsolute(mainFile) ? mainFile : nodePath.join(project.path, mainFile);
        openFile(f);
    }
    $('welcome-screen').style.display = 'none';
    saveSession();
}

function closeCurrentProject() {
    if (!currentProject) return;
    // Save session before closing
    saveSession();
    // Close all open tabs
    closeAllTabs();
    // Clear project state
    const projectName = currentProject.name;
    currentProject = null as any;
    $('titlebar-project').textContent = '';
    // Redraw the Explorer rather than blanking it: with no project it is the
    // recent projects list, and emptying the element left the panel dead until
    // the next restart.
    refreshFileTree();
    // Show welcome screen
    $('welcome-screen').style.display = '';
    appendOutput(`Closed project: ${projectName}\n`);
}

$('welcome-open').addEventListener('click', () => openProject());

// ══════════════════════════════════════
//  NEW PROJECT DIALOG
// ══════════════════════════════════════
$('welcome-new').addEventListener('click', showNewProjectDialog);

/**
 * Empty until the user picks one. This used to default to 'hello-world', so the
 * dialog opened with the Minecraft demo already highlighted and Create would
 * make one for anybody who didn't notice they were choosing.
 */
let selectedTemplate = '';

async function showNewProjectDialog() {
    // Reset per open: the variable outlives the dialog, so without this a
    // second visit would arrive pre-selected with the first visit's choice.
    selectedTemplate = '';
    // Pre-fill location with default projects directory
    const locInput = $('np-location') as HTMLInputElement;
    if (!locInput.value && defaultProjectsDir) locInput.value = defaultProjectsDir;

    await renderTemplateCards();

    $('new-project-overlay').classList.remove('hidden');
    // Blur Monaco editor so it doesn't capture keystrokes, then focus the name input
    if (editor) editor.getContainerDomNode()?.querySelector('textarea')?.blur();
    setTimeout(() => ($('np-name') as HTMLInputElement).focus(), 100);
}

/**
 * Draw the template cards.
 *
 * Separate from showNewProjectDialog so that changing an icon can redraw them
 * without resetting the user's selection or re-focusing the name box — the
 * dialog is already open at that point.
 */
async function renderTemplateCards() {
    const templates = await ipcRenderer.invoke(IPC.PROJECT_GET_TEMPLATES);
    const container = $('np-templates');
    container.innerHTML = '';
    for (const t of templates) {
        const card = document.createElement('div');
        card.className = `template-card${t.id === selectedTemplate ? ' selected' : ''}`;
        card.innerHTML = `${templateIconHtml(t)}<div class="template-info"><h4>${escapeHtml(t.name)}</h4><p>${escapeHtml(t.description)}</p></div>`;
        card.addEventListener('click', () => {
            container.querySelectorAll('.template-card').forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
            selectedTemplate = t.id;
        });
        // Right-click to replace the emoji with a real picture. A context menu
        // rather than a visible button: changing an icon is a rare, deliberate
        // act, and a pencil on every card would be noise on the one screen
        // where the user is trying to read the templates.
        card.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            showTemplateIconMenu(t.id, e.clientX, e.clientY);
        });
        container.appendChild(card);
    }
}

/**
 * A template's icon: the user's picture if they set one, else the built-in
 * emoji. `image-rendering:pixelated` because the obvious thing to drop in here
 * is game art — a 16px Minecraft block scaled up should stay crisp rather than
 * be smoothed into mush.
 */
function templateIconHtml(t: { id: string; icon: string }): string {
    const custom = userSettings.templateIcons?.[t.id];
    if (custom) {
        return `<span class="template-icon"><img src="${escapeHtml(custom)}" alt=""
            style="width:26px;height:26px;object-fit:contain;display:block;image-rendering:pixelated"></span>`;
    }
    return `<span class="template-icon">${escapeHtml(t.icon)}</span>`;
}

/** Right-click menu on a template card: set or clear its picture. */
function showTemplateIconMenu(templateId: string, x: number, y: number) {
    document.getElementById('tpl-icon-menu')?.remove();

    const menu = document.createElement('div');
    menu.id = 'tpl-icon-menu';
    menu.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:10000;background:var(--bg-panel);
        border:1px solid var(--border);border-radius:6px;padding:4px;box-shadow:0 6px 20px rgba(0,0,0,.4);
        font-size:12px;min-width:150px`;

    const hasCustom = !!userSettings.templateIcons?.[templateId];
    const add = (label: string, fn: () => void) => {
        const item = document.createElement('div');
        item.textContent = label;
        item.style.cssText = 'padding:6px 10px;border-radius:4px;cursor:pointer;color:var(--text)';
        item.addEventListener('mouseenter', () => item.style.background = 'var(--bg-hover)');
        item.addEventListener('mouseleave', () => item.style.background = '');
        item.addEventListener('click', () => { menu.remove(); fn(); });
        menu.appendChild(item);
    };

    add(hasCustom ? 'Replace icon…' : 'Upload icon…', async () => {
        // 128px: these render at 26px, and even a high-DPI display doesn't need
        // more than this. It keeps the settings file small when every template
        // has one.
        const data = await pickImageAsDataUrl(128);
        if (!data) return;
        if (!userSettings.templateIcons) userSettings.templateIcons = {};
        userSettings.templateIcons[templateId] = data;
        saveUserSettings();
        renderTemplateCards();
    });
    if (hasCustom) {
        add('Reset to default', () => {
            delete userSettings.templateIcons[templateId];
            saveUserSettings();
            renderTemplateCards();
        });
    }

    document.body.appendChild(menu);

    // Nudge back on screen if it opened near an edge.
    const r = menu.getBoundingClientRect();
    if (r.right > window.innerWidth) menu.style.left = `${window.innerWidth - r.width - 6}px`;
    if (r.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - r.height - 6}px`;

    const close = (e: MouseEvent) => {
        if (!menu.contains(e.target as Node)) { menu.remove(); document.removeEventListener('mousedown', close); }
    };
    // Deferred: this same click is still propagating, and binding it now would
    // close the menu before it is ever seen.
    setTimeout(() => document.addEventListener('mousedown', close), 0);
}

$('np-cancel').addEventListener('click', () => $('new-project-overlay').classList.add('hidden'));
$('np-browse').addEventListener('click', async () => {
    const dir = await ipcRenderer.invoke(IPC.FILE_SELECT_DIR);
    if (dir) ($('np-location') as HTMLInputElement).value = dir;
});
$('np-create').addEventListener('click', async () => {
    const name = ($('np-name') as HTMLInputElement).value.trim();
    const location = ($('np-location') as HTMLInputElement).value.trim();
    if (!name) { alert('Enter a project name.'); return; }
    if (!location) { alert('Choose a location.'); return; }
    // No template defaults to selected any more, so this is now reachable —
    // without it the main process throws "Template '' not found".
    if (!selectedTemplate) { alert('Choose a template.'); return; }
    try {
        const project = await ipcRenderer.invoke(IPC.PROJECT_NEW, name, location, selectedTemplate);
        currentProject = project;
        $('titlebar-project').textContent = `— ${project.name}`;
        $('new-project-overlay').classList.add('hidden');
        $('welcome-screen').style.display = 'none';
        await refreshFileTree();
        if (project.sourceFiles?.length > 0) {
            // Open main.cpp first, fallback to last source file
            const mainFile = project.sourceFiles.find((f: string) => /main\.(cpp|c)$/i.test(f))
                          || project.sourceFiles[project.sourceFiles.length - 1];
            openFile(nodePath.join(project.path, mainFile));
        }
        onProjectCreated();
    } catch (err: any) {
        alert('Failed to create project: ' + err.message);
    }
});

// ══════════════════════════════════════
//  NEW FILE DIALOG
// ══════════════════════════════════════
function showNewFileDialog() {
    if (!currentProject) { appendOutput('Open a project first.\n'); return; }
    ($('nf-name') as HTMLInputElement).value = '';
    $('new-file-overlay').classList.remove('hidden');
    if (editor) editor.getContainerDomNode()?.querySelector('textarea')?.blur();
    setTimeout(() => ($('nf-name') as HTMLInputElement).focus(), 100);
}

async function createNewFile() {
    const name = ($('nf-name') as HTMLInputElement).value.trim();
    if (!name) { alert('Enter a file name.'); return; }
    if (!currentProject) { alert('No project open.'); return; }
    const filePath = nodePath.join(currentProject.path, 'src', name);
    // Default content based on extension
    let content = '';
    if (/\.(cpp|c|cc|cxx)$/i.test(name)) content = '#include "stdafx.h"\n\n';
    else if (/\.(h|hpp)$/i.test(name)) {
        const guard = name.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_';
        content = `#pragma once\n#ifndef ${guard}\n#define ${guard}\n\n\n\n#endif // ${guard}\n`;
    }
    try {
        await ipcRenderer.invoke(IPC.FILE_CREATE, filePath, content);
        $('new-file-overlay').classList.add('hidden');
        await refreshFileTree();
        openFile(filePath);
        appendOutput(`Created: ${name}\n`);
    } catch (err: any) {
        alert('Failed to create file: ' + err.message);
        appendOutput(`Create file failed: ${err.message}\n`);
    }
}

$('nf-cancel').addEventListener('click', () => $('new-file-overlay').classList.add('hidden'));
$('nf-create').addEventListener('click', createNewFile);
($('nf-name') as HTMLInputElement).addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); createNewFile(); }
    if (e.key === 'Escape') { $('new-file-overlay').classList.add('hidden'); }
});

// ══════════════════════════════════════
//  DEPLOY
// ══════════════════════════════════════
async function doDeploy() {
    if (!currentProject) { appendOutput('No project open.\n'); return; }
    const config = ($('config-select') as HTMLSelectElement).value;
    const xexPath = nodePath.join(currentProject.path, 'out', config, currentProject.name + '.xex');
    clearOutput(); showBottomPanel();
    try {
        await ipcRenderer.invoke(IPC.DEVKIT_DEPLOY, xexPath);
        onDeploy();
    }
    catch (err: any) { appendOutput(`Deploy failed: ${err.message}\n`); }
}

// ══════════════════════════════════════
//  SDK TOOLS DIALOG
// ══════════════════════════════════════
// ══════════════════════════════════════
//  SDK TOOLS DIALOG
// ══════════════════════════════════════

async function showSdkToolsDialog() {
    const tools = await ipcRenderer.invoke(IPC.SDK_GET_TOOLS);
    const grid = $('tools-grid');
    grid.innerHTML = '';
    if (tools.length === 0) {
        grid.innerHTML = '<p style="color:var(--text-dim);padding:16px;">No SDK tools found. Configure SDK path first.</p>';
    } else {
        const icons: Record<string, string> = { compiler:'⚙', linker:'🔗', shader:'🎨', audio:'🔊', xui:'🖼', utility:'📦', devkit:'📡', debug:'🔍', profiler:'📈', other:'📄' };
        let lastCategory = '';
        for (const tool of tools) {
            if (tool.category !== lastCategory) {
                lastCategory = tool.category;
                const header = document.createElement('div');
                header.className = 'tools-category-header';
                header.textContent = (icons[tool.category] || '📄') + ' ' + tool.category.toUpperCase();
                grid.appendChild(header);
            }
            const card = document.createElement('div');
            card.className = 'tool-card' + (tool.gui ? ' tool-gui' : ' tool-cli');
            card.title = tool.gui ? 'Click to launch (GUI application)' : 'Click to run (output in terminal)';
            card.innerHTML = `<span class="tool-category">${icons[tool.category]||'📄'}</span><div><div class="tool-name">${tool.name} <span class="tool-type-badge">${tool.gui ? 'GUI' : 'CLI'}</span></div><div class="tool-desc">${tool.description}</div></div>`;
            card.addEventListener('click', async () => {
                try {
                    if (!tool.gui) {
                        showBottomPanel();
                        appendOutput('\n─── ' + tool.name + ' ───\n');
                    }
                    await ipcRenderer.invoke(IPC.TOOL_LAUNCH, tool.name, tool.gui);
                } catch (err: any) {
                    showBottomPanel();
                    appendOutput('Error: ' + (err.message || err) + '\n');
                }
            });
            grid.appendChild(card);
        }
    }
    $('tools-overlay').classList.remove('hidden');
}
$('tools-close').addEventListener('click', () => $('tools-overlay').classList.add('hidden'));

// ══════════════════════════════════════
//  EXTENSIONS PANEL
// ══════════════════════════════════════

async function renderExtensionsPanel() {
    const panel = $('extensions-panel');
    panel.innerHTML = `
        <div style="text-align:center;padding:32px 16px;">
            <div style="font-size:40px;margin-bottom:14px;">🏪</div>
            <div style="font-size:15px;font-weight:600;color:var(--text);margin-bottom:6px;">Nexia Marketplace</div>
            <div style="font-size:12px;color:var(--text-dim);line-height:1.6;margin-bottom:20px;">Browse and install extensions, themes, and lesson packages for the Nexia IDE.</div>
            <div style="display:flex;flex-direction:column;gap:10px;max-width:220px;margin:0 auto;">
                <div style="padding:12px;background:var(--bg-input);border:1px solid var(--border);border-radius:8px;text-align:center;">
                    <div style="font-size:22px;margin-bottom:6px;">🧩</div>
                    <div style="font-size:13px;font-weight:600;color:var(--text);">Extensions</div>
                    <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">Coming Soon</div>
                </div>
                <div style="padding:12px;background:var(--bg-input);border:1px solid var(--border);border-radius:8px;text-align:center;">
                    <div style="font-size:22px;margin-bottom:6px;">🎨</div>
                    <div style="font-size:13px;font-weight:600;color:var(--text);">Themes</div>
                    <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">Coming Soon</div>
                </div>
                <div style="padding:12px;background:var(--bg-input);border:1px solid var(--border);border-radius:8px;text-align:center;">
                    <div style="font-size:22px;margin-bottom:6px;">🎬</div>
                    <div style="font-size:13px;font-weight:600;color:var(--text);">Lesson Packages</div>
                    <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">Coming Soon</div>
                </div>
            </div>
        </div>
    `;
}

// Import overlay buttons
$('ext-import-zip').addEventListener('click', async () => {
    $('ext-import-overlay').classList.add('hidden');
    const filePath = await ipcRenderer.invoke(IPC.FILE_SELECT_FILE);
    if (!filePath || !filePath.toLowerCase().endsWith('.zip')) {
        if (filePath) appendOutput('⚠ Please select a .zip file.\n');
        return;
    }
    try {
        const result = await ipcRenderer.invoke(IPC.EXT_INSTALL_ZIP, filePath);
        appendOutput(`✅ Installed extension: ${result.manifest.name} v${result.manifest.version}\n`);
        renderExtensionsPanel();
    } catch (err: any) {
        appendOutput(`❌ Import failed: ${err.message || err}\n`);
    }
});

$('ext-import-folder').addEventListener('click', async () => {
    $('ext-import-overlay').classList.add('hidden');
    const folderPath = await ipcRenderer.invoke(IPC.FILE_SELECT_DIR);
    if (!folderPath) return;
    try {
        const result = await ipcRenderer.invoke(IPC.EXT_INSTALL_FOLDER, folderPath);
        appendOutput(`✅ Installed extension: ${result.manifest.name} v${result.manifest.version}\n`);
        renderExtensionsPanel();
    } catch (err: any) {
        appendOutput(`❌ Import failed: ${err.message || err}\n`);
    }
});

$('ext-create-new').addEventListener('click', () => {
    $('ext-import-overlay').classList.add('hidden');
    $('ext-create-overlay').classList.remove('hidden');
});

$('ext-import-close').addEventListener('click', () => $('ext-import-overlay').classList.add('hidden'));

$('ext-create-cancel').addEventListener('click', () => $('ext-create-overlay').classList.add('hidden'));

$('ext-create-submit').addEventListener('click', async () => {
    const name = ($('ext-create-name') as HTMLInputElement).value.trim();
    const type = ($('ext-create-type') as HTMLSelectElement).value;
    if (!name) { alert('Enter a name for the extension.'); return; }
    try {
        const extDir = await ipcRenderer.invoke(IPC.EXT_CREATE, name, type);
        appendOutput(`📦 Created extension template: ${name}\n📁 ${extDir}\n`);
        $('ext-create-overlay').classList.add('hidden');
        renderExtensionsPanel();
    } catch (err: any) {
        appendOutput(`❌ Create failed: ${err.message || err}\n`);
    }
});

// ══════════════════════════════════════
//  DEVKIT PANEL — Extracted to panels/devkitPanel.ts
// ══════════════════════════════════════
let _devkitPanel: any;
try {
    _devkitPanel = require('./panels/devkitPanel');
} catch (err: any) {
    console.error('[Devkit] Module load failed:', err.message);
    _devkitPanel = { initDevkit: () => {}, initDevkitPanel: () => {}, isDevkitConnected: () => false };
}
const { initDevkitPanel, isDevkitConnected } = _devkitPanel;

// ══════════════════════════════════════
//  EMULATOR PANEL — Extracted to panels/emulatorPanel.ts
// ══════════════════════════════════════
let _emulatorPanel: any;
try {
    _emulatorPanel = require('./panels/emulatorPanel');
} catch (err: any) {
    console.error('[Emulator] Module load failed:', err.message);
    _emulatorPanel = { initEmulator: () => {}, initEmulatorPanel: () => {} };
}
const { initEmulatorPanel } = _emulatorPanel;

// ══════════════════════════════════════
//  SETUP WIZARD
// ══════════════════════════════════════
async function checkSetup(appState: any) {
    if (appState.sdkConfigured) {
        const sdkRoot = appState.sdkPaths.root;
        const badge = appState.sdkBundled
            ? '<span class="sdk-bundled-badge">📦 Bundled</span>'
            : '<span class="sdk-system-badge">💻 System</span>';
        $('setup-sdk-status').className = 'sdk-found';
        $('setup-sdk-status').innerHTML = `✓ Xbox 360 SDK detected ${badge}<br><span style="font-size:11px;color:var(--text-dim)">${sdkRoot}</span>`;
        ($('setup-sdk-path') as HTMLInputElement).value = sdkRoot;
        $('status-sdk').textContent = appState.sdkBundled
            ? '✓ SDK: Bundled'
            : `✓ SDK: ${nodePath.basename(sdkRoot)}`;
        // Hide download and partial sections if SDK is found
        $('setup-sdk-download').classList.add('hidden');
        $('setup-sdk-partial').classList.add('hidden');
    } else if (appState.sdkInstallState === 'partial') {
        // Partial install: has bin/ but missing include/ and lib/
        $('setup-sdk-status').className = 'sdk-missing';
        $('setup-sdk-status').textContent = '⚠ Xbox 360 SDK partially installed (missing headers & libraries)';
        $('status-sdk').textContent = '⚠ SDK: Partial Install';
        $('statusbar').classList.add('status-error');
        $('setup-sdk-download').classList.add('hidden');
        $('setup-sdk-partial').classList.remove('hidden');
        if (appState.sdkPartialPath) {
            $('setup-sdk-partial-path').textContent = `Found at: ${appState.sdkPartialPath}`;
        }
    } else {
        $('setup-sdk-status').className = 'sdk-missing';
        $('setup-sdk-status').textContent = '✗ Xbox 360 SDK not found';
        $('status-sdk').textContent = '✗ SDK not configured';
        $('statusbar').classList.add('status-error');
        // Show download section
        $('setup-sdk-download').classList.remove('hidden');
        $('setup-sdk-partial').classList.add('hidden');
    }
    if (appState.firstRun) $('setup-overlay').classList.remove('hidden');
}

$('setup-browse').addEventListener('click', async () => {
    const dir = await ipcRenderer.invoke(IPC.FILE_SELECT_DIR);
    if (dir) ($('setup-sdk-path') as HTMLInputElement).value = dir;
});
$('setup-detect').addEventListener('click', async () => {
    const result = await ipcRenderer.invoke(IPC.SDK_DETECT);
    if (result && result.paths) {
        ($('setup-sdk-path') as HTMLInputElement).value = result.paths.root;
        const badge = result.bundled
            ? '<span class="sdk-bundled-badge">📦 Bundled</span>'
            : '<span class="sdk-system-badge">💻 System</span>';
        $('setup-sdk-status').className = 'sdk-found';
        $('setup-sdk-status').innerHTML = `✓ Found SDK ${badge}<br><span style="font-size:11px;color:var(--text-dim)">${result.paths.root}</span>`;
        $('setup-sdk-download').classList.add('hidden');
        $('setup-sdk-partial').classList.add('hidden');
    } else {
        // Check if it's a partial install
        const installState = await ipcRenderer.invoke(IPC.SDK_INSTALL_STATE);
        if (installState && installState.state === 'partial') {
            $('setup-sdk-status').className = 'sdk-missing';
            $('setup-sdk-status').textContent = '⚠ Xbox 360 SDK partially installed (missing headers & libraries)';
            $('setup-sdk-download').classList.add('hidden');
            $('setup-sdk-partial').classList.remove('hidden');
            if (installState.partialPath) {
                $('setup-sdk-partial-path').textContent = `Found at: ${installState.partialPath}`;
            }
        } else {
            $('setup-sdk-status').className = 'sdk-missing';
            $('setup-sdk-status').textContent = '✗ Could not auto-detect. Browse manually or download below.';
            $('setup-sdk-download').classList.remove('hidden');
            $('setup-sdk-partial').classList.add('hidden');
        }
    }
});
$('setup-download-btn').addEventListener('click', () => {
    // Open SDK download page in the user's browser
    shell.openExternal('https://archive.org/download/xbox-360-sdk-21256.3_202204/XBOX360%20SDK%2021256.3.zip');
    appendOutput('SDK download page opened in browser. After installing, click Auto-Detect.\n');
});
$('setup-prep-btn').addEventListener('click', async () => {
    $('setup-prep-status').textContent = 'Creating registry keys...';
    $('setup-prep-status').style.color = 'var(--text-dim)';
    const result = await ipcRenderer.invoke(IPC.SDK_PREP_REGISTRY);
    if (result.success) {
        $('setup-prep-status').innerHTML = '✓ ' + result.message;
        $('setup-prep-status').style.color = 'var(--xbox-green)';
        $('setup-prep-btn').classList.add('hidden');
        $('setup-cleanup-btn').classList.remove('hidden');
        appendOutput('[SDK Prep] ' + result.message + '\n');
    } else {
        $('setup-prep-status').innerHTML = '✗ ' + result.message;
        $('setup-prep-status').style.color = 'var(--error-red, #ff4444)';
        appendOutput('[SDK Prep] Error: ' + result.message + '\n');
    }
});
$('setup-cleanup-btn').addEventListener('click', async () => {
    $('setup-prep-status').textContent = 'Removing registry keys...';
    $('setup-prep-status').style.color = 'var(--text-dim)';
    const result = await ipcRenderer.invoke(IPC.SDK_CLEANUP_REGISTRY);
    if (result.success) {
        $('setup-prep-status').innerHTML = '✓ ' + result.message;
        $('setup-prep-status').style.color = 'var(--xbox-green)';
        $('setup-cleanup-btn').classList.add('hidden');
        $('setup-prep-btn').classList.remove('hidden');
        appendOutput('[SDK Cleanup] ' + result.message + '\n');
    } else {
        $('setup-prep-status').innerHTML = '✗ ' + result.message;
        $('setup-prep-status').style.color = 'var(--error-red, #ff4444)';
        appendOutput('[SDK Cleanup] Error: ' + result.message + '\n');
    }
});
$('setup-done').addEventListener('click', async () => {
    const p = ($('setup-sdk-path') as HTMLInputElement).value;
    if (p) {
        const r = await ipcRenderer.invoke(IPC.SDK_CONFIGURE, p);
        if (r) {
            $('status-sdk').textContent = `✓ SDK: ${nodePath.basename(r.root)}`;
            $('statusbar').classList.remove('status-error');
        }
    }
    await ipcRenderer.invoke(IPC.APP_SHOW_SETUP);
    $('setup-overlay').classList.add('hidden');
});
$('setup-skip').addEventListener('click', async () => {
    await ipcRenderer.invoke(IPC.APP_SHOW_SETUP);
    $('setup-overlay').classList.add('hidden');
});

// ══════════════════════════════════════
//  TITLEBAR USERNAME + USER PANEL
// ══════════════════════════════════════

function updateTitlebarUser() {
    const el = document.getElementById('titlebar-user');
    if (!el) return;
    const user = authService.getUser();
    if (user) {
        const color = user.role === 'admin' ? '#e5c07b' : '#4ec9b0';
        el.innerHTML = `${avatarHtml(user, 'tu-avatar', color)}<span class="tu-name">${escapeHtml(user.username)}</span>`;
    } else {
        el.innerHTML = '<span style="font-size:11px;color:var(--text-muted)">Not signed in</span>';
    }
}

function updateConnectionStatus(state: any) {
    const el = document.getElementById('status-connection');
    if (!el) return;

    if (state.offlineMode) {
        // Offline mode — user can keep working
        const queued = state.queuedActions || 0;
        const queueText = queued > 0 ? ` · ${queued} queued` : '';

        if (state.syncInProgress) {
            el.className = 'status-connection status-conn-syncing';
            el.textContent = '⬤ Syncing...';
            el.title = `Reconnected — syncing ${queued} queued actions`;
        } else {
            el.className = 'status-connection status-conn-offline-mode';
            el.textContent = `⬤ Offline Mode${queueText}`;
            el.title = `Working offline — server unreachable since ${state.lastConnected || 'startup'}. Your work is saved locally. Changes will sync when reconnected.`;
        }

        // Show offline banner if not already showing
        showOfflineBanner(state);

    } else if (state.authenticated && state.serverOnline) {
        el.className = 'status-connection status-conn-auth';
        el.textContent = '⬤ Connected';
        el.title = `Server online · Authenticated · v${state.serverVersion || '?'} · Uptime: ${state.serverUptime || 0}s`;
        hideOfflineBanner();

    } else if (state.serverOnline && !state.authenticated) {
        el.className = 'status-connection status-conn-online';
        el.textContent = '⬤ Online';
        el.title = 'Server reachable · Not signed in';
        hideOfflineBanner();

    } else if (state.failCount > 0 && state.failCount < 3) {
        el.className = 'status-connection status-conn-lost';
        el.textContent = '⬤ Reconnecting...';
        el.title = `Connection lost · Attempt ${state.failCount}/3`;

    } else {
        el.className = 'status-connection status-conn-offline';
        el.textContent = '⬤ Offline';
        el.title = state.failCount >= 3 ? 'Server unreachable' : 'Not connected to server';
    }
}

// ── Offline Mode Banner ──

let _offlineBannerShown = false;

function showOfflineBanner(state: any) {
    if (_offlineBannerShown) {
        // Update queued count in existing banner
        const countEl = document.getElementById('offline-banner-count');
        if (countEl) countEl.textContent = `${state.queuedActions || 0} actions queued`;
        return;
    }
    _offlineBannerShown = true;

    const banner = document.createElement('div');
    banner.id = 'offline-banner';
    banner.className = 'offline-banner';
    banner.innerHTML = `
        <div class="offline-banner-content">
            <span class="offline-banner-icon">⚡</span>
            <div class="offline-banner-text">
                <strong>Offline Mode</strong> — Server connection lost. You can continue working normally.
                <span id="offline-banner-count">${state.queuedActions || 0} actions queued</span>
                will sync automatically when reconnected.
            </div>
            <button class="offline-banner-dismiss" id="offline-banner-close">✕</button>
        </div>`;

    // Insert after the menubar, before the main content
    const main = document.getElementById('main');
    if (main && main.parentElement) {
        main.parentElement.insertBefore(banner, main);
    } else {
        document.body.appendChild(banner);
    }

    document.getElementById('offline-banner-close')?.addEventListener('click', () => {
        banner.classList.add('offline-banner-dismissed');
    });
}

function hideOfflineBanner() {
    if (!_offlineBannerShown) return;
    _offlineBannerShown = false;
    const banner = document.getElementById('offline-banner');
    if (banner) {
        // Show a brief "reconnected" message before removing
        banner.innerHTML = `
            <div class="offline-banner-content offline-banner-reconnected">
                <span class="offline-banner-icon">✓</span>
                <div class="offline-banner-text">
                    <strong>Reconnected!</strong> — All changes have been synced.
                </div>
            </div>`;
        banner.className = 'offline-banner offline-banner-success';
        setTimeout(() => banner.remove(), 4000);
    }
}

// ── Internet Connectivity Monitor ──

let _noInternetToastShown = false;

function checkInternetConnectivity() {
    if (!navigator.onLine) {
        showNoInternetToast();
    }
}

function showNoInternetToast() {
    if (_noInternetToastShown) return;
    _noInternetToastShown = true;

    const existing = document.getElementById('no-internet-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'no-internet-toast';
    toast.style.cssText = 'position:fixed;bottom:60px;left:50%;transform:translateX(-50%) translateY(20px);opacity:0;z-index:9999;background:#1e1e2e;border:1px solid #f97316;border-radius:8px;padding:14px 18px;max-width:440px;box-shadow:0 8px 32px rgba(0,0,0,0.5);transition:opacity 0.3s,transform 0.3s;font-family:var(--font);';
    toast.innerHTML = `
        <div style="display:flex;align-items:flex-start;gap:12px;">
            <div style="font-size:24px;flex-shrink:0;margin-top:2px;color:#f97316;">⚠</div>
            <div style="flex:1;">
                <div style="font-size:13px;font-weight:600;color:#f97316;margin-bottom:4px;">No Internet Connection</div>
                <div style="font-size:12px;color:#cccccc;line-height:1.5;margin-bottom:10px;">Some features are unavailable without an internet connection, including community forums, GitHub integration, cloud settings sync, and AI assistance.</div>
                <div style="display:flex;gap:8px;flex-wrap:wrap;">
                    <button id="no-internet-wifi-btn" style="padding:6px 14px;background:#f97316;color:white;border:none;border-radius:4px;font-size:12px;font-weight:600;cursor:pointer;font-family:var(--font);">Check Network Settings</button>
                    <button id="no-internet-retry-btn" style="padding:6px 14px;background:transparent;color:#cccccc;border:1px solid #404040;border-radius:4px;font-size:12px;cursor:pointer;font-family:var(--font);">Retry</button>
                    <button id="no-internet-dismiss-btn" style="padding:6px 12px;background:transparent;color:#858585;border:1px solid #404040;border-radius:4px;font-size:12px;cursor:pointer;font-family:var(--font);">Dismiss</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(toast);
    requestAnimationFrame(() => { toast.style.opacity = '1'; toast.style.transform = 'translateX(-50%) translateY(0)'; });

    document.getElementById('no-internet-wifi-btn')!.addEventListener('click', () => {
        // Open Windows network settings
        try {
            const { execSync } = require('child_process');
            // Try Windows 10+ Settings app first
            try { execSync('start ms-settings:network-wifi', { shell: true, windowsHide: true }); }
            catch {
                // Fallback for Windows 7/8 — open Network Connections control panel
                try { execSync('ncpa.cpl', { shell: true, windowsHide: true }); }
                catch { shell.openExternal('https://support.microsoft.com/en-us/windows/connect-to-a-wi-fi-network'); }
            }
        } catch {}
    });

    document.getElementById('no-internet-retry-btn')!.addEventListener('click', () => {
        hideNoInternetToast();
        // Re-check after a brief delay
        setTimeout(() => {
            if (!navigator.onLine) {
                showNoInternetToast();
            } else {
                // Connection restored — trigger re-init of online features
                appendOutput('Internet connection restored.\n');
            }
        }, 1000);
    });

    document.getElementById('no-internet-dismiss-btn')!.addEventListener('click', () => {
        hideNoInternetToast();
    });
}

function hideNoInternetToast() {
    _noInternetToastShown = false;
    const toast = document.getElementById('no-internet-toast');
    if (toast) {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(-50%) translateY(20px)';
        setTimeout(() => toast.remove(), 300);
    }
}

// Listen for auth changes to update titlebar
authService.onAuthStateChange(() => updateTitlebarUser());

// Click handler for titlebar user
document.getElementById('titlebar-user')?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleUserPanel();
});

let _userPanelOpen = false;

function toggleUserPanel() {
    if (_userPanelOpen) { closeUserPanel(); return; }
    _userPanelOpen = true;

    const user = authService.getUser();
    const isAdmin = authService.isAdmin();

    const overlay = document.createElement('div');
    overlay.id = 'user-panel-overlay';
    overlay.addEventListener('click', () => closeUserPanel());
    document.body.appendChild(overlay);

    const panel = document.createElement('div');
    panel.id = 'user-panel';

    if (user) {
        const color = user.role === 'admin' ? '#e5c07b' : '#4ec9b0';
        panel.innerHTML = `
            <div class="up-header">
                <div class="up-user-row">
                    ${avatarHtml(user, 'auth-avatar-lg', color)}
                    <div>
                        <div class="up-name">${user.username}</div>
                        <div class="up-email">${user.email}</div>
                        <div class="up-role" style="color:${color}">${user.role.toUpperCase()}</div>
                    </div>
                </div>
            </div>
            ${isAdmin ? `
            <div class="up-section">
                <div class="up-item up-item-dev" data-action="devpanel"><span class="up-item-icon">🛡</span>Developer Panel</div>
            </div>` : ''}
            <div class="up-section">
                <div class="up-section-title">IDE</div>
                <div class="up-item" data-action="settings"><span class="up-item-icon">⚙</span>Settings</div>
                <div class="up-item" data-action="serversettings"><span class="up-item-icon">🌐</span>Server Settings</div>
            </div>
            <div class="up-section">
                <div class="up-section-title">Account</div>
                <div class="up-item up-item-danger" data-action="signout"><span class="up-item-icon">↪</span>Sign Out</div>
            </div>`;
    } else {
        panel.innerHTML = `
            <div class="up-header" style="text-align:center;padding:24px 18px">
                <div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:4px">Not signed in</div>
                <div style="font-size:11px;color:var(--text-dim)">Sign in to access cloud lessons and admin features</div>
            </div>
            <div class="up-section">
                <div class="up-item" data-action="signin"><span class="up-item-icon">🔑</span>Sign In</div>
                <div class="up-item" data-action="register"><span class="up-item-icon">✦</span>Create Account</div>
            </div>
            <div class="up-section">
                <div class="up-section-title">IDE</div>
                <div class="up-item" data-action="settings"><span class="up-item-icon">⚙</span>Settings</div>
                <div class="up-item" data-action="serversettings"><span class="up-item-icon">🌐</span>Server Settings</div>
            </div>`;
    }

    panel.addEventListener('click', (e) => {
        const item = (e.target as HTMLElement).closest('.up-item') as HTMLElement;
        if (!item) return;
        const action = item.dataset.action;
        closeUserPanel();
        switch (action) {
            case 'settings': showSettingsPanel(); break;
            case 'serversettings': authUI.showServerSettings(); break;
            case 'signout': authService.logout(); break;
            case 'signin': authUI.showLogin(); break;
            case 'register': authUI.showRegister(); break;
            case 'devpanel': openDevPanel(); break;
        }
    });

    document.body.appendChild(panel);
}

function closeUserPanel() {
    _userPanelOpen = false;
    document.getElementById('user-panel-overlay')?.remove();
    document.getElementById('user-panel')?.remove();
}

// ══════════════════════════════════════
//  DEVELOPER PANEL (floating overlay)
// ══════════════════════════════════════

let _devPanelOpen = false;

function openDevPanel() {
    if (_devPanelOpen) { closeDevPanel(); return; }
    if (!authService.isAdmin()) return;
    _devPanelOpen = true;

    const overlay = document.createElement('div');
    overlay.id = 'devpanel-overlay';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeDevPanel(); });
    document.body.appendChild(overlay);

    const win = document.createElement('div');
    win.id = 'devpanel-window';

    // Title bar
    const titlebar = document.createElement('div');
    titlebar.className = 'dp-titlebar';
    titlebar.innerHTML = `
        <span class="dp-title">🛡 Developer Panel</span>
        <div class="dp-tabs">
            <button class="dp-tab active" data-tab="users">Users</button>
            <button class="dp-tab" data-tab="builder">Lesson Builder</button>
            <button class="dp-tab" data-tab="uidesigner">UI Designer</button>
        </div>
        <button class="dp-close" id="dp-close">✕</button>`;
    win.appendChild(titlebar);

    // Content area
    const content = document.createElement('div');
    content.className = 'dp-content';
    content.id = 'dp-content';
    win.appendChild(content);

    overlay.appendChild(win);
    requestAnimationFrame(() => overlay.classList.add('visible'));

    // Wire tabs
    titlebar.addEventListener('click', (e) => {
        const tab = (e.target as HTMLElement).closest('.dp-tab') as HTMLElement;
        if (tab) {
            titlebar.querySelectorAll('.dp-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            renderDevPanelTab(content, tab.dataset.tab!);
        }
    });

    document.getElementById('dp-close')!.addEventListener('click', closeDevPanel);

    // Escape key closes
    const escHandler = (e: KeyboardEvent) => {
        if (e.key === 'Escape') { closeDevPanel(); document.removeEventListener('keydown', escHandler); }
    };
    document.addEventListener('keydown', escHandler);

    // Render default tab
    renderDevPanelTab(content, 'users');

    // Make draggable by titlebar
    makeDraggable(win, titlebar);
}

function closeDevPanel() {
    _devPanelOpen = false;
    const overlay = document.getElementById('devpanel-overlay');
    if (overlay) {
        overlay.classList.remove('visible');
        setTimeout(() => overlay.remove(), 200);
    }
}

function makeDraggable(win: HTMLElement, handle: HTMLElement) {
    let dragging = false, startX = 0, startY = 0, origLeft = 0, origTop = 0;
    handle.addEventListener('mousedown', (e) => {
        if ((e.target as HTMLElement).closest('.dp-tab, .dp-close')) return;
        dragging = true;
        startX = e.clientX; startY = e.clientY;
        const rect = win.getBoundingClientRect();
        origLeft = rect.left; origTop = rect.top;
        // Switch to fixed positioning for drag (avoids sub-pixel transform)
        win.style.position = 'fixed';
        win.style.left = origLeft + 'px';
        win.style.top = origTop + 'px';
        win.style.margin = '0';
        win.style.transition = 'none';
        e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX, dy = e.clientY - startY;
        win.style.left = Math.round(origLeft + dx) + 'px';
        win.style.top = Math.round(origTop + dy) + 'px';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
}

async function renderDevPanelTab(container: HTMLElement, tab: string) {
    if (tab === 'users') {
        await renderDevPanelUsers(container);
    } else if (tab === 'builder') {
        renderDevPanelBuilder(container);
    } else if (tab === 'uidesigner') {
        renderUIDesigner(container);
    }
}

async function renderDevPanelUsers(container: HTMLElement) {
    container.innerHTML = '<div class="dp-loading">Loading users...</div>';

    const result = await authService.getUsers();
    if (!result.success) {
        container.innerHTML = `<div class="dp-error">${result.error || 'Failed to load users'}</div>`;
        return;
    }

    const users = result.users || [];
    container.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'dp-section-header';
    header.innerHTML = `<span>Registered Users (${users.length})</span>`;
    container.appendChild(header);

    const list = document.createElement('div');
    list.className = 'dp-user-list';

    for (const user of users) {
        const isMe = authService.getUser()?.id === user.id;
        const color = user.role === 'admin' ? '#e5c07b' : '#4ec9b0';
        const item = document.createElement('div');
        item.className = 'dp-user-item';
        item.innerHTML = `
            ${avatarHtml(user, 'dp-user-avatar', color)}
            <div class="dp-user-info">
                <div class="dp-user-name">${user.username} ${isMe ? '<span class="dp-you">(you)</span>' : ''}</div>
                <div class="dp-user-email">${user.email}</div>
            </div>
            <div class="dp-user-role" style="color:${color}">${user.role.toUpperCase()}</div>
            <div class="dp-user-actions">
                ${!isMe && user.role !== 'admin' ? `<button class="dp-btn dp-btn-promote" data-uid="${user.id}" data-action="promote">Promote</button>` : ''}
                ${!isMe && user.role === 'admin' ? `<button class="dp-btn dp-btn-demote" data-uid="${user.id}" data-action="demote">Demote</button>` : ''}
                ${!isMe ? `<button class="dp-btn dp-btn-delete" data-uid="${user.id}" data-action="delete">✕</button>` : ''}
            </div>`;
        list.appendChild(item);
    }

    list.addEventListener('click', async (e) => {
        const btn = (e.target as HTMLElement).closest('[data-action]') as HTMLElement;
        if (!btn) return;
        const uid = btn.dataset.uid!;
        const action = btn.dataset.action!;
        if (action === 'promote' && confirm('Promote this user to admin?')) {
            await authService.promoteUser(uid, 'admin');
            renderDevPanelUsers(container);
        } else if (action === 'demote' && confirm('Remove admin privileges?')) {
            await authService.demoteUser(uid);
            renderDevPanelUsers(container);
        } else if (action === 'delete' && confirm('Delete this user permanently?')) {
            await authService.deleteUser(uid);
            renderDevPanelUsers(container);
        }
    });

    container.appendChild(list);

    // ── Engine Tests ──
    const testSection = document.createElement('div');
    testSection.className = 'dp-section-header';
    testSection.innerHTML = '<span>Engine Tests</span>';
    container.appendChild(testSection);

    const testGrid = document.createElement('div');
    testGrid.style.cssText = 'padding:0 12px 16px; display:flex; flex-wrap:wrap; gap:6px;';

    const testBlankBtn = document.createElement('button');
    testBlankBtn.className = 'dp-btn';
    testBlankBtn.textContent = 'Test Blank Engine';
    testBlankBtn.title = 'Opens the cinematic engine with NO package loaded — should show empty state';
    testBlankBtn.addEventListener('click', () => {
        closeDevPanel();
        // Force-clear the package so the engine has nothing
        cinematicEngine.loadLesson({ blocks: [], oldCode: [], explanations: {}, connections: {}, tokens: {} });
        // Now tell it to load a truly empty package by wiping internal state
        openCinematicTutorBlank();
    });
    testGrid.appendChild(testBlankBtn);


    container.appendChild(testGrid);
}

async function openCinematicTutorBlank() {
    const tabPath = '__cinematic__:blank_test';
    const existing = openTabs.find((t: any) => t.path === tabPath);
    if (existing) { switchToTab(tabPath); return; }

    if (!cinematicContainer) {
        cinematicContainer = document.createElement('div');
        cinematicContainer.id = 'cinematic-container';
        cinematicContainer.style.cssText = 'display:none; flex:1; flex-direction:column; overflow:hidden; background:var(--bg-dark);';
        $('editor-area').appendChild(cinematicContainer);
    }

    // Do NOT load any lesson — mount with empty state
    cinematicEngine.unmount();
    // Clear internal package state by loading an empty shell
    (cinematicEngine as any).loadLesson({ format: 'nexia-lesson-v2', blocks: [], overlay: { explanations: {}, connections: {}, tokens: {}, visualizers: {}, tokenVisualizers: {} } });
    cinematicEngine.mount(cinematicContainer);

    const monaco = (window as any).monaco;
    const model = monaco?.editor?.createModel?.('', 'plaintext') || { dispose: () => {}, getValue: () => '' };
    openTabs.push({ path: tabPath, name: '\ud83e\uddea Blank Engine Test', model, modified: false });
    switchToTab(tabPath);
}

function renderDevPanelBuilder(container: HTMLElement) {
    // Delegate to the admin panel's builder
    adminPanel.render(container);
}

// ══════════════════════════════════════
//  UI DESIGNER (Developer Panel tab)
// ══════════════════════════════════════

interface UILayoutConfig {
    sidebar: {
        tabs: { id: string; icon: string; title: string; visible: boolean; }[];
        defaultWidth: number;
    };
    bottomPanel: {
        defaultHeight: number;
    };
    menuBar: {
        items: { id: string; label: string; visible: boolean; }[];
    };
    welcome: {
        logoEmoji: string;
        title: string;
        subtitle: string;
        showNewProject: boolean;
        showOpenProject: boolean;
        customHtml: string;
    };
}

function getDefaultLayoutConfig(): UILayoutConfig {
    return {
        sidebar: {
            tabs: [
                { id: 'explorer', icon: '📁', title: 'Explorer', visible: true },
                { id: 'search', icon: '🔍', title: 'Find in Files', visible: true },
                { id: 'ai', icon: '🤖', title: 'Nexia AI', visible: true },
                { id: 'extensions', icon: '🧩', title: 'Extensions', visible: true },
                { id: 'git', icon: '🔀', title: 'Source Control', visible: true },
                { id: 'devkit', icon: '📡', title: 'Devkit', visible: true },
                { id: 'emulator', icon: '🎮', title: 'Emulator', visible: true },
                { id: 'learn', icon: '🎓', title: 'Learn', visible: true },
                { id: 'community', icon: '💬', title: 'Community', visible: true },
            ],
            defaultWidth: 260,
        },
        bottomPanel: {
            defaultHeight: 200,
        },
        menuBar: {
            items: [
                { id: 'file', label: 'File', visible: true },
                { id: 'edit', label: 'Edit', visible: true },
                { id: 'build', label: 'Build', visible: true },
                { id: 'view', label: 'View', visible: true },
            ],
        },
        welcome: {
            logoEmoji: '🎮',
            title: 'Nexia IDE',
            subtitle: 'Xbox 360 Development Environment',
            showNewProject: true,
            showOpenProject: true,
            customHtml: '',
        },
    };
}

let _uiLayoutConfig: UILayoutConfig | null = null;

function loadUILayoutConfig(): UILayoutConfig {
    if (_uiLayoutConfig) return _uiLayoutConfig;

    let config: UILayoutConfig;
    try {
        const configPath = nodePath.join(nodeOs.homedir(), '.nexia-ide-layout.json');
        if (nodeFs.existsSync(configPath)) {
            config = JSON.parse(nodeFs.readFileSync(configPath, 'utf-8'));
        } else {
            config = getDefaultLayoutConfig();
        }
    } catch {
        config = getDefaultLayoutConfig();
    }

    // Auto-discover sidebar tabs from the DOM that aren't in the config yet
    // This ensures newly added tabs (e.g. Source Control) appear automatically
    config.sidebar.tabs = reconcileSidebarTabs(config.sidebar.tabs);

    _uiLayoutConfig = config;
    return _uiLayoutConfig!;
}

/**
 * Scans the DOM for all .sidebar-tab buttons and merges any missing ones
 * into the config's tab list. Preserves user ordering and visibility for
 * tabs that already exist in the config.
 */
function reconcileSidebarTabs(configTabs: { id: string; icon: string; title: string; visible: boolean }[]): { id: string; icon: string; title: string; visible: boolean }[] {
    const domTabs = Array.from(document.querySelectorAll('.sidebar-tab')) as HTMLElement[];
    if (domTabs.length === 0) return configTabs; // DOM not ready yet

    const configIds = new Set(configTabs.map(t => t.id));
    const merged = [...configTabs];

    for (const el of domTabs) {
        const id = el.dataset.panel;
        if (!id || configIds.has(id)) continue;

        // New tab found in DOM — extract its info and append
        const icon = el.textContent?.trim() || '📌';
        const title = el.getAttribute('title') || id.charAt(0).toUpperCase() + id.slice(1);
        merged.push({ id, icon, title, visible: true });
    }

    // Also remove any config tabs whose panels no longer exist in the DOM
    // (but only if the DOM has loaded — check for at least the explorer tab)
    const domIds = new Set(domTabs.map(el => el.dataset.panel).filter(Boolean));
    if (domIds.has('explorer')) {
        return merged.filter(t => domIds.has(t.id));
    }

    return merged;
}

function saveUILayoutConfig(config: UILayoutConfig) {
    _uiLayoutConfig = config;
    try {
        const configPath = nodePath.join(nodeOs.homedir(), '.nexia-ide-layout.json');
        nodeFs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    } catch (err) {
        console.error('Failed to save layout config:', err);
    }
}

function renderUIDesigner(container: HTMLElement) {
    // Clear cached config so we re-scan the DOM for any new tabs
    _uiLayoutConfig = null;
    const config = loadUILayoutConfig();
    container.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'uid-wrapper';

    // ── Left: config sections ──
    const editor = document.createElement('div');
    editor.className = 'uid-editor';

    // Sidebar Tabs section
    editor.innerHTML = `
        <div class="uid-section">
            <div class="uid-section-title">SIDEBAR TABS <span class="uid-hint">Drag to reorder · Toggle visibility</span></div>
            <div class="uid-tab-list" id="uid-tab-list"></div>
        </div>
        <div class="uid-section">
            <div class="uid-section-title">PANEL SIZES</div>
            <div class="uid-slider-row">
                <label>Sidebar Width</label>
                <input type="range" min="180" max="400" value="${config.sidebar.defaultWidth}" id="uid-sidebar-w" class="uid-slider">
                <span id="uid-sidebar-w-val">${config.sidebar.defaultWidth}px</span>
            </div>
            <div class="uid-slider-row">
                <label>Bottom Panel Height</label>
                <input type="range" min="100" max="500" value="${config.bottomPanel.defaultHeight}" id="uid-bottom-h" class="uid-slider">
                <span id="uid-bottom-h-val">${config.bottomPanel.defaultHeight}px</span>
            </div>
        </div>
        <div class="uid-section">
            <div class="uid-section-title">MENU BAR</div>
            <div class="uid-menu-list" id="uid-menu-list"></div>
        </div>
        <div class="uid-section">
            <div class="uid-section-title">WELCOME SCREEN</div>
            <div class="uid-field-row"><label>Logo Emoji</label><input type="text" class="uid-field" id="uid-welcome-logo" value="${config.welcome.logoEmoji}" maxlength="4"></div>
            <div class="uid-field-row"><label>Title</label><input type="text" class="uid-field" id="uid-welcome-title" value="${escapeHtml(config.welcome.title)}" spellcheck="false"></div>
            <div class="uid-field-row"><label>Subtitle</label><input type="text" class="uid-field" id="uid-welcome-subtitle" value="${escapeHtml(config.welcome.subtitle)}" spellcheck="false"></div>
            <div class="uid-check-row"><input type="checkbox" id="uid-welcome-new" ${config.welcome.showNewProject ? 'checked' : ''}> <label for="uid-welcome-new">Show "New Project" button</label></div>
            <div class="uid-check-row"><input type="checkbox" id="uid-welcome-open" ${config.welcome.showOpenProject ? 'checked' : ''}> <label for="uid-welcome-open">Show "Open Project" button</label></div>
        </div>
        <div class="uid-actions">
            <button class="dp-btn dp-btn-promote" id="uid-apply">Apply to IDE</button>
            <button class="dp-btn" id="uid-export">Export nexia-layout.json</button>
            <button class="dp-btn" id="uid-reset">Reset to Defaults</button>
        </div>`;

    wrapper.appendChild(editor);

    // ── Right: live preview ──
    const preview = document.createElement('div');
    preview.className = 'uid-preview';
    preview.id = 'uid-preview';
    wrapper.appendChild(preview);

    container.appendChild(wrapper);

    // Populate sortable tab list
    renderSidebarTabList(config);
    renderMenuBarList(config);
    renderUIPreview(config);

    // Wire sliders
    const sidebarSlider = document.getElementById('uid-sidebar-w') as HTMLInputElement;
    const bottomSlider = document.getElementById('uid-bottom-h') as HTMLInputElement;
    sidebarSlider.addEventListener('input', () => {
        config.sidebar.defaultWidth = parseInt(sidebarSlider.value);
        document.getElementById('uid-sidebar-w-val')!.textContent = sidebarSlider.value + 'px';
        renderUIPreview(config);
    });
    bottomSlider.addEventListener('input', () => {
        config.bottomPanel.defaultHeight = parseInt(bottomSlider.value);
        document.getElementById('uid-bottom-h-val')!.textContent = bottomSlider.value + 'px';
        renderUIPreview(config);
    });

    // Wire welcome fields
    ['uid-welcome-logo', 'uid-welcome-title', 'uid-welcome-subtitle'].forEach(id => {
        document.getElementById(id)?.addEventListener('input', () => {
            config.welcome.logoEmoji = (document.getElementById('uid-welcome-logo') as HTMLInputElement).value;
            config.welcome.title = (document.getElementById('uid-welcome-title') as HTMLInputElement).value;
            config.welcome.subtitle = (document.getElementById('uid-welcome-subtitle') as HTMLInputElement).value;
            renderUIPreview(config);
        });
    });
    ['uid-welcome-new', 'uid-welcome-open'].forEach(id => {
        document.getElementById(id)?.addEventListener('change', () => {
            config.welcome.showNewProject = (document.getElementById('uid-welcome-new') as HTMLInputElement).checked;
            config.welcome.showOpenProject = (document.getElementById('uid-welcome-open') as HTMLInputElement).checked;
            renderUIPreview(config);
        });
    });

    // Wire action buttons
    document.getElementById('uid-apply')!.addEventListener('click', () => {
        saveUILayoutConfig(config);
        applyUILayout(config);
        appendOutput('UI layout applied and saved.\n');
    });
    document.getElementById('uid-export')!.addEventListener('click', async () => {
        saveUILayoutConfig(config);
        try {
            const { ipcRenderer: ipc } = require('electron');
            const result = await ipc.invoke('file:selectDir');
            if (result) {
                const outPath = nodePath.join(result, 'nexia-layout.json');
                nodeFs.writeFileSync(outPath, JSON.stringify(config, null, 2));
                appendOutput('Exported layout to: ' + outPath + '\n');
            }
        } catch {
            // Fallback: just save to home dir
            const outPath = nodePath.join(nodeOs.homedir(), 'nexia-layout.json');
            nodeFs.writeFileSync(outPath, JSON.stringify(config, null, 2));
            appendOutput('Exported layout to: ' + outPath + '\n');
        }
    });
    document.getElementById('uid-reset')!.addEventListener('click', () => {
        if (!confirm('Reset UI layout to defaults?')) return;
        _uiLayoutConfig = getDefaultLayoutConfig();
        renderUIDesigner(container);
    });
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderSidebarTabList(config: UILayoutConfig) {
    const list = document.getElementById('uid-tab-list');
    if (!list) return;
    list.innerHTML = '';

    config.sidebar.tabs.forEach((tab, i) => {
        const item = document.createElement('div');
        item.className = 'uid-tab-item' + (tab.visible ? '' : ' uid-hidden-tab');
        item.draggable = true;
        item.dataset.index = String(i);
        item.innerHTML = `
            <span class="uid-drag-handle">⠿</span>
            <span class="uid-tab-icon">${tab.icon}</span>
            <span class="uid-tab-name">${tab.title}</span>
            <button class="uid-remove-btn" data-ridx="${i}" title="Remove">✕</button>
            <label class="uid-toggle"><input type="checkbox" ${tab.visible ? 'checked' : ''} data-tidx="${i}"><span class="uid-toggle-slider"></span></label>`;
        list.appendChild(item);
    });

    // Add new tab button
    const addBtn = document.createElement('div');
    addBtn.className = 'uid-add-item';
    addBtn.innerHTML = '<span>＋</span> Add Sidebar Tab';
    addBtn.addEventListener('click', () => {
        const icon = prompt('Emoji icon for the tab:', '📌');
        if (!icon) return;
        const title = prompt('Tab title:', 'Custom Tab');
        if (!title) return;
        const id = 'custom_' + Date.now();
        config.sidebar.tabs.push({ id, icon, title, visible: true });

        // Create the actual sidebar tab button in the DOM
        const tabContainer = document.getElementById('sidebar-tabs');
        if (tabContainer) {
            const btn = document.createElement('button');
            btn.className = 'sidebar-tab';
            btn.dataset.panel = id;
            btn.title = title;
            btn.textContent = icon;
            btn.addEventListener('click', () => {
                document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.remove('active'));
                btn.classList.add('active');
                document.getElementById(`panel-${id}`)?.classList.add('active');
            });
            tabContainer.appendChild(btn);
        }

        // Create the panel container in the DOM
        const sidebarContent = document.getElementById('sidebar-content');
        if (sidebarContent) {
            const panel = document.createElement('div');
            panel.id = `panel-${id}`;
            panel.className = 'sidebar-panel';
            panel.innerHTML = `
                <div class="panel-header">${title.toUpperCase()}</div>
                <div class="panel-body">
                    <div class="git-empty" style="padding:24px 16px;text-align:center">
                        <div class="git-empty-icon">${icon}</div>
                        <div class="git-empty-text">${title}</div>
                        <div class="git-empty-hint">Custom panel — use extensions or the API to add content here</div>
                    </div>
                </div>`;
            sidebarContent.appendChild(panel);
        }

        renderSidebarTabList(config);
        renderUIPreview(config);
        saveUILayoutConfig(config);
    });
    list.appendChild(addBtn);

    // Drag-and-drop reordering
    let dragIdx: number | null = null;
    list.addEventListener('dragstart', (e: DragEvent) => {
        const item = (e.target as HTMLElement).closest('.uid-tab-item') as HTMLElement;
        if (item) { dragIdx = parseInt(item.dataset.index!); item.classList.add('uid-dragging'); }
    });
    list.addEventListener('dragover', (e: DragEvent) => {
        e.preventDefault();
        const item = (e.target as HTMLElement).closest('.uid-tab-item') as HTMLElement;
        if (item) item.classList.add('uid-drag-over');
    });
    list.addEventListener('dragleave', (e: DragEvent) => {
        const item = (e.target as HTMLElement).closest('.uid-tab-item') as HTMLElement;
        if (item) item.classList.remove('uid-drag-over');
    });
    list.addEventListener('drop', (e: DragEvent) => {
        e.preventDefault();
        const item = (e.target as HTMLElement).closest('.uid-tab-item') as HTMLElement;
        if (!item || dragIdx === null) return;
        const dropIdx = parseInt(item.dataset.index!);
        if (dragIdx !== dropIdx) {
            const moved = config.sidebar.tabs.splice(dragIdx, 1)[0];
            config.sidebar.tabs.splice(dropIdx, 0, moved);
            renderSidebarTabList(config);
            renderUIPreview(config);
        }
        item.classList.remove('uid-drag-over');
    });
    list.addEventListener('dragend', () => {
        list.querySelectorAll('.uid-dragging').forEach(el => el.classList.remove('uid-dragging'));
    });

    // Toggle visibility
    list.addEventListener('change', (e: Event) => {
        const cb = e.target as HTMLInputElement;
        if (cb.dataset.tidx !== undefined) {
            const idx = parseInt(cb.dataset.tidx);
            config.sidebar.tabs[idx].visible = cb.checked;
            renderSidebarTabList(config);
            renderUIPreview(config);
        }
    });

    // Remove tab
    list.addEventListener('click', (e: Event) => {
        const btn = (e.target as HTMLElement).closest('.uid-remove-btn') as HTMLElement;
        if (!btn || btn.dataset.ridx === undefined) return;
        const idx = parseInt(btn.dataset.ridx);
        const tab = config.sidebar.tabs[idx];
        if (confirm(`Remove sidebar tab "${tab.title}"?`)) {
            config.sidebar.tabs.splice(idx, 1);
            renderSidebarTabList(config);
            renderUIPreview(config);
        }
    });
}

function renderMenuBarList(config: UILayoutConfig) {
    const list = document.getElementById('uid-menu-list');
    if (!list) return;
    list.innerHTML = '';

    config.menuBar.items.forEach((item, i) => {
        const el = document.createElement('div');
        el.className = 'uid-menu-item';
        el.innerHTML = `
            <span class="uid-menu-label">${item.label}</span>
            <button class="uid-remove-btn" data-midx-rm="${i}" title="Remove">✕</button>
            <label class="uid-toggle"><input type="checkbox" ${item.visible ? 'checked' : ''} data-midx="${i}"><span class="uid-toggle-slider"></span></label>`;
        list.appendChild(el);
    });

    // Add new menu button
    const addBtn = document.createElement('div');
    addBtn.className = 'uid-add-item';
    addBtn.innerHTML = '<span>＋</span> Add Menu';
    addBtn.addEventListener('click', () => {
        const label = prompt('Menu label:', 'Tools');
        if (!label) return;
        const id = 'custom_' + Date.now();
        config.menuBar.items.push({ id, label, visible: true });
        renderMenuBarList(config);
        renderUIPreview(config);
    });
    list.appendChild(addBtn);

    list.addEventListener('change', (e: Event) => {
        const cb = e.target as HTMLInputElement;
        if (cb.dataset.midx !== undefined) {
            config.menuBar.items[parseInt(cb.dataset.midx)].visible = cb.checked;
            renderUIPreview(config);
        }
    });

    list.addEventListener('click', (e: Event) => {
        const btn = (e.target as HTMLElement).closest('[data-midx-rm]') as HTMLElement;
        if (!btn) return;
        const idx = parseInt(btn.dataset.midxRm!);
        if (confirm(`Remove menu "${config.menuBar.items[idx].label}"?`)) {
            config.menuBar.items.splice(idx, 1);
            renderMenuBarList(config);
            renderUIPreview(config);
        }
    });
}

function renderUIPreview(config: UILayoutConfig) {
    const preview = document.getElementById('uid-preview');
    if (!preview) return;

    const sideW = Math.round(config.sidebar.defaultWidth / 4);
    const bottomH = Math.round(config.bottomPanel.defaultHeight / 6);

    const visibleTabs = config.sidebar.tabs.filter(t => t.visible);
    const tabIcons = visibleTabs.map(t => `<div class="uidp-tab" title="${t.title}">${t.icon}</div>`).join('');
    const menuItems = config.menuBar.items.filter(m => m.visible).map(m => `<span class="uidp-menu">${m.label}</span>`).join('');

    preview.innerHTML = `
        <div class="uidp-frame">
            <div class="uidp-titlebar">
                <span class="uidp-titlebar-text">Nexia IDE</span>
                <span class="uidp-titlebar-user">user ✕</span>
            </div>
            <div class="uidp-menubar">${menuItems}</div>
            <div class="uidp-body">
                <div class="uidp-sidebar" style="width:${sideW}px">
                    <div class="uidp-sidebar-icons">${tabIcons}</div>
                    <div class="uidp-sidebar-panel"></div>
                </div>
                <div class="uidp-main">
                    <div class="uidp-editor">
                        <div class="uidp-welcome">
                            <div class="uidp-welcome-logo">${config.welcome.logoEmoji}</div>
                            <div class="uidp-welcome-title">${escapeHtml(config.welcome.title)}</div>
                            <div class="uidp-welcome-sub">${escapeHtml(config.welcome.subtitle)}</div>
                            <div class="uidp-welcome-btns">
                                ${config.welcome.showNewProject ? '<span class="uidp-btn">New Project</span>' : ''}
                                ${config.welcome.showOpenProject ? '<span class="uidp-btn">Open Project</span>' : ''}
                            </div>
                        </div>
                    </div>
                    <div class="uidp-bottom" style="height:${bottomH}px">
                        <div class="uidp-bottom-tabs">OUTPUT</div>
                    </div>
                </div>
            </div>
            <div class="uidp-statusbar"></div>
        </div>`;
}

function applyUILayout(config: UILayoutConfig) {
    // Apply sidebar tab order and visibility
    const tabContainer = document.getElementById('sidebar-tabs');
    const sidebarContent = document.getElementById('sidebar-content');
    if (tabContainer) {
        const buttons = Array.from(tabContainer.querySelectorAll('.sidebar-tab')) as HTMLElement[];
        const buttonMap = new Map<string, HTMLElement>();
        buttons.forEach(b => buttonMap.set(b.dataset.panel!, b));

        // Reorder and create missing custom tabs
        config.sidebar.tabs.forEach(tab => {
            let btn = buttonMap.get(tab.id);

            // Create DOM elements for custom tabs that don't exist yet
            if (!btn && tab.id.startsWith('custom_')) {
                btn = document.createElement('button') as HTMLButtonElement;
                btn.className = 'sidebar-tab';
                btn.dataset.panel = tab.id;
                btn.title = tab.title;
                btn.textContent = tab.icon;
                btn.addEventListener('click', () => {
                    document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
                    document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.remove('active'));
                    btn!.classList.add('active');
                    document.getElementById(`panel-${tab.id}`)?.classList.add('active');
                });
                tabContainer.appendChild(btn);

                // Create panel
                if (sidebarContent && !document.getElementById(`panel-${tab.id}`)) {
                    const panel = document.createElement('div');
                    panel.id = `panel-${tab.id}`;
                    panel.className = 'sidebar-panel';
                    panel.innerHTML = `
                        <div class="panel-header">${tab.title.toUpperCase()}</div>
                        <div class="panel-body">
                            <div class="git-empty" style="padding:24px 16px;text-align:center">
                                <div class="git-empty-icon">${tab.icon}</div>
                                <div class="git-empty-text">${tab.title}</div>
                                <div class="git-empty-hint">Custom panel — use extensions or the API to add content here</div>
                            </div>
                        </div>`;
                    sidebarContent.appendChild(panel);
                }
            }

            if (btn) {
                btn.style.display = tab.visible ? '' : 'none';
                tabContainer.appendChild(btn); // moves to end = reorder
            }
        });
    }

    // Apply panel sizes
    document.documentElement.style.setProperty('--sidebar-w', config.sidebar.defaultWidth + 'px');
    document.documentElement.style.setProperty('--bottom-h', config.bottomPanel.defaultHeight + 'px');

    // Apply menu bar visibility
    config.menuBar.items.forEach(item => {
        const menuEl = document.getElementById('menu-' + item.id) || document.getElementById('menu-' + item.id + '-menu');
        if (menuEl) menuEl.style.display = item.visible ? '' : 'none';
    });

    // Apply welcome screen
    const welcomeLogo = document.getElementById('welcome-logo');
    const welcomeH1 = document.querySelector('#welcome-content h1');
    const welcomeP = document.querySelector('#welcome-content > p');
    if (welcomeLogo) welcomeLogo.textContent = config.welcome.logoEmoji;
    if (welcomeH1) welcomeH1.textContent = config.welcome.title;
    if (welcomeP) welcomeP.textContent = config.welcome.subtitle;
    const welcomeNew = document.getElementById('welcome-new');
    const welcomeOpen = document.getElementById('welcome-open');
    if (welcomeNew) welcomeNew.style.display = config.welcome.showNewProject ? '' : 'none';
    if (welcomeOpen) welcomeOpen.style.display = config.welcome.showOpenProject ? '' : 'none';
}

// ══════════════════════════════════════
//  MARKETPLACE (Developer Panel tab)
// ══════════════════════════════════════

let _settingsPanelOpen = false;

/**
 * @param section which nav item to open on. Defaults to Appearance; the Learn
 *        panel passes 'learn' so its "enter a key" button lands on the field
 *        it's asking for rather than dumping the user at the front of Settings.
 */
function showSettingsPanel(section = 'appearance') {
    if (_settingsPanelOpen) { closeSettingsPanel(); return; }
    _settingsPanelOpen = true;

    const overlay = document.createElement('div');
    overlay.id = 'settings-panel-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9998;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity 0.2s;';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSettingsPanel(); });
    document.body.appendChild(overlay);

    const win = document.createElement('div');
    win.id = 'settings-panel-window';
    win.style.cssText = 'display:flex;width:760px;max-width:90vw;height:560px;max-height:85vh;background:var(--bg-panel);border:1px solid var(--border);border-radius:10px;box-shadow:0 20px 60px rgba(0,0,0,0.5);overflow:hidden;font-family:var(--font);';

    // Sidebar
    const sidebar = document.createElement('div');
    sidebar.style.cssText = 'width:180px;background:var(--bg-dark);border-right:1px solid var(--border);padding:16px 0;display:flex;flex-direction:column;flex-shrink:0;';
    sidebar.innerHTML = `
        <style>
            .sp-nav-item { display:flex;align-items:center;gap:8px;width:100%;padding:8px 16px;border:none;background:transparent;color:var(--text-dim);font-size:12px;cursor:pointer;text-align:left;font-family:var(--font);transition:background 0.15s,color 0.15s; }
            .sp-nav-item:hover { background:var(--bg-hover);color:var(--text); }
            .sp-nav-item.active { background:var(--bg-input);color:var(--text);font-weight:600;border-left:2px solid var(--accent); }
        </style>
        <div style="padding:0 16px 16px;font-size:14px;font-weight:600;color:var(--text);">⚙ Settings</div>
        <div class="sp-nav" id="sp-nav">
            <button class="sp-nav-item${section === 'appearance' ? ' active' : ''}" data-section="appearance">🎨 Appearance</button>
            <button class="sp-nav-item${section === 'layout' ? ' active' : ''}" data-section="layout">📐 Layout</button>
            <button class="sp-nav-item${section === 'ai' ? ' active' : ''}" data-section="ai">🤖 AI Assistant</button>
            <button class="sp-nav-item${section === 'learn' ? ' active' : ''}" data-section="learn">🎓 Learn</button>
            <button class="sp-nav-item${section === 'accounts' ? ' active' : ''}" data-section="accounts">🔗 Accounts</button>
            <button class="sp-nav-item${section === 'advanced' ? ' active' : ''}" data-section="advanced">⚡ Advanced</button>
        </div>
        <div style="flex:1;"></div>
        <div id="sp-version" style="padding:8px 16px;font-size:10.5px;color:var(--text-muted);user-select:text;"></div>
    `;
    win.appendChild(sidebar);

    // Build version, bottom-left. Read from the main process rather than the
    // bundled package.json: app.getVersion() is what the updater compares
    // against the release manifest, so this shows the number that actually
    // decides whether an update is offered.
    ipcRenderer.invoke('app:version').then((v: string) => {
        const el = $('sp-version');
        if (el) el.textContent = `Nexia IDE ${displayVersion(v)}`;
    }).catch(() => {
        const el = $('sp-version');
        if (el) el.textContent = '';
    });

    // Content, in a relative wrapper so the close button can pin to the corner.
    // It cannot live inside #sp-content: that scrolls, and the button would
    // scroll away with the settings.
    const contentWrap = document.createElement('div');
    contentWrap.style.cssText = 'flex:1;position:relative;display:flex;min-width:0;';

    const closeBtn = document.createElement('button');
    closeBtn.id = 'sp-close';
    closeBtn.title = 'Close settings (Esc)';
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'position:absolute;top:12px;right:14px;z-index:2;width:26px;height:26px;display:flex;align-items:center;justify-content:center;border:none;border-radius:5px;background:transparent;color:var(--text-muted);font-size:13px;cursor:pointer;font-family:var(--font);transition:background 0.15s,color 0.15s;';
    closeBtn.addEventListener('mouseenter', () => {
        closeBtn.style.background = 'var(--bg-hover)';
        closeBtn.style.color = 'var(--text)';
    });
    closeBtn.addEventListener('mouseleave', () => {
        closeBtn.style.background = 'transparent';
        closeBtn.style.color = 'var(--text-muted)';
    });
    closeBtn.addEventListener('click', () => closeSettingsPanel());
    contentWrap.appendChild(closeBtn);

    const content = document.createElement('div');
    content.id = 'sp-content';
    // Extra right padding so a section heading can't slide under the ✕.
    content.style.cssText = 'flex:1;overflow-y:auto;padding:24px 28px;padding-right:48px;';
    contentWrap.appendChild(content);
    win.appendChild(contentWrap);

    overlay.appendChild(win);
    requestAnimationFrame(() => { overlay.style.opacity = '1'; });

    // Wire nav
    sidebar.querySelector('#sp-nav')!.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest('.sp-nav-item') as HTMLElement;
        if (!btn) return;
        sidebar.querySelectorAll('.sp-nav-item').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        renderSettingsSection(content, btn.dataset.section!);
    });

    // Closing is the ✕ in the top right, the overlay, or Escape. The old Done
    // button sat bottom-left of the sidebar, where nothing else about the panel
    // suggested a dialog to confirm — settings apply as you change them.

    // Escape key
    const escHandler = (e: KeyboardEvent) => {
        if (e.key === 'Escape') { closeSettingsPanel(); document.removeEventListener('keydown', escHandler); }
    };
    document.addEventListener('keydown', escHandler);

    renderSettingsSection(content, section);
}

function closeSettingsPanel() {
    _settingsPanelOpen = false;
    // Save AI settings before closing
    saveSettingsFromUI();
    const overlay = document.getElementById('settings-panel-overlay');
    if (overlay) {
        overlay.style.opacity = '0';
        setTimeout(() => overlay.remove(), 200);
    }
}

function saveSettingsFromUI() {
    const get = (id: string) => document.getElementById(id);
    const providerSel = get('sp-ai-provider') as HTMLSelectElement;
    if (providerSel) userSettings.aiProvider = providerSel.value as any;
    const apiKeyInput = get('sp-ai-key') as HTMLInputElement;
    if (apiKeyInput) userSettings.aiApiKey = apiKeyInput.value;
    const endpointInput = get('sp-ai-endpoint') as HTMLInputElement;
    if (endpointInput) userSettings.aiEndpoint = endpointInput.value;
    const modelInput = get('sp-ai-model') as HTMLInputElement;
    if (modelInput) userSettings.aiModel = modelInput.value.trim();
    const sysPrompt = get('sp-ai-system') as HTMLTextAreaElement;
    if (sysPrompt) userSettings.aiSystemPrompt = sysPrompt.value;
    const inlineSuggest = get('sp-ai-inline') as HTMLInputElement;
    if (inlineSuggest) userSettings.aiInlineSuggest = inlineSuggest.checked;
    const fileCtx = get('sp-ai-filectx') as HTMLInputElement;
    if (fileCtx) userSettings.aiFileContext = fileCtx.checked;

    // Learn tab. Same contract as the AI fields above: each is read only when
    // its element is on screen, so switching sections doesn't blank a key that
    // isn't currently rendered.
    const ytKey = get('sp-yt-key') as HTMLInputElement;
    if (ytKey) userSettings.youtubeApiKey = ytKey.value.trim();
    const webKey = get('sp-web-key') as HTMLInputElement;
    if (webKey) userSettings.searchApiKey = webKey.value.trim();
    const webCx = get('sp-web-cx') as HTMLInputElement;
    if (webCx) userSettings.searchEngineId = webCx.value.trim();

    saveUserSettings();
}

const PRESETS: Record<string, Partial<UserSettings>> = {
    xbox:   { accentColor: '#4ec9b0', bgDark: '#181818', bgMain: '#1e1e1e', bgPanel: '#1e1e1e', bgSidebar: '#252526', editorBg: '#1e1e1e', textColor: '#cccccc', textDim: '#858585' },
    red:    { accentColor: '#f14c4c', bgDark: '#1c1616', bgMain: '#221a1a', bgPanel: '#221a1a', bgSidebar: '#2a2020', editorBg: '#221a1a', textColor: '#d4c8c8', textDim: '#8a7070' },
    blue:   { accentColor: '#4fc1ff', bgDark: '#16181c', bgMain: '#1a1e24', bgPanel: '#1a1e24', bgSidebar: '#20242a', editorBg: '#1a1e24', textColor: '#ccd0d8', textDim: '#687888' },
    purple: { accentColor: '#c586c0', bgDark: '#1c1620', bgMain: '#221a26', bgPanel: '#221a26', bgSidebar: '#28202e', editorBg: '#221a26', textColor: '#d4ccd8', textDim: '#8a7090' },
    orange: { accentColor: '#ce9178', bgDark: '#1c1816', bgMain: '#241e1a', bgPanel: '#241e1a', bgSidebar: '#2a2420', editorBg: '#241e1a', textColor: '#d8d0c8', textDim: '#8a7868' },
    mono:   { accentColor: '#cccccc', bgDark: '#141414', bgMain: '#1a1a1a', bgPanel: '#1a1a1a', bgSidebar: '#222222', editorBg: '#1a1a1a', textColor: '#d4d4d4', textDim: '#808080' },
};

/**
 * Structural skins. Unlike PRESETS (which only swap colors), each skin also
 * restyles component structure via CSS scoped to [data-skin="..."] in main.css.
 * Each pairs its `skin` id with a palette tuned for it.
 */
const SKINS: Record<string, { label: string; desc: string; settings: Partial<UserSettings> }> = {
    default: {
        label: 'Default',
        desc: 'Clean, familiar editor chrome.',
        settings: { skin: 'default', ...PRESETS.xbox },
    },
    blade: {
        label: 'Blade',
        desc: 'The 2005 Xbox 360 dashboard — sliding blades, ring of light, deep green field.',
        settings: {
            skin: 'blade', accentColor: '#9fe870', bgDark: '#06120d', bgMain: '#0a1f15',
            bgPanel: '#0e3521', bgSidebar: '#0c2f1e', editorBg: '#06120d',
            textColor: '#e9f6e2', textDim: '#8fb083',
        },
    },
    devkit: {
        label: 'Devkit',
        desc: 'The IDE as hardware — brushed chassis, machined bezel, keycaps, status LEDs.',
        settings: {
            skin: 'devkit', accentColor: '#5ee07f', bgDark: '#141618', bgMain: '#24272b',
            bgPanel: '#2a2d31', bgSidebar: '#1b1e21', editorBg: '#0a0c0d',
            textColor: '#dfe4ea', textDim: '#8b919a',
        },
    },
    phosphor: {
        label: 'Phosphor',
        desc: 'CRT terminal brutalism — monospace, scanlines, hard edges, phosphor glow.',
        settings: {
            skin: 'phosphor', accentColor: '#41ff8a', bgDark: '#050705', bgMain: '#050705',
            bgPanel: '#070d08', bgSidebar: '#050705', editorBg: '#050705',
            textColor: '#41ff8a', textDim: '#2aa85c',
        },
    },
};

function renderSettingsSection(container: HTMLElement, section: string) {
    // Save AI settings before switching sections so nothing is lost
    saveSettingsFromUI();

    const s = userSettings;
    const row = (label: string, input: string) => `<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;"><label style="font-size:13px;color:var(--text);">${label}</label>${input}</div>`;
    const toggle = (id: string, checked: boolean) => `<label class="toggle-switch"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''}><span class="toggle-slider"></span></label>`;
    const colorInput = (key: string, val: string) => `<input type="color" data-setting="${key}" value="${val || '#1e1e1e'}" style="width:36px;height:24px;border:1px solid var(--border);background:var(--bg-input);cursor:pointer;padding:1px;border-radius:var(--radius-sm);">`;
    const sectionTitle = (title: string) => `<div style="font-size:11px;color:var(--text-dim);letter-spacing:0.04em;margin:16px 0 8px;text-transform:uppercase;font-weight:700;">${title}</div>`;

    switch (section) {
        // 'editor' is gone: it was one field, Font Size, under its own tab and
        // its own heading. It lives in Appearance now, next to the code colours
        // it sits beside in the editor anyway.

        case 'appearance':
            container.innerHTML = `
                <h2 style="font-size:18px;font-weight:600;color:var(--text);margin:0 0 20px;">Appearance</h2>
                ${sectionTitle('Skin')}
                <div style="font-size:11px;color:var(--text-muted);margin:0 0 10px;">A skin changes the IDE's structure — not just its colors.</div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px;">
                    ${Object.entries(SKINS).map(([id, sk]) => `
                        <button class="skin-btn" data-skin="${id}" style="text-align:left;padding:10px 12px;border:1px solid ${(s.skin || 'default') === id ? 'var(--green)' : 'var(--border)'};background:${(s.skin || 'default') === id ? 'var(--green-bg)' : 'var(--bg-input)'};color:var(--text);border-radius:var(--radius-md);cursor:pointer;">
                            <div style="font-size:12.5px;font-weight:600;margin-bottom:3px;">${escapeHtml(sk.label)}${(s.skin || 'default') === id ? ' <span style="color:var(--green)">✓</span>' : ''}</div>
                            <div style="font-size:10.5px;color:var(--text-muted);line-height:1.45;">${escapeHtml(sk.desc)}</div>
                        </button>`).join('')}
                </div>
                ${sectionTitle('Visual Effects')}
                ${row('Fancy Mode', toggle('sp-fancy', s.fancyEffects))}
                <div style="font-size:11px;color:var(--text-muted);margin:2px 0 12px;">Glassmorphism, glow effects, animations, floating orbs, and decorative shadows.</div>
                ${sectionTitle('Theme Colors')}
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 24px;">
                    ${row('Accent Color', colorInput('accentColor', s.accentColor))}
                    ${row('Background (Dark)', colorInput('bgDark', s.bgDark))}
                    ${row('Background (Main)', colorInput('bgMain', s.bgMain))}
                    ${row('Panel Background', colorInput('bgPanel', s.bgPanel))}
                    ${row('Sidebar Background', colorInput('bgSidebar', s.bgSidebar))}
                    ${row('Editor Background', colorInput('editorBg', s.editorBg))}
                    ${row('Text Color', colorInput('textColor', s.textColor))}
                    ${row('Text (Dim)', colorInput('textDim', s.textDim))}
                </div>
                ${sectionTitle('Code Colors')}
                <div style="font-size:11px;color:var(--text-muted);margin:0 0 10px;">How your code is syntax-highlighted. Changes apply as you pick.</div>
                <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px;">
                    ${Object.entries(SYNTAX_PRESETS).map(([id, p]) => `
                        <button class="syntax-preset-btn" data-syntax-preset="${id}" title="${escapeHtml(p.label)}"
                            style="display:flex;align-items:center;gap:6px;padding:5px 9px;border:1px solid var(--border);background:var(--bg-input);color:var(--text);border-radius:var(--radius-sm);cursor:pointer;font-size:11.5px;">
                            <span style="display:flex;border-radius:2px;overflow:hidden;border:1px solid rgba(0,0,0,0.4)">
                                ${(['keyword', 'string', 'comment', 'function'] as (keyof SyntaxColors)[])
                                    .map(k => `<span style="width:7px;height:12px;background:${p.colors[k]}"></span>`).join('')}
                            </span>
                            ${escapeHtml(p.label)}
                        </button>`).join('')}
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 24px;">
                    ${SYNTAX_COLOR_LABELS.map(([key, label, sample]) => row(
                        `${label} <span style="color:var(--text-muted);font-family:var(--font-mono);font-size:10.5px;">${escapeHtml(sample)}</span>`,
                        `<input type="color" data-syntax="${key}" value="${(s.syntaxColors || DEFAULT_SYNTAX_COLORS)[key]}" style="width:36px;height:24px;border:1px solid var(--border);background:var(--bg-input);cursor:pointer;padding:1px;border-radius:var(--radius-sm);">`
                    )).join('')}
                </div>
                <button id="sp-syntax-reset" style="margin-top:8px;padding:5px 10px;border:1px solid var(--border);background:var(--bg-input);color:var(--text-dim);border-radius:var(--radius-sm);cursor:pointer;font-size:11px;">Reset code colors</button>
                ${sectionTitle('Editor Font')}
                ${row('Font Size', `<input type="number" id="sp-fontsize" min="8" max="40" value="${s.fontSize}" style="width:60px;padding:3px 6px;background:var(--bg-input);border:1px solid var(--border);color:var(--text);font-family:var(--mono);font-size:13px;text-align:center;border-radius:var(--radius-sm);">`)}
                ${sectionTitle('Presets')}
                <div style="display:flex;gap:6px;flex-wrap:wrap;">
                    <button class="preset-btn" data-preset="xbox" style="padding:6px 12px;border:1px solid var(--border);background:var(--bg-input);color:var(--text);border-radius:var(--radius-sm);cursor:pointer;font-size:12px;">🟢 Xbox Green</button>
                    <button class="preset-btn" data-preset="red" style="padding:6px 12px;border:1px solid var(--border);background:var(--bg-input);color:var(--text);border-radius:var(--radius-sm);cursor:pointer;font-size:12px;">🔴 Red Ring</button>
                    <button class="preset-btn" data-preset="blue" style="padding:6px 12px;border:1px solid var(--border);background:var(--bg-input);color:var(--text);border-radius:var(--radius-sm);cursor:pointer;font-size:12px;">🔵 Blue Steel</button>
                    <button class="preset-btn" data-preset="purple" style="padding:6px 12px;border:1px solid var(--border);background:var(--bg-input);color:var(--text);border-radius:var(--radius-sm);cursor:pointer;font-size:12px;">🟣 Purple Haze</button>
                    <button class="preset-btn" data-preset="orange" style="padding:6px 12px;border:1px solid var(--border);background:var(--bg-input);color:var(--text);border-radius:var(--radius-sm);cursor:pointer;font-size:12px;">🟠 Sunset</button>
                    <button class="preset-btn" data-preset="mono" style="padding:6px 12px;border:1px solid var(--border);background:var(--bg-input);color:var(--text);border-radius:var(--radius-sm);cursor:pointer;font-size:12px;">⚪ Mono</button>
                </div>
            `;
            container.querySelector('#sp-fancy')!.addEventListener('change', (e) => {
                userSettings.fancyEffects = (e.target as HTMLInputElement).checked;
                applyFancyMode();
                saveUserSettings();
            });
            // Live color updates. Scoped to [data-setting] so the syntax pickers
            // below — also input[type=color] — don't fall through to here and get
            // written as top-level settings keys.
            container.querySelectorAll('input[type="color"][data-setting]').forEach(inp => {
                inp.addEventListener('input', (e) => {
                    const t = e.target as HTMLInputElement;
                    const key = t.dataset.setting as keyof UserSettings;
                    if (key) (userSettings as any)[key] = t.value;
                    applyThemeColors();
                    saveUserSettings();
                });
            });
            // Syntax colors — redefine the editor theme, don't touch the UI palette.
            container.querySelectorAll('input[type="color"][data-syntax]').forEach(inp => {
                inp.addEventListener('input', (e) => {
                    const t = e.target as HTMLInputElement;
                    const key = t.dataset.syntax as keyof SyntaxColors;
                    if (!key) return;
                    if (!userSettings.syntaxColors) userSettings.syntaxColors = { ...DEFAULT_SYNTAX_COLORS };
                    userSettings.syntaxColors[key] = t.value;
                    // defineTheme with an existing name replaces it, and Monaco
                    // re-renders every open editor against the new rules.
                    defineEditorTheme();
                    saveUserSettings();
                });
            });
            container.querySelector('#sp-syntax-reset')?.addEventListener('click', () => {
                userSettings.syntaxColors = { ...DEFAULT_SYNTAX_COLORS };
                defineEditorTheme();
                saveUserSettings();
                renderSettingsSection(container, 'appearance');
            });
            // Font size, moved here from the Editor tab. Deliberately has no
            // data-setting attribute: the live colour handler above binds to
            // [data-setting] and would write this number as a colour.
            container.querySelector('#sp-fontsize')?.addEventListener('input', (e) => {
                const v = parseInt((e.target as HTMLInputElement).value) || 14;
                userSettings.fontSize = Math.max(8, Math.min(40, v));
                if (editor) editor.updateOptions({ fontSize: userSettings.fontSize });
                const zoom = $('status-zoom');
                if (zoom) zoom.textContent = `${Math.round((userSettings.fontSize / 14) * 100)}%`;
                saveUserSettings();
            });
            // Syntax schemes. Copied, not referenced — assigning the preset
            // object itself would alias it, so editing one colour afterwards
            // would rewrite the preset for the rest of the session.
            container.querySelectorAll('.syntax-preset-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const id = (btn as HTMLElement).dataset.syntaxPreset;
                    if (!id || !SYNTAX_PRESETS[id]) return;
                    userSettings.syntaxColors = { ...SYNTAX_PRESETS[id].colors };
                    defineEditorTheme();
                    saveUserSettings();
                    // Re-render so the pickers below show the scheme's values
                    // rather than the ones they had before.
                    renderSettingsSection(container, 'appearance');
                });
            });
            // Skins — apply the structural skin plus its tuned palette
            container.querySelectorAll('.skin-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const id = (btn as HTMLElement).dataset.skin;
                    if (id && SKINS[id]) {
                        Object.assign(userSettings, SKINS[id].settings);
                        saveUserSettings();
                        applyThemeColors();
                        renderSettingsSection(container, 'appearance');
                        appendOutput(`Skin: ${SKINS[id].label}\n`);
                    }
                });
            });
            // Presets
            container.querySelectorAll('.preset-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const p = (btn as HTMLElement).dataset.preset;
                    if (p && PRESETS[p]) {
                        Object.assign(userSettings, PRESETS[p]);
                        saveUserSettings();
                        applyThemeColors();
                        renderSettingsSection(container, 'appearance');
                    }
                });
            });
            break;

        case 'layout':
            const currentLayout = s.layout || 'sidebar-left';
            container.innerHTML = `
                <h2 style="font-size:18px;font-weight:600;color:var(--text);margin:0 0 20px;">Layout</h2>
                ${sectionTitle('Window Layout')}
                <div class="layout-grid">
                    <div class="layout-option ${currentLayout === 'sidebar-left' ? 'active' : ''}" data-layout="sidebar-left">
                        <div class="layout-preview"><div class="lp-sidebar lp-left"></div><div class="lp-main"></div></div>
                        <span>Sidebar Left</span>
                    </div>
                    <div class="layout-option ${currentLayout === 'sidebar-right' ? 'active' : ''}" data-layout="sidebar-right">
                        <div class="layout-preview"><div class="lp-main"></div><div class="lp-sidebar lp-right"></div></div>
                        <span>Sidebar Right</span>
                    </div>
                    <!--
                        "Bottom Panel" and "AI Side Panel" were here and did
                        nothing. bottom-panel had no branch in applyLayout() and
                        no CSS, so it silently fell through to sidebar-left;
                        ai-right added a class whose only rule targeted
                        #ai-panel-container, an element that does not exist in
                        index.html. Two buttons that changed a saved setting and
                        nothing else. Better to offer two layouts that work than
                        four where half are decoration.
                    -->
                </div>
                ${sectionTitle('Borders & Spacing')}
                ${row('Corner Rounding', `<select id="sp-corner" style="padding:4px 8px;background:var(--bg-input);border:1px solid var(--border);color:var(--text);border-radius:var(--radius-sm);font-size:12px;">
                    <option value="sharp" ${s.cornerRadius === 'sharp' ? 'selected' : ''}>Sharp (0px)</option>
                    <option value="subtle" ${s.cornerRadius === 'subtle' ? 'selected' : ''}>Subtle (4px)</option>
                    <option value="rounded" ${(!s.cornerRadius || s.cornerRadius === 'rounded') ? 'selected' : ''}>Rounded (8px)</option>
                    <option value="pill" ${s.cornerRadius === 'pill' ? 'selected' : ''}>Pill (12px)</option>
                </select>`)}
            `;
            container.querySelectorAll('.layout-option').forEach(opt => {
                opt.addEventListener('click', () => {
                    container.querySelectorAll('.layout-option').forEach(o => o.classList.remove('active'));
                    opt.classList.add('active');
                    userSettings.layout = (opt as HTMLElement).dataset.layout!;
                    applyLayout();
                    saveUserSettings();
                });
            });
            container.querySelector('#sp-corner')!.addEventListener('change', (e) => {
                userSettings.cornerRadius = (e.target as HTMLSelectElement).value;
                applyCornerRadius();
                saveUserSettings();
            });
            break;

        case 'ai':
            const showEndpoint = s.aiProvider === 'custom' || s.aiProvider === 'local';
            container.innerHTML = `
                <h2 style="font-size:18px;font-weight:600;color:var(--text);margin:0 0 20px;">AI Assistant</h2>
                ${sectionTitle('Provider')}
                <div style="margin-bottom:10px;">
                    <select id="sp-ai-provider" style="width:100%;padding:6px 10px;background:var(--bg-input);border:1px solid var(--border);color:var(--text);border-radius:var(--radius-sm);font-size:13px;">
                        <option value="anthropic" ${s.aiProvider === 'anthropic' ? 'selected' : ''}>Anthropic (Claude)</option>
                        <option value="openai" ${s.aiProvider === 'openai' ? 'selected' : ''}>OpenAI (GPT)</option>
                        <option value="local" ${s.aiProvider === 'local' ? 'selected' : ''}>Local / Ollama</option>
                        <option value="custom" ${s.aiProvider === 'custom' ? 'selected' : ''}>Custom Endpoint</option>
                    </select>
                </div>
                ${sectionTitle('API Key')}
                <div style="display:flex;gap:8px;margin-bottom:10px;">
                    <input type="password" id="sp-ai-key" value="${escapeHtml(s.aiApiKey || '')}" placeholder="sk-... or your API key" style="flex:1;padding:6px 10px;background:var(--bg-input);border:1px solid var(--border);color:var(--text);border-radius:var(--radius-sm);font-size:13px;">
                    <button id="sp-ai-key-toggle" style="padding:6px 12px;background:var(--bg-input);border:1px solid var(--border);color:var(--text);border-radius:var(--radius-sm);cursor:pointer;font-size:12px;">Show</button>
                </div>
                <div id="sp-ai-endpoint-row" style="margin-bottom:10px;${showEndpoint ? '' : 'display:none;'}">
                    <div style="font-size:11px;color:var(--text-dim);margin-bottom:4px;">Custom Endpoint</div>
                    <input type="text" id="sp-ai-endpoint" value="${escapeHtml(s.aiEndpoint || '')}" placeholder="http://localhost:11434/v1/chat/completions" style="width:100%;padding:6px 10px;background:var(--bg-input);border:1px solid var(--border);color:var(--text);border-radius:var(--radius-sm);font-size:13px;box-sizing:border-box;">
                </div>
                ${sectionTitle('Model')}
                <input type="text" id="sp-ai-model" value="${escapeHtml(s.aiModel || '')}" placeholder="Leave blank for default" style="width:100%;padding:6px 10px;background:var(--bg-input);border:1px solid var(--border);color:var(--text);border-radius:var(--radius-sm);font-size:13px;margin-bottom:10px;box-sizing:border-box;">
                ${sectionTitle('System Context')}
                <textarea id="sp-ai-system" rows="3" placeholder="Custom instructions (optional)" style="width:100%;padding:6px 10px;background:var(--bg-input);border:1px solid var(--border);color:var(--text);border-radius:var(--radius-sm);font-size:13px;resize:vertical;margin-bottom:12px;box-sizing:border-box;font-family:var(--font);">${escapeHtml(s.aiSystemPrompt || '')}</textarea>
                ${sectionTitle('Behavior')}
                ${row('Inline code suggestions', toggle('sp-ai-inline', s.aiInlineSuggest || false))}
                ${row('Include open file as context', toggle('sp-ai-filectx', s.aiFileContext !== false))}
                <div style="margin-top:12px;">
                    <button id="sp-ai-test" style="padding:6px 14px;background:var(--bg-input);border:1px solid var(--border);color:var(--text);border-radius:var(--radius-sm);cursor:pointer;font-size:12px;">🔌 Test Connection</button>
                </div>
            `;
            container.querySelector('#sp-ai-provider')!.addEventListener('change', (e) => {
                const v = (e.target as HTMLSelectElement).value;
                const epRow = document.getElementById('sp-ai-endpoint-row');
                if (epRow) epRow.style.display = (v === 'custom' || v === 'local') ? '' : 'none';
            });
            container.querySelector('#sp-ai-key-toggle')!.addEventListener('click', () => {
                const inp = document.getElementById('sp-ai-key') as HTMLInputElement;
                const btn = document.getElementById('sp-ai-key-toggle') as HTMLButtonElement;
                if (inp.type === 'password') { inp.type = 'text'; btn.textContent = 'Hide'; }
                else { inp.type = 'password'; btn.textContent = 'Show'; }
            });
            container.querySelector('#sp-ai-test')!.addEventListener('click', async () => {
                const btn = document.getElementById('sp-ai-test') as HTMLButtonElement;
                saveSettingsFromUI();
                btn.disabled = true; btn.textContent = '⏳ Testing...';
                try {
                    await aiComplete([{ role: 'user', content: 'Say "connected" and nothing else.' }]);
                    btn.textContent = '✅ Connected!';
                } catch (err: any) {
                    btn.textContent = `❌ ${(err.message || 'Failed').substring(0, 40)}`;
                }
                setTimeout(() => { btn.disabled = false; btn.textContent = '🔌 Test Connection'; }, 3000);
            });
            break;

        // Keys for the Learn panel's Videos and Web tabs. They're here rather
        // than in the panel itself because a key is a setting, not a search —
        // you enter it once and never look at it again.
        case 'learn': {
            const webProvider = s.searchProvider || 'google';
            container.innerHTML = `
                <h2 style="font-size:18px;font-weight:600;color:var(--text);margin:0 0 20px;">Learn</h2>
                <div style="font-size:11.5px;color:var(--text-muted);line-height:1.6;margin-bottom:6px;">
                    The Videos and Web tabs search through the providers' own APIs, which means each needs a key.
                    Both have free tiers. The curriculum, lessons and progress tracking work without either.
                </div>

                ${sectionTitle('YouTube — Videos tab')}
                <div style="display:flex;gap:8px;margin-bottom:6px;">
                    <input type="password" id="sp-yt-key" value="${escapeHtml(s.youtubeApiKey || '')}" placeholder="YouTube Data API v3 key" style="flex:1;padding:6px 10px;background:var(--bg-input);border:1px solid var(--border);color:var(--text);border-radius:var(--radius-sm);font-size:13px;">
                    <button id="sp-yt-toggle" style="padding:6px 12px;background:var(--bg-input);border:1px solid var(--border);color:var(--text);border-radius:var(--radius-sm);cursor:pointer;font-size:12px;">Show</button>
                </div>
                <div style="font-size:10.5px;color:var(--text-muted);margin-bottom:4px;">
                    Free tier is 100 searches a day. <a href="#" id="sp-yt-link" style="color:var(--accent);text-decoration:none;">Get a key →</a>
                </div>

                ${sectionTitle('Web search — Web tab')}
                <select id="sp-web-provider" style="width:100%;padding:6px 10px;background:var(--bg-input);border:1px solid var(--border);color:var(--text);border-radius:var(--radius-sm);font-size:13px;margin-bottom:8px;">
                    <option value="google" ${webProvider === 'google' ? 'selected' : ''}>Google Programmable Search</option>
                    <option value="brave" ${webProvider === 'brave' ? 'selected' : ''}>Brave Search</option>
                </select>
                <div style="display:flex;gap:8px;margin-bottom:8px;">
                    <input type="password" id="sp-web-key" value="${escapeHtml(s.searchApiKey || '')}" placeholder="${webProvider === 'brave' ? 'Brave Search API key' : 'Google API key'}" style="flex:1;padding:6px 10px;background:var(--bg-input);border:1px solid var(--border);color:var(--text);border-radius:var(--radius-sm);font-size:13px;">
                    <button id="sp-web-toggle" style="padding:6px 12px;background:var(--bg-input);border:1px solid var(--border);color:var(--text);border-radius:var(--radius-sm);cursor:pointer;font-size:12px;">Show</button>
                </div>
                <div id="sp-web-cx-row" style="margin-bottom:6px;${webProvider === 'google' ? '' : 'display:none;'}">
                    <input type="text" id="sp-web-cx" value="${escapeHtml(s.searchEngineId || '')}" placeholder="Search engine ID (cx)" style="width:100%;padding:6px 10px;background:var(--bg-input);border:1px solid var(--border);color:var(--text);border-radius:var(--radius-sm);font-size:13px;box-sizing:border-box;">
                </div>
                <div style="font-size:10.5px;color:var(--text-muted);">
                    <span id="sp-web-note">${webProvider === 'brave' ? 'Free tier is 2,000 searches a month.' : 'Free tier is 100 searches a day, and Google needs both values.'}</span>
                    <a href="#" id="sp-web-link" style="color:var(--accent);text-decoration:none;">Get a key →</a>
                </div>
            `;

            const reveal = (inputId: string, btnId: string) => {
                const inp = container.querySelector('#' + inputId) as HTMLInputElement;
                const btn = container.querySelector('#' + btnId) as HTMLButtonElement;
                btn.addEventListener('click', () => {
                    const hidden = inp.type === 'password';
                    inp.type = hidden ? 'text' : 'password';
                    btn.textContent = hidden ? 'Hide' : 'Show';
                });
            };
            reveal('sp-yt-key', 'sp-yt-toggle');
            reveal('sp-web-key', 'sp-web-toggle');

            container.querySelector('#sp-yt-link')!.addEventListener('click', (e) => {
                e.preventDefault();
                shell.openExternal('https://console.cloud.google.com/apis/library/youtube.googleapis.com');
            });
            container.querySelector('#sp-web-link')!.addEventListener('click', (e) => {
                e.preventDefault();
                shell.openExternal((userSettings.searchProvider || 'google') === 'brave'
                    ? 'https://brave.com/search/api/'
                    : 'https://programmablesearchengine.google.com/');
            });

            // Switching provider re-renders: the engine-id field and the quota
            // note only make sense for one of the two.
            container.querySelector('#sp-web-provider')!.addEventListener('change', (e) => {
                userSettings.searchProvider = (e.target as HTMLSelectElement).value as 'google' | 'brave';
                saveUserSettings();
                renderSettingsSection(container, 'learn');
            });
            break;
        }

        case 'accounts': {
            const me = authService.getUser();
            const meColor = me?.role === 'admin' ? '#e5c07b' : '#4ec9b0';
            container.innerHTML = `
                <h2 style="font-size:18px;font-weight:600;color:var(--text);margin:0 0 20px;">Account</h2>
                ${sectionTitle('Profile picture')}
                <div style="display:flex;align-items:center;gap:14px;margin-bottom:6px;">
                    <div id="sp-avatar-preview" style="flex:none;">${avatarHtml(me, 'auth-avatar-lg', meColor)}</div>
                    <div style="display:flex;flex-direction:column;gap:6px;">
                        <div style="display:flex;gap:6px;">
                            <button id="sp-avatar-pick" style="padding:6px 12px;background:var(--bg-input);border:1px solid var(--border);color:var(--text);border-radius:var(--radius-sm);cursor:pointer;font-size:12px;">Upload picture…</button>
                            <button id="sp-avatar-clear" style="padding:6px 12px;background:var(--bg-input);border:1px solid var(--border);color:var(--text-dim);border-radius:var(--radius-sm);cursor:pointer;font-size:12px;${s.avatarDataUrl ? '' : 'display:none;'}">Remove</button>
                        </div>
                        <div style="font-size:10.5px;color:var(--text-muted);">
                            ${s.avatarDataUrl ? 'Your uploaded picture. Stored on this PC.' : 'No picture — your initial is shown instead.'}
                        </div>
                    </div>
                </div>
                ${sectionTitle('Connected accounts')}
                <div style="display:flex;flex-direction:column;gap:10px;" id="sp-accounts"></div>
            `;
            renderAccountRows(container.querySelector('#sp-accounts')!);

            container.querySelector('#sp-avatar-pick')!.addEventListener('click', async () => {
                const data = await pickImageAsDataUrl(256);
                if (!data) return;
                userSettings.avatarDataUrl = data;
                saveUserSettings();
                refreshAvatars();
                renderSettingsSection(container, 'accounts');
            });
            container.querySelector('#sp-avatar-clear')!.addEventListener('click', () => {
                userSettings.avatarDataUrl = '';
                saveUserSettings();
                refreshAvatars();
                renderSettingsSection(container, 'accounts');
            });
            break;
        }

        case 'advanced':
            container.innerHTML = `
                <h2 style="font-size:18px;font-weight:600;color:var(--text);margin:0 0 20px;">Advanced</h2>
                ${sectionTitle('SDK')}
                <button id="sp-sdk-setup" style="padding:8px 16px;background:var(--bg-input);border:1px solid var(--border);color:var(--text);border-radius:var(--radius-sm);cursor:pointer;font-size:12px;width:100%;text-align:left;">🔧 SDK Setup...</button>
                ${sectionTitle('Tour')}
                <button id="sp-retake-tour" style="padding:8px 16px;background:var(--bg-input);border:1px solid var(--border);color:var(--text);border-radius:var(--radius-sm);cursor:pointer;font-size:12px;width:100%;text-align:left;">🎓 Retake UI Tour</button>
                ${sectionTitle('Reset')}
                <div style="display:flex;flex-direction:column;gap:8px;">
                    <button id="sp-reset-theme" style="padding:8px 16px;background:var(--bg-input);border:1px solid var(--border);color:var(--text);border-radius:var(--radius-sm);cursor:pointer;font-size:12px;text-align:left;">🎨 Reset Theme to Default</button>
                    <button id="sp-reset-learning" style="padding:8px 16px;background:var(--bg-input);border:1px solid #e5c07b;color:#e5c07b;border-radius:var(--radius-sm);cursor:pointer;font-size:12px;text-align:left;">📚 Reset Learning Progress</button>
                    <button id="sp-factory-reset" style="padding:8px 16px;background:var(--bg-input);border:1px solid #f14c4c;color:#f14c4c;border-radius:var(--radius-sm);cursor:pointer;font-size:12px;text-align:left;">⚠ Factory Reset Everything</button>
                </div>
            `;
            container.querySelector('#sp-sdk-setup')!.addEventListener('click', () => { closeSettingsPanel(); $('setup-overlay').classList.remove('hidden'); });
            container.querySelector('#sp-retake-tour')!.addEventListener('click', () => { closeSettingsPanel(); setTimeout(() => startTour(), 300); });
            container.querySelector('#sp-reset-theme')!.addEventListener('click', () => {
                userSettings = { ...DEFAULT_SETTINGS };
                saveUserSettings(); applyThemeColors(); applyFancyMode(); applyLayout(); applyCornerRadius(); clearCompactMode();
                if (editor) editor.updateOptions({ fontSize: userSettings.fontSize });
                $('status-zoom').textContent = '100%';
                renderSettingsSection(container, 'advanced');
                appendOutput('Theme reset to defaults.\n');
            });
            container.querySelector('#sp-reset-learning')!.addEventListener('click', () => {
                if (!confirm('Reset all learning progress?')) return;
                userProfile = { ...DEFAULT_PROFILE }; saveProfile(); renderLearnPanel(); renderTipsPanel();
                appendOutput('Learning progress reset.\n');
            });
            container.querySelector('#sp-factory-reset')!.addEventListener('click', () => {
                if (!confirm('Factory reset EVERYTHING?')) return;
                userSettings = { ...DEFAULT_SETTINGS }; saveUserSettings(); applyThemeColors(); applyFancyMode();
                if (editor) editor.updateOptions({ fontSize: 14 }); $('status-zoom').textContent = '100%';
                userProfile = { ...DEFAULT_PROFILE }; saveProfile(); renderLearnPanel(); renderTipsPanel();
                closeSettingsPanel();
                appendOutput('Factory reset complete.\n');
            });
            break;
    }
}

function renderAccountRows(container: HTMLElement) {
    const _discUser = getDiscordAuthUser();
    const ghConfigFile = nodePath.join(nodeOs.homedir(), '.nexia-ide-github.json');
    let ghData: any = null;
    try { if (nodeFs.existsSync(ghConfigFile)) ghData = JSON.parse(nodeFs.readFileSync(ghConfigFile, 'utf-8')); } catch {}

    const accountRow = (icon: string, name: string, status: string, statusColor: string, connected: boolean, btnId: string) => `
        <div style="display:flex;align-items:center;gap:12px;padding:12px 14px;background:var(--bg-input);border-radius:8px;">
            <div style="font-size:20px;flex-shrink:0;">${icon}</div>
            <div style="flex:1;">
                <div style="font-size:13px;font-weight:500;color:var(--text);">${name}</div>
                <div style="font-size:11px;color:${statusColor};">${status}</div>
            </div>
            <button id="${btnId}" style="padding:6px 14px;background:${connected ? 'transparent' : 'var(--accent)'};color:${connected ? 'var(--text-dim)' : '#1e1e1e'};border:1px solid ${connected ? 'var(--border)' : 'var(--accent)'};border-radius:6px;cursor:pointer;font-size:12px;font-weight:500;">${connected ? 'Disconnect' : 'Connect'}</button>
        </div>`;

    const discordIcon = `<svg viewBox="0 0 24 24" width="22" height="22" fill="#5865F2"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.125-.093.25-.19.372-.292a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419s.956-2.419 2.157-2.419c1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419s.956-2.419 2.157-2.419c1.21 0 2.176 1.095 2.157 2.42 0 1.333-.947 2.418-2.157 2.418z"/></svg>`;
    const githubIcon = `<svg viewBox="0 0 16 16" width="22" height="22" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;

    container.innerHTML =
        accountRow(discordIcon, 'Discord', _discUser ? _discUser.username : 'Not connected', _discUser ? '#5865F2' : 'var(--text-dim)', !!_discUser, 'sp-discord-btn') +
        accountRow(githubIcon, 'GitHub', ghData?.username || 'Not connected', ghData?.token ? '#4ade80' : 'var(--text-dim)', !!ghData?.token, 'sp-github-btn');

    // Wire Discord
    document.getElementById('sp-discord-btn')!.addEventListener('click', async () => {
        if (_discUser) {
            await ipcRenderer.invoke(IPC.DISCORD_AUTH_LOGOUT);
            setDiscordAuthUser(null);
            saveUserSettings();
            renderAccountRows(container);
        } else {
            const btn = document.getElementById('sp-discord-btn') as HTMLButtonElement;
            btn.textContent = 'Connecting...'; btn.disabled = true;
            const result = await ipcRenderer.invoke(IPC.DISCORD_AUTH_START);
            if (result.success) {
                const authResult = await ipcRenderer.invoke(IPC.DISCORD_AUTH_USER);
                if (authResult.loggedIn) setDiscordAuthUser({ id: authResult.id, username: authResult.username, avatarUrl: authResult.avatarUrl });
                saveUserSettings();
            }
            renderAccountRows(container);
        }
    });

    // Wire GitHub
    document.getElementById('sp-github-btn')!.addEventListener('click', () => {
        if (ghData?.token) {
            try { nodeFs.unlinkSync(ghConfigFile); } catch {}
            saveUserSettings(); renderGitPanel();
            renderAccountRows(container);
        } else {
            closeSettingsPanel();
            const gitTab = document.querySelector('.sidebar-tab[data-panel="git"]') as HTMLElement;
            if (gitTab) gitTab.click();
        }
    });
}

// ══════════════════════════════════════
//  ONBOARDING WIZARD
// ══════════════════════════════════════
function showOnboarding() {
    $('onboarding-overlay').classList.remove('hidden');
    setOnboardingStep(1);
}

function setOnboardingStep(step: number) {
    document.querySelectorAll('.ob-step').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.ob-dot').forEach(d => d.classList.remove('active'));
    const stepEl = document.querySelector(`.ob-step[data-step="${step}"]`);
    const dotEl = document.querySelector(`.ob-dot[data-dot="${step}"]`);
    if (stepEl) stepEl.classList.add('active');
    if (dotEl) dotEl.classList.add('active');
}

function finishOnboarding() {
    userProfile.onboardingComplete = true;
    saveProfile();
    $('onboarding-overlay').classList.add('hidden');
    renderLearnPanel();
}

// Wire onboarding buttons
$('ob-next-1').addEventListener('click', () => {
    // If already signed in from stored token, skip the auth step
    if (authService.isLoggedIn()) {
        setOnboardingStep(3);
    } else {
        setOnboardingStep(2);
    }
});

// Step 2: Account sign in / register / skip
$('ob-signin').addEventListener('click', () => {
    authUI.showLogin();
    // Listen for successful auth to update the onboarding UI
    const unsub = authService.onAuthStateChange((user: any) => {
        if (user) {
            updateOnboardingAuthStatus(user);
            unsub();
        }
    });
});
$('ob-register').addEventListener('click', () => {
    authUI.showRegister();
    const unsub = authService.onAuthStateChange((user: any) => {
        if (user) {
            updateOnboardingAuthStatus(user);
            unsub();
        }
    });
});
$('ob-skip-auth').addEventListener('click', () => setOnboardingStep(3));

$('ob-next-4').addEventListener('click', () => { finishOnboarding(); setTimeout(() => startTour(), 400); });
$('ob-skip').addEventListener('click', () => finishOnboarding());

function updateOnboardingAuthStatus(user: any) {
    const statusEl = document.getElementById('ob-auth-status');
    const buttonsEl = document.getElementById('ob-auth-buttons');
    const skipEl = document.getElementById('ob-skip-auth');
    if (statusEl && user) {
        statusEl.style.display = 'block';
        const color = user.role === 'admin' ? '#e5c07b' : '#4ec9b0';
        const ob = document.getElementById('ob-auth-avatar')!;
        ob.style.background = color;
        // innerHTML, not textContent: this one may now hold an <img>.
        const obSrc = userAvatarSrc(user);
        if (obSrc) {
            ob.style.overflow = 'hidden';
            ob.innerHTML = `<img src="${escapeHtml(obSrc)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block">`;
        } else {
            ob.style.overflow = '';
            ob.textContent = userInitial(user);
        }
        document.getElementById('ob-auth-name')!.textContent = user.username;
        document.getElementById('ob-auth-role')!.textContent = user.role.toUpperCase();
        document.getElementById('ob-auth-role')!.style.color = color;
    }
    if (buttonsEl) buttonsEl.style.display = 'none';
    if (skipEl) {
        skipEl.textContent = 'Continue →';
        skipEl.className = 'ob-btn-primary';
    }
}

// Skill level selection
document.querySelectorAll('.ob-skill-card').forEach(card => {
    card.addEventListener('click', () => {
        document.querySelectorAll('.ob-skill-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        userProfile.skillLevel = (card as HTMLElement).dataset.level as any;
        userProfile.tipsEnabled = userProfile.skillLevel !== 'expert';
        saveProfile();
        // Auto-advance after a short delay
        setTimeout(() => setOnboardingStep(4), 400);
    });
});

// ══════════════════════════════════════
//  GUIDED UI TOUR
// ══════════════════════════════════════
interface TourStep {
    target: string;        // CSS selector for the element to spotlight
    icon: string;
    title: string;
    body: string;
    position: 'bottom' | 'top' | 'right' | 'left';  // where card appears relative to target
    setup?: () => void;    // optional: run before showing this step
}

const TOUR_STEPS: TourStep[] = [
    {
        target: '#titlebar',
        icon: '🪟', title: 'Title Bar & Account',
        body: 'The title bar shows your project name. On the right, click your avatar to access Settings and sign out. Your Nexia account syncs settings, AI config, and linked accounts across devices.',
        position: 'bottom',
    },
    {
        target: '#menubar',
        icon: '📋', title: 'Menu Bar',
        body: 'Access all IDE features from the menus. File for projects, Edit for find/replace, Build for compiling, and View for toggling panels. Most actions have keyboard shortcuts shown next to them.',
        position: 'bottom',
    },
    {
        target: '#toolbar',
        icon: '🔧', title: 'Build Toolbar',
        body: 'One-click Build (F7), Rebuild, Clean, and Deploy to Devkit. The dropdown selects Debug, Release, or Profile configuration. Build output appears in the Output panel below.',
        position: 'bottom',
    },
    {
        target: '#sidebar',
        icon: '📁', title: 'Explorer & File Tree',
        body: 'Your project\'s file tree with Header Files and Source Files grouped automatically. Right-click for Rename, Delete, and New File. Drag files to reorganize. Use the toolbar buttons to create files, refresh, collapse all, or close the project.',
        position: 'right',
        setup: () => {
            const expTab = document.querySelector('[data-panel="explorer"]') as HTMLElement;
            if (expTab) expTab.click();
        },
    },
    {
        target: '[data-panel="search"]',
        icon: '🔍', title: 'Find in Files',
        body: 'Search across your entire project with regex support. Click any result to jump straight to that line. Great for tracking down function definitions, usages, or TODOs.',
        position: 'right',
    },
    {
        target: '[data-panel="ai"]',
        icon: '🤖', title: 'Nexia AI Assistant',
        body: 'Your AI-powered coding companion. Chat mode for questions, Generate mode for code creation, and Errors mode for automatic build error analysis. Supports Anthropic, OpenAI, and local models. Configure your API key in Settings.',
        position: 'right',
        setup: () => {
            const aiTab = document.querySelector('[data-panel="ai"]') as HTMLElement;
            if (aiTab) aiTab.click();
        },
    },
    {
        target: '[data-panel="extensions"]',
        icon: '🏪', title: 'Marketplace',
        body: 'The Nexia Marketplace will let you browse and install extensions, themes, and lesson packages. This feature is coming soon — stay tuned for community-created content!',
        position: 'right',
    },
    {
        target: '[data-panel="git"]',
        icon: '🔀', title: 'Source Control & GitHub',
        body: 'Manage Git repositories and connect your GitHub account to push/pull code, browse repos, and manage files — all from within the IDE. Sign in to your Nexia account first to enable GitHub integration.',
        position: 'right',
    },
    {
        target: '[data-panel="devkit"]',
        icon: '📡', title: 'Dev Kit Manager',
        body: 'Connect to your Xbox 360 development kit by entering its IP address. Once connected, you can deploy builds, browse the console\'s file system, capture screenshots, view system info, and reboot — all remotely.',
        position: 'right',
    },
    {
        target: '[data-panel="emulator"]',
        icon: '🎮', title: 'Nexia 360 Emulator',
        body: 'Launch and debug your XEX files in the Nexia 360 emulator. Set breakpoints, step through code, and inspect memory. Note: Emulation requires Windows 10 or later.',
        position: 'right',
    },
    {
        target: '[data-panel="learn"]',
        icon: '🎓', title: 'Learn',
        body: 'Three ways to learn, in one place. Learn is a guided curriculum through Xbox 360 development — Direct3D through to full games — tracking your progress as you go. Videos searches YouTube for tutorials, and Web searches the internet, both without leaving the IDE.',
        position: 'right',
        setup: () => {
            const learnTab = document.querySelector('[data-panel="learn"]') as HTMLElement;
            if (learnTab) learnTab.click();
        },
    },
    {
        target: '[data-panel="community"]',
        icon: '💬', title: 'Discord Community',
        body: 'Connect your Discord account to browse forum posts, read discussions, and post new threads — all without leaving the IDE. Sign in to your Nexia account first, then link Discord in Settings.',
        position: 'right',
    },
    {
        target: '#editor-area',
        icon: '📝', title: 'Code Editor',
        body: 'A full-featured Monaco editor with syntax highlighting, IntelliSense, bracket matching, and Xbox 360 API completions. Open multiple files as tabs, right-click tabs for options. AI hint bar appears when you select code.',
        position: 'left',
    },
    {
        target: '#bottom-panel',
        icon: '📊', title: 'Output & Problems',
        body: 'Build output streams here in real-time with MSBuild-style formatting. The Problems tab shows clickable errors and warnings — click one to jump to the line. The Tips tab has Xbox 360 development knowledge.',
        position: 'top',
        setup: () => {
            if (!bottomPanelVisible) toggleBottomPanel();
        },
    },
    {
        target: '#statusbar',
        icon: '📶', title: 'Status Bar',
        body: 'Shows build status, SDK detection, server connection, cursor position, zoom level, encoding, and language mode. A green dot means you\'re connected to the Nexia server.',
        position: 'top',
    },
    {
        target: '#welcome-content',
        icon: '🚀', title: 'Ready to Build!',
        body: 'Click "New Project" to create an Xbox 360 project (Executable, DLL, or Static Library), or "Open Project" to load an existing one. Open Settings from your avatar menu to configure AI, themes, and linked accounts. Happy coding!',
        position: 'top',
    },
];

let tourStep = 0;
let tourActive = false;

function startTour() {
    tourStep = 0;
    tourActive = true;
    $('tour-overlay').classList.remove('hidden');
    showTourStep();
}

function endTour() {
    tourActive = false;
    $('tour-overlay').classList.add('hidden');
    // Show first tip after tour ends
    setTimeout(() => triggerTip('first-launch'), 1500);
}

function showTourStep() {
    const step = TOUR_STEPS[tourStep];
    if (!step) { endTour(); return; }

    // Run setup if present
    if (step.setup) step.setup();

    // Update card content
    $('tour-step-badge').textContent = `${tourStep + 1} / ${TOUR_STEPS.length}`;
    $('tour-icon').innerHTML = icons.replaceEmojis(step.icon);
    $('tour-title').textContent = step.title;
    $('tour-body').textContent = step.body;

    // Update button states
    ($('tour-prev') as HTMLButtonElement).disabled = tourStep === 0;
    $('tour-next').textContent = tourStep === TOUR_STEPS.length - 1 ? 'Finish ✓' : 'Next →';

    // Position spotlight on target
    const target = document.querySelector(step.target) as HTMLElement;
    const spotlight = $('tour-spotlight');
    const card = $('tour-card');

    if (target) {
        const rect = target.getBoundingClientRect();
        const pad = 6;
        spotlight.style.left = (rect.left - pad) + 'px';
        spotlight.style.top = (rect.top - pad) + 'px';
        spotlight.style.width = (rect.width + pad * 2) + 'px';
        spotlight.style.height = (rect.height + pad * 2) + 'px';
        spotlight.style.display = 'block';

        // Position card relative to target
        positionTourCard(card, rect, step.position);
    } else {
        // Fallback: center the card
        spotlight.style.display = 'none';
        card.style.left = '50%';
        card.style.top = '50%';
        card.style.transform = 'translate(-50%, -50%)';
    }

    // Reset animation
    card.style.animation = 'none';
    card.offsetHeight; // force reflow
    card.style.animation = 'tour-card-appear 0.3s ease';
}

function positionTourCard(card: HTMLElement, targetRect: DOMRect, pos: string) {
    const gap = 16;
    const cardW = 340;
    const cardH = 200; // approximate
    card.style.transform = 'none';

    switch (pos) {
        case 'bottom':
            card.style.left = Math.max(8, Math.min(targetRect.left, window.innerWidth - cardW - 8)) + 'px';
            card.style.top = (targetRect.bottom + gap) + 'px';
            break;
        case 'top':
            card.style.left = Math.max(8, Math.min(targetRect.left, window.innerWidth - cardW - 8)) + 'px';
            card.style.top = Math.max(8, targetRect.top - cardH - gap) + 'px';
            break;
        case 'right':
            card.style.left = (targetRect.right + gap) + 'px';
            card.style.top = Math.max(8, targetRect.top) + 'px';
            break;
        case 'left':
            card.style.left = Math.max(8, targetRect.left - cardW - gap) + 'px';
            card.style.top = Math.max(8, targetRect.top) + 'px';
            break;
    }

    // Clamp to viewport
    const cardRect = card.getBoundingClientRect();
    if (cardRect.bottom > window.innerHeight - 8) {
        card.style.top = Math.max(8, window.innerHeight - cardH - 8) + 'px';
    }
    if (cardRect.right > window.innerWidth - 8) {
        card.style.left = Math.max(8, window.innerWidth - cardW - 8) + 'px';
    }
}

// Tour button handlers
$('tour-next').addEventListener('click', () => {
    if (tourStep >= TOUR_STEPS.length - 1) { endTour(); return; }
    tourStep++;
    showTourStep();
});
$('tour-prev').addEventListener('click', () => {
    if (tourStep > 0) { tourStep--; showTourStep(); }
});
$('tour-skip').addEventListener('click', () => endTour());

// Reposition on resize
window.addEventListener('resize', () => { if (tourActive) showTourStep(); });

// ══════════════════════════════════════
//  TIPS SYSTEM
// ══════════════════════════════════════
function triggerTip(trigger: string, match?: string) {
    if (!userProfile.tipsEnabled || tipCooldown) return;
    const tip = learning.getRandomTip(userProfile, trigger, match);
    if (!tip) return;
    showInlineTip(tip);
}

function showInlineTip(tip: any) {
    currentInlineTip = tip;
    $('tip-icon').textContent = tip.icon;
    $('tip-text').textContent = `${tip.title}: ${tip.body}`;
    $('inline-tip').classList.remove('hidden');
    // Position it above the editor
    const editorArea = $('editor-area');
    if (editorArea) {
        $('inline-tip').style.position = 'absolute';
        editorArea.style.position = 'relative';
        editorArea.appendChild($('inline-tip'));
    }
    // Set cooldown to avoid tip spam
    tipCooldown = true;
    setTimeout(() => { tipCooldown = false; }, 30000); // 30s between tips
    // Auto-hide after 15s
    setTimeout(() => { $('inline-tip').classList.add('hidden'); }, 15000);
}

$('tip-dismiss').addEventListener('click', () => {
    $('inline-tip').classList.add('hidden');
    if (currentInlineTip) {
        userProfile.dismissedTips.push(currentInlineTip.id);
        saveProfile();
    }
});

$('tip-more').addEventListener('click', () => {
    $('inline-tip').classList.add('hidden');
    showBottomPanel();
    // Switch to tips tab
    const tipBtn = document.querySelector('[data-panel="tips"]') as HTMLElement;
    if (tipBtn) tipBtn.click();
});

// ══════════════════════════════════════
//  CINEMATIC TUTOR (opens in editor area)
// ══════════════════════════════════════
async function openCinematicTutor(lessonId?: string) {
    const id = lessonId;
    if (!id) { appendOutput('No lesson ID provided.\n'); return; }
    const tabPath = '__cinematic__:' + id;
    const existing = openTabs.find(t => t.path === tabPath);
    if (existing) {
        switchToTab(tabPath);
        return;
    }

    // Create container in editor area if needed
    if (!cinematicContainer) {
        cinematicContainer = document.createElement('div');
        cinematicContainer.id = 'cinematic-container';
        cinematicContainer.style.cssText = 'display:none; flex:1; flex-direction:column; overflow:hidden; background:var(--bg-dark);';
        $('editor-area').appendChild(cinematicContainer);
    }

    // All lessons loaded from .lesson packages via IPC
    let tabName = '\u{1F3AC} ' + id;
    try {
        const lessonData = await ipcRenderer.invoke(IPC.LESSON_READ, id);
        if (!lessonData) {
            appendOutput('Failed to load lesson: ' + id + ' — not found\n');
            return;
        }
        cinematicEngine.loadLesson(lessonData);
        tabName = '\u{1F3AC} ' + (lessonData.meta?.title || id);
    } catch (err: any) {
        appendOutput('Failed to load lesson: ' + (err.message || err) + '\n');
        return;
    }

    // Mount the cinematic engine into the container
    cinematicEngine.mount(cinematicContainer);

    // Create a dummy model for the tab system
    const monaco = (window as any).monaco;
    const model = monaco?.editor?.createModel?.('', 'plaintext') || { dispose: () => {}, getValue: () => '' };

    openTabs.push({ path: tabPath, name: tabName, model, modified: false });
    switchToTab(tabPath);
}
//  VISUALIZER PANEL (bottom panel)
// ══════════════════════════════════════
function initVisualizerPanel() {
    const vizCanvas = $('visualizer-canvas') as HTMLCanvasElement;
    if (vizCanvas) {
        codeVisualizer.attach(vizCanvas);
    }

    $('viz-run')?.addEventListener('click', () => {
        const cmd = ($('viz-command') as HTMLInputElement)?.value || '';
        const type = ($('viz-type') as HTMLSelectElement)?.value || 'variables';

        if (type === 'pointer') {
            // Parse "ptr -> target" or just use defaults
            const parts = cmd.split(/\s*->\s*/);
            codeVisualizer.visualizePointer(parts[0] || 'ptr', parts[1] || 'value');
        } else if (type === 'array') {
            // Parse "name: 1,2,3,4,5" or just comma-separated values
            const colonPos = cmd.indexOf(':');
            if (colonPos !== -1) {
                const name = cmd.substring(0, colonPos).trim();
                const vals = cmd.substring(colonPos + 1).split(',').map(v => v.trim());
                codeVisualizer.visualizeArray(name, vals);
            } else {
                const vals = cmd.split(',').map(v => v.trim());
                codeVisualizer.visualizeArray('arr', vals);
            }
        } else {
            // Default: parse as C++ variable declarations
            codeVisualizer.visualizeCode(cmd.replace(/;/g, ';\n'));
        }
        codeVisualizer.render();
    });

    $('viz-clear')?.addEventListener('click', () => {
        codeVisualizer.clear();
        codeVisualizer.render();
    });

    // Re-render on resize
    window.addEventListener('resize', () => {
        if (vizCanvas) {
            codeVisualizer.resizeCanvas();
            codeVisualizer.render();
        }
    });
}

function renderTipsPanel() {
    const list = $('tips-list');
    if (!list) return;
    list.innerHTML = '';
    const categories = ['ide', 'xbox360', 'cpp', 'd3d', 'build'];
    for (const cat of categories) {
        const tips = learning.getCategoryTips(userProfile, cat);
        for (const tip of tips) {
            const card = document.createElement('div');
            card.className = 'tip-card';
            card.innerHTML = `
                <span class="tip-card-icon">${tip.icon}</span>
                <div class="tip-card-body">
                    <div class="tip-card-title">${tip.title}</div>
                    <div class="tip-card-text">${tip.body}</div>
                    <span class="tip-card-cat cat-${tip.category}">${tip.category}</span>
                </div>`;
            list.appendChild(card);
        }
    }
    if (list.children.length === 0) {
        list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-dim)">No tips to show. You have dismissed them all — nice work! 🎉</div>';
    }
}

// ══════════════════════════════════════
//  ACHIEVEMENTS
// ══════════════════════════════════════
function checkAchievements(context?: any) {
    const { ACHIEVEMENTS } = learning;
    for (const ach of ACHIEVEMENTS) {
        if (userProfile.completedAchievements.includes(ach.id)) continue;
        if (ach.check(userProfile, context)) {
            unlockAchievement(ach);
        }
    }
}

function unlockAchievement(ach: any) {
    if (userProfile.completedAchievements.includes(ach.id)) return;
    userProfile.completedAchievements.push(ach.id);
    saveProfile();
    showAchievementToast(ach);
    renderLearnPanel();
}

function showAchievementToast(ach: any) {
    $('ach-icon').textContent = ach.icon;
    $('ach-name').textContent = ach.name;
    $('ach-desc').textContent = ach.description;
    const toast = $('achievement-toast');
    toast.classList.remove('hidden');
    // Auto-hide after 5s
    setTimeout(() => { toast.classList.add('hidden'); }, 5000);
}

// Manually trigger specific achievements
function triggerAchievement(id: string) {
    const ach = learning.ACHIEVEMENTS.find((a: any) => a.id === id);
    if (ach && !userProfile.completedAchievements.includes(id)) {
        unlockAchievement(ach);
    }
}

// ══════════════════════════════════════
//  LEARN PANEL (sidebar)
// ══════════════════════════════════════
/** Compare dotted version strings. Returns >0 if a is newer, <0 if older, 0 if equal. */
/**
 * Version as shown to a person: 3.1.0 -> "3.1".
 *
 * Nexia versions as major.minor, but package.json must hold semver — npm and
 * electron-builder both reject a two-part version — so the third part exists
 * only to satisfy them and is noise everywhere a human reads it.
 *
 * A non-zero patch is left alone: if 3.1.2 ever ships, hiding the .2 would make
 * two different builds look identical.
 */
function displayVersion(v: string | undefined | null): string {
    const s = String(v ?? '').trim();
    const m = /^(\d+)\.(\d+)\.0$/.exec(s);
    return m ? `${m[1]}.${m[2]}` : s;
}

function cmpVersions(a: string, b: string): number {
    const pa = String(a || '0').split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b || '0').split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d !== 0) return d;
    }
    return 0;
}

/** Download (or update) a cloud lesson into the local registry, then refresh the Learn panel. */
async function downloadCloudLesson(cloudId: string, btn?: HTMLButtonElement) {
    if (btn) { btn.disabled = true; btn.textContent = 'Downloading…'; }
    try {
        const full = await authService.getCloudLesson(cloudId);
        if (!full.success || !full.lesson) { throw new Error(full.error || 'Fetch failed'); }
        // Install under the cloud id so update-detection lines up with the catalog.
        const res = await ipcRenderer.invoke('lesson:save', cloudId, full.lesson);
        if (!res || res.success === false) throw new Error(res?.error || 'Install failed');
        appendOutput('Installed cloud lesson: ' + (full.lesson.meta?.title || cloudId) + '\n');
        renderLearnPanel();
    } catch (err: any) {
        appendOutput('Cloud lesson download failed: ' + (err.message || err) + '\n');
        if (btn) { btn.disabled = false; btn.textContent = 'Download'; }
    }
}

/** Count cloud lessons that have a newer version than what's installed locally. */
async function countLessonUpdates(): Promise<number> {
    try {
        const cloudRes = await authService.getCloudLessons();
        if (!cloudRes.success || !cloudRes.lessons?.length) return 0;
        const installed: any[] = (await ipcRenderer.invoke(IPC.LESSON_LIST)) || [];
        const byId = new Map(installed.map((l: any) => [l.id, l]));
        let n = 0;
        for (const cl of cloudRes.lessons) {
            const local = byId.get(cl.id);
            if (local && cmpVersions(cl.version, local.version) > 0) n++;
        }
        return n;
    } catch { return 0; }
}

/** Render a single lesson content item (text/code/exercise/quiz/visualization) into an element. */
function renderLessonContentItem(item: any, lesson: any): HTMLElement {
    const wrap = document.createElement('div');
    const type = item.type;

    if (type === 'code') {
        const pre = document.createElement('pre');
        pre.style.cssText = 'margin:0;padding:14px;background:var(--bg-dark,#0d0d12);border:1px solid var(--border,#2a2a35);border-radius:8px;overflow-x:auto;font-family:"Cascadia Code",Consolas,monospace;font-size:12.5px;line-height:1.55;color:var(--text,#d4d4dc);white-space:pre';
        pre.textContent = item.content || '';
        wrap.appendChild(pre);
    } else if (type === 'exercise') {
        const prompt = document.createElement('div');
        prompt.style.cssText = 'padding:12px 14px;border-left:3px solid #e5c07b;background:rgba(229,192,123,0.06);border-radius:4px;font-size:13px;line-height:1.6;white-space:pre-wrap;color:var(--text,#d4d4dc)';
        prompt.textContent = item.content || '';
        wrap.appendChild(prompt);
        if (item.hint) {
            const hint = document.createElement('details');
            hint.style.cssText = 'margin-top:10px;font-size:12px;color:var(--text-dim,#9a9aa5)';
            hint.innerHTML = `<summary style="cursor:pointer;color:#e5c07b">💡 Hint</summary><div style="padding:8px 0 0 4px;white-space:pre-wrap">${escapeHtml(item.hint)}</div>`;
            wrap.appendChild(hint);
        }
        if (item.solution) {
            const sol = document.createElement('details');
            sol.style.cssText = 'margin-top:6px;font-size:12px';
            sol.innerHTML = `<summary style="cursor:pointer;color:#4ec9b0">✓ Solution</summary><pre style="margin:8px 0 0;padding:10px;background:var(--bg-dark,#0d0d12);border-radius:6px;overflow-x:auto;font-family:monospace;font-size:12px;white-space:pre;color:var(--text,#d4d4dc)">${escapeHtml(item.solution)}</pre>`;
            wrap.appendChild(sol);
        }
    } else if (type === 'quiz' && Array.isArray(item.options) && item.options.length) {
        const q = document.createElement('div');
        q.style.cssText = 'font-size:14px;line-height:1.6;margin-bottom:12px;color:var(--text,#d4d4dc);white-space:pre-wrap';
        q.textContent = item.content || item.title || '';
        wrap.appendChild(q);
        let answered = false;
        item.options.forEach((opt: string, i: number) => {
            const btn = document.createElement('button');
            btn.style.cssText = 'display:block;width:100%;text-align:left;margin:6px 0;padding:10px 12px;background:var(--bg-input,#22222c);border:1px solid var(--border,#2a2a35);border-radius:6px;color:var(--text,#d4d4dc);font-size:12.5px;cursor:pointer';
            btn.textContent = opt;
            btn.addEventListener('click', () => {
                if (answered) return;
                answered = true;
                const correct = i === item.correctOption;
                btn.style.borderColor = correct ? '#4ec9b0' : '#e06c75';
                btn.style.background = correct ? 'rgba(78,201,176,0.12)' : 'rgba(224,108,117,0.12)';
                if (!correct) {
                    const right = wrap.querySelectorAll('button')[item.correctOption] as HTMLElement;
                    if (right) { right.style.borderColor = '#4ec9b0'; right.style.background = 'rgba(78,201,176,0.12)'; }
                }
                try { learningProfile.recordInteraction(lesson.concepts?.[0] || 'quiz', 'quiz', correct, 0); scheduleProgressSync(); } catch {}
            });
            wrap.appendChild(btn);
        });
    } else if (type === 'visualization') {
        const v = document.createElement('div');
        v.style.cssText = 'padding:12px 14px;border:1px dashed var(--border,#2a2a35);border-radius:8px;font-size:12px;color:var(--text-dim,#9a9aa5)';
        v.innerHTML = `<div style="color:#56d4f5;font-weight:600;margin-bottom:6px">📊 ${escapeHtml(item.title || 'Visualization')}</div><code style="font-family:monospace;font-size:11px">${escapeHtml(item.content || '')}</code>`;
        wrap.appendChild(v);
    } else {
        // text (default): split into paragraphs
        const body = document.createElement('div');
        body.style.cssText = 'font-size:13.5px;line-height:1.7;color:var(--text,#d4d4dc)';
        for (const para of String(item.content || '').split('\n\n')) {
            const p = document.createElement('p');
            p.style.cssText = 'margin:0 0 12px;white-space:pre-wrap';
            p.textContent = para;
            body.appendChild(p);
        }
        wrap.appendChild(body);
    }
    return wrap;
}

/** Open the curriculum lesson viewer overlay for a given lesson, wiring progress tracking. */
function openLessonViewer(moduleId: string, lessonId: string) {
    const lesson = lessonSystem.getLesson(moduleId, lessonId);
    if (!lesson || !lesson.content?.length) return;
    lessonSystem.goToLesson(moduleId, lessonId);

    // Mark started immediately.
    try { learningProfile.recordLessonProgress(lesson.id, 0, lesson.content.length, false); } catch {}

    let idx = 0;
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.62);z-index:99999;display:flex;align-items:center;justify-content:center';
    const modal = document.createElement('div');
    modal.style.cssText = 'width:min(760px,92vw);max-height:88vh;display:flex;flex-direction:column;background:var(--bg-panel,#17171e);border:1px solid var(--border,#2a2a35);border-radius:12px;overflow:hidden;box-shadow:0 24px 80px rgba(0,0,0,0.6)';
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    function close() {
        try { learningProfile.save(); } catch {}
        scheduleProgressSync();
        overlay.remove();
        document.removeEventListener('keydown', onKey);
        renderLearnPanel();
    }
    function onKey(e: KeyboardEvent) {
        if (e.key === 'Escape') close();
        else if (e.key === 'ArrowRight') next();
        else if (e.key === 'ArrowLeft') prev();
    }
    function prev() { if (idx > 0) { idx--; render(); } }
    function next() {
        const total = lesson.content.length;
        if (idx < total - 1) { idx++; render(); }
        else {
            try {
                learningProfile.recordLessonProgress(lesson.id, total, total, true);
                for (const c of (lesson.concepts || [])) learningProfile.recordInteraction(c, 'lesson', true, 0);
                learningProfile.save();
            } catch {}
            scheduleProgressSync();
            appendOutput(`✓ Completed lesson: ${lesson.title}\n`);
            try { checkAchievements(); } catch {}
            close();
        }
    }

    function render() {
        const total = lesson.content.length;
        const item = lesson.content[idx];
        const isLast = idx >= total - 1;
        try { learningProfile.recordLessonProgress(lesson.id, idx + 1, total, false); } catch {}

        modal.innerHTML = '';
        const header = document.createElement('div');
        header.style.cssText = 'display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--border,#2a2a35)';
        header.innerHTML = `<div style="flex:1;min-width:0"><div style="font-size:14px;font-weight:600;color:var(--text,#d4d4dc)">${escapeHtml(lesson.title)}</div><div style="font-size:11px;color:var(--text-muted,#7a7a85)">${escapeHtml(item.title || '')} · Step ${idx + 1} of ${total}</div></div><button id="lv-close" style="background:none;border:none;color:var(--text-muted,#7a7a85);font-size:18px;cursor:pointer;line-height:1">✕</button>`;
        modal.appendChild(header);

        const pbar = document.createElement('div');
        pbar.style.cssText = 'height:3px;background:var(--border,#2a2a35)';
        pbar.innerHTML = `<div style="height:100%;width:${Math.round(((idx + 1) / total) * 100)}%;background:#4ec9b0;transition:width .2s"></div>`;
        modal.appendChild(pbar);

        const body = document.createElement('div');
        body.style.cssText = 'padding:20px 18px;overflow-y:auto;flex:1';
        body.appendChild(renderLessonContentItem(item, lesson));
        modal.appendChild(body);

        const footer = document.createElement('div');
        footer.style.cssText = 'display:flex;gap:8px;align-items:center;padding:14px 18px;border-top:1px solid var(--border,#2a2a35)';
        footer.innerHTML = `<button id="lv-prev" class="learn-action-btn" ${idx === 0 ? 'disabled' : ''}>← Previous</button><div style="flex:1"></div><button id="lv-next" class="learn-action-btn learn-action-primary">${isLast ? '✓ Complete Lesson' : 'Next →'}</button>`;
        modal.appendChild(footer);

        header.querySelector('#lv-close')!.addEventListener('click', close);
        footer.querySelector('#lv-prev')!.addEventListener('click', prev);
        footer.querySelector('#lv-next')!.addEventListener('click', next);
    }

    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey);
    render();
}

type LearnTab = 'learn' | 'videos' | 'web';
let learnTab: LearnTab = 'learn';

const LEARN_TABS: { id: LearnTab; label: string; icon: string }[] = [
    { id: 'learn', label: 'Learn', icon: '🎓' },
    { id: 'videos', label: 'Videos', icon: '▶' },
    { id: 'web', label: 'Web', icon: '🌐' },
];

/**
 * The Learn panel: one place to learn, split three ways.
 *
 * These used to be a single scroll with the old Study panel beside it, and the
 * two overlapped enough that neither was the obvious place to look. Now the
 * curriculum, the videos, and the web each get a tab, and progress is recorded
 * against the learning profile from wherever it happens rather than from a
 * separate panel of quizzes.
 */
async function renderLearnPanel() {
    const root = $('learn-panel');
    if (!root) return;
    root.innerHTML = '';

    const strip = document.createElement('div');
    strip.style.cssText = 'display:flex;gap:2px;padding:2px;margin-bottom:6px;background:var(--bg-dark);border-radius:6px';
    for (const t of LEARN_TABS) {
        const b = document.createElement('button');
        const on = learnTab === t.id;
        b.style.cssText = `flex:1;padding:5px 4px;border:none;border-radius:4px;cursor:pointer;font-size:10.5px;
            font-weight:${on ? '600' : '500'};background:${on ? 'var(--bg-panel)' : 'transparent'};
            color:${on ? 'var(--text)' : 'var(--text-muted)'}`;
        b.textContent = `${t.icon} ${t.label}`;
        b.addEventListener('click', () => { learnTab = t.id; renderLearnPanel(); });
        strip.appendChild(b);
    }
    root.appendChild(strip);

    const body = document.createElement('div');
    root.appendChild(body);

    if (learnTab === 'videos') { renderVideosSection(body); return; }
    if (learnTab === 'web') { renderWebSection(body); return; }
    await renderLearnHome(body);
}

async function renderLearnHome(panel: HTMLElement) {
    // ── Progress Summary ──
    const totalAch = learning.ACHIEVEMENTS.length;
    const earnedAch = userProfile.completedAchievements.length;
    const pct = totalAch > 0 ? Math.round((earnedAch / totalAch) * 100) : 0;

    const progress = document.createElement('div');
    progress.className = 'learn-progress';
    progress.innerHTML = `
        <div class="learn-section-title">PROGRESS \u2014 ${earnedAch}/${totalAch} Achievements (${pct}%)</div>
        <div class="learn-progress-bar"><div class="learn-progress-fill" style="width:${pct}%"></div></div>`;
    panel.appendChild(progress);

    // ── Cinematic Lessons ──
    const lessonsSection = document.createElement('div');
    lessonsSection.className = 'learn-section';
    lessonsSection.innerHTML = '<div class="learn-section-title">CINEMATIC LESSONS</div>';

    // All lessons loaded from imported .lesson packages
    let importedLessons: any[] = [];
    try { importedLessons = await ipcRenderer.invoke(IPC.LESSON_LIST) || []; } catch {}

    // Lesson card grid
    const grid = document.createElement('div');
    grid.className = 'lesson-grid';

    if (importedLessons.length > 0) {
        for (const lesson of importedLessons) {
            grid.appendChild(createLessonCard({
                id: lesson.id, title: lesson.title,
                desc: lesson.description || 'by ' + (lesson.author || 'Unknown'),
                difficulty: lesson.difficulty || 'Beginner', available: true, 
                longDesc: lesson.description || '', duration: '', topics: lesson.tags || [],
            }));
        }
    } else {
        const emptyMsg = document.createElement('div');
        emptyMsg.style.cssText = 'padding:12px 4px;font-size:11px;color:var(--text-muted);text-align:center';
        emptyMsg.textContent = 'No lessons installed. Import a .lesson package to get started.';
        grid.appendChild(emptyMsg);
    }

    lessonsSection.appendChild(grid);
    panel.appendChild(lessonsSection);

    // ── Cloud Lessons (public catalog: download + update) ──
    try {
        const cloudRes = await authService.getCloudLessons();
        const cloudLessons = (cloudRes.success && cloudRes.lessons) ? cloudRes.lessons : [];
        if (cloudLessons.length > 0) {
            const installedById = new Map(importedLessons.map((l: any) => [l.id, l]));
            let updateCount = 0;

            const cloudGrid = document.createElement('div');
            cloudGrid.className = 'lesson-grid';

            for (const cl of cloudLessons) {
                const installed = installedById.get(cl.id);
                const state = !installed ? 'new'
                    : (cmpVersions(cl.version, installed.version) > 0 ? 'update' : 'current');
                if (state === 'update') updateCount++;

                const card = document.createElement('div');
                card.className = 'lesson-card';
                card.style.cssText = 'display:flex;flex-direction:column;gap:6px;padding:10px;';
                const badge = state === 'update'
                    ? `<span style="color:#e5c07b;font-size:9px;font-weight:600">UPDATE → v${escapeHtml(cl.version)}</span>`
                    : state === 'current'
                        ? '<span style="color:#4ec9b0;font-size:9px;font-weight:600">✓ INSTALLED</span>'
                        : `<span style="color:var(--text-muted);font-size:9px">v${escapeHtml(cl.version)}</span>`;
                card.innerHTML = `
                    <div style="display:flex;justify-content:space-between;align-items:center;gap:6px">
                        <div class="lesson-card-title" style="font-size:12px;font-weight:600">${escapeHtml(cl.title)}</div>
                        ${badge}
                    </div>
                    <div style="font-size:10px;color:var(--text-muted)">${escapeHtml(cl.difficulty || 'beginner')} · ${escapeHtml(cl.author || 'Unknown')}</div>
                    <div style="font-size:10px;color:var(--text-dim)">${escapeHtml(cl.description || '')}</div>`;

                if (state !== 'current') {
                    const btn = document.createElement('button');
                    btn.className = 'learn-action-btn';
                    btn.style.cssText = 'align-self:flex-start;font-size:10px;padding:4px 10px;margin-top:2px';
                    btn.textContent = state === 'update' ? `Update to v${cl.version}` : 'Download';
                    btn.addEventListener('click', () => downloadCloudLesson(cl.id, btn));
                    card.appendChild(btn);
                }
                cloudGrid.appendChild(card);
            }

            const cloudSection = document.createElement('div');
            cloudSection.className = 'learn-section';
            cloudSection.innerHTML = `<div class="learn-section-title">☁ CLOUD LESSONS${updateCount > 0 ? ` <span style="color:#e5c07b">(${updateCount} update${updateCount > 1 ? 's' : ''} available)</span>` : ''}</div>`;
            cloudSection.appendChild(cloudGrid);
            panel.appendChild(cloudSection);
        }
    } catch { /* offline or server unreachable — skip the cloud section quietly */ }

    // ── Curriculum (built-in interactive lessons) ──
    const curriculum = lessonSystem.getActiveCurriculum();
    if (curriculum && curriculum.modules.length) {
        let totalLessons = 0, doneLessons = 0;
        for (const m of curriculum.modules) for (const l of m.lessons) {
            totalLessons++;
            if (learningProfile.getLessonProgress(l.id)?.completed) doneLessons++;
        }

        const curSection = document.createElement('div');
        curSection.className = 'learn-section';
        curSection.innerHTML = `<div class="learn-section-title">CURRICULUM <span style="color:var(--text-muted)">(${doneLessons}/${totalLessons} lessons)</span></div>`;

        for (const mod of curriculum.modules) {
            const modLabel = document.createElement('div');
            modLabel.style.cssText = 'font-size:10px;font-weight:600;letter-spacing:.04em;color:var(--text-muted);margin:10px 0 3px';
            modLabel.textContent = mod.title.toUpperCase();
            curSection.appendChild(modLabel);

            for (const lesson of mod.lessons) {
                const lp = learningProfile.getLessonProgress(lesson.id);
                const done = !!lp?.completed, started = !!lp?.started;
                const row = document.createElement('div');
                row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:5px;cursor:pointer;font-size:11.5px';
                row.innerHTML = `<span style="color:${done ? '#4ec9b0' : started ? '#e5c07b' : 'var(--text-muted)'};width:12px;text-align:center">${done ? '✓' : started ? '◐' : '○'}</span>
                    <span style="flex:1;color:var(--text)">${escapeHtml(lesson.title)}</span>
                    <span style="color:var(--text-muted);font-size:9px">${lesson.estimatedMinutes}m · ${escapeHtml(lesson.difficulty)}</span>`;
                row.addEventListener('mouseenter', () => row.style.background = 'rgba(255,255,255,0.05)');
                row.addEventListener('mouseleave', () => row.style.background = '');
                row.addEventListener('click', () => openLessonViewer(mod.id, lesson.id));
                curSection.appendChild(row);
            }
        }
        panel.appendChild(curSection);
    }

    // ── Action Buttons ──
    const actionsSection = document.createElement('div');
    actionsSection.className = 'learn-actions';

    const importBtn = document.createElement('button');
    importBtn.className = 'learn-action-btn learn-action-primary';
    importBtn.innerHTML = '\ud83d\udce5 Import Lesson';
    importBtn.addEventListener('click', async () => {
        const result = await ipcRenderer.invoke(IPC.LESSON_IMPORT);
        if (result.success) { appendOutput('Imported cinematic lesson: ' + (result.title || result.lessonId) + '\n'); renderLearnPanel(); }
        else if (result.error && result.error !== 'Cancelled') { appendOutput('Lesson import failed: ' + result.error + '\n'); }
    });
    actionsSection.appendChild(importBtn);
    panel.appendChild(actionsSection);

    // ── Achievements ──
    const achSection = document.createElement('div');
    achSection.className = 'learn-section';
    achSection.innerHTML = '<div class="learn-section-title">ACHIEVEMENTS</div>';
    const achGrid = document.createElement('div');
    achGrid.className = 'ach-grid';
    const { earned, locked } = learning.getAchievementProgress(userProfile);
    for (const a of earned) { const item = document.createElement('div'); item.className = 'ach-item earned'; item.innerHTML = '<span class="ach-item-icon">' + a.icon + '</span><div><div class="ach-item-name">' + a.name + '</div><div class="ach-item-desc">' + a.description + '</div></div>'; achGrid.appendChild(item); }
    for (const a of locked) { const item = document.createElement('div'); item.className = 'ach-item locked'; item.innerHTML = '<span class="ach-item-icon">' + a.icon + '</span><div><div class="ach-item-name">' + a.name + '</div><div class="ach-item-desc">' + a.description + '</div></div>'; achGrid.appendChild(item); }
    achSection.appendChild(achGrid);
    panel.appendChild(achSection);

    // ── Skill Level ──
    const skillDiv = document.createElement('div');
    skillDiv.className = 'learn-section';
    const levelIcons: Record<string, string> = { beginner: '\ud83c\udf31', intermediate: '\ud83d\udd27', expert: '\u26a1' };
    skillDiv.innerHTML = '<div class="learn-section-title">SKILL LEVEL</div><div style="padding:4px 4px;font-size:11px;color:var(--text)">' + (levelIcons[userProfile.skillLevel] || '\ud83c\udf31') + ' ' + userProfile.skillLevel.charAt(0).toUpperCase() + userProfile.skillLevel.slice(1) + '</div>';
    panel.appendChild(skillDiv);

    // The light/dark picker that used to sit here is gone. Settings → Appearance
    // has owned colour mode since v3.0, and two controls for one setting is how
    // you get a panel that disagrees with itself.
}

function createLessonCard(lesson: { id: string; title: string; desc: string; difficulty: string; available: boolean; longDesc?: string; duration?: string; topics?: string[] }): HTMLElement {
    const card = document.createElement('div');
    card.className = 'lesson-card' + (lesson.available ? '' : ' lesson-locked');

    const diffColor = lesson.difficulty === 'Beginner' ? '#4ec9b0' : lesson.difficulty === 'Intermediate' ? '#e5c07b' : '#c586c0';

    card.innerHTML = `
        <div class="lesson-card-icon">${lesson.available ? '\ud83c\udfac' : '\ud83d\udd12'}</div>
        <div class="lesson-card-body">
            <div class="lesson-card-title">${lesson.title}</div>
        </div>
        <div class="lesson-card-footer">
            <span class="lesson-card-diff" style="color:${diffColor}">${lesson.difficulty.substring(0, 3).toUpperCase()}</span>
        </div>`;

    card.addEventListener('click', () => showLessonDetail(lesson));
    return card;
}

function showLessonDetail(lesson: { id: string; title: string; desc: string; difficulty: string; available: boolean; longDesc?: string; duration?: string; topics?: string[] }) {
    document.getElementById('lesson-detail-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'lesson-detail-overlay';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const diffColor = lesson.difficulty === 'Beginner' ? '#4ec9b0' : lesson.difficulty === 'Intermediate' ? '#e5c07b' : '#c586c0';
    const topicsHtml = (lesson.topics || []).map(t => `<span class="ld-topic">${escapeHtml(t)}</span>`).join('');
    const previewData = getLessonPreviewData(lesson.id);

    const modal = document.createElement('div');
    modal.className = 'lesson-detail';
    modal.innerHTML = `
        <div class="ld-header">
            <div class="ld-icon">${lesson.available ? '\ud83c\udfac' : '\ud83d\udd12'}</div>
            <div>
                <div class="ld-title">${escapeHtml(lesson.title)}</div>
                <div class="ld-meta">
                    <span class="ld-diff" style="color:${diffColor}">${lesson.difficulty}</span>
                    ${lesson.duration ? `<span class="ld-dur">${lesson.duration}</span>` : ''}
                </div>
            </div>
            <button class="ld-close" id="ld-close">\u2715</button>
        </div>
        <div class="ld-preview-row">
            <div class="ld-preview-pane">
                <div class="ld-preview-label">CINEMATIC LESSON</div>
                <div class="ld-code-preview">
                    ${previewData.codeBlocks.map(b => `
                        <div class="ld-code-block" style="border-left:3px solid ${b.color}">
                            <div class="ld-code-block-title" style="color:${b.color}">${escapeHtml(b.label)}</div>
                            ${b.lines.map(l => `<div class="ld-code-line" style="width:${l}%"></div>`).join('')}
                        </div>
                    `).join('')}
                    <div class="ld-spotlight-hint"><div class="ld-spotlight-box"></div><span>Spotlight explains each section</span></div>
                </div>
            </div>
            <div class="ld-preview-pane">
                <div class="ld-preview-label">RESULT</div>
                <div class="ld-result-preview">
                    <canvas id="ld-result-canvas" width="220" height="150"></canvas>
                    <div class="ld-result-caption">${escapeHtml(previewData.resultCaption)}</div>
                </div>
            </div>
        </div>
        <div class="ld-body">
            <div class="ld-desc">${escapeHtml(lesson.longDesc || lesson.desc)}</div>
            ${topicsHtml ? `<div class="ld-topics-title">TOPICS COVERED</div><div class="ld-topics">${topicsHtml}</div>` : ''}
        </div>
        <div class="ld-footer">
            ${lesson.available
                ? `<button class="ld-btn ld-btn-primary" id="ld-begin">\u26a1 Begin Lesson</button>`
                : `<div class="ld-locked-msg">\ud83d\udd12 This lesson is not yet available</div>`}
            <button class="ld-btn ld-btn-secondary" id="ld-back">\u2190 Back</button>
            <button class="ld-btn ld-btn-danger" id="ld-delete">\ud83d\uddd1 Delete Lesson</button>
        </div>`;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => {
        overlay.classList.add('visible');
        const canvas = document.getElementById('ld-result-canvas') as HTMLCanvasElement;
        if (canvas) renderLessonResultPreview(canvas, lesson.id);
    });

    modal.querySelector('#ld-close')!.addEventListener('click', () => overlay.remove());
    modal.querySelector('#ld-back')!.addEventListener('click', () => overlay.remove());
    if (lesson.available) {
        modal.querySelector('#ld-begin')!.addEventListener('click', () => { overlay.remove(); openCinematicTutor(lesson.id); });
    }
    modal.querySelector('#ld-delete')!.addEventListener('click', async () => {
        if (!confirm(`Delete "${lesson.title}"? This will remove the lesson and cannot be undone.`)) return;
        try {
            const result = await ipcRenderer.invoke(IPC.LESSON_DELETE, lesson.id);
            if (result.success) { overlay.remove(); renderLearnPanel(); }
            else { alert('Delete failed: ' + (result.error || 'Unknown error')); }
        } catch (err: any) { alert('Delete failed: ' + err.message); }
    });
}

interface LessonPreviewData { codeBlocks: { label: string; color: string; lines: number[] }[]; resultCaption: string; }

function getLessonPreviewData(lessonId: string): LessonPreviewData {
    // All preview data is generic — lessons define their own identity via packages
    return {
        codeBlocks: [
            { label: 'Code Section 1', color: '#4ec9b0', lines: [70, 85, 60, 75] },
            { label: 'Code Section 2', color: '#569cd6', lines: [80, 55, 90] },
            { label: 'Code Section 3', color: '#e5c07b', lines: [65, 75, 85, 70] },
        ],
        resultCaption: 'Lesson output preview',
    };
}
function renderLessonResultPreview(canvas: HTMLCanvasElement, lessonId: string) {
    const ctx = canvas.getContext("2d")!;
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = "#0a0a12"; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#4ec9b044"; ctx.beginPath(); ctx.roundRect(30, 30, w - 60, h - 60, 10); ctx.fill();
    ctx.fillStyle = "#4ec9b0"; ctx.font = "10px sans-serif"; ctx.textAlign = "center";
    ctx.fillText("Preview", w / 2, h / 2 + 4);
}


// ══════════════════════════════════════
//  LEARNING HOOKS (connect to IDE events)
// ══════════════════════════════════════
function onBuildComplete(result: any) {
    if (result.success) {
        userProfile.totalBuilds++;
        if (!userProfile.firstBuildDate) userProfile.firstBuildDate = new Date().toISOString();
        saveProfile();
        checkAchievements();
        triggerTip('build-success');

        // Check for zero-warnings achievement
        if ((result.warnings || []).length === 0 && (result.errors || []).length === 0) {
            triggerAchievement('master-clean-build');
        }
    } else {
        triggerTip('build-fail');
        // A failed build no longer fires the AI automatically. It sent every
        // error to the model unprompted, which costs tokens on every failed
        // build whether or not the user wanted an explanation. Use the Errors
        // tab in the AI panel to ask deliberately.
    }
    renderLearnPanel();
}

function onFileOpened(filePath: string) {
    const ext = nodePath.extname(filePath).toLowerCase();
    const baseName = nodePath.basename(filePath).toLowerCase();

    triggerTip('file-open', ext);

    // Achievement triggers
    if (baseName === 'stdafx.h') triggerAchievement('learn-pch');
    if (ext === '.hlsl' || ext === '.fx') triggerAchievement('learn-shader');
}

function onProjectCreated() {
    triggerAchievement('first-project');
    triggerTip('project-create');
    renderLearnPanel();
}

function onDeploy() {
    userProfile.totalDeploys++;
    saveProfile();
    checkAchievements();
    renderLearnPanel();
}

// Idle tip timer — show tips when the user hasn't done anything for a while
let idleTipTimer: any = null;
function resetIdleTipTimer() {
    if (idleTipTimer) clearTimeout(idleTipTimer);
    if (!userProfile.tipsEnabled) return;
    idleTipTimer = setTimeout(() => {
        triggerTip('editor-idle');
    }, 120000); // 2 minutes of idle
}
document.addEventListener('keydown', resetIdleTipTimer);
document.addEventListener('click', resetIdleTipTimer);

// ══════════════════════════════════════
//  IMAGE PICKING
// ══════════════════════════════════════

/**
 * Let the user pick an image file and return it as a downscaled data: URI.
 *
 * Downscaling is the whole point. These images are stored inline in the
 * settings JSON, and a phone photo dropped in as a profile picture is several
 * megabytes of base64 that gets parsed on every launch, forever. Re-encoding to
 * a bounded PNG makes the stored size a function of `maxPx` rather than of
 * whatever the user happened to pick.
 *
 * Returns null if the user cancels or the file isn't a decodable image.
 */
async function pickImageAsDataUrl(maxPx = 256): Promise<string | null> {
    const file: string | null = await ipcRenderer.invoke(IPC.FILE_SELECT_FILE, [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'] },
    ]);
    if (!file) return null;

    let raw: string;
    try {
        const buf = nodeFs.readFileSync(file);
        const ext = nodePath.extname(file).toLowerCase();
        const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
            : ext === '.gif' ? 'image/gif'
            : ext === '.bmp' ? 'image/bmp'
            : ext === '.webp' ? 'image/webp'
            : 'image/png';
        raw = `data:${mime};base64,${buf.toString('base64')}`;
    } catch (err: any) {
        alert(`Couldn't read that file: ${err.message}`);
        return null;
    }

    return await new Promise<string | null>((resolve) => {
        const img = new Image();
        img.onload = () => {
            // Only shrink. Scaling a 32px icon up to 256 would just blur it.
            const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
            const w = Math.max(1, Math.round(img.width * scale));
            const h = Math.max(1, Math.round(img.height * scale));

            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            if (!ctx) return resolve(raw);
            ctx.drawImage(img, 0, 0, w, h);
            // PNG throughout: these are icons and avatars, often with
            // transparency, and JPEG would fill it with black.
            try { resolve(canvas.toDataURL('image/png')); } catch { resolve(raw); }
        };
        img.onerror = () => { alert("That file isn't an image the IDE can read."); resolve(null); };
        img.src = raw;
    });
}

// ══════════════════════════════════════
//  AVATARS
// ══════════════════════════════════════

/**
 * The letter shown when there's no picture.
 *
 * One letter, not two. Five call sites each had their own
 * `.substring(0, 2).toUpperCase()`, so "mrtitanic777" rendered as "MR" — two
 * letters of a username reads as somebody's initials, which is what a two-letter
 * avatar means everywhere else. A single letter is unambiguous.
 */
function userInitial(user: { username?: string; email?: string } | null): string {
    const source = (user?.username || user?.email || '').trim();
    // Not [0] — an emoji or any astral character is a surrogate pair, and half
    // of one renders as a replacement box.
    return (Array.from(source)[0] || '?').toUpperCase();
}

/**
 * The image to show for a user, or null to fall back to their initial.
 *
 * A locally uploaded picture wins over the server's: it is the one the user
 * chose in this copy of the IDE, and it should not be silently overridden by
 * whatever their account or linked Discord happens to carry.
 */
function userAvatarSrc(user: { avatarUrl?: string } | null): string | null {
    return userSettings.avatarDataUrl || user?.avatarUrl || null;
}

/**
 * Render an avatar as HTML: a picture if there is one, else a single letter.
 * `cls` is the existing class at each site (tu-avatar, dp-user-avatar, …) so
 * each keeps its own size and shape.
 */
function avatarHtml(user: { username?: string; email?: string; avatarUrl?: string } | null,
                    cls: string, color: string): string {
    const src = userAvatarSrc(user);
    if (src) {
        // object-fit:cover so a non-square upload fills the circle instead of
        // being squashed into it.
        return `<div class="${cls}" style="background:${color};overflow:hidden;padding:0">
            <img src="${escapeHtml(src)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block">
        </div>`;
    }
    return `<div class="${cls}" style="background:${color}">${escapeHtml(userInitial(user))}</div>`;
}

/**
 * Redraw every avatar that's currently on screen.
 *
 * The titlebar is the only one that persists — the user panel and the dev panel
 * rebuild themselves each time they open, so they pick the new picture up on
 * their own.
 */
function refreshAvatars() {
    try { updateTitlebarUser(); } catch {}
    try { authUI.refreshAuthButton(); } catch {}
}

// ══════════════════════════════════════
//  LEARN — VIDEOS & WEB — panels/learnDiscover.ts
// ══════════════════════════════════════
const { initDiscover, renderVideosSection, renderWebSection } = require('./panels/learnDiscover');

// ══════════════════════════════════════
//  COMMUNITY PANEL — Extracted to panels/communityPanel.ts
// ══════════════════════════════════════
let communityPanel: any;
try {
    communityPanel = require('./panels/communityPanel');
} catch (err: any) {
    console.error('[Community] Module load failed:', err.message);
    communityPanel = {
        initCommunity: () => {},
        renderCommunityPanel: () => {},
        refreshCommunityView: async () => {},
        showDiscordSetup: () => {},
        getDiscordAuthUser: () => null,
        setDiscordAuthUser: () => {},
    };
}
const { renderCommunityPanel, refreshCommunityView, showDiscordSetup,
        getDiscordAuthUser, setDiscordAuthUser } = communityPanel;


// ══════════════════════════════════════
//  CODE-ALONG HELPER
// ══════════════════════════════════════
function initCodeHelper() {
    // Listen for cursor position changes
    if (!editor) return;
    editor.onDidChangeCursorPosition((e: any) => {
        if (!userProfile.tipsEnabled) return;
        const lineNum = e.position.lineNumber;
        if (lineNum === lastHintLine) return;
        lastHintLine = lineNum;

        const model = editor.getModel();
        if (!model) return;
        const lineContent = model.getLineContent(lineNum);
        // Check surrounding lines too for broader context
        const context = [
            lineNum > 1 ? model.getLineContent(lineNum - 1) : '',
            lineContent,
            lineNum < model.getLineCount() ? model.getLineContent(lineNum + 1) : '',
        ].join('\n');

        const hints = quizzes.getHintsForLine(context);
        if (hints.length > 0) {
            const hint = hints.find((h: any) => !codeHelperDismissed.has(h.id));
            if (hint && hint.id !== currentCodeHint?.id) {
                showCodeHelper(hint);
            }
        }
    });
}

function showCodeHelper(hint: any) {
    currentCodeHint = hint;
    const body = $('code-helper-body');
    body.innerHTML = `<strong>${hint.icon} ${hint.title}</strong><br><br>${hint.body}`;
    // Show/hide insert button based on whether hint has a snippet
    $('code-helper-insert').style.display = hint.snippet ? 'inline-block' : 'none';
    $('code-helper').classList.remove('hidden');
    // Position relative to editor area
    const editorArea = $('editor-area');
    if (editorArea && !editorArea.contains($('code-helper'))) {
        editorArea.style.position = 'relative';
        editorArea.appendChild($('code-helper'));
    }
}

$('code-helper-close').addEventListener('click', () => $('code-helper').classList.add('hidden'));
$('code-helper-dismiss').addEventListener('click', () => {
    if (currentCodeHint) codeHelperDismissed.add(currentCodeHint.id);
    $('code-helper').classList.add('hidden');
});
$('code-helper-insert').addEventListener('click', () => {
    if (!editor || !currentCodeHint?.snippet) return;
    const pos = editor.getPosition();
    editor.executeEdits('code-helper', [{
        range: new (window as any).monaco.Range(pos.lineNumber + 1, 1, pos.lineNumber + 1, 1),
        text: '\n' + currentCodeHint.snippet + '\n',
    }]);
    $('code-helper').classList.add('hidden');
    editor.focus();
});

// ══════════════════════════════════════
//  PROJECT EXPORT — Extracted to editor/projectExport.ts
// ══════════════════════════════════════
const { initProjectExport, exportProject, importProject, uploadDocument } = require('./editor/projectExport');
initProjectExport({
    appendOutput,
    getCurrentProject: () => currentProject,
    refreshFileTree,
    openProject,
});
menuAction('menu-export', exportProject);
menuAction('menu-import', importProject);
menuAction('menu-import-vs', importFromVisualStudio);
menuAction('menu-upload-doc', uploadDocument);

// ══════════════════════════════════════
//  GIT — Extracted to git.ts
// ══════════════════════════════════════
const { initGit, gitInit, gitCommit, gitPush, gitSetRemote, renderGitPanel } = require('./git');
initGit({ $: (id: string) => document.getElementById(id)!, getCurrentProject: () => currentProject, appendOutput });
menuAction('menu-git-init', gitInit);
menuAction('menu-git-commit', gitCommit);
menuAction('menu-git-push', gitPush);
menuAction('menu-git-setup', gitSetRemote);
// ══════════════════════════════════════
//  FIND IN FILES — Extracted to editor/searchPanel.ts
// ══════════════════════════════════════
const { triggerSearch, openFindInFiles } = require('./editor/searchPanel');

//  EDITOR ZOOM — Ctrl+Scroll, Ctrl+Plus/Minus, Ctrl+0
// ══════════════════════════════════════

function editorZoom(delta: number) {
    if (!editor) return;
    userSettings.fontSize = Math.max(8, Math.min(40, userSettings.fontSize + delta));
    editor.updateOptions({ fontSize: userSettings.fontSize });
    $('status-zoom').textContent = `${Math.round((userSettings.fontSize / 14) * 100)}%`;
    saveUserSettings();
}

function editorZoomReset() {
    if (!editor) return;
    userSettings.fontSize = 14;
    editor.updateOptions({ fontSize: 14 });
    $('status-zoom').textContent = '100%';
    saveUserSettings();
}

// Ctrl+Scroll over editor area
$('editor-container').addEventListener('wheel', (e: WheelEvent) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    e.stopPropagation();
    editorZoom(e.deltaY < 0 ? 1 : -1);
}, { passive: false });

// ══════════════════════════════════════
//  KEYBOARD SHORTCUTS
// ══════════════════════════════════════
document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 's') { e.preventDefault(); if (e.shiftKey) saveAllFiles(); else saveCurrentFile(); }
    if (e.key === 'F7') { e.preventDefault(); doBuild(); }
    if (e.key === 'F6') {
        e.preventDefault();
        if (lastBuiltXex) {
            ipcRenderer.invoke(IPC.EMU_LAUNCH, lastBuiltXex);
            appendOutput(`[Nexia 360] Launching: ${lastBuiltXex}\n`);
        } else {
            appendOutput('No XEX built yet. Build first (F7), then run (F6).\n');
        }
    }
    if (e.key === 'F5') {
        e.preventDefault();
        if (lastBuiltXex && isDevkitConnected()) {
            ipcRenderer.invoke(IPC.DEVKIT_DEPLOY, lastBuiltXex);
        } else if (!isDevkitConnected()) {
            appendOutput('No console connected. Connect in the Devkit panel first.\n');
        } else {
            appendOutput('No XEX built yet. Build first (F7), then deploy (F5).\n');
        }
    }
    if (e.ctrlKey && e.shiftKey && e.key === 'B') { e.preventDefault(); doRebuild(); }
    if (e.ctrlKey && e.shiftKey && (e.key === 'F' || e.key === 'f')) { e.preventDefault(); openFindInFiles(); }
    if (e.ctrlKey && !e.shiftKey && e.key === 'b' && !e.altKey) { e.preventDefault(); doBuild(); }
    if (e.ctrlKey && e.key === 'n') { e.preventDefault(); if (e.altKey) { if (currentProject) inlineCreateItem('file'); else showNewFileDialog(); } else showNewProjectDialog(); }
    if (e.ctrlKey && e.key === 'o') { e.preventDefault(); openProject(); }
    if (e.ctrlKey && e.key === 'w') { e.preventDefault(); if (activeTab) closeTab(activeTab); }
    if (e.ctrlKey && e.key === 'g') { e.preventDefault(); showGoToLine(); }
    if (e.ctrlKey && e.key === '\\') { e.preventDefault(); toggleSidebar(); }
    if (e.ctrlKey && e.key === '`') { e.preventDefault(); toggleBottomPanel(); }
    // Zoom: Ctrl+= / Ctrl+- / Ctrl+0
    if (e.ctrlKey && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        editorZoom(1);
    }
    if (e.ctrlKey && e.key === '-') {
        e.preventDefault();
        editorZoom(-1);
    }
    if (e.ctrlKey && e.key === '0') {
        e.preventDefault();
        editorZoomReset();
    }
    if (e.key === 'Escape') { $$('.overlay').forEach(o => o.classList.add('hidden')); closeAllMenus(); }
});

// ══════════════════════════════════════
//  RECENT PROJECTS
// ══════════════════════════════════════
/**
 * The recent projects list, as last read from the main process.
 *
 * Held here because the Explorer is redrawn by refreshFileTree(), which has no
 * idea what a recent project is — it asks for this view instead.
 */
let recentProjects: string[] = [];

function renderRecentProjects(recent: string[]) {
    recentProjects = recent;
    // These render in the Explorer, so redraw it — but only while it is showing
    // them. With a project open the Explorer is the file tree and must not be
    // rebuilt out from under the user just because the recents list changed.
    if (!currentProject) refreshFileTree();
}

/**
 * The Explorer, when no project is open: recent projects.
 *
 * Visual Studio does the same thing from the other side — recents on the Start
 * Page, Solution Explorer empty, and the moment you open something the tree
 * takes over. Nexia's Explorer was simply blank until then, which wasted the one
 * panel already pointed at "which project am I working on", while the recents
 * sat in the middle of the screen where the logo is.
 *
 * refreshFileTree() calls this. Opening a project makes it call the tree
 * instead, so this disappears on its own with nothing to tear down.
 */
function renderExplorerNoProject(container: HTMLElement) {
    drawExplorerRecents(container);

    // Then reconcile with the main process. It appends to the list itself when a
    // project is opened, so our copy is stale the moment you open anything —
    // close that project and the list would be missing the one you just had.
    // Drawing from cache first keeps the panel instant; this only redraws if the
    // list actually differs.
    ipcRenderer.invoke(IPC.APP_GET_RECENT).then((list: string[]) => {
        if (currentProject) return;  // a project opened while we were asking
        const fresh = list || [];
        if (JSON.stringify(fresh) === JSON.stringify(recentProjects)) return;
        recentProjects = fresh;
        drawExplorerRecents(container);
    }).catch(() => { /* keep what's on screen */ });
}

function drawExplorerRecents(container: HTMLElement) {
    container.innerHTML = '';

    if (!recentProjects.length) {
        const empty = document.createElement('div');
        empty.className = 'explorer-empty';
        empty.innerHTML = `
            <div class="explorer-empty-icon">📂</div>
            <div>No project open.</div>
            <div class="explorer-empty-dim">Create or open one to get started.</div>`;
        container.appendChild(empty);
        return;
    }

    const section = document.createElement('div');
    section.className = 'explorer-recents';
    section.innerHTML = '<div class="explorer-recents-title">RECENT PROJECTS</div>';

    // Five, not the welcome screen's three: this panel is a full column tall and
    // has the room the centred layout did not.
    for (const p of recentProjects.slice(0, 5)) {
        const item = document.createElement('div');
        item.className = 'recent-item';

        const name = nodePath.basename(p);
        const dir = nodePath.dirname(p);
        const gone = !nodeFs.existsSync(p);

        const info = document.createElement('div');
        info.className = 'recent-info';
        // Checked against disk as it's drawn: a deleted or moved project should
        // say so here rather than fail when clicked.
        info.innerHTML =
            `<span class="recent-name${gone ? ' recent-gone' : ''}">📁 ${escapeHtml(name)}</span>` +
            `<span class="recent-path" title="${escapeHtml(p)}">${gone ? 'Missing — ' : ''}${escapeHtml(dir)}</span>`;
        info.addEventListener('click', () => {
            if (gone) {
                appendOutput(`That project is no longer at ${p}\n`);
                return;
            }
            openProject(p);
        });

        const btn = document.createElement('button');
        btn.className = 'recent-delete';
        btn.title = 'Remove from recent projects';
        btn.textContent = '✕';
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const updated = await ipcRenderer.invoke(IPC.APP_REMOVE_RECENT, p);
            renderRecentProjects(updated);
        });

        item.appendChild(info);
        item.appendChild(btn);
        section.appendChild(item);
    }

    container.appendChild(section);
}

// ══════════════════════════════════════
//  INIT
// ══════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════
// NEXIA AI — Extracted to ai/aiService.ts
// ══════════════════════════════════════════════════════════════════════
const aiService = require('./ai/aiService');
const { aiComplete, sendAIMessage, switchToAIPanel,
        switchAIMode, setAIContext, triggerInlineSuggestion, updateBreadcrumb,
        initAI, initAIHintBar, addAIContextMenuItems, openAISettings,
        clearAIChat, renderMarkdown,
        tutorOnLessonComplete, tutorOnQuizFail, tutorOnSessionReturn, tutorOnBuildError } = aiService;

initDiscover({
    getSettings: () => userSettings,
    openExternal: (url: string) => { try { shell.openExternal(url); } catch {} },
    openSettings: () => showSettingsPanel('learn'),
    escapeHtml,
});

// ── AI Configuration Check ──
let _aiToastShown = false;

function checkAIConfiguration() {
    const hasConfig = userSettings.aiApiKey || userSettings.aiProvider === 'local';
    if (hasConfig || _aiToastShown) return;
    _aiToastShown = true;

    const existing = document.getElementById('ai-config-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'ai-config-toast';
    toast.style.cssText = 'position:fixed;bottom:60px;left:50%;transform:translateX(-50%) translateY(20px);opacity:0;z-index:9999;background:#1e1e2e;border:1px solid #38bdf8;border-radius:8px;padding:14px 18px;max-width:420px;box-shadow:0 8px 32px rgba(0,0,0,0.5);transition:opacity 0.3s,transform 0.3s;font-family:var(--font);';
    toast.innerHTML = `
        <div style="display:flex;align-items:flex-start;gap:12px;">
            <div style="font-size:24px;flex-shrink:0;margin-top:2px;color:#38bdf8;">🤖</div>
            <div style="flex:1;">
                <div style="font-size:13px;font-weight:600;color:#38bdf8;margin-bottom:4px;">AI Not Configured</div>
                <div style="font-size:12px;color:#cccccc;line-height:1.5;margin-bottom:10px;">Nexia AI needs an API key to provide code assistance, error analysis, and code generation. Configure a provider to get started.</div>
                <div style="display:flex;gap:8px;">
                    <button id="ai-toast-configure" style="padding:6px 14px;background:#38bdf8;color:#1e1e2e;border:none;border-radius:4px;font-size:12px;font-weight:600;cursor:pointer;font-family:var(--font);">Configure AI</button>
                    <button id="ai-toast-dismiss" style="padding:6px 12px;background:transparent;color:#858585;border:1px solid #404040;border-radius:4px;font-size:12px;cursor:pointer;font-family:var(--font);">Dismiss</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(toast);
    requestAnimationFrame(() => { toast.style.opacity = '1'; toast.style.transform = 'translateX(-50%) translateY(0)'; });

    document.getElementById('ai-toast-configure')!.addEventListener('click', () => {
        dismissAIToast(toast);
        showSettingsPanel();
    });

    document.getElementById('ai-toast-dismiss')!.addEventListener('click', () => {
        dismissAIToast(toast);
    });

    // Auto-dismiss after 12 seconds
    setTimeout(() => { if (toast.parentNode) dismissAIToast(toast); }, 12000);
}

function dismissAIToast(toast: HTMLElement) {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(-50%) translateY(20px)';
    setTimeout(() => toast.remove(), 300);
}

// ── Git Configuration Check ──
let _gitToastShown = false;

function checkGitConfiguration() {
    // Only show when on the GitHub sub-tab and not signed into Nexia
    if (_gitToastShown) return;
    if (authService.isLoggedIn()) return; // Nexia account present — GitHub features available

    _gitToastShown = true;

    const existing = document.getElementById('git-config-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'git-config-toast';
    toast.style.cssText = 'position:fixed;bottom:60px;left:50%;transform:translateX(-50%) translateY(20px);opacity:0;z-index:9999;background:#1e1e2e;border:1px solid #f472b6;border-radius:8px;padding:14px 18px;max-width:420px;box-shadow:0 8px 32px rgba(0,0,0,0.5);transition:opacity 0.3s,transform 0.3s;font-family:var(--font);';
    toast.innerHTML = `
        <div style="display:flex;align-items:flex-start;gap:12px;">
            <div style="font-size:24px;flex-shrink:0;margin-top:2px;color:#f472b6;">🔀</div>
            <div style="flex:1;">
                <div style="font-size:13px;font-weight:600;color:#f472b6;margin-bottom:4px;">GitHub Integration</div>
                <div style="font-size:12px;color:#cccccc;line-height:1.5;margin-bottom:10px;">Sign in to your Nexia account to link GitHub, push/pull repos, and manage files directly from the IDE. Local Git features work without signing in.</div>
                <div style="display:flex;gap:8px;">
                    <button id="git-toast-signin" style="padding:6px 14px;background:#f472b6;color:white;border:none;border-radius:4px;font-size:12px;font-weight:600;cursor:pointer;font-family:var(--font);">Sign In to Nexia</button>
                    <button id="git-toast-dismiss" style="padding:6px 12px;background:transparent;color:#858585;border:1px solid #404040;border-radius:4px;font-size:12px;cursor:pointer;font-family:var(--font);">Dismiss</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(toast);
    requestAnimationFrame(() => { toast.style.opacity = '1'; toast.style.transform = 'translateX(-50%) translateY(0)'; });

    document.getElementById('git-toast-signin')!.addEventListener('click', () => {
        dismissGenericToast(toast);
        authUI.showLogin();
    });
    document.getElementById('git-toast-dismiss')!.addEventListener('click', () => {
        dismissGenericToast(toast);
    });

    setTimeout(() => { if (toast.parentNode) dismissGenericToast(toast); }, 12000);
}

// ── Devkit Configuration Check ──
// (Hint is rendered inline in devkitPanel.ts — no floating toast needed)
function checkDevkitConfiguration() {}

function dismissGenericToast(toast: HTMLElement) {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(-50%) translateY(20px)';
    setTimeout(() => toast.remove(), 300);
}


async function init() {
    // Replace emoji characters with SVG icons
    const { initIcons, patchIcons } = require('./icons');
    initIcons();
    // Patch dynamically-added content
    const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
            for (const node of Array.from(m.addedNodes)) {
                if (node.nodeType === Node.ELEMENT_NODE) patchIcons(node as HTMLElement);
                else if (node.nodeType === Node.TEXT_NODE && node.parentElement) patchIcons(node.parentElement);
            }
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    loadUserSettings();
    loadProfile();

    // Wire shared app context for extracted modules
    appCtx.userSettings = userSettings;
    appCtx.userProfile = userProfile;
    appCtx.ipc = ipcRenderer;
    appFn.appendOutput = appendOutput;
    appFn.clearOutput = clearOutput;
    appFn.showBottomPanel = showBottomPanel;
    appFn.renderTabs = renderTabs;
    appFn.saveUserSettings = saveUserSettings;
    appFn.saveProfile = saveProfile;
    appFn.refreshFileTree = refreshFileTree;
    appFn.switchToTab = switchToTab;
    appFn.renderMarkdown = renderMarkdown;

    // Wire mutable state via getters so extracted modules always see live values
    Object.defineProperty(appCtx, 'activeTab', { get: () => activeTab, configurable: true });
    Object.defineProperty(appCtx, 'openTabs', { get: () => openTabs, configurable: true });
    Object.defineProperty(appCtx, 'userSettings', { get: () => userSettings, configurable: true });
    Object.defineProperty(appCtx, 'userProfile', { get: () => userProfile, configurable: true });
    Object.defineProperty(appCtx, 'currentProject', { get: () => currentProject, configurable: true });

    // Phase 2: Initialize adaptive learning system
    learningProfile.load();           // Load saved mastery progress from disk
    lessonSystem.loadXbox360Curriculum(); // Load the built-in curriculum for the lesson viewer
    // Cinematic tutor is loaded on-demand when the user opens it
    learningProfile.startSession();   // Start tracking learning time

    // No "welcome back" prompt on startup. Launching the IDE used to fire a
    // request at the model unasked, spending tokens before the user had typed
    // anything — and on an API the user pays for per call.
    applyThemeColors();
    applyFancyMode();
    applyLayout();
    applyCornerRadius();
    clearCompactMode();
    installContextMenu();
    // Apply saved color mode
    if (userSettings.colorMode) applyColorMode(userSettings.colorMode);
    // Apply saved UI layout (sidebar order, panel sizes, welcome screen)
    try { applyUILayout(loadUILayoutConfig()); } catch {}
    initMonaco();
    _projectPropsMod.initProjectProperties({ $, $$: (s: string) => document.querySelectorAll(s), appendOutput, ipcRenderer, IPC, getCurrentProject: () => currentProject, setCurrentProject: (p: any) => { currentProject = p; } });
    _fileTreeMod.initFileTree({ $, appendOutput, ipcRenderer, IPC, shell, nodePath, nodeFs, openFile, showContextMenu, getCurrentProject: () => currentProject, closeProject: closeCurrentProject, renderNoProjectView: renderExplorerNoProject });
    _devkitPanel.initDevkit({ $, appendOutput, escapeHtml: escapeHtml, ipcRenderer, IPC, nodeFs, nodePath, nodeOs });
    initDevkitPanel();
    _emulatorPanel.initEmulator({ $, appendOutput, escapeHtml: escapeHtml, ipcRenderer, IPC, nodeOs });
    initEmulatorPanel();
    initTabContextMenu();
    setBuildStatus('ready');
    renderLearnPanel();
    renderTipsPanel();
    renderGitPanel();
    initVisualizerPanel();
    initAI();

    // ── Auth initialization ──
    // Silently load stored token and validate
    const authUser = await authService.init();
    // Teach authUI where a locally uploaded picture lives. It can't read
    // settings itself, and its default only knows about the account's own
    // avatarUrl.
    try { authUI.setAvatarResolver((u: any) => userAvatarSrc(u)); } catch {}
    // Show username in titlebar
    updateTitlebarUser();
    // Pull cloud settings + learning progress if logged in
    if (authUser) {
        pullCloudSettings();
        pullCloudProgress();
    }

    // Notify if any installed cinematic lessons have a newer version in the cloud.
    countLessonUpdates().then(n => {
        if (n > 0) appendOutput(`📚 ${n} cinematic lesson update${n > 1 ? 's' : ''} available — open the Learn panel (☁ Cloud Lessons).\n`);
    }).catch(() => {});

    // Startup prompts. A signed-in user is only ever interrupted by a new
    // release; a signed-out user is asked about their account first, and the
    // release popup waits until they've answered so the two never stack.
    if (authUser) {
        setTimeout(() => { checkForUpdates(); }, 2500);
    } else {
        setTimeout(() => { showAccountPrompt(() => { checkForUpdates(); }); }, 900);
    }

    // Render community panel AFTER auth is initialized so it knows login state
    try {
        communityPanel.initCommunity({
            $, appendOutput, escapeHtml, ipcRenderer, shell, IPC,
            authService, authUI, renderGitPanel, saveUserSettings,
            nodeFs, nodePath, nodeOs,
        });
        renderCommunityPanel();
    } catch (err: any) {
        console.error('[Community] Init failed:', err);
        appendOutput('Community panel failed to load: ' + err.message + '\n');
    }

    // Listen for future auth changes (login/logout during this session)
    authService.onAuthStateChange((user: any) => {
        updateTitlebarUser();
        // Pull cloud settings + progress when user logs in
        if (user) { pullCloudSettings(); pullCloudProgress(); }
        // Re-render community panel on login/logout
        renderCommunityPanel();
    });

    // Listen for connection/pulse state changes
    authService.onConnectionStateChange((state: any) => {
        updateConnectionStatus(state);
    });

    // ── Internet Connectivity Monitor ──
    checkInternetConnectivity();
    window.addEventListener('online', () => { hideNoInternetToast(); });
    window.addEventListener('offline', () => { showNoInternetToast(); });

    const state = await ipcRenderer.invoke(IPC.APP_READY);
    defaultProjectsDir = state.projectsDir || '';
    await checkSetup(state);
    renderRecentProjects(state.recentProjects || []);
    // Show onboarding on first launch
    if (!userProfile.onboardingComplete) {
        setTimeout(() => showOnboarding(), 500);
    } else {
        // Start idle tip timer for returning users
        resetIdleTipTimer();
    }

    // Auto-reopen removed — IDE shows welcome screen until user explicitly opens a project
}

$$('.overlay').forEach(o => {
    o.addEventListener('click', (e) => { if (e.target === o) o.classList.add('hidden'); });
});

init();

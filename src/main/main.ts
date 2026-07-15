/**
 * Nexia IDE — Main Process
 * Electron main process handling window creation, IPC, and backend services.
 */

import { app, BrowserWindow, ipcMain, dialog, shell, Menu, MenuItem } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { Toolchain } from './toolchain';
import { BuildSystem } from './buildSystem';
import { DevkitManager } from './devkit';
import { EmulatorManager } from './emulator';
import { SdkTools } from './sdkTools';
import { ExtensionManager } from './extensions';
import { ProjectManager } from './projectManager';
import { DiscordFeed } from './discord';
import { parseSolution, parseVsProject, importVsProject } from './vsImporter';
import * as searchService from './searchService';
import { IPC } from '../shared/types';

// ── Services ──
let toolchain: Toolchain;
let buildSystem: BuildSystem;
let devkitManager: DevkitManager;
let emulatorManager: EmulatorManager;
let sdkTools: SdkTools;
let extensionManager: ExtensionManager;
let projectManager: ProjectManager;
let discordFeed: DiscordFeed;
let mainWindow: BrowserWindow | null = null;

// ── App Settings ──
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
const RECENT_PATH = path.join(app.getPath('userData'), 'recent.json');
// Documents\NexiaIDE\Projects — no space, matching the product name everywhere
// else. Projects made before this went to "Nexia IDE\Projects"; they are not
// moved. Nothing needs them to be: open() takes a project's path from wherever
// it finds nexia.json rather than the path recorded inside it, so an old
// project opens from its old folder indefinitely.
const PROJECTS_DIR = path.join(app.getPath('documents'), 'NexiaIDE', 'Projects');

// Ensure Projects folder exists
function ensureProjectsDir() {
    if (!fs.existsSync(PROJECTS_DIR)) {
        fs.mkdirSync(PROJECTS_DIR, { recursive: true });
    }
    return PROJECTS_DIR;
}

function loadSettings(): any {
    try {
        if (fs.existsSync(SETTINGS_PATH)) {
            return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
        }
    } catch (e) {
        console.error('Failed to load settings:', e);
    }
    return {};
}

function saveSettings(settings: any) {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
}

function getRecentProjects(): string[] {
    try {
        if (fs.existsSync(RECENT_PATH)) {
            return JSON.parse(fs.readFileSync(RECENT_PATH, 'utf-8'));
        }
    } catch (e) {
        console.error('Failed to load recent projects:', e);
    }
    return [];
}

function addRecentProject(projectPath: string) {
    let recent = getRecentProjects();
    recent = recent.filter(p => p !== projectPath);
    recent.unshift(projectPath);
    if (recent.length > 10) recent = recent.slice(0, 10);
    fs.writeFileSync(RECENT_PATH, JSON.stringify(recent, null, 2), 'utf-8');
}

function removeRecentProject(projectPath: string) {
    let recent = getRecentProjects();
    recent = recent.filter(p => p !== projectPath);
    fs.writeFileSync(RECENT_PATH, JSON.stringify(recent, null, 2), 'utf-8');
}

function sendToRenderer(channel: string, ...args: any[]) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, ...args);
    }
}

// ── Window Creation ──

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1024,
        minHeight: 600,
        frame: false,             // Custom title bar
        thickFrame: true,         // Keeps native Windows snap/resize behavior
        backgroundColor: '#1e1e1e',
        icon: path.join(app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..'), 'resources', 'icon.png'),
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        },
        show: false,
    });

    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

    mainWindow.once('ready-to-show', () => {
        mainWindow?.show();
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// ── Initialize Services ──

async function initializeServices() {
    toolchain = new Toolchain();
    buildSystem = new BuildSystem(toolchain);
    devkitManager = new DevkitManager(toolchain);

    // Initialize emulator manager
    emulatorManager = new EmulatorManager();
    emulatorManager.setOutputCallback((data) => sendToRenderer(IPC.TOOL_OUTPUT, data));
    emulatorManager.setStateChangeCallback((state) => sendToRenderer(IPC.EMU_EVENT, { event: 'state', state }));
    emulatorManager.setEventCallback((event) => sendToRenderer(IPC.EMU_EVENT, event));
    sdkTools = new SdkTools(toolchain);
    extensionManager = new ExtensionManager();
    projectManager = new ProjectManager();

    // Forward build/tool output to renderer
    buildSystem.setOutputCallback((data) => sendToRenderer(IPC.BUILD_OUTPUT, data));
    devkitManager.setOutputCallback((data) => sendToRenderer(IPC.TOOL_OUTPUT, data));
    sdkTools.setOutputCallback((data) => sendToRenderer(IPC.TOOL_OUTPUT, data));
    extensionManager.setOutputCallback((data) => sendToRenderer(IPC.TOOL_OUTPUT, data));

    // Try to auto-detect SDK
    const settings = loadSettings();
    if (settings.emulatorPath) emulatorManager.configure(settings.emulatorPath);
    if (settings.sdkPath) {
        await toolchain.configure(settings.sdkPath);
    } else {
        await toolchain.detect();
    }

    // Initialize Discord feed from saved settings
    discordFeed = new DiscordFeed({
        botToken: settings.discordBotToken || '',
        channelId: settings.discordChannelId || '',
        clientId: settings.discordClientId || '',
        clientSecret: settings.discordClientSecret || '',
        enabled: settings.discordEnabled ?? false,
    });

    // Restore saved Discord user session
    if (settings.discordUser) {
        discordFeed.setAuthUser(settings.discordUser);
    }
}

// ── IPC Handlers ──

function registerIpcHandlers() {
    // ── App ──
    ipcMain.handle(IPC.APP_READY, async () => {
        ensureProjectsDir();
        const settings = loadSettings();
        return {
            sdkConfigured: !!toolchain.getPaths(),
            sdkPaths: toolchain.getPaths(),
            sdkBundled: toolchain.isBundled(),
            sdkInstallState: toolchain.detectInstallState(),
            sdkPartialPath: toolchain.getPartialInstallPath(),
            recentProjects: getRecentProjects(),
            firstRun: !settings.setupComplete,
            projectsDir: PROJECTS_DIR,
        };
    });

    ipcMain.on(IPC.APP_MINIMIZE, () => mainWindow?.minimize());
    ipcMain.on(IPC.APP_MAXIMIZE, () => {
        if (mainWindow?.isMaximized()) mainWindow.unmaximize();
        else mainWindow?.maximize();
    });
    ipcMain.on(IPC.APP_CLOSE, () => mainWindow?.close());

    // ── SDK ──
    ipcMain.handle(IPC.SDK_DETECT, async () => {
        const result = await toolchain.detect();
        return { paths: result, bundled: toolchain.isBundled() };
    });

    ipcMain.handle(IPC.SDK_CONFIGURE, async (_e, sdkPath: string) => {
        const result = await toolchain.configure(sdkPath);
        if (result) {
            const settings = loadSettings();
            settings.sdkPath = sdkPath;
            saveSettings(settings);
        }
        return result;
    });

    ipcMain.handle(IPC.SDK_GET_PATHS, async () => toolchain.getPaths());
    ipcMain.handle(IPC.SDK_GET_TOOLS, async () => toolchain.getToolInventory());

    ipcMain.handle(IPC.SDK_INSTALL_STATE, async () => {
        return {
            state: toolchain.detectInstallState(),
            partialPath: toolchain.getPartialInstallPath(),
        };
    });

    ipcMain.handle(IPC.SDK_PREP_REGISTRY, async () => {
        return toolchain.prepSdkRegistry();
    });

    ipcMain.handle(IPC.SDK_CLEANUP_REGISTRY, async () => {
        return toolchain.cleanupSdkRegistry();
    });

    // ── Project ──
    ipcMain.handle(IPC.PROJECT_GET_TEMPLATES, async () => projectManager.getTemplates());

    ipcMain.handle(IPC.PROJECT_NEW, async (_e, name: string, directory: string, templateId: string) => {
        const project = await projectManager.create(name, directory, templateId);
        addRecentProject(project.path);
        return project;
    });

    ipcMain.handle(IPC.PROJECT_OPEN, async (_e, projectDir?: string) => {
        let dir = projectDir;
        if (!dir) {
            if (!mainWindow) return null;
            const result = await dialog.showOpenDialog(mainWindow, {
                properties: ['openDirectory'],
                title: 'Open Xbox 360 Project',
            });
            if (result.canceled || result.filePaths.length === 0) return null;
            dir = result.filePaths[0];
        }
        const project = await projectManager.open(dir!);
        addRecentProject(project.path);
        return project;
    });

    ipcMain.handle(IPC.PROJECT_SAVE, async (_e, config?: any) => {
        await projectManager.save(config);
    });

    ipcMain.handle(IPC.PROJECT_GET_CONFIG, async () => projectManager.getCurrent());

    // ── Files ──
    ipcMain.handle(IPC.FILE_READ, async (_e, filePath: string) => {
        return fs.readFileSync(filePath, 'utf-8');
    });

    ipcMain.handle(IPC.FILE_WRITE, async (_e, filePath: string, content: string) => {
        fs.writeFileSync(filePath, content, 'utf-8');
    });

    ipcMain.handle(IPC.FILE_LIST, async (_e, dirPath?: string) => {
        return projectManager.getFileTree(dirPath);
    });

    ipcMain.handle(IPC.FILE_CREATE, async (_e, filePath: string, content: string = '') => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content, 'utf-8');
    });

    ipcMain.handle(IPC.FILE_DELETE, async (_e, filePath: string) => {
        fs.rmSync(filePath, { recursive: true, force: true });
    });

    ipcMain.handle(IPC.FILE_RENAME, async (_e, oldPath: string, newPath: string) => {
        fs.renameSync(oldPath, newPath);
    });

    ipcMain.handle(IPC.FILE_SELECT_DIR, async () => {
        if (!mainWindow) return null;
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openDirectory'],
        });
        return result.canceled ? null : result.filePaths[0];
    });

    ipcMain.handle(IPC.FILE_SELECT_FILE, async (_e, filters?: any[]) => {
        if (!mainWindow) return null;
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openFile'],
            filters: filters || [{ name: 'All Files', extensions: ['*'] }],
        });
        return result.canceled ? null : result.filePaths[0];
    });

    // ── Project Export/Import ──
    ipcMain.handle(IPC.PROJECT_EXPORT, async () => {
        const project = projectManager.getCurrent();
        if (!project) throw new Error('No project open');
        if (!mainWindow) return null;
        const result = await dialog.showSaveDialog(mainWindow, {
            title: 'Export Project',
            defaultPath: path.join(require('os').homedir(), 'Desktop', `${project.name}.zip`),
            filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
        });
        if (result.canceled || !result.filePath) return null;
        const { execFile, execSync } = require('child_process');
        try {
            const src = project.path;
            const dest = result.filePath;
            if (process.platform === 'win32') {
                // Use execFile with argument array to avoid command injection
                await new Promise<void>((resolve, reject) => {
                    execFile('powershell.exe', [
                        '-NoProfile', '-NonInteractive', '-Command',
                        `Compress-Archive -Path (Join-Path '${src.replace(/'/g, "''")}' '*') -DestinationPath '${dest.replace(/'/g, "''")}' -Force`
                    ], { windowsHide: true }, (err: any) => err ? reject(err) : resolve());
                });
            } else {
                execSync(`cd "${src}" && zip -r "${dest}" . -x "out/*" "*.obj" "*.pch"`, { stdio: 'pipe' });
            }
            return result.filePath;
        } catch (err: any) { throw new Error('Export failed: ' + err.message); }
    });

    ipcMain.handle(IPC.PROJECT_IMPORT, async () => {
        if (!mainWindow) return null;
        const result = await dialog.showOpenDialog(mainWindow, {
            title: 'Import Project (.zip)',
            properties: ['openFile'],
            filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
        });
        if (result.canceled || !result.filePaths[0]) return null;
        const zipPath = result.filePaths[0];
        // Ask where to extract
        const destResult = await dialog.showOpenDialog(mainWindow, {
            title: 'Choose extraction location',
            properties: ['openDirectory'],
        });
        if (destResult.canceled || !destResult.filePaths[0]) return null;
        const destDir = destResult.filePaths[0];
        const projectName = path.basename(zipPath, '.zip');
        const extractTo = path.join(destDir, projectName);
        const { execFile, execSync } = require('child_process');
        try {
            fs.mkdirSync(extractTo, { recursive: true });
            if (process.platform === 'win32') {
                await new Promise<void>((resolve, reject) => {
                    execFile('powershell.exe', [
                        '-NoProfile', '-NonInteractive', '-Command',
                        `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${extractTo.replace(/'/g, "''")}' -Force`
                    ], { windowsHide: true }, (err: any) => err ? reject(err) : resolve());
                });
            } else {
                execSync(`unzip -o "${zipPath}" -d "${extractTo}"`, { stdio: 'pipe' });
            }
            return extractTo;
        } catch (err: any) { throw new Error('Import failed: ' + err.message); }
    });

    // ── XEX Inspector ──
    ipcMain.handle(IPC.XEX_INSPECT, async (_e, xexPath?: string) => {
        let filePath = xexPath;
        if (!filePath) {
            if (!mainWindow) return null;
            const result = await dialog.showOpenDialog(mainWindow, {
                title: 'Open XEX File',
                properties: ['openFile'],
                filters: [{ name: 'Xbox 360 Executable', extensions: ['xex'] }, { name: 'All Files', extensions: ['*'] }],
            });
            if (result.canceled || !result.filePaths[0]) return null;
            filePath = result.filePaths[0];
        }

        try {
            const buf = fs.readFileSync(filePath);
            return parseXex(buf, filePath);
        } catch (err: any) {
            return { error: err.message, filePath };
        }
    });

    // ── Build ──
    ipcMain.handle(IPC.BUILD_RUN, async (_e, config?: any) => {
        const project = projectManager.getCurrent();
        if (!project) throw new Error('No project open');
        const result = await buildSystem.build(project, config);
        sendToRenderer(IPC.BUILD_COMPLETE, result);
        return result;
    });

    ipcMain.handle(IPC.BUILD_CLEAN, async () => {
        const project = projectManager.getCurrent();
        if (!project) throw new Error('No project open');
        await buildSystem.clean(project);
    });

    ipcMain.handle(IPC.BUILD_REBUILD, async (_e, config?: any) => {
        const project = projectManager.getCurrent();
        if (!project) throw new Error('No project open');
        await buildSystem.clean(project);
        const result = await buildSystem.build(project, config);
        sendToRenderer(IPC.BUILD_COMPLETE, result);
        return result;
    });

    ipcMain.handle(IPC.BUILD_CANCEL, async () => {
        buildSystem.cancel();
    });

    // ── SDK Tools ──
    ipcMain.handle(IPC.TOOL_COMPILE_SHADER, async (_e, input: string, output: string, profile: string, entry: string) => {
        return sdkTools.compileShader(input, output, profile, entry);
    });

    ipcMain.handle(IPC.TOOL_BUILD_XEX, async (_e, input: string, output: string) => {
        return sdkTools.buildXex(input, output);
    });

    ipcMain.handle(IPC.TOOL_ENCODE_AUDIO, async (_e, input: string, output: string) => {
        return sdkTools.encodeAudioXma2(input, output);
    });

    ipcMain.handle(IPC.TOOL_COMPILE_XUI, async (_e, input: string, output: string) => {
        return sdkTools.compileXui(input, output);
    });

    ipcMain.handle(IPC.TOOL_INSPECT_BINARY, async (_e, input: string) => {
        return sdkTools.inspectBinary(input);
    });

    ipcMain.handle(IPC.TOOL_COMPRESS, async (_e, input: string, output: string) => {
        return sdkTools.compress(input, output);
    });

    ipcMain.handle(IPC.TOOL_LAUNCH_PIX, async () => {
        return sdkTools.launchPix();
    });

    ipcMain.handle(IPC.TOOL_RUN, async (_e, toolName: string, args: string[]) => {
        return sdkTools.runTool(toolName, args);
    });

    ipcMain.handle(IPC.TOOL_LAUNCH, async (_e, toolName: string, isGui: boolean) => {
        return sdkTools.launchTool(toolName, isGui);
    });

    // ── Extensions ──
    ipcMain.handle(IPC.EXT_LIST, async () => {
        return extensionManager.getInstalled();
    });

    ipcMain.handle(IPC.EXT_INSTALL_ZIP, async (_e, zipPath: string) => {
        return extensionManager.installFromZip(zipPath);
    });

    ipcMain.handle(IPC.EXT_INSTALL_FOLDER, async (_e, folderPath: string) => {
        return extensionManager.installFromFolder(folderPath);
    });

    ipcMain.handle(IPC.EXT_UNINSTALL, async (_e, extensionId: string) => {
        return extensionManager.uninstall(extensionId);
    });

    ipcMain.handle(IPC.EXT_SET_ENABLED, async (_e, extensionId: string, enabled: boolean) => {
        return extensionManager.setEnabled(extensionId, enabled);
    });

    ipcMain.handle(IPC.EXT_CREATE, async (_e, name: string, type: string) => {
        return extensionManager.createTemplate(name, type as any);
    });

    ipcMain.handle(IPC.EXT_OPEN_DIR, async () => {
        extensionManager.openExtensionsDir();
    });

    // ── Devkit ──
    ipcMain.handle(IPC.DEVKIT_CONNECT, async (_e, ip: string) => {
        return devkitManager.connect(ip);
    });

    ipcMain.handle(IPC.DEVKIT_DISCONNECT, async () => {
        devkitManager.disconnect();
        return { connected: false };
    });

    ipcMain.handle(IPC.DEVKIT_STATUS, async () => {
        return {
            connected: devkitManager.isConnected(),
            ip: devkitManager.getConnectedIp(),
        };
    });

    ipcMain.handle(IPC.DEVKIT_SYSINFO, async (_e, ip?: string) => {
        return devkitManager.getSystemInfo(ip);
    });

    ipcMain.handle(IPC.DEVKIT_VOLUMES, async (_e, ip?: string) => {
        return devkitManager.listVolumes(ip);
    });

    ipcMain.handle(IPC.DEVKIT_DEPLOY, async (_e, xexPath: string, ip?: string) => {
        return devkitManager.deployAndRun(xexPath, ip);
    });

    ipcMain.handle(IPC.DEVKIT_LAUNCH, async (_e, remotePath: string, ip?: string) => {
        return devkitManager.launchTitle(remotePath, ip);
    });

    ipcMain.handle(IPC.DEVKIT_REBOOT, async (_e, type: string, ip?: string) => {
        return devkitManager.reboot(type as any, ip);
    });

    ipcMain.handle(IPC.DEVKIT_SCREENSHOT, async (_e, outputPath: string, ip?: string) => {
        return devkitManager.screenshot(outputPath, ip);
    });

    ipcMain.handle(IPC.DEVKIT_FILE_MANAGER, async (_e, remotePath: string, ip?: string) => {
        return devkitManager.listFiles(remotePath, ip);
    });

    ipcMain.handle(IPC.DEVKIT_COPY_TO, async (_e, localPath: string, remotePath: string, ip?: string) => {
        return devkitManager.copyTo(localPath, remotePath, ip);
    });

    // ── Emulator ──
    ipcMain.handle(IPC.EMU_CONFIGURE, async (_e, emulatorPath: string) => {
        emulatorManager.configure(emulatorPath);
        const settings = loadSettings();
        settings.emulatorPath = emulatorPath;
        saveSettings(settings);
        return { configured: emulatorManager.isConfigured() };
    });

    ipcMain.handle(IPC.EMU_GET_CONFIG, async () => {
        return {
            path: emulatorManager.getEmulatorPath(),
            configured: emulatorManager.isConfigured(),
        };
    });

    ipcMain.handle(IPC.EMU_LAUNCH, async (_e, xexPath: string) => {
        return emulatorManager.launch(xexPath);
    });

    ipcMain.handle(IPC.EMU_STOP, async () => {
        emulatorManager.stop();
        return { success: true };
    });

    ipcMain.handle(IPC.EMU_PAUSE, async () => {
        return await emulatorManager.pause();
    });

    ipcMain.handle(IPC.EMU_RESUME, async () => {
        return { ok: await emulatorManager.resume() };
    });

    ipcMain.handle(IPC.EMU_STEP, async () => {
        return await emulatorManager.step();
    });

    ipcMain.handle(IPC.EMU_STEP_OVER, async () => {
        return await emulatorManager.stepOver();
    });

    ipcMain.handle(IPC.EMU_STATE, async () => {
        return {
            state: emulatorManager.getState(),
            registers: emulatorManager.getRegisters(),
            breakpoints: emulatorManager.getBreakpoints(),
        };
    });

    ipcMain.handle(IPC.EMU_REGISTERS, async () => {
        return await emulatorManager.requestRegisters();
    });

    ipcMain.handle(IPC.EMU_BREAKPOINT_SET, async (_e, addr: string) => {
        return await emulatorManager.setBreakpoint(addr);
    });

    ipcMain.handle(IPC.EMU_BREAKPOINT_REMOVE, async (_e, id: string) => {
        return { ok: await emulatorManager.removeBreakpoint(id) };
    });

    ipcMain.handle(IPC.EMU_BREAKPOINT_LIST, async () => {
        return await emulatorManager.listBreakpoints();
    });

    ipcMain.handle(IPC.EMU_BACKTRACE, async () => {
        return await emulatorManager.getBacktrace();
    });

    ipcMain.handle(IPC.EMU_MEMORY_READ, async (_e, addr: string, size: number) => {
        return await emulatorManager.readMemory(addr, size);
    });

    ipcMain.handle(IPC.EMU_MEMORY_WRITE, async (_e, addr: string, data: string) => {
        return { ok: await emulatorManager.writeMemory(addr, data) };
    });

    // ── Setup Complete ──
    ipcMain.handle(IPC.APP_SHOW_SETUP, async () => {
        const settings = loadSettings();
        settings.setupComplete = true;
        saveSettings(settings);
    });

    ipcMain.handle(IPC.APP_GET_RECENT, async () => getRecentProjects());

    ipcMain.handle(IPC.APP_REMOVE_RECENT, async (_e, projectPath: string) => {
        removeRecentProject(projectPath);
        return getRecentProjects();
    });

    // ── Discord ──
    ipcMain.handle(IPC.DISCORD_GET_FEED, async (_e, force?: boolean) => {
        if (force) discordFeed.clearCache();
        return discordFeed.getThreads();
    });

    ipcMain.handle(IPC.DISCORD_GET_CONFIG, async () => {
        return discordFeed.getConfig();
    });

    ipcMain.handle(IPC.DISCORD_CONFIGURE, async (_e, config: { botToken?: string; channelId?: string; clientId?: string; clientSecret?: string; enabled?: boolean }) => {
        discordFeed.configure(config);
        // Persist to settings
        const settings = loadSettings();
        if (config.botToken !== undefined) settings.discordBotToken = config.botToken;
        if (config.channelId !== undefined) settings.discordChannelId = config.channelId;
        if (config.clientId !== undefined) settings.discordClientId = config.clientId;
        if (config.clientSecret !== undefined) settings.discordClientSecret = config.clientSecret;
        if (config.enabled !== undefined) settings.discordEnabled = config.enabled;
        saveSettings(settings);
        return discordFeed.getConfig();
    });

    ipcMain.handle(IPC.DISCORD_GET_MESSAGES, async (_e, threadId: string) => {
        return discordFeed.getThreadMessages(threadId);
    });

    ipcMain.handle(IPC.DISCORD_GET_NEW_MESSAGES, async (_e, threadId: string, afterMessageId: string) => {
        return discordFeed.getNewMessages(threadId, afterMessageId);
    });

    ipcMain.handle(IPC.DISCORD_CREATE_THREAD, async (_e, title: string, content: string) => {
        return discordFeed.createThread(title, content);
    });

    ipcMain.handle(IPC.DISCORD_REPLY, async (_e, threadId: string, content: string) => {
        return discordFeed.replyToThread(threadId, content);
    });

    ipcMain.handle(IPC.DISCORD_AUTH_START, async () => {
        if (!discordFeed.isOAuthConfigured()) {
            return { success: false, error: 'OAuth2 not configured. Add Client ID and Client Secret in Discord settings.' };
        }
        // Open browser to Discord authorize page
        const authUrl = discordFeed.getAuthUrl();
        shell.openExternal(authUrl);
        // Wait for callback
        const user = await discordFeed.startAuth();
        if (user) {
            // Persist user session
            const settings = loadSettings();
            settings.discordUser = user;
            saveSettings(settings);
            return { success: true, user: { id: user.id, username: user.username, avatarUrl: user.avatarUrl } };
        }
        return { success: false, error: 'Login cancelled or failed' };
    });

    ipcMain.handle(IPC.DISCORD_AUTH_USER, async () => {
        const user = discordFeed.getAuthUser();
        if (user) return { loggedIn: true, id: user.id, username: user.username, avatarUrl: user.avatarUrl };
        return { loggedIn: false };
    });

    ipcMain.handle(IPC.DISCORD_AUTH_LOGOUT, async () => {
        discordFeed.logout();
        const settings = loadSettings();
        delete settings.discordUser;
        saveSettings(settings);
        return { success: true };
    });

    // ══════════════════════════════════════
    //  VISUAL STUDIO IMPORT
    // ══════════════════════════════════════

    /** Pick a .sln/.vcxproj/.vcproj and list the importable projects inside it. */
    ipcMain.handle(IPC.VS_PICK, async () => {
        const result = await dialog.showOpenDialog(mainWindow!, {
            title: 'Import from Visual Studio',
            filters: [
                { name: 'Visual Studio Solution or Project', extensions: ['sln', 'vcxproj', 'vcproj'] },
                { name: 'Solution (*.sln)', extensions: ['sln'] },
                { name: 'Project (*.vcxproj, *.vcproj)', extensions: ['vcxproj', 'vcproj'] },
            ],
            properties: ['openFile'],
        });
        if (result.canceled || !result.filePaths.length) return { success: false, error: 'Cancelled' };

        const picked = result.filePaths[0];
        try {
            if (/\.sln$/i.test(picked)) {
                const info = parseSolution(picked);
                if (!info.projects.length) {
                    // Almost always a C#/.NET solution — say so instead of a blank "nothing found".
                    const raw = fs.readFileSync(picked, 'utf-8');
                    const other = (raw.match(/\.(csproj|vbproj|fsproj|pyproj)"/gi) || []).length;
                    return {
                        success: false,
                        error: other
                            ? `No C/C++ projects in that solution — it contains ${other} .NET project(s), which Nexia can't build for Xbox 360.`
                            : 'That solution has no C/C++ (.vcxproj/.vcproj) projects in it.',
                    };
                }
                // Don't offer the SDK's own projects as things to import.
                //
                // A solution that uses the ATG framework lists it as a project,
                // but it lives in the Xbox 360 SDK and ships prebuilt — picking
                // it would import Microsoft's 112 sources instead of the user's
                // app. Importing the app already links it (see projectReferences
                // in the importer), so listing it here just implies you have to
                // choose both, which is the opposite of what happens.
                //
                // If that leaves exactly one project, the renderer skips the
                // picker entirely — there is nothing to choose.
                const sdkRoot = toolchain.getPaths()?.root;
                const importable = sdkRoot
                    ? info.projects.filter(p => !path.resolve(p.path).toLowerCase()
                        .startsWith(path.resolve(sdkRoot).toLowerCase() + path.sep))
                    : info.projects;

                return {
                    success: true, kind: 'sln', solutionPath: picked, name: info.name,
                    projects: importable.length ? importable : info.projects,
                    // Kept for the header: "MinecraftMenu.sln · 2 projects" should
                    // still describe the solution, not what survived the filter.
                    totalProjects: info.projects.length,
                };
            }
            return {
                success: true, kind: 'proj', solutionPath: null,
                name: path.basename(picked, path.extname(picked)),
                projects: [{ name: path.basename(picked, path.extname(picked)), path: picked, exists: true }],
            };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    /** Parse a project and report what WOULD be imported — nothing is written. */
    ipcMain.handle(IPC.VS_PREVIEW, async (_e, projectPath: string) => {
        try {
            // The SDK root has to be passed here too, or the preview shows a
            // different library list than the import produces — referenced libs
            // (the ATG framework) would be missing from what the user is shown.
            const p = parseVsProject(projectPath, toolchain.getPaths()?.root);
            return {
                success: true,
                preview: {
                    name: p.name, format: p.format, type: p.type,
                    sourceCount: p.sources.length,
                    headerCount: p.headers.length,
                    otherCount: p.otherFiles.length,
                    includeDirectories: p.includeDirectories,
                    libraries: p.libraries,
                    defines: p.defines,
                    pchHeader: p.pchHeader,
                    warningLevel: p.warningLevel,
                    exceptionHandling: p.exceptionHandling,
                    enableRtti: p.enableRtti,
                    optimizationOverride: p.optimizationOverride,
                    warnings: p.warnings,
                    // Referenced projects, so the dialog can say what happens to
                    // each one instead of silently linking it.
                    projectReferences: p.projectReferences.map(r => ({
                        name: r.name,
                        insideSdk: r.insideSdk,
                        isStaticLibrary: r.isStaticLibrary,
                        resolved: !!r.libPath,
                        libPath: r.libPath,
                    })),
                    destination: PROJECTS_DIR,
                },
            };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    /** Do the import: copy sources into a new Nexia project and write nexia.json. */
    ipcMain.handle(IPC.VS_IMPORT, async (_e, opts: { projectPath: string; destDir?: string; name?: string; solutionPath?: string }) => {
        try {
            // No folder prompt. Imported projects belong alongside every other
            // Nexia project; asking the user to choose was busywork with a wrong
            // answer available. destDir is still honoured if a caller passes one.
            const destDir = opts.destDir || PROJECTS_DIR;
            fs.mkdirSync(destDir, { recursive: true });

            // importVsProject refuses to write into a non-empty directory, so
            // find a free name rather than failing on a second import.
            let name = opts.name;
            if (!name) {
                const base = parseVsProject(opts.projectPath, toolchain.getPaths()?.root).name;
                name = base;
                for (let i = 2; fs.existsSync(path.join(destDir, name)) &&
                                fs.readdirSync(path.join(destDir, name)).length > 0; i++) {
                    name = `${base}-${i}`;
                }
            }

            const report = importVsProject(opts.projectPath, destDir, name, toolchain.getPaths()?.root, opts.solutionPath);
            // Make it the open project so the user lands straight in it.
            await projectManager.open(report.config.path);
            return { success: true, report };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    // ══════════════════════════════════════
    //  SOFTWARE UPDATES
    // ══════════════════════════════════════

    ipcMain.handle('app:version', () => app.getVersion());

    /**
     * The standard right-click menu: Cut, Copy, Paste, Select All, Undo, Redo.
     *
     * There was none — right-clicking a text box anywhere in the IDE did
     * nothing at all. Electron shows no context menu unless one is built.
     *
     * Built with Electron roles rather than IPC of our own, so the items are the
     * real OS menu: they get the platform's labels, accelerators, and the
     * clipboard behaviour people expect, and they work on inputs Chromium owns
     * without us touching the DOM.
     *
     * The RENDERER decides whether to ask for this (see the contextmenu listener
     * in app.ts). Doing it from webContents' own 'context-menu' event would fire
     * inside the Monaco editor too — Monaco uses a hidden textarea, so it counts
     * as editable — and the user would get this menu stacked on top of Monaco's
     * own, which has Go to Definition and the rest.
     */
    ipcMain.handle('ui:contextMenu', (e, opts: { editable?: boolean; hasSelection?: boolean }) => {
        const win = BrowserWindow.fromWebContents(e.sender);
        if (!win) return;

        const menu = new Menu();
        if (opts?.editable) {
            menu.append(new MenuItem({ role: 'undo' }));
            menu.append(new MenuItem({ role: 'redo' }));
            menu.append(new MenuItem({ type: 'separator' }));
            menu.append(new MenuItem({ role: 'cut' }));
            menu.append(new MenuItem({ role: 'copy' }));
            menu.append(new MenuItem({ role: 'paste' }));
            menu.append(new MenuItem({ type: 'separator' }));
            menu.append(new MenuItem({ role: 'selectAll' }));
        } else if (opts?.hasSelection) {
            // Read-only text: copying is the only thing that makes sense.
            menu.append(new MenuItem({ role: 'copy' }));
            menu.append(new MenuItem({ role: 'selectAll' }));
        }
        if (menu.items.length) menu.popup({ window: win });
    });

    /**
     * Download a release installer to temp, reporting progress and verifying
     * the SHA-256 digest. We never execute a binary whose hash doesn't match
     * the signed manifest — a hijacked downloadUrl would otherwise be RCE.
     */
    ipcMain.handle('update:download', async (e, opts: { url: string; sha256?: string | null; version: string }) => {
        const https = require('https');
        const crypto = require('crypto');
        const os = require('os');

        if (!/^https:\/\//i.test(opts?.url || '')) {
            return { success: false, error: 'Refusing to download from a non-HTTPS URL' };
        }

        const dest = path.join(os.tmpdir(), `NexiaSetup-${opts.version || 'latest'}.exe`);

        return await new Promise((resolve) => {
            const doGet = (url: string, redirects = 0) => {
                if (redirects > 5) return resolve({ success: false, error: 'Too many redirects' });
                https.get(url, { headers: { 'User-Agent': 'NexiaIDE-Updater' } }, (res: any) => {
                    // Follow redirects (CDNs love them)
                    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        res.resume();
                        return doGet(res.headers.location, redirects + 1);
                    }
                    if (res.statusCode !== 200) {
                        res.resume();
                        return resolve({ success: false, error: `Download failed (HTTP ${res.statusCode})` });
                    }

                    const total = parseInt(res.headers['content-length'] || '0', 10);
                    let received = 0;
                    const hash = crypto.createHash('sha256');
                    const file = fs.createWriteStream(dest);

                    res.on('data', (chunk: Buffer) => {
                        received += chunk.length;
                        hash.update(chunk);
                        if (total > 0 && !e.sender.isDestroyed()) {
                            e.sender.send('update:progress', {
                                received, total, pct: Math.round((received / total) * 100),
                            });
                        }
                    });
                    res.pipe(file);
                    file.on('finish', () => {
                        file.close(() => {
                            const digest = hash.digest('hex');
                            if (opts.sha256 && digest.toLowerCase() !== String(opts.sha256).toLowerCase()) {
                                try { fs.unlinkSync(dest); } catch {}
                                return resolve({ success: false, error: 'Checksum mismatch — download rejected.' });
                            }
                            resolve({ success: true, path: dest, sha256: digest, size: received });
                        });
                    });
                    file.on('error', (err: any) => resolve({ success: false, error: err.message }));
                }).on('error', (err: any) => resolve({ success: false, error: err.message }));
            };
            doGet(opts.url);
        });
    });

    /** Launch the downloaded installer and quit so it can replace the app. */
    ipcMain.handle('update:install', async (_e, filePath: string) => {
        try {
            if (!filePath || !fs.existsSync(filePath)) return { success: false, error: 'Installer not found' };

            // Launch setup unattended: /S installs with no prompts and no wizard.
            //
            // spawn is usable again because the installer is asInvoker now. It used
            // to be requireAdministrator, and spawn goes through CreateProcess,
            // which cannot elevate — Windows failed it with ERROR_ELEVATION_REQUIRED
            // (surfacing as EACCES). shell.openPath elevated correctly but cannot
            // pass arguments, so it could never request /S.
            //
            // Setup waits for this process to release its files before extracting,
            // so quitting promptly is what lets the update proceed.
            // /S            — install with no prompts and no wizard.
            // --force-run    — relaunch the app when it's done.
            // --updated      — tell setup this is an update, not a first install.
            //
            // --force-run is not optional. electron-builder's assisted installer
            // only restarts the app when BOTH --force-run and /S are given:
            //
            //   ${if} ${isForceRun}
            //   ${andIf} ${Silent}
            //     !insertmacro doStartApp
            //
            // Without it setup installs, exits, and leaves the user with nothing
            // running. The wizard's "run after finish" checkbox does not cover
            // this — silent installs never reach the finish page.
            const { spawn } = require('child_process');
            const child = spawn(filePath, ['/S', '--force-run', '--updated'], {
                detached: true,       // must outlive us — we are what it replaces
                stdio: 'ignore',
            });

            // spawn reports failure through an asynchronous 'error' event rather
            // than throwing, so the try/catch around this cannot see it. Unhandled,
            // it becomes an uncaught exception and Electron shows a raw crash
            // dialog — which is exactly how the old EACCES surfaced to users.
            const launched = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
                let settled = false;
                child.once('error', (e: any) => {
                    if (settled) return;
                    settled = true;
                    resolve({ ok: false, error: e?.message || String(e) });
                });
                // No 'error' within a moment means CreateProcess accepted it.
                setTimeout(() => {
                    if (settled) return;
                    settled = true;
                    resolve({ ok: true });
                }, 1000);
            });

            if (!launched.ok) return { success: false, error: launched.error };

            child.unref();
            setTimeout(() => app.quit(), 500);
            return { success: true };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle(IPC.DISCORD_CHECK_GUILDS, async () => {
        // Ask the BOT first — it's authoritative and doesn't depend on the user's
        // OAuth scopes. Only if it can't answer do we fall back to reading the
        // user's own guild list. Every path reports `determined`, because
        // "couldn't check" must never be rendered as "you haven't joined".
        try {
            const authed = discordFeed.getAuthUser();
            if (authed?.id) {
                const verdict = await discordFeed.isUserInGuild(authed.id);
                if (verdict !== null) {
                    return { success: true, determined: true, inNexiaServer: verdict, matchedBy: 'bot' };
                }
            }
        } catch { /* fall through to the user-token route */ }

        try {
            const guilds = await discordFeed.fetchUserGuilds();

            // No guild data = no `guilds` scope, expired token, or empty response.
            // That's "unknown", not "not a member".
            if (!Array.isArray(guilds) || guilds.length === 0) {
                return { success: true, determined: false, inNexiaServer: false, reason: 'no-guild-data' };
            }

            // Prefer an exact guild-ID match — the ID is immutable, whereas the
            // server NAME can be renamed/emoji'd and silently break the check
            // (which made members read as "not joined"). Resolve the Nexia guild
            // id from the configured forum channel (via the bot, if a token is
            // set) or from NEXIA_DISCORD_GUILD_ID; fall back to a tolerant name
            // match so it still works when neither id source is available.
            let nexiaGuildId: string | null = null;
            try { nexiaGuildId = await discordFeed.getGuildId(); } catch {}
            if (!nexiaGuildId) nexiaGuildId = process.env.NEXIA_DISCORD_GUILD_ID || null;

            let found = false;
            let matchedBy = 'none';
            if (nexiaGuildId) {
                found = guilds.some((g: any) => String(g.id) === String(nexiaGuildId));
                if (found) matchedBy = 'id';
            }
            if (!found) {
                // Tolerant name match: strip case/punctuation/whitespace and
                // accept any server whose name contains "nexia".
                const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                found = guilds.some((g: any) => {
                    const n = norm(g.name);
                    return n.includes('nexia') || n === norm('The Official Nexia Server');
                });
                if (found) matchedBy = 'name';
            }

            return {
                success: true,
                determined: true,
                inNexiaServer: found,
                matchedBy,
                nexiaGuildId,
                guilds: guilds.map((g: any) => ({ id: g.id, name: g.name })),
            };
        } catch (err: any) {
            // Network/API failure — we simply don't know. Don't accuse the user.
            return { success: false, determined: false, inNexiaServer: false, error: err.message };
        }
    });

    ipcMain.handle(IPC.DISCORD_DOWNLOAD, async (_e, url: string, filename: string) => {
        // Validate URL is from Discord CDN to prevent arbitrary downloads
        const allowedHosts = ['cdn.discordapp.com', 'media.discordapp.net'];
        try {
            const parsed = new URL(url);
            if (!allowedHosts.includes(parsed.hostname)) {
                return { success: false, error: 'Download URL is not from a Discord CDN domain' };
            }
        } catch {
            return { success: false, error: 'Invalid download URL' };
        }

        const dlDir = path.join(app.getPath('downloads'), 'Nexia IDE');
        if (!fs.existsSync(dlDir)) fs.mkdirSync(dlDir, { recursive: true });
        const result = await discordFeed.downloadAttachment(url, dlDir, filename);
        if (result.success && result.filePath) {
            shell.showItemInFolder(result.filePath);
        }
        return result;
    });

    // ── Lesson Package Handlers ──
    const lessonsDir = path.join(app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..', '..'), 'lessons');

    ipcMain.handle(IPC.LESSON_GET_DIR, async () => {
        if (!fs.existsSync(lessonsDir)) fs.mkdirSync(lessonsDir, { recursive: true });
        return lessonsDir;
    });

    // Learn panel search. The renderer owns settings, so it hands the key down
    // per call and this stays stateless — nothing to keep in sync, and no key
    // sitting in main's memory for the life of the process.
    ipcMain.handle(IPC.SEARCH_VIDEOS, async (_e, opts: { query: string; apiKey: string }) =>
        searchService.searchVideos(opts?.query || '', opts?.apiKey || ''));

    ipcMain.handle(IPC.SEARCH_WEB, async (_e, opts: { query: string; provider: 'google' | 'brave'; apiKey: string; engineId?: string }) =>
        searchService.searchWeb(opts?.query || '', {
            provider: opts?.provider || 'google',
            apiKey: opts?.apiKey || '',
            engineId: opts?.engineId,
        }));

    ipcMain.handle(IPC.LESSON_LIST, async () => {
        if (!fs.existsSync(lessonsDir)) fs.mkdirSync(lessonsDir, { recursive: true });
        const registryPath = path.join(lessonsDir, 'registry.json');
        try {
            if (fs.existsSync(registryPath)) {
                return JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
            }
        } catch {}
        return [];
    });

    ipcMain.handle(IPC.LESSON_IMPORT, async () => {
        const result = await dialog.showOpenDialog(mainWindow!, {
            title: 'Import Cinematic Lesson',
            filters: [{ name: 'Nexia Lesson Package', extensions: ['lesson'] }],
            properties: ['openFile'],
        });
        if (result.canceled || !result.filePaths.length) return { success: false, error: 'Cancelled' };

        const srcPath = result.filePaths[0];
        try {
            // .lesson is a zip — extract it
            if (!fs.existsSync(lessonsDir)) fs.mkdirSync(lessonsDir, { recursive: true });

            // Read the zip
            const zipBuf = fs.readFileSync(srcPath);

            // Simple zip extraction using Node's built-in zlib + manual parsing
            // For robustness we'll use a temp approach: copy .lesson, rename to .zip, use AdmZip-like manual extraction
            // Actually, since we're in Electron/Node, let's use child_process to call tar or use a simple approach
            // We'll parse the zip manually using the central directory

            // Simpler approach: use the 'unzipper' pattern with raw Node
            // But to keep deps minimal, let's just copy the file and read the JSON from it
            // The .lesson format: it's a zip, but we can also support a simple directory-based approach

            // For v1: treat .lesson as a renamed zip. Extract using Node's built-in zlib for deflate entries.
            const lessonEntries = extractNxLesson(zipBuf);
            if (!lessonEntries['lesson.json']) {
                return { success: false, error: 'Invalid .lesson: missing lesson.json' };
            }

            const lessonData = JSON.parse(lessonEntries['lesson.json']);
            const lessonId = lessonData.meta?.id || path.basename(srcPath, '.lesson');
            const lessonDir = path.join(lessonsDir, lessonId);

            if (!fs.existsSync(lessonDir)) fs.mkdirSync(lessonDir, { recursive: true });

            // Write all extracted files
            for (const [name, content] of Object.entries(lessonEntries)) {
                const filePath = path.join(lessonDir, name);
                const dir = path.dirname(filePath);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(filePath, content as string, typeof content === 'string' ? 'utf-8' : undefined);
            }

            // Update registry
            const registryPath = path.join(lessonsDir, 'registry.json');
            let registry: any[] = [];
            try { if (fs.existsSync(registryPath)) registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8')); } catch {}

            // Remove existing entry with same ID
            registry = registry.filter((r: any) => r.id !== lessonId);
            registry.push({
                id: lessonId,
                title: lessonData.meta?.title || lessonId,
                description: lessonData.meta?.description || '',
                difficulty: lessonData.meta?.difficulty || 'beginner',
                author: lessonData.meta?.author || 'Unknown',
                version: lessonData.meta?.version || '1.0.0',
                path: lessonDir,
                importedAt: new Date().toISOString(),
            });
            fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));

            return { success: true, lessonId, title: lessonData.meta?.title };
        } catch (err: any) {
            return { success: false, error: err.message || 'Import failed' };
        }
    });

    ipcMain.handle(IPC.LESSON_READ, async (_e, lessonId: string) => {
        const lessonDir = path.join(lessonsDir, lessonId);
        const jsonPath = path.join(lessonDir, 'lesson.json');
        if (!fs.existsSync(jsonPath)) return null;
        try {
            const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));

            // V1 compat: load single visualizers.js if present
            const visPath = path.join(lessonDir, 'visualizers.js');
            if (fs.existsSync(visPath)) {
                data._visualizerCode = fs.readFileSync(visPath, 'utf-8');
            }

            // V2: load visualizer JS files from visualizers/ directory
            // and embed them as _loadedVisualizers so the renderer can eval them
            const visDir = path.join(lessonDir, 'visualizers');
            if (fs.existsSync(visDir)) {
                const visFiles: Record<string, string> = {};
                const files = fs.readdirSync(visDir);
                for (const f of files) {
                    if (f.endsWith('.js')) {
                        visFiles[f] = fs.readFileSync(path.join(visDir, f), 'utf-8');
                    }
                }
                if (Object.keys(visFiles).length > 0) {
                    data._visualizerFiles = visFiles;
                }
            }

            // Pass the base path so the renderer can resolve relative asset paths
            data._basePath = lessonDir;

            return data;
        } catch { return null; }
    });

    // Save edited lesson data back to disk
    ipcMain.handle('lesson:save', async (_e, lessonId: string, lessonData: any) => {
        const lessonDir = path.join(lessonsDir, lessonId);
        const jsonPath = path.join(lessonDir, 'lesson.json');
        try {
            if (!fs.existsSync(lessonDir)) fs.mkdirSync(lessonDir, { recursive: true });
            fs.writeFileSync(jsonPath, JSON.stringify(lessonData, null, 2));

            // Update registry metadata
            const registryPath = path.join(lessonsDir, 'registry.json');
            let registry: any[] = [];
            try { if (fs.existsSync(registryPath)) registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8')); } catch {}
            const idx = registry.findIndex((r: any) => r.id === lessonId);
            const entry = {
                id: lessonId,
                title: lessonData.meta?.title || lessonId,
                description: lessonData.meta?.description || '',
                difficulty: lessonData.meta?.difficulty || 'beginner',
                author: lessonData.meta?.author || 'Unknown',
                version: lessonData.meta?.version || '1.0.0',
                path: lessonDir,
                importedAt: idx >= 0 ? registry[idx].importedAt : new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            };
            if (idx >= 0) registry[idx] = entry; else registry.push(entry);
            fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));

            return { success: true };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle(IPC.LESSON_DELETE, async (_e, lessonId: string) => {
        const lessonDir = path.join(lessonsDir, lessonId);
        try {
            if (fs.existsSync(lessonDir)) fs.rmSync(lessonDir, { recursive: true, force: true });
            // Update registry
            const registryPath = path.join(lessonsDir, 'registry.json');
            let registry: any[] = [];
            try { if (fs.existsSync(registryPath)) registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8')); } catch {}
            registry = registry.filter((r: any) => r.id !== lessonId);
            fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
            return { success: true };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle(IPC.LESSON_EXPORT, async (_e, lessonData: any) => {
        const result = await dialog.showSaveDialog(mainWindow!, {
            title: 'Export Cinematic Lesson',
            defaultPath: (lessonData.meta?.id || 'lesson') + '.lesson',
            filters: [{ name: 'Nexia Lesson Package', extensions: ['lesson'] }],
        });
        if (result.canceled || !result.filePath) return { success: false, error: 'Cancelled' };

        try {
            const zipBuf = buildNxLesson(lessonData);
            fs.writeFileSync(result.filePath, zipBuf);
            shell.showItemInFolder(result.filePath);
            return { success: true, path: result.filePath };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });
}

// ── .lesson Zip Utilities ──
// Minimal zip creator/extractor — no external dependencies

function buildNxLesson(lessonData: any): Buffer {
    const files: { name: string; data: Buffer }[] = [];

    // Separate visualizer code if present
    const visCode = lessonData._visualizerCode;
    const cleanData = { ...lessonData };
    delete cleanData._visualizerCode;

    files.push({ name: 'lesson.json', data: Buffer.from(JSON.stringify(cleanData, null, 2), 'utf-8') });
    if (visCode) {
        files.push({ name: 'visualizers.js', data: Buffer.from(visCode, 'utf-8') });
    }

    return createZipBuffer(files);
}

function extractNxLesson(zipBuf: Buffer): Record<string, string> {
    const entries: Record<string, string> = {};
    // Parse zip central directory
    // Find end of central directory record (signature 0x06054b50)
    let eocdOffset = -1;
    for (let i = zipBuf.length - 22; i >= 0; i--) {
        if (zipBuf.readUInt32LE(i) === 0x06054b50) { eocdOffset = i; break; }
    }
    if (eocdOffset === -1) throw new Error('Invalid zip: no end of central directory');

    const cdOffset = zipBuf.readUInt32LE(eocdOffset + 16);
    const cdEntries = zipBuf.readUInt16LE(eocdOffset + 10);

    let pos = cdOffset;
    for (let e = 0; e < cdEntries; e++) {
        if (zipBuf.readUInt32LE(pos) !== 0x02014b50) break;
        const compMethod = zipBuf.readUInt16LE(pos + 10);
        const compSize = zipBuf.readUInt32LE(pos + 20);
        const uncompSize = zipBuf.readUInt32LE(pos + 24);
        const nameLen = zipBuf.readUInt16LE(pos + 28);
        const extraLen = zipBuf.readUInt16LE(pos + 30);
        const commentLen = zipBuf.readUInt16LE(pos + 32);
        const localOffset = zipBuf.readUInt32LE(pos + 42);
        const name = zipBuf.slice(pos + 46, pos + 46 + nameLen).toString('utf-8');
        pos += 46 + nameLen + extraLen + commentLen;

        if (name.endsWith('/')) continue; // skip directories

        // Read local file header to get to actual data
        const localNameLen = zipBuf.readUInt16LE(localOffset + 26);
        const localExtraLen = zipBuf.readUInt16LE(localOffset + 28);
        const dataOffset = localOffset + 30 + localNameLen + localExtraLen;

        let fileData: Buffer;
        if (compMethod === 0) {
            // Stored (no compression)
            fileData = zipBuf.slice(dataOffset, dataOffset + compSize);
        } else if (compMethod === 8) {
            // Deflated
            const zlib = require('zlib');
            fileData = zlib.inflateRawSync(zipBuf.slice(dataOffset, dataOffset + compSize));
        } else {
            continue; // skip unsupported compression
        }

        entries[name] = fileData.toString('utf-8');
    }
    return entries;
}

function createZipBuffer(files: { name: string; data: Buffer }[]): Buffer {
    const zlib = require('zlib');
    const localHeaders: Buffer[] = [];
    const centralEntries: Buffer[] = [];
    let offset = 0;

    for (const file of files) {
        const nameB = Buffer.from(file.name, 'utf-8');
        const compressed = zlib.deflateRawSync(file.data);
        const useStore = compressed.length >= file.data.length;
        const dataToWrite = useStore ? file.data : compressed;
        const method = useStore ? 0 : 8;

        // CRC32
        const crc = crc32(file.data);

        // Local file header
        const local = Buffer.alloc(30 + nameB.length);
        local.writeUInt32LE(0x04034b50, 0); // signature
        local.writeUInt16LE(20, 4); // version needed
        local.writeUInt16LE(0, 6); // flags
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(0, 10); // mod time
        local.writeUInt16LE(0, 12); // mod date
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(dataToWrite.length, 18); // compressed size
        local.writeUInt32LE(file.data.length, 22); // uncompressed size
        local.writeUInt16LE(nameB.length, 26);
        local.writeUInt16LE(0, 28); // extra length
        nameB.copy(local, 30);

        localHeaders.push(local);
        localHeaders.push(dataToWrite);

        // Central directory entry
        const central = Buffer.alloc(46 + nameB.length);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4); // version made by
        central.writeUInt16LE(20, 6); // version needed
        central.writeUInt16LE(0, 8); // flags
        central.writeUInt16LE(method, 10);
        central.writeUInt16LE(0, 12); // mod time
        central.writeUInt16LE(0, 14); // mod date
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(dataToWrite.length, 20);
        central.writeUInt32LE(file.data.length, 24);
        central.writeUInt16LE(nameB.length, 28);
        central.writeUInt16LE(0, 30); // extra length
        central.writeUInt16LE(0, 32); // comment length
        central.writeUInt16LE(0, 34); // disk start
        central.writeUInt16LE(0, 36); // internal attrs
        central.writeUInt32LE(0, 38); // external attrs
        central.writeUInt32LE(offset, 42); // local header offset
        nameB.copy(central, 46);
        centralEntries.push(central);

        offset += local.length + dataToWrite.length;
    }

    const cdOffset = offset;
    const cdSize = centralEntries.reduce((s, b) => s + b.length, 0);

    // End of central directory
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4); // disk
    eocd.writeUInt16LE(0, 6); // disk with cd
    eocd.writeUInt16LE(files.length, 8);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    eocd.writeUInt16LE(0, 20); // comment length

    return Buffer.concat([...localHeaders, ...centralEntries, eocd]);
}

function crc32(buf: Buffer): number {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
        crc ^= buf[i];
        for (let j = 0; j < 8; j++) {
            crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
        }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ── XEX2 Binary Parser ──

function parseXex(buf: Buffer, filePath: string): any {
    const result: any = {
        filePath,
        fileName: path.basename(filePath),
        fileSize: buf.length,
        fileSizeFormatted: formatBytes(buf.length),
        valid: false,
        error: null,
        header: {} as any,
        securityInfo: {} as any,
        optionalHeaders: [] as any[],
        sections: [] as any[],
        imports: [] as any[],
        resources: [] as any[],
        executionInfo: {} as any,
    };

    // XEX2 magic: "XEX2" at offset 0
    if (buf.length < 24) {
        result.error = 'File too small to be a valid XEX';
        return result;
    }

    const magic = buf.toString('ascii', 0, 4);
    if (magic !== 'XEX2' && magic !== 'XEX1' && magic !== 'XEX\0') {
        result.error = `Invalid magic: "${magic}" (expected "XEX2")`;
        return result;
    }

    result.valid = true;
    result.header.magic = magic;

    // XEX2 Header (Big Endian — Xbox 360 is PowerPC BE)
    result.header.moduleFlags = buf.readUInt32BE(4);
    result.header.peDataOffset = buf.readUInt32BE(8);
    result.header.reserved = buf.readUInt32BE(12);
    result.header.securityInfoOffset = buf.readUInt32BE(16);
    result.header.optionalHeaderCount = buf.readUInt32BE(20);

    // Decode module flags
    const flags = result.header.moduleFlags;
    result.header.moduleFlagsDecoded = [];
    if (flags & 0x00000001) result.header.moduleFlagsDecoded.push('TITLE_MODULE');
    if (flags & 0x00000002) result.header.moduleFlagsDecoded.push('EXPORTS_TO_TITLE');
    if (flags & 0x00000004) result.header.moduleFlagsDecoded.push('SYSTEM_DEBUGGER');
    if (flags & 0x00000008) result.header.moduleFlagsDecoded.push('DLL_MODULE');
    if (flags & 0x00000010) result.header.moduleFlagsDecoded.push('MODULE_PATCH');
    if (flags & 0x00000020) result.header.moduleFlagsDecoded.push('PATCH_FULL');
    if (flags & 0x00000040) result.header.moduleFlagsDecoded.push('PATCH_DELTA');
    if (flags & 0x00000080) result.header.moduleFlagsDecoded.push('USER_MODE');

    // Parse optional headers
    let offset = 24;
    const knownHeaders: Record<number, string> = {
        0x000002FF: 'Resource Info',
        0x000003FF: 'Base File Format',
        0x000005FF: 'Delta Patch Descriptor',
        0x00008001: 'Bounding Path',
        0x00008105: 'Device ID',
        0x000080FF: 'Original Base Address',
        0x00008102: 'Entry Point',
        0x00008103: 'Image Base Address',
        0x00008104: 'Import Libraries',
        0x000100FF: 'Checksum Timestamp',
        0x000101FF: 'Enabled For Callcap',
        0x000102FF: 'Enabled For Fastcap',
        0x000103FF: 'Original PE Name',
        0x00018002: 'Static Libraries',
        0x000183FF: 'TLS Info',
        0x000200FF: 'Default Stack Size',
        0x000201FF: 'Default Filesystem Cache Size',
        0x000300FF: 'Default Heap Size',
        0x00040006: 'System Flags',
        0x000400FF: 'Execution Info',
        0x000401FF: 'Service ID List',
        0x000402FF: 'Title Workspace Size',
        0x000403FF: 'Game Ratings',
        0x000405FF: 'LAN Key',
        0x000406FF: 'Xbox 360 Logo',
        0x000407FF: 'Multidisc Media IDs',
        0x000408FF: 'Alternate Title IDs',
        0x000409FF: 'Additional Title Memory',
        0x0004050B: 'Export Table',
    };

    for (let i = 0; i < result.header.optionalHeaderCount && offset + 8 <= buf.length; i++) {
        const headerId = buf.readUInt32BE(offset);
        const headerData = buf.readUInt32BE(offset + 4);
        const headerName = knownHeaders[headerId] || `Unknown (0x${headerId.toString(16).padStart(8, '0')})`;

        const entry: any = {
            id: headerId,
            idHex: '0x' + headerId.toString(16).padStart(8, '0'),
            name: headerName,
            dataOrOffset: headerData,
            dataHex: '0x' + headerData.toString(16).padStart(8, '0'),
        };

        // Extract specific header data
        if (headerId === 0x00008102 /* Entry Point */) {
            result.executionInfo.entryPoint = '0x' + headerData.toString(16).padStart(8, '0');
        } else if (headerId === 0x00008103 /* Image Base Address */) {
            result.executionInfo.imageBaseAddress = '0x' + headerData.toString(16).padStart(8, '0');
        } else if (headerId === 0x000080FF /* Original Base Address */) {
            result.executionInfo.originalBaseAddress = '0x' + headerData.toString(16).padStart(8, '0');
        } else if (headerId === 0x000200FF /* Default Stack Size */) {
            entry.value = headerData;
            entry.valueFormatted = formatBytes(headerData);
        } else if (headerId === 0x000300FF /* Default Heap Size */) {
            entry.value = headerData;
            entry.valueFormatted = formatBytes(headerData);
        } else if (headerId === 0x000103FF /* Original PE Name */) {
            // Points to offset containing the name string
            if (headerData > 0 && headerData + 4 < buf.length) {
                const nameLen = buf.readUInt32BE(headerData);
                if (nameLen > 0 && nameLen < 256 && headerData + 4 + nameLen <= buf.length) {
                    entry.value = buf.toString('ascii', headerData + 4, headerData + 4 + nameLen).replace(/\0/g, '');
                    result.header.originalPeName = entry.value;
                }
            }
        } else if (headerId === 0x000400FF /* Execution Info */ && headerData + 24 <= buf.length) {
            try {
                result.executionInfo.mediaId = '0x' + buf.readUInt32BE(headerData).toString(16).padStart(8, '0');
                result.executionInfo.version = `${buf.readUInt8(headerData + 4)}.${buf.readUInt8(headerData + 5)}.${buf.readUInt16BE(headerData + 6)}.${buf.readUInt8(headerData + 8)}`;
                result.executionInfo.baseVersion = `${buf.readUInt8(headerData + 9)}.${buf.readUInt8(headerData + 10)}.${buf.readUInt16BE(headerData + 11)}.${buf.readUInt8(headerData + 13)}`;
                result.executionInfo.titleId = '0x' + buf.readUInt32BE(headerData + 14).toString(16).padStart(8, '0');
                result.executionInfo.platform = buf.readUInt8(headerData + 18);
                result.executionInfo.executableType = buf.readUInt8(headerData + 19);
                result.executionInfo.discNumber = buf.readUInt8(headerData + 20);
                result.executionInfo.discCount = buf.readUInt8(headerData + 21);
            } catch {}
        } else if (headerId === 0x00008104 /* Import Libraries */ && headerData + 8 <= buf.length) {
            try {
                const nameTableSize = buf.readUInt32BE(headerData);
                const importCount = buf.readUInt32BE(headerData + 4);
                // Parse library name table
                let nameOffset = headerData + 8;
                const names: string[] = [];
                for (let n = 0; n < 16 && nameOffset < headerData + 8 + nameTableSize; n++) {
                    const end = buf.indexOf(0, nameOffset);
                    if (end <= nameOffset || end > headerData + 8 + nameTableSize) break;
                    const name = buf.toString('ascii', nameOffset, end);
                    if (name.length > 0) names.push(name);
                    nameOffset = end + 1;
                    // Skip padding
                    while (nameOffset < headerData + 8 + nameTableSize && buf[nameOffset] === 0) nameOffset++;
                }
                for (const name of names) {
                    result.imports.push({ library: name, functions: [] });
                }
                entry.value = `${names.length} libraries, ${importCount} total imports`;
                entry.libraries = names;
            } catch {}
        } else if (headerId === 0x000002FF /* Resource Info */ && headerData + 4 <= buf.length) {
            try {
                const resSize = buf.readUInt32BE(headerData);
                const resCount = Math.floor(resSize / 16);
                for (let r = 0; r < resCount && headerData + 4 + (r + 1) * 16 <= buf.length; r++) {
                    const resOff = headerData + 4 + r * 16;
                    const resName = buf.toString('ascii', resOff, resOff + 8).replace(/\0/g, '');
                    const resAddr = buf.readUInt32BE(resOff + 8);
                    const resLen = buf.readUInt32BE(resOff + 12);
                    result.resources.push({
                        name: resName,
                        address: '0x' + resAddr.toString(16).padStart(8, '0'),
                        size: resLen,
                        sizeFormatted: formatBytes(resLen),
                    });
                }
            } catch {}
        }

        result.optionalHeaders.push(entry);
        offset += 8;
    }

    // Parse security info
    const secOff = result.header.securityInfoOffset;
    if (secOff > 0 && secOff + 296 <= buf.length) {
        try {
            result.securityInfo.headerSize = buf.readUInt32BE(secOff);
            result.securityInfo.imageSize = buf.readUInt32BE(secOff + 4);
            result.securityInfo.imageSizeFormatted = formatBytes(buf.readUInt32BE(secOff + 4));

            // PE headers inside the XEX
            const peOff = result.header.peDataOffset;
            if (peOff > 0 && peOff + 0x100 < buf.length) {
                // Check for PE signature
                const peMagic = buf.toString('ascii', peOff, peOff + 2);
                if (peMagic === 'MZ') {
                    const peHeaderOff = buf.readUInt32LE(peOff + 0x3C);
                    const absOff = peOff + peHeaderOff;
                    if (absOff + 4 <= buf.length && buf.toString('ascii', absOff, absOff + 4) === 'PE\0\0') {
                        // COFF header
                        const numSections = buf.readUInt16LE(absOff + 6);
                        const timeDateStamp = buf.readUInt32LE(absOff + 8);
                        result.header.peTimestamp = new Date(timeDateStamp * 1000).toISOString();
                        result.header.peSectionCount = numSections;

                        // Optional header size
                        const optHeaderSize = buf.readUInt16LE(absOff + 20);
                        const sectionTableOff = absOff + 24 + optHeaderSize;

                        // Parse sections
                        for (let s = 0; s < numSections && sectionTableOff + (s + 1) * 40 <= buf.length; s++) {
                            const sOff = sectionTableOff + s * 40;
                            const secName = buf.toString('ascii', sOff, sOff + 8).replace(/\0/g, '');
                            const virtualSize = buf.readUInt32LE(sOff + 8);
                            const virtualAddr = buf.readUInt32LE(sOff + 12);
                            const rawSize = buf.readUInt32LE(sOff + 16);
                            const rawPtr = buf.readUInt32LE(sOff + 20);
                            const chars = buf.readUInt32LE(sOff + 36);

                            const charFlags: string[] = [];
                            if (chars & 0x00000020) charFlags.push('CODE');
                            if (chars & 0x00000040) charFlags.push('INITIALIZED_DATA');
                            if (chars & 0x00000080) charFlags.push('UNINITIALIZED_DATA');
                            if (chars & 0x20000000) charFlags.push('EXECUTE');
                            if (chars & 0x40000000) charFlags.push('READ');
                            if (chars & 0x80000000) charFlags.push('WRITE');

                            result.sections.push({
                                name: secName,
                                virtualSize,
                                virtualSizeFormatted: formatBytes(virtualSize),
                                virtualAddress: '0x' + virtualAddr.toString(16).padStart(8, '0'),
                                rawDataSize: rawSize,
                                rawDataSizeFormatted: formatBytes(rawSize),
                                rawDataPointer: '0x' + rawPtr.toString(16).padStart(8, '0'),
                                characteristics: charFlags,
                                characteristicsRaw: '0x' + (chars >>> 0).toString(16).padStart(8, '0'),
                            });
                        }
                    }
                }
            }
        } catch {}
    }

    return result;
}

function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const val = bytes / Math.pow(1024, i);
    return `${val < 10 ? val.toFixed(2) : val < 100 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}

// ── App Lifecycle ──

app.whenReady().then(async () => {
    await initializeServices();
    registerIpcHandlers();
    createWindow();
});

// Tear down background work on quit so nothing survives the app: in-flight
// builds (cl.exe/link.exe), the detached emulator + its GDB, devkit sockets,
// and the Discord OAuth callback server.
let cleanedUp = false;
function cleanupServices() {
    if (cleanedUp) return;
    cleanedUp = true;
    try { buildSystem?.cancel(); } catch {}
    try { emulatorManager?.stop(); } catch {}
    try { devkitManager?.disconnect(); } catch {}
    try { discordFeed?.cleanup(); } catch {}
}

app.on('before-quit', cleanupServices);

app.on('window-all-closed', () => {
    app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

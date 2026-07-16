/**
 * Xbox 360 SDK Toolchain Detection & Management
 * Handles SDK auto-detection, tool inventory, and path resolution.
 */

import * as path from 'path';
import * as fs from 'fs';
import { execSync, execFileSync } from 'child_process';
import { SdkPaths, SdkTool } from '../shared/types';

/**
 * nexia-core.exe — the SDK search, in C.
 *
 * Beside the JavaScript that calls it, which resolves the same in development
 * and in an install: this file is dist\main\toolchain.js in both, so the binary
 * is always one directory up. Both installers put it there — the delta carries
 * it, and the bootstrap ships it prebuilt because the user has no C compiler.
 */
function corePath(): string {
    return path.join(__dirname, '..', 'nexia-core.exe');
}

export class Toolchain {
    private sdkPaths: SdkPaths | null = null;
    private bundledSdk: boolean = false;

    /**
     * Detect the Xbox 360 SDK.
     *
     * The search itself is nexia-core's now. What was here was seventy lines
     * building a candidate list in a specific order — custom path, then the
     * bundled SDK, then beside the executable, then the environment, then the
     * usual install locations — and that order decides which SDK compiles a
     * user's code on a machine with more than one. It is copied into
     * core/toolchain.c exactly, and core/test/toolchain-parity.js compares the
     * two against the real SDK on every run.
     *
     * The hints exist because C cannot introspect this process: resourcesPath is
     * Electron's and execPath is ours. C decides; we supply the facts only we
     * have.
     */
    async detect(customPath?: string): Promise<SdkPaths | null> {
        const args = ['sdk', 'detect'];
        if (customPath) args.push('--custom', customPath);
        if (process.resourcesPath) args.push('--resources', process.resourcesPath);
        args.push('--exe-dir', path.dirname(process.execPath));

        let out: string;
        try {
            out = execFileSync(corePath(), args, { encoding: 'utf8', windowsHide: true });
        } catch (err: any) {
            // No silent fallback to the old TypeScript. Two live implementations
            // and only one tested means the bug is always in the other one.
            // src/main/_ts-backup holds the previous version if this ever has to
            // be reverted, but that is a decision someone makes, not one the
            // program makes at runtime.
            throw new Error(
                `Couldn't run nexia-core.exe, so the Xbox 360 SDK can't be located.\n` +
                `Expected it at: ${corePath()}\n${err.message}`);
        }

        const res = JSON.parse(out);
        if (!res.sdk) { this.sdkPaths = null; return null; }

        this.bundledSdk = !!res.sdk.bundled;
        this.sdkPaths = {
            root: res.sdk.root,
            bin: res.sdk.bin,
            binWin32: res.sdk.binWin32,
            binX64: res.sdk.binX64,
            include: res.sdk.include,
            lib: res.sdk.lib,
            doc: res.sdk.doc,
            source: res.sdk.source,
            system: res.sdk.system,
        };
        return this.sdkPaths;
    }

    /**
     * Whether the currently loaded SDK is the bundled one.
     */
    isBundled(): boolean {
        return this.bundledSdk;
    }

    /**
     * Manually set the SDK path.
     */
    async configure(sdkPath: string): Promise<SdkPaths | null> {
        return this.detect(sdkPath);
    }

    /**
     * Get current SDK paths.
     */
    getPaths(): SdkPaths | null {
        return this.sdkPaths;
    }

    /**
     * Get the full path to a specific tool.
     */
    getToolPath(toolName: string): string | null {
        if (!this.sdkPaths) return null;
        // The search order — binwin32, then binwin64, then bin, each tried
        // with and without .exe — lives in nexia-core now, not in two places.
        try {
            const res = JSON.parse(execFileSync(corePath(), ['sdk', 'tool', toolName, '--custom', this.sdkPaths.root],
                { encoding: 'utf8', windowsHide: true }));
            return res.path || null;
        } catch { return null; }
    }

    /**
     * Get all available bin directories for PATH construction.
     */
    getBinDirectories(): string[] {
        if (!this.sdkPaths) return [];
        const dirs: string[] = [];
        const candidates = [
            this.sdkPaths.binWin32,
            this.sdkPaths.binX64,
            this.sdkPaths.bin,
        ];
        for (const d of candidates) {
            if (fs.existsSync(d)) dirs.push(d);
        }
        return dirs;
    }

    /**
     * Build the environment for running SDK tools.
     */
    getToolEnvironment(): NodeJS.ProcessEnv {
        const env = { ...process.env };

        // Ensure critical Windows env vars survive into child processes.
        // Packaged Electron apps can lose these, causing shell: true to fail
        // with "spawn cmd.exe ENOENT".
        if (!env.ComSpec) {
            env.ComSpec = process.env.ComSpec || `${process.env.SystemRoot || 'C:\\WINDOWS'}\\system32\\cmd.exe`;
        }
        if (!env.SystemRoot) {
            env.SystemRoot = process.env.SystemRoot || 'C:\\WINDOWS';
        }

        if (this.sdkPaths) {
            const binDirs = this.getBinDirectories();
            env.PATH = binDirs.join(path.delimiter) + path.delimiter + (env.PATH || '');
            env.XEDK = this.sdkPaths.root;
            // Xbox-specific headers must come first in INCLUDE to prevent
            // cl.exe from finding Source\crt\ internal headers
            const xboxInc = path.join(this.sdkPaths.include, 'xbox');
            if (fs.existsSync(xboxInc)) {
                env.INCLUDE = xboxInc + path.delimiter + this.sdkPaths.include + path.delimiter + (env.INCLUDE || '');
            } else {
                env.INCLUDE = this.sdkPaths.include + path.delimiter + (env.INCLUDE || '');
            }
            env.LIB = path.join(this.sdkPaths.lib, 'xbox') + path.delimiter + (env.LIB || '');
        }
        return env;
    }

    /**
     * Check that required Visual C++ runtime DLLs are available.
     * The Xbox 360 SDK tools (cl.exe, link.exe, etc.) are MSVC 2010 era
     * and require the VC++ 2010 Redistributable (msvcr100.dll, msvcp100.dll).
     * Returns a list of missing DLL names, or empty if all are found.
     */
    checkRuntimeDependencies(): { missing: string[]; hint: string } {
        // nexia-core searches the same places in the same order: the SDK bin
        // directories first, then SysWOW64, then System32. The hint stays here
        // because it is a sentence, not a search.
        //
        // On failure this reports nothing missing rather than everything. The
        // caller turns a non-empty list into "your SDK is broken", and a
        // nexia-core that would not start is not evidence that msvcr100.dll is
        // absent — it would send people deleting DLLs to fix the wrong problem.
        let missing: string[] = [];
        try {
            const res = JSON.parse(execFileSync(corePath(), ['sdk', 'runtime'],
                { encoding: 'utf8', windowsHide: true }));
            missing = res.missing || [];
        } catch { /* see above */ }

        return {
            missing,
            hint: 'Copy msvcr100.dll and msvcp100.dll from C:\\Windows\\SysWOW64 into the sdk\\bin\\win32 folder, then rebuild the IDE.',
        };
    }

    /**
     * Detect a partial SDK installation — has bin/ but missing include/ and lib/.
     * This happens when the Xbox 360 SDK installer runs without VS2010 detected,
     * which limits it to a "Minimum Installation" that omits headers and libraries.
     *
     * Returns:
     *   - 'none'    — No SDK found at all
     *   - 'partial' — SDK found with bin/ but missing include/ or lib/
     *   - 'full'    — SDK found with all required directories
     */
    detectInstallState(): 'none' | 'partial' | 'full' {
        // nexia-core walks the same candidates detect() does and reports the
        // best state it finds, so the two can't disagree about which SDK they
        // are describing — which they could when this kept its own shorter list.
        try {
            const args = ['sdk', 'state'];
            if (process.resourcesPath) args.push('--resources', process.resourcesPath);
            args.push('--exe-dir', path.dirname(process.execPath));
            const res = JSON.parse(execFileSync(corePath(), args, { encoding: 'utf8', windowsHide: true }));
            return res.state;
        } catch {
            // Only reachable if nexia-core is missing, which detect() has
            // already failed loudly about. Callers use this to decide whether to
            // offer SDK setup, so 'none' sends them somewhere useful.
            return 'none';
        }
    }

    /**
     * Get the path of a detected partial SDK install (for display purposes).
     */
    getPartialInstallPath(): string | null {
        const candidates: string[] = [];

        for (const v of ['XEDK', 'XEDK_DIR', 'XBOX_SDK', 'XDK']) {
            if (process.env[v]) candidates.push(process.env[v]!);
        }

        candidates.push(
            'C:\\Program Files (x86)\\Microsoft Xbox 360 SDK',
            'C:\\Program Files\\Microsoft Xbox 360 SDK',
            'D:\\Microsoft Xbox 360 SDK',
            'C:\\XEDK',
            'D:\\XEDK',
            'C:\\Program Files (x86)\\Microsoft Xbox SDK',
        );

        for (const sdkPath of candidates) {
            if (!sdkPath || !fs.existsSync(sdkPath)) continue;
            const hasBin = fs.existsSync(path.join(sdkPath, 'bin'));
            const hasInclude = fs.existsSync(path.join(sdkPath, 'include'));
            if (hasBin && !hasInclude) return sdkPath;
        }
        return null;
    }

    /**
     * Check if real Visual Studio 2010 is installed (not our fake keys).
     */
    private isRealVS2010Installed(): boolean {
        const paths = [
            'C:\\Program Files (x86)\\Microsoft Visual Studio 10.0\\Common7\\IDE\\devenv.exe',
            'C:\\Program Files\\Microsoft Visual Studio 10.0\\Common7\\IDE\\devenv.exe',
        ];
        return paths.some(p => fs.existsSync(p));
    }

    /**
     * Check if our fake VS2010 registry marker already exists.
     */
    private hasFakeVSMarker(): boolean {
        try {
            execSync('reg query "HKLM\\SOFTWARE\\Wow6432Node\\Microsoft\\VisualStudio\\10.0" /v "NexiaIDEFakeVS"', { stdio: 'pipe' });
            return true;
        } catch {
            try {
                execSync('reg query "HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\10.0" /v "NexiaIDEFakeVS"', { stdio: 'pipe' });
                return true;
            } catch {
                return false;
            }
        }
    }

    /**
     * Create fake VS2010 registry keys so the Xbox 360 SDK installer
     * enables the "Full Installation" option.
     *
     * SAFETY:
     *   - Only writes to HKLM\SOFTWARE\Microsoft\VisualStudio\10.0
     *   - These are application-level keys, NOT system/boot/driver keys
     *   - Windows does not use these keys for any OS functionality
     *   - Will not overwrite a real VS2010 installation
     *   - Creates a NexiaIDEFakeVS marker for safe cleanup
     *
     * Returns { success, message } indicating outcome.
     */
    prepSdkRegistry(): { success: boolean; message: string } {
        // Safety: don't overwrite real VS2010
        if (this.isRealVS2010Installed()) {
            return {
                success: false,
                message: 'Visual Studio 2010 is already installed. You can run the SDK installer directly and select "Full Installation".',
            };
        }

        // Safety: check if SDK is already fully installed
        if (this.detectInstallState() === 'full') {
            return {
                success: false,
                message: 'The Xbox 360 SDK is already fully installed with include/ and lib/ directories.',
            };
        }

        try {
            const cmds = [
                // Marker so cleanup knows these are ours
                'reg add "HKLM\\SOFTWARE\\Wow6432Node\\Microsoft\\VisualStudio\\10.0" /v "NexiaIDEFakeVS" /t REG_SZ /d "1" /f',
                'reg add "HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\10.0" /v "NexiaIDEFakeVS" /t REG_SZ /d "1" /f',

                // Wow6432Node keys (64-bit Windows)
                'reg add "HKLM\\SOFTWARE\\Wow6432Node\\Microsoft\\VisualStudio\\10.0" /v "InstallDir" /t REG_SZ /d "C:\\Program Files (x86)\\Microsoft Visual Studio 10.0\\Common7\\IDE\\" /f',
                'reg add "HKLM\\SOFTWARE\\Wow6432Node\\Microsoft\\VisualStudio\\10.0\\Setup\\VS" /v "ProductDir" /t REG_SZ /d "C:\\Program Files (x86)\\Microsoft Visual Studio 10.0\\" /f',
                'reg add "HKLM\\SOFTWARE\\Wow6432Node\\Microsoft\\VisualStudio\\10.0\\Setup\\VS" /v "EnvironmentDirectory" /t REG_SZ /d "C:\\Program Files (x86)\\Microsoft Visual Studio 10.0\\Common7\\IDE\\" /f',
                'reg add "HKLM\\SOFTWARE\\Wow6432Node\\Microsoft\\VisualStudio\\10.0\\Setup\\VS" /v "EnvironmentPath" /t REG_SZ /d "C:\\Program Files (x86)\\Microsoft Visual Studio 10.0\\Common7\\IDE\\devenv.exe" /f',
                'reg add "HKLM\\SOFTWARE\\Wow6432Node\\Microsoft\\VisualStudio\\10.0\\Setup\\VC" /v "ProductDir" /t REG_SZ /d "C:\\Program Files (x86)\\Microsoft Visual Studio 10.0\\VC\\" /f',

                // Native keys (32-bit fallback)
                'reg add "HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\10.0" /v "InstallDir" /t REG_SZ /d "C:\\Program Files (x86)\\Microsoft Visual Studio 10.0\\Common7\\IDE\\" /f',
                'reg add "HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\10.0\\Setup\\VS" /v "ProductDir" /t REG_SZ /d "C:\\Program Files (x86)\\Microsoft Visual Studio 10.0\\" /f',
                'reg add "HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\10.0\\Setup\\VS" /v "EnvironmentDirectory" /t REG_SZ /d "C:\\Program Files (x86)\\Microsoft Visual Studio 10.0\\Common7\\IDE\\" /f',
                'reg add "HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\10.0\\Setup\\VS" /v "EnvironmentPath" /t REG_SZ /d "C:\\Program Files (x86)\\Microsoft Visual Studio 10.0\\Common7\\IDE\\devenv.exe" /f',
                'reg add "HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\10.0\\Setup\\VC" /v "ProductDir" /t REG_SZ /d "C:\\Program Files (x86)\\Microsoft Visual Studio 10.0\\VC\\" /f',
            ];

            for (const cmd of cmds) {
                execSync(cmd, { stdio: 'pipe', windowsHide: true });
            }

            return {
                success: true,
                message: 'Registry keys created. You can now run the Xbox 360 SDK installer and select "Full Installation". After installing, click "Clean Up Registry Keys" to remove the fake entries.',
            };
        } catch (e: any) {
            if (e.message && e.message.includes('Access is denied')) {
                return {
                    success: false,
                    message: 'Access denied. Please run Nexia IDE as Administrator to modify registry keys.',
                };
            }
            return {
                success: false,
                message: `Failed to create registry keys: ${e.message || e}`,
            };
        }
    }

    /**
     * Remove the fake VS2010 registry keys created by prepSdkRegistry().
     *
     * SAFETY:
     *   - Only removes keys if the NexiaIDEFakeVS marker is present
     *   - Will not delete real VS2010 keys
     *   - Removes individual values first, only deletes parent keys if empty
     */
    cleanupSdkRegistry(): { success: boolean; message: string } {
        // Safety: check our marker exists
        if (!this.hasFakeVSMarker()) {
            return {
                success: false,
                message: 'No Nexia IDE registry keys found to clean up.',
            };
        }

        // Safety: warn if real VS2010 appeared since prep
        if (this.isRealVS2010Installed()) {
            return {
                success: false,
                message: 'Visual Studio 2010 appears to have been installed. Removing registry keys could break it. Cleanup skipped.',
            };
        }

        try {
            const cmds = [
                // Remove sub-keys first (deepest first)
                'reg delete "HKLM\\SOFTWARE\\Wow6432Node\\Microsoft\\VisualStudio\\10.0\\Setup\\VC" /f',
                'reg delete "HKLM\\SOFTWARE\\Wow6432Node\\Microsoft\\VisualStudio\\10.0\\Setup\\VS" /f',
                'reg delete "HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\10.0\\Setup\\VC" /f',
                'reg delete "HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\10.0\\Setup\\VS" /f',

                // Remove our specific values from the 10.0 key
                'reg delete "HKLM\\SOFTWARE\\Wow6432Node\\Microsoft\\VisualStudio\\10.0" /v "InstallDir" /f',
                'reg delete "HKLM\\SOFTWARE\\Wow6432Node\\Microsoft\\VisualStudio\\10.0" /v "NexiaIDEFakeVS" /f',
                'reg delete "HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\10.0" /v "InstallDir" /f',
                'reg delete "HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\10.0" /v "NexiaIDEFakeVS" /f',
            ];

            for (const cmd of cmds) {
                try {
                    execSync(cmd, { stdio: 'pipe', windowsHide: true });
                } catch {
                    // Ignore errors for individual deletions (key may not exist)
                }
            }

            // Try to clean up empty parent keys — ignore errors if they have other sub-keys
            const parentCleanup = [
                'reg delete "HKLM\\SOFTWARE\\Wow6432Node\\Microsoft\\VisualStudio\\10.0\\Setup" /f',
                'reg delete "HKLM\\SOFTWARE\\Wow6432Node\\Microsoft\\VisualStudio\\10.0" /f',
                'reg delete "HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\10.0\\Setup" /f',
                'reg delete "HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\10.0" /f',
            ];
            for (const cmd of parentCleanup) {
                try { execSync(cmd, { stdio: 'pipe', windowsHide: true }); } catch {}
            }

            return {
                success: true,
                message: 'Fake VS2010 registry keys removed. Your SDK installation is unaffected.',
            };
        } catch (e: any) {
            if (e.message && e.message.includes('Access is denied')) {
                return {
                    success: false,
                    message: 'Access denied. Please run Nexia IDE as Administrator to clean up registry keys.',
                };
            }
            return {
                success: false,
                message: `Failed to clean up registry keys: ${e.message || e}`,
            };
        }
    }

    /**
     * Get a categorized inventory of all SDK tools.
     * Scans bin directories for all .exe files and categorizes them.
     */
    getToolInventory(): SdkTool[] {
        if (!this.sdkPaths) return [];

        // Known tools with descriptions, categories, and GUI flags.
        // Anything not listed here is discovered automatically as 'other' CLI tool.
        const knownTools: Record<string, { desc: string; category: SdkTool['category']; gui?: boolean }> = {
            // Compiler & Linker
            'cl.exe':           { desc: 'Xbox 360 C/C++ Compiler', category: 'compiler' },
            'link.exe':         { desc: 'Xbox 360 Linker', category: 'linker' },
            'lib.exe':          { desc: 'Library Manager', category: 'linker' },
            'ml.exe':           { desc: 'Macro Assembler', category: 'compiler' },
            'nmake.exe':        { desc: 'Build Utility', category: 'compiler' },

            // Shader Tools
            'fxc.exe':          { desc: 'Effect/Shader Compiler', category: 'shader' },
            'xgpudiag.exe':     { desc: 'GPU Diagnostics', category: 'shader' },

            // Audio Tools
            'xma2encode.exe':   { desc: 'XMA2 Audio Encoder', category: 'audio' },
            'xwmaencode.exe':   { desc: 'xWMA Audio Encoder', category: 'audio' },
            'xact3.exe':        { desc: 'XACT Audio Authoring Tool', category: 'audio', gui: true },
            'xactbld3.exe':     { desc: 'XACT Build Tool', category: 'audio' },
            'audconsole3.exe':  { desc: 'Audio Console', category: 'audio', gui: true },
            'wavmerge.exe':     { desc: 'WAV Merge Tool', category: 'audio' },

            // XUI Tools
            'xuicompile.exe':   { desc: 'XUI Skin Compiler', category: 'xui' },
            'makexui.exe':      { desc: 'XUI Compiler', category: 'xui' },
            'xui2bin.exe':      { desc: 'XUI to Binary Converter', category: 'xui' },
            'xui2resx.exe':     { desc: 'XUI to RESX Converter', category: 'xui' },
            'xuifont.exe':      { desc: 'XUI Font Tool', category: 'xui' },
            'xuipkg.exe':       { desc: 'XUI Package Tool', category: 'xui' },
            'xuiver.exe':       { desc: 'XUI Version Tool', category: 'xui' },
            'XuiTool.exe':      { desc: 'XUI Visual Tool', category: 'xui', gui: true },
            'resx2bin.exe':     { desc: 'RESX to Binary Converter', category: 'xui' },
            'resx2xui.exe':     { desc: 'RESX to XUI Converter', category: 'xui' },
            'resxloc.exe':      { desc: 'RESX Localisation Tool', category: 'xui' },

            // Binary / Packaging
            'imagexex.exe':     { desc: 'XEX Image Builder', category: 'utility' },
            'xexdump.exe':      { desc: 'XEX Dumper', category: 'utility' },
            'xexpdb.exe':       { desc: 'XEX PDB Tool', category: 'utility' },
            'deltaxex.exe':     { desc: 'XEX Delta Patcher', category: 'utility' },
            'lzxcompress.exe':  { desc: 'LZX Compression', category: 'utility' },
            'xbcompress.exe':   { desc: 'Xbox Compression', category: 'utility' },
            'xbdecompress.exe': { desc: 'Xbox Decompression', category: 'utility' },
            'bundler.exe':      { desc: 'Resource Bundler', category: 'utility' },
            'Bundler.exe':      { desc: 'Resource Bundler', category: 'utility' },
            'UnBundler.exe':    { desc: 'Resource UnBundler', category: 'utility' },
            'makefont.exe':     { desc: 'Font Compiler', category: 'utility' },
            'dumpbin.exe':      { desc: 'Binary Dumper', category: 'utility' },
            'editbin.exe':      { desc: 'Binary Editor', category: 'utility' },
            'pdbinfo.exe':      { desc: 'PDB Info', category: 'utility' },
            'spac.exe':         { desc: 'SPA Compiler', category: 'utility' },
            'spac2.exe':        { desc: 'SPA Compiler v2', category: 'utility' },
            'gdf2content.exe':  { desc: 'GDF to Content Converter', category: 'utility' },
            'gdf2file.exe':     { desc: 'GDF to File Converter', category: 'utility' },
            'gsubval.exe':      { desc: 'Submission Validator', category: 'utility' },
            'blast.exe':        { desc: 'BLAST Tool', category: 'utility' },
            'subval.exe':       { desc: 'Submission Validator', category: 'utility' },
            'xlast.exe':        { desc: 'XLAST Tool', category: 'utility' },
            'pkgsig.dll':       { desc: 'Package Signing', category: 'utility' },
            'pgocvt.exe':       { desc: 'PGO Converter', category: 'utility' },
            'pgodump.exe':      { desc: 'PGO Dump', category: 'utility' },
            'pgomgr.exe':       { desc: 'PGO Manager', category: 'utility' },
            'PgoLite.exe':      { desc: 'PGO Lite', category: 'utility' },

            // Content / Disc
            'ContentExporter.exe':  { desc: 'Content Exporter', category: 'utility', gui: true },
            'FontMaker.exe':        { desc: 'Font Maker', category: 'utility', gui: true },
            'FontPacker.exe':       { desc: 'Font Packer', category: 'utility' },
            'CopyGlyphs.exe':       { desc: 'Glyph Copy Tool', category: 'utility' },
            'xbGameDisc.exe':       { desc: 'Game Disc Builder', category: 'utility', gui: true },
            'xbGameDisc_old.exe':   { desc: 'Game Disc Builder (Legacy)', category: 'utility', gui: true },
            'XDiscBld.exe':         { desc: 'Disc Builder', category: 'utility', gui: true },
            'xDiscBld_old.exe':     { desc: 'Disc Builder (Legacy)', category: 'utility', gui: true },
            'ArcadeLicense.exe':    { desc: 'Arcade License Tool', category: 'utility', gui: true },
            'DLCLicense.exe':       { desc: 'DLC License Tool', category: 'utility', gui: true },

            // Devkit Tools
            'xbreboot.exe':     { desc: 'Reboot Console', category: 'devkit' },
            'xbcp.exe':         { desc: 'File Copy to Console', category: 'devkit' },
            'xbdel.exe':        { desc: 'Delete File on Console', category: 'devkit' },
            'xbdir.exe':        { desc: 'List Console Files', category: 'devkit' },
            'xbmkdir.exe':      { desc: 'Create Console Directory', category: 'devkit' },
            'xbcapture.exe':    { desc: 'Capture Screenshot', category: 'devkit' },
            'xbsetcfg.exe':     { desc: 'Console Configuration', category: 'devkit' },
            'xbconnect.exe':    { desc: 'Connect to Console', category: 'devkit' },
            'xbmanage.exe':     { desc: 'Console Manager', category: 'devkit' },
            'xbconsoletype.exe':{ desc: 'Console Type Info', category: 'devkit' },
            'xbecopy.exe':      { desc: 'Copy Executable to Console', category: 'devkit' },
            'xbren.exe':        { desc: 'Rename File on Console', category: 'devkit' },
            'xbrights.exe':     { desc: 'Console Rights', category: 'devkit' },
            'xbnetstat.exe':    { desc: 'Console Network Stats', category: 'devkit' },
            'xbmemdump.exe':    { desc: 'Console Memory Dump', category: 'devkit' },
            'xbscale.exe':      { desc: 'Console Scale Tool', category: 'devkit' },
            'xbmovie.exe':      { desc: 'Console Movie Player', category: 'devkit', gui: true },
            'xbwatson.exe':     { desc: 'Console Crash Dump Viewer', category: 'devkit', gui: true },

            // Debug & Profile
            'pix.exe':          { desc: 'PIX Performance Analyzer', category: 'profiler', gui: true },
            'psa.exe':          { desc: 'Performance Session Analyzer', category: 'profiler', gui: true },
            'vsa.exe':          { desc: 'Visual Session Analyzer', category: 'profiler', gui: true },
            'xbperfview.exe':   { desc: 'Performance Viewer', category: 'profiler', gui: true },
            'xbpg.exe':         { desc: 'Performance Guide', category: 'profiler', gui: true },
            'xkd.exe':          { desc: 'Kernel Debugger', category: 'debug' },
            'windbg.exe':       { desc: 'Windows Debugger', category: 'debug', gui: true },
            'remote.exe':       { desc: 'Remote Debug', category: 'debug' },
            'TraceDump.exe':    { desc: 'Trace Dump', category: 'debug' },
            'FilterTraceOutput.exe': { desc: 'Trace Output Filter', category: 'debug' },
            'XBTrigger.exe':    { desc: 'Xbox Trigger Tool', category: 'debug' },
            'NetGrove.exe':     { desc: 'Network Analyzer', category: 'debug', gui: true },
            'ApiMon.exe':       { desc: 'API Monitor', category: 'debug', gui: true },

            // Emulation
            'xbEmulate.exe':    { desc: 'Xbox Emulator (CLI)', category: 'debug' },
            'xbEmulateGUI.exe': { desc: 'Xbox Emulator', category: 'debug', gui: true },

            // Avatar / Kinect / Speech
            'AvatarPreviewerPC.exe':    { desc: 'Avatar Previewer', category: 'other', gui: true },
            'AvatarAssetConverter_e.exe':{ desc: 'Avatar Asset Converter', category: 'other' },
            'AvatarAssetMetadata.exe':  { desc: 'Avatar Asset Metadata', category: 'other' },
            'AvatarAssetVerifier.exe':  { desc: 'Avatar Asset Verifier', category: 'other' },
            'AvatarPreviewerAssetUtility.exe': { desc: 'Avatar Asset Utility', category: 'other' },
            'VisualGestureBuilder.exe': { desc: 'Gesture Builder', category: 'other', gui: true },
            'AdaBoostGenerateLabeledExamples.exe': { desc: 'AdaBoost Label Generator', category: 'other' },
            'AdaBoostRuntime.exe':      { desc: 'AdaBoost Runtime', category: 'other' },
            'AdaBoostTrainGesture32.exe': { desc: 'AdaBoost Trainer (32-bit)', category: 'other' },
            'AdaBoostTrainGesture64.exe': { desc: 'AdaBoost Trainer (64-bit)', category: 'other' },
            'AdaBoostTriggerTrainer.exe': { desc: 'AdaBoost Trigger Trainer', category: 'other' },
            'PCAProgressRuntime.exe':   { desc: 'PCA Progress Runtime', category: 'other' },
            'PCAProgressTrainer.exe':   { desc: 'PCA Progress Trainer', category: 'other' },
            'RFRProgressRuntime.exe':   { desc: 'RFR Progress Runtime', category: 'other' },
            'RFRProgressTrainer.exe':   { desc: 'RFR Progress Trainer', category: 'other' },
            'PipelineAnimation.exe':    { desc: 'Pipeline Animation Tool', category: 'other' },
            'xbspeechlab.exe':  { desc: 'Speech Lab', category: 'other', gui: true },
            'xbspeechprep.exe': { desc: 'Speech Prep', category: 'other' },
            'xscmd.exe':        { desc: 'Xbox Script Command', category: 'utility' },
            'xsd.exe':          { desc: 'XML Schema Tool', category: 'utility' },
            'XStudio.exe':      { desc: 'Xbox Studio', category: 'other', gui: true },

            // IME / Localization
            'jpimedic2xe.exe':      { desc: 'Japanese IME Dictionary', category: 'other' },
            'ximecandidatefilter.exe': { desc: 'IME Candidate Filter', category: 'other' },
            'make100.exe':          { desc: 'IME Dictionary Maker', category: 'other' },
            'maketrie.exe':         { desc: 'Trie Builder', category: 'other' },

            // Testing
            'DeepLinkingTestTool.exe': { desc: 'Deep Linking Test Tool', category: 'debug' },
            'Microsoft.Test.Xbox.Profiles.dll': { desc: 'Test Profiles', category: 'debug' },

            // Internal / Build support (not shown but still valid)
            'mspdbsrvx.exe':    { desc: 'PDB Server', category: 'compiler' },
            'disp100.exe':      { desc: 'Dispatch Helper', category: 'compiler' },
            'devenvTP10.exe':   { desc: 'VS Integration Helper', category: 'compiler' },
        };

        // Scan all bin directories for .exe files
        const tools: SdkTool[] = [];
        const seen = new Set<string>();
        const searchDirs = this.getBinDirectories();

        for (const dir of searchDirs) {
            if (!fs.existsSync(dir)) continue;
            let entries: string[];
            try { entries = fs.readdirSync(dir); } catch { continue; }

            for (const entry of entries) {
                if (!/\.exe$/i.test(entry)) continue;
                if (seen.has(entry.toLowerCase())) continue;
                seen.add(entry.toLowerCase());

                const toolPath = path.join(dir, entry);
                const known = knownTools[entry];

                tools.push({
                    name: entry,
                    path: toolPath,
                    description: known?.desc || entry.replace(/\.exe$/i, ''),
                    category: known?.category || 'other',
                    gui: known?.gui || false,
                });
            }
        }

        // Sort: known categories first, then alphabetically within each category
        const categoryOrder: Record<string, number> = {
            compiler: 0, linker: 1, shader: 2, audio: 3, xui: 4,
            utility: 5, devkit: 6, debug: 7, profiler: 8, other: 9,
        };
        tools.sort((a, b) => {
            const catDiff = (categoryOrder[a.category] ?? 99) - (categoryOrder[b.category] ?? 99);
            return catDiff !== 0 ? catDiff : a.name.localeCompare(b.name);
        });

        return tools;
    }
}

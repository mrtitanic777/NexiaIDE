/**
 * Extensions Manager
 * Handles importing, installing, enabling/disabling, and removing IDE extensions.
 * Extensions are stored in ~/.nexia-ide/extensions/ with a manifest.json each.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';

export interface ExtensionManifest {
    id: string;
    name: string;
    version: string;
    author: string;
    description: string;
    type: 'tool' | 'template' | 'snippet' | 'theme' | 'library' | 'plugin';
    icon?: string;             // Emoji or path to icon
    homepage?: string;         // URL
    files?: string[];          // List of files included
    entryPoint?: string;       // Main script for plugins
    tags?: string[];
}

export interface InstalledExtension {
    manifest: ExtensionManifest;
    path: string;
    enabled: boolean;
    installedAt: string;       // ISO date
}

interface ExtensionsState {
    extensions: { [id: string]: { enabled: boolean; installedAt: string } };
}

export class ExtensionManager {
    private extensionsDir: string;
    private stateFile: string;
    private state: ExtensionsState;
    private onOutput: ((data: string) => void) | null = null;

    constructor() {
        const nexiaDir = path.join(os.homedir(), '.nexia-ide');
        this.extensionsDir = path.join(nexiaDir, 'extensions');
        this.stateFile = path.join(nexiaDir, 'extensions-state.json');

        // Ensure directories exist
        fs.mkdirSync(this.extensionsDir, { recursive: true });

        // Load state
        this.state = this.loadState();
    }

    setOutputCallback(cb: (data: string) => void) {
        this.onOutput = cb;
    }

    private emit(msg: string) {
        if (this.onOutput) this.onOutput(msg);
    }

    private loadState(): ExtensionsState {
        try {
            if (fs.existsSync(this.stateFile)) {
                return JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
            }
        } catch (e) {
            console.error('Failed to load extensions state:', e);
        }
        return { extensions: {} };
    }

    private saveState() {
        try {
            fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
        } catch (err: any) {
            this.emit(`Failed to save extensions state: ${err.message}\n`);
        }
    }

    /**
     * List all installed extensions.
     */
    getInstalled(): InstalledExtension[] {
        const results: InstalledExtension[] = [];
        try {
            const entries = fs.readdirSync(this.extensionsDir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const extDir = path.join(this.extensionsDir, entry.name);
                const manifestPath = path.join(extDir, 'manifest.json');
                if (!fs.existsSync(manifestPath)) continue;
                try {
                    const manifest: ExtensionManifest = JSON.parse(
                        fs.readFileSync(manifestPath, 'utf-8')
                    );
                    const stateEntry = this.state.extensions[manifest.id];
                    results.push({
                        manifest,
                        path: extDir,
                        enabled: stateEntry ? stateEntry.enabled : true,
                        installedAt: stateEntry ? stateEntry.installedAt : new Date().toISOString(),
                    });
                } catch (e) {
                    console.error(`Failed to parse manifest for extension "${entry.name}":`, e);
                }
            }
        } catch (e) {
            console.error('Failed to scan extensions directory:', e);
        }
        return results.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
    }

    /**
     * Install an extension from a folder path.
     * Copies the folder into the extensions directory.
     */
    async installFromFolder(folderPath: string): Promise<InstalledExtension> {
        const manifestPath = path.join(folderPath, 'manifest.json');
        if (!fs.existsSync(manifestPath)) {
            throw new Error('No manifest.json found in the selected folder.');
        }

        const manifest: ExtensionManifest = JSON.parse(
            fs.readFileSync(manifestPath, 'utf-8')
        );

        if (!manifest.id || !manifest.name || !manifest.version) {
            throw new Error('Invalid manifest: requires id, name, and version fields.');
        }

        const destDir = path.join(this.extensionsDir, manifest.id);

        // Remove existing if reinstalling
        if (fs.existsSync(destDir)) {
            fs.rmSync(destDir, { recursive: true, force: true });
        }

        // Copy folder
        this.copyDir(folderPath, destDir);

        // Update state
        this.state.extensions[manifest.id] = {
            enabled: true,
            installedAt: new Date().toISOString(),
        };
        this.saveState();

        this.emit(`✅ Installed extension: ${manifest.name} v${manifest.version}\n`);

        return {
            manifest,
            path: destDir,
            enabled: true,
            installedAt: this.state.extensions[manifest.id].installedAt,
        };
    }

    /**
     * Install from a .zip file.
     * Extracts to a temp folder, then installs from there.
     */
    async installFromZip(zipPath: string): Promise<InstalledExtension> {
        const tempDir = path.join(os.tmpdir(), `nexia-ext-${Date.now()}`);
        fs.mkdirSync(tempDir, { recursive: true });

        try {
            // Use PowerShell to extract (Windows)
            await this.extractZip(zipPath, tempDir);

            // The zip might contain a single root folder or files directly
            const entries = fs.readdirSync(tempDir, { withFileTypes: true });
            let installDir = tempDir;

            // If there's a single folder inside, use that
            if (entries.length === 1 && entries[0].isDirectory()) {
                installDir = path.join(tempDir, entries[0].name);
            }

            // Check for manifest
            if (!fs.existsSync(path.join(installDir, 'manifest.json'))) {
                throw new Error('No manifest.json found in the extension package.');
            }

            return await this.installFromFolder(installDir);
        } finally {
            // Clean up temp
            try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
        }
    }

    /**
     * Uninstall an extension by ID.
     */
    uninstall(extensionId: string): boolean {
        const extDir = path.join(this.extensionsDir, extensionId);
        if (fs.existsSync(extDir)) {
            fs.rmSync(extDir, { recursive: true, force: true });
        }
        delete this.state.extensions[extensionId];
        this.saveState();
        this.emit(`🗑 Uninstalled extension: ${extensionId}\n`);
        return true;
    }

    /**
     * Enable or disable an extension.
     */
    setEnabled(extensionId: string, enabled: boolean): boolean {
        if (!this.state.extensions[extensionId]) {
            this.state.extensions[extensionId] = {
                enabled,
                installedAt: new Date().toISOString(),
            };
        } else {
            this.state.extensions[extensionId].enabled = enabled;
        }
        this.saveState();
        this.emit(`${enabled ? '✅' : '⏸'} ${extensionId} ${enabled ? 'enabled' : 'disabled'}\n`);
        return true;
    }

    /**
     * Get the extensions directory path.
     */
    getExtensionsDir(): string {
        return this.extensionsDir;
    }

    /**
     * Open the extensions directory in the system file explorer.
     */
    openExtensionsDir() {
        const cmd = process.platform === 'win32' ? 'explorer' : 'open';
        spawn(cmd, [this.extensionsDir], { detached: true, stdio: 'ignore' }).unref();
    }

    /**
     * Create a new extension template.
     */
    createTemplate(name: string, type: ExtensionManifest['type']): string {
        const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

        // A name with nothing alphanumeric in it — "!!!", "___", an emoji —
        // slugs to the empty string, and path.join(extensionsDir, '') is the
        // extensions directory itself. That wrote manifest.json and README.md
        // into the root of every extension, and the next createTemplate
        // overwrote them. Refuse instead: there is no id here to install under.
        if (!id) {
            throw new Error(
                `"${name}" has no letters or numbers in it, so it can't be turned into an extension id. ` +
                `Give it a name with at least one letter or digit.`);
        }

        const extDir = path.join(this.extensionsDir, id);
        fs.mkdirSync(extDir, { recursive: true });

        const manifest: ExtensionManifest = {
            id,
            name,
            version: '1.0.0',
            author: 'Unknown',
            description: `A ${type} extension for Nexia IDE.`,
            type,
            icon: this.getDefaultIcon(type),
            tags: [type],
        };

        fs.writeFileSync(
            path.join(extDir, 'manifest.json'),
            JSON.stringify(manifest, null, 2)
        );

        // Create a README
        fs.writeFileSync(
            path.join(extDir, 'README.md'),
            `# ${name}\n\n${manifest.description}\n\n## Installation\n\nImport this folder into Nexia IDE via the Extensions panel.\n`
        );

        this.state.extensions[id] = {
            enabled: true,
            installedAt: new Date().toISOString(),
        };
        this.saveState();

        this.emit(`📦 Created extension template: ${name} at ${extDir}\n`);
        return extDir;
    }

    private getDefaultIcon(type: string): string {
        switch (type) {
            case 'tool': return '🔧';
            case 'template': return '📋';
            case 'snippet': return '✂';
            case 'theme': return '🎨';
            case 'library': return '📚';
            case 'plugin': return '🔌';
            default: return '📦';
        }
    }

    private extractZip(zipPath: string, destDir: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const ps = spawn('powershell.exe', [
                '-NoProfile', '-NonInteractive',
                '-Command', `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`
            ], { windowsHide: true });
            let stderr = '';
            ps.stderr.on('data', (d) => { stderr += d.toString(); });
            ps.on('close', (code) => {
                code === 0 ? resolve() : reject(new Error(`Zip extraction failed: ${stderr}`));
            });
            ps.on('error', reject);
        });
    }

    private copyDir(src: string, dest: string) {
        fs.mkdirSync(dest, { recursive: true });
        const entries = fs.readdirSync(src, { withFileTypes: true });
        for (const entry of entries) {
            const srcPath = path.join(src, entry.name);
            const destPath = path.join(dest, entry.name);
            if (entry.isDirectory()) {
                this.copyDir(srcPath, destPath);
            } else {
                fs.copyFileSync(srcPath, destPath);
            }
        }
    }
}

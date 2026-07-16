/**
 * Xbox 360 Development Kit Management
 * Handles console connection, deployment, and management.
 * Communicates via XBDM (Xbox Debug Monitor) on port 730.
 */

import { execFile } from 'child_process';
import * as path from 'path';
import * as net from 'net';
import { spawn } from 'child_process';
import { Toolchain } from './toolchain';
import { DevkitConfig, DevkitStatus } from '../shared/types';

const XBDM_PORT = 730;
const XBDM_TIMEOUT = 5000;


/**
 * nexia-core.exe — the XBDM client.
 *
 * These four talked to the console over a socket from this process. The other
 * devkit operations shell out to the SDK's own xbcp, xbrun and xbreboot and
 * still do: their copy semantics are Microsoft's and only observable against
 * real hardware, so reimplementing them would be a guess that corrupts a XEX on
 * someone else's console.
 *
 * A spawn is slower than the in-process socket it replaces. It does not matter:
 * every one of these is a button press, and the console's round trip dwarfs the
 * process start.
 */
function corePath(): string {
    return path.join(__dirname, '..', 'nexia-core.exe');
}

/*
 * Async, and that is not a style preference.
 *
 * execFileSync blocks the event loop until the child exits, and every one of
 * these waits on a console over the network — up to the full XBDM timeout when
 * it is unreachable. Doing that synchronously in Electron's main process freezes
 * the whole IDE: no window, no menus, no way to cancel, for as long as the
 * console stays silent. The sockets this replaced were async for exactly that
 * reason, and making them synchronous on the way to C would have traded a
 * working IDE for a tidier call site.
 *
 * nexia-core exits non-zero when the console refuses, so the JSON on stdout is
 * parsed before the exit code is judged: a refusal is an answer, not a crash.
 */
function core(args: string[]): Promise<any> {
    return new Promise((resolve, reject) => {
        execFile(corePath(), args,
            { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
            (err, stdout) => {
                if (stdout) {
                    try { return resolve(JSON.parse(stdout)); } catch {}
                }
                reject(err || new Error('nexia-core emitted no JSON'));
            });
    });
}


export class DevkitManager {
    private toolchain: Toolchain;
    private consoles: DevkitConfig[] = [];
    private onOutput: ((data: string) => void) | null = null;
    private connectedIp: string | null = null;

    constructor(toolchain: Toolchain) {
        this.toolchain = toolchain;
    }

    setOutputCallback(cb: (data: string) => void) {
        this.onOutput = cb;
    }

    private emit(data: string) {
        if (this.onOutput) this.onOutput(data);
    }

    getConsoles(): DevkitConfig[] {
        return this.consoles;
    }

    addConsole(config: DevkitConfig) {
        this.consoles = this.consoles.filter(c => c.name !== config.name);
        this.consoles.push(config);
    }

    removeConsole(name: string) {
        this.consoles = this.consoles.filter(c => c.name !== name);
    }

    getDefault(): DevkitConfig | undefined {
        return this.consoles.find(c => c.isDefault) || this.consoles[0];
    }

    isConnected(): boolean {
        return this.connectedIp !== null;
    }

    getConnectedIp(): string | null {
        return this.connectedIp;
    }

    /**
     * Test connection to an Xbox 360 via XBDM (port 730).
     * Sends a simple command and checks for a valid response.
     */
    async connect(ip: string): Promise<DevkitStatus> {
        this.emit(`\nConnecting to ${ip}:${XBDM_PORT}...\n`);
        let res: any;
        try {
            res = await core(['devkit', 'connect', ip]);
        } catch (err: any) {
            this.connectedIp = null;
            this.emit(`✗ Connection failed: ${err.message}\n`);
            return { connected: false, type: err.message };
        }
        if (res.connected) {
            this.connectedIp = ip;
            this.addConsole({ name: `Xbox360@${ip}`, ip, isDefault: true });
            this.emit(`✓ Connected to ${ip}\n`);
            if (res.type) this.emit(`  Console type: ${res.type}\n`);
        } else {
            this.connectedIp = null;
            this.emit(`✗ Connection failed: ${res.type || 'Unknown error'}\n`);
        }
        return { connected: !!res.connected, type: res.type };
    }

    /**
     * Disconnect from the current console.
     */
    disconnect() {
        const ip = this.connectedIp;
        this.connectedIp = null;
        if (ip) this.emit(`Disconnected from ${ip}\n`);
    }

    /**
     * List available volumes/drives on the console via XBDM drivelist command.
     */
    async listVolumes(ip?: string): Promise<string[]> {
        const target = ip || this.connectedIp;
        if (!target) return [];
        // Rejects when the console can't be reached, as the socket version did:
        // it had socket.on('error', err => reject(err)). Swallowing that into an
        // empty list would turn "I couldn't reach your devkit" into "your devkit
        // has no drives", which is a worse lie than an error.
        const res = await core(['devkit', 'volumes', target]);
        if (res.ok === false) throw new Error(res.error || 'drivelist failed');
        return res.volumes || [];
    }

    /**
     * Get console system info via XBDM.
     */
    async getSystemInfo(ip?: string): Promise<Record<string, string>> {
        const target = ip || this.connectedIp;
        if (!target) return {};
        // Rejects on failure, as before — see listVolumes.
        const res = await core(['devkit', 'sysinfo', target]);
        if (res.ok === false) throw new Error(res.error || 'systeminfo failed');
        return res.info || {};
    }

    /**
     * Run a devkit tool command.
     */
    private runDevkitCommand(tool: string, args: string[], ip?: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const toolPath = this.toolchain.getToolPath(tool);
            if (!toolPath) {
                reject(new Error(`${tool} not found in SDK`));
                return;
            }

            const targetIp = ip || this.getDefault()?.ip;
            if (!targetIp) {
                reject(new Error('No devkit configured'));
                return;
            }

            const fullArgs = [`/X:${targetIp}`, ...args];
            const env = this.toolchain.getToolEnvironment();

            this.emit(`> ${tool} ${fullArgs.join(' ')}\n`);

            const proc = spawn(toolPath.includes(' ') ? `"${toolPath}"` : toolPath, fullArgs, { env, shell: true, windowsHide: true });
            let output = '';

            proc.stdout.on('data', (data) => {
                const text = data.toString();
                output += text;
                this.emit(text);
            });

            proc.stderr.on('data', (data) => {
                const text = data.toString();
                output += text;
                this.emit(text);
            });

            proc.on('close', (code) => {
                if (code === 0) resolve(output);
                else reject(new Error(`${tool} failed with code ${code}\n${output}`));
            });

            proc.on('error', (err) => reject(err));
        });
    }

    /**
     * Launch a title (XEX) already on the console via XBDM magicboot command.
     */
    async launchTitle(remotePath: string, ip?: string): Promise<void> {
        const targetIp = ip || this.connectedIp || this.getDefault()?.ip;
        if (!targetIp) throw new Error('No console connected');

        // Normalize path separators
        const cleanPath = remotePath.replace(/\//g, '\\');
        this.emit(`\nLaunching: ${cleanPath}\n`);

        return new Promise((resolve, reject) => {
            const socket = new net.Socket();
            let responseData = '';
            let sentCommand = false;
            // The 2s timer, 'timeout', and 'error' handlers all race to settle
            // this promise. Guard so only the first wins — otherwise the success
            // emit can fire alongside a late error and the outcome is unreliable.
            let settled = false;
            const done = (fn: () => void) => {
                if (settled) return;
                settled = true;
                try { socket.destroy(); } catch {}
                fn();
            };

            socket.setTimeout(XBDM_TIMEOUT);

            socket.on('data', (data) => {
                responseData += data.toString();

                if (!sentCommand && responseData.includes('201')) {
                    sentCommand = true;
                    // magicboot launches a title from its path on the console
                    socket.write(`magicboot title="${cleanPath}" directory="${cleanPath.substring(0, cleanPath.lastIndexOf('\\'))}\\"\r\n`);

                    setTimeout(() => {
                        if (responseData.includes('200') || responseData.includes('OK')) {
                            done(() => { this.emit(`✓ Title launched: ${cleanPath}\n`); resolve(); });
                        } else if (responseData.includes('402') || responseData.includes('not found')) {
                            done(() => reject(new Error(`File not found: ${cleanPath}`)));
                        } else {
                            // magicboot usually causes a disconnect as the console reboots into the title
                            done(() => { this.emit(`✓ Launch command sent: ${cleanPath}\n`); resolve(); });
                        }
                    }, 2000);
                }
            });

            socket.on('timeout', () => {
                // Timeout is expected — console reboots into the title
                done(() => { this.emit(`✓ Launch command sent (console rebooting into title)\n`); resolve(); });
            });

            socket.on('error', (err: any) => {
                // Connection reset is expected when magicboot triggers a reboot
                if (err.code === 'ECONNRESET' || err.code === 'EPIPE') {
                    done(() => { this.emit(`✓ Title launching (console rebooting)\n`); resolve(); });
                } else {
                    done(() => reject(err));
                }
            });

            socket.connect(XBDM_PORT, targetIp);
        });
    }

    /**
     * Deploy a XEX to the devkit.
     */
    async deploy(xexPath: string, remotePath: string, ip?: string): Promise<void> {
        const target = remotePath || 'xe:\\';
        this.emit(`\nDeploying to ${target}...\n`);
        await this.runDevkitCommand('xbcp.exe', [xexPath, target], ip);
        this.emit(`✓ Deployed successfully\n`);
    }

    /**
     * Deploy and run a title on the devkit.
     */
    async deployAndRun(xexPath: string, ip?: string): Promise<void> {
        const remotePath = `xe:\\${path.basename(xexPath)}`;
        await this.deploy(xexPath, remotePath, ip);
        this.emit(`\nLaunching...\n`);
        await this.runDevkitCommand('xbrun.exe', [remotePath], ip);
        this.emit(`✓ Title launched\n`);
    }

    /**
     * Reboot the devkit.
     */
    async reboot(type: 'cold' | 'warm' | 'title' = 'cold', ip?: string): Promise<void> {
        const args: string[] = [];
        if (type === 'warm') args.push('/warm');
        else if (type === 'title') args.push('/title');

        this.emit(`\nRebooting (${type})...\n`);
        await this.runDevkitCommand('xbreboot.exe', args, ip);
        this.emit(`✓ Reboot command sent\n`);
    }

    /**
     * Capture a screenshot from the devkit.
     */
    async screenshot(outputPath: string, ip?: string): Promise<string> {
        this.emit(`\nCapturing screenshot...\n`);
        await this.runDevkitCommand('xbcapture.exe', [outputPath], ip);
        this.emit(`✓ Saved to ${outputPath}\n`);
        return outputPath;
    }

    /**
     * List files on the devkit via XBDM dirlist command.
     */
    async listFiles(remotePath: string, ip?: string): Promise<string> {
        const target = ip || this.connectedIp;
        if (!target) return '';
        // Rejects on failure, as before.
        const res = await core(['devkit', 'ls', target, remotePath]);
        if (res.ok === false) throw new Error(res.error || 'dirlist failed');
        return Array.isArray(res.files) ? res.files.join('\n') : (res.raw || '');
    }

    /**
     * Delete a file on the devkit.
     */
    async deleteFile(remotePath: string, ip?: string): Promise<void> {
        await this.runDevkitCommand('xbdel.exe', [remotePath], ip);
    }

    /**
     * Create a directory on the devkit.
     */
    async mkdir(remotePath: string, ip?: string): Promise<void> {
        await this.runDevkitCommand('xbmkdir.exe', [remotePath], ip);
    }

    /**
     * Copy a file to the console via FTP (port 21).
     * Works with RGH/JTAG consoles running FTP servers (XeXMenu, Aurora, FSD, etc.)
     * Falls back to xbcp for official devkits.
     */
    async copyTo(localPath: string, remotePath: string, ip?: string): Promise<void> {
        const targetIp = ip || this.connectedIp || this.getDefault()?.ip;
        if (!targetIp) throw new Error('No console connected');

        const fileName = path.basename(localPath);
        this.emit(`\nDeploying ${fileName} via FTP...\n`);

        // Normalize the remote path for FTP (convert xHDD:\ or HDD:\ to /Hdd1/, etc.)
        const ftpPath = this.normalizeRemotePath(remotePath, fileName);
        this.emit(`  Target: ftp://${targetIp}${ftpPath}\n`);

        const fs = require('fs');
        const fileData = fs.readFileSync(localPath);
        const fileSize = fileData.length;
        this.emit(`  Size: ${(fileSize / 1024).toFixed(1)} KB\n`);

        await this.ftpUpload(targetIp, ftpPath, fileData);
        this.emit(`✓ Deployed ${fileName} (${(fileSize / 1024).toFixed(1)} KB)\n`);
    }

    /**
     * Convert various path formats to FTP paths.
     * xHDD:\path → /Hdd1/path
     * HDD:\path  → /Hdd1/path
     * xe:\path   → /Hdd1/path
     * USB0:\path → /Usb0/path
     * /path      → /path (already FTP format)
     */
    private normalizeRemotePath(remotePath: string, fileName: string): string {
        let p = remotePath.replace(/\\/g, '/');

        // Strip x prefix (xHDD: → HDD:)
        p = p.replace(/^x/i, '');

        // Map volume names to FTP paths
        const volumeMap: Record<string, string> = {
            'hdd:': '/Hdd1/',
            'e:': '/Hdd1/',
            'usb0:': '/Usb0/',
            'usb1:': '/Usb1/',
            'flash:': '/Flash/',
            'dvd:': '/Dvd/',
            'd:': '/Hdd1/',
        };

        const lower = p.toLowerCase();
        for (const [vol, ftpRoot] of Object.entries(volumeMap)) {
            if (lower.startsWith(vol)) {
                p = ftpRoot + p.substring(vol.length);
                break;
            }
        }

        // If it doesn't start with /, default to /Hdd1/
        if (!p.startsWith('/')) {
            p = '/Hdd1/' + p;
        }

        // Ensure it ends with the filename
        if (p.endsWith('/')) {
            p += fileName;
        }

        // Clean up double slashes
        p = p.replace(/\/+/g, '/');

        return p;
    }

    /**
     * Upload a file via raw FTP commands (no external dependencies).
     */
    private ftpUpload(ip: string, remotePath: string, data: Buffer): Promise<void> {
        return new Promise((resolve, reject) => {
            const socket = new net.Socket();
            let step = 0; // 0=connect, 1=user, 2=pass, 3=type, 4=pasv, 5=stor, 6=done
            let dataPort = 0;
            let dataHost = '';
            let responseBuffer = '';

            const timeout = setTimeout(() => {
                socket.destroy();
                reject(new Error('FTP connection timed out'));
            }, 30000);

            socket.connect(21, ip, () => {
                this.emit('  FTP connected\n');
            });

            socket.on('data', (chunk) => {
                responseBuffer += chunk.toString();
                const lines = responseBuffer.split('\r\n');
                responseBuffer = lines.pop() || '';

                for (const line of lines) {
                    if (!line.trim()) continue;
                    const code = parseInt(line.substring(0, 3));

                    if (step === 0 && (code === 220 || code === 200)) {
                        // Welcome — send USER
                        socket.write('USER xbox\r\n');
                        step = 1;
                    } else if (step === 1 && (code === 331 || code === 230)) {
                        // User accepted — send PASS
                        socket.write('PASS xbox\r\n');
                        step = 2;
                    } else if (step === 2 && (code === 230 || code === 200)) {
                        // Logged in — set binary mode
                        socket.write('TYPE I\r\n');
                        step = 3;
                    } else if (step === 3 && code === 200) {
                        // Binary mode set — ensure directory exists
                        const dir = remotePath.substring(0, remotePath.lastIndexOf('/'));
                        if (dir && dir !== '/') {
                            socket.write(`MKD ${dir}\r\n`);
                            step = 35; // intermediate step
                        } else {
                            socket.write('PASV\r\n');
                            step = 4;
                        }
                    } else if (step === 35) {
                        // MKD response (ignore errors — dir may exist)
                        socket.write('PASV\r\n');
                        step = 4;
                    } else if (step === 4 && code === 227) {
                        // Parse PASV response: 227 Entering Passive Mode (h1,h2,h3,h4,p1,p2)
                        // NOTE: Many Xbox FTP servers return 0.0.0.0 — always use the real console IP
                        const match = line.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/);
                        if (!match) {
                            socket.destroy();
                            clearTimeout(timeout);
                            reject(new Error('Failed to parse PASV response'));
                            return;
                        }
                        dataHost = ip; // Always use the console's real IP
                        dataPort = parseInt(match[5]) * 256 + parseInt(match[6]);

                        // Send STOR command
                        socket.write(`STOR ${remotePath}\r\n`);
                        step = 5;
                    } else if (step === 5 && (code === 150 || code === 125)) {
                        // Server ready to receive — open data connection and send file
                        const dataSocket = new net.Socket();
                        dataSocket.connect(dataPort, dataHost, () => {
                            this.emit('  Transferring...\n');
                            dataSocket.end(data, () => {
                                // Data sent
                            });
                        });
                        dataSocket.on('error', (err) => {
                            socket.destroy();
                            clearTimeout(timeout);
                            reject(new Error(`FTP data transfer failed: ${err.message}`));
                        });
                        step = 6;
                    } else if (step === 6 && (code === 226 || code === 250)) {
                        // Transfer complete
                        clearTimeout(timeout);
                        socket.write('QUIT\r\n');
                        socket.destroy();
                        resolve();
                    } else if (code >= 400) {
                        // Error
                        clearTimeout(timeout);
                        socket.destroy();
                        reject(new Error(`FTP error ${code}: ${line}`));
                    }
                }
            });

            socket.on('error', (err) => {
                clearTimeout(timeout);
                reject(new Error(`FTP connection failed: ${err.message}`));
            });

            socket.on('close', () => {
                clearTimeout(timeout);
            });
        });
    }

    /**
     * Copy a file from the console via FTP.
     */
    async copyFrom(remotePath: string, localPath: string, ip?: string): Promise<void> {
        // For now, fall back to xbcp for downloads
        try {
            await this.runDevkitCommand('xbcp.exe', [remotePath, localPath], ip);
        } catch {
            throw new Error('File download not yet supported via FTP');
        }
    }
}

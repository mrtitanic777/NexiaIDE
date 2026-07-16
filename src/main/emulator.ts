/**
 * Nexia 360 Emulator Integration
 * Launches Nexia360.exe, finds its real PID via tasklist, attaches GDB.
 *
 * Architecture:
 *   1. IDE spawns Nexia360.exe via shell (handles elevation)
 *   2. IDE uses tasklist to find the real Nexia360.exe PID (not cmd.exe)
 *   3. IDE spawns GDB (--interpreter=mi) and attaches to the real PID
 *   4. Pause/resume/step/breakpoints/registers/memory all via GDB/MI
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ChildProcess, spawn, execSync, execFileSync } from 'child_process';

export interface EmulatorRegisters {
    gpr: { name: string; value: string }[];
    pc: string;
    lr: string;
    ctr: string;
}

export interface Breakpoint {
    id: string;
    addr: string;
    file?: string;
    line?: number;
    enabled: boolean;
    hitCount: number;
}

export interface MemoryBlock {
    addr: string;
    data: string;
}

export type EmulatorState = 'stopped' | 'starting' | 'running' | 'paused';

export class EmulatorManager {
    private emulatorProcess: ChildProcess | null = null;
    private gdbProcess: ChildProcess | null = null;
    private state: EmulatorState = 'stopped';
    private emulatorPath: string = '';
    private gdbPath: string = '';
    private targetPid: number | null = null;
    private gdbTokenCounter = 1;
    private gdbBuffer = '';
    private pendingCallbacks = new Map<number, (result: string) => void>();
    private stopListeners: (() => void)[] = [];
    private breakpoints: Breakpoint[] = [];
    private lastRegisters: EmulatorRegisters | null = null;

    private onOutput: ((data: string) => void) | null = null;
    private onStateChange: ((state: EmulatorState) => void) | null = null;
    private onEvent: ((event: any) => void) | null = null;

    setOutputCallback(cb: (data: string) => void) { this.onOutput = cb; }
    setStateChangeCallback(cb: (state: EmulatorState) => void) { this.onStateChange = cb; }
    setEventCallback(cb: (event: any) => void) { this.onEvent = cb; }

    private emit(data: string) { if (this.onOutput) this.onOutput(data); }
    private emitEvent(event: any) { if (this.onEvent) this.onEvent(event); }

    private setState(s: EmulatorState) {
        this.state = s;
        if (this.onStateChange) this.onStateChange(s);
        this.emitEvent({ event: 'state', state: s });
    }

    getState(): EmulatorState { return this.state; }
    getBreakpoints(): Breakpoint[] { return this.breakpoints; }
    getRegisters(): EmulatorRegisters | null { return this.lastRegisters; }

    configure(emulatorPath: string, gdbPath?: string) {
        this.emulatorPath = emulatorPath;
        if (gdbPath) this.gdbPath = gdbPath;
    }

    getEmulatorPath(): string { return this.emulatorPath; }
    getGdbPath(): string { return this.gdbPath; }

    isConfigured(): boolean {
        if (!this.emulatorPath) return false;
        try {
            const core = path.join(__dirname, '..', 'nexia-core.exe');
            return !!JSON.parse(execFileSync(core, ['emulator', 'configured', this.emulatorPath],
                { encoding: 'utf8', windowsHide: true })).configured;
        } catch { return false; }
    }

    private findGdb(): string {
        if (this.gdbPath && fs.existsSync(this.gdbPath)) return this.gdbPath;
        // nexia-core probes the same candidates in the same order and returns
        // the winner as written rather than resolved: the first candidate is a
        // bare "gdb", and turning that into a full path would change which
        // binary runs when PATH changes underneath us.
        try {
            const core = path.join(__dirname, '..', 'nexia-core.exe');
            const res = JSON.parse(execFileSync(core, ['emulator', 'gdb'],
                { encoding: 'utf8', windowsHide: true }));
            this.gdbPath = res.path || '';
            return this.gdbPath;
        } catch { return ''; }
    }

    /**
     * Launch Nexia360.exe separately, find its real PID, then attach GDB.
     * The emulator requires elevation so GDB can't launch it directly.
     */
    async launch(xexPath: string): Promise<{ success: boolean; error?: string }> {
        if (!this.isConfigured()) {
            return { success: false, error: 'Set path to Nexia360.exe first.' };
        }
        if (this.state !== 'stopped') {
            return { success: false, error: 'Emulator already running.' };
        }
        if (!fs.existsSync(xexPath)) {
            return { success: false, error: `XEX not found: ${xexPath}` };
        }

        const gdb = this.findGdb();
        if (!gdb) {
            return { success: false, error: 'GDB not found. Install via MSYS2, MinGW, or TDM-GCC.' };
        }

        this.setState('starting');
        this.emit(`\n[Nexia 360] Launching: ${path.basename(xexPath)}\n`);
        this.emit(`[Nexia 360] Emulator: ${this.emulatorPath}\n`);
        this.emit(`[Nexia 360] GDB: ${gdb}\n\n`);

        try {
            const emuName = path.basename(this.emulatorPath);

            // Get PIDs of any existing instances so we can find our new one
            const pidsBefore = this.findPidsByName(emuName);

            // 1. Spawn emulator via shell (handles elevation / EACCES)
            this.emulatorProcess = spawn(`"${this.emulatorPath}"`, [`"${xexPath}"`], {
                cwd: path.dirname(this.emulatorPath),
                windowsHide: false,
                shell: true,
                detached: true,
            });

            this.emulatorProcess.stdout?.on('data', (d) => this.emit(d.toString()));
            this.emulatorProcess.stderr?.on('data', (d) => this.emit(`[emu:err] ${d.toString()}`));

            let emulatorExited = false;
            this.emulatorProcess.on('close', (code) => {
                emulatorExited = true;
                this.emit(`\n[Nexia 360] Emulator exited (code ${code})\n`);
                this.cleanup();
            });
            this.emulatorProcess.on('error', (err) => {
                emulatorExited = true;
                this.emit(`\n[Nexia 360] Error: ${err.message}\n`);
                this.cleanup();
            });

            // Wait for emulator to start
            await new Promise(r => setTimeout(r, 2500));

            if (emulatorExited) {
                return { success: false, error: 'Emulator exited immediately.' };
            }

            this.setState('running');
            this.emit(`[Nexia 360] Emulator is running.\n`);

            // 2. Find the real PID (not the shell PID)
            const pidsAfter = this.findPidsByName(emuName);
            const newPids = pidsAfter.filter(p => !pidsBefore.includes(p));
            const realPid = newPids.length > 0 ? newPids[0] : null;

            if (!realPid) {
                this.emit(`[GDB] Could not find ${emuName} PID. Running without debugger.\n`);
                return { success: true };
            }

            this.emit(`[GDB] Found ${emuName} PID: ${realPid}\n`);
            this.targetPid = realPid;

            // 3. Attach GDB to the real emulator PID
            try {
                await this.attachGdb(gdb, realPid);
            } catch (gdbErr: any) {
                this.emit(`[GDB] Could not attach: ${gdbErr.message}. Running without debugger.\n`);
            }

            return { success: true };
        } catch (err: any) {
            this.cleanup();
            return { success: false, error: err.message };
        }
    }

    /**
     * Find all PIDs matching an executable name using tasklist.
     */
    private findPidsByName(exeName: string): number[] {
        // nexia-core walks the process list with Toolhelp32. What was here ran
        // tasklist and pulled the pid out of its CSV with a regex — a process
        // spawn either way, but one of them parses a localised, formatted table
        // that exists to be read by people. The column order is not a contract.
        try {
            const core = path.join(__dirname, '..', 'nexia-core.exe');
            const res = JSON.parse(execFileSync(core, ['emulator', 'pids', exeName],
                { encoding: 'utf8', windowsHide: true, timeout: 5000 }));
            return res.pids || [];
        } catch {
            // Same as before: a lookup that fails is an emulator that is not
            // running, which every caller already handles.
            return [];
        }
    }

    /**
     * Spawn GDB in MI mode and attach to a running process by PID.
     */
    private async attachGdb(gdb: string, pid: number) {
        this.gdbProcess = spawn(gdb, ['--interpreter=mi', '--quiet'], {
            windowsHide: true,
        });

        this.gdbBuffer = '';
        this.gdbTokenCounter = 1;
        this.pendingCallbacks.clear();

        this.gdbProcess.stdout?.on('data', (d) => this.handleGdbOutput(d.toString()));
        this.gdbProcess.stderr?.on('data', (d) => this.emit(`[gdb:err] ${d.toString()}`));

        this.gdbProcess.on('close', (code) => {
            this.emit(`[GDB] Exited (code ${code})\n`);
        });

        this.gdbProcess.on('error', (err) => {
            this.emit(`[GDB] Error: ${err.message}\n`);
        });

        await new Promise(r => setTimeout(r, 500));

        this.emit(`[GDB] Attaching to PID ${pid}...\n`);

        // Tell GDB to pass SIGSEGV through — emulators use it for JIT recompilation
        // Keep SIGTRAP at default (stop) — we need it for DebugBreakProcess and breakpoints
        await this.gdbCommand('handle SIGSEGV nostop noprint pass');
        await this.gdbCommand('handle SIGPIPE nostop noprint pass');

        const attachResult = await this.gdbCommand(`-target-attach ${pid}`);

        if (attachResult.includes('^done') || attachResult.includes('*stopped')) {
            this.emit(`[GDB] Attached to PID ${pid}.\n`);
            // Resume the emulator so it keeps running
            await this.gdbCommand('-exec-continue');
            this.emit(`[Nexia 360] Debugger attached.\n\n`);
        } else {
            const errMsg = (attachResult.match(/msg="([^"]*)"/) || [])[1] || 'Unknown error';
            if (errMsg.includes('Access is denied') || errMsg.includes('error 5')) {
                this.emit(`[GDB] Access denied — Nexia360.exe is running as admin.\n`);
                this.emit(`[GDB] ⚠ Run Nexia IDE as Administrator for debugging to work.\n`);
                this.emit(`[GDB] (Right-click Nexia IDE → Run as administrator)\n\n`);
            } else {
                this.emit(`[GDB] Attach failed: ${errMsg}\n`);
            }
            // Clean up the failed GDB process
            try { if (this.gdbProcess && !this.gdbProcess.killed) this.gdbProcess.kill(); } catch {}
            this.gdbProcess = null;
        }
    }

    // ── GDB/MI ──

    private gdbCommand(cmd: string, timeout = 5000): Promise<string> {
        return new Promise((resolve) => {
            if (!this.gdbProcess?.stdin) { resolve(''); return; }

            const token = this.gdbTokenCounter++;
            const timer = setTimeout(() => {
                this.pendingCallbacks.delete(token);
                resolve('');
            }, timeout);

            this.pendingCallbacks.set(token, (result: string) => {
                clearTimeout(timer);
                resolve(result);
            });

            this.gdbProcess.stdin.write(`${token}${cmd}\n`);
        });
    }

    /** Fire-and-forget — send without waiting for response */
    private gdbSend(cmd: string) {
        if (!this.gdbProcess?.stdin) return;
        const token = this.gdbTokenCounter++;
        this.gdbProcess.stdin.write(`${token}${cmd}\n`);
    }

    private handleGdbOutput(raw: string) {
        this.gdbBuffer += raw;
        const lines = this.gdbBuffer.split('\n');
        this.gdbBuffer = lines.pop() || '';

        for (const line of lines) {
            const t = line.trim();
            if (!t || t === '(gdb)') continue;

            // Log non-thread-noise lines so we can debug
            if (!t.startsWith('[New Thread') && !t.startsWith('[Thread ')
                && !t.startsWith('~"[') && !t.startsWith('Signal')) {
                this.emit(`[gdb:raw] ${t}\n`);
            }

            // Token-prefixed result
            const tm = t.match(/^(\d+)([\^*+=~@&])(.*)/);
            if (tm) {
                const token = parseInt(tm[1]);
                const cb = this.pendingCallbacks.get(token);
                if (cb) {
                    this.pendingCallbacks.delete(token);
                    cb(t);
                }
            }

            // Async stop/run notifications (no token)
            if (t.startsWith('*stopped')) {
                const hadWaiters = this.stopListeners.length > 0;
                this.parseStopReason(t);
                this.notifyStopListeners();

                // For unsolicited stops (breakpoint hits, signals) where no one
                // is actively awaiting the stop, fetch data and emit a complete event.
                // Button-initiated pause/step have active waiters and fetch data themselves.
                // Only act when we were 'running' — avoids spurious fetch during attach.
                if (!hadWaiters && this.state === 'running') {
                    this.setState('paused');
                    this.handleUnsolicitedStop();
                }
            } else if (t.startsWith('*running')) {
                this.setState('running');
            }

            // Console stream
            if (t.startsWith('~"')) {
                const text = this.unescape(t.substring(1));
                this.emitEvent({ event: 'gdb_console', text });
            }
        }
    }

    private parseStopReason(line: string) {
        const get = (key: string) => {
            const m = line.match(new RegExp(`${key}="([^"]*)"`));
            return m ? m[1] : '';
        };

        const reason = get('reason');
        const addr = get('addr');
        const func = get('func');

        if (reason === 'breakpoint-hit') {
            this.emit(`[GDB] ● Breakpoint hit at ${addr}${func ? ' (' + func + ')' : ''}\n`);
        } else if (reason === 'end-stepping-range') {
            this.emit(`[GDB] Stepped to ${addr}${func ? ' (' + func + ')' : ''}\n`);
        } else if (reason === 'signal-received') {
            this.emit(`[GDB] Signal: ${get('signal-name')} at ${addr}\n`);
        } else {
            this.emit(`[GDB] Paused: ${reason || 'manual'} at ${addr}\n`);
        }
    }

    /**
     * Handle an unsolicited stop (breakpoint hit, signal from outside).
     * Fetches registers + backtrace and emits a complete 'paused' event
     * so the renderer doesn't need to make separate IPC calls.
     */
    private async handleUnsolicitedStop() {
        try {
            const registers = await this.requestRegisters();
            const backtrace = await this.getBacktrace();
            this.emitEvent({ event: 'paused', registers, backtrace });
        } catch (err: any) {
            this.emit(`[GDB] Error fetching state: ${err.message}\n`);
            this.emitEvent({ event: 'paused' });
        }
    }

    private unescape(s: string): string {
        if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
        return s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }

    // ── Debug Commands ──

    async pause(): Promise<{ paused: boolean; registers?: EmulatorRegisters | null; backtrace?: string[] }> {
        if (!this.targetPid) {
            this.emit('[GDB] No target PID — cannot pause.\n');
            return { paused: false };
        }

        this.emit('[GDB] Interrupting...\n');

        // nexia-core calls DebugBreakProcess. What was here wrote a .ps1 to
        // TEMP that had PowerShell compile a C# class at runtime to P/Invoke
        // three kernel32 functions, ran it, and deleted it — to make one API
        // call. It also checked nothing: OpenProcess could return NULL and
        // DebugBreakProcess could fail, and the catch below only fired if
        // PowerShell itself died. A silent failure then fell straight into
        // waitForStop and spent five seconds waiting for a stop nobody had
        // asked for.
        //
        // The C reports what actually happened, so the fallback is taken on
        // purpose rather than by timeout.
        let broke = false;
        try {
            const core = path.join(__dirname, '..', 'nexia-core.exe');
            const res = JSON.parse(execFileSync(core, ['emulator', 'break', String(this.targetPid)],
                { encoding: 'utf8', windowsHide: true, timeout: 5000 }));
            broke = !!res.broke;
            if (!broke) this.emit(`[GDB] DebugBreakProcess failed (error ${res.code}).\n`);
        } catch (err: any) {
            this.emit(`[GDB] Couldn't run nexia-core to interrupt: ${err.message}\n`);
        }

        if (!broke) {
            // GDB can sometimes stop it even when DebugBreakProcess cannot.
            this.emit('[GDB] Falling back to -exec-interrupt.\n');
            this.gdbSend('-exec-interrupt --all');
        }
        const paused = await this.waitForStop(5000);

        if (!paused) {
            this.emit('[GDB] Interrupt timed out.\n');
            return { paused: false };
        }

        this.emit('[GDB] Paused.\n');
        this.setState('paused');

        const registers = await this.requestRegisters();
        const backtrace = await this.getBacktrace();
        return { paused: true, registers, backtrace };
    }

    /**
     * Wait for a *stopped notification from GDB.
     */
    private waitForStop(timeout: number): Promise<boolean> {
        return new Promise((resolve) => {
            if (this.state === 'paused') { resolve(true); return; }

            const timer = setTimeout(() => {
                this.removeStopListener(listener);
                resolve(false);
            }, timeout);

            const listener = () => {
                clearTimeout(timer);
                resolve(true);
            };

            this.addStopListener(listener);
        });
    }

    private addStopListener(fn: () => void) { this.stopListeners.push(fn); }
    private removeStopListener(fn: () => void) { this.stopListeners = this.stopListeners.filter(f => f !== fn); }
    private notifyStopListeners() { for (const fn of this.stopListeners) fn(); this.stopListeners = []; }

    async resume(): Promise<boolean> {
        this.emit('[GDB] Continuing...\n');
        return !!(await this.gdbCommand('-exec-continue'));
    }

    async step(): Promise<{ registers?: EmulatorRegisters | null; backtrace?: string[] }> {
        this.gdbSend('-exec-step-instruction');
        await this.waitForStop(5000);
        this.setState('paused');
        const registers = await this.requestRegisters();
        const backtrace = await this.getBacktrace();
        return { registers, backtrace };
    }

    async stepOver(): Promise<{ registers?: EmulatorRegisters | null; backtrace?: string[] }> {
        this.gdbSend('-exec-next-instruction');
        await this.waitForStop(5000);
        this.setState('paused');
        const registers = await this.requestRegisters();
        const backtrace = await this.getBacktrace();
        return { registers, backtrace };
    }

    async setBreakpoint(location: string): Promise<Breakpoint | null> {
        this.emit(`[GDB] Breakpoint: ${location}\n`);
        const result = await this.gdbCommand(`-break-insert *${location}`);

        if (result.includes('^done')) {
            const num = (result.match(/number="(\d+)"/) || [])[1] || '?';
            const addr = (result.match(/addr="([^"]+)"/) || [])[1] || location;
            const bp: Breakpoint = { id: num, addr, enabled: true, hitCount: 0 };
            this.breakpoints.push(bp);
            this.emit(`[GDB] Breakpoint #${num} at ${addr}\n`);
            this.emitEvent({ event: 'breakpoints', list: this.breakpoints });
            return bp;
        }
        this.emit(`[GDB] Breakpoint failed.\n`);
        return null;
    }

    async removeBreakpoint(id: string): Promise<boolean> {
        const result = await this.gdbCommand(`-break-delete ${id}`);
        this.breakpoints = this.breakpoints.filter(b => b.id !== id);
        this.emitEvent({ event: 'breakpoints', list: this.breakpoints });
        return result.includes('^done');
    }

    async listBreakpoints(): Promise<Breakpoint[]> {
        const result = await this.gdbCommand('-break-list');
        this.breakpoints = [];
        const matches = result.matchAll(/bkpt=\{number="(\d+)"[^}]*addr="([^"]*)"[^}]*enabled="([yn])"/g);
        for (const m of matches) {
            this.breakpoints.push({ id: m[1], addr: m[2], enabled: m[3] === 'y', hitCount: 0 });
        }
        this.emitEvent({ event: 'breakpoints', list: this.breakpoints });
        return this.breakpoints;
    }

    async requestRegisters(): Promise<EmulatorRegisters | null> {
        const namesResult = await this.gdbCommand('-data-list-register-names');
        const valsResult = await this.gdbCommand('-data-list-register-values x');
        if (!namesResult || !valsResult) return null;

        const nameList = (namesResult.match(/register-names=\[([^\]]*)\]/) || [])[1] || '';
        const names = nameList.match(/"([^"]*)"/g)?.map(s => s.replace(/"/g, '')) || [];

        const regs: { name: string; value: string }[] = [];
        let pc = '', lr = '', ctr = '';
        const valMatches = valsResult.matchAll(/\{number="(\d+)",value="([^"]*)"\}/g);

        for (const m of valMatches) {
            const idx = parseInt(m[1]);
            const name = names[idx] || `r${idx}`;
            const value = m[2];
            if (name) regs.push({ name, value });
            if (name === 'pc' || name === 'rip' || name === 'eip') pc = value;
            if (name === 'lr') lr = value;
            if (name === 'ctr') ctr = value;
        }

        this.lastRegisters = { gpr: regs, pc, lr, ctr };
        return this.lastRegisters;
    }

    async readMemory(addr: string, size: number): Promise<MemoryBlock | null> {
        const result = await this.gdbCommand(`-data-read-memory-bytes ${addr} ${size}`);
        if (result.includes('^done')) {
            const hex = (result.match(/contents="([^"]+)"/) || [])[1] || '';
            if (hex) {
                this.emitEvent({ event: 'memory', addr, data: hex });
                return { addr, data: hex };
            }
        }
        this.emit(`[GDB] Memory read failed at ${addr}\n`);
        return null;
    }

    async writeMemory(addr: string, hexData: string): Promise<boolean> {
        const result = await this.gdbCommand(`-data-write-memory-bytes ${addr} ${hexData}`);
        const ok = result.includes('^done');
        this.emit(ok ? `[GDB] Wrote ${hexData.length / 2} bytes at ${addr}\n` : `[GDB] Write failed at ${addr}\n`);
        return ok;
    }

    async getBacktrace(): Promise<string[]> {
        const result = await this.gdbCommand('-stack-list-frames');
        const frames: string[] = [];
        const matches = result.matchAll(/frame=\{level="(\d+)"[^}]*addr="([^"]*)"[^}]*func="([^"]*)"/g);
        for (const m of matches) frames.push(`#${m[1]} ${m[3]} at ${m[2]}`);
        return frames;
    }

    stop() {
        this.emit('[Nexia 360] Stopping...\n');
        if (this.gdbProcess?.stdin) {
            try {
                this.gdbProcess.stdin.write('kill\n');
                this.gdbProcess.stdin.write('-gdb-exit\n');
            } catch {}
        }
        setTimeout(() => this.cleanup(), 2000);
    }

    private cleanup() {
        try { if (this.gdbProcess && !this.gdbProcess.killed) this.gdbProcess.kill(); } catch {}
        try { if (this.emulatorProcess && !this.emulatorProcess.killed) this.emulatorProcess.kill(); } catch {}
        this.gdbProcess = null;
        this.emulatorProcess = null;
        this.targetPid = null;
        this.lastRegisters = null;
        this.breakpoints = [];
        this.stopListeners = [];
        this.pendingCallbacks.clear();
        this.setState('stopped');
    }
}

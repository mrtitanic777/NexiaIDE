/**
 * SDK Tools Integration
 * Provides access to shader compilation, audio encoding, XUI, and other SDK tools.
 */

import { spawn } from 'child_process';
import * as path from 'path';
import { Toolchain } from './toolchain';

export class SdkTools {
    private toolchain: Toolchain;
    private onOutput: ((data: string) => void) | null = null;

    constructor(toolchain: Toolchain) {
        this.toolchain = toolchain;
    }

    setOutputCallback(cb: (data: string) => void) {
        this.onOutput = cb;
    }

    private emit(data: string) {
        if (this.onOutput) this.onOutput(data);
    }

    /**
     * Launch an SDK tool from the tools panel.
     * GUI tools are spawned detached (no terminal output).
     * CLI tools run with stdout/stderr piped to the IDE terminal.
     */
    launchTool(toolName: string, isGui: boolean): Promise<string> {
        const toolPath = this.toolchain.getToolPath(toolName);
        if (!toolPath) {
            const msg = `${toolName} not found in SDK`;
            this.emit(`\nError: ${msg}\n`);
            return Promise.reject(new Error(msg));
        }

        const env = this.toolchain.getToolEnvironment();
        const toolDir = path.dirname(toolPath);

        if (isGui) {
            // GUI tool: launch detached, no output capture
            this.emit(`\nLaunching ${toolName}...\n`);
            try {
                spawn(toolPath, [], {
                    env,
                    cwd: toolDir,
                    detached: true,
                    stdio: 'ignore',
                    windowsHide: false,
                }).unref();
                this.emit(`${toolName} launched.\n`);
                return Promise.resolve(`${toolName} launched`);
            } catch (err: any) {
                this.emit(`Failed to launch ${toolName}: ${err.message}\n`);
                return Promise.reject(err);
            }
        } else {
            // CLI tool: run with output piped to terminal
            return this.runTool(toolName, []);
        }
    }

    /**
     * Run any SDK tool with arguments.
     */
    runTool(toolName: string, args: string[]): Promise<string> {
        return new Promise((resolve, reject) => {
            const toolPath = this.toolchain.getToolPath(toolName);
            if (!toolPath) {
                reject(new Error(`${toolName} not found in SDK`));
                return;
            }

            const env = this.toolchain.getToolEnvironment();
            const toolDir = path.dirname(toolPath);
            this.emit(`> ${toolName} ${args.join(' ')}\n`);

            const proc = spawn(toolPath.includes(' ') ? `"${toolPath}"` : toolPath, args, { env, cwd: toolDir, shell: true, windowsHide: true });
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
                code === 0 ? resolve(output) : reject(new Error(output));
            });

            proc.on('error', reject);
        });
    }

    /**
     * Compile HLSL shader.
     */
    async compileShader(inputFile: string, outputFile: string, profile: string, entryPoint: string = 'main'): Promise<string> {
        this.emit(`\nCompiling shader: ${inputFile}\n`);
        const args = [
            `/T`, profile,
            `/E`, entryPoint,
            `/Fo`, outputFile,
            inputFile,
        ];
        return this.runTool('fxc.exe', args);
    }

    /**
     * Encode audio to XMA2.
     */
    async encodeAudioXma2(inputFile: string, outputFile: string): Promise<string> {
        this.emit(`\nEncoding audio (XMA2): ${inputFile}\n`);
        return this.runTool('xma2encode.exe', [inputFile, `/o`, outputFile]);
    }

    /**
     * Encode audio to xWMA.
     */
    async encodeAudioXwma(inputFile: string, outputFile: string): Promise<string> {
        this.emit(`\nEncoding audio (xWMA): ${inputFile}\n`);
        return this.runTool('xwmaencode.exe', [inputFile, outputFile]);
    }

    /**
     * Compile XUI skin.
     */
    async compileXui(inputFile: string, outputFile: string): Promise<string> {
        this.emit(`\nCompiling XUI: ${inputFile}\n`);
        return this.runTool('makexui.exe', [inputFile, `/o`, outputFile]);
    }

    /**
     * Inspect a binary (XEX dump).
     */
    async inspectBinary(inputFile: string): Promise<string> {
        this.emit(`\nInspecting: ${inputFile}\n`);
        return this.runTool('xexdump.exe', [inputFile]);
    }

    /**
     * Compress a file with LZX.
     */
    async compress(inputFile: string, outputFile: string): Promise<string> {
        this.emit(`\nCompressing: ${inputFile}\n`);
        return this.runTool('lzxcompress.exe', [inputFile, outputFile]);
    }

    /**
     * Build XEX image from executable.
     */
    async buildXex(inputFile: string, outputFile: string): Promise<string> {
        this.emit(`\nBuilding XEX: ${inputFile}\n`);
        return this.runTool('imagexex.exe', [`/nologo`, `/out:${outputFile}`, inputFile]);
    }

    /**
     * Launch PIX performance analyzer.
     */
    async launchPix(): Promise<void> {
        await this.launchTool('pix.exe', true);
    }
}

/**
 * Xbox 360 Build System
 * Handles compilation, linking, and XEX packaging.
 * Output format mirrors Visual Studio / MSBuild for Xbox 360.
 */

import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { Toolchain } from './toolchain';
import { BuildConfig, BuildResult, BuildMessage, ProjectConfig, BuildConfiguration } from '../shared/types';

/**
 * The libraries/defines/paths that apply to the configuration being built.
 *
 * Visual Studio keeps these per configuration, because the Xbox 360 SDK ships a
 * different library flavour for each one (d3d9d / d3d9i / d3d9 / d3d9ltcg). The
 * VS importer records them under project.configurations; anything without an
 * entry — a hand-made Nexia project, or one imported before this existed —
 * falls back to the flat fields, so nothing has to be migrated.
 */
function effectiveSettings(project: ProjectConfig, cfg: BuildConfiguration) {
    const o = project.configurations?.[cfg];
    return {
        libraries: o?.libraries ?? project.libraries ?? [],
        defines: o?.defines ?? project.defines ?? [],
        includeDirectories: o?.includeDirectories ?? project.includeDirectories ?? [],
        libraryDirectories: o?.libraryDirectories ?? project.libraryDirectories ?? [],
        /**
         * The C runtime, per configuration.
         *
         * The flat project.runtimeLibrary is only a fallback now. An import
         * recorded the Debug group's /MTd there and it applied to every build:
         * /MTd implies _DEBUG, the SDK headers then pragma-link xapilibd.lib,
         * and it collided with the release xapilib for 37 duplicate-symbol
         * errors in Release, Profile and Release_LTCG. Debug built fine, so the
         * import looked correct.
         *
         * Undefined here means "let the caller pick from the configuration",
         * which is the correct default and what a hand-made project wants.
         */
        runtimeLibrary: o?.runtimeLibrary ?? project.runtimeLibrary,
    };
}

/**
 * Generate a unique .obj filename from a source path by incorporating the
 * relative directory structure.  This prevents collisions when two source
 * files share the same basename (e.g. src/Main.cpp and src/net/Main.cpp).
 *
 *   src/Main.cpp        →  Main.obj
 *   src/net/Main.cpp    →  net_Main.obj
 *   src/a/b/Util.cpp    →  a_b_Util.obj
 */
function uniqueObjName(srcPath: string, projectRoot: string): string {
    const srcDir = path.join(projectRoot, 'src');
    // Get path relative to src/ (or project root if not under src/)
    let rel: string;
    if (srcPath.startsWith(srcDir + path.sep) || srcPath.startsWith(srcDir + '/')) {
        rel = path.relative(srcDir, srcPath);
    } else {
        rel = path.relative(projectRoot, srcPath);
    }
    // Replace directory separators with underscores, swap extension to .obj
    const noExt = rel.replace(/\.[^.]+$/, '');
    return noExt.replace(/[\\/]/g, '_') + '.obj';
}

export class BuildSystem {
    private toolchain: Toolchain;
    private currentProcess: ChildProcess | null = null;
    private onOutput: ((data: string) => void) | null = null;
    private building = false;

    constructor(toolchain: Toolchain) {
        this.toolchain = toolchain;
    }

    setOutputCallback(cb: (data: string) => void) {
        this.onOutput = cb;
    }

    private emit(data: string) {
        if (this.onOutput) this.onOutput(data);
    }

    private timestamp(): string {
        const d = new Date();
        return d.toLocaleDateString('en-US') + ' ' + d.toLocaleTimeString('en-US');
    }

    private elapsed(ms: number): string {
        const s = Math.floor(ms / 1000);
        const min = Math.floor(s / 60);
        const sec = s % 60;
        const centiseconds = Math.floor((ms % 1000) / 10);
        const frac = centiseconds.toString().padStart(2, '0');
        return `${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}.${frac}`;
    }

    /** Whether a build is currently running. */
    get isBuilding(): boolean { return this.building; }

    /**
     * Full build: compile all sources → link → produce XEX.
     *
     * Serialized — only one build may run at a time. A second concurrent
     * invocation (e.g. a second F7 before the first finishes) returns
     * immediately instead of corrupting shared state: the single
     * `currentProcess` handle, the fixed-name `link.rsp`/`lib.rsp`, and the
     * shared output directory would otherwise be written by two builds at once.
     */
    async build(project: ProjectConfig, config?: Partial<BuildConfig>): Promise<BuildResult> {
        if (this.building) {
            this.emit('1>------ Build skipped: another build is already in progress ------\n');
            return {
                success: false,
                errors: [{ file: '', line: 0, column: 0, message: 'A build is already in progress.', severity: 'error' }],
                warnings: [],
                output: '',
                duration: 0,
            };
        }
        this.building = true;
        try {
            return await this.runBuild(project, config);
        } finally {
            this.building = false;
        }
    }

    private async runBuild(project: ProjectConfig, config?: Partial<BuildConfig>): Promise<BuildResult> {
        const startTime = Date.now();
        const errors: BuildMessage[] = [];
        const warnings: BuildMessage[] = [];
        let fullOutput = '';

        const configuration = config?.configuration || project.configuration || 'Debug';
        const buildConfig: BuildConfig = {
            configuration,
            compilerFlags: config?.compilerFlags || [],
            linkerFlags: config?.linkerFlags || [],
            defines: config?.defines || effectiveSettings(project, configuration).defines,
            outputDir: config?.outputDir || path.join(project.path, 'out', configuration),
        };

        // Ensure output directory
        if (!fs.existsSync(buildConfig.outputDir)) {
            fs.mkdirSync(buildConfig.outputDir, { recursive: true });
        }

        // ── MSBuild-style header ──
        this.emit(`1>------ Build started: Project: ${project.name}, Configuration: ${configuration} Xbox 360 ------\n`);
        this.emit(`1>Build started ${this.timestamp()}.\n`);


        // ── Check VC++ Runtime Dependencies ──
        const runtimeCheck = this.toolchain.checkRuntimeDependencies();
        if (runtimeCheck.missing.length > 0) {
            const duration = Date.now() - startTime;
            const dlls = runtimeCheck.missing.join(', ');
            const msg = `Microsoft Visual C++ 2010 runtime DLLs are missing from the SDK: ${dlls}. ${runtimeCheck.hint}`;
            this.emit(`1>\n`);
            this.emit(`1>  ERROR: ${msg}\n`);
            this.emit(`1>\n`);
            errors.push({ file: '', line: 0, column: 0, message: msg, severity: 'error' });
            this.emit(`1>Build FAILED.\n`);
            this.emit(`1>\n`);
            this.emit(`1>Time Elapsed ${this.elapsed(duration)}\n`);
            this.emit(`========== Build: 0 succeeded, 1 failed, 0 up-to-date, 0 skipped ==========\n`);
            return { success: false, errors, warnings, output: fullOutput, duration };
        }

        // ── InitializeBuildStatus ──
        this.emit(`1>InitializeBuildStatus:\n`);
        const unsuccessfulMarker = path.join(buildConfig.outputDir, `${project.name}.unsuccessfulbuild`);
        try { fs.writeFileSync(unsuccessfulMarker, ''); } catch {}
        this.emit(`1>  Creating "${path.relative(project.path, unsuccessfulMarker)}" because "AlwaysCreate" was specified.\n`);

        // ── ClCompile ──
        // Discover all source files: merge config list with directory scan
        const configuredFiles = (project.sourceFiles || []).filter(f => /\.(cpp|c|cc|cxx)$/i.test(f));
        const discoveredFiles = this.discoverSourceFiles(project.path);

        // Deduplicate source files — use case-insensitive comparison on Windows
        // because NTFS treats "main.cpp" and "Main.cpp" as the same file.
        const seenPaths = new Set<string>();
        const sourceFiles: string[] = [];
        const addSource = (filePath: string) => {
            const key = process.platform === 'win32' ? filePath.toLowerCase() : filePath;
            if (!seenPaths.has(key)) {
                seenPaths.add(key);
                sourceFiles.push(filePath);
            }
        };
        for (const f of configuredFiles) {
            const abs = path.isAbsolute(f) ? f : path.join(project.path, f);
            addSource(abs);
        }
        for (const f of discoveredFiles) addSource(f);
        const objFiles: string[] = [];

        // Determine PCH files
        const pchHeaderName = project.pchHeader || 'stdafx.h';
        const pchCppName = pchHeaderName.replace(/\.h$/i, '.cpp');
        const pchPath = path.join(buildConfig.outputDir, pchHeaderName.replace(/\.h$/i, '.pch'));
        const pchCpp = sourceFiles.find(f => path.basename(f).toLowerCase() === pchCppName.toLowerCase());
        const nonPchFiles = sourceFiles.filter(f => path.basename(f).toLowerCase() !== pchCppName.toLowerCase());
        const usePch = !!pchCpp;

        // ── Incremental build tracking ──
        let pchRebuilt = false;
        let compiledCount = 0;
        let skippedCount = 0;

        // Newest modification time across all project headers. A header-only
        // edit doesn't bump any .cpp mtime, so without this an unchanged source
        // would be judged up-to-date and a STALE .obj linked ("works after
        // Rebuild but not Build"). Treat every source as dirty if any header is
        // newer than its .obj — a conservative full-recompile on header change.
        const newestHeaderMtime = this.newestHeaderMtime(project);

        if (sourceFiles.length > 0) {
            this.emit(`1>ClCompile:\n`);

            // Check if a source file needs recompilation by comparing mtimes.
            // A file needs recompilation if:
            //   - Its .obj doesn't exist
            //   - The source file is newer than its .obj
            //   - The PCH is being rebuilt (any header change invalidates all)

            const needsCompile = (srcPath: string, objPath: string): boolean => {
                if (!fs.existsSync(objPath)) return true;
                if (pchRebuilt) return true;  // PCH changed → everything recompiles
                try {
                    const objMtime = fs.statSync(objPath).mtimeMs;
                    if (newestHeaderMtime > objMtime) return true;  // a header changed
                    const srcMtime = fs.statSync(srcPath).mtimeMs;
                    return srcMtime > objMtime;
                } catch {
                    return true;
                }
            };

            // Step 1: Compile PCH source first with /Yc (create precompiled header)
            if (usePch && pchCpp) {
                const baseName = path.basename(pchCpp);
                const objName = uniqueObjName(pchCpp, project.path);
                const objPath = path.join(buildConfig.outputDir, objName);

                // Check if PCH needs rebuilding: pch source or pch header changed
                let pchNeedsRebuild = !fs.existsSync(pchPath) || !fs.existsSync(objPath);
                if (!pchNeedsRebuild) {
                    try {
                        const pchObjMtime = fs.statSync(objPath).mtimeMs;
                        const srcMtime = fs.statSync(pchCpp).mtimeMs;
                        if (srcMtime > pchObjMtime) pchNeedsRebuild = true;

                        // Also check the PCH header file itself
                        const pchHeaderPath = path.join(project.path, 'src', pchHeaderName);
                        if (fs.existsSync(pchHeaderPath)) {
                            const hdrMtime = fs.statSync(pchHeaderPath).mtimeMs;
                            if (hdrMtime > pchObjMtime) pchNeedsRebuild = true;
                        }
                        // Any project header newer than the PCH .obj invalidates it
                        // (the PCH transitively includes them).
                        if (newestHeaderMtime > pchObjMtime) pchNeedsRebuild = true;
                    } catch {
                        pchNeedsRebuild = true;
                    }
                }

                if (pchNeedsRebuild) {
                    // Clean stale PCH and compiler PDB to prevent C2859
                    try { fs.unlinkSync(pchPath); } catch {}
                    try { fs.unlinkSync(path.join(buildConfig.outputDir, 'vc100.pdb')); } catch {}

                    this.emit(`1>  ${baseName}\n`);

                    const result = await this.compile(pchCpp, objPath, project, buildConfig, {
                        pchMode: 'create', pchHeader: pchHeaderName, pchFile: pchPath
                    });
                    fullOutput += result.output;

                    if (result.rawLines.length > 0) {
                        for (const line of result.rawLines) this.emit(`1>  ${line}\n`);
                    }

                    if (result.errors.length > 0) {
                        errors.push(...result.errors);
                    } else {
                        objFiles.push(objPath);
                        warnings.push(...result.warnings);
                        pchRebuilt = true;
                    }
                } else {
                    // PCH is up to date — still need the .obj for linking
                    objFiles.push(objPath);
                }
            }

            // Stop if PCH compilation failed
            if (errors.length > 0) {
                const duration = Date.now() - startTime;
                this.emitFailure(project, errors, warnings, duration, unsuccessfulMarker);
                return { success: false, errors, warnings, output: fullOutput, duration };
            }

            // Step 2: Compile remaining source files with /Yu (use precompiled header)

            for (const srcPath of nonPchFiles) {
                const baseName = path.basename(srcPath);
                const objName = uniqueObjName(srcPath, project.path);
                const objPath = path.join(buildConfig.outputDir, objName);

                if (!needsCompile(srcPath, objPath)) {
                    // Up to date — skip compilation but include obj for linking
                    objFiles.push(objPath);
                    skippedCount++;
                    continue;
                }

                if (compiledCount === 0 && usePch) {
                    this.emit(`1>  Compiling...\n`);
                }
                compiledCount++;

                this.emit(`1>  ${baseName}\n`);

                const pchOpts = usePch ? { pchMode: 'use' as const, pchHeader: pchHeaderName, pchFile: pchPath } : undefined;
                const result = await this.compile(srcPath, objPath, project, buildConfig, pchOpts);
                fullOutput += result.output;

                if (result.rawLines.length > 0) {
                    for (const line of result.rawLines) this.emit(`1>  ${line}\n`);
                }

                if (result.errors.length > 0) {
                    errors.push(...result.errors);
                } else {
                    objFiles.push(objPath);
                    warnings.push(...result.warnings);
                }
            }

            if (skippedCount > 0 && compiledCount > 0) {
                this.emit(`1>  ${skippedCount} file${skippedCount > 1 ? 's' : ''} up to date, ${compiledCount} recompiled.\n`);
            } else if (compiledCount === 0 && skippedCount > 0 && !pchRebuilt) {
                this.emit(`1>  All files are up to date.\n`);
            }

            this.emit(`1>  Generating Code...\n`);
        }

        // Stop if compilation errors
        if (errors.length > 0) {
            const duration = Date.now() - startTime;
            this.emitFailure(project, errors, warnings, duration, unsuccessfulMarker);
            return { success: false, errors, warnings, output: fullOutput, duration };
        }

        // ── Link / Archive ──
        if (objFiles.length > 0) {
            if (project.type === 'library') {
                // ── Static Library: use lib.exe to create .lib archive ──
                const libName = project.name + '.lib';
                const libPath = path.join(buildConfig.outputDir, libName);
                const needsLib = compiledCount > 0 || pchRebuilt || !fs.existsSync(libPath);

                if (needsLib) {
                    this.emit(`1>Lib:\n`);
                    this.emit(`1>  ${libName}\n`);

                    const libResult = await this.archive(objFiles, libPath, project);
                    fullOutput += libResult.output;
                    errors.push(...libResult.errors);
                    warnings.push(...libResult.warnings);

                    if (libResult.rawLines.length > 0) {
                        for (const line of libResult.rawLines) {
                            this.emit(`1>  ${line}\n`);
                        }
                    }

                    if (libResult.errors.length > 0) {
                        const duration = Date.now() - startTime;
                        this.emitFailure(project, errors, warnings, duration, unsuccessfulMarker);
                        return { success: false, errors, warnings, output: fullOutput, duration };
                    }
                } else {
                    this.emit(`1>  ${libName} is up to date.\n`);
                }
            } else {
                // ── Executable or DLL: use link.exe ──
                const outputExt = project.type === 'dll' ? '.dll' : '.exe';
                const exeName = project.name + outputExt;
                const exePath = path.join(buildConfig.outputDir, exeName);

                // Skip link if nothing was recompiled and the output already exists
                const needsLink = compiledCount > 0 || pchRebuilt || !fs.existsSync(exePath);

                if (needsLink) {
                    this.emit(`1>Link:\n`);
                    this.emit(`1>  ${exeName}\n`);

                    const linkResult = await this.link(objFiles, exePath, project, buildConfig);
                    fullOutput += linkResult.output;
                    errors.push(...linkResult.errors);
                    warnings.push(...linkResult.warnings);

                    if (linkResult.rawLines.length > 0) {
                        for (const line of linkResult.rawLines) {
                            this.emit(`1>  ${line}\n`);
                        }
                    }

                    if (linkResult.errors.length > 0) {
                        const duration = Date.now() - startTime;
                        this.emitFailure(project, errors, warnings, duration, unsuccessfulMarker);
                        return { success: false, errors, warnings, output: fullOutput, duration };
                    }

                    // ── ImageXex (executables and DLLs both get XEX-wrapped on Xbox 360) ──
                    if (project.type === 'executable' || project.type === 'dll') {
                        this.emit(`1>ImageXex:\n`);
                        const xexPath = path.join(buildConfig.outputDir, project.name + '.xex');

                        this.emit(`1>  Microsoft(R) Xbox 360 Image File Builder Version 2.0.21256.0\n`);
                        this.emit(`1>  (c)2012 Microsoft Corporation. All rights reserved.\n`);
                        this.emit(`1>  \n`);

                        const xexResult = await this.buildXex(exePath, xexPath, project);
                        fullOutput += xexResult.output;

                        if (xexResult.rawLines.length > 0) {
                            for (const line of xexResult.rawLines) {
                                this.emit(`1>  ${line}\n`);
                            }
                        }

                        if (xexResult.errors.length > 0) {
                            errors.push(...xexResult.errors);
                            const duration = Date.now() - startTime;
                            this.emitFailure(project, errors, warnings, duration, unsuccessfulMarker);
                            return { success: false, errors, warnings, output: fullOutput, duration };
                        }
                    }
                } else {
                    this.emit(`1>  ${exeName} is up to date.\n`);
                }
            }
        }

        // ── FinalizeBuildStatus ──
        const duration = Date.now() - startTime;
        const success = errors.length === 0;

        if (success) {
            this.emit(`1>FinalizeBuildStatus:\n`);
            try { if (fs.existsSync(unsuccessfulMarker)) fs.unlinkSync(unsuccessfulMarker); } catch {}
            this.emit(`1>  Deleting file "${path.relative(project.path, unsuccessfulMarker)}".\n`);
            const lastBuildState = path.join(buildConfig.outputDir, `${project.name}.lastbuildstate`);
            try { fs.writeFileSync(lastBuildState, new Date().toISOString()); } catch {}
            this.emit(`1>  Touching "${path.relative(project.path, lastBuildState)}".\n`);
            this.emit(`1>\n`);
            this.emit(`1>Build succeeded.\n`);
            this.emit(`1>\n`);
            this.emit(`1>Time Elapsed ${this.elapsed(duration)}\n`);
            this.emit(`========== Build: 1 succeeded, 0 failed, 0 up-to-date, 0 skipped ==========\n`);
        } else {
            this.emitFailure(project, errors, warnings, duration, unsuccessfulMarker);
        }

        const outputExt = project.type === 'library' ? '.lib' : '.xex';
        const outputFile = path.join(buildConfig.outputDir, project.name + outputExt);
        // Only report an output path if the artifact actually exists. An empty
        // project (no sources → no link step) otherwise "succeeds" and returns
        // a path to a non-existent .xex, which makes Run/Deploy fail with a
        // confusing "XEX not found".
        let outputExists = false;
        try { outputExists = fs.existsSync(outputFile); } catch {}
        return { success, errors, warnings, output: fullOutput, duration, outputFile: success && outputExists ? outputFile : undefined };
    }

    private emitFailure(project: ProjectConfig, errors: BuildMessage[], warnings: BuildMessage[], duration: number, unsuccessfulMarker: string) {
        this.emit(`1>FinalizeBuildStatus:\n`);
        this.emit(`1>  "${path.basename(unsuccessfulMarker)}" was not deleted — build failed.\n`);
        this.emit(`1>\n`);
        this.emit(`1>Build FAILED.\n`);
        this.emit(`1>\n`);
        if (errors.length > 0) {
            for (const err of errors) {
                const loc = err.file ? `${path.basename(err.file)}${err.line ? `(${err.line})` : ''}` : project.name;
                this.emit(`1>${loc}: error: ${err.message}\n`);
            }
            this.emit(`1>\n`);
        }
        this.emit(`1>Time Elapsed ${this.elapsed(duration)}\n`);
        this.emit(`========== Build: 0 succeeded, 1 failed, 0 up-to-date, 0 skipped ==========\n`);
    }

    /**
     * Compile a single source file.
     */
    private async compile(
        srcPath: string,
        objPath: string,
        project: ProjectConfig,
        config: BuildConfig,
        pchOpts?: { pchMode: 'create' | 'use'; pchHeader: string; pchFile: string }
    ): Promise<{ output: string; errors: BuildMessage[]; warnings: BuildMessage[]; rawLines: string[] }> {
        const sdkPaths = this.toolchain.getPaths();
        if (!sdkPaths) {
            return { output: '', errors: [{ file: srcPath, line: 0, column: 0, message: 'Xbox 360 SDK not configured. Go to Settings > SDK Setup.', severity: 'error' }], warnings: [], rawLines: ['error: Xbox 360 SDK not configured'] };
        }

        const clPath = this.toolchain.getToolPath('cl.exe');
        if (!clPath) {
            return { output: '', errors: [{ file: srcPath, line: 0, column: 0, message: 'cl.exe not found in SDK', severity: 'error' }], warnings: [], rawLines: ['error: cl.exe not found in SDK bin directory'] };
        }

        const args: string[] = ['/nologo', '/c', `/Fo"${objPath}"`];

        // Precompiled header flags
        if (pchOpts) {
            if (pchOpts.pchMode === 'create') {
                // /Yc creates the .pch from this source file
                args.push(`/Yc"${pchOpts.pchHeader}"`);
            } else {
                // /Yu uses an existing .pch
                args.push(`/Yu"${pchOpts.pchHeader}"`);
            }
            args.push(`/Fp"${pchOpts.pchFile}"`);
        }

        // Include paths — Xbox-specific headers MUST come first to avoid
        // picking up internal CRT headers from Source\crt\
        const xboxInc = path.join(sdkPaths.include, 'xbox');
        if (fs.existsSync(xboxInc)) args.push(`/I"${xboxInc}"`);
        args.push(`/I"${sdkPaths.include}"`);

        // MSVC CRT headers (excpt.h, stdarg.h, etc.) — needed by xtl.h
        // Check multiple possible locations for the Visual C++ headers
        const vcIncludeCandidates = [
            path.join(sdkPaths.root, 'vc', 'include'),
            path.join(sdkPaths.root, 'include', 'msvc'),
            path.join(sdkPaths.root, 'msvc', 'include'),
            // TechPreview compiler headers — contains public excpt.h, crtdefs.h,
            // vadefs.h without the internal CRT #error guard that Source\crt has.
            // This is the primary fallback for machines without VS installed.
            path.join(sdkPaths.root, 'TechPreview', 'Jul12Compiler', 'include', 'xbox'),
            // Standard MSVC 2010 install
            'C:\\Program Files (x86)\\Microsoft Visual Studio 10.0\\VC\\include',
            'C:\\Program Files\\Microsoft Visual Studio 10.0\\VC\\include',
            // MSVC 2008
            'C:\\Program Files (x86)\\Microsoft Visual Studio 9.0\\VC\\include',
            'C:\\Program Files\\Microsoft Visual Studio 9.0\\VC\\include',
        ];
        for (const vcInc of vcIncludeCandidates) {
            if (fs.existsSync(vcInc) && fs.existsSync(path.join(vcInc, 'excpt.h'))) {
                args.push(`/I"${vcInc}"`);
                break;
            }
        }
        // Project source dir
        args.push(`/I"${path.join(project.path, 'src')}"`);
        args.push(`/I"${project.path}"`);
        for (const inc of effectiveSettings(project, config.configuration).includeDirectories) {
            const incPath = path.isAbsolute(inc) ? inc : path.join(project.path, inc);
            args.push(`/I"${incPath}"`);
        }

        // Configuration-specific flags
        if (config.configuration === 'Debug') {
            args.push('/Od', '/Zi', `/Fd"${path.join(config.outputDir, 'vc100.pdb')}"`, '/D_DEBUG', '/DDEBUG', '/RTC1', '/GS');
        } else if (config.configuration === 'Release') {
            args.push('/O2', '/Ox', '/DNDEBUG', '/GS-');
        } else if (config.configuration === 'Profile') {
            args.push('/O2', '/Zi', `/Fd"${path.join(config.outputDir, 'vc100.pdb')}"`, '/DNDEBUG', '/DPROFILE', '/GS-');
        } else if (config.configuration === 'Release_LTCG') {
            // Link-Time Code Generation: /GL defers codegen to the linker so it can
            // optimise across translation units. It pairs with /LTCG on the link
            // step — /GL objects are not real object files and a plain link fails.
            args.push('/O2', '/Ox', '/DNDEBUG', '/DLTCG', '/GS-', '/GL');
        }

        // C runtime — must match the configuration's _DEBUG setting.
        //
        // Without this, cl.exe defaults to /MT (release CRT) while a Debug build
        // defines _DEBUG. The CRT/STL headers then emit debug-only assertion
        // calls — _CrtDbgReportW from std::vector::operator[], vcompd.lib and
        // friends — which live only in the debug CRT, and the link fails with a
        // single baffling unresolved external.
        //
        // Defaults match Visual Studio's Xbox 360 defaults: MultiThreadedDebug
        // for Debug, MultiThreaded otherwise.
        const crt = effectiveSettings(project, config.configuration).runtimeLibrary
            ?? (config.configuration === 'Debug' ? 'MTd' : 'MT');
        args.push(`/${crt}`);

        // Xbox 360 specific defines
        args.push('/D_XBOX', '/DXBOX', '/D_XBOX_VER=200');

        // User defines
        for (const def of config.defines) args.push(`/D${def}`);

        // Standard flags — driven by Project Properties
        // Exception handling
        const eh = project.exceptionHandling ?? 'sync';
        if (eh === 'sync') args.push('/EHsc');
        else if (eh === 'async') args.push('/EHa');
        // 'none' = omit /EH entirely

        // Warning level
        const wl = project.warningLevel ?? 3;
        args.push(`/W${wl}`);

        // Treat warnings as errors
        if (project.treatWarningsAsErrors) args.push('/WX');

        // RTTI
        if (project.enableRtti) args.push('/GR');
        else args.push('/GR-');

        // Optimization override (if set, overrides configuration defaults)
        if (project.optimizationOverride && project.optimizationOverride !== 'default') {
            // Remove any existing /O flags that were added by configuration block above
            const oIdx = args.findIndex(a => a.startsWith('/O') || a === '/Od');
            if (oIdx !== -1) args.splice(oIdx, 1);
            // Also remove /Ox if present
            const oxIdx = args.findIndex(a => a === '/Ox');
            if (oxIdx !== -1) args.splice(oxIdx, 1);

            switch (project.optimizationOverride) {
                case 'disabled': args.push('/Od'); break;
                case 'minSize': args.push('/O1'); break;
                case 'maxSpeed': args.push('/O2'); break;
                case 'full': args.push('/Ox'); break;
            }
        }

        // Additional compiler flags from Project Properties
        if (project.additionalCompilerFlags) {
            const extra = project.additionalCompilerFlags.trim().split(/\s+/).filter(f => f);
            args.push(...extra);
        }

        // Additional compiler flags from BuildConfig (runtime overrides)
        args.push(...config.compilerFlags);

        // Source file
        args.push(`"${srcPath}"`);

        return this.runTool(clPath, args, srcPath);
    }

    /**
     * Link object files into an executable.
     */
    private async link(
        objFiles: string[],
        outputPath: string,
        project: ProjectConfig,
        config: BuildConfig
    ): Promise<{ output: string; errors: BuildMessage[]; warnings: BuildMessage[]; rawLines: string[] }> {
        const sdkPaths = this.toolchain.getPaths();
        if (!sdkPaths) {
            return { output: '', errors: [{ file: '', line: 0, column: 0, message: 'SDK not configured', severity: 'error' }], warnings: [], rawLines: [] };
        }

        const linkPath = this.toolchain.getToolPath('link.exe');
        if (!linkPath) {
            return { output: '', errors: [{ file: '', line: 0, column: 0, message: 'link.exe not found', severity: 'error' }], warnings: [], rawLines: ['error: link.exe not found in SDK'] };
        }

        const args: string[] = ['/nologo', `/OUT:"${outputPath}"`];

        if (project.type === 'dll') args.push('/DLL');

        // Xbox 360 link.exe infers MACHINE/SUBSYSTEM/ENTRY automatically

        // Library paths
        const xboxLib = path.join(sdkPaths.lib, 'xbox');
        if (fs.existsSync(xboxLib)) args.push(`/LIBPATH:"${xboxLib}"`);
        for (const libDir of effectiveSettings(project, config.configuration).libraryDirectories) {
            const libPath = path.isAbsolute(libDir) ? libDir : path.join(project.path, libDir);
            args.push(`/LIBPATH:"${libPath}"`);
        }

        // Default Xbox 360 libraries.
        //
        // The XDK ships FOUR flavours of most libs, not two, and the suffix is
        // per-configuration — taken from what VS2010 puts in AdditionalDependencies:
        //
        //   Debug         d3d9d.lib      xact3d.lib      xmcored.lib     (+xbdm)
        //   Profile       d3d9i.lib      xact3i.lib      xmcorei.lib     (+xbdm)  "i" = instrumented
        //   Release       d3d9.lib       xact3.lib       xmcore.lib
        //   Release_LTCG  d3d9ltcg.lib   xact3ltcg.lib   xmcoreltcg.lib
        //
        // This used to be `isDebug ? 'd3d9d.lib' : 'd3d9.lib'`, which meant Profile
        // silently linked the Release libs rather than the instrumented ones, and
        // Release_LTCG had no libs of its own at all.
        const cfg = config.configuration;
        const LIBS: Record<string, string[]> = {
            Debug: [
                'xapilibd.lib', 'xboxkrnl.lib',
                'd3d9d.lib', 'd3dx9d.lib', 'xgraphicsd.lib',
                'xaudiod2.lib', 'xactd3.lib', 'x3daudiod.lib',
                'xmcored.lib', 'xnetd.lib', 'xinput2d.lib', 'vcompd.lib',
                'xbdm.lib',
            ],
            Profile: [
                'xapilibi.lib', 'xboxkrnl.lib',
                'd3d9i.lib', 'd3dx9.lib', 'xgraphics.lib',
                'xaudio2.lib', 'xact3i.lib', 'x3daudioi.lib',
                'xmcorei.lib', 'xnet.lib', 'xinput2.lib', 'vcomp.lib',
                'xbdm.lib',
            ],
            Release: [
                'xapilib.lib', 'xboxkrnl.lib',
                'd3d9.lib', 'd3dx9.lib', 'xgraphics.lib',
                'xaudio2.lib', 'xact3.lib', 'x3daudio.lib',
                'xmcore.lib', 'xnet.lib', 'xinput2.lib', 'vcomp.lib',
            ],
            Release_LTCG: [
                'xapilib.lib', 'xboxkrnl.lib',
                'd3d9ltcg.lib', 'd3dx9.lib', 'xgraphics.lib',
                'xaudio2.lib', 'xact3ltcg.lib', 'x3daudioltcg.lib',
                'xmcoreltcg.lib', 'xnet.lib', 'xinput2.lib', 'vcomp.lib',
            ],
        };
        args.push(...(LIBS[cfg] || LIBS.Release));

        // SDK headers auto-link xapilib.lib via #pragma comment(lib). Suppress it
        // wherever we link a different flavour, or both end up on the command line
        // and the linker reports duplicate symbols.
        if (cfg === 'Debug') args.push('/NODEFAULTLIB:xapilib.lib');
        else if (cfg === 'Profile') args.push('/NODEFAULTLIB:xapilib.lib');

        // User libraries — this configuration's, not whichever set was imported.
        for (const lib of effectiveSettings(project, config.configuration).libraries) args.push(lib);

        // Link-time code generation — must match the /GL used when compiling.
        // /LTCG is incompatible with /INCREMENTAL, so it goes before the debug
        // block and Release_LTCG deliberately takes neither.
        if (config.configuration === 'Release_LTCG') {
            args.push('/LTCG');
        }

        // Debug info
        if (config.configuration === 'Debug' || config.configuration === 'Profile') {
            args.push('/INCREMENTAL');
            args.push('/DEBUG');
            const pdbPath = outputPath.replace(/\.(exe|dll)$/i, '.pdb');
            args.push(`/PDB:"${pdbPath}"`);
        }

        // Additional linker flags from Project Properties
        if (project.additionalLinkerFlags) {
            const extra = project.additionalLinkerFlags.trim().split(/\s+/).filter(f => f);
            args.push(...extra);
        }

        // Additional linker flags from BuildConfig (runtime overrides)
        args.push(...config.linkerFlags);

        // Object files
        for (const obj of objFiles) args.push(`"${obj}"`);

        // Xbox 360 link.exe: skip XEX generation (done separately by buildXex)
        args.push('/XEX:NO');

        // Use a response file to avoid "The command line is too long" errors.
        // Large projects (100+ .obj files) easily exceed the Windows command
        // line limit of ~8191 chars (cmd.exe) or 32768 chars (CreateProcess).
        // link.exe natively supports @responsefile syntax, just like MSBuild uses.
        const rspPath = path.join(config.outputDir, 'link.rsp');
        fs.writeFileSync(rspPath, args.join('\n'), 'utf-8');

        return this.runTool(linkPath, [`@"${rspPath}"`], '');
    }

    /**
     * Create a static library (.lib) from object files using lib.exe.
     */
    private async archive(
        objFiles: string[],
        outputPath: string,
        project: ProjectConfig
    ): Promise<{ output: string; errors: BuildMessage[]; warnings: BuildMessage[]; rawLines: string[] }> {
        const libExe = this.toolchain.getToolPath('lib.exe');
        if (!libExe) {
            return { output: '', errors: [{ file: '', line: 0, column: 0, message: 'lib.exe not found in SDK', severity: 'error' }], warnings: [], rawLines: ['error: lib.exe not found in SDK'] };
        }

        const args: string[] = ['/nologo', `/OUT:"${outputPath}"`];

        // Additional linker/lib flags from Project Properties
        if (project.additionalLinkerFlags) {
            const extra = project.additionalLinkerFlags.trim().split(/\s+/).filter(f => f);
            args.push(...extra);
        }

        // Object files
        for (const obj of objFiles) args.push(`"${obj}"`);

        // Use a response file for large projects
        const rspPath = path.join(path.dirname(outputPath), 'lib.rsp');
        fs.writeFileSync(rspPath, args.join('\n'), 'utf-8');

        return this.runTool(libExe, [`@"${rspPath}"`], '');
    }

    /**
     * Build XEX from executable.
     */
    private async buildXex(
        exePath: string,
        xexPath: string,
        project: ProjectConfig
    ): Promise<{ output: string; errors: BuildMessage[]; warnings: BuildMessage[]; rawLines: string[] }> {
        const imagexex = this.toolchain.getToolPath('imagexex.exe');
        if (!imagexex) {
            return { output: '', errors: [{ file: '', line: 0, column: 0, message: 'imagexex.exe not found', severity: 'error' }], warnings: [], rawLines: ['error: imagexex.exe not found'] };
        }

        const props = project.properties || {};
        const args: string[] = ['/nologo'];

        // Output path
        args.push(`/out:"${xexPath}"`);

        // Configuration file (xex.xml) — if specified, overrides individual settings
        if (props.xexConfigFile) {
            const cfgPath = path.isAbsolute(props.xexConfigFile)
                ? props.xexConfigFile
                : path.join(project.path, props.xexConfigFile);
            if (fs.existsSync(cfgPath)) {
                args.push(`/config:"${cfgPath}"`);
            }
        }

        // Title ID
        if (props.xexTitleId) {
            args.push(`/titleid:${props.xexTitleId}`);
        }

        // LAN Key
        if (props.xexLanKey) {
            args.push(`/lankey:${props.xexLanKey}`);
        }

        // Base Address
        if (props.xexBaseAddress) {
            args.push(`/baseaddr:${props.xexBaseAddress}`);
        }

        // Heap Size
        if (props.xexHeapSize) {
            args.push(`/heapsize:${props.xexHeapSize}`);
        }

        // Workspace Size
        if (props.xexWorkspaceSize) {
            args.push(`/workspace:${props.xexWorkspaceSize}`);
        }

        // Export By Name
        if (props.xexExportByName) {
            args.push('/exportbyname');
        }

        // Additional Sections
        if (props.xexAdditionalSections) {
            for (const sec of props.xexAdditionalSections.split(';').filter((s: string) => s.trim())) {
                args.push(`/addsection:${sec.trim()}`);
            }
        }

        // Privileges flags
        if (props.xexDvdMapping) args.push('/opticaldiscdriveemulation');
        if (props.xexPal50) args.push('/pal50incompatible');
        if (props.xexMultiDisc) args.push('/multidisctitle');
        if (props.xexBigButton) args.push('/preferbigbuttoninput');
        if (props.xexCrossPlatform) args.push('/crossplatformsystemlink');
        if (props.xexAvatarXuid) args.push('/allowavatargetmetadatabyxuid');
        if (props.xexControllerSwap) args.push('/allowcontrollerswapping');
        if (props.xexFullExperience) args.push('/requirefullexperience');
        if (props.xexGameVoice) args.push('/gamevoicerequiredui');
        if (props.xexNetworkAccess) args.push('/allownetworkaccess');
        if (props.xexKinectElevation) args.push('/kinectelevationcontrol');
        if (props.xexSkeletal && props.xexSkeletal !== 'none') {
            args.push(`/skeletaltracking:${props.xexSkeletal}`);
        }

        // Additional XEX flags
        if (props.xexAdditionalOptions) {
            const extra = props.xexAdditionalOptions.trim().split(/\s+/).filter((f: string) => f);
            args.push(...extra);
        }

        // Input executable
        args.push(`"${exePath}"`);

        return this.runTool(imagexex, args, '');
    }

    /**
     * Clean build artifacts.
     */
    async clean(project: ProjectConfig): Promise<void> {
        // Only delete build artifacts — NOT the entire out/ directory.
        // Users keep non-build files (Content folders, assets, configs, etc.)
        // in the output directories that must be preserved.
        const BUILD_ARTIFACT_EXTS = new Set([
            '.obj', '.pch', '.pdb', '.exe', '.dll', '.xex', '.exp', '.lib',
            '.ilk', '.rsp', '.lastbuildstate', '.unsuccessfulbuild',
            '.idb', '.res', '.manifest',
        ]);

        const configs = ['Debug', 'Release', 'Profile'];
        let cleanedCount = 0;

        for (const cfg of configs) {
            const cfgDir = path.join(project.path, 'out', cfg);
            if (!fs.existsSync(cfgDir)) continue;

            for (const entry of fs.readdirSync(cfgDir, { withFileTypes: true })) {
                // Only delete files, never directories (Content/, etc.)
                if (!entry.isDirectory()) {
                    const ext = path.extname(entry.name).toLowerCase();
                    if (BUILD_ARTIFACT_EXTS.has(ext)) {
                        try {
                            fs.unlinkSync(path.join(cfgDir, entry.name));
                            cleanedCount++;
                        } catch {}
                    }
                }
            }
        }

        this.emit(`1>  Cleaned ${cleanedCount} build artifact${cleanedCount !== 1 ? 's' : ''}.\n`);
        this.emit(`========== Clean: 1 succeeded ==========\n`);
    }

    /**
     * Cancel the current build.
     */
    cancel() {
        if (this.currentProcess) {
            this.currentProcess.kill();
            this.currentProcess = null;
            this.emit('\n========== Build: cancelled ==========\n');
        }
    }

    /**
     * Return the newest mtime (ms) among all header files the project could
     * include: everything under src/, loose headers in the project root, and
     * any configured include directories. Returns 0 if none are found.
     *
     * Used to detect header-only edits, which don't change any .cpp mtime.
     */
    private newestHeaderMtime(project: ProjectConfig): number {
        const HEADER_RE = /\.(h|hpp|hxx|hh|inl|ipp)$/i;
        let newest = 0;
        const visited = new Set<string>();
        const scanDir = (dir: string, depth: number) => {
            if (depth > 16) return;
            let entries: fs.Dirent[];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const entry of entries) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (['out', 'obj', '.git', 'node_modules'].includes(entry.name)) continue;
                    const key = process.platform === 'win32' ? full.toLowerCase() : full;
                    if (visited.has(key)) continue;
                    visited.add(key);
                    scanDir(full, depth + 1);
                } else if (HEADER_RE.test(entry.name)) {
                    try {
                        const m = fs.statSync(full).mtimeMs;
                        if (m > newest) newest = m;
                    } catch {}
                }
            }
        };
        scanDir(path.join(project.path, 'src'), 0);
        try {
            for (const entry of fs.readdirSync(project.path, { withFileTypes: true })) {
                if (!entry.isDirectory() && HEADER_RE.test(entry.name)) {
                    try {
                        const m = fs.statSync(path.join(project.path, entry.name)).mtimeMs;
                        if (m > newest) newest = m;
                    } catch {}
                }
            }
        } catch {}
        for (const inc of (project.includeDirectories || [])) {
            const incPath = path.isAbsolute(inc) ? inc : path.join(project.path, inc);
            scanDir(incPath, 0);
        }
        return newest;
    }

    /**
     * Scan project directory for source files.
     */
    private discoverSourceFiles(projectPath: string): string[] {
        const sources: string[] = [];
        const srcDir = path.join(projectPath, 'src');
        const scanDir = (dir: string) => {
            if (!fs.existsSync(dir)) return;
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (entry.isDirectory()) {
                    if (!['out', 'obj', '.git', 'node_modules'].includes(entry.name)) {
                        scanDir(path.join(dir, entry.name));
                    }
                } else if (/\.(cpp|c|cc|cxx)$/i.test(entry.name)) {
                    sources.push(path.join(dir, entry.name));
                }
            }
        };
        // Scan src/ folder first, then root
        scanDir(srcDir);
        // Also check root for any loose source files
        if (fs.existsSync(projectPath)) {
            for (const entry of fs.readdirSync(projectPath, { withFileTypes: true })) {
                if (!entry.isDirectory() && /\.(cpp|c|cc|cxx)$/i.test(entry.name)) {
                    sources.push(path.join(projectPath, entry.name));
                }
            }
        }
        return sources;
    }

    /**
     * Run a tool and parse output for errors/warnings.
     */
    private runTool(toolPath: string, args: string[], contextFile: string): Promise<{ output: string; errors: BuildMessage[]; warnings: BuildMessage[]; rawLines: string[] }> {
        return new Promise((resolve) => {
            const env = this.toolchain.getToolEnvironment();
            let proc: ChildProcess;

            try {
                // Quote the tool path to handle spaces (e.g. C:\Program Files (x86)\...)
                const quotedTool = toolPath.includes(' ') ? `"${toolPath}"` : toolPath;
                // Set cwd to the tool's directory so Windows DLL search finds sibling
                // DLLs (c1.dll, c1xx.dll, c2.dll, mspdb*.dll, MSVC runtimes, etc.)
                const toolDir = path.dirname(toolPath);
                proc = spawn(quotedTool, args, { env, cwd: toolDir, shell: true, windowsHide: true });
            } catch (err: any) {
                resolve({
                    output: err.message,
                    errors: [{ file: contextFile, line: 0, column: 0, message: `Failed to launch: ${path.basename(toolPath)} — ${err.message}`, severity: 'error' }],
                    warnings: [],
                    rawLines: [`error: Failed to launch ${path.basename(toolPath)}: ${err.message}`],
                });
                return;
            }

            this.currentProcess = proc;
            let output = '';
            const errors: BuildMessage[] = [];
            const warnings: BuildMessage[] = [];
            const rawLines: string[] = [];

            const parseLine = (line: string) => {
                output += line + '\n';

                // MSVC error format: file(line): error Cxxxx: message
                const match = line.match(/^(.+?)\((\d+)\)\s*:\s*(error|warning)\s+(\w+)\s*:\s*(.+)/i);
                if (match) {
                    const msg: BuildMessage = {
                        file: match[1],
                        line: parseInt(match[2]),
                        column: 0,
                        message: `${match[4]}: ${match[5]}`,
                        severity: match[3].toLowerCase() as 'error' | 'warning',
                    };
                    if (msg.severity === 'error') errors.push(msg);
                    else warnings.push(msg);
                    rawLines.push(line);
                    return;
                }

                // Linker error: LINK : fatal error LNKxxxx: message
                const linkMatch = line.match(/LINK\s*:\s*(fatal\s+error|error|warning)\s+(\w+)\s*:\s*(.+)/i);
                if (linkMatch) {
                    const severity = linkMatch[1].toLowerCase().includes('error') ? 'error' : 'warning';
                    const msg: BuildMessage = {
                        file: contextFile || 'LINK',
                        line: 0, column: 0,
                        message: `${linkMatch[2]}: ${linkMatch[3]}`,
                        severity: severity as 'error' | 'warning',
                    };
                    if (severity === 'error') errors.push(msg);
                    else warnings.push(msg);
                    rawLines.push(line);
                    return;
                }

                // Unresolved external
                const unresolved = line.match(/error\s+(LNK\d+)\s*:\s*(.+)/i);
                if (unresolved) {
                    errors.push({
                        file: contextFile || 'LINK', line: 0, column: 0,
                        message: `${unresolved[1]}: ${unresolved[2]}`,
                        severity: 'error',
                    });
                    rawLines.push(line);
                    return;
                }

                // Skip nologo/blank lines, only collect meaningful tool output
                // Also skip cl.exe filename echo (just the bare source filename)
                if (line.trim() && !line.match(/^Microsoft|^Copyright|^\s*$/) && !line.match(/^\w+\.(cpp|c|cc|cxx|obj|h)$/i)) {
                    rawLines.push(line);
                }
            };

            proc.stdout?.on('data', (data) => {
                data.toString().split('\n').forEach((l: string) => { if (l.trim()) parseLine(l.trim()); });
            });

            proc.stderr?.on('data', (data) => {
                data.toString().split('\n').forEach((l: string) => { if (l.trim()) parseLine(l.trim()); });
            });

            proc.on('close', (code) => {
                this.currentProcess = null;
                // If process exited with error code but we didn't parse any errors,
                // add a generic error
                if (code && code !== 0 && errors.length === 0) {
                    // 0xC0000135 (3221225781 unsigned / -1073741515 signed) = STATUS_DLL_NOT_FOUND
                    const isDllNotFound = code === 3221225781 || code === -1073741515;
                    const message = isDllNotFound
                        ? `${path.basename(toolPath)} failed: a required DLL was not found (0xC0000135). Ensure msvcr100.dll and msvcp100.dll are in the SDK bin\\win32 folder.`
                        : `${path.basename(toolPath)} exited with code ${code}`;
                    errors.push({
                        file: contextFile || path.basename(toolPath),
                        line: 0, column: 0,
                        message,
                        severity: 'error',
                    });
                    rawLines.push(`error: ${message}`);
                }
                resolve({ output, errors, warnings, rawLines });
            });

            proc.on('error', (err) => {
                this.currentProcess = null;
                errors.push({
                    file: contextFile, line: 0, column: 0,
                    message: `Cannot execute ${path.basename(toolPath)}: ${err.message}`,
                    severity: 'error',
                });
                rawLines.push(`error: Cannot execute ${path.basename(toolPath)}: ${err.message}`);
                resolve({ output, errors, warnings, rawLines });
            });
        });
    }
}

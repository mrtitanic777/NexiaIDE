/**
 * Xbox 360 Build System
 * Handles compilation, linking, and XEX packaging.
 * Output format mirrors Visual Studio / MSBuild for Xbox 360.
 */

import { logCore } from './coreLog';
import * as os from 'os';
import { execFileSync } from 'child_process';
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
/** One source file's place in the plan: what to compile it to, and with what. */
interface CompileEntry {
    source: string;
    obj: string;
    /** Which pass. 'create' is the /Yc line and is always first. */
    pch: 'create' | 'use' | 'none';
    args: string[];
}

/** What `nexia-core build args` hands back for one configuration. */
interface BuildPlan {
    ok: true;
    configuration: BuildConfiguration;
    outputDir: string;
    compileTool: string;
    /** The .pch to create/use, or null when the project has no PCH source. */
    pchFile: string | null;
    compile: CompileEntry[];
    /** Empty when the tool is missing from the SDK; one of the two is null. */
    linkTool?: string;
    archiveTool?: string;
    output: string;
    link: string[] | null;
    archive: string[] | null;
}

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

    /**
     * @param chain Resolved paths of the projects already being built above this
     *        one, for cycle detection. A -> B -> A would otherwise recurse until
     *        the stack gives out.
     */
    private async runBuild(project: ProjectConfig, config?: Partial<BuildConfig>, chain: string[] = []): Promise<BuildResult> {
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

        // ── ProjectReference ──
        // Build what this project depends on first, then fold each dependency's
        // .lib and include folder into this build. Visual Studio links the
        // output of a referenced project automatically ("Link Library
        // Dependencies" defaults to true) and rebuilds it when its sources
        // change; both are the point of a reference, so both happen here.
        const refs = await this.buildReferences(project, buildConfig, chain);
        fullOutput += refs.output;
        if (refs.errors.length > 0) {
            errors.push(...refs.errors);
            const duration = Date.now() - startTime;
            this.emitFailure(project, errors, warnings, duration, unsuccessfulMarker);
            return { success: false, errors, warnings, output: fullOutput, duration };
        }

        // From here on, `project` carries its dependencies' libraries and
        // includes. Flattened for this one configuration: a per-configuration
        // override *replaces* the flat list rather than adding to it, so
        // appending to project.libraries would be silently dropped by any
        // project that has a `configurations` entry — XUI has one.
        if (refs.libs.length || refs.includes.length || refs.libDirs.length) {
            const eff = effectiveSettings(project, configuration);
            project = {
                ...project,
                libraries: [...eff.libraries, ...refs.libs],
                defines: eff.defines,
                includeDirectories: [...eff.includeDirectories, ...refs.includes],
                libraryDirectories: [...eff.libraryDirectories, ...refs.libDirs],
                runtimeLibrary: eff.runtimeLibrary,
                // Already folded in above; leaving it would re-apply the
                // override and undo the merge.
                configurations: undefined,
            };
        }

        // ── The plan ──
        // Sources, object names, PCH and every command line, worked out once by
        // nexia-core. What used to be here — the configured-list/directory-scan
        // merge, the case-insensitive dedup, the .h → .cpp/.pch naming — is the
        // same code in core/buildsystem.c, and having it in both languages was
        // the last place a compiler flag could be fixed in one and stay broken
        // in the other.
        let plan: BuildPlan;
        try {
            plan = this.plan(project, configuration);
        } catch (err: any) {
            // Surfaced as a build error rather than thrown, because everything
            // this can fail on — no SDK, no cl.exe, a project nexia-core
            // refuses — is a thing the Output panel should say out loud.
            const duration = Date.now() - startTime;
            errors.push({ file: '', line: 0, column: 0, message: err.message, severity: 'error' });
            this.emit(`1>\n1>  ERROR: ${err.message}\n1>\n`);
            this.emitFailure(project, errors, warnings, duration, unsuccessfulMarker);
            return { success: false, errors, warnings, output: fullOutput, duration };
        }

        const objFiles: string[] = [];
        const pchEntry = plan.compile.find(e => e.pch === 'create');
        const nonPchEntries = plan.compile.filter(e => e.pch !== 'create');
        const usePch = !!pchEntry;
        // Named by the plan, not recomputed: this file's .h → .pch rule lives in
        // core/buildsystem.c now, and a second copy here would be the same bug
        // waiting to happen.
        const pchPath = plan.pchFile;
        // Not the plan's business: this names the *header* to stat for staleness,
        // not anything that reaches a command line. The default matches
        // core/buildsystem.c's, which is a duplicated literal and nothing more —
        // if it ever grows a rule, the rule belongs in the C and the plan should
        // carry the answer back.
        const pchHeaderName = project.pchHeader || 'stdafx.h';

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

        if (plan.compile.length > 0) {
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
            if (usePch && pchEntry && pchPath) {
                const pchCpp = pchEntry.source;
                const baseName = path.basename(pchCpp);
                const objPath = pchEntry.obj;

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

                    const result = await this.compileEntry(pchEntry, plan);
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

            for (const entry of nonPchEntries) {
                const srcPath = entry.source;
                const baseName = path.basename(srcPath);
                const objPath = entry.obj;

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

                const result = await this.compileEntry(entry, plan);
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
                // The name and the path are the plan's, not rebuilt from
                // project.name here — same reason as the .obj names.
                const libPath = plan.output;
                const libName = path.basename(libPath);
                const needsLib = compiledCount > 0 || pchRebuilt || !fs.existsSync(libPath);

                if (needsLib) {
                    this.emit(`1>Lib:\n`);
                    this.emit(`1>  ${libName}\n`);

                    const libResult = await this.archiveWithPlan(plan);
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
                const exePath = plan.output;
                const exeName = path.basename(exePath);

                // Skip link if nothing was recompiled and the output already exists
                const needsLink = compiledCount > 0 || pchRebuilt || !fs.existsSync(exePath);

                if (needsLink) {
                    this.emit(`1>Link:\n`);
                    this.emit(`1>  ${exeName}\n`);

                    const linkResult = await this.linkWithPlan(plan);
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

        // ── XuiPackage ──
        // After linking, because it writes beside the XEX rather than into it,
        // and because a compile error should surface before a content error.
        if (project.xuiContent && errors.length === 0) {
            const xuiResult = await this.buildXuiContent(project, buildConfig);
            fullOutput += xuiResult.output;
            errors.push(...xuiResult.errors);
            if (xuiResult.errors.length > 0) {
                const duration = Date.now() - startTime;
                this.emitFailure(project, errors, warnings, duration, unsuccessfulMarker);
                return { success: false, errors, warnings, output: fullOutput, duration };
            }
        }

        // ── Content ──
        // Copy the project's Content\ folder next to the XEX, so a runtime
        // game:\Content\... locator resolves. The Minecraft demo loads
        // game:\Content\dirt.png this way; without this the file is never beside
        // the XEX and the texture load always fails to the procedural fallback.
        //
        // Executables and DLLs only (a .lib has no runtime), and not gated on
        // whether the link ran: a texture can change with no source edit, so an
        // up-to-date build must still refresh the deployed content.
        if ((project.type === 'executable' || project.type === 'dll') && errors.length === 0) {
            const contentDir = path.join(project.path, 'Content');
            try {
                if (fs.existsSync(contentDir) && fs.statSync(contentDir).isDirectory()) {
                    const dest = path.join(buildConfig.outputDir, 'Content');
                    const copied = this.copyDirRecursive(contentDir, dest);
                    if (copied > 0) {
                        this.emit(`1>Content:\n`);
                        this.emit(`1>  ${copied} file${copied > 1 ? 's' : ''} copied to ${path.relative(project.path, dest)}\\\n`);
                    }
                }
            } catch (e: any) {
                // A content-copy failure is a warning, not a build failure: the
                // XEX built fine, the texture just won't be there.
                warnings.push({ file: '', line: 0, column: 0, message: `Could not copy Content\\: ${e.message}`, severity: 'warning' });
                this.emit(`1>  WARNING: could not copy Content\\: ${e.message}\n`);
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
    /**
     * The whole build plan for one configuration, from nexia-core.
     *
     * The flags ARE the product — one wrong /MTd links the debug CRT into a
     * Release title, and neither that nor a missing d3d9i.lib shows up as a
     * crash on the PC. They were written twice, in two languages, and now they
     * are written once.
     *
     * What comes back is a lookup table, not a script. `compile` says what argv
     * each source needs; the loop in runBuild still decides which of them are
     * stale enough to actually run. That is why "the C emits a whole plan while
     * compile() runs per file" never needed the loop restructured.
     *
     * The project is written back out rather than passed by its path on disk,
     * because by this point it is no longer what is on disk: buildReferences
     * has folded each dependency's libraries and includes into it.
     * projectReferences is dropped for the same reason — nexia-core refuses a
     * project that has one, since resolving a reference means building it, and
     * they are already built and merged by the time we get here. The C never
     * has to spawn a compiler, which is the whole point of the split.
     */
    private plan(project: ProjectConfig, configuration: BuildConfiguration): BuildPlan {
        const effective = { ...project, projectReferences: undefined };
        const tmp = path.join(os.tmpdir(), `nexia-plan-${process.pid}-${Date.now()}.json`);
        try {
            fs.writeFileSync(tmp, JSON.stringify(effective), 'utf-8');
            const core = path.join(__dirname, '..', 'nexia-core.exe');

            // nexia-core exits non-zero when it refuses, and the reason is the
            // JSON on stdout — so the throw is where the answer arrives, not
            // where it is lost.
            let out: string;
            const t0 = Date.now();
            try {
                out = execFileSync(core, ['build', 'args', tmp, configuration],
                    { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
            } catch (err: any) {
                out = err?.stdout?.toString() || '';
                logCore(['build', 'args', configuration], t0, err);
                if (!out) throw err;
            }
            logCore(['build', 'args', configuration], t0, undefined, out);

            const p = JSON.parse(out);
            if (!p.ok) throw new Error(p.error || 'nexia-core refused the project');
            return p as BuildPlan;
        } finally {
            try { fs.unlinkSync(tmp); } catch {}
        }
    }

    private async compileEntry(
        entry: CompileEntry,
        plan: BuildPlan
    ): Promise<{ output: string; errors: BuildMessage[]; warnings: BuildMessage[]; rawLines: string[] }> {
        return this.runTool(plan.compileTool, entry.args, entry.source);
    }

    /**
     * Link, via a response file.
     *
     * The argv is the plan's; turning a long one into link.rsp stays here,
     * because it is about how a process gets spawned rather than what the
     * command line says. link.exe supports @file natively, as MSBuild uses.
     */
    private async linkWithPlan(plan: BuildPlan):
        Promise<{ output: string; errors: BuildMessage[]; warnings: BuildMessage[]; rawLines: string[] }> {
        if (!plan.linkTool) {
            return { output: '', errors: [{ file: '', line: 0, column: 0, message: 'link.exe not found', severity: 'error' }], warnings: [], rawLines: ['error: link.exe not found in SDK'] };
        }
        const rspPath = path.join(plan.outputDir, 'link.rsp');
        fs.writeFileSync(rspPath, (plan.link || []).join('\n'), 'utf-8');
        return this.runTool(plan.linkTool, [`@"${rspPath}"`], '');
    }

    /** Archive a static library. As linkWithPlan, but lib.exe. */
    private async archiveWithPlan(plan: BuildPlan):
        Promise<{ output: string; errors: BuildMessage[]; warnings: BuildMessage[]; rawLines: string[] }> {
        if (!plan.archiveTool) {
            return { output: '', errors: [{ file: '', line: 0, column: 0, message: 'lib.exe not found', severity: 'error' }], warnings: [], rawLines: ['error: lib.exe not found in SDK'] };
        }
        const rspPath = path.join(plan.outputDir, 'lib.rsp');
        fs.writeFileSync(rspPath, (plan.archive || []).join('\n'), 'utf-8');
        return this.runTool(plan.archiveTool, [`@"${rspPath}"`], '');
    }


    /**
     * Build every project this one references, and report what to link.
     *
     * Each reference is a path to another Nexia project's folder. It is built to
     * its own out\<Configuration> in the same configuration as this build — a
     * Debug title must not link a Release library, since they disagree about
     * which CRT they were compiled against and the link either fails or produces
     * something that crashes on the console.
     *
     * Returns the .lib names to link, the folders to find them in, and the
     * referenced projects' include directories.
     */
    private async buildReferences(
        project: ProjectConfig,
        buildConfig: BuildConfig,
        chain: string[],
    ): Promise<{ libs: string[]; libDirs: string[]; includes: string[]; errors: BuildMessage[]; output: string }> {
        const empty = { libs: [], libDirs: [], includes: [], errors: [], output: '' };
        const references = project.projectReferences || [];
        if (references.length === 0) return empty;

        const fail = (message: string) => ({
            libs: [], libDirs: [], includes: [], output: message + '\n',
            errors: [{ file: '', line: 0, column: 0, message, severity: 'error' as const }],
        });

        // Original case is kept for display; comparisons lowercase both sides
        // because NTFS does.
        const self = path.resolve(project.path);
        const libs: string[] = [];
        const libDirs: string[] = [];
        const includes: string[] = [];
        let output = '';

        this.emit(`1>ProjectReference:\n`);

        for (const ref of references) {
            // Relative to this project, so a folder of related projects can be
            // moved or shared without every reference breaking.
            const refDir = path.resolve(project.path, ref);

            if (refDir.toLowerCase() === self.toLowerCase()) {
                return fail(`${project.name} references itself.`);
            }

            // Name the whole loop — "a cycle exists" is useless when the chain
            // is four projects long. The cycle runs from wherever this
            // reference already appears in the chain, through the project being
            // built right now, and back to the reference.
            const at = chain.findIndex(c => c.toLowerCase() === refDir.toLowerCase());
            if (at >= 0) {
                const loop = [...chain.slice(at), self, refDir].map(p => path.basename(p)).join(' → ');
                return fail(`Circular project reference: ${loop}`);
            }

            const refConfigPath = path.join(refDir, 'nexia.json');
            if (!fs.existsSync(refConfigPath)) {
                return fail(`${project.name} references "${ref}", but there's no Nexia project there (looked for ${refConfigPath}).`);
            }

            let refProject: ProjectConfig;
            try {
                refProject = JSON.parse(fs.readFileSync(refConfigPath, 'utf-8'));
            } catch (e: any) {
                return fail(`Couldn't read the referenced project at ${refDir}: ${e.message}`);
            }
            // Trust the folder we found it in, not the path recorded inside —
            // the project may have been moved since it was written.
            refProject.path = refDir;

            if (refProject.type === 'executable') {
                return fail(`${project.name} references ${refProject.name}, which builds an executable. Only libraries can be referenced.`);
            }

            this.emit(`1>  ${refProject.name}\n`);

            const refOut = path.join(refDir, 'out', buildConfig.configuration);
            const result = await this.runBuild(refProject, {
                configuration: buildConfig.configuration,
                outputDir: refOut,
            }, [...chain, self]);
            output += result.output;

            if (!result.success) {
                return {
                    libs: [], libDirs: [], includes: [], output,
                    errors: [
                        ...result.errors,
                        { file: '', line: 0, column: 0, severity: 'error' as const,
                          message: `${project.name} was not built: its reference ${refProject.name} failed to build.` },
                    ],
                };
            }

            // A dll's import library and a static lib's archive are both
            // <name>.lib and both are what you link against.
            const libName = `${refProject.name}.lib`;
            if (!fs.existsSync(path.join(refOut, libName))) {
                return fail(`${refProject.name} built without producing ${libName}, so ${project.name} has nothing to link.`);
            }
            libs.push(libName);
            libDirs.push(refOut);

            // So the dependent project can #include the library's headers
            // without spelling out a relative path to them.
            for (const inc of (refProject.includeDirectories || [])) {
                includes.push(path.resolve(refDir, inc));
            }
        }

        this.emit(`1>\n`);
        return { libs, libDirs, includes, errors: [], output };
    }

    /**
     * Compile a project's .xui scenes into an .xzp package beside the XEX.
     *
     * xuipkg compiles each .xui to a binary .xur as it packs it, and stores each
     * entry under the path it was *given* — not the file's absolute location. So
     * the working directory is the project's Media folder and the inputs are
     * relative to it ("xui\scene.xui" -> "xui\scene.xur"), which makes the
     * runtime locator a constant the template hardcodes. Run it from anywhere
     * else and the entry names change, the locator stops matching, and the title
     * fails to find its scene on the console with everything still building
     * perfectly on the PC.
     *
     * /O rather than /A: append leaves entries from previous builds in the
     * archive, so a renamed scene would ship alongside its own ghost.
     */
    /**
     * Copy a directory tree, returning how many files landed. Used to deploy the
     * project's Content\ folder beside the XEX. Overwrites — a build should
     * refresh the deployed content, not merge with a stale copy.
     */
    private copyDirRecursive(src: string, dest: string): number {
        let count = 0;
        fs.mkdirSync(dest, { recursive: true });
        for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
            const s = path.join(src, entry.name);
            const d = path.join(dest, entry.name);
            if (entry.isDirectory()) count += this.copyDirRecursive(s, d);
            else { fs.copyFileSync(s, d); count++; }
        }
        return count;
    }

    private async buildXuiContent(
        project: ProjectConfig,
        buildConfig: BuildConfig
    ): Promise<{ output: string; errors: BuildMessage[] }> {
        const content = project.xuiContent!;
        const err = (message: string): { output: string; errors: BuildMessage[] } => ({
            output: message + '\n',
            errors: [{ file: '', line: 0, column: 0, message, severity: 'error' }],
        });

        this.emit(`1>XuiPackage:\n`);

        const xuipkg = this.toolchain.getToolPath('xuipkg.exe');
        if (!xuipkg) return err('xuipkg.exe not found in the SDK — cannot build XUI content.');

        const mediaDir = path.join(project.path, 'Media');
        if (!fs.existsSync(mediaDir)) return err(`This project has XUI content but no Media folder: ${mediaDir}`);

        // xuipkg reports a missing input as a bare "file(s) not found" with no
        // clue which one, so check first and name it.
        for (const scene of content.scenes) {
            const p = path.join(mediaDir, scene);
            if (!fs.existsSync(p)) return err(`XUI scene not found: ${p}`);
        }

        const outMedia = path.join(buildConfig.outputDir, 'media');
        fs.mkdirSync(outMedia, { recursive: true });
        const pkgPath = path.join(outMedia, content.package);

        this.emit(`1>  ${content.package}\n`);
        const result = await this.runTool(
            xuipkg,
            ['/nologo', '/o', `"${pkgPath}"`, ...content.scenes.map(s => `"${s}"`)],
            '',
            mediaDir,
        );

        for (const line of result.rawLines) this.emit(`1>  ${line}\n`);
        if (result.errors.length > 0) return { output: result.output, errors: result.errors };

        // xuipkg can report success and still produce nothing if every input was
        // skipped. Not shipping a scene is not a successful build.
        if (!fs.existsSync(pkgPath)) return err(`xuipkg reported success but produced no ${content.package}.`);

        // Loose files — the font. Not packed, because RegisterDefaultTypeface
        // takes a plain file locator rather than an archive one.
        for (const rel of content.copy) {
            const src = path.join(mediaDir, rel);
            if (!fs.existsSync(src)) return err(`XUI content file not found: ${src}`);
            const dest = path.join(outMedia, path.basename(rel));
            try {
                fs.copyFileSync(src, dest);
                this.emit(`1>  ${path.basename(rel)}\n`);
            } catch (e: any) {
                return err(`Couldn't copy ${path.basename(rel)}: ${e.message}`);
            }
        }

        return { output: result.output, errors: [] };
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
     * Run a tool and parse output for errors/warnings.
     */
    /**
     * @param cwd Working directory to run the tool in. Defaults to the tool's
     *        own directory (see below). Only pass this when the tool's output
     *        depends on where it was run — xuipkg records each input path as
     *        given, so its cwd determines the names stored in the archive and
     *        therefore the resource locators the title needs at runtime.
     */
    /**
     * Hand the tool's raw bytes to nexia-core and get back errors, warnings and
     * the raw lines.
     *
     * Bytes, not a string: the decode is the C's to make. MSVC 2010 writes to
     * the pipe in the console output page (cp437 on an English install, 850 in
     * Western Europe, 932 in Japan), and nexia-core asks GetConsoleOutputCP
     * rather than guessing. Decoding here first would throw away the only
     * evidence of what page it was.
     *
     * Via a temp file because the output of a failing link can be megabytes and
     * an argv cannot.
     *
     * contextFile is not passed down. The old parser used it only to name the
     * file on an LNK diagnostic (`contextFile || 'LINK'`), and every caller that
     * can produce one — link, lib, imagexex — passes '', so it always resolved
     * to 'LINK', which is what nexia-core emits. compile() is the only caller
     * with a non-empty contextFile and cl.exe does not emit LNK lines. It is
     * still used below, where the exit-code and spawn-failure errors need a file
     * to point at.
     */
    private parseToolOutput(raw: Buffer, contextFile: string):
        { output: string; errors: BuildMessage[]; warnings: BuildMessage[]; rawLines: string[] } {
        if (raw.length === 0) return { output: '', errors: [], warnings: [], rawLines: [] };
        const tmp = path.join(os.tmpdir(), `nexia-tool-out-${process.pid}-${Date.now()}.txt`);
        const t0 = Date.now();
        try {
            fs.writeFileSync(tmp, raw);
            const core = path.join(__dirname, '..', 'nexia-core.exe');
            const parsed = execFileSync(core, ['build', 'parse', tmp],
                { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
            logCore(['build', 'parse'], t0, undefined, parsed);
            const res = JSON.parse(parsed);
            return {
                // `output` is every line and feeds the Output panel; `raw` is the
                // filtered subset. Two different things — the old parser kept both
                // and so does this.
                output: (res.output || []).join('\n') + ((res.output || []).length ? '\n' : ''),
                errors: res.errors || [],
                warnings: res.warnings || [],
                rawLines: res.raw || [],
            };
        } catch (err: any) {
            logCore(['build', 'parse'], t0, err);
            // A parse that fails must not swallow the build. Surface the bytes.
            return {
                output: '',
                errors: [{ file: contextFile, line: 0, column: 0,
                    message: `Could not parse tool output: ${err.message}`, severity: 'error' }],
                warnings: [],
                rawLines: [],
            };
        } finally {
            try { fs.unlinkSync(tmp); } catch {}
        }
    }

    private runTool(toolPath: string, args: string[], contextFile: string, cwd?: string): Promise<{ output: string; errors: BuildMessage[]; warnings: BuildMessage[]; rawLines: string[] }> {
        return new Promise((resolve) => {
            const env = this.toolchain.getToolEnvironment();
            let proc: ChildProcess;

            try {
                // Quote the tool path to handle spaces (e.g. C:\Program Files (x86)\...)
                const quotedTool = toolPath.includes(' ') ? `"${toolPath}"` : toolPath;
                // Set cwd to the tool's directory so Windows DLL search finds sibling
                // DLLs (c1.dll, c1xx.dll, c2.dll, mspdb*.dll, MSVC runtimes, etc.)
                const toolDir = path.dirname(toolPath);
                proc = spawn(quotedTool, args, { env, cwd: cwd || toolDir, shell: true, windowsHide: true });
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
            // Raw bytes, undecoded. nexia-core does the code-page decode and the
            // parse together, because the two are one decision: the bytes MSVC
            // writes are in the console output page, and deciding that in one place
            // is why a "café.cpp" diagnostic survives to name a file on disk.
            const chunks: Buffer[] = [];
            proc.stdout?.on('data', (d: Buffer) => { chunks.push(Buffer.from(d)); });
            proc.stderr?.on('data', (d: Buffer) => { chunks.push(Buffer.from(d)); });
            proc.on('close', (code) => {
                this.currentProcess = null;
                const parsed = this.parseToolOutput(Buffer.concat(chunks), contextFile);
                const errors = parsed.errors, warnings = parsed.warnings, rawLines = parsed.rawLines;
                output = parsed.output;
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
                const errors: BuildMessage[] = [], warnings: BuildMessage[] = [], rawLines: string[] = [];
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

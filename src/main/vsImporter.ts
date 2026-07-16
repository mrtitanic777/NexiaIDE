/**
 * vsImporter.ts — Visual Studio solution/project importer
 *
 * Converts a Visual Studio solution (.sln) or project (.vcxproj / .vcproj) into
 * a Nexia project, so people can move Xbox 360 work over from VS without
 * hand-rebuilding the directory layout, source list, include paths and libs.
 *
 * Supports both project formats the Xbox 360 XDK shipped against:
 *   - .vcxproj — MSBuild XML (VS2010+)
 *   - .vcproj  — legacy XML  (VS2005/2008)
 *
 * Parsing is done with targeted regex rather than a full XML parser: these files
 * are machine-generated and highly regular, and it keeps the dependency list at
 * zero. Anything we can't confidently map is surfaced as a warning rather than
 * being silently dropped.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { ProjectConfig, BuildConfiguration, ConfigurationSettings, SolutionInfo, SolutionProject } from '../shared/types';

/**
 * Run a nexia-core `vsimport` command and return its parsed JSON.
 *
 * The parsing that reads a .sln, a .vcxproj/.vcproj and a project reference is
 * core/vsimport.c now, proven field for field by vsimport-parity.js. This is the
 * one spawn the three exported functions share. A refusal comes back as
 * {ok:false,error} on stdout with a non-zero exit, so the answer is on the thrown
 * error's stdout; a truly broken spawn has none and rethrows.
 */
function core(args: string[]): any {
    const exe = path.join(__dirname, '..', 'nexia-core.exe');
    let out: string;
    try {
        out = execFileSync(exe, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    } catch (err: any) {
        out = err?.stdout?.toString() || '';
        if (!out) throw err;
    }
    const res = JSON.parse(out);
    if (!res.ok) throw new Error(res.error || 'nexia-core refused the request');
    return res;
}

// ══════════════════════════════════════
//  TYPES
// ══════════════════════════════════════

export interface VsProjectRef {
    name: string;
    /** Absolute path to the .vcxproj/.vcproj */
    path: string;
    exists: boolean;
}

export interface VsSolutionInfo {
    solutionPath: string;
    name: string;
    projects: VsProjectRef[];
}

/**
 * A <ProjectReference> — another project this one depends on.
 *
 * These matter because Visual Studio links a referenced static library
 * IMPLICITLY ("Link Library Dependencies" defaults to true), so the .vcxproj
 * never names the .lib in AdditionalDependencies. Reading only that list gives
 * you every SDK lib and silently omits the referenced one — the headers resolve
 * and the link fails.
 */
export interface VsProjectReference {
    /** Absolute path to the referenced .vcxproj/.vcproj */
    path: string;
    /** <ProjectName> if declared, else the filename. AtgFramework2010.vcxproj declares "AtgFramework". */
    name: string;
    exists: boolean;
    /** Only static libraries produce a .lib to link. */
    isStaticLibrary: boolean;
    /** Absolute path to the prebuilt output, when it could be resolved AND exists. */
    libPath?: string;
    /** The referenced project lives inside the Xbox 360 SDK, so it is not the user's code. */
    insideSdk: boolean;
}

export interface ParsedVsProject {
    name: string;
    projectPath: string;
    format: 'vcxproj' | 'vcproj';
    type: ProjectConfig['type'];
    /** Projects this one references. See VsProjectReference. */
    projectReferences: VsProjectReference[];
    /** Per-configuration libs/defines/paths, read from every ItemDefinitionGroup. */
    configurations: Partial<Record<BuildConfiguration, ConfigurationSettings>>;
    /** Source/header/other files, relative to the project dir */
    sources: string[];
    headers: string[];
    otherFiles: string[];
    includeDirectories: string[];
    libraryDirectories: string[];
    libraries: string[];
    defines: string[];
    pchHeader?: string;
    enableRtti?: boolean;
    exceptionHandling?: 'sync' | 'async' | 'none';
    /** /MT, /MTd, /MD, /MDd — must agree with _DEBUG or the CRT link fails. */
    runtimeLibrary?: ProjectConfig['runtimeLibrary'];
    warningLevel?: 0 | 1 | 2 | 3 | 4;
    treatWarningsAsErrors?: boolean;
    optimizationOverride?: 'disabled' | 'minSize' | 'maxSpeed' | 'full' | 'default';
    /** Things we intentionally didn't map — shown to the user, never silent */
    warnings: string[];
}

export interface ImportReport {
    config: ProjectConfig;
    filesCopied: number;
    bytesCopied: number;
    skipped: string[];
    warnings: string[];
}

// ══════════════════════════════════════
//  SOLUTION (.sln)
// ══════════════════════════════════════

/**
 * Parse a .sln and return the C/C++ projects it references.
 * Solution files are plain text; each project is one `Project("{...}") = ...` line.
 */
export function parseSolution(slnPath: string): VsSolutionInfo {
    // core/vsimport.c scans the .sln, skips solution folders and non-C++
    // projects, and resolves each path against the .sln's directory. Proven by
    // vsimport-parity.js.
    const res = core(['vsimport', 'solution', slnPath]);
    return { solutionPath: res.solutionPath, name: res.name, projects: res.projects };
}

// ══════════════════════════════════════
//  PROJECT REFERENCES
// ══════════════════════════════════════

/**
 * Resolve one referenced project for one configuration.
 *
 * The macro expansion ($(ProjectDir)/$(Configuration)/$(ProjectName)/$(OutDir))
 * and the on-disk .lib check are core/vsimport.c's, proven by the ATG-framework
 * case in vsimport-parity.js. Called per (ref, cfg) by buildSolutionInfo for the
 * Explorer's per-configuration libPaths — the one bit of the importer's parsing
 * not reached through parseVsProject.
 */
function resolveProjectReference(refPath: string, configuration: string, sdkRoot?: string): VsProjectReference {
    const args = ['vsimport', 'resolveref', refPath, configuration];
    if (sdkRoot) args.push('--sdk', sdkRoot);
    return core(args).reference as VsProjectReference;
}

// ══════════════════════════════════════
//  PROJECT (.vcxproj / .vcproj)
// ══════════════════════════════════════


/**
 * Every configuration we import settings for.
 *
 * All four are read, not just Debug: the Xbox 360 SDK ships a different library
 * flavour per configuration (d3d9d / d3d9i / d3d9 / d3d9ltcg), so keeping only
 * Debug's list meant switching to Release_LTCG still linked Debug's libs.
 */
const VS_CONFIGURATIONS: BuildConfiguration[] = ['Debug', 'Release', 'Profile', 'Release_LTCG'];


/**
 * @param sdkRoot Xbox 360 SDK root, when detected. Used to recognise referenced
 *                projects that live inside the SDK (the ATG framework), which
 *                are Microsoft's code and ship prebuilt — they get linked, not
 *                copied into the user's project.
 */
export function parseVsProject(projPath: string, sdkRoot?: string): ParsedVsProject {
    // Both formats are core/vsimport.c now — item classification, the
    // per-configuration ItemDefinitionGroups, and the project-reference
    // resolution — proven structurally by vsimport-parity.js across five layers.
    const ext = path.extname(projPath).toLowerCase();
    const args = ext === '.vcproj'
        ? ['vsimport', 'vcproj', projPath]
        : ['vsimport', 'vcxproj', projPath, ...(sdkRoot ? ['--sdk', sdkRoot] : [])];
    const res = core(args);
    delete res.ok;
    return res as ParsedVsProject;
}


// ══════════════════════════════════════
//  SOLUTION INFO
// ══════════════════════════════════════

/**
 * Record what the solution contained, for the Explorer.
 *
 * Two sources, because a dependency can appear in either:
 *   - the .sln's Project(...) lines, when the import came from a solution
 *   - the project's own <ProjectReference> items, which is where VS2010 puts
 *     them and is the only source when a .vcxproj is imported directly
 *
 * Merged by path so a project listed in both doesn't appear twice.
 */
function buildSolutionInfo(
    projPath: string,
    name: string,
    parsed: ParsedVsProject,
    slnPath?: string,
    sdkRoot?: string,
): SolutionInfo | undefined {
    const byPath = new Map<string, SolutionProject>();
    const key = (p: string) => path.resolve(p).toLowerCase();

    byPath.set(key(projPath), {
        name,
        path: projPath,
        isCurrent: true,
        insideSdk: false,
    });

    if (slnPath && fs.existsSync(slnPath)) {
        for (const p of parseSolution(slnPath).projects) {
            if (byPath.has(key(p.path))) continue;
            const insideSdk = !!sdkRoot &&
                path.resolve(p.path).toLowerCase().startsWith(path.resolve(sdkRoot).toLowerCase() + path.sep);
            byPath.set(key(p.path), { name: p.name, path: p.path, isCurrent: false, insideSdk });
        }
    }

    for (const ref of parsed.projectReferences) {
        const existing = byPath.get(key(ref.path));
        // Resolve the library this dependency contributes in each configuration,
        // so the Explorer can show whether it's actually available per build.
        const libPaths: Partial<Record<BuildConfiguration, string>> = {};
        for (const cfg of VS_CONFIGURATIONS) {
            const r = resolveProjectReference(ref.path, cfg, sdkRoot);
            if (r.libPath) libPaths[cfg] = r.libPath;
        }
        if (existing) {
            existing.libPaths = libPaths;
            existing.insideSdk = ref.insideSdk;
        } else {
            byPath.set(key(ref.path), {
                name: ref.name,
                path: ref.path,
                isCurrent: false,
                insideSdk: ref.insideSdk,
                libPaths,
            });
        }
    }

    const projects = [...byPath.values()];
    // A lone project with no dependencies isn't a solution worth showing.
    if (projects.length < 2 && !slnPath) return undefined;

    return {
        name: slnPath ? path.basename(slnPath, path.extname(slnPath)) : name,
        path: slnPath,
        projects,
    };
}

// ══════════════════════════════════════
//  IMPORT
// ══════════════════════════════════════

/**
 * Import a parsed VS project into a new Nexia project directory.
 * Files are COPIED (never moved) so the original VS project keeps working —
 * people are usually migrating gradually, not burning the boats.
 */
/**
 * @param slnPath When the import came from a .sln, its path — so the project can
 *                record what the solution contained. Nexia builds one project,
 *                but the Explorer shows the solution it belongs to and which
 *                dependencies resolved.
 */
export function importVsProject(projPath: string, destDir: string, projectName?: string, sdkRoot?: string, slnPath?: string): ImportReport {
    const parsed = parseVsProject(projPath, sdkRoot);
    const name = projectName || parsed.name;
    const srcRoot = path.dirname(projPath);
    const projectDir = path.resolve(destDir, name);

    if (fs.existsSync(projectDir) && fs.readdirSync(projectDir).length > 0) {
        throw new Error(`Destination already exists and isn't empty: ${projectDir}`);
    }
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'out'), { recursive: true });

    const skipped: string[] = [];
    let filesCopied = 0;
    let bytesCopied = 0;

    const copyOne = (rel: string): string | null => {
        const from = path.resolve(srcRoot, rel);
        if (!fs.existsSync(from)) { skipped.push(`${rel} (not found on disk)`); return null; }

        // Keep the original tree shape, but never let "..\shared\x.cpp" escape
        // the new project dir — flatten those into external/ instead.
        let relOut = rel;
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
            relOut = path.join('external', path.basename(rel));
        }
        const to = path.join(projectDir, relOut);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
        filesCopied++;
        try { bytesCopied += fs.statSync(to).size; } catch {}
        return relOut.split(path.sep).join('/');
    };

    const outSources: string[] = [];
    for (const s of parsed.sources) { const r = copyOne(s); if (r) outSources.push(r); }
    for (const h of parsed.headers) copyOne(h);
    for (const o of parsed.otherFiles) copyOne(o);

    // Include/library dirs.
    // Paths inside the project stay relative. Paths that point OUTSIDE it (../shared,
    // or an absolute SDK sample dir) are resolved against the original VS project
    // and kept as absolute — the build system handles absolute paths, and dropping
    // them would quietly break the build for anything depending on them.
    const resolveDir = (d: string): string => {
        const cleaned = d.replace(/^\.[\\/]/, '');
        if (path.isAbsolute(cleaned) || cleaned.startsWith('..')) {
            return path.resolve(srcRoot, cleaned);
        }
        return cleaned.split(path.sep).join('/');
    };

    const includeDirectories = Array.from(new Set(
        parsed.includeDirectories.map(resolveDir)
            .concat(['src', 'include'].filter(d => fs.existsSync(path.join(projectDir, d))))
    ));
    const libraryDirectories = Array.from(new Set(parsed.libraryDirectories.map(resolveDir)));

    // Be explicit about anything now pinned to this machine.
    const externalDirs = includeDirectories.concat(libraryDirectories).filter(d => path.isAbsolute(d));
    const extraWarnings = externalDirs.map(
        d => `Kept as an absolute path (it lives outside the project, so it won't move with it): ${d}`
    );

    // Say plainly what happened to each referenced project. Visual Studio links
    // these implicitly, so without a note the user has no way to know a library
    // was added on their behalf — or why one is missing.
    for (const ref of parsed.projectReferences) {
        if (!ref.isStaticLibrary || !ref.libPath) continue;
        extraWarnings.push(ref.insideSdk
            ? `"${ref.name}" comes from your Xbox 360 SDK, so it was linked from there rather than copied in: ${ref.libPath}`
            : `"${ref.name}" is a library this project depends on. Linked its built output: ${ref.libPath}`);
    }

    const config: ProjectConfig = {
        name,
        path: projectDir,
        type: parsed.type,
        template: 'empty',
        sourceFiles: outSources,
        includeDirectories,
        libraryDirectories,
        libraries: parsed.libraries,
        defines: parsed.defines,
        configuration: 'Debug',
        // Per-configuration overrides, so switching to Release/Profile/Release_LTCG
        // links that configuration's SDK libs rather than Debug's. Library dirs are
        // resolved the same way as the flat ones so they survive the project move.
        configurations: Object.keys(parsed.configurations).length
            ? Object.fromEntries(Object.entries(parsed.configurations).map(([cfg, s]) => [cfg, {
                ...s,
                includeDirectories: (s.includeDirectories || []).map(resolveDir),
                libraryDirectories: (s.libraryDirectories || []).map(resolveDir),
            }]))
            : undefined,
        solution: buildSolutionInfo(projPath, name, parsed, slnPath, sdkRoot),
        pchHeader: parsed.pchHeader,
        enableRtti: parsed.enableRtti,
        exceptionHandling: parsed.exceptionHandling,
        runtimeLibrary: parsed.runtimeLibrary,
        warningLevel: parsed.warningLevel,
        treatWarningsAsErrors: parsed.treatWarningsAsErrors,
        optimizationOverride: parsed.optimizationOverride,
        properties: {
            importedFrom: projPath,
            importedFormat: parsed.format,
            importedAt: new Date().toISOString(),
        },
    };

    fs.writeFileSync(path.join(projectDir, 'nexia.json'), JSON.stringify(config, null, 2), 'utf-8');

    return { config, filesCopied, bytesCopied, skipped, warnings: parsed.warnings.concat(extraWarnings) };
}

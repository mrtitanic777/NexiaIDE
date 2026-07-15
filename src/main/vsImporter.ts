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
import { ProjectConfig } from '../shared/types';

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

export interface ParsedVsProject {
    name: string;
    projectPath: string;
    format: 'vcxproj' | 'vcproj';
    type: ProjectConfig['type'];
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
//  HELPERS
// ══════════════════════════════════════

/**
 * MSBuild percent-encodes reserved characters, so "Program Files (x86)" is
 * stored as "Program Files %28x86%29". Decode it or every SDK path is corrupt.
 * Item metadata like %(AdditionalIncludeDirectories) is untouched because "(A"
 * isn't a valid hex pair.
 */
function unescapeMsbuild(v: string): string {
    return v.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/** Normalize VS's backslash paths to the host separator. */
function toHostPath(p: string): string {
    return unescapeMsbuild(p).replace(/\\/g, path.sep).replace(/\//g, path.sep).trim();
}

/**
 * Resolve the MSBuild macros that just mean "this project's folder". These are
 * extremely common ($(ProjectDir)include) and are perfectly resolvable, so
 * dropping them would silently lose real include paths.
 * Returns a project-relative path.
 */
function resolveProjectMacros(value: string): string {
    return value
        .replace(/\$\((ProjectDir|MSBuildProjectDirectory|MSBuildThisFileDirectory)\)[\\/]?/gi, '')
        .replace(/^\.[\\/]/, '')
        .trim();
}

/**
 * Macros we genuinely can't resolve outside VS. $(XEDK)/$(DXSDK_DIR) are dropped
 * on purpose — Nexia's toolchain already injects the Xbox 360 SDK include/lib
 * dirs, so importing them would bake in a machine-specific path that breaks.
 * %(...) is MSBuild item-metadata inheritance, not a path.
 */
function isUnresolvableMacro(value: string): boolean {
    return /\$\(|%\(/.test(value);
}

/** Split a VS semicolon list, dropping inherit markers and empties. */
function splitList(raw: string | undefined | null): string[] {
    if (!raw) return [];
    return raw
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0 && !/^%\(.*\)$/.test(s));
}

/** Grab the inner text of the first <Tag>...</Tag>. */
function tagText(xml: string, tag: string): string | null {
    const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
    return m ? m[1].trim() : null;
}

function mapWarningLevel(v: string | null): ParsedVsProject['warningLevel'] {
    if (!v) return undefined;
    const m = /Level(\d)/i.exec(v);
    if (m) return Math.min(4, Math.max(0, parseInt(m[1], 10))) as any;
    if (/TurnOffAllWarnings/i.test(v)) return 0;
    const n = parseInt(v, 10);
    return isNaN(n) ? undefined : (Math.min(4, Math.max(0, n)) as any);
}

function mapOptimization(v: string | null): ParsedVsProject['optimizationOverride'] {
    if (!v) return undefined;
    if (/^Disabled$|^0$/i.test(v)) return 'disabled';
    if (/^MinSpace$|^1$/i.test(v)) return 'minSize';
    if (/^MaxSpeed$|^2$/i.test(v)) return 'maxSpeed';
    if (/^Full$|^3$/i.test(v)) return 'full';
    return 'default';
}

function mapExceptions(v: string | null): ParsedVsProject['exceptionHandling'] {
    if (!v) return undefined;
    if (/^(Sync|true|1|Cpp)$/i.test(v)) return 'sync';
    if (/^(Async|2)$/i.test(v)) return 'async';
    if (/^(false|0|SyncCThrow)$/i.test(v)) return /SyncCThrow/i.test(v) ? 'sync' : 'none';
    return undefined;
}

function mapConfigurationType(v: string | null): ProjectConfig['type'] {
    if (!v) return 'executable';
    if (/StaticLibrary|^4$/i.test(v)) return 'library';
    if (/DynamicLibrary|^2$/i.test(v)) return 'dll';
    return 'executable';
}

const SOURCE_RE = /\.(cpp|c|cc|cxx)$/i;
const HEADER_RE = /\.(h|hpp|hxx|inl)$/i;

// ══════════════════════════════════════
//  SOLUTION (.sln)
// ══════════════════════════════════════

/**
 * Parse a .sln and return the C/C++ projects it references.
 * Solution files are plain text; each project is one `Project("{...}") = ...` line.
 */
export function parseSolution(slnPath: string): VsSolutionInfo {
    const raw = fs.readFileSync(slnPath, 'utf-8');
    const dir = path.dirname(slnPath);
    const projects: VsProjectRef[] = [];

    const re = /^Project\("\{[^}]+\}"\)\s*=\s*"([^"]+)",\s*"([^"]+)"/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
        const name = m[1].trim();
        const rel = m[2].trim();
        if (!/\.(vcxproj|vcproj)$/i.test(rel)) continue; // skip solution folders / C# / etc.
        const abs = path.resolve(dir, toHostPath(rel));
        projects.push({ name, path: abs, exists: fs.existsSync(abs) });
    }

    return {
        solutionPath: slnPath,
        name: path.basename(slnPath, path.extname(slnPath)),
        projects,
    };
}

// ══════════════════════════════════════
//  PROJECT (.vcxproj / .vcproj)
// ══════════════════════════════════════

export function parseVsProject(projPath: string): ParsedVsProject {
    const ext = path.extname(projPath).toLowerCase();
    return ext === '.vcproj' ? parseVcproj(projPath) : parseVcxproj(projPath);
}

/** VS2010+ MSBuild format. */
function parseVcxproj(projPath: string): ParsedVsProject {
    const xml = fs.readFileSync(projPath, 'utf-8');
    const warnings: string[] = [];

    const sources: string[] = [];
    const headers: string[] = [];
    const otherFiles: string[] = [];

    const itemRe = /<(ClCompile|ClInclude|None|Text|Image|CustomBuild)\s+Include="([^"]+)"/gi;
    let m: RegExpExecArray | null;
    while ((m = itemRe.exec(xml)) !== null) {
        const kind = m[1];
        const rel = toHostPath(m[2]);
        if (isUnresolvableMacro(rel)) { warnings.push(`Skipped item with unresolved macro: ${m[2]}`); continue; }
        if (kind === 'ClCompile' || SOURCE_RE.test(rel)) sources.push(rel);
        else if (kind === 'ClInclude' || HEADER_RE.test(rel)) headers.push(rel);
        else otherFiles.push(rel);
    }

    // Prefer the Debug ItemDefinitionGroup; fall back to the first one present.
    const groups = xml.match(/<ItemDefinitionGroup[\s\S]*?<\/ItemDefinitionGroup>/gi) || [];
    const debugGroup = groups.find(g => /Debug\|/i.test(g)) || groups[0] || '';
    const clBlock = /<ClCompile>([\s\S]*?)<\/ClCompile>/i.exec(debugGroup)?.[1] || '';
    const linkBlock = /<Link>([\s\S]*?)<\/Link>/i.exec(debugGroup)?.[1] || '';

    const rawIncludes = splitList(tagText(clBlock, 'AdditionalIncludeDirectories'));
    const rawLibDirs = splitList(tagText(linkBlock, 'AdditionalLibraryDirectories'));
    const rawLibs = splitList(tagText(linkBlock, 'AdditionalDependencies'));
    const rawDefines = splitList(tagText(clBlock, 'PreprocessorDefinitions'));

    const { kept: includeDirectories, dropped: droppedInc } = filterPaths(rawIncludes);
    const { kept: libraryDirectories, dropped: droppedLib } = filterPaths(rawLibDirs);
    for (const d of droppedInc) warnings.push(`Include path not imported (VS/SDK macro — Nexia adds the XDK paths itself): ${d}`);
    for (const d of droppedLib) warnings.push(`Library path not imported (VS/SDK macro — Nexia adds the XDK paths itself): ${d}`);

    const cfgType = tagText(xml, 'ConfigurationType');
    const pch = inferPch(tagText(clBlock, 'PrecompiledHeaderFile'), tagText(clBlock, 'PrecompiledHeader'), headers);

    return {
        name: path.basename(projPath, path.extname(projPath)),
        projectPath: projPath,
        format: 'vcxproj',
        type: mapConfigurationType(cfgType),
        sources, headers, otherFiles,
        includeDirectories,
        libraryDirectories,
        libraries: rawLibs.filter(l => !isUnresolvableMacro(l)),
        defines: rawDefines.filter(d => !isUnresolvableMacro(d)),
        pchHeader: pch || undefined,
        enableRtti: parseBool(tagText(clBlock, 'RuntimeTypeInfo')),
        exceptionHandling: mapExceptions(tagText(clBlock, 'ExceptionHandling')),
        warningLevel: mapWarningLevel(tagText(clBlock, 'WarningLevel')),
        treatWarningsAsErrors: parseBool(tagText(clBlock, 'TreatWarningAsError')),
        optimizationOverride: mapOptimization(tagText(clBlock, 'Optimization')),
        warnings,
    };
}

/** VS2005/2008 legacy format (common for older XDK projects). */
function parseVcproj(projPath: string): ParsedVsProject {
    const xml = fs.readFileSync(projPath, 'utf-8');
    const warnings: string[] = [];

    const sources: string[] = [];
    const headers: string[] = [];
    const otherFiles: string[] = [];

    const fileRe = /<File\s+RelativePath="([^"]+)"/gi;
    let m: RegExpExecArray | null;
    while ((m = fileRe.exec(xml)) !== null) {
        let rel = toHostPath(m[1]);
        rel = rel.replace(/^\.\\|^\.\//, '');
        if (isUnresolvableMacro(rel)) { warnings.push(`Skipped item with unresolved macro: ${m[1]}`); continue; }
        if (SOURCE_RE.test(rel)) sources.push(rel);
        else if (HEADER_RE.test(rel)) headers.push(rel);
        else otherFiles.push(rel);
    }

    // Prefer the Debug <Configuration>; else the first.
    const configs = xml.match(/<Configuration[\s\S]*?<\/Configuration>/gi) || [];
    const cfg = configs.find(c => /Name="Debug/i.test(c)) || configs[0] || '';

    const clTool = /<Tool\s+Name="VCCLCompilerTool"([\s\S]*?)\/?>/i.exec(cfg)?.[1] || '';
    const linkTool = /<Tool\s+Name="VCLinkerTool"([\s\S]*?)\/?>/i.exec(cfg)?.[1] || '';

    const attr = (block: string, name: string): string | null => {
        const mm = new RegExp(`${name}="([^"]*)"`, 'i').exec(block);
        return mm ? mm[1] : null;
    };

    const rawIncludes = splitList(attr(clTool, 'AdditionalIncludeDirectories'));
    const rawLibDirs = splitList(attr(linkTool, 'AdditionalLibraryDirectories'));
    const rawLibs = splitList(attr(linkTool, 'AdditionalDependencies')?.replace(/\s+/g, ';') || '');
    const rawDefines = splitList(attr(clTool, 'PreprocessorDefinitions'));

    const { kept: includeDirectories, dropped: droppedInc } = filterPaths(rawIncludes);
    const { kept: libraryDirectories, dropped: droppedLib } = filterPaths(rawLibDirs);
    for (const d of droppedInc) warnings.push(`Include path not imported (VS/SDK macro): ${d}`);
    for (const d of droppedLib) warnings.push(`Library path not imported (VS/SDK macro): ${d}`);

    const cfgTypeAttr = /ConfigurationType="(\d)"/i.exec(cfg)?.[1] || null;

    return {
        name: path.basename(projPath, path.extname(projPath)),
        projectPath: projPath,
        format: 'vcproj',
        type: mapConfigurationType(cfgTypeAttr),
        sources, headers, otherFiles,
        includeDirectories,
        libraryDirectories,
        libraries: rawLibs.filter(l => !isUnresolvableMacro(l)),
        defines: rawDefines.filter(d => !isUnresolvableMacro(d)),
        pchHeader: inferPch(attr(clTool, 'PrecompiledHeaderThrough'), attr(clTool, 'UsePrecompiledHeader'), headers),
        enableRtti: parseBool(attr(clTool, 'RuntimeTypeInfo')),
        exceptionHandling: mapExceptions(attr(clTool, 'ExceptionHandling')),
        warningLevel: mapWarningLevel(attr(clTool, 'WarningLevel')),
        treatWarningsAsErrors: parseBool(attr(clTool, 'WarnAsError')),
        optimizationOverride: mapOptimization(attr(clTool, 'Optimization')),
        warnings,
    };
}

function parseBool(v: string | null): boolean | undefined {
    if (v === null || v === undefined || v === '') return undefined;
    return /^(true|1)$/i.test(v.trim());
}

/**
 * Resolve project-folder macros, keep what's left if it's a real path, and drop
 * anything still carrying a macro we can't resolve (reported to the user).
 */
function filterPaths(list: string[]): { kept: string[]; dropped: string[] } {
    const kept: string[] = [];
    const dropped: string[] = [];
    for (const raw of list) {
        const resolved = resolveProjectMacros(raw);
        if (!resolved) continue;                       // was just "$(ProjectDir)" — the project root itself
        if (isUnresolvableMacro(resolved)) { dropped.push(raw); continue; }
        kept.push(toHostPath(resolved));
    }
    return { kept, dropped };
}

/**
 * Work out the precompiled header. VS often omits <PrecompiledHeaderFile> and
 * relies on the default (stdafx.h), so infer it from the PCH mode or from a
 * stdafx/pch header actually present in the project.
 */
function inferPch(explicit: string | null, pchMode: string | null, headers: string[]): string | undefined {
    if (explicit) return explicit;
    const known = headers.find(h => /(^|[\\/])(stdafx|pch)\.h$/i.test(h));
    // vcxproj says "Use"; legacy vcproj says "2".
    if (pchMode && /^(Use|2)$/i.test(pchMode.trim())) return known ? path.basename(known) : 'stdafx.h';
    return known ? path.basename(known) : undefined;
}

// ══════════════════════════════════════
//  IMPORT
// ══════════════════════════════════════

/**
 * Import a parsed VS project into a new Nexia project directory.
 * Files are COPIED (never moved) so the original VS project keeps working —
 * people are usually migrating gradually, not burning the boats.
 */
export function importVsProject(projPath: string, destDir: string, projectName?: string): ImportReport {
    const parsed = parseVsProject(projPath);
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
        pchHeader: parsed.pchHeader,
        enableRtti: parsed.enableRtti,
        exceptionHandling: parsed.exceptionHandling,
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

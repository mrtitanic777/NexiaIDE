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
import { ProjectConfig, BuildConfiguration, ConfigurationSettings, SolutionInfo, SolutionProject } from '../shared/types';

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

/**
 * <RuntimeLibrary> → the cl.exe switch.
 *
 * Dropping this is what left an imported Debug project linking against the
 * release CRT: _DEBUG was defined but /MTd was not passed, so _CrtDbgReportW
 * (debug-CRT only) came out unresolved.
 */
function mapRuntimeLibrary(v: string | null): ProjectConfig['runtimeLibrary'] {
    switch ((v || '').trim()) {
        // .vcxproj spells it out
        case 'MultiThreaded':          return 'MT';
        case 'MultiThreadedDebug':     return 'MTd';
        case 'MultiThreadedDLL':       return 'MD';
        case 'MultiThreadedDebugDLL':  return 'MDd';
        // .vcproj uses the numeric enum
        case '0': return 'MT';
        case '1': return 'MTd';
        case '2': return 'MD';
        case '3': return 'MDd';
        default: return undefined;   // let the build system pick from the configuration
    }
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
//  PROJECT REFERENCES
// ══════════════════════════════════════

/**
 * Read a property whose Condition selects a configuration, e.g.
 *   <OutDir Condition="'$(Configuration)|$(Platform)'=='Debug|Xbox 360'">...</OutDir>
 * Falls back to an unconditional <Tag> if no conditional one matches.
 */
function condProp(xml: string, tag: string, configuration: string): string | null {
    const re = new RegExp(
        `<${tag}\\s+Condition="[^"]*?'${configuration}\\|[^"]*?"\\s*>([\\s\\S]*?)<\\/${tag}>`, 'i');
    const hit = re.exec(xml);
    if (hit) return unescapeMsbuild(hit[1].trim());
    return tagText(xml, tag);
}

/**
 * Work out the .lib a referenced project produces.
 *
 * Expands the MSBuild macros these files rely on:
 *   $(ProjectDir)    — the referenced project's own directory
 *   $(Configuration) — the configuration being imported
 *   $(ProjectName)   — <ProjectName> if declared, else the file name
 *   $(OutDir)        — resolved first, then substituted into OutputFile
 *
 * The ATG framework is the case that proves each of these is needed:
 *   <ProjectName>AtgFramework</ProjectName>          (file is AtgFramework2010.vcxproj)
 *   <OutDir     ...>$(ProjectDir)$(Configuration)\</OutDir>
 *   <OutputFile ...>$(OutDir)$(ProjectName).lib</OutputFile>
 * which for Debug resolves to <SDK>\Source\Samples\Common\Debug\AtgFramework.lib.
 */
function resolveProjectReference(refPath: string, configuration: string, sdkRoot?: string): VsProjectReference {
    const fileName = path.basename(refPath, path.extname(refPath));
    const insideSdk = !!sdkRoot &&
        path.resolve(refPath).toLowerCase().startsWith(path.resolve(sdkRoot).toLowerCase() + path.sep);

    if (!fs.existsSync(refPath)) {
        return { path: refPath, name: fileName, exists: false, isStaticLibrary: false, insideSdk };
    }

    let xml = '';
    try { xml = fs.readFileSync(refPath, 'utf-8'); } catch {
        return { path: refPath, name: fileName, exists: false, isStaticLibrary: false, insideSdk };
    }

    const name = tagText(xml, 'ProjectName') || fileName;
    const cfgType = condProp(xml, 'ConfigurationType', configuration) || '';
    const isStaticLibrary = /StaticLibrary/i.test(cfgType);
    if (!isStaticLibrary) {
        return { path: refPath, name, exists: true, isStaticLibrary: false, insideSdk };
    }

    const projectDir = path.dirname(refPath) + path.sep;
    const expand = (v: string) => v
        .replace(/\$\(ProjectDir\)/gi, projectDir)
        .replace(/\$\(Configuration\)/gi, configuration)
        .replace(/\$\(ProjectName\)/gi, name);

    // OutDir may be relative to the project (the ATG project uses a bare
    // "Profile\" for some configurations), so resolve it against projectDir.
    const rawOutDir = condProp(xml, 'OutDir', configuration) || `$(ProjectDir)$(Configuration)\\`;
    const outDir = path.resolve(projectDir, expand(rawOutDir));

    const rawOutFile = condProp(xml, 'OutputFile', configuration) || `$(OutDir)$(ProjectName).lib`;
    const outFile = expand(rawOutFile).replace(/\$\(OutDir\)/gi, outDir + path.sep);
    const libPath = path.resolve(projectDir, outFile);

    return {
        path: refPath,
        name,
        exists: true,
        isStaticLibrary: true,
        libPath: fs.existsSync(libPath) ? libPath : undefined,
        insideSdk,
    };
}

/** Parse <ProjectReference Include="..."> items out of a .vcxproj. */
function parseProjectReferences(xml: string, projPath: string, configuration: string, sdkRoot?: string): VsProjectReference[] {
    const out: VsProjectReference[] = [];
    const re = /<ProjectReference\s+Include="([^"]+)"/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
        const rel = toHostPath(unescapeMsbuild(m[1]));
        if (isUnresolvableMacro(rel)) continue;
        const abs = path.resolve(path.dirname(projPath), rel);
        out.push(resolveProjectReference(abs, configuration, sdkRoot));
    }
    return out;
}

// ══════════════════════════════════════
//  PROJECT (.vcxproj / .vcproj)
// ══════════════════════════════════════

/**
 * The configuration an imported project opens in. Nexia projects are created as
 * Debug, and this must agree with ProjectConfig.configuration.
 */
const IMPORT_CONFIGURATION = 'Debug';

/**
 * Every configuration we import settings for.
 *
 * All four are read, not just Debug: the Xbox 360 SDK ships a different library
 * flavour per configuration (d3d9d / d3d9i / d3d9 / d3d9ltcg), so keeping only
 * Debug's list meant switching to Release_LTCG still linked Debug's libs.
 */
const VS_CONFIGURATIONS: BuildConfiguration[] = ['Debug', 'Release', 'Profile', 'Release_LTCG'];

/**
 * Pull the ClCompile/Link settings out of one configuration's
 * ItemDefinitionGroup. Returns null when the project has no such configuration.
 */
function parseConfigGroup(groups: string[], configuration: string): ConfigurationSettings | null {
    // Match on 'Debug|' etc. so Release doesn't also match Release_LTCG.
    const group = groups.find(g => new RegExp(`'${configuration}\\|`, 'i').test(g));
    if (!group) return null;

    const clBlock = /<ClCompile>([\s\S]*?)<\/ClCompile>/i.exec(group)?.[1] || '';
    const linkBlock = /<Link>([\s\S]*?)<\/Link>/i.exec(group)?.[1] || '';

    const { kept: includeDirectories } = filterPaths(splitList(tagText(clBlock, 'AdditionalIncludeDirectories')));
    const { kept: libraryDirectories } = filterPaths(splitList(tagText(linkBlock, 'AdditionalLibraryDirectories')));

    return {
        libraries: splitList(tagText(linkBlock, 'AdditionalDependencies')).filter(l => !isUnresolvableMacro(l)),
        defines: splitList(tagText(clBlock, 'PreprocessorDefinitions')).filter(d => !isUnresolvableMacro(d)),
        includeDirectories,
        libraryDirectories,
    };
}

/**
 * @param sdkRoot Xbox 360 SDK root, when detected. Used to recognise referenced
 *                projects that live inside the SDK (the ATG framework), which
 *                are Microsoft's code and ship prebuilt — they get linked, not
 *                copied into the user's project.
 */
export function parseVsProject(projPath: string, sdkRoot?: string): ParsedVsProject {
    const ext = path.extname(projPath).toLowerCase();
    return ext === '.vcproj' ? parseVcproj(projPath) : parseVcxproj(projPath, sdkRoot);
}

/** VS2010+ MSBuild format. */
function parseVcxproj(projPath: string, sdkRoot?: string): ParsedVsProject {
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

    // Read EVERY configuration, not just Debug. The Xbox 360 SDK ships a
    // different library flavour per configuration, so keeping only Debug's list
    // left Release/Profile/Release_LTCG linking Debug's libs.
    const configurations: Partial<Record<BuildConfiguration, ConfigurationSettings>> = {};
    for (const cfg of VS_CONFIGURATIONS) {
        const parsed = parseConfigGroup(groups, cfg);
        if (parsed) configurations[cfg] = parsed;
    }
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

    // Referenced projects. Visual Studio links a referenced static library without
    // ever naming it in AdditionalDependencies, so these have to be resolved
    // separately or the import links against everything EXCEPT its dependency.
    //
    // Resolved per configuration: a referenced project builds its own .lib per
    // configuration too (Common\Debug\AtgFramework.lib vs
    // Common\Release_LTCG\AtgFramework.lib), so a single resolution would point
    // every configuration at Debug's build.
    const projectReferences = parseProjectReferences(xml, projPath, IMPORT_CONFIGURATION, sdkRoot);

    for (const cfg of VS_CONFIGURATIONS) {
        const settings = configurations[cfg];
        if (!settings) continue;
        const refs = parseProjectReferences(xml, projPath, cfg, sdkRoot);
        const libs = settings.libraries || (settings.libraries = []);
        const libDirs = settings.libraryDirectories || (settings.libraryDirectories = []);
        for (const ref of refs) {
            if (!ref.isStaticLibrary) continue;
            if (!ref.libPath) {
                // Resolvable for some configurations but not others: the Xbox 360
                // SDK ships AtgFramework prebuilt for Debug, Release and
                // Release_LTCG but NOT Profile. Say so per configuration rather
                // than leaving that build to fail at link time with no clue why.
                if (ref.exists && cfg !== IMPORT_CONFIGURATION) {
                    warnings.push(
                        `${cfg}: no built "${ref.name}" library was found, so this configuration won't link ` +
                        `until you build ${ref.name} for ${cfg} in Visual Studio. ` +
                        `${IMPORT_CONFIGURATION} is unaffected.`);
                }
                continue;
            }
            const libName = path.basename(ref.libPath);
            if (!libs.some(l => l.toLowerCase() === libName.toLowerCase())) libs.push(libName);
            const dir = path.dirname(ref.libPath);
            if (!libDirs.includes(dir)) libDirs.push(dir);
        }
    }

    // Warn once per reference rather than once per configuration.
    for (const ref of projectReferences) {
        if (!ref.isStaticLibrary) continue;
        if (!ref.exists) {
            warnings.push(`Referenced project not found on disk, so its library can't be linked: ${ref.path}`);
        } else if (!ref.libPath) {
            warnings.push(
                `"${ref.name}" is referenced as a static library but its built .lib wasn't found. ` +
                `Build it in Visual Studio (${IMPORT_CONFIGURATION} configuration) and re-import, or the link will fail.`);
        }
    }

    // The flat fields stay in sync with the configuration the project opens in,
    // so anything reading them without configuration awareness still behaves.
    const opening = configurations[IMPORT_CONFIGURATION as BuildConfiguration];
    const libs = opening?.libraries || rawLibs.filter(l => !isUnresolvableMacro(l));
    const refLibDirs = (opening?.libraryDirectories || []).filter(d => !libraryDirectories.includes(d));

    return {
        name: tagText(xml, 'ProjectName') || path.basename(projPath, path.extname(projPath)),
        projectPath: projPath,
        format: 'vcxproj',
        type: mapConfigurationType(cfgType),
        projectReferences,
        configurations,
        sources, headers, otherFiles,
        includeDirectories,
        libraryDirectories: libraryDirectories.concat(refLibDirs),
        libraries: libs,
        defines: rawDefines.filter(d => !isUnresolvableMacro(d)),
        pchHeader: pch || undefined,
        enableRtti: parseBool(tagText(clBlock, 'RuntimeTypeInfo')),
        exceptionHandling: mapExceptions(tagText(clBlock, 'ExceptionHandling')),
        runtimeLibrary: mapRuntimeLibrary(tagText(clBlock, 'RuntimeLibrary')),
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
        // The legacy format has no <ProjectReference>: VS2005/2008 recorded
        // dependencies in the .sln's ProjectSection(ProjectDependencies) instead.
        // Nothing to resolve from the project file alone.
        projectReferences: [],
        // Only the Debug <Configuration> block is read for .vcproj, so there are
        // no per-configuration overrides to record.
        configurations: {},
        sources, headers, otherFiles,
        includeDirectories,
        libraryDirectories,
        libraries: rawLibs.filter(l => !isUnresolvableMacro(l)),
        defines: rawDefines.filter(d => !isUnresolvableMacro(d)),
        pchHeader: inferPch(attr(clTool, 'PrecompiledHeaderThrough'), attr(clTool, 'UsePrecompiledHeader'), headers),
        enableRtti: parseBool(attr(clTool, 'RuntimeTypeInfo')),
        exceptionHandling: mapExceptions(attr(clTool, 'ExceptionHandling')),
        runtimeLibrary: mapRuntimeLibrary(attr(clTool, 'RuntimeLibrary')),
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

/**
 * projectProperties.ts — VS2010-Style Project Properties Dialog
 *
 * Extracted from app.ts. Handles the project properties dialog:
 * tree navigation, property pages, compiler/linker settings, and apply/save.
 */

let _$: (id: string) => HTMLElement;
let _$$: (sel: string) => NodeListOf<HTMLElement>;
let _appendOutput: (text: string) => void;
let _ipcRenderer: any;
let _IPC: any;
let _getCurrentProject: () => any;
let _setCurrentProject: (proj: any) => void;

export interface ProjectPropertiesDeps {
    $: (id: string) => HTMLElement;
    $$: (sel: string) => NodeListOf<HTMLElement>;
    appendOutput: (text: string) => void;
    ipcRenderer: any;
    IPC: any;
    getCurrentProject: () => any;
    setCurrentProject: (proj: any) => void;
}

export function initProjectProperties(deps: ProjectPropertiesDeps) {
    _$ = deps.$;
    _$$ = deps.$$;
    _appendOutput = deps.appendOutput;
    _ipcRenderer = deps.ipcRenderer;
    _IPC = deps.IPC;
    _getCurrentProject = deps.getCurrentProject;
    _setCurrentProject = deps.setCurrentProject;

    // Wire tree navigation
    _$$('.pp-tree-item').forEach(item => {
        item.addEventListener('click', () => {
            _$$('.pp-tree-item').forEach(i => i.classList.remove('active'));
            item.classList.add('active');
            const page = item.getAttribute('data-page');
            _$$('.pp-page').forEach(p => p.classList.remove('active'));
            if (page) document.getElementById('pp-page-' + page)?.classList.add('active');
        });
    });

    // Collapsible tree sections
    _$$('.pp-tree-section').forEach(sec => {
        sec.addEventListener('click', () => sec.classList.toggle('collapsed'));
    });

    // Description bar
    _$$('.pp-grid-row').forEach(row => {
        row.addEventListener('focusin', () => {
            const desc = row.getAttribute('data-desc');
            const bar = document.getElementById('pp-desc-bar');
            if (bar) bar.textContent = desc || '';
        });
    });

    // OK — apply and close
    _$('pp-ok')?.addEventListener('click', async () => {
        const proj = applyProjectProperties();
        if (proj) {
            await _ipcRenderer.invoke(_IPC.PROJECT_SAVE, proj);
            _$('project-props-overlay')?.classList.add('hidden');
            _appendOutput('Project properties saved.\n');
        }
    });

    // Apply — save but keep open
    _$('pp-apply')?.addEventListener('click', async () => {
        const proj = applyProjectProperties();
        if (proj) {
            await _ipcRenderer.invoke(_IPC.PROJECT_SAVE, proj);
            _appendOutput('Project properties applied.\n');
        }
    });

    // Cancel
    _$('pp-cancel')?.addEventListener('click', () => {
        _$('project-props-overlay')?.classList.add('hidden');
    });

    // Sync RTTI fields
    _$('pp-cpp-rtti')?.addEventListener('change', () => {
        ppSet('pp-cpp-rtti2', ppVal('pp-cpp-rtti'));
    });
    _$('pp-cpp-rtti2')?.addEventListener('change', () => {
        ppSet('pp-cpp-rtti', ppVal('pp-cpp-rtti2'));
    });
}

function ppVal(id: string): string {
    const el = _$(id) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    return el ? el.value : '';
}
function ppSet(id: string, val: string | undefined | null) {
    const el = _$(id) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    if (el) el.value = val || '';
}

export function openProjectProperties() {
    if (!_getCurrentProject()) {
        _appendOutput('Open a project first.\n');
        return;
    }

    const proj = _getCurrentProject();
    const props = proj.properties || {};

    // Set title
    _$('pp-title').textContent = `${proj.name} Property Pages`;

    // Configuration select
    (_$('pp-config-select') as HTMLSelectElement).value = proj.configuration || 'Debug';

    // General
    ppSet('pp-config-type', proj.type);
    ppSet('pp-charset', props.charset || 'mbcs');
    ppSet('pp-wpo', props.wholeProgramOptimization ? 'true' : 'false');
    ppSet('pp-clean-ext', props.cleanExtensions || '*.obj;*.pch;*.pdb;*.ilk;*.exp;*.xex;*.exe;*.rsp');

    // Debugging
    ppSet('pp-dbg-command', props.debugCommand || '$(RemotePath)');
    ppSet('pp-dbg-args', props.debugArgs || '');
    ppSet('pp-dbg-dvd', props.debugMapDvd ? 'true' : 'false');
    ppSet('pp-dbg-remote', props.debugRemoteMachine || '$(DefaultConsole)');

    // VC++ Directories
    ppSet('pp-vc-include-dirs', (proj.includeDirectories || []).join(';'));
    ppSet('pp-vc-lib-dirs', (proj.libraryDirectories || []).join(';'));
    ppSet('pp-vc-src-dirs', props.sourceDirectories || '');
    ppSet('pp-vc-exec-dirs', props.executableDirectories || '');
    ppSet('pp-vc-exclude-dirs', props.excludeDirectories || '');

    // C/C++ General
    ppSet('pp-cpp-inc-dirs', props.additionalIncludeDirectories || '');
    ppSet('pp-cpp-debug-info', props.debugInfoFormat || 'Zi');
    ppSet('pp-cpp-nologo', props.suppressBanner !== false ? 'true' : 'false');
    ppSet('pp-cpp-warn', String(proj.warningLevel ?? 3));
    ppSet('pp-cpp-wx', proj.treatWarningsAsErrors ? 'true' : 'false');
    ppSet('pp-cpp-mp', props.multiProcessorCompilation ? 'true' : 'false');

    // C/C++ Optimization
    ppSet('pp-cpp-opt', proj.optimizationOverride || 'default');
    ppSet('pp-cpp-inline', props.inlineFunctionExpansion || 'default');
    ppSet('pp-cpp-intrinsic', props.enableIntrinsics ? 'true' : 'false');
    ppSet('pp-cpp-favor', props.favorSizeOrSpeed || 'neither');
    ppSet('pp-cpp-wpo', props.compilerWholeProgramOpt ? 'true' : 'false');

    // C/C++ Preprocessor
    ppSet('pp-cpp-defines', (proj.defines || []).join(';'));
    ppSet('pp-cpp-undefs', props.undefineDefinitions || '');

    // C/C++ Code Generation
    ppSet('pp-cpp-stringpool', props.stringPooling ? 'true' : 'false');
    ppSet('pp-cpp-minrebuild', props.minimalRebuild ? 'true' : 'false');
    ppSet('pp-cpp-exceptions', proj.exceptionHandling || 'sync');
    ppSet('pp-cpp-smalltype', props.smallerTypeCheck ? 'true' : 'false');
    ppSet('pp-cpp-rtc', props.basicRuntimeChecks || 'default');
    ppSet('pp-cpp-runtime', props.runtimeLibrary || 'MTd');
    ppSet('pp-cpp-align', props.structAlignment || 'default');
    ppSet('pp-cpp-gs', props.bufferSecurityCheck ? 'true' : 'false');
    ppSet('pp-cpp-rtti', proj.enableRtti ? 'true' : 'false');
    ppSet('pp-cpp-funclink', props.functionLevelLinking ? 'true' : 'false');
    ppSet('pp-cpp-fp', props.floatingPointModel || 'fast');
    ppSet('pp-cpp-fpexcept', props.floatingPointExceptions ? 'true' : 'false');

    // C/C++ Language
    ppSet('pp-cpp-wchar', props.treatWcharAsBuiltin !== false ? 'true' : 'false');
    ppSet('pp-cpp-forscope', props.forceConformanceForScope !== false ? 'true' : 'false');
    ppSet('pp-cpp-rtti2', proj.enableRtti ? 'true' : 'false');

    // C/C++ Precompiled Headers
    ppSet('pp-cpp-pch-mode', props.pchMode || (proj.pchHeader ? 'use' : 'none'));
    ppSet('pp-cpp-pch-header', proj.pchHeader || 'stdafx.h');

    // C/C++ Advanced
    ppSet('pp-cpp-callconv', props.callingConvention || 'Gd');
    ppSet('pp-cpp-disable-warns', props.disableSpecificWarnings || '');

    // C/C++ Command Line
    ppSet('pp-cpp-extra', proj.additionalCompilerFlags || '');

    // Linker
    ppSet('pp-link-libdirs', (proj.libraryDirectories || []).join(';'));
    ppSet('pp-link-deps', (proj.libraries || []).join(';'));
    ppSet('pp-link-nodefault', props.ignoreDefaultLibraries || '');
    ppSet('pp-link-debug', props.generateDebugInfo !== false ? 'true' : 'false');
    ppSet('pp-link-incremental', props.incrementalLinking || 'default');
    ppSet('pp-link-stack', props.stackReserveSize || '');
    ppSet('pp-link-opt-ref', props.optimizeReferences || 'default');
    ppSet('pp-link-opt-icf', props.enableComdatFolding || 'default');
    ppSet('pp-link-entry', props.entryPoint || '');
    ppSet('pp-link-extra', proj.additionalLinkerFlags || '');

    // XEX
    ppSet('pp-xex-config', props.xexConfigFile || '');
    ppSet('pp-xex-output', props.xexOutputFile || '$(OutDir)$(ProjectName).xex');
    ppSet('pp-xex-titleid', props.xexTitleId || '');
    ppSet('pp-xex-lankey', props.xexLanKey || '');
    ppSet('pp-xex-nologo', props.xexSuppressBanner !== false ? 'true' : 'false');
    ppSet('pp-xex-baseaddr', props.xexBaseAddress || '');
    ppSet('pp-xex-heapsize', props.xexHeapSize || '');
    ppSet('pp-xex-workspace', props.xexWorkspaceSize || '');
    ppSet('pp-xex-sections', props.xexAdditionalSections || '');
    ppSet('pp-xex-exportbyname', props.xexExportByName ? 'true' : 'false');
    ppSet('pp-xex-network', props.xexNetworkAccess ? 'true' : 'false');
    ppSet('pp-xex-live', props.xexLiveAccess ? 'true' : 'false');
    ppSet('pp-xex-dvdmap', props.xexDvdMapping ? 'true' : 'false');
    ppSet('pp-xex-pal50', props.xexPal50 ? 'true' : 'false');
    ppSet('pp-xex-multidisc', props.xexMultiDisc ? 'true' : 'false');
    ppSet('pp-xex-bigbutton', props.xexBigButton ? 'true' : 'false');
    ppSet('pp-xex-crossplatform', props.xexCrossPlatform ? 'true' : 'false');
    ppSet('pp-xex-avatarxuid', props.xexAvatarXuid ? 'true' : 'false');
    ppSet('pp-xex-controllerswap', props.xexControllerSwap ? 'true' : 'false');
    ppSet('pp-xex-fullexp', props.xexFullExperience ? 'true' : 'false');
    ppSet('pp-xex-gamevoice', props.xexGameVoice ? 'true' : 'false');
    ppSet('pp-xex-kinectelev', props.xexKinectElevation ? 'true' : 'false');
    ppSet('pp-xex-skeletal', props.xexSkeletal || 'none');
    ppSet('pp-xex-extra', props.xexAdditionalOptions || '');

    // Build Events
    ppSet('pp-evt-prebuild-cmd', props.preBuildCommand || '');
    ppSet('pp-evt-prebuild-desc', props.preBuildDescription || '');
    ppSet('pp-evt-prelink-cmd', props.preLinkCommand || '');
    ppSet('pp-evt-prelink-desc', props.preLinkDescription || '');
    ppSet('pp-evt-postbuild-cmd', props.postBuildCommand || '');
    ppSet('pp-evt-postbuild-desc', props.postBuildDescription || '');

    // Console Deployment
    ppSet('pp-deploy-type', props.deploymentType || 'copy');
    ppSet('pp-deploy-dir', props.deploymentDirectory || '');
    ppSet('pp-deploy-files', props.deployAdditionalFiles || '');

    // Reset to first page
    _$$('.pp-tree-item').forEach(i => i.classList.remove('active'));
    const firstItem = document.querySelector('.pp-tree-item[data-page="general"]') as HTMLElement;
    if (firstItem) firstItem.classList.add('active');
    _$$('.pp-page').forEach(p => p.classList.remove('active'));
    _$('pp-page-general').classList.add('active');

    _$('project-props-overlay').classList.remove('hidden');
}

export function applyProjectProperties() {
    if (!_getCurrentProject()) return;

    const proj = _getCurrentProject();
    if (!proj.properties) proj.properties = {};
    const props = proj.properties;

    // General
    proj.type = ppVal('pp-config-type') as any;
    props.charset = ppVal('pp-charset');
    props.wholeProgramOptimization = ppVal('pp-wpo') === 'true';
    props.cleanExtensions = ppVal('pp-clean-ext');

    // Debugging
    props.debugCommand = ppVal('pp-dbg-command');
    props.debugArgs = ppVal('pp-dbg-args');
    props.debugMapDvd = ppVal('pp-dbg-dvd') === 'true';
    props.debugRemoteMachine = ppVal('pp-dbg-remote');

    // VC++ Directories
    const incDirs = ppVal('pp-vc-include-dirs').split(';').filter(s => s.trim());
    proj.includeDirectories = incDirs;
    const libDirs = ppVal('pp-vc-lib-dirs').split(';').filter(s => s.trim());
    proj.libraryDirectories = libDirs;
    props.sourceDirectories = ppVal('pp-vc-src-dirs');
    props.executableDirectories = ppVal('pp-vc-exec-dirs');
    props.excludeDirectories = ppVal('pp-vc-exclude-dirs');

    // C/C++ General
    props.additionalIncludeDirectories = ppVal('pp-cpp-inc-dirs');
    props.debugInfoFormat = ppVal('pp-cpp-debug-info');
    props.suppressBanner = ppVal('pp-cpp-nologo') === 'true';
    proj.warningLevel = parseInt(ppVal('pp-cpp-warn')) as any;
    proj.treatWarningsAsErrors = ppVal('pp-cpp-wx') === 'true';
    props.multiProcessorCompilation = ppVal('pp-cpp-mp') === 'true';

    // C/C++ Optimization
    proj.optimizationOverride = ppVal('pp-cpp-opt') as any;
    props.inlineFunctionExpansion = ppVal('pp-cpp-inline');
    props.enableIntrinsics = ppVal('pp-cpp-intrinsic') === 'true';
    props.favorSizeOrSpeed = ppVal('pp-cpp-favor');
    props.compilerWholeProgramOpt = ppVal('pp-cpp-wpo') === 'true';

    // C/C++ Preprocessor
    proj.defines = ppVal('pp-cpp-defines').split(';').filter(s => s.trim());

    // C/C++ Code Generation
    props.stringPooling = ppVal('pp-cpp-stringpool') === 'true';
    props.minimalRebuild = ppVal('pp-cpp-minrebuild') === 'true';
    proj.exceptionHandling = ppVal('pp-cpp-exceptions') as any;
    props.smallerTypeCheck = ppVal('pp-cpp-smalltype') === 'true';
    props.basicRuntimeChecks = ppVal('pp-cpp-rtc');
    props.runtimeLibrary = ppVal('pp-cpp-runtime');
    props.structAlignment = ppVal('pp-cpp-align');
    props.bufferSecurityCheck = ppVal('pp-cpp-gs') === 'true';
    proj.enableRtti = ppVal('pp-cpp-rtti') === 'true';
    props.functionLevelLinking = ppVal('pp-cpp-funclink') === 'true';
    props.floatingPointModel = ppVal('pp-cpp-fp');
    props.floatingPointExceptions = ppVal('pp-cpp-fpexcept') === 'true';

    // C/C++ Language
    props.treatWcharAsBuiltin = ppVal('pp-cpp-wchar') === 'true';
    props.forceConformanceForScope = ppVal('pp-cpp-forscope') === 'true';

    // C/C++ Precompiled Headers
    props.pchMode = ppVal('pp-cpp-pch-mode');
    proj.pchHeader = ppVal('pp-cpp-pch-header') || undefined;

    // C/C++ Advanced
    props.callingConvention = ppVal('pp-cpp-callconv');
    props.disableSpecificWarnings = ppVal('pp-cpp-disable-warns');

    // C/C++ Command Line
    proj.additionalCompilerFlags = ppVal('pp-cpp-extra').trim() || undefined;

    // Linker
    proj.libraries = ppVal('pp-link-deps').split(';').filter(s => s.trim());
    props.ignoreDefaultLibraries = ppVal('pp-link-nodefault');
    props.generateDebugInfo = ppVal('pp-link-debug') === 'true';
    props.incrementalLinking = ppVal('pp-link-incremental');
    props.stackReserveSize = ppVal('pp-link-stack');
    props.optimizeReferences = ppVal('pp-link-opt-ref');
    props.enableComdatFolding = ppVal('pp-link-opt-icf');
    props.entryPoint = ppVal('pp-link-entry');
    proj.additionalLinkerFlags = ppVal('pp-link-extra').trim() || undefined;

    // XEX
    props.xexConfigFile = ppVal('pp-xex-config');
    props.xexOutputFile = ppVal('pp-xex-output');
    props.xexTitleId = ppVal('pp-xex-titleid');
    props.xexLanKey = ppVal('pp-xex-lankey');
    props.xexSuppressBanner = ppVal('pp-xex-nologo') === 'true';
    props.xexBaseAddress = ppVal('pp-xex-baseaddr');
    props.xexHeapSize = ppVal('pp-xex-heapsize');
    props.xexWorkspaceSize = ppVal('pp-xex-workspace');
    props.xexAdditionalSections = ppVal('pp-xex-sections');
    props.xexExportByName = ppVal('pp-xex-exportbyname') === 'true';
    props.xexNetworkAccess = ppVal('pp-xex-network') === 'true';
    props.xexLiveAccess = ppVal('pp-xex-live') === 'true';
    props.xexDvdMapping = ppVal('pp-xex-dvdmap') === 'true';
    props.xexPal50 = ppVal('pp-xex-pal50') === 'true';
    props.xexMultiDisc = ppVal('pp-xex-multidisc') === 'true';
    props.xexBigButton = ppVal('pp-xex-bigbutton') === 'true';
    props.xexCrossPlatform = ppVal('pp-xex-crossplatform') === 'true';
    props.xexAvatarXuid = ppVal('pp-xex-avatarxuid') === 'true';
    props.xexControllerSwap = ppVal('pp-xex-controllerswap') === 'true';
    props.xexFullExperience = ppVal('pp-xex-fullexp') === 'true';
    props.xexGameVoice = ppVal('pp-xex-gamevoice') === 'true';
    props.xexKinectElevation = ppVal('pp-xex-kinectelev') === 'true';
    props.xexSkeletal = ppVal('pp-xex-skeletal');
    props.xexAdditionalOptions = ppVal('pp-xex-extra');

    // Build Events
    props.preBuildCommand = ppVal('pp-evt-prebuild-cmd');
    props.preBuildDescription = ppVal('pp-evt-prebuild-desc');
    props.preLinkCommand = ppVal('pp-evt-prelink-cmd');
    props.preLinkDescription = ppVal('pp-evt-prelink-desc');
    props.postBuildCommand = ppVal('pp-evt-postbuild-cmd');
    props.postBuildDescription = ppVal('pp-evt-postbuild-desc');

    // Console Deployment
    props.deploymentType = ppVal('pp-deploy-type');
    props.deploymentDirectory = ppVal('pp-deploy-dir');
    props.deployAdditionalFiles = ppVal('pp-deploy-files');

    // Clean up defaults
    if (!proj.enableRtti) delete proj.enableRtti;
    if (proj.exceptionHandling === 'sync') delete proj.exceptionHandling;
    if (proj.warningLevel === 3) delete proj.warningLevel;
    if (!proj.treatWarningsAsErrors) delete proj.treatWarningsAsErrors;
    if (proj.optimizationOverride === 'default') delete proj.optimizationOverride;

    return proj;
}

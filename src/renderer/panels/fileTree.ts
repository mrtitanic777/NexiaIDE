/**
 * fileTree.ts — File Explorer / Tree Panel
 *
 * Extracted from app.ts. Handles the file tree sidebar:
 * project tree rendering, virtual folders, inline file/folder creation,
 * drag-and-drop, context menus, and file icons.
 */

let _$: (id: string) => HTMLElement;
let _appendOutput: (text: string) => void;
let _ipcRenderer: any;
let _IPC: any;
let _shell: any;
let _nodePath: any;
let _nodeFs: any;
let _openFile: (path: string) => void;
let _showContextMenu: (x: number, y: number, items: any[]) => void;
let _getCurrentProject: () => any;

let _closeProject: () => void;
/** Draws the Explorer when no project is open. Supplied by app.ts. */
let _renderNoProjectView: (container: HTMLElement) => void = () => {};

/**
 * Local, deliberately.
 *
 * This file compiles to a CommonJS module with its own scope, so app.ts's
 * escapeHtml is not visible here — TypeScript resolves it from an ambient
 * declaration and says nothing, but at runtime it is a free variable and throws
 * ReferenceError the first time a name needs escaping. Everything else this
 * module needs from app.ts arrives through FileTreeDeps for the same reason.
 */
function escapeHtml(s: string): string {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export interface FileTreeDeps {
    $: (id: string) => HTMLElement;
    appendOutput: (text: string) => void;
    ipcRenderer: any;
    IPC: any;
    shell: any;
    nodePath: any;
    nodeFs: any;
    openFile: (path: string) => void;
    showContextMenu: (x: number, y: number, items: any[]) => void;
    getCurrentProject: () => any;
    closeProject: () => void;
    /** Draws the Explorer's contents when no project is open. */
    renderNoProjectView: (container: HTMLElement) => void;
}

export function initFileTree(deps: FileTreeDeps) {
    _$ = deps.$;
    _appendOutput = deps.appendOutput;
    _ipcRenderer = deps.ipcRenderer;
    _IPC = deps.IPC;
    _shell = deps.shell;
    _nodePath = deps.nodePath;
    _nodeFs = deps.nodeFs;
    _openFile = deps.openFile;
    _showContextMenu = deps.showContextMenu;
    _getCurrentProject = deps.getCurrentProject;
    _closeProject = deps.closeProject;
    _renderNoProjectView = deps.renderNoProjectView;

    // Wire explorer action buttons
    _$('explorer-new-file')?.addEventListener('click', () => {
        if (!_getCurrentProject()) { _appendOutput('Open a project first.\n'); return; }
        inlineCreateItem('file');
    });
    _$('explorer-new-folder')?.addEventListener('click', () => {
        if (!_getCurrentProject()) { _appendOutput('Open a project first.\n'); return; }
        inlineCreateItem('folder');
    });
    _$('explorer-refresh')?.addEventListener('click', () => refreshFileTree());
    _$('explorer-collapse')?.addEventListener('click', () => {
        _$('file-tree')?.querySelectorAll('.tree-children.open').forEach((el: Element) => {
            el.classList.remove('open');
            const arrow = el.previousElementSibling?.querySelector('.tree-arrow');
            if (arrow) { arrow.textContent = '\u25B6'; arrow.classList.remove('expanded'); }
        });
    });

    _$('explorer-close-project' as any)?.addEventListener('click', () => {
        if (!_getCurrentProject()) { _appendOutput('No project is open.\n'); return; }
        _closeProject();
    });

    // Right-click on empty space in explorer
    _$('file-tree')?.addEventListener('contextmenu', (e: MouseEvent) => {
        if ((e.target as HTMLElement).closest('.tree-item')) return;
        e.preventDefault();
        if (!_getCurrentProject()) return;
        _showContextMenu(e.clientX, e.clientY, [
            { label: 'New File...', action: () => inlineCreateItem('file') },
            { label: 'New Folder...', action: () => inlineCreateItem('folder') },
            { label: '\u2500', action: () => {} },
            { label: 'Add Existing File...', action: () => addExistingFile() },
            { label: 'Upload Document...', action: () => uploadDocument() },
            { label: '\u2500', action: () => {} },
            { label: 'Refresh', action: () => refreshFileTree() },
            { label: '\u2500', action: () => {} },
            { label: 'Open in Explorer', action: () => { _shell.openPath(_getCurrentProject().path); } },
        ]);
    });

    // Drop onto empty space in file tree
    _$('file-tree')?.addEventListener('dragover', (e: DragEvent) => {
        if (!(e.target as HTMLElement).closest('.tree-item') && e.dataTransfer?.types.includes('nexia/filepath')) {
            e.preventDefault();
            e.dataTransfer!.dropEffect = 'move';
        }
    });
    _$('file-tree')?.addEventListener('drop', async (e: DragEvent) => {
        if ((e.target as HTMLElement).closest('.tree-item')) return;
        e.preventDefault();
        if (!_getCurrentProject()) return;
        const srcPath = e.dataTransfer!.getData('nexia/filepath');
        if (!srcPath) return;
        const fileName = _nodePath.basename(srcPath);
        const destPath = _nodePath.join(_getCurrentProject().path, 'src', fileName);
        if (srcPath === destPath) return;
        try {
            _nodeFs.renameSync(srcPath, destPath);
            _appendOutput(`Moved: ${fileName} \u2192 ${_nodePath.dirname(destPath)}\n`);
            await refreshFileTree();
        } catch (err: any) { _appendOutput(`Move failed: ${err.message}\n`); }
    });
}

export async function refreshFileTree() {
    const tree = await _ipcRenderer.invoke(_IPC.FILE_LIST);
    const container = _$('file-tree');
    container.innerHTML = '';

    // No project: the Explorer is the recent-projects list. getFileTree returns
    // [] with nothing open, so this branch used to render an empty panel.
    // Handing it to app.ts keeps the recents list next to openProject, which is
    // all it does.
    if (!_getCurrentProject()) {
        _renderNoProjectView(container);
        return;
    }

    // ── Project root node (like VS Solution Explorer) ──
    const rootNode = document.createElement('div');
    rootNode.className = 'project-root-node';
    rootNode.innerHTML = `<span class="tree-arrow expanded">▶</span><span class="project-root-icon">🎮</span><span>${_getCurrentProject().name}</span>`;

    const rootChildren = document.createElement('div');
    rootChildren.className = 'tree-children open';

    rootNode.addEventListener('click', () => {
        rootChildren.classList.toggle('open');
        const arrow = rootNode.querySelector('.tree-arrow')!;
        arrow.classList.toggle('expanded');
    });

    // Right-click on project root
    rootNode.addEventListener('contextmenu', (e: MouseEvent) => {
        e.preventDefault();
        _showContextMenu(e.clientX, e.clientY, [
            { label: 'New File...', action: () => inlineCreateItem('file') },
            { label: 'New Folder...', action: () => inlineCreateItem('folder') },
            { label: '─', action: () => {} },
            { label: 'Add Existing File...', action: () => addExistingFile() },
            { label: 'Upload Document...', action: () => uploadDocument() },
            { label: '─', action: () => {} },
            { label: 'Refresh', action: () => refreshFileTree() },
            { label: '─', action: () => {} },
            { label: 'Open in Explorer', action: () => { _shell.openPath(_getCurrentProject().path); } },
        ]);
    });

    // ── Solution header, when the project came from a .sln ──
    //
    // Visual Studio puts the solution and its projects at the top of Solution
    // Explorer, which is how you see at a glance that your dependencies are
    // attached. Nexia builds one project, so the sibling projects here are
    // informational — but a project that links AtgFramework should say so
    // rather than leaving you to guess whether it came across.
    const solution = _getCurrentProject().solution;
    if (solution && solution.projects.length > 1) {
        const slnNode = document.createElement('div');
        slnNode.className = 'tree-item solution-node';
        slnNode.style.paddingLeft = '8px';
        const count = solution.projects.length;
        slnNode.innerHTML =
            `<span class="tree-arrow expanded">▼</span>` +
            `<span class="tree-icon">📁</span>` +
            `<span class="tree-name">Solution '${escapeHtml(solution.name)}' (${count} project${count === 1 ? '' : 's'})</span>`;
        slnNode.title = solution.path || solution.name;
        container.appendChild(slnNode);

        // Sibling projects — everything in the solution that isn't the one open.
        for (const p of solution.projects) {
            if (p.isCurrent) continue;
            const cfgs = Object.keys(p.libPaths || {});
            const item = document.createElement('div');
            item.className = 'tree-item solution-dep';
            item.style.paddingLeft = '24px';
            const state = cfgs.length
                ? `<span style="color:var(--text-muted)"> — ${p.insideSdk ? 'linked from SDK' : 'linked'}</span>`
                : `<span style="color:var(--yellow)"> — not built, won't link</span>`;
            item.innerHTML =
                `<span class="tree-arrow" style="visibility:hidden">▶</span>` +
                `<span class="tree-icon">${cfgs.length ? '📦' : '⚠'}</span>` +
                `<span class="tree-name">${escapeHtml(p.name)}${state}</span>`;
            item.title = cfgs.length
                ? `${p.path}\nAvailable for: ${cfgs.join(', ')}`
                : `${p.path}\nNo built library found — this dependency won't link.`;
            container.appendChild(item);
        }
    }

    container.appendChild(rootNode);

    // ── External Dependencies — the libraries this project links ──
    // VS shows these under each project. Ours lists what actually gets passed to
    // the linker for the current configuration, so a missing dependency is
    // visible here rather than only at link time.
    {
        const proj = _getCurrentProject();
        const cfg = proj.configuration || 'Debug';
        const libs = proj.configurations?.[cfg]?.libraries || proj.libraries || [];
        if (libs.length) {
            const depNodes = libs.map((l: string) => ({ name: l, isExternalLib: true }));
            rootChildren.appendChild(createVirtualFolder(
                `External Dependencies (${cfg})`, '🔗', depNodes, 1, /* collapsed */ true));
        }
    }

    // ── Build virtual "Header Files" and "Source Files" groups ──
    const HEADER_EXTS = new Set(['.h', '.hpp', '.hxx', '.inl']);
    const SOURCE_EXTS = new Set(['.cpp', '.c', '.cc', '.cxx']);
    const headerFiles: any[] = [];
    const sourceFiles: any[] = [];
    const otherNodes: any[] = [];

    // Collect all files recursively from the tree
    function collectFiles(nodes: any[], inSourceDir: boolean = false) {
        for (const node of nodes) {
            if (node.isDirectory) {
                const lname = node.name.toLowerCase();
                // Flatten include/ and src/ directories — their contents go into virtual groups
                if (lname === 'include' || lname === 'src' || inSourceDir) {
                    if (node.children) collectFiles(node.children, true);
                } else {
                    otherNodes.push(node);
                }
            } else {
                const ext = (node.extension || '').toLowerCase();
                if (HEADER_EXTS.has(ext)) {
                    headerFiles.push(node);
                } else if (SOURCE_EXTS.has(ext)) {
                    sourceFiles.push(node);
                } else {
                    otherNodes.push(node);
                }
            }
        }
    }
    collectFiles(tree);

    // Render "Header Files" virtual folder
    if (headerFiles.length > 0) {
        const vfolder = createVirtualFolder('Header Files', '📋', headerFiles, 1);
        rootChildren.appendChild(vfolder);
    }

    // Render "Source Files" virtual folder
    if (sourceFiles.length > 0) {
        const vfolder = createVirtualFolder('Source Files', '📄', sourceFiles, 1);
        rootChildren.appendChild(vfolder);
    }

    // Render remaining nodes normally
    renderFileTree(otherNodes, rootChildren, 1, false);

    container.appendChild(rootChildren);
}

/**
 * @param collapsed Start shut. Used for External Dependencies, which is a long
 *                  list you rarely need open — Visual Studio collapses it too.
 *                  Header/Source Files default to open, because they are the
 *                  reason the panel exists.
 */
function createVirtualFolder(name: string, icon: string, files: any[], depth: number, collapsed = false): HTMLElement {
    const wrapper = document.createElement('div');
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    wrapper.className = `virtual-folder virtual-folder-${slug}`;

    const header = document.createElement('div');
    header.className = 'tree-item';
    header.style.paddingLeft = (8 + depth * 16) + 'px';
    // Expanded from the start (unless asked otherwise). These were built collapsed
    // and nothing ever opened them, so opening a project showed "Header Files" and
    // "Source Files" as two shut folders and you had to click into them every
    // single time to reach your code. Visual Studio shows them open, and there is
    // nothing to gain by hiding the only thing in the panel worth looking at.
    header.innerHTML = `<span class="tree-arrow${collapsed ? '' : ' expanded'}">${collapsed ? '▶' : '▼'}</span><span class="tree-icon">${icon}</span><span class="tree-name">${name}</span>`;

    const children = document.createElement('div');
    children.className = collapsed ? 'tree-children' : 'tree-children open';

    header.addEventListener('click', () => {
        children.classList.toggle('open');
        const arrow = header.querySelector('.tree-arrow')! as HTMLElement;
        if (children.classList.contains('open')) {
            arrow.textContent = '▼'; arrow.classList.add('expanded');
        } else {
            arrow.textContent = '▶'; arrow.classList.remove('expanded');
        }
    });

    // Right-click on virtual folder
    header.addEventListener('contextmenu', (e: MouseEvent) => {
        e.preventDefault();
        _showContextMenu(e.clientX, e.clientY, [
            { label: 'New File...', action: () => inlineCreateItem('file') },
            { label: '─', action: () => {} },
            { label: 'Add Existing File...', action: () => addExistingFile() },
        ]);
    });

    // Render files inside
    for (const file of files) {
        // External Dependencies entries are libraries, not files on disk: they
        // have a name and nothing to open. Render them plainly and skip the file
        // behaviours, or clicking one would try to open `undefined`.
        if (file.isExternalLib) {
            const li = document.createElement('div');
            li.className = 'tree-item external-lib';
            li.style.paddingLeft = (8 + (depth + 1) * 16 + 20) + 'px';
            li.innerHTML = `<span class="tree-icon">📚</span><span class="tree-name" style="color:var(--text-dim)">${file.name}</span>`;
            li.title = file.name;
            children.appendChild(li);
            continue;
        }

        const fi = document.createElement('div');
        fi.className = 'tree-item';
        fi.style.paddingLeft = (8 + (depth + 1) * 16 + 20) + 'px';
        fi.innerHTML = `<span class="tree-icon">${getFileIcon(file.extension || '')}</span><span class="tree-name">${file.name}</span>`;
        fi.addEventListener('click', () => _openFile(file.path));
        fi.addEventListener('contextmenu', (e: MouseEvent) => {
            e.preventDefault();
            _showContextMenu(e.clientX, e.clientY, [
                { label: 'Open', action: () => _openFile(file.path) },
                { label: '─', action: () => {} },
                { label: 'Rename...', action: () => renameFile(file.path) },
                { label: 'Delete', action: () => deleteFile(file.path) },
                { label: '─', action: () => {} },
                { label: 'Copy Path', action: () => { navigator.clipboard.writeText(file.path); } },
                { label: 'Reveal in Explorer', action: () => { _shell.showItemInFolder(file.path); } },
            ]);
        });
        fi.draggable = true;
        fi.addEventListener('dragstart', (e: DragEvent) => {
            e.dataTransfer!.setData('nexia/filepath', file.path);
            e.dataTransfer!.setData('nexia/isdir', 'false');
            e.dataTransfer!.effectAllowed = 'move';
            fi.classList.add('dragging');
        });
        fi.addEventListener('dragend', () => { fi.classList.remove('dragging'); });
        children.appendChild(fi);
    }

    wrapper.appendChild(header);
    wrapper.appendChild(children);
    return wrapper;
}


/**
 * Inline creation — inserts a temporary editable tree item in the explorer.
 * On Enter the file/folder is actually created. On Escape/blur it is cancelled.
 */
export function inlineCreateItem(kind: 'file' | 'folder') {
    // Remove any existing inline editor first
    document.querySelectorAll('.tree-inline-new').forEach(el => el.remove());

    // Decide where to insert the inline item and ensure the container is open
    let container: HTMLElement | null = null;
    if (kind === 'file') {
        // Put it inside the "Source Files" virtual folder children
        container = _$('file-tree').querySelector('.virtual-folder-source-files .tree-children') as HTMLElement;
        if (container) {
            container.classList.add('open');
            const arrow = container.previousElementSibling?.querySelector('.tree-arrow') as HTMLElement;
            if (arrow) { arrow.textContent = '▼'; arrow.classList.add('expanded'); }
        }
    }
    if (!container) {
        // Fallback: put it inside the root children
        const rootChildren = _$('file-tree').querySelector('.tree-children') as HTMLElement;
        container = rootChildren || _$('file-tree');
    }

    const defaultName = kind === 'file' ? 'NewFile.cpp' : 'NewFolder';
    const icon = kind === 'file' ? '<span class="ficon ficon-cpp">C++</span>' : '📁';
    const depth = kind === 'file' ? 2 : 1;

    // Create the temporary inline row
    const row = document.createElement('div');
    row.className = 'tree-item tree-inline-new';
    row.style.paddingLeft = (8 + depth * 16 + (kind === 'file' ? 20 : 0)) + 'px';
    row.innerHTML = `<span class="tree-icon">${icon}</span>`;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'tree-inline-input';
    input.value = defaultName;
    input.spellcheck = false;
    row.appendChild(input);

    // Insert at the top of the container
    container.insertBefore(row, container.firstChild);
    input.focus();
    // Select just the name part (before extension for files)
    if (kind === 'file') {
        const dotIdx = defaultName.lastIndexOf('.');
        input.setSelectionRange(0, dotIdx > 0 ? dotIdx : defaultName.length);
    } else {
        input.select();
    }

    let committed = false;

    async function commit() {
        if (committed) return;
        committed = true;
        const name = input.value.trim();
        if (!name || !_getCurrentProject()) {
            row.remove();
            return;
        }
        const srcDir = _nodePath.join(_getCurrentProject().path, 'src');
        try {
            if (kind === 'file') {
                const filePath = _nodePath.join(srcDir, name);
                let content = '';
                if (/\.(cpp|c|cc|cxx)$/i.test(name)) content = '#include "stdafx.h"\n\n';
                else if (/\.(h|hpp)$/i.test(name)) {
                    const guard = name.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_';
                    content = `#pragma once\n#ifndef ${guard}\n#define ${guard}\n\n\n\n#endif // ${guard}\n`;
                }
                await _ipcRenderer.invoke(_IPC.FILE_CREATE, filePath, content);
                await refreshFileTree();
                _openFile(filePath);
                _appendOutput(`Created: ${name}\n`);
            } else {
                const fullPath = _nodePath.join(srcDir, name);
                _nodeFs.mkdirSync(fullPath, { recursive: true });
                await refreshFileTree();
                _appendOutput(`Created folder: ${name}\n`);
            }
        } catch (err: any) {
            _appendOutput(`Create failed: ${err.message}\n`);
            row.remove();
        }
    }

    function cancel() {
        if (committed) return;
        committed = true;
        row.remove();
    }

    input.addEventListener('keydown', (e: KeyboardEvent) => {
        e.stopPropagation(); // Prevent editor shortcuts from firing
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
    input.addEventListener('blur', () => {
        // Small delay to let click on something else process first
        setTimeout(() => { if (!committed) commit(); }, 150);
    });
}



async function newFolderInProject() {
    if (!_getCurrentProject()) { _appendOutput('Open a project first.\n'); return; }
    const name = prompt('New folder name:');
    if (!name || !name.trim()) return;
    const fullPath = _nodePath.join(_getCurrentProject().path, 'src', name.trim());
    try {
        _nodeFs.mkdirSync(fullPath, { recursive: true });
        await refreshFileTree();
        _appendOutput(`Created folder: src/${name.trim()}\n`);
    } catch (err: any) { _appendOutput(`Create folder failed: ${err.message}\n`); }
}

async function addExistingFile() {
    if (!_getCurrentProject()) { _appendOutput('Open a project first.\n'); return; }
    const filePath = await _ipcRenderer.invoke(_IPC.FILE_SELECT_FILE);
    if (!filePath) return;
    const fileName = _nodePath.basename(filePath);
    const srcDir = _nodePath.join(_getCurrentProject().path, 'src');
    if (!_nodeFs.existsSync(srcDir)) _nodeFs.mkdirSync(srcDir, { recursive: true });
    const dest = _nodePath.join(srcDir, fileName);
    try {
        _nodeFs.copyFileSync(filePath, dest);
        await refreshFileTree();
        _openFile(dest);
        _appendOutput(`Added: ${fileName}\n`);
    } catch (err: any) { _appendOutput(`Add file failed: ${err.message}\n`); }
}

function renderFileTree(nodes: any[], container: HTMLElement, depth: number, clear: boolean = true) {
    if (clear) container.innerHTML = '';
    for (const node of nodes) {
        const item = document.createElement('div');
        if (node.isDirectory) {
            const header = document.createElement('div');
            header.className = 'tree-item';
            header.style.paddingLeft = (8 + depth * 16) + 'px';
            header.innerHTML = `<span class="tree-arrow">▶</span><span class="tree-icon">📁</span><span class="tree-name">${node.name}</span>`;
            const children = document.createElement('div');
            children.className = 'tree-children';
            if (node.children) renderFileTree(node.children, children, depth + 1);
            header.addEventListener('click', () => {
                children.classList.toggle('open');
                const arrow = header.querySelector('.tree-arrow')! as HTMLElement;
                const icon = header.querySelector('.tree-icon')!;
                if (children.classList.contains('open')) {
                    arrow.textContent = '▼'; arrow.classList.add('expanded'); icon.textContent = '📂';
                } else {
                    arrow.textContent = '▶'; arrow.classList.remove('expanded'); icon.textContent = '📁';
                }
            });
            header.addEventListener('contextmenu', (e: MouseEvent) => {
                e.preventDefault();
                _showContextMenu(e.clientX, e.clientY, [
                    { label: 'New File Here...', action: () => newFileInFolder(node.path) },
                    { label: '─', action: () => {} },
                    { label: 'Rename...', action: () => renameFile(node.path) },
                    { label: 'Delete Folder', action: () => deleteFile(node.path) },
                    { label: '─', action: () => {} },
                    { label: 'Copy Path', action: () => { navigator.clipboard.writeText(node.path); } },
                    { label: 'Open in Explorer', action: () => { _shell.openPath(node.path); } },
                ]);
            });

            // --- Drag-and-drop: folders are drop targets ---
            // Also make folders draggable to move entire folders
            header.draggable = true;
            header.addEventListener('dragstart', (e: DragEvent) => {
                e.dataTransfer!.setData('nexia/filepath', node.path);
                e.dataTransfer!.setData('nexia/isdir', 'true');
                e.dataTransfer!.effectAllowed = 'move';
                header.classList.add('dragging');
            });
            header.addEventListener('dragend', () => { header.classList.remove('dragging'); });
            header.addEventListener('dragover', (e: DragEvent) => {
                // Accept drops of files/folders but not onto self
                const srcPath = e.dataTransfer?.types.includes('nexia/filepath') ? true : false;
                if (!srcPath) return;
                e.preventDefault();
                e.dataTransfer!.dropEffect = 'move';
                header.classList.add('drag-over');
            });
            header.addEventListener('dragleave', () => { header.classList.remove('drag-over'); });
            header.addEventListener('drop', async (e: DragEvent) => {
                e.preventDefault();
                header.classList.remove('drag-over');
                const srcPath = e.dataTransfer!.getData('nexia/filepath');
                if (!srcPath) return;
                const fileName = _nodePath.basename(srcPath);
                const destPath = _nodePath.join(node.path, fileName);
                // Don't drop onto self or into own subtree
                if (srcPath === destPath || srcPath === node.path) return;
                if (destPath.startsWith(srcPath + _nodePath.sep)) return;
                await moveFile(srcPath, destPath);
            });

            item.appendChild(header);
            item.appendChild(children);
        } else {
            const fi = document.createElement('div');
            fi.className = 'tree-item';
            fi.style.paddingLeft = (8 + depth * 16 + 20) + 'px';
            fi.innerHTML = `<span class="tree-icon">${getFileIcon(node.extension || '')}</span><span class="tree-name">${node.name}</span>`;
            fi.addEventListener('click', () => _openFile(node.path));
            fi.addEventListener('contextmenu', (e: MouseEvent) => {
                e.preventDefault();
                _showContextMenu(e.clientX, e.clientY, [
                    { label: 'Open', action: () => _openFile(node.path) },
                    { label: '─', action: () => {} },
                    { label: 'Rename...', action: () => renameFile(node.path) },
                    { label: 'Delete', action: () => deleteFile(node.path) },
                    { label: '─', action: () => {} },
                    { label: 'Copy Path', action: () => { navigator.clipboard.writeText(node.path); } },
                    { label: 'Reveal in Explorer', action: () => { _shell.showItemInFolder(node.path); } },
                ]);
            });

            // --- Drag-and-drop: files are draggable ---
            fi.draggable = true;
            fi.addEventListener('dragstart', (e: DragEvent) => {
                e.dataTransfer!.setData('nexia/filepath', node.path);
                e.dataTransfer!.setData('nexia/isdir', 'false');
                e.dataTransfer!.effectAllowed = 'move';
                fi.classList.add('dragging');
            });
            fi.addEventListener('dragend', () => { fi.classList.remove('dragging'); });

            item.appendChild(fi);
        }
        container.appendChild(item);
    }
}

/**
 * Move a file or folder to a new path, updating any open tabs.
 */
async function moveFile(srcPath: string, destPath: string) {
    const name = _nodePath.basename(srcPath);
    if (_nodeFs.existsSync(destPath)) {
        if (!confirm(`"${name}" already exists in the destination. Overwrite?`)) return;
    }
    try {
        await _ipcRenderer.invoke(_IPC.FILE_RENAME, srcPath, destPath);
        // Update any open tabs that were inside the moved path
        for (const tab of openTabs) {
            if (tab.path === srcPath) {
                tab.path = destPath;
                tab.name = _nodePath.basename(destPath);
                if (activeTab === srcPath) activeTab = destPath;
            } else if (tab.path.startsWith(srcPath + _nodePath.sep)) {
                // File was inside a moved folder
                const rel = tab.path.substring(srcPath.length);
                tab.path = destPath + rel;
                if (activeTab === srcPath + rel) activeTab = tab.path;
            }
        }
        renderTabs();
        await refreshFileTree();
        _appendOutput(`Moved: ${name} → ${_nodePath.dirname(destPath)}\n`);
    } catch (err: any) {
        _appendOutput(`Move failed: ${err.message}\n`);
    }
}

export function getFileIcon(ext: string): string {
    const m: Record<string, string> = {
        '.cpp': '<span class="ficon ficon-cpp">C++</span>',
        '.c': '<span class="ficon ficon-c">C</span>',
        '.h': '<span class="ficon ficon-h">H</span>',
        '.hpp': '<span class="ficon ficon-h">H+</span>',
        '.hlsl': '🎨', '.fx': '🎨',
        '.xui': '🖼', '.xur': '🖼',
        '.wav': '🔊', '.xma': '🔊',
        '.json': '<span class="ficon ficon-json">{}</span>',
        '.xml': '<span class="ficon ficon-xml">&lt;&gt;</span>',
        '.xex': '🎮', '.exe': '⚙', '.dll': '📦',
        '.png': '🖼', '.dds': '🖼', '.bmp': '🖼', '.tga': '🖼',
        '.txt': '📝', '.md': '📝', '.log': '📝',
        '.bat': '⚡', '.cmd': '⚡',
        '.py': '🐍', '.js': '<span class="ficon ficon-js">JS</span>',
        '.ts': '<span class="ficon ficon-ts">TS</span>',
    };
    return m[ext] || '📄';
}

/**
 * xexInspector.ts — XEX File Inspector
 *
 * Extracted from app.ts during Phase 5 decomposition.
 * Parses and displays Xbox 360 XEX executable metadata.
 */

import { $, escHtml, ctx, fn } from '../appContext';
const { ipcRenderer } = require('electron');

export let xexInspectorContainer: HTMLElement | null = null;

export async function openXexInspector(xexPath?: string) {
    try {
        const data = await ipcRenderer.invoke(IPC.XEX_INSPECT, xexPath || undefined);
        if (!data) return; // User cancelled
        showXexInspector(data);
    } catch (err: any) {
        fn.appendOutput(`XEX Inspector error: ${err.message}\n`);
    }
}

export function showXexInspector(data: any) {
    // Create or reuse the inspector container
    if (!xexInspectorContainer) {
        xexInspectorContainer = document.createElement('div');
        xexInspectorContainer.id = 'xex-inspector';
        $('editor-area').appendChild(xexInspectorContainer);
    }

    // Add as a pseudo-tab
    const tabPath = `__xex_inspector__:${data.filePath || 'xex'}`;
    const existing = ctx.openTabs.find(t => t.path === tabPath);
    if (existing) {
        switchToXexTab(tabPath, data);
        return;
    }

    // Create a dummy model (won't be used by Monaco)
    const monaco = (window as any).monaco;
    const model = monaco?.editor?.createModel?.('', 'plaintext') || { dispose: () => {}, getValue: () => '' };

    ctx.openTabs.push({ path: tabPath, name: `🔍 ${data.fileName || 'XEX Inspector'}`, model, modified: false });
    switchToXexTab(tabPath, data);
}

export function switchToXexTab(tabPath: string, data: any) {
    ctx.activeTab = tabPath;
    // Hide Monaco editor, show XEX inspector
    $('editor-container').style.display = 'none';
    $('welcome-screen').style.display = 'none';
    if (xexInspectorContainer) {
        xexInspectorContainer.style.display = 'block';
        xexInspectorContainer.innerHTML = renderXexInspectorHtml(data);
        // Attach drag-drop handler
        setupXexDropZone();
    }
    fn.renderTabs();
}

export function setupXexDropZone() {
    const dropZone = document.getElementById('xex-drop-zone');
    if (!dropZone) return;
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('xex-drag-over'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('xex-drag-over'));
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('xex-drag-over');
        const files = e.dataTransfer?.files;
        if (files && files.length > 0) {
            const file = files[0];
            if (file.path) openXexInspector(file.path);
        }
    });
}

function renderXexInspectorHtml(data: any): string {
    if (data.error && !data.valid) {
        return `
        <div class="xex-inspector-content">
            <div class="xex-header-bar">
                <h2>🔍 XEX Inspector</h2>
                <span class="xex-file-path">${escHtml(data.filePath || '')}</span>
            </div>
            <div id="xex-drop-zone" class="xex-drop-zone">
                <div class="xex-drop-icon">📦</div>
                <div class="xex-drop-text">Drop a .xex file here to inspect</div>
                <div class="xex-drop-hint">or use View → Inspect XEX...</div>
            </div>
            <div class="xex-error-box">⚠ ${escHtml(data.error)}</div>
        </div>`;
    }

    let html = `<div class="xex-inspector-content">`;

    // Header bar
    html += `<div class="xex-header-bar">
        <h2>🔍 XEX Inspector</h2>
        <div id="xex-drop-zone" class="xex-drop-zone xex-drop-zone-mini">
            <span>📦 Drop another .xex here</span>
        </div>
    </div>`;

    // File overview
    html += `<div class="xex-section">
        <div class="xex-section-title">📄 File Overview</div>
        <div class="xex-info-grid">
            <div class="xex-info-row"><span class="xex-label">File</span><span class="xex-value">${escHtml(data.fileName)}</span></div>
            <div class="xex-info-row"><span class="xex-label">Path</span><span class="xex-value xex-path">${escHtml(data.filePath)}</span></div>
            <div class="xex-info-row"><span class="xex-label">Size</span><span class="xex-value">${escHtml(data.fileSizeFormatted)} (${data.fileSize?.toLocaleString()} bytes)</span></div>
            <div class="xex-info-row"><span class="xex-label">Format</span><span class="xex-value xex-tag xex-tag-ok">${escHtml(data.header?.magic || '?')}</span></div>`;

    if (data.header?.originalPeName) {
        html += `<div class="xex-info-row"><span class="xex-label">Original PE</span><span class="xex-value">${escHtml(data.header.originalPeName)}</span></div>`;
    }
    if (data.header?.peTimestamp) {
        html += `<div class="xex-info-row"><span class="xex-label">PE Timestamp</span><span class="xex-value">${escHtml(data.header.peTimestamp)}</span></div>`;
    }
    if (data.header?.moduleFlagsDecoded?.length > 0) {
        html += `<div class="xex-info-row"><span class="xex-label">Module Flags</span><span class="xex-value">${data.header.moduleFlagsDecoded.map((f: string) => `<span class="xex-tag">${escHtml(f)}</span>`).join(' ')}</span></div>`;
    }
    html += `</div></div>`;

    // Execution info
    if (data.executionInfo && Object.keys(data.executionInfo).length > 0) {
        html += `<div class="xex-section">
            <div class="xex-section-title">⚡ Execution Info</div>
            <div class="xex-info-grid">`;
        if (data.executionInfo.titleId) html += `<div class="xex-info-row"><span class="xex-label">Title ID</span><span class="xex-value xex-mono">${escHtml(data.executionInfo.titleId)}</span></div>`;
        if (data.executionInfo.mediaId) html += `<div class="xex-info-row"><span class="xex-label">Media ID</span><span class="xex-value xex-mono">${escHtml(data.executionInfo.mediaId)}</span></div>`;
        if (data.executionInfo.version) html += `<div class="xex-info-row"><span class="xex-label">Version</span><span class="xex-value">${escHtml(data.executionInfo.version)}</span></div>`;
        if (data.executionInfo.baseVersion) html += `<div class="xex-info-row"><span class="xex-label">Base Version</span><span class="xex-value">${escHtml(data.executionInfo.baseVersion)}</span></div>`;
        if (data.executionInfo.entryPoint) html += `<div class="xex-info-row"><span class="xex-label">Entry Point</span><span class="xex-value xex-mono">${escHtml(data.executionInfo.entryPoint)}</span></div>`;
        if (data.executionInfo.imageBaseAddress) html += `<div class="xex-info-row"><span class="xex-label">Image Base</span><span class="xex-value xex-mono">${escHtml(data.executionInfo.imageBaseAddress)}</span></div>`;
        if (data.executionInfo.discNumber) html += `<div class="xex-info-row"><span class="xex-label">Disc</span><span class="xex-value">${data.executionInfo.discNumber} of ${data.executionInfo.discCount}</span></div>`;
        html += `</div></div>`;
    }

    // Sections
    if (data.sections?.length > 0) {
        html += `<div class="xex-section">
            <div class="xex-section-title">📦 PE Sections (${data.sections.length})</div>
            <table class="xex-table">
                <thead><tr><th>Name</th><th>Virtual Addr</th><th>Virtual Size</th><th>Raw Size</th><th>Characteristics</th></tr></thead>
                <tbody>`;
        for (const sec of data.sections) {
            const chars = sec.characteristics?.join(', ') || '';
            html += `<tr>
                <td class="xex-mono">${escHtml(sec.name)}</td>
                <td class="xex-mono">${escHtml(sec.virtualAddress)}</td>
                <td>${escHtml(sec.virtualSizeFormatted)}</td>
                <td>${escHtml(sec.rawDataSizeFormatted)}</td>
                <td><span class="xex-chars">${escHtml(chars)}</span></td>
            </tr>`;
        }
        html += `</tbody></table></div>`;
    }

    // Imports
    if (data.imports?.length > 0) {
        html += `<div class="xex-section">
            <div class="xex-section-title">📥 Import Libraries (${data.imports.length})</div>
            <div class="xex-imports-list">`;
        for (const imp of data.imports) {
            html += `<div class="xex-import-item"><span class="xex-mono">${escHtml(imp.library)}</span></div>`;
        }
        html += `</div></div>`;
    }

    // Resources
    if (data.resources?.length > 0) {
        html += `<div class="xex-section">
            <div class="xex-section-title">🗂 Resources (${data.resources.length})</div>
            <table class="xex-table">
                <thead><tr><th>Name</th><th>Address</th><th>Size</th></tr></thead>
                <tbody>`;
        for (const res of data.resources) {
            html += `<tr>
                <td class="xex-mono">${escHtml(res.name)}</td>
                <td class="xex-mono">${escHtml(res.address)}</td>
                <td>${escHtml(res.sizeFormatted)}</td>
            </tr>`;
        }
        html += `</tbody></table></div>`;
    }

    // Optional headers (collapsible raw view)
    if (data.optionalHeaders?.length > 0) {
        html += `<div class="xex-section">
            <div class="xex-section-title xex-collapsible" onclick="this.parentElement.classList.toggle('xex-collapsed')">
                ▶ Optional Headers (${data.optionalHeaders.length})
            </div>
            <table class="xex-table xex-collapsible-body">
                <thead><tr><th>ID</th><th>Name</th><th>Data</th></tr></thead>
                <tbody>`;
        for (const h of data.optionalHeaders) {
            const extra = h.value ? ` → ${typeof h.value === 'string' ? escHtml(h.value) : h.valueFormatted || h.value}` : '';
            html += `<tr>
                <td class="xex-mono">${escHtml(h.idHex)}</td>
                <td>${escHtml(h.name)}</td>
                <td class="xex-mono">${escHtml(h.dataHex)}${extra}</td>
            </tr>`;
        }
        html += `</tbody></table></div>`;
    }

    // Security info
    if (data.securityInfo?.imageSize) {
        html += `<div class="xex-section">
            <div class="xex-section-title">🔒 Security Info</div>
            <div class="xex-info-grid">
                <div class="xex-info-row"><span class="xex-label">Image Size</span><span class="xex-value">${escHtml(data.securityInfo.imageSizeFormatted)}</span></div>
            </div>
        </div>`;
    }

    html += `</div>`;
    return html;
}


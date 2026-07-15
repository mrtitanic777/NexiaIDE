/**
 * adminPanel.ts — Admin Panel for Nexia IDE
 *
 * Visible only to users with role === 'admin'.
 * Contains:
 *   1. User Management — list, promote, demote, delete users
 *   2. Lesson Builder — visual lesson editor with drag-and-drop spotlight positioning
 *   3. Cloud Lessons — publish/update/delete lessons on the server
 *
 * The Lesson Builder is the core feature: it renders a preview of the code
 * as the cinematic engine would see it, and lets the admin drag spotlight
 * rectangles and explanation panels into position. All coordinates are
 * baked into the .lesson package.
 */

import * as auth from '../auth/authService';
import type { NexiaUser } from '../auth/authService';

// ── Types for Lesson Layout Data ──

export interface SpotlightRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface PanelLayout {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface BlockLayout {
    spotlight: SpotlightRect;
    panel: PanelLayout;
}

export interface TokenLayout {
    spotlight: SpotlightRect;
    panel: PanelLayout;
}

export interface ConnectionLayout {
    srcSpotlight: SpotlightRect;
    dstSpotlight: SpotlightRect;
}

export interface LessonLayoutData {
    /** Layout per block ID */
    blocks: Record<string, BlockLayout>;
    /** Layout per block ID → token index */
    tokens: Record<string, TokenLayout[]>;
    /** Layout per connection */
    connections: Record<string, ConnectionLayout[]>;
    /** Canvas dimensions the layouts were authored at */
    canvasWidth: number;
    canvasHeight: number;
}

// ── Builder State ──

interface BuilderState {
    lesson: any;                    // The full lesson data being edited
    lessonId: string | null;        // ID of the lesson being edited (for save-to-disk)
    layout: LessonLayoutData;       // Layout data being built
    selectedBlockId: string | null;  // Currently selected block
    selectedTokenIdx: number;        // -1 = no token selected
    activeHandle: string | null;     // Which handle is being dragged
    dragStart: { x: number; y: number } | null;
    dragOrigRect: SpotlightRect | PanelLayout | null;
    previewScrollTop: number;
    lineHeight: number;
    gutterWidth: number;
    codeLeftPad: number;
    zoom: number;                    // Preview zoom level
}

let _builder: BuilderState | null = null;
let _panel: HTMLElement | null = null;
let _subTab: 'users' | 'builder' | 'cloud' | 'releases' = 'builder';

// ── Syntax Highlighting (simplified, matching cinematic engine) ──

const CPP_KEYWORDS = new Set(['if','else','for','while','do','switch','case','break','continue','return','class','struct','public','private','protected','virtual','override','void','const','static','new','delete','nullptr','true','false','this','namespace','using','template','typename','typedef','enum','sizeof','auto','register','volatile','extern','inline','throw','try','catch','operator','friend','explicit','mutable','noexcept','constexpr','decltype']);
const CPP_TYPES = new Set(['int','float','double','char','bool','long','short','unsigned','signed','DWORD','BYTE','WORD','HRESULT','BOOL','HANDLE','HWND','LPCSTR','LPSTR','LPCWSTR','LPWSTR','UINT','ULONG','LONG','SIZE_T','VOID','IDirect3D9','IDirect3DDevice9','D3DPRESENT_PARAMETERS','D3DFORMAT','D3DDEVTYPE','XINPUT_STATE','XINPUT_GAMEPAD','D3DCOLOR','D3DVECTOR','D3DMATRIX','D3DVIEWPORT9','D3DXMATRIX','D3DXVECTOR3','D3DXVECTOR4','D3DLOCKED_RECT','LPDIRECT3DTEXTURE9','LPDIRECT3DVERTEXBUFFER9','LPDIRECT3DINDEXBUFFER9']);

function escHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function hlLine(text: string): string {
    let r = '', i = 0;
    while (i < text.length) {
        if (text.substr(i, 2) === '//') { r += `<span class="lb-comment">${escHtml(text.substr(i))}</span>`; break; }
        if (text[i] === '#') { let end = text.indexOf(' ', i); if (end < 0) end = text.length; r += `<span class="lb-directive">${escHtml(text.substring(i, end))}</span>`; i = end; continue; }
        if (text[i] === '"') { let e = text.indexOf('"', i + 1); if (e < 0) e = text.length - 1; r += `<span class="lb-string">${escHtml(text.substring(i, e + 1))}</span>`; i = e + 1; continue; }
        if (/[0-9]/.test(text[i]) && (i === 0 || !/\w/.test(text[i - 1]))) { let n = ''; while (i < text.length && /[0-9a-fA-Fx.]/.test(text[i])) { n += text[i]; i++; } r += `<span class="lb-number">${n}</span>`; continue; }
        if (/[a-zA-Z_]/.test(text[i])) {
            let w = ''; while (i < text.length && /[\w]/.test(text[i])) { w += text[i]; i++; }
            if (CPP_KEYWORDS.has(w)) r += `<span class="lb-keyword">${w}</span>`;
            else if (CPP_TYPES.has(w)) r += `<span class="lb-type">${w}</span>`;
            else if (i < text.length && text[i] === '(') r += `<span class="lb-func">${w}</span>`;
            else r += w;
            continue;
        }
        r += escHtml(text[i]); i++;
    }
    return r;
}

// ══════════════════════════════════════
//  ADMIN PANEL RENDER
// ══════════════════════════════════════

export function render(container: HTMLElement) {
    _panel = container;
    container.innerHTML = '';

    if (!auth.isAdmin()) {
        container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-dim)">Admin access required.</div>';
        return;
    }

    // Sub-tab bar
    const tabBar = document.createElement('div');
    tabBar.className = 'admin-tab-bar';
    tabBar.innerHTML = `
        <div class="admin-tab ${_subTab === 'builder' ? 'active' : ''}" data-tab="builder">Lesson Builder</div>
        <div class="admin-tab ${_subTab === 'users' ? 'active' : ''}" data-tab="users">Users</div>
        <div class="admin-tab ${_subTab === 'cloud' ? 'active' : ''}" data-tab="cloud">Cloud Lessons</div>
        <div class="admin-tab ${_subTab === 'releases' ? 'active' : ''}" data-tab="releases">Releases</div>`;
    tabBar.addEventListener('click', (e) => {
        const tab = (e.target as HTMLElement).dataset?.tab;
        if (tab) { _subTab = tab as any; render(container); }
    });
    container.appendChild(tabBar);

    const content = document.createElement('div');
    content.className = 'admin-content';
    container.appendChild(content);

    if (_subTab === 'users') renderUsersTab(content);
    else if (_subTab === 'builder') renderBuilderTab(content);
    else if (_subTab === 'cloud') renderCloudTab(content);
    else if (_subTab === 'releases') renderReleasesTab(content);
}

// ══════════════════════════════════════
//  RELEASES TAB — publish an update to every client
// ══════════════════════════════════════

async function renderReleasesTab(container: HTMLElement) {
    container.innerHTML = '<div style="padding:16px;color:var(--text-dim)">Loading current release…</div>';

    const cur = await auth.getLatestRelease();
    const live = cur.success ? cur.update : null;

    container.innerHTML = '';
    const header = document.createElement('div');
    header.className = 'admin-section-header';
    header.innerHTML = '<span>Software Releases</span>';
    container.appendChild(header);

    const status = document.createElement('div');
    status.style.cssText = 'margin:0 16px 14px;padding:12px 14px;border-radius:var(--radius-md);border:1px solid var(--border);background:var(--bg-input)';
    status.innerHTML = live
        ? `<div style="font-size:12px;color:var(--text-dim);margin-bottom:4px">Currently published — every client on an older version is prompted to install this.</div>
           <div style="font-size:14px;font-weight:600;color:var(--green)">v${escHtml(live.version)} — ${escHtml(live.title || '')}</div>
           <div style="font-size:11px;color:var(--text-muted);margin-top:4px;font-family:monospace">${escHtml(live.downloadUrl || '')}</div>
           <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${(live.notes || []).length} note(s) · ${live.size ? (live.size / 1048576).toFixed(1) + ' MB' : 'size unknown'}${live.mandatory ? ' · REQUIRED' : ''} · published by ${escHtml(live.publishedBy || '?')}</div>
           <button class="admin-btn admin-btn-sm admin-btn-delete" id="rel-pull" style="margin-top:10px">Pull Release</button>`
        : '<div style="font-size:12px;color:var(--text-dim)">No release is currently published. Clients are not being prompted.</div>';
    container.appendChild(status);

    const form = document.createElement('div');
    form.style.cssText = 'padding:0 16px 20px;display:flex;flex-direction:column;gap:10px';
    form.innerHTML = `
        <div class="lb-section-title">PUBLISH A RELEASE</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div><label class="lb-field-label">Version</label><input class="lb-field-input" id="rel-version" placeholder="2.2.0" value="${escHtml(live?.version || '')}"></div>
            <div><label class="lb-field-label">Download size (bytes)</label><input class="lb-field-input" id="rel-size" placeholder="157724618" value="${live?.size || ''}"></div>
        </div>
        <div><label class="lb-field-label">Headline</label><input class="lb-field-input" id="rel-title" placeholder="Design overhaul, cloud lessons & security updates" value="${escHtml(live?.title || '')}"></div>
        <div><label class="lb-field-label">Download URL (https)</label><input class="lb-field-input" id="rel-url" spellcheck="false" placeholder="https://auth.logansreplicas.com/downloads/NexiaSetup-2.2.0.exe" value="${escHtml(live?.downloadUrl || '')}"></div>
        <div><label class="lb-field-label">SHA-256 (optional but recommended — clients reject a mismatch)</label><input class="lb-field-input" id="rel-sha" spellcheck="false" placeholder="64-char hex digest" value="${escHtml(live?.sha256 || '')}"></div>
        <div><label class="lb-field-label">What's new — one bullet per line</label>
            <textarea class="lb-field-input lb-field-textarea" id="rel-notes" rows="7" spellcheck="false" placeholder="Three new IDE skins: Blade, Devkit, Phosphor&#10;Curriculum lesson viewer with progress tracking&#10;Cloud lesson downloads and update notifications&#10;Security: hardened login lockout">${escHtml((live?.notes || []).join('\n'))}</textarea></div>
        <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-dim)">
            <input type="checkbox" id="rel-mandatory" ${live?.mandatory ? 'checked' : ''}> Required update (users can't dismiss it)
        </label>
        <div id="rel-msg" style="font-size:12px;display:none"></div>
        <div><button class="admin-btn admin-btn-primary" id="rel-publish">☁ Publish &amp; Notify Users</button></div>`;
    container.appendChild(form);

    function msg(text: string, ok: boolean) {
        const m = form.querySelector('#rel-msg') as HTMLElement;
        m.style.display = 'block';
        m.textContent = text;
        m.style.color = ok ? 'var(--green)' : '#f44747';
    }

    status.querySelector('#rel-pull')?.addEventListener('click', async () => {
        if (!confirm('Pull the published release? Clients will stop being prompted.')) return;
        const r = await auth.clearRelease();
        if (r.success) renderReleasesTab(container);
        else alert('Failed: ' + (r.error || 'unknown'));
    });

    form.querySelector('#rel-publish')!.addEventListener('click', async () => {
        const btn = form.querySelector('#rel-publish') as HTMLButtonElement;
        const manifest = {
            version: (form.querySelector('#rel-version') as HTMLInputElement).value.trim(),
            title: (form.querySelector('#rel-title') as HTMLInputElement).value.trim(),
            downloadUrl: (form.querySelector('#rel-url') as HTMLInputElement).value.trim(),
            sha256: (form.querySelector('#rel-sha') as HTMLInputElement).value.trim() || null,
            size: parseInt((form.querySelector('#rel-size') as HTMLInputElement).value, 10) || 0,
            mandatory: (form.querySelector('#rel-mandatory') as HTMLInputElement).checked,
            notes: (form.querySelector('#rel-notes') as HTMLTextAreaElement).value
                .split('\n').map(l => l.trim()).filter(Boolean),
        };
        btn.disabled = true; btn.textContent = 'Publishing…';
        const r = await auth.publishRelease(manifest);
        btn.disabled = false; btn.textContent = '☁ Publish & Notify Users';
        if (r.success) {
            msg(`Published v${manifest.version}. Every client older than this will be prompted on next launch.`, true);
            renderReleasesTab(container);
        } else {
            msg('Publish failed: ' + (r.error || 'unknown error'), false);
        }
    });
}

// ══════════════════════════════════════
//  USERS TAB
// ══════════════════════════════════════

async function renderUsersTab(container: HTMLElement) {
    container.innerHTML = '<div style="padding:16px;color:var(--text-dim)">Loading users...</div>';

    const result = await auth.getUsers();
    if (!result.success) {
        container.innerHTML = `<div style="padding:16px;color:#f44747">${escHtml(result.error || 'Failed to load users')}</div>`;
        return;
    }

    const users = result.users || [];
    container.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'admin-section-header';
    header.innerHTML = `<span>Registered Users (${users.length})</span>`;
    container.appendChild(header);

    const list = document.createElement('div');
    list.className = 'admin-user-list';

    for (const user of users) {
        const item = document.createElement('div');
        item.className = 'admin-user-item';
        const isCurrentUser = auth.getUser()?.id === user.id;
        item.innerHTML = `
            <div class="admin-user-avatar" style="background:${user.role === 'admin' ? '#e5c07b' : '#4ec9b0'}">${(user.username || '?').substring(0, 2).toUpperCase()}</div>
            <div class="admin-user-info">
                <div class="admin-user-name">${escHtml(user.username)} ${isCurrentUser ? '<span style="color:var(--text-muted);font-size:10px">(you)</span>' : ''}</div>
                <div class="admin-user-email">${escHtml(user.email)}</div>
            </div>
            <div class="admin-user-role" style="color:${user.role === 'admin' ? '#e5c07b' : 'var(--text-dim)'}">${user.role.toUpperCase()}</div>
            <div class="admin-user-actions">
                ${!isCurrentUser && user.role !== 'admin' ? `<button class="admin-btn admin-btn-sm admin-btn-promote" data-uid="${user.id}" data-action="promote">↑ Promote</button>` : ''}
                ${!isCurrentUser && user.role === 'admin' ? `<button class="admin-btn admin-btn-sm admin-btn-demote" data-uid="${user.id}" data-action="demote">↓ Demote</button>` : ''}
                ${!isCurrentUser ? `<button class="admin-btn admin-btn-sm admin-btn-delete" data-uid="${user.id}" data-action="delete">✕</button>` : ''}
            </div>`;
        list.appendChild(item);
    }

    list.addEventListener('click', async (e) => {
        const btn = (e.target as HTMLElement).closest('[data-action]') as HTMLElement;
        if (!btn) return;
        const uid = btn.dataset.uid!;
        const action = btn.dataset.action!;

        if (action === 'promote') {
            if (confirm('Promote this user to admin?')) {
                await auth.promoteUser(uid, 'admin');
                renderUsersTab(container);
            }
        } else if (action === 'demote') {
            if (confirm('Remove admin privileges from this user?')) {
                await auth.demoteUser(uid);
                renderUsersTab(container);
            }
        } else if (action === 'delete') {
            if (confirm('Delete this user? This cannot be undone.')) {
                await auth.deleteUser(uid);
                renderUsersTab(container);
            }
        }
    });

    container.appendChild(list);
}

// ══════════════════════════════════════
//  CLOUD LESSONS TAB
// ══════════════════════════════════════

async function renderCloudTab(container: HTMLElement) {
    container.innerHTML = '<div style="padding:16px;color:var(--text-dim)">Loading cloud lessons...</div>';

    const result = await auth.getCloudLessons();
    if (!result.success) {
        container.innerHTML = `<div style="padding:16px;color:#f44747">${escHtml(result.error || 'Failed to load lessons')}</div>`;
        return;
    }

    const lessons = result.lessons || [];
    container.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'admin-section-header';
    header.innerHTML = `<span>Cloud Lessons (${lessons.length})</span>
        <button class="admin-btn admin-btn-primary" id="admin-publish-btn">＋ Publish New</button>`;
    container.appendChild(header);

    header.querySelector('#admin-publish-btn')!.addEventListener('click', () => {
        // Switch to builder tab to create a new lesson
        _subTab = 'builder';
        if (_panel) render(_panel);
    });

    if (lessons.length === 0) {
        container.innerHTML += '<div style="padding:20px;text-align:center;color:var(--text-dim)">No lessons published yet. Use the Lesson Builder to create and publish lessons.</div>';
        return;
    }

    const list = document.createElement('div');
    list.className = 'admin-lesson-list';

    for (const lesson of lessons) {
        const item = document.createElement('div');
        item.className = 'admin-lesson-item';
        item.innerHTML = `
            <div class="admin-lesson-icon">🎬</div>
            <div class="admin-lesson-info">
                <div class="admin-lesson-title">${escHtml(lesson.title)}</div>
                <div class="admin-lesson-meta">${escHtml(lesson.difficulty)} · ${escHtml(lesson.author)} · v${escHtml(lesson.version)}</div>
                <div class="admin-lesson-desc">${escHtml(lesson.description)}</div>
            </div>
            <div class="admin-lesson-actions">
                <button class="admin-btn admin-btn-sm" data-lid="${lesson.id}" data-action="edit">Edit</button>
                <button class="admin-btn admin-btn-sm admin-btn-delete" data-lid="${lesson.id}" data-action="delete">Delete</button>
            </div>`;
        list.appendChild(item);
    }

    list.addEventListener('click', async (e) => {
        const btn = (e.target as HTMLElement).closest('[data-action]') as HTMLElement;
        if (!btn) return;
        const lid = btn.dataset.lid!;
        const action = btn.dataset.action!;

        if (action === 'edit') {
            // Load lesson into builder
            const full = await auth.getCloudLesson(lid);
            if (full.success && full.lesson) {
                _subTab = 'builder';
                if (_panel) render(_panel);
                // After render, load the lesson into the builder
                setTimeout(() => loadLessonIntoBuilder(full.lesson), 100);
            }
        } else if (action === 'delete') {
            if (confirm('Delete this lesson from the cloud? This cannot be undone.')) {
                await auth.deleteCloudLesson(lid);
                renderCloudTab(container);
            }
        }
    });

    container.appendChild(list);
}

// ══════════════════════════════════════
//  LESSON BUILDER TAB
// ══════════════════════════════════════

function renderBuilderTab(container: HTMLElement) {
    container.innerHTML = '';

    // Toolbar
    const toolbar = document.createElement('div');
    toolbar.className = 'lb-toolbar';
    toolbar.innerHTML = `
        <button class="admin-btn admin-btn-primary" id="lb-new">＋ New Lesson</button>
        <button class="admin-btn" id="lb-import">📥 Import .lesson</button>
        <button class="admin-btn" id="lb-run" disabled title="Test the lesson in the cinematic engine">▶ Run Lesson</button>
        <div style="flex:1"></div>
        <button class="admin-btn admin-btn-primary" id="lb-save" disabled title="Save changes to disk">💾 Save</button>
        <button class="admin-btn" id="lb-export" disabled>📤 Export .lesson</button>
        <button class="admin-btn admin-btn-primary" id="lb-publish" disabled>☁ Publish</button>`;
    container.appendChild(toolbar);

    // Builder workspace
    const workspace = document.createElement('div');
    workspace.className = 'lb-workspace';
    workspace.id = 'lb-workspace';
    container.appendChild(workspace);

    if (_builder && _builder.lesson) {
        renderBuilderWorkspace(workspace);
    } else {
        workspace.innerHTML = `
            <div class="lb-empty">
                <div class="lb-empty-icon">🎬</div>
                <div class="lb-empty-title">Lesson Builder</div>
                <div class="lb-empty-desc">Create cinematic lessons with precise spotlight and panel positioning.<br>Start by creating a new lesson, importing an existing .lesson, or loading the built-in InitD3D lesson.</div>
            </div>`;
    }

    // Wire toolbar buttons
    toolbar.querySelector('#lb-new')!.addEventListener('click', () => createNewLesson(workspace));
    toolbar.querySelector('#lb-import')!.addEventListener('click', () => importLesson(workspace));
    toolbar.querySelector('#lb-save')!.addEventListener('click', () => saveLessonToDisk());
    toolbar.querySelector('#lb-export')!.addEventListener('click', () => exportLesson());
    toolbar.querySelector('#lb-publish')!.addEventListener('click', () => publishLesson());
    toolbar.querySelector('#lb-run')!.addEventListener('click', () => runLessonPreview());
}

function createNewLesson(workspace: HTMLElement) {
    const lesson: any = {
        meta: {
            id: 'new_lesson_' + Date.now(),
            title: 'New Lesson',
            author: auth.getUser()?.username || 'Unknown',
            version: '1.0.0',
            language: 'cpp',
            difficulty: 'beginner',
            tags: [],
            description: '',
        },
        oldCode: [],
        blocks: [],
        explanations: {},
        connections: {},
        tokens: {},
        visControls: {},
        animatedVis: [],
        layout: {
            blocks: {},
            tokens: {},
            connections: {},
            canvasWidth: 900,
            canvasHeight: 600,
        },
    };

    initBuilder(lesson);
    renderBuilderWorkspace(workspace);
    enableToolbarButtons();
}

async function importLesson(workspace: HTMLElement) {
    try {
        const { ipcRenderer } = require('electron');
        const result = await ipcRenderer.invoke('lesson:import');
        if (result.success && result.lessonId) {
            const lessonData = await ipcRenderer.invoke('lesson:read', result.lessonId);
            if (lessonData) {
                initBuilder(lessonData);
                renderBuilderWorkspace(workspace);
                enableToolbarButtons();
            }
        }
    } catch (err: any) {
        console.error('Import failed:', err);
    }
}

function loadLessonIntoBuilder(lessonData: any) {
    const workspace = document.getElementById('lb-workspace');
    if (!workspace) return;
    initBuilder(lessonData);
    renderBuilderWorkspace(workspace);
    enableToolbarButtons();
}

async function exportLesson() {
    if (!_builder?.lesson) return;
    try {
        const { ipcRenderer } = require('electron');
        const exportData = buildExportData();
        const result = await ipcRenderer.invoke('lesson:export', exportData);
        if (result.success) {
            console.log('Exported to:', result.path);
        }
    } catch (err: any) {
        console.error('Export failed:', err);
    }
}

async function saveLessonToDisk() {
    if (!_builder?.lesson) return;
    const lessonId = _builder.lessonId || _builder.lesson.meta?.id;
    if (!lessonId) {
        alert('No lesson ID — use Export to save as a new file.');
        return;
    }
    try {
        const { ipcRenderer } = require('electron');
        const exportData = buildExportData();
        const result = await ipcRenderer.invoke('lesson:save', lessonId, exportData);
        if (result.success) {
            const saveBtn = document.getElementById('lb-save');
            if (saveBtn) {
                saveBtn.textContent = '✓ Saved';
                setTimeout(() => { saveBtn.textContent = '💾 Save'; }, 2000);
            }
        } else {
            alert('Save failed: ' + (result.error || 'Unknown error'));
        }
    } catch (err: any) {
        alert('Save failed: ' + err.message);
    }
}

async function publishLesson() {
    if (!_builder?.lesson) return;
    const exportData = buildExportData();
    const existing = _builder.lesson.meta?.cloudId;

    let result;
    if (existing) {
        result = await auth.updateCloudLesson(existing, exportData);
    } else {
        result = await auth.publishLesson(exportData);
    }

    if (result.success) {
        if (result.lesson) {
            _builder.lesson.meta.cloudId = result.lesson.id;
        }
        alert('Lesson published successfully!');
    } else {
        alert('Publish failed: ' + (result.error || 'Unknown error'));
    }
}

function buildExportData(): any {
    if (!_builder) return {};
    const lesson = _builder.lesson;
    const blocks = (lesson.blocks || []).map((b: any) => ({
        id: b.id,
        section: b.sec || b.section || null,
        lines: (b.lines || []).map((l: any) => ({
            text: l.t || l.text || '',
            confidence: l.c ?? l.confidence ?? 1.0,
            type: l.tp || l.type || null,
            blockEnd: l.be || l.blockEnd || false,
        })),
    }));

    // Build v2 overlay
    const explanations: any = {};
    if (lesson.explanations) {
        for (const [id, ex] of Object.entries(lesson.explanations as Record<string, any>)) {
            explanations[id] = {
                label: ex.label || '',
                type: ex.tp || ex.type || 'concept',
                description: ex.desc || ex.description || '',
                narration: ex.narration || null,
            };
        }
    }

    const connections: any = {};
    if (lesson.connections) {
        for (const [id, conns] of Object.entries(lesson.connections as Record<string, any[]>)) {
            connections[id] = conns.map(c => ({
                src: c.src, dst: c.dst, label: c.label,
                description: c.desc || c.description || '',
            }));
        }
    }

    const tokens: any = {};
    if (lesson.tokens) {
        for (const [id, tlines] of Object.entries(lesson.tokens as Record<string, any[]>)) {
            tokens[id] = tlines.map(tl => ({
                line: tl.line,
                tokens: (tl.tokens || []).map((t: any) => ({
                    text: t.text,
                    description: t.desc || t.description || '',
                })),
            }));
        }
    }

    return {
        format: 'nexia-lesson-v2',
        meta: lesson.meta || {},
        syntax: lesson.syntax || null,
        erasePhase: lesson.oldCode?.length ? { lines: lesson.oldCode, timing: { lineAppearDelay: 80, swipePause: 500, removePause: 120, settlePause: 400 } } : null,
        blocks,
        overlay: {
            explanations,
            connections,
            tokens,
            visualizers: lesson.visualizers || {},
            tokenVisualizers: lesson.tokenVisualizers || {},
        },
        layout: _builder.layout?.blocks && Object.keys(_builder.layout.blocks).length > 0 ? _builder.layout : null,
        timing: lesson.timing || null,
        audio: lesson.audio || null,
        style: lesson.style || null,
    };
}

function enableToolbarButtons() {
    const exp = document.getElementById('lb-export') as HTMLButtonElement;
    const pub = document.getElementById('lb-publish') as HTMLButtonElement;
    const run = document.getElementById('lb-run') as HTMLButtonElement;
    const save = document.getElementById('lb-save') as HTMLButtonElement;
    if (exp) exp.disabled = false;
    if (pub) pub.disabled = false;
    if (run) run.disabled = false;
    if (save) save.disabled = false;
}

let _previewRunning = false;

function runLessonPreview() {
    if (!_builder || !_builder.lesson) return;
    if (_previewRunning) return;

    const data = buildExportData();
    const previewArea = document.querySelector('.lb-preview-area') as HTMLElement;
    if (!previewArea) return;

    _previewRunning = true;

    // Save the current preview content so we can restore it
    const savedContent = previewArea.innerHTML;

    // Clear and mount cinematic engine directly in the preview area
    previewArea.innerHTML = '';
    previewArea.style.display = 'flex';
    previewArea.style.flexDirection = 'column';

    // Add a stop bar at the top
    const stopBar = document.createElement('div');
    stopBar.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 12px;background:rgba(229,192,123,0.08);border-bottom:1px solid rgba(229,192,123,0.2);flex-shrink:0;';
    stopBar.innerHTML = `<span style="font-size:10px;color:#e5c07b;font-weight:600">▶ LESSON PREVIEW</span><div style="flex:1"></div><button id="lb-stop-preview" style="padding:4px 12px;background:rgba(244,71,71,0.1);border:1px solid rgba(244,71,71,0.3);border-radius:4px;color:#f44747;font-size:10px;font-family:inherit;cursor:pointer">■ Stop Preview</button>`;
    previewArea.appendChild(stopBar);

    // Engine container
    const engineContainer = document.createElement('div');
    engineContainer.style.cssText = 'flex:1;display:flex;flex-direction:column;overflow:hidden;';
    previewArea.appendChild(engineContainer);

    // Load and mount the cinematic engine
    try {
        const cinematicEngine = require('../learning/cinematicEngine');
        cinematicEngine.loadLesson(data);
        cinematicEngine.mount(engineContainer);
    } catch (err: any) {
        engineContainer.innerHTML = `<div style="padding:40px;text-align:center;color:#f44747;font-size:12px">Failed to start preview: ${err.message}</div>`;
    }

    // Wire stop button
    document.getElementById('lb-stop-preview')!.addEventListener('click', () => {
        try {
            const cinematicEngine = require('../learning/cinematicEngine');
            cinematicEngine.unmount();
        } catch {}
        previewArea.innerHTML = savedContent;
        previewArea.style.display = '';
        previewArea.style.flexDirection = '';
        _previewRunning = false;
        // Re-render the preview if possible
        const workspace = document.getElementById('lb-workspace');
        if (workspace && _builder) renderBuilderWorkspace(workspace);
    });
}

// ══════════════════════════════════════
//  BUILDER INIT & STATE
// ══════════════════════════════════════

function initBuilder(lesson: any) {
    // ── Normalize v2 format to builder's internal format ──
    if (lesson.format === 'nexia-lesson-v2' || lesson.overlay) {
        // Convert v2 blocks to v1 field names the builder uses internally
        if (lesson.blocks) {
            lesson.blocks = lesson.blocks.map((b: any) => ({
                id: b.id,
                sec: b.section || b.sec || null,
                lines: (b.lines || []).map((l: any) => ({
                    t: l.text || l.t || '',
                    c: l.confidence ?? l.c ?? 1.0,
                    tp: l.type || l.tp || null,
                    be: l.blockEnd || l.be || false,
                })),
            }));
        }
        // Convert v2 overlay to flat lesson fields
        if (lesson.overlay) {
            // Explanations: v2 uses {type, description} → v1 uses {tp, desc}
            if (lesson.overlay.explanations && !lesson.explanations) {
                lesson.explanations = {};
                for (const [id, ex] of Object.entries(lesson.overlay.explanations as Record<string, any>)) {
                    lesson.explanations[id] = {
                        label: ex.label || '',
                        tp: ex.type || ex.tp || 'concept',
                        desc: ex.description || ex.desc || '',
                    };
                }
            }
            // Connections: v2 uses {description} → v1 uses {desc}
            if (lesson.overlay.connections && !lesson.connections) {
                lesson.connections = {};
                for (const [id, conns] of Object.entries(lesson.overlay.connections as Record<string, any[]>)) {
                    lesson.connections[id] = conns.map(c => ({
                        src: c.src, dst: c.dst, label: c.label,
                        desc: c.description || c.desc || '',
                    }));
                }
            }
            // Tokens: v2 uses {description} → v1 uses {desc}
            if (lesson.overlay.tokens && !lesson.tokens) {
                lesson.tokens = {};
                for (const [id, tlines] of Object.entries(lesson.overlay.tokens as Record<string, any[]>)) {
                    lesson.tokens[id] = tlines.map(tl => ({
                        line: tl.line,
                        tokens: (tl.tokens || []).map((t: any) => ({
                            text: t.text,
                            desc: t.description || t.desc || '',
                        })),
                    }));
                }
            }
            // Visualizer defs
            if (lesson.overlay.visualizers) lesson.visualizers = lesson.overlay.visualizers;
            if (lesson.overlay.tokenVisualizers) lesson.tokenVisualizers = lesson.overlay.tokenVisualizers;
        }
        // Erase phase
        if (lesson.erasePhase && !lesson.oldCode) {
            lesson.oldCode = lesson.erasePhase.lines || [];
        }
    }

    // Extract or create layout data
    const layout: LessonLayoutData = lesson.layout || {
        blocks: {},
        tokens: {},
        connections: {},
        canvasWidth: 900,
        canvasHeight: 600,
    };

    // Auto-generate default layouts for blocks that don't have one
    const blocks = lesson.blocks || [];
    let yOffset = 10;
    const lineH = 20;

    for (const block of blocks) {
        const blockLines = block.lines?.length || 1;
        if (!layout.blocks[block.id]) {
            const blockH = blockLines * lineH;
            layout.blocks[block.id] = {
                spotlight: { x: 50, y: yOffset, width: 400, height: blockH + 12 },
                panel: { x: 520, y: yOffset, width: 340, height: 260 },
            };
        }
        yOffset += blockLines * lineH + 8;
    }

    _builder = {
        lesson,
        lessonId: lesson.meta?.id || null,
        layout,
        selectedBlockId: blocks.length > 0 ? blocks[0].id : null,
        selectedTokenIdx: -1,
        activeHandle: null,
        dragStart: null,
        dragOrigRect: null,
        previewScrollTop: 0,
        lineHeight: lineH,
        gutterWidth: 48,
        codeLeftPad: 8,
        zoom: 1,
    };
}

// ══════════════════════════════════════
//  BUILDER WORKSPACE RENDER
// ══════════════════════════════════════

function renderBuilderWorkspace(container: HTMLElement) {
    if (!_builder) return;
    container.innerHTML = '';

    // Left sidebar: block list + metadata editor
    const sidebar = document.createElement('div');
    sidebar.className = 'lb-sidebar';
    container.appendChild(sidebar);

    // Resize handle between sidebar and preview
    const sidebarResize = document.createElement('div');
    sidebarResize.className = 'lb-sidebar-resize';
    container.appendChild(sidebarResize);
    makeResizeHandle(sidebarResize, sidebar, 'left');

    // Preview canvas area
    const previewArea = document.createElement('div');
    previewArea.className = 'lb-preview-area';
    container.appendChild(previewArea);

    // Resize handle between preview and props
    const propsResize = document.createElement('div');
    propsResize.className = 'lb-props-resize';
    container.appendChild(propsResize);

    // Properties panel (right side)
    const propsPanel = document.createElement('div');
    propsPanel.className = 'lb-props-panel';
    container.appendChild(propsPanel);
    makeResizeHandle(propsResize, propsPanel, 'right');

    renderSidebar(sidebar);
    renderPreview(previewArea);
    renderProperties(propsPanel);
}

// ── Sidebar: Block List + Meta ──

function renderSidebar(container: HTMLElement) {
    if (!_builder) return;
    const lesson = _builder.lesson;

    // Meta section
    const metaSection = document.createElement('div');
    metaSection.className = 'lb-meta-section';
    metaSection.innerHTML = `
        <div class="lb-section-title">LESSON META</div>
        <label class="lb-field-label">Title</label>
        <input class="lb-field-input" id="lb-meta-title" value="${escHtml(lesson.meta?.title || '')}" spellcheck="false">
        <label class="lb-field-label">Author</label>
        <input class="lb-field-input" id="lb-meta-author" value="${escHtml(lesson.meta?.author || '')}" spellcheck="false">
        <label class="lb-field-label">Difficulty</label>
        <select class="lb-field-input" id="lb-meta-diff">
            <option value="beginner" ${lesson.meta?.difficulty === 'beginner' ? 'selected' : ''}>Beginner</option>
            <option value="intermediate" ${lesson.meta?.difficulty === 'intermediate' ? 'selected' : ''}>Intermediate</option>
            <option value="advanced" ${lesson.meta?.difficulty === 'advanced' ? 'selected' : ''}>Advanced</option>
        </select>
        <label class="lb-field-label">Description</label>
        <textarea class="lb-field-input lb-field-textarea" id="lb-meta-desc" rows="2" spellcheck="false">${escHtml(lesson.meta?.description || '')}</textarea>`;
    container.appendChild(metaSection);

    // Wire meta inputs
    const metaInputs = metaSection.querySelectorAll('input, select, textarea');
    metaInputs.forEach(inp => {
        inp.addEventListener('change', () => {
            if (!_builder) return;
            const m = _builder.lesson.meta = _builder.lesson.meta || {};
            m.title = (document.getElementById('lb-meta-title') as HTMLInputElement).value;
            m.author = (document.getElementById('lb-meta-author') as HTMLInputElement).value;
            m.difficulty = (document.getElementById('lb-meta-diff') as HTMLSelectElement).value;
            m.description = (document.getElementById('lb-meta-desc') as HTMLTextAreaElement).value;
        });
    });

    // Block list
    const blockSection = document.createElement('div');
    blockSection.className = 'lb-block-section';
    blockSection.innerHTML = '<div class="lb-section-title">BLOCKS <button class="lb-add-block-btn" id="lb-add-block">＋</button></div>';

    const blockList = document.createElement('div');
    blockList.className = 'lb-block-list';

    const blocks = _builder.lesson.blocks || [];
    for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        const item = document.createElement('div');
        item.className = 'lb-block-item' + (b.id === _builder.selectedBlockId ? ' active' : '');
        item.dataset.blockId = b.id;

        const lineCount = b.lines?.length || 0;
        const hasExpl = !!(_builder.lesson.explanations?.[b.id]);
        const hasTokens = !!(_builder.lesson.tokens?.[b.id]);
        const hasLayout = !!(_builder.layout.blocks[b.id]);

        item.innerHTML = `
            <div class="lb-block-num">${i + 1}</div>
            <div class="lb-block-info">
                <div class="lb-block-id">${escHtml(b.id)}</div>
                <div class="lb-block-stats">${lineCount} lines${b.sec ? ' · §' + escHtml(b.sec) : ''}${hasExpl ? ' · 📝' : ''}${hasTokens ? ' · 🔍' : ''}</div>
            </div>
            <div class="lb-block-layout-dot ${hasLayout ? 'has-layout' : ''}" title="${hasLayout ? 'Layout set' : 'No layout yet'}">●</div>`;

        item.addEventListener('click', () => {
            if (!_builder) return;
            _builder.selectedBlockId = b.id;
            _builder.selectedTokenIdx = -1;
            const ws = document.getElementById('lb-workspace');
            if (ws) renderBuilderWorkspace(ws);
        });

        blockList.appendChild(item);
    }

    blockSection.appendChild(blockList);
    container.appendChild(blockSection);

    // Add block button
    blockSection.querySelector('#lb-add-block')!.addEventListener('click', () => {
        if (!_builder) return;
        const newId = 'block_' + Date.now();
        _builder.lesson.blocks = _builder.lesson.blocks || [];
        _builder.lesson.blocks.push({ id: newId, sec: '', lines: [{ t: '' }] });
        _builder.selectedBlockId = newId;
        const ws = document.getElementById('lb-workspace');
        if (ws) renderBuilderWorkspace(ws);
    });
}

// ── Preview Canvas ──

function renderPreview(container: HTMLElement) {
    if (!_builder) return;

    const previewHeader = document.createElement('div');
    previewHeader.className = 'lb-preview-header';
    previewHeader.innerHTML = `
        <span class="lb-preview-title">PREVIEW</span>
        <span class="lb-zoom-controls">
            <button class="lb-zoom-btn" id="lb-zoom-out">−</button>
            <span id="lb-zoom-label">${Math.round(_builder.zoom * 100)}%</span>
            <button class="lb-zoom-btn" id="lb-zoom-in">+</button>
        </span>`;
    container.appendChild(previewHeader);

    const previewWrapper = document.createElement('div');
    previewWrapper.className = 'lb-preview-wrapper';
    previewWrapper.id = 'lb-preview-wrapper';
    container.appendChild(previewWrapper);

    const preview = document.createElement('div');
    preview.className = 'lb-preview';
    preview.id = 'lb-preview';
    preview.style.transform = `scale(${_builder.zoom})`;
    preview.style.transformOrigin = 'top left';
    previewWrapper.appendChild(preview);

    // Render all code lines
    const gutter = document.createElement('div');
    gutter.className = 'lb-gutter';
    preview.appendChild(gutter);

    const codeArea = document.createElement('div');
    codeArea.className = 'lb-code-area';
    preview.appendChild(codeArea);

    let lineNum = 1;
    const blocks = _builder.lesson.blocks || [];
    for (const block of blocks) {
        if (block.sec) {
            const secDiv = document.createElement('div');
            secDiv.className = 'lb-section-divider';
            secDiv.innerHTML = `<span>▸ ${escHtml(block.sec)}</span>`;
            codeArea.appendChild(secDiv);

            const gutSec = document.createElement('div');
            gutSec.className = 'lb-gut-line lb-gut-sec';
            gutSec.textContent = ' ';
            gutter.appendChild(gutSec);
        }

        for (const line of (block.lines || [])) {
            const gutLine = document.createElement('div');
            gutLine.className = 'lb-gut-line';
            gutLine.textContent = String(lineNum);
            gutter.appendChild(gutLine);

            const codeLine = document.createElement('div');
            codeLine.className = 'lb-code-line';
            codeLine.dataset.blockId = block.id;
            codeLine.dataset.lineNum = String(lineNum);
            codeLine.innerHTML = (line.t || line.text) ? hlLine(line.t || line.text) : '&nbsp;';
            codeArea.appendChild(codeLine);

            lineNum++;
        }
    }

    // Overlay layer for spotlights and panels
    const overlay = document.createElement('div');
    overlay.className = 'lb-overlay';
    overlay.id = 'lb-overlay';
    preview.appendChild(overlay);

    // Render layout rectangles
    renderOverlayRects(overlay);

    // Wire zoom
    container.querySelector('#lb-zoom-in')!.addEventListener('click', () => {
        if (!_builder) return;
        _builder.zoom = Math.min(2, _builder.zoom + 0.1);
        preview.style.transform = `scale(${_builder.zoom})`;
        document.getElementById('lb-zoom-label')!.textContent = Math.round(_builder.zoom * 100) + '%';
    });
    container.querySelector('#lb-zoom-out')!.addEventListener('click', () => {
        if (!_builder) return;
        _builder.zoom = Math.max(0.3, _builder.zoom - 0.1);
        preview.style.transform = `scale(${_builder.zoom})`;
        document.getElementById('lb-zoom-label')!.textContent = Math.round(_builder.zoom * 100) + '%';
    });

    // ── Inline Code Editor ──
    const editorPanel = document.createElement('div');
    editorPanel.className = 'lb-code-editor-panel';
    editorPanel.id = 'lb-code-editor-panel';

    const editorHeader = document.createElement('div');
    editorHeader.className = 'lb-code-editor-header';
    editorHeader.innerHTML = '<span class="lb-preview-title">CODE EDITOR</span>';
    editorPanel.appendChild(editorHeader);

    const editorBody = document.createElement('div');
    editorBody.className = 'lb-code-editor-body';
    editorBody.id = 'lb-code-editor-body';
    editorPanel.appendChild(editorBody);

    container.appendChild(editorPanel);
    renderCodeEditor(editorBody);
}

function renderCodeEditor(container: HTMLElement) {
    if (!_builder) return;
    container.innerHTML = '';

    const selectedId = _builder.selectedBlockId;
    if (!selectedId) {
        container.innerHTML = '<div class="lb-code-editor-empty">Select a block to edit its code</div>';
        return;
    }

    const block = _builder.lesson.blocks?.find((b: any) => b.id === selectedId);
    if (!block) {
        container.innerHTML = '<div class="lb-code-editor-empty">Block not found</div>';
        return;
    }

    // Section name editor
    const secRow = document.createElement('div');
    secRow.className = 'lb-code-editor-row';
    secRow.innerHTML = `<label class="lb-field-label">Section</label>
        <input class="lb-field-input lb-code-section-input" id="lb-edit-section" value="${escHtml(block.sec || block.section || '')}" placeholder="(none)" spellcheck="false">`;
    container.appendChild(secRow);

    // Line-by-line editors
    const lines = block.lines || [];
    const linesContainer = document.createElement('div');
    linesContainer.className = 'lb-code-lines-editor';

    lines.forEach((line: any, i: number) => {
        const row = document.createElement('div');
        row.className = 'lb-code-line-row';

        const lineNum = document.createElement('span');
        lineNum.className = 'lb-code-line-num';
        lineNum.textContent = String(i + 1);
        row.appendChild(lineNum);

        const input = document.createElement('input');
        input.className = 'lb-code-line-input';
        input.type = 'text';
        input.value = line.t || line.text || '';
        input.spellcheck = false;
        input.dataset.lineIdx = String(i);
        input.addEventListener('change', () => {
            if (!_builder) return;
            const key = line.t !== undefined ? 't' : 'text';
            line[key] = input.value;
            refreshPreview();
        });
        row.appendChild(input);

        const confSpan = document.createElement('span');
        confSpan.className = 'lb-code-line-conf';
        confSpan.textContent = (line.confidence ?? line.c ?? 1.0).toFixed(1);
        confSpan.title = 'Confidence';
        row.appendChild(confSpan);

        linesContainer.appendChild(row);
    });

    container.appendChild(linesContainer);

    // Add/remove line buttons
    const lineActions = document.createElement('div');
    lineActions.className = 'lb-code-line-actions';
    lineActions.innerHTML = `<button class="lb-btn-sm" id="lb-add-line">+ Add Line</button>
        <button class="lb-btn-sm lb-btn-danger-sm" id="lb-remove-line">− Remove Last</button>`;
    container.appendChild(lineActions);

    lineActions.querySelector('#lb-add-line')!.addEventListener('click', () => {
        if (!_builder) return;
        const key = lines[0]?.t !== undefined ? 't' : 'text';
        lines.push({ [key]: '', confidence: 1.0, type: null, blockEnd: false });
        renderCodeEditor(container);
        refreshPreview();
    });

    lineActions.querySelector('#lb-remove-line')!.addEventListener('click', () => {
        if (!_builder || lines.length <= 1) return;
        lines.pop();
        renderCodeEditor(container);
        refreshPreview();
    });

    // Wire section input
    container.querySelector('#lb-edit-section')!.addEventListener('change', (e) => {
        if (!_builder) return;
        const val = (e.target as HTMLInputElement).value.trim();
        const key = block.sec !== undefined ? 'sec' : 'section';
        block[key] = val || null;
        refreshPreview();
    });
}

// ── Overlay Rectangles (draggable spotlights and panels) ──

/**
 * Flatten a block's token-lines into the same order the cinematic engine walks
 * them. The engine indexes layout.tokens[blockId] by this flat position, so the
 * two must agree or the wrong rectangle lights up.
 */
function flatTokens(blockId: string): { line: number; text: string }[] {
    const out: { line: number; text: string }[] = [];
    for (const tl of (_builder?.lesson.tokens?.[blockId] || [])) {
        for (const t of (tl.tokens || [])) out.push({ line: tl.line, text: t.text });
    }
    return out;
}

/**
 * Create default token/connection layouts for anything that has content but no
 * placement yet, and drop entries whose token/connection was deleted. Without
 * this, layout.tokens/.connections stay empty forever and the engine has nothing
 * to read.
 */
function ensureAuxLayouts(blockId: string) {
    if (!_builder) return;
    const bl = _builder.layout.blocks[blockId];
    const baseX = bl?.spotlight.x ?? 50;
    const baseY = bl?.spotlight.y ?? 10;
    const panelX = bl?.panel.x ?? 520;

    const toks = flatTokens(blockId);
    if (toks.length) {
        const arr = _builder.layout.tokens[blockId] || [];
        for (let i = arr.length; i < toks.length; i++) {
            arr[i] = {
                spotlight: { x: baseX + 8, y: baseY + i * 26, width: 150, height: 22 },
                panel: { x: panelX, y: baseY + i * 26, width: 300, height: 160 },
            };
        }
        arr.length = toks.length;
        _builder.layout.tokens[blockId] = arr;
    } else {
        delete _builder.layout.tokens[blockId];
    }

    const conns = _builder.lesson.connections?.[blockId] || [];
    if (conns.length) {
        const arr = _builder.layout.connections[blockId] || [];
        for (let i = arr.length; i < conns.length; i++) {
            arr[i] = {
                srcSpotlight: { x: baseX, y: baseY + i * 50, width: bl?.spotlight.width ?? 400, height: 22 },
                dstSpotlight: { x: baseX, y: baseY + i * 50 + 26, width: bl?.spotlight.width ?? 400, height: 22 },
            };
        }
        arr.length = conns.length;
        _builder.layout.connections[blockId] = arr;
    } else {
        delete _builder.layout.connections[blockId];
    }
}

function renderOverlayRects(overlay: HTMLElement) {
    if (!_builder) return;

    const selectedId = _builder.selectedBlockId;
    if (!selectedId) return;

    // Blocks added after the lesson was loaded have no layout yet — initBuilder
    // only seeds the blocks it saw at load time. Without this, a freshly added
    // block renders no rectangles at all and looks broken.
    if (!_builder.layout.blocks[selectedId]) {
        const blk = (_builder.lesson.blocks || []).find((b: any) => b.id === selectedId);
        const lineCount = blk?.lines?.length || 1;
        _builder.layout.blocks[selectedId] = {
            spotlight: { x: 50, y: 10, width: 400, height: lineCount * _builder.lineHeight + 12 },
            panel: { x: 520, y: 10, width: 340, height: 260 },
        };
    }

    ensureAuxLayouts(selectedId);

    const blockLayout = _builder.layout.blocks[selectedId];
    if (!blockLayout) return;

    // Spotlight rectangle
    const spotRect = createDraggableRect(
        blockLayout.spotlight, 'spotlight', selectedId,
        'lb-spot-rect', '🔦 Spotlight'
    );
    overlay.appendChild(spotRect);

    // Panel rectangle — sync y to spotlight y, and default x to right of spotlight
    // This matches what the engine does at runtime
    const syncedPanel = { ...blockLayout.panel };
    syncedPanel.y = blockLayout.spotlight.y;
    if (syncedPanel.x < blockLayout.spotlight.x + blockLayout.spotlight.width) {
        syncedPanel.x = blockLayout.spotlight.x + blockLayout.spotlight.width + 20;
    }
    // Write back so dragging updates the real layout
    blockLayout.panel.y = syncedPanel.y;
    blockLayout.panel.x = syncedPanel.x;

    const panelRect = createDraggableRect(
        blockLayout.panel, 'panel', selectedId,
        'lb-panel-rect', '📝 Explanation'
    );
    overlay.appendChild(panelRect);

    // Token spotlight + mini-panel for the selected token. Only the selected one
    // is drawn — a block with 20 tokens would otherwise bury the preview.
    const toks = flatTokens(selectedId);
    const ti = _builder.selectedTokenIdx;
    if (ti >= 0 && ti < toks.length) {
        const tl = _builder.layout.tokens[selectedId]?.[ti];
        if (tl) {
            overlay.appendChild(createDraggableRect(
                tl.spotlight, `tok-spot-${ti}`, selectedId,
                'lb-tok-rect', `🔍 "${toks[ti].text}"`
            ));
            overlay.appendChild(createDraggableRect(
                tl.panel, `tok-panel-${ti}`, selectedId,
                'lb-tok-panel-rect', `💬 "${toks[ti].text}" panel`
            ));
        }
    }

    // Connection spotlights (if any)
    const conns = _builder.lesson.connections?.[selectedId] || [];
    conns.forEach((conn: any, i: number) => {
        const connLayout = _builder!.layout.connections[selectedId]?.[i];
        if (connLayout) {
            const srcRect = createDraggableRect(
                connLayout.srcSpotlight, `conn-src-${i}`, selectedId,
                'lb-conn-rect', `→ ${conn.label || 'conn'} (src)`
            );
            overlay.appendChild(srcRect);

            const dstRect = createDraggableRect(
                connLayout.dstSpotlight, `conn-dst-${i}`, selectedId,
                'lb-conn-rect', `→ ${conn.label || 'conn'} (dst)`
            );
            overlay.appendChild(dstRect);
        }
    });
}

function createDraggableRect(
    rect: SpotlightRect | PanelLayout,
    handleType: string,
    blockId: string,
    cssClass: string,
    label: string
): HTMLElement {
    const el = document.createElement('div');
    el.className = 'lb-drag-rect ' + cssClass;
    el.style.left = rect.x + 'px';
    el.style.top = rect.y + 'px';
    el.style.width = rect.width + 'px';
    el.style.height = rect.height + 'px';
    el.dataset.handle = handleType;
    el.dataset.blockId = blockId;

    el.innerHTML = `<div class="lb-drag-label">${escHtml(label)}</div>
        <div class="lb-resize-handle lb-resize-br" data-resize="br"></div>`;

    // Drag to move
    el.addEventListener('mousedown', (e) => {
        if ((e.target as HTMLElement).dataset.resize) return; // handled by resize
        e.preventDefault(); e.stopPropagation();
        startDrag(e, handleType, blockId, rect, 'move');
    });

    // Resize handle
    el.querySelector('.lb-resize-br')!.addEventListener('mousedown', (e) => {
        e.preventDefault(); e.stopPropagation();
        startDrag(e as MouseEvent, handleType, blockId, rect, 'resize');
    });

    return el;
}

function startDrag(
    e: MouseEvent,
    handleType: string,
    blockId: string,
    rect: SpotlightRect | PanelLayout,
    mode: 'move' | 'resize'
) {
    if (!_builder) return;

    const startX = e.clientX;
    const startY = e.clientY;
    const origRect = { ...rect };
    const previewEl = document.getElementById('lb-preview');
    if (!previewEl) return;

    const zoom = _builder.zoom;

    function onMouseMove(ev: MouseEvent) {
        if (!_builder) return;
        const dx = (ev.clientX - startX) / zoom;
        const dy = (ev.clientY - startY) / zoom;

        if (mode === 'move') {
            rect.x = Math.max(0, origRect.x + dx);
            rect.y = Math.max(0, origRect.y + dy);
        } else {
            rect.width = Math.max(60, origRect.width + dx);
            rect.height = Math.max(30, origRect.height + dy);
        }

        // Update DOM
        const overlay = document.getElementById('lb-overlay');
        if (overlay) {
            const el = overlay.querySelector(`[data-handle="${handleType}"]`) as HTMLElement;
            if (el) {
                el.style.left = rect.x + 'px';
                el.style.top = rect.y + 'px';
                el.style.width = rect.width + 'px';
                el.style.height = rect.height + 'px';
            }
        }

        // Update properties panel numbers
        updatePropertiesLive();
    }

    function onMouseUp() {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
}

function updatePropertiesLive() {
    if (!_builder || !_builder.selectedBlockId) return;
    const bl = _builder.layout.blocks[_builder.selectedBlockId];
    if (!bl) return;

    const fields = [
        { id: 'lb-prop-sx', val: bl.spotlight.x },
        { id: 'lb-prop-sy', val: bl.spotlight.y },
        { id: 'lb-prop-sw', val: bl.spotlight.width },
        { id: 'lb-prop-sh', val: bl.spotlight.height },
        { id: 'lb-prop-px', val: bl.panel.x },
        { id: 'lb-prop-py', val: bl.panel.y },
        { id: 'lb-prop-pw', val: bl.panel.width },
        { id: 'lb-prop-ph', val: bl.panel.height },
    ];

    for (const f of fields) {
        const el = document.getElementById(f.id) as HTMLInputElement;
        if (el) el.value = String(Math.round(f.val));
    }
}

// ── Properties Panel ──

function renderProperties(container: HTMLElement) {
    if (!_builder || !_builder.selectedBlockId) {
        container.innerHTML = '<div style="padding:16px;color:var(--text-dim);font-size:11px">Select a block to edit its properties.</div>';
        return;
    }

    const blockId = _builder.selectedBlockId;
    const bl = _builder.layout.blocks[blockId];
    const block = (_builder.lesson.blocks || []).find((b: any) => b.id === blockId);
    const expl = _builder.lesson.explanations?.[blockId];
    const blockTokens = _builder.lesson.tokens?.[blockId] || [];
    const blockConns = _builder.lesson.connections?.[blockId] || [];

    container.innerHTML = '';

    // ── Block Info ──
    const blockInfo = document.createElement('div');
    blockInfo.className = 'lb-props-section';
    blockInfo.innerHTML = `
        <div class="lb-section-title">BLOCK: ${escHtml(blockId)}</div>
        <label class="lb-field-label">Section Title</label>
        <input class="lb-field-input" id="lb-prop-sec" value="${escHtml(block?.sec || block?.section || '')}" spellcheck="false" placeholder="(optional section divider)">
        <label class="lb-field-label">Lines</label>
        <textarea class="lb-field-input lb-field-textarea lb-code-edit" id="lb-prop-lines" rows="6" spellcheck="false">${escHtml((block?.lines || []).map((l: any) => l.t || l.text || '').join('\n'))}</textarea>`;
    container.appendChild(blockInfo);

    blockInfo.querySelector('#lb-prop-sec')!.addEventListener('change', () => {
        if (!_builder || !block) return;
        block.sec = (document.getElementById('lb-prop-sec') as HTMLInputElement).value;
        refreshPreview();
    });
    blockInfo.querySelector('#lb-prop-lines')!.addEventListener('change', () => {
        if (!_builder || !block) return;
        const text = (document.getElementById('lb-prop-lines') as HTMLTextAreaElement).value;
        block.lines = text.split('\n').map((t: string) => ({ t, text: t }));
        refreshPreview();
    });

    // ── Spotlight Layout ──
    if (bl) {
        const spotSection = document.createElement('div');
        spotSection.className = 'lb-props-section';
        spotSection.innerHTML = `
            <div class="lb-section-title">🔦 SPOTLIGHT</div>
            <div class="lb-coord-grid">
                <label>X</label><input class="lb-field-input lb-coord-input" id="lb-prop-sx" type="number" value="${Math.round(bl.spotlight.x)}">
                <label>Y</label><input class="lb-field-input lb-coord-input" id="lb-prop-sy" type="number" value="${Math.round(bl.spotlight.y)}">
                <label>W</label><input class="lb-field-input lb-coord-input" id="lb-prop-sw" type="number" value="${Math.round(bl.spotlight.width)}">
                <label>H</label><input class="lb-field-input lb-coord-input" id="lb-prop-sh" type="number" value="${Math.round(bl.spotlight.height)}">
            </div>`;
        container.appendChild(spotSection);

        const panelSection = document.createElement('div');
        panelSection.className = 'lb-props-section';
        panelSection.innerHTML = `
            <div class="lb-section-title">📝 PANEL POSITION</div>
            <div class="lb-coord-grid">
                <label>X</label><input class="lb-field-input lb-coord-input" id="lb-prop-px" type="number" value="${Math.round(bl.panel.x)}">
                <label>Y</label><input class="lb-field-input lb-coord-input" id="lb-prop-py" type="number" value="${Math.round(bl.panel.y)}">
                <label>W</label><input class="lb-field-input lb-coord-input" id="lb-prop-pw" type="number" value="${Math.round(bl.panel.width)}">
                <label>H</label><input class="lb-field-input lb-coord-input" id="lb-prop-ph" type="number" value="${Math.round(bl.panel.height)}">
            </div>`;
        container.appendChild(panelSection);

        container.querySelectorAll('.lb-coord-input').forEach(inp => {
            inp.addEventListener('change', () => {
                if (!_builder || !bl) return;
                bl.spotlight.x = parseFloat((document.getElementById('lb-prop-sx') as HTMLInputElement).value) || 0;
                bl.spotlight.y = parseFloat((document.getElementById('lb-prop-sy') as HTMLInputElement).value) || 0;
                bl.spotlight.width = parseFloat((document.getElementById('lb-prop-sw') as HTMLInputElement).value) || 100;
                bl.spotlight.height = parseFloat((document.getElementById('lb-prop-sh') as HTMLInputElement).value) || 40;
                bl.panel.x = parseFloat((document.getElementById('lb-prop-px') as HTMLInputElement).value) || 0;
                bl.panel.y = parseFloat((document.getElementById('lb-prop-py') as HTMLInputElement).value) || 0;
                bl.panel.width = parseFloat((document.getElementById('lb-prop-pw') as HTMLInputElement).value) || 300;
                bl.panel.height = parseFloat((document.getElementById('lb-prop-ph') as HTMLInputElement).value) || 200;
                const overlay = document.getElementById('lb-overlay');
                if (overlay) { overlay.innerHTML = ''; renderOverlayRects(overlay); }
            });
        });
    }

    // ── Explanation ──
    const explSection = document.createElement('div');
    explSection.className = 'lb-props-section';
    explSection.innerHTML = `
        <div class="lb-section-title">💬 EXPLANATION</div>
        <label class="lb-field-label">Label</label>
        <input class="lb-field-input" id="lb-prop-expl-label" value="${escHtml(expl?.label || '')}" spellcheck="false" placeholder="e.g. D3D Interface">
        <label class="lb-field-label">Type</label>
        <select class="lb-field-input" id="lb-prop-expl-type">
            <option value="concept" ${(expl?.tp || expl?.type) === 'concept' || (!expl?.tp && !expl?.type) ? 'selected' : ''}>Concept</option>
            <option value="api" ${(expl?.tp || expl?.type) === 'api' ? 'selected' : ''}>API</option>
            <option value="pattern" ${(expl?.tp || expl?.type) === 'pattern' ? 'selected' : ''}>Pattern</option>
            <option value="warn" ${(expl?.tp || expl?.type) === 'warn' ? 'selected' : ''}>Warning</option>
        </select>
        <label class="lb-field-label">Description (HTML)</label>
        <textarea class="lb-field-input lb-field-textarea" id="lb-prop-expl-desc" rows="5" spellcheck="false">${escHtml(expl?.desc || expl?.description || '')}</textarea>`;
    container.appendChild(explSection);

    // Auto-save explanation on change
    ['lb-prop-expl-label', 'lb-prop-expl-type', 'lb-prop-expl-desc'].forEach(id => {
        explSection.querySelector('#' + id)?.addEventListener('change', () => {
            if (!_builder) return;
            _builder.lesson.explanations = _builder.lesson.explanations || {};
            _builder.lesson.explanations[blockId] = {
                label: (document.getElementById('lb-prop-expl-label') as HTMLInputElement).value,
                tp: (document.getElementById('lb-prop-expl-type') as HTMLSelectElement).value,
                desc: (document.getElementById('lb-prop-expl-desc') as HTMLTextAreaElement).value,
            };
        });
    });

    // ── Token Explanations ──
    const tokSection = document.createElement('div');
    tokSection.className = 'lb-props-section';
    let tokHtml = '<div class="lb-section-title">🔍 TOKEN EXPLANATIONS <button class="lb-add-block-btn" id="lb-add-token">＋</button></div>';
    tokHtml += '<div style="font-size:10px;color:var(--text-muted);margin:-4px 0 6px">“Place” drags this token’s spotlight and panel on the preview. Unplaced tokens fall back to auto-positioning.</div>';
    tokHtml += '<div id="lb-token-list">';
    let _flat = 0;
    blockTokens.forEach((tl: any, ti: number) => {
        const lineTokens = tl.tokens || [];
        tokHtml += `<div class="lb-token-line" style="margin-bottom:8px;padding:6px;background:rgba(255,255,255,0.02);border-radius:4px;border:1px solid var(--border)">`;
        tokHtml += `<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px"><span style="font-size:9px;color:var(--text-muted)">Line ${tl.line}</span><input class="lb-field-input" style="width:50px;padding:2px 4px" type="number" value="${tl.line}" data-tli="${ti}" data-field="line"><button class="lb-add-block-btn" data-remove-tl="${ti}" style="color:#f44747;border-color:#f44747">✕</button></div>`;
        lineTokens.forEach((tok: any, tki: number) => {
            tokHtml += `<div style="margin:4px 0;padding:4px;background:rgba(86,212,245,0.04);border-radius:3px">`;
            tokHtml += `<input class="lb-field-input" style="margin-bottom:2px;font-family:monospace;font-size:10px" placeholder="token text" value="${escHtml(tok.text)}" data-tli="${ti}" data-tki="${tki}" data-field="text">`;
            tokHtml += `<textarea class="lb-field-input lb-field-textarea" rows="2" style="font-size:10px" placeholder="explanation" data-tli="${ti}" data-tki="${tki}" data-field="desc">${escHtml(tok.desc || tok.description || '')}</textarea>`;
            const isPlaced = _builder!.selectedTokenIdx === _flat;
            tokHtml += `<div style="display:flex;gap:4px;align-items:center">
                <button class="lb-add-block-btn" data-place-tok="${_flat}" style="font-size:9px;${isPlaced ? 'color:var(--green);border-color:var(--green)' : ''}">${isPlaced ? '◉ Placing' : '◎ Place'}</button>
                <button class="lb-add-block-btn" data-remove-tok="${ti}:${tki}" style="font-size:9px;color:#f44747;border-color:#f44747">Remove token</button>
            </div>`;
            tokHtml += '</div>';
            _flat++;
        });
        tokHtml += `<button class="lb-add-block-btn" data-add-tok="${ti}" style="margin-top:2px">＋ Add Token</button>`;
        tokHtml += '</div>';
    });
    tokHtml += '</div>';
    tokSection.innerHTML = tokHtml;
    container.appendChild(tokSection);

    // Wire token editors
    tokSection.addEventListener('change', (e) => {
        const el = e.target as HTMLInputElement | HTMLTextAreaElement;
        const tli = el.dataset.tli !== undefined ? parseInt(el.dataset.tli) : -1;
        const tki = el.dataset.tki !== undefined ? parseInt(el.dataset.tki) : -1;
        const field = el.dataset.field;
        if (!_builder || tli < 0) return;
        _builder.lesson.tokens = _builder.lesson.tokens || {};
        const tlines = _builder.lesson.tokens[blockId] || [];
        if (field === 'line' && tlines[tli]) { tlines[tli].line = parseInt(el.value) || 0; }
        if (field === 'text' && tki >= 0 && tlines[tli]?.tokens[tki]) { tlines[tli].tokens[tki].text = el.value; }
        if (field === 'desc' && tki >= 0 && tlines[tli]?.tokens[tki]) { tlines[tli].tokens[tki].desc = el.value; }
        _builder.lesson.tokens[blockId] = tlines;
    });

    tokSection.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest('button') as HTMLElement;
        if (!btn || !_builder) return;
        _builder.lesson.tokens = _builder.lesson.tokens || {};
        if (btn.dataset.placeTok !== undefined) {
            const idx = parseInt(btn.dataset.placeTok, 10);
            // Toggle: clicking the active one clears the selection.
            _builder.selectedTokenIdx = _builder.selectedTokenIdx === idx ? -1 : idx;
            const ws = document.getElementById('lb-workspace');
            if (ws) renderBuilderWorkspace(ws);
            return;
        }
        if (btn.id === 'lb-add-token') {
            const tlines = _builder.lesson.tokens[blockId] || [];
            tlines.push({ line: 0, tokens: [{ text: '', desc: '' }] });
            _builder.lesson.tokens[blockId] = tlines;
            renderProperties(container);
        }
        if (btn.dataset.addTok !== undefined) {
            const ti = parseInt(btn.dataset.addTok);
            const tlines = _builder.lesson.tokens[blockId] || [];
            if (tlines[ti]) { tlines[ti].tokens.push({ text: '', desc: '' }); }
            _builder.lesson.tokens[blockId] = tlines;
            renderProperties(container);
        }
        if (btn.dataset.removeTok) {
            const [ti, tki] = btn.dataset.removeTok.split(':').map(Number);
            const tlines = _builder.lesson.tokens[blockId] || [];
            if (tlines[ti]?.tokens) { tlines[ti].tokens.splice(tki, 1); }
            _builder.lesson.tokens[blockId] = tlines;
            renderProperties(container);
        }
        if (btn.dataset.removeTl !== undefined) {
            const ti = parseInt(btn.dataset.removeTl);
            const tlines = _builder.lesson.tokens[blockId] || [];
            tlines.splice(ti, 1);
            _builder.lesson.tokens[blockId] = tlines;
            renderProperties(container);
        }
    });

    // ── Connections ──
    const connSection = document.createElement('div');
    connSection.className = 'lb-props-section';
    let connHtml = '<div class="lb-section-title">🔗 CONNECTIONS <button class="lb-add-block-btn" id="lb-add-conn">＋</button></div>';
    connHtml += '<div id="lb-conn-list">';
    blockConns.forEach((conn: any, ci: number) => {
        connHtml += `<div style="margin-bottom:6px;padding:6px;background:rgba(255,255,255,0.02);border-radius:4px;border:1px solid var(--border)">`;
        connHtml += `<div style="display:flex;gap:4px;margin-bottom:3px"><label class="lb-field-label" style="margin:0">Src lines</label><input class="lb-field-input" style="flex:1;padding:2px 4px;font-size:10px" value="${(conn.src || []).join(',')}" data-ci="${ci}" data-cfield="src"></div>`;
        connHtml += `<div style="display:flex;gap:4px;margin-bottom:3px"><label class="lb-field-label" style="margin:0">Dst lines</label><input class="lb-field-input" style="flex:1;padding:2px 4px;font-size:10px" value="${(conn.dst || []).join(',')}" data-ci="${ci}" data-cfield="dst"></div>`;
        connHtml += `<input class="lb-field-input" style="margin-bottom:2px;font-size:10px" placeholder="Arrow label" value="${escHtml(conn.label || '')}" data-ci="${ci}" data-cfield="label">`;
        connHtml += `<textarea class="lb-field-input lb-field-textarea" rows="2" style="font-size:10px" placeholder="Description" data-ci="${ci}" data-cfield="desc">${escHtml(conn.desc || conn.description || '')}</textarea>`;
        connHtml += `<button class="lb-add-block-btn" data-remove-conn="${ci}" style="font-size:9px;color:#f44747;border-color:#f44747">Remove</button>`;
        connHtml += '</div>';
    });
    connHtml += '</div>';
    connSection.innerHTML = connHtml;
    container.appendChild(connSection);

    connSection.addEventListener('change', (e) => {
        const el = e.target as HTMLInputElement | HTMLTextAreaElement;
        const ci = el.dataset.ci !== undefined ? parseInt(el.dataset.ci) : -1;
        const field = el.dataset.cfield;
        if (!_builder || ci < 0 || !field) return;
        _builder.lesson.connections = _builder.lesson.connections || {};
        const conns = _builder.lesson.connections[blockId] || [];
        if (!conns[ci]) return;
        if (field === 'src') conns[ci].src = el.value.split(',').map((s: string) => parseInt(s.trim())).filter((n: number) => !isNaN(n));
        if (field === 'dst') conns[ci].dst = el.value.split(',').map((s: string) => parseInt(s.trim())).filter((n: number) => !isNaN(n));
        if (field === 'label') conns[ci].label = el.value;
        if (field === 'desc') conns[ci].desc = el.value;
        _builder.lesson.connections[blockId] = conns;
    });

    connSection.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest('button') as HTMLElement;
        if (!btn || !_builder) return;
        _builder.lesson.connections = _builder.lesson.connections || {};
        if (btn.id === 'lb-add-conn') {
            const conns = _builder.lesson.connections[blockId] || [];
            conns.push({ src: [], dst: [], label: '', desc: '' });
            _builder.lesson.connections[blockId] = conns;
            renderProperties(container);
        }
        if (btn.dataset.removeConn !== undefined) {
            const ci = parseInt(btn.dataset.removeConn);
            const conns = _builder.lesson.connections[blockId] || [];
            conns.splice(ci, 1);
            _builder.lesson.connections[blockId] = conns;
            renderProperties(container);
        }
    });

    // ── Delete Block ──
    const dangerSection = document.createElement('div');
    dangerSection.className = 'lb-props-section';
    dangerSection.innerHTML = `<button class="admin-btn admin-btn-sm admin-btn-delete" id="lb-delete-block">Delete This Block</button>`;
    container.appendChild(dangerSection);

    dangerSection.querySelector('#lb-delete-block')!.addEventListener('click', () => {
        if (!_builder || !confirm('Delete block "' + blockId + '"?')) return;
        _builder.lesson.blocks = (_builder.lesson.blocks || []).filter((b: any) => b.id !== blockId);
        delete _builder.layout.blocks[blockId];
        delete _builder.lesson.explanations?.[blockId];
        delete _builder.lesson.connections?.[blockId];
        delete _builder.lesson.tokens?.[blockId];
        _builder.selectedBlockId = _builder.lesson.blocks?.[0]?.id || null;
        refreshPreview();
    });
}

function refreshPreview() {
    const ws = document.getElementById('lb-workspace');
    if (ws && _builder) renderBuilderWorkspace(ws);
}

// ══════════════════════════════════════
//  PUBLIC API
// ══════════════════════════════════════

/** Check if the admin panel should be visible. */
export function isVisible(): boolean {
    return auth.isAdmin();
}

/** Get the current builder's lesson layout data (for engine consumption). */
export function getBuilderLayout(): LessonLayoutData | null {
    return _builder?.layout || null;
}

/** Get the full builder export data. */
export function getBuilderExportData(): any | null {
    return _builder ? buildExportData() : null;
}

/** Make a resize handle that drags a panel's width. */
function makeResizeHandle(handle: HTMLElement, panel: HTMLElement, side: 'left' | 'right') {
    let dragging = false, startX = 0, startW = 0;
    handle.addEventListener('mousedown', (e) => {
        dragging = true;
        startX = e.clientX;
        startW = panel.offsetWidth;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const newW = side === 'left' ? startW + dx : startW - dx;
        const min = parseInt(getComputedStyle(panel).minWidth) || 180;
        const max = parseInt(getComputedStyle(panel).maxWidth) || 500;
        panel.style.width = Math.max(min, Math.min(max, newW)) + 'px';
    });
    document.addEventListener('mouseup', () => {
        if (dragging) {
            dragging = false;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        }
    });
}

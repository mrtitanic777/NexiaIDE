/**
 * git.ts — Git + GitHub integration for Nexia IDE
 * Sidebar panel: local git operations, GitHub account linking,
 * repo browsing, clone, and token-authenticated push/pull.
 */

const { execSync, execFileSync, spawn: nodeSpawn } = require('child_process');
const nodeFs = require('fs');
const nodePath = require('path');
const nodeOs = require('os');
const nodeHttps = require('https');
const nodeHttp = require('http');

// ── Node-based HTTP helper (bypasses Chromium CSP/TLS issues on Windows 7) ──

interface NodeRequestOptions {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeout?: number;
}

interface NodeResponse {
    ok: boolean;
    status: number;
    data: string;
    json(): any;
    text(): string;
}

function nodeRequest(url: string, opts: NodeRequestOptions = {}): Promise<NodeResponse> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const isHttps = parsed.protocol === 'https:';
        const lib = isHttps ? nodeHttps : nodeHttp;
        const headers: Record<string, string> = { ...(opts.headers || {}) };
        if (opts.body) headers['Content-Length'] = Buffer.byteLength(opts.body).toString();
        const req = lib.request({
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: opts.method || 'GET',
            headers,
        }, (res: any) => {
            let data = '';
            res.on('data', (chunk: string) => data += chunk);
            res.on('end', () => {
                resolve({
                    ok: res.statusCode >= 200 && res.statusCode < 400,
                    status: res.statusCode,
                    data,
                    json() { return JSON.parse(data); },
                    text() { return data; },
                });
            });
        });
        req.on('error', reject);
        req.setTimeout(opts.timeout || 30000, () => { req.destroy(); reject(new Error('Request timeout')); });
        if (opts.body) req.write(opts.body);
        req.end();
    });
}

// ── Dependencies ──
let _$: (id: string) => HTMLElement = (id) => document.getElementById(id)!;
let _getCurrentProject: () => any = () => null;
let _appendOutput: (text: string) => void = () => {};

export function initGit(deps: {
    $?: (id: string) => HTMLElement;
    getCurrentProject: () => any;
    appendOutput: (text: string) => void;
}) {
    if (deps.$) _$ = deps.$;
    _getCurrentProject = deps.getCurrentProject;
    _appendOutput = deps.appendOutput;
    loadGitHubConfig();
}

// ══════════════════════════════════════════
//  GITHUB ACCOUNT / TOKEN STORAGE
// ══════════════════════════════════════════

const GH_CONFIG_FILE = nodePath.join(nodeOs.homedir(), '.nexia-ide-github.json');
const GH_CLIENT_ID = 'Ov23liF8sIGatsOZJJmE';

interface GitHubConfig {
    token: string;
    username: string;
    avatarUrl: string;
    name: string;
}

let ghConfig: GitHubConfig | null = null;
let ghRepoCache: any[] = [];
let ghView: 'local' | 'github' | 'repos' | 'clone' | 'files' | 'device-pending' = 'local';

// Device flow state
let ghDeviceCode: string = '';
let ghUserCode: string = '';
let ghVerificationUri: string = '';
let ghPollInterval: number = 5;
let ghPollTimer: ReturnType<typeof setTimeout> | null = null;

// File manager state
let ghFmRepo: string = '';           // "owner/repo" currently browsed
let ghFmBranch: string = 'main';
let ghFmPath: string = '';           // current directory path ('' = root)
let ghFmContents: any[] = [];       // cached directory listing
let ghFmViewingFile: { path: string; content: string; sha: string; encoding: string } | null = null;
let ghFmEditing: boolean = false;

function loadGitHubConfig() {
    try {
        if (nodeFs.existsSync(GH_CONFIG_FILE)) {
            ghConfig = JSON.parse(nodeFs.readFileSync(GH_CONFIG_FILE, 'utf-8'));
        }
    } catch { ghConfig = null; }
}

function saveGitHubConfig() {
    try {
        if (ghConfig) {
            nodeFs.writeFileSync(GH_CONFIG_FILE, JSON.stringify(ghConfig, null, 2));
        } else {
            if (nodeFs.existsSync(GH_CONFIG_FILE)) nodeFs.unlinkSync(GH_CONFIG_FILE);
        }
    } catch {}
}

async function ghApiFetch(endpoint: string, options: any = {}): Promise<any> {
    if (!ghConfig?.token) throw new Error('Not signed in to GitHub');
    const url = endpoint.startsWith('http') ? endpoint : `https://api.github.com${endpoint}`;
    const headers: Record<string, string> = {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${ghConfig.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'NexiaIDE',
        ...(options.headers || {}),
    };
    if (options.body) headers['Content-Type'] = 'application/json';
    const resp = await nodeRequest(url, {
        method: options.method || 'GET',
        headers,
        body: options.body,
    });
    if (!resp.ok) {
        throw new Error(`GitHub API ${resp.status}: ${resp.text().substring(0, 200)}`);
    }
    return resp.json();
}

async function validateAndStoreToken(token: string): Promise<boolean> {
    try {
        const resp = await nodeRequest('https://api.github.com/user', {
            headers: {
                'Accept': 'application/vnd.github+json',
                'Authorization': `Bearer ${token}`,
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': 'NexiaIDE',
            },
        });
        if (!resp.ok) return false;
        const data = resp.json();
        ghConfig = {
            token,
            username: data.login,
            avatarUrl: data.avatar_url || '',
            name: data.name || data.login,
        };
        saveGitHubConfig();
        configureGitCredentials();
        return true;
    } catch { return false; }
}

// ── GitHub Device Flow ──

async function startDeviceFlow() {
    try {
        ghView = 'device-pending';
        renderGitPanel();

        const resp = await nodeRequest('https://github.com/login/device/code', {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'User-Agent': 'NexiaIDE',
            },
            body: JSON.stringify({
                client_id: GH_CLIENT_ID,
                scope: 'repo',
            }),
        });

        if (!resp.ok) {
            showGitToast(`GitHub auth failed: ${resp.text().substring(0, 100)}`, 'error');
            ghView = 'github';
            renderGitPanel();
            return;
        }

        const data = resp.json();
        ghDeviceCode = data.device_code;
        ghUserCode = data.user_code;
        ghVerificationUri = data.verification_uri;
        ghPollInterval = data.interval || 5;

        // Render the code for the user
        renderGitPanel();

        // Start polling
        pollForToken();
    } catch (err: any) {
        showGitToast(`Device flow failed: ${err.message}`, 'error');
        ghView = 'github';
        renderGitPanel();
    }
}

function pollForToken() {
    if (ghPollTimer) clearTimeout(ghPollTimer);

    ghPollTimer = setTimeout(async () => {
        try {
            const resp = await nodeRequest('https://github.com/login/oauth/access_token', {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'User-Agent': 'NexiaIDE',
                },
                body: JSON.stringify({
                    client_id: GH_CLIENT_ID,
                    device_code: ghDeviceCode,
                    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
                }),
            });

            const data = resp.json();

            if (data.access_token) {
                // Success — validate and store
                const ok = await validateAndStoreToken(data.access_token);
                if (ok) {
                    showGitToast(`Signed in as ${ghConfig!.username}!`, 'success');
                    ghView = 'github';
                    renderGitPanel();
                } else {
                    showGitToast('Got token but validation failed', 'error');
                    ghView = 'github';
                    renderGitPanel();
                }
                return;
            }

            if (data.error === 'authorization_pending') {
                // User hasn't authorized yet — keep polling
                pollForToken();
                return;
            }

            if (data.error === 'slow_down') {
                // GitHub says slow down — increase interval
                ghPollInterval = (data.interval || ghPollInterval) + 1;
                pollForToken();
                return;
            }

            if (data.error === 'expired_token') {
                showGitToast('Code expired — please try again', 'error');
                ghView = 'github';
                renderGitPanel();
                return;
            }

            if (data.error === 'access_denied') {
                showGitToast('Authorization denied', 'error');
                ghView = 'github';
                renderGitPanel();
                return;
            }

            // Unknown error — keep polling a few more times
            pollForToken();
        } catch {
            // Network error — retry
            pollForToken();
        }
    }, ghPollInterval * 1000);
}

function cancelDeviceFlow() {
    if (ghPollTimer) { clearTimeout(ghPollTimer); ghPollTimer = null; }
    ghDeviceCode = '';
    ghUserCode = '';
    ghView = 'github';
    renderGitPanel();
}

function configureGitCredentials() {
    if (!ghConfig) return;
    // Set git config so pushes use the token
    try {
        const proj = _getCurrentProject();
        if (proj) {
            execSync(`git config credential.helper ""`, { cwd: proj.path, stdio: 'pipe' });
        }
    } catch {}
}

function getAuthenticatedRemoteUrl(url: string): string {
    if (!ghConfig?.token) return url;
    // Convert https://github.com/user/repo.git → https://TOKEN@github.com/user/repo.git
    if (url.startsWith('https://github.com/')) {
        return url.replace('https://github.com/', `https://${ghConfig.token}@github.com/`);
    }
    return url;
}

// Remove any credentials from text before it is shown in the UI. Git error
// messages echo the remote URL — which may contain https://TOKEN@host — so we
// scrub both the known token and any generic userinfo (https://...@) component.
function scrubSecret(text: string): string {
    if (!text) return text;
    let out = String(text);
    if (ghConfig?.token) {
        out = out.split(ghConfig.token).join('***');
    }
    // Generic: replace the userinfo in any URL (scheme://user:pass@host → scheme://***@host)
    out = out.replace(/(https?:\/\/)[^/@\s]+@/gi, '$1***@');
    return out;
}

function logoutGitHub() {
    ghConfig = null;
    ghRepoCache = [];
    if (ghPollTimer) { clearTimeout(ghPollTimer); ghPollTimer = null; }
    saveGitHubConfig();
}

// ══════════════════════════════════════════
//  LOCAL GIT HELPERS
// ══════════════════════════════════════════

function gitExec(cmd: string, cwd?: string): string {
    const dir = cwd || _getCurrentProject()?.path;
    if (!dir) throw new Error('No project open');
    try {
        return execSync(cmd, { cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch (err: any) {
        throw new Error(err.stderr?.trim() || err.message);
    }
}

// Run git with an explicit argv array via execFileSync — no shell is spawned, so
// a token-bearing URL passed as an argument is never re-parsed by a shell. Any
// error text is scrubbed of credentials before it propagates to the UI.
function gitExecArgs(args: string[], cwd?: string): string {
    const dir = cwd || _getCurrentProject()?.path;
    if (!dir) throw new Error('No project open');
    try {
        return execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch (err: any) {
        throw new Error(scrubSecret(err.stderr?.trim() || err.message));
    }
}

function isGitRepo(): boolean {
    try { gitExec('git rev-parse --is-inside-work-tree'); return true; }
    catch { return false; }
}

function getCurrentBranch(): string {
    try { return gitExec('git branch --show-current') || 'HEAD (detached)'; }
    catch { return 'unknown'; }
}

function getRemoteUrl(): string {
    try { return gitExec('git remote get-url origin'); }
    catch { return ''; }
}

function hasCommits(): boolean {
    try { gitExec('git rev-parse HEAD'); return true; }
    catch { return false; }
}

interface FileChange { status: string; staged: boolean; file: string; }

// Git wraps paths containing special chars (spaces, unicode, etc.) in double
// quotes and C-escapes them. Strip the surrounding quotes so the UI shows a
// clean path. (We only unquote; full C-unescaping isn't needed for display.)
function unquoteGitPath(p: string): string {
    if (p.length >= 2 && p[0] === '"' && p[p.length - 1] === '"') {
        return p.slice(1, -1);
    }
    return p;
}

function getChangedFiles(): FileChange[] {
    try {
        const raw = gitExec('git status --porcelain');
        if (!raw) return [];
        const results: FileChange[] = [];
        for (const line of raw.split('\n').filter(Boolean)) {
            const ix = line[0], wt = line[1];
            let pathPart = line.substring(3);
            // Renames/copies are reported as "old -> new"; track the new path.
            const arrowIdx = pathPart.indexOf(' -> ');
            if (arrowIdx >= 0) {
                pathPart = pathPart.substring(arrowIdx + 4);
            }
            const file = unquoteGitPath(pathPart);
            if (ix !== ' ' && ix !== '?') results.push({ status: ix, staged: true, file });
            if (wt !== ' ' || ix === '?') results.push({ status: wt === '?' ? '?' : wt, staged: false, file });
        }
        return results;
    } catch { return []; }
}

function getStatusClass(s: string): string {
    switch (s) {
        case 'M': return 'git-modified';
        case 'A': case '?': return 'git-added';
        case 'D': return 'git-deleted';
        case 'R': case 'C': return 'git-renamed';
        case 'U': return 'git-conflict';
        default: return 'git-modified';
    }
}

function getCommitLog(n: number = 10): { short: string; message: string; date: string; author: string }[] {
    try {
        const raw = gitExec(`git log --pretty=format:"%h||%s||%cr||%an" -n ${n}`);
        if (!raw) return [];
        return raw.split('\n').filter(Boolean).map(l => {
            const [short, message, date, author] = l.split('||');
            return { short, message, date, author };
        });
    } catch { return []; }
}

function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ══════════════════════════════════════════
//  PANEL RENDER
// ══════════════════════════════════════════

export function renderGitPanel() {
    const panel = _$('git-panel');
    if (!panel) return;

    // ── Tab bar (Local / GitHub) ──
    let html = `<div class="git-tab-bar">
        <button class="git-tab ${ghView === 'local' ? 'active' : ''}" data-view="local">Local</button>
        <button class="git-tab ${ghView === 'github' || ghView === 'repos' || ghView === 'clone' ? 'active' : ''}" data-view="github">GitHub</button>
    </div>`;

    if (ghView === 'local') {
        html += renderLocalView();
    } else {
        html += renderGitHubView();
    }

    panel.innerHTML = html;
    wireGitEvents(panel);
}

// ── LOCAL VIEW ──

function renderLocalView(): string {
    const proj = _getCurrentProject();
    if (!proj) {
        return `<div class="git-empty">
            <div class="git-empty-icon">🔀</div>
            <div class="git-empty-text">No project open</div>
            <div class="git-empty-hint">Open a project to use source control</div>
        </div>`;
    }

    if (!isGitRepo()) {
        return `<div class="git-empty">
            <div class="git-empty-icon">🔀</div>
            <div class="git-empty-text">Not a Git repository</div>
            <div class="git-empty-hint">Initialize a repository to track your project's changes</div>
            <button class="git-btn git-btn-primary" id="git-init-btn">Initialize Repository</button>
        </div>`;
    }

    const branch = getCurrentBranch();
    const remote = getRemoteUrl();
    const changes = getChangedFiles();
    const staged = changes.filter(f => f.staged);
    const unstaged = changes.filter(f => !f.staged);
    let h = '';

    // Branch
    h += `<div class="git-section git-branch-section">
        <div class="git-branch-row">
            <span class="git-branch-icon">⎇</span>
            <span class="git-branch-name">${esc(branch)}</span>
        </div>`;
    if (remote) {
        const short = remote.replace(/^https?:\/\//, '').replace(/\.git$/, '').replace(/[^@]*@/, '');
        h += `<div class="git-remote-row" title="${esc(remote)}">↗ ${esc(short)}</div>`;
    }
    h += `</div>`;

    // Commit box
    h += `<div class="git-section git-commit-section">
        <textarea id="git-commit-msg" class="git-commit-input" placeholder="Commit message (Ctrl+Enter)" rows="2"></textarea>
        <div class="git-commit-actions">
            <button class="git-btn git-btn-primary git-btn-full" id="git-commit-btn" ${changes.length === 0 ? 'disabled' : ''}>
                Commit${staged.length > 0 ? ` (${staged.length} staged)` : ' All'}
            </button>
        </div>
    </div>`;

    // Push / Pull / Stash
    h += `<div class="git-section git-actions-row">
        <button class="git-btn" id="git-push-btn" title="Push to remote">↑ Push</button>
        <button class="git-btn" id="git-pull-btn" title="Pull from remote">↓ Pull</button>
        <button class="git-btn" id="git-stash-btn" title="Stash changes">⊡ Stash</button>
    </div>`;

    // Staged
    if (staged.length > 0) {
        h += `<div class="git-section"><div class="git-section-header">
            <span>STAGED CHANGES</span><span class="git-section-count">${staged.length}</span>
            <button class="git-section-action" id="git-unstage-all" title="Unstage all">−</button>
        </div><div class="git-file-list">`;
        for (const f of staged) {
            h += `<div class="git-file-entry"><span class="git-file-status ${getStatusClass(f.status)}">${esc(f.status)}</span>
                <span class="git-file-name" title="${esc(f.file)}">${esc(f.file)}</span>
                <button class="git-file-action" data-action="unstage" data-file="${esc(f.file)}" title="Unstage">−</button></div>`;
        }
        h += `</div></div>`;
    }

    // Unstaged
    if (unstaged.length > 0) {
        h += `<div class="git-section"><div class="git-section-header">
            <span>CHANGES</span><span class="git-section-count">${unstaged.length}</span>
            <button class="git-section-action" id="git-stage-all" title="Stage all">+</button>
        </div><div class="git-file-list">`;
        for (const f of unstaged) {
            h += `<div class="git-file-entry"><span class="git-file-status ${getStatusClass(f.status)}">${esc(f.status)}</span>
                <span class="git-file-name" title="${esc(f.file)}">${esc(f.file)}</span>
                <button class="git-file-action" data-action="stage" data-file="${esc(f.file)}" title="Stage">+</button></div>`;
        }
        h += `</div></div>`;
    }

    // Clean
    if (changes.length === 0) {
        h += `<div class="git-section git-clean-msg"><span class="git-clean-icon">✓</span> No changes</div>`;
    }

    // Commits
    if (hasCommits()) {
        const commits = getCommitLog(10);
        if (commits.length > 0) {
            h += `<div class="git-section"><div class="git-section-header"><span>COMMITS</span></div><div class="git-commit-list">`;
            for (const c of commits) {
                h += `<div class="git-commit-entry" title="${esc(c.short)} by ${esc(c.author)}">
                    <span class="git-commit-hash">${esc(c.short)}</span>
                    <span class="git-commit-msg-text">${esc(c.message)}</span>
                    <span class="git-commit-date">${esc(c.date)}</span></div>`;
            }
            h += `</div></div>`;
        }
    }

    // Remote config
    h += `<div class="git-section git-remote-section"><div class="git-section-header"><span>REMOTE</span></div>
        <div class="git-remote-config">
            <input type="text" id="git-remote-input" class="git-remote-input" placeholder="https://github.com/user/repo.git" value="${esc(remote)}">
            <button class="git-btn" id="git-remote-save-btn">Set</button>
        </div></div>`;

    return h;
}

// ── GITHUB VIEW ──

function renderGitHubView(): string {
    // Not signed in — show landing or device flow
    if (!ghConfig) {
        if (ghView === 'device-pending') {
            return renderDevicePending();
        }
        return renderGitHubLanding();
    }

    // Signed in — show account + sub-views
    let h = `<div class="git-section gh-account-section">
        <div class="gh-account-row">
            <img class="gh-avatar" src="${esc(ghConfig.avatarUrl)}" alt="" onerror="this.style.display='none'">
            <div class="gh-account-info">
                <div class="gh-account-name">${esc(ghConfig.name)}</div>
                <div class="gh-account-user">@${esc(ghConfig.username)}</div>
            </div>
            <button class="git-btn gh-logout-btn" id="gh-logout-btn" title="Sign out">✕</button>
        </div>
    </div>`;

    // GitHub action buttons
    h += `<div class="git-section git-actions-row gh-actions-wrap">
        <button class="git-btn ${ghView === 'repos' ? 'git-btn-active' : ''}" id="gh-repos-btn">📂 Repos</button>
        <button class="git-btn ${ghView === 'files' ? 'git-btn-active' : ''}" id="gh-files-btn">📄 Files</button>
        <button class="git-btn ${ghView === 'clone' ? 'git-btn-active' : ''}" id="gh-clone-btn">⬇ Clone</button>
        <button class="git-btn" id="gh-new-repo-btn">+ New</button>
    </div>`;

    // Sub-views
    if (ghView === 'repos') {
        h += renderRepoList();
    } else if (ghView === 'clone') {
        h += renderCloneView();
    } else if (ghView === 'files') {
        h += renderFileManager();
    } else {
        // Default GitHub landing — quick stats
        h += renderGitHubHome();
    }

    return h;
}

function renderGitHubLanding(): string {
    return `<div class="gh-landing">
        <div class="gh-landing-icon">
            <svg viewBox="0 0 16 16" width="48" height="48" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
        </div>
        <div class="gh-landing-title">GitHub Integration</div>
        <div class="gh-landing-desc">Upload, view, edit, and create files in your repos — all from within Nexia IDE. Sign in to get started.</div>
        <div class="gh-landing-features">
            <div class="gh-landing-feature">📂 Browse & manage repo files</div>
            <div class="gh-landing-feature">✏️ Edit & commit directly</div>
            <div class="gh-landing-feature">⬆️ Upload files to any repo</div>
            <div class="gh-landing-feature">🔄 Push, pull & sync projects</div>
        </div>
        <button class="gh-signin-btn" id="gh-signin-start-btn">
            <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" style="margin-right:8px"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
            Sign In with GitHub
        </button>
    </div>`;
}

function renderDevicePending(): string {
    if (!ghUserCode) {
        // Still requesting the code
        return `<div class="gh-device-panel">
            <div class="gh-device-header">
                <svg viewBox="0 0 16 16" width="36" height="36" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
                <div class="gh-device-title">Connecting to GitHub...</div>
            </div>
            <div class="gh-device-spinner"></div>
        </div>`;
    }

    return `<div class="gh-device-panel">
        <button class="gh-signin-back" id="gh-device-cancel">← Cancel</button>
        <div class="gh-device-header">
            <svg viewBox="0 0 16 16" width="36" height="36" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
            <div class="gh-device-title">Sign in to GitHub</div>
        </div>

        <div class="gh-device-instructions">
            Enter this code on GitHub to authorize Nexia IDE:
        </div>

        <div class="gh-device-code-box">
            <div class="gh-device-code" id="gh-device-code">${esc(ghUserCode)}</div>
            <button class="gh-device-copy" id="gh-device-copy-btn" title="Copy code">📋</button>
        </div>

        <button class="gh-signin-btn" id="gh-device-open-btn">
            🌐 Open GitHub & Authorize
        </button>

        <div class="gh-device-waiting">
            <div class="gh-device-spinner"></div>
            <div class="gh-device-waiting-text">Waiting for authorization...</div>
            <div class="gh-device-waiting-hint">Complete the sign-in on GitHub, then return here. This page will update automatically.</div>
        </div>
    </div>`;
}

function renderGitHubHome(): string {
    let h = '';
    // Quick link: if current project has a GitHub remote, show it
    const proj = _getCurrentProject();
    if (proj && isGitRepo()) {
        const remote = getRemoteUrl();
        const ghMatch = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
        if (ghMatch) {
            h += `<div class="git-section gh-linked-repo">
                <div class="git-section-header"><span>LINKED REPOSITORY</span></div>
                <div class="gh-repo-card gh-repo-linked">
                    <div class="gh-repo-name">📦 ${esc(ghMatch[1])}</div>
                    <div class="gh-repo-url">${esc(remote)}</div>
                    <div class="gh-repo-actions-row">
                        <button class="git-btn" id="gh-open-remote-btn">🌐 Open on GitHub</button>
                        <button class="git-btn" id="gh-sync-btn">🔄 Sync</button>
                    </div>
                </div>
            </div>`;
        }
    }

    h += `<div class="git-section gh-tip">
        <div class="gh-tip-text">Use <strong>My Repos</strong> to browse your repositories, <strong>Clone</strong> to pull down a repo, or <strong>New Repo</strong> to create one on GitHub.</div>
    </div>`;

    return h;
}

function renderRepoList(): string {
    let h = `<div class="git-section" id="gh-repo-list-section">
        <div class="git-section-header">
            <span>YOUR REPOSITORIES</span>
            <button class="git-section-action" id="gh-repos-refresh" title="Refresh">↻</button>
        </div>
        <input type="text" id="gh-repo-search" class="git-remote-input" placeholder="Filter repos..." style="margin-bottom:6px">
        <div id="gh-repo-list" class="gh-repo-list">`;

    if (ghRepoCache.length === 0) {
        h += `<div class="gh-repo-loading">Loading repositories...</div>`;
    } else {
        for (const repo of ghRepoCache) {
            const isPrivate = repo.private;
            h += `<div class="gh-repo-card" data-clone-url="${esc(repo.clone_url)}" data-full-name="${esc(repo.full_name)}">
                <div class="gh-repo-top">
                    <span class="gh-repo-name">${esc(repo.name)}</span>
                    <span class="gh-repo-vis">${isPrivate ? '🔒' : '🌐'}</span>
                </div>
                ${repo.description ? `<div class="gh-repo-desc">${esc(repo.description)}</div>` : ''}
                <div class="gh-repo-meta">
                    ${repo.language ? `<span class="gh-repo-lang">● ${esc(repo.language)}</span>` : ''}
                    <span class="gh-repo-stars">★ ${repo.stargazers_count || 0}</span>
                    <span class="gh-repo-updated">${formatGhDate(repo.updated_at)}</span>
                </div>
                <div class="gh-repo-actions-row">
                    <button class="git-btn gh-repo-clone-btn" data-url="${esc(repo.clone_url)}" data-name="${esc(repo.name)}">Clone</button>
                    <button class="git-btn gh-repo-browse-btn" data-fullname="${esc(repo.full_name)}" data-branch="${esc(repo.default_branch || 'main')}">Browse</button>
                    <button class="git-btn gh-repo-link-btn" data-url="${esc(repo.clone_url)}">Link</button>
                    <button class="git-btn gh-repo-open-btn" data-url="${esc(repo.html_url)}">Open</button>
                </div>
            </div>`;
        }
    }
    h += `</div></div>`;
    return h;
}

function renderCloneView(): string {
    return `<div class="git-section">
        <div class="git-section-header"><span>CLONE REPOSITORY</span></div>
        <label class="gh-label">Repository URL</label>
        <input type="text" id="gh-clone-url" class="git-remote-input" placeholder="https://github.com/user/repo.git">
        <label class="gh-label" style="margin-top:8px">Clone Into</label>
        <div class="git-remote-config">
            <input type="text" id="gh-clone-dir" class="git-remote-input" placeholder="Directory..." value="${esc(getDefaultCloneDir())}">
            <button class="git-btn" id="gh-clone-browse-btn">...</button>
        </div>
        <button class="git-btn git-btn-primary git-btn-full" id="gh-clone-go-btn" style="margin-top:10px">Clone Repository</button>
        <div id="gh-clone-status" class="gh-clone-status hidden"></div>
    </div>`;
}

// ── FILE MANAGER VIEW ──

function renderFileManager(): string {
    let h = '';

    // Repo selector if no repo chosen yet
    if (!ghFmRepo) {
        h += `<div class="git-section">
            <div class="git-section-header"><span>SELECT REPOSITORY</span></div>
            <label class="gh-label">Repository (owner/name)</label>
            <div class="git-remote-config">
                <input type="text" id="gh-fm-repo-input" class="git-remote-input" placeholder="username/repo">
                <button class="git-btn git-btn-primary" id="gh-fm-repo-go">Open</button>
            </div>`;
        // Quick-pick from cached repos
        if (ghRepoCache.length > 0) {
            h += `<div class="gh-fm-quick-repos">`;
            for (const repo of ghRepoCache.slice(0, 8)) {
                h += `<button class="gh-fm-quick-repo" data-fullname="${esc(repo.full_name)}" data-branch="${esc(repo.default_branch || 'main')}">${esc(repo.name)}</button>`;
            }
            h += `</div>`;
        } else {
            h += `<div class="gh-fm-hint">Or click <strong>Repos</strong> first to load your repositories for quick access</div>`;
        }
        h += `</div>`;
        return h;
    }

    // ── Viewing a file ──
    if (ghFmViewingFile) {
        return renderFileViewer();
    }

    // ── Breadcrumb / path bar ──
    h += `<div class="git-section gh-fm-header">
        <div class="gh-fm-repo-label">
            <span class="gh-fm-repo-name">${esc(ghFmRepo)}</span>
            <span class="gh-fm-branch-badge">${esc(ghFmBranch)}</span>
            <button class="git-btn gh-fm-close-repo" id="gh-fm-close" title="Close repo">✕</button>
        </div>
        <div class="gh-fm-breadcrumb" id="gh-fm-breadcrumb">
            <button class="gh-fm-crumb" data-path="">📦 root</button>${buildBreadcrumbs(ghFmPath)}
        </div>
    </div>`;

    // ── Actions bar ──
    h += `<div class="git-section gh-fm-actions-bar">
        <button class="git-btn" id="gh-fm-upload-btn">⬆ Upload File</button>
        <button class="git-btn" id="gh-fm-new-file-btn">+ New File</button>
        ${ghFmPath ? `<button class="git-btn" id="gh-fm-up-btn">↑ Up</button>` : ''}
    </div>`;

    // ── File listing ──
    h += `<div class="git-section gh-fm-file-section">
        <div id="gh-fm-file-list" class="gh-fm-file-list">`;

    if (ghFmContents.length === 0) {
        h += `<div class="gh-repo-loading" id="gh-fm-loading">Loading...</div>`;
    } else {
        // Sort: directories first, then files
        const sorted = [...ghFmContents].sort((a, b) => {
            if (a.type === 'dir' && b.type !== 'dir') return -1;
            if (a.type !== 'dir' && b.type === 'dir') return 1;
            return a.name.localeCompare(b.name);
        });
        for (const item of sorted) {
            const icon = item.type === 'dir' ? '📁' : getFileIcon(item.name);
            const sizeStr = item.type === 'file' && item.size != null ? formatSize(item.size) : '';
            h += `<div class="gh-fm-entry ${item.type === 'dir' ? 'gh-fm-dir' : 'gh-fm-file'}" data-path="${esc(item.path)}" data-type="${item.type}" data-sha="${esc(item.sha || '')}">
                <span class="gh-fm-icon">${icon}</span>
                <span class="gh-fm-name">${esc(item.name)}</span>
                <span class="gh-fm-size">${sizeStr}</span>
                ${item.type === 'file' ? `<button class="gh-fm-entry-action gh-fm-delete-btn" data-path="${esc(item.path)}" data-sha="${esc(item.sha || '')}" title="Delete">🗑</button>` : ''}
            </div>`;
        }
    }
    h += `</div></div>`;
    return h;
}

function renderFileViewer(): string {
    const f = ghFmViewingFile!;
    const fileName = f.path.split('/').pop() || f.path;
    const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '';
    const isText = isTextFile(ext);
    const isImage = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'bmp', 'webp'].includes(ext);

    let h = `<div class="git-section gh-fm-header">
        <div class="gh-fm-repo-label">
            <span class="gh-fm-repo-name">${esc(ghFmRepo)}</span>
            <span class="gh-fm-branch-badge">${esc(ghFmBranch)}</span>
        </div>
        <div class="gh-fm-breadcrumb">
            <button class="gh-fm-crumb" data-path="">📦 root</button>${buildBreadcrumbs(f.path)}
        </div>
    </div>`;

    h += `<div class="git-section gh-fm-viewer-actions">
        <button class="git-btn" id="gh-fm-back-btn">← Back</button>
        <span class="gh-fm-file-title">${esc(fileName)}</span>`;
    if (isText) {
        if (ghFmEditing) {
            h += `<button class="git-btn git-btn-primary" id="gh-fm-save-btn">💾 Save & Commit</button>
                  <button class="git-btn" id="gh-fm-cancel-edit-btn">Cancel</button>`;
        } else {
            h += `<button class="git-btn" id="gh-fm-edit-btn">✏ Edit</button>`;
        }
    }
    h += `<button class="git-btn" id="gh-fm-download-btn">⬇ Download</button>
    </div>`;

    if (isImage) {
        // Show image preview
        const imgSrc = f.encoding === 'base64'
            ? `data:image/${ext === 'svg' ? 'svg+xml' : ext};base64,${f.content}`
            : f.content;
        h += `<div class="git-section gh-fm-image-preview"><img src="${imgSrc}" alt="${esc(fileName)}"></div>`;
    } else if (isText) {
        if (ghFmEditing) {
            h += `<div class="git-section gh-fm-editor-section">
                <textarea id="gh-fm-editor" class="gh-fm-editor">${esc(f.content)}</textarea>
                <div class="gh-fm-commit-row">
                    <input type="text" id="gh-fm-commit-msg" class="git-remote-input" placeholder="Commit message..." value="Update ${esc(fileName)}">
                </div>
            </div>`;
        } else {
            h += `<div class="git-section gh-fm-code-section"><pre class="gh-fm-code">${esc(f.content)}</pre></div>`;
        }
    } else {
        h += `<div class="git-section gh-fm-binary-msg">Binary file (${formatSize(f.content.length)}). Click Download to save.</div>`;
    }

    return h;
}

function buildBreadcrumbs(path: string): string {
    if (!path) return '';
    const parts = path.split('/');
    let h = '';
    let accumulated = '';
    for (let i = 0; i < parts.length; i++) {
        accumulated += (i > 0 ? '/' : '') + parts[i];
        const isLast = i === parts.length - 1;
        h += `<span class="gh-fm-crumb-sep">/</span>`;
        if (isLast) {
            h += `<span class="gh-fm-crumb-current">${esc(parts[i])}</span>`;
        } else {
            h += `<button class="gh-fm-crumb" data-path="${esc(accumulated)}">${esc(parts[i])}</button>`;
        }
    }
    return h;
}

function getFileIcon(name: string): string {
    const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
    const map: Record<string, string> = {
        'cpp': '📄', 'c': '📄', 'h': '📄', 'hpp': '📄',
        'ts': '📜', 'js': '📜', 'json': '📋',
        'md': '📝', 'txt': '📝', 'cfg': '⚙',
        'png': '🖼', 'jpg': '🖼', 'jpeg': '🖼', 'gif': '🖼', 'svg': '🖼', 'bmp': '🖼',
        'hlsl': '✨', 'fx': '✨', 'fxh': '✨',
        'bat': '⚡', 'cmd': '⚡', 'ps1': '⚡', 'sh': '⚡',
        'xml': '📋', 'html': '🌐', 'css': '🎨',
        'zip': '📦', 'exe': '🔧', 'dll': '🔧', 'lib': '🔧',
        'xex': '🎮', 'xbe': '🎮',
    };
    return map[ext] || '📄';
}

function isTextFile(ext: string): boolean {
    const textExts = ['c', 'cpp', 'h', 'hpp', 'cc', 'cxx', 'hxx', 'inl',
        'ts', 'js', 'jsx', 'tsx', 'json', 'md', 'txt', 'cfg', 'ini', 'yml', 'yaml',
        'xml', 'html', 'htm', 'css', 'scss', 'less', 'bat', 'cmd', 'ps1', 'sh',
        'hlsl', 'fx', 'fxh', 'glsl', 'vert', 'frag', 'py', 'rb', 'rs', 'go',
        'java', 'cs', 'lua', 'cmake', 'makefile', 'gitignore', 'editorconfig',
        'toml', 'lock', 'log', 'csv', 'svg', 'vcxproj', 'sln', 'props', 'targets'];
    return textExts.includes(ext) || ext === '';
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
}

function getDefaultCloneDir(): string {
    try {
        const docs = nodePath.join(nodeOs.homedir(), 'Documents', 'Nexia IDE', 'Projects');
        return docs;
    } catch { return ''; }
}

function formatGhDate(iso: string): string {
    try {
        const d = new Date(iso);
        const now = Date.now();
        const diff = now - d.getTime();
        const days = Math.floor(diff / 86400000);
        if (days === 0) return 'today';
        if (days === 1) return 'yesterday';
        if (days < 30) return `${days}d ago`;
        if (days < 365) return `${Math.floor(days / 30)}mo ago`;
        return `${Math.floor(days / 365)}y ago`;
    } catch { return ''; }
}

// ══════════════════════════════════════════
//  EVENT WIRING
// ══════════════════════════════════════════

function wireGitEvents(panel: HTMLElement) {
    // Tab switching
    panel.querySelectorAll('.git-tab').forEach((btn: any) => {
        btn.addEventListener('click', () => {
            // When the GitHub tab is selected we always switch to the 'github' view;
            // renderGitHubView() itself falls back to the sign-in landing page when
            // ghConfig is absent. (Previously both ternary branches were 'github'.)
            ghView = btn.dataset.view === 'github' ? 'github' : 'local';
            renderGitPanel();
        });
    });

    // ── LOCAL VIEW EVENTS ──
    _$('git-init-btn')?.addEventListener('click', () => {
        try {
            gitExec('git init'); gitExec('git add -A');
            gitExec('git commit -m "Initial commit — Nexia IDE project"');
            showGitToast('Repository initialized!', 'success');
        } catch (err: any) { showGitToast(`Init failed: ${err.message}`, 'error'); }
        renderGitPanel();
    });

    _$('git-commit-btn')?.addEventListener('click', () => {
        const msg = (_$('git-commit-msg') as HTMLTextAreaElement)?.value.trim();
        if (!msg) { (_$('git-commit-msg') as HTMLTextAreaElement)?.focus(); return; }
        try {
            const changes = getChangedFiles();
            if (changes.filter(f => f.staged).length === 0) gitExec('git add -A');
            gitExec(`git commit -m "${msg.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
            showGitToast('Committed!', 'success');
            renderGitPanel();
        } catch (err: any) { showGitToast(`Commit failed: ${err.message}`, 'error'); }
    });

    _$('git-commit-msg')?.addEventListener('keydown', (e: Event) => {
        const ke = e as KeyboardEvent;
        if (ke.key === 'Enter' && ke.ctrlKey) { ke.preventDefault(); _$('git-commit-btn')?.click(); }
    });

    _$('git-push-btn')?.addEventListener('click', () => doPush());
    _$('git-pull-btn')?.addEventListener('click', () => doPull());

    _$('git-stash-btn')?.addEventListener('click', () => {
        try { gitExec('git stash'); showGitToast('Changes stashed', 'success'); renderGitPanel(); }
        catch (err: any) { showGitToast(`Stash failed: ${err.message}`, 'error'); }
    });

    // Stage / unstage individual
    panel.querySelectorAll('.git-file-action').forEach((btn: any) => {
        btn.addEventListener('click', (e: Event) => {
            e.stopPropagation();
            try {
                if (btn.dataset.action === 'stage') gitExec(`git add "${btn.dataset.file}"`);
                else gitExec(`git reset HEAD "${btn.dataset.file}"`);
                renderGitPanel();
            } catch (err: any) { showGitToast(`Failed: ${err.message}`, 'error'); }
        });
    });

    _$('git-stage-all')?.addEventListener('click', () => {
        try { gitExec('git add -A'); renderGitPanel(); }
        catch (err: any) { showGitToast(`Stage failed: ${err.message}`, 'error'); }
    });
    _$('git-unstage-all')?.addEventListener('click', () => {
        try { gitExec('git reset HEAD'); renderGitPanel(); }
        catch (err: any) { showGitToast(`Unstage failed: ${err.message}`, 'error'); }
    });

    _$('git-remote-save-btn')?.addEventListener('click', () => {
        const url = (_$('git-remote-input') as HTMLInputElement)?.value.trim();
        if (!url) return;
        try {
            try { gitExec('git remote remove origin'); } catch {}
            gitExec(`git remote add origin ${url}`);
            showGitToast(`Remote set to: ${url}`, 'success');
            renderGitPanel();
        } catch (err: any) { showGitToast(`Failed: ${err.message}`, 'error'); }
    });

    // ── GITHUB VIEW EVENTS ──

    // Landing page → start device flow
    _$('gh-signin-start-btn')?.addEventListener('click', () => {
        startDeviceFlow();
    });

    // Device flow: cancel
    _$('gh-device-cancel')?.addEventListener('click', () => {
        cancelDeviceFlow();
    });

    // Device flow: copy code
    _$('gh-device-copy-btn')?.addEventListener('click', () => {
        try {
            require('electron').clipboard.writeText(ghUserCode);
            showGitToast('Code copied!', 'success');
        } catch {
            // Fallback
            try { navigator.clipboard.writeText(ghUserCode); showGitToast('Code copied!', 'success'); } catch {}
        }
    });

    // Device flow: open GitHub verification page
    _$('gh-device-open-btn')?.addEventListener('click', () => {
        try { require('electron').shell.openExternal(ghVerificationUri || 'https://github.com/login/device'); } catch {}
    });

    // Logout
    _$('gh-logout-btn')?.addEventListener('click', () => {
        logoutGitHub();
        showGitToast('Signed out of GitHub', 'info');
        ghView = 'github';
        renderGitPanel();
    });

    // Sub-view buttons
    _$('gh-repos-btn')?.addEventListener('click', async () => {
        ghView = 'repos';
        renderGitPanel();
        await fetchRepos();
    });
    _$('gh-clone-btn')?.addEventListener('click', () => { ghView = 'clone'; renderGitPanel(); });
    _$('gh-files-btn')?.addEventListener('click', () => {
        ghView = 'files';
        // If we already have a repo selected, keep it; otherwise show picker
        renderGitPanel();
        if (ghFmRepo && ghFmContents.length === 0) fetchRepoContents(ghFmRepo, ghFmBranch, ghFmPath);
    });

    // New repo
    _$('gh-new-repo-btn')?.addEventListener('click', () => showNewRepoDialog());

    // Repo list refresh
    _$('gh-repos-refresh')?.addEventListener('click', () => fetchRepos());

    // Repo search/filter
    _$('gh-repo-search')?.addEventListener('input', () => {
        const q = ((_$('gh-repo-search') as HTMLInputElement)?.value || '').toLowerCase();
        panel.querySelectorAll('.gh-repo-card').forEach((card: any) => {
            const name = (card.dataset.fullName || '').toLowerCase();
            card.style.display = name.includes(q) ? '' : 'none';
        });
    });

    // Repo card actions
    panel.querySelectorAll('.gh-repo-clone-btn').forEach((btn: any) => {
        btn.addEventListener('click', (e: Event) => {
            e.stopPropagation();
            ghView = 'clone';
            renderGitPanel();
            setTimeout(() => {
                const input = _$('gh-clone-url') as HTMLInputElement;
                if (input) input.value = btn.dataset.url;
            }, 50);
        });
    });

    panel.querySelectorAll('.gh-repo-browse-btn').forEach((btn: any) => {
        btn.addEventListener('click', (e: Event) => {
            e.stopPropagation();
            ghFmRepo = btn.dataset.fullname;
            ghFmBranch = btn.dataset.branch || 'main';
            ghFmPath = '';
            ghFmViewingFile = null;
            ghFmEditing = false;
            ghView = 'files';
            renderGitPanel();
            fetchRepoContents(ghFmRepo, ghFmBranch, '');
        });
    });

    panel.querySelectorAll('.gh-repo-link-btn').forEach((btn: any) => {
        btn.addEventListener('click', (e: Event) => {
            e.stopPropagation();
            if (!_getCurrentProject()) { showGitToast('No project open', 'error'); return; }
            if (!isGitRepo()) {
                try { gitExec('git init'); } catch {}
            }
            const url = btn.dataset.url;
            try {
                try { gitExec('git remote remove origin'); } catch {}
                gitExec(`git remote add origin ${url}`);
                showGitToast('Remote linked!', 'success');
                ghView = 'local';
                renderGitPanel();
            } catch (err: any) { showGitToast(`Failed: ${err.message}`, 'error'); }
        });
    });

    panel.querySelectorAll('.gh-repo-open-btn').forEach((btn: any) => {
        btn.addEventListener('click', (e: Event) => {
            e.stopPropagation();
            try { require('electron').shell.openExternal(btn.dataset.url); } catch {}
        });
    });

    // Clone
    _$('gh-clone-browse-btn')?.addEventListener('click', async () => {
        try {
            const ipcRenderer = require('electron').ipcRenderer;
            const dir = await ipcRenderer.invoke('file:selectDir');
            if (dir) (_$('gh-clone-dir') as HTMLInputElement).value = dir;
        } catch {}
    });

    _$('gh-clone-go-btn')?.addEventListener('click', () => doClone());

    // Open linked repo on GitHub
    _$('gh-open-remote-btn')?.addEventListener('click', () => {
        const remote = getRemoteUrl();
        let url = remote.replace(/\.git$/, '');
        if (url.includes('@')) url = 'https://github.com/' + url.split(':').pop()?.replace('.git', '');
        try { require('electron').shell.openExternal(url); } catch {}
    });

    // Sync (pull + push)
    _$('gh-sync-btn')?.addEventListener('click', async () => {
        await doPull();
        await doPush();
    });

    // ── FILE MANAGER EVENTS ──

    // Repo selector
    _$('gh-fm-repo-go')?.addEventListener('click', () => {
        const input = (_$('gh-fm-repo-input') as HTMLInputElement)?.value.trim();
        if (!input) return;
        ghFmRepo = input;
        ghFmBranch = 'main';
        ghFmPath = '';
        ghFmViewingFile = null;
        ghFmEditing = false;
        renderGitPanel();
        fetchRepoContents(ghFmRepo, ghFmBranch, '');
    });

    // Quick repo picker
    panel.querySelectorAll('.gh-fm-quick-repo').forEach((btn: any) => {
        btn.addEventListener('click', () => {
            ghFmRepo = btn.dataset.fullname;
            ghFmBranch = btn.dataset.branch || 'main';
            ghFmPath = '';
            ghFmViewingFile = null;
            ghFmEditing = false;
            renderGitPanel();
            fetchRepoContents(ghFmRepo, ghFmBranch, '');
        });
    });

    // Close repo
    _$('gh-fm-close')?.addEventListener('click', () => {
        ghFmRepo = '';
        ghFmContents = [];
        ghFmViewingFile = null;
        ghFmEditing = false;
        renderGitPanel();
    });

    // Breadcrumb navigation
    panel.querySelectorAll('.gh-fm-crumb').forEach((btn: any) => {
        btn.addEventListener('click', () => {
            ghFmPath = btn.dataset.path || '';
            ghFmViewingFile = null;
            ghFmEditing = false;
            renderGitPanel();
            fetchRepoContents(ghFmRepo, ghFmBranch, ghFmPath);
        });
    });

    // Up button
    _$('gh-fm-up-btn')?.addEventListener('click', () => {
        const parts = ghFmPath.split('/');
        parts.pop();
        ghFmPath = parts.join('/');
        ghFmViewingFile = null;
        ghFmEditing = false;
        renderGitPanel();
        fetchRepoContents(ghFmRepo, ghFmBranch, ghFmPath);
    });

    // Click file/directory entries
    panel.querySelectorAll('.gh-fm-entry').forEach((entry: any) => {
        entry.addEventListener('click', (e: Event) => {
            if ((e.target as HTMLElement).closest('.gh-fm-delete-btn')) return;
            const path = entry.dataset.path;
            const type = entry.dataset.type;
            if (type === 'dir') {
                ghFmPath = path;
                ghFmViewingFile = null;
                ghFmEditing = false;
                renderGitPanel();
                fetchRepoContents(ghFmRepo, ghFmBranch, path);
            } else {
                fetchFileContent(path);
            }
        });
    });

    // Delete file
    panel.querySelectorAll('.gh-fm-delete-btn').forEach((btn: any) => {
        btn.addEventListener('click', (e: Event) => {
            e.stopPropagation();
            const path = btn.dataset.path;
            const sha = btn.dataset.sha;
            if (!confirm(`Delete ${path}?`)) return;
            deleteRemoteFile(path, sha);
        });
    });

    // Upload file
    _$('gh-fm-upload-btn')?.addEventListener('click', () => showUploadDialog());

    // New file
    _$('gh-fm-new-file-btn')?.addEventListener('click', () => showNewFileDialog());

    // File viewer: back
    _$('gh-fm-back-btn')?.addEventListener('click', () => {
        ghFmViewingFile = null;
        ghFmEditing = false;
        renderGitPanel();
    });

    // File viewer: edit
    _$('gh-fm-edit-btn')?.addEventListener('click', () => {
        ghFmEditing = true;
        renderGitPanel();
    });

    // File viewer: cancel edit
    _$('gh-fm-cancel-edit-btn')?.addEventListener('click', () => {
        ghFmEditing = false;
        renderGitPanel();
    });

    // File viewer: save & commit
    _$('gh-fm-save-btn')?.addEventListener('click', () => {
        const content = (_$('gh-fm-editor') as HTMLTextAreaElement)?.value || '';
        const msg = (_$('gh-fm-commit-msg') as HTMLInputElement)?.value.trim() || `Update ${ghFmViewingFile!.path}`;
        saveRemoteFile(ghFmViewingFile!.path, content, ghFmViewingFile!.sha, msg);
    });

    // File viewer: download
    _$('gh-fm-download-btn')?.addEventListener('click', () => {
        if (!ghFmViewingFile) return;
        downloadFile(ghFmViewingFile);
    });

    // Refresh
    _$('git-refresh-btn')?.addEventListener('click', () => renderGitPanel());
}

// ══════════════════════════════════════════
//  PUSH / PULL WITH TOKEN AUTH
// ══════════════════════════════════════════

function doPush() {
    if (!_getCurrentProject()) { showGitToast('No project open', 'error'); return; }
    const remote = getRemoteUrl();
    const authRemote = getAuthenticatedRemoteUrl(remote);

    try {
        if (authRemote !== remote && remote) {
            // Use authenticated URL temporarily — passed as a discrete argv arg (no shell).
            gitExecArgs(['push', authRemote]);
        } else {
            gitExec('git push');
        }
        showGitToast('Push complete', 'success');
    } catch {
        try {
            const b = getCurrentBranch();
            if (authRemote !== remote && remote) {
                gitExecArgs(['push', '-u', authRemote, b]);
            } else {
                gitExec(`git push -u origin ${b}`);
            }
            showGitToast('Push complete (upstream set)', 'success');
        } catch (err2: any) {
            showGitToast(scrubSecret(`Push failed: ${err2.message}`), 'error');
        }
    }
}

function doPull() {
    if (!_getCurrentProject()) { showGitToast('No project open', 'error'); return; }
    const remote = getRemoteUrl();
    const authRemote = getAuthenticatedRemoteUrl(remote);

    try {
        if (authRemote !== remote && remote) {
            // Authenticated URL passed as a discrete argv arg (no shell).
            gitExecArgs(['pull', authRemote]);
        } else {
            gitExec('git pull');
        }
        showGitToast('Pull complete', 'success');
        renderGitPanel();
    } catch (err: any) {
        showGitToast(scrubSecret(`Pull failed: ${err.message}`), 'error');
    }
}

// ══════════════════════════════════════════
//  GITHUB API ACTIONS
// ══════════════════════════════════════════

async function fetchRepos() {
    try {
        ghRepoCache = await ghApiFetch('/user/repos?sort=updated&per_page=50&affiliation=owner,collaborator');
        renderGitPanel();
    } catch (err: any) {
        showGitToast(`Failed to fetch repos: ${err.message}`, 'error');
    }
}

// ══════════════════════════════════════════
//  FILE MANAGER API
// ══════════════════════════════════════════

async function fetchRepoContents(repo: string, branch: string, path: string) {
    try {
        const endpoint = `/repos/${repo}/contents/${path}${path ? '?' : '?'}ref=${branch}`;
        ghFmContents = await ghApiFetch(endpoint);
        if (!Array.isArray(ghFmContents)) ghFmContents = [ghFmContents];
        renderGitPanel();
    } catch (err: any) {
        showGitToast(`Failed to load: ${err.message}`, 'error');
        ghFmContents = [];
        renderGitPanel();
    }
}

async function fetchFileContent(path: string) {
    try {
        showGitToast('Loading file...', 'info');
        const data = await ghApiFetch(`/repos/${ghFmRepo}/contents/${path}?ref=${ghFmBranch}`);
        let content = '';
        if (data.encoding === 'base64' && data.content) {
            try { content = atob(data.content.replace(/\n/g, '')); } catch { content = data.content; }
        } else {
            content = data.content || '';
        }
        ghFmViewingFile = { path: data.path, content, sha: data.sha, encoding: data.encoding };
        ghFmEditing = false;
        renderGitPanel();
    } catch (err: any) {
        showGitToast(`Failed to load file: ${err.message}`, 'error');
    }
}

async function saveRemoteFile(path: string, content: string, sha: string, message: string) {
    try {
        const encoded = btoa(unescape(encodeURIComponent(content)));
        await ghApiFetch(`/repos/${ghFmRepo}/contents/${path}`, {
            method: 'PUT',
            body: JSON.stringify({ message, content: encoded, sha, branch: ghFmBranch }),
        });
        showGitToast('File saved and committed!', 'success');
        // Refresh the file to get the new SHA
        ghFmEditing = false;
        await fetchFileContent(path);
    } catch (err: any) {
        showGitToast(`Save failed: ${err.message}`, 'error');
    }
}

async function deleteRemoteFile(path: string, sha: string) {
    try {
        await ghApiFetch(`/repos/${ghFmRepo}/contents/${path}`, {
            method: 'DELETE',
            body: JSON.stringify({ message: `Delete ${path}`, sha, branch: ghFmBranch }),
        });
        showGitToast(`Deleted ${path}`, 'success');
        await fetchRepoContents(ghFmRepo, ghFmBranch, ghFmPath);
    } catch (err: any) {
        showGitToast(`Delete failed: ${err.message}`, 'error');
    }
}

async function uploadFileToRepo(path: string, content: string, message: string) {
    try {
        // Check if file already exists (need SHA for update)
        let sha: string | undefined;
        try {
            const existing = await ghApiFetch(`/repos/${ghFmRepo}/contents/${path}?ref=${ghFmBranch}`);
            sha = existing.sha;
        } catch {}
        const body: any = { message, content, branch: ghFmBranch };
        if (sha) body.sha = sha;
        await ghApiFetch(`/repos/${ghFmRepo}/contents/${path}`, {
            method: 'PUT',
            body: JSON.stringify(body),
        });
        showGitToast(`Uploaded ${path.split('/').pop()}!`, 'success');
        await fetchRepoContents(ghFmRepo, ghFmBranch, ghFmPath);
    } catch (err: any) {
        showGitToast(`Upload failed: ${err.message}`, 'error');
    }
}

function showUploadDialog() {
    let overlay = document.getElementById('gh-upload-overlay');
    if (overlay) overlay.remove();

    overlay = document.createElement('div');
    overlay.id = 'gh-upload-overlay';
    overlay.className = 'overlay';
    overlay.innerHTML = `
        <div class="dialog-box dialog-md" style="padding:0">
            <div class="dialog-header" style="display:flex;justify-content:space-between;align-items:center;padding:18px 24px;border-bottom:1px solid var(--border)">
                <h2 style="margin:0;font-size:16px;color:var(--text-bright);font-weight:600">Upload File to ${esc(ghFmRepo)}</h2>
            </div>
            <div style="padding:18px 24px">
                <div class="gh-fm-drop-zone" id="gh-upload-drop">
                    <div class="gh-fm-drop-icon">⬆</div>
                    <div class="gh-fm-drop-text">Click to select or drag & drop a file</div>
                    <input type="file" id="gh-upload-file" style="display:none" multiple>
                </div>
                <div id="gh-upload-selected" class="gh-upload-selected"></div>
                <div class="dialog-field" style="margin-top:12px">
                    <label>Upload path prefix</label>
                    <input type="text" id="gh-upload-path" value="${esc(ghFmPath)}" placeholder="path/to/folder">
                </div>
                <div class="dialog-field">
                    <label>Commit message</label>
                    <input type="text" id="gh-upload-msg" value="Upload files via Nexia IDE">
                </div>
            </div>
            <div class="dialog-buttons" style="padding:14px 24px;border-top:1px solid var(--border);margin-top:0">
                <button class="setup-btn-secondary" id="gh-upload-cancel">Cancel</button>
                <button class="setup-btn-primary" id="gh-upload-go" disabled>Upload</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);

    let selectedFiles: File[] = [];

    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay!.remove(); });
    _$('gh-upload-cancel').addEventListener('click', () => overlay!.remove());

    const dropZone = _$('gh-upload-drop');
    const fileInput = _$('gh-upload-file') as HTMLInputElement;

    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', (e: Event) => { e.preventDefault(); dropZone.classList.add('gh-fm-drop-active'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('gh-fm-drop-active'));
    dropZone.addEventListener('drop', (e: Event) => {
        e.preventDefault();
        dropZone.classList.remove('gh-fm-drop-active');
        const de = e as DragEvent;
        if (de.dataTransfer?.files) {
            selectedFiles = Array.from(de.dataTransfer.files);
            updateSelectedFiles();
        }
    });

    fileInput.addEventListener('change', () => {
        selectedFiles = Array.from(fileInput.files || []);
        updateSelectedFiles();
    });

    function updateSelectedFiles() {
        const el = _$('gh-upload-selected');
        if (selectedFiles.length === 0) {
            el.innerHTML = '';
            (_$('gh-upload-go') as HTMLButtonElement).disabled = true;
            return;
        }
        el.innerHTML = selectedFiles.map(f => `<div class="gh-upload-file-item">📄 ${esc(f.name)} <span class="gh-fm-size">${formatSize(f.size)}</span></div>`).join('');
        (_$('gh-upload-go') as HTMLButtonElement).disabled = false;
    }

    _$('gh-upload-go').addEventListener('click', async () => {
        const prefix = (_$('gh-upload-path') as HTMLInputElement).value.trim();
        const msg = (_$('gh-upload-msg') as HTMLInputElement).value.trim() || 'Upload files via Nexia IDE';
        const btn = _$('gh-upload-go') as HTMLButtonElement;
        btn.textContent = 'Uploading...'; btn.disabled = true;

        for (const file of selectedFiles) {
            try {
                const base64 = await fileToBase64(file);
                const fullPath = prefix ? `${prefix}/${file.name}` : file.name;
                await uploadFileToRepo(fullPath, base64, `${msg} — ${file.name}`);
            } catch (err: any) {
                showGitToast(`Failed to upload ${file.name}: ${err.message}`, 'error');
            }
        }
        overlay!.remove();
    });
}

function showNewFileDialog() {
    let overlay = document.getElementById('gh-newfile-overlay');
    if (overlay) overlay.remove();

    overlay = document.createElement('div');
    overlay.id = 'gh-newfile-overlay';
    overlay.className = 'overlay';
    overlay.innerHTML = `
        <div class="dialog-box dialog-md" style="padding:0">
            <div class="dialog-header" style="display:flex;justify-content:space-between;align-items:center;padding:18px 24px;border-bottom:1px solid var(--border)">
                <h2 style="margin:0;font-size:16px;color:var(--text-bright);font-weight:600">New File in ${esc(ghFmRepo)}</h2>
            </div>
            <div style="padding:18px 24px">
                <div class="dialog-field">
                    <label>File path</label>
                    <input type="text" id="gh-nf-path" placeholder="filename.cpp" value="${esc(ghFmPath ? ghFmPath + '/' : '')}">
                </div>
                <div class="dialog-field">
                    <label>Content</label>
                    <textarea id="gh-nf-content" class="gh-fm-editor" rows="8" placeholder="File content..."></textarea>
                </div>
                <div class="dialog-field">
                    <label>Commit message</label>
                    <input type="text" id="gh-nf-msg" value="Add new file via Nexia IDE">
                </div>
            </div>
            <div class="dialog-buttons" style="padding:14px 24px;border-top:1px solid var(--border);margin-top:0">
                <button class="setup-btn-secondary" id="gh-nf-cancel">Cancel</button>
                <button class="setup-btn-primary" id="gh-nf-create">Create File</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay!.remove(); });
    _$('gh-nf-cancel').addEventListener('click', () => overlay!.remove());
    _$('gh-nf-create').addEventListener('click', async () => {
        const path = (_$('gh-nf-path') as HTMLInputElement).value.trim();
        const content = (_$('gh-nf-content') as HTMLTextAreaElement).value;
        const msg = (_$('gh-nf-msg') as HTMLInputElement).value.trim() || 'Add new file';
        if (!path) { showGitToast('Enter a file path', 'error'); return; }

        const btn = _$('gh-nf-create') as HTMLButtonElement;
        btn.textContent = 'Creating...'; btn.disabled = true;

        try {
            const encoded = btoa(unescape(encodeURIComponent(content)));
            await uploadFileToRepo(path, encoded, msg);
            overlay!.remove();
        } catch (err: any) {
            showGitToast(`Failed: ${err.message}`, 'error');
            btn.textContent = 'Create File'; btn.disabled = false;
        }
    });
}

function downloadFile(file: { path: string; content: string; encoding: string }) {
    try {
        const fileName = file.path.split('/').pop() || 'file';
        const ipcRenderer = require('electron').ipcRenderer;
        // Save to project directory or home
        const proj = _getCurrentProject();
        const destDir = proj ? proj.path : nodePath.join(nodeOs.homedir(), 'Downloads');
        const destPath = nodePath.join(destDir, fileName);
        if (file.encoding === 'base64') {
            nodeFs.writeFileSync(destPath, Buffer.from(file.content, 'base64'));
        } else {
            nodeFs.writeFileSync(destPath, file.content, 'utf-8');
        }
        showGitToast(`Downloaded to ${destPath}`, 'success');
    } catch (err: any) {
        showGitToast(`Download failed: ${err.message}`, 'error');
    }
}

function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = reader.result as string;
            // Strip data URL prefix to get raw base64
            const base64 = result.includes(',') ? result.split(',')[1] : result;
            resolve(base64);
        };
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsDataURL(file);
    });
}

function doClone() {
    let url = (_$('gh-clone-url') as HTMLInputElement)?.value.trim();
    const dir = (_$('gh-clone-dir') as HTMLInputElement)?.value.trim();
    if (!url) { showGitToast('Enter a repository URL', 'error'); return; }
    if (!dir) { showGitToast('Choose a directory', 'error'); return; }

    // Derive the repo name from the original (token-free) URL so the token never
    // ends up in a directory path.
    const repoName = url.replace(/\.git$/, '').split('/').pop() || 'repo';

    // Use authenticated URL if available
    url = getAuthenticatedRemoteUrl(url);

    const targetDir = nodePath.join(dir, repoName);

    const statusEl = _$('gh-clone-status');
    if (statusEl) { statusEl.classList.remove('hidden'); statusEl.textContent = 'Cloning...'; }

    const btn = _$('gh-clone-go-btn') as HTMLButtonElement;
    if (btn) { btn.disabled = true; btn.textContent = 'Cloning...'; }

    try {
        // Ensure parent directory exists
        if (!nodeFs.existsSync(dir)) {
            nodeFs.mkdirSync(dir, { recursive: true });
        }
        // execFileSync with an argv array — no shell, so the token URL is never re-parsed.
        execFileSync('git', ['clone', url, targetDir], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
        showGitToast(`Cloned to ${repoName}!`, 'success');
        if (statusEl) { statusEl.textContent = `✓ Cloned to: ${targetDir}`; statusEl.className = 'gh-clone-status gh-clone-success'; }

        // Offer to open the project
        setTimeout(() => {
            if (statusEl) {
                statusEl.innerHTML = `✓ Cloned! <button class="git-btn git-btn-primary" id="gh-clone-open" style="margin-left:8px">Open Project</button>`;
                _$('gh-clone-open')?.addEventListener('click', () => {
                    try {
                        const ipcRenderer = require('electron').ipcRenderer;
                        ipcRenderer.invoke('project:open', targetDir);
                    } catch {}
                });
            }
        }, 100);
    } catch (err: any) {
        const safeMsg = scrubSecret(err.message);
        showGitToast(`Clone failed: ${safeMsg}`, 'error');
        if (statusEl) { statusEl.textContent = `✗ ${safeMsg}`; statusEl.className = 'gh-clone-status gh-clone-error'; }
    }
    if (btn) { btn.disabled = false; btn.textContent = 'Clone Repository'; }
}

function showNewRepoDialog() {
    // Create an overlay dialog for new repo
    let overlay = document.getElementById('gh-new-repo-overlay');
    if (overlay) overlay.remove();

    overlay = document.createElement('div');
    overlay.id = 'gh-new-repo-overlay';
    overlay.className = 'overlay';
    overlay.innerHTML = `
        <div class="dialog-box dialog-md" style="padding:0">
            <div class="dialog-header" style="display:flex;justify-content:space-between;align-items:center;padding:18px 24px;border-bottom:1px solid var(--border)">
                <h2 style="margin:0;font-size:16px;color:var(--text-bright);font-weight:600">Create GitHub Repository</h2>
            </div>
            <div style="padding:18px 24px">
                <div class="dialog-field">
                    <label>Repository Name</label>
                    <input type="text" id="gh-new-name" placeholder="my-xbox-project" value="${esc(_getCurrentProject()?.name || '')}">
                </div>
                <div class="dialog-field">
                    <label>Description</label>
                    <input type="text" id="gh-new-desc" placeholder="An Xbox 360 project built with Nexia IDE">
                </div>
                <div class="dialog-field" style="display:flex;align-items:center;gap:8px;margin-top:8px">
                    <input type="checkbox" id="gh-new-private" checked>
                    <label for="gh-new-private" style="margin:0;cursor:pointer">Private repository</label>
                </div>
                <div id="gh-new-status" class="gh-clone-status hidden" style="margin-top:8px"></div>
            </div>
            <div class="dialog-buttons" style="padding:14px 24px;border-top:1px solid var(--border);margin-top:0">
                <button class="setup-btn-secondary" id="gh-new-cancel">Cancel</button>
                <button class="setup-btn-primary" id="gh-new-create">Create Repository</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay!.remove(); });
    _$('gh-new-cancel').addEventListener('click', () => overlay!.remove());
    _$('gh-new-create').addEventListener('click', async () => {
        const name = (_$('gh-new-name') as HTMLInputElement).value.trim();
        const desc = (_$('gh-new-desc') as HTMLInputElement).value.trim();
        const isPrivate = (_$('gh-new-private') as HTMLInputElement).checked;
        if (!name) { showGitToast('Enter a repo name', 'error'); return; }

        const btn = _$('gh-new-create') as HTMLButtonElement;
        btn.textContent = 'Creating...'; btn.disabled = true;

        try {
            const repo = await ghApiFetch('/user/repos', {
                method: 'POST',
                body: JSON.stringify({ name, description: desc, private: isPrivate, auto_init: false }),
            });

            showGitToast(`Created ${repo.full_name}!`, 'success');

            // Auto-link to current project if one is open
            const proj = _getCurrentProject();
            if (proj) {
                if (!isGitRepo()) {
                    try { gitExec('git init'); gitExec('git add -A'); gitExec('git commit -m "Initial commit"'); } catch {}
                }
                try { gitExec('git remote remove origin'); } catch {}
                try { gitExec(`git remote add origin ${repo.clone_url}`); } catch {}
                // Push — token URL passed as a discrete argv arg (no shell).
                try {
                    const authUrl = getAuthenticatedRemoteUrl(repo.clone_url);
                    const branch = getCurrentBranch();
                    gitExecArgs(['push', '-u', authUrl, branch]);
                    showGitToast('Pushed to new repo!', 'success');
                } catch {}
            }

            overlay!.remove();
            ghRepoCache = [];
            ghView = 'local';
            renderGitPanel();
        } catch (err: any) {
            showGitToast(`Create failed: ${err.message}`, 'error');
            btn.textContent = 'Create Repository'; btn.disabled = false;
        }
    });
}

// ══════════════════════════════════════════
//  TOAST NOTIFICATIONS
// ══════════════════════════════════════════

function showGitToast(message: string, type: 'success' | 'error' | 'info' = 'info') {
    const existing = document.getElementById('git-toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.id = 'git-toast';
    toast.className = `git-toast git-toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('visible'));
    setTimeout(() => { toast.classList.remove('visible'); setTimeout(() => toast.remove(), 200); }, 3500);
}

// ══════════════════════════════════════════
//  FILE MENU ACTIONS (legacy)
// ══════════════════════════════════════════

export function gitInit() {
    if (!_getCurrentProject()) { showGitToast('No project open', 'error'); return; }
    try {
        gitExec('git init'); gitExec('git add -A');
        gitExec('git commit -m "Initial commit — Nexia IDE project"');
        showGitToast('Repository initialized!', 'success');
        renderGitPanel();
    } catch (err: any) { showGitToast(`Git init failed: ${err.message}`, 'error'); }
}

export function gitCommit() {
    if (!_getCurrentProject()) { showGitToast('No project open', 'error'); return; }
    ghView = 'local';
    const tab = document.querySelector('.sidebar-tab[data-panel="git"]') as HTMLElement;
    if (tab) tab.click();
    setTimeout(() => { (_$('git-commit-msg') as HTMLTextAreaElement)?.focus(); }, 100);
}

export function gitPush() {
    if (!_getCurrentProject()) { showGitToast('No project open', 'error'); return; }
    doPush();
}

export function gitSetRemote() {
    if (!_getCurrentProject()) { showGitToast('No project open', 'error'); return; }
    ghView = 'local';
    const tab = document.querySelector('.sidebar-tab[data-panel="git"]') as HTMLElement;
    if (tab) tab.click();
    setTimeout(() => { (_$('git-remote-input') as HTMLInputElement)?.focus(); }, 100);
}

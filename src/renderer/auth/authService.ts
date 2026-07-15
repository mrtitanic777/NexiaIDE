/**
 * authService.ts — Authentication client for Nexia IDE
 *
 * Communicates with the Nexia auth server (Node.js/Express).
 * Manages JWT tokens, user sessions, and role checking.
 *
 * API Contract (server must implement):
 *
 *   POST /api/auth/register   { username, email, password }           → { token, user }
 *   POST /api/auth/login      { email, password }                     → { token, user }
 *   GET  /api/auth/me          Authorization: Bearer <token>          → { user }
 *   POST /api/auth/refresh     Authorization: Bearer <token>          → { token, user }
 *
 *   GET  /api/admin/users      Authorization: Bearer <admin-token>    → { users[] }
 *   POST /api/admin/promote    { userId, role }  + admin token        → { user }
 *   POST /api/admin/demote     { userId }        + admin token        → { user }
 *   DELETE /api/admin/users/:id  admin token                          → { success }
 *
 *   GET  /api/lessons                                                 → { lessons[] }  (public list)
 *   GET  /api/lessons/:id                                             → { lesson }     (full lesson data)
 *   POST /api/lessons           admin token + lesson data             → { lesson }
 *   PUT  /api/lessons/:id       admin token + lesson data             → { lesson }
 *   DELETE /api/lessons/:id     admin token                           → { success }
 *
 * User object shape:
 *   { id, username, email, role: 'user' | 'admin', createdAt, lastLogin }
 *
 * The first registered user is auto-promoted to admin by the server.
 */

// ── Types ──

export interface NexiaUser {
    id: string;
    username: string;
    email: string;
    role: 'user' | 'admin';
    createdAt: string;
    lastLogin: string;
    avatarUrl?: string;
}

export interface AuthResult {
    success: boolean;
    token?: string;
    user?: NexiaUser;
    error?: string;
}

export interface LessonMeta {
    id: string;
    title: string;
    author: string;
    version: string;
    difficulty: string;
    description: string;
    language: string;
    tags: string[];
    createdAt: string;
    updatedAt: string;
}

export type AuthStateListener = (user: NexiaUser | null) => void;
export type ConnectionStateListener = (state: ConnectionState) => void;

export interface ConnectionState {
    connected: boolean;
    serverOnline: boolean;
    authenticated: boolean;
    offlineMode: boolean;
    lastPulse: string | null;
    lastConnected: string | null;   // when we last had a successful connection
    failCount: number;
    serverVersion?: string;
    serverUptime?: number;
    queuedActions: number;          // items waiting to sync
    syncInProgress: boolean;
}

export interface OfflineAction {
    id: string;
    type: 'lesson-progress' | 'quiz-score' | 'flashcard-add' | 'profile-update' | 'custom';
    payload: any;
    timestamp: string;
    synced: boolean;
}

// ── Configuration ──

const DEFAULT_SERVER_URL = 'https://auth.logansreplicas.com';
const TOKEN_STORAGE_KEY = 'nexia_auth_token';
const SERVER_URL_FILE = '.nexia-ide-server.json';
const ACCOUNT_FILE = '.nexia-ide-account.json';

const PULSE_INTERVAL = 60 * 1000;         // 60 seconds
const PULSE_TIMEOUT = 8000;               // 8 second timeout
const PULSE_MAX_FAILURES = 3;             // enter offline mode after 3 failures
const RECONNECT_INTERVAL = 30 * 1000;     // check every 30s while offline
const OFFLINE_QUEUE_FILE = '.nexia-ide-offline-queue.json';

// ── State ──

let _token: string | null = null;
let _user: NexiaUser | null = null;
let _serverUrl: string = DEFAULT_SERVER_URL;
let _listeners: AuthStateListener[] = [];
let _connectionListeners: ConnectionStateListener[] = [];
let _refreshTimer: ReturnType<typeof setInterval> | null = null;
let _pulseTimer: ReturnType<typeof setInterval> | null = null;
let _offlineQueue: OfflineAction[] = [];
let _userSnapshot: NexiaUser | null = null; // cached user for offline mode

let _connectionState: ConnectionState = {
    connected: false,
    serverOnline: false,
    authenticated: false,
    offlineMode: false,
    lastPulse: null,
    lastConnected: null,
    failCount: 0,
    queuedActions: 0,
    syncInProgress: false,
};

// ── Helpers ──

function getStoredToken(): string | null {
    try {
        const fs = require('fs');
        const os = require('os');
        const path = require('path');
        const tokenFile = path.join(os.homedir(), '.nexia-ide-token.json');
        if (fs.existsSync(tokenFile)) {
            const data = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
            return data.token || null;
        }
    } catch {}
    return null;
}

function storeToken(token: string | null) {
    try {
        const fs = require('fs');
        const os = require('os');
        const path = require('path');
        const tokenFile = path.join(os.homedir(), '.nexia-ide-token.json');
        if (token) {
            fs.writeFileSync(tokenFile, JSON.stringify({ token }, null, 2));
        } else {
            if (fs.existsSync(tokenFile)) fs.unlinkSync(tokenFile);
        }
    } catch {}
}

/**
 * Remember who was last signed in — deliberately kept separate from the token
 * so an expired/cleared token doesn't erase the identity. This is what lets the
 * app say "you were last signed in as X" instead of forgetting you entirely.
 * Contains no secrets — just a username/email for the welcome-back prompt.
 */
export interface LastAccount { username: string; email: string; role?: string; savedAt: number; }

function storeLastAccount(user: NexiaUser | null) {
    if (!user) return;
    try {
        const fs = require('fs');
        const os = require('os');
        const path = require('path');
        fs.writeFileSync(
            path.join(os.homedir(), ACCOUNT_FILE),
            JSON.stringify({ username: user.username, email: user.email, role: user.role, savedAt: Date.now() }, null, 2)
        );
    } catch {}
}

/** The last account that was signed in on this machine, if any. */
export function getLastAccount(): LastAccount | null {
    try {
        const fs = require('fs');
        const os = require('os');
        const path = require('path');
        const f = path.join(os.homedir(), ACCOUNT_FILE);
        if (fs.existsSync(f)) {
            const d = JSON.parse(fs.readFileSync(f, 'utf8'));
            if (d && d.username) return d;
        }
    } catch {}
    return null;
}

/** Forget the remembered account (used by "continue without an account"). */
export function clearLastAccount() {
    try {
        const fs = require('fs');
        const os = require('os');
        const path = require('path');
        const f = path.join(os.homedir(), ACCOUNT_FILE);
        if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {}
}

function getStoredServerUrl(): string | null {
    try {
        const fs = require('fs');
        const os = require('os');
        const path = require('path');
        const file = path.join(os.homedir(), SERVER_URL_FILE);
        if (fs.existsSync(file)) {
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            return (typeof data.serverUrl === 'string' && data.serverUrl) ? data.serverUrl : null;
        }
    } catch {}
    return null;
}

function storeServerUrl(url: string | null) {
    try {
        const fs = require('fs');
        const os = require('os');
        const path = require('path');
        const file = path.join(os.homedir(), SERVER_URL_FILE);
        if (url) {
            fs.writeFileSync(file, JSON.stringify({ serverUrl: url }, null, 2));
        } else if (fs.existsSync(file)) {
            fs.unlinkSync(file);
        }
    } catch {}
}

/** Trim whitespace and strip any trailing slash so `_serverUrl + '/api/...'` never double-slashes. */
function normalizeServerUrl(url: string): string {
    return String(url).trim().replace(/\/+$/, '');
}

function notifyListeners() {
    for (const fn of _listeners) {
        try { fn(_user); } catch {}
    }
}

// ── Offline Queue ──

function getQueuePath(): string {
    const os = require('os');
    const path = require('path');
    return path.join(os.homedir(), OFFLINE_QUEUE_FILE);
}

function loadOfflineQueue() {
    try {
        const fs = require('fs');
        const queuePath = getQueuePath();
        if (fs.existsSync(queuePath)) {
            _offlineQueue = JSON.parse(fs.readFileSync(queuePath, 'utf-8'));
        }
    } catch { _offlineQueue = []; }
}

function saveOfflineQueue() {
    try {
        const fs = require('fs');
        fs.writeFileSync(getQueuePath(), JSON.stringify(_offlineQueue, null, 2));
    } catch {}
}

function enterOfflineMode() {
    if (_connectionState.offlineMode) return; // already offline

    // Snapshot the user so we can keep showing their info
    if (_user) _userSnapshot = { ..._user };

    console.warn('[AuthService] Entering offline mode');
    updateConnectionState({
        ..._connectionState,
        offlineMode: true,
        connected: false,
        serverOnline: false,
        queuedActions: _offlineQueue.filter(a => !a.synced).length,
    });

    // Switch to slower reconnect polling
    stopPulse();
    _pulseTimer = setInterval(doPulse, RECONNECT_INTERVAL);
}

async function exitOfflineMode() {
    if (!_connectionState.offlineMode) return;

    console.log('[AuthService] Reconnected — exiting offline mode');

    // Revalidate token first
    if (_token) {
        const result = await apiFetch('/api/auth/me');
        if (result.success && result.user) {
            _user = result.user;
            _userSnapshot = null;
            startRefreshTimer();
            notifyListeners();
        } else {
            // Token expired during offline period — keep user data but clear auth
            _token = null;
            storeToken(null);
            notifyListeners();
        }
    }

    // Sync queued actions
    await syncOfflineQueue();

    updateConnectionState({
        ..._connectionState,
        offlineMode: false,
        connected: _token !== null,
        serverOnline: true,
        authenticated: _token !== null,
        queuedActions: _offlineQueue.filter(a => !a.synced).length,
        syncInProgress: false,
    });

    // Resume normal pulse interval
    stopPulse();
    startPulse();
}

async function syncOfflineQueue() {
    const pending = _offlineQueue.filter(a => !a.synced);
    if (pending.length === 0) return;

    console.log(`[AuthService] Syncing ${pending.length} queued actions...`);
    updateConnectionState({ ..._connectionState, syncInProgress: true });

    for (const action of pending) {
        try {
            let endpoint = '';
            let method = 'POST';
            let body: any = action.payload;

            switch (action.type) {
                case 'lesson-progress':
                    endpoint = '/api/auth/sync/progress';
                    body = { ...action.payload, offlineTimestamp: action.timestamp };
                    break;
                case 'quiz-score':
                    endpoint = '/api/auth/sync/quiz';
                    body = { ...action.payload, offlineTimestamp: action.timestamp };
                    break;
                case 'flashcard-add':
                    endpoint = '/api/auth/sync/flashcard';
                    body = { ...action.payload, offlineTimestamp: action.timestamp };
                    break;
                case 'profile-update':
                    endpoint = '/api/auth/profile';
                    method = 'PUT';
                    break;
                case 'custom':
                    endpoint = action.payload.endpoint || '';
                    method = action.payload.method || 'POST';
                    body = action.payload.data;
                    break;
                default:
                    action.synced = true;
                    continue;
            }

            if (endpoint) {
                const result = await apiFetch(endpoint, {
                    method,
                    body: JSON.stringify(body),
                });
                if (result.success !== false) {
                    action.synced = true;
                }
            }
        } catch {
            // Failed to sync — will retry next time
            console.warn(`[AuthService] Failed to sync action ${action.id}`);
        }
    }

    // Clean up synced actions
    _offlineQueue = _offlineQueue.filter(a => !a.synced);
    saveOfflineQueue();

    const remaining = _offlineQueue.length;
    if (remaining === 0) {
        console.log('[AuthService] All queued actions synced successfully');
    } else {
        console.warn(`[AuthService] ${remaining} actions still pending`);
    }
}

async function apiFetch(endpoint: string, options: RequestInit = {}): Promise<any> {
    const url = _serverUrl + endpoint;
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(options.headers as Record<string, string> || {}),
    };
    if (_token) {
        headers['Authorization'] = 'Bearer ' + _token;
    }

    try {
        const resp = await fetch(url, { ...options, headers });
        const data = await resp.json();

        if (!resp.ok) {
            return { success: false, error: data.error || data.message || `HTTP ${resp.status}` };
        }
        return { success: true, ...data };
    } catch (err: any) {
        return { success: false, error: 'Connection failed: ' + (err.message || err) };
    }
}

// ── Token Refresh ──

function startRefreshTimer() {
    stopRefreshTimer();
    _refreshTimer = setInterval(async () => {
        if (!_token) return;
        const result = await apiFetch('/api/auth/refresh', { method: 'POST' });
        if (result.success && result.token) {
            _token = result.token;
            storeToken(_token);
            if (result.user) _user = result.user;
        }
    }, 50 * 60 * 1000);
}

function stopRefreshTimer() {
    if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
}

// ── Pulse / Heartbeat ──

function startPulse() {
    stopPulse();
    // Run first pulse immediately
    doPulse();
    _pulseTimer = setInterval(doPulse, PULSE_INTERVAL);
}

function stopPulse() {
    if (_pulseTimer) { clearInterval(_pulseTimer); _pulseTimer = null; }
}

async function doPulse() {
    if (!_token && !_userSnapshot) {
        // No token and no offline user — just check if server is online
        try {
            const resp = await fetch(_serverUrl + '/api/health', { signal: AbortSignal.timeout(PULSE_TIMEOUT) });
            if (resp.ok) {
                const data = await resp.json();
                const wasOffline = _connectionState.offlineMode;
                updateConnectionState({
                    ..._connectionState,
                    connected: false, serverOnline: true, authenticated: false,
                    offlineMode: false,
                    lastPulse: new Date().toISOString(), failCount: 0,
                    serverVersion: data.version, serverUptime: data.uptime,
                    queuedActions: _offlineQueue.filter(a => !a.synced).length,
                });
                if (wasOffline) await exitOfflineMode();
            } else {
                pulseFailure();
            }
        } catch {
            pulseFailure();
        }
        return;
    }

    // Has token (or offline snapshot) — do authenticated pulse
    if (!_token && _userSnapshot) {
        // We're in offline mode with a cached user — try health check to see if server is back
        try {
            const resp = await fetch(_serverUrl + '/api/health', { signal: AbortSignal.timeout(PULSE_TIMEOUT) });
            if (resp.ok) {
                // Server is back — exit offline mode (will revalidate token)
                await exitOfflineMode();
            } else {
                pulseFailure();
            }
        } catch {
            pulseFailure();
        }
        return;
    }

    try {
        const resp = await fetch(_serverUrl + '/api/auth/pulse', {
            headers: {
                'Authorization': `Bearer ${_token}`,
                'Accept': 'application/json',
            },
            signal: AbortSignal.timeout(PULSE_TIMEOUT),
        });

        if (resp.ok) {
            const data = await resp.json();
            const wasOffline = _connectionState.offlineMode;

            updateConnectionState({
                ..._connectionState,
                connected: true, serverOnline: true, authenticated: data.authenticated === true,
                offlineMode: false,
                lastPulse: data.timestamp || new Date().toISOString(), failCount: 0,
                lastConnected: new Date().toISOString(),
                serverVersion: data.server?.version, serverUptime: data.server?.uptime,
                queuedActions: _offlineQueue.filter(a => !a.synced).length,
                syncInProgress: false,
            });

            // Update user info if role changed on server
            if (data.user && _user) {
                if (data.user.role !== _user.role || data.user.username !== _user.username) {
                    _user = { ..._user, role: data.user.role, username: data.user.username };
                    notifyListeners();
                }
            }

            // If we just came back online, sync queued actions
            if (wasOffline) {
                _userSnapshot = null;
                await syncOfflineQueue();
                updateConnectionState({
                    ..._connectionState,
                    queuedActions: _offlineQueue.filter(a => !a.synced).length,
                    syncInProgress: false,
                });
            }
        } else if (resp.status === 401) {
            // Token revoked or expired
            console.warn('[AuthService] Pulse: token rejected — logging out');
            updateConnectionState({
                ..._connectionState,
                connected: false, serverOnline: true, authenticated: false,
                offlineMode: false,
                lastPulse: new Date().toISOString(), failCount: 0,
            });
            _token = null;
            _user = null;
            _userSnapshot = null;
            storeToken(null);
            stopRefreshTimer();
            notifyListeners();
        } else {
            pulseFailure();
        }
    } catch {
        pulseFailure();
    }
}

function pulseFailure() {
    const newFails = _connectionState.failCount + 1;
    const wasConnected = _connectionState.connected || _connectionState.authenticated;

    if (newFails >= PULSE_MAX_FAILURES && !_connectionState.offlineMode) {
        // Transition to offline mode
        _connectionState.failCount = newFails;
        enterOfflineMode();
        return;
    }

    updateConnectionState({
        ..._connectionState,
        failCount: newFails,
        connected: newFails < PULSE_MAX_FAILURES && wasConnected,
        serverOnline: false,
        lastPulse: new Date().toISOString(),
    });
}

function updateConnectionState(state: ConnectionState) {
    const changed = JSON.stringify(state) !== JSON.stringify(_connectionState);
    _connectionState = state;
    if (changed) {
        for (const fn of _connectionListeners) {
            try { fn(state); } catch {}
        }
    }
}

// ══════════════════════════════════════
//  PUBLIC API
// ══════════════════════════════════════

/** Get the current server URL. */
export function getServerUrl(): string {
    return _serverUrl;
}

/** Get the compiled-in default server URL (used to offer a "reset" in the UI). */
export function getDefaultServerUrl(): string {
    return DEFAULT_SERVER_URL;
}

/**
 * Set and persist the auth/lesson server URL. Takes effect immediately for
 * all subsequent requests; persisted to ~/.nexia-ide-server.json so it
 * survives restarts. Pass null/empty to clear the override and fall back to
 * the compiled-in default. Returns the normalized URL now in effect.
 */
export function setServerUrl(url: string | null): string {
    const normalized = url ? normalizeServerUrl(url) : '';
    if (normalized) {
        _serverUrl = normalized;
        storeServerUrl(normalized);
    } else {
        _serverUrl = DEFAULT_SERVER_URL;
        storeServerUrl(null);
    }
    return _serverUrl;
}

/** Initialize auth — loads stored token, validates it, starts pulse. */
export async function init(): Promise<NexiaUser | null> {
    // Apply a user-configured server URL (if any) before the first request.
    const storedUrl = getStoredServerUrl();
    if (storedUrl) _serverUrl = normalizeServerUrl(storedUrl);

    _token = getStoredToken();
    loadOfflineQueue();

    if (!_token) {
        startPulse();
        notifyListeners();
        return null;
    }

    // Validate stored token against server
    const result = await apiFetch('/api/auth/me');
    if (result.success && result.user) {
        _user = result.user;
        storeLastAccount(_user);
        startRefreshTimer();
        startPulse();
        notifyListeners();
        return _user;
    } else {
        // Token expired or invalid — server rejected it
        _token = null;
        _user = null;
        storeToken(null);
        startPulse();
        notifyListeners();
        return null;
    }
}

/** Register a new account. */
export async function register(username: string, email: string, password: string): Promise<AuthResult> {
    const result = await apiFetch('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ username, email, password }),
    });

    if (result.success && result.token) {
        _token = result.token;
        _user = result.user;
        storeToken(_token);
        storeLastAccount(_user);
        startRefreshTimer();
        notifyListeners();
    }
    return result;
}

/** Log in with email and password. */
export async function login(email: string, password: string): Promise<AuthResult> {
    const result = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
    });

    if (result.success && result.token) {
        _token = result.token;
        _user = result.user;
        storeToken(_token);
        storeLastAccount(_user);
        startRefreshTimer();
        startPulse();
        notifyListeners();
    }
    return result;
}

/** Log out — clears token, tells server, stops pulse. */
export async function logout() {
    // Tell server to blacklist the token
    if (_token) {
        try { await apiFetch('/api/auth/logout', { method: 'POST' }); } catch {}
    }
    _token = null;
    _user = null;
    storeToken(null);
    stopRefreshTimer();
    updateConnectionState({
        ..._connectionState,
        connected: false, serverOnline: _connectionState.serverOnline,
        authenticated: false, offlineMode: false,
        lastPulse: new Date().toISOString(), failCount: 0,
    });
    notifyListeners();
}

/** Get the currently logged-in user, or null. Returns cached snapshot in offline mode. */
export function getUser(): NexiaUser | null {
    return _user || _userSnapshot;
}

/** Check if the current user is an admin. */
export function isAdmin(): boolean {
    const u = _user || _userSnapshot;
    return u?.role === 'admin';
}

/** Check if any user is logged in (or was logged in before going offline). */
export function isLoggedIn(): boolean {
    return (_user !== null && _token !== null) || (_userSnapshot !== null && _connectionState.offlineMode);
}

/** Subscribe to auth state changes. Returns unsubscribe function. */
export function onAuthStateChange(listener: AuthStateListener): () => void {
    _listeners.push(listener);
    return () => { _listeners = _listeners.filter(l => l !== listener); };
}

/** Get the current JWT token (for custom API calls). */
export function getToken(): string | null {
    return _token;
}

/** Get current connection/pulse state. */
export function getConnectionState(): ConnectionState {
    return { ..._connectionState };
}

/** Subscribe to connection state changes. Returns unsubscribe function. */
export function onConnectionStateChange(listener: ConnectionStateListener): () => void {
    _connectionListeners.push(listener);
    return () => { _connectionListeners = _connectionListeners.filter(l => l !== listener); };
}

/** Force an immediate pulse check. */
export function forcePulse() {
    doPulse();
}

/** Check if currently in offline mode. */
export function isOffline(): boolean {
    return _connectionState.offlineMode;
}

/**
 * Queue an action to sync when back online.
 * Use this from anywhere in the IDE when the server is unreachable.
 */
export function queueOfflineAction(type: OfflineAction['type'], payload: any) {
    const action: OfflineAction = {
        id: require('crypto').randomBytes(8).toString('hex'),
        type,
        payload,
        timestamp: new Date().toISOString(),
        synced: false,
    };
    _offlineQueue.push(action);
    saveOfflineQueue();

    updateConnectionState({
        ..._connectionState,
        queuedActions: _offlineQueue.filter(a => !a.synced).length,
    });

    console.log(`[AuthService] Queued offline action: ${type} (${_offlineQueue.length} total)`);
}

/** Get the number of pending offline actions. */
export function getQueuedActionCount(): number {
    return _offlineQueue.filter(a => !a.synced).length;
}

/** Clear the offline queue (e.g. user chose to discard). */
export function clearOfflineQueue() {
    _offlineQueue = [];
    saveOfflineQueue();
    updateConnectionState({ ..._connectionState, queuedActions: 0 });
}

// ── Admin: User Management ──

export async function getUsers(): Promise<{ success: boolean; users?: NexiaUser[]; error?: string }> {
    return apiFetch('/api/admin/users');
}

export async function promoteUser(userId: string, role: 'admin' | 'user'): Promise<AuthResult> {
    return apiFetch('/api/admin/promote', {
        method: 'POST',
        body: JSON.stringify({ userId, role }),
    });
}

export async function demoteUser(userId: string): Promise<AuthResult> {
    return apiFetch('/api/admin/demote', {
        method: 'POST',
        body: JSON.stringify({ userId }),
    });
}

export async function deleteUser(userId: string): Promise<{ success: boolean; error?: string }> {
    return apiFetch('/api/admin/users/' + userId, { method: 'DELETE' });
}

// ── Cloud Lessons ──

export async function getCloudLessons(): Promise<{ success: boolean; lessons?: LessonMeta[]; error?: string }> {
    return apiFetch('/api/lessons');
}

export async function getCloudLesson(id: string): Promise<{ success: boolean; lesson?: any; error?: string }> {
    return apiFetch('/api/lessons/' + id);
}

export async function publishLesson(lessonData: any): Promise<{ success: boolean; lesson?: LessonMeta; error?: string }> {
    return apiFetch('/api/lessons', {
        method: 'POST',
        body: JSON.stringify(lessonData),
    });
}

export async function updateCloudLesson(id: string, lessonData: any): Promise<{ success: boolean; lesson?: LessonMeta; error?: string }> {
    return apiFetch('/api/lessons/' + id, {
        method: 'PUT',
        body: JSON.stringify(lessonData),
    });
}

export async function deleteCloudLesson(id: string): Promise<{ success: boolean; error?: string }> {
    return apiFetch('/api/lessons/' + id, { method: 'DELETE' });
}

// ── Releases (software updates) ──

/** Fetch the currently published release manifest (public). */
export async function getLatestRelease(): Promise<{ success: boolean; update?: any; error?: string }> {
    return apiFetch('/api/updates/latest');
}

/** Publish a release — this is the "push" that notifies every client. Admin only. */
export async function publishRelease(manifest: any): Promise<{ success: boolean; update?: any; error?: string }> {
    return apiFetch('/api/updates/latest', { method: 'PUT', body: JSON.stringify(manifest) });
}

/** Pull the current release so clients stop being prompted. Admin only. */
export async function clearRelease(): Promise<{ success: boolean; error?: string }> {
    return apiFetch('/api/updates/latest', { method: 'DELETE' });
}

// ── Server Health ──

export async function checkServerHealth(overrideUrl?: string): Promise<{ online: boolean; version?: string }> {
    try {
        const base = overrideUrl ? normalizeServerUrl(overrideUrl) : _serverUrl;
        const resp = await fetch(base + '/api/health', { signal: AbortSignal.timeout(5000) });
        if (resp.ok) {
            const data = await resp.json();
            return { online: true, version: data.version };
        }
    } catch {}
    return { online: false };
}

// ── Cloud Settings Sync ──

export interface CloudSettings {
    // IDE preferences
    fontSize?: number;
    accentColor?: string;
    bgDark?: string;
    bgMain?: string;
    bgPanel?: string;
    bgSidebar?: string;
    editorBg?: string;
    textColor?: string;
    textDim?: string;
    fancyEffects?: boolean;
    layout?: string;
    cornerRadius?: string;
    compactMode?: boolean;
    colorMode?: string;

    // AI settings
    aiProvider?: string;
    aiApiKey?: string;
    aiEndpoint?: string;
    aiModel?: string;
    aiSystemPrompt?: string;
    aiAutoErrors?: boolean;
    aiInlineSuggest?: boolean;
    aiFileContext?: boolean;

    // Discord auth
    discord?: {
        id: string;
        username: string;
        discriminator: string;
        avatar: string | null;
        avatarUrl: string | null;
        accessToken: string;
    } | null;

    // GitHub auth
    github?: {
        token: string;
        username: string;
        avatarUrl: string;
        name: string;
    } | null;
}

/**
 * Load settings from the cloud (server).
 * Returns null if not logged in or if the request fails.
 */
export async function loadCloudSettings(): Promise<{ settings: CloudSettings; updatedAt: string | null } | null> {
    if (!_token) return null;
    const result = await apiFetch('/api/user/settings');
    if (result.success) {
        return { settings: result.settings || {}, updatedAt: result.updatedAt || null };
    }
    return null;
}

/**
 * Save settings to the cloud (server).
 * Returns true on success.
 */
export async function saveCloudSettings(settings: CloudSettings): Promise<boolean> {
    if (!_token) return false;
    const result = await apiFetch('/api/user/settings', {
        method: 'PUT',
        body: JSON.stringify({ settings }),
    });
    return result.success === true;
}

/**
 * Load the learning-profile snapshot from the cloud.
 * Returns null if not logged in or the request fails.
 */
export async function loadCloudProgress(): Promise<{ progress: any; updatedAt: string | null } | null> {
    if (!_token) return null;
    const result = await apiFetch('/api/auth/progress');
    if (result.success) {
        return { progress: result.progress || null, updatedAt: result.updatedAt || null };
    }
    return null;
}

/**
 * Save the learning-profile snapshot to the cloud.
 * If offline, the write is queued and replayed on reconnect. Returns true if
 * the write reached the server now (queued writes return false but persist).
 */
export async function saveCloudProgress(data: any): Promise<boolean> {
    if (!_token) return false;
    if (_connectionState.offlineMode) {
        queueOfflineAction('custom', { endpoint: '/api/auth/progress', method: 'PUT', data: { data } });
        return false;
    }
    const result = await apiFetch('/api/auth/progress', {
        method: 'PUT',
        body: JSON.stringify({ data }),
    });
    return result.success === true;
}

/**
 * Fetch Discord bot configuration from the Nexia server.
 * Only available to authenticated users — the bot token never ships in the client.
 */
export async function fetchDiscordConfig(): Promise<{ botToken: string; channelId: string; clientId: string; clientSecret: string } | null> {
    if (!_token) return null;
    try {
        const result = await apiFetch('/api/auth/discord-config');
        if (result && result.botToken) return result;
    } catch {}
    return null;
}
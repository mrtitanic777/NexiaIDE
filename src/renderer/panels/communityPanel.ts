/**
 * communityPanel.ts — Discord Community Panel
 *
 * Extracted from app.ts. Handles the community sidebar panel:
 * Discord feed, thread view, auth bar, forum posting, and setup.
 */

// ── Dependencies (injected via initCommunity) ──
let _$: (id: string) => HTMLElement;
let _appendOutput: (text: string) => void;
let _escapeHtml: (s: string) => string;
let _ipcRenderer: any;
let _shell: any;
let _IPC: any;
let _authService: any;
let _authUI: any;
let _renderGitPanel: () => void;
let _saveUserSettings: () => void;
let _nodeFs: any;
let _nodePath: any;
let _nodeOs: any;

export interface CommunityDeps {
    $: (id: string) => HTMLElement;
    appendOutput: (text: string) => void;
    escapeHtml: (s: string) => string;
    ipcRenderer: any;
    shell: any;
    IPC: any;
    authService: any;
    authUI: any;
    renderGitPanel: () => void;
    saveUserSettings: () => void;
    nodeFs: any;
    nodePath: any;
    nodeOs: any;
}

export function initCommunity(deps: CommunityDeps) {
    _$ = deps.$;
    _appendOutput = deps.appendOutput;
    _escapeHtml = deps.escapeHtml;
    _ipcRenderer = deps.ipcRenderer;
    _shell = deps.shell;
    _IPC = deps.IPC;
    _authService = deps.authService;
    _authUI = deps.authUI;
    _renderGitPanel = deps.renderGitPanel;
    _saveUserSettings = deps.saveUserSettings;
    _nodeFs = deps.nodeFs;
    _nodePath = deps.nodePath;
    _nodeOs = deps.nodeOs;
}

// ── Exported state (accessed by settings panel and cloud sync) ──
export let discordAuthUser: { id: string; username: string; avatarUrl: string | null } | null = null;

export function setDiscordAuthUser(user: { id: string; username: string; avatarUrl: string | null } | null) {
    discordAuthUser = user;
}

export function getDiscordAuthUser() {
    return discordAuthUser;
}

let discordFeedLoading = false;
let currentThreadView: string | null = null;
let threadPollInFlight = false;
let threadPollInterval: ReturnType<typeof setInterval> | null = null;
let feedPollInterval: ReturnType<typeof setInterval> | null = null;
let lastSeenMessageId: string | null = null;
const THREAD_POLL_MS = 5000;  // Poll thread messages every 5s
const FEED_POLL_MS = 30000;   // Poll feed every 30s

function stopThreadPoll() {
    if (threadPollInterval) { clearInterval(threadPollInterval); threadPollInterval = null; }
}

function startThreadPoll(threadId: string) {
    stopThreadPoll();
    threadPollInterval = setInterval(() => pollThreadMessages(threadId), THREAD_POLL_MS);
}

async function pollThreadMessages(threadId: string) {
    if (currentThreadView !== threadId || !lastSeenMessageId) return;
    // Skip if a previous poll's awaited round-trip hasn't resolved yet. Without
    // this, a fetch slower than the 5s interval lets ticks overlap and append the
    // same messages twice.
    if (threadPollInFlight) return;
    threadPollInFlight = true;

    try {
        const newMsgs = await _ipcRenderer.invoke(_IPC.DISCORD_GET_NEW_MESSAGES, threadId, lastSeenMessageId);
        if (!newMsgs || newMsgs.length === 0) return;

        const container = document.getElementById('thread-messages');
        if (!container) return;

        const wasAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 40;

        for (const msg of newMsgs) {
            appendMessageToView(container, msg, true);
            lastSeenMessageId = msg.id;
        }

        // Auto-scroll if user was already at the bottom
        if (wasAtBottom) {
            container.scrollTop = container.scrollHeight;
        } else {
            // Show "new messages" indicator
            showNewMessagesBadge(container, newMsgs.length);
        }
    } catch {} finally {
        threadPollInFlight = false;
    }
}

function showNewMessagesBadge(container: HTMLElement, count: number) {
    let badge = container.parentElement?.querySelector('.new-msgs-badge') as HTMLElement;
    if (!badge) {
        badge = document.createElement('div');
        badge.className = 'new-msgs-badge';
        badge.addEventListener('click', () => {
            container.scrollTop = container.scrollHeight;
            badge.remove();
        });
        container.parentElement?.insertBefore(badge, container.nextSibling);
    }
    badge.textContent = `↓ ${count} new message${count > 1 ? 's' : ''}`;
}

function stopFeedPoll() {
    if (feedPollInterval) { clearInterval(feedPollInterval); feedPollInterval = null; }
}

function startFeedPoll() {
    stopFeedPoll();
    feedPollInterval = setInterval(() => pollFeed(), FEED_POLL_MS);
}

async function pollFeed() {
    if (currentThreadView) return; // Don't poll feed while viewing a thread
    const feedEl = document.getElementById('community-feed');
    if (!feedEl || discordFeedLoading) return;

    try {
        const threads = await _ipcRenderer.invoke(_IPC.DISCORD_GET_FEED, true);
        if (!threads || threads.length === 0) return;

        // Check if feed content changed by comparing first thread's last message
        const firstCard = feedEl.querySelector('.discord-thread');
        const currentFirstId = firstCard?.getAttribute('data-thread-id');
        if (threads[0]?.id !== currentFirstId) {
            // Feed has new content — rebuild quietly
            renderFeedCards(feedEl, threads);
        }
    } catch {}
}

export function renderCommunityPanel() {
    const panel = _$('community-panel');
    if (!panel) return;

    // Check if user is already logged in
    refreshCommunityView();
}

export async function refreshCommunityView() {
    const panel = _$('community-panel');
    if (!panel) return;

    // The panel is about to be re-rendered (or torn down to a not-logged-in
    // state). Stop the feed poll so its 30s interval doesn't keep firing
    // IPC/Discord calls for the app's lifetime against a destroyed feed element.
    // loadDiscordFeed() restarts it when the feed view is shown again.
    stopFeedPoll();

    // Require Nexia account sign-in first
    if (!_authService.isLoggedIn()) {
        panel.innerHTML = `
            <div class="gh-landing" style="padding:24px 18px;">
                <div class="gh-landing-icon" style="color:#5865F2;">
                    <svg viewBox="0 0 24 24" width="48" height="48" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.125-.093.25-.19.372-.292a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419s.956-2.419 2.157-2.419c1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419s.956-2.419 2.157-2.419c1.21 0 2.176 1.095 2.157 2.42 0 1.333-.947 2.418-2.157 2.418z"/></svg>
                </div>
                <div class="gh-landing-title">Community</div>
                <div class="gh-landing-desc">Sign in to your Nexia account to access the Discord community, forum posts, and discussions.</div>
                <div class="gh-landing-features">
                    <div class="gh-landing-feature">💬 Browse forum discussions</div>
                    <div class="gh-landing-feature">📝 Post and reply to threads</div>
                    <div class="gh-landing-feature">🔄 Settings sync across devices</div>
                    <div class="gh-landing-feature">🔗 Link Discord and GitHub accounts</div>
                </div>
                <button class="gh-signin-btn" id="community-nexia-signin" style="background:var(--green);">
                    Sign In to Nexia
                </button>
            </div>
        `;
        document.getElementById('community-nexia-signin')!.addEventListener('click', () => {
            _authUI.showLogin();
        });
        return;
    }

    const result = await _ipcRenderer.invoke(_IPC.DISCORD_AUTH_USER);

    if (!result.loggedIn) {
        // Not logged in — show landing page (like GitHub panel)
        renderDiscordLanding(panel);
        return;
    }

    // Logged in — store user info
    discordAuthUser = { id: result.id, username: result.username, avatarUrl: result.avatarUrl };

    // Check guild membership.
    // Only nag when we POSITIVELY established they aren't a member. If the check
    // couldn't run (expired Discord token, missing `guilds` scope, API hiccup),
    // `determined` is false and we stay quiet — telling an actual member they
    // haven't joined is worse than saying nothing.
    const guildCheck = await _ipcRenderer.invoke(_IPC.DISCORD_CHECK_GUILDS);

    if (!guildCheck.determined) {
        console.warn('[Community] Guild membership undetermined:', guildCheck.reason || guildCheck.error || 'unknown');
        renderCommunityFeedView(panel);
        return;
    }

    if (!guildCheck.inNexiaServer) {
        // Show the feed UI but display a toast about joining the server
        renderCommunityFeedView(panel);
        showCommunityToast(
            'Hey! It looks like you haven\'t joined The Official Nexia Server on Discord yet. Join the server to access community features like forum posts and discussions.',
            'https://discord.gg/d3AeCyH7bN'
        );
        return;
    }

    // Fully authenticated and in the server — show the feed
    renderCommunityFeedView(panel);
}

function renderDiscordLanding(panel: HTMLElement) {
    panel.innerHTML = `
        <div class="gh-landing" style="padding:24px 18px;">
            <div class="gh-landing-icon" style="color:#5865F2;">
                <svg viewBox="0 0 24 24" width="48" height="48" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.947 2.418-2.157 2.418z"/></svg>
            </div>
            <div class="gh-landing-title">Discord Community</div>
            <div class="gh-landing-desc">Connect your Discord account to interact with the Nexia community directly from within the IDE.</div>
            <div class="gh-landing-features">
                <div class="gh-landing-feature">💬 Browse forum discussions</div>
                <div class="gh-landing-feature">📝 Post and reply to threads</div>
                <div class="gh-landing-feature">📌 Stay up to date with pinned topics</div>
                <div class="gh-landing-feature">📎 View shared files and attachments</div>
            </div>
            <button class="gh-signin-btn" id="discord-landing-signin" style="background:#5865F2;">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="margin-right:8px"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.947 2.418-2.157 2.418z"/></svg>
                Sign In with Discord
            </button>
        </div>
    `;

    document.getElementById('discord-landing-signin')!.addEventListener('click', async () => {
        const btn = document.getElementById('discord-landing-signin') as HTMLButtonElement;
        btn.textContent = 'Waiting for Discord...';
        btn.disabled = true;

        // Check if OAuth is configured first
        const config = await _ipcRenderer.invoke(_IPC.DISCORD_GET_CONFIG);
        if (!config.clientId) {
            btn.disabled = false;
            btn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="margin-right:8px"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.125-.093.25-.19.372-.292a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419s.956-2.419 2.157-2.419c1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419s.956-2.419 2.157-2.419c1.21 0 2.176 1.095 2.157 2.42 0 1.333-.947 2.418-2.157 2.418z"/></svg> Sign In with Discord`;
            // Show setup dialog so the user can configure OAuth credentials
            showDiscordSetup();
            return;
        }

        const result = await _ipcRenderer.invoke(_IPC.DISCORD_AUTH_START);
        if (result.success) {
            refreshCommunityView();
        } else {
            btn.disabled = false;
            btn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="margin-right:8px"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.125-.093.25-.19.372-.292a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419s.956-2.419 2.157-2.419c1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419s.956-2.419 2.157-2.419c1.21 0 2.176 1.095 2.157 2.42 0 1.333-.947 2.418-2.157 2.418z"/></svg> Sign In with Discord`;
            // Show the error visually on the landing page
            let errEl = document.getElementById('discord-landing-error');
            if (!errEl) {
                errEl = document.createElement('div');
                errEl.id = 'discord-landing-error';
                errEl.style.cssText = 'margin-top:12px;padding:8px 12px;background:rgba(244,71,71,0.1);border:1px solid rgba(244,71,71,0.3);border-radius:6px;font-size:11px;color:#f87171;text-align:center;';
                btn.parentNode!.insertBefore(errEl, btn.nextSibling);
            }
            errEl.textContent = result.error || 'Login failed. Please try again.';
        }
    });
}

function renderCommunityFeedView(panel: HTMLElement) {
    panel.innerHTML = `
        <div class="discord-auth-bar" id="discord-auth-bar"></div>
        <div class="community-feed-header">
            <span>📋 Software Tools Forum</span>
            <div style="display:flex;gap:4px;">
                <button class="community-action-btn" id="community-new-post-btn" title="New Post" style="display:none;">+ New</button>
                <button class="community-refresh-btn" id="community-refresh-btn" title="Refresh feed">↻</button>
                <button class="community-refresh-btn" id="community-settings-btn" title="Settings">⚙</button>
            </div>
        </div>
        <div id="community-feed" class="community-feed">
            <div class="community-feed-loading">Loading forum threads...</div>
        </div>
        <div id="community-thread-view" class="community-thread-view hidden"></div>
    `;

    // Render the logged-in auth bar
    renderAuthBar();

    document.getElementById('community-refresh-btn')!.addEventListener('click', () => loadDiscordFeed(true));
    document.getElementById('community-settings-btn')!.addEventListener('click', () => showDiscordSetup());
    document.getElementById('community-new-post-btn')!.addEventListener('click', () => showNewPostDialog());

    loadDiscordFeed();
}

function renderAuthBar() {
    const bar = document.getElementById('discord-auth-bar');
    if (!bar || !discordAuthUser) return;

    bar.innerHTML = `
        <div class="discord-auth-user">
            ${discordAuthUser.avatarUrl ? `<img class="discord-auth-avatar" src="${discordAuthUser.avatarUrl}" alt="">` : '<span class="discord-auth-avatar-placeholder">👤</span>'}
            <span class="discord-auth-name">${_escapeHtml(discordAuthUser.username)}</span>
            <button class="discord-auth-logout" id="discord-logout-btn" title="Log out">Log out</button>
        </div>
    `;

    document.getElementById('discord-logout-btn')!.addEventListener('click', async () => {
        await _ipcRenderer.invoke(_IPC.DISCORD_AUTH_LOGOUT);
        discordAuthUser = null;
        refreshCommunityView();
    });

    // Show new post button for logged-in users
    const newBtn = document.getElementById('community-new-post-btn');
    if (newBtn) newBtn.style.display = '';
}

function showCommunityToast(message: string, joinUrl: string) {
    const existing = document.getElementById('community-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'community-toast';
    toast.style.cssText = 'position:fixed;bottom:60px;left:50%;transform:translateX(-50%) translateY(20px);opacity:0;z-index:9999;background:#1e1e2e;border:1px solid #5865F2;border-radius:8px;padding:14px 18px;max-width:400px;box-shadow:0 8px 32px rgba(0,0,0,0.5);transition:opacity 0.3s,transform 0.3s;font-family:var(--font);';
    toast.innerHTML = `
        <div style="display:flex;align-items:flex-start;gap:12px;">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="#5865F2" style="flex-shrink:0;margin-top:2px;"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.125-.093.25-.19.372-.292a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419s.956-2.419 2.157-2.419c1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419s.956-2.419 2.157-2.419c1.21 0 2.176 1.095 2.157 2.42 0 1.333-.947 2.418-2.157 2.418z"/></svg>
            <div style="flex:1;">
                <div style="font-size:12px;color:#cccccc;line-height:1.5;margin-bottom:10px;">${_escapeHtml(message)}</div>
                <div style="display:flex;gap:8px;">
                    <button id="community-toast-join" style="padding:6px 16px;background:#5865F2;color:white;border:none;border-radius:4px;font-size:12px;font-weight:600;cursor:pointer;font-family:var(--font);">Join Server</button>
                    <button id="community-toast-dismiss" style="padding:6px 12px;background:transparent;color:#858585;border:1px solid #404040;border-radius:4px;font-size:12px;cursor:pointer;font-family:var(--font);">Dismiss</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(toast);
    requestAnimationFrame(() => { toast.style.opacity = '1'; toast.style.transform = 'translateX(-50%) translateY(0)'; });

    document.getElementById('community-toast-join')!.addEventListener('click', () => {
        _shell.openExternal(joinUrl);
        toast.style.opacity = '0'; toast.style.transform = 'translateX(-50%) translateY(20px)';
        setTimeout(() => toast.remove(), 300);
    });
    document.getElementById('community-toast-dismiss')!.addEventListener('click', () => {
        toast.style.opacity = '0'; toast.style.transform = 'translateX(-50%) translateY(20px)';
        setTimeout(() => toast.remove(), 300);
    });

    // Auto-dismiss after 15 seconds
    setTimeout(() => {
        if (toast.parentNode) {
            toast.style.opacity = '0'; toast.style.transform = 'translateX(-50%) translateY(20px)';
            setTimeout(() => toast.remove(), 300);
        }
    }, 15000);
}

async function loadDiscordFeed(force: boolean = false) {
    const feedEl = document.getElementById('community-feed');
    if (!feedEl || discordFeedLoading) return;

    // Hide thread view, show feed
    const threadView = document.getElementById('community-thread-view');
    if (threadView) threadView.classList.add('hidden');
    feedEl.classList.remove('hidden');
    currentThreadView = null;
    lastSeenMessageId = null;
    stopThreadPoll();

    const config = await _ipcRenderer.invoke(_IPC.DISCORD_GET_CONFIG);
    if (!config.enabled) {
        feedEl.innerHTML = `
            <div class="community-feed-placeholder">
                <p>Connect a Discord bot to pull forum posts<br>from your server into the IDE.</p>
                <button class="community-setup-btn" id="community-setup-btn2">⚙ Setup Discord Feed</button>
            </div>`;
        document.getElementById('community-setup-btn2')?.addEventListener('click', () => showDiscordSetup());
        return;
    }

    discordFeedLoading = true;
    feedEl.innerHTML = '<div class="community-feed-loading">Loading forum threads...</div>';

    try {
        const threads = await _ipcRenderer.invoke(_IPC.DISCORD_GET_FEED, force);
        if (!threads || threads.length === 0) {
            feedEl.innerHTML = '<div class="community-feed-placeholder"><p>No forum threads found.<br>Check your channel ID and bot permissions.</p></div>';
            return;
        }
        feedEl.innerHTML = '';
        renderFeedCards(feedEl, threads);
    } catch (err: any) {
        feedEl.innerHTML = `<div class="community-feed-placeholder"><p>Failed to load feed:<br>${_escapeHtml(err.message || 'Unknown error')}</p></div>`;
    } finally {
        discordFeedLoading = false;
        // Start feed polling
        startFeedPoll();
    }
}

function renderFeedCards(feedEl: HTMLElement, threads: any[]) {
    feedEl.innerHTML = '';
    for (const thread of threads) {
        const card = document.createElement('div');
        card.className = 'discord-thread' + (thread.pinned ? ' pinned' : '');
        card.setAttribute('data-thread-id', thread.id);
        const timeAgo = formatTimeAgo(thread.createdAt);
        const preview = _escapeHtml(thread.preview);
        card.innerHTML = `
            <div class="discord-thread-header">
                ${thread.pinned ? '<span class="discord-pin">📌</span>' : ''}
                <span class="discord-thread-title">${_escapeHtml(thread.name)}</span>
            </div>
            <div class="discord-thread-meta">
                <span class="discord-thread-author">${_escapeHtml(thread.authorName)}</span>
                <span class="discord-thread-time">${timeAgo}</span>
                <span class="discord-thread-replies">💬 ${thread.messageCount}</span>
            </div>
            ${preview ? `<div class="discord-thread-preview">${preview}</div>` : ''}
        `;
        card.addEventListener('click', () => openThreadView(thread.id, thread.name));
        feedEl.appendChild(card);
    }
}

async function openThreadView(threadId: string, threadName: string) {
    const feedEl = document.getElementById('community-feed');
    const threadView = document.getElementById('community-thread-view');
    if (!feedEl || !threadView) return;

    feedEl.classList.add('hidden');
    threadView.classList.remove('hidden');
    currentThreadView = threadId;
    lastSeenMessageId = null;
    stopFeedPoll();
    stopThreadPoll();

    threadView.innerHTML = `
        <div class="thread-view-header">
            <button class="thread-back-btn" id="thread-back-btn">← Back</button>
            <span class="thread-view-title">${_escapeHtml(threadName)}</span>
            <button class="thread-open-discord-btn" id="thread-open-discord" title="Open in Discord">↗</button>
        </div>
        <div class="thread-messages" id="thread-messages">
            <div class="community-feed-loading">Loading messages...</div>
        </div>
        <div class="thread-reply-bar" id="thread-reply-bar">
            ${discordAuthUser
                ? `<input type="text" id="thread-reply-input" placeholder="Reply as ${_escapeHtml(discordAuthUser.username)}..." autocomplete="off">
                   <button class="thread-reply-send" id="thread-reply-send">Send</button>`
                : `<div class="thread-reply-login">Log in with Discord to reply</div>`
            }
        </div>
    `;

    document.getElementById('thread-back-btn')!.addEventListener('click', () => loadDiscordFeed(true));
    document.getElementById('thread-open-discord')!.addEventListener('click', () => {
        _shell.openExternal(`https://discord.com/channels/@me/${threadId}`);
    });

    // Reply (only if logged in)
    if (discordAuthUser) {
        const replyInput = document.getElementById('thread-reply-input') as HTMLInputElement;
        const replySend = document.getElementById('thread-reply-send')!;
        const sendReply = async () => {
            const content = replyInput.value.trim();
            if (!content) return;
            replyInput.disabled = true;
            replySend.textContent = '...';
            const result = await _ipcRenderer.invoke(_IPC.DISCORD_REPLY, threadId, content);
            if (result.success) {
                replyInput.value = '';
                // Quick poll to pick up our own reply
                setTimeout(() => pollThreadMessages(threadId), 1000);
            } else {
                _appendOutput('Reply failed: ' + (result.error || 'Unknown error') + '\n');
            }
            replyInput.disabled = false;
            replySend.textContent = 'Send';
            replyInput.focus();
        };
        replySend.addEventListener('click', sendReply);
        replyInput.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') sendReply(); });
    }

    await loadThreadMessages(threadId);
}

async function loadThreadMessages(threadId: string) {
    const container = document.getElementById('thread-messages');
    if (!container) return;

    try {
        const messages = await _ipcRenderer.invoke(_IPC.DISCORD_GET_MESSAGES, threadId);
        if (!messages || messages.length === 0) {
            container.innerHTML = '<div class="community-feed-placeholder"><p>No messages found.</p></div>';
            return;
        }

        container.innerHTML = '';
        for (const msg of messages) {
            appendMessageToView(container, msg, false);
        }

        // Track last message for polling
        lastSeenMessageId = messages[messages.length - 1].id;

        // Scroll to bottom
        container.scrollTop = container.scrollHeight;

        // Start live polling
        startThreadPoll(threadId);

        // Auto-dismiss new messages badge when scrolled to bottom
        container.addEventListener('scroll', () => {
            if (container.scrollHeight - container.scrollTop - container.clientHeight < 40) {
                const badge = container.parentElement?.querySelector('.new-msgs-badge');
                if (badge) badge.remove();
            }
        });
    } catch (err: any) {
        container.innerHTML = `<div class="community-feed-placeholder"><p>Failed to load messages:<br>${_escapeHtml(err.message || 'Error')}</p></div>`;
    }
}

function appendMessageToView(container: HTMLElement, msg: any, isNew: boolean) {
    const msgEl = document.createElement('div');
    msgEl.className = 'thread-message' + (msg.authorIsBot ? ' bot-message' : '') + (isNew ? ' new-message' : '');
    msgEl.setAttribute('data-msg-id', msg.id);

    let attachmentsHtml = '';
    if (msg.attachments && msg.attachments.length > 0) {
        attachmentsHtml = '<div class="msg-attachments">';
        for (const att of msg.attachments) {
            const sizeStr = formatFileSize(att.size);
            const isImage = att.contentType && att.contentType.startsWith('image/');
            attachmentsHtml += `
                <div class="msg-attachment" data-url="${_escapeHtml(att.url)}" data-filename="${_escapeHtml(att.filename)}">
                    <span class="msg-att-icon">${isImage ? '🖼' : '📎'}</span>
                    <div class="msg-att-info">
                        <span class="msg-att-name">${_escapeHtml(att.filename)}</span>
                        <span class="msg-att-size">${sizeStr}</span>
                    </div>
                    <button class="msg-att-dl" title="Download">↓</button>
                </div>
            `;
        }
        attachmentsHtml += '</div>';
    }

    let embedsHtml = '';
    if (msg.embeds && msg.embeds.length > 0) {
        for (const embed of msg.embeds) {
            if (embed.title || embed.description) {
                embedsHtml += `<div class="msg-embed">`;
                if (embed.title) embedsHtml += `<div class="msg-embed-title">${_escapeHtml(embed.title)}</div>`;
                if (embed.description) embedsHtml += `<div class="msg-embed-desc">${_escapeHtml(embed.description)}</div>`;
                embedsHtml += `</div>`;
            }
        }
    }

    const timeStr = new Date(msg.createdAt).toLocaleString();
    const contentHtml = formatDiscordContent(msg.content);

    msgEl.innerHTML = `
        <div class="msg-header">
            <span class="msg-author${msg.authorIsBot ? ' msg-bot' : ''}">${_escapeHtml(msg.authorName)}${msg.authorIsBot ? ' <span class="msg-bot-badge">BOT</span>' : ''}</span>
            <span class="msg-time">${timeStr}</span>
        </div>
        ${contentHtml ? `<div class="msg-content">${contentHtml}</div>` : ''}
        ${attachmentsHtml}
        ${embedsHtml}
    `;

    // Wire download buttons
    const dlBtns = msgEl.querySelectorAll('.msg-att-dl');
    dlBtns.forEach((btn) => {
        btn.addEventListener('click', async (e: Event) => {
            e.stopPropagation();
            const attEl = (btn as HTMLElement).closest('.msg-attachment') as HTMLElement;
            const url = attEl.dataset.url || '';
            const filename = attEl.dataset.filename || 'download';
            (btn as HTMLElement).textContent = '...';
            const result = await _ipcRenderer.invoke(_IPC.DISCORD_DOWNLOAD, url, filename);
            if (result.success) {
                (btn as HTMLElement).textContent = '✓';
                _appendOutput(`Downloaded: ${filename}\n`);
            } else {
                (btn as HTMLElement).textContent = '✗';
                _appendOutput(`Download failed: ${result.error}\n`);
            }
        });
    });

    container.appendChild(msgEl);
}

function showNewPostDialog() {
    if (!discordAuthUser) {
        _appendOutput('You must be logged in to create a post.\n');
        return;
    }
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.id = 'new-post-overlay';
    overlay.innerHTML = `
        <div class="discord-setup-dialog" style="width:520px;">
            <h2>📋 New Forum Post</h2>
            <p class="discord-setup-info">
                Create a new post in the Software Tools forum channel.
                This will be posted as <strong>${_escapeHtml(discordAuthUser!.username)}</strong> via Nexia IDE.
            </p>
            <div class="dialog-field">
                <label>Title</label>
                <input type="text" id="new-post-title" placeholder="Post title..." maxlength="100" autocomplete="off">
            </div>
            <div class="dialog-field">
                <label>Content</label>
                <textarea id="new-post-content" placeholder="Write your post content here..." rows="8"
                    style="width:100%;padding:8px 12px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text);font-family:var(--font);font-size:13px;resize:vertical;"></textarea>
            </div>
            <div class="dialog-buttons">
                <button class="setup-btn-secondary" id="new-post-cancel">Cancel</button>
                <button class="setup-btn-primary" id="new-post-submit">Publish</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById('new-post-cancel')!.addEventListener('click', () => overlay.remove());
    document.getElementById('new-post-submit')!.addEventListener('click', async () => {
        const title = (document.getElementById('new-post-title') as HTMLInputElement).value.trim();
        const content = (document.getElementById('new-post-content') as HTMLTextAreaElement).value.trim();

        if (!title) { alert('Please enter a title.'); return; }
        if (!content) { alert('Please enter content.'); return; }

        const btn = document.getElementById('new-post-submit')!;
        btn.textContent = 'Publishing...';
        (btn as HTMLButtonElement).disabled = true;

        const result = await _ipcRenderer.invoke(_IPC.DISCORD_CREATE_THREAD, title, content);
        if (result.success) {
            overlay.remove();
            _appendOutput(`Published forum post: "${title}"\n`);
            // Small delay for Discord API propagation, then force refresh
            setTimeout(() => loadDiscordFeed(true), 1500);
        } else {
            btn.textContent = 'Publish';
            (btn as HTMLButtonElement).disabled = false;
            alert('Failed to publish: ' + (result.error || 'Unknown error'));
        }
    });

    document.getElementById('new-post-title')!.focus();
}

export function showDiscordSetup() {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.id = 'discord-setup-overlay';
    overlay.innerHTML = `
        <div class="discord-setup-dialog">
            <h2>⚙ Discord Feed Setup</h2>
            <p class="discord-setup-info">
                Create a Discord bot at <a id="discord-dev-link" href="#">developer portal</a>,
                add it to your server with <strong>Read Message History</strong>,
                <strong>Send Messages</strong>, and
                <strong>View Channels</strong> permissions, then paste the bot token and
                forum channel ID below.<br><br>
                For user login, also copy the <strong>Client ID</strong> and <strong>Client Secret</strong>
                from the OAuth2 section of your application, and add
                <code style="background:rgba(0,0,0,0.3);padding:1px 4px;border-radius:3px;">http://localhost:18293/callback</code>
                as a Redirect URI.
            </p>
            <div class="dialog-field">
                <label>Bot Token</label>
                <input type="password" id="discord-token-input" placeholder="Bot token..." autocomplete="off">
            </div>
            <div class="dialog-field">
                <label>Forum Channel ID</label>
                <input type="text" id="discord-channel-input" placeholder="e.g. 1234567890">
            </div>
            <div class="dialog-field">
                <label>Client ID (for user login)</label>
                <input type="text" id="discord-clientid-input" placeholder="Application Client ID">
            </div>
            <div class="dialog-field">
                <label>Client Secret (for user login)</label>
                <input type="password" id="discord-clientsecret-input" placeholder="Application Client Secret" autocomplete="off">
            </div>
            <div class="dialog-field">
                <label style="display:flex;align-items:center;gap:8px;">
                    <input type="checkbox" id="discord-enabled-input"> Enable Discord feed
                </label>
            </div>
            <div class="dialog-buttons">
                <button class="setup-btn-secondary" id="discord-setup-cancel">Cancel</button>
                <button class="setup-btn-primary" id="discord-setup-save">Save</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    _ipcRenderer.invoke(_IPC.DISCORD_GET_CONFIG).then((config: any) => {
        (document.getElementById('discord-channel-input') as HTMLInputElement).value = config.channelId || '';
        (document.getElementById('discord-clientid-input') as HTMLInputElement).value = config.clientId || '';
        (document.getElementById('discord-enabled-input') as HTMLInputElement).checked = config.enabled;
    });

    document.getElementById('discord-dev-link')!.addEventListener('click', (e) => {
        e.preventDefault();
        _shell.openExternal('https://discord.com/developers/applications');
    });

    document.getElementById('discord-setup-cancel')!.addEventListener('click', () => overlay.remove());

    document.getElementById('discord-setup-save')!.addEventListener('click', async () => {
        const token = (document.getElementById('discord-token-input') as HTMLInputElement).value.trim();
        const channelId = (document.getElementById('discord-channel-input') as HTMLInputElement).value.trim();
        const clientId = (document.getElementById('discord-clientid-input') as HTMLInputElement).value.trim();
        const clientSecret = (document.getElementById('discord-clientsecret-input') as HTMLInputElement).value.trim();
        const enabled = (document.getElementById('discord-enabled-input') as HTMLInputElement).checked;

        const config: any = { channelId, enabled };
        if (token) config.botToken = token;
        if (clientId) config.clientId = clientId;
        if (clientSecret) config.clientSecret = clientSecret;

        await _ipcRenderer.invoke(_IPC.DISCORD_CONFIGURE, config);
        overlay.remove();
        loadDiscordFeed(true);
    });
}

function formatDiscordContent(content: string): string {
    if (!content) return '';
    let html = _escapeHtml(content);
    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Italic
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    // Code blocks
    html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, '<pre class="msg-codeblock"><code>$2</code></pre>');
    // Line breaks
    html = html.replace(/\n/g, '<br>');
    return html;
}

function formatTimeAgo(dateStr: string): string {
    const d = new Date(dateStr);
    const now = Date.now();
    const diff = now - d.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    return d.toLocaleDateString();
}

function formatFileSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
}


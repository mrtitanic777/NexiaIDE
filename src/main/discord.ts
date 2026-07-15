/**
 * Discord Integration
 * Fetches forum threads/posts from a specific Discord channel
 * using the Discord Bot HTTP API.
 */

import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';

const DISCORD_API = 'discord.com';
const API_VERSION = '/api/v10';

export interface DiscordThread {
    id: string;
    name: string;
    authorName: string;
    authorAvatar: string | null;
    createdAt: string;
    messageCount: number;
    lastMessageAt: string | null;
    tags: string[];
    preview: string;  // First message content (truncated)
    pinned: boolean;
}

export interface DiscordMessage {
    id: string;
    content: string;
    authorName: string;
    authorAvatar: string | null;
    authorIsBot: boolean;
    createdAt: string;
    editedAt: string | null;
    attachments: DiscordAttachment[];
    embeds: DiscordEmbed[];
}

export interface DiscordAttachment {
    id: string;
    filename: string;
    url: string;
    size: number;
    contentType: string | null;
}

export interface DiscordEmbed {
    title: string | null;
    description: string | null;
    url: string | null;
    color: number | null;
}

export interface DiscordConfig {
    botToken: string;
    channelId: string;   // Forum channel ID
    clientId: string;    // OAuth2 application client ID
    clientSecret: string;// OAuth2 application client secret
    enabled: boolean;
}

export interface DiscordUser {
    id: string;
    username: string;
    discriminator: string;
    avatar: string | null;
    avatarUrl: string | null;
    accessToken: string;
}

export class DiscordFeed {
    private config: DiscordConfig;
    private cache: { threads: DiscordThread[]; fetchedAt: number } | null = null;
    private cacheTtl = 60_000; // 1 minute cache
    private authUser: DiscordUser | null = null;
    private authServer: http.Server | null = null;
    private authResolve: ((user: DiscordUser | null) => void) | null = null;
    private authFlowId = 0;
    private static OAUTH_PORT = 18293;
    private static REDIRECT_URI = `http://localhost:${DiscordFeed.OAUTH_PORT}/callback`;
    private guildId: string | null = null;

    constructor(config?: Partial<DiscordConfig>) {
        this.config = {
            botToken: config?.botToken || process.env.NEXIA_DISCORD_BOT_TOKEN || '',
            channelId: config?.channelId || '1459211832437903380', // Nexia Discord: software-tools forum
            clientId: config?.clientId || '1471724753730408622',
            clientSecret: config?.clientSecret || process.env.NEXIA_DISCORD_CLIENT_SECRET || '',
            enabled: config?.enabled ?? true,
        };
    }

    configure(config: Partial<DiscordConfig>) {
        Object.assign(this.config, config);
        this.cache = null;
        this.guildId = null;
    }

    getConfig(): { channelId: string; clientId: string; enabled: boolean } {
        return { channelId: this.config.channelId, clientId: this.config.clientId, enabled: this.config.enabled };
    }

    isConfigured(): boolean {
        return this.config.enabled && !!this.config.botToken && !!this.config.channelId;
    }

    /**
     * Clear the thread cache so next fetch is fresh.
     */
    clearCache() {
        this.cache = null;
        this.guildId = null;
    }

    // ── OAuth2 Authentication ──

    /**
     * Get the current authenticated user, or null if not logged in.
     */
    getAuthUser(): DiscordUser | null {
        return this.authUser;
    }

    /**
     * Set auth user from persisted data (loaded from settings).
     */
    setAuthUser(user: DiscordUser | null) {
        this.authUser = user;
    }

    /**
     * Check if OAuth2 is configured (clientId + clientSecret set).
     */
    isOAuthConfigured(): boolean {
        return !!this.config.clientId && !!this.config.clientSecret;
    }

    /**
     * Returns the Discord OAuth2 authorize URL.
     */
    getAuthUrl(): string {
        const params = new URLSearchParams({
            client_id: this.config.clientId,
            redirect_uri: DiscordFeed.REDIRECT_URI,
            response_type: 'code',
            scope: 'identify guilds',
        });
        return `https://discord.com/oauth2/authorize?${params.toString()}`;
    }

    /**
     * Start the OAuth2 flow. Opens a local HTTP server for the callback.
     * Returns a promise that resolves with the user or null on cancel/error.
     */
    startAuth(): Promise<DiscordUser | null> {
        // Cancel any in-flight flow first: resolve its orphaned promise and
        // close its server synchronously, so this new flow can bind the port
        // and the previous flow's 5-minute timeout can't cancel this one.
        this.cancelAuth();

        return new Promise((resolve) => {
            this.authResolve = resolve;
            const myFlow = ++this.authFlowId;

            const server = http.createServer(async (req, res) => {
                const url = new URL(req.url || '/', `http://localhost:${DiscordFeed.OAUTH_PORT}`);

                if (url.pathname === '/callback') {
                    const code = url.searchParams.get('code');
                    const error = url.searchParams.get('error');

                    if (error || !code) {
                        res.writeHead(200, { 'Content-Type': 'text/html' });
                        res.end('<html><body style="background:#1a1a2e;color:#e0e0e0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><div style="text-align:center;"><h2>Login Cancelled</h2><p>You can close this tab.</p></div></body></html>');
                        this.finishAuth(null);
                        return;
                    }

                    try {
                        // Exchange code for access token
                        const tokenData = await this.exchangeCode(code);
                        // Fetch user info
                        const userInfo = await this.fetchUserInfo(tokenData.access_token);

                        const avatarCdnUrl = userInfo.avatar
                                ? `https://cdn.discordapp.com/avatars/${userInfo.id}/${userInfo.avatar}.${userInfo.avatar.startsWith('a_') ? 'gif' : 'png'}?size=128`
                                : `https://cdn.discordapp.com/embed/avatars/${(BigInt(userInfo.id) >> 22n) % 6n}.png`;

                        // Download avatar via Node https so it works on Windows 7
                        const avatarDataUrl = await this.fetchImageAsDataUrl(avatarCdnUrl);

                        const user: DiscordUser = {
                            id: userInfo.id,
                            username: userInfo.username,
                            discriminator: userInfo.discriminator || '0',
                            avatar: userInfo.avatar,
                            avatarUrl: avatarDataUrl || avatarCdnUrl,
                            accessToken: tokenData.access_token,
                        };

                        this.authUser = user;

                        res.writeHead(200, { 'Content-Type': 'text/html' });
                        res.end(`<html><body style="background:#1a1a2e;color:#e0e0e0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><div style="text-align:center;"><h2 style="color:#00e676;">Logged in as ${user.username}</h2><p>You can close this tab and return to Nexia IDE.</p></div></body></html>`);
                        this.finishAuth(user);
                    } catch (err: any) {
                        res.writeHead(200, { 'Content-Type': 'text/html' });
                        res.end(`<html><body style="background:#1a1a2e;color:#e0e0e0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><div style="text-align:center;"><h2 style="color:#ff5555;">Login Failed</h2><p>${err.message}</p></div></body></html>`);
                        this.finishAuth(null);
                    }
                } else {
                    res.writeHead(404);
                    res.end('Not found');
                }
            });
            this.authServer = server;

            // A listen error (e.g. EADDRINUSE from a leftover server or a
            // double-click) emits 'error' on the server; with no handler Node
            // throws and crashes the main process. Resolve null instead.
            server.on('error', () => {
                try { server.close(); } catch {}
                if (this.authServer === server) this.authServer = null;
                if (this.authFlowId === myFlow) this.finishAuth(null);
            });

            server.listen(DiscordFeed.OAUTH_PORT, '127.0.0.1');

            // Auto-timeout after 5 minutes — only cancels THIS flow.
            setTimeout(() => {
                if (this.authFlowId === myFlow) this.finishAuth(null);
            }, 300_000);
        });
    }

    private finishAuth(user: DiscordUser | null) {
        if (this.authResolve) {
            this.authResolve(user);
            this.authResolve = null;
        }
        if (this.authServer) {
            const server = this.authServer;
            this.authServer = null;
            // Delay close to let the response finish sending
            setTimeout(() => {
                try { server.close(); } catch {}
            }, 1000);
        }
    }

    /**
     * Synchronously abort any in-flight OAuth flow: resolve its pending
     * promise with null and close the callback server immediately.
     */
    private cancelAuth() {
        this.authFlowId++;
        if (this.authResolve) {
            this.authResolve(null);
            this.authResolve = null;
        }
        if (this.authServer) {
            try { this.authServer.close(); } catch {}
            this.authServer = null;
        }
    }

    /**
     * Release all resources held by this feed. Called on app quit.
     */
    cleanup() {
        this.cancelAuth();
    }

    /**
     * Exchange an authorization code for an access token.
     */
    private exchangeCode(code: string): Promise<any> {
        return new Promise((resolve, reject) => {
            const body = new URLSearchParams({
                client_id: this.config.clientId,
                client_secret: this.config.clientSecret,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: DiscordFeed.REDIRECT_URI,
            }).toString();

            const options = {
                hostname: DISCORD_API,
                path: API_VERSION + '/oauth2/token',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(body),
                },
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (json.error) reject(new Error(json.error_description || json.error));
                        else resolve(json);
                    } catch { reject(new Error('Token exchange failed')); }
                });
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
    }

    /**
     * Fetch user info using an OAuth2 access token.
     */
    private fetchUserInfo(accessToken: string): Promise<any> {
        return new Promise((resolve, reject) => {
            const options = {
                hostname: DISCORD_API,
                path: API_VERSION + '/users/@me',
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'User-Agent': 'NexiaIDE (https://github.com/nexia-ide, 1.0)',
                },
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (res.statusCode && res.statusCode >= 400) reject(new Error(json.message || 'Failed'));
                        else resolve(json);
                    } catch { reject(new Error('Failed to fetch user info')); }
                });
            });
            req.on('error', reject);
            req.end();
        });
    }

    /**
     * Fetch the guilds (servers) the authenticated user belongs to.
     * Requires the 'guilds' OAuth2 scope.
     */
    fetchUserGuilds(): Promise<any[]> {
        const user = this.authUser;
        if (!user?.accessToken) return Promise.resolve([]);

        return new Promise((resolve, reject) => {
            const options = {
                hostname: DISCORD_API,
                path: API_VERSION + '/users/@me/guilds',
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${user.accessToken}`,
                    'User-Agent': 'NexiaIDE (https://github.com/nexia-ide, 1.0)',
                },
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk: string) => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (res.statusCode && res.statusCode >= 400) reject(new Error(json.message || 'Failed'));
                        else resolve(Array.isArray(json) ? json : []);
                    } catch { reject(new Error('Failed to fetch guilds')); }
                });
            });
            req.on('error', reject);
            req.end();
        });
    }

    /**
     * Download an image URL via Node's https and return a base64 data URI.
     * This bypasses Chromium's network stack which fails on Windows 7 TLS.
     */
    fetchImageAsDataUrl(imageUrl: string): Promise<string | null> {
        return new Promise((resolve) => {
            try {
                const parsed = new URL(imageUrl);
                const req = https.request({
                    hostname: parsed.hostname,
                    path: parsed.pathname + parsed.search,
                    method: 'GET',
                    headers: { 'User-Agent': 'NexiaIDE' },
                }, (res) => {
                    // Follow redirects
                    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        this.fetchImageAsDataUrl(res.headers.location).then(resolve);
                        return;
                    }
                    if (res.statusCode && res.statusCode >= 400) { resolve(null); return; }
                    const chunks: Buffer[] = [];
                    res.on('data', (chunk: Buffer) => chunks.push(chunk));
                    res.on('end', () => {
                        const buffer = Buffer.concat(chunks);
                        const contentType = res.headers['content-type'] || 'image/png';
                        resolve(`data:${contentType};base64,${buffer.toString('base64')}`);
                    });
                });
                req.on('error', () => resolve(null));
                req.setTimeout(10000, () => { req.destroy(); resolve(null); });
                req.end();
            } catch { resolve(null); }
        });
    }

    /**
     * Log out the current user.
     */
    logout() {
        this.authUser = null;
    }

    /**
     * Fetch forum threads from the configured channel.
     */
    async getThreads(limit: number = 25): Promise<DiscordThread[]> {
        if (!this.isConfigured()) return [];

        // Return cached data if fresh
        if (this.cache && Date.now() - this.cache.fetchedAt < this.cacheTtl) {
            return this.cache.threads;
        }

        try {
            // Fetch active threads in the guild (forum threads are "threads")
            // For forum channels, we fetch the channel's threads
            const activeThreads = await this.fetchActiveThreads();
            const archivedThreads = await this.fetchArchivedThreads();

            // Combine and deduplicate
            const allThreads = new Map<string, any>();
            for (const t of [...activeThreads, ...archivedThreads]) {
                if (!allThreads.has(t.id)) allThreads.set(t.id, t);
            }

            // Fetch first message (preview) for each thread
            const threads: DiscordThread[] = [];
            const threadList = Array.from(allThreads.values())
                .sort((a, b) => {
                    const dateA = a.last_message_id || a.id;
                    const dateB = b.last_message_id || b.id;
                    return dateB.localeCompare(dateA); // Newest first
                })
                .slice(0, limit);

            for (const thread of threadList) {
                try {
                    const firstMsg = await this.fetchFirstMessage(thread.id);
                    threads.push({
                        id: thread.id,
                        name: thread.name || 'Untitled',
                        authorName: firstMsg?.author?.username || thread.owner_id || 'Unknown',
                        authorAvatar: firstMsg?.author?.avatar
                            ? `https://cdn.discordapp.com/avatars/${firstMsg.author.id}/${firstMsg.author.avatar}.${firstMsg.author.avatar.startsWith('a_') ? 'gif' : 'png'}?size=64`
                            : firstMsg?.author?.id
                                ? `https://cdn.discordapp.com/embed/avatars/${(BigInt(firstMsg.author.id) >> 22n) % 6n}.png`
                                : null,
                        createdAt: thread.thread_metadata?.create_timestamp
                            || new Date(Number(BigInt(thread.id) >> 22n) + 1420070400000).toISOString(),
                        messageCount: thread.message_count || 0,
                        lastMessageAt: thread.last_message_id
                            ? new Date(Number(BigInt(thread.last_message_id) >> 22n) + 1420070400000).toISOString()
                            : null,
                        tags: (thread.applied_tags || []),
                        preview: firstMsg?.content
                            ? firstMsg.content.substring(0, 300) + (firstMsg.content.length > 300 ? '...' : '')
                            : '',
                        pinned: !!(thread.flags && (thread.flags & 2)),
                    });
                } catch {
                    // Skip threads we can't fetch
                    threads.push({
                        id: thread.id,
                        name: thread.name || 'Untitled',
                        authorName: 'Unknown',
                        authorAvatar: null,
                        createdAt: new Date(Number(BigInt(thread.id) >> 22n) + 1420070400000).toISOString(),
                        messageCount: thread.message_count || 0,
                        lastMessageAt: null,
                        tags: [],
                        preview: '',
                        pinned: false,
                    });
                }
            }

            this.cache = { threads, fetchedAt: Date.now() };
            return threads;
        } catch (err: any) {
            console.error('Discord feed error:', err.message);
            return this.cache?.threads || [];
        }
    }

    /**
     * Authoritatively check whether a Discord user is in the Nexia guild.
     *
     * This asks the BOT, not the user. The old check read the user's own guild
     * list, which silently fails when their OAuth token is expired or was granted
     * before the `guilds` scope existed — making real members look like
     * non-members. The bot is already in the guild (it serves the forum feed),
     * so it can answer regardless of the user's scopes.
     *
     * Returns true (member), false (definitively not), or null (couldn't tell —
     * callers must NOT treat this as "not a member").
     */
    async isUserInGuild(userId: string): Promise<boolean | null> {
        if (!userId || !this.config?.botToken) return null;
        try {
            const guildId = await this.getGuildId();
            if (!guildId) return null;
            await this.apiGet(`/guilds/${guildId}/members/${userId}`);
            return true; // 200 → member
        } catch (err: any) {
            const msg = String(err?.message || '');
            if (msg.includes('404')) return false; // Discord says: not a member
            return null; // 401/403/429/network — unknown, don't guess
        }
    }

    /**
     * Get the guild ID from the forum channel (cached after first call).
     * Public so the guild-membership check can match by immutable ID.
     * Returns null when no bot token is configured (the channel lookup needs it).
     */
    async getGuildId(): Promise<string | null> {
        if (this.guildId) return this.guildId;
        try {
            const channel = await this.apiGet(`/channels/${this.config.channelId}`);
            this.guildId = channel.guild_id || null;
            return this.guildId;
        } catch {
            return null;
        }
    }

    /**
     * Fetch active (non-archived) threads in the forum channel.
     * Active threads require the guild-level endpoint, filtered by parent channel.
     */
    private async fetchActiveThreads(): Promise<any[]> {
        try {
            const guildId = await this.getGuildId();
            if (!guildId) return [];

            const data = await this.apiGet(`/guilds/${guildId}/threads/active`);
            const allActive = data.threads || [];
            // Filter to only threads belonging to our forum channel
            return allActive.filter((t: any) => t.parent_id === this.config.channelId);
        } catch {
            return [];
        }
    }

    /**
     * Fetch archived threads from the forum channel.
     */
    private async fetchArchivedThreads(): Promise<any[]> {
        try {
            const data = await this.apiGet(`/channels/${this.config.channelId}/threads/archived/public?limit=25`);
            return data.threads || [];
        } catch {
            return [];
        }
    }

    /**
     * Fetch the first message of a thread (the forum post content).
     */
    private async fetchFirstMessage(threadId: string): Promise<any> {
        const messages = await this.apiGet(`/channels/${threadId}/messages?limit=1&around=${threadId}`);
        if (Array.isArray(messages) && messages.length > 0) {
            return messages[0];
        }
        return null;
    }

    /**
     * Fetch all messages in a thread (up to 100).
     */
    async getThreadMessages(threadId: string): Promise<DiscordMessage[]> {
        if (!this.isConfigured()) return [];

        try {
            const rawMessages = await this.apiGet(`/channels/${threadId}/messages?limit=100`);
            if (!Array.isArray(rawMessages)) return [];

            // Reverse so oldest is first
            rawMessages.reverse();

            return this.parseMessages(rawMessages);
        } catch (err: any) {
            console.error('Failed to fetch thread messages:', err.message);
            return [];
        }
    }

    /**
     * Fetch only new messages after a specific message ID.
     * Returns empty array if no new messages.
     */
    async getNewMessages(threadId: string, afterMessageId: string): Promise<DiscordMessage[]> {
        if (!this.isConfigured()) return [];

        try {
            const rawMessages = await this.apiGet(`/channels/${threadId}/messages?after=${afterMessageId}&limit=50`);
            if (!Array.isArray(rawMessages) || rawMessages.length === 0) return [];

            // API returns newest first, reverse to chronological
            rawMessages.reverse();

            return this.parseMessages(rawMessages);
        } catch {
            return [];
        }
    }

    /**
     * Get the message count for a thread (for detecting new activity on the feed).
     */
    async getThreadInfo(threadId: string): Promise<{ messageCount: number } | null> {
        try {
            const channel = await this.apiGet(`/channels/${threadId}`);
            return { messageCount: channel.message_count || 0 };
        } catch {
            return null;
        }
    }

    private parseMessages(rawMessages: any[]): DiscordMessage[] {
        return rawMessages.map((msg: any) => ({
            id: msg.id,
            content: msg.content || '',
            authorName: msg.author?.username || 'Unknown',
            authorAvatar: msg.author?.avatar
                ? `https://cdn.discordapp.com/avatars/${msg.author.id}/${msg.author.avatar}.${msg.author.avatar.startsWith('a_') ? 'gif' : 'png'}?size=64`
                : msg.author?.id
                    ? `https://cdn.discordapp.com/embed/avatars/${(BigInt(msg.author.id) >> 22n) % 6n}.png`
                    : null,
            authorIsBot: !!msg.author?.bot,
            createdAt: msg.timestamp || new Date(Number(BigInt(msg.id) >> 22n) + 1420070400000).toISOString(),
            editedAt: msg.edited_timestamp || null,
            attachments: (msg.attachments || []).map((a: any) => ({
                id: a.id,
                filename: a.filename,
                url: a.url,
                size: a.size || 0,
                contentType: a.content_type || null,
            })),
            embeds: (msg.embeds || []).map((e: any) => ({
                title: e.title || null,
                description: e.description || null,
                url: e.url || null,
                color: e.color || null,
            })),
        }));
    }

    /**
     * Create a new forum thread (post) in the configured channel.
     * Requires an authenticated user.
     */
    async createThread(title: string, content: string): Promise<{ success: boolean; threadId?: string; error?: string }> {
        if (!this.isConfigured()) return { success: false, error: 'Discord not configured' };
        if (!this.authUser) return { success: false, error: 'Not logged in' };

        try {
            const attribution = `**${this.authUser.username}** via Nexia IDE`;
            const body = {
                name: title,
                message: {
                    content: `${content}\n\n--- *Posted by ${attribution}*`,
                },
            };

            const result = await this.apiPost(`/channels/${this.config.channelId}/threads`, body);
            this.cache = null; // Invalidate cache
            return { success: true, threadId: result.id };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }

    /**
     * Reply to an existing thread.
     * Requires an authenticated user.
     */
    async replyToThread(threadId: string, content: string): Promise<{ success: boolean; error?: string }> {
        if (!this.isConfigured()) return { success: false, error: 'Discord not configured' };
        if (!this.authUser) return { success: false, error: 'Not logged in' };

        try {
            const attribution = `**${this.authUser.username}**`;
            await this.apiPost(`/channels/${threadId}/messages`, {
                content: `${attribution}: ${content}`,
            });
            return { success: true };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }

    /**
     * Download an attachment to a local directory.
     */
    async downloadAttachment(url: string, destDir: string, filename: string): Promise<{ success: boolean; filePath?: string; error?: string }> {
        const filePath = path.join(destDir, filename);

        return new Promise((resolve) => {
            const getter = url.startsWith('https') ? https : http;

            const doDownload = (downloadUrl: string) => {
                getter.get(downloadUrl, (res) => {
                    // Follow redirects
                    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        doDownload(res.headers.location);
                        return;
                    }

                    if (res.statusCode !== 200) {
                        resolve({ success: false, error: `HTTP ${res.statusCode}` });
                        return;
                    }

                    const writeStream = fs.createWriteStream(filePath);
                    res.pipe(writeStream);

                    writeStream.on('finish', () => {
                        writeStream.close();
                        resolve({ success: true, filePath });
                    });

                    writeStream.on('error', (err) => {
                        fs.unlink(filePath, () => {});
                        resolve({ success: false, error: err.message });
                    });
                }).on('error', (err) => {
                    resolve({ success: false, error: err.message });
                });
            };

            doDownload(url);
        });
    }

    /**
     * Make an authenticated GET request to the Discord API.
     */
    private apiGet(endpoint: string): Promise<any> {
        return new Promise((resolve, reject) => {
            const options = {
                hostname: DISCORD_API,
                path: API_VERSION + endpoint,
                method: 'GET',
                headers: {
                    'Authorization': `Bot ${this.config.botToken}`,
                    'User-Agent': 'NexiaIDE (https://github.com/nexia-ide, 1.0)',
                    'Content-Type': 'application/json',
                },
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (res.statusCode && res.statusCode >= 400) {
                            reject(new Error(`Discord API ${res.statusCode}: ${json.message || data}`));
                        } else {
                            resolve(json);
                        }
                    } catch {
                        reject(new Error(`Discord API parse error: ${data.substring(0, 200)}`));
                    }
                });
            });

            req.on('error', reject);
            req.setTimeout(10000, () => { req.destroy(); reject(new Error('Discord API timeout')); });
            req.end();
        });
    }

    /**
     * Make an authenticated POST request to the Discord API.
     */
    private apiPost(endpoint: string, body: any): Promise<any> {
        return new Promise((resolve, reject) => {
            const bodyStr = JSON.stringify(body);
            const options = {
                hostname: DISCORD_API,
                path: API_VERSION + endpoint,
                method: 'POST',
                headers: {
                    'Authorization': `Bot ${this.config.botToken}`,
                    'User-Agent': 'NexiaIDE (https://github.com/nexia-ide, 1.0)',
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(bodyStr),
                },
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (res.statusCode && res.statusCode >= 400) {
                            reject(new Error(`Discord API ${res.statusCode}: ${json.message || data}`));
                        } else {
                            resolve(json);
                        }
                    } catch {
                        reject(new Error(`Discord API parse error: ${data.substring(0, 200)}`));
                    }
                });
            });

            req.on('error', reject);
            req.setTimeout(15000, () => { req.destroy(); reject(new Error('Discord API timeout')); });
            req.write(bodyStr);
            req.end();
        });
    }
}

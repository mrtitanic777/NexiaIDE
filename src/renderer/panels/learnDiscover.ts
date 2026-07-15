/**
 * learnDiscover.ts — the Learn panel's Videos and Web tabs.
 *
 * Two search surfaces that behave identically: type, press Enter, get a list.
 * Neither searches as you type. That is not a UI preference — YouTube's Data
 * API bills 100 quota units per search against a 10,000/day default, so
 * per-keystroke search would exhaust a user's entire day in one sentence.
 *
 * These live outside app.ts because they need almost none of it: an element to
 * render into, the current settings, and a way to open a URL. Everything else
 * about the Learn panel — the profile, the curriculum, the lesson viewer — is
 * app.ts's business and stays there.
 */

const { ipcRenderer: ipc } = require('electron');
const { IPC: CH } = require('../../shared/types');

interface DiscoverDeps {
    getSettings: () => any;
    openExternal: (url: string) => void;
    /** Opens the settings panel on the Learn tab, for the "add a key" prompt. */
    openSettings: () => void;
    escapeHtml: (s: string) => string;
}

let deps: DiscoverDeps = {
    getSettings: () => ({}),
    openExternal: () => {},
    openSettings: () => {},
    escapeHtml: (s) => s,
};

export function initDiscover(d: DiscoverDeps) { deps = d; }

/**
 * Last query and results per tab.
 *
 * Kept here rather than re-fetched on render because the panel re-renders every
 * time the user switches tabs, and a re-fetch would spend quota to redraw
 * something the user already had on screen.
 */
const cache: Record<'videos' | 'web', { query: string; html: string | null }> = {
    videos: { query: '', html: null },
    web: { query: '', html: null },
};

// ── Shared chrome ────────────────────────────────────────────────────────────

function searchBar(placeholder: string, initial: string, onSearch: (q: string) => void): HTMLElement {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;gap:6px;padding:8px 4px 10px';
    wrap.innerHTML = `
        <input type="text" class="ld-search-input" placeholder="${deps.escapeHtml(placeholder)}"
               value="${deps.escapeHtml(initial)}" spellcheck="false"
               style="flex:1;min-width:0;background:var(--bg-dark);border:1px solid var(--border);
                      border-radius:5px;padding:6px 9px;font-size:11.5px;color:var(--text);outline:none">
        <button class="learn-action-btn" style="padding:6px 12px;font-size:11px;flex:none">Search</button>`;

    const input = wrap.querySelector('input') as HTMLInputElement;
    const btn = wrap.querySelector('button') as HTMLButtonElement;

    const go = () => { const q = input.value.trim(); if (q) onSearch(q); };
    btn.addEventListener('click', go);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    input.addEventListener('focus', () => input.style.borderColor = 'var(--accent)');
    input.addEventListener('blur', () => input.style.borderColor = 'var(--border)');

    return wrap;
}

function statusBlock(text: string, kind: 'info' | 'error' = 'info'): HTMLElement {
    const d = document.createElement('div');
    d.style.cssText = `padding:14px 8px;font-size:11px;text-align:center;line-height:1.6;color:${
        kind === 'error' ? '#e06c75' : 'var(--text-muted)'}`;
    d.textContent = text;
    return d;
}

/**
 * The empty state for an unconfigured provider.
 *
 * A bare "no API key" would be a dead end — the user has no idea what to do
 * next. This says where to get one and opens the field it goes in.
 */
function setupBlock(message: string, keyUrl: string, keyLabel: string): HTMLElement {
    const d = document.createElement('div');
    d.style.cssText = 'padding:16px 10px;font-size:11px;color:var(--text-muted);line-height:1.7;text-align:center';
    d.innerHTML = `
        <div style="font-size:22px;margin-bottom:8px;opacity:.5">🔑</div>
        <div style="color:var(--text);margin-bottom:10px">${deps.escapeHtml(message)}</div>
        <div style="margin-bottom:12px">It's free and takes a few minutes.</div>`;

    const get = document.createElement('button');
    get.className = 'learn-action-btn';
    get.style.cssText = 'font-size:10.5px;padding:5px 12px;margin:0 3px';
    get.textContent = keyLabel;
    get.addEventListener('click', () => deps.openExternal(keyUrl));
    d.appendChild(get);

    const set = document.createElement('button');
    set.className = 'learn-action-btn learn-action-primary';
    set.style.cssText = 'font-size:10.5px;padding:5px 12px;margin:0 3px';
    set.textContent = 'Enter key';
    set.addEventListener('click', () => deps.openSettings());
    d.appendChild(set);

    return d;
}

/** Swap a results container's contents, remembering them for the next render. */
function paint(host: HTMLElement, results: HTMLElement, tab: 'videos' | 'web', node: HTMLElement) {
    results.innerHTML = '';
    results.appendChild(node);
    cache[tab].html = results.innerHTML;
    void host;
}

// ── Videos ───────────────────────────────────────────────────────────────────

export function renderVideosSection(host: HTMLElement) {
    host.innerHTML = '';

    const results = document.createElement('div');

    const run = async (q: string) => {
        cache.videos.query = q;
        results.innerHTML = '';
        results.appendChild(statusBlock('Searching YouTube…'));

        const res = await ipc.invoke(CH.SEARCH_VIDEOS, {
            query: q,
            apiKey: deps.getSettings().youtubeApiKey || '',
        });

        if (!res.success) {
            paint(host, results, 'videos', res.needsKey
                ? setupBlock(res.error, 'https://console.cloud.google.com/apis/library/youtube.googleapis.com', 'Get a key')
                : statusBlock(res.error, 'error'));
            return;
        }
        if (!res.results.length) {
            paint(host, results, 'videos', statusBlock(`No videos found for "${q}".`));
            return;
        }

        const list = document.createElement('div');
        list.style.cssText = 'display:flex;flex-direction:column;gap:8px';
        for (const v of res.results) list.appendChild(videoCard(v));
        paint(host, results, 'videos', list);
    };

    host.appendChild(searchBar('Search YouTube for tutorials…', cache.videos.query, run));

    if (cache.videos.html !== null) {
        // Restored markup has no listeners, so cards are rewired by delegation.
        results.innerHTML = cache.videos.html;
        results.addEventListener('click', (e) => {
            const card = (e.target as HTMLElement).closest('[data-video-url]') as HTMLElement;
            if (card) deps.openExternal(card.dataset.videoUrl!);
        });
    } else {
        results.appendChild(statusBlock('Search for a video to get started.'));
    }
    host.appendChild(results);
}

function videoCard(v: any): HTMLElement {
    const card = document.createElement('div');
    card.className = 'lesson-card';
    card.dataset.videoUrl = v.url;
    card.style.cssText = 'display:flex;gap:9px;padding:8px;cursor:pointer;align-items:flex-start';

    const when = v.published ? new Date(v.published).toLocaleDateString(undefined, { year: 'numeric', month: 'short' }) : '';

    card.innerHTML = `
        <div style="flex:none;width:76px;height:43px;border-radius:4px;overflow:hidden;background:var(--bg-dark);
                    display:flex;align-items:center;justify-content:center;font-size:15px;opacity:.6">▶</div>
        <div style="flex:1;min-width:0">
            <div style="font-size:11.5px;font-weight:600;color:var(--text);line-height:1.35;
                        display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">
                ${deps.escapeHtml(v.title)}</div>
            <div style="font-size:9.5px;color:var(--text-muted);margin-top:3px">
                ${deps.escapeHtml(v.channel)}${when ? ' · ' + deps.escapeHtml(when) : ''}</div>
        </div>`;

    // The thumbnail is set via src rather than a CSS background so a failed load
    // falls back to the ▶ placeholder instead of an empty box.
    if (v.thumbnail) {
        const img = document.createElement('img');
        img.src = v.thumbnail;
        img.style.cssText = 'width:100%;height:100%;object-fit:cover';
        img.addEventListener('error', () => img.remove());
        (card.firstElementChild as HTMLElement).innerHTML = '';
        (card.firstElementChild as HTMLElement).appendChild(img);
    }

    card.addEventListener('click', () => deps.openExternal(v.url));
    return card;
}

// ── Web ──────────────────────────────────────────────────────────────────────

export function renderWebSection(host: HTMLElement) {
    host.innerHTML = '';

    const results = document.createElement('div');

    const run = async (q: string) => {
        cache.web.query = q;
        results.innerHTML = '';
        results.appendChild(statusBlock('Searching…'));

        const s = deps.getSettings();
        const provider = s.searchProvider || 'google';
        const res = await ipc.invoke(CH.SEARCH_WEB, {
            query: q,
            provider,
            apiKey: s.searchApiKey || '',
            engineId: s.searchEngineId || '',
        });

        if (!res.success) {
            paint(host, results, 'web', res.needsKey
                ? setupBlock(
                    res.error,
                    provider === 'brave' ? 'https://brave.com/search/api/' : 'https://programmablesearchengine.google.com/',
                    'Get a key')
                : statusBlock(res.error, 'error'));
            return;
        }
        if (!res.results.length) {
            paint(host, results, 'web', statusBlock(`Nothing found for "${q}".`));
            return;
        }

        const list = document.createElement('div');
        list.style.cssText = 'display:flex;flex-direction:column;gap:2px';
        for (const r of res.results) list.appendChild(webRow(r));
        paint(host, results, 'web', list);
    };

    host.appendChild(searchBar('Search the web…', cache.web.query, run));

    if (cache.web.html !== null) {
        results.innerHTML = cache.web.html;
        results.addEventListener('click', (e) => {
            const row = (e.target as HTMLElement).closest('[data-url]') as HTMLElement;
            if (row) deps.openExternal(row.dataset.url!);
        });
    } else {
        results.appendChild(statusBlock('Search the web without leaving the IDE.'));
    }
    host.appendChild(results);
}

function webRow(r: any): HTMLElement {
    const row = document.createElement('div');
    row.dataset.url = r.url;
    row.style.cssText = 'padding:8px;border-radius:5px;cursor:pointer';
    row.innerHTML = `
        <div style="font-size:11.5px;font-weight:600;color:var(--accent);line-height:1.35;
                    display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">
            ${deps.escapeHtml(r.title)}</div>
        <div style="font-size:9.5px;color:#4ec9b0;margin:2px 0 3px">${deps.escapeHtml(r.site)}</div>
        <div style="font-size:10.5px;color:var(--text-muted);line-height:1.45;
                    display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden">
            ${deps.escapeHtml(r.snippet)}</div>`;

    row.addEventListener('mouseenter', () => row.style.background = 'rgba(255,255,255,0.05)');
    row.addEventListener('mouseleave', () => row.style.background = '');
    row.addEventListener('click', () => deps.openExternal(r.url));
    return row;
}

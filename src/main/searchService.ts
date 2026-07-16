/**
 * searchService.ts — the Learn panel's video and web search.
 *
 * The fetch, the JSON mapping and the error explanations are core/search.c now,
 * over WinHTTP rather than Node's https. This is the thin front that spawns it.
 *
 * WinHTTP because it does TLS, redirects and the chunked decode itself and ships
 * on Windows 7+, with the one caveat that matters here: it defaults to TLS 1.0 on
 * Windows 7 and the APIs refuse anything below 1.2, so core/http.c forces 1.2.
 *
 * The mapping is proven offline against fixture responses by search-parity.js;
 * the fetch and the error paths were verified against the real Google API
 * (a bogus key returns the same error message from both implementations). The
 * previous TypeScript is in _ts-backup/searchService.ts.bak — and it carries a
 * fix the C forced out: numeric HTML entities above U+FFFF (a common case,
 * emoji in a YouTube title) were mangled by String.fromCharCode and are decoded
 * correctly now.
 */

import { execFileSync } from 'child_process';
import * as path from 'path';

export interface VideoResult {
    id: string;
    title: string;
    channel: string;
    published: string;
    thumbnail: string;
    description: string;
    url: string;
}

export interface WebResult {
    title: string;
    url: string;
    snippet: string;
    site: string;
}

export type SearchResponse<T> =
    | { success: true; results: T[] }
    | { success: false; error: string; needsKey?: boolean };

export type WebProvider = 'google' | 'brave';

/**
 * Run a nexia-core `search` command. Its stdout is the SearchResponse verbatim —
 * success with results, or failure with a message the panel shows — so this
 * parses and returns it. A spawn that fails outright (the binary missing) becomes
 * a plain error response rather than a throw, matching the old catch-all.
 */
function core<T>(args: string[]): SearchResponse<T> {
    const exe = path.join(__dirname, '..', 'nexia-core.exe');
    try {
        const out = execFileSync(exe, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
        return JSON.parse(out);
    } catch (err: any) {
        const out = err?.stdout?.toString();
        if (out) { try { return JSON.parse(out); } catch { /* fall through */ } }
        return { success: false, error: 'Search is unavailable (nexia-core did not run).' };
    }
}

/** Search YouTube via the Data API v3. */
export async function searchVideos(query: string, apiKey: string, max = 20): Promise<SearchResponse<VideoResult>> {
    return core<VideoResult>(['search', 'youtube', apiKey || '', query || '', String(max)]);
}

/** Search the web via Google Programmable Search or Brave. */
export async function searchWeb(
    query: string,
    cfg: { provider: WebProvider; apiKey: string; engineId?: string },
): Promise<SearchResponse<WebResult>> {
    const provider = cfg?.provider || 'google';
    const args = ['search', 'web', provider, cfg?.apiKey || '', query || ''];
    if (provider === 'google' && cfg?.engineId) args.push('--cx', cfg.engineId);
    return core<WebResult>(args);
}

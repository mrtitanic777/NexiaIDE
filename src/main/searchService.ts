/**
 * searchService.ts — the Learn panel's video and web search.
 *
 * Both are thin fronts over a provider's public API, and both live in the main
 * process for the same reason: a renderer request would carry a page origin, and
 * neither googleapis.com nor api.search.brave.com returns CORS headers that
 * would let it through. Node has no such restriction.
 *
 * Deliberately not scraping. It was considered and rejected: YouTube's terms
 * prohibit it, and a scraper breaks the day either site touches its markup —
 * silently, in every copy already installed, with no fix short of a full
 * release. Worse, the failure looks like "search is broken" rather than
 * "YouTube changed", so nobody reports it usefully. An API key is something a
 * user obtains once and that keeps working.
 *
 * Keys are passed in per call rather than held here. Settings live in the
 * renderer, this stays stateless, and no key is ever written to a log or an
 * error string — see redact().
 */

import * as https from 'https';

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

/**
 * `needsKey` separates "you haven't set this up" from "it broke". The panel
 * shows setup instructions for the first and an error for the second; without
 * the distinction a fresh install looks like a bug.
 */
export type SearchResponse<T> =
    | { success: true; results: T[] }
    | { success: false; error: string; needsKey?: boolean };

export type WebProvider = 'google' | 'brave';

/** Strip anything key-shaped out of text bound for a log or the UI. */
function redact(text: string): string {
    return text.replace(/([?&](?:key|token)=)[^&\s]+/gi, '$1[redacted]');
}

/**
 * GET a JSON document.
 *
 * The size cap is not paranoia about the providers themselves — it's that a
 * captive-portal or ISP interstitial answers 200 with an arbitrary page, and
 * without a cap we'd buffer whatever it feels like sending before failing to
 * parse it.
 */
function getJson(url: string, headers: Record<string, string> = {}): Promise<any> {
    const MAX_BYTES = 4 * 1024 * 1024;
    const TIMEOUT_MS = 15000;

    return new Promise((resolve, reject) => {
        const doGet = (target: string, redirects = 0) => {
            if (redirects > 5) return reject(new Error('Too many redirects'));

            const req = https.get(target, {
                headers: { 'User-Agent': 'NexiaIDE', Accept: 'application/json', ...headers },
            }, (res: any) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    return doGet(new URL(res.headers.location, target).toString(), redirects + 1);
                }

                let body = '';
                let bytes = 0;
                res.setEncoding('utf8');
                res.on('data', (chunk: string) => {
                    bytes += Buffer.byteLength(chunk);
                    if (bytes > MAX_BYTES) {
                        req.destroy();
                        return reject(new Error('Response too large'));
                    }
                    body += chunk;
                });
                res.on('end', () => {
                    // Error responses carry a useful JSON message far more often
                    // than not, so parse before judging the status code.
                    let parsed: any = null;
                    try { parsed = JSON.parse(body); } catch { /* handled below */ }

                    if (res.statusCode !== 200) {
                        const apiMsg = parsed?.error?.message || parsed?.message;
                        return reject(Object.assign(
                            new Error(apiMsg ? redact(String(apiMsg)) : `HTTP ${res.statusCode}`),
                            { statusCode: res.statusCode, reason: parsed?.error?.errors?.[0]?.reason },
                        ));
                    }
                    if (parsed === null) return reject(new Error('The response was not valid JSON'));
                    resolve(parsed);
                });
            });

            req.setTimeout(TIMEOUT_MS, () => {
                req.destroy();
                reject(new Error('The search timed out'));
            });
            req.on('error', (err: Error) => reject(new Error(redact(err.message))));
        };

        doGet(url);
    });
}

/** Turn a thrown error into the message the panel will actually show. */
function explain(err: any, provider: string): string {
    const status = err?.statusCode;
    const reason = err?.reason;

    // The one everybody hits. YouTube spends the same 403 on a bad key and an
    // exhausted quota, and the two need opposite responses from the user, so
    // the reason field is the only thing that tells them apart.
    if (status === 403 && reason === 'quotaExceeded') {
        return `${provider} has cut you off for the day — the free quota is spent. It resets at midnight Pacific.`;
    }
    if (status === 403 || status === 401) {
        return `${provider} rejected the API key. Check it in Settings → Learn.`;
    }
    if (status === 429) return `${provider} is rate limiting you. Wait a moment and try again.`;
    if (status === 400) return `${provider} rejected the request: ${err.message}`;

    const msg = String(err?.message || err);
    if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT/.test(msg)) return 'No connection to the internet.';
    return redact(msg);
}

/**
 * Search YouTube via the Data API v3.
 *
 * Costs 100 quota units per call against a 10,000/day default — i.e. 100
 * searches a day. That is the whole reason results are not fetched as you type.
 */
export async function searchVideos(query: string, apiKey: string, max = 20): Promise<SearchResponse<VideoResult>> {
    const q = (query || '').trim();
    if (!q) return { success: true, results: [] };
    if (!apiKey) {
        return {
            success: false,
            needsKey: true,
            error: 'Video search needs a YouTube Data API key.',
        };
    }

    const url = 'https://www.googleapis.com/youtube/v3/search'
        + '?part=snippet&type=video&safeSearch=moderate'
        + `&maxResults=${Math.min(Math.max(max, 1), 50)}`
        + `&q=${encodeURIComponent(q)}`
        + `&key=${encodeURIComponent(apiKey)}`;

    try {
        const data = await getJson(url);
        const results: VideoResult[] = (data.items || [])
            // A deleted-but-indexed video comes back with no videoId; rendering
            // one produces a card that opens nothing.
            .filter((it: any) => it?.id?.videoId)
            .map((it: any) => {
                const sn = it.snippet || {};
                const th = sn.thumbnails || {};
                return {
                    id: it.id.videoId,
                    title: decodeEntities(sn.title || 'Untitled'),
                    channel: decodeEntities(sn.channelTitle || ''),
                    published: sn.publishedAt || '',
                    thumbnail: (th.medium || th.default || {}).url || '',
                    description: decodeEntities(sn.description || ''),
                    url: `https://www.youtube.com/watch?v=${it.id.videoId}`,
                };
            });
        return { success: true, results };
    } catch (err) {
        return { success: false, error: explain(err, 'YouTube') };
    }
}

/**
 * Search the web.
 *
 * Two providers because they fail differently: Google's Programmable Search is
 * the one people already have keys for but caps free use at 100 queries/day and
 * needs a second value (the engine id) that is easy to omit; Brave's is one
 * value and a far larger free tier. Neither is a clear default, so it's a
 * setting.
 */
export async function searchWeb(
    query: string,
    cfg: { provider: WebProvider; apiKey: string; engineId?: string },
): Promise<SearchResponse<WebResult>> {
    const q = (query || '').trim();
    if (!q) return { success: true, results: [] };

    const provider = cfg?.provider || 'google';
    if (!cfg?.apiKey) {
        return {
            success: false,
            needsKey: true,
            error: provider === 'brave'
                ? 'Web search needs a Brave Search API key.'
                : 'Web search needs a Google Programmable Search key.',
        };
    }
    if (provider === 'google' && !cfg.engineId) {
        return {
            success: false,
            needsKey: true,
            error: 'Google Programmable Search also needs a Search engine ID.',
        };
    }

    try {
        if (provider === 'brave') {
            const data = await getJson(
                `https://api.search.brave.com/res/v1/web/search?count=20&q=${encodeURIComponent(q)}`,
                { 'X-Subscription-Token': cfg.apiKey },
            );
            const results: WebResult[] = (data?.web?.results || []).map((r: any) => ({
                title: decodeEntities(stripTags(r.title || '')),
                url: r.url || '',
                snippet: decodeEntities(stripTags(r.description || '')),
                site: siteOf(r.url || ''),
            }));
            return { success: true, results };
        }

        const url = 'https://www.googleapis.com/customsearch/v1'
            + `?key=${encodeURIComponent(cfg.apiKey)}`
            + `&cx=${encodeURIComponent(cfg.engineId!)}`
            + `&num=10&q=${encodeURIComponent(q)}`;
        const data = await getJson(url);
        const results: WebResult[] = (data.items || []).map((r: any) => ({
            title: decodeEntities(r.title || ''),
            url: r.link || '',
            snippet: decodeEntities(r.snippet || ''),
            site: r.displayLink || siteOf(r.link || ''),
        }));
        return { success: true, results };
    } catch (err) {
        return { success: false, error: explain(err, provider === 'brave' ? 'Brave Search' : 'Google') };
    }
}

/** Brave returns highlighted markup in titles and snippets; the panel wants text. */
function stripTags(s: string): string {
    return s.replace(/<[^>]*>/g, '');
}

/**
 * Both APIs return titles with HTML entities in them ("C&#39;s pointers").
 * The renderer escapes before inserting, so an un-decoded entity would render
 * literally as `&#39;`.
 */
function decodeEntities(s: string): string {
    return s
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        // Ampersand last, or "&amp;lt;" would round-trip into "<".
        .replace(/&amp;/g, '&');
}

function siteOf(url: string): string {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

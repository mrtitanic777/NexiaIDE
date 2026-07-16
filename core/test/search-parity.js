/**
 * search-parity.js — prove core/search.c maps a provider's JSON to the same
 * results as searchService.ts.
 *
 * The mapping is the deterministic half — HTML entity decoding, Brave's markup
 * stripping, the deleted-video filter, the thumbnail fallback, the displayLink
 * preference. The fetch (nx_http_get, WinHTTP) needs live API keys and is not
 * parity-testable, so the C exposes `search map <provider> <file>` to run the
 * mapping on a fixture response, and this drives it against the TypeScript's own
 * mappers over the same fixtures.
 *
 * The TypeScript mappers are inline in searchVideos/searchWeb, so the fixtures
 * are fed through the real exported functions with the network stubbed — the
 * arguments captured on their way out is the only way this can't be wrong in the
 * same direction as the code.
 *
 *   npx tsc && node core/test/search-parity.js
 */
const fs = require('fs'), path = require('path'), os = require('os');
const { execFileSync } = require('child_process');

const R = process.cwd();
const CORE = path.join(R, 'dist', 'nexia-core.exe');
if (!fs.existsSync(CORE)) {
    console.error('   [X] dist/nexia-core.exe missing — run: node scripts/build-core.js');
    process.exit(1);
}

// Load the live searchService with its https.get stubbed to return our fixture,
// so its real mapping runs. Module cache is bypassed per call by swapping the
// stub's payload.
const Module = require('module');
const httpsPath = require.resolve('https');
let FIXTURE = null;
const realHttps = require('https');
require.cache[httpsPath] = {
    id: httpsPath, filename: httpsPath, loaded: true, exports: {
        ...realHttps,
        get(_url, _opts, cb) {
            const res = {
                statusCode: 200, headers: {},
                setEncoding() {}, resume() {},
                on(ev, fn) {
                    if (ev === 'data') fn(JSON.stringify(FIXTURE));
                    if (ev === 'end') fn();
                    return this;
                },
            };
            const callback = typeof _opts === 'function' ? _opts : cb;
            callback(res);
            return { setTimeout() {}, on() { return this; }, destroy() {} };
        },
    },
};
// _ts-backup/searchService.ts.bak, not the live module: the live searchVideos /
// searchWeb spawn nexia-core now, so they would just re-run the C. The .bak holds
// the original TypeScript mappers (with the astral-entity fix the C forced).
// Delete it and this test retires — see _ts-backup/README.md.
const BAK = path.join(R, 'src', 'main', '_ts-backup', 'searchService.ts.bak');
if (!fs.existsSync(BAK)) {
    console.log('  _ts-backup/searchService.ts.bak is gone - nothing left to compare against.');
    process.exit(0);
}
const tsc = require(path.join(R, 'node_modules', 'typescript'));
const ssJs = tsc.transpileModule(fs.readFileSync(BAK, 'utf8'), {
    compilerOptions: { module: tsc.ModuleKind.CommonJS, target: tsc.ScriptTarget.ES2019 },
}).outputText;
const ssBox = { exports: {} };
new Function('require', 'exports', 'module', ssJs).call(ssBox, require, ssBox.exports, ssBox);
const ss = ssBox.exports;

const core = (provider, fixture) => {
    const f = path.join(os.tmpdir(), `nexia-searchfix-${process.pid}-${Math.abs(hash(JSON.stringify(fixture)))}.json`);
    fs.writeFileSync(f, JSON.stringify(fixture), 'utf-8');
    const out = JSON.parse(execFileSync(CORE, ['search', 'map', provider, f], { encoding: 'utf8' }));
    fs.unlinkSync(f);
    return out;
};
function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

let checks = 0, bad = 0;
const fail = (m) => { bad++; console.log('  *** ' + m); };

async function check(label, provider, fixture, tsCall) {
    FIXTURE = fixture;
    const ts = await tsCall();
    const c = core(provider, fixture);
    checks++;
    // Compare only results (the C `map` emits success:true always; the TS may add
    // needsKey on other paths, not these).
    const a = JSON.stringify(ts.results), b = JSON.stringify(c.results);
    if (a !== b) {
        fail(`${label}: results differ`);
        console.log('      ts: ' + a);
        console.log('      c:  ' + b);
    } else {
        console.log(`  ${label.padEnd(28)} ${ts.results.length} results match`);
    }
}

(async () => {
    // ── YouTube ──
    await check('youtube: basic + entities', 'youtube', {
        items: [
            { id: { videoId: 'abc123' }, snippet: {
                title: 'C&#39;s pointers &amp; refs', channelTitle: 'Xbox &lt;Dev&gt;',
                publishedAt: '2020-01-01T00:00:00Z', description: 'A &quot;deep&quot; dive',
                thumbnails: { medium: { url: 'http://i.ytimg.com/m.jpg' }, default: { url: 'http://i.ytimg.com/d.jpg' } } } },
            // deleted-but-indexed: no videoId -> filtered out
            { id: {}, snippet: { title: 'gone' } },
            // no medium thumbnail -> falls back to default
            { id: { videoId: 'xyz789' }, snippet: { title: 'No medium thumb',
                thumbnails: { default: { url: 'http://i.ytimg.com/only-default.jpg' } } } },
            // emoji entity
            { id: { videoId: 'emo' }, snippet: { title: 'Fun &#128512; times', thumbnails: {} } },
        ],
    }, () => ss.searchVideos('q', 'KEY'));

    // ── Brave ──
    await check('brave: markup + site', 'brave', {
        web: { results: [
            { title: '<strong>Fast</strong> &amp; free', url: 'https://www.example.com/path?x=1',
              description: 'A <b>bold</b> &lt;snippet&gt;' },
            { title: 'No www', url: 'https://docs.rust-lang.org/book' },
        ] },
    }, () => ss.searchWeb('q', { provider: 'brave', apiKey: 'KEY' }));

    // ── Google ──
    await check('google: displayLink + entities', 'google', {
        items: [
            { title: 'C&amp;C++', link: 'https://learn.microsoft.com/xbox', snippet: 'Docs &#39;here&#39;',
              displayLink: 'learn.microsoft.com' },
            { title: 'No displayLink', link: 'https://www.foo.org/a' },  // -> siteOf strips www.
        ],
    }, () => ss.searchWeb('q', { provider: 'google', apiKey: 'KEY', engineId: 'CX' }));

    // ── empty results ──
    await check('youtube: empty', 'youtube', { items: [] }, () => ss.searchVideos('q', 'KEY'));

    console.log();
    console.log('  ================================================================');
    console.log(bad === 0
        ? `  ALL ${checks} SEARCH MAP CHECKS PASS`
        : `  *** ${bad} MISMATCH(ES) across ${checks} checks`);
    process.exit(bad ? 1 : 0);
})().catch(e => { console.error('FAILED:', e.message, '\n', e.stack); process.exit(1); });

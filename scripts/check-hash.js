/**
 * check-hash.js — Check if a file has changed since the last successful build
 *
 * Usage:
 *   node check-hash.js <file> [file2] ...            -> prints "changed" or "same"
 *   node check-hash.js --commit <file> [file2] ...   -> records the current hash
 *
 * Computes MD5 of all input files combined and compares against the hash stored
 * in dist/.build-cache/.
 *
 * Checking NEVER writes. The hash is only recorded via --commit, which callers
 * must run *after* the corresponding build step succeeds.
 *
 * This used to record the hash at the moment it reported "changed" — before
 * anything was compiled. Two ways that silently shipped stale binaries:
 *   - A failed compile left the hash committed, so the next build reported
 *     "same", skipped the compile, and packed the previously-built binary.
 *   - Running it to inspect state consumed the "changed" signal, so the real
 *     build then skipped the rebuild.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const commit = args[0] === '--commit';
const files = commit ? args.slice(1) : args;

if (files.length === 0) {
    if (!commit) process.stdout.write('changed');
    process.exit(0);
}

const cacheDir = path.join(__dirname, '..', 'dist', '.build-cache');
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

// Build a cache key from filenames
const key = files.map(f => path.basename(f)).join('_').replace(/[^a-zA-Z0-9_.-]/g, '');
const hashFile = path.join(cacheDir, key + '.md5');

// Compute combined hash. A missing input means the cache can't be vouched for,
// so report "changed" and let the caller rebuild.
const hasher = crypto.createHash('md5');
for (const f of files) {
    try {
        hasher.update(fs.readFileSync(f));
    } catch {
        if (!commit) process.stdout.write('changed');
        process.exit(0);
    }
}
const hash = hasher.digest('hex');

if (commit) {
    fs.writeFileSync(hashFile, hash);
    process.exit(0);
}

let stored = null;
try { stored = fs.readFileSync(hashFile, 'utf8').trim(); } catch { /* no prior build */ }
process.stdout.write(stored === hash ? 'same' : 'changed');

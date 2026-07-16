/**
 * coreLog.ts — optional, env-gated tracing of every nexia-core spawn.
 *
 * Off unless NEXIA_CORE_LOG names a file to append to, so it costs nothing and
 * ships harmlessly. When on, each nexia-core call is logged with its argv, exit
 * status, duration, and — on failure — the stderr/stdout, so an integration
 * problem in the running IDE (a command that refuses, crashes, or returns
 * unparseable JSON) shows up in one place instead of as a generic thrown error.
 */
import * as fs from 'fs';

const LOG_FILE = process.env.NEXIA_CORE_LOG;

export const coreLogEnabled = !!LOG_FILE;

function write(line: string): void {
    if (!LOG_FILE) return;
    try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch { /* logging must never break the IDE */ }
}

/** Log a completed nexia-core call. `err` present means it threw/refused. */
export function logCore(args: string[], startMs: number, err?: any, rawOut?: string): void {
    if (!LOG_FILE) return;
    const ms = Date.now() - startMs;
    const cmd = args.slice(0, 3).join(' ');
    if (err) {
        const exit = err?.status ?? err?.code ?? '?';
        const out = (err?.stdout?.toString() || rawOut || '').replace(/\s+/g, ' ').slice(0, 300);
        write(`[${new Date().toISOString()}] FAIL exit=${exit} (${ms}ms)  ${cmd}  :: ${out}`);
    } else {
        const preview = (rawOut || '').replace(/\s+/g, ' ').slice(0, 120);
        write(`[${new Date().toISOString()}] ok   (${ms}ms)  ${cmd}  -> ${preview}`);
    }
}

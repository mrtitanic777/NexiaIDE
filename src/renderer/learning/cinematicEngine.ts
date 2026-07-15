/**
 * cinematicEngine.ts — Pure presentation machine
 *
 * Ported from the proof-of-concept engine.js into TypeScript.
 * Zero content knowledge. Consumes CFG, SYNTAX, and lesson data.
 *
 * This module builds its own DOM inside a provided container element,
 * manages its own audio context, spotlight SVG overlays, arrow system,
 * explanation panels, token-explain mode, typing animation, and erase phase.
 *
 * Lifecycle:
 *   1. cinematicEngine.mount(container) — Build DOM, wire controls
 *   2. cinematicEngine.start()          — Run the full cinematic sequence
 *   3. cinematicEngine.stop()           — Cancel mid-animation
 *   4. cinematicEngine.unmount()        — Tear down DOM, release resources
 */

// cinematicConfig kept for type reference only
import type { SyntaxConfig } from './cinematicConfig';
// Type imports only from lesson data module
import type { LessonBlock, LessonLine, TokenLine } from './cinematicLessonData';
import { injectCinematicStyles, removeCinematicStyles } from './cinematicStyles';
import {
    LessonPackage, convertV1ToV2, loadFromJSON, DEFAULT_TIMING, DEFAULT_AUDIO, DEFAULT_STYLE, DEFAULT_SYNTAX,
    LessonBlock as V2Block, BlockLine, Overlay, TimingDef, AudioDef, StyleDef, SyntaxDef, LayoutDef,
} from './lessonLoader';

// ── Active Package (v2) ──
// The engine reads ALL values from this package. No other source of truth.

let pkg: LessonPackage | null = null;

// Package-driven accessors — the engine calls these instead of reading CFG/SYNTAX directly
function T(): TimingDef { return pkg?.timing || DEFAULT_TIMING; }
function A(): AudioDef { return pkg?.audio || DEFAULT_AUDIO; }
function S(): StyleDef { return pkg?.style || DEFAULT_STYLE; }
function SYN(): SyntaxDef { return pkg?.syntax || DEFAULT_SYNTAX; }

// ── Active Lesson Data (empty by default — populated by loadLesson/loadPackage) ──

let activeBlocks: LessonBlock[] = [];
let activeOldCode: string[] = [];
let activeExpl: Record<string, any> = {};
let activeConnections: Record<string, any[]> = {};
let activeTokens: Record<string, TokenLine[]> = {};
let activeVisControls: Record<string, any[]> = {};
let activeAnimatedVis: Set<string> = new Set();
let activeBlockVis: Record<string, (c: CanvasRenderingContext2D, w: number, h: number, v?: Record<string, any>) => void> = {};
let activeTokenVis: Record<string, (c: CanvasRenderingContext2D, w: number, h: number) => void> = {};

// ── Layout Data (baked positions from Lesson Builder) ──

interface LayoutRect { x: number; y: number; width: number; height: number; }
interface BlockLayoutData { spotlight: LayoutRect; panel: LayoutRect; }
interface ConnLayoutData { srcSpotlight: LayoutRect; dstSpotlight: LayoutRect; }
interface FullLayoutData {
    blocks: Record<string, BlockLayoutData>;
    tokens: Record<string, { spotlight: LayoutRect; panel: LayoutRect }[]>;
    connections: Record<string, { srcSpotlight: LayoutRect; dstSpotlight: LayoutRect }[]>;
    canvasWidth: number;
    canvasHeight: number;
}

let activeLayout: FullLayoutData | null = null;
let _layoutXOffset = 0; // Pixel delta between builder and engine coordinate systems
let _layoutXMeasured = false;

/**
 * Measure the actual X offset between builder layout coords and engine DOM coords.
 * Called once when the first code line element is in the DOM and rendered.
 * Uses the real element position as ground truth instead of guessing.
 */
function _measureLayoutOffset(lineEl: HTMLElement) {
    if (_layoutXMeasured) return;
    _layoutXMeasured = true;

    // Where the code text actually starts in the engine's .ct-ei coordinate space.
    const eiEl = ed.parentElement; // .ct-ei
    if (!eiEl) return;
    const eiRect = eiEl.getBoundingClientRect();
    const lineRect = lineEl.getBoundingClientRect();
    const engineCodeX = lineRect.left - eiRect.left;

    // Builder preview: gutter=44, code-area margin-left=48, padding-left=8 → code at 56px
    const builderCodeX = 56;

    // Add one character width so the spotlight border sits just to the right of the
    // gutter/cursor line, with a small gap before the first code character.
    const charNudge = 8; // ~1 character width at 13px JetBrains Mono

    _layoutXOffset = engineCodeX - builderCodeX + charNudge;
}

// ── Infrastructure ──

const _disposables: (() => void)[] = [];
function trackDisposable(fn: () => void) { _disposables.push(fn); }
function disposeAll() { while (_disposables.length) _disposables.pop()!(); }

const vizCtrl = {
    _raf: null as number | null,
    _fn: null as (() => void) | null,
    start(fn: () => void) {
        this.stop(); this._fn = fn;
        const loop = () => { if (this._fn) { this._fn(); this._raf = requestAnimationFrame(loop); } };
        this._raf = requestAnimationFrame(loop);
    },
    stop() { if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; } this._fn = null; },
};

const tokVizCtrl = {
    _raf: null as number | null,
    _fn: null as (() => void) | null,
    start(fn: () => void) {
        this.stop(); this._fn = fn;
        const loop = () => { if (this._fn) { this._fn(); this._raf = requestAnimationFrame(loop); } };
        this._raf = requestAnimationFrame(loop);
    },
    stop() { if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; } this._fn = null; },
};

// ── Audio ──

let ac: AudioContext | null = null;
function initAudio() { if (!ac) ac = new (window.AudioContext || (window as any).webkitAudioContext)(); }

let _ksBuf: AudioBuffer | null = null;
let _bksBuf: AudioBuffer | null = null;

function _renderBuf(freq: number, dur: number, vol: number): AudioBuffer | null {
    if (!ac) return null;
    const sr = ac.sampleRate, len = Math.ceil(dur * sr), buf = ac.createBuffer(1, len, sr), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) { const t = i / sr; d[i] = vol * Math.exp(-t / dur * 6) * Math.sin(2 * Math.PI * freq * t); }
    return buf;
}

function _ensureBufs() {
    if (!ac) return;
    if (!_ksBuf) _ksBuf = _renderBuf(1100, A().keystroke.duration, A().keystroke.volume);
    if (!_bksBuf) _bksBuf = _renderBuf(A().blockComplete.frequency, A().blockComplete.duration, A().blockComplete.volume);
}

function _playBuf(buf: AudioBuffer | null, rate?: number) {
    if (!ac || !buf) return;
    const s = ac.createBufferSource(); s.buffer = buf; s.playbackRate.value = rate || 1;
    s.connect(ac.destination); s.start();
}

function sndKeystroke() { if (!ac) return; _ensureBufs(); _playBuf(_ksBuf, 0.7 + Math.random() * 0.6); }
function sndBlockComplete() { if (!ac) return; _ensureBufs(); _playBuf(_bksBuf, 1); }
function sndLinkChime() {
    if (!ac) return;
    A().linkChime.frequencies.forEach((f, i) => {
        const o = ac!.createOscillator(), g = ac!.createGain();
        o.connect(g); g.connect(ac!.destination); o.frequency.value = f; o.type = 'sine';
        g.gain.value = A().linkChime.volume;
        g.gain.exponentialRampToValueAtTime(0.0001, ac!.currentTime + A().linkChime.duration + i * A().linkChime.stagger);
        o.start(ac!.currentTime + i * A().linkChime.stagger);
        o.stop(ac!.currentTime + A().linkChime.duration + i * A().linkChime.stagger);
    });
}

// ── Syntax Highlighter ──

function esc(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function hl(t: string): string {
    const syn = SYN();
    const C = syn.colors;
    // Build Sets for fast lookup (cached per call — cheap since hl is called frequently)
    const kwSet = new Set(syn.keywords);
    const tySet = new Set(syn.types);
    const seSet = new Set(syn.semantics);
    let r = '', i = 0;
    while (i < t.length) {
        if (t.substr(i, syn.lineComment.length) === syn.lineComment) { r += `<span class="ct-sc" style="color:${C.comment}">${esc(t.substr(i))}</span>`; break; }
        let fd = false;
        for (const d of syn.directives) { if (t.substr(i, d.length) === d) { r += `<span class="ct-sd" style="color:${C.directive}">${d}</span>`; i += d.length; fd = true; break; } }
        if (fd) continue;
        if (t[i] === syn.stringDelim) { let e = t.indexOf(syn.stringDelim, i + 1); if (e < 0) e = t.length - 1; r += `<span class="ct-ss" style="color:${C.string}">${esc(t.substring(i, e + 1))}</span>`; i = e + 1; continue; }
        if (/\d/.test(t[i]) && (i === 0 || !/\w/.test(t[i - 1]))) { let n = ''; while (i < t.length && /[\d.xXfF]/.test(t[i])) { n += t[i]; i++; } r += `<span class="ct-sn" style="color:${C.number}">${n}</span>`; continue; }
        if (/[a-zA-Z_]/.test(t[i])) {
            let w = ''; while (i < t.length && /[\w]/.test(t[i])) { w += t[i]; i++; }
            if (kwSet.has(w)) r += `<span class="ct-sk" style="color:${C.keyword}">${w}</span>`;
            else if (tySet.has(w)) r += `<span class="ct-st" style="color:${C.type}">${w}</span>`;
            else if (seSet.has(w)) r += `<span class="ct-se" style="color:${C.semantic}">${w}</span>`;
            else if (i < t.length && t[i] === '(') r += `<span class="ct-sf" style="color:${C.function}">${w}</span>`;
            else if (syn.macroPrefixes.some(p => w.startsWith(p))) r += `<span class="ct-sm" style="color:${C.macro}">${w}</span>`;
            else r += w;
            continue;
        }
        r += esc(t[i]); i++;
    }
    return r;
}

// ── Lesson Data Processing ──

interface ProcessedLine extends LessonLine {
    c?: number;
}

let LINES: ProcessedLine[] = [];
let blockMap: Record<string, LessonBlock> = {};
let totC = 0;

function processLesson(blocks: any[]) {
    LINES = []; blockMap = {}; totC = 0;
    blocks.forEach(b => {
        b._start = LINES.length;
        b.lines.forEach((l: any) => { LINES.push(l); });
        b._end = LINES.length - 1;
        blockMap[b.id] = b;
    });
    // Support both v1 (l.t) and v2 (l.text) field names
    LINES.forEach(l => totC += ((l as any).text || (l as any).t || '').length);
}

// ── Engine State ──

let run = false;
let dead = false;
/**
 * Monotonic run token. Every start/replay captures `++runToken` at the top of
 * the sequence; stop()/unmount()/replay bump it. The sl() helper and every loop
 * iteration compare their captured token against this — a mismatch means a newer
 * run (or teardown) began, so stale already-scheduled setTimeout/RAF/Promise
 * continuations from the previous run abort instead of animating against a
 * torn-down or reset DOM. The `dead` flag is kept working alongside it.
 */
let runToken = 0;
let doneC = 0;
let t0 = 0;
let usrScr = false;
let scrTmr: ReturnType<typeof setTimeout> | null = null;
let curLine: number | null = null;
let spotStart: number | null = null;
let spotEnd: number | null = null;
let expResolve: (() => void) | null = null;
let expTimeout: ReturnType<typeof setTimeout> | null = null;
let _cubeAnim: number | null = null;
let _dualSpotActive = false;

// ── DOM References (set during mount) ──

let ed: HTMLElement;
let gut: HTMLElement;
let co: HTMLElement;
let vig: HTMLElement;
let badge: HTMLElement;
let pfl: HTMLElement;
let tlbl: HTMLElement;
let rbar: HTMLElement;
let spdR: HTMLInputElement;
let spdL: HTMLElement;
let bPlay: HTMLElement;
let bStop: HTMLElement;
let bReplay: HTMLElement;
let spotEl: HTMLElement;
let spot2El: HTMLElement;
let shEl: SVGRectElement;
let sh2El: SVGRectElement;
let asvg: SVGSVGElement;
let epEl: HTMLElement;
let epcEl: HTMLElement;
let miniExpEl: HTMLElement;
let rootContainer: HTMLElement;

// ── Line Width Cache ──

let _mCtx: CanvasRenderingContext2D;
const _lineWidthCache = new Map<number, number>();
let _cacheFontSize = '13px';

function invalidateLineWidthCache() { _lineWidthCache.clear(); }

function getTextOnlyWidth(startIdx: number, endIdx: number): number {
    let maxTextW = 0;
    for (let i = startIdx; i <= endIdx; i++) {
        const el = document.getElementById('ct-l' + i);
        if (el) {
            const textW = _mCtx.measureText(el.textContent || '').width;
            if (textW > maxTextW) maxTextW = textW;
        }
    }
    return Math.ceil(maxTextW);
}

function getMaxLineWidth(startIdx: number, endIdx: number): number {
    const blockId = getBlockIdForLine(startIdx);
    if (!blockId || !activeLayout?.blocks[blockId]?.spotlight) return 0;
    const s = activeLayout.blocks[blockId].spotlight;
    return s.x + _layoutXOffset + s.width;
}

// ── Speed / Sleep ──

function spd(): number {
    const v = parseInt(spdR.value);
    return v <= 4 ? v * 0.125 : v <= 8 ? (v - 4) * 0.375 + 0.5 : (v - 8) * 0.75 + 2;
}

function sl(ms: number): Promise<void> {
    // Capture the run token at call time. If a newer run started (or teardown
    // bumped the token) — or the sequence was marked dead — resolve immediately
    // so the stale continuation unwinds instead of resuming the old sequence.
    // The awaiting caller re-checks `dead`/`runToken` right after each await.
    const myRun = runToken;
    return new Promise(r => {
        setTimeout(r, ms / spd());
        if (dead || myRun !== runToken) r();
    });
}

// ── Spotlight System ──

function updSpot1(idx: number) {
    curLine = idx; spotStart = null; spotEnd = null;
    const el = document.getElementById('ct-l' + idx); if (!el) return;

    const blockId = getBlockIdForLine(idx);
    if (!blockId || !activeLayout?.blocks[blockId]?.spotlight) return;
    const bakedSpot = activeLayout.blocks[blockId].spotlight;

    const pad = 6;
    const top = Math.max(0, el.offsetTop - ed.scrollTop - pad);
    const h = el.offsetHeight + pad * 2;
    const spotLeft = bakedSpot.x + _layoutXOffset;
    const spotWidth = bakedSpot.width;

    shEl.setAttribute('x', String(spotLeft)); shEl.setAttribute('y', String(top)); shEl.setAttribute('height', String(h)); shEl.setAttribute('width', spotWidth + 'px');
    spotEl.style.left = spotLeft + 'px'; spotEl.style.top = top + 'px'; spotEl.style.height = h + 'px'; spotEl.style.width = spotWidth + 'px';
    spotEl.classList.add('ct-v');
}

/** Find which block a line index belongs to. */
function getBlockIdForLine(lineIdx: number): string | null {
    for (const [id, blk] of Object.entries(blockMap)) {
        if (blk._start !== undefined && blk._end !== undefined) {
            if (lineIdx >= blk._start && lineIdx <= blk._end) return id;
        }
    }
    return null;
}

function setSpotRange(s: number, e: number) { spotStart = s; spotEnd = e; curLine = null; updSpotRange(); }

function updSpotRange() {
    if (spotStart === null || spotEnd === null) return;
    const sEl = document.getElementById('ct-l' + spotStart), eEl = document.getElementById('ct-l' + spotEnd);
    if (!sEl || !eEl) return;

    const blockId = getBlockIdForLine(spotStart);
    if (!blockId || !activeLayout?.blocks[blockId]?.spotlight) return;
    const bakedSpot = activeLayout.blocks[blockId].spotlight;

    const pad = 8;
    const top = Math.max(0, sEl.offsetTop - ed.scrollTop - pad);
    const bot = eEl.offsetTop + eEl.offsetHeight - ed.scrollTop + pad;
    const h = bot - top;
    const spotLeft = bakedSpot.x + _layoutXOffset;
    const spotWidth = bakedSpot.width;

    shEl.setAttribute('x', String(spotLeft)); shEl.setAttribute('y', String(top)); shEl.setAttribute('height', String(h)); shEl.setAttribute('width', spotWidth + 'px');
    spotEl.style.left = spotLeft + 'px'; spotEl.style.top = top + 'px'; spotEl.style.height = h + 'px'; spotEl.style.width = spotWidth + 'px';
    spotEl.classList.add('ct-v');
}

function expandSpotTo(idx: number) {
    if (spotStart === null) { spotStart = idx; spotEnd = idx; }
    else { if (idx < spotStart) spotStart = idx; if (idx > spotEnd!) spotEnd = idx; }
    curLine = null; updSpotRange();
}

function setDualSpot(srcLines: number[], dstLines: number[], baked?: ConnLayoutData | null) { _dualSpotActive = true; posDualSpot(srcLines, dstLines, baked); }

function posDualSpot(srcLines: number[], dstLines: number[], baked?: ConnLayoutData | null) {
    const pad = 6;
    const srcMin = Math.min(...srcLines), srcMax = Math.max(...srcLines);
    const dstMin = Math.min(...dstLines), dstMax = Math.max(...dstLines);

    // A baked connection layout wins; otherwise fall back to the owning block's
    // spotlight, which is what the engine did before per-connection layout existed.
    const srcBlockId = getBlockIdForLine(srcMin);
    const dstBlockId = getBlockIdForLine(dstMin);
    const srcSpot = baked?.srcSpotlight || (srcBlockId ? activeLayout?.blocks[srcBlockId]?.spotlight : null);
    const dstSpot = baked?.dstSpotlight || (dstBlockId ? activeLayout?.blocks[dstBlockId]?.spotlight : null);
    if (!srcSpot || !dstSpot) return;

    const s0 = document.getElementById('ct-l' + srcMin), s1 = document.getElementById('ct-l' + srcMax);
    if (s0 && s1) {
        const t1 = Math.max(0, s0.offsetTop - ed.scrollTop - pad);
        const h1 = s1.offsetTop + s1.offsetHeight - s0.offsetTop + pad * 2;
        const sx = srcSpot.x + _layoutXOffset;
        shEl.setAttribute('x', String(sx)); shEl.setAttribute('y', String(t1)); shEl.setAttribute('height', String(h1)); shEl.setAttribute('width', srcSpot.width + 'px');
        spotEl.style.left = sx + 'px'; spotEl.style.top = t1 + 'px'; spotEl.style.height = h1 + 'px'; spotEl.style.width = srcSpot.width + 'px'; spotEl.classList.add('ct-v');
    }
    const d0 = document.getElementById('ct-l' + dstMin), d1 = document.getElementById('ct-l' + dstMax);
    if (d0 && d1) {
        const t2 = Math.max(0, d0.offsetTop - ed.scrollTop - pad);
        const h2 = d1.offsetTop + d1.offsetHeight - d0.offsetTop + pad * 2;
        const dx = dstSpot.x + _layoutXOffset;
        sh2El.setAttribute('x', String(dx)); sh2El.setAttribute('y', String(t2)); sh2El.setAttribute('height', String(h2)); sh2El.setAttribute('width', dstSpot.width + 'px');
        spot2El.style.left = dx + 'px'; spot2El.style.top = t2 + 'px'; spot2El.style.height = h2 + 'px'; spot2El.style.width = dstSpot.width + 'px'; spot2El.classList.add('ct-v');
    }
}

function clearDualSpot() {
    _dualSpotActive = false;
    sh2El.setAttribute('height', '0');
    spot2El.classList.remove('ct-v');
}

// ── DOM Builders ──

function addGut(n: number): HTMLElement {
    const d = document.createElement('div'); d.className = 'ct-gl'; d.id = 'ct-g' + n;
    d.innerHTML = `<div class="ct-gy"></div>${n}`;
    gut.appendChild(d); return d;
}

function addLine(i: number): HTMLElement {
    const d = document.createElement('div'); d.className = 'ct-cl'; d.id = 'ct-l' + i;
    co.appendChild(d); return d;
}

function updProg() {
    pfl.style.width = (doneC / totC * 100) + '%';
    const s = ((Date.now() - t0) / 1000) | 0;
    tlbl.textContent = `${(s / 60) | 0}:${('0' + s % 60).slice(-2)}`;
}

// ── SVG Arrow Helpers ──

function ensureArrowDefs() {
    if (!document.getElementById('ct-ag')) {
        const d = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        d.innerHTML = '<filter id="ct-ag"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter><marker id="ct-ah" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 0L10 4L0 8Z" fill="rgba(255,255,255,0.9)"/></marker><marker id="ct-ah2" markerWidth="10" markerHeight="8" refX="1" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M10 0L0 4L10 8Z" fill="rgba(255,255,255,0.9)"/></marker>';
        asvg.appendChild(d);
    }
}

function getElGroupMidY(els: HTMLElement[]): number {
    return (els[0].offsetTop + els[els.length - 1].offsetTop + els[els.length - 1].offsetHeight) / 2 - ed.scrollTop;
}

// ── Show Block Arrow ──

async function showBlockArrow(
    conn: { src: number[]; dst: number[]; label: string; desc?: string },
    blockId?: string,
    connIdx?: number,
) {
    // Per-connection baked layout from the Lesson Builder, if the author placed one.
    const bakedConn: ConnLayoutData | null =
        (blockId !== undefined && connIdx !== undefined
            ? activeLayout?.connections?.[blockId]?.[connIdx]
            : null) || null;
    const wrW = rootContainer.querySelector('.ct-ei')!.clientWidth;
    const oldSS = spotStart, oldSE = spotEnd, oldCL = curLine;
    co.querySelectorAll('.ct-hi,.ct-tr').forEach(e => e.classList.remove('ct-hi', 'ct-tr'));
    const srcEls = conn.src.map(i => document.getElementById('ct-l' + i)).filter(Boolean) as HTMLElement[];
    const dstEls = conn.dst.map(i => document.getElementById('ct-l' + i)).filter(Boolean) as HTMLElement[];
    if (!srcEls.length || !dstEls.length) return;

    if (!usrScr) {
        const allLines = [...conn.src, ...conn.dst];
        const minL = Math.min(...allLines), maxL = Math.max(...allLines);
        const minEl = document.getElementById('ct-l' + minL), maxEl = document.getElementById('ct-l' + maxL);
        if (minEl && maxEl) {
            const mid = (minEl.offsetTop + maxEl.offsetTop + maxEl.offsetHeight) / 2;
            ed.scrollTo({ top: Math.max(0, mid - ed.clientHeight / 2), behavior: 'smooth' });
            await sl(T().animations.arrowScrollPause);
        }
    }

    setSpotRange(Math.min(...conn.src), Math.max(...conn.src));
    spotEl.classList.add('ct-v');
    srcEls.forEach(el => el.classList.add('ct-hi'));
    await sl(T().animations.arrowSourcePause);

    dstEls.forEach(el => el.classList.add('ct-hi'));
    setDualSpot(conn.src, conn.dst, bakedConn);
    await sl(T().animations.arrowDualPause);

    ensureArrowDefs();
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const dotS = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    const dotD = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    const lbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');

    function getY(els: HTMLElement[]) {
        return (els[0].offsetTop + els[els.length - 1].offsetTop + els[els.length - 1].offsetHeight) / 2 - ed.scrollTop;
    }
    function posArrow() {
        const sp1 = spotEl, sp2 = spot2El;
        const sx1 = (parseFloat(sp1.style.left) || 50) + (parseFloat(sp1.style.width) || 200) + 4;
        const sx2 = (parseFloat(sp2.style.left) || 50) + (parseFloat(sp2.style.width) || 200) + 4;
        const ex = Math.max(sx1, sx2) + 20;
        const y1 = getY(srcEls), y2 = getY(dstEls);
        path.setAttribute('d', 'M' + sx1 + ' ' + y1 + 'L' + ex + ' ' + y1 + 'L' + ex + ' ' + y2 + 'L' + sx2 + ' ' + y2);
        dotS.setAttribute('cx', String(sx1)); dotS.setAttribute('cy', String(y1));
        dotD.setAttribute('cx', String(sx2)); dotD.setAttribute('cy', String(y2));
        lbl.setAttribute('x', String(ex + 18)); lbl.setAttribute('y', String((y1 + y2) / 2 + 4));
    }

    path.setAttribute('stroke', 'rgba(255,255,255,0.75)'); path.setAttribute('stroke-width', '2.5'); path.setAttribute('fill', 'none');
    path.setAttribute('stroke-linejoin', 'round'); path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('marker-end', 'url(#ct-ah)'); path.setAttribute('marker-start', 'url(#ct-ah2)');
    path.style.opacity = '0'; path.style.transition = 'opacity .3s'; asvg.appendChild(path);
    [dotS, dotD].forEach(d => { d.setAttribute('r', '0'); d.setAttribute('fill', 'none'); d.style.opacity = '0'; d.style.transition = 'opacity .3s'; asvg.appendChild(d); });
    lbl.setAttribute('fill', 'rgba(255,255,255,0.9)'); lbl.setAttribute('font-size', '11'); lbl.setAttribute('font-family', 'Outfit'); lbl.setAttribute('font-weight', '600');
    lbl.textContent = conn.label || 'refs';
    lbl.style.opacity = '0'; lbl.style.transition = 'opacity .4s .15s'; asvg.appendChild(lbl);

    posArrow();
    let _arrowRafPending = false;
    function onS() {
        if (_arrowRafPending) return; _arrowRafPending = true;
        requestAnimationFrame(() => { _arrowRafPending = false; posArrow(); posDualSpot(conn.src, conn.dst, bakedConn); });
    }
    ed.addEventListener('scroll', onS);
    trackDisposable(() => ed.removeEventListener('scroll', onS));
    requestAnimationFrame(() => { path.style.opacity = '1'; dotS.style.opacity = '1'; dotD.style.opacity = '1'; lbl.style.opacity = '1'; });
    sndLinkChime();

    if (conn.desc) {
        const eiEl = rootContainer.querySelector('.ct-ei') as HTMLElement;
        const eiW = eiEl.offsetWidth, eiH = eiEl.offsetHeight;
        const elbowX = parseFloat(lbl.getAttribute('x') || '') || wrW * 0.6;
        const elbowY = parseFloat(lbl.getAttribute('y') || '') || 100;
        const popW = Math.min(340, eiW - elbowX - 30);
        miniExpEl.innerHTML = `
            <div class="ct-me-tok" style="font-size:11px">${conn.label.replace(/ [↓↑→←]/g, '')}</div>
            <div class="ct-me-desc">${conn.desc}</div>
            <div class="ct-me-nav"><button class="ct-me-btn" id="ct-meNext">Continue →</button></div>`;
        miniExpEl.style.width = Math.max(240, popW) + 'px';
        miniExpEl.style.left = (elbowX + 15) + 'px';
        const y1 = getY(srcEls), y2 = getY(dstEls);
        let popTop = Math.max(10, ((y1 + y2) / 2) - 80);
        miniExpEl.style.top = popTop + 'px'; miniExpEl.style.right = 'auto';
        miniExpEl.style.maxHeight = 'none'; miniExpEl.style.overflowY = 'hidden'; miniExpEl.style.padding = '16px 20px';
        const meDesc = miniExpEl.querySelector('.ct-me-desc') as HTMLElement;
        if (meDesc) { meDesc.style.fontSize = (popW < 280 ? '12px' : '13px'); meDesc.style.lineHeight = '1.6'; }
        miniExpEl.classList.add('ct-v');
        let att = 0; while (att < 4) {
            if (miniExpEl.offsetHeight <= eiH - 20) break;
            if (meDesc) { const fs = parseFloat(meDesc.style.fontSize) || 13; if (fs > 10) meDesc.style.fontSize = (fs - 1) + 'px'; else break; }
            att++;
        }
        popTop = Math.max(10, Math.min(popTop, eiH - miniExpEl.offsetHeight - 10));
        miniExpEl.style.top = popTop + 'px';
        await new Promise<void>(r => { document.getElementById('ct-meNext')!.onclick = () => r(); });
        miniExpEl.classList.remove('ct-v');
    } else {
        await sl(T().animations.arrowHold);
    }

    ed.removeEventListener('scroll', onS);
    path.style.opacity = '0'; dotS.style.opacity = '0'; dotD.style.opacity = '0'; lbl.style.opacity = '0';
    srcEls.forEach(el => el.classList.remove('ct-hi'));
    dstEls.forEach(el => el.classList.remove('ct-hi'));
    clearDualSpot();
    if (oldCL !== null) updSpot1(oldCL); else if (oldSS !== null) setSpotRange(oldSS, oldSE!);
    await sl(T().animations.arrowScrollPause);
    path.remove(); dotS.remove(); dotD.remove(); lbl.remove();
}

// ── Show Explanation Panel ──

function showExplain(blockId: string): Promise<void> {
    // Capture the run token so a stop/replay/unmount during the panel's deferred
    // build (or while it is shown) aborts instead of rendering against a reset DOM.
    const myRun = runToken;
    return new Promise(resolve => {
        const ex = activeExpl[blockId]; if (!ex) { resolve(); return; }
        if (dead || myRun !== runToken) { resolve(); return; }
        const blk = blockMap[blockId];
        setSpotRange(blk._start!, blk._end!);
        if (!usrScr) {
            const sEl = document.getElementById('ct-l' + blk._start), eEl = document.getElementById('ct-l' + blk._end);
            if (sEl && eEl) { const mid = (sEl.offsetTop + eEl.offsetTop + eEl.offsetHeight) / 2; ed.scrollTo({ top: Math.max(0, mid - ed.clientHeight / 2), behavior: 'smooth' }); }
        }

        setTimeout(() => {
            // Stale run? Bail without building the panel and let the awaiter unwind.
            if (dead || myRun !== runToken) { resolve(); return; }
            clearTimeout(expTimeout!);
            const hasVis = blockId in activeBlockVis;
            const ctrls = activeVisControls[blockId] || [];
            const visVals: Record<string, any> = {};
            ctrls.forEach(ct => visVals[ct.key] = ct.val);

            let html = '<div class="ct-ec">';
            if (hasVis) {
                html += `<div class="ct-ec-vis"><canvas id="ct-visCv" width="400" height="260"></canvas>`;
                if (ctrls.length) {
                    html += '<div class="ct-vis-ctrl">';
                    ctrls.forEach(ct => {
                        if (ct.type === 'checkbox') html += `<label><input type="checkbox" data-key="${ct.key}" ${ct.val ? 'checked' : ''}> ${ct.label}</label>`;
                        else html += `<label>${ct.label} <input type="range" min="${ct.min}" max="${ct.max}" value="${ct.val}" data-key="${ct.key}"><span class="ct-val" id="ct-vc_${ct.key}">${ct.val}</span></label>`;
                    });
                    html += '</div>';
                }
                html += '</div>';
            }
            html += `<div class="ct-ec-body">
                <div class="ct-ec-lbl ${ex.tp}"><div class="ct-dot"></div>${ex.label}</div>
                <div style="font-size:12px;color:var(--text-dim, #555566);margin-bottom:12px">Lines ${blk._start! + 1}\u2013${blk._end! + 1}</div>
                <div class="ct-ec-desc">${ex.desc}</div>
                <div class="ct-ec-foot"><button class="ct-ec-explain" id="ct-expExplain">\uD83D\uDD0D Explain Code</button><button class="ct-ec-btn" id="ct-expBtn">Continue →</button><div class="ct-ec-tmr"><div class="ct-ec-tf" id="ct-expTf"></div></div></div>
            </div></div>`;
            epcEl.innerHTML = html;

            // Position panel
            function posPanel() {
                // If baked layout exists, use the baked panel position and size directly
                if (activeLayout?.blocks[blockId]) {
                    const pl = activeLayout.blocks[blockId].panel;
                    const panelLeft = pl.x + _layoutXOffset;
                    epEl.style.left = panelLeft + 'px';
                    epEl.style.top = (parseFloat(spotEl.style.top || '0')) + 'px';
                    epEl.style.width = pl.width + 'px';
                    epEl.style.maxHeight = pl.height + 'px';
                    epEl.style.right = 'auto'; epEl.style.overflowY = 'auto';

                    // Size and render the visualizer canvas within the baked panel
                    const cv = document.getElementById('ct-visCv') as HTMLCanvasElement | null;
                    const visEl = epcEl.querySelector('.ct-ec-vis') as HTMLElement | null;
                    if (cv && visEl) {
                        visEl.style.display = '';
                        const innerW = pl.width - 32 - 2;
                        cv.width = innerW;
                        cv.height = Math.min(200, Math.round(innerW * 0.5));
                        cv.style.minHeight = cv.height + 'px';
                        if (activeBlockVis[blockId]) {
                            activeBlockVis[blockId](cv.getContext('2d')!, cv.width, cv.height, visVals);
                        }
                    }
                    return;
                }

                const sEl = document.getElementById('ct-l' + blk._start), eEl = document.getElementById('ct-l' + blk._end);
                if (!sEl || !eEl) return;
                const blockMidY = (sEl.offsetTop + eEl.offsetTop + eEl.offsetHeight) / 2 - ed.scrollTop;
                const eiEl = rootContainer.querySelector('.ct-ei') as HTMLElement;
                const eiH = eiEl.offsetHeight, eiW = eiEl.offsetWidth;
                const spotW = getMaxLineWidth(blk._start!, blk._end!) + 50;
                const panelGap = 30;
                const availW = eiW - spotW - panelGap - 20;
                const panelW = Math.max(280, Math.min(480, availW));
                epEl.style.width = panelW + 'px'; epEl.style.left = (spotW + panelGap) + 'px'; epEl.style.right = 'auto';
                epEl.style.overflowY = 'hidden'; epEl.style.maxHeight = 'none';
                const innerW = panelW - 32 - 2;
                const availH = eiH - 40;
                const cv = document.getElementById('ct-visCv') as HTMLCanvasElement | null;
                const visEl = epcEl.querySelector('.ct-ec-vis') as HTMLElement | null;
                const descEl = epcEl.querySelector('.ct-ec-desc') as HTMLElement | null;
                const lblEl = epcEl.querySelector('.ct-ec-lbl') as HTMLElement | null;
                const bodyEl = epcEl.querySelector('.ct-ec-body') as HTMLElement | null;

                if (panelW < 340) {
                    if (visEl) visEl.style.display = 'none';
                    if (descEl) { descEl.style.fontSize = '11px'; descEl.style.lineHeight = '1.45'; }
                    if (lblEl) lblEl.style.fontSize = '10px';
                    if (bodyEl) bodyEl.style.padding = '10px 12px';
                } else if (panelW < 420) {
                    if (visEl) visEl.style.display = '';
                    if (cv) { cv.width = innerW; cv.height = Math.min(200, Math.round(innerW * 0.5)); cv.style.minHeight = cv.height + 'px'; if (activeBlockVis[blockId]) activeBlockVis[blockId](cv.getContext('2d')!, cv.width, cv.height, visVals); }
                    if (descEl) { descEl.style.fontSize = '11px'; descEl.style.lineHeight = '1.5'; }
                    if (lblEl) lblEl.style.fontSize = '11px';
                    if (bodyEl) bodyEl.style.padding = '12px 14px';
                } else {
                    if (visEl) visEl.style.display = '';
                    if (cv) { cv.width = innerW; cv.height = Math.min(280, Math.round(innerW * 0.65), Math.round(availH * 0.38)); cv.style.minHeight = cv.height + 'px'; if (activeBlockVis[blockId]) activeBlockVis[blockId](cv.getContext('2d')!, cv.width, cv.height, visVals); }
                    if (descEl) { descEl.style.fontSize = '12px'; descEl.style.lineHeight = '1.55'; }
                    if (lblEl) lblEl.style.fontSize = '12px';
                    if (bodyEl) bodyEl.style.padding = '14px 18px';
                }

                const panelH = epcEl.offsetHeight || 300;
                if (panelH > availH && descEl) {
                    const scale = availH / panelH;
                    descEl.style.fontSize = Math.max(11, Math.round(parseFloat(descEl.style.fontSize) * scale)) + 'px';
                    if (cv && visEl && visEl.style.display !== 'none') {
                        const newCvH = Math.max(120, Math.round(cv.height * scale));
                        cv.height = newCvH; cv.style.minHeight = newCvH + 'px';
                        if (activeBlockVis[blockId]) activeBlockVis[blockId](cv.getContext('2d')!, cv.width, cv.height, visVals);
                    }
                }
                const finalH = Math.min(epcEl.offsetHeight, availH);
                const targetTop = Math.max(10, Math.min(blockMidY - finalH / 2, eiH - finalH - 10));
                epEl.style.top = targetTop + 'px';
            }

            posPanel();
            epEl.classList.add('ct-v');

            function onExpPanelScroll() { posPanel(); }
            ed.addEventListener('scroll', onExpPanelScroll);

            if (hasVis) {
                const cv = document.getElementById('ct-visCv') as HTMLCanvasElement | null;
                if (cv) {
                    const ctx = cv.getContext('2d')!;
                    if (activeAnimatedVis.has(blockId)) {
                        vizCtrl.start(() => { const cv2 = document.getElementById('ct-visCv') as HTMLCanvasElement | null; if (cv2) activeBlockVis[blockId](cv2.getContext('2d')!, cv2.width, cv2.height, visVals); });
                        trackDisposable(() => vizCtrl.stop());
                    } else {
                        activeBlockVis[blockId](ctx, cv.width, cv.height, visVals);
                    }
                }
                epcEl.querySelectorAll('input[data-key]').forEach((inp: Element) => {
                    const input = inp as HTMLInputElement;
                    input.addEventListener('input', () => {
                        const k = input.dataset.key!;
                        if (input.type === 'checkbox') visVals[k] = input.checked;
                        else { visVals[k] = parseInt(input.value); const vl = document.getElementById('ct-vc_' + k); if (vl) vl.textContent = input.value; }
                        const cv2 = document.getElementById('ct-visCv') as HTMLCanvasElement | null;
                        if (cv2 && activeBlockVis[blockId]) activeBlockVis[blockId](cv2.getContext('2d')!, cv2.width, cv2.height, visVals);
                    });
                });
            }

            // Timer bar
            const tf = document.getElementById('ct-expTf')!;
            tf.style.transition = 'none'; tf.style.width = '100%';
            requestAnimationFrame(() => requestAnimationFrame(() => {
                const dur = 30 / spd(); tf.style.transition = `width ${dur}s linear`; tf.style.width = '0%';
            }));

            // Explanation arrow
            ensureArrowDefs();
            const ePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            const eDotS = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            const eDotD = document.createElementNS('http://www.w3.org/2000/svg', 'circle');

            function posExpArrow() {
                const sEl = document.getElementById('ct-l' + blk._start), eEl = document.getElementById('ct-l' + blk._end);
                if (!sEl || !eEl) return;
                const spotL = parseFloat(spotEl.style.left) || 50;
                const spotW = parseFloat(spotEl.style.width) || 200;
                const sr = spotL + spotW + 4;
                const midY = (sEl.offsetTop + eEl.offsetTop + eEl.offsetHeight) / 2 - ed.scrollTop;
                const pl = parseFloat(epEl.style.left) || 500;
                const pTop = parseFloat(epEl.style.top) || 0;
                const pH = epcEl.offsetHeight || 400;
                const panelMidY = pTop + pH / 2;
                const elbowX = (sr + pl) / 2;
                ePath.setAttribute('d', `M${sr} ${midY}L${elbowX} ${midY}L${elbowX} ${panelMidY}L${pl} ${panelMidY}`);
                eDotS.setAttribute('cx', String(sr)); eDotS.setAttribute('cy', String(midY));
                eDotD.setAttribute('cx', String(pl)); eDotD.setAttribute('cy', String(panelMidY));
            }

            ePath.setAttribute('stroke', 'rgba(255,255,255,0.75)'); ePath.setAttribute('stroke-width', '2'); ePath.setAttribute('fill', 'none');
            ePath.setAttribute('stroke-linejoin', 'round'); ePath.setAttribute('stroke-linecap', 'round');
            ePath.setAttribute('marker-end', 'url(#ct-ah)'); ePath.setAttribute('marker-start', 'url(#ct-ah2)');
            ePath.style.opacity = '0'; ePath.style.transition = 'opacity .4s'; asvg.appendChild(ePath);
            [eDotS, eDotD].forEach(d => { d.setAttribute('r', '0'); d.setAttribute('fill', 'none'); d.style.opacity = '0'; d.style.transition = 'opacity .4s'; asvg.appendChild(d); });
            posExpArrow();

            function onExpScroll() { posPanel(); posExpArrow(); }
            ed.addEventListener('scroll', onExpScroll);
            requestAnimationFrame(() => { ePath.style.opacity = '1'; eDotS.style.opacity = '1'; eDotD.style.opacity = '1'; });

            function done() {
                clearTimeout(expTimeout!); epEl.classList.remove('ct-v'); expResolve = null;
                vizCtrl.stop();
                if (_cubeAnim) { cancelAnimationFrame(_cubeAnim); _cubeAnim = null; }
                ed.removeEventListener('scroll', onExpScroll);
                ed.removeEventListener('scroll', onExpPanelScroll);
                ePath.style.opacity = '0'; eDotS.style.opacity = '0'; eDotD.style.opacity = '0';
                setTimeout(() => { ePath.remove(); eDotS.remove(); eDotD.remove(); }, 400);
                resolve();
            }

            expResolve = done;
            document.getElementById('ct-expBtn')!.onclick = done;

            const explBtn = document.getElementById('ct-expExplain');
            if (explBtn) {
                if (activeTokens[blockId]) {
                    explBtn.style.display = '';
                    explBtn.onclick = () => {
                        clearTimeout(expTimeout!);
                        epEl.classList.remove('ct-v');
                        vizCtrl.stop();
                        if (_cubeAnim) { cancelAnimationFrame(_cubeAnim); _cubeAnim = null; }
                        ed.removeEventListener('scroll', onExpScroll);
                        ed.removeEventListener('scroll', onExpPanelScroll);
                        ePath.style.opacity = '0'; eDotS.style.opacity = '0'; eDotD.style.opacity = '0';
                        setTimeout(() => { ePath.remove(); eDotS.remove(); eDotD.remove(); }, 400);
                        runTokenExplain(blockId, blk).then(resolve);
                    };
                } else {
                    explBtn.style.display = 'none';
                }
            }
            expTimeout = setTimeout(done, T().pauses.autoAdvance / spd());
        }, 500 / spd());
    });
}

// ── Token-Level Explain ──

async function runTokenExplain(blockId: string, blk: LessonBlock) {
    const tokenData = activeTokens[blockId]; if (!tokenData) return;
    // Capture the run token: a stop/replay/unmount during token-explain must
    // abort this loop rather than animate against a superseded DOM.
    const myRun = runToken;

    let allTokens: { lineIdx: number; text: string; desc: string }[] = [];
    tokenData.forEach(td => {
        const lineIdx = blk._start! + td.line;
        td.tokens.forEach(tok => allTokens.push({ lineIdx, text: tok.text, desc: ((tok as any).description || (tok as any).desc) }));
    });

    for (let ti = 0; ti < allTokens.length; ti++) {
        if (dead || myRun !== runToken) break;
        const tok = allTokens[ti];
        const lineEl = document.getElementById('ct-l' + tok.lineIdx); if (!lineEl) continue;

        // Baked token layout from the Lesson Builder, indexed by the same flat
        // token order this loop walks. Same convention as blocks: x/width (and
        // panel height) are authored, while y stays runtime so the spotlight
        // keeps tracking the line as it scrolls.
        const bakedTok = activeLayout?.tokens?.[blockId]?.[ti];

        if (!usrScr) {
            const r = lineEl.getBoundingClientRect(), er = ed.getBoundingClientRect();
            if (r.top < er.top + 40 || r.bottom > er.bottom - 40) {
                ed.scrollTo({ top: lineEl.offsetTop - ed.clientHeight / 2, behavior: 'smooth' });
                await sl(T().animations.tokenScroll);
            }
        }

        const origHTML = lineEl.innerHTML;
        const rawText = lineEl.textContent || '';
        const tokIdx = rawText.indexOf(tok.text);

        if (tokIdx >= 0) {
            const beforeText = rawText.substring(0, tokIdx);
            const tokenText = tok.text;
            const beforeW = _mCtx.measureText(beforeText).width;
            const tokenW = _mCtx.measureText(tokenText).width;

            // Use the actual DOM position of the line element relative to the editor
            const lineRect = lineEl.getBoundingClientRect();
            const edRect = ed.getBoundingClientRect();
            const lineLeftInEditor = lineEl.offsetLeft; // left edge of line within co (code container)
            const coLeft = co.offsetLeft; // code container left within .ct-ed

            const tokLeftPx = coLeft + lineLeftInEditor + lineEl.clientLeft + beforeW;
            const tokWidthPx = tokenW + 16;
            const pad = 6;
            const top = Math.max(0, lineEl.offsetTop - ed.scrollTop - pad);
            const h = lineEl.offsetHeight + pad * 2;
            let spotLeft = Math.max(0, tokLeftPx - 8);
            let spotWidth = tokWidthPx + 16;
            if (bakedTok?.spotlight) {
                spotLeft = bakedTok.spotlight.x + _layoutXOffset;
                spotWidth = bakedTok.spotlight.width;
            }
            shEl.setAttribute('x', String(spotLeft));
            shEl.setAttribute('y', String(top)); shEl.setAttribute('width', spotWidth + 'px'); shEl.setAttribute('height', String(h));
            spotEl.style.left = spotLeft + 'px'; spotEl.style.top = top + 'px';
            spotEl.style.width = spotWidth + 'px'; spotEl.style.height = h + 'px'; spotEl.classList.add('ct-v');

            const before = rawText.substring(0, tokIdx);
            const match = rawText.substring(tokIdx, tokIdx + tok.text.length);
            const after = rawText.substring(tokIdx + tok.text.length);
            lineEl.innerHTML = hl(before) + '<span class="ct-tok-hl">' + hl(match) + '</span>' + hl(after);
        }

        const hasTokenVis = tok.text in activeTokenVis;
        miniExpEl.innerHTML = `
            ${hasTokenVis ? '<canvas id="ct-tokVisCv" style="width:100%;border-radius:8px;margin-bottom:10px;background:#0e0e14;display:block"></canvas>' : ''}
            <div class="ct-me-tok">${esc(tok.text)}</div>
            <div class="ct-me-desc">${((tok as any).description || (tok as any).desc)}</div>
            <div class="ct-me-nav">
                <button class="ct-me-btn" id="ct-meNext">${ti < allTokens.length - 1 ? 'Next →' : 'Done ✓'}</button>
                <button class="ct-me-btn ct-done" id="ct-meSkip">Skip All</button>
                <span class="ct-me-pg">${ti + 1} / ${allTokens.length}</span>
            </div>`;

        tokVizCtrl.stop();
        if (hasTokenVis) {
            const tcv = document.getElementById('ct-tokVisCv') as HTMLCanvasElement | null;
            if (tcv) {
                const mw = parseFloat(miniExpEl.style.width) || 340;
                tcv.width = mw - 44; tcv.height = Math.min(120, Math.floor(mw * 0.35));
                const tctx = tcv.getContext('2d')!;
                tokVizCtrl.start(() => activeTokenVis[tok.text](tctx, tcv.width, tcv.height));
            }
        }

        const lineTop = lineEl.offsetTop - ed.scrollTop;
        const eiEl = rootContainer.querySelector('.ct-ei') as HTMLElement;
        const eiH = eiEl.offsetHeight, eiW = eiEl.offsetWidth;
        const spotRightEdge = parseFloat(spotEl.style.left) + parseFloat(spotEl.style.width) + 40;
        const availMiniW = eiW - spotRightEdge - 20;
        const miniW = bakedTok?.panel ? bakedTok.panel.width : Math.max(240, Math.min(380, availMiniW));
        miniExpEl.style.width = miniW + 'px';
        miniExpEl.style.maxHeight = bakedTok?.panel ? bakedTok.panel.height + 'px' : 'none';
        miniExpEl.style.overflowY = bakedTok?.panel ? 'auto' : 'hidden';
        const meDesc = miniExpEl.querySelector('.ct-me-desc') as HTMLElement | null;
        const meTok = miniExpEl.querySelector('.ct-me-tok') as HTMLElement | null;
        if (miniW < 300) {
            if (meDesc) { meDesc.style.fontSize = '11px'; meDesc.style.lineHeight = '1.45'; }
            if (meTok) meTok.style.fontSize = '11px'; miniExpEl.style.padding = '10px 12px';
        } else {
            if (meDesc) { meDesc.style.fontSize = '12px'; meDesc.style.lineHeight = '1.55'; }
            if (meTok) meTok.style.fontSize = '12px'; miniExpEl.style.padding = '14px 16px';
        }
        let expLeft = bakedTok?.panel
            ? bakedTok.panel.x + _layoutXOffset
            : Math.min(spotRightEdge, eiW - miniW - 20);
        let expTop = Math.max(10, Math.min(lineTop - 20, eiH - 280));
        miniExpEl.style.left = expLeft + 'px'; miniExpEl.style.top = expTop + 'px'; miniExpEl.style.right = 'auto';
        miniExpEl.classList.add('ct-v');

        // Shrink to fit
        const tcvEl = document.getElementById('ct-tokVisCv') as HTMLCanvasElement | null;
        let attempts = 0;
        while (attempts < 5) {
            if (miniExpEl.offsetHeight <= eiH - 20) break;
            if (tcvEl && tcvEl.height > 50) {
                tcvEl.height = Math.max(50, tcvEl.height - 20); tcvEl.style.minHeight = tcvEl.height + 'px';
                if (hasTokenVis) activeTokenVis[tok.text](tcvEl.getContext('2d')!, tcvEl.width, tcvEl.height);
            } else if (meDesc) {
                const cur = parseFloat(meDesc.style.fontSize) || 14;
                if (cur > 10) { meDesc.style.fontSize = (cur - 1) + 'px'; meDesc.style.lineHeight = '1.4'; }
                else if (tcvEl) { tcvEl.style.display = 'none'; break; }
            } else break;
            attempts++;
        }
        expTop = Math.max(10, Math.min(lineTop - 20, eiH - miniExpEl.offsetHeight - 10));
        miniExpEl.style.top = expTop + 'px';

        // Token arrow
        ensureArrowDefs();
        const tPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        const tDotS = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        const tDotD = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        tPath.setAttribute('stroke', 'rgba(255,255,255,0.75)'); tPath.setAttribute('stroke-width', '2'); tPath.setAttribute('fill', 'none');
        tPath.setAttribute('stroke-linejoin', 'round'); tPath.setAttribute('stroke-linecap', 'round');
        tPath.setAttribute('marker-end', 'url(#ct-ah)'); tPath.setAttribute('marker-start', 'url(#ct-ah2)');
        [tDotS, tDotD].forEach(d => { d.setAttribute('r', '0'); d.setAttribute('fill', 'none'); });

        const sRight = parseFloat(spotEl.style.left) + parseFloat(spotEl.style.width) + 4;
        const sMidY = parseFloat(spotEl.style.top) + parseFloat(spotEl.style.height) / 2;
        const mLeft = parseFloat(miniExpEl.style.left);
        const mMidY = parseFloat(miniExpEl.style.top) + (miniExpEl.offsetHeight || 100) / 2;
        const elbX = (sRight + mLeft) / 2;
        tPath.setAttribute('d', `M${sRight} ${sMidY}L${elbX} ${sMidY}L${elbX} ${mMidY}L${mLeft} ${mMidY}`);
        tDotS.setAttribute('cx', String(sRight)); tDotS.setAttribute('cy', String(sMidY));
        tDotD.setAttribute('cx', String(mLeft)); tDotD.setAttribute('cy', String(mMidY));
        tPath.style.opacity = '0'; tDotS.style.opacity = '0'; tDotD.style.opacity = '0';
        tPath.style.transition = 'opacity .25s'; tDotS.style.transition = 'opacity .25s'; tDotD.style.transition = 'opacity .25s';
        asvg.appendChild(tPath); asvg.appendChild(tDotS); asvg.appendChild(tDotD);
        requestAnimationFrame(() => { tPath.style.opacity = '1'; tDotS.style.opacity = '1'; tDotD.style.opacity = '1'; });

        const action = await new Promise<string>(res => {
            document.getElementById('ct-meNext')!.onclick = () => res('next');
            document.getElementById('ct-meSkip')!.onclick = () => res('skip');
        });

        tokVizCtrl.stop();
        tPath.style.opacity = '0'; tDotS.style.opacity = '0'; tDotD.style.opacity = '0';
        setTimeout(() => { tPath.remove(); tDotS.remove(); tDotD.remove(); }, 250);
        lineEl.innerHTML = origHTML;
        miniExpEl.classList.remove('ct-v');
        if (action === 'skip' || dead || myRun !== runToken) break;
        await sl(T().animations.tokenStep);
    }

    miniExpEl.classList.remove('ct-v');
    spotEl.classList.remove('ct-v'); spotEl.style.left = '50px';
    shEl.setAttribute('x', '50');
}

// ── Typing Engine ──

async function typeBlock(blk: LessonBlock, myRun: number = runToken) {
    if (dead || myRun !== runToken) return;
    const startIdx = blk._start!;

    if (((blk as any).section || (blk as any).sec)) {
        const d = document.createElement('div'); d.className = 'ct-sdiv';
        d.innerHTML = `<span class="ct-dt">▸ ${((blk as any).section || (blk as any).sec)}</span><div class="ct-dl"></div>`;
        co.appendChild(d);
        const gd = document.createElement('div'); gd.className = 'ct-gl'; gd.innerHTML = '&nbsp;'; gut.appendChild(gd);
        requestAnimationFrame(() => d.classList.add('ct-v'));
        await sl(T().pauses.sectionDivider);
    }

    for (let li = 0; li < blk.lines.length; li++) {
        if (dead || myRun !== runToken) return;
        const data = blk.lines[li];
        const idx = startIdx + li;
        const num = idx + 1;
        addGut(num);
        const el = addLine(idx);
        el.classList.add('ct-hi');
        updSpot1(idx);

        if (!usrScr) {
            const r = el.getBoundingClientRect(), er = ed.getBoundingClientRect();
            if (r.top > er.top + er.height * 0.35) ed.scrollTo({ top: el.offsetTop - ed.clientHeight * 0.35, behavior: 'smooth' });
        }

        const ge = document.getElementById('ct-g' + num); if (ge) ge.classList.add('ct-a');

        if (li > 0) {
            const prev = document.getElementById('ct-l' + (idx - 1)); if (prev) prev.classList.remove('ct-hi');
            const pg = document.getElementById('ct-g' + idx); if (pg) pg.classList.remove('ct-a');
        }

        const txt = ((data as any).text || (data as any).t);
        if (!txt) { el.innerHTML = '&nbsp;'; await sl(T().pauses.emptyLine); continue; }

        if (((data as any).confidence ?? (data as any).c ?? 1) && ((data as any).confidence ?? (data as any).c ?? 1) < 0.8) {
            el.innerHTML = '<div class="ct-thi"><div></div><div></div><div></div></div>';
            await sl(((data as any).confidence ?? (data as any).c ?? 1) < 0.75 ? T().pauses.thinkDotsLong : T().pauses.thinkDotsShort);
        }

        const hlFull = hl(txt);

        for (let i = 0; i < txt.length; i++) {
            if (dead || myRun !== runToken) return;
            el.innerHTML = esc(txt.substring(0, i + 1)) + '<span class="ct-cur"></span>';
            if (!_layoutXMeasured) _measureLayoutOffset(el);
            sndKeystroke(); doneC++; updProg();
            _lineWidthCache.delete(idx); updSpot1(idx);

            if (!usrScr) {
                const r = el.getBoundingClientRect(), er = ed.getBoundingClientRect();
                const targetY = er.top + er.height * 0.35;
                if (r.top > targetY) ed.scrollTo({ top: el.offsetTop - ed.clientHeight * 0.35, behavior: 'smooth' });
            }

            const ch = txt[i], cm = ((data as any).confidence ?? (data as any).c ?? 1) && ((data as any).confidence ?? (data as any).c ?? 1) < 0.8 ? T().typing.lowConfidenceMultiplier : 1;
            if (ch === ' ' || ch === '\t') await sl(T().typing.spaceDelay * cm);
            else if (T().typing.punctChars.includes(ch)) await sl(T().typing.punctDelay * cm);
            else await sl((T().typing.charDelayBase + Math.random() * T().typing.charDelayJitter) * cm);
        }

        el.innerHTML = hlFull;
        _lineWidthCache.delete(idx); updSpot1(idx);

        if (((data as any).type || (data as any).tp) === 'fn') el.querySelectorAll('.ct-sf').forEach(s => s.classList.add('ct-ff'));
        else if (((data as any).type || (data as any).tp) === 'ty' || ((data as any).type || (data as any).tp) === 'se') el.querySelectorAll('.ct-st,.ct-se').forEach(s => s.classList.add('ct-ft'));
        else if (((data as any).type || (data as any).tp) === 'dir') el.querySelectorAll('.ct-sd').forEach(s => s.classList.add('ct-fk'));

        if (((data as any).blockEnd || (data as any).be)) sndBlockComplete();
        if (li < blk.lines.length - 1) await sl(((data as any).text || (data as any).t) ? T().pauses.interLine : T().pauses.emptyLine);
    }

    for (let i = startIdx; i <= blk._end!; i++) {
        const le = document.getElementById('ct-l' + i); if (le) le.classList.remove('ct-hi', 'ct-tr');
        const ge = document.getElementById('ct-g' + (i + 1)); if (ge) ge.classList.remove('ct-a', 'ct-t');
    }
    await sl(T().animations.tokenStep);

    if (activeConnections[blk.id]) {
        const conns = activeConnections[blk.id];
        for (let ci = 0; ci < conns.length; ci++) {
            if (dead || myRun !== runToken) break;
            // Pass the block id + index so the arrow can pick up its baked layout.
            await showBlockArrow(conns[ci], blk.id, ci);
        }
    }

    if (dead || myRun !== runToken) return;
    if (activeExpl[blk.id]) await showExplain(blk.id);
}

// ── Erase Phase ──

async function erasePhase() {
    if (!activeOldCode || activeOldCode.length === 0) return; // Skip if no erase data
    const et = pkg?.erasePhase?.timing || { lineAppearDelay: 80, swipePause: 500, removePause: 120, settlePause: 400 };
    badge.textContent = 'ANALYZING'; badge.className = 'ct-badge ct-on';
    for (let i = 0; i < activeOldCode.length; i++) {
        addGut(i + 1);
        const ln = addLine(i); ln.innerHTML = hl(activeOldCode[i]); ln.classList.add('ct-old');
        await sl(et.lineAppearDelay);
    }
    await sl(et.swipePause + 200);
    for (let i = 0; i < activeOldCode.length; i++) document.getElementById('ct-l' + i)!.classList.add('ct-sw');
    await sl(et.swipePause);
    for (let i = activeOldCode.length - 1; i >= 0; i--) {
        const el = document.getElementById('ct-l' + i)!;
        el.classList.remove('ct-sw'); el.classList.add('ct-gh');
        await sl(et.removePause);
    }
    await sl(et.settlePause);
    gut.innerHTML = ''; co.innerHTML = '';
}

// ── Main Sequence ──

async function startSequence() {
    if (run) return;
    if (!activeBlocks || activeBlocks.length === 0) {
        badge.textContent = 'NO CONTENT'; badge.className = 'ct-badge ct-idle';
        return;
    }
    // Claim a fresh run token. Any prior in-flight chain (whose continuations
    // were already scheduled) now holds a stale token and will abort.
    const myRun = ++runToken;
    initAudio();
    run = true; dead = false; doneC = 0; usrScr = false; spotStart = null; spotEnd = null; curLine = null;
    _layoutXMeasured = false; _layoutXOffset = 0;
    vizCtrl.stop(); tokVizCtrl.stop(); disposeAll(); invalidateLineWidthCache();
    gut.innerHTML = ''; co.innerHTML = ''; asvg.innerHTML = '';
    bPlay.style.display = 'none'; bStop.style.display = ''; bReplay.style.display = 'none';
    rbar.classList.remove('ct-v');
    badge.textContent = 'ANALYZING'; badge.className = 'ct-badge ct-on';
    t0 = Date.now();

    await erasePhase();
    if (dead || myRun !== runToken) { if (myRun === runToken) finish(); return; }

    badge.textContent = 'WRITING'; badge.className = 'ct-badge ct-on';
    vig.classList.add('ct-on');
    rbar.classList.add('ct-v');

    for (const blk of activeBlocks) {
        if (dead || myRun !== runToken) break;
        await typeBlock(blk, myRun);
        await sl(T().pauses.blockGap);
    }
    // Only the current run may finalize — a superseded run must not touch the DOM
    // that the newer run now owns.
    if (myRun === runToken) finish();
}

// Bump the run token so any in-flight chain aborts at its next checkpoint, then
// finalize the UI directly: with the token bumped, the (now stale) awaiting loop
// won't call finish() itself.
function stopSequence() { if (!run) { dead = true; return; } dead = true; runToken++; finish(); }

function finish() {
    run = false; vig.classList.remove('ct-on');
    spotEl.classList.remove('ct-v');
    epEl.classList.remove('ct-v');
    clearTimeout(expTimeout!); if (expResolve) expResolve();
    vizCtrl.stop(); tokVizCtrl.stop(); disposeAll();
    if (_cubeAnim) { cancelAnimationFrame(_cubeAnim); _cubeAnim = null; }
    invalidateLineWidthCache();
    badge.textContent = dead ? 'CANCELLED' : 'COMPLETE';
    badge.className = dead ? 'ct-badge ct-idle' : 'ct-badge ct-done';
    bStop.style.display = 'none'; bReplay.style.display = ''; bPlay.style.display = 'none';
    pfl.style.width = dead ? pfl.style.width : '100%';
    co.querySelectorAll('.ct-hi,.ct-tr').forEach(e => e.classList.remove('ct-hi', 'ct-tr'));
    gut.querySelectorAll('.ct-a,.ct-t').forEach(e => e.classList.remove('ct-a', 'ct-t'));
}

// ══════════════════════════════════════════════════════════════
//  PUBLIC API
// ══════════════════════════════════════════════════════════════

let _mounted = false;

/**
 * Load a lesson from a .lesson JSON object.
 * Replaces the active lesson data so the engine plays the imported lesson.
 * Call this BEFORE mount() or between unmount/mount cycles.
 */
export function loadLesson(data: any) {
    // Detect format and convert to v2 LessonPackage
    if (data.format === 'nexia-lesson-v2') {
        pkg = loadFromJSON(data, data._basePath || '');
    } else {
        // V1 format — convert
        pkg = convertV1ToV2(data, data._blockVis, data._tokenVis);
    }

    // Sync module-level variables for backward compat with rest of engine
    activeBlocks = pkg.blocks as any;
    activeOldCode = pkg.erasePhase?.lines || [];
    // Normalize layout to engine's expected format
    if (pkg.layout) {
        const rawLayout = pkg.layout as any;
        activeLayout = {
            blocks: rawLayout.blocks || {},
            tokens: rawLayout.tokens || {},
            connections: rawLayout.connections || {},
            canvasWidth: rawLayout.canvasWidth || rawLayout.canvas?.width || 900,
            canvasHeight: rawLayout.canvasHeight || rawLayout.canvas?.height || 600,
        };
    } else {
        activeLayout = null;
    }

    // Map v2 explanations to v1 field names (engine reads .desc, .tp)
    activeExpl = {};
    if (pkg.overlay.explanations) {
        for (const [id, ex] of Object.entries(pkg.overlay.explanations)) {
            activeExpl[id] = {
                label: ex.label,
                tp: (ex as any).tp || (ex as any).type || 'concept',
                desc: (ex as any).desc || (ex as any).description || '',
                narration: (ex as any).narration || null,
            };
        }
    }

    // Map v2 connections to v1 field names (engine reads .desc)
    activeConnections = {};
    if (pkg.overlay.connections) {
        for (const [id, conns] of Object.entries(pkg.overlay.connections)) {
            activeConnections[id] = conns.map(c => ({
                src: c.src,
                dst: c.dst,
                label: c.label,
                desc: (c as any).desc || (c as any).description || '',
            }));
        }
    }

    // Map v2 tokens to v1 field names (engine reads .desc)
    activeTokens = {};
    if (pkg.overlay.tokens) {
        for (const [id, tlines] of Object.entries(pkg.overlay.tokens)) {
            activeTokens[id] = tlines.map(tl => ({
                line: tl.line,
                tokens: tl.tokens.map(t => ({
                    text: t.text,
                    desc: (t as any).desc || (t as any).description || '',
                })),
            })) as any;
        }
    }

    activeVisControls = {};
    activeAnimatedVis = new Set<string>();
    activeBlockVis = pkg._blockVisualizers || {} as any;
    activeTokenVis = pkg._tokenVisualizers || {} as any;

    // Load v2 visualizer files if embedded by main process
    if ((data as any)._visualizerFiles) {
        const visFiles = (data as any)._visualizerFiles as Record<string, string>;
        const loadedModules: Record<string, Record<string, any>> = {};

        // Parse each JS file
        for (const [filename, code] of Object.entries(visFiles)) {
            try {
                const mod: Record<string, any> = {};
                const loader = new Function('exports', code);
                loader(mod);
                loadedModules[filename] = mod;
            } catch (err) {
                console.warn('Failed to load visualizer file:', filename, err);
            }
        }

        // Map block visualizers: overlay.visualizers[blockId].source → file, .function → export name
        if (pkg.overlay.visualizers) {
            for (const [blockId, vDef] of Object.entries(pkg.overlay.visualizers)) {
                const filename = vDef.source.split('/').pop() || '';
                const mod = loadedModules[filename];
                if (mod && mod[vDef.function]) {
                    activeBlockVis[blockId] = mod[vDef.function];
                }
            }
        }

        // Map token visualizers: overlay.tokenVisualizers[tokenText].source → file, .function → export name
        if (pkg.overlay.tokenVisualizers) {
            for (const [tokenText, tDef] of Object.entries(pkg.overlay.tokenVisualizers)) {
                const filename = tDef.source.split('/').pop() || '';
                const mod = loadedModules[filename];
                if (mod && mod[tDef.function]) {
                    activeTokenVis[tokenText] = mod[tDef.function];
                }
            }
        }
    }

    // Map v2 visualizer controls from overlay into the old format
    if (pkg.overlay.visualizers) {
        for (const [blockId, vDef] of Object.entries(pkg.overlay.visualizers)) {
            if (vDef.controls && vDef.controls.length > 0) {
                activeVisControls[blockId] = vDef.controls.map(c => ({
                    key: c.key, label: c.label, type: c.type,
                    min: c.min, max: c.max, val: c.default,
                }));
            }
            if (vDef.animated) activeAnimatedVis.add(blockId);
        }
    }
}

/**
 * Load a v2 LessonPackage directly (from the loader).
 */
export function loadPackage(lessonPkg: LessonPackage) {
    pkg = lessonPkg;
    // Delegate to loadLesson which handles all field mapping
    loadLesson(lessonPkg as any);
}

/**
 * Clear engine state. No built-in data exists — all content via .lesson packages.
 */
export function reset() {
    pkg = null;
    activeBlocks = [];
    activeOldCode = [];
    activeExpl = {};
    activeConnections = {};
    activeTokens = {};
    activeVisControls = {};
    activeAnimatedVis = new Set<string>();
    activeBlockVis = {};
    activeTokenVis = {};
    activeLayout = null;
}

/**
 * Build the cinematic tutor DOM inside the given container.
 * The container should be a div in the editor area.
 */
export function mount(container: HTMLElement) {
    if (_mounted) unmount();
    rootContainer = container;
    injectCinematicStyles();

    // Build DOM structure
    container.innerHTML = `
        <div class="ct-ctrl">
            <button class="ct-btn ct-p" id="ct-bPlay">⚡ Apply Code</button>
            <button class="ct-btn ct-d" id="ct-bStop" style="display:none">■ Stop</button>
            <button class="ct-btn ct-s" id="ct-bReplay" style="display:none">↻ Replay</button>
            <span class="ct-badge ct-idle" id="ct-badge">IDLE</span>
            <div class="ct-spd"><span>Speed</span><input type="range" id="ct-spdR" min="1" max="12" value="4"><span id="ct-spdL">0.5x</span></div>
        </div>
        <div class="ct-ew"><div class="ct-ei">
            <div class="ct-vig" id="ct-vig"><svg><defs><mask id="ct-sm"><rect width="100%" height="100%" fill="white"/><rect id="ct-sh" x="50" y="0" width="28%" height="0" rx="10" ry="10" fill="black"/><rect id="ct-sh2" x="50" y="0" width="28%" height="0" rx="10" ry="10" fill="black"/></mask></defs><rect width="100%" height="100%" fill="rgba(0,0,0,.78)" mask="url(#ct-sm)"/></svg></div>
            <div class="ct-spot" id="ct-spot"></div>
            <div class="ct-spot" id="ct-spot2"></div>
            <div class="ct-alyr"><svg id="ct-asvg"></svg></div>
            <div class="ct-ep" id="ct-ep"><div id="ct-epc"></div></div>
            <div class="ct-mini-exp" id="ct-miniExp"></div>
            <div class="ct-ed" id="ct-ed"><div class="ct-gut" id="ct-gut"></div><div class="ct-co" id="ct-co"></div></div>
        </div></div>
        <div class="ct-rbar" id="ct-rbar"><div class="ct-trk"><div class="ct-fl" id="ct-pfl" style="width:0"></div></div><div class="ct-tm" id="ct-tlbl">0:00</div></div>
    `;

    // Bind DOM refs
    ed = document.getElementById('ct-ed')!;
    gut = document.getElementById('ct-gut')!;
    co = document.getElementById('ct-co')!;
    vig = document.getElementById('ct-vig')!;
    badge = document.getElementById('ct-badge')!;
    pfl = document.getElementById('ct-pfl')!;
    tlbl = document.getElementById('ct-tlbl')!;
    rbar = document.getElementById('ct-rbar')!;
    spdR = document.getElementById('ct-spdR') as HTMLInputElement;
    spdL = document.getElementById('ct-spdL')!;
    bPlay = document.getElementById('ct-bPlay')!;
    bStop = document.getElementById('ct-bStop')!;
    bReplay = document.getElementById('ct-bReplay')!;
    spotEl = document.getElementById('ct-spot')!;
    spot2El = document.getElementById('ct-spot2')!;
    shEl = document.getElementById('ct-sh') as unknown as SVGRectElement;
    sh2El = document.getElementById('ct-sh2') as unknown as SVGRectElement;
    asvg = document.getElementById('ct-asvg') as unknown as SVGSVGElement;
    epEl = document.getElementById('ct-ep')!;
    epcEl = document.getElementById('ct-epc')!;
    miniExpEl = document.getElementById('ct-miniExp')!;

    // Line width measurement canvas
    const measureCanvas = document.createElement('canvas');
    _mCtx = measureCanvas.getContext('2d')!;
    _mCtx.font = `${S().fontSize}px ${S().fontFamily.split(',')[0].replace(/'/g, '')}`;

    // _layoutXOffset will be measured from the first real code line element
    // once it's in the DOM. See _measureLayoutOffset().
    _layoutXOffset = 0;
    _layoutXMeasured = false;

    // If no package loaded, show a message instead of auto-falling back
    if (!pkg) {
        container.querySelector('.ct-ei')!.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-dim,#555);font-size:13px;font-family:sans-serif;text-align:center;padding:40px"><div>No lesson package loaded.<br><span style="font-size:11px;opacity:0.6">Load a .lesson package to begin.</span></div></div>';
        _mounted = true;
        return;
    }

    // Process lesson data
    processLesson(activeBlocks);

    // Wire controls
    bPlay.onclick = () => startSequence();
    // Stop: stopSequence() marks dead, bumps the run token so any already-scheduled
    // continuation aborts at its next checkpoint, and finalizes the UI.
    bStop.onclick = () => stopSequence();
    // Replay: clear dead, then startSequence() claims a fresh token which
    // invalidates any lingering continuation from the previous run.
    bReplay.onclick = () => { dead = false; startSequence(); };

    spdR.oninput = () => {
        const s = spd();
        spdL.textContent = s.toFixed(s < 1 ? 2 : 1) + 'x';
    };

    // Scroll handling
    ed.addEventListener('wheel', () => { usrScr = true; if (scrTmr) clearTimeout(scrTmr); scrTmr = setTimeout(() => { usrScr = false; }, T().animations.scrollReset); }, { passive: true });
    let _scrollRafPending = false;
    ed.addEventListener('scroll', () => {
        if (_scrollRafPending || _dualSpotActive) return; _scrollRafPending = true;
        requestAnimationFrame(() => { _scrollRafPending = false; if (spotStart !== null && spotEnd !== null) updSpotRange(); else if (curLine !== null) updSpot1(curLine); });
    }, { passive: true });

    _mounted = true;
}

/**
 * Tear down the cinematic tutor DOM and release all resources.
 */
export function unmount() {
    if (!_mounted) return;
    dead = true;
    // Invalidate any in-flight run so stale scheduled continuations abort instead
    // of resuming against the torn-down DOM.
    runToken++;
    finish();
    disposeAll();
    if (rootContainer) rootContainer.innerHTML = '';
    removeCinematicStyles();
    _mounted = false;
}

/** Start the cinematic animation sequence. */
export function start() { startSequence(); }

/** Stop the animation mid-sequence. */
export function stop() { stopSequence(); }

/** Whether the tutor is currently mounted. */
export function isActive(): boolean { return _mounted; }

/** Whether the animation is currently running. */
export function isRunning(): boolean { return run; }

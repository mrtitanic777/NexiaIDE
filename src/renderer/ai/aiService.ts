/**
 * aiService.ts — Nexia AI Multi-Provider Assistant
 *
 * Extracted from app.ts during Phase 5 decomposition.
 * Contains: AI request handling, chat UI, inline suggestions,
 * hint bar, code generation, build error analysis, and settings.
 *
 * Dependencies are provided via appContext.ts (shared state).
 */

import { $, $$, escHtml, ctx, fn } from '../appContext';
const { ipcRenderer } = require('electron');
const nodeFs = require('fs');
const nodePath = require('path');

const { learningProfile } = require('../learning/learningProfile');
const { codeVisualizer } = require('../visualizer/codeVisualizer');

// ── VIZ Tag Processing ──
// When the AI includes [VIZ:VARIABLE:name:type:value] or similar tags in its response,
// we extract them, trigger the visualizer, and remove the tags from the display text.

function processVizTags(text: string): string {
    const vizRegex = /\[VIZ:([^\]]+)\]/g;
    let match;
    let lastVizCommand: string | null = null;

    while ((match = vizRegex.exec(text)) !== null) {
        lastVizCommand = match[1];
    }

    // If we found any VIZ commands, render the last one (most relevant)
    if (lastVizCommand) {
        try {
            codeVisualizer.parseCommand(lastVizCommand);
            const vizCanvas = document.getElementById('visualizer-canvas') as HTMLCanvasElement;
            if (vizCanvas) {
                codeVisualizer.attach(vizCanvas);
                codeVisualizer.render();
            }
            // Auto-switch to visualizer tab in bottom panel
            const vizTab = document.querySelector('[data-panel="visualizer"]') as HTMLElement;
            if (vizTab) vizTab.click();
        } catch (e) {
            // Silently fail — don't break the chat
        }
    }

    // Strip VIZ tags from display text, replace with a subtle indicator
    return text.replace(vizRegex, '📊 *(diagram shown in Visualizer panel)*');
}

const XBOX360_SYSTEM_PROMPT = `You are Nexia AI, an expert Xbox 360 development assistant built into the Nexia IDE. You have deep knowledge of:
- Xbox 360 SDK (XDK) APIs, D3D9 on Xbox 360, XAudio2, XACT, XInput
- PowerPC architecture (Xenon CPU), Xbox 360 GPU (Xenos/ATI)
- XEX format, XAM.XEX system functions, Xbox 360 memory layout
- C++ game programming, HLSL shaders, Xbox 360 performance optimization
- RGH/JTAG development, homebrew development, devkit deployment
- MSBuild for Xbox 360 projects, Xbox 360 SDK toolchain

You are integrated directly into the IDE. When the user has a file open, you can see its contents.
You can see the project's file tree and understand the project structure.

When generating code changes, wrap them in special tags so the IDE can apply them:
- To replace the ENTIRE current file: \\\`\\\`\\\`cpp:replace\\n...code...\\n\\\`\\\`\\\`
- To create a NEW file: \\\`\\\`\\\`cpp:newfile:filename.cpp\\n...code...\\n\\\`\\\`\\\`
- To insert code at a specific line: \\\`\\\`\\\`cpp:insert:LINE_NUMBER\\n...code...\\n\\\`\\\`\\\`

When generating code, always use Xbox 360 compatible APIs and patterns.
Keep responses concise and code-focused. Use C++ unless asked otherwise.`;

interface AIMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: number;
    id?: number;
    /** Sent to the model but never drawn in the transcript (proactive tutor prompts). */
    hidden?: boolean;
}

let aiMessages: AIMessage[] = [];
let aiStreaming = false;
// Monotonic id stamped on each message and its DOM node so we can match a
// message to its exact DOM element by identity rather than by text content
// (duplicate prompts would otherwise delete the wrong node — see retryAIMessage).
let aiMsgIdSeq = 0;
function nextAIMsgId(): number { return ++aiMsgIdSeq; }

// ── AI networking via Node's https (bypasses CSP, uses exact URLs) ──
const nodeHttps = require('https');
const nodeHttp = require('http');
const nodeUrl = require('url');
const { marked } = require('marked');
const hljs = require('highlight.js');

// Configure marked with highlight.js for syntax highlighting in code blocks
marked.setOptions({
    highlight: (code: string, lang: string) => {
        if (lang && hljs.getLanguage(lang)) {
            try { return hljs.highlight(code, { language: lang }).value; } catch {}
        }
        try { return hljs.highlightAuto(code).value; } catch {}
        return code;
    },
    breaks: true,
    gfm: true,
});

export function renderMarkdown(text: string): string {
    try { return marked.parse(text); }
    catch { return text.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>'); }
}

// Non-streaming request (error analysis, code gen, inline, test)
function aiRequest(url: string, body: any, apiKey?: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const isHttps = parsed.protocol === 'https:';
        const lib = isHttps ? nodeHttps : nodeHttp;
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
        const postData = JSON.stringify(body);
        headers['Content-Length'] = Buffer.byteLength(postData).toString();
        const req = lib.request({
            hostname: parsed.hostname, port: parsed.port || (isHttps ? 443 : 80),
            path: parsed.pathname + parsed.search, method: 'POST', headers,
        }, (res: any) => {
            let data = '';
            res.on('data', (chunk: string) => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 400) { reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 300)}`)); return; }
                try { resolve(JSON.parse(data)); }
                catch { reject(new Error('Invalid JSON response: ' + data.substring(0, 200))); }
            });
        });
        req.on('error', reject);
        req.setTimeout(120000, () => { req.destroy(); reject(new Error('Request timeout')); });
        req.write(postData); req.end();
    });
}

function aiRequestRaw(url: string, body: any, headers: Record<string, string>, onRequest?: (req: any) => void): Promise<any> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const isHttps = parsed.protocol === 'https:';
        const lib = isHttps ? nodeHttps : nodeHttp;
        const postData = JSON.stringify(body);
        headers['Content-Length'] = Buffer.byteLength(postData).toString();
        let aborted = false;
        const req = lib.request({
            hostname: parsed.hostname, port: parsed.port || (isHttps ? 443 : 80),
            path: parsed.pathname + parsed.search, method: 'POST', headers,
        }, (res: any) => {
            let data = '';
            res.on('data', (chunk: string) => data += chunk);
            res.on('end', () => {
                if (aborted) return;
                if (res.statusCode >= 400) { reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 300)}`)); return; }
                try { resolve(JSON.parse(data)); }
                catch { reject(new Error('Invalid JSON response: ' + data.substring(0, 200))); }
            });
        });
        req.on('error', (err: Error) => { if (!aborted) reject(err); });
        req.setTimeout(120000, () => { req.destroy(); if (!aborted) reject(new Error('Request timeout')); });
        // Expose the in-flight request so callers can abort it. Wrapping the
        // request object lets the caller call req.destroy() and mark this aborted
        // so the stale onError/onEnd handlers don't reject after cancellation.
        if (onRequest) onRequest({ destroy: () => { aborted = true; req.destroy(new Error('aborted')); } });
        req.write(postData); req.end();
    });
}

// ── SSE Streaming — parses Server-Sent Events, yields tokens to callback ──
function aiStreamSSE(
    url: string, body: any, headers: Record<string, string>,
    onToken: (token: string) => void,
    onDone: (fullText: string) => void,
    onError: (err: Error) => void,
): () => void {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? nodeHttps : nodeHttp;

    body.stream = true;
    const postData = JSON.stringify(body);
    headers['Content-Length'] = Buffer.byteLength(postData).toString();
    headers['Accept'] = 'text/event-stream';

    let fullText = '';
    let aborted = false;
    let buffer = '';
    let finished = false;

    const finish = () => { if (!finished) { finished = true; onDone(fullText); } };
    // fail() and finish() are mutually exclusive: once either fires, the `finished`
    // flag is latched so a late socket timeout/error can't append a spurious bubble.
    const fail = (err: Error) => { if (!finished && !aborted) { finished = true; onError(err); } };

    // Parse a single complete SSE line. Returns true if [DONE] was seen.
    const parseLine = (line: string): boolean => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) return false;
        if (trimmed === 'data: [DONE]') return true;
        if (trimmed.startsWith('data: ')) {
            try {
                const obj = JSON.parse(trimmed.slice(6));
                const delta = obj.choices?.[0]?.delta?.content || obj.choices?.[0]?.text || '';
                if (delta) { fullText += delta; onToken(delta); }
            } catch {}
        }
        return false;
    };

    const req = lib.request({
        hostname: parsed.hostname, port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search, method: 'POST', headers,
    }, (res: any) => {
        if (res.statusCode >= 400) {
            let errData = '';
            res.on('data', (c: string) => errData += c);
            res.on('end', () => fail(new Error(`HTTP ${res.statusCode}: ${errData.substring(0, 300)}`)));
            return;
        }
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
            if (aborted || finished) return;
            buffer += chunk;
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (parseLine(line)) { finish(); return; }
            }
        });
        res.on('end', () => {
            if (aborted || finished) return;
            // Flush any trailing bytes left in the buffer when the stream ends
            // without a final newline / [DONE] sentinel, so we don't lose the last token.
            if (buffer.trim()) parseLine(buffer);
            buffer = '';
            finish();
        });
    });

    req.on('error', (err: Error) => fail(err));
    req.setTimeout(120000, () => { req.destroy(); fail(new Error('Stream timeout')); });
    req.write(postData); req.end();

    return () => { aborted = true; finished = true; req.destroy(); };
}

function getAIRequestURL(): string {
    const s = ctx.userSettings;
    switch (s.aiProvider) {
        case 'anthropic': return 'https://api.anthropic.com/v1/messages';
        case 'openai': return 'https://api.openai.com/v1/chat/completions';
        case 'local': return s.aiEndpoint || 'http://localhost:11434/v1/chat/completions';
        case 'custom': return s.aiEndpoint || 'http://localhost:8080/v1/chat/completions';
        default: return s.aiEndpoint;
    }
}

function getAIModel(): string {
    const m = (ctx.userSettings.aiModel || '').trim();
    if (m && m !== 'auto') return m;
    const defaults: Record<string, string> = {
        anthropic: 'claude-sonnet-4-20250514',
        openai: 'gpt-4o',
        local: 'llama3',
        custom: '',
    };
    return defaults[ctx.userSettings.aiProvider] || '';
}

// ── Project Signature Scanner ──
// Scans .h/.hpp/.cpp files for function, class, struct, enum, typedef, and #define signatures
// to provide the LLM with codebase context for accurate completions

let projectSignaturesCache: string = '';
let projectSignaturesCacheTime: number = 0;
const SIGNATURE_CACHE_TTL = 30000; // 30s — rescan after this

function scanProjectSignatures(): string {
    if (!currentProject?.path) return '';

    // Use cache if fresh
    const now = Date.now();
    if (projectSignaturesCache && (now - projectSignaturesCacheTime) < SIGNATURE_CACHE_TTL) {
        return projectSignaturesCache;
    }

    const srcDir = nodePath.join(currentProject.path, 'src');
    const includeDir = nodePath.join(currentProject.path, 'include');
    const signatures: string[] = [];
    const scannedFiles: string[] = [];

    function scanDir(dir: string) {
        try {
            if (!nodeFs.existsSync(dir)) return;
            const entries = nodeFs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = nodePath.join(dir, entry.name);
                if (entry.isDirectory()) {
                    scanDir(fullPath);
                } else {
                    const ext = nodePath.extname(entry.name).toLowerCase();
                    if (['.h', '.hpp', '.hxx', '.cpp', '.c', '.cc', '.cxx', '.hlsl'].includes(ext)) {
                        scanFile(fullPath, entry.name);
                    }
                }
            }
        } catch {}
    }

    function scanFile(filePath: string, fileName: string) {
        try {
            const content = nodeFs.readFileSync(filePath, 'utf-8');
            const lines = content.split('\n');
            const fileSigs: string[] = [];

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();

                // Skip empty lines, comments, preprocessor guards
                if (!line || line.startsWith('//') || line === '#pragma once' || line.startsWith('#ifndef') || line.startsWith('#define _') || line.startsWith('#endif')) continue;

                // Function declarations/definitions: return_type name(params)
                const funcMatch = line.match(/^(?:(?:static|inline|virtual|extern|__declspec\([^)]*\))\s+)*(\w[\w:*&<> ]*?)\s+(\w+)\s*\(([^)]*)\)\s*(?:const\s*)?(?:override\s*)?[;{]/);
                if (funcMatch && !['if', 'while', 'for', 'switch', 'return', 'else', 'case'].includes(funcMatch[2])) {
                    fileSigs.push(`${funcMatch[1]} ${funcMatch[2]}(${funcMatch[3].trim()})`);
                    continue;
                }

                // Class/struct declarations
                const classMatch = line.match(/^(?:class|struct)\s+(?:__declspec\([^)]*\)\s+)?(\w+)\s*(?::\s*(?:public|private|protected)\s+\w[\w:<> ]*)?(?:\s*\{)?/);
                if (classMatch) {
                    fileSigs.push(`${line.startsWith('struct') ? 'struct' : 'class'} ${classMatch[1]}`);
                    continue;
                }

                // Enum declarations
                const enumMatch = line.match(/^enum\s+(?:class\s+)?(\w+)/);
                if (enumMatch) {
                    fileSigs.push(`enum ${enumMatch[1]}`);
                    continue;
                }

                // Typedef
                if (line.startsWith('typedef ')) {
                    const shortTypedef = line.length < 120 ? line.replace(/;$/, '') : line.substring(0, 120) + '...';
                    fileSigs.push(shortTypedef);
                    continue;
                }

                // #define macros (skip include guards)
                const defineMatch = line.match(/^#define\s+(\w+)(?:\(([^)]*)\))?\s*(.*)/);
                if (defineMatch && defineMatch[1] && !defineMatch[1].startsWith('_') && defineMatch[1] !== defineMatch[1].toUpperCase() + '_H') {
                    const macro = defineMatch[2] !== undefined
                        ? `#define ${defineMatch[1]}(${defineMatch[2]})`
                        : `#define ${defineMatch[1]}`;
                    fileSigs.push(macro);
                    continue;
                }

                // Global variable declarations (extern)
                if (line.startsWith('extern ') && line.endsWith(';')) {
                    fileSigs.push(line.replace(/;$/, ''));
                    continue;
                }
            }

            if (fileSigs.length > 0) {
                scannedFiles.push(fileName);
                signatures.push(`// ${fileName}\n${fileSigs.join('\n')}`);
            }
        } catch {}
    }

    scanDir(srcDir);
    scanDir(includeDir);
    // Also scan root-level headers
    try {
        const rootEntries = nodeFs.readdirSync(currentProject.path);
        for (const name of rootEntries) {
            const ext = nodePath.extname(name).toLowerCase();
            if (['.h', '.hpp'].includes(ext)) {
                scanFile(nodePath.join(currentProject.path, name), name);
            }
        }
    } catch {}

    if (signatures.length === 0) return '';

    // Truncate if too large (keep under ~4000 chars to not blow up context)
    let result = signatures.join('\n\n');
    if (result.length > 4000) {
        result = result.substring(0, 4000) + '\n// ... (truncated, ' + scannedFiles.length + ' files scanned)';
    }

    projectSignaturesCache = result;
    projectSignaturesCacheTime = now;
    return result;
}

function getSystemPrompt(): string {
    let prompt = XBOX360_SYSTEM_PROMPT;

    // Inject project signatures
    const sigs = scanProjectSignatures();
    if (sigs) {
        prompt += `\n\nThe user's current project contains the following declarations and signatures. Use these for accurate code completion, references, and suggestions:\n\n${sigs}`;
    }

    // Inject adaptive learning profile context
    // This tells the AI about the user's mastery levels, struggles, and recommended focus areas
    const learnerContext = learningProfile.getAIContextSummary();
    if (learnerContext) {
        prompt += `\n\n${learnerContext}`;
    }

    if (ctx.userSettings.aiSystemPrompt) {
        prompt += '\n\n' + ctx.userSettings.aiSystemPrompt;
    }
    return prompt;
}

export async function aiComplete(messages: { role: string; content: string }[]): Promise<string> {
    const url = getAIRequestURL();
    const s = ctx.userSettings;

    if (s.aiProvider === 'anthropic') {
        const body = {
            model: getAIModel(),
            max_tokens: 4096,
            system: getSystemPrompt(),
            messages,
        };
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'x-api-key': s.aiApiKey,
            'anthropic-version': '2023-06-01',
        };
        const resp = await aiRequestRaw(url, body, headers);
        return (resp.content || []).map((b: any) => b.text || '').join('');
    } else {
        const model = getAIModel();
        const sysPrompt = getSystemPrompt();
        const allMessages: any[] = [];
        if (sysPrompt) allMessages.push({ role: 'system', content: sysPrompt });
        allMessages.push(...messages);
        const body: any = { messages: allMessages, max_tokens: 4096 };
        if (model) body.model = model;
        const resp = await aiRequest(url, body, s.aiApiKey || undefined);
        return resp.choices?.[0]?.message?.content || '';
    }
}

function setAIStatus(state: 'connected' | 'disconnected' | 'loading' | 'error', text?: string) {
    const dot = $('ai-status-dot');
    const txt = $('ai-status-text');
    const label = $('ai-provider-label');
    dot.className = 'ai-dot ' + state;
    if (text) txt.textContent = text;
    const providerNames: Record<string, string> = { anthropic: 'Claude', openai: 'GPT', local: 'Ollama', custom: 'Custom' };
    label.textContent = ctx.userSettings.aiApiKey || ctx.userSettings.aiProvider === 'local' ? providerNames[ctx.userSettings.aiProvider] || '' : '';
}

let aiAbortStream: (() => void) | null = null;

/**
 * @param hidden Send the prompt to the model without showing it in the chat.
 *               The proactive tutor uses this: its prompts are instructions
 *               ("[SYSTEM: The learner just failed a quiz about X...]") and are
 *               not something the user typed, so displaying them exposed the
 *               scaffolding and read as if the IDE were talking to itself.
 *               The message still enters aiMessages, so the model sees it and
 *               the conversation stays coherent.
 */
export async function sendAIMessage(userText: string, contextCode?: string, hidden = false) {
    if (!userText.trim() || aiStreaming) return;
    if (!ctx.userSettings.aiApiKey && ctx.userSettings.aiProvider !== 'local' && ctx.userSettings.aiProvider !== 'custom') {
        addAIMessage('system', '⚠ No API key configured. Click the ⚙ button to set up your AI provider.');
        return;
    }

    let fullPrompt = userText;
    if (contextCode) {
        fullPrompt = `Here is the relevant code:\n\`\`\`cpp\n${contextCode}\n\`\`\`\n\n${userText}`;
    } else if (ctx.userSettings.aiFileContext && ctx.editor) {
        const currentCode = ctx.editor.getValue();
        const currentTab = ctx.openTabs.find(t => t.path === ctx.activeTab);
        const parts: string[] = [];

        // Project structure context
        if (ctx.currentProject) {
            parts.push(`Project: "${ctx.currentProject.name}" at ${ctx.currentProject.path}`);
        }

        // Current file context
        if (currentCode && currentCode.length < 12000 && currentTab) {
            parts.push(`Currently editing "${currentTab.name}":\n\`\`\`cpp\n${currentCode}\n\`\`\``);
        } else if (currentTab) {
            parts.push(`Currently editing "${currentTab.name}" (file too large to include).`);
        }

        if (parts.length > 0) {
            fullPrompt = parts.join('\n\n') + '\n\n' + userText;
        }
    }

    addAIMessage('user', userText, hidden);
    showAITyping();
    setAIStatus('loading', 'Thinking...');
    aiStreaming = true;
    ($('ai-send') as HTMLButtonElement).disabled = false;
    $('ai-send').textContent = '↑';
    $('ai-send').textContent = '■'; // Stop icon

    const apiMessages = aiMessages
        .filter(m => m.role !== 'system')
        .map(m => ({ role: m.role, content: m.role === 'user' && m === aiMessages[aiMessages.length - 1] ? fullPrompt : m.content }));

    const url = getAIRequestURL();
    const s = ctx.userSettings;

    // Build request body and headers based on provider
    let body: any;
    let headers: Record<string, string> = { 'Content-Type': 'application/json' };

    if (s.aiProvider === 'anthropic') {
        headers['x-api-key'] = s.aiApiKey;
        headers['anthropic-version'] = '2023-06-01';
        body = { model: getAIModel(), max_tokens: 4096, system: getSystemPrompt(), messages: apiMessages };
        // Anthropic streaming uses a different SSE format — fall back to non-streaming for now.
        // The request is still cancellable: aiRequestRaw hands us the in-flight request via
        // onRequest, which we store in aiAbortStream so the Stop button can destroy it.
        let anthropicAborted = false;
        try {
            const resp = await aiRequestRaw(url, body, headers, (req: any) => {
                aiAbortStream = () => { anthropicAborted = true; req.destroy(); };
            });
            aiAbortStream = null;
            const reply = (resp.content || []).map((b: any) => b.text || '').join('');
            hideAITyping();
            if (reply) {
                const displayReply = processVizTags(reply);
                addAIMessage('assistant', displayReply);
                setAIStatus('connected', 'Ready');
            }
            else { addAIMessage('system', '⚠ Empty response.'); setAIStatus('error', 'Empty'); }
        } catch (err: any) {
            aiAbortStream = null;
            hideAITyping();
            // If the user pressed Stop, treat it as a clean cancellation, not an error.
            if (anthropicAborted) {
                setAIStatus('connected', 'Stopped');
            } else {
                addAIMessage('system', `❌ Error: ${err.message}`);
                setAIStatus('error', 'Failed');
            }
        }
        aiStreaming = false;
        ($('ai-send') as HTMLButtonElement).disabled = false;
    $('ai-send').textContent = '↑';
        return;
    }

    // OpenAI-compatible providers — use SSE streaming
    if (s.aiApiKey) headers['Authorization'] = `Bearer ${s.aiApiKey}`;
    const model = getAIModel();
    const sysPrompt = getSystemPrompt();
    const allMessages: any[] = [];
    if (sysPrompt) allMessages.push({ role: 'system', content: sysPrompt });
    allMessages.push(...apiMessages);
    body = { messages: allMessages, max_tokens: 4096 };
    if (model) body.model = model;

    // Create the streaming message element
    hideAITyping();
    const streamMsg: AIMessage = { role: 'assistant', content: '', timestamp: Date.now(), id: nextAIMsgId() };
    aiMessages.push(streamMsg);
    const streamEl = createStreamingMessageEl(streamMsg.id!);
    const bodyEl = streamEl.querySelector('.ai-msg-body') as HTMLElement;

    let tokenCount = 0;

    aiAbortStream = aiStreamSSE(url, body, headers,
        // onToken — live update
        (token: string) => {
            streamMsg.content += token;
            tokenCount++;
            // Re-render markdown every few tokens (throttled for performance)
            if (tokenCount % 3 === 0 || token.includes('\n')) {
                bodyEl.innerHTML = renderMarkdown(streamMsg.content);
                addCopyButtonsToCodeBlocks(bodyEl);
            }
            $('ai-messages').scrollTop = $('ai-messages').scrollHeight;
            setAIStatus('loading', `Streaming... (${streamMsg.content.length} chars)`);
        },
        // onDone
        (fullText: string) => {
            const displayText = processVizTags(fullText);
            streamMsg.content = displayText;
            bodyEl.innerHTML = renderMarkdown(displayText);
            addCopyButtonsToCodeBlocks(bodyEl);
            // Remove streaming visual state
            streamEl.classList.remove('ai-msg-streaming');
            const badge = streamEl.querySelector('.ai-msg-streaming-badge');
            if (badge) badge.remove();
            // Add action buttons
            addMessageActionButtons(streamEl, streamMsg);
            $('ai-messages').scrollTop = $('ai-messages').scrollHeight;
            setAIStatus('connected', 'Ready');
            aiStreaming = false;
            aiAbortStream = null;
            ($('ai-send') as HTMLButtonElement).disabled = false;
    $('ai-send').textContent = '↑';
        },
        // onError
        (err: Error) => {
            if (streamMsg.content) {
                // Partial response — keep what we got
                bodyEl.innerHTML = renderMarkdown(streamMsg.content);
                addCopyButtonsToCodeBlocks(bodyEl);
            } else {
                streamEl.remove();
                aiMessages.pop();
            }
            addAIMessage('system', `❌ Stream error: ${err.message}`);
            setAIStatus('error', 'Stream failed');
            aiStreaming = false;
            aiAbortStream = null;
            ($('ai-send') as HTMLButtonElement).disabled = false;
    $('ai-send').textContent = '↑';
        },
    );
}

function createStreamingMessageEl(msgId?: number): HTMLElement {
    const container = $('ai-messages');
    const welcome = container.querySelector('.ai-welcome');
    if (welcome) welcome.remove();

    const el = document.createElement('div');
    el.className = 'ai-msg ai-msg-streaming';
    if (msgId != null) el.dataset.msgId = String(msgId);
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    el.innerHTML = `<div class="ai-msg-header"><span class="ai-msg-role assistant">Nexia AI</span><span class="ai-msg-streaming-badge">● streaming</span><span class="ai-msg-time">${time}</span></div><div class="ai-msg-body"><span class="ai-cursor-blink">▊</span></div>`;
    container.appendChild(el);
    $('ai-messages').scrollTop = $('ai-messages').scrollHeight;
    return el;
}

function addCopyButtonsToCodeBlocks(container: HTMLElement) {
    container.querySelectorAll('pre').forEach(pre => {
        if (pre.querySelector('.ai-code-copy')) return; // already has one
        const codeEl = pre.querySelector('code');
        const code = codeEl?.textContent || pre.textContent || '';
        pre.style.position = 'relative';

        // Action buttons wrapper
        const actions = document.createElement('div');
        actions.className = 'ai-code-actions';

        // Copy button
        const copyBtn = document.createElement('button');
        copyBtn.className = 'ai-code-copy';
        copyBtn.textContent = '📋';
        copyBtn.title = 'Copy code';
        copyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(code);
            copyBtn.textContent = '✓';
            setTimeout(() => copyBtn.textContent = '📋', 1500);
        });
        actions.appendChild(copyBtn);

        // Apply to Editor button (animated typing)
        if (ctx.editor && code.trim().length > 0) {
            const applyBtn = document.createElement('button');
            applyBtn.className = 'ai-code-apply';
            applyBtn.textContent = '⚡ Apply';
            applyBtn.title = 'Apply to editor with animation';
            applyBtn.addEventListener('click', () => {
                animateCodeIntoEditor(code, applyBtn);
            });
            actions.appendChild(applyBtn);

            // Insert at cursor button
            const insertBtn = document.createElement('button');
            insertBtn.className = 'ai-code-insert';
            insertBtn.textContent = '📥 Insert';
            insertBtn.title = 'Insert at cursor position';
            insertBtn.addEventListener('click', () => {
                animateCodeInsert(code, insertBtn);
            });
            actions.appendChild(insertBtn);
        }

        // New File button
        const newFileBtn = document.createElement('button');
        newFileBtn.className = 'ai-code-newfile';
        newFileBtn.textContent = '📄 New File';
        newFileBtn.title = 'Save as a new file in project';
        newFileBtn.addEventListener('click', () => {
            saveAICodeAsFile(code);
        });
        actions.appendChild(newFileBtn);

        pre.appendChild(actions);
    });
}

// ── Animated Code Application ──

async function animateCodeIntoEditor(code: string, btn: HTMLElement) {
    if (!ctx.editor) return;
    const originalText = btn.textContent;
    btn.textContent = '⏳ Applying...';
    btn.classList.add('applying');

    const model = ctx.editor.getModel();
    if (!model) return;

    // Flash the editor to indicate incoming change
    const editorEl = document.querySelector('.monaco-editor') as HTMLElement;
    if (editorEl) {
        editorEl.style.transition = 'box-shadow 0.3s';
        editorEl.style.boxShadow = 'inset 0 0 40px rgba(78,201,176,0.15)';
    }

    // Select all current content with a sweep animation
    const lineCount = model.getLineCount();
    ctx.editor.setSelection({ startLineNumber: 1, startColumn: 1, endLineNumber: lineCount, endColumn: model.getLineMaxColumn(lineCount) });

    await sleep(300);

    // Type it in chunks for visual effect
    const lines = code.split('\n');
    const chunkSize = Math.max(1, Math.ceil(lines.length / 30)); // ~30 visual steps
    let currentLine = 0;

    ctx.editor.executeEdits('nexia-ai', [{
        range: model.getFullModelRange(),
        text: '',
    }]);

    for (let i = 0; i < lines.length; i += chunkSize) {
        const chunk = lines.slice(i, i + chunkSize).join('\n') + (i + chunkSize < lines.length ? '\n' : '');
        const pos = model.getPositionAt(model.getValueLength());
        ctx.editor.executeEdits('nexia-ai', [{
            range: { startLineNumber: pos.lineNumber, startColumn: pos.column, endLineNumber: pos.lineNumber, endColumn: pos.column },
            text: chunk,
        }]);

        // Scroll to show the new code being typed
        ctx.editor.revealLine(model.getLineCount());

        // Highlight the just-typed lines
        const decoration = ctx.editor.deltaDecorations([], lines.slice(i, i + chunkSize).map((_, idx) => ({
            range: { startLineNumber: i + idx + 1, startColumn: 1, endLineNumber: i + idx + 1, endColumn: 1 },
            options: { isWholeLine: true, className: 'ai-typed-line', glyphMarginClassName: 'ai-typed-glyph' },
        })));

        await sleep(25 + Math.random() * 15);
        ctx.editor.deltaDecorations(decoration, []);
    }

    // Fade out the glow
    if (editorEl) {
        editorEl.style.boxShadow = 'none';
        setTimeout(() => editorEl.style.transition = '', 500);
    }

    btn.textContent = '✓ Applied';
    btn.classList.remove('applying');
    setTimeout(() => btn.textContent = originalText!, 2000);

    // Mark file as modified
    const tab = ctx.openTabs.find(t => t.path === ctx.activeTab);
    if (tab) tab.modified = true;
}

async function animateCodeInsert(code: string, btn: HTMLElement) {
    if (!ctx.editor) return;
    const originalText = btn.textContent;
    btn.textContent = '⏳...';

    const position = ctx.editor.getPosition();
    if (!position) return;
    const model = ctx.editor.getModel();
    if (!model) return;

    // Type it in line-by-line with animation
    const lines = code.split('\n');
    let insertLine = position.lineNumber;

    const editorEl = document.querySelector('.monaco-editor') as HTMLElement;
    if (editorEl) {
        editorEl.style.transition = 'box-shadow 0.3s';
        editorEl.style.boxShadow = 'inset 0 0 30px rgba(78,201,176,0.1)';
    }

    for (let i = 0; i < lines.length; i++) {
        const lineText = lines[i] + (i < lines.length - 1 ? '\n' : '');
        const curModel = ctx.editor.getModel()!;
        const pos = i === 0 ? position : curModel.getPositionAt(curModel.getValueLength());
        const insertAt = i === 0 ? position : { lineNumber: insertLine + i, column: 1 };

        ctx.editor.executeEdits('nexia-ai-insert', [{
            range: { startLineNumber: insertAt.lineNumber, startColumn: insertAt.column,
                     endLineNumber: insertAt.lineNumber, endColumn: insertAt.column },
            text: lineText,
        }]);

        ctx.editor.revealLineInCenter(insertLine + i);

        const deco = ctx.editor.deltaDecorations([], [{
            range: { startLineNumber: insertLine + i, startColumn: 1, endLineNumber: insertLine + i, endColumn: 1 },
            options: { isWholeLine: true, className: 'ai-typed-line' },
        }]);

        await sleep(30 + Math.random() * 20);
        ctx.editor.deltaDecorations(deco, []);
    }

    if (editorEl) {
        editorEl.style.boxShadow = 'none';
    }

    btn.textContent = '✓';
    setTimeout(() => btn.textContent = originalText!, 2000);

    const tab = ctx.openTabs.find(t => t.path === ctx.activeTab);
    if (tab) tab.modified = true;
}

function saveAICodeAsFile(code: string) {
    const filename = prompt('Enter filename:', 'new_file.cpp');
    if (!filename) return;

    if (ctx.currentProject) {
        const nodePath = require('path');
        const nodeFs = require('fs');
        const filePath = nodePath.join(ctx.currentProject.path, 'src', filename);
        try {
            // Ensure directory exists
            const dir = nodePath.dirname(filePath);
            if (!nodeFs.existsSync(dir)) nodeFs.mkdirSync(dir, { recursive: true });
            nodeFs.writeFileSync(filePath, code, 'utf-8');
            // Open the newly created file
            ctx.ipc.send('open-file', filePath);
            addAIMessage('system', `✅ Created file: src/${filename}`);
        } catch (err: any) {
            addAIMessage('system', `❌ Failed to create file: ${err.message}`);
        }
    } else {
        addAIMessage('system', '⚠ No project open. Open a project first to save files.');
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Add a message to the conversation.
 *
 * `hidden` records the message in history — so the model still sees it — without
 * drawing it in the transcript. Used for the proactive tutor prompts, which are
 * instructions to the model ("[SYSTEM: The learner is returning after 3 days
 * away...]") and were being rendered verbatim as though the user had typed them.
 */
function addAIMessage(role: 'user' | 'assistant' | 'system', content: string, hidden = false) {
    const msg: AIMessage = { role, content, timestamp: Date.now(), id: nextAIMsgId(), hidden };
    aiMessages.push(msg);
    if (!hidden) renderAIMessage(msg);
}

function addMessageActionButtons(el: HTMLElement, msg: AIMessage) {
    const actions = document.createElement('div');
    actions.className = 'ai-msg-actions';
    actions.innerHTML = `<button class="ai-msg-action-btn" data-action="copy" title="Copy response">📋</button><button class="ai-msg-action-btn" data-action="edit" title="Edit response">✏️</button><button class="ai-msg-action-btn" data-action="retry" title="Retry">🔄</button>`;

    actions.querySelector('[data-action="copy"]')!.addEventListener('click', () => {
        navigator.clipboard.writeText(msg.content);
        const btn = actions.querySelector('[data-action="copy"]')!;
        btn.textContent = '✓';
        setTimeout(() => btn.textContent = '📋', 1500);
    });

    actions.querySelector('[data-action="edit"]')!.addEventListener('click', () => {
        const bodyEl = el.querySelector('.ai-msg-body') as HTMLElement;
        if (bodyEl.contentEditable === 'true') {
            bodyEl.contentEditable = 'false';
            bodyEl.classList.remove('ai-msg-editing');
            msg.content = bodyEl.innerText;
            bodyEl.innerHTML = renderMarkdown(msg.content);
            addCopyButtonsToCodeBlocks(bodyEl);
            actions.querySelector('[data-action="edit"]')!.textContent = '✏️';
        } else {
            bodyEl.contentEditable = 'true';
            bodyEl.classList.add('ai-msg-editing');
            bodyEl.innerText = msg.content;
            bodyEl.focus();
            actions.querySelector('[data-action="edit"]')!.textContent = '💾';
        }
    });

    actions.querySelector('[data-action="retry"]')!.addEventListener('click', () => {
        retryAIMessage(msg, el);
    });

    el.appendChild(actions);
}

function renderAIMessage(msg: AIMessage) {
    const container = $('ai-messages');
    const welcome = container.querySelector('.ai-welcome');
    if (welcome) welcome.remove();

    const el = document.createElement('div');
    el.className = 'ai-msg';
    if (msg.id != null) el.dataset.msgId = String(msg.id);
    const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const roleLabel = msg.role === 'user' ? 'You' : msg.role === 'assistant' ? 'Nexia AI' : 'System';

    el.innerHTML = `<div class="ai-msg-header"><span class="ai-msg-role ${msg.role}">${roleLabel}</span><span class="ai-msg-time">${time}</span></div><div class="ai-msg-body"></div>`;

    const body = el.querySelector('.ai-msg-body')!;
    body.innerHTML = renderMarkdown(msg.content);
    addCopyButtonsToCodeBlocks(body as HTMLElement);

    // Action buttons for assistant messages
    if (msg.role === 'assistant') {
        addMessageActionButtons(el, msg);
    }

    container.appendChild(el);
    $('ai-messages').scrollTop = $('ai-messages').scrollHeight;
}

function retryAIMessage(msg: AIMessage, msgEl: HTMLElement) {
    if (aiStreaming) return;

    // Find the user message that preceded this assistant response
    const msgIdx = aiMessages.indexOf(msg);
    if (msgIdx < 0) return;

    // Walk backwards to find the preceding user message
    let userMsg: AIMessage | null = null;
    for (let i = msgIdx - 1; i >= 0; i--) {
        if (aiMessages[i].role === 'user') {
            userMsg = aiMessages[i];
            break;
        }
    }

    if (!userMsg) return;

    // Remove the assistant message from array and DOM
    aiMessages.splice(msgIdx, 1);
    msgEl.remove();

    // Also remove the user message from array and DOM
    const userIdx = aiMessages.indexOf(userMsg);
    if (userIdx >= 0) {
        aiMessages.splice(userIdx, 1);
        // Remove the user message DOM element by its stable stamped id, not by
        // text content — duplicate prompts (e.g. quick-action buttons) would
        // otherwise match and delete the wrong node.
        if (userMsg.id != null) {
            const userEl = $('ai-messages').querySelector(`.ai-msg[data-msg-id="${userMsg.id}"]`);
            if (userEl) userEl.remove();
        }
    }

    // Resend the original user message
    sendAIMessage(userMsg.content);
}

function formatAIContent(text: string): string {
    return renderMarkdown(text);
}

function showAITyping() {
    // Auto-switch to AI panel so user sees the response
    const aiTab = document.querySelector('[data-panel="ai"]') as HTMLElement;
    if (aiTab && !aiTab.classList.contains('active')) aiTab.click();

    const container = $('ai-messages');
    const el = document.createElement('div');
    el.className = 'ai-typing';
    el.id = 'ai-typing-indicator';
    el.innerHTML = '<div class="ai-typing-dots"><span class="ai-typing-dot"></span><span class="ai-typing-dot"></span><span class="ai-typing-dot"></span></div><span class="ai-typing-label">Nexia AI is thinking...</span>';
    container.appendChild(el);
    $('ai-messages').scrollTop = $('ai-messages').scrollHeight;
}

function hideAITyping() {
    const el = document.getElementById('ai-typing-indicator');
    if (el) el.remove();
}

export function clearAIChat() {
    aiMessages = [];
    const container = $('ai-messages');
    container.innerHTML = `<div class="ai-welcome"><div class="ai-welcome-icon">🤖</div><div class="ai-welcome-title">Nexia AI</div><div class="ai-welcome-desc">Your Xbox 360 development assistant. Ask questions about XDK APIs, debug build errors, or generate code.</div><div class="ai-quick-actions"><button class="ai-quick-btn" data-prompt="Explain the Xbox 360 D3D initialization process">📖 D3D Init Guide</button><button class="ai-quick-btn" data-prompt="Show me a basic Xbox 360 input polling loop">🎮 Input Polling</button><button class="ai-quick-btn" data-prompt="How do I set up audio using XAudio2 on Xbox 360?">🔊 Audio Setup</button><button class="ai-quick-btn" data-prompt="What are common Xbox 360 build errors and how to fix them?">🔧 Build Errors</button></div></div>`;
}

// ── AI Error Analysis ──

export async function analyzeAIBuildErrors(errors: any[], warnings: any[]) {
    if (!ctx.userSettings.aiAutoErrors) return;
    if (!ctx.userSettings.aiApiKey && ctx.userSettings.aiProvider !== 'local') return;
    if (errors.length === 0) return;

    const errorsView = $('ai-errors-content');
    const emptyView = $('ai-errors-empty');
    const summary = $('ai-errors-summary');
    const list = $('ai-errors-list');

    emptyView.classList.add('hidden');
    errorsView.classList.remove('hidden');
    summary.innerHTML = `<strong>🔴 ${errors.length} error${errors.length > 1 ? 's' : ''}</strong>${warnings.length ? `, ⚠ ${warnings.length} warning${warnings.length > 1 ? 's' : ''}` : ''} — analyzing...`;
    list.innerHTML = '<div class="ai-typing" style="padding:16px;"><div class="ai-typing-dots"><span class="ai-typing-dot"></span><span class="ai-typing-dot"></span><span class="ai-typing-dot"></span></div><span class="ai-typing-label">Analyzing errors...</span></div>';

    // Update the AI tab badge
    const aiTab = document.querySelector('[data-panel="ai"]');
    if (aiTab) aiTab.setAttribute('data-badge', String(errors.length));

    const errorText = errors.map(e => `${e.file || '?'}:${e.line || '?'}: ${e.message}`).join('\n');
    const warningText = warnings.map(w => `${w.file || '?'}:${w.line || '?'}: ${w.message}`).join('\n');

    // Get current file content for context
    let codeContext = '';
    if (ctx.editor && errors[0]?.file) {
        const code = ctx.editor.getValue();
        if (code.length < 6000) codeContext = `\nCurrent file content:\n\`\`\`cpp\n${code}\n\`\`\``;
    }

    const prompt = `Analyze these Xbox 360 build errors and provide a fix for each one. Be concise.
${codeContext}

ERRORS:
${errorText}
${warningText ? '\nWARNINGS:\n' + warningText : ''}

For each error, respond with:
1. What caused it (one sentence)
2. How to fix it (specific code change)`;

    try {
        const reply = await aiComplete([{ role: 'user', content: prompt }]);

        summary.innerHTML = `<strong>🔴 ${errors.length} error${errors.length > 1 ? 's' : ''}</strong>${warnings.length ? `, ⚠ ${warnings.length} warning${warnings.length > 1 ? 's' : ''}` : ''} — AI analysis complete`;
        list.innerHTML = '';

        const analysisEl = document.createElement('div');
        analysisEl.className = 'ai-error-item';
        analysisEl.innerHTML = `<div class="ai-msg-body">${formatAIContent(reply)}</div>`;
        list.appendChild(analysisEl);

    } catch (err: any) {
        summary.innerHTML = `<strong>🔴 ${errors.length} error${errors.length > 1 ? 's' : ''}</strong> — analysis failed`;
        list.innerHTML = `<div class="ai-error-item"><div class="ai-error-item-explanation">❌ Could not analyze: ${err.message}</div></div>`;
    }
}

// ── AI Code Generation ──

async function generateAICode() {
    const prompt = ($('ai-gen-prompt') as HTMLTextAreaElement).value.trim();
    if (!prompt) return;
    if (!ctx.userSettings.aiApiKey && ctx.userSettings.aiProvider !== 'local') {
        alert('No API key configured. Open AI Settings first.');
        return;
    }

    const addComments = ($('ai-gen-comments') as HTMLInputElement).checked;
    const addIncludes = ($('ai-gen-includes') as HTMLInputElement).checked;
    const addErrorHandling = ($('ai-gen-error-handling') as HTMLInputElement).checked;

    const genBtn = $('ai-gen-submit') as HTMLButtonElement;
    genBtn.disabled = true;
    genBtn.textContent = '⏳ Generating...';
    $('ai-gen-result').classList.add('hidden');

    const fullPrompt = `Generate Xbox 360 C++ code for the following request. Return ONLY the code, no explanation.
${addComments ? 'Add clear comments.' : 'Minimal comments.'}
${addIncludes ? 'Include all necessary #include directives.' : 'Do not include #include directives.'}
${addErrorHandling ? 'Add proper error handling (HRESULT checks, null checks).' : 'Skip error handling for brevity.'}

Request: ${prompt}`;

    try {
        let reply = await aiComplete([{ role: 'user', content: fullPrompt }]);

        // Strip markdown code fences if present
        reply = reply.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();

        $('ai-gen-code-text').textContent = reply;
        $('ai-gen-result').classList.remove('hidden');
    } catch (err: any) {
        alert('Generation failed: ' + err.message);
    } finally {
        genBtn.disabled = false;
        genBtn.textContent = '⚡ Generate Code';
    }
}

// ── AI Inline Suggestions ──

let inlineSuggestTimer: any = null;
// Monotonic token so overlapping in-flight completions are ignored — only the
// latest request is allowed to show/insert a suggestion.
let inlineSuggestToken = 0;

export function triggerInlineSuggestion() {
    if (!ctx.userSettings.aiInlineSuggest || !ctx.userSettings.aiApiKey) return;
    if (!ctx.editor) return;

    clearTimeout(inlineSuggestTimer);
    inlineSuggestTimer = setTimeout(async () => {
        const pos = ctx.editor.getPosition();
        if (!pos) return;
        const model = ctx.editor.getModel();
        if (!model) return;

        // Get surrounding code context
        const startLine = Math.max(1, pos.lineNumber - 20);
        const endLine = pos.lineNumber;
        const codeAbove = model.getValueInRange({ startLineNumber: startLine, startColumn: 1, endLineNumber: endLine, endColumn: pos.column });
        const currentLine = model.getLineContent(pos.lineNumber);

        // Only suggest if the line is non-empty and we're at the end
        if (!currentLine.trim() || pos.column < currentLine.length) return;

        // Snapshot the request context so we can detect if the user kept typing
        // (or moved the cursor) while the network call was in flight.
        const reqToken = ++inlineSuggestToken;
        const reqVersionId = model.getVersionId();
        const reqLine = pos.lineNumber;
        const reqColumn = pos.column;

        try {
            let suggestion = await aiComplete([{
                role: 'user',
                content: `Complete the following Xbox 360 C++ code. Return ONLY the completion (the next 1-5 lines), nothing else. No explanation.\n\n${codeAbove}`,
            }]);

            // Bail if a newer request superseded this one.
            if (reqToken !== inlineSuggestToken) return;
            // Bail if the editor/model changed out from under us.
            const curModel = ctx.editor?.getModel();
            if (!curModel || curModel !== model || curModel.getVersionId() !== reqVersionId) return;
            // Bail if the cursor moved from where the suggestion was anchored.
            const curPos = ctx.editor?.getPosition();
            if (!curPos || curPos.lineNumber !== reqLine || curPos.column !== reqColumn) return;

            suggestion = suggestion.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();
            if (!suggestion) return;

            showInlineSuggestion(suggestion, curPos);
        } catch {}
    }, 1500); // 1.5s debounce
}

function showInlineSuggestion(text: string, position: any) {
    const widget = $('ai-inline-widget');
    $('ai-inline-text').textContent = text;
    widget.classList.remove('hidden');

    // Position near cursor
    const editorDom = $('editor-container');
    const rect = editorDom.getBoundingClientRect();
    const coords = ctx.editor.getScrolledVisiblePosition(position);
    if (coords) {
        widget.style.left = Math.min(rect.left + coords.left, window.innerWidth - 520) + 'px';
        widget.style.top = (rect.top + coords.top + 20) + 'px';
    }

    (window as any).__aiInlineSuggestion = text;
}

function acceptInlineSuggestion() {
    const text = (window as any).__aiInlineSuggestion;
    if (!text || !ctx.editor) return;
    const pos = ctx.editor.getPosition();
    if (pos) {
        ctx.editor.executeEdits('ai-inline', [{ range: new (window as any).monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column), text: '\n' + text }]);
    }
    dismissInlineSuggestion();
}

function dismissInlineSuggestion() {
    $('ai-inline-widget').classList.add('hidden');
    (window as any).__aiInlineSuggestion = null;
}

// ── Breadcrumb Bar ──

export function updateBreadcrumb(filePath?: string) {
    const bar = $('breadcrumb-bar');
    const pathEl = $('breadcrumb-path');
    if (!filePath) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');

    const parts = filePath.replace(/\\/g, '/').split('/');
    // Show last 3-4 parts
    const visible = parts.slice(-4);
    pathEl.innerHTML = visible.map((part, i) => {
        const isLast = i === visible.length - 1;
        return `<span class="breadcrumb-item${isLast ? ' active' : ''}">${part}</span>${!isLast ? '<span class="breadcrumb-sep">›</span>' : ''}`;
    }).join('');
}

// ── AI Context Menu for Editor ──

interface CtxItem { label: string; action: () => void; }

export function addAIContextMenuItems(items: CtxItem[]): CtxItem[] {
    if (!ctx.userSettings.aiApiKey && ctx.userSettings.aiProvider !== 'local') return items;

    items.push({ label: '─', action: () => {} });
    items.push({
        label: '🤖 Ask AI about this code',
        action: () => {
            const selection = ctx.editor?.getModel()?.getValueInRange(ctx.editor.getSelection());
            if (selection) {
                switchToAIPanel();
                setAIContext(selection);
                ($('ai-input') as HTMLTextAreaElement).focus();
            } else {
                switchToAIPanel();
                ($('ai-input') as HTMLTextAreaElement).focus();
            }
        },
    });
    items.push({
        label: '⚡ Generate code here',
        action: () => {
            switchToAIPanel();
            switchAIMode('generate');
            ($('ai-gen-prompt') as HTMLTextAreaElement).focus();
        },
    });
    items.push({
        label: '📖 Explain this code',
        action: () => {
            const selection = ctx.editor?.getModel()?.getValueInRange(ctx.editor.getSelection());
            if (selection) {
                switchToAIPanel();
                sendAIMessage('Explain this code in detail:', selection);
            }
        },
    });
    items.push({
        label: '🔧 Fix / improve this code',
        action: () => {
            const selection = ctx.editor?.getModel()?.getValueInRange(ctx.editor.getSelection());
            if (selection) {
                switchToAIPanel();
                sendAIMessage('Fix any bugs and suggest improvements for this code:', selection);
            }
        },
    });
    return items;
}

export function switchToAIPanel() {
    // Click the AI sidebar tab
    const aiTab = document.querySelector('[data-panel="ai"]') as HTMLElement;
    if (aiTab) aiTab.click();
}

export function switchAIMode(mode: string) {
    document.querySelectorAll('.ai-mode-tab').forEach(t => t.classList.toggle('active', t.getAttribute('data-ai-mode') === mode));
    document.querySelectorAll('.ai-view').forEach(v => v.classList.remove('active'));
    const view = document.getElementById(`ai-${mode}-view`);
    if (view) view.classList.add('active');
}

export function setAIContext(code: string) {
    const badge = $('ai-context-badge');
    const text = $('ai-context-text');
    const lines = code.split('\n');
    text.textContent = `📎 ${lines.length} line${lines.length > 1 ? 's' : ''} of code attached`;
    badge.classList.remove('hidden');
    (badge as any).__contextCode = code;
}

// ── AI Settings Dialog ──

export function openAISettings() {
    // AI settings are now in the unified Settings dialog — open it
    const overlay = $('settings-overlay');
    if (overlay) {
        overlay.classList.remove('hidden');
    }
}

function toggleCustomEndpointField() {
    const provider = ($('ai-provider') as HTMLSelectElement).value;
    $('ai-custom-endpoint').classList.toggle('hidden', provider !== 'custom' && provider !== 'local');
}


function saveAISettings() {
    ctx.userSettings.aiProvider = ($('ai-provider') as HTMLSelectElement).value as any;
    ctx.userSettings.aiApiKey = ($('ai-api-key') as HTMLInputElement).value;
    ctx.userSettings.aiEndpoint = ($('ai-endpoint-url') as HTMLInputElement).value;
    ctx.userSettings.aiModel = ($('ai-model') as HTMLInputElement).value.trim();
    ctx.userSettings.aiSystemPrompt = ($('ai-system-prompt') as HTMLTextAreaElement).value;
    ctx.userSettings.aiAutoErrors = ($('ai-auto-errors') as HTMLInputElement).checked;
    ctx.userSettings.aiInlineSuggest = ($('ai-inline-suggest') as HTMLInputElement).checked;
    ctx.userSettings.aiFileContext = ($('ai-file-context') as HTMLInputElement).checked;
    fn.saveUserSettings();
    $('ai-settings-overlay').classList.add('hidden');
    updateAIStatusFromSettings();
}

function updateAIStatusFromSettings() {
    if (ctx.userSettings.aiApiKey || ctx.userSettings.aiProvider === 'local') {
        setAIStatus('connected', 'Ready');
    } else {
        setAIStatus('disconnected', 'No API key configured');
    }
}

async function testAIConnection() {
    const origKey = ctx.userSettings.aiApiKey;
    const origProvider = ctx.userSettings.aiProvider;
    const origEndpoint = ctx.userSettings.aiEndpoint;
    const origModel = ctx.userSettings.aiModel;
    ctx.userSettings.aiApiKey = ($('ai-api-key') as HTMLInputElement).value;
    ctx.userSettings.aiProvider = ($('ai-provider') as HTMLSelectElement).value as any;
    ctx.userSettings.aiEndpoint = ($('ai-endpoint-url') as HTMLInputElement).value;
    ctx.userSettings.aiModel = ($('ai-model') as HTMLInputElement).value.trim();

    const btn = $('ai-test-connection') as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = '⏳ Testing...';

    try {
        await aiComplete([{ role: 'user', content: 'Say "connected" and nothing else.' }]);
        btn.textContent = '✅ Connected!';
    } catch (err: any) {
        btn.textContent = `❌ ${err.message.substring(0, 40)}`;
    }

    ctx.userSettings.aiApiKey = origKey;
    ctx.userSettings.aiProvider = origProvider;
    ctx.userSettings.aiEndpoint = origEndpoint;
    ctx.userSettings.aiModel = origModel;

    setTimeout(() => { btn.disabled = false; btn.textContent = '🔌 Test Connection'; }, 3000);
}

// ── Initialize AI System ──

// ══════════════════════════════════════════════════════════════════════
// AI HINT BAR — Selection-triggered inline actions
// ══════════════════════════════════════════════════════════════════════

let hintBarDebounce: any = null;
let hintBarSelection: { text: string; range: any } | null = null;
let hintResultData: { action: string; code: string; result: string } | null = null;

export function initAIHintBar() {
    if (!ctx.editor) return;

    // Listen for selection changes in Monaco
    ctx.editor.onDidChangeCursorSelection((e: any) => {
        clearTimeout(hintBarDebounce);
        const selection = e.selection;
        const model = ctx.editor.getModel();
        if (!model) return;

        const text = model.getValueInRange(selection).trim();
        if (!text || text.length < 3 || selection.startLineNumber === selection.endLineNumber && selection.startColumn === selection.endColumn) {
            hideHintBar();
            return;
        }

        // Debounce — show after 400ms of stable selection
        hintBarDebounce = setTimeout(() => {
            hintBarSelection = { text, range: selection };
            showHintBar(selection);
        }, 400);
    });

    // Hint bar button clicks
    $('ai-hint-bar').addEventListener('click', (e: MouseEvent) => {
        const btn = (e.target as HTMLElement).closest('.ai-hint-btn') as HTMLElement;
        if (!btn || !hintBarSelection) return;
        const action = btn.getAttribute('data-action');
        if (action) executeHintAction(action, hintBarSelection.text, hintBarSelection.range);
    });

    // Result panel buttons
    $('ai-hint-result-close').addEventListener('click', hideHintResult);
    $('ai-hint-reject').addEventListener('click', hideHintResult);
    $('ai-hint-apply').addEventListener('click', applyHintResult);
    $('ai-hint-copy').addEventListener('click', () => {
        if (hintResultData) {
            navigator.clipboard.writeText(hintResultData.result);
            ($('ai-hint-copy') as HTMLElement).textContent = '✓ Copied';
            setTimeout(() => ($('ai-hint-copy') as HTMLElement).textContent = '📋 Copy', 1500);
        }
    });

    // Hide hint bar when ctx.editor scrolls or loses focus
    ctx.editor.onDidScrollChange(() => { hideHintBar(); hideHintResult(); });
    ctx.editor.onDidBlurEditorText(() => {
        // Small delay so clicking hint bar buttons works
        setTimeout(() => {
            if (!document.querySelector('.ai-hint-bar:hover') && !document.querySelector('.ai-hint-result:hover')) {
                hideHintBar();
            }
        }, 200);
    });
}

function showHintBar(selection: any) {
    if (!ctx.editor) return;
    // Don't show if no API configured
    if (!ctx.userSettings.aiApiKey && ctx.userSettings.aiProvider !== 'local' && ctx.userSettings.aiProvider !== 'custom') return;

    const bar = $('ai-hint-bar');
    const editorDom = $('editor-container');
    const editorRect = editorDom.getBoundingClientRect();

    // Get position of the start of the selection
    const coords = ctx.editor.getScrolledVisiblePosition({ lineNumber: selection.startLineNumber, column: selection.startColumn });
    if (!coords) { hideHintBar(); return; }

    const x = editorRect.left + coords.left;
    const y = editorRect.top + coords.top - 36; // 36px above selection

    // Keep on screen
    bar.classList.remove('hidden');
    const barWidth = bar.offsetWidth || 250;
    bar.style.left = Math.max(editorRect.left, Math.min(x, window.innerWidth - barWidth - 8)) + 'px';
    bar.style.top = Math.max(editorRect.top, y) + 'px';
}

function hideHintBar() {
    $('ai-hint-bar').classList.add('hidden');
}

function hideHintResult() {
    $('ai-hint-result').classList.add('hidden');
    hintResultData = null;
}

function showHintResult(x: number, y: number) {
    const panel = $('ai-hint-result');
    panel.classList.remove('hidden');
    const pw = 520;
    const ph = panel.offsetHeight || 200;
    panel.style.left = Math.max(8, Math.min(x, window.innerWidth - pw - 8)) + 'px';
    panel.style.top = Math.max(8, Math.min(y, window.innerHeight - ph - 8)) + 'px';
}

function setHintResultLoading(action: string) {
    const titles: Record<string, string> = {
        explain: '📖 Explaining...',
        fix: '🔧 Auto Fixing...',
        refactor: '⚡ Refactoring...',
    };
    $('ai-hint-result-title').textContent = titles[action] || '🤖 Nexia AI';
    $('ai-hint-result-status').textContent = '';
    $('ai-hint-result-body').innerHTML = '<div class="ai-hint-loading"><div class="ai-hint-loading-dots"><span class="ai-hint-loading-dot"></span><span class="ai-hint-loading-dot"></span><span class="ai-hint-loading-dot"></span></div><span class="ai-hint-loading-label">Thinking...</span></div>';
    $('ai-hint-result-actions').classList.add('hidden');
}

async function executeHintAction(action: string, code: string, range: any) {
    hideHintBar();

    // Position result panel near the selection
    const editorDom = $('editor-container');
    const editorRect = editorDom.getBoundingClientRect();
    const coords = ctx.editor.getScrolledVisiblePosition({ lineNumber: range.endLineNumber, column: 1 });
    const rx = editorRect.left + (coords?.left || 100);
    const ry = editorRect.top + (coords?.top || 100) + 24;

    showHintResult(rx, ry);
    setHintResultLoading(action);

    const prompts: Record<string, string> = {
        explain: `Explain the following code. Describe what it does, its purpose, and any notable patterns or potential issues. Be concise but thorough.

\`\`\`cpp
${code}
\`\`\``,

        fix: `You are a code repair tool. Analyze the following code for bugs, errors, and issues, then provide the FIXED version.

IMPORTANT: Respond using EXACTLY this format:
<tool>fix_code</tool>
<search>
(the exact original code or pattern to find)
</search>
<replace>
(the corrected code to replace it with)
</replace>
<explanation>
(brief explanation of what was fixed and why)
</explanation>

If there are multiple fixes needed, repeat the tool block for each one.
If no issues are found, say "No issues found" and explain why the code is correct.

\`\`\`cpp
${code}
\`\`\``,

        refactor: `You are a code refactoring tool. Improve the following code for readability, performance, or best practices while preserving its functionality.

IMPORTANT: Respond using EXACTLY this format:
<tool>refactor_code</tool>
<mode>replace</mode>
<code>
(the complete refactored code that replaces the selection)
</code>
<explanation>
(brief explanation of what was changed and why)
</explanation>

\`\`\`cpp
${code}
\`\`\``,
    };

    try {
        const reply = await aiComplete([{ role: 'user', content: prompts[action] }]);

        const titleLabels: Record<string, string> = {
            explain: '📖 Explanation',
            fix: '🔧 Auto Fix',
            refactor: '⚡ Refactored',
        };
        $('ai-hint-result-title').textContent = titleLabels[action] || '🤖 Nexia AI';

        if (action === 'explain') {
            // Explain — just render markdown, no apply button
            $('ai-hint-result-body').innerHTML = renderMarkdown(reply);
            addCopyButtonsToCodeBlocks($('ai-hint-result-body'));
            $('ai-hint-result-actions').classList.add('hidden');
            hintResultData = { action, code, result: reply };
            $('ai-hint-result-status').textContent = '';
            // Show copy only
            $('ai-hint-result-actions').classList.remove('hidden');
            ($('ai-hint-apply') as HTMLElement).style.display = 'none';
            ($('ai-hint-reject') as HTMLElement).style.display = 'none';

        } else if (action === 'fix') {
            // Parse fix_code tool calls
            const fixes = parseFixToolCalls(reply);
            if (fixes.length > 0) {
                renderFixResult(fixes, code);
                hintResultData = { action, code, result: JSON.stringify(fixes) };
            } else {
                // No structured tool call — show as markdown
                $('ai-hint-result-body').innerHTML = renderMarkdown(reply);
                addCopyButtonsToCodeBlocks($('ai-hint-result-body'));
                $('ai-hint-result-actions').classList.add('hidden');
                hintResultData = { action, code, result: reply };
            }

        } else if (action === 'refactor') {
            // Parse refactor_code tool call
            const refactored = parseRefactorToolCall(reply);
            if (refactored) {
                renderRefactorResult(code, refactored.code, refactored.explanation);
                hintResultData = { action, code, result: refactored.code };
            } else {
                $('ai-hint-result-body').innerHTML = renderMarkdown(reply);
                addCopyButtonsToCodeBlocks($('ai-hint-result-body'));
                $('ai-hint-result-actions').classList.add('hidden');
                hintResultData = { action, code, result: reply };
            }
        }

    } catch (err: any) {
        $('ai-hint-result-title').textContent = '❌ Error';
        $('ai-hint-result-body').innerHTML = `<p style="color:var(--red)">${err.message}</p>`;
        $('ai-hint-result-actions').classList.add('hidden');
    }
}

// ── Tool call parsers ──

interface FixCall { search: string; replace: string; explanation: string; }

function parseFixToolCalls(text: string): FixCall[] {
    const fixes: FixCall[] = [];
    // Match <tool>fix_code</tool> blocks
    const toolRegex = /<tool>\s*fix_code\s*<\/tool>\s*<search>\s*([\s\S]*?)\s*<\/search>\s*<replace>\s*([\s\S]*?)\s*<\/replace>(?:\s*<explanation>\s*([\s\S]*?)\s*<\/explanation>)?/gi;
    let match;
    while ((match = toolRegex.exec(text)) !== null) {
        fixes.push({
            search: match[1].trim(),
            replace: match[2].trim(),
            explanation: (match[3] || '').trim(),
        });
    }
    return fixes;
}

interface RefactorResult { code: string; explanation: string; mode: string; }

function parseRefactorToolCall(text: string): RefactorResult | null {
    const regex = /<tool>\s*refactor_code\s*<\/tool>\s*(?:<mode>\s*([\s\S]*?)\s*<\/mode>\s*)?<code>\s*([\s\S]*?)\s*<\/code>(?:\s*<explanation>\s*([\s\S]*?)\s*<\/explanation>)?/i;
    const match = regex.exec(text);
    if (!match) return null;
    return {
        mode: (match[1] || 'replace').trim(),
        code: match[2].trim(),
        explanation: (match[3] || '').trim(),
    };
}

// ── Result renderers ──

function renderFixResult(fixes: FixCall[], originalCode: string) {
    const body = $('ai-hint-result-body');
    let html = `<p style="margin-bottom:8px;color:var(--text-dim);font-size:11px;">${fixes.length} fix${fixes.length > 1 ? 'es' : ''} found:</p>`;

    for (let i = 0; i < fixes.length; i++) {
        const fix = fixes[i];
        html += `<div style="margin-bottom:10px;">`;
        if (fix.explanation) {
            html += `<p style="font-size:11px;color:var(--text);margin:0 0 4px;"><strong>#${i + 1}:</strong> ${fix.explanation}</p>`;
        }
        html += `<div class="ai-hint-diff-remove"><pre>${escapeHtml(fix.search)}</pre></div>`;
        html += `<div class="ai-hint-diff-add"><pre>${escapeHtml(fix.replace)}</pre></div>`;
        html += `</div>`;
    }

    body.innerHTML = html;
    $('ai-hint-result-status').textContent = `${fixes.length} change${fixes.length > 1 ? 's' : ''}`;

    // Show apply/reject
    const actions = $('ai-hint-result-actions');
    actions.classList.remove('hidden');
    ($('ai-hint-apply') as HTMLElement).style.display = '';
    ($('ai-hint-reject') as HTMLElement).style.display = '';
}

function renderRefactorResult(original: string, refactored: string, explanation: string) {
    const body = $('ai-hint-result-body');
    let html = '';
    if (explanation) {
        html += `<p style="font-size:11px;color:var(--text);margin:0 0 8px;">${explanation}</p>`;
    }
    html += `<div class="ai-hint-diff-remove"><pre>${escapeHtml(original)}</pre></div>`;
    html += `<div class="ai-hint-diff-add"><pre>${escapeHtml(refactored)}</pre></div>`;
    body.innerHTML = html;
    $('ai-hint-result-status').textContent = 'Refactored';

    const actions = $('ai-hint-result-actions');
    actions.classList.remove('hidden');
    ($('ai-hint-apply') as HTMLElement).style.display = '';
    ($('ai-hint-reject') as HTMLElement).style.display = '';
}

// ── Apply changes to ctx.editor ──

function applyHintResult() {
    if (!hintResultData || !ctx.editor || !hintBarSelection) return;
    const model = ctx.editor.getModel();
    if (!model) return;

    const { action, code, result } = hintResultData;
    const range = hintBarSelection.range;

    if (action === 'fix') {
        // Apply fix_code tool calls — search/replace within the selection
        const fixes: FixCall[] = JSON.parse(result);
        let currentText = model.getValueInRange(range);

        for (const fix of fixes) {
            // Try exact string match first
            if (currentText.includes(fix.search)) {
                currentText = currentText.replace(fix.search, fix.replace);
            } else {
                // Try regex match
                try {
                    const regex = new RegExp(fix.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
                    currentText = currentText.replace(regex, fix.replace);
                } catch {
                    // If regex fails, try line-by-line fuzzy match
                    currentText = currentText.replace(fix.search.trim(), fix.replace.trim());
                }
            }
        }

        // Apply the edit
        const monaco = (window as any).monaco;
        ctx.editor.executeEdits('ai-hint-fix', [{
            range: new monaco.Range(range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn),
            text: currentText,
        }]);

    } else if (action === 'refactor') {
        // Replace entire selection with refactored code
        const monaco = (window as any).monaco;
        ctx.editor.executeEdits('ai-hint-refactor', [{
            range: new monaco.Range(range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn),
            text: result,
        }]);
    }

    hideHintResult();
    // Mark file as modified
    if (ctx.activeTab) {
        const tab = ctx.openTabs.find(t => t.path === ctx.activeTab);
        if (tab && !tab.modified) { tab.modified = true; fn.renderTabs(); }
    }
}

// ── Proactive Tutor Messages ──
//
// These prompts are instructions to the model, not something the learner typed,
// so every one of them is sent hidden. They used to be rendered verbatim in the
// chat — the learner saw "[SYSTEM: The learner is returning after 3 days away...]"
// appear as if from their own account, which exposed the scaffolding and made
// the tutor look like it was talking to itself.

/**
 * Called when a lesson is completed. The AI congratulates and summarizes.
 */
export function tutorOnLessonComplete(lessonTitle: string, concepts: string[]): void {
    const conceptList = concepts.length > 0 ? concepts.join(', ') : 'general concepts';
    sendAIMessage(
        `[SYSTEM: The learner just completed the lesson "${lessonTitle}" covering ${conceptList}. ` +
        `Briefly congratulate them (1-2 sentences), summarize the key takeaway, and suggest what to try next. Keep it encouraging and concise.]`,
        undefined, true
    );
}

/**
 * Called when a quiz is failed. The AI offers targeted help.
 */
export function tutorOnQuizFail(topic: string, question: string): void {
    sendAIMessage(
        `[SYSTEM: The learner just got a quiz question wrong about "${topic}". The question was: "${question}". ` +
        `Give a brief, friendly explanation of the concept (2-3 sentences). Don't make them feel bad. ` +
        `Use a [VIZ:...] tag if a visualization would help.]`,
        undefined, true
    );
}

/**
 * Called when the user returns after a long break (>24h).
 */
export function tutorOnSessionReturn(lastTopic: string, daysSince: number): void {
    sendAIMessage(
        `[SYSTEM: The learner is returning after ${daysSince} days away. Their last topic was "${lastTopic}". ` +
        `Welcome them back briefly (1 sentence), remind them where they left off, and offer to do a quick review. Keep it warm and concise.]`,
        undefined, true
    );
}

/**
 * Called after a build error when the learner might need help.
 */
export function tutorOnBuildError(errors: string[]): void {
    const errorSummary = errors.slice(0, 3).join('\n');
    sendAIMessage(
        `[SYSTEM: The learner's build just failed with these errors:\n${errorSummary}\n` +
        `Explain the most likely cause in simple terms (2-3 sentences) and show how to fix it. ` +
        `Adapt your explanation to their mastery level as shown in the tutor context.]`,
        undefined, true
    );
}

export function initAI() {
    // Mode tabs
    document.querySelectorAll('.ai-mode-tab').forEach(tab => {
        tab.addEventListener('click', () => switchAIMode(tab.getAttribute('data-ai-mode') || 'chat'));
    });

    // Chat input
    const input = $('ai-input') as HTMLTextAreaElement;
    input.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            const contextBadge = $('ai-context-badge');
            const contextCode = (contextBadge as any).__contextCode || undefined;
            sendAIMessage(input.value, contextCode);
            input.value = '';
            input.style.height = 'auto';
            // Clear context
            contextBadge.classList.add('hidden');
            (contextBadge as any).__contextCode = null;
        }
    });
    // Auto-resize textarea
    input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });

    // Send button
    $('ai-send').addEventListener('click', () => {
        if (aiStreaming && aiAbortStream) {
            // Stop streaming
            aiAbortStream();
            aiAbortStream = null;
            aiStreaming = false;
            ($('ai-send') as HTMLButtonElement).disabled = false;
    $('ai-send').textContent = '↑';
            $('ai-send').textContent = '↑';
            setAIStatus('connected', 'Stopped');
            // Remove streaming badge from current message
            const streamingMsg = document.querySelector('.ai-msg-streaming');
            if (streamingMsg) {
                streamingMsg.classList.remove('ai-msg-streaming');
                const badge = streamingMsg.querySelector('.ai-msg-streaming-badge');
                if (badge) badge.remove();
            }
            return;
        }
        const contextCode = ($('ai-context-badge') as any).__contextCode || undefined;
        sendAIMessage(input.value, contextCode);
        input.value = '';
        input.style.height = 'auto';
        $('ai-context-badge').classList.add('hidden');
    });

    // Clear button
    $('ai-clear').addEventListener('click', clearAIChat);

    // Quick action buttons
    document.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest('.ai-quick-btn');
        if (btn) {
            const prompt = btn.getAttribute('data-prompt');
            if (prompt) sendAIMessage(prompt);
        }
    });

    // Settings button (opens unified settings panel — wired in app.ts)
    $('ai-settings-btn').addEventListener('click', openAISettings);

    // Context clear
    $('ai-context-clear').addEventListener('click', () => {
        $('ai-context-badge').classList.add('hidden');
        ($('ai-context-badge') as any).__contextCode = null;
    });

    // Generate mode
    $('ai-gen-submit').addEventListener('click', generateAICode);
    $('ai-gen-copy').addEventListener('click', () => {
        navigator.clipboard.writeText($('ai-gen-code-text').textContent || '');
        ($('ai-gen-copy') as HTMLElement).textContent = '✓ Copied';
        setTimeout(() => ($('ai-gen-copy') as HTMLElement).textContent = '📋 Copy', 1500);
    });
    $('ai-gen-insert').addEventListener('click', () => {
        const code = $('ai-gen-code-text').textContent || '';
        if (ctx.editor && code) {
            const pos = ctx.editor.getPosition();
            if (pos) {
                ctx.editor.executeEdits('ai-gen', [{ range: new (window as any).monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column), text: code }]);
            }
        }
    });
    $('ai-gen-newfile').addEventListener('click', () => {
        const code = $('ai-gen-code-text').textContent || '';
        // Trigger new file dialog, user can paste
        navigator.clipboard.writeText(code);
        fn.appendOutput('Generated code copied to clipboard. Create a new file and paste.\n');
    });

    // Inline suggestion handlers
    $('ai-inline-accept').addEventListener('click', acceptInlineSuggestion);
    $('ai-inline-dismiss').addEventListener('click', dismissInlineSuggestion);

    // Keyboard shortcut: Ctrl+Shift+A to focus AI
    document.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.ctrlKey && e.shiftKey && e.key === 'A') {
            e.preventDefault();
            switchToAIPanel();
            ($('ai-input') as HTMLTextAreaElement).focus();
        }
        // Esc to dismiss inline suggestion
        if (e.key === 'Escape') dismissInlineSuggestion();
        // Tab to accept inline suggestion
        if (e.key === 'Tab' && (window as any).__aiInlineSuggestion) {
            e.preventDefault();
            acceptInlineSuggestion();
        }
    });

    updateAIStatusFromSettings();

    // Initialize hint bar after ctx.editor is ready
    monacoReady.then(() => initAIHintBar());
}

/**
 * genesisEngine.ts — Self-Evolving AI Lesson Engine
 *
 * Ported from Genesis/index.html (~400 lines of inline JS)
 *
 * The core idea: start with a seed HTML lesson (Generation 0), then use AI
 * to critique it and rewrite it into a better version. Each generation is
 * both more visually polished AND more pedagogically effective. The user can
 * step through the timeline of generations, auto-evolve a full curriculum,
 * or steer the evolution with directives like "more diagrams" or "retro style".
 *
 * How it works:
 * 1. SEED — Generation 0 is a hand-crafted HTML/CSS lesson (Hello World)
 * 2. CRITIQUE — AI analyzes the current lesson's design + teaching quality
 * 3. EVOLVE — AI rewrites the entire page based on the critique
 * 4. STORE — New HTML + critique saved to the generations array
 * 5. RENDER — New lesson displayed in a sandboxed container (shadow DOM)
 * 6. REPEAT — Each generation builds on the last
 *
 * Key adaptation from the original Genesis:
 * - Original used an Express server proxy (/api/ai) for AI calls
 * - In Electron, we don't need a proxy — we accept an AI function as a dependency
 * - The engine calls `this.aiFunction(prompt, maxTokens)` which maps to
 *   OldIDE's existing aiComplete() via a wrapper set up in app.ts
 *
 * This module has NO dependencies on DOM, Monaco, or specific AI providers.
 * It's pure logic — the UI integration happens in app.ts.
 */

// ── Types ──

/**
 * A single generation in the evolution timeline.
 * Each generation is a complete, self-contained HTML lesson.
 */
export interface Generation {
    /** The full HTML/CSS content of this generation's lesson. */
    html: string;
    /** The AI's critique of the previous generation that led to this one. Null for Gen 0. */
    feedback: string | null;
}

/**
 * Callback for logging evolution progress.
 * The UI can subscribe to this to show a live log.
 */
export type LogCallback = (message: string) => void;

/**
 * The AI function signature the engine uses.
 * Takes a prompt string and max_tokens, returns the AI's text response.
 * This is a dependency injection point — app.ts provides the actual implementation.
 */
export type AIFunction = (prompt: string, maxTokens: number) => Promise<string>;

// ── Constants ──

/**
 * Topic labels for each generation number.
 * Used in the timeline UI to label what each generation covers.
 * After index 23, generations are labeled "Advanced".
 */
export const TOPICS: string[] = [
    'Intro', 'Hello World', 'Structure', 'Variables', 'Types', 'I/O',
    'Operators', 'If/Else', 'Logic', 'For Loops', 'While', 'Nesting',
    'Functions', 'Params', 'Scope', 'Arrays', 'Vectors', 'Iteration',
    'Pointers', 'References', 'Memory', 'Classes', 'Objects', 'OOP',
];

/**
 * The system prompt that tells the AI how to evolve lessons.
 * Contains content rules (progressive C++ topics), design rules (pure HTML/CSS,
 * no JS, Google Fonts, animations), and topic progression guidelines.
 *
 * The placeholder "NUMBER" is replaced with the actual generation number at runtime.
 */
const EVOLUTION_SYSTEM_PROMPT = `You are Genesis, a self-evolving UI organism. Your purpose is to be the world's most beautiful and effective visual C++ tutorial for absolute beginners.

You receive your current HTML form and a critique, and must produce a BETTER version of yourself — both more visually stunning AND more pedagogically effective.

CONTENT RULES:
- You are teaching C++ to someone who has NEVER programmed before.
- Cover concepts progressively. Early generations: what is code, hello world, variables, types. Later: control flow, functions, arrays, pointers, classes.
- Use VISUAL METAPHORS — boxes for variables, flow arrows for control flow, color-coded syntax.
- Include real, correct C++ code examples with syntax highlighting via inline styles.
- Add helpful annotations, callouts, and "why this matters" explanations.
- Use analogies to real life (variables = labeled boxes, functions = recipes, etc).
- Generation NUMBER should cover topics appropriate for lesson NUMBER of a beginner course.

DESIGN RULES:
- Output ONLY raw HTML/CSS (inline styles + <style> tags). No markdown, no code fences, no explanation text outside the HTML.
- The root must be a single <div> with min-height:100% and overflow-y:auto for scrollable content.
- Import Google Fonts via @import in <style> tags. Use distinctive, readable fonts.
- Use beautiful syntax-highlighted code blocks with a dark code theme.
- Create visual diagrams using pure CSS (colored boxes, arrows, flow charts) to illustrate concepts.
- Add CSS animations (@keyframes) for reveals, highlights, and attention-drawing.
- Show the generation number visually.
- NEVER use JavaScript. Pure HTML + CSS only.
- Each generation should be noticeably more sophisticated in BOTH design AND teaching quality.
- Make it feel premium, polished, like a $200 course — not a boring textbook.

TOPIC PROGRESSION:
- Gen 0-2: What is programming, Hello World, basic structure of a C++ program
- Gen 3-5: Variables, data types (int, float, string, bool), input/output
- Gen 6-8: Operators, if/else, comparisons, boolean logic
- Gen 9-11: Loops (for, while), loop patterns, nested loops
- Gen 12-14: Functions, parameters, return values, scope
- Gen 15-17: Arrays, vectors, iterating collections
- Gen 18-20: Pointers, references, memory basics
- Gen 21+: Classes, objects, OOP fundamentals

You are generation NUMBER. Teach the appropriate topic AND make it gorgeous.`;

/**
 * The seed HTML for Generation 0.
 * This is a hand-crafted "Hello World" lesson with CSS animations and
 * syntax-highlighted code. The AI evolves from here.
 */
const INITIAL_GENOME = `
<style>
  @import url('https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;600&family=Space+Grotesk:wght@400;600;700&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  @keyframes fadeIn { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
  @keyframes blink { 0%,100% { opacity:1; } 50% { opacity:0; } }
</style>
<div style="min-height:100%;background:linear-gradient(170deg,#0d1117 0%,#161b22 50%,#0d1117 100%);font-family:'Space Grotesk',sans-serif;color:#c9d1d9;padding:48px 40px;overflow-y:auto;">
  <div style="max-width:720px;margin:0 auto;">
    <div style="animation:fadeIn 0.6s ease;">
      <div style="display:inline-block;background:#1f6feb;color:#fff;font-size:11px;font-weight:600;padding:4px 12px;border-radius:20px;letter-spacing:0.1em;margin-bottom:16px;">GENERATION 0</div>
      <h1 style="font-size:2.4rem;font-weight:700;color:#f0f6fc;line-height:1.2;margin-bottom:8px;">Learn C++</h1>
      <p style="font-size:1.05rem;color:#8b949e;margin-bottom:32px;">Your first steps into one of the most powerful programming languages ever created.</p>
    </div>
    <div style="animation:fadeIn 0.6s ease 0.2s both;">
      <h2 style="font-size:1.1rem;color:#58a6ff;margin-bottom:12px;">What is C++?</h2>
      <p style="line-height:1.8;color:#8b949e;margin-bottom:24px;">C++ is a general-purpose programming language created by Bjarne Stroustrup in 1979. It gives you direct control over hardware and memory, which makes it perfect for games, operating systems, and high-performance applications.</p>
    </div>
    <div style="animation:fadeIn 0.6s ease 0.4s both;">
      <h2 style="font-size:1.1rem;color:#58a6ff;margin-bottom:12px;">Your First Program</h2>
      <div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:20px;font-family:'Fira Code',monospace;font-size:13px;line-height:1.8;margin-bottom:12px;">
        <div><span style="color:#ff7b72;">#include</span> <span style="color:#a5d6ff;">&lt;iostream&gt;</span></div>
        <div style="margin-top:8px;"><span style="color:#ff7b72;">int</span> <span style="color:#d2a8ff;">main</span><span style="color:#8b949e;">()</span> <span style="color:#8b949e;">{</span></div>
        <div style="padding-left:24px;"><span style="color:#79c0ff;">std::cout</span> <span style="color:#ff7b72;">&lt;&lt;</span> <span style="color:#a5d6ff;">"Hello, World!"</span><span style="color:#8b949e;">;</span></div>
        <div style="padding-left:24px;"><span style="color:#ff7b72;">return</span> <span style="color:#79c0ff;">0</span><span style="color:#8b949e;">;</span></div>
        <div><span style="color:#8b949e;">}</span></div>
      </div>
      <p style="font-size:0.85rem;color:#484f58;font-style:italic;">This is where every C++ journey begins.<span style="animation:blink 1s step-end infinite;margin-left:2px;">|</span></p>
    </div>
  </div>
</div>`;

// ── The Engine ──

/**
 * GenesisEngine — the self-evolving lesson generator.
 *
 * Usage from app.ts:
 *   const { genesisEngine } = require('./learning/genesisEngine');
 *
 *   // Wire up the AI function (maps to OldIDE's aiComplete)
 *   genesisEngine.setAIFunction(async (prompt, maxTokens) => {
 *       return await aiComplete([{ role: 'user', content: prompt }]);
 *   });
 *
 *   // Evolve a new lesson
 *   await genesisEngine.evolve();
 *
 *   // Get the current generation's HTML to render
 *   const html = genesisEngine.getCurrentHtml();
 */
export class GenesisEngine {
    /** All generations from Gen 0 to the latest. */
    private generations: Generation[] = [{ html: INITIAL_GENOME, feedback: null }];

    /** Index of the currently viewed generation. */
    private currentGen: number = 0;

    /** Whether an evolution is currently in progress. */
    private evolving: boolean = false;

    /** Whether auto-evolution is running. */
    private autoEvolving: boolean = false;

    /** Timer handle for auto-evolution loop. */
    private autoTimeout: ReturnType<typeof setTimeout> | null = null;

    /**
     * Monotonically-increasing token identifying the current auto-evolve run.
     * Each start/stop bumps it; an autoLoop chain captures the value at launch
     * and bails the moment it no longer matches, so a stop→start cycle while an
     * evolve() is in-flight can never leave two loops running concurrently.
     */
    private autoRunId: number = 0;

    /** The AI function to use for critique and evolution. Set via setAIFunction(). */
    private aiFunction: AIFunction | null = null;

    /** Optional log callback for UI updates. */
    private logCallback: LogCallback | null = null;

    /** User guidance text (e.g., "more diagrams", "retro style"). */
    private guidance: string = '';

    /** Max tokens for the evolution AI call. */
    private maxTokens: number = 4096;

    // ── Configuration ──

    /**
     * Set the AI function the engine will use for critique and evolution.
     * This MUST be called before evolve() — the engine doesn't know how to
     * talk to any AI provider directly.
     */
    setAIFunction(fn: AIFunction): void {
        this.aiFunction = fn;
    }

    /** Set a callback that receives log messages during evolution. */
    setLogCallback(fn: LogCallback): void {
        this.logCallback = fn;
    }

    /** Set user guidance that steers the evolution direction. */
    setGuidance(text: string): void {
        this.guidance = text;
    }

    /** Set max tokens for AI responses. Default 4096. */
    setMaxTokens(tokens: number): void {
        this.maxTokens = tokens;
    }

    // ── State Queries ──

    /** Get the total number of generations. */
    getGenerationCount(): number {
        return this.generations.length;
    }

    /** Get the index of the currently viewed generation. */
    getCurrentGenIndex(): number {
        return this.currentGen;
    }

    /** Get all generations (for timeline rendering). */
    getGenerations(): Generation[] {
        return this.generations;
    }

    /** Get the HTML content of the currently viewed generation. */
    getCurrentHtml(): string {
        return this.generations[this.currentGen]?.html || '';
    }

    /** Get the critique/feedback for the currently viewed generation. */
    getCurrentFeedback(): string | null {
        return this.generations[this.currentGen]?.feedback || null;
    }

    /** Get the topic label for a generation number. */
    getTopicLabel(genIndex: number): string {
        return TOPICS[genIndex] || 'Advanced';
    }

    /** Whether an evolution is currently in progress. */
    isEvolving(): boolean {
        return this.evolving;
    }

    /** Whether auto-evolution is running. */
    isAutoEvolving(): boolean {
        return this.autoEvolving;
    }

    // ── Navigation ──

    /** Navigate to a specific generation by index. */
    goToGeneration(index: number): void {
        if (index >= 0 && index < this.generations.length) {
            this.currentGen = index;
        }
    }

    /** Navigate to the previous generation. */
    previousGeneration(): void {
        if (this.currentGen > 0) {
            this.currentGen--;
        }
    }

    /** Navigate to the next generation. */
    nextGeneration(): void {
        if (this.currentGen < this.generations.length - 1) {
            this.currentGen++;
        }
    }

    // ── Evolution ──

    /**
     * Evolve a new generation.
     *
     * This is the core loop:
     * 1. Take the latest generation's HTML
     * 2. Ask the AI to critique it (design + teaching quality + next topic)
     * 3. Ask the AI to rewrite it based on the critique
     * 4. Store the new generation and navigate to it
     *
     * The AI function must be set via setAIFunction() before calling this.
     * Returns true if evolution succeeded, false if it failed.
     */
    async evolve(): Promise<boolean> {
        if (this.evolving) return false;
        if (!this.aiFunction) {
            this.log('[Genesis] Error: No AI function configured. Call setAIFunction() first.');
            return false;
        }

        // Defensive: never dereference an out-of-range index. If a bad load left
        // the timeline empty, re-seed Gen 0 before evolving.
        if (this.generations.length === 0) {
            this.generations = [{ html: INITIAL_GENOME, feedback: null }];
            this.currentGen = 0;
        }

        this.evolving = true;
        const currentGenome = this.generations[this.generations.length - 1].html;
        const genNumber = this.generations.length;
        const guidanceText = this.guidance.trim()
            ? `\n\nUSER DIRECTIVE: "${this.guidance}" — incorporate this into your evolution while staying on-topic for C++ teaching.`
            : '';

        try {
            // Step 1: Critique the current generation
            this.log(`[Gen ${genNumber}] Analyzing current lesson...`);

            const critiquePrompt = `You are an expert UI designer AND C++ educator. Critique this self-evolving C++ tutorial page. Current HTML:\n\n${currentGenome}\n\nGive a brief (3-4 sentence) critique covering: 1) Visual design quality 2) Teaching effectiveness 3) What topic should come next 4) Specific visual/UX improvements needed.${guidanceText}`;

            const critique = await this.aiFunction(critiquePrompt, 1000);

            this.log(`[Gen ${genNumber}] ${critique.slice(0, 140)}...`);

            // Step 2: Evolve based on the critique
            this.log(`[Gen ${genNumber}] Synthesizing lesson ${genNumber}...`);

            const evolvePrompt = `${EVOLUTION_SYSTEM_PROMPT.replace(/NUMBER/g, String(genNumber))}\n\nCRITIQUE OF CURRENT FORM:\n${critique}${guidanceText}\n\nCURRENT GENOME (Generation ${genNumber - 1}):\n${currentGenome}\n\nNow output Generation ${genNumber}. ONLY raw HTML — no explanation, no markdown fences:`;

            let newGenome = await this.aiFunction(evolvePrompt, this.maxTokens);

            // Clean up — remove markdown fences if the AI wrapped the output
            newGenome = newGenome.replace(/```html?\n?/g, '').replace(/```\n?/g, '').trim();

            if (!newGenome || newGenome.length < 50) {
                throw new Error('Evolution produced invalid genome (too short).');
            }

            // Step 3: Store and navigate
            this.generations.push({ html: newGenome, feedback: critique });
            this.currentGen = this.generations.length - 1;

            this.log(`[Gen ${genNumber}] Lesson ${genNumber} rendered successfully.`);
            this.evolving = false;
            this.save(); // Auto-save after each evolution
            return true;

        } catch (err: any) {
            this.log(`[Gen ${genNumber}] Error: ${err.message}`);
            this.evolving = false;
            return false;
        }
    }

    // ── Auto-Evolution ──

    /**
     * Start auto-evolution — continuously evolves new generations with a
     * 3-second delay between each. Call stopAutoEvolve() to stop.
     */
    startAutoEvolve(): void {
        if (this.autoEvolving) return;
        this.autoEvolving = true;
        // Bump the run token and capture it for this loop chain. Any earlier
        // in-flight loop now holds a stale token and will bail.
        const myRun = ++this.autoRunId;
        this.autoLoop(myRun);
    }

    /** Stop auto-evolution. */
    stopAutoEvolve(): void {
        this.autoEvolving = false;
        // Invalidate any in-flight loop chain so it can't schedule another tick.
        this.autoRunId++;
        if (this.autoTimeout) {
            clearTimeout(this.autoTimeout);
            this.autoTimeout = null;
        }
    }

    /** Toggle auto-evolution on/off. */
    toggleAutoEvolve(): void {
        if (this.autoEvolving) {
            this.stopAutoEvolve();
        } else {
            this.startAutoEvolve();
        }
    }

    /**
     * Internal auto-evolution loop.
     * @param myRun - The run token captured when this loop chain started. If it
     *   ever differs from this.autoRunId, a newer start/stop happened and this
     *   (now stale) chain aborts so only one loop is ever active.
     */
    private async autoLoop(myRun: number): Promise<void> {
        if (!this.autoEvolving || myRun !== this.autoRunId) return;
        await this.evolve();
        // Re-check after the (>3s) AI call — a stop/restart may have happened
        // while evolve() was in-flight.
        if (!this.autoEvolving || myRun !== this.autoRunId) return;
        this.autoTimeout = setTimeout(() => this.autoLoop(myRun), 3000);
    }

    // ── Persistence ──

    /**
     * Save all generations to a JSON file.
     * Default path: ~/.nexia-ide-genesis.json
     */
    save(filePath?: string): boolean {
        try {
            const nodeOs = require('os');
            const nodeFs = require('fs');
            const nodePath = require('path');
            const savePath = filePath || nodePath.join(nodeOs.homedir(), '.nexia-ide-genesis.json');

            const data = {
                version: 1,
                generationCount: this.generations.length,
                currentGen: this.currentGen,
                guidance: this.guidance,
                generations: this.generations,
            };

            nodeFs.writeFileSync(savePath, JSON.stringify(data, null, 2), 'utf-8');
            this.log(`[Genesis] Saved ${this.generations.length} generations to ${savePath}`);
            return true;
        } catch (err: any) {
            this.log(`[Genesis] Save failed: ${err.message}`);
            return false;
        }
    }

    /**
     * Load generations from a JSON file.
     * Default path: ~/.nexia-ide-genesis.json
     */
    load(filePath?: string): boolean {
        try {
            const nodeOs = require('os');
            const nodeFs = require('fs');
            const nodePath = require('path');
            const loadPath = filePath || nodePath.join(nodeOs.homedir(), '.nexia-ide-genesis.json');

            if (!nodeFs.existsSync(loadPath)) return false;

            const raw = nodeFs.readFileSync(loadPath, 'utf-8');
            const data = JSON.parse(raw);

            if (data.version !== 1 || !Array.isArray(data.generations)) return false;

            this.generations = data.generations;

            // Guard against a saved file with an empty generations array: that would
            // leave currentGen = -1 and make the next evolve() deref generations[-1].
            // Re-seed Gen 0 exactly as the constructor does so the engine stays usable.
            if (this.generations.length === 0) {
                this.generations = [{ html: INITIAL_GENOME, feedback: null }];
                this.currentGen = 0;
            } else {
                // Clamp the saved index into the valid [0, length-1] range.
                this.currentGen = Math.min(
                    Math.max(0, data.currentGen || 0),
                    this.generations.length - 1);
            }
            this.guidance = data.guidance || '';

            this.log(`[Genesis] Loaded ${this.generations.length} generations`);
            return true;
        } catch (err: any) {
            this.log(`[Genesis] Load failed: ${err.message}`);
            return false;
        }
    }

    // ── Export ──

    /**
     * Export a single generation as a standalone HTML file.
     * Returns the complete HTML document as a string.
     */
    exportGenerationHtml(genIndex: number): string {
        const html = this.generations[genIndex]?.html || '';
        return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Genesis Lesson ${genIndex}</title></head><body style="margin:0;height:100vh;">${html}</body></html>`;
    }

    /**
     * Export ALL generations as a single combined HTML file.
     * Each lesson is in its own full-height section.
     */
    exportAllHtml(): string {
        let combined = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Genesis — Complete C++ Course</title>';
        combined += '<style>body{margin:0;background:#0d1117;font-family:sans-serif;color:#c9d1d9;} .lesson{min-height:100vh;border-bottom:4px solid #58a6ff;}</style></head><body>';
        this.generations.forEach((g, i) => {
            combined += `<div class="lesson" id="lesson-${i}">${g.html}</div>`;
        });
        combined += '</body></html>';
        return combined;
    }

    // ── Internal ──

    /** Send a message to the log callback. */
    private log(message: string): void {
        if (this.logCallback) {
            this.logCallback(message);
        }
    }
}

// ── Singleton Instance ──

export const genesisEngine = new GenesisEngine();

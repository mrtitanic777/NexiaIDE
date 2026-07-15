/**
 * learningProfile.ts — Adaptive Learning Profile
 *
 * Ported from CodingTeacherOld/LearningProfile.h + .cpp
 *
 * Tracks per-concept mastery, detects learning patterns (visual learner,
 * struggles with pointers, etc.), and recommends what to study next.
 *
 * Persistence: JSON file at ~/.nexia-ide-learning-profile.json
 * The original C++ used a custom key=value .dat format. We use JSON because
 * it's easier to extend and debug, and Node.js has native JSON support.
 *
 * This module is loaded by app.ts via require('./learning/learningProfile').
 * It has NO dependencies on the DOM or Monaco — it's pure data logic.
 */

const nodeFs = require('fs');
const nodePath = require('path');
const nodeOs = require('os');

// ── Enums ──

/**
 * Mastery level for a concept. Ordered from least to most mastery.
 * The numeric values matter — they're stored in the profile JSON and
 * used for comparisons.
 */
export enum MasteryLevel {
    NotStarted = 0,
    Introduced = 1,   // Has seen the concept in a lesson
    Practicing = 2,    // Working on exercises for it
    Developing = 3,    // Getting better, but still makes mistakes
    Proficient = 4,    // Can do it reliably
    Mastered = 5       // Fully understands, rarely makes errors
}

/**
 * Human-readable labels for mastery levels.
 * Used in the UI to show progress.
 */
export const MASTERY_LABELS: Record<MasteryLevel, string> = {
    [MasteryLevel.NotStarted]: 'Not Started',
    [MasteryLevel.Introduced]: 'Introduced',
    [MasteryLevel.Practicing]: 'Practicing',
    [MasteryLevel.Developing]: 'Developing',
    [MasteryLevel.Proficient]: 'Proficient',
    [MasteryLevel.Mastered]: 'Mastered',
};

// ── Data Structures ──

/**
 * A single recorded interaction with a concept.
 * Every time the user does a lesson, exercise, quiz, or AI chat about a concept,
 * we create one of these.
 */
export interface InteractionRecord {
    type: 'lesson' | 'exercise' | 'quiz' | 'chat';
    conceptId: string;
    timestamp: number;        // Date.now() — milliseconds since epoch
    successful: boolean;
    attemptNumber: number;
    timeSpentSeconds: number;
    notes: string;            // Optional context (e.g., "quiz question about for-loop syntax")
}

/**
 * Progress on a specific concept (e.g., "pointers", "for_loop", "classes").
 * This is the core unit of the adaptive system — the profile tracks one of
 * these per concept.
 */
export interface ConceptProgress {
    conceptId: string;
    conceptName: string;
    level: MasteryLevel;
    timesIntroduced: number;     // How many times they've seen this in lessons
    timesPracticed: number;      // How many exercises/quizzes they've done
    successfulAttempts: number;
    failedAttempts: number;
    totalTimeSpentSeconds: number;
    lastInteraction: number;     // Timestamp of most recent interaction
    history: InteractionRecord[];
}

/**
 * Progress on a specific lesson (e.g., "hello_xbox", "variables").
 * Tracks whether the user started it, how far they got, whether they finished.
 */
export interface LessonProgress {
    lessonId: string;
    started: boolean;
    completed: boolean;
    contentItemsCompleted: number;
    totalContentItems: number;
    completionPercentage: number;
    startTime: number;           // Timestamp when they first opened this lesson
    completionTime: number;      // Timestamp when they finished (0 if not done)
    totalTimeSpentSeconds: number;
    attempts: number;            // How many times they've started this lesson
}

/**
 * Detected learning pattern — computed by analyzing all concept progress.
 * This feeds into the AI system prompt so the tutor can adapt its teaching style.
 *
 * Example: if strugglesWithPointers is true, the AI might say:
 * "I notice you've been working on pointers — let me try a visual approach."
 */
export interface LearningPattern {
    prefersVisualLearning: boolean;
    needsMoreRepetition: boolean;
    strugglesWithPointers: boolean;
    strugglesWithSyntax: boolean;
    learnsQuickly: boolean;
    averageSessionMinutes: number;
    strongestArea: string;       // Name of the concept with highest success rate
    weakestArea: string;         // Name of the concept with lowest success rate
    recommendedFocusAreas: string[];
}

// ── Default Concepts ──

/**
 * All tracked concepts for the Xbox 360 C++ curriculum.
 * This list defines what the profile knows how to track.
 * New concepts can be added later — the profile handles unknown concept IDs
 * by creating a new ConceptProgress on the fly.
 */
const DEFAULT_CONCEPTS: Array<{ id: string; name: string }> = [
    { id: 'program_structure', name: 'Program Structure' },
    { id: 'main_function', name: 'Main Function' },
    { id: 'includes', name: 'Include Statements' },
    { id: 'variables', name: 'Variables' },
    { id: 'data_types', name: 'Data Types' },
    { id: 'assignment', name: 'Assignment' },
    { id: 'if_statement', name: 'If Statements' },
    { id: 'conditions', name: 'Conditions' },
    { id: 'comparison_operators', name: 'Comparison Operators' },
    { id: 'for_loop', name: 'For Loops' },
    { id: 'while_loop', name: 'While Loops' },
    { id: 'iteration', name: 'Iteration' },
    { id: 'function_definition', name: 'Function Definitions' },
    { id: 'parameters', name: 'Function Parameters' },
    { id: 'return_values', name: 'Return Values' },
    { id: 'pointers', name: 'Pointers' },
    { id: 'memory_addresses', name: 'Memory Addresses' },
    { id: 'dereferencing', name: 'Dereferencing' },
    { id: 'arrays', name: 'Arrays' },
    { id: 'classes', name: 'Classes' },
    { id: 'objects', name: 'Objects' },
    { id: 'constructors', name: 'Constructors' },
    { id: 'inheritance', name: 'Inheritance' },
    { id: 'memory_management', name: 'Memory Management' },
    { id: 'new_delete', name: 'New and Delete' },
    // Xbox 360 specific concepts
    { id: 'xbox_architecture', name: 'Xbox 360 Architecture' },
    { id: 'd3d_basics', name: 'Direct3D Basics' },
    { id: 'xinput', name: 'XInput Controllers' },
    { id: 'xex_format', name: 'XEX Format' },
    { id: 'game_loop', name: 'Game Loop Pattern' },
];

// ── Profile File Path ──

const PROFILE_FILE = nodePath.join(nodeOs.homedir(), '.nexia-ide-learning-profile.json');

// ── The Profile Class ──

/**
 * LearningProfile — the adaptive learning engine.
 *
 * Usage from app.ts:
 *   const { learningProfile } = require('./learning/learningProfile');
 *   learningProfile.load();
 *   learningProfile.recordInteraction('pointers', 'quiz', false, 45);
 *   const pattern = learningProfile.analyzePatterns();
 *   // pattern.strugglesWithPointers === true
 */
export class LearningProfile {
    /** Learner's display name (optional) */
    learnerName: string = '';

    /** Per-concept progress. Key is concept ID (e.g., "pointers"). */
    conceptProgress: Map<string, ConceptProgress> = new Map();

    /** Per-lesson progress. Key is lesson ID (e.g., "hello_xbox"). */
    lessonProgress: Map<string, LessonProgress> = new Map();

    /** When the current learning session started (Date.now() value, 0 if no active session). */
    private sessionStartTime: number = 0;

    /** Total number of learning sessions. */
    sessionCount: number = 0;

    /** Total time spent learning across all sessions (seconds). */
    private totalLearningTimeSeconds: number = 0;

    constructor() {
        this.initializeConceptMap();
    }

    // ── Initialization ──

    /**
     * Populate the concept map with all known concepts.
     * Each concept starts at MasteryLevel.NotStarted with zeroed counters.
     * Called by the constructor. If the user has existing progress, load() will
     * overwrite these defaults.
     */
    private initializeConceptMap(): void {
        for (const { id, name } of DEFAULT_CONCEPTS) {
            this.conceptProgress.set(id, {
                conceptId: id,
                conceptName: name,
                level: MasteryLevel.NotStarted,
                timesIntroduced: 0,
                timesPracticed: 0,
                successfulAttempts: 0,
                failedAttempts: 0,
                totalTimeSpentSeconds: 0,
                lastInteraction: 0,
                history: [],
            });
        }
    }

    // ── Persistence ──

    /**
     * Load profile from disk.
     * Returns true if a profile was found and loaded, false if starting fresh.
     *
     * The JSON format stores conceptProgress and lessonProgress as objects
     * (not Maps) since JSON doesn't support Map directly.
     */
    load(profilePath?: string): boolean {
        const path = profilePath || PROFILE_FILE;
        try {
            if (!nodeFs.existsSync(path)) return false;

            const raw = nodeFs.readFileSync(path, 'utf-8');
            const data = JSON.parse(raw);

            // Restore scalar fields
            this.learnerName = data.learnerName || '';
            this.sessionCount = data.sessionCount || 0;
            this.totalLearningTimeSeconds = data.totalLearningTimeSeconds || 0;

            // Restore concept progress (JSON object → Map)
            if (data.conceptProgress) {
                for (const [id, cp] of Object.entries(data.conceptProgress)) {
                    const existing = this.conceptProgress.get(id);
                    const loaded = cp as any;
                    // Merge loaded data onto the default (preserves conceptName if missing)
                    this.conceptProgress.set(id, {
                        conceptId: id,
                        conceptName: loaded.conceptName || existing?.conceptName || id,
                        level: loaded.level ?? MasteryLevel.NotStarted,
                        timesIntroduced: loaded.timesIntroduced || 0,
                        timesPracticed: loaded.timesPracticed || 0,
                        successfulAttempts: loaded.successfulAttempts || 0,
                        failedAttempts: loaded.failedAttempts || 0,
                        totalTimeSpentSeconds: loaded.totalTimeSpentSeconds || 0,
                        lastInteraction: loaded.lastInteraction || 0,
                        history: loaded.history || [],
                    });
                }
            }

            // Restore lesson progress (JSON object → Map)
            if (data.lessonProgress) {
                for (const [id, lp] of Object.entries(data.lessonProgress)) {
                    this.lessonProgress.set(id, lp as LessonProgress);
                }
            }

            return true;
        } catch (err) {
            console.error('[LearningProfile] Failed to load:', err);
            return false;
        }
    }

    /**
     * Save profile to disk.
     * Converts Maps to plain objects for JSON serialization.
     * Interaction history is included (it's small — typically <100 records per concept).
     */
    save(profilePath?: string): boolean {
        const path = profilePath || PROFILE_FILE;
        try {
            // Convert Maps to plain objects for JSON
            const conceptObj: Record<string, ConceptProgress> = {};
            for (const [id, cp] of this.conceptProgress) {
                // Only save concepts that have been interacted with (saves space)
                if (cp.level !== MasteryLevel.NotStarted || cp.timesIntroduced > 0) {
                    conceptObj[id] = cp;
                }
            }

            const lessonObj: Record<string, LessonProgress> = {};
            for (const [id, lp] of this.lessonProgress) {
                if (lp.started) {
                    lessonObj[id] = lp;
                }
            }

            const data = {
                learnerName: this.learnerName,
                sessionCount: this.sessionCount,
                totalLearningTimeSeconds: this.totalLearningTimeSeconds,
                conceptProgress: conceptObj,
                lessonProgress: lessonObj,
            };

            nodeFs.writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
            return true;
        } catch (err) {
            console.error('[LearningProfile] Failed to save:', err);
            return false;
        }
    }

    // ── Cloud Sync (snapshot serialize + merge) ──

    /**
     * Serialize the full profile to a plain JSON-safe object for cloud sync.
     * Unlike save() (which trims untouched concepts to save disk), this includes
     * everything needed to reconstruct the profile on another device, plus a
     * `syncVersion` for forward-compat.
     */
    serialize(): any {
        const conceptObj: Record<string, ConceptProgress> = {};
        for (const [id, cp] of this.conceptProgress) {
            if (cp.level !== MasteryLevel.NotStarted || cp.timesIntroduced > 0 || cp.timesPracticed > 0) {
                conceptObj[id] = cp;
            }
        }
        const lessonObj: Record<string, LessonProgress> = {};
        for (const [id, lp] of this.lessonProgress) {
            if (lp.started) lessonObj[id] = lp;
        }
        return {
            syncVersion: 1,
            learnerName: this.learnerName,
            sessionCount: this.sessionCount,
            totalLearningTimeSeconds: this.totalLearningTimeSeconds,
            conceptProgress: conceptObj,
            lessonProgress: lessonObj,
        };
    }

    /**
     * Merge a cloud snapshot into the current in-memory profile.
     *
     * Progress is monotonic (counters only increase, lessons only get more
     * complete), so we take the field-wise MAX rather than last-writer-wins.
     * This makes multi-device sync conflict-free: whichever device did more of
     * a given thing wins that field, and interaction history is unioned.
     *
     * Returns true if anything changed (so the caller can persist + re-render).
     */
    mergeSnapshot(snapshot: any): boolean {
        if (!snapshot || typeof snapshot !== 'object') return false;
        let changed = false;

        if (snapshot.learnerName && !this.learnerName) { this.learnerName = snapshot.learnerName; changed = true; }
        if (typeof snapshot.sessionCount === 'number' && snapshot.sessionCount > this.sessionCount) {
            this.sessionCount = snapshot.sessionCount; changed = true;
        }
        if (typeof snapshot.totalLearningTimeSeconds === 'number' && snapshot.totalLearningTimeSeconds > this.totalLearningTimeSeconds) {
            this.totalLearningTimeSeconds = snapshot.totalLearningTimeSeconds; changed = true;
        }

        // Concepts: field-wise max, unioned + de-duplicated history.
        if (snapshot.conceptProgress && typeof snapshot.conceptProgress === 'object') {
            for (const [id, raw] of Object.entries(snapshot.conceptProgress)) {
                const c = raw as any;
                const local = this.conceptProgress.get(id);
                if (!local) {
                    this.conceptProgress.set(id, {
                        conceptId: id,
                        conceptName: c.conceptName || id,
                        level: c.level ?? MasteryLevel.NotStarted,
                        timesIntroduced: c.timesIntroduced || 0,
                        timesPracticed: c.timesPracticed || 0,
                        successfulAttempts: c.successfulAttempts || 0,
                        failedAttempts: c.failedAttempts || 0,
                        totalTimeSpentSeconds: c.totalTimeSpentSeconds || 0,
                        lastInteraction: c.lastInteraction || 0,
                        history: Array.isArray(c.history) ? c.history.slice() : [],
                    });
                    changed = true;
                    continue;
                }
                const before = JSON.stringify(local);
                local.level = Math.max(local.level, c.level ?? 0);
                local.timesIntroduced = Math.max(local.timesIntroduced, c.timesIntroduced || 0);
                local.timesPracticed = Math.max(local.timesPracticed, c.timesPracticed || 0);
                local.successfulAttempts = Math.max(local.successfulAttempts, c.successfulAttempts || 0);
                local.failedAttempts = Math.max(local.failedAttempts, c.failedAttempts || 0);
                local.totalTimeSpentSeconds = Math.max(local.totalTimeSpentSeconds, c.totalTimeSpentSeconds || 0);
                local.lastInteraction = Math.max(local.lastInteraction, c.lastInteraction || 0);
                // Union history by timestamp (records are immutable once created).
                if (Array.isArray(c.history) && c.history.length) {
                    const seen = new Set(local.history.map(h => h.timestamp));
                    for (const h of c.history) if (!seen.has(h.timestamp)) local.history.push(h);
                    local.history.sort((a, b) => a.timestamp - b.timestamp);
                }
                if (JSON.stringify(local) !== before) changed = true;
            }
        }

        // Lessons: OR completion, max the counters, keep earliest start / latest finish.
        if (snapshot.lessonProgress && typeof snapshot.lessonProgress === 'object') {
            for (const [id, raw] of Object.entries(snapshot.lessonProgress)) {
                const l = raw as any;
                const local = this.lessonProgress.get(id);
                if (!local) { this.lessonProgress.set(id, l as LessonProgress); changed = true; continue; }
                const before = JSON.stringify(local);
                local.started = local.started || !!l.started;
                local.completed = local.completed || !!l.completed;
                local.contentItemsCompleted = Math.max(local.contentItemsCompleted, l.contentItemsCompleted || 0);
                local.totalContentItems = Math.max(local.totalContentItems, l.totalContentItems || 0);
                local.completionPercentage = Math.max(local.completionPercentage, l.completionPercentage || 0);
                local.totalTimeSpentSeconds = Math.max(local.totalTimeSpentSeconds, l.totalTimeSpentSeconds || 0);
                local.attempts = Math.max(local.attempts, l.attempts || 0);
                if (l.startTime && (!local.startTime || l.startTime < local.startTime)) local.startTime = l.startTime;
                if (l.completionTime && l.completionTime > local.completionTime) local.completionTime = l.completionTime;
                if (JSON.stringify(local) !== before) changed = true;
            }
        }

        return changed;
    }

    // ── Recording Interactions ──

    /**
     * Record an interaction with a concept.
     *
     * This is the main entry point for tracking learning progress.
     * Called when:
     * - A lesson introduces a concept (type='lesson')
     * - The user completes a coding exercise (type='exercise')
     * - The user answers a quiz question (type='quiz')
     * - The user asks the AI about a concept (type='chat')
     *
     * After recording, the mastery level is automatically recalculated.
     *
     * @param conceptId - Which concept (e.g., "pointers", "for_loop")
     * @param type - What kind of interaction
     * @param successful - Did they get it right?
     * @param timeSpentSeconds - How long they spent on this interaction
     */
    recordInteraction(conceptId: string, type: InteractionRecord['type'],
                      successful: boolean, timeSpentSeconds: number): void {
        // Get or create the concept progress entry
        let progress = this.conceptProgress.get(conceptId);
        if (!progress) {
            // Unknown concept — create it on the fly
            progress = {
                conceptId,
                conceptName: conceptId, // No pretty name available
                level: MasteryLevel.NotStarted,
                timesIntroduced: 0,
                timesPracticed: 0,
                successfulAttempts: 0,
                failedAttempts: 0,
                totalTimeSpentSeconds: 0,
                lastInteraction: 0,
                history: [],
            };
            this.conceptProgress.set(conceptId, progress);
        }

        // Create the interaction record
        const record: InteractionRecord = {
            type,
            conceptId,
            timestamp: Date.now(),
            successful,
            attemptNumber: progress.timesPracticed + 1,
            timeSpentSeconds,
            notes: '',
        };

        // Update counters
        progress.history.push(record);
        progress.lastInteraction = record.timestamp;
        progress.totalTimeSpentSeconds += timeSpentSeconds;

        if (type === 'lesson') {
            progress.timesIntroduced++;
        } else if (type === 'exercise' || type === 'quiz') {
            progress.timesPracticed++;
            if (successful) {
                progress.successfulAttempts++;
            } else {
                progress.failedAttempts++;
            }
        }

        // Recalculate mastery level based on new data
        this.updateMasteryLevel(progress);
    }

    /**
     * Record progress on a lesson.
     *
     * Called when:
     * - The user opens a lesson for the first time (started=true, completed=false)
     * - The user advances through content items
     * - The user finishes all content in a lesson (completed=true)
     *
     * @param lessonId - Which lesson (e.g., "hello_xbox")
     * @param contentItemsCompleted - How many content steps they've done
     * @param totalContentItems - Total content steps in this lesson
     * @param completed - Did they finish the whole lesson?
     */
    recordLessonProgress(lessonId: string, contentItemsCompleted: number,
                         totalContentItems: number, completed: boolean): void {
        let progress = this.lessonProgress.get(lessonId);
        if (!progress) {
            progress = {
                lessonId,
                started: false,
                completed: false,
                contentItemsCompleted: 0,
                totalContentItems: 0,
                completionPercentage: 0,
                startTime: 0,
                completionTime: 0,
                totalTimeSpentSeconds: 0,
                attempts: 0,
            };
            this.lessonProgress.set(lessonId, progress);
        }

        // Mark as started on first visit
        if (!progress.started) {
            progress.started = true;
            progress.startTime = Date.now();
            progress.attempts = 1;
        }

        progress.contentItemsCompleted = contentItemsCompleted;
        progress.totalContentItems = totalContentItems;
        progress.completionPercentage = totalContentItems > 0
            ? (100.0 * contentItemsCompleted / totalContentItems) : 0;

        // Mark completion (only once — don't overwrite the timestamp)
        if (completed && !progress.completed) {
            progress.completed = true;
            progress.completionTime = Date.now();
        }
    }

    // ── Queries ──

    /**
     * Get progress for a specific concept.
     * Returns undefined if the concept isn't tracked.
     */
    getConceptProgress(conceptId: string): ConceptProgress | undefined {
        return this.conceptProgress.get(conceptId);
    }

    /**
     * Get progress for a specific lesson.
     * Returns undefined if the lesson hasn't been started.
     */
    getLessonProgress(lessonId: string): LessonProgress | undefined {
        return this.lessonProgress.get(lessonId);
    }

    /**
     * Get concepts that need more practice.
     * Returns concept IDs where the mastery level is Introduced or Practicing —
     * meaning the user has seen them but hasn't gotten comfortable yet.
     */
    getConceptsNeedingPractice(): string[] {
        const result: string[] = [];
        for (const [id, progress] of this.conceptProgress) {
            if (progress.level === MasteryLevel.Introduced ||
                progress.level === MasteryLevel.Practicing) {
                result.push(id);
            }
        }
        return result;
    }

    /**
     * Get overall learning progress as a percentage (0-100).
     * Based on lesson completion: completedLessons / totalLessons * 100.
     *
     * The denominator should be the TOTAL number of lessons in the curriculum,
     * not just the lessons the user has started. Pass `totalLessons` (e.g. the
     * curriculum lesson count from lessonSystem) to get an accurate figure —
     * finishing one of N lessons then reads as 1/N, not 1/1 = 100%.
     *
     * When `totalLessons` is omitted (or not a positive number), this falls back
     * to the legacy behavior of dividing by the number of started lessons.
     * Callers that know the curriculum size should pass it.
     *
     * @param totalLessons - Total lessons in the curriculum (optional)
     */
    getOverallProgress(totalLessons?: number): number {
        let completed = 0;
        let started = 0;
        for (const [, progress] of this.lessonProgress) {
            started++;
            if (progress.completed) completed++;
        }
        const total = (typeof totalLessons === 'number' && totalLessons > 0)
            ? totalLessons
            : started;
        return total > 0 ? (100.0 * completed / total) : 0;
    }

    /**
     * Get total time spent learning across all sessions, in hours.
     */
    getTotalTimeSpentHours(): number {
        return this.totalLearningTimeSeconds / 3600.0;
    }

    /**
     * Get the recommended next lesson.
     * Logic: find the first lesson that was started but not completed.
     * If all started lessons are done, returns the default first lesson.
     */
    getRecommendedNextLesson(): string {
        for (const [id, progress] of this.lessonProgress) {
            if (progress.started && !progress.completed) {
                return id;
            }
        }
        return 'hello_xbox'; // Default to the very first lesson
    }

    // ── Pattern Analysis ──

    /**
     * Analyze learning patterns across all concepts.
     *
     * This is the "intelligence" of the adaptive system. It looks at success/fail
     * rates across all concepts to detect:
     * - Which areas the user is strong/weak in
     * - Whether they struggle with specific topic families (pointers, syntax)
     * - How long their typical session is
     *
     * The returned LearningPattern object is designed to be injected into the AI
     * system prompt, so the tutor can adapt its responses.
     */
    analyzePatterns(): LearningPattern {
        const pattern: LearningPattern = {
            prefersVisualLearning: false,
            needsMoreRepetition: false,
            strugglesWithPointers: false,
            strugglesWithSyntax: false,
            learnsQuickly: false,
            averageSessionMinutes: 0,
            strongestArea: '',
            weakestArea: '',
            recommendedFocusAreas: [],
        };

        let pointerFails = 0;
        let syntaxFails = 0;
        let highestRate = 0;
        let lowestRate = 1;
        let strongest = '';
        let weakest = '';

        for (const [id, progress] of this.conceptProgress) {
            // Skip concepts the user hasn't practiced yet
            if (progress.timesPracticed === 0) continue;

            const totalAttempts = progress.successfulAttempts + progress.failedAttempts;
            if (totalAttempts === 0) continue;

            const rate = progress.successfulAttempts / totalAttempts;

            if (rate > highestRate) {
                highestRate = rate;
                strongest = progress.conceptName;
            }
            if (rate < lowestRate) {
                lowestRate = rate;
                weakest = progress.conceptName;
            }

            // Check pointer-related concepts
            if (id === 'pointers' || id === 'memory_addresses' || id === 'dereferencing') {
                pointerFails += progress.failedAttempts;
            }

            // Check syntax-related concepts
            if (id.includes('syntax')) {
                syntaxFails += progress.failedAttempts;
            }
        }

        pattern.strongestArea = strongest;
        pattern.weakestArea = weakest;

        // Thresholds: more than 5 failures in a category means "struggles with"
        pattern.strugglesWithPointers = pointerFails > 5;
        pattern.strugglesWithSyntax = syntaxFails > 5;

        // Calculate average session duration
        if (this.sessionCount > 0) {
            pattern.averageSessionMinutes = (this.totalLearningTimeSeconds / this.sessionCount) / 60.0;
        }

        // Build focus recommendations
        if (weakest) {
            pattern.recommendedFocusAreas.push(weakest);
        }
        if (pattern.strugglesWithPointers) {
            pattern.recommendedFocusAreas.push('Pointers and Memory');
        }

        return pattern;
    }

    /**
     * Generate a summary string suitable for injecting into the AI system prompt.
     * This lets the AI tutor know about the user's learning state.
     *
     * Example output:
     *   "Learner profile: 3 sessions, 2.5 hours total. Strongest: Variables.
     *    Weakest: Pointers. Struggles with pointers (6 failed attempts).
     *    Concepts needing practice: Pointers, Dereferencing."
     */
    getAIContextSummary(): string {
        const pattern = this.analyzePatterns();
        const needsPractice = this.getConceptsNeedingPractice();
        const hours = this.getTotalTimeSpentHours();
        const recommended = this.getRecommendedNextLesson();

        // Lazy require to avoid circular dependency
        let currentLessonInfo = '';
        let totalLessons: number | undefined;
        try {
            const { lessonSystem } = require('./lessonSystem');
            const lesson = lessonSystem.getCurrentLesson();
            const modId = lessonSystem.getCurrentModuleId();
            const contentIdx = lessonSystem.getCurrentContentIndex();
            if (lesson) {
                currentLessonInfo = `CURRENT LESSON: ${modId} / ${lesson.title} (Step ${contentIdx + 1} of ${lesson.content.length})`;
            }
            // Derive the curriculum's total lesson count so overall progress is
            // measured against the whole curriculum, not just started lessons.
            const curriculum = lessonSystem.getActiveCurriculum();
            if (curriculum && Array.isArray(curriculum.modules)) {
                totalLessons = curriculum.modules.reduce(
                    (sum: number, mod: any) => sum + (mod.lessons?.length || 0), 0);
            }
        } catch (e) { /* lessonSystem not loaded yet */ }

        const overallProgress = this.getOverallProgress(totalLessons);

        // Categorize concepts by mastery level
        const mastered: string[] = [];
        const proficient: string[] = [];
        const developing: string[] = [];
        const practicing: string[] = [];
        const notStarted: string[] = [];

        for (const [id, cp] of this.conceptProgress) {
            const name = cp.conceptName || id;
            switch (cp.level) {
                case MasteryLevel.Mastered: mastered.push(name); break;
                case MasteryLevel.Proficient: proficient.push(name); break;
                case MasteryLevel.Developing: developing.push(name); break;
                case MasteryLevel.Practicing:
                case MasteryLevel.Introduced: practicing.push(name); break;
                default: notStarted.push(name); break;
            }
        }

        // Recent interaction history (last 5)
        const allInteractions: { concept: string; type: string; success: boolean; time: number }[] = [];
        for (const [id, cp] of this.conceptProgress) {
            for (const h of cp.history.slice(-3)) {
                allInteractions.push({ concept: cp.conceptName || id, type: h.type, success: h.successful, time: h.timestamp });
            }
        }
        allInteractions.sort((a, b) => b.time - a.time);
        const recent = allInteractions.slice(0, 5);

        // Time since last session
        let timeSinceNote = '';
        if (this.sessionCount > 1) {
            // Check the most recent interaction timestamp
            const lastTime = allInteractions.length > 0 ? allInteractions[0].time : 0;
            if (lastTime > 0) {
                const hoursSince = (Date.now() - lastTime) / (1000 * 60 * 60);
                if (hoursSince > 24) {
                    // States the fact; does not instruct a greeting.
                    //
                    // This used to end with "Welcome them back and offer to
                    // review." — an instruction in the system prompt, which is
                    // sent with EVERY message. So the first real question after a
                    // break got a welcome-back preamble in front of the answer,
                    // every time, on tokens the user pays for. The tutor can have
                    // the fact without being told to perform with it.
                    timeSinceNote = `Their last session was ${Math.round(hoursSince / 24)} days ago.`;
                }
            }
        }

        // Build the structured context
        const lines: string[] = [
            'TUTOR MODE:',
            'You are also the learner\'s C++ tutor. Here is their current state:',
            '',
            `PROGRESS: ${overallProgress.toFixed(0)}% complete | ${this.sessionCount} sessions | ${hours.toFixed(1)} hours total`,
        ];

        if (currentLessonInfo) lines.push(currentLessonInfo);

        lines.push('');
        lines.push('MASTERY LEVELS:');
        if (mastered.length > 0) lines.push(`  ✅ Mastered: ${mastered.join(', ')}`);
        if (proficient.length > 0) lines.push(`  🔵 Proficient: ${proficient.join(', ')}`);
        if (developing.length > 0) lines.push(`  🟡 Developing: ${developing.join(', ')}`);
        if (practicing.length > 0) lines.push(`  🟠 Practicing: ${practicing.join(', ')}`);
        if (notStarted.length > 0) lines.push(`  🔴 Not Started: ${notStarted.join(', ')}`);

        if (recent.length > 0) {
            lines.push('');
            lines.push('RECENT ACTIVITY:');
            for (const r of recent) {
                const icon = r.success ? '✓' : '✗';
                lines.push(`  ${icon} ${r.concept} (${r.type})`);
            }
        }

        lines.push('');
        lines.push('PATTERNS:');
        if (pattern.strongestArea) lines.push(`  Strongest: ${pattern.strongestArea}`);
        if (pattern.weakestArea) lines.push(`  Weakest: ${pattern.weakestArea}`);
        if (pattern.strugglesWithPointers) lines.push('  ⚠ Struggles with pointers — use visual explanations and analogies');
        if (pattern.strugglesWithSyntax) lines.push('  ⚠ Struggles with syntax — provide more code examples');
        if (pattern.learnsQuickly) lines.push('  ⚡ Learns quickly — can handle more advanced examples');
        if (recommended) lines.push(`  📌 Recommended next: ${recommended}`);
        if (timeSinceNote) lines.push(`  🕐 ${timeSinceNote}`);

        lines.push('');
        lines.push('TUTOR RULES:');
        lines.push('1. Relate answers to the learner\'s current lesson topic when natural.');
        lines.push('2. For 🔴/🟡 concepts, use analogies, step-by-step breakdowns, and visual metaphors.');
        lines.push('3. For ✅ mastered concepts, be concise — they already know this.');
        lines.push('4. If they seem stuck, suggest opening a lesson or the Visualizer.');
        lines.push('5. Proactively suggest their weakest areas when appropriate.');
        lines.push('6. For their weak areas, always add plain-English annotations to code.');
        lines.push('7. You can trigger visualizations by including [VIZ:VARIABLE:name:type:value] or [VIZ:POINTER:ptr:target] or [VIZ:ARRAY:name:1,2,3] in your response — the IDE will render these as diagrams.');

        return lines.join('\n');
    }

    // ── Session Management ──

    /**
     * Start a new learning session. Call this when the user enters the Learn panel.
     */
    startSession(): void {
        this.sessionStartTime = Date.now();
        this.sessionCount++;
    }

    /**
     * End the current session. Call this when the user leaves the Learn panel
     * or closes the app. Adds the session duration to the total learning time.
     */
    endSession(): void {
        if (this.sessionStartTime > 0) {
            const durationSeconds = (Date.now() - this.sessionStartTime) / 1000;
            this.totalLearningTimeSeconds += durationSeconds;
            this.sessionStartTime = 0;
        }
    }

    // ── Mastery Calculation ──

    /**
     * Recalculate the mastery level for a concept based on its progress data.
     *
     * The algorithm:
     * - Not introduced yet → NotStarted
     * - Introduced but never practiced → Introduced
     * - 5+ successes with 90%+ rate → Mastered
     * - 3+ successes with 75%+ rate → Proficient
     * - 2+ successes with 50%+ rate → Developing
     * - Otherwise → Practicing
     *
     * This matches the original C++ implementation exactly.
     */
    private updateMasteryLevel(progress: ConceptProgress): void {
        const totalAttempts = progress.successfulAttempts + progress.failedAttempts;
        const successRate = totalAttempts > 0
            ? progress.successfulAttempts / totalAttempts
            : 0;

        if (progress.timesIntroduced === 0) {
            progress.level = MasteryLevel.NotStarted;
        } else if (progress.timesPracticed === 0) {
            progress.level = MasteryLevel.Introduced;
        } else if (progress.successfulAttempts >= 5 && successRate >= 0.9) {
            progress.level = MasteryLevel.Mastered;
        } else if (progress.successfulAttempts >= 3 && successRate >= 0.75) {
            progress.level = MasteryLevel.Proficient;
        } else if (progress.successfulAttempts >= 2 && successRate >= 0.5) {
            progress.level = MasteryLevel.Developing;
        } else {
            progress.level = MasteryLevel.Practicing;
        }
    }
}

// ── Singleton Instance ──
// Exported so app.ts can use it directly:
//   const { learningProfile } = require('./learning/learningProfile');

export const learningProfile = new LearningProfile();

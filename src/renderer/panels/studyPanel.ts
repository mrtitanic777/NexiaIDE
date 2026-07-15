/**
 * studyPanel.ts — Quiz, flashcard, and study notes system
 * Extracted from app.ts.
 */

const nodeFs = require('fs');
const nodePath = require('path');
const nodeOs = require('os');
const quizzes = require('../learning/quizzes');

// ── State (moved from app.ts top-level) ──
let quizQuestions: any[] = [];
let quizIndex = 0;
let quizAnswered = false;
let quizScore = { correct: 0, total: 0 };
let quizMode: 'multiple-choice' | 'fill-in' = 'multiple-choice';
let flashcards: { front: string; back: string }[] = [];
let fcIndex = 0;
let studyNotes: string = '';

// ── Dependencies (wired from app.ts) ──
let _$: (id: string) => HTMLElement = (id) => document.getElementById(id)!;
let _appendOutput: (text: string) => void = () => {};
let _getCurrentProject: () => any = () => null;
let _getUserSettings: () => any = () => ({});
let _renderLearnPanel: () => void = () => {};
let _tutorOnQuizFail: (cat: string, q: string) => void = () => {};
let _recordLearning: (conceptId: string, type: 'lesson' | 'exercise' | 'quiz' | 'chat', successful: boolean) => void = () => {};

export function initStudy(deps: {
    $: (id: string) => HTMLElement;
    appendOutput: (text: string) => void;
    getCurrentProject: () => any;
    getUserSettings: () => any;
    renderLearnPanel: () => void;
    tutorOnQuizFail: (cat: string, q: string) => void;
    recordLearning?: (conceptId: string, type: 'lesson' | 'exercise' | 'quiz' | 'chat', successful: boolean) => void;
}) {
    _$ = deps.$;
    _appendOutput = deps.appendOutput;
    _getCurrentProject = deps.getCurrentProject;
    _getUserSettings = deps.getUserSettings;
    _renderLearnPanel = deps.renderLearnPanel;
    _tutorOnQuizFail = deps.tutorOnQuizFail;
    if (deps.recordLearning) _recordLearning = deps.recordLearning;
}

/** Map a quiz question's category to a learning-profile concept id. */
function conceptIdForQuiz(q: any): string {
    const raw = (q && (q.concept || q.category)) || 'general';
    return String(raw).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'general';
}

// ── Flashcard Persistence ──
export function loadFlashcards() {
    try {
        const file = nodePath.join(nodeOs.homedir(), '.nexia-ide-flashcards.json');
        if (nodeFs.existsSync(file)) {
            const parsed = JSON.parse(nodeFs.readFileSync(file, 'utf-8'));
            // Guard against corrupt/legacy data that isn't an array — keep the
            // deck a valid array so render/index logic can't crash.
            flashcards = Array.isArray(parsed) ? parsed : [];
        }
    } catch {}
}
function saveFlashcards() {
    try { nodeFs.writeFileSync(nodePath.join(nodeOs.homedir(), '.nexia-ide-flashcards.json'), JSON.stringify(flashcards, null, 2)); } catch {}
}

// ── Study Notes ──
function getNotesFile(): string {
    const proj = _getCurrentProject();
    if (proj) return nodePath.join(proj.path, 'study-notes.txt');
    return nodePath.join(nodeOs.homedir(), '.nexia-ide-notes.txt');
}

function showNotes() {
    try {
        const file = getNotesFile();
        if (nodeFs.existsSync(file)) studyNotes = nodeFs.readFileSync(file, 'utf-8');
    } catch {}
    (_$('notes-editor') as HTMLTextAreaElement).value = studyNotes;
    _$('notes-overlay').classList.remove('hidden');
}

// ── Quiz System ──
export function startQuiz(category?: string, mode?: 'multiple-choice' | 'fill-in') {
    const allQ = quizzes.getQuizByCategory(category) || [];
    quizMode = mode || 'multiple-choice';
    let selected: any[];
    if (quizMode === 'fill-in') {
        selected = quizzes.shuffleArray(allQ).slice(0, 10);
    } else {
        selected = quizzes.shuffleArray(allQ.filter((q: any) => q.options)).slice(0, 10);
    }

    // Guard: a category with no matching questions would otherwise drop straight
    // into a "0/0" result. Show a friendly message and stay out of the quiz UI.
    if (selected.length === 0) {
        const label = category ? `the "${category}" category` : 'this selection';
        const modeNote = quizMode === 'fill-in' ? '' : ' (multiple-choice)';
        alert(`No questions available for ${label}${modeNote}.`);
        return;
    }

    quizQuestions = selected;
    quizIndex = 0;
    quizAnswered = false;
    quizScore = { correct: 0, total: 0 };
    _$('quiz-overlay').classList.remove('hidden');
    renderQuizQuestion();
}

function renderQuizQuestion() {
    if (quizIndex >= quizQuestions.length) { showQuizResults(); return; }
    const q = quizQuestions[quizIndex];
    quizAnswered = false;
    _$('quiz-progress').textContent = `${quizIndex + 1} / ${quizQuestions.length}`;
    _$('quiz-question').textContent = q.question;
    _$('quiz-feedback').className = 'quiz-feedback hidden';
    _$('quiz-ref').className = 'quiz-ref hidden';
    _$('quiz-next').textContent = quizIndex < quizQuestions.length - 1 ? 'Next →' : 'Finish';

    if (quizMode === 'fill-in' || !q.options) {
        _$('quiz-mode-mc').style.display = 'none';
        _$('quiz-mode-fill').style.display = 'block';
        (_$('quiz-fill-input') as HTMLInputElement).value = '';
        (_$('quiz-fill-input') as HTMLInputElement).focus();
    } else {
        _$('quiz-mode-mc').style.display = 'block';
        _$('quiz-mode-fill').style.display = 'none';
        const opts = _$('quiz-options');
        opts.innerHTML = '';
        q.options.forEach((opt: string, i: number) => {
            const btn = document.createElement('button');
            btn.className = 'quiz-option';
            btn.textContent = opt;
            btn.addEventListener('click', () => answerQuizMC(i));
            opts.appendChild(btn);
        });
    }
}

function answerQuizMC(idx: number) {
    if (quizAnswered) return;
    quizAnswered = true;
    quizScore.total++;
    const q = quizQuestions[quizIndex];
    const correct = idx === q.answerIndex;
    if (correct) quizScore.correct++;
    _recordLearning(conceptIdForQuiz(q), 'quiz', correct);

    const btns = _$('quiz-options').querySelectorAll('.quiz-option');
    btns.forEach((b: any, i: number) => {
        if (i === q.answerIndex) b.classList.add('correct');
        else if (i === idx && !correct) b.classList.add('incorrect');
    });
    showQuizFeedback(correct, q);
}

function answerQuizFill() {
    if (quizAnswered) return;
    const input = (_$('quiz-fill-input') as HTMLInputElement).value.trim();
    if (!input) return;
    quizAnswered = true;
    quizScore.total++;
    const q = quizQuestions[quizIndex];
    const correct = input.toLowerCase().includes(q.answer.toLowerCase());
    if (correct) quizScore.correct++;
    _recordLearning(conceptIdForQuiz(q), 'quiz', correct);
    showQuizFeedback(correct, q);
}

function showQuizFeedback(correct: boolean, q: any) {
    const fb = _$('quiz-feedback');
    fb.className = `quiz-feedback ${correct ? 'correct' : 'incorrect'}`;
    fb.textContent = correct ? '✓ Correct!' : `✗ Incorrect. The answer is: ${q.answer}`;
    if (!correct) {
        const settings = _getUserSettings();
        if (settings.aiApiKey || settings.aiProvider === 'local') {
            _tutorOnQuizFail(q.category || 'C++', q.question || '');
        }
    }
}

function showQuizResults() {
    const pct = quizScore.total > 0 ? Math.round((quizScore.correct / quizScore.total) * 100) : 0;
    _$('quiz-question').textContent = `Quiz Complete! You scored ${quizScore.correct}/${quizScore.total} (${pct}%)`;
    _$('quiz-options').innerHTML = '';
    _$('quiz-mode-mc').style.display = 'none';
    _$('quiz-mode-fill').style.display = 'none';
    _$('quiz-feedback').className = 'quiz-feedback hidden';
    _$('quiz-next').textContent = 'Close';
    _$('quiz-progress').textContent = 'Done!';
    _renderLearnPanel();
}

// ── Flashcard UI ──
export function showFlashcards() {
    if (!Array.isArray(flashcards) || flashcards.length === 0) {
        alert('No flashcards yet! Take a quiz and click "Save as Flashcard" to create some, or add them from the Study panel.');
        return;
    }
    fcIndex = 0;
    _$('flashcard-overlay').classList.remove('hidden');
    renderFlashcard();
}

function renderFlashcard() {
    if (!Array.isArray(flashcards) || flashcards.length === 0) return;
    const fc = flashcards[fcIndex];
    if (!fc) return;
    _$('fc-front-text').textContent = fc.front;
    _$('fc-back-text').textContent = fc.back;
    _$('fc-progress').textContent = `${fcIndex + 1} / ${flashcards.length}`;
    document.getElementById('flashcard')!.classList.remove('flipped');
}

// ── Wire Buttons (call once from app.ts init) ──
export function initStudyButtons() {
    _$('quiz-next').addEventListener('click', () => {
        if (quizIndex >= quizQuestions.length) { _$('quiz-overlay').classList.add('hidden'); return; }
        quizIndex++;
        renderQuizQuestion();
    });
    _$('quiz-close').addEventListener('click', () => _$('quiz-overlay').classList.add('hidden'));
    _$('quiz-ref-btn').addEventListener('click', () => {
        if (quizIndex < quizQuestions.length) {
            _$('quiz-ref').classList.remove('hidden');
            _$('quiz-ref-text').textContent = quizQuestions[quizIndex].reference;
        }
    });
    _$('quiz-note-btn').addEventListener('click', () => {
        if (quizIndex < quizQuestions.length) {
            const q = quizQuestions[quizIndex];
            flashcards.push({ front: q.question, back: q.answer + ' — ' + q.reference });
            saveFlashcards();
            _appendOutput(`📌 Saved flashcard: "${q.question.substring(0, 40)}..."\n`);
        }
    });
    _$('quiz-fill-submit').addEventListener('click', answerQuizFill);

    // Flashcard buttons
    _$('flashcard').addEventListener('click', () => document.getElementById('flashcard')!.classList.toggle('flipped'));
    _$('fc-flip').addEventListener('click', () => document.getElementById('flashcard')!.classList.toggle('flipped'));
    _$('fc-prev').addEventListener('click', () => { if (fcIndex > 0) { fcIndex--; renderFlashcard(); } });
    _$('fc-next').addEventListener('click', () => { if (fcIndex < flashcards.length - 1) { fcIndex++; renderFlashcard(); } });
    _$('fc-close').addEventListener('click', () => _$('flashcard-overlay').classList.add('hidden'));

    // Notes buttons
    _$('notes-save').addEventListener('click', () => {
        studyNotes = (_$('notes-editor') as HTMLTextAreaElement).value;
        try { nodeFs.writeFileSync(getNotesFile(), studyNotes, 'utf-8'); } catch {}
        _$('notes-overlay').classList.add('hidden');
        _appendOutput('📓 Study notes saved.\n');
    });
    _$('notes-export').addEventListener('click', () => {
        const content = (_$('notes-editor') as HTMLTextAreaElement).value;
        const proj = _getCurrentProject();
        const dest = proj
            ? nodePath.join(proj.path, 'study-notes-export.txt')
            : nodePath.join(nodeOs.homedir(), 'Desktop', 'nexia-study-notes.txt');
        try { nodeFs.writeFileSync(dest, content, 'utf-8'); _appendOutput(`📓 Notes exported to: ${dest}\n`); } catch {}
    });
}

// ── Study Panel Render ──
export function renderStudyPanel() {
    const panel = _$('study-panel');
    if (!panel) return;
    panel.innerHTML = '';

    const statsDiv = document.createElement('div');
    statsDiv.className = 'study-stats';
    statsDiv.innerHTML = `
        <div class="study-stat"><div class="study-stat-num">${flashcards.length}</div><div class="study-stat-label">Flashcards</div></div>
        <div class="study-stat"><div class="study-stat-num">${quizzes.QUIZ_BANK.length}</div><div class="study-stat-label">Quiz Questions</div></div>`;
    panel.appendChild(statsDiv);

    const section = document.createElement('div');
    section.className = 'study-section';
    section.innerHTML = '<div class="learn-section-title">STUDY TOOLS</div>';

    const cats = quizzes.getQuizCategories();
    for (const cat of cats) {
        const count = quizzes.getQuizByCategory(cat).length;
        const btn = document.createElement('button');
        btn.className = 'study-btn';
        btn.innerHTML = `<span class="study-btn-icon">📝</span><div><div class="study-btn-label">${cat} Quiz</div><div class="study-btn-desc">${count} questions · Multiple Choice</div></div>`;
        btn.addEventListener('click', () => startQuiz(cat, 'multiple-choice'));
        section.appendChild(btn);

        const btn2 = document.createElement('button');
        btn2.className = 'study-btn';
        btn2.innerHTML = `<span class="study-btn-icon">✏️</span><div><div class="study-btn-label">${cat} Fill-In</div><div class="study-btn-desc">${count} questions · Type your answer</div></div>`;
        btn2.addEventListener('click', () => startQuiz(cat, 'fill-in'));
        section.appendChild(btn2);
    }

    const fcBtn = document.createElement('button');
    fcBtn.className = 'study-btn';
    fcBtn.innerHTML = `<span class="study-btn-icon">🎯</span><div><div class="study-btn-label">Flashcards</div><div class="study-btn-desc">${flashcards.length} cards saved</div></div>`;
    fcBtn.addEventListener('click', showFlashcards);
    section.appendChild(fcBtn);

    const notesBtn = document.createElement('button');
    notesBtn.className = 'study-btn';
    notesBtn.innerHTML = '<span class="study-btn-icon">📓</span><div><div class="study-btn-label">Study Notes</div><div class="study-btn-desc">Write and save personal notes</div></div>';
    notesBtn.addEventListener('click', showNotes);
    section.appendChild(notesBtn);

    panel.appendChild(section);
}

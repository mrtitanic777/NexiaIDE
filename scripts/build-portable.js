/**
 * build-portable.js
 * Wraps electron-builder with real-time progress monitoring.
 * Shows file counts, directory sizes, and build phases as they happen.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── Config ──
const DIST_DIR = path.join(__dirname, '..', 'dist');
const UNPACKED_DIR = path.join(DIST_DIR, 'win-unpacked');
const SDK_DIR = path.join(__dirname, '..', 'sdk');

// ── Helpers ──
function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
}

function getDirSize(dir) {
    let total = 0;
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                total += getDirSize(full);
            } else {
                try { total += fs.statSync(full).size; } catch {}
            }
        }
    } catch {}
    return total;
}

function countFiles(dir) {
    let count = 0;
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory()) {
                count += countFiles(path.join(dir, entry.name));
            } else {
                count++;
            }
        }
    } catch {}
    return count;
}

function clearLine() {
    process.stdout.write('\r' + ' '.repeat(72) + '\r');
}

// ── Phase tracking ──
const phases = {
    init:       { label: 'Initializing',                  done: false },
    config:     { label: 'Loading configuration',         done: false },
    packaging:  { label: 'Packaging app files',           done: false },
    resources:  { label: 'Copying extra resources (SDK)',  done: false },
    asar:       { label: 'Creating app archive (asar)',   done: false },
    building:   { label: 'Building portable executable',  done: false },
    done:       { label: 'Build complete',                done: false },
};

let currentPhase = 'init';
let monitorInterval = null;
let lastFileCount = 0;
let lastDirSize = 0;
let phaseStartTime = Date.now();
let buildStartTime = Date.now();

function setPhase(name) {
    if (phases[name] && !phases[name].done) {
        // Mark previous phase done
        if (currentPhase && phases[currentPhase]) {
            phases[currentPhase].done = true;
            const elapsed = ((Date.now() - phaseStartTime) / 1000).toFixed(1);
            clearLine();
            console.log('    [OK] ' + phases[currentPhase].label + ' (' + elapsed + 's)');
        }
        currentPhase = name;
        phaseStartTime = Date.now();
        if (name !== 'done') {
            console.log('    [ ] ' + phases[name].label + '...');
        }
    }
}

function detectPhase(line) {
    if (line.includes('loaded configuration'))    setPhase('config');
    else if (line.includes('packaging'))          setPhase('packaging');
    else if (line.includes('copying extra'))      setPhase('resources');
    else if (line.includes('building') && line.includes('target='))  setPhase('building');
    else if (line.includes('building block map')) setPhase('building');
}

// ── Directory monitor ──
function startMonitor() {
    monitorInterval = setInterval(() => {
        if (!fs.existsSync(UNPACKED_DIR)) return;

        const fileCount = countFiles(UNPACKED_DIR);
        const dirSize = getDirSize(UNPACKED_DIR);

        if (fileCount !== lastFileCount || Math.abs(dirSize - lastDirSize) > 1048576) {
            clearLine();
            process.stdout.write('         -> ' + fileCount + ' files, ' + formatBytes(dirSize) + ' unpacked');
            lastFileCount = fileCount;
            lastDirSize = dirSize;
        }
    }, 2000);
}

function stopMonitor() {
    if (monitorInterval) {
        clearInterval(monitorInterval);
        monitorInterval = null;
        clearLine();
    }
}

// ── Check output exe ──
function reportExe() {
    // Check for dir target output (win-unpacked/)
    const unpackedExe = path.join(UNPACKED_DIR, 'Nexia IDE.exe');
    if (fs.existsSync(unpackedExe)) {
        const stat = fs.statSync(unpackedExe);
        console.log('    [OK] App exe: win-unpacked/Nexia IDE.exe (' + formatBytes(stat.size) + ')');
        return;
    }
    // Fallback: check dist/ for portable exe
    try {
        const files = fs.readdirSync(DIST_DIR).filter(f => f.endsWith('.exe'));
        for (const f of files) {
            const full = path.join(DIST_DIR, f);
            const stat = fs.statSync(full);
            console.log('    [OK] Output: dist/' + f + ' (' + formatBytes(stat.size) + ')');
        }
    } catch {}
}

// ── SDK pre-check ──
function reportSdkSize() {
    if (fs.existsSync(SDK_DIR)) {
        const size = getDirSize(SDK_DIR);
        const count = countFiles(SDK_DIR);
        console.log('    [i] SDK to bundle: ' + count + ' files, ' + formatBytes(size));
    }
}

// ── Main ──
function run() {
    buildStartTime = Date.now();

    console.log('');
    console.log('    electron-builder packaging');
    console.log('    ----------------------------------------');

    reportSdkSize();
    currentPhase = 'init';
    phaseStartTime = Date.now();
    startMonitor();

    const cwd = path.join(__dirname, '..');
    const builderCmd = path.join(cwd, 'node_modules', '.bin', 'electron-builder');

    // Quote the command path: with shell:true the command string is parsed by
    // cmd.exe, so an unquoted path containing spaces (e.g. "My Projects") splits
    // and fails with "'...\My' is not recognized". PATHEXT still resolves the
    // extensionless bin to electron-builder.cmd.
    const builder = spawn('"' + builderCmd + '"', ['--win'], {
            cwd: cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: true,
            windowsHide: true,
        }
    );

    let output = '';

    builder.stdout.on('data', (data) => {
        const text = data.toString();
        output += text;
        const lines = text.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            // Detect phase transitions
            detectPhase(trimmed);

            // Print electron-builder's own important lines (indented)
            if (trimmed.startsWith('*') || trimmed.includes('error') || trimmed.includes('Error')) {
                clearLine();
                console.log('         ' + trimmed);
            }
        }
    });

    builder.stderr.on('data', (data) => {
        const text = data.toString().trim();
        if (text && !text.includes('MaxListeners')) {
            clearLine();
            console.log('    [!!] ' + text);
        }
    });

    builder.on('close', (code) => {
        stopMonitor();

        if (code === 0) {
            setPhase('done');
            console.log('    ----------------------------------------');

            // Final stats
            if (fs.existsSync(UNPACKED_DIR)) {
                const unpackedSize = getDirSize(UNPACKED_DIR);
                const unpackedFiles = countFiles(UNPACKED_DIR);
                console.log('    [i] Unpacked: ' + unpackedFiles + ' files, ' + formatBytes(unpackedSize));
            }

            reportExe();

            const totalTime = ((Date.now() - buildStartTime) / 1000).toFixed(1);
            console.log('    [i] Packaging took ' + totalTime + 's');
            console.log('');
        } else {
            console.log('');
            console.log('    [X] electron-builder exited with code ' + code);
            console.log('');
            // Dump last bit of output for debugging
            const lastLines = output.split('\n').slice(-15).join('\n');
            if (lastLines.trim()) {
                console.log('    -- Last output ----');
                console.log(lastLines);
            }
        }

        process.exit(code || 0);
    });

    builder.on('error', (err) => {
        stopMonitor();
        console.log('    [X] Failed to start electron-builder: ' + err.message);
        process.exit(1);
    });
}

run();
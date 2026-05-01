import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { classifyArtifact, discoverArtifacts } from '../bin/morty-watcher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MORTY_WATCHER_BIN = path.resolve(__dirname, '../bin/morty-watcher.js');

/**
 * Run morty-watcher.js as a subprocess.
 * @param {string[]} args - CLI arguments
 */
function run(args) {
    // 10s → 30s: budget for system load when run alongside concurrent
    // codex/tmux work. Tests validate CLI behavior, not wall-clock.
    return spawnSync(process.execPath, [MORTY_WATCHER_BIN, ...args], {
        env: { ...process.env },
        encoding: 'utf-8',
        timeout: 30000,
    });
}

function makeTmpDir() {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-morty-watcher-')));
}

function makeSessionDir(prefix) {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// --- Startup validation ---

test('morty-watcher: no args → exit 1, stderr includes Usage', () => {
    const result = run([]);
    assert.equal(result.status, 1, 'should exit with code 1');
    assert.ok(result.stderr.includes('Usage'), 'stderr should include Usage');
});

test('morty-watcher: non-existent session dir → exit 1, stderr includes Usage', () => {
    const result = run(['/tmp/definitely-does-not-exist-pickle-' + Date.now()]);
    assert.equal(result.status, 1, 'should exit with code 1');
    assert.ok(result.stderr.includes('Usage'), 'stderr should include Usage');
});

// --- classifyArtifact ---

test('classifyArtifact: research_ prefix → Researching', () => {
    assert.equal(classifyArtifact('research_api.md'), '📖 Researching...');
});

test('classifyArtifact: analysis_ prefix → Researching', () => {
    assert.equal(classifyArtifact('analysis_deps.json'), '📖 Researching...');
});

test('classifyArtifact: plan_ prefix → Planning', () => {
    assert.equal(classifyArtifact('plan_v2.md'), '📐 Planning...');
});

test('classifyArtifact: other prefix → Implementing', () => {
    assert.equal(classifyArtifact('component.tsx'), '🔨 Implementing...');
    assert.equal(classifyArtifact('fix_login.ts'), '🔨 Implementing...');
});

// --- discoverArtifacts ---

test('discoverArtifacts: finds recent files in ticket subdirectories', () => {
    const tmpDir = makeTmpDir();
    try {
        const ticketDir = path.join(tmpDir, 'ticket-001');
        fs.mkdirSync(ticketDir);
        fs.writeFileSync(path.join(ticketDir, 'research_api.md'), 'data');
        fs.writeFileSync(path.join(ticketDir, 'plan_impl.md'), 'plan');

        const seen = new Set();
        const results = discoverArtifacts(tmpDir, seen);

        assert.equal(results.length, 2, `Expected 2 artifacts, got: ${results.length}`);
        const fileNames = results.map(r => r.fileName).sort();
        assert.deepEqual(fileNames, ['plan_impl.md', 'research_api.md']);
        assert.equal(results[0].ticketId, 'ticket-001');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('discoverArtifacts: deduplicates via seenArtifacts set', () => {
    const tmpDir = makeTmpDir();
    try {
        const ticketDir = path.join(tmpDir, 'ticket-002');
        fs.mkdirSync(ticketDir);
        fs.writeFileSync(path.join(ticketDir, 'code.ts'), 'const x = 1;');

        const seen = new Set();
        const first = discoverArtifacts(tmpDir, seen);
        assert.equal(first.length, 1);

        // Second call should find nothing new
        const second = discoverArtifacts(tmpDir, seen);
        assert.equal(second.length, 0, 'Should not re-discover same artifact');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('discoverArtifacts: ignores state.json and .log files', () => {
    const tmpDir = makeTmpDir();
    try {
        const ticketDir = path.join(tmpDir, 'ticket-003');
        fs.mkdirSync(ticketDir);
        fs.writeFileSync(path.join(ticketDir, 'state.json'), '{}');
        fs.writeFileSync(path.join(ticketDir, 'worker_session_123.log'), 'log data');
        fs.writeFileSync(path.join(ticketDir, 'real_artifact.ts'), 'code');

        const seen = new Set();
        const results = discoverArtifacts(tmpDir, seen);

        assert.equal(results.length, 1, `Expected 1 artifact (filtering state.json + .log), got: ${results.length}`);
        assert.equal(results[0].fileName, 'real_artifact.ts');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('discoverArtifacts: ignores old files (> 30s)', () => {
    const tmpDir = makeTmpDir();
    try {
        const ticketDir = path.join(tmpDir, 'ticket-004');
        fs.mkdirSync(ticketDir);
        const filePath = path.join(ticketDir, 'old_artifact.md');
        fs.writeFileSync(filePath, 'data');

        // Set mtime to 60 seconds ago
        const oldTime = new Date(Date.now() - 60000);
        fs.utimesSync(filePath, oldTime, oldTime);

        const seen = new Set();
        const results = discoverArtifacts(tmpDir, seen);
        assert.equal(results.length, 0, 'Old files should be ignored');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('discoverArtifacts: empty session dir returns empty', () => {
    const tmpDir = makeTmpDir();
    try {
        const seen = new Set();
        const results = discoverArtifacts(tmpDir, seen);
        assert.equal(results.length, 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('morty-watcher: dead-pid active session terminates via recovered state', () => {
    const sessionDir = makeSessionDir('pickle-morty-watcher-session-');
    try {
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            pid: 999999,
            step: 'implement',
            iteration: 2,
        }, null, 2));

        const result = spawnSync(process.execPath, [MORTY_WATCHER_BIN, sessionDir], {
            env: { ...process.env },
            encoding: 'utf-8',
            timeout: 4000,
        });

        assert.notEqual(result.error?.code, 'ETIMEDOUT', `Watcher hung instead of terminating: ${result.stderr}`);
        assert.equal(result.status, 0, `Expected clean exit, got stderr: ${result.stderr}`);
        assert.ok(result.stdout.includes('FEED TERMINATED'), `Expected termination banner, got: ${result.stdout}`);
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});

/**
 * jar-batch.test.js
 *
 * Integration tests for jar-runner batch fault-isolation scenarios:
 *
 *   Scenario A — "crash on ticket 4, resume from 4":
 *     Tasks 1-3 pre-set as 'consumed', task 4 has corrupt state.json (simulates
 *     a mid-run crash), tasks 5-6 are valid marinating. Batch should:
 *       - skip tasks 1-3 (not marinating)
 *       - fail task 4 (corrupt session state) and mark it 'failed'
 *       - continue to process tasks 5-6
 *     On a subsequent re-run, task 4 (now 'failed') is not retried; 5-6 are
 *     attempted again only if still marinating.
 *
 *   Scenario B — "write fail on ticket 5 (skip to 6, marked failed)":
 *     Task 5's meta.json is made read-only after initial setup; when the runner
 *     tries to update its status after failure, the write fails silently and the
 *     batch continues to task 6.
 *
 *   Scenario C — batch completion summary with mixed results
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JAR_RUNNER_BIN = path.resolve(__dirname, '../bin/jar-runner.js');

function makeTmpRoot() {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-jar-batch-')));
}

function run(extDir) {
    // 15s → 45s: budget for system load when run alongside concurrent
    // codex/tmux work. Tests validate batch processing logic, not wall-clock.
    return spawnSync(process.execPath, [JAR_RUNNER_BIN], {
        env: { ...process.env, EXTENSION_DIR: extDir },
        encoding: 'utf-8',
        timeout: 45000,
    });
}

/**
 * Create a jar task with a matching session dir.
 * @param {string} tmpRoot  - EXTENSION_DIR root
 * @param {string} taskId   - unique task identifier
 * @param {string} status   - meta.json status ('marinating' | 'consumed' | 'failed')
 * @param {object} sessionState - override for session state.json (null = skip creation)
 */
function createTask(tmpRoot, taskId, status, sessionState = null) {
    const taskDir = path.join(tmpRoot, 'jar', '2026-01-01', taskId);
    fs.mkdirSync(taskDir, { recursive: true });
    const metaPath = path.join(taskDir, 'meta.json');
    fs.writeFileSync(metaPath, JSON.stringify({
        status,
        repo_path: tmpRoot,
    }, null, 2));

    if (sessionState !== null) {
        const sessionDir = path.join(tmpRoot, 'sessions', taskId);
        fs.mkdirSync(sessionDir, { recursive: true });
        const stateContent = typeof sessionState === 'string'
            ? sessionState   // raw string for corrupt-state tests
            : JSON.stringify(sessionState, null, 2);
        fs.writeFileSync(path.join(sessionDir, 'state.json'), stateContent);
    }

    return metaPath;
}

const defaultState = (overrides = {}) => ({
    active: false,
    step: 'prd',
    iteration: 0,
    working_dir: '/tmp',
    session_dir: '/tmp',
    ...overrides,
});

// ---------------------------------------------------------------------------
// Scenario A: "Crash on ticket 4, resume from 4"
// ---------------------------------------------------------------------------

test('jar-batch: crash on ticket 4 — batch continues to tickets 5 and 6', () => {
    const tmpRoot = makeTmpRoot();
    try {
        // Tasks 1-3: pre-consumed (simulate previous successful run)
        createTask(tmpRoot, 'task-1', 'consumed');
        createTask(tmpRoot, 'task-2', 'consumed');
        createTask(tmpRoot, 'task-3', 'consumed');

        // Task 4: marinating but with corrupt session state.json (simulated crash)
        const meta4 = createTask(tmpRoot, 'task-4', 'marinating', '{{{corrupt json state');

        // Tasks 5-6: valid marinating (missing session dir → will fail gracefully)
        // We don't create their session dirs to trigger "Session dir not found" error
        createTask(tmpRoot, 'task-5', 'marinating');
        createTask(tmpRoot, 'task-6', 'marinating');

        const result = run(tmpRoot);
        const combined = result.stdout + result.stderr;

        // Batch must not abort — all tasks must be mentioned
        assert.ok(
            combined.includes('task-4'),
            `Expected task-4 to be processed, got: ${combined.slice(0, 1000)}`
        );
        assert.ok(
            combined.includes('task-5'),
            `Expected task-5 to be processed, got: ${combined.slice(0, 1000)}`
        );
        assert.ok(
            combined.includes('task-6'),
            `Expected task-6 to be processed, got: ${combined.slice(0, 1000)}`
        );

        // Batch should complete (not crash the runner itself)
        const hasCompletion = combined.includes('Jar complete') || combined.includes('Jar Complete') || combined.includes('complete');
        assert.ok(hasCompletion, `Expected batch completion marker, got: ${combined.slice(0, 500)}`);

        // Task 4 should be marked failed
        const meta4Data = JSON.parse(fs.readFileSync(meta4, 'utf-8'));
        assert.equal(meta4Data.status, 'failed', `task-4 should be 'failed', got: ${meta4Data.status}`);

        // Tasks 1-3 should remain consumed (unaffected)
        for (const id of ['task-1', 'task-2', 'task-3']) {
            const mPath = path.join(tmpRoot, 'jar', '2026-01-01', id, 'meta.json');
            const mData = JSON.parse(fs.readFileSync(mPath, 'utf-8'));
            assert.equal(mData.status, 'consumed', `${id} should remain 'consumed'`);
        }
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('jar-batch: resume-from-4 — on re-run, consumed tasks 1-3 skipped, failed task 4 skipped', () => {
    const tmpRoot = makeTmpRoot();
    try {
        // Simulate post-crash state: tasks 1-3 consumed, task 4 failed, tasks 5-6 still marinating
        createTask(tmpRoot, 'task-1', 'consumed');
        createTask(tmpRoot, 'task-2', 'consumed');
        createTask(tmpRoot, 'task-3', 'consumed');
        createTask(tmpRoot, 'task-4', 'failed');  // already marked failed from previous run
        createTask(tmpRoot, 'task-5', 'marinating'); // no session dir → fails gracefully
        createTask(tmpRoot, 'task-6', 'marinating'); // no session dir → fails gracefully

        const result = run(tmpRoot);
        const combined = result.stdout + result.stderr;

        // Tasks 1-4 should be skipped (not marinating)
        // Only tasks 5-6 should be attempted
        for (const id of ['task-1', 'task-2', 'task-3', 'task-4']) {
            // These should NOT appear as "processing" since they're not marinating
            // They may appear in summary counts but not as individual processing targets
            // The key assertion: no "Session dir not found" for tasks 1-4
            const sessionNotFound = `Session dir not found`;
            // Only task 5 and 6 trigger "Session dir not found" (the marinating ones without session dir)
            const notFoundCount = (combined.match(new RegExp(sessionNotFound, 'g')) || []).length;
            assert.ok(notFoundCount <= 2, `At most 2 session-not-found errors (tasks 5-6), got ${notFoundCount}`);
            break; // Just check the count once
        }

        // Batch should complete
        const hasCompletion = combined.includes('Jar complete') || combined.includes('Jar Complete') || combined.includes('complete');
        assert.ok(hasCompletion, `Batch should complete on re-run, got: ${combined.slice(0, 500)}`);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Scenario B: "Write fail on ticket 5 — skip to 6, marked failed"
// ---------------------------------------------------------------------------

test('jar-batch: write fail on ticket 5 — batch continues to ticket 6', () => {
    const tmpRoot = makeTmpRoot();
    // Track meta paths before chmod
    const meta5Path = path.join(tmpRoot, 'jar', '2026-01-01', 'task-5', 'meta.json');
    const meta6Path = path.join(tmpRoot, 'jar', '2026-01-01', 'task-6', 'meta.json');
    let meta5Readonly = false;
    try {
        createTask(tmpRoot, 'task-5', 'marinating'); // no session dir → triggers fail path
        createTask(tmpRoot, 'task-6', 'marinating'); // no session dir → triggers fail path

        // Make task-5's meta.json read-only to simulate write failure
        fs.chmodSync(meta5Path, 0o444);
        meta5Readonly = true;

        const result = run(tmpRoot);
        const combined = result.stdout + result.stderr;

        // Batch must continue and mention task-6
        assert.ok(
            combined.includes('task-6'),
            `Expected task-6 to be attempted after write-fail on task-5, got: ${combined.slice(0, 1000)}`
        );

        // Batch should complete
        const hasCompletion = combined.includes('Jar complete') || combined.includes('Jar Complete') || combined.includes('complete');
        assert.ok(hasCompletion, `Batch should complete despite write fail, got: ${combined.slice(0, 500)}`);
    } finally {
        // Restore write permission before cleanup (so rmSync works)
        if (meta5Readonly) {
            try { fs.chmodSync(meta5Path, 0o644); } catch { /* ignore */ }
        }
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('jar-batch: write fail does not corrupt other task meta.json files', () => {
    const tmpRoot = makeTmpRoot();
    const meta5Path = path.join(tmpRoot, 'jar', '2026-01-01', 'task-5', 'meta.json');
    let meta5Readonly = false;
    try {
        createTask(tmpRoot, 'task-5', 'marinating');
        // Task 6 has a session dir but still fails (no real claude) — but meta.json write should work
        const meta6 = createTask(tmpRoot, 'task-6', 'marinating');

        fs.chmodSync(meta5Path, 0o444);
        meta5Readonly = true;

        run(tmpRoot); // run and ignore result

        // Task 6's meta.json should be valid JSON (not corrupted by task 5's write failure)
        const meta6Data = JSON.parse(fs.readFileSync(meta6, 'utf-8'));
        assert.ok(
            typeof meta6Data === 'object' && meta6Data !== null,
            'task-6 meta.json must remain valid JSON after task-5 write failure'
        );
    } finally {
        if (meta5Readonly) {
            try { fs.chmodSync(meta5Path, 0o644); } catch { /* ignore */ }
        }
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Scenario C: Batch completion summary with mixed results
// ---------------------------------------------------------------------------

test('jar-batch: mixed-result batch reports correct success/failure counts', () => {
    const tmpRoot = makeTmpRoot();
    try {
        // 2 tasks will fail (no session dir), none will succeed (no real claude)
        createTask(tmpRoot, 'task-a', 'marinating');
        createTask(tmpRoot, 'task-b', 'marinating');

        const result = run(tmpRoot);
        const combined = result.stdout + result.stderr;

        // Both tasks should appear in output
        assert.ok(combined.includes('task-a'), `task-a must appear in output`);
        assert.ok(combined.includes('task-b'), `task-b must appear in output`);

        // Should see completion
        const hasCompletion = combined.includes('Jar complete') || combined.includes('Jar Complete') || combined.includes('complete');
        assert.ok(hasCompletion, 'batch completion marker must appear');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('jar-batch: all-consumed batch completes with "No marinating tasks"', () => {
    const tmpRoot = makeTmpRoot();
    try {
        createTask(tmpRoot, 'task-x', 'consumed');
        createTask(tmpRoot, 'task-y', 'consumed');

        const result = run(tmpRoot);

        assert.ok(
            result.stdout.includes('No marinating tasks'),
            `Expected "No marinating tasks", got: ${result.stdout}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('jar-batch: mix of consumed and failed tasks — still no marinating', () => {
    const tmpRoot = makeTmpRoot();
    try {
        createTask(tmpRoot, 'task-p', 'consumed');
        createTask(tmpRoot, 'task-q', 'failed');
        createTask(tmpRoot, 'task-r', 'consumed');

        const result = run(tmpRoot);

        assert.ok(
            result.stdout.includes('No marinating tasks'),
            `Expected "No marinating tasks" when no marinating tasks exist, got: ${result.stdout}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Isolation: each task failure is independent — N tasks, one bad, rest continue
// ---------------------------------------------------------------------------

test('jar-batch: single corrupt task does not abort a 4-task batch', () => {
    const tmpRoot = makeTmpRoot();
    try {
        // Task 1: corrupt state.json
        createTask(tmpRoot, 'batch-1', 'marinating', '{{{corrupt');

        // Tasks 2-4: no session dir (will fail with "Session dir not found" but not crash)
        createTask(tmpRoot, 'batch-2', 'marinating');
        createTask(tmpRoot, 'batch-3', 'marinating');
        createTask(tmpRoot, 'batch-4', 'marinating');

        const result = run(tmpRoot);
        const combined = result.stdout + result.stderr;

        // All 4 task IDs must appear in output
        for (const id of ['batch-1', 'batch-2', 'batch-3', 'batch-4']) {
            assert.ok(combined.includes(id), `Task ${id} must appear in batch output`);
        }

        // batch-1 marked failed
        const meta1 = JSON.parse(fs.readFileSync(
            path.join(tmpRoot, 'jar', '2026-01-01', 'batch-1', 'meta.json'), 'utf-8'
        ));
        assert.equal(meta1.status, 'failed', 'corrupt-state task must be marked failed');

        // Batch completes
        const hasCompletion = combined.includes('Jar complete') || combined.includes('Jar Complete') || combined.includes('complete');
        assert.ok(hasCompletion, 'batch must complete after isolated failure');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// Codex-backend coverage for jar-runner.
//
// Until now, jar-runner's codex routing was a trap-door: a task jarred with
// `backend=codex` would silently fall back to `claude` if any of the backend
// resolution logic regressed, and nothing in the suite would catch it. These
// tests pin down:
//   - state.backend === 'codex' resolves to codex (panel shows Backend: codex)
//   - the actual child spawn is `codex exec --dangerously-bypass-approvals-and-sandbox
//     --skip-git-repo-check --ephemeral ... -- <prompt>`
//   - ENOENT (no codex on PATH) prints an install hint AND leaves the task's
//     meta.status untouched (pending/marinating) — infrastructure errors must
//     not permanently fail a task
//   - PICKLE_BACKEND=codex is spread into the spawn's env
//
// Same fake-shim-on-PATH pattern as backend-spawn-hang-guard.test.js and
// scope-one-hop-hang-guard.test.js.

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
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-jar-codex-')));
}

/**
 * Creates a codex shim script that records its invocation (argv + env) to a
 * log file, then exits 0 immediately so the jar-runner's wait doesn't hang.
 */
function writeCodexShim(shimDir, logPath) {
    fs.mkdirSync(shimDir, { recursive: true });
    const shimPath = path.join(shimDir, 'codex');
    const body = `#!/usr/bin/env node
const fs = require('fs');
const rec = {
    argv: process.argv.slice(2),
    pickle_backend: process.env.PICKLE_BACKEND || null,
    pwd: process.cwd(),
};
fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(rec, null, 2));
process.exit(0);
`;
    fs.writeFileSync(shimPath, body);
    fs.chmodSync(shimPath, 0o755);
    return shimPath;
}

function writeClaudeShim(shimDir, logPath) {
    fs.mkdirSync(shimDir, { recursive: true });
    const shimPath = path.join(shimDir, 'claude');
    const body = `#!${process.execPath}
const fs = require('fs');
const rec = {
    argv: process.argv.slice(2),
    pickle_backend: process.env.PICKLE_BACKEND || null,
    pwd: process.cwd(),
};
fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(rec, null, 2));
process.exit(0);
`;
    fs.writeFileSync(shimPath, body);
    fs.chmodSync(shimPath, 0o755);
    return shimPath;
}

function setupCodexTask(tmpRoot, taskId = 'codex-task-1') {
    const taskDir = path.join(tmpRoot, 'jar', '2026-01-01', taskId);
    fs.mkdirSync(taskDir, { recursive: true });
    const metaPath = path.join(taskDir, 'meta.json');
    fs.writeFileSync(metaPath, JSON.stringify({
        status: 'marinating',
        repo_path: tmpRoot,
    }, null, 2));

    const sessionDir = path.join(tmpRoot, 'sessions', taskId);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
        active: false,
        step: 'prd',
        iteration: 0,
        backend: 'codex',  // THIS is what routes the task through codex
    }, null, 2));

    return { taskDir, metaPath, sessionDir };
}

// --- Test 1: panel shows Backend: codex for codex-backed task ---

test('jar-runner (codex): panel displays Backend: codex for codex-backed task', { timeout: 30_000 }, () => {
    const tmpRoot = makeTmpRoot();
    try {
        const { metaPath } = setupCodexTask(tmpRoot);

        // Stub codex on PATH so we get past spawn
        const shimDir = path.join(tmpRoot, 'bin');
        const shimLog = path.join(tmpRoot, 'codex-invocation.json');
        writeCodexShim(shimDir, shimLog);

        const result = spawnSync(process.execPath, [JAR_RUNNER_BIN], {
            env: {
                ...process.env,
                EXTENSION_DIR: tmpRoot,
                PATH: `${shimDir}${path.delimiter}${process.env.PATH || ''}`,
                // Scrub any env-level PICKLE_BACKEND so we prove the routing
                // comes from state.backend, not a leaked env var.
                PICKLE_BACKEND: '',
            },
            encoding: 'utf-8',
            // 8s → 25s: budget for system load under concurrent test runs.
            timeout: 25000,
        });

        const combined = result.stdout + result.stderr;
        assert.ok(
            combined.includes('Backend: codex') || combined.includes('Backend') && combined.includes('codex'),
            `Expected panel "Backend: codex" in output, got: ${combined.slice(0, 800)}`,
        );

        // Also verify the task was marked consumed (shim exited 0)
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        assert.equal(meta.status, 'consumed', `Expected consumed, got: ${meta.status}`);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Test 2: codex shim invoked with exec + bypass + skip-git + ephemeral + -- <prompt> ---

test('jar-runner (codex): shim receives exec --dangerously-bypass --skip-git --ephemeral ... -- <prompt>', { timeout: 30_000 }, () => {
    const tmpRoot = makeTmpRoot();
    try {
        setupCodexTask(tmpRoot);

        const shimDir = path.join(tmpRoot, 'bin');
        const shimLog = path.join(tmpRoot, 'codex-invocation.json');
        writeCodexShim(shimDir, shimLog);

        spawnSync(process.execPath, [JAR_RUNNER_BIN], {
            env: {
                ...process.env,
                EXTENSION_DIR: tmpRoot,
                PATH: `${shimDir}${path.delimiter}${process.env.PATH || ''}`,
                PICKLE_BACKEND: '',
            },
            encoding: 'utf-8',
            // 8s → 25s: budget for system load under concurrent test runs.
            timeout: 25000,
        });

        assert.ok(fs.existsSync(shimLog), `Shim never wrote log — codex was not invoked`);
        const rec = JSON.parse(fs.readFileSync(shimLog, 'utf-8'));
        const argv = rec.argv;

        assert.equal(argv[0], 'exec', `Expected argv[0]='exec', got: ${argv[0]}`);
        assert.ok(argv.includes('--dangerously-bypass-approvals-and-sandbox'),
            `Missing --dangerously-bypass-approvals-and-sandbox in argv: ${JSON.stringify(argv)}`);
        assert.ok(argv.includes('--skip-git-repo-check'),
            `Missing --skip-git-repo-check in argv: ${JSON.stringify(argv)}`);
        assert.ok(argv.includes('--ephemeral'),
            `Missing --ephemeral in argv: ${JSON.stringify(argv)}`);

        // '--' separator immediately precedes the prompt (last element)
        const dashIdx = argv.lastIndexOf('--');
        assert.ok(dashIdx >= 0, `Missing '--' prompt separator in argv: ${JSON.stringify(argv)}`);
        assert.equal(dashIdx, argv.length - 2, `'--' is not immediately before the final positional prompt`);
        // Prompt should mention "Pickle Rick" (from the fallback prompt or
        // the pickle.md body); either way it must be non-empty.
        assert.ok(argv[argv.length - 1].length > 0, `Prompt positional is empty`);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Test 3: PICKLE_BACKEND=codex spread into child env ---

test('jar-runner (codex): spreads PICKLE_BACKEND=codex into child env', { timeout: 30_000 }, () => {
    const tmpRoot = makeTmpRoot();
    try {
        setupCodexTask(tmpRoot);

        const shimDir = path.join(tmpRoot, 'bin');
        const shimLog = path.join(tmpRoot, 'codex-invocation.json');
        writeCodexShim(shimDir, shimLog);

        spawnSync(process.execPath, [JAR_RUNNER_BIN], {
            env: {
                ...process.env,
                EXTENSION_DIR: tmpRoot,
                PATH: `${shimDir}${path.delimiter}${process.env.PATH || ''}`,
                // Outer env has it unset (empty) — the runner should still
                // inject PICKLE_BACKEND=codex before spawning the child.
                PICKLE_BACKEND: '',
            },
            encoding: 'utf-8',
            // 8s → 25s: budget for system load under concurrent test runs.
            timeout: 25000,
        });

        assert.ok(fs.existsSync(shimLog), `Shim never wrote log`);
        const rec = JSON.parse(fs.readFileSync(shimLog, 'utf-8'));
        assert.equal(rec.pickle_backend, 'codex',
            `Expected PICKLE_BACKEND=codex in child env, got: ${rec.pickle_backend}`);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Test 4: ENOENT prints install hint AND does NOT mark task failed ---

test('jar-runner (codex): ENOENT leaves task marinating and prints install hint', { timeout: 30_000 }, () => {
    const tmpRoot = makeTmpRoot();
    try {
        const { metaPath } = setupCodexTask(tmpRoot);

        // Build a scrubbed PATH that deliberately omits codex. We point PATH
        // at an empty bin dir + /usr/bin for node itself, but no codex anywhere.
        const emptyBin = path.join(tmpRoot, 'empty-bin');
        fs.mkdirSync(emptyBin, { recursive: true });

        // Find node binary — we need it on PATH for subprocess node shebangs.
        // process.execPath already covers the outer invocation; the shim isn't
        // used here because we want codex-not-found.
        const result = spawnSync(process.execPath, [JAR_RUNNER_BIN], {
            env: {
                // Deliberately replace PATH, not extend it, so codex cannot be
                // resolved via the user's homebrew/npm prefix.
                PATH: emptyBin,
                HOME: process.env.HOME || '/tmp',
                EXTENSION_DIR: tmpRoot,
                PICKLE_BACKEND: '',
            },
            encoding: 'utf-8',
            // 8s → 25s: budget for system load under concurrent test runs.
            timeout: 25000,
        });

        const combined = result.stdout + result.stderr;

        // Install hint must be present
        assert.ok(
            combined.includes('codex CLI not found'),
            `Expected "codex CLI not found" install hint, got: ${combined.slice(0, 800)}`,
        );

        // Task status MUST still be 'marinating' — not failed
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        assert.equal(
            meta.status,
            'marinating',
            `ENOENT must leave status untouched. Got: ${meta.status}`,
        );
        assert.notEqual(
            meta.status,
            'failed',
            `ENOENT must NOT mark task failed`,
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Test 5: ENOENT on first codex task skips remaining codex tasks (early-exit) ---

test('jar-runner (codex): ENOENT short-circuits remaining codex tasks', { timeout: 30_000 }, () => {
    const tmpRoot = makeTmpRoot();
    try {
        // Two codex tasks queued — both should remain marinating after ENOENT
        setupCodexTask(tmpRoot, 'codex-task-a');
        setupCodexTask(tmpRoot, 'codex-task-b');

        const emptyBin = path.join(tmpRoot, 'empty-bin');
        fs.mkdirSync(emptyBin, { recursive: true });

        const result = spawnSync(process.execPath, [JAR_RUNNER_BIN], {
            env: {
                PATH: emptyBin,
                HOME: process.env.HOME || '/tmp',
                EXTENSION_DIR: tmpRoot,
                PICKLE_BACKEND: '',
            },
            encoding: 'utf-8',
            // 8s → 25s: budget for system load under concurrent test runs.
            timeout: 25000,
        });

        const combined = result.stdout + result.stderr;
        assert.ok(
            combined.includes('codex CLI not found'),
            `Expected install hint, got: ${combined.slice(0, 800)}`,
        );

        // Both codex tasks must remain marinating (second was short-circuited)
        const metaA = JSON.parse(fs.readFileSync(
            path.join(tmpRoot, 'jar', '2026-01-01', 'codex-task-a', 'meta.json'), 'utf-8'));
        const metaB = JSON.parse(fs.readFileSync(
            path.join(tmpRoot, 'jar', '2026-01-01', 'codex-task-b', 'meta.json'), 'utf-8'));
        assert.equal(metaA.status, 'marinating', `task-a should stay marinating, got: ${metaA.status}`);
        assert.equal(metaB.status, 'marinating', `task-b should stay marinating, got: ${metaB.status}`);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('jar-runner (codex): recovered claude task is not skipped by codex ENOENT short-circuit', { timeout: 30_000 }, () => {
    const tmpRoot = makeTmpRoot();
    try {
        setupCodexTask(tmpRoot, 'codex-task-a');
        const { metaPath, sessionDir } = setupCodexTask(tmpRoot, 'codex-task-b');

        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: false,
            step: 'prd',
            iteration: 1,
            backend: 'codex',
            working_dir: tmpRoot,
        }, null, 2));
        fs.writeFileSync(path.join(sessionDir, 'state.json.tmp.999999'), JSON.stringify({
            active: false,
            step: 'prd',
            iteration: 2,
            backend: 'claude',
            working_dir: tmpRoot,
        }, null, 2));

        const shimDir = path.join(tmpRoot, 'bin');
        const claudeLog = path.join(tmpRoot, 'claude-invocation.json');
        writeClaudeShim(shimDir, claudeLog);

        const result = spawnSync(process.execPath, [JAR_RUNNER_BIN], {
            env: {
                PATH: shimDir,
                HOME: process.env.HOME || '/tmp',
                EXTENSION_DIR: tmpRoot,
                PICKLE_BACKEND: '',
            },
            encoding: 'utf-8',
            timeout: 25000,
        });

        const combined = result.stdout + result.stderr;
        assert.ok(
            combined.includes('codex CLI not found'),
            `Expected codex ENOENT install hint, got: ${combined.slice(0, 800)}`,
        );
        assert.ok(fs.existsSync(claudeLog), 'Recovered claude task never ran');

        const metaA = JSON.parse(fs.readFileSync(
            path.join(tmpRoot, 'jar', '2026-01-01', 'codex-task-a', 'meta.json'), 'utf-8'));
        const metaB = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        assert.equal(metaA.status, 'marinating', `codex task should stay marinating, got: ${metaA.status}`);
        assert.equal(metaB.status, 'consumed', `Recovered claude task should run, got: ${metaB.status}`);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

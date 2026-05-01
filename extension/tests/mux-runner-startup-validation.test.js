import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateStartupState } from '../bin/mux-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MUX_RUNNER_BIN = path.resolve(__dirname, '../bin/mux-runner.js');

function makeTmpRoot() {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-sv-')));
}

function run(sessionDir, extDir) {
    // 10s → 45s: budget for system load when run alongside concurrent
    // codex/tmux work. Tests validate startup error paths, not wall-clock.
    return spawnSync(process.execPath, [MUX_RUNNER_BIN, sessionDir], {
        env: { ...process.env, EXTENSION_DIR: extDir },
        encoding: 'utf-8',
        timeout: 45000,
    });
}

function makeSessionDir(root, stateOverrides) {
    const sessionDir = path.join(root, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });
    const base = {
        active: true,
        working_dir: root,
        step: 'implement',
        iteration: 0,
        max_iterations: 10,
        max_time_minutes: 720,
        worker_timeout_seconds: 1200,
        start_time_epoch: Math.floor(Date.now() / 1000),
        completion_promise: null,
        original_prompt: 'test',
        current_ticket: null,
        history: [],
        started_at: new Date().toISOString(),
        session_dir: sessionDir,
    };
    const state = Object.assign({}, base, stateOverrides);
    // For "missing" field tests, delete the key if override value is Symbol('delete')
    for (const [k, v] of Object.entries(state)) {
        if (typeof v === 'symbol') delete state[k];
    }
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(state, null, 2));
    return sessionDir;
}

const DEL = Symbol('delete');

// --- max_iterations validation ---

for (const [label, value] of [
    ['negative', -1],
    ['NaN', NaN],
    ['missing', DEL],
]) {
    test(`startup-validation: max_iterations=${label} → exit 2`, () => {
        const root = makeTmpRoot();
        try {
            const sessionDir = makeSessionDir(root, { max_iterations: value });
            const result = run(sessionDir, root);
            assert.equal(result.status, 2, `Expected exit 2, got ${result.status}. stderr: ${result.stderr}`);
            assert.ok(
                result.stderr.includes('max_iterations'),
                `Expected stderr to mention max_iterations. Got: ${result.stderr}`,
            );
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
}

test('startup-validation: setup tmux max_iterations=0 is accepted as unlimited', () => {
    const root = makeTmpRoot();
    try {
        const sessionDir = makeSessionDir(root, { max_iterations: 0 });
        const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
        assert.doesNotThrow(() => validateStartupState(state, path.join(sessionDir, 'state.json')));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

// --- worker_timeout_seconds validation ---

for (const [label, value] of [
    ['zero', 0],
    ['negative', -1],
    ['86401 (implausible)', 86401],
    ['NaN', NaN],
    ['missing', DEL],
]) {
    test(`startup-validation: worker_timeout_seconds=${label} → exit 2`, () => {
        const root = makeTmpRoot();
        try {
            const sessionDir = makeSessionDir(root, { worker_timeout_seconds: value });
            const result = run(sessionDir, root);
            assert.equal(result.status, 2, `Expected exit 2, got ${result.status}. stderr: ${result.stderr}`);
            assert.ok(
                result.stderr.includes('worker_timeout_seconds'),
                `Expected stderr to mention worker_timeout_seconds. Got: ${result.stderr}`,
            );
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
}

// 86400 is the boundary — must be accepted
test('startup-validation: worker_timeout_seconds=86400 → not exit 2', () => {
    const root = makeTmpRoot();
    try {
        // iteration=max_iterations so it exits 0 immediately after validation passes
        const sessionDir = makeSessionDir(root, { worker_timeout_seconds: 86400, iteration: 10, max_iterations: 10 });
        const result = run(sessionDir, root);
        assert.notEqual(result.status, 2, `Expected exit != 2 for boundary value 86400, got: ${result.stderr}`);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

// --- iteration validation ---

for (const [label, value] of [
    ['negative', -1],
    ['NaN', NaN],
    ['missing', DEL],
]) {
    test(`startup-validation: iteration=${label} → exit 2`, () => {
        const root = makeTmpRoot();
        try {
            const sessionDir = makeSessionDir(root, { iteration: value });
            const result = run(sessionDir, root);
            assert.equal(result.status, 2, `Expected exit 2, got ${result.status}. stderr: ${result.stderr}`);
            assert.ok(
                result.stderr.includes('iteration'),
                `Expected stderr to mention iteration. Got: ${result.stderr}`,
            );
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
}

// iteration=0 is valid
test('startup-validation: iteration=0 → not exit 2', () => {
    const root = makeTmpRoot();
    try {
        const sessionDir = makeSessionDir(root, { iteration: 10, max_iterations: 10 });
        const result = run(sessionDir, root);
        assert.notEqual(result.status, 2, `Expected exit != 2 for iteration=0. stderr: ${result.stderr}`);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

// --- Multiple issues surfaced together ---

test('startup-validation: multiple bad fields → all issues in stderr', () => {
    const root = makeTmpRoot();
    try {
        const sessionDir = makeSessionDir(root, {
            max_iterations: -1,
            worker_timeout_seconds: 0,
            iteration: -1,
        });
        const result = run(sessionDir, root);
        assert.equal(result.status, 2, `Expected exit 2, got ${result.status}. stderr: ${result.stderr}`);
        // All three issues must appear in a single stderr write
        assert.ok(result.stderr.includes('max_iterations'), `Missing max_iterations in: ${result.stderr}`);
        assert.ok(result.stderr.includes('worker_timeout_seconds'), `Missing worker_timeout_seconds in: ${result.stderr}`);
        assert.ok(result.stderr.includes('iteration'), `Missing iteration in: ${result.stderr}`);
        // Count bullet points — should have exactly 3
        const bulletCount = (result.stderr.match(/^\s*-\s/gm) || []).length;
        assert.equal(bulletCount, 3, `Expected 3 bullet lines in stderr, got ${bulletCount}:\n${result.stderr}`);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

// --- No spawn attempted before validation ---

test('startup-validation: invalid state → no claude child spawned', () => {
    const root = makeTmpRoot();
    try {
        const sessionDir = makeSessionDir(root, { max_iterations: -1 });
        const result = run(sessionDir, root);
        assert.equal(result.status, 2);
        // If no spawn was attempted, there's no iteration log file
        const iterLog = path.join(sessionDir, 'tmux_iteration_1.log');
        assert.ok(!fs.existsSync(iterLog), `Iteration log should not exist when validation fails`);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

// --- Valid state passes validation (sanity) ---

test('startup-validation: valid state → passes validation (not exit 2)', () => {
    const root = makeTmpRoot();
    try {
        // Set iteration=max_iterations so it exits cleanly at the loop ceiling
        const sessionDir = makeSessionDir(root, { iteration: 10, max_iterations: 10 });
        const result = run(sessionDir, root);
        assert.notEqual(result.status, 2, `Valid state should not exit 2. stderr: ${result.stderr}`);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('startup-validation: tmux ownership stamps runner pid into state.json', () => {
    const root = makeTmpRoot();
    try {
        const sessionDir = makeSessionDir(root, {
            active: false,
            tmux_mode: true,
            iteration: 10,
            max_iterations: 10,
        });
        const result = run(sessionDir, root);
        assert.notEqual(result.status, 2, `Ownership path should pass validation. stderr: ${result.stderr}`);

        const finalState = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
        assert.equal(finalState.active, false, 'runner should still deactivate on the loop ceiling');
        assert.equal(typeof finalState.pid, 'number', `Expected numeric pid stamp, got: ${JSON.stringify(finalState)}`);
        assert.ok(finalState.pid > 0, `Expected positive pid stamp, got: ${finalState.pid}`);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

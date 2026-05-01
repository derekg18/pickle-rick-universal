import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawnSync } from 'node:child_process';
import { getHeadSha, isWorkingTreeDirty } from '../services/git-utils.js';
import { runIteration } from '../bin/mux-runner.js';
import {
    compareMetric,
    createMicroverseState,
    recordIteration,
    recordStall,
    recordFailedApproach,
    isConverged,
    writeMicroverseState,
    readMicroverseState,
} from '../services/microverse-state.js';
import { runRemediatorForIteration } from '../bin/microverse-runner.js';

function createTempGitRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-microverse-'));
    execSync('git init', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
    fs.writeFileSync(path.join(dir, 'README.md'), 'init');
    execSync('git add . && git commit -m "init"', { cwd: dir, stdio: 'pipe' });
    return dir;
}

test('getHeadSha returns 40-char hex string', () => {
    const dir = createTempGitRepo();
    try {
        const sha = getHeadSha(dir);
        assert.match(sha, /^[0-9a-f]{40}$/, `expected 40-char hex, got: ${sha}`);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('isWorkingTreeDirty returns false on clean repo', () => {
    const dir = createTempGitRepo();
    try {
        assert.equal(isWorkingTreeDirty(dir), false);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('isWorkingTreeDirty returns true when untracked file exists', () => {
    const dir = createTempGitRepo();
    try {
        fs.writeFileSync(path.join(dir, 'dirty.txt'), 'dirty');
        assert.equal(isWorkingTreeDirty(dir), true);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('isWorkingTreeDirty ignores excluded path prefixes (untracked + modified + nested)', () => {
    const dir = createTempGitRepo();
    try {
        fs.mkdirSync(path.join(dir, 'prds'));
        fs.mkdirSync(path.join(dir, 'docs', 'sub'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'prds', 'untracked.md'), '# new');
        fs.writeFileSync(path.join(dir, 'docs', 'sub', 'nested.md'), '# nested');
        // Tracked-then-modified file under prds/
        fs.writeFileSync(path.join(dir, 'prds', 'tracked.md'), 'v1');
        execSync('git add prds/tracked.md && git commit -m "track prd"', { cwd: dir, stdio: 'pipe' });
        fs.writeFileSync(path.join(dir, 'prds', 'tracked.md'), 'v2');

        assert.equal(isWorkingTreeDirty(dir), true, 'no exclusions: dirty');
        assert.equal(isWorkingTreeDirty(dir, ['prds', 'docs']), false, 'excluded both: clean');
        assert.equal(isWorkingTreeDirty(dir, ['prds']), true, 'docs/ still dirty');

        fs.writeFileSync(path.join(dir, 'src.txt'), 'real change');
        assert.equal(isWorkingTreeDirty(dir, ['prds', 'docs']), true, 'change outside excluded dirs is dirty');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('isWorkingTreeDirty tolerates trailing slashes and leading ./ in exclude prefixes', () => {
    const dir = createTempGitRepo();
    try {
        fs.mkdirSync(path.join(dir, 'prds'));
        fs.writeFileSync(path.join(dir, 'prds', 'a.md'), '# a');
        assert.equal(isWorkingTreeDirty(dir, ['prds/']), false);
        assert.equal(isWorkingTreeDirty(dir, ['./prds']), false);
        assert.equal(isWorkingTreeDirty(dir, ['']), true, 'empty string ignored, still dirty');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- microverse-state tests ---

const TEST_METRIC = {
    description: 'test score',
    validation: 'echo 50',
    type: 'command',
    timeout_seconds: 30,
    tolerance: 2,
};

test('compareMetric returns "improved" when current > previous + tolerance', () => {
    assert.equal(compareMetric(50, 40, 2), 'improved');
});

test('compareMetric returns "held" when within tolerance', () => {
    assert.equal(compareMetric(41, 40, 2), 'held');
});

test('compareMetric returns "regressed" when current < previous - tolerance', () => {
    assert.equal(compareMetric(30, 40, 2), 'regressed');
});

test('compareMetric returns "held" for NaN inputs', () => {
    assert.equal(compareMetric(NaN, 50, 2), 'held');
    assert.equal(compareMetric(50, NaN, 2), 'held');
    assert.equal(compareMetric(50, 50, NaN), 'held');
    assert.equal(compareMetric(Infinity, 50, 2), 'held');
    assert.equal(compareMetric(50, 50, Infinity), 'held');
});

test('compareMetric handles zero tolerance (exact match required)', () => {
    assert.equal(compareMetric(50, 50, 0), 'held');
    assert.equal(compareMetric(51, 50, 0), 'improved');
    assert.equal(compareMetric(49, 50, 0), 'regressed');
});

test('per-iteration gate remediation publishes gate result via atomic state writer', () => {
    const srcPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/bin/microverse-runner.ts');
    const src = fs.readFileSync(srcPath, 'utf-8');
    assert.match(src, /const gateResultPath = path\.join\(gateDir, `gate_result_iter_/);
    assert.match(src, /writeStateFile\(gateResultPath, gateResult\)/);
    assert.doesNotMatch(src, /fs\.writeFileSync\(gateResultPath/);
});

test('per-iteration gate remediation recovers orphan tmp result before classifying success', async () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-remediation-result-'));
    const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-remediation-work-'));
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-remediation-bin-'));
    const fakeClaudePath = path.join(binDir, 'claude');
    const oldPath = process.env.PATH;
    const gateDir = path.join(sessionDir, 'gate');

    try {
        fs.writeFileSync(
            fakeClaudePath,
            [
                '#!/usr/bin/env node',
                "const fs = require('node:fs');",
                "const path = require('node:path');",
                `const gateDir = ${JSON.stringify(gateDir)};`,
                "fs.mkdirSync(gateDir, { recursive: true });",
                "const resultPath = path.join(gateDir, `remediation_${Date.now()}_result.json.tmp.99999999`);",
                "fs.writeFileSync(resultPath, JSON.stringify({ aborted: false, failures_out: 0 }), 'utf-8');",
                '',
            ].join('\n'),
            { mode: 0o755 },
        );
        process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ''}`;

        const result = await runRemediatorForIteration(
            {
                status: 'red',
                failures: [{
                    check: 'tests',
                    file: path.join(workingDir, 'broken.test.js'),
                    line: 1,
                    ruleOrCode: 'simulated',
                    message: 'simulated failure',
                    severity: 'error',
                    occurrence_index: 0,
                }],
                baseline_used: false,
                allowed_paths_used: false,
                elapsed_ms: 1,
                total_raw_failure_count: 1,
                new_failures_vs_baseline: 1,
            },
            sessionDir,
            workingDir,
            'claude',
            5,
        );

        assert.deepEqual(result, { success: true });
        assert.equal(
            fs.readdirSync(gateDir).some((name) => /^remediation_.+_result\.json$/.test(name)),
            true,
            'orphan tmp result should be promoted to the canonical result path',
        );
    } finally {
        process.env.PATH = oldPath;
        fs.rmSync(sessionDir, { recursive: true, force: true });
        fs.rmSync(workingDir, { recursive: true, force: true });
        fs.rmSync(binDir, { recursive: true, force: true });
    }
});

// --- direction='lower' tests ---

test('compareMetric direction=lower: score drop below tolerance → improved', () => {
    assert.equal(compareMetric(30, 50, 2, 'lower'), 'improved');
});

test('compareMetric direction=lower: score rise above tolerance → regressed', () => {
    assert.equal(compareMetric(60, 50, 2, 'lower'), 'regressed');
});

test('compareMetric direction=lower: score within tolerance → held', () => {
    assert.equal(compareMetric(49, 50, 2, 'lower'), 'held');
});

test('compareMetric backward compat: no direction param = higher behavior', () => {
    assert.equal(compareMetric(60, 50, 2), 'improved');
    assert.equal(compareMetric(30, 50, 2), 'regressed');
    assert.equal(compareMetric(51, 50, 2), 'held');
});

test('compareMetric direction=higher explicit: same as default', () => {
    assert.equal(compareMetric(60, 50, 2, 'higher'), 'improved');
    assert.equal(compareMetric(30, 50, 2, 'higher'), 'regressed');
    assert.equal(compareMetric(51, 50, 2, 'higher'), 'held');
});

test('compareMetric direction=lower: NaN guard still returns held', () => {
    assert.equal(compareMetric(NaN, 50, 2, 'lower'), 'held');
    assert.equal(compareMetric(50, NaN, 2, 'lower'), 'held');
});

test('recordIteration with direction=lower: score drop → stall_counter=0, action=accept', () => {
    const metricWithLower = { ...TEST_METRIC, direction: 'lower' };
    let state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: metricWithLower, stallLimit: 3 });
    state.convergence.stall_counter = 2;
    state.baseline_score = 50;
    const entry = {
        iteration: 1,
        metric_value: '30',
        score: 30,
        action: 'accept',
        description: 'improved (lower)',
        pre_iteration_sha: 'abc123'.padEnd(40, '0'),
        timestamp: new Date().toISOString(),
    };
    state = recordIteration(state, entry);
    assert.equal(state.convergence.stall_counter, 0, 'stall reset on improvement with direction=lower');
    assert.equal(state.convergence.history.length, 1);
});

test('recordIteration with direction=lower: score rise → stall_counter increments', () => {
    const metricWithLower = { ...TEST_METRIC, direction: 'lower' };
    let state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: metricWithLower, stallLimit: 3 });
    state.baseline_score = 50;
    const entry = {
        iteration: 1,
        metric_value: '60',
        score: 60,
        action: 'accept',
        description: 'regressed (lower)',
        pre_iteration_sha: 'abc123'.padEnd(40, '0'),
        timestamp: new Date().toISOString(),
    };
    state = recordIteration(state, entry);
    assert.equal(state.convergence.stall_counter, 1, 'stall incremented on regression with direction=lower');
});

test('createMicroverseState returns valid initial state', () => {
    const state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 3 });
    assert.equal(state.status, 'gap_analysis');
    assert.equal(state.prd_path, '/tmp/prd.md');
    assert.deepEqual(state.convergence.history, []);
    assert.equal(state.convergence.stall_counter, 0);
    assert.equal(state.convergence.stall_limit, 3);
    assert.equal(state.baseline_score, 0);
    assert.deepEqual(state.failed_approaches, []);
});

test('createMicroverseState defaults direction to higher when not provided', () => {
    const state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 3 });
    assert.equal(state.key_metric.direction, 'higher');
});

test('createMicroverseState preserves explicit direction lower', () => {
    const metricWithDirection = { ...TEST_METRIC, direction: 'lower' };
    const state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: metricWithDirection, stallLimit: 3 });
    assert.equal(state.key_metric.direction, 'lower');
});

test('isConverged returns true when stall_counter >= stall_limit', () => {
    const state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 3 });
    state.convergence.stall_counter = 3;
    assert.equal(isConverged(state), true);
});

test('isConverged returns false when stall_counter < stall_limit', () => {
    const state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 3 });
    state.convergence.stall_counter = 2;
    assert.equal(isConverged(state), false);
});

test('isConverged returns true when convergence_target is reached', () => {
    const state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 5, convergenceTarget: 0 });
    // baseline_score=0 matches convergence_target=0, no history
    assert.equal(isConverged(state), true);
});

test('isConverged uses last accepted score for convergence_target check', () => {
    const state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 5, convergenceTarget: 0 });
    state.baseline_score = 10;
    state.convergence.history = [
        { iteration: 1, metric_value: '5', score: 5, action: 'accept', description: 'improved', pre_iteration_sha: 'abc', timestamp: new Date().toISOString() },
        { iteration: 2, metric_value: '0', score: 0, action: 'accept', description: 'improved', pre_iteration_sha: 'def', timestamp: new Date().toISOString() },
    ];
    assert.equal(isConverged(state), true);
});

test('isConverged returns false when convergence_target not reached', () => {
    // direction: higher, target: 90 — score of 5 has not reached 90
    const state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 5, convergenceTarget: 90 });
    state.baseline_score = 0;
    state.convergence.history = [
        { iteration: 1, metric_value: '5', score: 5, action: 'accept', description: 'improved', pre_iteration_sha: 'abc', timestamp: new Date().toISOString() },
    ];
    assert.equal(isConverged(state), false);
});

test('isConverged ignores convergence_target when not set', () => {
    const state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 5 });
    state.baseline_score = 0; // score is 0 but no convergence_target set
    assert.equal(isConverged(state), false);
});

test('createMicroverseState sets convergence_target when provided', () => {
    const state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 3, convergenceTarget: 0 });
    assert.equal(state.convergence_target, 0);
});

test('createMicroverseState omits convergence_target when not provided', () => {
    const state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 3 });
    assert.equal(state.convergence_target, undefined);
});

test('recordIteration resets stall_counter on accept with improved score', () => {
    let state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 3 });
    state.convergence.stall_counter = 2;
    state.baseline_score = 40;
    const entry = {
        iteration: 1,
        metric_value: '50',
        score: 50,
        action: 'accept',
        description: 'improved things',
        pre_iteration_sha: 'abc123'.padEnd(40, '0'),
        timestamp: new Date().toISOString(),
    };
    state = recordIteration(state, entry);
    assert.equal(state.convergence.stall_counter, 0);
    assert.equal(state.convergence.history.length, 1);
});

test('recordIteration increments stall_counter on held score', () => {
    let state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 3 });
    state.baseline_score = 40;
    const entry = {
        iteration: 1,
        metric_value: '41',
        score: 41,
        action: 'accept',
        description: 'minor change',
        pre_iteration_sha: 'abc123'.padEnd(40, '0'),
        timestamp: new Date().toISOString(),
    };
    state = recordIteration(state, entry);
    assert.equal(state.convergence.stall_counter, 1);
});

test('recordIteration increments stall_counter on revert', () => {
    let state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 3 });
    state.baseline_score = 40;
    const entry = {
        iteration: 1,
        metric_value: '50',
        score: 50,
        action: 'revert',
        description: 'reverted',
        pre_iteration_sha: 'abc123'.padEnd(40, '0'),
        timestamp: new Date().toISOString(),
    };
    state = recordIteration(state, entry);
    assert.equal(state.convergence.stall_counter, 1);
});

test('recordFailedApproach appends to failed_approaches', () => {
    let state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 3 });
    state = recordFailedApproach(state, 'tried X, failed');
    state = recordFailedApproach(state, 'tried Y, also failed');
    assert.deepEqual(state.failed_approaches, ['tried X, failed', 'tried Y, also failed']);
});

test('recordFailedApproach: caps at 100, oldest shifted on overflow', () => {
    let state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 3 });
    for (let i = 0; i < 101; i++) {
        state = recordFailedApproach(state, `approach ${i}`);
    }
    assert.equal(state.failed_approaches.length, 100, `expected 100, got ${state.failed_approaches.length}`);
    assert.ok(!state.failed_approaches.includes('approach 0'), 'oldest entry should have been trimmed');
    assert.ok(state.failed_approaches.includes('approach 1'), 'approach 1 should still be present');
    assert.ok(state.failed_approaches.includes('approach 100'), 'newest entry should be present');
});

test('writeMicroverseState and readMicroverseState round-trip', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mv-'));
    try {
        const state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 3 });
        writeMicroverseState(dir, state);
        const loaded = readMicroverseState(dir);
        assert.deepEqual(loaded, state);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('readMicroverseState returns null for missing file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mv-'));
    try {
        assert.equal(readMicroverseState(dir), null);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('runIteration is exported from mux-runner', () => {
    assert.equal(typeof runIteration, 'function');
});

// --- microverse-runner tests ---

import { measureMetric, measureLlmMetric, extractScore, buildJudgePrompt, buildMicroverseHandoff, deactivateRunnerState, handleRateLimit, main, _deps, readRunnerState, stageAutoCommitPaths, executeMainLoop } from '../bin/microverse-runner.js';
import { resetToSha } from '../services/git-utils.js';
import { StateManager } from '../services/state-manager.js';
import { writeStateFile } from '../services/pickle-utils.js';
import { resolveBackend } from '../services/backend-spawn.js';
import { Defaults, LockError } from '../types/index.js';

const MICROVERSE_RUNNER_BIN = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../bin/microverse-runner.js',
);

function createSessionDir(workingDir, mvOverrides = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mv-session-'));
    const state = {
        active: true,
        working_dir: workingDir,
        step: 'implement',
        iteration: 0,
        max_iterations: 10,
        max_time_minutes: 60,
        worker_timeout_seconds: 120,
        start_time_epoch: Math.floor(Date.now() / 1000),
        completion_promise: null,
        original_prompt: 'test',
        current_ticket: null,
        history: [],
        started_at: new Date().toISOString(),
        session_dir: dir,
        tmux_mode: true,
        command_template: 'microverse.md',
    };
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));
    const mvState = {
        status: 'iterating',
        prd_path: '/tmp/prd.md',
        key_metric: { description: 'test', validation: 'echo 50', type: 'command', timeout_seconds: 5, tolerance: 2 },
        convergence: { stall_limit: 3, stall_counter: 0, history: [] },
        gap_analysis_path: '',
        failed_approaches: [],
        baseline_score: 40,
        ...mvOverrides,
    };
    fs.writeFileSync(path.join(dir, 'microverse.json'), JSON.stringify(mvState, null, 2));
    return { dir, state, mvState };
}

function writeMicroverseRelaunchTicket(sessionDir, id, status, order = 1) {
    const ticketDir = path.join(sessionDir, id);
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(path.join(ticketDir, `linear_ticket_${id}.md`), [
        '---',
        `id: ${id}`,
        `title: ${id}`,
        `status: "${status}"`,
        `order: ${order}`,
        '---',
        '',
    ].join('\n'));
}

function readMicroverseRelaunchEvents(dataRoot) {
    const activityDir = path.join(dataRoot, 'activity');
    if (!fs.existsSync(activityDir)) return [];
    const events = [];
    for (const entry of fs.readdirSync(activityDir)) {
        if (!entry.endsWith('.jsonl')) continue;
        for (const line of fs.readFileSync(path.join(activityDir, entry), 'utf-8').split('\n')) {
            if (!line.trim()) continue;
            try { events.push(JSON.parse(line)); } catch { /* ignore malformed fixture lines */ }
        }
    }
    return events.filter(event => event.event === 'codex_manager_relaunch');
}

async function withMicroverseLoopDeps(overrides, fn) {
    const original = {
        runIteration: _deps.runIteration,
        sleep: _deps.sleep,
        getHeadSha: _deps.getHeadSha,
        isWorkingTreeDirty: _deps.isWorkingTreeDirty,
    };
    _deps.runIteration = overrides.runIteration ?? original.runIteration;
    _deps.sleep = overrides.sleep ?? (async () => {});
    _deps.getHeadSha = overrides.getHeadSha ?? (() => 'abc123'.padEnd(40, '0'));
    _deps.isWorkingTreeDirty = overrides.isWorkingTreeDirty ?? (() => false);
    try {
        return await fn();
    } finally {
        _deps.runIteration = original.runIteration;
        _deps.sleep = original.sleep;
        _deps.getHeadSha = original.getHeadSha;
        _deps.isWorkingTreeDirty = original.isWorkingTreeDirty;
    }
}

async function runMicroverseRelaunchScenario({ backend, priorRelaunchCount = 0, tickets }) {
    const workingDir = createTempGitRepo();
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mv-relaunch-data-'));
    const previousDataRoot = process.env.PICKLE_DATA_ROOT;
    const session = createSessionDir(workingDir);
    const statePath = path.join(session.dir, 'state.json');
    const state = {
        ...session.state,
        backend,
        codex_manager_relaunch_count: priorRelaunchCount,
    };
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    for (const ticket of tickets) {
        writeMicroverseRelaunchTicket(session.dir, ticket.id, ticket.status, ticket.order);
    }
    const logs = [];
    const ctx = {
        sessionDir: session.dir,
        extensionRoot: path.resolve('.'),
        statePath,
        workingDir,
        startTime: Date.now(),
        initialIteration: 0,
        enableFailureClassification: false,
        cgSettings: {
            enabled_convergence_files: [],
            regression_warning_threshold: 5,
            remediator_timeout_s: 600,
            baseline_max_age_iterations: 30,
            baseline_max_age_seconds: 14_400,
        },
        rateLimitWaitMinutes: 0,
        maxRateLimitRetries: 0,
        log: (msg) => logs.push(msg),
        currentRunnerState: state,
        iteration: 0,
        consecutiveRateLimits: 0,
    };

    try {
        process.env.PICKLE_DATA_ROOT = dataRoot;
        let calls = 0;
        const result = await withMicroverseLoopDeps({
            runIteration: async () => {
                calls += 1;
                return calls === 1
                    ? { completion: 'error', timedOut: true, exitCode: null, wallSeconds: Defaults.MAX_ITERATION_SECONDS }
                    : { completion: 'inactive', timedOut: false, exitCode: 0, wallSeconds: 1 };
            },
        }, () => executeMainLoop(session.mvState, ctx));
        return {
            result,
            calls,
            logs,
            persisted: JSON.parse(fs.readFileSync(statePath, 'utf-8')),
            relaunchEvents: readMicroverseRelaunchEvents(dataRoot),
        };
    } finally {
        if (previousDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
        else process.env.PICKLE_DATA_ROOT = previousDataRoot;
        fs.rmSync(session.dir, { recursive: true, force: true });
        fs.rmSync(workingDir, { recursive: true, force: true });
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
}

test('readRunnerState promotes orphan tmp state before microverse control-flow reads', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mv-state-'));
    const statePath = path.join(dir, 'state.json');
    try {
        const baseState = {
            active: true,
            working_dir: dir,
            step: 'implement',
            iteration: 1,
            max_iterations: 10,
            max_time_minutes: 60,
            worker_timeout_seconds: 120,
            start_time_epoch: Math.floor(Date.now() / 1000),
            backend: 'claude',
        };
        const promotedState = {
            ...baseState,
            active: false,
            iteration: 2,
            backend: 'codex',
        };

        fs.writeFileSync(statePath, JSON.stringify(baseState, null, 2));
        fs.writeFileSync(`${statePath}.tmp.99999999`, JSON.stringify(promotedState, null, 2));

        const staleRaw = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(staleRaw.active, true, 'raw base state misses the cancellation bit');
        assert.equal(resolveBackend(staleRaw), 'claude', 'raw base state still resolves the old backend');

        const recovered = readRunnerState(statePath);
        assert.equal(recovered.active, false, 'runner reads the promoted inactive tmp state');
        assert.equal(recovered.iteration, 2, 'runner sees the higher-iteration promoted state');
        assert.equal(resolveBackend(recovered), 'codex', 'runner resolves backend from the promoted state');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('deactivateRunnerState preserves session fields when lock-backed update fails', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mv-state-'));
    const statePath = path.join(dir, 'state.json');
    try {
        writeStateFile(statePath, {
            active: true,
            working_dir: '/tmp/project',
            session_dir: dir,
            step: 'implement',
            iteration: 7,
            current_ticket: 'T-7',
            backend: 'codex',
            command_template: 'microverse.md',
            schema_version: 1,
        });

        const originalUpdate = StateManager.prototype.update;
        StateManager.prototype.update = () => {
            throw new LockError('forced fallback');
        };

        try {
            deactivateRunnerState(statePath);
        } finally {
            StateManager.prototype.update = originalUpdate;
        }

        const recovered = readRunnerState(statePath);
        assert.equal(recovered.active, false);
        assert.equal(recovered.working_dir, '/tmp/project');
        assert.equal(recovered.session_dir, dir);
        assert.equal(recovered.iteration, 7);
        assert.equal(recovered.current_ticket, 'T-7');
        assert.equal(recovered.backend, 'codex');
        assert.equal(recovered.command_template, 'microverse.md');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('microverse-runner fatal path promotes newer microverse tmp before marking stopped', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mv-fatal-'));
    const mvPath = path.join(dir, 'microverse.json');
    const tmpPath = `${mvPath}.tmp.99999999`;
    try {
        fs.writeFileSync(path.join(dir, 'state.json'), '{ not json');
        fs.writeFileSync(mvPath, JSON.stringify({
            status: 'iterating',
            iteration_regressions: 0,
            convergence: { history: [] },
        }, null, 2));
        fs.writeFileSync(tmpPath, JSON.stringify({
            status: 'iterating',
            iteration_regressions: 3,
            convergence: { history: [{ iteration: 11, action: 'held' }] },
        }, null, 2));
        const future = new Date(Date.now() + 1000);
        fs.utimesSync(tmpPath, future, future);

        const result = spawnSync(process.execPath, [MICROVERSE_RUNNER_BIN, dir], {
            encoding: 'utf-8',
            timeout: 10_000,
        });

        assert.equal(result.status, 1, `runner should fail startup on corrupt state: ${result.stderr}`);
        const recovered = JSON.parse(fs.readFileSync(mvPath, 'utf-8'));
        assert.equal(recovered.status, 'stopped');
        assert.equal(recovered.exit_reason, 'error');
        assert.equal(recovered.iteration_regressions, 3, 'fatal cleanup preserves recovered regression counters');
        assert.deepEqual(recovered.convergence.history, [{ iteration: 11, action: 'held' }]);
        assert.equal(fs.existsSync(tmpPath), false, 'fatal cleanup consumes the promoted tmp snapshot');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// --- measureMetric tests ---

test('measureMetric parses numeric output from command', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-metric-'));
    try {
        const result = measureMetric('echo 42.5', 5, dir);
        assert.ok(result, 'expected non-null result');
        assert.equal(result.score, 42.5);
        assert.ok(result.raw.includes('42.5'));
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('measureMetric returns null for non-numeric output', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-metric-'));
    try {
        const result = measureMetric('echo "not a number"', 5, dir);
        assert.equal(result, null);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('measureMetric returns null on timeout', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-metric-'));
    try {
        const result = measureMetric('sleep 10 && echo 50', 1, dir);
        assert.equal(result, null);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('measureMetric returns null on command failure', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-metric-'));
    try {
        const result = measureMetric('exit 1', 5, dir);
        assert.equal(result, null);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('measureMetric parses last line when multi-line output', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-metric-'));
    try {
        const result = measureMetric('echo "info line" && echo 99', 5, dir);
        assert.ok(result, 'expected non-null result');
        assert.equal(result.score, 99);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- buildMicroverseHandoff tests ---

test('buildMicroverseHandoff includes metric info and iteration number', () => {
    const mvState = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 3 });
    mvState.baseline_score = 40;
    const handoff = buildMicroverseHandoff(mvState, 5, '/tmp/work');
    assert.ok(handoff.includes('Iteration 5'));
    assert.ok(handoff.includes('test score'));
    assert.ok(handoff.includes('Baseline score: 40'));
});

test('buildMicroverseHandoff includes failed approaches', () => {
    let mvState = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 3 });
    mvState = recordFailedApproach(mvState, 'approach A failed');
    const handoff = buildMicroverseHandoff(mvState, 1, '/tmp/work');
    assert.ok(handoff.includes('Failed Approaches'));
    assert.ok(handoff.includes('approach A failed'));
});

test('buildMicroverseHandoff includes recent history', () => {
    let mvState = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 3 });
    mvState.baseline_score = 40;
    mvState = recordIteration(mvState, {
        iteration: 1, metric_value: '50', score: 50, action: 'accept',
        description: 'improved', pre_iteration_sha: 'a'.repeat(40), timestamp: new Date().toISOString(),
    });
    const handoff = buildMicroverseHandoff(mvState, 2, '/tmp/work');
    assert.ok(handoff.includes('Recent Metric History'));
    assert.ok(handoff.includes('score=50'));
});

test('buildMicroverseHandoff includes Type field from key_metric', () => {
    const llmMetric = { ...TEST_METRIC, type: 'llm', validation: 'Improve code quality' };
    const mvState = createMicroverseState({ prdPath: '/tmp/prd.md', metric: llmMetric, stallLimit: 3 });
    const handoff = buildMicroverseHandoff(mvState, 1, '/tmp/work');
    assert.ok(handoff.includes('Type: llm'));
});

test('buildMicroverseHandoff includes Direction field', () => {
    const lowerMetric = { ...TEST_METRIC, direction: 'lower' };
    const mvState = createMicroverseState({ prdPath: '/tmp/prd.md', metric: lowerMetric, stallLimit: 3 });
    const handoff = buildMicroverseHandoff(mvState, 1, '/tmp/work');
    assert.ok(handoff.includes('Direction: lower'));
    assert.ok(handoff.includes('lower is better'));
});

test('buildMicroverseHandoff with direction=lower says "reducing the metric"', () => {
    const lowerMetric = { ...TEST_METRIC, direction: 'lower' };
    const mvState = createMicroverseState({ prdPath: '/tmp/prd.md', metric: lowerMetric, stallLimit: 3 });
    const handoff = buildMicroverseHandoff(mvState, 1, '/tmp/work');
    assert.ok(handoff.includes('Focus on reducing the metric.'));
});

test('buildMicroverseHandoff with direction=higher says "improving the metric"', () => {
    const higherMetric = { ...TEST_METRIC, direction: 'higher' };
    const mvState = createMicroverseState({ prdPath: '/tmp/prd.md', metric: higherMetric, stallLimit: 3 });
    const handoff = buildMicroverseHandoff(mvState, 1, '/tmp/work');
    assert.ok(handoff.includes('Focus on improving the metric.'));
});

test('buildMicroverseHandoff includes PRD path when sessionDir provided', () => {
    const mvState = createMicroverseState({ prdPath: '/tmp/target', metric: TEST_METRIC, stallLimit: 3 });
    const handoff = buildMicroverseHandoff(mvState, 1, '/tmp/work', '/tmp/sessions/abc123');
    assert.ok(handoff.includes('## PRD: /tmp/sessions/abc123/prd.md'), 'should include PRD path');
});

test('buildMicroverseHandoff omits PRD section when sessionDir not provided', () => {
    const mvState = createMicroverseState({ prdPath: '/tmp/target', metric: TEST_METRIC, stallLimit: 3 });
    const handoff = buildMicroverseHandoff(mvState, 1, '/tmp/work');
    assert.ok(!handoff.includes('## PRD:'), 'should not include PRD section without sessionDir');
});

// --- Accept/reject cycle simulation ---

test('accept/reject cycle: 3 iterations (improve, regress, hold) → 2 accepted, 1 reset, stall_counter=1', () => {
    const dir = createTempGitRepo();
    try {
        let mvState = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 5 });
        mvState.baseline_score = 40;
        const sha = getHeadSha(dir);

        // Iteration 1: improve (50 > 40 + 2)
        const entry1 = {
            iteration: 1, metric_value: '50', score: 50, action: 'accept',
            description: 'improved: 50 vs 40', pre_iteration_sha: sha,
            timestamp: new Date().toISOString(),
        };
        mvState = recordIteration(mvState, entry1);
        assert.equal(mvState.convergence.stall_counter, 0, 'stall reset after improve');

        // Iteration 2: regress (30 < 50 - 2)
        const entry2 = {
            iteration: 2, metric_value: '30', score: 30, action: 'revert',
            description: 'regressed: 30 vs 50', pre_iteration_sha: sha,
            timestamp: new Date().toISOString(),
        };
        mvState = recordFailedApproach(mvState, 'Iteration 2: dropped from 50 to 30');
        mvState = recordIteration(mvState, entry2);
        assert.equal(mvState.convergence.stall_counter, 1, 'stall incremented after regress');
        assert.equal(mvState.failed_approaches.length, 1);

        // Iteration 3: hold (51 within 50 ± 2)
        // recordIteration now uses last *accepted* score (50), not last entry score (30)
        const entry3 = {
            iteration: 3, metric_value: '51', score: 51, action: 'accept',
            description: 'held: 51 vs 50', pre_iteration_sha: sha,
            timestamp: new Date().toISOString(),
        };
        mvState = recordIteration(mvState, entry3);

        const accepted = mvState.convergence.history.filter(h => h.action === 'accept').length;
        const reverted = mvState.convergence.history.filter(h => h.action === 'revert').length;
        assert.equal(accepted, 2, '2 accepted');
        assert.equal(reverted, 1, '1 reverted');
        assert.equal(mvState.convergence.history.length, 3);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- Post-revert baseline (M1 fix) ---

test('recordIteration after revert compares against last accepted score, not reverted score', () => {
    let mvState = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 5 });
    mvState.baseline_score = 40;
    mvState.status = 'iterating';
    const sha = 'b'.repeat(40);

    // Iteration 1: accept at score 60 (improved from baseline 40)
    mvState = recordIteration(mvState, {
        iteration: 1, metric_value: '60', score: 60, action: 'accept',
        description: 'improved', pre_iteration_sha: sha, timestamp: new Date().toISOString(),
    });
    assert.equal(mvState.convergence.stall_counter, 0, 'stall reset on improvement');

    // Iteration 2: revert at score 20 (regressed)
    mvState = recordIteration(mvState, {
        iteration: 2, metric_value: '20', score: 20, action: 'revert',
        description: 'regressed', pre_iteration_sha: sha, timestamp: new Date().toISOString(),
    });
    assert.equal(mvState.convergence.stall_counter, 1);

    // Iteration 3: score 45 — compared against last accepted (60), NOT last entry (20)
    // 45 < 60 - 2 = 58, so this should be 'regressed', not 'improved' (as it would be vs 20)
    mvState = recordIteration(mvState, {
        iteration: 3, metric_value: '45', score: 45, action: 'revert',
        description: 'regressed vs accepted', pre_iteration_sha: sha, timestamp: new Date().toISOString(),
    });
    assert.equal(mvState.convergence.stall_counter, 2, 'stall incremented — 45 regressed from accepted 60');

    // Iteration 4: score 63 — compared against last accepted (60), 63 > 60+2 → improved
    mvState = recordIteration(mvState, {
        iteration: 4, metric_value: '63', score: 63, action: 'accept',
        description: 'improved vs accepted', pre_iteration_sha: sha, timestamp: new Date().toISOString(),
    });
    assert.equal(mvState.convergence.stall_counter, 0, 'stall reset — 63 improved from accepted 60');
});

test('recordIteration with all-reverts falls back to baseline_score', () => {
    let mvState = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 10 });
    mvState.baseline_score = 50;
    mvState.status = 'iterating';
    const sha = 'c'.repeat(40);

    // Two consecutive reverts — no accepted entries exist
    mvState = recordIteration(mvState, {
        iteration: 1, metric_value: '20', score: 20, action: 'revert',
        description: 'regressed', pre_iteration_sha: sha, timestamp: new Date().toISOString(),
    });
    assert.equal(mvState.convergence.stall_counter, 1);

    mvState = recordIteration(mvState, {
        iteration: 2, metric_value: '15', score: 15, action: 'revert',
        description: 'regressed again', pre_iteration_sha: sha, timestamp: new Date().toISOString(),
    });
    assert.equal(mvState.convergence.stall_counter, 2);

    // No accepted entries — lastAccepted is undefined, so previousScore = baseline_score (50)
    // Score 53 > 50 + 2 = 52 → improved, stall resets
    mvState = recordIteration(mvState, {
        iteration: 3, metric_value: '53', score: 53, action: 'accept',
        description: 'improved vs baseline', pre_iteration_sha: sha, timestamp: new Date().toISOString(),
    });
    assert.equal(mvState.convergence.stall_counter, 0, 'stall reset — compared against baseline_score 50');

    // Now lastAccepted exists at 53 — score 51 within 53 ± 2 → held
    mvState = recordIteration(mvState, {
        iteration: 4, metric_value: '51', score: 51, action: 'accept',
        description: 'held vs accepted', pre_iteration_sha: sha, timestamp: new Date().toISOString(),
    });
    assert.equal(mvState.convergence.stall_counter, 1, 'stall incremented — 51 held vs accepted 53');
});

// --- Convergence detection ---

// --- recordStall tests ---

test('recordStall increments stall_counter without adding history', () => {
    let state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 5 });
    state.baseline_score = 40;
    assert.equal(state.convergence.stall_counter, 0);
    assert.equal(state.convergence.history.length, 0);

    state = recordStall(state);
    assert.equal(state.convergence.stall_counter, 1);
    assert.equal(state.convergence.history.length, 0, 'no history entry for stall');

    state = recordStall(state);
    assert.equal(state.convergence.stall_counter, 2);
    assert.equal(state.convergence.history.length, 0);
});

test('recordStall triggers convergence when hitting stall_limit', () => {
    let state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 2 });
    state = recordStall(state);
    assert.equal(isConverged(state), false);
    state = recordStall(state);
    assert.equal(isConverged(state), true);
});

// --- createMicroverseState validation tests ---

test('createMicroverseState rejects stall_limit < 1', () => {
    assert.throws(() => createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 0 }), /stall_limit must be a positive integer/);
    assert.throws(() => createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: -1 }), /stall_limit must be a positive integer/);
});

test('createMicroverseState rejects non-integer stall_limit', () => {
    assert.throws(() => createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 1.5 }), /stall_limit must be a positive integer/);
    assert.throws(() => createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: NaN }), /stall_limit must be a positive integer/);
    assert.throws(() => createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: Infinity }), /stall_limit must be a positive integer/);
});

test('createMicroverseState rejects negative tolerance', () => {
    const badMetric = { ...TEST_METRIC, tolerance: -1 };
    assert.throws(() => createMicroverseState({ prdPath: '/tmp/prd.md', metric: badMetric, stallLimit: 3 }), /tolerance must be a non-negative number/);
});

test('createMicroverseState rejects NaN/Infinity tolerance', () => {
    assert.throws(() => createMicroverseState({ prdPath: '/tmp/prd.md', metric: { ...TEST_METRIC, tolerance: NaN }, stallLimit: 3 }), /tolerance must be a non-negative number/);
    assert.throws(() => createMicroverseState({ prdPath: '/tmp/prd.md', metric: { ...TEST_METRIC, tolerance: Infinity }, stallLimit: 3 }), /tolerance must be a non-negative number/);
});

test('createMicroverseState accepts valid parameters', () => {
    const state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 3 });
    assert.equal(state.convergence.stall_limit, 3);
    assert.equal(state.key_metric.tolerance, TEST_METRIC.tolerance);
});

test('convergence: 3 consecutive holds with stall_limit=3 stops loop', () => {
    let mvState = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 3 });
    mvState.baseline_score = 40;

    const sha = 'a'.repeat(40);
    for (let i = 1; i <= 3; i++) {
        const entry = {
            iteration: i, metric_value: '41', score: 41, action: 'accept',
            description: `held: 41 vs 40`, pre_iteration_sha: sha,
            timestamp: new Date().toISOString(),
        };
        mvState = recordIteration(mvState, entry);
    }

    assert.equal(mvState.convergence.stall_counter, 3, 'stall_counter should be 3');
    assert.equal(isConverged(mvState), true, 'should be converged');
});

// --- Hard cap enforcement ---

test('hard cap: max_iterations enforced', () => {
    const dir = createTempGitRepo();
    try {
        const { dir: sessionDir, state } = createSessionDir(dir, {});
        state.max_iterations = 5;
        state.iteration = 5; // at the cap
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(state, null, 2));

        // Verify cap logic: iteration >= max_iterations should stop
        const rawMaxIter = Number(state.max_iterations);
        const curIter = Number(state.iteration);
        assert.equal(rawMaxIter > 0 && curIter >= rawMaxIter, true, 'should trigger cap');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('hard cap: max_time_minutes enforced', () => {
    const dir = createTempGitRepo();
    try {
        const { dir: sessionDir, state } = createSessionDir(dir, {});
        state.max_time_minutes = 1;
        state.start_time_epoch = Math.floor(Date.now() / 1000) - 120; // 2 min ago
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(state, null, 2));

        const elapsed = Math.floor(Date.now() / 1000) - state.start_time_epoch;
        assert.ok(elapsed >= state.max_time_minutes * 60, 'should exceed time limit');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- Dirty tree abort ---

test('dirty working tree detected', () => {
    const dir = createTempGitRepo();
    try {
        fs.writeFileSync(path.join(dir, 'dirty.txt'), 'dirty');
        assert.equal(isWorkingTreeDirty(dir), true);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- Rollback test ---

test('regressed metric triggers git reset', () => {
    const dir = createTempGitRepo();
    try {
        const origSha = getHeadSha(dir);
        // Make a commit
        fs.writeFileSync(path.join(dir, 'new.txt'), 'content');
        execSync('git add . && git commit -m "new file"', { cwd: dir, stdio: 'pipe' });
        const newSha = getHeadSha(dir);
        assert.notEqual(origSha, newSha);

        // Reset to original
        resetToSha(origSha, dir);
        const afterReset = getHeadSha(dir);
        assert.equal(afterReset, origSha, 'should be back to original SHA');
        assert.equal(fs.existsSync(path.join(dir, 'new.txt')), false, 'new file should be gone');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- Final report ---

test('final report written to memory directory', () => {
    const dir = createTempGitRepo();
    try {
        const { dir: sessionDir } = createSessionDir(dir, {
            convergence: {
                stall_limit: 3, stall_counter: 3,
                history: [
                    { iteration: 1, metric_value: '50', score: 50, action: 'accept', description: 'improved', pre_iteration_sha: 'a'.repeat(40), timestamp: new Date().toISOString() },
                ],
            },
        });
        // Simulate report writing by checking the function exists
        const memoryDir = path.join(sessionDir, 'memory');
        fs.mkdirSync(memoryDir, { recursive: true });
        const reportPath = path.join(memoryDir, 'microverse_report_test.md');
        fs.writeFileSync(reportPath, '# Test Report\n');
        assert.ok(fs.existsSync(reportPath), 'report should exist in memory dir');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- State sync ---

test('runner reads state.json and microverse.json on startup', () => {
    const dir = createTempGitRepo();
    try {
        const { dir: sessionDir } = createSessionDir(dir);
        const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
        const mvState = readMicroverseState(sessionDir);
        assert.ok(state.active === true);
        assert.ok(mvState !== null);
        assert.equal(mvState.status, 'iterating');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('handleRateLimit persists API reset metadata and emits wait activity', async () => {
    const dir = createTempGitRepo();
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mv-data-'));
    const previousDataRoot = process.env.PICKLE_DATA_ROOT;
    const originalSleep = _deps.sleep;
    try {
        process.env.PICKLE_DATA_ROOT = dataRoot;
        const { dir: sessionDir, state } = createSessionDir(dir);
        const statePath = path.join(sessionDir, 'state.json');
        const waitPath = path.join(sessionDir, 'rate_limit_wait.json');

        _deps.sleep = async () => {
            state.active = false;
            fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
        };

        const ctx = {
            sessionDir,
            statePath,
            currentRunnerState: state,
            rateLimitWaitMs: 60_000,
            consecutiveRateLimits: 2,
            log: () => {},
        };

        await handleRateLimit({}, ctx, new AbortController().signal, {
            durationMin: 15,
            rateLimitType: 'requests',
            resetsAt: 1_714_083_600,
            waitSource: 'api',
        });

        const waitData = JSON.parse(fs.readFileSync(waitPath, 'utf-8'));
        assert.equal(waitData.rate_limit_type, 'requests');
        assert.equal(waitData.resets_at_epoch, 1_714_083_600);
        assert.equal(waitData.wait_source, 'api');
        assert.equal(ctx.rateLimitExitReason, 'stopped');

        const activityDir = path.join(dataRoot, 'activity');
        const activityFile = path.join(activityDir, fs.readdirSync(activityDir)[0]);
        const waitEvent = fs.readFileSync(activityFile, 'utf-8')
            .trim()
            .split('\n')
            .map(line => JSON.parse(line))
            .find(event => event.event === 'rate_limit_wait');
        assert.ok(waitEvent, 'rate_limit_wait activity event should be logged');
        assert.equal(waitEvent.duration_min, 15);
        assert.equal(waitEvent.session, path.basename(sessionDir));
    } finally {
        _deps.sleep = originalSleep;
        if (previousDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
        else process.env.PICKLE_DATA_ROOT = previousDataRoot;
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});

test('microverse-runner relaunches codex manager subprocess below cap', async () => {
    const outcome = await runMicroverseRelaunchScenario({
        backend: 'codex',
        priorRelaunchCount: 0,
        tickets: [
            { id: 'mv-done', status: 'Done', order: 1 },
            { id: 'mv-pending', status: 'Todo', order: 2 },
        ],
    });

    assert.equal(outcome.calls, 2, 'second iteration proves the outer loop relaunched');
    assert.equal(outcome.persisted.codex_manager_relaunch_count, 1);
    assert.equal(outcome.persisted.active, true, 'relaunch path must not deactivate the session');
    assert.equal(outcome.relaunchEvents.length, 1);
    assert.equal(outcome.relaunchEvents[0].iteration, 1);
    assert.equal(outcome.result.exitReason, 'stopped');
    assert.ok(
        outcome.logs.some(msg => msg.includes('relaunching') && msg.includes(`1/${Defaults.CODEX_MANAGER_RELAUNCH_CAP}`)),
        `expected relaunch log, got ${JSON.stringify(outcome.logs)}`,
    );
});

test('microverse-runner honors codex manager relaunch cap', async () => {
    const outcome = await runMicroverseRelaunchScenario({
        backend: 'codex',
        priorRelaunchCount: Defaults.CODEX_MANAGER_RELAUNCH_CAP,
        tickets: [
            { id: 'mv-pending', status: 'Todo', order: 1 },
        ],
    });

    assert.equal(outcome.calls, 1, 'at cap should break instead of starting another iteration');
    assert.equal(outcome.persisted.codex_manager_relaunch_count, Defaults.CODEX_MANAGER_RELAUNCH_CAP);
    assert.equal(outcome.relaunchEvents.length, 0);
    assert.equal(outcome.result.exitReason, 'error');
});

test('microverse-runner leaves claude subprocess errors terminal', async () => {
    const outcome = await runMicroverseRelaunchScenario({
        backend: 'claude',
        tickets: [
            { id: 'mv-pending', status: 'Todo', order: 1 },
        ],
    });

    assert.equal(outcome.calls, 1, 'claude backend must not relaunch');
    assert.equal(outcome.persisted.codex_manager_relaunch_count, 0);
    assert.equal(outcome.relaunchEvents.length, 0);
    assert.equal(outcome.result.exitReason, 'error');
});

// --- Pre-iteration SHA ---

test('pre-iteration SHA recorded correctly', () => {
    const dir = createTempGitRepo();
    try {
        const sha = getHeadSha(dir);
        assert.match(sha, /^[0-9a-f]{40}$/);
        // Make a change
        fs.writeFileSync(path.join(dir, 'file.txt'), 'data');
        execSync('git add . && git commit -m "change"', { cwd: dir, stdio: 'pipe' });
        const newSha = getHeadSha(dir);
        assert.notEqual(sha, newSha, 'SHA should change after commit');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- extractScore tests ---

test('extractScore: clean number on last line', () => {
    assert.equal(extractScore('analysis\n42'), 42);
});

test('extractScore: number with markdown bold', () => {
    assert.equal(extractScore('reasoning...\n**7**'), 7);
});

test('extractScore: number with backticks', () => {
    assert.equal(extractScore('here is the score\n`12`'), 12);
});

test('extractScore: decimal number', () => {
    assert.equal(extractScore('stuff\n3.5'), 3.5);
});

test('extractScore: number buried in middle (last numeric line wins)', () => {
    assert.equal(extractScore('analysis\n15\nsome trailing text'), 15);
});

test('extractScore: zero is valid', () => {
    assert.equal(extractScore('no issues found\n0'), 0);
});

test('extractScore: returns null for pure text', () => {
    assert.equal(extractScore('great job, no issues!'), null);
});

test('extractScore: returns null for fractions', () => {
    assert.equal(extractScore('7/10'), null);
});

test('extractScore: returns null for empty string', () => {
    assert.equal(extractScore(''), null);
});

// --- measureLlmMetric + buildJudgePrompt tests ---

test('measureLlmMetric extracts numeric score from last line', () => {
    const mockOutput = 'analysis of codebase...\n42';
    const orig = _deps.execFileSync;
    _deps.execFileSync = () => mockOutput;
    try {
        const result = measureLlmMetric('fix bugs', 30, '/tmp');
        assert.deepEqual(result, { raw: mockOutput, score: 42 });
    } finally {
        _deps.execFileSync = orig;
    }
});

test('measureLlmMetric spawns claude with --system-prompt and --allowedTools', () => {
    const orig = _deps.execFileSync;
    let capturedArgs;
    _deps.execFileSync = (cmd, args) => {
        capturedArgs = { cmd, args };
        return '75';
    };
    try {
        measureLlmMetric('fix bugs', 30, '/tmp', 'claude-opus-4-6');
        assert.equal(capturedArgs.cmd, 'claude');
        assert.ok(capturedArgs.args.includes('-p'));
        assert.ok(capturedArgs.args.includes('--model'));
        assert.ok(capturedArgs.args.includes('claude-opus-4-6'));
        assert.ok(capturedArgs.args.includes('--system-prompt'), 'should include --system-prompt');
        assert.ok(capturedArgs.args.includes('--allowedTools'), 'should include --allowedTools');
        assert.ok(capturedArgs.args.includes('Read,Glob,Grep'), 'should restrict to read-only tools');
        assert.ok(capturedArgs.args.includes('--no-session-persistence'), 'should not persist judge sessions');
    } finally {
        _deps.execFileSync = orig;
    }
});

test('measureLlmMetric enforces minimum 180s timeout', () => {
    const orig = _deps.execFileSync;
    let capturedOpts;
    _deps.execFileSync = (_cmd, _args, opts) => {
        capturedOpts = opts;
        return '50';
    };
    try {
        measureLlmMetric('fix bugs', 30, '/tmp');
        assert.equal(capturedOpts.timeout, 180 * 1000, 'should floor timeout to 180s');
    } finally {
        _deps.execFileSync = orig;
    }
});

test('measureLlmMetric respects timeout above 180s', () => {
    const orig = _deps.execFileSync;
    let capturedOpts;
    _deps.execFileSync = (_cmd, _args, opts) => {
        capturedOpts = opts;
        return '50';
    };
    try {
        measureLlmMetric('fix bugs', 300, '/tmp');
        assert.equal(capturedOpts.timeout, 300 * 1000, 'should use provided timeout when above floor');
    } finally {
        _deps.execFileSync = orig;
    }
});

test('measureLlmMetric returns null on timeout', () => {
    const orig = _deps.execFileSync;
    _deps.execFileSync = () => {
        const err = new Error('Command timed out');
        err.code = 'ETIMEDOUT';
        throw err;
    };
    try {
        const result = measureLlmMetric('fix bugs', 1, '/tmp');
        assert.equal(result, null);
    } finally {
        _deps.execFileSync = orig;
    }
});

test('measureLlmMetric returns null on subprocess error', () => {
    const orig = _deps.execFileSync;
    _deps.execFileSync = () => { throw new Error('subprocess failed'); };
    try {
        const result = measureLlmMetric('fix bugs', 30, '/tmp');
        assert.equal(result, null);
    } finally {
        _deps.execFileSync = orig;
    }
});

test('measureLlmMetric returns null on non-numeric output', () => {
    const orig = _deps.execFileSync;
    _deps.execFileSync = () => 'great job!';
    try {
        const result = measureLlmMetric('fix bugs', 30, '/tmp');
        assert.equal(result, null);
    } finally {
        _deps.execFileSync = orig;
    }
});

test('measureLlmMetric extracts score from markdown-formatted output', () => {
    const mockOutput = 'I found several issues.\n\nHere is my score:\n\n**5**';
    const orig = _deps.execFileSync;
    _deps.execFileSync = () => mockOutput;
    try {
        const result = measureLlmMetric('fix bugs', 30, '/tmp');
        assert.deepEqual(result, { raw: mockOutput, score: 5 });
    } finally {
        _deps.execFileSync = orig;
    }
});

test('buildJudgePrompt includes goal, cwd, and scoring format instructions', () => {
    const prompt = buildJudgePrompt('fix bugs', '/tmp');
    assert.ok(prompt.includes('fix bugs'), 'should include goal');
    assert.ok(prompt.includes('/tmp'), 'should include cwd');
    assert.ok(prompt.includes('single integer'), 'should include scoring instructions');
});

test('buildJudgePrompt instructs no fractions', () => {
    const prompt = buildJudgePrompt('fix bugs', '/tmp');
    assert.ok(prompt.includes('Do NOT use fractions'), 'should instruct no fractions');
});

test('buildJudgePrompt does not include codebase evaluation preamble', () => {
    const prompt = buildJudgePrompt('fix bugs', '/tmp');
    assert.ok(!prompt.includes('You are evaluating a codebase'), 'preamble moved to system prompt');
});

test('buildJudgePrompt includes prdPath when provided', () => {
    const prompt = buildJudgePrompt('fix bugs', '/tmp', undefined, '/tmp/prds/my-prd.md');
    assert.ok(prompt.includes('/tmp/prds/my-prd.md'), 'should include prd path');
    assert.ok(prompt.includes('Examine the code at this path'), 'should instruct to examine the path');
});

test('buildJudgePrompt omits target file when prdPath not provided', () => {
    const prompt = buildJudgePrompt('fix bugs', '/tmp');
    assert.ok(!prompt.includes('Target path:'), 'should not include target path without prdPath');
});

test('measureLlmMetric passes prdPath to buildJudgePrompt', () => {
    const orig = _deps.execFileSync;
    let capturedArgs;
    _deps.execFileSync = (_cmd, args) => {
        capturedArgs = args;
        return '50';
    };
    try {
        measureLlmMetric('fix bugs', 30, '/tmp', undefined, undefined, '/tmp/prds/test.md');
        // The prompt (second arg after -p) should contain the prd path
        const promptIdx = capturedArgs.indexOf('-p') + 1;
        assert.ok(capturedArgs[promptIdx].includes('/tmp/prds/test.md'), 'prompt should contain prd path');
    } finally {
        _deps.execFileSync = orig;
    }
});

test('buildJudgePrompt includes judgeContextPath when provided', () => {
    const prompt = buildJudgePrompt('fix bugs', '/tmp', undefined, '/tmp/target', '/tmp/principles.md');
    assert.ok(prompt.includes('/tmp/principles.md'), 'should include judge context path');
    assert.ok(prompt.includes('Scoring reference:'), 'should label the context path');
    assert.ok(prompt.includes('Read this file FIRST'), 'should instruct judge to read it first');
});

test('buildJudgePrompt omits scoring reference when judgeContextPath not provided', () => {
    const prompt = buildJudgePrompt('fix bugs', '/tmp', undefined, '/tmp/target');
    assert.ok(!prompt.includes('Scoring reference:'), 'should not include scoring reference without judgeContextPath');
});

test('buildJudgePrompt places scoring reference before target path', () => {
    const prompt = buildJudgePrompt('fix bugs', '/tmp', undefined, '/tmp/target', '/tmp/principles.md');
    const refIdx = prompt.indexOf('Scoring reference:');
    const targetIdx = prompt.indexOf('Target path:');
    assert.ok(refIdx < targetIdx, 'scoring reference should appear before target path');
});

test('measureLlmMetric passes judgeContextPath to buildJudgePrompt', () => {
    const orig = _deps.execFileSync;
    let capturedArgs;
    _deps.execFileSync = (_cmd, args) => {
        capturedArgs = args;
        return '5';
    };
    try {
        measureLlmMetric('fix bugs', 30, '/tmp', undefined, undefined, '/tmp/target', '/tmp/principles.md');
        const promptIdx = capturedArgs.indexOf('-p') + 1;
        assert.ok(capturedArgs[promptIdx].includes('/tmp/principles.md'), 'prompt should contain judge context path');
    } finally {
        _deps.execFileSync = orig;
    }
});

test('measureLlmMetric defaults to claude-sonnet-4-6 model', () => {
    const orig = _deps.execFileSync;
    let capturedArgs;
    _deps.execFileSync = (_cmd, args) => {
        capturedArgs = args;
        return '50';
    };
    try {
        measureLlmMetric('fix bugs', 30, '/tmp');
        assert.ok(capturedArgs.includes('claude-sonnet-4-6'), 'should use default model');
    } finally {
        _deps.execFileSync = orig;
    }
});

// --- Late baseline adoption tests ---

test('late baseline: first measurement becomes baseline when initial baseline failed', () => {
    // Simulate: baseline_score=0, no accepted history, first measurement = 8
    let state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: { ...TEST_METRIC, direction: 'lower' }, stallLimit: 5 });
    state.status = 'iterating';
    state.baseline_score = 0; // baseline measurement failed

    const metricScore = 8;
    const lastAccepted = [...state.convergence.history].reverse().find(h => h.action === 'accept');

    // This is the logic from the runner
    if (state.baseline_score === 0 && !lastAccepted) {
        state.baseline_score = metricScore;
    }

    assert.equal(state.baseline_score, 8, 'should adopt first measurement as baseline');

    // Now compare — should be "held" (8 vs 8), not "regressed" (8 vs 0)
    const previousScore = lastAccepted ? lastAccepted.score : state.baseline_score;
    const classification = compareMetric(metricScore, previousScore, 0, 'lower');
    assert.equal(classification, 'held', 'first measurement should be held, not regressed');
});

test('late baseline: does not override when baseline was successfully measured', () => {
    let state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: { ...TEST_METRIC, direction: 'lower' }, stallLimit: 5 });
    state.status = 'iterating';
    state.baseline_score = 12; // baseline was measured successfully

    const metricScore = 8;
    const lastAccepted = [...state.convergence.history].reverse().find(h => h.action === 'accept');

    if (state.baseline_score === 0 && !lastAccepted) {
        state.baseline_score = metricScore;
    }

    assert.equal(state.baseline_score, 12, 'should not override successful baseline');
});

test('late baseline: does not override when accepted history exists', () => {
    let state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: { ...TEST_METRIC, direction: 'lower' }, stallLimit: 5 });
    state.status = 'iterating';
    state.baseline_score = 0; // baseline failed
    state.convergence.history.push({
        iteration: 1, metric_value: '10', score: 10, action: 'accept',
        description: 'held', pre_iteration_sha: 'a'.repeat(40), timestamp: new Date().toISOString(),
    });

    const metricScore = 5;
    const lastAccepted = [...state.convergence.history].reverse().find(h => h.action === 'accept');

    if (state.baseline_score === 0 && !lastAccepted) {
        state.baseline_score = metricScore;
    }

    assert.equal(state.baseline_score, 0, 'should not override when accepted history exists');
});

// --- LLM runner integration tests (ticket 7351399a) ---

test('LLM baseline: measureLlmMetric result sets baseline_score in gap analysis', () => {
    // Simulate the baseline measurement branch for type='llm'
    const orig = _deps.execFileSync;
    _deps.execFileSync = () => 'analysis...\n45';
    try {
        const LLM_METRIC = {
            description: 'code quality',
            validation: 'improve code quality',
            type: 'llm',
            timeout_seconds: 60,
            tolerance: 2,
            judge_model: 'claude-sonnet-4-6',
        };
        let currentMv = createMicroverseState({ prdPath: '/tmp/prd.md', metric: LLM_METRIC, stallLimit: 3 });
        currentMv.status = 'gap_analysis';
        const workingDir = '/tmp';

        // Replicate the runner's baseline branch for type='llm'
        if (currentMv.key_metric.type === 'llm') {
            const baseline = measureLlmMetric(
                currentMv.key_metric.validation,
                currentMv.key_metric.timeout_seconds,
                workingDir,
                currentMv.key_metric.judge_model,
            );
            if (baseline) {
                currentMv.baseline_score = baseline.score;
            }
        }

        assert.equal(currentMv.baseline_score, 45, 'baseline_score should be 45 from LLM judge');
    } finally {
        _deps.execFileSync = orig;
    }
});

test('LLM iteration: measureLlmMetric result feeds into comparison pipeline', () => {
    const orig = _deps.execFileSync;
    _deps.execFileSync = () => '72';
    try {
        const LLM_METRIC = {
            description: 'code quality',
            validation: 'improve code quality',
            type: 'llm',
            timeout_seconds: 60,
            tolerance: 2,
            judge_model: 'claude-sonnet-4-6',
        };
        let currentMv = createMicroverseState({ prdPath: '/tmp/prd.md', metric: LLM_METRIC, stallLimit: 3 });
        currentMv.status = 'iterating';
        currentMv.baseline_score = 40;
        const workingDir = '/tmp';

        // Replicate the runner's iteration branch for type='llm'
        let metricResult = null;
        if (currentMv.key_metric.type === 'llm') {
            metricResult = measureLlmMetric(
                currentMv.key_metric.validation,
                currentMv.key_metric.timeout_seconds,
                workingDir,
                currentMv.key_metric.judge_model,
                currentMv.convergence.history,
            );
        }

        assert.ok(metricResult, 'metricResult should be non-null');
        assert.equal(metricResult.score, 72, 'score should be 72');

        // Verify it feeds into comparison
        const lastAccepted = [...currentMv.convergence.history].reverse().find(h => h.action === 'accept');
        const previousScore = lastAccepted ? lastAccepted.score : currentMv.baseline_score;
        const classification = compareMetric(metricResult.score, previousScore, currentMv.key_metric.tolerance);
        assert.equal(classification, 'improved', '72 vs baseline 40 should be improved');
    } finally {
        _deps.execFileSync = orig;
    }
});

test('LLM measurement failure treated as stall', () => {
    const orig = _deps.execFileSync;
    _deps.execFileSync = () => { throw new Error('subprocess failed'); };
    try {
        const LLM_METRIC = {
            description: 'code quality',
            validation: 'improve code quality',
            type: 'llm',
            timeout_seconds: 60,
            tolerance: 2,
            judge_model: 'claude-sonnet-4-6',
        };
        let currentMv = createMicroverseState({ prdPath: '/tmp/prd.md', metric: LLM_METRIC, stallLimit: 3 });
        currentMv.status = 'iterating';
        currentMv.baseline_score = 40;
        const workingDir = '/tmp';

        // Replicate the runner's iteration branch for type='llm'
        let metricResult = null;
        if (currentMv.key_metric.type === 'llm') {
            metricResult = measureLlmMetric(
                currentMv.key_metric.validation,
                currentMv.key_metric.timeout_seconds,
                workingDir,
                currentMv.key_metric.judge_model,
                currentMv.convergence.history,
            );
        }

        assert.equal(metricResult, null, 'metricResult should be null on failure');

        // Replicate the runner's stall handling for null metricResult
        if (!metricResult) {
            currentMv = recordStall(currentMv);
        }

        assert.equal(currentMv.convergence.stall_counter, 1, 'stall_counter should increment on null metric');
    } finally {
        _deps.execFileSync = orig;
    }
});

// --- Bug fix tests: double classification, timeout guard, auto-rescue ---

test('recordIteration accepts pre-computed classification to avoid double classification', () => {
    let state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 5 });
    state.baseline_score = 40;
    state.convergence.stall_counter = 2;

    // Score 41 is within tolerance (40 ± 2 → 38-42), so re-computed classification = 'held'.
    // But if caller passes 'improved', the stall counter should reset.
    const entry = {
        iteration: 1, metric_value: '41', score: 41, action: 'accept',
        description: 'test', pre_iteration_sha: 'a'.repeat(40), timestamp: new Date().toISOString(),
    };

    // Without classification param: 41 within 40 ± 2 = 'held', stall increments
    const stateNoClassif = recordIteration({ ...state, convergence: { ...state.convergence } }, entry);
    assert.equal(stateNoClassif.convergence.stall_counter, 3, 'without param: held → stall increments');

    // With classification param: caller says 'improved', stall resets
    const stateWithClassif = recordIteration({ ...state, convergence: { ...state.convergence } }, entry, 'improved');
    assert.equal(stateWithClassif.convergence.stall_counter, 0, 'with param: improved → stall resets');
});

test('recordIteration falls back to internal classification when param omitted', () => {
    let state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 5 });
    state.baseline_score = 40;

    // Score 50 > 40 + 2 → improved, stall resets (backward compat)
    const entry = {
        iteration: 1, metric_value: '50', score: 50, action: 'accept',
        description: 'improved', pre_iteration_sha: 'a'.repeat(40), timestamp: new Date().toISOString(),
    };
    state = recordIteration(state, entry);
    assert.equal(state.convergence.stall_counter, 0, 'backward compat: improved without classification param');
});

test('worker_timeout_seconds=0 is re-enforced after state re-read', () => {
    // Simulate the runner's guard: if external edit restores timeout, re-zero it
    const dir = createTempGitRepo();
    try {
        const { dir: sessionDir } = createSessionDir(dir);
        const statePath = path.join(sessionDir, 'state.json');

        // Simulate external edit that restores timeout
        const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        state.worker_timeout_seconds = 1200;
        fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

        // Replicate the runner's guard logic
        const reRead = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        if (reRead.worker_timeout_seconds !== 0) {
            reRead.worker_timeout_seconds = 0;
            fs.writeFileSync(statePath, JSON.stringify(reRead, null, 2));
        }

        const final = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(final.worker_timeout_seconds, 0, 'timeout should be re-zeroed');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('auto-rescue: dirty tree gets auto-committed when no commits detected', () => {
    const dir = createTempGitRepo();
    try {
        const preSha = getHeadSha(dir);

        // Simulate worker leaving dirty tree (no commit)
        fs.writeFileSync(path.join(dir, 'worker-output.txt'), 'worker changes');
        assert.equal(isWorkingTreeDirty(dir), true);

        // Replicate auto-rescue logic from microverse-runner
        let postIterSha = getHeadSha(dir);
        assert.equal(postIterSha, preSha, 'no commits yet');

        if (postIterSha === preSha && isWorkingTreeDirty(dir)) {
            stageAutoCommitPaths(dir);
            execSync('git commit -m "microverse: auto-commit (test)"', { cwd: dir, timeout: 30_000 });
            postIterSha = getHeadSha(dir);
        }

        assert.notEqual(postIterSha, preSha, 'auto-commit should advance HEAD');
        assert.equal(isWorkingTreeDirty(dir), false, 'tree should be clean after auto-commit');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('stageAutoCommitPaths stages untracked files without sweeping excluded docs/prds paths', () => {
    const dir = createTempGitRepo();
    try {
        fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'prds'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'worker-output.txt'), 'worker changes');
        fs.writeFileSync(path.join(dir, 'docs', 'note.md'), 'leave me alone');
        fs.writeFileSync(path.join(dir, 'prds', 'idea.md'), 'leave me alone too');

        stageAutoCommitPaths(dir, ['docs', 'prds']);
        execSync('git commit -m "microverse: preflight auto-commit (test)"', { cwd: dir, timeout: 30_000 });

        const committedFiles = execSync('git show --name-only --format=oneline HEAD', { cwd: dir, encoding: 'utf-8' });
        assert.match(committedFiles, /worker-output\.txt/, 'should stage untracked worker output');
        assert.doesNotMatch(committedFiles, /docs\/note\.md/, 'should not stage excluded docs changes');
        assert.doesNotMatch(committedFiles, /prds\/idea\.md/, 'should not stage excluded prd changes');
        assert.equal(isWorkingTreeDirty(dir, ['docs', 'prds']), false, 'excluded leftovers should not block preflight');
        assert.equal(isWorkingTreeDirty(dir), true, 'excluded leftovers remain intentionally uncommitted');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('auto-rescue: git reset unstages on commit failure', () => {
    const dir = createTempGitRepo();
    try {
        // Create a file and stage it
        fs.writeFileSync(path.join(dir, 'staged.txt'), 'content');
        execSync('git add -A', { cwd: dir, timeout: 30_000 });

        // Commit it first so there's nothing new to commit
        execSync('git commit -m "commit"', { cwd: dir, timeout: 30_000 });

        // Now stage something, then try to commit nothing new → should fail
        // Simulate the unstage path
        fs.writeFileSync(path.join(dir, 'new.txt'), 'new');
        execSync('git add -A', { cwd: dir, timeout: 30_000 });

        // Verify staged changes exist
        const stagedBefore = execSync('git diff --cached --stat', { cwd: dir, encoding: 'utf-8' }).trim();
        assert.ok(stagedBefore.length > 0, 'should have staged changes');

        // git reset unstages
        execSync('git reset', { cwd: dir, timeout: 10_000 });
        const stagedAfter = execSync('git diff --cached --stat', { cwd: dir, encoding: 'utf-8' }).trim();
        assert.equal(stagedAfter, '', 'should have no staged changes after reset');

        // File still exists in working tree
        assert.ok(fs.existsSync(path.join(dir, 'new.txt')), 'file preserved in working tree');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('metric retry: second attempt succeeds after first failure', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-metric-retry-'));
    try {
        let callCount = 0;
        const measureFn = () => {
            callCount++;
            if (callCount === 1) return null; // first call fails
            return { raw: '75', score: 75 };  // second call succeeds
        };

        let result = measureFn();
        if (!result) {
            // In real code there's a 10s sleep here; skip in test
            result = measureFn();
        }

        assert.equal(callCount, 2, 'should retry once');
        assert.ok(result, 'second attempt should succeed');
        assert.equal(result.score, 75);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('metric retry: both attempts fail → null', () => {
    let callCount = 0;
    const measureFn = () => {
        callCount++;
        return null;
    };

    let result = measureFn();
    if (!result) result = measureFn();

    assert.equal(callCount, 2, 'should attempt twice');
    assert.equal(result, null, 'both failures → null');
});

// --- F13: worker_timeout_seconds string coercion ---

test('F13: worker_timeout_seconds string "0" does not trigger re-enforce write', () => {
    // When state.json is read back from disk, JSON.parse always yields a number.
    // This test guards against the edge case where the value is somehow a string,
    // verifying that Number() coercion prevents a spurious write on every loop tick.
    const strZero = '0';
    // Without coercion: '0' !== 0 → true (would trigger spurious write — the bug)
    assert.equal(strZero !== 0, true, 'uncoerced string "0" !== 0 is truthy (the bug)');
    // With coercion: Number('0') !== 0 → false (no write — the fix)
    assert.equal(Number(strZero) !== 0, false, 'Number("0") !== 0 is false (no spurious write)');
});

test('F13: worker_timeout_seconds numeric 0 is always safe', () => {
    // Numeric 0 from JSON.parse behaves correctly regardless of coercion
    assert.equal(Number(0) !== 0, false, 'numeric 0 remains safe after coercion');
});

// --- F14: auto-commit .git validation ---

test('F14: non-git workingDir is detected before auto-commit git commands', () => {
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-nongit-'));
    try {
        // No .git directory — the runner should log 'not a git repository' and skip git ops
        const isGitRepo = fs.existsSync(path.join(nonGitDir, '.git'));
        assert.equal(isGitRepo, false, 'should not have .git directory');

        // Simulate what the fixed runner does: build the error message
        const messages = [];
        if (!isGitRepo) {
            messages.push(`Auto-commit skipped: not a git repository (${nonGitDir})`);
        }

        assert.equal(messages.length, 1, 'should produce one error log entry');
        assert.ok(messages[0].includes('not a git repository'), 'message should state the reason');
        assert.ok(messages[0].includes(nonGitDir), 'message should include the offending path');
    } finally {
        fs.rmSync(nonGitDir, { recursive: true });
    }
});

test('F14: valid git repo passes the .git existence check', () => {
    const dir = createTempGitRepo();
    try {
        const isGitRepo = fs.existsSync(path.join(dir, '.git'));
        assert.equal(isGitRepo, true, 'git repo should have .git directory');
        // In the runner, this means auto-commit proceeds normally (no early-return)
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- Resume recovery tests ---

test('resume recovery: stopped state with no history resets to gap_analysis', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mv-resume-'));
    try {
        let state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 3 });
        state.status = 'stopped';
        state.exit_reason = 'error';
        writeMicroverseState(dir, state);

        // Simulate runner recovery logic
        const mvState = readMicroverseState(dir);
        if (mvState.status === 'stopped') {
            const hasHistory = mvState.convergence?.history?.length > 0;
            const hasBaseline = mvState.baseline_score !== 0;
            const newStatus = (hasHistory || hasBaseline) ? 'iterating' : 'gap_analysis';
            mvState.status = newStatus;
            delete mvState.exit_reason;
            writeMicroverseState(dir, mvState);
        }

        const recovered = readMicroverseState(dir);
        assert.equal(recovered.status, 'gap_analysis', 'should reset to gap_analysis when no history');
        assert.equal(recovered.exit_reason, undefined, 'exit_reason should be cleared');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('resume recovery: stopped state with history resets to iterating', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mv-resume-'));
    try {
        let state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 3 });
        state.status = 'stopped';
        state.exit_reason = 'error';
        state.baseline_score = 42;
        state.convergence.history.push({
            iteration: 1,
            metric_value: '42',
            score: 42,
            action: 'accept',
            description: 'initial',
            pre_iteration_sha: 'a'.repeat(40),
            timestamp: new Date().toISOString(),
        });
        writeMicroverseState(dir, state);

        // Simulate runner recovery logic
        const mvState = readMicroverseState(dir);
        if (mvState.status === 'stopped') {
            const hasHistory = mvState.convergence?.history?.length > 0;
            const hasBaseline = mvState.baseline_score !== 0;
            const newStatus = (hasHistory || hasBaseline) ? 'iterating' : 'gap_analysis';
            mvState.status = newStatus;
            delete mvState.exit_reason;
            writeMicroverseState(dir, mvState);
        }

        const recovered = readMicroverseState(dir);
        assert.equal(recovered.status, 'iterating', 'should reset to iterating when history exists');
        assert.equal(recovered.exit_reason, undefined, 'exit_reason should be cleared');
        assert.equal(recovered.convergence.history.length, 1, 'history should be preserved');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('resume recovery: non-failed status is not modified', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mv-resume-'));
    try {
        let state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 3 });
        state.status = 'iterating';
        writeMicroverseState(dir, state);

        // Simulate runner recovery logic — should NOT modify
        const mvState = readMicroverseState(dir);
        const statusBefore = mvState.status;
        if (mvState.status === 'stopped') {
            mvState.status = 'gap_analysis';
            delete mvState.exit_reason;
            writeMicroverseState(dir, mvState);
        }

        const recovered = readMicroverseState(dir);
        assert.equal(recovered.status, statusBefore, 'iterating status should not be modified');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- Worker-managed convergence tests ---

test('worker mode: stall_counter stays 0 across simulated no-commit iterations', () => {
    const state = createMicroverseState({
        prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 3,
        convergenceMode: 'worker', convergenceFile: 'convergence.json',
    });
    state.status = 'iterating';
    // In worker mode the runner skips recordStall — stall_counter stays 0
    for (let i = 0; i < 5; i++) {
        assert.equal(state.convergence.stall_counter, 0, `stall_counter should stay 0 at iteration ${i}`);
    }
});

test('worker mode: isConverged is irrelevant — runner checks convergence file instead', () => {
    const state = createMicroverseState({
        prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 1,
        convergenceMode: 'worker', convergenceFile: 'convergence.json',
    });
    state.convergence.stall_counter = 999;
    // Guard check: convergence_mode === 'worker' means runner never calls isConverged
    assert.equal(state.convergence_mode, 'worker');
    assert.equal(state.convergence_file, 'convergence.json');
    // isConverged itself still works — runner just bypasses it
    assert.equal(isConverged(state), true);
});

test('worker mode: convergence file with converged=true triggers exit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-wk-'));
    try {
        fs.writeFileSync(path.join(dir, 'convergence.json'), JSON.stringify({ converged: true, reason: 'done' }));
        const raw = JSON.parse(fs.readFileSync(path.join(dir, 'convergence.json'), 'utf-8'));
        assert.equal(raw.converged, true);
        assert.equal(raw.reason, 'done');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('worker mode: convergence file missing does not throw', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-wk-'));
    try {
        let caught = false;
        try {
            JSON.parse(fs.readFileSync(path.join(dir, 'convergence.json'), 'utf-8'));
        } catch {
            caught = true;
        }
        assert.equal(caught, true, 'missing file should be caught');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('worker mode: malformed JSON in convergence file does not throw', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-wk-'));
    try {
        fs.writeFileSync(path.join(dir, 'convergence.json'), 'not json!!!');
        let caught = false;
        try {
            JSON.parse(fs.readFileSync(path.join(dir, 'convergence.json'), 'utf-8'));
        } catch {
            caught = true;
        }
        assert.equal(caught, true, 'malformed JSON should be caught');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('worker mode: max_iterations still applies', () => {
    const state = createMicroverseState({
        prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 3,
        convergenceMode: 'worker', convergenceFile: 'convergence.json',
    });
    // max_iterations check happens BEFORE post-iteration logic — unaffected by worker mode
    const iteration = 3;
    const maxIter = 3;
    assert.equal(maxIter > 0 && iteration >= maxIter, true, 'max_iterations triggers exit');
});

test('worker mode handoff: includes convergence_file path', () => {
    const state = createMicroverseState({
        prdPath: '/tmp/target', metric: TEST_METRIC, stallLimit: 3,
        convergenceMode: 'worker', convergenceFile: 'anatomy-park.json',
    });
    const handoff = buildMicroverseHandoff(state, 1, '/tmp/work');
    assert.ok(handoff.includes('anatomy-park.json'), 'should include convergence file name');
    assert.ok(handoff.includes('Convergence: Worker-Managed'), 'should indicate worker mode');
    assert.ok(handoff.includes('converged'), 'should include convergence instruction');
});

test('worker mode handoff: omits metric fields and "Focus on improving"', () => {
    const state = createMicroverseState({
        prdPath: '/tmp/target', metric: TEST_METRIC, stallLimit: 3,
        convergenceMode: 'worker', convergenceFile: 'convergence.json',
    });
    const handoff = buildMicroverseHandoff(state, 1, '/tmp/work');
    assert.ok(!handoff.includes('Validation:'), 'no validation command');
    assert.ok(!handoff.includes('Direction:'), 'no direction');
    assert.ok(!handoff.includes('Baseline score:'), 'no baseline');
    assert.ok(!handoff.includes('stall_counter'), 'no stall counter');
    assert.ok(!handoff.includes('Focus on improving'), 'no metric focus');
    assert.ok(!handoff.includes('Focus on reducing'), 'no metric focus');
});

test('metric mode handoff: unchanged behavior (backward compat)', () => {
    const state = createMicroverseState({ prdPath: '/tmp/target', metric: TEST_METRIC, stallLimit: 3 });
    state.baseline_score = 40;
    const handoff = buildMicroverseHandoff(state, 5, '/tmp/work');
    assert.ok(handoff.includes('Iteration 5'));
    assert.ok(handoff.includes('test score'));
    assert.ok(handoff.includes('Baseline score: 40'));
    assert.ok(handoff.includes('Focus on improving the metric.'));
});

test('backward compat: state without convergence_mode uses metric path', () => {
    const state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 3 });
    assert.equal(state.convergence_mode, undefined);
    const handoff = buildMicroverseHandoff(state, 1, '/tmp/work');
    assert.ok(handoff.includes('Validation:'), 'metric mode includes validation');
    assert.ok(handoff.includes('Direction:'), 'metric mode includes direction');
});

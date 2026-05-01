/**
 * crash-recovery.test.js
 *
 * Integration tests for StateManager crash-recovery scenarios:
 *
 *   1. Orphan tmpfile with higher iteration → promoted to state.json
 *   2. Orphan tmpfile with same/lower iteration → deleted
 *   3. state.json active=true, microverse.json missing → readMicroverseState returns null gracefully
 *   4. state.json active=true with stale (dead) PID → sm.read clears active=false
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StateManager } from '../services/state-manager.js';
import { StateError } from '../types/index.js';
import { writeStateFile } from '../services/pickle-utils.js';
import { readMicroverseState } from '../services/microverse-state.js';

function makeTmpDir() {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-crash-rec-')));
}

function makeState(overrides = {}) {
    return {
        active: true,
        working_dir: '/tmp/test',
        step: 'implement',
        iteration: 3,
        max_iterations: 10,
        max_time_minutes: 60,
        worker_timeout_seconds: 1200,
        start_time_epoch: Math.floor(Date.now() / 1000),
        completion_promise: null,
        original_prompt: 'test',
        current_ticket: null,
        history: [],
        started_at: new Date().toISOString(),
        session_dir: '/tmp/test-session',
        schema_version: 1,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// 1. Orphan tmpfile with HIGHER iteration → promoted (renamed) to state.json
// ---------------------------------------------------------------------------

test('crash-recovery: orphan tmpfile with higher iteration is promoted to state.json', () => {
    const dir = makeTmpDir();
    try {
        const sm = new StateManager({ lockJitter: false });
        const statePath = path.join(dir, 'state.json');

        // Write current state (iteration=3)
        const currentState = makeState({ iteration: 3 });
        writeStateFile(statePath, currentState);

        // Simulate crash: write a tmpfile with a HIGHER iteration (dead PID = 99999999)
        const deadPid = 99999999;
        const tmpPath = `${statePath}.tmp.${deadPid}`;
        const promotedState = makeState({ iteration: 7, step: 'review' });
        fs.writeFileSync(tmpPath, JSON.stringify(promotedState, null, 2));

        // Reading state should detect the orphan tmpfile and promote it
        const result = sm.read(statePath);

        // After promotion, state.json should reflect the higher-iteration tmp
        assert.equal(result.iteration, 7, 'promoted tmpfile iteration wins');
        assert.equal(result.step, 'review', 'promoted tmpfile step is preserved');

        // The tmpfile should no longer exist
        assert.equal(
            fs.existsSync(tmpPath), false,
            'orphan tmpfile must be removed after promotion'
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// 2. Orphan tmpfile with LOWER iteration → deleted; newer SAME iteration → promoted
// ---------------------------------------------------------------------------

test('crash-recovery: orphan tmpfile with lower iteration is deleted, not promoted', () => {
    const dir = makeTmpDir();
    try {
        const sm = new StateManager({ lockJitter: false });
        const statePath = path.join(dir, 'state.json');

        // Current state at iteration=5
        const currentState = makeState({ iteration: 5 });
        writeStateFile(statePath, currentState);

        // Orphan tmpfile at iteration=2 (older — should be deleted)
        const deadPid = 99999998;
        const tmpPath = `${statePath}.tmp.${deadPid}`;
        const olderState = makeState({ iteration: 2 });
        fs.writeFileSync(tmpPath, JSON.stringify(olderState, null, 2));

        const result = sm.read(statePath);

        // State should remain at iteration=5
        assert.equal(result.iteration, 5, 'current state preserved when tmpfile is older');

        // Tmpfile should be cleaned up
        assert.equal(
            fs.existsSync(tmpPath), false,
            'stale lower-iteration tmpfile must be deleted'
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('crash-recovery: newer orphan tmpfile with SAME iteration is promoted', () => {
    const dir = makeTmpDir();
    try {
        const sm = new StateManager({ lockJitter: false });
        const statePath = path.join(dir, 'state.json');
        const baseTs = new Date('2026-04-28T12:00:00.000Z');
        const tmpTs = new Date('2026-04-28T12:00:01.000Z');

        const currentState = makeState({ iteration: 4, backend: 'claude', active: true });
        writeStateFile(statePath, currentState);
        fs.utimesSync(statePath, baseTs, baseTs);

        const deadPid = 99999997;
        const tmpPath = `${statePath}.tmp.${deadPid}`;
        const sameIterState = makeState({ iteration: 4, backend: 'codex', active: false });
        fs.writeFileSync(tmpPath, JSON.stringify(sameIterState, null, 2));
        fs.utimesSync(tmpPath, tmpTs, tmpTs);

        const result = sm.read(statePath);
        assert.equal(result.iteration, 4);
        assert.equal(result.backend, 'codex');
        assert.equal(result.active, false);
        assert.equal(fs.existsSync(tmpPath), false, 'promoted same-iteration tmpfile must be consumed');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('crash-recovery: corrupt orphan tmpfile (invalid JSON) is deleted', () => {
    const dir = makeTmpDir();
    try {
        const sm = new StateManager({ lockJitter: false });
        const statePath = path.join(dir, 'state.json');

        const currentState = makeState({ iteration: 2 });
        writeStateFile(statePath, currentState);

        const deadPid = 99999996;
        const tmpPath = `${statePath}.tmp.${deadPid}`;
        fs.writeFileSync(tmpPath, '{{{not valid json');

        const result = sm.read(statePath);
        assert.equal(result.iteration, 2, 'state unchanged after corrupt tmpfile removed');
        assert.equal(fs.existsSync(tmpPath), false, 'corrupt tmpfile must be deleted');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// 3. state.json active=true, microverse.json missing
//    StateManager reads state fine; readMicroverseState returns null gracefully
// ---------------------------------------------------------------------------

test('crash-recovery: state active=true with microverse.json missing — no throw, returns null', () => {
    const dir = makeTmpDir();
    try {
        const sm = new StateManager({ lockJitter: false });
        const statePath = path.join(dir, 'state.json');

        // State claims active but no microverse.json exists
        const state = makeState({ active: true, step: 'implement', iteration: 2 });
        writeStateFile(statePath, state);

        // sm.read should succeed (state is valid)
        const result = sm.read(statePath);
        assert.equal(result.active, true);
        assert.equal(result.iteration, 2);

        // readMicroverseState should return null (file missing), not throw
        const mv = readMicroverseState(dir);
        assert.equal(mv, null, 'missing microverse.json returns null, not throw');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('crash-recovery: state.json has iteration mismatch with microverse history — graceful mismatch', () => {
    const dir = makeTmpDir();
    try {
        const sm = new StateManager({ lockJitter: false });
        const statePath = path.join(dir, 'state.json');

        // state.json says iteration=3 but microverse.json only has 1 history entry
        const state = makeState({ iteration: 3, step: 'implement' });
        writeStateFile(statePath, state);

        const mvPath = path.join(dir, 'microverse.json');
        const mvState = {
            status: 'iterating',
            prd_path: 'prd.md',
            key_metric: {
                description: 'score',
                validation: 'echo 5',
                type: 'command',
                tolerance: 0.5,
                timeout_seconds: 10,
                direction: 'higher',
            },
            convergence: {
                stall_limit: 3,
                stall_counter: 0,
                // Only 1 entry even though state says iteration=3 — mismatch
                history: [{
                    iteration: 1,
                    metric_value: '7',
                    score: 7.0,
                    action: 'accept',
                    description: 'improved',
                    pre_iteration_sha: 'abc123',
                    timestamp: new Date().toISOString(),
                }],
            },
            gap_analysis_path: '',
            failed_approaches: [],
            baseline_score: 5.0,
        };
        fs.writeFileSync(mvPath, JSON.stringify(mvState, null, 2));

        // Both reads should succeed despite the logical mismatch
        const readState = sm.read(statePath);
        assert.equal(readState.iteration, 3);

        const readMv = readMicroverseState(dir);
        assert.ok(readMv !== null);
        assert.equal(readMv.convergence.history.length, 1, 'microverse history has 1 entry as written');

        // The system treats each file as authoritative for its own domain
        const delta = readState.iteration - readMv.convergence.history.length;
        assert.equal(delta, 2, 'mismatch detected: state ahead by 2 iterations');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// 4. Stale active flag + dead PID → cleared to inactive on read
// ---------------------------------------------------------------------------

test('crash-recovery: stale active=true with dead PID is cleared to false', () => {
    const dir = makeTmpDir();
    try {
        const sm = new StateManager({ lockJitter: false });
        const statePath = path.join(dir, 'state.json');

        // Use a PID that is guaranteed to be dead (very large number)
        const deadPid = 99999999;
        const staleState = makeState({ active: true, pid: deadPid });
        writeStateFile(statePath, staleState);

        // sm.read should detect dead PID and clear active
        const result = sm.read(statePath);
        assert.equal(result.active, false, 'active cleared when PID is dead');

        // Verify the file was updated on disk as well
        const onDisk = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(onDisk.active, false, 'state.json updated on disk after stale-active recovery');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('crash-recovery: active=false with any PID — no modification', () => {
    const dir = makeTmpDir();
    try {
        const sm = new StateManager({ lockJitter: false });
        const statePath = path.join(dir, 'state.json');

        const inactiveState = makeState({ active: false, pid: 99999999, iteration: 6 });
        writeStateFile(statePath, inactiveState);

        const result = sm.read(statePath);
        // Should not touch active when it's already false
        assert.equal(result.active, false);
        assert.equal(result.iteration, 6, 'iteration unchanged');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('crash-recovery: active=true with no PID — not cleared (no PID to validate)', () => {
    const dir = makeTmpDir();
    try {
        const sm = new StateManager({ lockJitter: false });
        const statePath = path.join(dir, 'state.json');

        // active=true but no pid field — stale active check skips (no PID to check)
        const noPidState = makeState({ active: true });
        delete noPidState.pid;
        writeStateFile(statePath, noPidState);

        const result = sm.read(statePath);
        // With no PID, recovery cannot validate — active preserved as-is
        assert.equal(result.active, true, 'active preserved when no pid field');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('crash-recovery: active=true with current process PID — not cleared (process alive)', () => {
    const dir = makeTmpDir();
    try {
        const sm = new StateManager({ lockJitter: false });
        const statePath = path.join(dir, 'state.json');

        // Use current PID — process is alive so active should not be cleared
        const aliveState = makeState({ active: true, pid: process.pid });
        writeStateFile(statePath, aliveState);

        const result = sm.read(statePath);
        assert.equal(result.active, true, 'active preserved when PID is alive');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Multiple orphan tmpfiles — only the highest-iteration one gets promoted
// ---------------------------------------------------------------------------

test('crash-recovery: multiple orphan tmpfiles — highest iteration wins', () => {
    const dir = makeTmpDir();
    try {
        const sm = new StateManager({ lockJitter: false });
        const statePath = path.join(dir, 'state.json');

        // Base state at iteration=2
        writeStateFile(statePath, makeState({ iteration: 2 }));

        // Three dead-process tmpfiles at iterations 5, 8, 4
        const deadPids = [99999991, 99999992, 99999993];
        const iterations = [5, 8, 4];
        for (let i = 0; i < deadPids.length; i++) {
            const tmpPath = `${statePath}.tmp.${deadPids[i]}`;
            fs.writeFileSync(tmpPath, JSON.stringify(makeState({ iteration: iterations[i] }), null, 2));
        }

        const result = sm.read(statePath);

        // Only iteration=8 should win
        assert.equal(result.iteration, 8, 'highest-iteration orphan promoted');

        // All tmpfiles should be gone
        for (const pid of deadPids) {
            const tmpPath = `${statePath}.tmp.${pid}`;
            assert.equal(fs.existsSync(tmpPath), false, `tmpfile for pid ${pid} must be removed`);
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

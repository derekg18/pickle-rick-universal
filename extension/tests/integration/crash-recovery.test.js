/**
 * crash-recovery.test.js — Integration tests for StateManager crash-recovery protocols.
 *
 * Tests orphan tmp promotion, stale lock stealing, and active flag clearing
 * with real filesystem operations.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StateManager } from '../../services/state-manager.js';
import { writeStateFile } from '../../services/pickle-utils.js';
import { LockError } from '../../types/index.js';
import {
  createMicroverseState,
  writeMicroverseState,
  readMicroverseState,
} from '../../services/microverse-state.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-cr-'));
}

function makeState(overrides = {}) {
  return {
    active: true,
    working_dir: '/tmp/test',
    step: 'prd',
    iteration: 1,
    max_iterations: 10,
    max_time_minutes: 60,
    worker_timeout_seconds: 1200,
    start_time_epoch: Math.floor(Date.now() / 1000),
    completion_promise: null,
    original_prompt: 'crash test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: '/tmp/test-session',
    schema_version: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Orphan tmp promotion — crash left a higher-iteration tmp behind
// ---------------------------------------------------------------------------

test('CR-1: StateManager.read() promotes orphan tmp with higher iteration than main file', () => {
  const dir = tmpDir();
  try {
    const sm = new StateManager();
    const statePath = path.join(dir, 'state.json');

    // Main file has iteration 5 (last successful write)
    writeStateFile(statePath, makeState({ iteration: 5 }));

    // Crash left behind iteration 8 in tmp (dead PID)
    const tmpPath = `${statePath}.tmp.99999999`;
    fs.writeFileSync(tmpPath, JSON.stringify(makeState({ iteration: 8 })));

    const state = sm.read(statePath);
    assert.equal(state.iteration, 8, 'higher-iteration tmp must be promoted');
    assert.equal(fs.existsSync(tmpPath), false, 'promoted tmp file must be consumed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CR-2: StateManager.read() deletes orphan tmp with lower-or-equal iteration', () => {
  const dir = tmpDir();
  try {
    const sm = new StateManager();
    const statePath = path.join(dir, 'state.json');

    writeStateFile(statePath, makeState({ iteration: 10 }));

    // Stale tmp with lower iteration (from earlier write attempt)
    const tmpPath = `${statePath}.tmp.99999999`;
    fs.writeFileSync(tmpPath, JSON.stringify(makeState({ iteration: 3 })));

    const state = sm.read(statePath);
    assert.equal(state.iteration, 10, 'main file iteration should win');
    assert.equal(fs.existsSync(tmpPath), false, 'lower-iteration tmp must be deleted');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CR-3: StateManager.read() deletes orphan tmp with corrupt JSON', () => {
  const dir = tmpDir();
  try {
    const sm = new StateManager();
    const statePath = path.join(dir, 'state.json');
    writeStateFile(statePath, makeState());

    const tmpPath = `${statePath}.tmp.99999999`;
    fs.writeFileSync(tmpPath, '{ this is not valid JSON ');

    sm.read(statePath);
    assert.equal(fs.existsSync(tmpPath), false, 'corrupt tmp must be deleted');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CR-4: StateManager.read() does NOT touch tmp belonging to a live process', () => {
  const dir = tmpDir();
  try {
    const sm = new StateManager();
    const statePath = path.join(dir, 'state.json');
    writeStateFile(statePath, makeState({ iteration: 5 }));

    // Use current PID — definitely alive
    const tmpPath = `${statePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(makeState({ iteration: 100 })));

    const state = sm.read(statePath);
    assert.equal(state.iteration, 5, 'live-process tmp must not be promoted');
    assert.equal(fs.existsSync(tmpPath), true, 'live-process tmp must be preserved');

    fs.unlinkSync(tmpPath); // cleanup
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Stale active flag — dead PID
// ---------------------------------------------------------------------------

test('CR-5: StateManager.read() clears active=true when owning PID is dead', () => {
  const dir = tmpDir();
  try {
    const sm = new StateManager();
    const statePath = path.join(dir, 'state.json');
    writeStateFile(statePath, makeState({ active: true, pid: 99_999_999 }));

    const state = sm.read(statePath);
    assert.equal(state.active, false, 'active must be cleared for dead PID');

    // Verify persisted
    const onDisk = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.equal(onDisk.active, false, 'cleared active must be written to disk');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CR-6: StateManager.read() leaves active=true when no pid set (externally managed)', () => {
  const dir = tmpDir();
  try {
    const sm = new StateManager();
    const statePath = path.join(dir, 'state.json');
    writeStateFile(statePath, makeState({ active: true, pid: undefined }));

    const state = sm.read(statePath);
    assert.equal(state.active, true, 'active must not be cleared when pid is absent');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Stale lock stealing
// ---------------------------------------------------------------------------

test('CR-7: StateManager.update() steals lock from dead-PID process and succeeds', () => {
  const dir = tmpDir();
  try {
    const sm = new StateManager({ staleLockTimeoutMs: 100 });
    const statePath = path.join(dir, 'state.json');
    writeStateFile(statePath, makeState());

    // Leave a stale lock from a dead PID with an old timestamp
    fs.writeFileSync(
      `${statePath}.lock`,
      JSON.stringify({ pid: 99_999_999, ts: Date.now() - 500 }),
    );

    const result = sm.update(statePath, (s) => { s.step = 'research'; });
    assert.equal(result.step, 'research');
    assert.equal(fs.existsSync(`${statePath}.lock`), false, 'lock must be released');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CR-8: StateManager.update() throws LockError when lock held by live process', () => {
  const dir = tmpDir();
  try {
    const sm = new StateManager({ maxLockRetries: 1, baseLockDelayMs: 5, staleLockTimeoutMs: 999_999 });
    const statePath = path.join(dir, 'state.json');
    writeStateFile(statePath, makeState());

    // Lock held by current (live) process
    fs.writeFileSync(`${statePath}.lock`, JSON.stringify({ pid: process.pid, ts: Date.now() }));

    try {
      sm.update(statePath, () => {});
      assert.fail('expected LockError');
    } catch (err) {
      assert.ok(err instanceof LockError, `expected LockError, got ${err.constructor?.name}`);
    } finally {
      try { fs.unlinkSync(`${statePath}.lock`); } catch { /* ok */ }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Multiple recovery events in same directory
// ---------------------------------------------------------------------------

test('CR-9: multiple orphan tmp files in same dir are all cleaned up', () => {
  const dir = tmpDir();
  try {
    const sm = new StateManager();
    const statePath = path.join(dir, 'state.json');
    writeStateFile(statePath, makeState({ iteration: 5 }));

    // Several orphan tmps from dead PIDs
    const deadPids = [99_999_990, 99_999_991, 99_999_992];
    for (const pid of deadPids) {
      fs.writeFileSync(`${statePath}.tmp.${pid}`, JSON.stringify(makeState({ iteration: 2 })));
    }

    sm.read(statePath);

    for (const pid of deadPids) {
      assert.equal(
        fs.existsSync(`${statePath}.tmp.${pid}`),
        false,
        `orphan tmp for PID ${pid} must be cleaned up`,
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CR-10: recovery is idempotent — reading a recovered file twice produces same result', () => {
  const dir = tmpDir();
  try {
    const sm = new StateManager();
    const statePath = path.join(dir, 'state.json');
    writeStateFile(statePath, makeState({ iteration: 5, active: true, pid: 99_999_999 }));

    const s1 = sm.read(statePath);
    const s2 = sm.read(statePath);

    assert.equal(s1.active, false);
    assert.equal(s2.active, false);
    assert.equal(s1.iteration, s2.iteration);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// State-microverse mismatch — crash between state write and microverse write
// ---------------------------------------------------------------------------

const MV_METRIC = {
  description: 'crash-recovery metric',
  validation: 'echo 0',
  type: 'command',
  timeout_seconds: 30,
  tolerance: 1,
};

test('CR-11: orphan tmp promoted while microverse.json lags — both remain independently readable', () => {
  const dir = tmpDir();
  try {
    const sm = new StateManager();
    const statePath = path.join(dir, 'state.json');

    // Main state: iteration 5 (last successful write before crash)
    writeStateFile(statePath, makeState({ iteration: 5 }));

    // Crash left behind iteration 7 in a dead-PID tmp (partial write)
    const tmpPath = `${statePath}.tmp.99999999`;
    fs.writeFileSync(tmpPath, JSON.stringify(makeState({ iteration: 7 })));

    // Microverse was NOT updated — still reflects the pre-crash state
    const mvState = createMicroverseState({ prdPath: 'prd.md', metric: MV_METRIC, stallLimit: 3 });
    writeMicroverseState(dir, { ...mvState, baseline_score: 50, convergence: { ...mvState.convergence, stall_counter: 2 } });

    // Recovery: StateManager promotes the tmp (iteration 7)
    const state = sm.read(statePath);
    assert.equal(state.iteration, 7, 'orphan tmp must be promoted to main state');
    assert.equal(fs.existsSync(tmpPath), false, 'promoted tmp must be consumed');

    // Microverse is still readable and unchanged (state-microverse mismatch tolerated)
    const mv = readMicroverseState(dir);
    assert.ok(mv !== null, 'microverse.json must still be readable after state recovery');
    assert.equal(mv.convergence.stall_counter, 2, 'microverse stall_counter must be unaffected by state recovery');
    assert.equal(mv.baseline_score, 50, 'microverse baseline_score must be unaffected');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CR-12: stale active=true + dead PID cleared, microverse.json is not touched', () => {
  const dir = tmpDir();
  try {
    const sm = new StateManager();
    const statePath = path.join(dir, 'state.json');

    // State has stale active flag from a dead process
    writeStateFile(statePath, makeState({ active: true, pid: 99_999_999, iteration: 3 }));

    // Microverse reflects the in-progress session
    const mvBase = createMicroverseState({ prdPath: 'prd.md', metric: MV_METRIC, stallLimit: 3 });
    const mvBefore = { ...mvBase, status: 'iterating', convergence: { ...mvBase.convergence, stall_counter: 1 } };
    writeMicroverseState(dir, mvBefore);

    // Capture microverse file mtime before recovery
    const mvPath = path.join(dir, 'microverse.json');
    const mtimeBefore = fs.statSync(mvPath).mtimeMs;

    // Recovery: StateManager clears active=false
    const state = sm.read(statePath);
    assert.equal(state.active, false, 'stale active flag must be cleared for dead PID');

    const onDisk = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.equal(onDisk.active, false, 'cleared active must be persisted to disk');

    // Microverse.json must be completely untouched
    const mtimeAfter = fs.statSync(mvPath).mtimeMs;
    assert.equal(mtimeAfter, mtimeBefore, 'state recovery must not modify microverse.json');

    const mvAfter = readMicroverseState(dir);
    assert.equal(mvAfter.status, 'iterating', 'microverse status must be unaffected');
    assert.equal(mvAfter.convergence.stall_counter, 1, 'microverse stall_counter must be unaffected');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CR-13: composite crash — orphan tmp promoted AND stale active cleared in one read pass', () => {
  const dir = tmpDir();
  try {
    const sm = new StateManager();
    const statePath = path.join(dir, 'state.json');

    // Main state: iteration 4, active=false (pre-crash checkpoint)
    writeStateFile(statePath, makeState({ iteration: 4, active: false }));

    // Crash left tmp with iteration 9 and active=true from a dead PID
    const tmpPath = `${statePath}.tmp.99999999`;
    fs.writeFileSync(tmpPath, JSON.stringify(makeState({ iteration: 9, active: true, pid: 99_999_999 })));

    // Single sm.read() must: (1) promote tmp, (2) clear stale active flag
    const state = sm.read(statePath);

    assert.equal(state.iteration, 9, 'tmp with higher iteration must be promoted');
    assert.equal(fs.existsSync(tmpPath), false, 'promoted tmp must be consumed');
    assert.equal(state.active, false, 'stale active=true from dead PID must be cleared');

    // Cleared active must be written back to the promoted state file
    const onDisk = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.equal(onDisk.active, false, 'cleared active must be persisted after composite recovery');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

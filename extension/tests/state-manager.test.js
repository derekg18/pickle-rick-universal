import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateManager, writeActivityEntry, safeDeactivate, assertSchemaVersionDeployParity, SchemaVersionDeployDriftError } from '../services/state-manager.js';
import {
  StateError,
  LockError,
  TransactionError,
  SchemaVersionMismatchError,
  STATE_MANAGER_DEFAULTS,
  LATEST_SCHEMA_VERSION,
} from '../types/index.js';
import { writeStateFile } from '../services/pickle-utils.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sm-'));
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
    start_time_epoch: Date.now(),
    completion_promise: null,
    original_prompt: 'test prompt',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: '/tmp/test-session',
    schema_version: 1,
    ...overrides,
  };
}

function withDir(fn) {
  const dir = tmpDir();
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function assertV3Defaults(state) {
  assert.equal(state.archaeology, null);
  assert.equal(state.tickets_version, 0);
  assert.equal(state.last_course_correction, null);
  assert.equal(state.phase_personas_active, false);
  assert.deepEqual(state.flags, {});
  assert.deepEqual(state.readiness, { cycle_history: [] });
  assert.equal(state.codex_version_seen, null);
}

// ---------------------------------------------------------------------------
// read — valid state
// ---------------------------------------------------------------------------

test('StateManager.read: reads valid state file', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    const state = makeState();
    writeStateFile(sp, state);
    const result = sm.read(sp);
    assert.equal(result.active, true);
    assert.equal(result.iteration, 1);
    assert.equal(result.schema_version, 3);
  });
});

// ---------------------------------------------------------------------------
// read — missing file
// ---------------------------------------------------------------------------

test('StateManager.read: throws MISSING for non-existent file', () => {
  const sm = new StateManager();
  try {
    sm.read('/tmp/nonexistent-pickle-state-99999.json');
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof StateError);
    assert.equal(err.code, 'MISSING');
  }
});

// ---------------------------------------------------------------------------
// read — corrupt JSON
// ---------------------------------------------------------------------------

test('StateManager.read: throws CORRUPT for invalid JSON', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    fs.writeFileSync(sp, '{invalid json!!!');
    try {
      sm.read(sp);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof StateError);
      assert.equal(err.code, 'CORRUPT');
    }
  });
});

test('StateManager.read: throws CORRUPT for JSON array', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    fs.writeFileSync(sp, '[1,2,3]');
    try {
      sm.read(sp);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof StateError);
      assert.equal(err.code, 'CORRUPT');
    }
  });
});

test('StateManager.read: throws CORRUPT for JSON null', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    fs.writeFileSync(sp, 'null');
    try {
      sm.read(sp);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof StateError);
      assert.equal(err.code, 'CORRUPT');
    }
  });
});

// ---------------------------------------------------------------------------
// read — schema migration
// ---------------------------------------------------------------------------

test('StateManager.read: migrates undefined schema_version to current schema', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    const state = makeState();
    delete state.schema_version;
    fs.writeFileSync(sp, JSON.stringify(state, null, 2));
    const result = sm.read(sp);
    assert.equal(result.schema_version, 3);
    assertV3Defaults(result);
    // Persisted to disk
    const onDisk = JSON.parse(fs.readFileSync(sp, 'utf-8'));
    assert.equal(onDisk.schema_version, 3);
    assertV3Defaults(onDisk);
  });
});

test('StateManager.read: throws SCHEMA_MISMATCH for future schema version', () => {
  withDir((dir) => {
    // State file claims schema_version 2, but this binary only understands version 1
    const sm = new StateManager({ schemaVersion: 1 });
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({ schema_version: 2 }));
    const tmpFile = `${sp}.tmp.99999999`;
    fs.writeFileSync(tmpFile, JSON.stringify(makeState({ iteration: 10, schema_version: 1 })));
    try {
      sm.read(sp);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof StateError);
      assert.equal(err.code, 'SCHEMA_MISMATCH');
    }
    assert.equal(fs.existsSync(tmpFile), true, 'future-schema base must fail before tmp recovery mutates siblings');
  });
});

test('StateManager.read: v3-shaped missing schema fails recoverably on v2-aware deployment', () => {
  withDir((dir) => {
    const sm = new StateManager({ schemaVersion: 2 });
    const sp = path.join(dir, 'state.json');
    const state = makeState({
      prd_path: path.join(dir, 'prd.md'),
      start_commit: 'abc123',
    });
    delete state.schema_version;
    fs.writeFileSync(sp, JSON.stringify(state, null, 2));

    const tmpFile = `${sp}.tmp.99999999`;
    fs.writeFileSync(tmpFile, JSON.stringify(makeState({ iteration: 10, schema_version: 2 })));

    try {
      sm.read(sp);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof StateError);
      assert.equal(err.code, 'SCHEMA_MISMATCH');
      assert.match(err.message, /schema v3 fields/);
      assert.match(err.message, /prd_path/);
      assert.match(err.message, /start_commit/);
      assert.match(err.message, /supports schema_version 2/);
      assert.match(err.message, /Recover by running a current Pickle Rick runtime or restoring a pre-v3 state backup/);
    }

    const onDisk = JSON.parse(fs.readFileSync(sp, 'utf-8'));
    assert.equal(onDisk.schema_version, undefined, 'v2-aware read must not stamp schema_version on v3-shaped state');
    assert.equal(fs.existsSync(tmpFile), true, 'v3-shaped base must fail before tmp recovery mutates siblings');
  });
});

test('StateManager.read: any v3 marker without schema fails recoverably on v2-aware deployment', () => {
  const cases = [
    ['tickets_version', { tickets_version: 1 }],
    ['phase_personas_active', { phase_personas_active: true }],
    ['flags', { flags: { strict_teams: true } }],
    ['readiness', { readiness: { cycle_history: [] } }],
    ['codex_version_seen', { codex_version_seen: '0.42.0' }],
  ];

  for (const [marker, override] of cases) {
    withDir((dir) => {
      const sm = new StateManager({ schemaVersion: 2 });
      const sp = path.join(dir, 'state.json');
      const state = makeState(override);
      delete state.schema_version;
      fs.writeFileSync(sp, JSON.stringify(state, null, 2));

      try {
        sm.read(sp);
        assert.fail(`should have thrown for ${marker}`);
      } catch (err) {
        assert.ok(err instanceof StateError);
        assert.equal(err.code, 'SCHEMA_MISMATCH');
        assert.match(err.message, /schema v3 fields/);
        assert.match(err.message, new RegExp(String(marker)));
        assert.match(err.message, /supports schema_version 2/);
      }

      const onDisk = JSON.parse(fs.readFileSync(sp, 'utf-8'));
      assert.equal(onDisk.schema_version, undefined, `${marker} read must not stamp schema_version`);
    });
  }
});

test('StateManager.read: migrates past schema version to current schema', () => {
  withDir((dir) => {
    const sm = new StateManager({ schemaVersion: 3 });
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({ schema_version: 2 }));
    const result = sm.read(sp);
    assert.equal(result.schema_version, 3);
    assertV3Defaults(result);
    assert.equal(result.prd_path, undefined);
    assert.equal(result.start_commit, undefined);
    const onDisk = JSON.parse(fs.readFileSync(sp, 'utf-8'));
    assert.equal(onDisk.schema_version, 3);
    assertV3Defaults(onDisk);
    assert.equal('prd_path' in onDisk, false);
    assert.equal('start_commit' in onDisk, false);
  });
});

test('StateManager.read: preserves existing v3 values while hydrating missing defaults', () => {
  withDir((dir) => {
    const sm = new StateManager({ schemaVersion: 3 });
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({
      schema_version: 2,
      tickets_version: 7,
      phase_personas_active: true,
      flags: { strict_teams: true, custom: 'yes' },
      readiness: { cycle_history: [{ cycle: 1, status: 'pass', suggested_analyst: null, user_action: null, timestamp: '2026-04-30T00:00:00Z' }] },
      codex_version_seen: '0.42.0',
    }));

    const result = sm.read(sp);

    assert.equal(result.schema_version, 3);
    assert.equal(result.tickets_version, 7);
    assert.equal(result.phase_personas_active, true);
    assert.deepEqual(result.flags, { strict_teams: true, custom: 'yes' });
    assert.equal(result.readiness.cycle_history.length, 1);
    assert.equal(result.codex_version_seen, '0.42.0');
    assert.equal(result.archaeology, null);
    assert.equal(result.last_course_correction, null);
  });
});

test('StateManager.read: logs to stderr on undefined schema_version migration', () => {
  withDir((dir) => {
    const messages = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (msg) => { messages.push(String(msg)); return true; };
    try {
      const sm = new StateManager();
      const sp = path.join(dir, 'state.json');
      const state = makeState();
      delete state.schema_version;
      fs.writeFileSync(sp, JSON.stringify(state, null, 2));
      sm.read(sp);
      assert.ok(
        messages.some((m) => m.includes('migrating to 1')),
        `expected migration log, got: ${JSON.stringify(messages)}`,
      );
    } finally {
      process.stderr.write = origWrite;
    }
  });
});

// ---------------------------------------------------------------------------
// read — recovery: orphan tmp files
// ---------------------------------------------------------------------------

test('StateManager.read: cleans up orphan tmp file with dead PID', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({ iteration: 5 }));
    // Create orphan tmp file with a dead PID (99999999)
    const tmpFile = `${sp}.tmp.99999999`;
    fs.writeFileSync(tmpFile, JSON.stringify({ iteration: 3 }));
    sm.read(sp);
    assert.equal(fs.existsSync(tmpFile), false, 'orphan tmp should be deleted');
  });
});

test('StateManager.read: promotes orphan tmp file with higher iteration', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({ iteration: 5 }));
    // Create orphan tmp with higher iteration
    const tmpFile = `${sp}.tmp.99999999`;
    fs.writeFileSync(tmpFile, JSON.stringify(makeState({ iteration: 10 })));
    const result = sm.read(sp);
    assert.equal(result.iteration, 10, 'should promote higher iteration');
    assert.equal(fs.existsSync(tmpFile), false, 'tmp file should be consumed');
  });
});

test('StateManager.read: promotes same-iteration orphan tmp before legacy schema migration touches base mtime', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    const base = makeState({ iteration: 5, active: true, current_ticket: 'T-BASE' });
    delete base.schema_version;
    fs.writeFileSync(sp, JSON.stringify(base, null, 2));

    const tmpFile = `${sp}.tmp.99999999`;
    fs.writeFileSync(tmpFile, JSON.stringify(makeState({
      iteration: 5,
      active: false,
      current_ticket: 'T-RECOVERED',
      schema_version: 1,
    }), null, 2));
    const future = new Date(Date.now() + 1000);
    fs.utimesSync(tmpFile, future, future);

    const result = sm.read(sp);

    assert.equal(result.iteration, 5);
    assert.equal(result.active, false);
    assert.equal(result.current_ticket, 'T-RECOVERED');
    assert.equal(fs.existsSync(tmpFile), false, 'same-iteration tmp should be consumed');

    const onDisk = JSON.parse(fs.readFileSync(sp, 'utf-8'));
    assert.equal(onDisk.active, false);
    assert.equal(onDisk.current_ticket, 'T-RECOVERED');
    assert.equal(onDisk.schema_version, 3);
  });
});

test('StateManager.read: promotes orphan tmp when base state.json is corrupt', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    fs.writeFileSync(sp, '{invalid json!!!');
    const tmpFile = `${sp}.tmp.99999999`;
    fs.writeFileSync(tmpFile, JSON.stringify(makeState({
      iteration: 9,
      current_ticket: 'T-RECOVERED',
      step: 'review',
    })));

    const result = sm.read(sp);

    assert.equal(result.iteration, 9, 'recovered tmp iteration should win when base is corrupt');
    assert.equal(result.current_ticket, 'T-RECOVERED');
    assert.equal(result.step, 'review');
    assert.equal(fs.existsSync(tmpFile), false, 'recovered tmp should be consumed');

    const onDisk = JSON.parse(fs.readFileSync(sp, 'utf-8'));
    assert.equal(onDisk.iteration, 9, 'promoted tmp should replace the corrupt base file');
    assert.equal(onDisk.current_ticket, 'T-RECOVERED');
  });
});

test('StateManager.read: deletes orphan tmp with invalid JSON', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState());
    const tmpFile = `${sp}.tmp.99999999`;
    fs.writeFileSync(tmpFile, 'NOT VALID JSON');
    sm.read(sp);
    assert.equal(fs.existsSync(tmpFile), false, 'invalid tmp should be deleted');
  });
});

test('StateManager.read: leaves tmp file from live process alone', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState());
    // Use current PID — definitely alive
    const tmpFile = `${sp}.tmp.${process.pid}`;
    fs.writeFileSync(tmpFile, JSON.stringify({ iteration: 99 }));
    sm.read(sp);
    assert.equal(fs.existsSync(tmpFile), true, 'tmp from live process should remain');
    fs.unlinkSync(tmpFile);
  });
});

// ---------------------------------------------------------------------------
// read — recovery: stale active flag
// ---------------------------------------------------------------------------

test('StateManager.read: clears active flag when pid is dead', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({ active: true, pid: 99999999 }));
    const result = sm.read(sp);
    assert.equal(result.active, false, 'active should be cleared for dead PID');
  });
});

test('StateManager.read: preserves active flag when no pid set', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({ active: true }));
    const result = sm.read(sp);
    assert.equal(result.active, true, 'active should be preserved when no pid');
  });
});

test('StateManager.read: preserves active flag for live pid', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({ active: true, pid: process.pid }));
    const result = sm.read(sp);
    assert.equal(result.active, true, 'active should be preserved for live PID');
  });
});

// ---------------------------------------------------------------------------
// update — basic mutation with lock
// ---------------------------------------------------------------------------

test('StateManager.update: applies mutator and persists', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({ iteration: 1 }));
    const result = sm.update(sp, (s) => { s.iteration = 42; });
    assert.equal(result.iteration, 42);
    // Persisted
    const onDisk = JSON.parse(fs.readFileSync(sp, 'utf-8'));
    assert.equal(onDisk.iteration, 42);
  });
});

test('StateManager.update: no lock file left after success', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState());
    sm.update(sp, (s) => { s.step = 'research'; });
    assert.equal(fs.existsSync(`${sp}.lock`), false, 'lock should be released');
  });
});

test('StateManager.update: releases lock even when mutator throws', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState());
    try {
      sm.update(sp, () => { throw new Error('mutator boom'); });
    } catch { /* expected */ }
    assert.equal(fs.existsSync(`${sp}.lock`), false, 'lock should be released on error');
  });
});

// ---------------------------------------------------------------------------
// forceWrite — best effort, no lock
// ---------------------------------------------------------------------------

test('StateManager.forceWrite: writes state without lock', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    sm.forceWrite(sp, makeState({ iteration: 99 }));
    const onDisk = JSON.parse(fs.readFileSync(sp, 'utf-8'));
    assert.equal(onDisk.iteration, 99);
  });
});

test('StateManager.forceWrite: succeeds even when lock file exists', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState());
    // Create a lock file
    fs.writeFileSync(`${sp}.lock`, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    sm.forceWrite(sp, makeState({ iteration: 77 }));
    const onDisk = JSON.parse(fs.readFileSync(sp, 'utf-8'));
    assert.equal(onDisk.iteration, 77);
    // Cleanup
    try { fs.unlinkSync(`${sp}.lock`); } catch { /* ok */ }
  });
});

test('StateManager.forceWrite: never throws even on bad path', () => {
  const sm = new StateManager();
  // This should not throw
  sm.forceWrite('/nonexistent/path/state.json', makeState());
});

test('StateManager.forceWrite: emits stderr breadcrumb on write failure', () => {
  const sm = new StateManager();
  const originalWrite = process.stderr.write.bind(process.stderr);
  const captured = [];
  process.stderr.write = (chunk, ...rest) => {
    captured.push(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
    return originalWrite(chunk, ...rest);
  };
  try {
    sm.forceWrite('/nonexistent/path/state.json', makeState());
  } finally {
    process.stderr.write = originalWrite;
  }
  const joined = captured.join('');
  assert.ok(
    joined.includes('[state-manager] forceWrite failed'),
    `expected forceWrite failure breadcrumb in stderr, got: ${joined}`,
  );
  assert.ok(
    joined.includes('/nonexistent/path/state.json'),
    `expected target path in stderr breadcrumb, got: ${joined}`,
  );
});

// ---------------------------------------------------------------------------
// transaction — success
// ---------------------------------------------------------------------------

test('StateManager.transaction: mutates multiple files atomically', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp1 = path.join(dir, 'state1.json');
    const sp2 = path.join(dir, 'state2.json');
    writeStateFile(sp1, makeState({ iteration: 1 }));
    writeStateFile(sp2, makeState({ iteration: 2 }));

    const results = sm.transaction([sp1, sp2], (states) => {
      states[0].iteration = 10;
      states[1].iteration = 20;
    });

    assert.equal(results[0].iteration, 10);
    assert.equal(results[1].iteration, 20);

    // Persisted
    const d1 = JSON.parse(fs.readFileSync(sp1, 'utf-8'));
    const d2 = JSON.parse(fs.readFileSync(sp2, 'utf-8'));
    assert.equal(d1.iteration, 10);
    assert.equal(d2.iteration, 20);
  });
});

test('StateManager.transaction: no lock files left after success', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp1 = path.join(dir, 'state1.json');
    const sp2 = path.join(dir, 'state2.json');
    writeStateFile(sp1, makeState());
    writeStateFile(sp2, makeState());

    sm.transaction([sp1, sp2], () => { /* no-op */ });

    assert.equal(fs.existsSync(`${sp1}.lock`), false);
    assert.equal(fs.existsSync(`${sp2}.lock`), false);
  });
});

// ---------------------------------------------------------------------------
// transaction — rollback
// ---------------------------------------------------------------------------

test('StateManager.transaction: rolls back on write failure', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp1 = path.join(dir, 'state1.json');
    const sp2 = path.join(dir, 'state2.json');
    writeStateFile(sp1, makeState({ iteration: 1 }));
    writeStateFile(sp2, makeState({ iteration: 2 }));

    // Make sp2 unwritable after backup is taken
    // We'll do this by having the mutator set a circular reference on states[1]
    // which will cause JSON.stringify to fail during write
    try {
      sm.transaction([sp1, sp2], (states) => {
        states[0].iteration = 100;
        // Create a circular reference to break JSON.stringify
        const circ = {};
        circ.self = circ;
        Object.assign(states[1], { bad: circ });
      });
      assert.fail('should have thrown TransactionError');
    } catch (err) {
      assert.ok(err instanceof TransactionError, `expected TransactionError, got ${err.constructor.name}`);
    }

    // sp1 should be rolled back to original value
    const d1 = JSON.parse(fs.readFileSync(sp1, 'utf-8'));
    assert.equal(d1.iteration, 1, 'sp1 should be rolled back');

    // sp2 should still have original value
    const d2 = JSON.parse(fs.readFileSync(sp2, 'utf-8'));
    assert.equal(d2.iteration, 2, 'sp2 should be unchanged');
  });
});

test('StateManager.transaction: releases locks on failure', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp1 = path.join(dir, 'state1.json');
    writeStateFile(sp1, makeState());

    try {
      sm.transaction([sp1], (states) => {
        const circ = {};
        circ.self = circ;
        Object.assign(states[0], { bad: circ });
      });
    } catch { /* expected */ }

    assert.equal(fs.existsSync(`${sp1}.lock`), false, 'lock should be released');
  });
});

test('StateManager.transaction: refuses write when on-disk schema advances after read', () => {
  withDir((dir) => {
    const sm = new StateManager({ schemaVersion: 3 });
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({ schema_version: 3, iteration: 1 }));

    assert.throws(
      () => sm.transaction([sp], (states) => {
        states[0].iteration = 2;
        fs.writeFileSync(sp, JSON.stringify(makeState({ schema_version: 4, iteration: 99 }), null, 2));
      }),
      (err) => {
        assert.ok(err instanceof SchemaVersionMismatchError);
        assert.equal(err.code, 'SCHEMA_MISMATCH');
        assert.equal(err.onDiskVersion, 4);
        assert.equal(err.cachedVersion, 3);
        return true;
      },
    );

    const onDisk = JSON.parse(fs.readFileSync(sp, 'utf-8'));
    assert.equal(onDisk.schema_version, 4);
    assert.equal(onDisk.iteration, 99);
  });
});

// ---------------------------------------------------------------------------
// Lock — stale lock stealing
// ---------------------------------------------------------------------------

test('StateManager.update: steals stale lock from dead process', () => {
  withDir((dir) => {
    const sm = new StateManager({ staleLockTimeoutMs: 100 });
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState());
    // Create stale lock from dead PID
    fs.writeFileSync(`${sp}.lock`, JSON.stringify({ pid: 99999999, ts: Date.now() - 200 }));
    // Should succeed by stealing the stale lock
    const result = sm.update(sp, (s) => { s.iteration = 7; });
    assert.equal(result.iteration, 7);
  });
});

test('StateManager.update: steals lock with corrupt JSON', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState());
    fs.writeFileSync(`${sp}.lock`, 'NOT JSON AT ALL');
    const result = sm.update(sp, (s) => { s.iteration = 8; });
    assert.equal(result.iteration, 8);
  });
});

// ---------------------------------------------------------------------------
// Lock — failure after max retries
// ---------------------------------------------------------------------------

test('StateManager.update: throws LockError after max retries', () => {
  withDir((dir) => {
    const sm = new StateManager({ maxLockRetries: 1, baseLockDelayMs: 10, staleLockTimeoutMs: 999_999 });
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState());
    // Create lock held by current process (alive, not stale)
    fs.writeFileSync(`${sp}.lock`, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    try {
      sm.update(sp, () => {});
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof LockError, `expected LockError, got ${err.constructor.name}`);
      assert.ok(err.code === 'LOCK_FAILED');
    } finally {
      fs.unlinkSync(`${sp}.lock`);
    }
  });
});

// ---------------------------------------------------------------------------
// Error class hierarchy
// ---------------------------------------------------------------------------

test('StateError: has correct name and code', () => {
  const err = new StateError('CORRUPT', 'bad data');
  assert.equal(err.name, 'StateError');
  assert.equal(err.code, 'CORRUPT');
  assert.equal(err.message, 'bad data');
  assert.ok(err instanceof Error);
});

test('LockError: inherits from StateError with LOCK_FAILED code', () => {
  const err = new LockError('lock test');
  assert.equal(err.name, 'LockError');
  assert.equal(err.code, 'LOCK_FAILED');
  assert.ok(err instanceof StateError);
  assert.ok(err instanceof Error);
});

test('TransactionError: carries rollback errors', () => {
  const rbErr = new Error('rollback failed');
  const err = new TransactionError('tx failed', [rbErr]);
  assert.equal(err.name, 'TransactionError');
  assert.equal(err.code, 'WRITE_FAILED');
  assert.equal(err.rollbackErrors.length, 1);
  assert.equal(err.rollbackErrors[0].message, 'rollback failed');
  assert.ok(err instanceof StateError);
});

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

test('STATE_MANAGER_DEFAULTS: has expected values', () => {
  assert.equal(STATE_MANAGER_DEFAULTS.maxLockRetries, 10);
  assert.equal(STATE_MANAGER_DEFAULTS.baseLockDelayMs, 100);
  assert.equal(STATE_MANAGER_DEFAULTS.lockJitter, true);
  assert.equal(STATE_MANAGER_DEFAULTS.staleLockTimeoutMs, 30_000);
  assert.equal(STATE_MANAGER_DEFAULTS.schemaVersion, 3);
});

// ---------------------------------------------------------------------------
// Constructor: custom options override defaults
// ---------------------------------------------------------------------------

test('StateManager: custom options override defaults', () => {
  withDir((dir) => {
    const sm = new StateManager({ maxLockRetries: 3, baseLockDelayMs: 50 });
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState());
    // Should work with custom options
    const result = sm.read(sp);
    assert.equal(result.schema_version, 3);
  });
});

// ---------------------------------------------------------------------------
// transaction: returns states in original path order
// ---------------------------------------------------------------------------

test('StateManager.transaction: returns states in caller path order (not sorted)', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const spZ = path.join(dir, 'z-state.json');
    const spA = path.join(dir, 'a-state.json');
    writeStateFile(spZ, makeState({ iteration: 100 }));
    writeStateFile(spA, makeState({ iteration: 200 }));

    // Pass in Z before A — results should match that order
    const results = sm.transaction([spZ, spA], () => { /* no-op */ });
    assert.equal(results[0].iteration, 100, 'first result should be Z');
    assert.equal(results[1].iteration, 200, 'second result should be A');
  });
});

// ---------------------------------------------------------------------------
// forceWriteMutate fallback path (via exported helpers)
// ---------------------------------------------------------------------------

test('writeActivityEntry: appends entry via locked update path', () => {
  withDir((dir) => {
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState());
    writeActivityEntry(sp, { ts: '2026-04-23T00:00:00Z', event: 'test', detail: 'one' });
    const read = JSON.parse(fs.readFileSync(sp, 'utf-8'));
    assert.equal(read.activity.length, 1);
    assert.equal(read.activity[0].detail, 'one');
  });
});

test('writeActivityEntry: swallows silently when file missing and no fallback', () => {
  withDir((dir) => {
    const sp = path.join(dir, 'state.json');
    // No file, no lock — update throws StateError, read throws ENOENT, no fallback factory → no write
    assert.doesNotThrow(() => writeActivityEntry(sp, { ts: 't', event: 'e', detail: 'd' }));
    assert.equal(fs.existsSync(sp), false, 'no file should be created');
  });
});

test('safeDeactivate: falls back to {active:false} seed when file unreadable', () => {
  withDir((dir) => {
    const sp = path.join(dir, 'state.json');
    // No file exists — update throws, read fails → fallbackFactory seeds minimal state
    safeDeactivate(sp);
    const read = JSON.parse(fs.readFileSync(sp, 'utf-8'));
    assert.equal(read.active, false);
  });
});

test('safeDeactivate: fallback preserves crash-recovered tmp state before deactivating', () => {
  withDir((dir) => {
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({ iteration: 1, current_ticket: 'T-BASE' }));
    const tmpFile = `${sp}.tmp.99999999`;
    fs.writeFileSync(tmpFile, JSON.stringify(makeState({
      iteration: 2,
      current_ticket: 'T-RECOVERED',
      command_template: 'council-of-ricks.md',
    })));

    const originalUpdate = StateManager.prototype.update;
    StateManager.prototype.update = () => {
      throw new LockError('forced fallback');
    };

    try {
      safeDeactivate(sp);
    } finally {
      StateManager.prototype.update = originalUpdate;
    }

    const recovered = new StateManager().read(sp);
    assert.equal(recovered.iteration, 2, 'fallback must preserve the promoted iteration');
    assert.equal(recovered.current_ticket, 'T-RECOVERED');
    assert.equal(recovered.command_template, 'council-of-ricks.md');
    assert.equal(recovered.active, false);
    assert.equal(fs.existsSync(tmpFile), false, 'recovered tmp should be consumed');
  });
});

// ---------------------------------------------------------------------------
// assertSchemaVersionDeployParity — fail-fast deploy drift guard
// ---------------------------------------------------------------------------

test('assertSchemaVersionDeployParity: returns normally when versions match', () => {
  // The shipped state-manager and types/index agree by construction; calling
  // the function in the current process must be a no-op (no throw, no exit).
  assert.equal(STATE_MANAGER_DEFAULTS.schemaVersion, LATEST_SCHEMA_VERSION);
  assert.doesNotThrow(() => assertSchemaVersionDeployParity());
});

test('SchemaVersionDeployDriftError: message contains no absolute or home-relative path', () => {
  const err = new SchemaVersionDeployDriftError(2, 3);
  // Must not ship any user-specific absolute path or home-dir shorthand.
  assert.doesNotMatch(err.message, /\/Users\//, 'message must not contain /Users/');
  assert.doesNotMatch(err.message, /~\//, 'message must not contain ~/');
  assert.doesNotMatch(err.message, /\$HOME/, 'message must not contain $HOME');
  // The portable guidance must still be present.
  assert.match(err.message, /bash install\.sh/);
});

test('assertSchemaVersionDeployParity: exits 1 with actionable stderr on drift', () => {
  // Spawn a subprocess that imports state-manager.js with monkey-patched
  // STATE_MANAGER_DEFAULTS so we can simulate stale-deploy drift without
  // mutating the real module for the rest of the suite.
  const __filename = fileURLToPath(import.meta.url);
  const testsDir = path.dirname(__filename);
  const stateManagerUrl = new URL('../services/state-manager.js', import.meta.url).href;
  const typesUrl = new URL('../types/index.js', import.meta.url).href;

  const driver = `
    import { STATE_MANAGER_DEFAULTS } from ${JSON.stringify(typesUrl)};
    // Simulate stale-deploy drift: deployed defaults stuck at 3 while a newer
    // LATEST_SCHEMA_VERSION (4) is what the parity check expects.
    STATE_MANAGER_DEFAULTS.schemaVersion = 3;
    const sm = await import(${JSON.stringify(stateManagerUrl)});
    // Override the bound LATEST_SCHEMA_VERSION the function compares against
    // by re-defining the module's view via a local replacement check. Since
    // the function reads LATEST_SCHEMA_VERSION via closure on its imported
    // binding, we instead force the inverse: bump defaults above the latest.
    STATE_MANAGER_DEFAULTS.schemaVersion = 999;
    sm.assertSchemaVersionDeployParity();
    // Should never reach here.
    process.exit(0);
  `;

  const result = spawnSync(process.execPath, ['--input-type=module', '-e', driver], {
    cwd: testsDir,
    encoding: 'utf-8',
    timeout: 30_000,
  });

  assert.equal(result.status, 1, `expected exit 1, got ${result.status}; stderr=${result.stderr}`);
  assert.match(result.stderr, /stale deploy/);
  assert.match(result.stderr, /bash install\.sh/);
});

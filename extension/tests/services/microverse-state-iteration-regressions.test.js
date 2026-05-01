import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  createMicroverseState,
  writeMicroverseState,
  readMicroverseState,
  readRecoverableJsonObject,
} from '../../services/microverse-state.js';

const READ_MICROVERSE_BIN = path.resolve('bin/read-microverse.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mv-iter-reg-'));
}

const BASE_OPTS = {
  prdPath: '/tmp/test.md',
  metric: { name: 'coverage', command: 'echo 80', tolerance: 1 },
  stallLimit: 3,
};

test('createMicroverseState initializes iteration_regressions to 0 and flag to false', () => {
  const state = createMicroverseState(BASE_OPTS);
  assert.equal(state.iteration_regressions, 0);
  assert.equal(state.gate_regression_threshold_warning_emitted, false);
});

test('readMicroverseState defaults iteration_regressions to 0 and flag to false on legacy file', () => {
  const dir = makeTempDir();
  try {
    const legacy = {
      status: 'iterating',
      prd_path: '/tmp/test.md',
      key_metric: { name: 'coverage', command: 'echo 80', tolerance: 1, direction: 'higher' },
      convergence: { stall_limit: 3, stall_counter: 0, history: [] },
      gap_analysis_path: '',
      failed_approaches: [],
      baseline_score: 0,
      failure_history: [],
      approach_exhaustion_fired: false,
      // intentionally omit iteration_regressions and gate_regression_threshold_warning_emitted
    };
    fs.writeFileSync(path.join(dir, 'microverse.json'), JSON.stringify(legacy));
    const state = readMicroverseState(dir);
    assert.notEqual(state, null);
    assert.equal(state.iteration_regressions, 0);
    assert.equal(state.gate_regression_threshold_warning_emitted, false);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('writeMicroverseState preserves modified iteration_regressions across round-trip', () => {
  const dir = makeTempDir();
  try {
    const state = createMicroverseState(BASE_OPTS);
    state.iteration_regressions = 5;
    state.gate_regression_threshold_warning_emitted = true;
    writeMicroverseState(dir, state);
    const read = readMicroverseState(dir);
    assert.notEqual(read, null);
    assert.equal(read.iteration_regressions, 5);
    assert.equal(read.gate_regression_threshold_warning_emitted, true);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('read-microverse CLI promotes dead writer tmp before reading iteration_regressions', () => {
  const dir = makeTempDir();
  try {
    const stale = createMicroverseState(BASE_OPTS);
    stale.iteration_regressions = 0;
    writeMicroverseState(dir, stale);

    const recovered = createMicroverseState(BASE_OPTS);
    recovered.iteration_regressions = 4;
    fs.writeFileSync(path.join(dir, 'microverse.json.tmp.999999'), JSON.stringify(recovered, null, 2));
    const future = new Date(Date.now() + 1000);
    fs.utimesSync(path.join(dir, 'microverse.json.tmp.999999'), future, future);

    const result = spawnSync(process.execPath, [READ_MICROVERSE_BIN, dir, 'iteration_regressions'], {
      cwd: path.resolve('.'),
      encoding: 'utf-8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '4');
    assert.equal(fs.existsSync(path.join(dir, 'microverse.json.tmp.999999')), false);
    assert.equal(readMicroverseState(dir)?.iteration_regressions, 4);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('readRecoverableJsonObject ignores stale tmp cleanup failures and returns the base object', () => {
  const dir = makeTempDir();
  const target = path.join(dir, 'cache.json');
  const staleTmp = `${target}.tmp.999999`;
  try {
    fs.writeFileSync(target, JSON.stringify({ value: 'base' }));
    fs.writeFileSync(staleTmp, JSON.stringify({ value: 'stale-tmp' }));
    const oldTime = new Date(Date.now() - 10_000);
    const newTime = new Date();
    fs.utimesSync(staleTmp, oldTime, oldTime);
    fs.utimesSync(target, newTime, newTime);
    fs.chmodSync(dir, 0o555);

    const recovered = readRecoverableJsonObject(target);

    assert.deepEqual(recovered, { value: 'base' });
    assert.equal(fs.existsSync(staleTmp), true, 'unremovable stale tmp should be left for a later cleanup');
  } finally {
    try { fs.chmodSync(dir, 0o755); } catch { /* ignore cleanup chmod failure */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

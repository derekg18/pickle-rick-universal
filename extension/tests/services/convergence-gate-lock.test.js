import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { runGate } from '../../services/convergence-gate.js';
import { withLock } from '../../services/state-manager.js';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lk-'));
}

function writeFastProject(dir) {
  const pkg = {
    name: 'lock-test',
    version: '1.0.0',
    scripts: {
      typecheck: 'node -e "process.exit(0)"',
      'lint:quiet': 'node -e "process.exit(0)"',
      test: 'node -e "process.exit(0)"',
    },
  };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
}

function gateLockKey(workingDir) {
  return `gate-${createHash('sha256').update(workingDir).digest('hex')}`;
}

// ---------------------------------------------------------------------------
// Baseline serialization: two concurrent runGate(mode='baseline') calls
// One writes the baseline, the other reads it — serialized via lock
// ---------------------------------------------------------------------------

test('runGate lock: concurrent baseline calls serialize', async () => {
  const dir = makeTmpDir();
  const baselineDir = makeTmpDir();
  const baselinePath = path.join(baselineDir, 'gate', 'baseline.json');
  try {
    writeFastProject(dir);

    const opts = {
      workingDir: dir,
      mode: 'baseline',
      scope: 'full',
      checks: [],
      baselinePath,
    };

    const [r1, r2] = await Promise.all([runGate(opts), runGate(opts)]);

    // One call wrote the baseline (baseline_used=false), the other read it (baseline_used=true)
    const writeCall = [r1, r2].find(r => !r.baseline_used);
    const readCall = [r1, r2].find(r => r.baseline_used);

    assert.ok(writeCall !== undefined, 'One call should have written baseline (baseline_used=false)');
    assert.ok(readCall !== undefined, 'One call should have read baseline (baseline_used=true)');
    assert.equal(writeCall.status, 'green');
    assert.equal(readCall.status, 'green');
    assert.ok(fs.existsSync(baselinePath), 'Baseline file should exist after concurrent calls');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(baselineDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Lock timeout: external holder holds the gate lock → runGate returns GATE_LOCK_TIMEOUT
// ---------------------------------------------------------------------------

test('runGate lock: baseline lock timeout → red with GATE_LOCK_TIMEOUT', async () => {
  const dir = makeTmpDir();
  const baselineDir = makeTmpDir();
  const baselinePath = path.join(baselineDir, 'gate', 'baseline.json');
  try {
    writeFastProject(dir);

    const lockKey = gateLockKey(dir);
    const HOLD_MS = 1000;
    const LOCK_TIMEOUT_MS = 100;

    // Hold the gate lock externally
    const holder = withLock(lockKey, {}, () => sleep(HOLD_MS));
    // Give holder time to acquire
    await sleep(30);

    const result = await runGate({
      workingDir: dir,
      mode: 'baseline',
      scope: 'full',
      checks: [],
      baselinePath,
      _timeouts: { lockMs: LOCK_TIMEOUT_MS },
    });

    await holder;

    assert.equal(result.status, 'red', `Expected red, got: ${result.status}`);
    const lf = result.failures.find(f => f.ruleOrCode === 'GATE_LOCK_TIMEOUT');
    assert.ok(lf, `Expected GATE_LOCK_TIMEOUT failure, got: ${JSON.stringify(result.failures)}`);
    assert.equal(lf.file, '<lock-timeout>');
    // Regression guard (harden ticket): the synthetic lock-timeout failure's `check` field
    // must carry one of the GateFailure union values — not a sentinel like 'gate' that
    // breaks downstream `f.check === 'tests'` consumers.
    assert.ok(
      ['typecheck', 'lint', 'tests'].includes(lf.check),
      `Expected lf.check ∈ {typecheck,lint,tests}, got: ${lf.check}`
    );
    assert.equal(result.baseline_used, false);
    assert.equal(result.new_failures_vs_baseline, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(baselineDir, { recursive: true, force: true });
  }
});

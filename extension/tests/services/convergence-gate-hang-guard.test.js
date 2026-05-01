import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runGate, GateError, GateTimeoutError } from '../../services/convergence-gate.js';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cg-hg-'));
}

function writeSlowProject(dir, { lintMs = 999_999, typecheckMs = 999_999, testMs = 999_999 } = {}) {
  const pkg = {
    name: 'hg-test',
    version: '1.0.0',
    scripts: {
      typecheck: `node -e "setTimeout(()=>process.exit(0),${typecheckMs})"`,
      'lint:quiet': `node -e "setTimeout(()=>process.exit(0),${lintMs})"`,
      test: `node -e "setTimeout(()=>process.exit(0),${testMs})"`,
    },
  };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
}

// ---------------------------------------------------------------------------
// Per-check timeout: a slow lint command times out and produces synthetic failure
// ---------------------------------------------------------------------------

test('runGate hang-guard: per-check timeout fires → red with GATE_CHECK_TIMEOUT', async () => {
  const dir = makeTmpDir();
  try {
    writeSlowProject(dir, { lintMs: 999_999 });

    const PER_CHECK_MS = 300;
    const result = await runGate({
      workingDir: dir,
      mode: 'strict',
      scope: 'full',
      checks: ['lint'],
      _timeouts: { perCheck: { lint: PER_CHECK_MS }, total: 10_000 },
    });

    assert.equal(result.status, 'red', `Expected red, got: ${result.status}`);
    assert.ok(result.failures.length > 0, 'Expected at least one failure');
    const tf = result.failures.find(f => f.ruleOrCode === 'GATE_CHECK_TIMEOUT');
    assert.ok(tf, `Expected GATE_CHECK_TIMEOUT failure, got: ${JSON.stringify(result.failures)}`);
    assert.equal(tf.file, '<timeout>');
    assert.equal(tf.check, 'lint');
    assert.ok(result.elapsed_ms < PER_CHECK_MS + 2000,
      `Expected elapsed < ${PER_CHECK_MS + 2000}ms, got ${result.elapsed_ms}ms`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Cumulative cap: multiple slow checks all hit the global deadline
// ---------------------------------------------------------------------------

test('runGate hang-guard: cumulative cap fires → all remaining checks aborted', async () => {
  const dir = makeTmpDir();
  try {
    writeSlowProject(dir, { typecheckMs: 999_999, lintMs: 999_999, testMs: 999_999 });

    const TOTAL_MS = 800;
    const PER_CHECK_MS = 999_000;
    const wallStart = Date.now();

    const result = await runGate({
      workingDir: dir,
      mode: 'strict',
      scope: 'full',
      checks: ['typecheck', 'lint', 'tests'],
      _timeouts: { perCheck: { typecheck: PER_CHECK_MS, lint: PER_CHECK_MS, tests: PER_CHECK_MS }, total: TOTAL_MS },
    });

    const elapsed = Date.now() - wallStart;

    assert.equal(result.status, 'red', `Expected red, got: ${result.status}`);
    // All failures should be GATE_CHECK_TIMEOUT
    assert.ok(result.failures.length > 0, 'Expected timeout failures');
    for (const f of result.failures) {
      assert.equal(f.ruleOrCode, 'GATE_CHECK_TIMEOUT', `Unexpected ruleOrCode: ${f.ruleOrCode}`);
      assert.equal(f.file, '<timeout>');
    }
    // Wall clock must not exceed TOTAL_MS + substantial slack
    assert.ok(elapsed < TOTAL_MS + 3000,
      `Expected wall clock < ${TOTAL_MS + 3000}ms, got ${elapsed}ms`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Fast commands still complete normally — hang-guard does not interfere
// ---------------------------------------------------------------------------

test('runGate hang-guard: fast commands succeed with timeouts configured', async () => {
  const dir = makeTmpDir();
  try {
    const pkg = {
      name: 'hg-fast',
      version: '1.0.0',
      scripts: {
        typecheck: 'node -e "process.exit(0)"',
        'lint:quiet': 'node -e "process.exit(0)"',
        test: 'node -e "process.exit(0)"',
      },
    };
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");

    const result = await runGate({
      workingDir: dir,
      mode: 'strict',
      scope: 'full',
      checks: ['typecheck', 'lint', 'tests'],
      _timeouts: { perCheck: { typecheck: 5000, lint: 5000, tests: 5000 }, total: 30_000 },
    });

    assert.equal(result.status, 'green');
    assert.deepEqual(result.failures, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// GateTimeoutError shape — verifies the exported class has the right fields
// ---------------------------------------------------------------------------

test('GateTimeoutError: constructor sets check, timeout_ms, and kind', () => {
  const err = new GateTimeoutError('lint', 5000);
  assert.ok(err instanceof GateTimeoutError, 'should be instanceof GateTimeoutError');
  assert.ok(err instanceof GateError, 'should be instanceof GateError');
  assert.ok(err instanceof Error, 'should be instanceof Error');
  assert.equal(err.check, 'lint');
  assert.equal(err.timeout_ms, 5000);
  assert.equal(err.kind, 'GATE_CHECK_TIMEOUT');
  assert.ok(err.message.includes('lint'), 'message should mention the check name');
  assert.ok(err.message.includes('5000'), 'message should mention the timeout');
});

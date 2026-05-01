import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { runGate } from '../../services/convergence-gate.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FAILING_PKG = JSON.stringify({
  name: 'flake-pkg',
  version: '1.0.0',
  scripts: { test: 'node -e "process.exit(1)"' },
}, null, 2);

const PASSING_PKG = JSON.stringify({
  name: 'clean-pkg',
  version: '1.0.0',
  scripts: { test: 'node -e "process.exit(0)"' },
}, null, 2);

async function withWorkspaceFixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-flake-'));
  try {
    execSync('git init', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.email "t@t.com"', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.name "T"', { cwd: dir, stdio: 'pipe' });
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('runGate: flake-listed failure → green-with-known-flake-warnings', async () => {
  await withWorkspaceFixture(async dir => {
    // Root pnpm workspace
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: \'9.0\'\n');
    fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');

    // packages/clean passes, packages/flaky fails
    const cleanDir = path.join(dir, 'packages', 'clean');
    const flakyDir = path.join(dir, 'packages', 'flaky');
    fs.mkdirSync(cleanDir, { recursive: true });
    fs.mkdirSync(flakyDir, { recursive: true });
    fs.writeFileSync(path.join(cleanDir, 'package.json'), PASSING_PKG);
    fs.writeFileSync(path.join(flakyDir, 'package.json'), FAILING_PKG);

    execSync('git add .', { cwd: dir, stdio: 'pipe' });
    execSync('git commit -m "init"', { cwd: dir, stdio: 'pipe' });

    const events = [];
    const result = await runGate({
      workingDir: dir,
      mode: 'strict',
      scope: 'full',
      checks: ['tests'],
      settings: { convergence_gate: { known_flake_files: ['packages/flaky'] } },
      onEvent: (event, data) => events.push({ event, data }),
      _timeouts: { perCheck: { tests: 10_000 }, total: 30_000 },
    });

    assert.equal(result.status, 'green-with-known-flake-warnings', 'flake failure should yield green-with-known-flake-warnings');
    assert.deepEqual(result.failures, [], 'failures array should be empty (flake suppressed)');
    assert.ok(result.total_raw_failure_count > 0, 'total_raw_failure_count should include the flake');

    const ooScope = events.find(e => e.event === 'gate_out_of_scope_failures_present');
    assert.ok(ooScope, 'gate_out_of_scope_failures_present must be emitted');
    assert.ok(ooScope.data.flake_count > 0, 'flake_count must be > 0');

    const complete = events.find(e => e.event === 'gate_run_complete');
    assert.ok(complete, 'gate_run_complete must be emitted');
    const { elapsed_ms, ...payload } = complete.data.gate_payload;
    assert.equal(typeof elapsed_ms, 'number', 'elapsed_ms must be numeric');
    assert.ok(elapsed_ms >= 0, 'elapsed_ms must be non-negative');
    assert.deepEqual(payload, {
      mode: 'strict',
      scope: 'full',
      checks: ['tests'],
      status: 'green-with-known-flake-warnings',
      failure_count: 0,
      total_raw_failure_count: 1,
      new_failures_vs_baseline: 0,
      allowed_paths_used: false,
      baseline_used: false,
    });

    // gate/known_flake_failures_*.md should be written
    const gateDir = path.join(dir, 'gate');
    assert.ok(fs.existsSync(gateDir), 'gate/ directory should exist');
    const flakeFiles = fs.readdirSync(gateDir).filter(f => f.startsWith('known_flake_failures_'));
    assert.ok(flakeFiles.length > 0, 'known_flake_failures_*.md should be written');
  });
});

test('runGate: gate_run_complete gate_payload has all required fields', async () => {
  await withWorkspaceFixture(async dir => {
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: \'9.0\'\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'root',
      version: '1.0.0',
      scripts: { typecheck: 'node -e "process.exit(0)"' },
    }, null, 2));
    execSync('git add .', { cwd: dir, stdio: 'pipe' });
    execSync('git commit -m "init"', { cwd: dir, stdio: 'pipe' });

    const events = [];
    await runGate({
      workingDir: dir,
      mode: 'strict',
      scope: 'full',
      checks: ['typecheck'],
      onEvent: (event, data) => events.push({ event, data }),
      _timeouts: { perCheck: { typecheck: 10_000 }, total: 30_000 },
    });

    const complete = events.find(e => e.event === 'gate_run_complete');
    assert.ok(complete, 'gate_run_complete must be emitted');
    const p = complete.data.gate_payload;
    assert.ok(p, 'gate_payload must exist');
    assert.deepEqual(
      Object.keys(p).sort(),
      [
        'allowed_paths_used',
        'baseline_used',
        'checks',
        'elapsed_ms',
        'failure_count',
        'mode',
        'new_failures_vs_baseline',
        'scope',
        'status',
        'total_raw_failure_count',
      ],
      'gate_payload shape must stay stable'
    );

    const { elapsed_ms, ...payload } = p;
    assert.equal(typeof elapsed_ms, 'number', 'elapsed_ms must be a number');
    assert.ok(elapsed_ms >= 0, 'elapsed_ms must be non-negative');
    assert.deepEqual(payload, {
      mode: 'strict',
      scope: 'full',
      checks: ['typecheck'],
      status: 'green',
      failure_count: 0,
      total_raw_failure_count: 0,
      new_failures_vs_baseline: 0,
      allowed_paths_used: false,
      baseline_used: false,
    });
  });
});

test('all 14 gate event names appear in convergence-gate.ts source', () => {
  const srcPath = path.resolve(__dirname, '../../src/services/convergence-gate.ts');
  const src = fs.readFileSync(srcPath, 'utf-8');
  const required = [
    'gate_baseline_captured',
    'gate_run_complete',
    'gate_skipped',
    'gate_unsafe_test_command_blocked',
    'gate_remediation_complete',
    'gate_remediation_aborted_unverified_production_change',
    'gate_autofix_reverted',
    'gate_workingdir_drift_detected',
    'gate_lock_acquired',
    'gate_lock_timeout',
    'gate_diff_scope_fallback',
    'gate_preexisting_tests_baselined',
    'gate_regression_threshold_warning',
    'gate_out_of_scope_failures_present',
  ];
  for (const name of required) {
    assert.ok(src.includes(name), `missing gate event: ${name}`);
  }
});

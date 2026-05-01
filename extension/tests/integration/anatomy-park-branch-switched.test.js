import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { runGate } from '../../services/convergence-gate.js';

function makeProject(dir) {
  const pkg = {
    name: 'branch-switch-test',
    version: '1.0.0',
    scripts: { test: 'node -e "process.exit(0)"' },
  };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
}

async function withBranchFixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-branch-'));
  try {
    execSync('git init -b main', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.email "t@t.com"', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.name "T"', { cwd: dir, stdio: 'pipe' });
    makeProject(dir);
    execSync('git add .', { cwd: dir, stdio: 'pipe' });
    execSync('git commit -m "init"', { cwd: dir, stdio: 'pipe' });
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('branch-switch: wrong branch → red + GATE_WORKINGDIR_DRIFT + drift file written', async () => {
  await withBranchFixture(async dir => {
    // Switch to a feature branch
    execSync('git checkout -b feature/foo', { cwd: dir, stdio: 'pipe' });

    const events = [];
    const result = await runGate({
      workingDir: dir,
      mode: 'strict',
      scope: 'full',
      checks: ['tests'],
      expected_branch: 'main',
      onEvent: (event, data) => events.push({ event, data }),
    });

    assert.equal(result.status, 'red', `Expected red, got ${result.status}`);
    assert.ok(result.failures.length > 0, 'Expected at least one failure');
    const drift = result.failures.find(f => f.ruleOrCode === 'GATE_WORKINGDIR_DRIFT');
    assert.ok(drift, `Expected GATE_WORKINGDIR_DRIFT failure; got ${JSON.stringify(result.failures)}`);
    assert.equal(drift.file, '<workingdir-drift>');

    // Drift file must be written in gate/ subdir
    const gateDir = path.join(dir, 'gate');
    assert.ok(fs.existsSync(gateDir), 'gate/ directory must exist');
    const driftFiles = fs.readdirSync(gateDir).filter(f => f.startsWith('workingdir_drift_'));
    assert.ok(driftFiles.length > 0, 'Expected at least one workingdir_drift_*.md file');

    // gate_workingdir_drift_detected event emitted
    const driftEvent = events.find(e => e.event === 'gate_workingdir_drift_detected');
    assert.ok(driftEvent, `Expected gate_workingdir_drift_detected event; got ${JSON.stringify(events)}`);
    assert.equal(driftEvent.data.expected_branch, 'main');
    assert.equal(driftEvent.data.current_branch, 'feature/foo');
  });
});

test('branch-switch: correct branch → gate runs normally (no halt)', async () => {
  await withBranchFixture(async dir => {
    const events = [];
    const result = await runGate({
      workingDir: dir,
      mode: 'strict',
      scope: 'full',
      checks: ['tests'],
      expected_branch: 'main',
      onEvent: (event, data) => events.push({ event, data }),
    });

    const drift = events.find(e => e.event === 'gate_workingdir_drift_detected');
    assert.ok(!drift, 'Should NOT emit drift event when on expected branch');
    assert.ok(['green', 'red'].includes(result.status));
    assert.ok(result.failures.every(f => f.ruleOrCode !== 'GATE_WORKINGDIR_DRIFT'));
  });
});

test('branch-switch: wrong HEAD SHA → red + GATE_WORKINGDIR_DRIFT', async () => {
  await withBranchFixture(async dir => {
    const headBefore = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf-8' }).trim();

    // Make a new commit so HEAD changes
    fs.writeFileSync(path.join(dir, 'extra.txt'), 'change');
    execSync('git add .', { cwd: dir, stdio: 'pipe' });
    execSync('git commit -m "extra"', { cwd: dir, stdio: 'pipe' });

    const events = [];
    const result = await runGate({
      workingDir: dir,
      mode: 'strict',
      scope: 'full',
      checks: ['tests'],
      expected_head: headBefore, // stale SHA
      onEvent: (event, data) => events.push({ event, data }),
    });

    assert.equal(result.status, 'red', `Expected red, got ${result.status}`);
    const drift = result.failures.find(f => f.ruleOrCode === 'GATE_WORKINGDIR_DRIFT');
    assert.ok(drift, 'Expected GATE_WORKINGDIR_DRIFT failure');

    const driftEvent = events.find(e => e.event === 'gate_workingdir_drift_detected');
    assert.ok(driftEvent, 'Expected gate_workingdir_drift_detected event');
    assert.equal(driftEvent.data.expected_head, headBefore);
  });
});

test('branch-switch: no expected_branch/head set → gate runs without drift check', async () => {
  await withBranchFixture(async dir => {
    execSync('git checkout -b feature/bar', { cwd: dir, stdio: 'pipe' });

    const events = [];
    const result = await runGate({
      workingDir: dir,
      mode: 'strict',
      scope: 'full',
      checks: ['tests'],
      // no expected_branch or expected_head
      onEvent: (event, data) => events.push({ event, data }),
    });

    const drift = events.find(e => e.event === 'gate_workingdir_drift_detected');
    assert.ok(!drift, 'Should NOT check drift when no expected_branch/head provided');
    assert.ok(['green', 'red'].includes(result.status));
  });
});

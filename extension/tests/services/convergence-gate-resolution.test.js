import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectProjectType, runGate } from '../../services/convergence-gate.js';

function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-res-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('detectProjectType: pnpm-lock.yaml → pnpm', () => {
  withTmpDir(dir => {
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    assert.equal(detectProjectType(dir), 'pnpm');
  });
});

test('detectProjectType: yarn.lock → yarn', () => {
  withTmpDir(dir => {
    fs.writeFileSync(path.join(dir, 'yarn.lock'), '');
    assert.equal(detectProjectType(dir), 'yarn');
  });
});

test('detectProjectType: package-lock.json → npm', () => {
  withTmpDir(dir => {
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '');
    assert.equal(detectProjectType(dir), 'npm');
  });
});

test('detectProjectType: package.json only → npm', () => {
  withTmpDir(dir => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    assert.equal(detectProjectType(dir), 'npm');
  });
});

test('detectProjectType: Cargo.toml → cargo', () => {
  withTmpDir(dir => {
    fs.writeFileSync(path.join(dir, 'Cargo.toml'), '');
    assert.equal(detectProjectType(dir), 'cargo');
  });
});

test('detectProjectType: go.mod → go', () => {
  withTmpDir(dir => {
    fs.writeFileSync(path.join(dir, 'go.mod'), '');
    assert.equal(detectProjectType(dir), 'go');
  });
});

test('detectProjectType: pnpm-lock.yaml wins over yarn.lock', () => {
  withTmpDir(dir => {
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    fs.writeFileSync(path.join(dir, 'yarn.lock'), '');
    assert.equal(detectProjectType(dir), 'pnpm');
  });
});

test('detectProjectType: empty dir → null', () => {
  withTmpDir(dir => {
    assert.equal(detectProjectType(dir), null);
  });
});

test('detectProjectType: bun.lockb → bun', () => {
  withTmpDir(dir => {
    fs.writeFileSync(path.join(dir, 'bun.lockb'), '');
    assert.equal(detectProjectType(dir), 'bun');
  });
});

test('detectProjectType: bun.lock → bun', () => {
  withTmpDir(dir => {
    fs.writeFileSync(path.join(dir, 'bun.lock'), '');
    assert.equal(detectProjectType(dir), 'bun');
  });
});

test('runGate: bun project emits gate_skipped with project_type_low_confidence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bun-'));
  try {
    const events = [];
    fs.writeFileSync(path.join(dir, 'bun.lockb'), '');
    const result = await runGate({
      workingDir: dir,
      mode: 'strict',
      scope: 'full',
      checks: ['tests'],
      onEvent: (event, data) => events.push({ event, data }),
    });
    assert.equal(result.status, 'green');
    assert.deepEqual(result.failures, []);
    const skipped = events.find(e => e.event === 'gate_skipped');
    assert.ok(skipped, 'gate_skipped event must be emitted');
    assert.equal(skipped.data.reason, 'project_type_low_confidence');
    assert.deepEqual(skipped.data.detected_signals, ['bun']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runGate: bun.lockb wins over package.json so bun repos do not false-green as npm', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bun-pkg-'));
  try {
    const events = [];
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'bun-project',
        private: true,
        scripts: { test: 'bun test' },
      }, null, 2),
    );
    fs.writeFileSync(path.join(dir, 'bun.lockb'), '');

    assert.equal(detectProjectType(dir), 'bun');

    const result = await runGate({
      workingDir: dir,
      mode: 'strict',
      scope: 'full',
      checks: ['tests'],
      onEvent: (event, data) => events.push({ event, data }),
    });

    assert.equal(result.status, 'green');
    assert.deepEqual(result.failures, []);
    const skipped = events.find(e => e.event === 'gate_skipped');
    assert.ok(skipped, 'gate_skipped event must be emitted');
    assert.equal(skipped.data.reason, 'project_type_low_confidence');
    assert.deepEqual(skipped.data.detected_signals, ['bun']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runGate: bun.lock wins over package.json so bun repos do not false-green as npm', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bun-text-lock-'));
  try {
    const events = [];
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'bun-project',
        private: true,
        scripts: { test: 'bun test' },
      }, null, 2),
    );
    fs.writeFileSync(path.join(dir, 'bun.lock'), 'lockfileVersion = 1\n');

    assert.equal(detectProjectType(dir), 'bun');

    const result = await runGate({
      workingDir: dir,
      mode: 'strict',
      scope: 'full',
      checks: ['tests'],
      onEvent: (event, data) => events.push({ event, data }),
    });

    assert.equal(result.status, 'green');
    assert.deepEqual(result.failures, []);
    const skipped = events.find(e => e.event === 'gate_skipped');
    assert.ok(skipped, 'gate_skipped event must be emitted');
    assert.equal(skipped.data.reason, 'project_type_low_confidence');
    assert.deepEqual(skipped.data.detected_signals, ['bun']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

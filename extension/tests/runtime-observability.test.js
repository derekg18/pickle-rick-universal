import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  parseRuntimeLogSpecs,
  runRuntimeObservabilityCommand,
} from '../services/runtime-observability.js';

function withTempDir(fn) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-observability-')));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('/interdimensional-cable parses multiple service log specs', () => {
  const specs = parseRuntimeLogSpecs([
    '--log',
    'api=/tmp/api.log,worker=/tmp/worker.log',
    'web=/tmp/web.log',
  ]);

  assert.deepEqual(specs, [
    { service: 'api', source: '/tmp/api.log' },
    { service: 'worker', source: '/tmp/worker.log' },
    { service: 'web', source: '/tmp/web.log' },
  ]);
});

test('/interdimensional-cable supervises fake logs and emits pane config', () => withTempDir((dir) => {
  const api = path.join(dir, 'api.log');
  const worker = path.join(dir, 'worker.log');
  fs.writeFileSync(api, 'api ready\napi handled request\n');
  fs.writeFileSync(worker, 'worker boot\n');

  const result = runRuntimeObservabilityCommand(
    'interdimensional-cable',
    [`api=${api}`, `worker=${worker}`],
    {
      workspaceDir: dir,
      sessionDir: path.join(dir, 'session'),
      now: new Date('2026-05-13T00:00:00.000Z'),
    },
  );

  assert.equal(result.status, 'success');
  assert.equal(result.command, 'interdimensional-cable');
  assert.equal(result.pane_config.length, 2);
  assert.deepEqual(result.pane_config.map((pane) => pane.channel), ['logs:api', 'logs:worker']);
  assert.deepEqual(result.pane_config[0].preview, ['api ready', 'api handled request']);
  assert.equal(result.pane_config.every((pane) => pane.supervised), true);
  assert.equal(result.artifact.kind, 'runtime-observability-summary');
}));

test('/interdimensional-cable reports missing log source with remediation', () => {
  const result = runRuntimeObservabilityCommand(
    'interdimensional-cable',
    ['api=/tmp/does-not-exist.log'],
    { fileExists: () => false },
  );

  assert.equal(result.status, 'failed');
  assert.match(result.summary, /Missing log source/);
  assert.match(result.remediation, /valid service=\/path\/to\/log/);
});

test('companion, focus, and audit commands return valid PickleCommandResult objects', () => withTempDir((dir) => {
  const sessionDir = path.join(dir, 'session');
  fs.mkdirSync(sessionDir);

  const companion = runRuntimeObservabilityCommand('mr-poopybutthole', [], { sessionDir, workspaceDir: dir });
  const focus = runRuntimeObservabilityCommand('glorzo', ['checkout'], { sessionDir, workspaceDir: dir });
  const audit = runRuntimeObservabilityCommand('galactic-federation', [], { sessionDir, workspaceDir: dir });

  for (const result of [companion, focus, audit]) {
    assert.equal(result.status, 'success');
    assert.equal(typeof result.summary, 'string');
    assert.equal(result.artifact.kind, 'runtime-observability-summary');
  }
  assert.equal(companion.companion.role, 'companion');
  assert.equal(focus.focus.focus, 'checkout');
  assert.deepEqual(audit.audit.checks, ['process-source', 'log-source', 'session-summary']);
}));

test('companion command reports missing session source with remediation', () => {
  const result = runRuntimeObservabilityCommand('mr-poopybutthole');

  assert.equal(result.status, 'failed');
  assert.match(result.summary, /No session source/);
  assert.match(result.remediation, /active Pickle session/);
});

test('/ghost-in-a-jar is skeleton-only and starts no persistence action', () => {
  let persistenceStarted = false;
  const result = runRuntimeObservabilityCommand('ghost-in-a-jar', [], {
    startPersistence: () => {
      persistenceStarted = true;
    },
  });

  assert.equal(result.status, 'success');
  assert.equal(result.persistence.skeleton_only, true);
  assert.equal(result.persistence.action, 'none');
  assert.equal(result.persistence.started, false);
  assert.equal(persistenceStarted, false);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { safeDeactivate } from '../services/state-manager.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'safedeactivate-'));
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
    original_prompt: 'test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: '/tmp/test-session',
    schema_version: 1,
    ...overrides,
  };
}

test('safeDeactivate: export resolves as function', () => {
  assert.strictEqual(typeof safeDeactivate, 'function');
});

test('safeDeactivate: sets state.active to false', () => {
  const dir = tmpDir();
  try {
    const sp = path.join(dir, 'state.json');
    fs.writeFileSync(sp, JSON.stringify(makeState({ active: true })));
    safeDeactivate(sp);
    const written = JSON.parse(fs.readFileSync(sp, 'utf-8'));
    assert.strictEqual(written.active, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

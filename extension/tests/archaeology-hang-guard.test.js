import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runArchaeology } from '../bin/archaeology.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(__dirname, '..', '..');
const repoRoot = path.join(__dirname, '__fixtures__', 'archaeology', 'web');

function tmpSession() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-archaeology-hang-')));
}

function writeState(sessionDir) {
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    active: true,
    working_dir: repoRoot,
    step: 'implement',
    iteration: 0,
    max_iterations: 1,
    max_time_minutes: 30,
    worker_timeout_seconds: 1200,
    start_time_epoch: 1,
    completion_promise: null,
    original_prompt: 'test',
    current_ticket: null,
    history: [],
    started_at: '2026-04-30T00:00:00.000Z',
    session_dir: sessionDir,
    schema_version: 3,
    backend: 'codex',
    activity: [],
  }, null, 2));
}

test('archaeology worker spawn is bounded by explicit timeout', () => {
  const sessionDir = tmpSession();
  try {
    writeState(sessionDir);
    let spawnOptions;
    const result = runArchaeology({
      sessionDir,
      repoRoot,
      extensionRoot,
      dryRun: false,
      force: true,
      noArchaeology: false,
    }, {
      spawn: (_cmd, _args, options) => {
        spawnOptions = options;
        return {
          status: 42,
          signal: null,
          output: [],
          pid: 123,
          stdout: '',
          stderr: 'wedged worker killed\n',
        };
      },
      stderr: () => {},
      logActivityFn: () => {},
    });

    assert.equal(result.exitCode, 42);
    assert.equal(spawnOptions?.timeout, 600_000);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

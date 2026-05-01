import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { logActivity } from '../../services/activity-logger.js';
import { formatLocalDateKey } from '../../services/pickle-utils.js';

function withTempActivityDir(fn) {
  const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-activity-gp-'));
  const origEnv = process.env.EXTENSION_DIR;
  process.env.EXTENSION_DIR = extRoot;
  try {
    fn(path.join(extRoot, 'activity'));
  } finally {
    process.env.EXTENSION_DIR = origEnv;
    if (origEnv === undefined) delete process.env.EXTENSION_DIR;
    fs.rmSync(extRoot, { recursive: true, force: true });
  }
}

test('gate_payload persisted round-trip in JSONL', () => {
  withTempActivityDir((activityDir) => {
    const payload = { failure_count: 3, auto_fixes_applied: ['eslint'] };
    logActivity({ event: 'gate_run_complete', source: 'hook', gate_payload: payload });

    const date = formatLocalDateKey(new Date());
    const filepath = path.join(activityDir, `${date}.jsonl`);
    assert.ok(fs.existsSync(filepath), 'JSONL file should exist');

    const parsed = JSON.parse(fs.readFileSync(filepath, 'utf8').trim());
    assert.deepEqual(parsed.gate_payload, payload);
  });
});

test('event without gate_payload has undefined gate_payload when read', () => {
  withTempActivityDir((activityDir) => {
    logActivity({ event: 'gate_skipped', source: 'hook' });

    const date = formatLocalDateKey(new Date());
    const filepath = path.join(activityDir, `${date}.jsonl`);
    const parsed = JSON.parse(fs.readFileSync(filepath, 'utf8').trim());
    assert.equal(parsed.gate_payload, undefined);
  });
});

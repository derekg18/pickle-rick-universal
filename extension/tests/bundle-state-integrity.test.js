import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditCodexManagerRelaunchCaps } from '../services/bundle-state-integrity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-bsi-'));
}

function writeState(dir, payload) {
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(payload), 'utf-8');
}

// ── auditCodexManagerRelaunchCaps ─────────────────────────────────────────────

test('auditCodexManagerRelaunchCaps: no violations when count is zero', () => {
  const sessionDir = tmpDir();
  writeState(sessionDir, { codex_manager_relaunch_count: 0 });
  const result = auditCodexManagerRelaunchCaps(sessionDir);

  assert.ok(typeof result.cap === 'number', 'cap should be a number');
  assert.ok(result.cap > 0, 'cap should be positive');
  assert.deepStrictEqual(result.violations, [], 'no violations expected for count=0');
  assert.ok(result.checkedStatePaths.length >= 1, 'should check at least the root state.json');
});

test('auditCodexManagerRelaunchCaps: violation when count exceeds cap', () => {
  const sessionDir = tmpDir();
  // Write a count well over any reasonable cap
  writeState(sessionDir, { codex_manager_relaunch_count: 9999 });
  const result = auditCodexManagerRelaunchCaps(sessionDir);

  assert.strictEqual(result.violations.length, 1);
  assert.strictEqual(result.violations[0].count, 9999);
  assert.ok(result.violations[0].reason.includes('exceeds cap'));
});

test('auditCodexManagerRelaunchCaps: violation when count field is non-numeric', () => {
  const sessionDir = tmpDir();
  writeState(sessionDir, { codex_manager_relaunch_count: 'not-a-number' });
  const result = auditCodexManagerRelaunchCaps(sessionDir);

  assert.strictEqual(result.violations.length, 1);
  assert.strictEqual(result.violations[0].count, null);
  assert.ok(result.violations[0].reason.includes('non-numeric'));
});

test('auditCodexManagerRelaunchCaps: unreadable state.json produces a violation', () => {
  const sessionDir = tmpDir();
  // Write a corrupted (non-JSON) state file
  fs.writeFileSync(path.join(sessionDir, 'state.json'), '{ not valid json', 'utf-8');
  const result = auditCodexManagerRelaunchCaps(sessionDir);

  assert.strictEqual(result.violations.length, 1);
  assert.strictEqual(result.violations[0].count, null);
  assert.ok(result.violations[0].reason.includes('unreadable'));
});

test('auditCodexManagerRelaunchCaps: includes microverse_ child state.json paths', () => {
  const sessionDir = tmpDir();
  writeState(sessionDir, { codex_manager_relaunch_count: 0 });

  // Create a microverse_ subdirectory with its own state
  const mvDir = path.join(sessionDir, 'microverse_iter1');
  fs.mkdirSync(mvDir);
  writeState(mvDir, { codex_manager_relaunch_count: 0 });

  const result = auditCodexManagerRelaunchCaps(sessionDir);
  assert.ok(
    result.checkedStatePaths.some(p => p.includes('microverse_iter1')),
    'should include the microverse_ child state.json',
  );
  assert.deepStrictEqual(result.violations, []);
});

test('auditCodexManagerRelaunchCaps: missing codex_manager_relaunch_count defaults to 0 (no violation)', () => {
  const sessionDir = tmpDir();
  // State without the field at all
  writeState(sessionDir, { active: true, step: 'implement' });
  const result = auditCodexManagerRelaunchCaps(sessionDir);

  assert.deepStrictEqual(result.violations, [], 'absent field should default to 0, not a violation');
});

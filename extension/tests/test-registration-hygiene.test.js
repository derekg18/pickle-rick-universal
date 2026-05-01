import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_PATH = path.resolve(__dirname, '..', 'package.json');

const UNREGISTERED_TEST_ALLOWLIST = new Set([
  'tests/bin/check-gate.test.js',
  'tests/bin/finalize-gate.test.js',
  'tests/bin/spawn-gate-remediator.test.js',
  'tests/integration/anatomy-park-baseline-gate.test.js',
  'tests/integration/anatomy-park-scoped-final-gate.test.js',
  'tests/integration/concurrent-gate-remediation.test.js',
  'tests/integration/extension-wiring.test.js',
  'tests/integration/gate-cycle-escalation.test.js',
  'tests/integration/szechuan-strict-gate.test.js',
  'tests/services/pickle-utils-iso-compact-stamp.test.js',
  'tests/skill-prompts/anatomy-park-gate-integration.test.js',
  'tests/skill-prompts/szechuan-sauce-gate-integration.test.js',
]);

function discoverTestFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return discoverTestFiles(fullPath);
      if (!entry.name.endsWith('.test.js')) return [];
      return [path.relative(path.resolve(__dirname, '..'), fullPath)];
    })
    .sort();
}

test('no test file is silently unregistered', () => {
  const onDisk = discoverTestFiles(__dirname);

  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
  const registeredSet = new Set(
    pkg.scripts.test
      .split(/\s+/)
      .filter(p => /tests\/.*\.test\.js$/.test(p))
      .map(p => path.normalize(p)),
  );

  const missing = onDisk.filter(f => !registeredSet.has(f) && !UNREGISTERED_TEST_ALLOWLIST.has(f));
  assert.deepStrictEqual(
    missing,
    [],
    `Unregistered test files (add to package.json scripts.test): ${missing.join(', ')}`,
  );
});

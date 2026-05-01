import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NODE_BIN = process.execPath;

const TEST_FILES = [
  'engine-keys-registry.test.js',
  'plumbus-frame-analyzer.test.js',
  'plumbus-frame-analyzer-bun.test.js',
  'plumbus-frame-analyzer-contract.test.js',
  'context-key-matrix.test.js',
  'diamond-routing.test.js',
  'tarjan-scc.test.js',
  'cycles-convergence.test.js',
  'fingerprint-regex.test.js',
  'kill-switch.test.js',
  'verification-comparator.test.js',
  'severity.test.js',
  'cluster-fix-selector.test.js',
  'test-registration-hygiene.test.js',
  'plumbus-frame-analyzer-calibration.test.js',
  'install-bun-probe.test.js',
  'plumbus-generative-audit.integration.test.js',
  'engine-keys-registry-coverage.test.js',
  'plumbus-ci-pipeline-baseline.test.js',
  'plumbus-iteration-merge.test.js',
  'data-flow-trace-a.test.js',
  'data-flow-trace-b.test.js',
  'data-flow-trace-c.test.js',
  'doc-cross-reference.test.js',
];

const SKIP_ONLY_RE = /\.(skip|only)\(/;
const SANCTIONED_RE = /\/\/ SKIP:/;

// NODE_TEST_CONTEXT causes child node --test processes to detect recursive
// invocation and skip all files. Clear it for subprocess spawns.
const spawnEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'),
);

test('no unsanctioned .skip/.only in TEST_FILES', () => {
  const violations = [];
  for (const filename of TEST_FILES) {
    const filePath = path.join(__dirname, filename);
    const lines = readFileSync(filePath, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (SKIP_ONLY_RE.test(line) && !SANCTIONED_RE.test(line)) {
        violations.push(`${filename}:${i + 1}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(violations, [], `Unsanctioned .skip/.only found:\n${violations.join('\n')}`);
});

test('each TEST_FILES file emits >= 1 TAP ok line', () => {
  const failures = [];
  for (const filename of TEST_FILES) {
    const filePath = path.join(__dirname, filename);
    const result = spawnSync(NODE_BIN, ['--test', '--test-reporter=tap', filePath], {
      encoding: 'utf8',
      // 30s → 90s: budget for re-running test files under concurrent test runs.
      // The test only checks "emits >= 1 TAP ok line" — wall-clock isn't asserted.
      timeout: 90000,
      env: spawnEnv,
    });
    const stdout = result.stdout ?? '';
    const okCount = stdout.split('\n').filter(l => l.startsWith('ok ')).length;
    if (okCount < 1) {
      failures.push(`${filename}: ${okCount} ok lines (exit ${result.status})`);
    }
  }
  assert.deepEqual(failures, [], `Files with zero TAP ok lines:\n${failures.join('\n')}`);
});

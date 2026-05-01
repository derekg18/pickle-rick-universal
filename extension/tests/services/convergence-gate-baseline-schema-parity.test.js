import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runGate } from '../../services/convergence-gate.js';

// Keys from GateBaselineFile interface in types/index.ts
const EXPECTED_KEYS = new Set([
  'schema_version',
  'captured_at',
  'working_dir',
  'project_type',
  'checks',
  'failures',
]);

test('baseline write: emitted JSON keys match GateBaselineFile type exactly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bl-parity-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'bl-parity-test', version: '1.0.0', scripts: {},
    }, null, 2));
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");

    const baselinePath = path.join(dir, 'gate', 'baseline.json');
    await runGate({ workingDir: dir, mode: 'baseline', scope: 'full', checks: [], baselinePath });

    const raw = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
    const actualKeys = new Set(Object.keys(raw));

    for (const key of EXPECTED_KEYS) {
      assert.ok(actualKeys.has(key), `GateBaselineFile key missing from emitted JSON: ${key}`);
    }
    for (const key of actualKeys) {
      assert.ok(EXPECTED_KEYS.has(key), `Unexpected extra key in emitted JSON (not in GateBaselineFile): ${key}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runGate } from '../../services/convergence-gate.js';

test('baseline write: emits valid GateBaselineFile JSON', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bl-schema-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'bl-schema-test', version: '1.0.0', scripts: {},
    }, null, 2));
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");

    const baselinePath = path.join(dir, 'gate', 'baseline.json');
    await runGate({ workingDir: dir, mode: 'baseline', scope: 'full', checks: [], baselinePath });

    assert.ok(fs.existsSync(baselinePath), 'baseline.json must be written');
    const raw = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));

    assert.equal(raw.schema_version, 1, 'schema_version === 1');
    assert.equal(typeof raw.captured_at, 'string', 'captured_at is string');
    assert.ok(!isNaN(Date.parse(raw.captured_at)), 'captured_at is valid ISO date');
    assert.equal(typeof raw.working_dir, 'string', 'working_dir is string');
    assert.equal(raw.working_dir, dir, 'working_dir equals workingDir arg');
    assert.ok(['pnpm', 'npm', 'yarn', 'cargo', 'go'].includes(raw.project_type), 'project_type valid');
    assert.ok(Array.isArray(raw.checks), 'checks is array');
    assert.ok(Array.isArray(raw.failures), 'failures is array');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

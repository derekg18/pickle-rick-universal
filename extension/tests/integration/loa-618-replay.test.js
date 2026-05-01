/**
 * LOA-618 fixture replay integration test (P3.4b).
 *
 * Extracts the synthesized tarball and runs the strict gate against it,
 * asserting the canonical failure pattern: 1 TS2352 + ≥66 lint errors.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runGate } from '../../services/convergence-gate.js';
import { spawnGateRemediatorMain } from '../../bin/spawn-gate-remediator.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TARBALL = path.resolve(__dirname, '../fixtures/loa-618-replay/loa-618-replay.tar.gz');

async function extractTarball() {
  const tmp = path.join(os.tmpdir(), 'loa-618-replay-' + crypto.randomUUID());
  await fsPromises.mkdir(tmp, { recursive: true });
  await execFileAsync('tar', ['-xzf', TARBALL, '-C', tmp]);
  return path.join(tmp, 'loa-618-replay');
}

async function spawnGateRemediatorBrief(gateResult, sessionRoot, reason) {
  const gateDir = path.join(sessionRoot, 'gate');
  fs.mkdirSync(gateDir, { recursive: true });
  const resultPath = path.join(gateDir, 'gate_result.json');
  fs.writeFileSync(resultPath, JSON.stringify(gateResult), 'utf-8');

  const lines = [];
  const code = await spawnGateRemediatorMain({
    argv: ['--gate-result', resultPath, '--session-root', sessionRoot, '--reason', reason],
    stdout: (msg) => lines.push(msg),
    stderr: () => {},
  });
  assert.equal(code, 0, 'spawnGateRemediatorMain should exit 0');
  const briefLine = lines.find((l) => l.startsWith('BRIEF_PATH='));
  assert.ok(briefLine, 'BRIEF_PATH line must be present in output');
  return briefLine.slice('BRIEF_PATH='.length);
}

test('LOA-618 replay: tarball extracts to expected file list', async () => {
  const tmp = path.join(os.tmpdir(), 'loa-618-list-' + crypto.randomUUID());
  await fsPromises.mkdir(tmp, { recursive: true });
  try {
    const { stdout } = await execFileAsync('tar', ['-tzf', TARBALL]);
    const entries = stdout.split('\n').filter(Boolean).sort();
    const expected = [
      'loa-618-replay/',
      'loa-618-replay/package.json',
      'loa-618-replay/pnpm-lock.yaml',
      'loa-618-replay/pnpm-workspace.yaml',
      'loa-618-replay/packages/',
      'loa-618-replay/packages/api/',
      'loa-618-replay/packages/api/package.json',
      'loa-618-replay/packages/api/scripts/',
      'loa-618-replay/packages/api/scripts/fake-lint.cjs',
      'loa-618-replay/packages/api/scripts/fake-test.cjs',
      'loa-618-replay/packages/api/scripts/fake-typecheck.cjs',
      'loa-618-replay/packages/api/src/',
      'loa-618-replay/packages/api/src/image-extraction.service.ts',
      'loa-618-replay/packages/api/test/',
      'loa-618-replay/packages/api/test/audit-log.controller.ts',
      'loa-618-replay/packages/api/test/image-extraction.service.spec.ts',
      'loa-618-replay/packages/api/test/portal-appraisal.service.spec.ts',
      'loa-618-replay/packages/api/test/processor.spec.ts',
      'loa-618-replay/packages/api/test/type-asserts.ts',
    ].sort();
    assert.deepEqual(entries, expected, 'tarball must contain exactly the expected entries');
  } finally {
    await fsPromises.rm(tmp, { recursive: true, force: true });
  }
});

test('LOA-618 replay: runGate finds ≥67 failures (1 TS2352 + ≥66 lint)', async () => {
  const fixtureDir = await extractTarball();
  try {
    const result = await runGate({
      workingDir: fixtureDir,
      mode: 'strict',
      scope: 'full',
      checks: ['typecheck', 'lint', 'tests'],
    });

    assert.equal(result.status, 'red', 'gate must be red on LOA-618 fixture');
    assert.ok(result.failures.length >= 67, `expected ≥67 failures, got ${result.failures.length}`);

    const tsFailures = result.failures.filter((f) => f.check === 'typecheck');
    assert.equal(tsFailures.length, 1, 'must have exactly 1 typecheck failure');
    assert.equal(tsFailures[0].ruleOrCode, 'TS2352', 'typecheck failure must be TS2352');

    const lintFailures = result.failures.filter((f) => f.check === 'lint');
    assert.ok(lintFailures.length >= 66, `expected ≥66 lint failures, got ${lintFailures.length}`);
  } finally {
    await fsPromises.rm(path.dirname(fixtureDir), { recursive: true, force: true });
  }
});

test('LOA-618 replay: remediator brief enumerates all ruleOrCodes', async () => {
  const fixtureDir = await extractTarball();
  try {
    const result = await runGate({
      workingDir: fixtureDir,
      mode: 'strict',
      scope: 'full',
      checks: ['typecheck', 'lint', 'tests'],
    });

    assert.equal(result.status, 'red');

    const briefPath = await spawnGateRemediatorBrief(result, fixtureDir, 'strict');
    const brief = await fsPromises.readFile(briefPath, 'utf-8');

    const uniqueRules = [...new Set(result.failures.map((f) => f.ruleOrCode))];
    for (const rule of uniqueRules) {
      assert.ok(brief.includes(rule), `brief must mention ruleOrCode "${rule}"`);
    }
  } finally {
    await fsPromises.rm(path.dirname(fixtureDir), { recursive: true, force: true });
  }
});

test('LOA-618 replay: A6 timing — gate completes in < 30s', async () => {
  const fixtureDir = await extractTarball();
  try {
    const wallStart = Date.now();
    const result = await runGate({
      workingDir: fixtureDir,
      mode: 'strict',
      scope: 'full',
      checks: ['typecheck', 'lint', 'tests'],
    });
    const wallElapsed = Date.now() - wallStart;

    assert.ok(wallElapsed < 30_000, `gate took ${wallElapsed}ms (> 30s wall-clock)`);
    assert.ok(result.elapsed_ms < 30_000, `result.elapsed_ms=${result.elapsed_ms} > 30s`);
  } finally {
    await fsPromises.rm(path.dirname(fixtureDir), { recursive: true, force: true });
  }
});

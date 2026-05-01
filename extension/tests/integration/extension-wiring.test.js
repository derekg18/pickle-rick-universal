/**
 * Extension wiring integration test — verifies convergence-gate primitives are
 * fully deployed and wired end-to-end.
 *
 * Deploy smoke (tests 1-3): require bash install.sh to have been run.
 * CLI surface (tests 4-5): programmatic API; no deploy required.
 * LOA-618 e2e (tests 6-7): runs runGate + spawnGateRemediatorMain against tarball.
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
import { checkGateMain } from '../../bin/check-gate.js';
import { finalizeGateMain } from '../../bin/finalize-gate.js';
import { spawnGateRemediatorMain } from '../../bin/spawn-gate-remediator.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEPLOYED_ROOT = path.join(os.homedir(), '.claude', 'pickle-rick');
const TARBALL = path.resolve(__dirname, '../fixtures/loa-618-replay/loa-618-replay.tar.gz');

async function extractLoa618() {
  const tmp = path.join(os.tmpdir(), 'ew-loa618-' + crypto.randomUUID());
  await fsPromises.mkdir(tmp, { recursive: true });
  await execFileAsync('tar', ['-xzf', TARBALL, '-C', tmp]);
  return path.join(tmp, 'loa-618-replay');
}

// ---------------------------------------------------------------------------
// Deploy smoke — all 8 paths must exist after bash install.sh
// ---------------------------------------------------------------------------

const DEPLOYED_PATHS = [
  path.join(DEPLOYED_ROOT, 'extension/bin/check-gate.js'),
  path.join(DEPLOYED_ROOT, 'extension/bin/finalize-gate.js'),
  path.join(DEPLOYED_ROOT, 'extension/bin/spawn-gate-remediator.js'),
  path.join(DEPLOYED_ROOT, 'extension/data/gate-commands.json'),
  path.join(os.homedir(), '.claude/agents/morty-gate-remediator.md'),
];

test('deploy smoke: gate bins and data exist after bash install.sh', () => {
  const missing = DEPLOYED_PATHS.filter(p => !fs.existsSync(p));
  assert.deepEqual(
    missing,
    [],
    `Missing deployed paths (run bash install.sh): ${missing.join(', ')}`
  );
});

test('deploy smoke: convergence_gate block present in deployed pickle_settings.json', () => {
  const settingsPath = path.join(DEPLOYED_ROOT, 'pickle_settings.json');
  assert.ok(fs.existsSync(settingsPath), `${settingsPath} does not exist`);
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  assert.ok(
    settings.convergence_gate && typeof settings.convergence_gate === 'object',
    'convergence_gate block missing from deployed pickle_settings.json'
  );
});

test('deploy smoke: finalize-gate.js invoked in szechuan-sauce.md and anatomy-park.md', () => {
  const commandsDir = path.join(os.homedir(), '.claude/commands');
  for (const cmd of ['szechuan-sauce.md', 'anatomy-park.md']) {
    const cmdPath = path.join(commandsDir, cmd);
    assert.ok(fs.existsSync(cmdPath), `${cmd} not deployed`);
    const content = fs.readFileSync(cmdPath, 'utf-8');
    assert.ok(
      content.includes('finalize-gate.js'),
      `finalize-gate.js not referenced in ${cmd}`
    );
  }
});

// ---------------------------------------------------------------------------
// CLI surface — check-gate and finalize-gate programmatic APIs
// ---------------------------------------------------------------------------

test('check-gate CLI: --help returns exit 0 with usage string', async () => {
  const lines = [];
  const code = await checkGateMain({
    argv: ['--help'],
    stdout: (msg) => lines.push(msg),
    stderr: () => {},
  });
  assert.equal(code, 0, 'expected exit 0 for --help');
  assert.ok(lines.some(l => l.includes('check-gate')), 'usage must mention check-gate');
});

test('check-gate CLI: missing required flags returns exit 1', async () => {
  const errLines = [];
  const code = await checkGateMain({
    argv: [],
    stdout: () => {},
    stderr: (msg) => errLines.push(msg),
  });
  assert.equal(code, 1, 'expected exit 1 for missing args');
  assert.ok(errLines.some(l => l.includes('--mode')), 'stderr must mention --mode');
});

test('finalize-gate CLI: missing required args returns exit 1', async () => {
  const errLines = [];
  const code = await finalizeGateMain({
    argv: [],
    stdout: () => {},
    stderr: (msg) => errLines.push(msg),
  });
  assert.equal(code, 1, 'expected exit 1 for missing args');
  assert.ok(errLines.some(l => l.includes('Usage')), 'stderr must include Usage');
});

// ---------------------------------------------------------------------------
// LOA-618 end-to-end: strict gate → red → remediator brief → residual check
// ---------------------------------------------------------------------------

test('LOA-618 e2e: strict gate is red with ≥67 failures on fixture', async () => {
  const fixtureDir = await extractLoa618();
  try {
    const result = await runGate({
      workingDir: fixtureDir,
      mode: 'strict',
      scope: 'full',
      checks: ['typecheck', 'lint', 'tests'],
    });
    assert.equal(result.status, 'red', 'gate must be red on LOA-618 fixture');
    assert.ok(result.failures.length >= 67, `expected ≥67 failures, got ${result.failures.length}`);
  } finally {
    await fsPromises.rm(path.dirname(fixtureDir), { recursive: true, force: true });
  }
});

test('LOA-618 e2e: remediator brief covers all ruleOrCodes from gate result', async () => {
  const fixtureDir = await extractLoa618();
  try {
    const result = await runGate({
      workingDir: fixtureDir,
      mode: 'strict',
      scope: 'full',
      checks: ['typecheck', 'lint', 'tests'],
    });
    assert.equal(result.status, 'red');

    const gateDir = path.join(fixtureDir, 'gate');
    fs.mkdirSync(gateDir, { recursive: true });
    const gateResultPath = path.join(gateDir, 'gate_result.json');
    fs.writeFileSync(gateResultPath, JSON.stringify(result), 'utf-8');

    const lines = [];
    const code = await spawnGateRemediatorMain({
      argv: ['--gate-result', gateResultPath, '--session-root', fixtureDir, '--reason', 'strict'],
      stdout: (msg) => lines.push(msg),
      stderr: () => {},
    });
    assert.equal(code, 0, 'spawnGateRemediatorMain must exit 0');

    const briefLine = lines.find(l => l.startsWith('BRIEF_PATH='));
    assert.ok(briefLine, 'BRIEF_PATH must be emitted');
    const briefPath = briefLine.slice('BRIEF_PATH='.length);
    const brief = await fsPromises.readFile(briefPath, 'utf-8');

    const uniqueRules = [...new Set(result.failures.map(f => f.ruleOrCode))];
    for (const rule of uniqueRules) {
      assert.ok(brief.includes(rule), `brief must mention ruleOrCode "${rule}"`);
    }
  } finally {
    await fsPromises.rm(path.dirname(fixtureDir), { recursive: true, force: true });
  }
});

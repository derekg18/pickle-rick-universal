import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs as parseCorrectCourseArgs } from '../bin/correct-course.js';
import { runDebate } from '../bin/debate.js';
import { isPhasePersonasEnabled } from '../bin/spawn-morty.js';
import { resolveBackend } from '../services/backend-spawn.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MATRIX_STATUSES = new Set([
  'phase_personas_off',
  'full_feature',
  'refinement_lock_illegal',
  'codex_strict_teams_fail',
  'auto_apply_skip_readiness_warn',
  'default_fail',
]);

const PHASE_PERSONAS = ['off', 'on'];
const REFINEMENT_LOCK = ['0', '1'];
const STRICT_TEAMS = [false, true];
const AUTO_APPLY = [false, true];
const SKIP_READINESS = [false, true];

function enumerateMatrixCombos() {
  const combos = [];
  for (const phasePersonas of PHASE_PERSONAS) {
    for (const refinementLock of REFINEMENT_LOCK) {
      for (const strictTeams of STRICT_TEAMS) {
        for (const autoApply of AUTO_APPLY) {
          for (const skipReadiness of SKIP_READINESS) {
            combos.push({
              phasePersonas,
              refinementLock,
              strictTeams,
              autoApply,
              skipReadiness,
            });
          }
        }
      }
    }
  }
  return combos;
}

function classifyFlagCombo(combo) {
  if (combo.phasePersonas === 'off') return 'phase_personas_off';
  if (combo.refinementLock === '1') return 'refinement_lock_illegal';
  if (combo.strictTeams) return 'codex_strict_teams_fail';
  if (!combo.autoApply && !combo.skipReadiness) return 'full_feature';
  if (combo.autoApply && combo.skipReadiness) return 'auto_apply_skip_readiness_warn';
  return 'default_fail';
}

function summarizeByStatus(combos) {
  const summary = new Map();
  for (const combo of combos) {
    const status = classifyFlagCombo(combo);
    assert.equal(MATRIX_STATUSES.has(status), true, `unrecognized status for ${JSON.stringify(combo)}`);
    summary.set(status, (summary.get(status) ?? 0) + 1);
  }
  return summary;
}

function withEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function tmpDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeDebateState(sessionDir, overrides = {}) {
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    active: true,
    working_dir: sessionDir,
    step: 'implement',
    iteration: 1,
    max_iterations: 3,
    max_time_minutes: 60,
    worker_timeout_seconds: 3600,
    start_time_epoch: 0,
    completion_promise: null,
    original_prompt: 'flag matrix test',
    current_ticket: null,
    history: [],
    started_at: '2026-04-30T00:00:00.000Z',
    session_dir: sessionDir,
    schema_version: 3,
    flags: {},
    ...overrides,
  }, null, 2));
}

function baseDebateArgs(sessionDir) {
  return {
    sessionDir,
    repoRoot: sessionDir,
    question: 'Should Codex use strict teams?',
    personas: ['researcher', 'architect', 'implementer', 'skeptic'],
    n: 4,
    solo: false,
    strictTeams: true,
    noStrictTeams: false,
    continueDebate: false,
    confirmMultiRound: false,
    acceptStale: false,
    dryRun: false,
    agentsDir: path.resolve(__dirname, '../../.claude/agents'),
  };
}

test('flag interaction matrix enumerates every combo and default-fails unlisted combos', () => {
  const combos = enumerateMatrixCombos();
  const uniqueKeys = new Set(combos.map((combo) => JSON.stringify(combo)));
  const summary = summarizeByStatus(combos);

  assert.equal(combos.length, 32);
  assert.equal(uniqueKeys.size, 32);
  assert.equal(summary.get('phase_personas_off'), 16);
  assert.equal(summary.get('full_feature'), 1);
  assert.equal(summary.get('refinement_lock_illegal'), 8);
  assert.equal(summary.get('codex_strict_teams_fail'), 4);
  assert.equal(summary.get('auto_apply_skip_readiness_warn'), 1);
  assert.equal(summary.get('default_fail'), 2);

  const defaultFailed = combos.filter((combo) => classifyFlagCombo(combo) === 'default_fail');
  assert.deepEqual(defaultFailed, [
    {
      phasePersonas: 'on',
      refinementLock: '0',
      strictTeams: false,
      autoApply: false,
      skipReadiness: true,
    },
    {
      phasePersonas: 'on',
      refinementLock: '0',
      strictTeams: false,
      autoApply: true,
      skipReadiness: false,
    },
  ]);
});

test('matrix phase-personas off and on rows match env enablement behavior', () => {
  const extensionRoot = tmpDir('pickle-flag-matrix-extension-');
  try {
    fs.writeFileSync(path.join(extensionRoot, 'pickle_settings.json'), JSON.stringify({
      bmad_hardening: { phase_personas_enabled: true },
    }, null, 2));

    assert.equal(withEnv({ PICKLE_PHASE_PERSONAS: 'off' }, () => isPhasePersonasEnabled(extensionRoot)), false);
    assert.equal(withEnv({ PICKLE_PHASE_PERSONAS: 'on' }, () => isPhasePersonasEnabled(extensionRoot)), true);
    assert.equal(withEnv({ PICKLE_PHASE_PERSONAS: undefined }, () => isPhasePersonasEnabled(extensionRoot)), true);
  } finally {
    fs.rmSync(extensionRoot, { recursive: true, force: true });
  }
});

test('matrix refinement-lock row forces locked sessions off Codex backend', () => {
  assert.equal(withEnv({ PICKLE_REFINEMENT_LOCK: '1' }, () => resolveBackend({ backend: 'codex' })), 'claude');
  assert.equal(withEnv({ PICKLE_REFINEMENT_LOCK: '0' }, () => resolveBackend({ backend: 'codex' })), 'codex');
});

test('matrix strict-teams row fails fast for Codex sessions', () => {
  const sessionDir = tmpDir('pickle-flag-matrix-debate-');
  try {
    writeDebateState(sessionDir, { backend: 'codex' });
    const stderr = [];
    const result = runDebate(baseDebateArgs(sessionDir), {
      stdout: () => {},
      stderr: (line) => stderr.push(line),
      now: () => new Date('2026-04-30T15:00:00.000Z'),
    });

    assert.equal(result.exitCode, 7);
    assert.equal(result.briefPath, '');
    assert.match(stderr[0], /--strict-teams requires claude backend/);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('matrix auto-apply row matches correct-course flag parsing', () => {
  const args = parseCorrectCourseArgs([
    'New constraint found',
    '--session-dir', '/tmp/session',
    '--auto-apply',
  ]);

  assert.equal(args.autoApply, true);
});

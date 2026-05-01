import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  executeMainLoop,
  measureAndClassifyIteration,
  _deps,
} from '../bin/microverse-runner.js';
import {
  createMicroverseState,
  readMicroverseState,
  writeMicroverseState,
} from '../services/microverse-state.js';

function makeTempDir(prefix = 'pickle-mv-helper-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function makeRunnerState(sessionDir, workingDir, overrides = {}) {
  return {
    active: true,
    working_dir: workingDir,
    step: 'implement',
    iteration: 0,
    max_iterations: 10,
    max_time_minutes: 60,
    worker_timeout_seconds: 0,
    start_time_epoch: Math.floor(Date.now() / 1000),
    completion_promise: null,
    original_prompt: 'test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    tmux_mode: true,
    command_template: 'microverse.md',
    ...overrides,
  };
}

function makeMetric(validation) {
  return {
    description: 'score',
    validation,
    type: 'command',
    timeout_seconds: 5,
    tolerance: 2,
    direction: 'higher',
  };
}

function makeContext(sessionDir, workingDir, state, overrides = {}) {
  return {
    sessionDir,
    extensionRoot: path.resolve('.'),
    statePath: path.join(sessionDir, 'state.json'),
    workingDir,
    startTime: Date.now(),
    initialIteration: 0,
    enableFailureClassification: false,
    cgSettings: {
      enabled_convergence_files: ['anatomy-park.json'],
      regression_warning_threshold: 5,
      remediator_timeout_s: 600,
      baseline_max_age_iterations: 30,
      baseline_max_age_seconds: 14_400,
    },
    rateLimitWaitMinutes: 1,
    maxRateLimitRetries: 1,
    log: () => {},
    currentRunnerState: state,
    iteration: 1,
    consecutiveRateLimits: 0,
    preIterSha: 'pre',
    postIterSha: 'post',
    ...overrides,
  };
}

function makeSession(score) {
  const sessionDir = makeTempDir();
  const workingDir = makeTempDir();
  const scoreFile = path.join(workingDir, 'score.txt');
  fs.writeFileSync(scoreFile, `${score}\n`);
  const runnerState = makeRunnerState(sessionDir, workingDir);
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(runnerState, null, 2));
  const mv = createMicroverseState({
    prdPath: path.join(workingDir, 'prd.md'),
    metric: makeMetric('cat score.txt'),
    stallLimit: 5,
  });
  mv.status = 'iterating';
  mv.baseline_score = 50;
  writeMicroverseState(sessionDir, mv);
  return { sessionDir, workingDir, scoreFile, runnerState, mv };
}

test('measureAndClassifyIteration returns improved and records accepted history', async () => {
  const { sessionDir, workingDir, runnerState, mv } = makeSession(60);
  try {
    const ctx = makeContext(sessionDir, workingDir, runnerState);
    const result = await measureAndClassifyIteration(mv, { raw: '50', score: 50 }, ctx);
    assert.equal(result.kind, 'improved');
    assert.equal(mv.convergence.history[0].classification, 'improved');
    assert.equal(readMicroverseState(sessionDir).convergence.history[0].action, 'accept');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});

test('measureAndClassifyIteration returns regressed and rolls back', async () => {
  const { sessionDir, workingDir, runnerState, mv } = makeSession(40);
  const originalReset = _deps.resetToSha;
  let rolledBackTo = null;
  try {
    _deps.resetToSha = (sha) => { rolledBackTo = sha; };
    const ctx = makeContext(sessionDir, workingDir, runnerState, { preIterSha: 'rollback-sha' });
    const result = await measureAndClassifyIteration(mv, { raw: '50', score: 50 }, ctx);
    assert.deepEqual(result, { kind: 'regressed', rollback: true });
    assert.equal(rolledBackTo, 'rollback-sha');
    assert.equal(mv.convergence.history[0].action, 'revert');
    assert.equal(mv.failed_approaches.length, 1);
  } finally {
    _deps.resetToSha = originalReset;
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});

test('measureAndClassifyIteration returns unchanged for held score and increments stall', async () => {
  const { sessionDir, workingDir, runnerState, mv } = makeSession(51);
  try {
    const ctx = makeContext(sessionDir, workingDir, runnerState);
    const result = await measureAndClassifyIteration(mv, { raw: '50', score: 50 }, ctx);
    assert.deepEqual(result, { kind: 'unchanged' });
    assert.equal(mv.convergence.history[0].classification, 'held');
    assert.equal(mv.convergence.stall_counter, 1);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});

test('executeMainLoop replays convergence mutation fixture order', async () => {
  const fixturePath = path.join('tests', 'fixtures', 'microverse', 'convergence-mutations.json');
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
  const sessionDir = makeTempDir('pickle-mv-replay-session-');
  const workingDir = makeTempDir('pickle-mv-replay-work-');
  const scoreFile = path.join(workingDir, 'score.txt');
  const runnerState = makeRunnerState(sessionDir, workingDir, { max_iterations: 5 });
  const originalRunIteration = _deps.runIteration;
  const originalGetHeadSha = _deps.getHeadSha;
  const originalSleep = _deps.sleep;
  const originalReset = _deps.resetToSha;
  const scores = [60, 61, 62];
  const shas = ['pre001', 'abc001', 'pre002', 'abc002', 'pre003', 'abc003'];
  const postShas = [];
  try {
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(runnerState, null, 2));
    const mv = createMicroverseState({
      prdPath: path.join(workingDir, 'prd.md'),
      metric: { ...makeMetric('cat score.txt'), tolerance: 5 },
      stallLimit: 2,
    });
    mv.status = 'iterating';
    mv.baseline_score = fixture.cycle[0].after.baseline_score;
    writeMicroverseState(sessionDir, mv);

    let iterationIndex = 0;
    _deps.runIteration = async () => {
      fs.writeFileSync(scoreFile, `${scores[iterationIndex++]}\n`);
      return { completion: 'success', exitCode: 0, timedOut: false, wallSeconds: 1 };
    };
    _deps.getHeadSha = () => {
      const sha = shas.shift() ?? 'abc003';
      if (sha.startsWith('abc')) postShas.push(sha);
      return sha;
    };
    _deps.sleep = async () => {};
    _deps.resetToSha = () => {};

    const ctx = makeContext(sessionDir, workingDir, runnerState, {
      iteration: 0,
      startTime: Date.now(),
    });
    await executeMainLoop(mv, ctx);
    const actual = readMicroverseState(sessionDir);
    const expectedAfter = fixture.cycle[3].after.convergence;
    const actualMutations = actual.convergence.history.map(({ score, iteration, action, classification }, index) => ({
      score,
      iteration,
      sha: postShas[index],
      ...(action === 'accept' && classification === 'improved' ? { action } : {}),
      classification,
    }));
    assert.deepStrictEqual(
      actualMutations,
      expectedAfter.history,
    );
    assert.equal(actual.convergence.stall_counter, expectedAfter.stall_counter);
  } finally {
    _deps.runIteration = originalRunIteration;
    _deps.getHeadSha = originalGetHeadSha;
    _deps.sleep = originalSleep;
    _deps.resetToSha = originalReset;
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});

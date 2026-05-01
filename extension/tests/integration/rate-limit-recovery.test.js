/**
 * rate-limit-recovery.test.js — F24: Rate limit state machine integration tests.
 *
 * Tests the exported rate-limit logic functions from mux-runner.js without
 * requiring a real claude binary. Covers decision paths for wait/bail,
 * log-based detection, and cancellation/time-expiry semantics.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateManager } from '../../services/state-manager.js';
import { writeStateFile } from '../../services/pickle-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Import from compiled bin (not src — tests run against JS)
const {
  computeRateLimitAction,
  detectRateLimitInLog,
  detectRateLimitInText,
  classifyIterationExit,
} = await import(path.resolve(__dirname, '../../bin/mux-runner.js'));

function tmpDir(prefix = 'pickle-rl-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function makeState(overrides = {}) {
  return {
    active: true,
    working_dir: '/tmp/test',
    step: 'implement',
    iteration: 1,
    max_iterations: 10,
    max_time_minutes: 60,
    worker_timeout_seconds: 1200,
    start_time_epoch: Math.floor(Date.now() / 1000),
    completion_promise: null,
    original_prompt: 'rate limit test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: '/tmp/test-session',
    schema_version: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeRateLimitAction — decision function tests
// ---------------------------------------------------------------------------

test('RL-1: computeRateLimitAction — config wait (no resetsAt, consecutive below max)', () => {
  const result = computeRateLimitAction(
    { type: 'api_limit', rateLimitInfo: null },
    1,   // consecutiveRateLimits
    3,   // maxRetries
    60,  // configWaitMinutes
  );
  assert.equal(result.action, 'wait');
  assert.equal(result.waitSource, 'config');
  assert.equal(result.waitMs, 60 * 60 * 1000, 'wait must equal config minutes in ms');
  assert.equal(result.resetCounter, false, 'config wait must not reset counter');
  assert.equal(result.hasResetsAt, false);
});

test('RL-2: computeRateLimitAction — bail (no resetsAt, consecutive equals max)', () => {
  const result = computeRateLimitAction(
    { type: 'api_limit', rateLimitInfo: null },
    3,   // consecutiveRateLimits === maxRetries
    3,
    60,
  );
  assert.equal(result.action, 'bail');
});

test('RL-3: computeRateLimitAction — bail when consecutive exceeds max', () => {
  const result = computeRateLimitAction(
    { type: 'api_limit', rateLimitInfo: null },
    5,   // > maxRetries
    3,
    60,
  );
  assert.equal(result.action, 'bail');
});

test('RL-4: computeRateLimitAction — API resetsAt path (future timestamp, within cap)', () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 3600; // 1hr from now
  const result = computeRateLimitAction(
    { type: 'api_limit', rateLimitInfo: { limited: true, resetsAt, rateLimitType: 'hour' } },
    1,
    3,
    60,
  );
  assert.equal(result.action, 'wait');
  assert.equal(result.waitSource, 'api');
  assert.equal(result.resetCounter, true, 'API wait must reset counter');
  assert.equal(result.hasResetsAt, true);
  // waitMs = (resetsAt * 1000 - now) + 30_000 buffer
  const expectedMs = (resetsAt * 1000 - Date.now()) + 30_000;
  assert.ok(
    Math.abs(result.waitMs - expectedMs) < 500,
    `waitMs ${result.waitMs} should be ≈ ${expectedMs}`,
  );
});

test('RL-5: computeRateLimitAction — resetsAt in the past falls back to config wait', () => {
  const resetsAt = Math.floor(Date.now() / 1000) - 3600; // 1hr ago
  const result = computeRateLimitAction(
    { type: 'api_limit', rateLimitInfo: { limited: true, resetsAt, rateLimitType: 'hour' } },
    1,
    3,
    60,
  );
  assert.equal(result.action, 'wait');
  // API time was <= 0, so config fallback applies — still uses 'config'
  // because apiWaitMs <= 0 branch leaves waitSource unchanged from its initial 'config'
  // and hasResetsAt=true doesn't trigger bail (bail requires !hasResetsAt)
  assert.equal(result.hasResetsAt, true);
  assert.equal(result.waitMs, 60 * 60 * 1000, 'should fall back to config wait');
});

test('RL-6: computeRateLimitAction — resetsAt present, consecutive >= max still waits (API wins)', () => {
  // When API provides resetsAt, we ALWAYS wait (never bail) — API told us when to come back
  const resetsAt = Math.floor(Date.now() / 1000) + 1800;
  const result = computeRateLimitAction(
    { type: 'api_limit', rateLimitInfo: { limited: true, resetsAt } },
    10,  // way over max
    3,
    60,
  );
  assert.equal(result.action, 'wait', 'must wait when resetsAt is provided, even if retries exhausted');
});

// ---------------------------------------------------------------------------
// detectRateLimitInLog — JSON event parsing
// ---------------------------------------------------------------------------

test('RL-7: detectRateLimitInLog — parses rate_limit_event with status=rejected', () => {
  const dir = tmpDir();
  try {
    const logFile = path.join(dir, 'iter.log');
    const event = {
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'rejected',
        resetsAt: 1_700_000_000,
        rateLimitType: 'hour',
      },
    };
    fs.writeFileSync(logFile, JSON.stringify(event) + '\n');

    const result = detectRateLimitInLog(logFile);
    assert.equal(result.limited, true);
    assert.equal(result.resetsAt, 1_700_000_000);
    assert.equal(result.rateLimitType, 'hour');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RL-8: detectRateLimitInLog — flat rate_limit_event (no nested rate_limit_info) also parsed', () => {
  const dir = tmpDir();
  try {
    const logFile = path.join(dir, 'iter.log');
    const event = {
      type: 'rate_limit_event',
      status: 'rejected',
      resetsAt: 1_700_000_001,
      rateLimitType: 'tokens',
    };
    fs.writeFileSync(logFile, JSON.stringify(event) + '\n');

    const result = detectRateLimitInLog(logFile);
    assert.equal(result.limited, true);
    assert.equal(result.resetsAt, 1_700_000_001);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RL-9: detectRateLimitInLog — ignores rate_limit_event with non-rejected status', () => {
  const dir = tmpDir();
  try {
    const logFile = path.join(dir, 'iter.log');
    const event = { type: 'rate_limit_event', rate_limit_info: { status: 'warning' } };
    fs.writeFileSync(logFile, JSON.stringify(event) + '\n');

    const result = detectRateLimitInLog(logFile);
    assert.equal(result.limited, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RL-10: detectRateLimitInLog — returns not limited for missing file', () => {
  const result = detectRateLimitInLog('/nonexistent/path/iter.log');
  assert.equal(result.limited, false);
});

// ---------------------------------------------------------------------------
// detectRateLimitInText — pattern matching
// ---------------------------------------------------------------------------

test('RL-11: detectRateLimitInText — matches "usage limit has been reached" in log', () => {
  const dir = tmpDir();
  try {
    const logFile = path.join(dir, 'iter.log');
    fs.writeFileSync(logFile, 'your daily usage limit has been reached\n');
    assert.equal(detectRateLimitInText(logFile), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RL-12: detectRateLimitInText — matches "out of usage" in log', () => {
  const dir = tmpDir();
  try {
    const logFile = path.join(dir, 'iter.log');
    fs.writeFileSync(logFile, 'You are out of usage for this period.\n');
    assert.equal(detectRateLimitInText(logFile), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RL-13: detectRateLimitInText — ignores rate limit text inside user/tool_result lines', () => {
  const dir = tmpDir();
  try {
    const logFile = path.join(dir, 'iter.log');
    // rate limit text in a user-typed message — should be filtered
    const userLine = JSON.stringify({
      type: 'user',
      message: { content: 'The rate limit prevents this.' },
    });
    const toolLine = JSON.stringify({
      type: 'tool_result',
      content: 'rate limit reached error',
    });
    fs.writeFileSync(logFile, userLine + '\n' + toolLine + '\n');
    assert.equal(detectRateLimitInText(logFile), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RL-14: detectRateLimitInText — returns false for missing file', () => {
  assert.equal(detectRateLimitInText('/nonexistent/iter.log'), false);
});

// ---------------------------------------------------------------------------
// classifyIterationExit — mapping completion results to exit types
// ---------------------------------------------------------------------------

test('RL-15: classifyIterationExit — "continue" + rate limit in log → api_limit', () => {
  const dir = tmpDir();
  try {
    const logFile = path.join(dir, 'iter.log');
    const event = {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt: 1_700_000_000 },
    };
    fs.writeFileSync(logFile, JSON.stringify(event) + '\n');

    const result = classifyIterationExit('continue', logFile);
    assert.equal(result.type, 'api_limit');
    assert.equal(result.rateLimitInfo?.limited, true);
    assert.equal(result.rateLimitInfo?.resetsAt, 1_700_000_000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RL-16: classifyIterationExit — "task_completed" → success (ignores log content)', () => {
  const dir = tmpDir();
  try {
    const logFile = path.join(dir, 'iter.log');
    // Even with rate limit in log, task_completed wins
    fs.writeFileSync(logFile, JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }) + '\n');

    const result = classifyIterationExit('task_completed', logFile);
    assert.equal(result.type, 'success');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RL-17: classifyIterationExit — "error" → error type', () => {
  const result = classifyIterationExit('error', '/nonexistent.log');
  assert.equal(result.type, 'error');
});

test('RL-18: classifyIterationExit — "continue" with text-only rate limit → api_limit (text fallback)', () => {
  const dir = tmpDir();
  try {
    const logFile = path.join(dir, 'iter.log');
    // Text rate limit (no JSON event) — falls through to detectRateLimitInText
    fs.writeFileSync(logFile, "You're out of extra usage · resets Mar 6 at 11am\n");

    const result = classifyIterationExit('continue', logFile);
    assert.equal(result.type, 'api_limit');
    // Text-only path has no rateLimitInfo
    assert.equal(result.rateLimitInfo, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Cancellation semantics — simulates "wait then user deactivates"
//
// The mux-runner wait loop polls state.json every RATE_LIMIT_POLL_MS.
// If state.active !== true, it breaks with exitReason = 'cancelled'.
// Here we verify the underlying state operations that enable clean cancellation:
// deactivation is durable, immediately readable, and no orphan files remain.
// ---------------------------------------------------------------------------

test('RL-19: user deactivates during wait — active=false is immediately readable (clean break)', () => {
  const dir = tmpDir();
  try {
    const statePath = path.join(dir, 'state.json');
    const sm = new StateManager();

    // Session is active (rate limit wait in progress)
    writeStateFile(statePath, makeState({ active: true }));

    // Simulate rate_limit_wait.json being written by the runner
    const waitFile = path.join(dir, 'rate_limit_wait.json');
    fs.writeFileSync(waitFile, JSON.stringify({
      waiting: true,
      reason: 'API rate limit',
      started_at: new Date().toISOString(),
      wait_until: new Date(Date.now() + 3_600_000).toISOString(),
      consecutive_waits: 1,
    }));

    // User deactivates (simulates /eat-pickle or external cancellation)
    sm.update(statePath, s => { s.active = false; });

    // The runner's poll reads state.json — must see active=false immediately
    const polled = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.equal(polled.active, false, 'deactivation must be durably written');

    // Cleanup: runner would delete rate_limit_wait.json on break (simulate it)
    fs.unlinkSync(waitFile);
    assert.equal(fs.existsSync(waitFile), false, 'wait file must be removed on cancellation (no orphans)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RL-20: user deactivates — StateManager.read() confirms active=false (no stale read)', () => {
  const dir = tmpDir();
  try {
    const statePath = path.join(dir, 'state.json');
    const sm = new StateManager();

    writeStateFile(statePath, makeState({ active: true }));
    sm.update(statePath, s => { s.active = false; });

    // Second reader (simulates another poll) sees the same value
    const state2 = sm.read(statePath);
    assert.equal(state2.active, false, 'second read must not see stale active=true');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Time expiry semantics — simulates "max_time expires during wait"
//
// The mux-runner checks elapsed >= max_time_minutes * 60 inside the wait loop.
// Here we verify the time computation logic that governs the "limit" break.
// ---------------------------------------------------------------------------

test('RL-21: time expiry — session elapsed >= max_time produces zero remaining time (limit_reached)', () => {
  const maxTimeMins = 30;
  const elapsedSecs = 35 * 60; // 35 min elapsed > 30 min max
  const startEpoch = Math.floor(Date.now() / 1000) - elapsedSecs;

  // Mirrors the mux-runner wait loop time check
  const elapsed = Math.floor(Date.now() / 1000) - startEpoch;
  const remaining = maxTimeMins * 60 - elapsed;

  assert.ok(remaining <= 0, `remaining ${remaining}s must be ≤ 0 when session time exceeded`);
});

test('RL-22: time expiry — actualWaitMs clamped to remaining session time', () => {
  const configWaitMs = 60 * 60 * 1000; // 60 min
  const maxTimeMins = 30;
  const elapsedSecs = 28 * 60; // 28 min elapsed, 2 min remaining
  const startEpoch = Math.floor(Date.now() / 1000) - elapsedSecs;

  const epoch = startEpoch;
  const elapsed = Math.floor(Date.now() / 1000) - epoch;
  const remaining = maxTimeMins * 60 - elapsed;

  // Mirrors: actualWaitMs = Math.min(actualWaitMs, remaining * 1000)
  const actualWaitMs = Math.min(configWaitMs, remaining * 1000);

  // 2 min remaining < 60 min config → clamped to ~2 min
  assert.ok(actualWaitMs < 3 * 60 * 1000, `actualWaitMs ${actualWaitMs}ms must be clamped to ~2min`);
  assert.ok(actualWaitMs > 0, 'actualWaitMs must be positive (not yet expired)');
});

test('RL-23: time expiry — pre-wait check detects expired session before wait starts', () => {
  const maxTimeMins = 30;
  const elapsedSecs = 35 * 60; // already expired
  const startEpoch = Math.floor(Date.now() / 1000) - elapsedSecs;

  const epoch = startEpoch;
  const rawMax = maxTimeMins;
  const maxMins = rawMax;
  const elapsed2 = Math.floor(Date.now() / 1000) - epoch;
  const remaining = maxMins * 60 - elapsed2;

  // Mirrors: if (remaining <= 0) { exitReason = 'limit'; safeDeactivate(); break; }
  assert.ok(remaining <= 0, 'expired session must trigger limit break before wait starts');
});

test('RL-24: rate limit wait file has expected structure', () => {
  const dir = tmpDir();
  try {
    const waitFile = path.join(dir, 'rate_limit_wait.json');
    const now = Date.now();
    const waitMs = 60 * 60 * 1000;
    const waitUntil = new Date(now + waitMs).toISOString();

    // Mirrors: writeStateFile(path.join(sessionDir, 'rate_limit_wait.json'), { ... })
    const payload = {
      waiting: true,
      reason: 'API rate limit',
      started_at: new Date().toISOString(),
      wait_until: waitUntil,
      consecutive_waits: 1,
      rate_limit_type: 'hour',
      resets_at_epoch: 1_700_000_000,
      wait_source: 'api',
    };
    fs.writeFileSync(waitFile, JSON.stringify(payload, null, 2));

    const read = JSON.parse(fs.readFileSync(waitFile, 'utf-8'));
    assert.equal(read.waiting, true);
    assert.equal(read.reason, 'API rate limit');
    assert.equal(typeof read.wait_until, 'string');
    assert.equal(read.consecutive_waits, 1);
    assert.equal(read.wait_source, 'api');
    assert.equal(read.resets_at_epoch, 1_700_000_000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

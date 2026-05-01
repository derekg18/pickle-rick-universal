/**
 * test-harness.js — Integration test infrastructure.
 *
 * NOT a test file — exports helpers for integration tests.
 * Provides: tmpdir lifecycle, state factories, and mock runIteration.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Tmpdir lifecycle
// ---------------------------------------------------------------------------

/**
 * Creates a temp directory and returns { dir, cleanup }.
 * Always call cleanup() in test teardown (even on failure).
 */
export function makeTmpDir(prefix = 'pickle-int-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// State factory
// ---------------------------------------------------------------------------

export function makeState(overrides = {}) {
  return {
    active: true,
    working_dir: '/tmp/test-working-dir',
    step: 'prd',
    iteration: 1,
    max_iterations: 10,
    max_time_minutes: 60,
    worker_timeout_seconds: 1200,
    start_time_epoch: Math.floor(Date.now() / 1000),
    completion_promise: null,
    original_prompt: 'integration test prompt',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: '/tmp/test-session',
    schema_version: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock runIteration
// ---------------------------------------------------------------------------

/**
 * Creates a mock runIteration function with configurable behavior.
 *
 * @param {Object} config
 * @param {'success'|'rate_limit'|'stall'|'error'} config.behavior
 * @param {number} [config.delay=0]  - simulated async delay in ms
 * @param {number} [config.callCount=0]  - tracks invocations
 *
 * Returns a function matching the runIteration(sessionDir, opts) signature.
 */
export function makeMockRunIteration(config = {}) {
  const behavior = config.behavior ?? 'success';
  const delay = config.delay ?? 0;
  let calls = 0;

  const fn = async function mockRunIteration(_sessionDir, _opts) {
    calls++;
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    switch (behavior) {
      case 'success':
        return { exitType: 'success', completionType: 'task_completed' };
      case 'rate_limit':
        return { exitType: 'api_limit', rateLimitInfo: null };
      case 'stall':
        return { exitType: 'success', completionType: 'continue' };
      case 'error':
        return { exitType: 'error', error: new Error('mock iteration error') };
      default:
        throw new Error(`Unknown behavior: ${behavior}`);
    }
  };

  // Expose call count for assertions
  Object.defineProperty(fn, 'callCount', { get: () => calls });

  return fn;
}

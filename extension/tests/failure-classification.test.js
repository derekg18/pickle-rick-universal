import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyFailure,
  compareMetric,
  recordIteration,
  readMicroverseState,
  createMicroverseState,
} from '../services/microverse-state.js';

// Helper: minimal MicroverseSessionState for testing
function makeState(overrides = {}) {
  return {
    status: 'iterating',
    prd_path: '/tmp/prd.md',
    key_metric: {
      description: 'test coverage',
      validation: 'npm test',
      type: 'command',
      timeout_seconds: 60,
      tolerance: 0.5,
      direction: 'higher',
    },
    convergence: {
      stall_limit: 6,
      stall_counter: 0,
      history: [],
    },
    gap_analysis_path: '',
    failed_approaches: [],
    baseline_score: 50,
    failure_history: [],
    approach_exhaustion_fired: false,
    ...overrides,
  };
}

function makeEntry(overrides = {}) {
  return {
    iteration: 1,
    metric_value: '60',
    score: 60,
    action: 'accept',
    description: 'test entry',
    pre_iteration_sha: 'abc123',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('classifyFailure', () => {
  test('1. tool_failure: metricResult=null returns tool_failure', () => {
    const state = makeState();
    const result = classifyFailure(state, null, 'sha1', 'sha2');
    assert.equal(result, 'tool_failure');
  });

  test('2. metric_unstable: alternating improved/regressed history returns metric_unstable', () => {
    const state = makeState({
      convergence: {
        stall_limit: 6,
        stall_counter: 3,
        history: [
          makeEntry({ score: 55, classification: 'improved' }),
          makeEntry({ score: 48, classification: 'regressed' }),
          makeEntry({ score: 56, classification: 'improved' }),
        ],
      },
    });
    // Current iteration would be 'held' (score=50 vs baseline=50), but oscillation in history triggers metric_unstable
    const result = classifyFailure(state, { raw: '50', score: 50 }, 'sha1', 'sha2');
    assert.equal(result, 'metric_unstable');
  });

  test('3. regression: compareMetric returns regressed', () => {
    const state = makeState({ baseline_score: 60 });
    // Score 50 vs baseline 60, tolerance 0.5, direction higher → regressed
    const result = classifyFailure(state, { raw: '50', score: 50 }, 'sha1', 'sha2');
    assert.equal(result, 'regression');
  });

  test('4. approach_exhaustion: 3+ failed_approaches and high stall_counter', () => {
    const state = makeState({
      failed_approaches: ['a', 'b', 'c'],
      convergence: {
        stall_limit: 6,
        stall_counter: 3, // >= 6/2
        history: [],
      },
    });
    // Score held (50 vs 50), no oscillation, not regressed → approach_exhaustion
    const result = classifyFailure(state, { raw: '50', score: 50 }, 'sha1', 'sha2');
    assert.equal(result, 'approach_exhaustion');
  });

  test('5. no_progress: preIterSha === postIterSha', () => {
    const state = makeState();
    // Score held, same SHA → no_progress
    const result = classifyFailure(state, { raw: '50', score: 50 }, 'same_sha', 'same_sha');
    assert.equal(result, 'no_progress');
  });

  test('6. no_progress: 3 consecutive held classifications', () => {
    const state = makeState({
      convergence: {
        stall_limit: 6,
        stall_counter: 3,
        history: [
          makeEntry({ score: 50, classification: 'held' }),
          makeEntry({ score: 50, classification: 'held' }),
          makeEntry({ score: 50, classification: 'held' }),
        ],
      },
    });
    // Different SHAs but 3 consecutive held → no_progress
    const result = classifyFailure(state, { raw: '50', score: 50 }, 'sha1', 'sha2');
    assert.equal(result, 'no_progress');
  });

  test('7. success: improved iteration returns null', () => {
    const state = makeState({ baseline_score: 50 });
    // Score 60 vs baseline 50, tolerance 0.5 → improved
    const result = classifyFailure(state, { raw: '60', score: 60 }, 'sha1', 'sha2');
    assert.equal(result, null);
  });

  test('8. priority ordering: tool_failure beats regression', () => {
    // Even if regression conditions exist, null metricResult → tool_failure
    const state = makeState({ baseline_score: 100 });
    const result = classifyFailure(state, null, 'sha1', 'sha2');
    assert.equal(result, 'tool_failure');
  });

  test('9. readMicroverseState defaults: missing failure_history defaults to []', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-test-'));
    const stateData = {
      status: 'iterating',
      prd_path: '/tmp/prd.md',
      key_metric: { description: 'x', validation: 'x', type: 'command', timeout_seconds: 60, tolerance: 0.5 },
      convergence: { stall_limit: 6, stall_counter: 0, history: [] },
      gap_analysis_path: '',
      failed_approaches: [],
      baseline_score: 0,
      // deliberately omit failure_history and approach_exhaustion_fired
    };
    fs.writeFileSync(path.join(tmpDir, 'microverse.json'), JSON.stringify(stateData));
    const loaded = readMicroverseState(tmpDir);
    assert.ok(loaded);
    assert.deepEqual(loaded.failure_history, []);
    assert.equal(loaded.approach_exhaustion_fired, false);

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('10. recordIteration persists classification on entry', () => {
    const state = makeState({ baseline_score: 50 });
    const entry = makeEntry({ score: 60 });
    const newState = recordIteration(state, entry);
    // entry should now have classification set
    assert.equal(entry.classification, 'improved');
    // And it should be in the history
    const historyEntry = newState.convergence.history[0];
    assert.equal(historyEntry.classification, 'improved');
  });
});

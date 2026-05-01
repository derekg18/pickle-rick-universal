import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildFailureDistribution,
  buildEfficiencySection,
  writeFinalReport,
} from '../bin/microverse-runner.js';

// ── buildFailureDistribution ──

test('buildFailureDistribution: normal case with multiple classes', () => {
  const history = [
    { failure_class: 'test_regression' },
    { failure_class: 'test_regression' },
    { failure_class: 'test_regression' },
    { failure_class: 'build_break' },
  ];
  const result = buildFailureDistribution(history);
  assert.ok(result.includes('## Failure Distribution'), 'has section header');
  assert.ok(result.includes('| test_regression | 3 |'), 'test_regression count');
  assert.ok(result.includes('| build_break | 1 |'), 'build_break count');
  assert.ok(result.includes('| Class | Count |'), 'has table header');
});

test('buildFailureDistribution: empty failure_history', () => {
  const result = buildFailureDistribution([]);
  assert.ok(result.includes('## Failure Distribution'), 'has section header');
  assert.ok(result.includes('No failures recorded'), 'shows no failures message');
  assert.ok(!result.includes('| Class |'), 'no table rendered');
});

test('buildFailureDistribution: single failure class', () => {
  const history = [
    { failure_class: 'regression' },
    { failure_class: 'regression' },
  ];
  const result = buildFailureDistribution(history);
  assert.ok(result.includes('| regression | 2 |'));
});

test('buildFailureDistribution: all five failure classes', () => {
  const history = [
    { failure_class: 'tool_failure' },
    { failure_class: 'approach_exhaustion' },
    { failure_class: 'regression' },
    { failure_class: 'metric_unstable' },
    { failure_class: 'no_progress' },
  ];
  const result = buildFailureDistribution(history);
  assert.ok(result.includes('| tool_failure | 1 |'));
  assert.ok(result.includes('| approach_exhaustion | 1 |'));
  assert.ok(result.includes('| regression | 1 |'));
  assert.ok(result.includes('| metric_unstable | 1 |'));
  assert.ok(result.includes('| no_progress | 1 |'));
});

test('buildFailureDistribution: sorted by count descending', () => {
  const history = [
    { failure_class: 'regression' },
    { failure_class: 'tool_failure' },
    { failure_class: 'tool_failure' },
    { failure_class: 'tool_failure' },
    { failure_class: 'regression' },
  ];
  const result = buildFailureDistribution(history);
  const toolIdx = result.indexOf('tool_failure');
  const regIdx = result.indexOf('regression');
  assert.ok(toolIdx < regIdx, 'higher count class appears first');
});

// ── buildEfficiencySection ──

test('buildEfficiencySection: 2 reverts out of 8 iterations', () => {
  const history = [
    { action: 'accept' },
    { action: 'revert' },
    { action: 'accept' },
    { action: 'revert' },
    { action: 'accept' },
    { action: 'accept' },
    { action: 'accept' },
    { action: 'accept' },
  ];
  const result = buildEfficiencySection(history, 8);
  assert.ok(result.includes('## Efficiency'), 'has section header');
  assert.ok(result.includes('**Wasted iterations**: 2 / 8 (25%)'), 'correct count and percentage');
});

test('buildEfficiencySection: 0 reverts (clean run)', () => {
  const history = [
    { action: 'accept' },
    { action: 'accept' },
    { action: 'accept' },
  ];
  const result = buildEfficiencySection(history, 3);
  assert.ok(result.includes('**Wasted iterations**: 0 / 3 (0%)'));
});

test('buildEfficiencySection: all reverts', () => {
  const history = [
    { action: 'revert' },
    { action: 'revert' },
    { action: 'revert' },
  ];
  const result = buildEfficiencySection(history, 3);
  assert.ok(result.includes('**Wasted iterations**: 3 / 3 (100%)'));
});

test('buildEfficiencySection: stall iterations (no commits = missing from history)', () => {
  // 5 total iterations, only 3 in history, 1 revert among those
  // wasted = 1 revert + 2 missing = 3
  const history = [
    { action: 'accept' },
    { action: 'revert' },
    { action: 'accept' },
  ];
  const result = buildEfficiencySection(history, 5);
  assert.ok(result.includes('**Wasted iterations**: 3 / 5 (60%)'));
});

test('buildEfficiencySection: zero total iterations', () => {
  const result = buildEfficiencySection([], 0);
  assert.ok(result.includes('**Wasted iterations**: 0 / 0 (0%)'));
});

test('buildEfficiencySection: percentage rounds correctly', () => {
  // 1 revert out of 3 = 33.333...% → 33%
  const history = [
    { action: 'accept' },
    { action: 'revert' },
    { action: 'accept' },
  ];
  const result = buildEfficiencySection(history, 3);
  assert.ok(result.includes('**Wasted iterations**: 1 / 3 (33%)'));
});

test('writeFinalReport uses local-day filename at UTC boundary', () => {
  const previousTz = process.env.TZ;
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mv-report-'));
  try {
    process.env.TZ = 'America/Chicago';
    mock.timers.enable({ apis: ['Date'], now: new Date('2026-04-29T00:30:00Z') });
    writeFinalReport(
      sessionDir,
      {
        status: 'iterating',
        prd_path: '/tmp/prd.md',
        key_metric: { description: 'test', validation: 'echo 50', type: 'command', timeout_seconds: 5, tolerance: 2 },
        convergence: { stall_limit: 3, stall_counter: 0, history: [] },
        gap_analysis_path: '',
        failed_approaches: [],
        failure_history: [],
        baseline_score: 40,
      },
      'limit_reached',
      0,
      0,
    );

    const memoryDir = path.join(sessionDir, 'memory');
    assert.equal(fs.existsSync(path.join(memoryDir, 'microverse_report_2026-04-28.md')), true);
    assert.equal(fs.existsSync(path.join(memoryDir, 'microverse_report_2026-04-29.md')), false);
  } finally {
    mock.timers.reset();
    if (previousTz === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previousTz;
    }
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

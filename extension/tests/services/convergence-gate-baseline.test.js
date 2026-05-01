import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignOccurrenceIndices, subtractBaseline } from '../../services/convergence-gate.js';

function makeFailure(file, ruleOrCode, line, occurrence_index = 0) {
  return { check: 'lint', file, line, ruleOrCode, message: 'test', severity: 'error', occurrence_index };
}

function makeBaseline(failures) {
  return {
    schema_version: 1,
    captured_at: new Date().toISOString(),
    working_dir: '/tmp',
    project_type: 'npm',
    checks: ['lint'],
    failures,
  };
}

test('assignOccurrenceIndices: assigns 0-based indices per (file, ruleOrCode), sorted by line', () => {
  const failures = [
    makeFailure('foo.ts', 'prefer-const', 20),
    makeFailure('foo.ts', 'prefer-const', 5),
    makeFailure('foo.ts', 'no-unused-vars', 10),
  ];
  const result = assignOccurrenceIndices(failures);
  const preferConst = result.filter(f => f.ruleOrCode === 'prefer-const').sort((a, b) => a.line - b.line);
  assert.equal(preferConst[0].occurrence_index, 0, 'line 5 gets index 0');
  assert.equal(preferConst[1].occurrence_index, 1, 'line 20 gets index 1');
  const noUnused = result.find(f => f.ruleOrCode === 'no-unused-vars');
  assert.equal(noUnused.occurrence_index, 0, 'single entry gets index 0');
});

test('subtractBaseline: occurrence_index fingerprinting — only new instance flagged', () => {
  // Baseline has 1 occurrence of prefer-const (occurrence_index 0)
  const baseline = makeBaseline([makeFailure('foo.ts', 'prefer-const', 5, 0)]);
  // Current has 2 occurrences; index 0 subtracts, index 1 is new
  const current = [
    makeFailure('foo.ts', 'prefer-const', 5, 0),
    makeFailure('foo.ts', 'prefer-const', 20, 1),
  ];
  const result = subtractBaseline(current, baseline);
  assert.equal(result.length, 1, 'only 1 new failure');
  assert.equal(result[0].line, 20);
  assert.equal(result[0].occurrence_index, 1);
});

test('subtractBaseline: file-deleted entries are auto-satisfied', () => {
  const baseline = makeBaseline([makeFailure('foo.ts', 'prefer-const', 5, 0)]);
  // Current is empty — file was deleted, no failures reported
  const result = subtractBaseline([], baseline);
  assert.equal(result.length, 0, 'no new failures when file is gone');
});

test('subtractBaseline: subtract is order-independent', () => {
  const baseline = makeBaseline([
    makeFailure('a.ts', 'rule-x', 1, 0),
    makeFailure('b.ts', 'rule-y', 2, 0),
  ]);
  // Current in reversed order, plus a new failure
  const current = [
    makeFailure('b.ts', 'rule-y', 2, 0),
    makeFailure('a.ts', 'rule-x', 1, 0),
    makeFailure('c.ts', 'rule-z', 3, 0),
  ];
  const result = subtractBaseline(current, baseline);
  assert.equal(result.length, 1, 'only the new failure remains');
  assert.equal(result[0].file, 'c.ts');
});

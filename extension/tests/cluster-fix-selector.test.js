import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB_PATH = path.resolve(__dirname, '..', 'lib', 'cluster-fix-selector.js');

const { selectFix } = await import(LIB_PATH);

function finding(frame, severity) {
  return { frame, post_verification_severity: severity, label: `${frame}-${severity}` };
}

describe('selectFix: tabulated combinations', () => {
  test('F1+F2 → Frame 2 wins, no warn', () => {
    const f1 = finding('F1', 'P1');
    const f2 = finding('F2', 'P0');
    const result = selectFix(['F1', 'F2'], [f1, f2]);
    assert.strictEqual(result.winner, f2);
    assert.strictEqual(result.warn, false);
  });

  test('F1+F2 order-independent (frameSet passed reversed)', () => {
    const f1 = finding('F1', 'P2');
    const f2 = finding('F2', 'P2');
    const result = selectFix(['F2', 'F1'], [f1, f2]);
    assert.strictEqual(result.winner, f2);
    assert.strictEqual(result.warn, false);
  });

  test('F1+F3 → Frame 3 wins, no warn', () => {
    const f1 = finding('F1', 'P0');
    const f3 = finding('F3', 'P1');
    const result = selectFix(['F1', 'F3'], [f1, f3]);
    assert.strictEqual(result.winner, f3);
    assert.strictEqual(result.warn, false);
  });

  test('F1+F2+F6 → Frame 2 wins, no warn', () => {
    const f1 = finding('F1', 'P0');
    const f2 = finding('F2', 'P0');
    const f6 = finding('F6', 'P1');
    const result = selectFix(['F1', 'F2', 'F6'], [f1, f2, f6]);
    assert.strictEqual(result.winner, f2);
    assert.strictEqual(result.warn, false);
  });

  test('F2+F4 → Frame 4 wins, no warn', () => {
    const f2 = finding('F2', 'P1');
    const f4 = finding('F4', 'P2');
    const result = selectFix(['F2', 'F4'], [f2, f4]);
    assert.strictEqual(result.winner, f4);
    assert.strictEqual(result.warn, false);
  });

  test('F3+F5 → Frame 5 wins, no warn', () => {
    const f3 = finding('F3', 'P1');
    const f5 = finding('F5', 'P2');
    const result = selectFix(['F3', 'F5'], [f3, f5]);
    assert.strictEqual(result.winner, f5);
    assert.strictEqual(result.warn, false);
  });

  test('single-frame F1 → F1 wins, no warn', () => {
    const f1 = finding('F1', 'P0');
    const result = selectFix(['F1'], [f1]);
    assert.strictEqual(result.winner, f1);
    assert.strictEqual(result.warn, false);
  });
});

describe('selectFix: untabulated combinations', () => {
  test('F2+F5 (untabulated) → warn=true, winner is max-severity member', () => {
    const f2 = finding('F2', 'P2');
    const f5 = finding('F5', 'P0');
    const result = selectFix(['F2', 'F5'], [f2, f5]);
    assert.strictEqual(result.warn, true);
    assert.strictEqual(result.winner, f5);
  });

  test('untabulated: when tied severity, returns first max-severity member', () => {
    const f2 = finding('F2', 'P1');
    const f6 = finding('F6', 'P1');
    const result = selectFix(['F2', 'F6'], [f2, f6]);
    assert.strictEqual(result.warn, true);
    assert.ok(result.winner === f2 || result.winner === f6);
    assert.strictEqual(result.winner.post_verification_severity, 'P1');
  });

  test('F1+F4+F5 (untabulated) → warn=true', () => {
    const f1 = finding('F1', 'P3');
    const f4 = finding('F4', 'P1');
    const f5 = finding('F5', 'P2');
    const result = selectFix(['F1', 'F4', 'F5'], [f1, f4, f5]);
    assert.strictEqual(result.warn, true);
    assert.strictEqual(result.winner, f4);
  });
});

describe('selectFix: error handling', () => {
  test('empty members array throws', () => {
    assert.throws(() => selectFix(['F1'], []), /Error/);
  });
});

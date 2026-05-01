import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB_PATH = path.resolve(__dirname, '..', 'lib', 'verification-comparator.js');

const { structuralEqual } = await import(LIB_PATH);

describe('structuralEqual', () => {
  describe('confirm cases', () => {
    test('order-reversed sets are equal', () => {
      assert.strictEqual(structuralEqual(['N3', 'N1', 'N5'], ['N1', 'N3', 'N5']), true);
    });

    test('identical sets are equal', () => {
      assert.strictEqual(structuralEqual(['N1', 'N2'], ['N1', 'N2']), true);
    });

    test('empty sets are equal', () => {
      assert.strictEqual(structuralEqual([], []), true);
    });
  });

  describe('disagree cases', () => {
    test('member mismatch returns false', () => {
      assert.strictEqual(structuralEqual(['N1', 'N2'], ['N1', 'N3']), false);
    });

    test('different lengths return false', () => {
      assert.strictEqual(structuralEqual(['N1', 'N2'], ['N1']), false);
    });

    test('case-sensitive: N1 !== n1', () => {
      assert.strictEqual(structuralEqual(['N1'], ['n1']), false);
    });
  });

  describe('determinism', () => {
    test('two runs against same inputs produce identical results', () => {
      const a = ['N3', 'N1', 'N5'];
      const b = ['N1', 'N3', 'N5'];
      assert.strictEqual(structuralEqual(a, b), structuralEqual(a, b));
    });
  });

  describe('TypeError guard', () => {
    test('non-array first arg throws TypeError', () => {
      assert.throws(() => structuralEqual('N1', ['N1']), TypeError);
    });

    test('non-array second arg throws TypeError', () => {
      assert.throws(() => structuralEqual(['N1'], null), TypeError);
    });
  });
});

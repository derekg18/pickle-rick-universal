import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB_PATH = path.resolve(__dirname, '..', 'lib', 'severity.js');

const { maxSeverity } = await import(LIB_PATH);

describe('maxSeverity: max-by-impact ordering', () => {
  test('P0 beats P1', () => {
    assert.strictEqual(maxSeverity(['P0', 'P1']), 'P0');
  });

  test('P1 beats P3 and P4', () => {
    assert.strictEqual(maxSeverity(['P3', 'P1', 'P4']), 'P1');
  });

  test('single element returns itself', () => {
    assert.strictEqual(maxSeverity(['P0']), 'P0');
  });

  test('all equal returns that severity', () => {
    assert.strictEqual(maxSeverity(['P2', 'P2', 'P2']), 'P2');
  });
});

describe('maxSeverity: enum closure enforcement', () => {
  test('unknown literal throws TypeError', () => {
    assert.throws(() => maxSeverity(['P9']), (err) => {
      assert.ok(err instanceof TypeError, `expected TypeError, got ${err.constructor.name}`);
      assert.ok(/P9/.test(err.message), `expected message to mention P9, got: ${err.message}`);
      return true;
    });
  });

  test('empty array throws Error', () => {
    assert.throws(() => maxSeverity([]), /Error/);
  });
});

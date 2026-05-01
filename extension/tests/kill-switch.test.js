import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB_PATH = path.resolve(__dirname, '..', 'lib', 'plumbus-kill-switch.js');

const { shouldRunGenerativeAudit } = await import(LIB_PATH);

describe('kill-switch: shouldRunGenerativeAudit', () => {
  describe('env off → no analyzer', () => {
    test('PLUMBUS_GENERATIVE_AUDIT=off returns false', () => {
      assert.strictEqual(
        shouldRunGenerativeAudit({ PLUMBUS_GENERATIVE_AUDIT: 'off' }, []),
        false,
      );
    });

    test('PLUMBUS_GENERATIVE_AUDIT=OFF (wrong case) returns true', () => {
      assert.strictEqual(
        shouldRunGenerativeAudit({ PLUMBUS_GENERATIVE_AUDIT: 'OFF' }, []),
        true,
      );
    });

    test('PLUMBUS_GENERATIVE_AUDIT=false returns true', () => {
      assert.strictEqual(
        shouldRunGenerativeAudit({ PLUMBUS_GENERATIVE_AUDIT: 'false' }, []),
        true,
      );
    });

    test('PLUMBUS_GENERATIVE_AUDIT=0 returns true', () => {
      assert.strictEqual(
        shouldRunGenerativeAudit({ PLUMBUS_GENERATIVE_AUDIT: '0' }, []),
        true,
      );
    });

    test('PLUMBUS_GENERATIVE_AUDIT absent returns true', () => {
      assert.strictEqual(shouldRunGenerativeAudit({}, []), true);
    });
  });

  describe('env off → activity log (kill-switch exact literal)', () => {
    test('exact kill-switch activity literal is defined in source', async () => {
      const src = await import('node:fs').then(fs =>
        fs.readFileSync(
          path.resolve(__dirname, '..', 'src', 'lib', 'plumbus-kill-switch.ts'),
          'utf8',
        ),
      );
      assert.ok(
        src.includes("'off'") || src.includes('"off"'),
        'source must check for exact string "off"',
      );
    });
  });

  describe('flag equivalence', () => {
    test('--no-generative flag returns false', () => {
      assert.strictEqual(
        shouldRunGenerativeAudit({}, ['--resume', '/tmp/sess', '--no-generative']),
        false,
      );
    });

    test('--no-generative with PLUMBUS_GENERATIVE_AUDIT=on still returns false', () => {
      assert.strictEqual(
        shouldRunGenerativeAudit({ PLUMBUS_GENERATIVE_AUDIT: 'on' }, ['--no-generative']),
        false,
      );
    });

    test('other flags do not trigger kill-switch', () => {
      assert.strictEqual(
        shouldRunGenerativeAudit({}, ['--resume', '/tmp/sess', '--dry-run']),
        true,
      );
    });
  });

  describe('CLAUDE.md documented', () => {
    test('PLUMBUS_GENERATIVE_AUDIT appears in CLAUDE.md', () => {
      const claudeMdPath = path.resolve(__dirname, '..', '..', 'CLAUDE.md');
      const count = Number(
        execSync(`grep -c 'PLUMBUS_GENERATIVE_AUDIT' ${JSON.stringify(claudeMdPath)}`, {
          encoding: 'utf8',
        }).trim(),
      );
      assert.ok(count >= 1, `expected ≥ 1 match in CLAUDE.md, got ${count}`);
    });
  });
});

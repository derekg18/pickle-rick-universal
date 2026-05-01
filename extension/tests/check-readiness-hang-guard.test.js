import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourcePath = resolve(__dirname, '../src/bin/check-readiness.ts');

test('check-readiness contract resolution passes explicit one-hop timeout', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.match(source, /computeOneHop\([^;]+findImportersTimeoutMs:\s*30_000[^;]+\)/s);
});

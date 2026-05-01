import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourcePath = resolve(__dirname, '../src/bin/debate.ts');

test('debate brief-prep helper does not import child_process or spawn workers', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.equal(source.includes('node:child_process'), false);
  assert.equal(/\bspawn(?:Sync)?\s*\(/.test(source), false);
  assert.equal(/\bexec(?:File|Sync)?\s*\(/.test(source), false);
});

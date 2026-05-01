import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = resolve(__dirname, '../data/gate-commands.json');

const PROJECT_TYPES = ['pnpm', 'npm', 'yarn', 'cargo', 'go'];
const COMMANDS = ['typecheck', 'lint', 'test'];

test('gate-commands.json parses as valid JSON', () => {
  const raw = readFileSync(DATA_PATH, 'utf8');
  assert.doesNotThrow(() => JSON.parse(raw));
});

test('gate-commands.json has all 5 project types', () => {
  const data = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
  for (const pt of PROJECT_TYPES) {
    assert.ok(pt in data, `missing project type: ${pt}`);
  }
});

test('each project type has all 3 commands', () => {
  const data = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
  for (const pt of PROJECT_TYPES) {
    for (const cmd of COMMANDS) {
      assert.ok(
        typeof data[pt][cmd] === 'string' && data[pt][cmd].length > 0,
        `${pt}.${cmd} is missing or empty`
      );
    }
  }
});

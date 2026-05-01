import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(__dirname, '..');
const stateTypesPath = path.join(extensionRoot, 'src', 'types', 'index.ts');
const claudePath = path.join(extensionRoot, 'CLAUDE.md');

function extractStateFields(source) {
  const match = source.match(/export interface State \{([\s\S]*?)\n\}/);
  assert.ok(match, 'State interface exists');
  return [...match[1].matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\??:/gm)].map((field) => field[1]);
}

function extractFieldInvariantSection(source) {
  const match = source.match(/## state\.json Field Invariants\n\n([\s\S]*?)(?:\n## |\n?$)/);
  assert.ok(match, 'state.json Field Invariants section exists');
  return match[1];
}

test('AC-BUNDLE-17: trap-door entries stay under 1500 chars', () => {
  const claude = fs.readFileSync(claudePath, 'utf8');
  const overlong = claude
    .split('\n')
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => line.startsWith('- `') && line.length > 1500);

  assert.deepEqual(overlong, []);
});

test('AC-BUNDLE-17: every State field has exactly one field invariant', () => {
  const stateSource = fs.readFileSync(stateTypesPath, 'utf8');
  const claude = fs.readFileSync(claudePath, 'utf8');
  const fields = extractStateFields(stateSource);
  const section = extractFieldInvariantSection(claude);

  for (const field of fields) {
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = section.match(new RegExp(`INVARIANT: \`${escaped}\``, 'g')) ?? [];
    assert.equal(matches.length, 1, `${field} must appear in exactly one INVARIANT clause`);
  }
});

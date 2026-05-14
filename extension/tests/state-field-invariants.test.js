import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { StateManager } from '../services/state-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(__dirname, '..');
const stateTypesPath = path.join(extensionRoot, 'src', 'types', 'index.ts');
const invariantDocPath = fs.existsSync(path.join(extensionRoot, 'CLAUDE.md'))
  ? path.join(extensionRoot, 'CLAUDE.md')
  : path.join(extensionRoot, 'GEMINI.md');

function extractStateFields(source) {
  const match = source.match(/export interface State \{([\s\S]*?)\n\}/);
  assert.ok(match, 'State interface exists');
  return [...match[1].matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\??:/gm)].map((field) => field[1]);
}

function extractStateFlagsFields(source) {
  const match = source.match(/export interface StateFlags \{([\s\S]*?)\n\}/);
  assert.ok(match, 'StateFlags interface exists');
  return [...match[1].matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\??:/gm)].map((field) => field[1]);
}

function extractFieldInvariantSection(source) {
  const match = source.match(/## state\.json Field Invariants\n\n([\s\S]*?)(?:\n## |\n?$)/);
  assert.ok(match, 'state.json Field Invariants section exists');
  return match[1];
}

test('AC-BUNDLE-17: trap-door entries stay under 1500 chars', () => {
  const invariantDoc = fs.readFileSync(invariantDocPath, 'utf8');
  const overlong = invariantDoc
    .split('\n')
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => line.startsWith('- `') && line.length > 1500);

  assert.deepEqual(overlong, []);
});

test('AC-BUNDLE-17: every State field has exactly one field invariant', () => {
  const stateSource = fs.readFileSync(stateTypesPath, 'utf8');
  const invariantDoc = fs.readFileSync(invariantDocPath, 'utf8');
  const fields = extractStateFields(stateSource);
  const section = extractFieldInvariantSection(invariantDoc);

  for (const field of fields) {
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = section.match(new RegExp(`INVARIANT: \`${escaped}\``, 'g')) ?? [];
    assert.equal(matches.length, 1, `${field} must appear in exactly one INVARIANT clause`);
  }
});

test('StateFlags typed keys are documented in the flags invariant', () => {
  const stateSource = fs.readFileSync(stateTypesPath, 'utf8');
  const invariantDoc = fs.readFileSync(invariantDocPath, 'utf8');
  const stateFlags = extractStateFlagsFields(stateSource);
  const section = extractFieldInvariantSection(invariantDoc);
  const flagsInvariant = section
    .split('\n')
    .find((line) => line.includes('INVARIANT: `flags`'));
  assert.ok(flagsInvariant, 'flags invariant exists');

  const expectedFlags = [
    'human_help_requested',
    'human_help_reason',
    'human_help_recovery_command',
    'jerry_mode_signature',
    'os_notifier_available',
  ];
  for (const flag of expectedFlags) {
    assert.ok(stateFlags.includes(flag), `${flag} must be typed on StateFlags`);
    assert.ok(flagsInvariant.includes(`\`${flag}\``), `${flag} must be documented in flags invariant`);
  }
});

test('legacy state fixture without new StateFlags keys reads with missing flags undefined', () => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-state-flags-'));
  try {
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({
      active: true,
      working_dir: '/tmp/project',
      step: 'implement',
      iteration: 1,
      max_iterations: 10,
      max_time_minutes: 60,
      worker_timeout_seconds: 1200,
      start_time_epoch: 1,
      completion_promise: null,
      original_prompt: 'legacy fixture',
      current_ticket: null,
      history: [],
      started_at: new Date(0).toISOString(),
      session_dir: dir,
      schema_version: 4,
      flags: { legacy_unknown_flag: 'keep-me' },
    }));

    const state = new StateManager().read(statePath);

    assert.equal(state.flags.human_help_requested, undefined);
    assert.equal(state.flags.human_help_reason, undefined);
    assert.equal(state.flags.human_help_recovery_command, undefined);
    assert.equal(state.flags.jerry_mode_signature, undefined);
    assert.equal(state.flags.os_notifier_available, undefined);
    assert.equal(state.flags.legacy_unknown_flag, 'keep-me');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

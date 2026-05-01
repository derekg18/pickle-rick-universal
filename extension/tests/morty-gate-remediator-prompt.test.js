// Tests morty-gate-remediator.md prompt body for required P1.4 clauses + abort grammar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_PATH = resolve(__dirname, '../../.claude/agents/morty-gate-remediator.md');
const body = readFileSync(AGENT_PATH, 'utf8');

test('morty-gate-remediator: frontmatter name matches contract', () => {
  assert.ok(body.includes('name: morty-gate-remediator'), 'name key must be morty-gate-remediator');
});

test('morty-gate-remediator: frontmatter role is gate-remediator', () => {
  assert.ok(body.includes('role: gate-remediator'), 'role must be gate-remediator');
});

test('morty-gate-remediator: tools list is exactly Read, Edit, Bash, Glob, Grep', () => {
  const toolsMatch = body.match(/^tools:\s*(.+)$/m);
  assert.ok(toolsMatch, 'tools line must be present');
  const tools = toolsMatch[1].trim().split(',').map(s => s.trim());
  const ALLOWED = new Set(['Read', 'Edit', 'Bash', 'Glob', 'Grep']);
  for (const t of tools) {
    assert.ok(ALLOWED.has(t), `tools must be Read,Edit,Bash,Glob,Grep only — found: ${t}`);
  }
  assert.strictEqual(tools.length, 5, 'must have exactly 5 tools');
});

test('morty-gate-remediator: P1.4(a) regex character class clause present', () => {
  assert.ok(body.includes('(a)'), 'clause (a) must be present');
  assert.ok(
    body.includes('no-control-regex') || body.includes('Regex character') || body.includes('regex character'),
    'clause (a) must reference regex/control-regex',
  );
});

test('morty-gate-remediator: P1.4(b) async-generator clause present', () => {
  assert.ok(body.includes('(b)'), 'clause (b) must be present');
  assert.ok(
    body.includes('async function') || body.includes('require-await') || body.includes('AsyncIterable'),
    'clause (b) must reference async-generator / require-await',
  );
});

test('morty-gate-remediator: P1.4(c) type assertion clause present', () => {
  assert.ok(body.includes('(c)'), 'clause (c) must be present');
  assert.ok(
    body.includes('no-unnecessary-type-assertion') || body.includes('as Type') || body.includes('type assertion'),
    'clause (c) must reference type assertion removal',
  );
});

test('morty-gate-remediator: P1.4(d) spec-mock alignment clause present', () => {
  assert.ok(body.includes('(d)'), 'clause (d) must be present');
  assert.ok(
    body.includes('mock') || body.includes('spec-file') || body.includes('Spec-file'),
    'clause (d) must reference spec/mock alignment',
  );
});

test('morty-gate-remediator: TS2741 error code present (production-coverage proxy)', () => {
  assert.ok(body.includes('TS2741'), 'TS2741 must appear in the prompt body');
});

test('morty-gate-remediator: covering test language present (production-coverage proxy d.iii)', () => {
  assert.ok(
    body.includes('covering test') || body.includes('production-test-coverage proxy') || body.includes('production_coverage_test_path'),
    'covering-test / production-coverage-proxy language must be present',
  );
});

test('morty-gate-remediator: abort file pattern present', () => {
  assert.ok(body.includes('remediation_aborted_'), 'abort file pattern remediation_aborted_ must be present');
});

test('morty-gate-remediator: auto-fix delegation via eslint --fix present', () => {
  assert.ok(
    body.includes('eslint --fix'),
    'eslint --fix delegation must be present',
  );
});

test('morty-gate-remediator: auto-fix delegation via prettier --write present', () => {
  assert.ok(
    body.includes('prettier --write'),
    'prettier --write delegation must be present',
  );
});

test('morty-gate-remediator: gate_remediation_complete event present', () => {
  assert.ok(body.includes('gate_remediation_complete'), 'gate_remediation_complete must appear in result protocol');
});

test('morty-gate-remediator: snapshot-and-revert protocol present', () => {
  assert.ok(
    body.includes('sha256') || body.includes('Snapshot-and-Revert') || body.includes('snapshot-and-revert'),
    'snapshot-and-revert protocol must be described',
  );
});

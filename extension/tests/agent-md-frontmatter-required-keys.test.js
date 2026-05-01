// VENDORED FROM convergence-toolchain-gates PRD; DELETE WHEN bmad-inspired-hardening lands its agent-md-schema.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = resolve(__dirname, '../../.claude/agents');
const VALID_MODELS = new Set(['sonnet', 'opus', 'haiku']);

function parseFrontmatter(content) {
  if (!content.startsWith('---\n')) return null;
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) return null;
  const block = content.slice(4, end);
  const result = {};
  for (const line of block.split('\n')) {
    const colon = line.indexOf(': ');
    if (colon === -1) continue;
    result[line.slice(0, colon).trim()] = line.slice(colon + 2).trim();
  }
  return result;
}

function agentFiles() {
  return readdirSync(AGENTS_DIR)
    .filter(f => f.endsWith('.md'))
    .map(f => ({ name: f, path: join(AGENTS_DIR, f), content: readFileSync(join(AGENTS_DIR, f), 'utf8') }));
}

test('agent-md-frontmatter: all .md files start with --- delimiter', () => {
  for (const { name, content } of agentFiles()) {
    assert.ok(content.startsWith('---\n'), `${name} must start with ---`);
    assert.ok(content.indexOf('\n---\n') !== -1, `${name} must have closing ---`);
  }
});

test('agent-md-frontmatter: required keys name, description, tools present', () => {
  for (const { name, content } of agentFiles()) {
    const fm = parseFrontmatter(content);
    assert.ok(fm !== null, `${name}: frontmatter failed to parse`);
    for (const key of ['name', 'description', 'tools']) {
      assert.ok(typeof fm[key] === 'string' && fm[key].length > 0, `${name}: missing or empty key "${key}"`);
    }
  }
});

test('agent-md-frontmatter: tools is non-empty comma-separated list', () => {
  for (const { name, content } of agentFiles()) {
    const fm = parseFrontmatter(content);
    const items = fm.tools.split(',').map(s => s.trim()).filter(Boolean);
    assert.ok(items.length >= 1, `${name}: tools must have at least one item`);
    for (const item of items) {
      assert.ok(item.length > 0, `${name}: tools list contains empty item`);
    }
  }
});

test('agent-md-frontmatter: optional model is valid enum if present', () => {
  for (const { name, content } of agentFiles()) {
    const fm = parseFrontmatter(content);
    if (!('model' in fm)) continue;
    assert.ok(VALID_MODELS.has(fm.model), `${name}: model "${fm.model}" not in {sonnet, opus, haiku}`);
  }
});

test('agent-md-frontmatter: optional role is non-empty string if present', () => {
  for (const { name, content } of agentFiles()) {
    const fm = parseFrontmatter(content);
    if (!('role' in fm)) continue;
    assert.ok(typeof fm.role === 'string' && fm.role.length > 0, `${name}: role must be non-empty string`);
  }
});

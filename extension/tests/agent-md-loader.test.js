import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadAgentMd, parseAgentMdFrontmatter, resolveAgentMdPath } from '../services/agent-md-loader.js';

function tempAgentsDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-md-loader-'));
  mkdirSync(path.join(dir, '.pickle-managed'), { recursive: true });
  return dir;
}

function writeAgent(filePath, name, description) {
  writeFileSync(
    filePath,
    [
      '---',
      `name: ${name}`,
      `description: ${description}`,
      'tools: Read, Glob, Grep',
      'model: sonnet',
      'role: phase-researcher',
      'identity: Know what exists.',
      'communication_style: direct',
      'principles[]: ["Ground claims.", "Cite files."]',
      '---',
      '',
      '# Body',
      '',
    ].join('\n'),
  );
}

test('agent-md-loader: user override wins over managed canonical file', () => {
  const agentsDir = tempAgentsDir();
  try {
    writeAgent(path.join(agentsDir, '.pickle-managed', 'morty-phase-researcher.md'), 'managed-agent', 'Managed');
    writeAgent(path.join(agentsDir, 'morty-phase-researcher.md'), 'user-agent', 'User');

    const loaded = loadAgentMd('morty-phase-researcher', { agentsDir });

    assert.ok(loaded);
    assert.equal(loaded.source, 'user');
    assert.equal(loaded.name, 'user-agent');
    assert.deepEqual(loaded.frontmatter.tools, ['Read', 'Glob', 'Grep']);
    assert.deepEqual(loaded.frontmatter.principles, ['Ground claims.', 'Cite files.']);
  } finally {
    rmSync(agentsDir, { recursive: true, force: true });
  }
});

test('agent-md-loader: managed canonical file is fallback when override is absent', () => {
  const agentsDir = tempAgentsDir();
  try {
    const managed = path.join(agentsDir, '.pickle-managed', 'morty-phase-planner.md');
    writeAgent(managed, 'morty-phase-planner', 'Planner');

    const resolved = resolveAgentMdPath('morty-phase-planner.md', { agentsDir });
    const loaded = loadAgentMd('morty-phase-planner', { agentsDir });

    assert.deepEqual(resolved, { path: managed, source: 'managed' });
    assert.ok(loaded);
    assert.equal(loaded.source, 'managed');
    assert.equal(loaded.path, managed);
  } finally {
    rmSync(agentsDir, { recursive: true, force: true });
  }
});

test('agent-md-loader: missing agent returns null', () => {
  const agentsDir = tempAgentsDir();
  try {
    assert.equal(loadAgentMd('missing-agent', { agentsDir }), null);
  } finally {
    rmSync(agentsDir, { recursive: true, force: true });
  }
});

test('agent-md-loader: malformed frontmatter fails clearly', () => {
  assert.throws(
    () => parseAgentMdFrontmatter('name: morty\n tools: Read', 'bad.md'),
    /missing required key "description".*bad\.md/,
  );
  assert.throws(
    () => parseAgentMdFrontmatter('name: morty\ndescription: bad\ntools: Read\nmodel: gpt-9', 'bad.md'),
    /model "gpt-9" is invalid/,
  );
});

test('agent-md-loader: rejects path traversal names', () => {
  const agentsDir = tempAgentsDir();
  try {
    assert.throws(() => resolveAgentMdPath('../morty', { agentsDir }), /Invalid agent name/);
  } finally {
    rmSync(agentsDir, { recursive: true, force: true });
  }
});

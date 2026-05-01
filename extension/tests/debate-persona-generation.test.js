import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEBATE_PERSONAS, generatedDebatePersonas } from '../bin/generate-debate-personas.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = resolve(__dirname, '../../.claude/agents');

function parseFrontmatter(content) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(content);
  assert.ok(match, 'agent markdown must have frontmatter');
  const result = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(': ');
    if (colon === -1) continue;
    result[line.slice(0, colon)] = line.slice(colon + 2);
  }
  return result;
}

test('debate persona committed files match generated output', () => {
  for (const [filename, generated] of generatedDebatePersonas()) {
    const committed = readFileSync(resolve(AGENTS_DIR, filename), 'utf8');
    assert.equal(committed, generated, `${filename} drifted from generate-debate-personas.ts`);
  }
});

test('debate persona files are read-only and persona-specific', () => {
  for (const persona of DEBATE_PERSONAS) {
    const filename = `morty-debater-${persona.name}.md`;
    const content = readFileSync(resolve(AGENTS_DIR, filename), 'utf8');
    const frontmatter = parseFrontmatter(content);
    const tools = frontmatter.tools.split(',').map((tool) => tool.trim());

    assert.equal(frontmatter.name, `morty-debater-${persona.name}`);
    assert.deepEqual(tools, ['Read', 'Glob', 'Grep']);
    assert.equal(tools.includes('Edit'), false);
    assert.equal(tools.includes('Write'), false);
    assert.equal(tools.includes('Bash'), false);
    assert.match(content, new RegExp(`Respond authentically as ${persona.title}`));
    assert.match(content, /explicit permission to disagree/);
    assert.match(content, /TaskUpdate\(status="completed"\)/);
  }
});

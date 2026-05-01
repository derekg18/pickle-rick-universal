import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncateTaskNotes } from '../bin/mux-runner.js';

// --- Under limit: returns unchanged ---

test('truncateTaskNotes: content under limit returns unchanged', () => {
  const input = '## Next\n- Do the thing\n\n## Progress\n- Did stuff\n';
  assert.equal(truncateTaskNotes(input, 2000), input);
});

test('truncateTaskNotes: exactly at limit returns unchanged', () => {
  const input = 'x'.repeat(2000);
  assert.equal(truncateTaskNotes(input, 2000), input);
});

// --- Empty input ---

test('truncateTaskNotes: empty string returns empty', () => {
  assert.equal(truncateTaskNotes('', 2000), '');
});

test('truncateTaskNotes: whitespace-only returns empty', () => {
  assert.equal(truncateTaskNotes('   \n  \n  ', 2000), '');
});

// --- Over limit with Progress trimmed ---

test('truncateTaskNotes: trims Progress when over limit, keeps Next/Dead Ends', () => {
  const next = '## Next\n- Important task\n';
  const deadEnds = '## Dead Ends\n- Tried X, failed\n';
  const progress = '## Progress\n' + '- Entry line here padding\n'.repeat(200);
  const input = next + '\n' + deadEnds + '\n' + progress;

  assert.ok(input.length > 2000, 'Input should exceed 2000 chars');

  const result = truncateTaskNotes(input, 2000);
  assert.ok(result.length <= 2000, `Result should be <= 2000 chars, got ${result.length}`);
  assert.ok(result.includes('## Next'), 'Should preserve ## Next');
  assert.ok(result.includes('Important task'), 'Should preserve Next content');
  assert.ok(result.includes('## Dead Ends'), 'Should preserve ## Dead Ends');
  assert.ok(result.includes('Tried X, failed'), 'Should preserve Dead Ends content');
});

// --- Over limit no sections: raw text trimmed from top ---

test('truncateTaskNotes: no sections trims from top with [truncated] marker', () => {
  const input = 'Line of text without any headers.\n'.repeat(200);
  assert.ok(input.length > 2000);

  const result = truncateTaskNotes(input, 2000);
  assert.ok(result.length <= 2000, `Result should be <= 2000, got ${result.length}`);
  assert.ok(result.startsWith('[truncated]'), 'Should start with [truncated] marker');
});

// --- Only Next section, even if over limit ---

test('truncateTaskNotes: single Next section over limit gets hard-truncated', () => {
  const input = '## Next\n' + 'Critical task details. '.repeat(200);
  assert.ok(input.length > 2000);

  const result = truncateTaskNotes(input, 2000);
  assert.ok(result.length <= 2000, `Result should be <= 2000, got ${result.length}`);
  assert.ok(result.includes('## Next'), 'Should preserve Next header');
  assert.ok(result.includes('[truncated]'), 'Should have truncated marker');
});

// --- Key Discoveries trimmed when Progress fully removed ---

test('truncateTaskNotes: removes Key Discoveries after Progress if still over limit', () => {
  const next = '## Next\n' + 'x'.repeat(800) + '\n';
  const deadEnds = '## Dead Ends\n' + 'y'.repeat(800) + '\n';
  const discoveries = '## Key Discoveries\n' + 'z'.repeat(800) + '\n';
  const progress = '## Progress\n' + 'w'.repeat(800) + '\n';
  const input = next + deadEnds + discoveries + progress;

  const result = truncateTaskNotes(input, 2000);
  assert.ok(result.length <= 2000, `Result should be <= 2000, got ${result.length}`);
  assert.ok(result.includes('## Next'), 'Should preserve Next');
  assert.ok(result.includes('## Dead Ends'), 'Should preserve Dead Ends');
});

// --- Default maxChars is 2000 ---

test('truncateTaskNotes: default maxChars is 2000', () => {
  const input = 'a'.repeat(3000);
  const result = truncateTaskNotes(input);
  assert.ok(result.length <= 2000, `Default should cap at 2000, got ${result.length}`);
});

// --- Preserves all sections when just under limit ---

test('truncateTaskNotes: preserves all sections when total is under limit', () => {
  const input = '## Next\n- Task\n\n## Dead Ends\n- Nope\n\n## Key Discoveries\n- Found it\n\n## Progress\n- Done\n';
  assert.ok(input.length < 2000);
  assert.equal(truncateTaskNotes(input, 2000), input);
});

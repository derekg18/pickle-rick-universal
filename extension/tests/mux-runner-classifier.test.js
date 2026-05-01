import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyCompletion } from '../bin/mux-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, 'fixtures', 'iteration-logs');

function readFixture(name) {
    return fs.readFileSync(path.join(FIXTURES, name), 'utf-8');
}

test('classifier: codex-prompt-leak.log → continue (EPIC_COMPLETED in user block is dropped)', () => {
    const content = readFixture('codex-prompt-leak.log');
    assert.equal(classifyCompletion(content), 'continue');
});

test('classifier: codex-real-completion.log → task_completed (EPIC_COMPLETED in codex block)', () => {
    const content = readFixture('codex-real-completion.log');
    assert.equal(classifyCompletion(content), 'task_completed');
});

test('classifier: codex-ticket-selected.log → continue (no completion token in codex block)', () => {
    const content = readFixture('codex-ticket-selected.log');
    assert.equal(classifyCompletion(content), 'continue');
});

test('classifier: claude-stream-json.log → continue (EPIC_COMPLETED only in user prompt, not assistant)', () => {
    const content = readFixture('claude-stream-json.log');
    assert.equal(classifyCompletion(content), 'continue');
});

test('classifier: claude-real-completion.log → task_completed (EPIC_COMPLETED in assistant block)', () => {
    const content = readFixture('claude-real-completion.log');
    assert.equal(classifyCompletion(content), 'task_completed');
});

test('classifier: mixed-json-noise.log → continue (bare null line must not trigger stream-json mode)', () => {
    const content = readFixture('mixed-json-noise.log');
    assert.equal(classifyCompletion(content), 'continue');
});

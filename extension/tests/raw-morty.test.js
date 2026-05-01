import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { processLineRaw } from '../bin/raw-morty.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAW_MORTY_BIN = path.resolve(__dirname, '../bin/raw-morty.js');

function run(args) {
    // 5s → 30s: budget for system load when run alongside concurrent
    // codex/tmux work. Tests validate CLI behavior, not wall-clock.
    return spawnSync(process.execPath, [RAW_MORTY_BIN, ...args], {
        env: { ...process.env },
        encoding: 'utf-8',
        timeout: 30000,
    });
}

function makeSessionDir(prefix) {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// --- Startup validation ---

test('raw-morty: no args → exit 1, stderr includes Usage', () => {
    const result = run([]);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes('Usage'));
});

test('raw-morty: flag-like arg → exit 1, stderr includes Usage', () => {
    const result = run(['--resume']);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes('Usage'));
});

test('raw-morty: non-existent session dir → exit 1, stderr includes Usage', () => {
    const result = run(['/tmp/definitely-does-not-exist-raw-morty-' + Date.now()]);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes('Usage'));
});

// --- processLineRaw: null / empty ---

test('processLineRaw: empty string → null', () => {
    assert.equal(processLineRaw(''), null);
});

test('processLineRaw: whitespace-only → null', () => {
    assert.equal(processLineRaw('   \t  '), null);
});

// --- processLineRaw: invalid JSON → DIM-styled raw text ---

test('processLineRaw: invalid JSON → returns DIM-styled text (not null)', () => {
    const result = processLineRaw('not-json-at-all');
    assert.ok(result !== null, 'should return styled text, not null');
    assert.ok(result.includes('not-json-at-all'));
});

// --- processLineRaw: assistant text block ---

test('processLineRaw: assistant text block → green-styled text', () => {
    const line = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello Morty' }] },
    });
    const result = processLineRaw(line);
    assert.ok(result !== null);
    assert.ok(result.includes('Hello Morty'));
});

test('processLineRaw: assistant multiple blocks → joined output', () => {
    const line = JSON.stringify({
        type: 'assistant',
        message: {
            content: [
                { type: 'text', text: 'Think...' },
                { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
            ],
        },
    });
    const result = processLineRaw(line);
    assert.ok(result !== null);
    assert.ok(result.includes('Think...'));
    assert.ok(result.includes('Bash'));
    assert.ok(result.includes('ls'));
});

test('processLineRaw: assistant no content blocks → null', () => {
    const line = JSON.stringify({
        type: 'assistant',
        message: { content: [] },
    });
    assert.equal(processLineRaw(line), null);
});

test('processLineRaw: assistant missing message → null', () => {
    const line = JSON.stringify({ type: 'assistant' });
    assert.equal(processLineRaw(line), null);
});

// --- processLineRaw: tool_use formatting per tool name ---

test('processLineRaw: tool_use Bash → includes command detail', () => {
    const line = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo hi' } }] },
    });
    const result = processLineRaw(line);
    assert.ok(result !== null);
    assert.ok(result.includes('Bash'));
    assert.ok(result.includes('echo hi'));
});

test('processLineRaw: tool_use Read → includes file_path detail', () => {
    const line = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/foo/bar.ts' } }] },
    });
    const result = processLineRaw(line);
    assert.ok(result !== null);
    assert.ok(result.includes('/foo/bar.ts'));
});

test('processLineRaw: tool_use Edit → includes file_path detail', () => {
    const line = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/src/foo.ts' } }] },
    });
    const result = processLineRaw(line);
    assert.ok(result !== null);
    assert.ok(result.includes('/src/foo.ts'));
});

test('processLineRaw: tool_use Write → includes file_path detail', () => {
    const line = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/out/file.js' } }] },
    });
    const result = processLineRaw(line);
    assert.ok(result !== null);
    assert.ok(result.includes('/out/file.js'));
});

test('processLineRaw: tool_use Glob → includes pattern detail', () => {
    const line = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Glob', input: { pattern: '**/*.ts' } }] },
    });
    const result = processLineRaw(line);
    assert.ok(result !== null);
    assert.ok(result.includes('**/*.ts'));
});

test('processLineRaw: tool_use Grep → includes pattern detail', () => {
    const line = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'myFunc' } }] },
    });
    const result = processLineRaw(line);
    assert.ok(result !== null);
    assert.ok(result.includes('myFunc'));
});

test('processLineRaw: tool_use Agent → includes description detail', () => {
    const line = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Agent', input: { description: 'search files' } }] },
    });
    const result = processLineRaw(line);
    assert.ok(result !== null);
    assert.ok(result.includes('search files'));
});

test('processLineRaw: tool_use unknown name → shows name, no detail', () => {
    const line = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'UnknownTool', input: {} }] },
    });
    const result = processLineRaw(line);
    assert.ok(result !== null);
    assert.ok(result.includes('UnknownTool'));
});

test('processLineRaw: tool_use with wrong input type → name only (no crash)', () => {
    const line = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Bash', input: null }] },
    });
    const result = processLineRaw(line);
    assert.ok(result !== null);
    assert.ok(result.includes('Bash'));
});

// --- processLineRaw: result type ---

test('processLineRaw: result success → includes COMPLETE', () => {
    const line = JSON.stringify({
        type: 'result',
        subtype: 'success',
        num_turns: 5,
        total_cost_usd: 0.42,
    });
    const result = processLineRaw(line);
    assert.ok(result !== null);
    assert.ok(result.includes('COMPLETE'));
    assert.ok(result.includes('5'));
    assert.ok(result.includes('$0.42'));
});

test('processLineRaw: result error subtype → includes ERROR', () => {
    const line = JSON.stringify({
        type: 'result',
        subtype: 'error_max_turns',
        num_turns: 3,
        total_cost_usd: 0.10,
    });
    const result = processLineRaw(line);
    assert.ok(result !== null);
    assert.ok(result.includes('ERROR'));
    assert.ok(result.includes('error_max_turns'));
});

test('processLineRaw: result with missing cost/turns → uses fallback ?', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'success' });
    const result = processLineRaw(line);
    assert.ok(result !== null);
    assert.ok(result.includes('COMPLETE'));
    assert.ok(result.includes('?'));
});

// --- processLineRaw: system type ---

test('processLineRaw: system init → includes INIT + model', () => {
    const line = JSON.stringify({
        type: 'system',
        subtype: 'init',
        model: 'claude-sonnet-4',
    });
    const result = processLineRaw(line);
    assert.ok(result !== null);
    assert.ok(result.includes('INIT'));
    assert.ok(result.includes('claude-sonnet-4'));
});

test('processLineRaw: system init without model → uses "unknown"', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'init' });
    const result = processLineRaw(line);
    assert.ok(result !== null);
    assert.ok(result.includes('unknown'));
});

test('processLineRaw: system non-init subtype → null', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'other' });
    assert.equal(processLineRaw(line), null);
});

// --- processLineRaw: unknown type → null ---

test('processLineRaw: unknown type → null', () => {
    const line = JSON.stringify({ type: 'human', message: 'hello' });
    assert.equal(processLineRaw(line), null);
});

test('processLineRaw: non-object JSON (array) → null', () => {
    const line = JSON.stringify([1, 2, 3]);
    assert.equal(processLineRaw(line), null);
});

test('processLineRaw: non-object JSON (number) → null', () => {
    const line = JSON.stringify(42);
    assert.equal(processLineRaw(line), null);
});

test('raw-morty: dead-pid active session terminates via recovered state', () => {
    const sessionDir = makeSessionDir('pickle-raw-morty-session-');
    try {
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            pid: 999999,
            step: 'implement',
            iteration: 3,
        }, null, 2));

        const result = spawnSync(process.execPath, [RAW_MORTY_BIN, sessionDir], {
            env: { ...process.env },
            encoding: 'utf-8',
            timeout: 4000,
        });

        assert.notEqual(result.error?.code, 'ETIMEDOUT', `Watcher hung instead of terminating: ${result.stderr}`);
        assert.equal(result.status, 0, `Expected clean exit, got stderr: ${result.stderr}`);
        assert.ok(result.stdout.includes('FEED TERMINATED'), `Expected termination banner, got: ${result.stdout}`);
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});

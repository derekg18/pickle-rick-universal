import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { buildJudgeInvocation } from '../services/backend-spawn.js';

// The LLM judge is a READ-ONLY scorer. Any regression that grants it write,
// edit, bash, or full-FS access is a CRITICAL security bug — the judge runs
// on every microverse iteration and has no business mutating the tree.
// These tests lock the read-only invariant against regression for both backends.

function mkTmpDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// --- claude path ---

test('buildJudgeInvocation(claude): restricts to Read,Glob,Grep', () => {
    const dir = mkTmpDir('judge-claude-');
    const inv = buildJudgeInvocation('claude', {
        prompt: 'score this diff',
        addDirs: [dir],
        systemPrompt: 'You are a scoring judge.',
    });
    assert.equal(inv.cmd, 'claude');
    assert.equal(inv.backend, 'claude');
    const allowedIdx = inv.args.indexOf('--allowedTools');
    assert.ok(allowedIdx >= 0, '--allowedTools flag must be present');
    assert.equal(inv.args[allowedIdx + 1], 'Read,Glob,Grep',
        'judge must be read-only — Read,Glob,Grep only');
    // Hard-assert that write-capable tools are NOT in the allowlist. Guards
    // against a regression that adds `Edit` or `Write` or `Bash` to the list.
    const allowedValue = inv.args[allowedIdx + 1];
    assert.ok(!allowedValue.includes('Edit'), 'Edit must NOT be in judge allowlist');
    assert.ok(!allowedValue.includes('Write'), 'Write must NOT be in judge allowlist');
    assert.ok(!allowedValue.includes('Bash'), 'Bash must NOT be in judge allowlist');
});

test('buildJudgeInvocation(claude): includes --no-session-persistence', () => {
    const inv = buildJudgeInvocation('claude', {
        prompt: 'x',
        addDirs: [],
    });
    assert.ok(inv.args.includes('--no-session-persistence'),
        'judge must not persist session state');
});

test('buildJudgeInvocation(claude): threads --system-prompt and -p', () => {
    const inv = buildJudgeInvocation('claude', {
        prompt: 'user prompt body',
        addDirs: [],
        systemPrompt: 'SYSTEM RULES HERE',
    });
    const sysIdx = inv.args.indexOf('--system-prompt');
    assert.ok(sysIdx >= 0, '--system-prompt flag must be present');
    assert.equal(inv.args[sysIdx + 1], 'SYSTEM RULES HERE');
    const pIdx = inv.args.lastIndexOf('-p');
    assert.ok(pIdx >= 0);
    assert.equal(inv.args[pIdx + 1], 'user prompt body');
});

test('buildJudgeInvocation(claude): omits --system-prompt when none provided', () => {
    const inv = buildJudgeInvocation('claude', {
        prompt: 'x',
        addDirs: [],
    });
    assert.equal(inv.args.includes('--system-prompt'), false);
});

test('buildJudgeInvocation(claude): passes model via --model when provided', () => {
    const inv = buildJudgeInvocation('claude', {
        prompt: 'x',
        addDirs: [],
        model: 'claude-sonnet-4-6',
    });
    const mIdx = inv.args.indexOf('--model');
    assert.ok(mIdx >= 0);
    assert.equal(inv.args[mIdx + 1], 'claude-sonnet-4-6');
});

// --- codex path ---

test('buildJudgeInvocation(codex): does NOT contain --dangerously-bypass-approvals-and-sandbox', () => {
    // THE security assertion. A regression that re-adds the bypass flag gives
    // the judge full FS + shell access. This test is the tripwire.
    const inv = buildJudgeInvocation('codex', {
        prompt: 'score this',
        addDirs: [],
    });
    assert.equal(inv.cmd, 'codex');
    assert.equal(inv.backend, 'codex');
    assert.equal(
        inv.args.includes('--dangerously-bypass-approvals-and-sandbox'),
        false,
        'CRITICAL: codex judge must NEVER bypass the sandbox — read-only mode only',
    );
});

test('buildJudgeInvocation(codex): uses -s read-only sandbox mode', () => {
    const inv = buildJudgeInvocation('codex', {
        prompt: 'x',
        addDirs: [],
    });
    const sIdx = inv.args.indexOf('-s');
    assert.ok(sIdx >= 0, 'codex judge must pass -s <mode>');
    assert.equal(inv.args[sIdx + 1], 'read-only',
        'codex judge sandbox MUST be read-only (see `codex exec --help`)');
});

test('buildJudgeInvocation(codex): includes --ignore-rules and --ignore-user-config', () => {
    const inv = buildJudgeInvocation('codex', {
        prompt: 'x',
        addDirs: [],
    });
    assert.ok(inv.args.includes('--ignore-rules'),
        '--ignore-rules: judge must not be biased by project .rules files');
    assert.ok(inv.args.includes('--ignore-user-config'),
        '--ignore-user-config: judge must not be biased by user config.toml');
});

test('buildJudgeInvocation(codex): includes --ephemeral', () => {
    const inv = buildJudgeInvocation('codex', {
        prompt: 'x',
        addDirs: [],
    });
    assert.ok(inv.args.includes('--ephemeral'),
        'judge must not persist session files to disk');
});

test('buildJudgeInvocation(codex): inlines system prompt as prefix to user prompt', () => {
    const inv = buildJudgeInvocation('codex', {
        prompt: 'SCORE THE DIFF',
        addDirs: [],
        systemPrompt: 'YOU ARE A JUDGE',
    });
    // codex exec has no --system-prompt flag; it must be inlined.
    assert.equal(inv.args.includes('--system-prompt'), false);
    const composedPrompt = inv.args[inv.args.length - 1];
    assert.equal(inv.args[inv.args.length - 2], '--');
    assert.ok(composedPrompt.startsWith('YOU ARE A JUDGE'),
        'system prompt must prefix the user prompt for codex');
    assert.ok(composedPrompt.includes('SCORE THE DIFF'),
        'user prompt must still be present in composed prompt');
});

test('buildJudgeInvocation(codex): uses raw prompt when no system prompt provided', () => {
    const inv = buildJudgeInvocation('codex', {
        prompt: 'just the user prompt',
        addDirs: [],
    });
    assert.equal(inv.args[inv.args.length - 1], 'just the user prompt');
});

test('buildJudgeInvocation(codex): passes model via -m when provided', () => {
    const inv = buildJudgeInvocation('codex', {
        prompt: 'x',
        addDirs: [],
        model: 'gpt-5.4',
    });
    const mIdx = inv.args.indexOf('-m');
    assert.ok(mIdx >= 0);
    assert.equal(inv.args[mIdx + 1], 'gpt-5.4');
});

test('buildJudgeInvocation(codex): omits -m when no model given', () => {
    const inv = buildJudgeInvocation('codex', {
        prompt: 'x',
        addDirs: [],
    });
    assert.equal(inv.args.includes('-m'), false);
});

test('buildJudgeInvocation(codex): drops missing add-dir entries', () => {
    const validDir = mkTmpDir('judge-codex-');
    const inv = buildJudgeInvocation('codex', {
        prompt: 'x',
        addDirs: [validDir, '/definitely/does/not/exist/zzz', ''],
    });
    const addDirCount = inv.args.filter((a) => a === '--add-dir').length;
    assert.equal(addDirCount, 1);
    assert.ok(inv.args.includes(validDir));
});

test('buildJudgeInvocation(codex): starts with `exec` subcommand', () => {
    const inv = buildJudgeInvocation('codex', {
        prompt: 'x',
        addDirs: [],
    });
    assert.equal(inv.args[0], 'exec');
});

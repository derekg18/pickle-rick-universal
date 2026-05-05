import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import {
    backendEnvOverrides,
    buildJudgeInvocation,
    buildManagerInvocation,
    buildWorkerInvocation,
} from '../services/backend-spawn.js';

function mkTmpDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('buildWorkerInvocation(gemini): uses headless gemini -p with write-capable approval', () => {
    const dir = mkTmpDir('gemini-worker-');
    const inv = buildWorkerInvocation('gemini', {
        prompt: 'do the work',
        addDirs: [dir],
        model: 'gemini-2.5-pro',
        effort: 'high',
        outputFormat: 'stream-json',
    });

    assert.equal(inv.cmd, 'gemini');
    assert.equal(inv.backend, 'gemini');
    assert.ok(inv.args.includes('--yolo'), 'worker should be write-capable like other worker backends');
    assert.equal(inv.args.includes('--approval-mode'), false, 'worker must not use judge read-only approval mode');
    const includeIdx = inv.args.indexOf('--include-directories');
    assert.ok(includeIdx >= 0);
    assert.equal(inv.args[includeIdx + 1], dir);
    const modelIdx = inv.args.indexOf('-m');
    assert.ok(modelIdx >= 0);
    assert.equal(inv.args[modelIdx + 1], 'gemini-2.5-pro');
    const promptIdx = inv.args.indexOf('-p');
    assert.ok(promptIdx >= 0);
    assert.equal(inv.args[promptIdx + 1], 'do the work');
    assert.equal(inv.args.includes('-c'), false, 'codex effort flags must not leak into gemini');
    assert.equal(inv.args.includes('--output-format'), false, 'claude output-format flags must not leak into gemini');
});

test('buildWorkerInvocation(gemini): drops missing include directories', () => {
    const dir = mkTmpDir('gemini-worker-');
    const inv = buildWorkerInvocation('gemini', {
        prompt: 'x',
        addDirs: [dir, '/definitely/does/not/exist/gemini-worker', ''],
    });

    const includeCount = inv.args.filter((arg) => arg === '--include-directories').length;
    assert.equal(includeCount, 1);
    assert.ok(inv.args.includes(dir));
    assert.equal(inv.args.includes('/definitely/does/not/exist/gemini-worker'), false);
});

test('buildManagerInvocation(gemini): uses gemini -p and drops claude manager flags', () => {
    const dir = mkTmpDir('gemini-manager-');
    const inv = buildManagerInvocation('gemini', {
        prompt: 'manage',
        addDirs: [dir],
        model: 'gemini-2.5-flash',
        maxTurns: 10,
        streamJson: true,
        noSessionPersistence: true,
    });

    assert.equal(inv.cmd, 'gemini');
    assert.equal(inv.backend, 'gemini');
    assert.ok(inv.args.includes('--yolo'));
    assert.equal(inv.args.includes('--max-turns'), false);
    assert.equal(inv.args.includes('--output-format'), false);
    assert.equal(inv.args.includes('--no-session-persistence'), false);
    assert.equal(inv.args[inv.args.indexOf('-m') + 1], 'gemini-2.5-flash');
    assert.equal(inv.args[inv.args.indexOf('-p') + 1], 'manage');
});

test('buildManagerInvocation(gemini): applies configured review pass model override', () => {
    const inv = buildManagerInvocation('gemini', {
        prompt: 'manage',
        addDirs: [],
        model: 'gemini-default',
        pass: 'review',
        passModelOverrides: {
            review: { gemini: 'gemini-review' },
        },
    });

    assert.equal(inv.args[inv.args.indexOf('-m') + 1], 'gemini-review');
});

test('buildWorkerInvocation(gemini): ignores non-gemini pass model overrides', () => {
    const inv = buildWorkerInvocation('gemini', {
        prompt: 'x',
        addDirs: [],
        pass: 'quality',
        passModelOverrides: {
            quality: { codex: 'gpt-quality' },
        },
    });

    assert.equal(inv.args.includes('-m'), false);
});

test('buildJudgeInvocation(gemini): uses read-only plan approval and never yolo', () => {
    const dir = mkTmpDir('gemini-judge-');
    const inv = buildJudgeInvocation('gemini', {
        prompt: 'score this diff',
        addDirs: [dir, '/definitely/does/not/exist/gemini-judge'],
        model: 'gemini-2.5-pro',
        systemPrompt: 'You are a judge.',
    });

    assert.equal(inv.cmd, 'gemini');
    assert.equal(inv.backend, 'gemini');
    assert.equal(inv.args.includes('--yolo'), false, 'judge must not inherit write-capable worker settings');
    const approvalIdx = inv.args.indexOf('--approval-mode');
    assert.ok(approvalIdx >= 0);
    assert.equal(inv.args[approvalIdx + 1], 'plan');
    const includeCount = inv.args.filter((arg) => arg === '--include-directories').length;
    assert.equal(includeCount, 1);
    assert.ok(inv.args.includes(dir));
    assert.equal(inv.args[inv.args.indexOf('-m') + 1], 'gemini-2.5-pro');
    const prompt = inv.args[inv.args.indexOf('-p') + 1];
    assert.ok(prompt.startsWith('You are a judge.'));
    assert.ok(prompt.includes('score this diff'));
});

test('buildJudgeInvocation(gemini): uses raw prompt without system prompt', () => {
    const inv = buildJudgeInvocation('gemini', {
        prompt: 'just score',
        addDirs: [],
    });

    assert.equal(inv.args[inv.args.indexOf('-p') + 1], 'just score');
});

test('backendEnvOverrides(gemini): propagates PICKLE_BACKEND', () => {
    assert.deepEqual(backendEnvOverrides('gemini'), { PICKLE_BACKEND: 'gemini' });
});

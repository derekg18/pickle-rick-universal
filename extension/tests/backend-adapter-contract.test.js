import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKENDS } from '../types/index.js';
import {
    backendAdapters,
    backendMissingCliHint,
    backendSetupVersionCheck,
    backendSupportsCommitPendingProbe,
    backendSupportsDefaultClaudeModels,
    backendSupportsManagerErrorRelaunch,
    backendSupportsTeamsMode,
    backendSupportsWorkerRoutingHeuristic,
    backendWorkerPromptAddendum,
    buildJudgeInvocation,
    buildManagerInvocation,
    buildWorkerInvocation,
} from '../services/backend-spawn.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(__dirname, '..');

function readSrc(relativePath) {
    return fs.readFileSync(path.join(extensionRoot, 'src', relativePath), 'utf-8');
}

function stripComments(source) {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
}

test('backend adapter contract: every BACKENDS value has worker, manager, and judge builders', () => {
    assert.deepEqual(Object.keys(backendAdapters).sort(), [...BACKENDS].sort());

    for (const backend of BACKENDS) {
        const adapter = backendAdapters[backend];
        assert.equal(adapter.backend, backend);
        assert.equal(typeof adapter.buildWorkerInvocation, 'function');
        assert.equal(typeof adapter.buildManagerInvocation, 'function');
        assert.equal(typeof adapter.buildJudgeInvocation, 'function');
        assert.equal(typeof adapter.supportsTeamsMode, 'function');
        assert.equal(typeof adapter.supportsDefaultClaudeModels, 'function');
        assert.equal(typeof adapter.supportsCommitPendingProbe, 'function');
        assert.equal(typeof adapter.supportsManagerErrorRelaunch, 'function');
        assert.equal(typeof adapter.supportsWorkerRoutingHeuristic, 'function');
        assert.equal(typeof adapter.workerPromptAddendum, 'function');
        assert.equal(typeof adapter.missingCliHint, 'function');
        assert.equal(typeof adapter.setupVersionCheck, 'function');
    }
});

test('backend adapter contract: exported builders dispatch through backend-owned adapters', () => {
    for (const backend of BACKENDS) {
        const worker = buildWorkerInvocation(backend, { prompt: `worker-${backend}`, addDirs: [] });
        const manager = buildManagerInvocation(backend, { prompt: `manager-${backend}`, addDirs: [] });
        const judge = buildJudgeInvocation(backend, { prompt: `judge-${backend}`, addDirs: [] });

        assert.equal(worker.backend, backend);
        assert.equal(manager.backend, backend);
        assert.equal(judge.backend, backend);
        assert.equal(worker.cmd, backend);
        assert.equal(manager.cmd, backend);
        assert.equal(judge.cmd, backend);
    }
});

test('backend adapter contract: lifecycle policy helpers preserve backend capabilities', () => {
    assert.equal(backendSupportsTeamsMode('claude'), true);
    assert.equal(backendSupportsTeamsMode('codex'), false);
    assert.equal(backendSupportsTeamsMode('gemini'), false);

    assert.equal(backendSupportsDefaultClaudeModels('claude'), true);
    assert.equal(backendSupportsDefaultClaudeModels('codex'), false);
    assert.equal(backendSupportsDefaultClaudeModels('gemini'), false);

    assert.equal(backendSupportsCommitPendingProbe('claude'), false);
    assert.equal(backendSupportsCommitPendingProbe('codex'), true);
    assert.equal(backendSupportsCommitPendingProbe('gemini'), false);

    assert.equal(backendSupportsManagerErrorRelaunch('claude'), false);
    assert.equal(backendSupportsManagerErrorRelaunch('codex'), true);
    assert.equal(backendSupportsManagerErrorRelaunch('gemini'), false);

    assert.equal(backendSupportsWorkerRoutingHeuristic('claude'), false);
    assert.equal(backendSupportsWorkerRoutingHeuristic('codex'), true);
    assert.equal(backendSupportsWorkerRoutingHeuristic('gemini'), false);

    assert.equal(backendWorkerPromptAddendum('claude', 'DONE'), null);
    assert.match(backendWorkerPromptAddendum('codex', 'DONE'), /Codex-specific contract additions/);
    assert.equal(backendWorkerPromptAddendum('gemini', 'DONE'), null);

    assert.match(backendMissingCliHint('claude'), /claude CLI not found/);
    assert.match(backendMissingCliHint('codex'), /codex CLI not found/);
    assert.match(backendMissingCliHint('gemini'), /gemini CLI not found/);

    assert.equal(backendSetupVersionCheck('claude'), null);
    assert.deepEqual(backendSetupVersionCheck('codex'), { command: 'codex', packageEngine: 'codex' });
    assert.equal(backendSetupVersionCheck('gemini'), null);
});

test('backend adapter contract: lifecycle callers route backend policy through adapter helpers', () => {
    const sourceByFile = {
        'bin/setup.ts': readSrc('bin/setup.ts'),
        'bin/mux-runner.ts': readSrc('bin/mux-runner.ts'),
        'bin/jar-runner.ts': readSrc('bin/jar-runner.ts'),
        'bin/microverse-runner.ts': readSrc('bin/microverse-runner.ts'),
        'bin/spawn-morty.ts': readSrc('bin/spawn-morty.ts'),
    };

    assert.match(sourceByFile['bin/setup.ts'], /backendSupportsTeamsMode/);
    assert.match(sourceByFile['bin/setup.ts'], /backendSetupVersionCheck/);
    assert.match(sourceByFile['bin/mux-runner.ts'], /backendSupportsDefaultClaudeModels/);
    assert.match(sourceByFile['bin/mux-runner.ts'], /backendSupportsCommitPendingProbe/);
    assert.match(sourceByFile['bin/mux-runner.ts'], /backendSupportsManagerErrorRelaunch/);
    assert.match(sourceByFile['bin/jar-runner.ts'], /backendMissingCliHint/);
    assert.match(sourceByFile['bin/microverse-runner.ts'], /backendSupportsDefaultClaudeModels/);
    assert.match(sourceByFile['bin/spawn-morty.ts'], /backendWorkerPromptAddendum/);
    assert.match(sourceByFile['bin/spawn-morty.ts'], /backendSupportsWorkerRoutingHeuristic/);
    assert.match(sourceByFile['bin/spawn-morty.ts'], /backendSupportsDefaultClaudeModels/);

    for (const [file, source] of Object.entries(sourceByFile)) {
        const codeOnly = stripComments(source);
        assert.doesNotMatch(codeOnly, /backend\s*(?:={2,3}|!==?)\s*['"]claude['"]/, `${file} should not branch directly on claude backend`);
        assert.doesNotMatch(codeOnly, /backend\s*(?:={2,3}|!==?)\s*['"]codex['"]/, `${file} should not branch directly on codex backend`);
        assert.doesNotMatch(codeOnly, /ticket\.backend\s*(?:={2,3}|!==?)\s*['"]codex['"]/, `${file} should not branch directly on ticket.backend`);
        assert.doesNotMatch(codeOnly, /config\.backend\s*(?:={2,3}|!==?)\s*['"]codex['"]/, `${file} should not branch directly on config.backend`);
        assert.doesNotMatch(codeOnly, /willHaveBackend\s*(?:={2,3}|!==?)\s*['"]codex['"]/, `${file} should not branch directly on resume backend`);
    }
});

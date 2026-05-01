import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import {
    buildWorkerInvocation,
    buildManagerInvocation,
    resolveBackend,
    resolveBackendFromStateFile,
    isBackend,
    backendEnvOverrides,
} from '../services/backend-spawn.js';

function mkTmpDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withUnsetBackendEnv(fn) {
    const prev = process.env.PICKLE_BACKEND;
    delete process.env.PICKLE_BACKEND;
    try {
        fn();
    } finally {
        if (prev === undefined) delete process.env.PICKLE_BACKEND;
        else process.env.PICKLE_BACKEND = prev;
    }
}

// --- resolveBackend ---

test('resolveBackend: returns claude when state is null', () => {
    withUnsetBackendEnv(() => {
        assert.equal(resolveBackend(null), 'claude');
    });
});

test('resolveBackend: returns claude when backend is absent', () => {
    withUnsetBackendEnv(() => {
        assert.equal(resolveBackend({}), 'claude');
    });
});

test('resolveBackend: reads backend from state', () => {
    assert.equal(resolveBackend({ backend: 'codex' }), 'codex');
});

test('resolveBackend: rejects invalid backend', () => {
    withUnsetBackendEnv(() => {
        assert.equal(resolveBackend({ backend: 'gemini' }), 'claude');
    });
});

test('resolveBackend: falls through to PICKLE_BACKEND env', () => {
    const prev = process.env.PICKLE_BACKEND;
    process.env.PICKLE_BACKEND = 'codex';
    try {
        assert.equal(resolveBackend({}), 'codex');
    } finally {
        if (prev === undefined) delete process.env.PICKLE_BACKEND;
        else process.env.PICKLE_BACKEND = prev;
    }
});

test('isBackend: validates values', () => {
    assert.equal(isBackend('claude'), true);
    assert.equal(isBackend('codex'), true);
    assert.equal(isBackend('gpt'), false);
    assert.equal(isBackend(42), false);
});

// --- resolveBackendFromStateFile ---

test('resolveBackendFromStateFile: reads backend from JSON', () => {
    const dir = mkTmpDir('backend-spawn-');
    const file = path.join(dir, 'state.json');
    fs.writeFileSync(file, JSON.stringify({ backend: 'codex', active: true }));
    assert.equal(resolveBackendFromStateFile(file), 'codex');
});

test('resolveBackendFromStateFile: defaults to claude on missing file', () => {
    withUnsetBackendEnv(() => {
        assert.equal(resolveBackendFromStateFile('/nonexistent/state.json'), 'claude');
    });
});

test('resolveBackendFromStateFile: defaults to claude on corrupt JSON', () => {
    const dir = mkTmpDir('backend-spawn-');
    const file = path.join(dir, 'state.json');
    fs.writeFileSync(file, '{not valid json');
    withUnsetBackendEnv(() => {
        assert.equal(resolveBackendFromStateFile(file), 'claude');
    });
});

test('resolveBackendFromStateFile: recovers higher-iteration orphan tmp backend before resolving', () => {
    const dir = mkTmpDir('backend-spawn-');
    const file = path.join(dir, 'state.json');
    fs.writeFileSync(file, JSON.stringify({ backend: 'claude', iteration: 1, schema_version: 1 }));
    fs.writeFileSync(
        `${file}.tmp.99999999`,
        JSON.stringify({ backend: 'codex', iteration: 2, schema_version: 1 })
    );
    withUnsetBackendEnv(() => {
        assert.equal(resolveBackendFromStateFile(file), 'codex');
    });
    const promoted = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.equal(promoted.backend, 'codex');
});

test('resolveBackendFromStateFile: recovers newer same-iteration orphan tmp backend before resolving', () => {
    const dir = mkTmpDir('backend-spawn-');
    const file = path.join(dir, 'state.json');
    const baseTs = new Date('2026-04-28T12:00:00.000Z');
    const tmpTs = new Date('2026-04-28T12:00:01.000Z');
    fs.writeFileSync(file, JSON.stringify({ backend: 'claude', iteration: 7, schema_version: 1 }, null, 2));
    fs.utimesSync(file, baseTs, baseTs);
    fs.writeFileSync(
        `${file}.tmp.99999999`,
        JSON.stringify({ backend: 'codex', iteration: 7, schema_version: 1 }, null, 2)
    );
    fs.utimesSync(`${file}.tmp.99999999`, tmpTs, tmpTs);
    withUnsetBackendEnv(() => {
        assert.equal(resolveBackendFromStateFile(file), 'codex');
    });
    const promoted = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.equal(promoted.backend, 'codex');
});

// --- buildWorkerInvocation: claude ---

test('buildWorkerInvocation(claude): includes --dangerously-skip-permissions and -p', () => {
    const dir = mkTmpDir('bs-');
    const inv = buildWorkerInvocation('claude', {
        prompt: 'hello world',
        addDirs: [dir],
        model: 'sonnet',
        outputFormat: 'text',
    });
    assert.equal(inv.cmd, 'claude');
    assert.equal(inv.backend, 'claude');
    assert.ok(inv.args.includes('--dangerously-skip-permissions'));
    assert.ok(inv.args.includes('--add-dir'));
    assert.ok(inv.args.includes(dir));
    assert.ok(inv.args.includes('--model'));
    assert.ok(inv.args.includes('sonnet'));
    assert.ok(inv.args.includes('-p'));
    assert.equal(inv.args[inv.args.length - 1], 'hello world');
});

test('buildWorkerInvocation(claude): includes --output-format when non-text', () => {
    const dir = mkTmpDir('bs-');
    const inv = buildWorkerInvocation('claude', {
        prompt: 'x',
        addDirs: [dir],
        outputFormat: 'stream-json',
    });
    const fmtIdx = inv.args.indexOf('--output-format');
    assert.ok(fmtIdx >= 0);
    assert.equal(inv.args[fmtIdx + 1], 'stream-json');
});

test('buildWorkerInvocation(claude): omits --output-format when text (the default)', () => {
    // Guard against a regression that always emits `--output-format text` — an
    // invalid value for the Claude CLI that would fail every worker spawn.
    const inv = buildWorkerInvocation('claude', {
        prompt: 'x',
        addDirs: [],
        outputFormat: 'text',
    });
    assert.equal(inv.args.includes('--output-format'), false);
});

test('buildWorkerInvocation(claude): drops missing add-dir entries', () => {
    const inv = buildWorkerInvocation('claude', {
        prompt: 'x',
        addDirs: ['/definitely/does/not/exist/abc123'],
    });
    assert.equal(inv.args.includes('--add-dir'), false);
});

// --- buildWorkerInvocation: codex ---

test('buildWorkerInvocation(codex): uses exec with bypass + ephemeral + skip-git', () => {
    const dir = mkTmpDir('bs-');
    const inv = buildWorkerInvocation('codex', {
        prompt: 'hello world',
        addDirs: [dir],
    });
    assert.equal(inv.cmd, 'codex');
    assert.equal(inv.backend, 'codex');
    assert.equal(inv.args[0], 'exec');
    assert.ok(inv.args.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.ok(inv.args.includes('--skip-git-repo-check'));
    assert.ok(inv.args.includes('--ephemeral'));
    assert.ok(inv.args.includes('--add-dir'));
    assert.ok(inv.args.includes(dir));
    // Prompt is the final positional after --
    assert.equal(inv.args[inv.args.length - 1], 'hello world');
    assert.equal(inv.args[inv.args.length - 2], '--');
});

test('buildWorkerInvocation(codex): passes model via -m', () => {
    const inv = buildWorkerInvocation('codex', {
        prompt: 'x',
        addDirs: [],
        model: 'gpt-5.4',
    });
    const mIdx = inv.args.indexOf('-m');
    assert.ok(mIdx >= 0);
    assert.equal(inv.args[mIdx + 1], 'gpt-5.4');
});

test('buildWorkerInvocation(codex): omits -m when no model given', () => {
    // Guards the trap-door: a future default to a tier-shaped name ('sonnet') would silently break every codex worker spawn.
    const inv = buildWorkerInvocation('codex', {
        prompt: 'x',
        addDirs: [],
    });
    assert.equal(inv.args.includes('-m'), false);
});

test('buildWorkerInvocation(codex): drops missing add-dir entries (mirrors claude-worker)', () => {
    // Both backends filter non-existent add-dir paths via existsSilently; the
    // claude test already covers this. Mirror it for codex so a regression that
    // removes the filter on one path but not the other is caught.
    const validDir = mkTmpDir('bs-codex-');
    const inv = buildWorkerInvocation('codex', {
        prompt: 'x',
        addDirs: [validDir, '/definitely/does/not/exist/xyz456', ''],
    });
    const addDirCount = inv.args.filter((a) => a === '--add-dir').length;
    assert.equal(addDirCount, 1);
    assert.ok(inv.args.includes(validDir));
    assert.equal(inv.args.includes('/definitely/does/not/exist/xyz456'), false);
});

// --- buildManagerInvocation ---

test('buildManagerInvocation(claude): includes stream-json + max-turns + no-session-persistence', () => {
    const dir = mkTmpDir('bs-');
    const inv = buildManagerInvocation('claude', {
        prompt: 'manage',
        addDirs: [dir, '/nonexistent/xyz'],
        maxTurns: 42,
        streamJson: true,
        noSessionPersistence: true,
    });
    assert.equal(inv.cmd, 'claude');
    assert.ok(inv.args.includes('--no-session-persistence'));
    assert.ok(inv.args.includes('--output-format'));
    assert.ok(inv.args.includes('stream-json'));
    assert.ok(inv.args.includes('--verbose'));
    const maxTurnsIdx = inv.args.indexOf('--max-turns');
    assert.ok(maxTurnsIdx >= 0);
    assert.equal(inv.args[maxTurnsIdx + 1], '42');
    // Manager builder passes addDirs through verbatim (no fs.existsSync filter)
    // because mux-runner always passes real session-owned directories.
    const addDirCount = inv.args.filter(a => a === '--add-dir').length;
    assert.equal(addDirCount, 2);
});

test('buildManagerInvocation(codex): same shape as worker invocation', () => {
    const dir = mkTmpDir('bs-');
    const inv = buildManagerInvocation('codex', {
        prompt: 'manage',
        addDirs: [dir],
        maxTurns: 10,
        streamJson: true,
        noSessionPersistence: true,
    });
    assert.equal(inv.cmd, 'codex');
    assert.equal(inv.args[0], 'exec');
    // max-turns, stream-json, no-session-persistence have no codex equivalent — dropped
    assert.equal(inv.args.includes('--max-turns'), false);
    assert.equal(inv.args.includes('--output-format'), false);
    assert.equal(inv.args.includes('--no-session-persistence'), false);
    assert.equal(inv.args[inv.args.length - 1], 'manage');
});

test('buildManagerInvocation(codex): omits -m when no model given', () => {
    // Guards the trap-door: a future default to a tier-shaped name ('sonnet') would silently break every codex manager spawn.
    const inv = buildManagerInvocation('codex', {
        prompt: 'manage',
        addDirs: [],
        maxTurns: 10,
        streamJson: true,
        noSessionPersistence: true,
    });
    assert.equal(inv.args.includes('-m'), false);
});

// --- backendEnvOverrides ---

test('backendEnvOverrides: emits PICKLE_BACKEND', () => {
    assert.deepEqual(backendEnvOverrides('codex'), { PICKLE_BACKEND: 'codex' });
    assert.deepEqual(backendEnvOverrides('claude'), { PICKLE_BACKEND: 'claude' });
});

// --- buildWorkerInvocation: --effort threading ---

test('buildWorkerInvocation(codex): emits -c reasoning.effort=high before -- when effort is set', () => {
    const inv = buildWorkerInvocation('codex', {
        prompt: 'do the thing',
        addDirs: [],
        effort: 'high',
    });
    const dashCIdx = inv.args.indexOf('-c');
    assert.ok(dashCIdx >= 0, 'codex invocation should include -c when effort is set');
    assert.equal(inv.args[dashCIdx + 1], 'reasoning.effort=high');
    // Must come BEFORE the `--` prompt separator or codex parses it as prompt
    const sepIdx = inv.args.indexOf('--');
    assert.ok(sepIdx >= 0 && dashCIdx < sepIdx, '-c must precede --');
    // Prompt is still the final positional after --
    assert.equal(inv.args[inv.args.length - 1], 'do the thing');
});

test('buildWorkerInvocation(codex): emits NO effort flag when effort is unset', () => {
    const inv = buildWorkerInvocation('codex', {
        prompt: 'do the thing',
        addDirs: [],
    });
    assert.equal(inv.args.includes('-c'), false, 'codex invocation should NOT include -c when effort is unset');
    assert.ok(!inv.args.some(a => typeof a === 'string' && a.startsWith('reasoning.effort=')));
});

test('buildWorkerInvocation(codex): all three effort levels round-trip', () => {
    for (const level of ['low', 'medium', 'high']) {
        const inv = buildWorkerInvocation('codex', {
            prompt: 'x',
            addDirs: [],
            effort: level,
        });
        const dashCIdx = inv.args.indexOf('-c');
        assert.ok(dashCIdx >= 0);
        assert.equal(inv.args[dashCIdx + 1], `reasoning.effort=${level}`);
    }
});

test('buildWorkerInvocation(claude): does NOT emit any effort/reasoning flag whether effort is set or unset', () => {
    // Claude CLI has no public reasoning-effort flag for `claude -p` — must be a no-op.
    const invSet = buildWorkerInvocation('claude', {
        prompt: 'x',
        addDirs: [],
        effort: 'high',
    });
    assert.equal(invSet.args.includes('-c'), false);
    assert.equal(invSet.args.includes('--reasoning-effort'), false);
    assert.equal(invSet.args.includes('reasoning.effort'), false);
    assert.ok(!invSet.args.some(a => typeof a === 'string' && a.startsWith('reasoning.effort=')));
    // No --append-system-prompt sneak-in either
    assert.equal(invSet.args.includes('--append-system-prompt'), false);

    const invUnset = buildWorkerInvocation('claude', {
        prompt: 'x',
        addDirs: [],
    });
    assert.equal(invUnset.args.includes('-c'), false);
    assert.equal(invUnset.args.includes('--reasoning-effort'), false);
    assert.equal(invUnset.args.includes('--append-system-prompt'), false);
});

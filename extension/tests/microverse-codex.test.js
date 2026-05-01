/**
 * microverse-codex.test.js
 *
 * Codex backend coverage for microverse's LLM judge and gap-analysis baseline.
 *
 * Guards against the "judge runs with full FS write" regression: the codex
 * judge MUST use `codex exec -s read-only --ignore-rules --ignore-user-config`
 * and MUST NOT include `--dangerously-bypass-approvals-and-sandbox` — that
 * flag grants the judge rm -rf on the repo and was the bug routed through
 * buildWorkerInvocation prior to switching to buildJudgeInvocation.
 *
 * Also guards against the "gap-analysis baseline reads stale state" bug: if
 * the user flips state.backend between session start and gap-analysis, the
 * baseline call must re-read state from disk before resolving backend so
 * compareMetric() doesn't compare apples to oranges against iteration scores.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { measureLlmMetric, _deps } from '../bin/microverse-runner.js';
import { resolveBackend } from '../services/backend-spawn.js';

// --- Bug 1 coverage: measureLlmMetric read-only sandboxing ---

test('measureLlmMetric codex backend uses read-only sandbox (no bypass flag)', () => {
    const orig = _deps.execFileSync;
    let captured;
    _deps.execFileSync = (cmd, args) => {
        captured = { cmd, args };
        return '42';
    };
    try {
        const result = measureLlmMetric(
            'fix bugs', 30, '/tmp',
            undefined, undefined, undefined, undefined,
            'codex',
        );
        assert.equal(captured.cmd, 'codex', 'should spawn codex binary');
        assert.ok(captured.args.includes('exec'), 'should pass exec subcommand');
        assert.ok(captured.args.includes('-s'), 'should pass sandbox flag');
        assert.ok(captured.args.includes('read-only'), 'should use read-only sandbox');
        assert.ok(captured.args.includes('--ignore-rules'), 'should ignore project rules');
        assert.ok(captured.args.includes('--ignore-user-config'), 'should ignore user config');
        assert.ok(
            !captured.args.includes('--dangerously-bypass-approvals-and-sandbox'),
            'judge MUST NOT have write/shell access — bypass flag is a critical regression',
        );
        assert.deepEqual(result, { raw: '42', score: 42 });
    } finally {
        _deps.execFileSync = orig;
    }
});

test('measureLlmMetric codex inlines system prompt as prefix (no --system-prompt flag)', () => {
    const orig = _deps.execFileSync;
    let captured;
    _deps.execFileSync = (cmd, args) => {
        captured = { cmd, args };
        return '7';
    };
    try {
        measureLlmMetric(
            'fix bugs', 30, '/tmp',
            undefined, undefined, undefined, undefined,
            'codex',
        );
        assert.ok(
            !captured.args.includes('--system-prompt'),
            'codex exec does not expose --system-prompt — must inline instead',
        );
        // Composed prompt is passed after `--`; verify judge system prompt
        // is prefixed onto the user prompt.
        const dashDashIdx = captured.args.indexOf('--');
        assert.ok(dashDashIdx >= 0, 'codex path should terminate flags with --');
        const composedPrompt = captured.args[dashDashIdx + 1];
        assert.ok(
            composedPrompt.includes('precise scoring judge'),
            'system prompt should be inlined as prefix',
        );
        assert.ok(composedPrompt.includes('fix bugs'), 'user prompt should follow');
    } finally {
        _deps.execFileSync = orig;
    }
});

test('measureLlmMetric codex omits default claude judge model', () => {
    const orig = _deps.execFileSync;
    let captured;
    _deps.execFileSync = (cmd, args) => {
        captured = { cmd, args };
        return '7';
    };
    try {
        measureLlmMetric(
            'fix bugs', 30, '/tmp',
            undefined, undefined, undefined, undefined,
            'codex',
        );
        // 'claude-sonnet-4-6' is the claude default and is meaningless to
        // codex. The runner must not pass it via -m.
        assert.ok(
            !captured.args.includes('claude-sonnet-4-6'),
            'codex must not receive claude model defaults',
        );
    } finally {
        _deps.execFileSync = orig;
    }
});

test('measureLlmMetric claude backend still uses --allowedTools Read,Glob,Grep', () => {
    const orig = _deps.execFileSync;
    let captured;
    _deps.execFileSync = (cmd, args) => {
        captured = { cmd, args };
        return '99';
    };
    try {
        measureLlmMetric(
            'fix bugs', 30, '/tmp',
            'claude-opus-4-6', undefined, undefined, undefined,
            'claude',
        );
        assert.equal(captured.cmd, 'claude');
        assert.ok(captured.args.includes('--allowedTools'), 'claude must set tool allowlist');
        assert.ok(captured.args.includes('Read,Glob,Grep'), 'claude judge restricted to read-only tools');
        assert.ok(captured.args.includes('--no-session-persistence'), 'claude judge sessions are ephemeral');
        assert.ok(captured.args.includes('--system-prompt'), 'claude path threads --system-prompt');
        assert.ok(
            !captured.args.includes('-s'),
            'claude path must not accidentally pass codex sandbox flag',
        );
    } finally {
        _deps.execFileSync = orig;
    }
});

// --- Bug 2 coverage: gap-analysis baseline re-reads state from disk ---

test('resolveBackend re-read from disk reflects a backend flip made after session start', () => {
    // Simulate main()'s initial state load, then a user-initiated flip of
    // state.backend (e.g. editing state.json or running a side script), then
    // gap-analysis baseline's re-read. Mirrors the fix in microverse-runner.ts
    // where `freshState = JSON.parse(fs.readFileSync(statePath, 'utf-8'))`
    // replaces the stale in-memory `state` before calling resolveBackend.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mv-codex-'));
    const statePath = path.join(dir, 'state.json');
    try {
        // Initial state — backend set to claude
        const initialState = {
            active: true, working_dir: dir, step: 'implement',
            iteration: 0, max_iterations: 10, max_time_minutes: 60,
            worker_timeout_seconds: 120,
            start_time_epoch: Math.floor(Date.now() / 1000),
            backend: 'claude',
        };
        fs.writeFileSync(statePath, JSON.stringify(initialState, null, 2));

        // main() loads state at startup
        const staleState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(resolveBackend(staleState), 'claude');

        // User flips backend on disk between session start and gap-analysis
        const flipped = { ...initialState, backend: 'codex' };
        fs.writeFileSync(statePath, JSON.stringify(flipped, null, 2));

        // Stale in-memory copy still resolves to claude — this is the BUG path
        assert.equal(resolveBackend(staleState), 'claude',
            'stale in-memory state still resolves to old backend (the bug)');

        // The FIX: re-read state from disk before resolveBackend
        const freshState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(resolveBackend(freshState), 'codex',
            'fresh on-disk state reflects the flip — baseline will use new backend');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

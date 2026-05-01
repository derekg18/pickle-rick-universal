// Hang-guard test for the backend-spawn consumer path. Same silent-hang class
// as council-publish gh, scope-resolver rg/grep, plumbus-frame-analyzer bun,
// and displayMacNotification osascript — a wedged `codex` (or `claude`) CLI
// would otherwise stall the Morty worker indefinitely with no signal.
//
// spawn-morty.ts guards this with a SIGTERM at effectiveTimeout, SIGKILL 2s
// later, and a force-exit hang-guard at effectiveTimeout + 30s. This test
// puts a hanging `codex` shim on PATH (routed via state.json backend=codex)
// and verifies the end-to-end wall-clock bound fires. Without the escalation,
// the outer spawnSync timeout is the only thing that would eventually release
// the test — an assertion failure is a clearer signal than a test timeout.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
    resolveBackend,
    __resetBackendWarnings,
} from '../services/backend-spawn.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPAWN_MORTY_BIN = path.resolve(__dirname, '../bin/spawn-morty.js');

function mkTmpDir(prefix = 'backend-spawn-hang-') {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// --- Silent-fallback breadcrumb (resolveBackend) ---

test('resolveBackend: warns on bad state.backend value, dedupes by value', () => {
    __resetBackendWarnings();
    /** @type {string[]} */
    const captured = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    // @ts-expect-error — patching in-place for the duration of this test
    process.stderr.write = (chunk) => {
        captured.push(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
        return true;
    };
    try {
        // Valid values don't warn.
        resolveBackend({ backend: 'codex' });
        resolveBackend({ backend: 'claude' });
        assert.equal(captured.length, 0, 'valid backends must not warn');

        // Invalid non-empty string warns once.
        resolveBackend({ backend: 'gemini' });
        assert.equal(captured.length, 1, 'first bad value warns');
        assert.match(captured[0], /unrecognized backend "gemini".*state.*falling back to 'claude'/);

        // Same bad value deduped within the process.
        resolveBackend({ backend: 'gemini' });
        resolveBackend({ backend: 'gemini' });
        assert.equal(captured.length, 1, 'same bad value must not re-warn');

        // A different bad value warns again (independent dedupe key).
        resolveBackend({ backend: 'gpt' });
        assert.equal(captured.length, 2, 'different bad value warns independently');

        // Empty string, null, undefined: no warning (not a typo, just absent).
        resolveBackend({ backend: '' });
        resolveBackend({});
        resolveBackend(null);
        assert.equal(captured.length, 2, 'empty/absent must not warn');
    } finally {
        process.stderr.write = origWrite;
    }
});

test('resolveBackend: warns on bad PICKLE_BACKEND env value', () => {
    __resetBackendWarnings();
    const prev = process.env.PICKLE_BACKEND;
    process.env.PICKLE_BACKEND = 'codx'; // typo
    /** @type {string[]} */
    const captured = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    // @ts-expect-error — patching in-place for the duration of this test
    process.stderr.write = (chunk) => {
        captured.push(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
        return true;
    };
    try {
        const result = resolveBackend({}); // no state, falls through to env
        assert.equal(result, 'claude');
        assert.equal(captured.length, 1);
        assert.match(captured[0], /codx/);
        assert.match(captured[0], /PICKLE_BACKEND env/);
    } finally {
        process.stderr.write = origWrite;
        if (prev === undefined) delete process.env.PICKLE_BACKEND;
        else process.env.PICKLE_BACKEND = prev;
    }
});

// --- Wall-clock hang guard via spawn-morty consumer path ---

// 20s → 60s: budget for system load when run alongside concurrent
// codex/tmux work. The substantive assertions (elapsed >= 3.5s, elapsed < 12s)
// still test the SIGTERM/SIGKILL escalation timing — only the harness budget grew.
test('spawn-morty: hanging codex shim on PATH is bounded by --timeout escalation', { timeout: 60_000 }, () => {
    const tmpDir = mkTmpDir();
    try {
        // Session layout: sessionRoot/state.json + sessionRoot/ticket-001/
        const sessionRoot = tmpDir;
        const ticketDir = path.join(sessionRoot, 'ticket-001');
        fs.mkdirSync(ticketDir, { recursive: true });
        fs.writeFileSync(
            path.join(sessionRoot, 'state.json'),
            JSON.stringify({ backend: 'codex', active: true }),
        );

        // Hanging codex shim — sleeps 60s. If the consumer's SIGTERM/SIGKILL
        // escalation is broken, the parent's outer timeout (20s below) is the
        // only thing that releases this test. We assert a tighter bound so a
        // regression produces a clear assertion failure, not a generic timeout.
        const shimDir = path.join(tmpDir, 'bin');
        fs.mkdirSync(shimDir);
        const shimPath = path.join(shimDir, 'codex');
        fs.writeFileSync(
            shimPath,
            `#!/usr/bin/env node
// Ignore SIGTERM so only SIGKILL (at +2s) frees us. This verifies the
// escalation, not just the initial kill.
process.on('SIGTERM', () => {});
setTimeout(() => process.exit(0), 60_000);
`,
        );
        fs.chmodSync(shimPath, 0o755);

        const start = Date.now();
        const result = spawnSync(
            process.execPath,
            [
                SPAWN_MORTY_BIN,
                'hang-probe',
                '--ticket-id', 'ticket-001',
                '--ticket-path', ticketDir,
                '--timeout', '2',
            ],
            {
                env: {
                    ...process.env,
                    PATH: `${shimDir}:${process.env.PATH || ''}`,
                    // Redirect extension/data roots so spawn-morty doesn't touch the user's
                    // real ~/.claude/pickle-rick while reading pickle_settings.json.
                    EXTENSION_DIR: tmpDir,
                    PICKLE_DATA_DIR: tmpDir,
                },
                encoding: 'utf-8',
                timeout: 30_000,
            },
        );
        const elapsed = Date.now() - start;

        // Budget: 2s --timeout → SIGTERM (ignored by shim) → +2s SIGKILL → finalize.
        // Upper bound 12s = 4s budget + 8s log-flush/close/load slack; widened from
        // the prior 7.5s for system load when run alongside concurrent codex/tmux
        // work, but still tight enough to catch a regression where SIGKILL never
        // fires (the alternative is a 30s outer spawnSync timeout — orders of
        // magnitude looser). Lower bound 3.5s catches the opposite regression:
        // SIGTERM firing immediately without honoring --timeout would complete in <2s.
        assert.ok(
            elapsed >= 3_500,
            `elapsed ${elapsed}ms below 3.5s lower bound — SIGTERM fired before --timeout 2s elapsed`,
        );
        assert.ok(
            elapsed < 12_000,
            `elapsed ${elapsed}ms exceeded 12s bound (status=${result.status} signal=${result.signal}) — SIGTERM/SIGKILL escalation did not fire`,
        );
        assert.notEqual(result.signal, 'SIGTERM', 'outer spawnSync timeout fired — inner escalation broken');
        assert.equal(result.status, 1, 'timed-out worker must exit non-zero');
        const combined = `${result.stdout || ''}${result.stderr || ''}`;
        assert.match(combined, /timed out/i, 'stdout/stderr should mention timeout');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

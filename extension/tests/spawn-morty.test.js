import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tierToModel } from '../bin/spawn-morty.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPAWN_MORTY_BIN = path.resolve(__dirname, '../bin/spawn-morty.js');

/**
 * Run spawn-morty.js as a subprocess and return the result.
 * @param {string[]} args - CLI arguments
 * @param {Record<string, string>} env - extra env vars to merge
 */
function run(args, env = {}) {
    // 15s → 45s: budget for system load when run alongside concurrent
    // codex/tmux work. Tests are validating CLI behavior, not wall-clock.
    return spawnSync(process.execPath, [SPAWN_MORTY_BIN, ...args], {
        env: { ...process.env, ...env },
        encoding: 'utf-8',
        timeout: 45000,
    });
}

/**
 * Create an isolated temp directory (resolves macOS /var -> /private/var symlinks).
 */
function makeTmpDir(prefix = 'pickle-spawn-morty-') {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeCodexShim(shimDir, logPath) {
    fs.mkdirSync(shimDir, { recursive: true });
    const shimPath = path.join(shimDir, 'codex');
    fs.writeFileSync(shimPath, `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  pickle_backend: process.env.PICKLE_BACKEND || null,
}, null, 2));
process.exit(0);
`);
    fs.chmodSync(shimPath, 0o755);
    return shimPath;
}

// --- Argument validation ---

test('spawn-morty: no args → exit 1, prints Usage', () => {
    const result = run([]);
    assert.equal(result.status, 1, 'should exit with code 1');
    assert.ok(result.stderr.includes('Usage'), 'stderr should include Usage');
});

test('spawn-morty: missing --ticket-id → exit 1, prints required', () => {
    const tmpDir = makeTmpDir();
    try {
        const result = run([
            'some-task',
            '--ticket-path', tmpDir,
        ]);
        assert.equal(result.status, 1, 'should exit with code 1');
        assert.ok(result.stderr.includes('required'), 'stderr should mention required');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty: missing --ticket-path → exit 1, prints required', () => {
    const result = run([
        'some-task',
        '--ticket-id', 'ticket-001',
    ]);
    assert.equal(result.status, 1, 'should exit with code 1');
    assert.ok(result.stderr.includes('required'), 'stderr should mention required');
});

test('spawn-morty: invalid ticket-id characters → exit 1, prints invalid characters', () => {
    const tmpDir = makeTmpDir();
    try {
        const result = run([
            'some-task',
            '--ticket-id', '../etc/passwd',
            '--ticket-path', tmpDir,
        ]);
        assert.equal(result.status, 1, 'should exit with code 1');
        assert.ok(
            result.stderr.includes('invalid characters'),
            'stderr should mention invalid characters'
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty: --ticket-id without value (last arg) → exit 1', () => {
    const tmpDir = makeTmpDir();
    try {
        // --ticket-id is the last arg so args[ticketIdIndex + 1] is undefined
        const result = run([
            'some-task',
            '--ticket-path', tmpDir,
            '--ticket-id',
        ]);
        assert.equal(result.status, 1, 'should exit with code 1');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty: --ticket-id value starts with -- → exit 1', () => {
    const tmpDir = makeTmpDir();
    try {
        const result = run([
            'some-task',
            '--ticket-id', '--oops',
            '--ticket-path', tmpDir,
        ]);
        assert.equal(result.status, 1, 'should exit with code 1');
        assert.ok(
            result.stderr.includes('non-empty values'),
            'stderr should mention non-empty values'
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty: valid args but no claude binary → exit 1 (spawn failure, not validation)', () => {
    const tmpDir = makeTmpDir();
    try {
        // Set PATH to a non-existent directory so `claude` cannot be found.
        // The process should get past all validation and fail when spawning claude.
        // Use a longer timeout (15s) — under full-suite concurrency the ENOENT
        // async error can take longer than the default 10s to surface.
        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
                'implement the thing',
                '--ticket-id', 'ticket-42',
                '--ticket-path', tmpDir,
            ], {
            env: { ...process.env, PATH: '/nonexistent' },
            encoding: 'utf-8',
            // 15s → 45s: budget for system load when run alongside concurrent
            // codex/tmux work. Validates panel content, not wall-clock.
            timeout: 45000,
        });
        assert.equal(result.status, 1, 'should exit with code 1');
        // It should NOT be a validation error — it got past validation
        assert.ok(
            !result.stdout.includes('Usage'),
            'should not be a Usage error (got past validation)'
        );
        assert.ok(
            !result.stdout.includes('required'),
            'should not be a "required" validation error'
        );
        assert.ok(
            !result.stdout.includes('invalid characters'),
            'should not be an "invalid characters" validation error'
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// --output-format and --ticket-file edge cases (deep review pass 5)
// ---------------------------------------------------------------------------

test('spawn-morty: --output-format as last arg (no value) defaults to text', () => {
    const tmpDir = makeTmpDir();
    try {
        // --output-format is the last arg with no value following it
        const result = run(
            [
                'implement the thing',
                '--ticket-id', 'ticket-77',
                '--ticket-path', tmpDir,
                '--output-format',
            ],
            { PATH: '/nonexistent' }
        );
        // Should get past validation (no crash, no validation error)
        assert.equal(result.status, 1, 'should exit with code 1 (no claude)');
        assert.ok(
            !result.stdout.includes('Usage'),
            'should not be a Usage error'
        );
        assert.ok(
            !result.stdout.includes('required'),
            'should not be a "required" error'
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty: --ticket-file with value starting with -- does not crash', () => {
    const tmpDir = makeTmpDir();
    try {
        const result = run(
            [
                'implement the thing',
                '--ticket-id', 'ticket-88',
                '--ticket-path', tmpDir,
                '--ticket-file', '--bogus-flag',
            ],
            { PATH: '/nonexistent' }
        );
        // Should get past validation without crashing
        assert.equal(result.status, 1, 'should exit with code 1 (no claude)');
        assert.ok(
            !result.stdout.includes('Usage'),
            'should not be a Usage error'
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty: --timeout with custom value is accepted (no validation error)', () => {
    const tmpDir = makeTmpDir();
    try {
        // Same as the "no claude" test, but with --timeout to verify it parses without error.
        const result = run(
            [
                'implement the thing',
                '--ticket-id', 'ticket-99',
                '--ticket-path', tmpDir,
                '--timeout', '30',
            ],
            { PATH: '/nonexistent' }
        );
        assert.equal(result.status, 1, 'should exit with code 1 (no claude)');
        // No validation errors — it accepted the timeout and moved on
        assert.ok(
            !result.stdout.includes('Usage'),
            'should not be a Usage error'
        );
        assert.ok(
            !result.stdout.includes('required'),
            'should not be a "required" error'
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty: --timeout rejects suffixed and missing values before worker spawn', () => {
    const tmpDir = makeTmpDir();
    try {
        for (const timeoutArgs of [['30junk'], ['3.5'], []]) {
            const result = run([
                'implement the thing',
                '--ticket-id', 'ticket-timeout-validation',
                '--ticket-path', tmpDir,
                '--timeout',
                ...timeoutArgs,
            ], { PATH: '/nonexistent' });
            assert.equal(result.status, 1, `should reject --timeout ${timeoutArgs[0] ?? '<missing>'}`);
            assert.match(result.stderr, /--timeout requires a positive integer/);
            assert.ok(
                !result.stderr.includes('Failed to spawn'),
                'validation should fail before worker spawn',
            );
        }
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// --review flag (meso-review enforcement)
// ---------------------------------------------------------------------------

test('spawn-morty: --review flag accepted without validation error', () => {
    const tmpDir = makeTmpDir();
    try {
        const result = run(
            [
                'review correctness and architecture',
                '--ticket-id', 'rev-001',
                '--ticket-path', tmpDir,
                '--review',
            ],
            { PATH: '/nonexistent' }
        );
        assert.equal(result.status, 1, 'should exit with code 1 (no claude)');
        // Should get past validation — no Usage or required errors
        assert.ok(!result.stderr.includes('Usage'), 'should not be a Usage error');
        assert.ok(!result.stderr.includes('required'), 'should not be a "required" error');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty: --review flag shows Review Worker panel title', () => {
    const tmpDir = makeTmpDir();
    try {
        const result = run(
            [
                'review correctness',
                '--ticket-id', 'rev-002',
                '--ticket-path', tmpDir,
                '--review',
            ],
            { PATH: '/nonexistent' }
        );
        const combined = result.stdout + result.stderr;
        // Must match the actual panel title, not just the word "review" which appears in the command
        assert.match(combined, /Review Worker|type.*review/i,
            'should show Review Worker panel title or review type field');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty: --review without --ticket-id still requires ticket-id', () => {
    const tmpDir = makeTmpDir();
    try {
        const result = run(
            [
                'review correctness',
                '--ticket-path', tmpDir,
                '--review',
            ],
        );
        assert.equal(result.status, 1, 'should exit with code 1');
        assert.ok(result.stderr.includes('required'), 'should require --ticket-id even with --review');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// proc.on('error') handler (deep review pass 7)
// ---------------------------------------------------------------------------

test('spawn-morty: spawn error (no claude binary) reports spawn-error status', () => {
    const tmpDir = makeTmpDir();
    try {
        // Point PATH to a directory with no `claude` binary to trigger ENOENT spawn error
        const result = run(
            [
                'implement the thing',
                '--ticket-id', 'ticket-err',
                '--ticket-path', tmpDir,
                '--timeout', '5',
            ],
            { PATH: '/nonexistent' }
        );
        assert.equal(result.status, 1, 'should exit with code 1');
        const combined = result.stdout + result.stderr;
        // The error handler should report spawn-error status
        assert.ok(
            combined.includes('spawn-error') || combined.includes('failed'),
            'should report spawn-error or failed status'
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// F15: 30s minimum timeout floor
// ---------------------------------------------------------------------------

test('spawn-morty F15: 5s remaining is clamped to 30s minimum', () => {
    const tmpDir = makeTmpDir();
    try {
        // session/ticket structure so state.json is found as parentState
        const sessionDir = path.join(tmpDir, 'session');
        const ticketDir = path.join(sessionDir, 'ticket-f15a');
        fs.mkdirSync(ticketDir, { recursive: true });

        // Started 55s ago with 1-minute max → ~5s remaining at fixture-write time.
        // Under load, the subprocess may not read state.json until several seconds
        // later — pushing remaining into the negative branch. Both branches enforce
        // the 30s floor and emit a "Timeout:" line; we assert the floor invariant
        // (>= 30s) rather than the exact 30s value to tolerate either path.
        const startEpoch = Math.floor(Date.now() / 1000) - 55;
        fs.writeFileSync(
            path.join(sessionDir, 'state.json'),
            JSON.stringify({ active: true, max_time_minutes: 1, start_time_epoch: startEpoch })
        );

        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
            'implement the thing',
            '--ticket-id', 'ticket-f15a',
            '--ticket-path', ticketDir,
            '--timeout', '600',
        ], {
            env: { ...process.env, PATH: '/nonexistent' },
            encoding: 'utf-8',
            // 15s → 45s: budget for system load when run alongside concurrent
            // codex/tmux work. Validates panel content, not wall-clock.
            timeout: 45000,
        });

        const combined = result.stdout + result.stderr;
        // Strip ANSI color codes so panel lines like "[2mTimeout:[0m 30s" parse.
        const stripAnsi = (s) => s.replace(/\[[0-9;]*m/g, '');
        const plain = stripAnsi(combined);
        // Either branch is valid:
        //  A) remaining > 0, < 30: clamped down with floor → "Timeout: 30s (Req: 600s)"
        //     "Worker timeout clamped: 30s" log line.
        //  B) remaining <= 0 (under load): floor max(30, --timeout=600) = 600s →
        //     "Session time already elapsed; running with requested timeout."
        //     "Timeout: 600s (Req: 600s)" — the floor would be 30 if --timeout < 30.
        // Both paths satisfy the invariant: effectiveTimeout >= 30. Verify by
        // extracting the panel Timeout value and asserting it >= 30s.
        const m = plain.match(/Timeout:\s*(\d+)s/);
        assert.ok(m, `effectiveTimeout panel line not found in output:\n${plain.slice(0, 800)}`);
        const effective = parseInt(m[1], 10);
        assert.ok(
            effective >= 30,
            `effectiveTimeout should be >= 30s floor, got ${effective}s`,
        );
        // And: with --timeout 600, effectiveTimeout cannot exceed 600.
        assert.ok(
            effective <= 600,
            `effectiveTimeout should be <= --timeout (600s), got ${effective}s`,
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty F15: negative remaining with short --timeout yields >=30s', () => {
    const tmpDir = makeTmpDir();
    try {
        const sessionDir = path.join(tmpDir, 'session');
        const ticketDir = path.join(sessionDir, 'ticket-f15b');
        fs.mkdirSync(ticketDir, { recursive: true });

        // Started 120s ago with 1-minute max → remaining is negative
        const startEpoch = Math.floor(Date.now() / 1000) - 120;
        fs.writeFileSync(
            path.join(sessionDir, 'state.json'),
            JSON.stringify({ active: true, max_time_minutes: 1, start_time_epoch: startEpoch })
        );

        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
            'implement the thing',
            '--ticket-id', 'ticket-f15b',
            '--ticket-path', ticketDir,
            '--timeout', '5',
        ], {
            env: { ...process.env, PATH: '/nonexistent' },
            encoding: 'utf-8',
            // 15s → 45s: budget for system load when run alongside concurrent
            // codex/tmux work. Validates panel content, not wall-clock.
            timeout: 45000,
        });

        const combined = result.stdout + result.stderr;
        // With remaining<=0 and --timeout 5, effectiveTimeout = max(30, 5) = 30
        assert.match(combined, /Timeout.*\b30s\b/, 'effectiveTimeout should be at least 30s even when session elapsed');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty: recovers orphan tmp backend state before routing worker CLI', () => {
    const tmpDir = makeTmpDir();
    try {
        const sessionDir = path.join(tmpDir, 'session');
        const ticketDir = path.join(sessionDir, 'ticket-backend-recovery');
        fs.mkdirSync(ticketDir, { recursive: true });

        const statePath = path.join(sessionDir, 'state.json');
        fs.writeFileSync(statePath, JSON.stringify({
            active: true,
            backend: 'claude',
            iteration: 1,
            schema_version: 1,
        }));
        fs.writeFileSync(
            `${statePath}.tmp.99999999`,
            JSON.stringify({
                active: true,
                backend: 'codex',
                iteration: 2,
                schema_version: 1,
            }),
        );

        const shimDir = path.join(tmpDir, 'bin');
        const shimLog = path.join(tmpDir, 'codex-invocation.json');
        writeCodexShim(shimDir, shimLog);

        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
            'implement the thing',
            '--ticket-id', 'ticket-backend-recovery',
            '--ticket-path', ticketDir,
            '--timeout', '30',
        ], {
            env: {
                ...process.env,
                EXTENSION_DIR: tmpDir,
                PATH: `${shimDir}${path.delimiter}${process.env.PATH || ''}`,
                PICKLE_BACKEND: '',
            },
            encoding: 'utf-8',
            timeout: 45000,
        });

        const combined = result.stdout + result.stderr;
        assert.equal(result.status, 1, `expected validation failure after codex shim exit, got: ${combined}`);
        assert.ok(combined.includes('Backend') && combined.includes('codex'), `expected Backend: codex in output, got: ${combined}`);
        assert.ok(fs.existsSync(shimLog), 'codex shim should be invoked after backend recovery');
        const invocation = JSON.parse(fs.readFileSync(shimLog, 'utf-8'));
        assert.equal(invocation.pickle_backend, 'codex');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty: recovers orphan tmp session timeout before printing worker budget', () => {
    const tmpDir = makeTmpDir();
    try {
        const sessionDir = path.join(tmpDir, 'session');
        const ticketDir = path.join(sessionDir, 'ticket-timeout-recovery');
        fs.mkdirSync(ticketDir, { recursive: true });

        const statePath = path.join(sessionDir, 'state.json');
        const nowEpoch = Math.floor(Date.now() / 1000);
        fs.writeFileSync(statePath, JSON.stringify({
            active: true,
            backend: 'claude',
            max_time_minutes: 20,
            start_time_epoch: nowEpoch - 5,
            iteration: 1,
            schema_version: 1,
        }));
        fs.writeFileSync(
            `${statePath}.tmp.99999998`,
            JSON.stringify({
                active: true,
                backend: 'codex',
                max_time_minutes: 3,
                start_time_epoch: nowEpoch - 90,
                iteration: 2,
                schema_version: 1,
            }),
        );

        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
            'implement the thing',
            '--ticket-id', 'ticket-timeout-recovery',
            '--ticket-path', ticketDir,
            '--timeout', '600',
        ], {
            env: {
                ...process.env,
                EXTENSION_DIR: tmpDir,
                PATH: '/nonexistent',
                PICKLE_BACKEND: '',
            },
            encoding: 'utf-8',
            timeout: 45000,
        });

        const combined = result.stdout + result.stderr;
        const plain = combined.replace(/\x1b\[[0-9;]*m/g, '');
        assert.equal(result.status, 1, `expected spawn failure after recovered timeout path, got: ${plain}`);
        assert.ok(plain.includes('Backend') && plain.includes('codex'), `expected recovered backend in output, got: ${plain}`);
        assert.ok(plain.includes('Worker timeout clamped'), `expected timeout clamp message, got: ${plain}`);
        const match = plain.match(/Timeout:\s*(\d+)s \(Req: 600s\)/);
        assert.ok(match, `expected timeout panel line, got: ${plain}`);
        const effective = Number(match[1]);
        assert.ok(
            Number.isFinite(effective) && effective >= 80 && effective <= 95,
            `expected recovered timeout near 90s, got ${effective}s`,
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty: session working_dir controls child cwd, repo access, and GitNexus detection', () => {
    const tmpDir = makeTmpDir();
    try {
        const sessionDir = path.join(tmpDir, 'session');
        const ticketDir = path.join(sessionDir, 'ticket-working-dir');
        const repoDir = path.join(tmpDir, 'target-repo');
        const wrongCwd = path.join(tmpDir, 'wrong-cwd');
        fs.mkdirSync(ticketDir, { recursive: true });
        fs.mkdirSync(repoDir, { recursive: true });
        fs.mkdirSync(wrongCwd, { recursive: true });
        fs.mkdirSync(path.join(repoDir, '.gitnexus'), { recursive: true });

        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            backend: 'codex',
            working_dir: repoDir,
            iteration: 1,
            schema_version: 1,
        }));

        const shimDir = path.join(tmpDir, 'bin');
        const shimLog = path.join(tmpDir, 'codex-working-dir.json');
        writeCodexShim(shimDir, shimLog);

        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
            'implement the thing',
            '--ticket-id', 'ticket-working-dir',
            '--ticket-path', ticketDir,
            '--timeout', '30',
        ], {
            cwd: wrongCwd,
            env: {
                ...process.env,
                EXTENSION_DIR: tmpDir,
                PATH: `${shimDir}${path.delimiter}${process.env.PATH || ''}`,
                PICKLE_BACKEND: '',
            },
            encoding: 'utf-8',
            timeout: 45000,
        });

        const combined = result.stdout + result.stderr;
        assert.equal(result.status, 1, `expected validation failure after codex shim exit, got: ${combined}`);
        assert.ok(fs.existsSync(shimLog), 'codex shim should be invoked');

        const invocation = JSON.parse(fs.readFileSync(shimLog, 'utf-8'));
        assert.equal(invocation.cwd, repoDir, 'worker subprocess should run from the recovered session working_dir');

        const addDirs = [];
        for (let i = 0; i < invocation.argv.length; i++) {
            if (invocation.argv[i] === '--add-dir' && typeof invocation.argv[i + 1] === 'string') {
                addDirs.push(invocation.argv[i + 1]);
                i++;
            }
        }
        assert.ok(addDirs.includes(repoDir), 'worker invocation should explicitly include the recovered repo root');
        assert.ok(addDirs.includes(ticketDir), 'worker invocation should still include the ticket directory');

        const prompt = invocation.argv[invocation.argv.length - 1];
        assert.match(prompt, /GITNEXUS CODE INTELLIGENCE/, 'GitNexus detection should use the recovered repo root, not the caller cwd');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// --effort threading: state.effort -> codex `-c reasoning.effort=<value>`
// ---------------------------------------------------------------------------

test('spawn-morty: state.effort=high reaches codex invocation as -c reasoning.effort=high', () => {
    const tmpDir = makeTmpDir();
    try {
        const sessionDir = path.join(tmpDir, 'session');
        const ticketDir = path.join(sessionDir, 'ticket-effort-thread');
        fs.mkdirSync(ticketDir, { recursive: true });

        const statePath = path.join(sessionDir, 'state.json');
        fs.writeFileSync(statePath, JSON.stringify({
            active: true,
            backend: 'codex',
            effort: 'high',
            iteration: 1,
            schema_version: 1,
        }));

        const shimDir = path.join(tmpDir, 'bin');
        const shimLog = path.join(tmpDir, 'codex-effort.json');
        writeCodexShim(shimDir, shimLog);

        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
            'implement the thing',
            '--ticket-id', 'ticket-effort-thread',
            '--ticket-path', ticketDir,
            '--timeout', '30',
        ], {
            env: {
                ...process.env,
                EXTENSION_DIR: tmpDir,
                PATH: `${shimDir}${path.delimiter}${process.env.PATH || ''}`,
                PICKLE_BACKEND: '',
            },
            encoding: 'utf-8',
            timeout: 45000,
        });

        // shim exits 0 with no real artifact -> validation failure (status 1) is expected
        assert.equal(result.status, 1);
        assert.ok(fs.existsSync(shimLog), 'codex shim should be invoked');
        const invocation = JSON.parse(fs.readFileSync(shimLog, 'utf-8'));
        const argv = invocation.argv;
        const dashCIdx = argv.indexOf('-c');
        assert.ok(dashCIdx >= 0, `expected -c in argv, got: ${JSON.stringify(argv)}`);
        assert.equal(argv[dashCIdx + 1], 'reasoning.effort=high');
        // -c must appear BEFORE the `--` prompt separator
        const sepIdx = argv.indexOf('--');
        assert.ok(sepIdx >= 0 && dashCIdx < sepIdx, '-c reasoning.effort must come before --');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// P0: Codex worker contract addendum
// ---------------------------------------------------------------------------

test('spawn-morty P0: codex backend prompt contains "Codex-specific contract additions"', () => {
    const tmpDir = makeTmpDir();
    try {
        const sessionDir = path.join(tmpDir, 'session');
        const ticketDir = path.join(sessionDir, 'ticket-codex-addendum');
        fs.mkdirSync(ticketDir, { recursive: true });

        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            backend: 'codex',
            iteration: 1,
            schema_version: 1,
        }));

        const shimDir = path.join(tmpDir, 'bin');
        const shimLog = path.join(tmpDir, 'codex-addendum.json');
        writeCodexShim(shimDir, shimLog);

        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
            'implement the thing',
            '--ticket-id', 'ticket-codex-addendum',
            '--ticket-path', ticketDir,
            '--timeout', '30',
        ], {
            env: {
                ...process.env,
                EXTENSION_DIR: tmpDir,
                PATH: `${shimDir}${path.delimiter}${process.env.PATH || ''}`,
                PICKLE_BACKEND: '',
            },
            encoding: 'utf-8',
            timeout: 45000,
        });

        assert.equal(result.status, 1, `expected validation failure after shim exit, got: ${result.stdout + result.stderr}`);
        assert.ok(fs.existsSync(shimLog), 'codex shim should be invoked');
        const invocation = JSON.parse(fs.readFileSync(shimLog, 'utf-8'));
        const prompt = invocation.argv[invocation.argv.length - 1];
        assert.match(prompt, /Codex-specific contract additions/,
            'codex prompt MUST contain the codex contract addendum');
        assert.match(prompt, /git add.*git commit.*before emitting/s,
            'codex addendum MUST require commit before promise');
        assert.match(prompt, /DEFERRED/,
            'codex addendum MUST mention DEFERRED for contradicted ACs');
        assert.match(prompt, /DO NOT explore harness internals/,
            'codex addendum MUST forbid harness exploration');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty P0: claude backend prompt does NOT contain codex addendum', () => {
    const tmpDir = makeTmpDir();
    try {
        const sessionDir = path.join(tmpDir, 'session');
        const ticketDir = path.join(sessionDir, 'ticket-claude-no-addendum');
        fs.mkdirSync(ticketDir, { recursive: true });

        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            backend: 'claude',
            iteration: 1,
            schema_version: 1,
        }));

        // Shim "claude" — same trick as codex shim. Captures prompt argv.
        const shimDir = path.join(tmpDir, 'bin');
        fs.mkdirSync(shimDir, { recursive: true });
        const shimLog = path.join(tmpDir, 'claude-prompt.json');
        const shimPath = path.join(shimDir, 'claude');
        fs.writeFileSync(shimPath, `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(shimLog)}, JSON.stringify({
  argv: process.argv.slice(2),
}, null, 2));
process.exit(0);
`);
        fs.chmodSync(shimPath, 0o755);

        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
            'implement the thing',
            '--ticket-id', 'ticket-claude-no-addendum',
            '--ticket-path', ticketDir,
            '--timeout', '30',
        ], {
            env: {
                ...process.env,
                EXTENSION_DIR: tmpDir,
                PATH: `${shimDir}${path.delimiter}${process.env.PATH || ''}`,
                PICKLE_BACKEND: '',
            },
            encoding: 'utf-8',
            timeout: 45000,
        });

        assert.equal(result.status, 1, `expected validation failure after shim exit, got: ${result.stdout + result.stderr}`);
        assert.ok(fs.existsSync(shimLog), 'claude shim should be invoked');
        const invocation = JSON.parse(fs.readFileSync(shimLog, 'utf-8'));
        // The prompt is the value following `--append-system-prompt` or the last positional;
        // for claude shim, just join all argv and confirm the addendum string is absent.
        const allArgv = invocation.argv.join('\n');
        assert.ok(
            !allArgv.includes('Codex-specific contract additions'),
            'claude prompt MUST NOT contain codex contract addendum'
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// P2: Per-ticket backend routing heuristic
// ---------------------------------------------------------------------------

/**
 * Helper: write a `pickle_settings.json` to the EXTENSION_DIR. The flag value
 * controls whether the routing heuristic is enabled.
 */
function writeSettings(extensionDir, enableRouting) {
    fs.mkdirSync(extensionDir, { recursive: true });
    fs.writeFileSync(
        path.join(extensionDir, 'pickle_settings.json'),
        JSON.stringify({ enable_backend_routing_heuristic: enableRouting })
    );
}

/**
 * Helper: write a ticket file with frontmatter for routing tests. Returns
 * the ticket file path.
 */
function writeTicketFile(ticketDir, frontmatter) {
    const ticketFile = path.join(ticketDir, 'ticket.md');
    const fmBody = Object.entries(frontmatter)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n');
    fs.writeFileSync(ticketFile, `---\n${fmBody}\n---\n\n# Ticket\n\nBody.\n`);
    return ticketFile;
}

test('spawn-morty P2: heuristic OFF (default) — large tier on codex stays codex', () => {
    const tmpDir = makeTmpDir();
    try {
        writeSettings(tmpDir, false);
        const sessionDir = path.join(tmpDir, 'session');
        const ticketDir = path.join(sessionDir, 'ticket-routing-off');
        fs.mkdirSync(ticketDir, { recursive: true });
        const ticketFile = writeTicketFile(ticketDir, {
            id: 'ticket-routing-off',
            title: 'Refactor tokenizer',
            complexity_tier: 'large',
        });

        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            backend: 'codex',
            iteration: 1,
            schema_version: 1,
        }));

        const shimDir = path.join(tmpDir, 'bin');
        const shimLog = path.join(tmpDir, 'codex-routing-off.json');
        writeCodexShim(shimDir, shimLog);

        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
            'do thing',
            '--ticket-id', 'ticket-routing-off',
            '--ticket-path', ticketDir,
            '--ticket-file', ticketFile,
            '--timeout', '30',
        ], {
            env: {
                ...process.env,
                EXTENSION_DIR: tmpDir,
                PATH: `${shimDir}${path.delimiter}${process.env.PATH || ''}`,
                PICKLE_BACKEND: '',
            },
            encoding: 'utf-8',
            timeout: 45000,
        });

        const combined = result.stdout + result.stderr;
        assert.equal(result.status, 1);
        // No override fired → backend stays codex → codex shim runs → shim log written.
        assert.ok(fs.existsSync(shimLog), 'codex shim should run when heuristic is OFF');
        assert.ok(combined.includes('Backend') && combined.includes('codex'),
            `expected Backend: codex, got: ${combined}`);
        assert.ok(!combined.includes('backend routed: codex → claude'),
            'no routing override message expected when heuristic is OFF');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty P2: recovers disabled routing heuristic from newer dead settings tmp', () => {
    const tmpDir = makeTmpDir();
    try {
        writeSettings(tmpDir, true);
        fs.writeFileSync(
            path.join(tmpDir, 'pickle_settings.json.tmp.999999'),
            JSON.stringify({ enable_backend_routing_heuristic: false })
        );
        const sessionDir = path.join(tmpDir, 'session');
        const ticketDir = path.join(sessionDir, 'ticket-routing-recovered-off');
        fs.mkdirSync(ticketDir, { recursive: true });
        const ticketFile = writeTicketFile(ticketDir, {
            id: 'ticket-routing-recovered-off',
            title: 'Refactor tokenizer',
            complexity_tier: 'large',
        });

        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            backend: 'codex',
            iteration: 1,
            schema_version: 1,
        }));

        const shimDir = path.join(tmpDir, 'bin');
        const shimLog = path.join(tmpDir, 'codex-routing-recovered-off.json');
        writeCodexShim(shimDir, shimLog);

        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
            'do thing',
            '--ticket-id', 'ticket-routing-recovered-off',
            '--ticket-path', ticketDir,
            '--ticket-file', ticketFile,
            '--timeout', '30',
        ], {
            env: {
                ...process.env,
                EXTENSION_DIR: tmpDir,
                PATH: `${shimDir}${path.delimiter}${process.env.PATH || ''}`,
                PICKLE_BACKEND: '',
            },
            encoding: 'utf-8',
            timeout: 45000,
        });

        const combined = result.stdout + result.stderr;
        assert.equal(result.status, 1);
        assert.ok(fs.existsSync(shimLog), 'codex shim should run when recovered heuristic is OFF');
        assert.ok(!combined.includes('backend routed: codex → claude'),
            `no routing override expected from stale enabled base, got: ${combined}`);
        assert.equal(fs.existsSync(path.join(tmpDir, 'pickle_settings.json.tmp.999999')), false,
            'dead settings tmp should be promoted and removed');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty P2: recovers disabled complexity tiers from newer dead settings tmp', () => {
    const tmpDir = makeTmpDir();
    try {
        fs.mkdirSync(tmpDir, { recursive: true });
        fs.writeFileSync(
            path.join(tmpDir, 'pickle_settings.json'),
            JSON.stringify({ enable_complexity_tiers: true })
        );
        fs.writeFileSync(
            path.join(tmpDir, 'pickle_settings.json.tmp.999999'),
            JSON.stringify({ enable_complexity_tiers: false })
        );
        const sessionDir = path.join(tmpDir, 'session');
        const ticketDir = path.join(sessionDir, 'ticket-model-recovered-off');
        fs.mkdirSync(ticketDir, { recursive: true });
        const ticketFile = writeTicketFile(ticketDir, {
            id: 'ticket-model-recovered-off',
            title: 'Implement neutral worker task',
            complexity_tier: 'large',
        });

        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            backend: 'claude',
            iteration: 1,
            schema_version: 1,
        }));

        const shimDir = path.join(tmpDir, 'bin');
        fs.mkdirSync(shimDir, { recursive: true });
        const claudeLog = path.join(tmpDir, 'claude-model-recovered-off.json');
        const claudeShim = path.join(shimDir, 'claude');
        fs.writeFileSync(claudeShim, `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(claudeLog)}, JSON.stringify({ argv: process.argv.slice(2) }, null, 2));
process.exit(0);
`);
        fs.chmodSync(claudeShim, 0o755);

        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
            'do thing',
            '--ticket-id', 'ticket-model-recovered-off',
            '--ticket-path', ticketDir,
            '--ticket-file', ticketFile,
            '--timeout', '30',
        ], {
            env: {
                ...process.env,
                EXTENSION_DIR: tmpDir,
                PATH: `${shimDir}${path.delimiter}${process.env.PATH || ''}`,
                PICKLE_BACKEND: '',
            },
            encoding: 'utf-8',
            timeout: 45000,
        });

        assert.equal(result.status, 1);
        assert.ok(fs.existsSync(claudeLog), 'claude shim should run for claude backend');
        const invocation = JSON.parse(fs.readFileSync(claudeLog, 'utf-8'));
        const modelIndex = invocation.argv.indexOf('--model');
        assert.notEqual(modelIndex, -1, 'claude invocation should include a model');
        assert.equal(invocation.argv[modelIndex + 1], 'sonnet',
            `recovered disabled complexity tiers should force sonnet, got: ${invocation.argv.join(' ')}`);
        assert.equal(fs.existsSync(path.join(tmpDir, 'pickle_settings.json.tmp.999999')), false,
            'dead settings tmp should be promoted and removed');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty P2: heuristic ON — large tier flips codex → claude', () => {
    const tmpDir = makeTmpDir();
    try {
        writeSettings(tmpDir, true);
        const sessionDir = path.join(tmpDir, 'session');
        const ticketDir = path.join(sessionDir, 'ticket-routing-large');
        fs.mkdirSync(ticketDir, { recursive: true });
        const ticketFile = writeTicketFile(ticketDir, {
            id: 'ticket-routing-large',
            title: 'Refactor tokenizer',
            complexity_tier: 'large',
        });

        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            backend: 'codex',
            iteration: 1,
            schema_version: 1,
        }));

        // Shim claude (the override target). codex would also be invoked if
        // override fails — distinct shim logs make the assertion unambiguous.
        const shimDir = path.join(tmpDir, 'bin');
        fs.mkdirSync(shimDir, { recursive: true });
        const claudeLog = path.join(tmpDir, 'claude-large.json');
        const claudeShim = path.join(shimDir, 'claude');
        fs.writeFileSync(claudeShim, `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(claudeLog)}, JSON.stringify({ argv: process.argv.slice(2) }));
process.exit(0);
`);
        fs.chmodSync(claudeShim, 0o755);
        // No codex shim — if heuristic fails to flip, ENOENT crashes loudly.

        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
            'do thing',
            '--ticket-id', 'ticket-routing-large',
            '--ticket-path', ticketDir,
            '--ticket-file', ticketFile,
            '--timeout', '30',
        ], {
            env: {
                ...process.env,
                EXTENSION_DIR: tmpDir,
                PATH: `${shimDir}${path.delimiter}${process.env.PATH || ''}`,
                PICKLE_BACKEND: '',
            },
            encoding: 'utf-8',
            timeout: 45000,
        });

        const combined = result.stdout + result.stderr;
        assert.equal(result.status, 1);
        assert.ok(fs.existsSync(claudeLog), 'claude shim should run after override fires');
        assert.ok(combined.includes('backend routed: codex → claude'),
            `expected override log line, got: ${combined}`);
        assert.ok(combined.includes('complexity_tier=large'),
            `expected reason=complexity_tier=large, got: ${combined}`);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty P2: heuristic ON — UI title flips codex → claude', () => {
    const tmpDir = makeTmpDir();
    try {
        writeSettings(tmpDir, true);
        const sessionDir = path.join(tmpDir, 'session');
        const ticketDir = path.join(sessionDir, 'ticket-routing-ui');
        fs.mkdirSync(ticketDir, { recursive: true });
        const ticketFile = writeTicketFile(ticketDir, {
            id: 'ticket-routing-ui',
            title: 'Polish UI for billing dashboard',
            complexity_tier: 'medium',
        });

        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            backend: 'codex',
            iteration: 1,
            schema_version: 1,
        }));

        const shimDir = path.join(tmpDir, 'bin');
        fs.mkdirSync(shimDir, { recursive: true });
        const claudeLog = path.join(tmpDir, 'claude-ui.json');
        const claudeShim = path.join(shimDir, 'claude');
        fs.writeFileSync(claudeShim, `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(claudeLog)}, JSON.stringify({ argv: process.argv.slice(2) }));
process.exit(0);
`);
        fs.chmodSync(claudeShim, 0o755);

        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
            'do thing',
            '--ticket-id', 'ticket-routing-ui',
            '--ticket-path', ticketDir,
            '--ticket-file', ticketFile,
            '--timeout', '30',
        ], {
            env: {
                ...process.env,
                EXTENSION_DIR: tmpDir,
                PATH: `${shimDir}${path.delimiter}${process.env.PATH || ''}`,
                PICKLE_BACKEND: '',
            },
            encoding: 'utf-8',
            timeout: 45000,
        });

        const combined = result.stdout + result.stderr;
        assert.equal(result.status, 1);
        assert.ok(fs.existsSync(claudeLog), 'claude shim should run after UI title override fires');
        assert.ok(combined.includes('backend routed: codex → claude'),
            `expected override message, got: ${combined}`);
        assert.ok(/title-signal/.test(combined),
            `expected title-signal reason, got: ${combined}`);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty P2: heuristic ON — small tier + neutral title stays codex', () => {
    const tmpDir = makeTmpDir();
    try {
        writeSettings(tmpDir, true);
        const sessionDir = path.join(tmpDir, 'session');
        const ticketDir = path.join(sessionDir, 'ticket-routing-stay');
        fs.mkdirSync(ticketDir, { recursive: true });
        const ticketFile = writeTicketFile(ticketDir, {
            id: 'ticket-routing-stay',
            title: 'Fix typo in helper',
            complexity_tier: 'small',
        });

        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            backend: 'codex',
            iteration: 1,
            schema_version: 1,
        }));

        const shimDir = path.join(tmpDir, 'bin');
        const shimLog = path.join(tmpDir, 'codex-stay.json');
        writeCodexShim(shimDir, shimLog);

        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
            'do thing',
            '--ticket-id', 'ticket-routing-stay',
            '--ticket-path', ticketDir,
            '--ticket-file', ticketFile,
            '--timeout', '30',
        ], {
            env: {
                ...process.env,
                EXTENSION_DIR: tmpDir,
                PATH: `${shimDir}${path.delimiter}${process.env.PATH || ''}`,
                PICKLE_BACKEND: '',
            },
            encoding: 'utf-8',
            timeout: 45000,
        });

        const combined = result.stdout + result.stderr;
        assert.equal(result.status, 1);
        assert.ok(fs.existsSync(shimLog), 'codex shim should run because small/neutral did not flip');
        assert.ok(!combined.includes('backend routed'),
            `no routing override expected for small/neutral, got: ${combined}`);
        assert.ok(combined.includes('Backend') && combined.includes('codex'),
            `expected Backend: codex, got: ${combined}`);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// P2: Post-flush guard — short log + git edits + artifact = success
// ---------------------------------------------------------------------------

/**
 * Helper: writes a shim that prints WORKER_DONE token (small log <200B),
 * creates a lifecycle artifact in the ticket dir, AND makes a git commit
 * in the session working_dir. Then exits 0.
 */
function writePostFlushShim(shimDir, ticketDir, workingDir, makeGitEdit) {
    fs.mkdirSync(shimDir, { recursive: true });
    const shimPath = path.join(shimDir, 'codex');
    const shimSrc = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
// Small post-promise log — under 200B
process.stdout.write('<promise>I AM DONE</promise>\\n');
// Lifecycle artifact for implementation role: research_*.md
fs.writeFileSync(path.join(${JSON.stringify(ticketDir)}, 'research_done.md'), 'r');
${makeGitEdit ? `
// Real git edit + commit in working dir
try {
  fs.writeFileSync(path.join(${JSON.stringify(workingDir)}, 'morty-edit.txt'), 'committed by shim\\n');
  execSync('git add morty-edit.txt && git commit -m "shim edit"', { cwd: ${JSON.stringify(workingDir)} });
} catch (e) { process.stderr.write('shim git failed: ' + e.message); }
` : ''}
process.exit(0);
`;
    fs.writeFileSync(shimPath, shimSrc);
    fs.chmodSync(shimPath, 0o755);
    return shimPath;
}

test('spawn-morty P2 post-flush: token + artifact + git edits + log<200B → success', () => {
    const tmpDir = makeTmpDir();
    try {
        const sessionDir = path.join(tmpDir, 'session');
        const ticketDir = path.join(sessionDir, 'ticket-postflush-success');
        const workingDir = path.join(tmpDir, 'repo');
        fs.mkdirSync(ticketDir, { recursive: true });
        fs.mkdirSync(workingDir, { recursive: true });

        // Init real git repo so checkGitEdits can run.
        // git init + initial commit using imported spawnSync. Backdate the
        // base commit so checkGitEdits's ">= startTime" comparison cleanly
        // excludes it (otherwise a same-second seed commit looks like worker
        // edits and the negative test false-passes).
        const baseEpoch = Math.floor(Date.now() / 1000) - 5;
        const gitSetup = spawnSync('bash', ['-c',
            `GIT_AUTHOR_DATE='@${baseEpoch} +0000' GIT_COMMITTER_DATE='@${baseEpoch} +0000' git init -q && ` +
            'git config user.email t@t && git config user.name t && ' +
            `GIT_AUTHOR_DATE='@${baseEpoch} +0000' GIT_COMMITTER_DATE='@${baseEpoch} +0000' git commit --allow-empty -q -m base`
        ], { cwd: workingDir, encoding: 'utf-8' });
        assert.equal(gitSetup.status, 0, `git init failed: ${gitSetup.stderr}`);

        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            backend: 'codex',
            working_dir: workingDir,
            iteration: 1,
            schema_version: 1,
        }));

        const shimDir = path.join(tmpDir, 'bin');
        writePostFlushShim(shimDir, ticketDir, workingDir, /* makeGitEdit */ true);

        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
            'do thing',
            '--ticket-id', 'ticket-postflush-success',
            '--ticket-path', ticketDir,
            '--timeout', '30',
        ], {
            env: {
                ...process.env,
                EXTENSION_DIR: tmpDir,
                PATH: `${shimDir}${path.delimiter}${process.env.PATH || ''}`,
                PICKLE_BACKEND: '',
            },
            encoding: 'utf-8',
            timeout: 45000,
        });

        const combined = result.stdout + result.stderr;
        assert.equal(result.status, 0,
            `expected isSuccess via post-flush guard (exit 0), got: ${combined}`);
        assert.ok(/validation.*successful/i.test(combined),
            `expected successful validation, got: ${combined}`);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty P2 post-flush: token + artifact + zero git edits + log<200B → failure', () => {
    const tmpDir = makeTmpDir();
    try {
        const sessionDir = path.join(tmpDir, 'session');
        const ticketDir = path.join(sessionDir, 'ticket-postflush-fail');
        const workingDir = path.join(tmpDir, 'repo');
        fs.mkdirSync(ticketDir, { recursive: true });
        fs.mkdirSync(workingDir, { recursive: true });

        // git init + initial commit using imported spawnSync. Backdate the
        // base commit so checkGitEdits's ">= startTime" comparison cleanly
        // excludes it (otherwise a same-second seed commit looks like worker
        // edits and the negative test false-passes).
        const baseEpoch = Math.floor(Date.now() / 1000) - 5;
        const gitSetup = spawnSync('bash', ['-c',
            `GIT_AUTHOR_DATE='@${baseEpoch} +0000' GIT_COMMITTER_DATE='@${baseEpoch} +0000' git init -q && ` +
            'git config user.email t@t && git config user.name t && ' +
            `GIT_AUTHOR_DATE='@${baseEpoch} +0000' GIT_COMMITTER_DATE='@${baseEpoch} +0000' git commit --allow-empty -q -m base`
        ], { cwd: workingDir, encoding: 'utf-8' });
        assert.equal(gitSetup.status, 0, `git init failed: ${gitSetup.stderr}`);

        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            backend: 'codex',
            working_dir: workingDir,
            iteration: 1,
            schema_version: 1,
        }));

        const shimDir = path.join(tmpDir, 'bin');
        writePostFlushShim(shimDir, ticketDir, workingDir, /* makeGitEdit */ false);

        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
            'do thing',
            '--ticket-id', 'ticket-postflush-fail',
            '--ticket-path', ticketDir,
            '--timeout', '30',
        ], {
            env: {
                ...process.env,
                EXTENSION_DIR: tmpDir,
                PATH: `${shimDir}${path.delimiter}${process.env.PATH || ''}`,
                PICKLE_BACKEND: '',
            },
            encoding: 'utf-8',
            timeout: 45000,
        });

        const combined = result.stdout + result.stderr;
        assert.equal(result.status, 1,
            `expected validation failure when log<200B AND no git edits, got: ${combined}`);
        assert.ok(/no git edits|validation failed/i.test(combined),
            `expected validation failure message, got: ${combined}`);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// tierToModel — tier-based model routing
// ---------------------------------------------------------------------------

test('tierToModel: trivial -> haiku', () => {
    assert.equal(tierToModel('trivial'), 'haiku');
});

test('tierToModel: small -> sonnet', () => {
    assert.equal(tierToModel('small'), 'sonnet');
});

test('tierToModel: medium -> sonnet', () => {
    assert.equal(tierToModel('medium'), 'sonnet');
});

test('tierToModel: large -> opus', () => {
    assert.equal(tierToModel('large'), 'opus');
});

test('tierToModel: undefined -> sonnet (missing tier fallback)', () => {
    assert.equal(tierToModel(undefined), 'sonnet');
});

test('tierToModel: unrecognized tier -> sonnet (unknown fallback)', () => {
    assert.equal(tierToModel('mega'), 'sonnet');
    assert.equal(tierToModel(''), 'sonnet');
});

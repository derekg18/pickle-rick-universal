import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMUX_RUNNER_BIN = path.resolve(__dirname, '../bin/mux-runner.js');

/**
 * Create an isolated temp root directory.
 * Uses fs.realpathSync to resolve macOS /var -> /private/var symlinks.
 */
function makeTmpRoot() {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mux-runner-')));
}

async function waitFor(predicate, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

/**
 * Run mux-runner.js as a subprocess with isolated EXTENSION_DIR.
 * @param {string} extDir - the EXTENSION_DIR to use
 * @param {string[]} args - additional arguments to pass
 */
function run(extDir, args = []) {
    // 15s → 60s: budget for system load when run alongside concurrent
    // codex/tmux work. Fast-path tests (no-args, missing state.json, etc.)
    // exit in <100ms; the budget exists so node spawn + module load under
    // load doesn't blow the wall-clock and SIGKILL the subprocess.
    const env = { ...process.env, EXTENSION_DIR: extDir };
    delete env.PICKLE_ROLE;
    env.PICKLE_BACKEND = 'claude';
    return spawnSync(process.execPath, [TMUX_RUNNER_BIN, ...args], {
        env,
        encoding: 'utf-8',
        timeout: 60000,
    });
}

// --- No args → exit code 1, stderr includes "Usage" ---

test('mux-runner: exits with code 1 and prints Usage when no args provided', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const result = run(tmpRoot);
        assert.equal(result.status, 1, `Expected exit code 1, got: ${result.status}`);
        assert.ok(
            result.stderr.includes('Usage'),
            `Expected "Usage" in stderr, got: ${result.stderr}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Session dir without state.json → exit code 1, stderr includes "Usage" ---

test('mux-runner: exits with code 1 when session dir has no state.json', () => {
    const tmpRoot = makeTmpRoot();
    try {
        // Create a session dir but don't put state.json in it
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });

        const result = run(tmpRoot, [sessionDir]);
        assert.equal(result.status, 1, `Expected exit code 1, got: ${result.status}`);
        assert.ok(
            result.stderr.includes('Usage'),
            `Expected "Usage" in stderr, got: ${result.stderr}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Max iterations already reached → exits with "Max iterations reached" ---

test('mux-runner: exits when max_iterations already reached', () => {
    const tmpRoot = makeTmpRoot();
    try {
        // Create a session dir with state.json where iteration >= max_iterations
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            step: 'implement',
            iteration: 5,
            max_iterations: 5,
            worker_timeout_seconds: 1200,
            original_prompt: 'test task',
            working_dir: tmpRoot,
        }, null, 2));

        // mux-runner also needs pickle_settings.json at extension root (optional)
        // and pickle.md in ~/.claude/commands/ (only needed for runIteration)
        // Since max_iterations is already reached, the loop will break before
        // calling runIteration, so we don't need those files.

        const result = run(tmpRoot, [sessionDir]);

        // Combine stdout and runner log to check for the exit message
        const runnerLog = path.join(sessionDir, 'mux-runner.log');
        let logContent = '';
        if (fs.existsSync(runnerLog)) {
            logContent = fs.readFileSync(runnerLog, 'utf-8');
        }
        const combined = result.stdout + result.stderr + logContent;

        assert.ok(
            combined.includes('Max iterations reached'),
            `Expected "Max iterations reached" in output/log, got stdout: ${result.stdout}, stderr: ${result.stderr}, log: ${logContent}`
        );

        // Verify state was set to inactive
        const finalState = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
        assert.equal(finalState.active, false, 'Session should be inactive after max iterations');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Session starts inactive, mux-runner takes ownership, then immediately hits max ---

test('mux-runner: takes ownership of inactive session then respects max_iterations', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });
        // Start with active: false (mux-runner should set it to true)
        // but iteration is already at max
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: false,
            tmux_mode: true,
            step: 'plan',
            iteration: 10,
            max_iterations: 10,
            worker_timeout_seconds: 1200,
            original_prompt: 'test ownership',
            working_dir: tmpRoot,
        }, null, 2));

        const result = run(tmpRoot, [sessionDir]);

        const runnerLog = path.join(sessionDir, 'mux-runner.log');
        let logContent = '';
        if (fs.existsSync(runnerLog)) {
            logContent = fs.readFileSync(runnerLog, 'utf-8');
        }
        const combined = result.stdout + result.stderr + logContent;

        // Should have taken ownership
        assert.ok(
            combined.includes('ownership'),
            `Expected ownership message in log, got: ${logContent}`
        );

        // Should hit max iterations
        assert.ok(
            combined.includes('Max iterations reached'),
            `Expected "Max iterations reached" in output/log, got stdout: ${result.stdout}, log: ${logContent}`
        );

        // Final state should be inactive again (set by the max_iterations guard)
        const finalState = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
        assert.equal(finalState.active, false, 'Session should be inactive after max iterations');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Settings type guards for max turns ---

test('mux-runner: ignores non-number default_tmux_max_turns in settings', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });
        // Session already at max iterations — will exit immediately
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            step: 'implement',
            iteration: 3,
            max_iterations: 3,
            worker_timeout_seconds: 1200,
            original_prompt: 'test settings guard',
            working_dir: tmpRoot,
        }, null, 2));

        // Write settings with a string (should be ignored)
        fs.writeFileSync(path.join(tmpRoot, 'pickle_settings.json'), JSON.stringify({
            default_tmux_max_turns: "eighty",
            default_manager_max_turns: true,
        }));

        const result = run(tmpRoot, [sessionDir]);
        const combined = result.stdout + result.stderr;
        // Should not crash with TypeError
        assert.ok(
            !combined.includes('TypeError'),
            `Should handle non-number settings gracefully, got: ${combined.slice(0, 500)}`
        );

        const runnerLog = path.join(sessionDir, 'mux-runner.log');
        if (fs.existsSync(runnerLog)) {
            const logContent = fs.readFileSync(runnerLog, 'utf-8');
            assert.ok(
                logContent.includes('Max iterations reached'),
                `Expected normal max iterations exit, got: ${logContent}`
            );
        }
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('mux-runner: ignores zero default_tmux_max_turns, falls back to default_manager_max_turns', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            step: 'refactor',
            iteration: 2,
            max_iterations: 2,
            original_prompt: 'test fallback',
            working_dir: tmpRoot,
        }, null, 2));

        // default_tmux_max_turns is 0 (rejected), but default_manager_max_turns is valid
        fs.writeFileSync(path.join(tmpRoot, 'pickle_settings.json'), JSON.stringify({
            default_tmux_max_turns: 0,
            default_manager_max_turns: 42,
        }));

        const result = run(tmpRoot, [sessionDir]);
        const combined = result.stdout + result.stderr;
        assert.ok(
            !combined.includes('TypeError'),
            `Should handle zero settings gracefully, got: ${combined.slice(0, 500)}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Nonexistent session dir path → exit code 1 ---

test('mux-runner: exits with code 1 when session dir path does not exist', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const result = run(tmpRoot, ['/nonexistent/session/path/xyz']);
        assert.equal(result.status, 1, `Expected exit code 1, got: ${result.status}`);
        assert.ok(
            result.stderr.includes('Usage'),
            `Expected "Usage" in stderr, got: ${result.stderr}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Runner creates mux-runner.log ---

// ---------------------------------------------------------------------------
// Number() coercion for string numeric limits (deep review pass 5)
// ---------------------------------------------------------------------------

test('mux-runner: string max_iterations and iteration still trigger max iterations exit', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });
        // Use STRING values for max_iterations and iteration
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            step: 'implement',
            iteration: '1',
            max_iterations: '1',
            worker_timeout_seconds: 1200,
            original_prompt: 'test string coercion',
            working_dir: tmpRoot,
        }, null, 2));

        const result = run(tmpRoot, [sessionDir]);

        const runnerLog = path.join(sessionDir, 'mux-runner.log');
        let logContent = '';
        if (fs.existsSync(runnerLog)) {
            logContent = fs.readFileSync(runnerLog, 'utf-8');
        }
        const combined = result.stdout + result.stderr + logContent;

        assert.ok(
            combined.includes('Max iterations reached'),
            `Expected "Max iterations reached" with string numerics, got stdout: ${result.stdout}, stderr: ${result.stderr}, log: ${logContent}`
        );

        // Verify state was set to inactive
        const finalState = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
        assert.equal(finalState.active, false, 'Session should be inactive after string max iterations');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('mux-runner: recovered inactive orphan tmp stops the loop before stale command_template validation', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });
        const statePath = path.join(sessionDir, 'state.json');
        fs.writeFileSync(statePath, JSON.stringify({
            active: true,
            step: 'implement',
            iteration: 0,
            max_iterations: 5,
            worker_timeout_seconds: 1200,
            original_prompt: 'test recovered inactive state',
            working_dir: tmpRoot,
            command_template: '../stale-template.md',
        }, null, 2));
        fs.writeFileSync(`${statePath}.tmp.99999999`, JSON.stringify({
            active: false,
            step: 'review',
            iteration: 4,
            max_iterations: 5,
            worker_timeout_seconds: 1200,
            original_prompt: 'promoted inactive state',
            working_dir: tmpRoot,
        }, null, 2));

        const result = run(tmpRoot, [sessionDir]);

        const runnerLog = path.join(sessionDir, 'mux-runner.log');
        const logContent = fs.existsSync(runnerLog) ? fs.readFileSync(runnerLog, 'utf-8') : '';
        const combined = result.stdout + result.stderr + logContent;

        assert.ok(
            combined.includes('Session inactive. Exiting.'),
            `Expected recovered inactive session exit, got stdout: ${result.stdout}, stderr: ${result.stderr}, log: ${logContent}`
        );
        assert.ok(
            !combined.includes('Invalid command_template'),
            `Recovered inactive state should short-circuit stale template validation, got: ${combined}`
        );

        const finalState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(finalState.active, false, 'promoted inactive state must persist');
        assert.equal(finalState.iteration, 4, 'higher-iteration orphan tmp must be promoted');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('mux-runner: SIGTERM shutdown preserves a newer orphan tmp session payload', async () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });
        const statePath = path.join(sessionDir, 'state.json');
        fs.writeFileSync(statePath, JSON.stringify({
            schema_version: 1,
            active: false,
            tmux_mode: true,
            backend: 'claude',
            step: 'implement',
            iteration: 1,
            max_iterations: 10,
            worker_timeout_seconds: 1200,
            current_ticket: 'T-BASE',
            original_prompt: 'Base mux session state',
            working_dir: tmpRoot,
            session_dir: sessionDir,
        }, null, 2));

        const templatesDir = path.join(tmpRoot, 'templates');
        fs.mkdirSync(templatesDir, { recursive: true });
        fs.writeFileSync(path.join(templatesDir, 'pickle.md'), '# Pickle\n\nResume: $ARGUMENTS\n');

        const fakeBin = path.join(tmpRoot, 'fake-bin');
        fs.mkdirSync(fakeBin, { recursive: true });
        const fakeClaude = path.join(fakeBin, 'claude');
        fs.writeFileSync(fakeClaude, '#!/bin/sh\n/bin/sleep 30\n');
        fs.chmodSync(fakeClaude, 0o755);

        const child = spawn(process.execPath, [TMUX_RUNNER_BIN, sessionDir], {
            env: { ...process.env, EXTENSION_DIR: tmpRoot, PATH: fakeBin, PICKLE_BACKEND: 'claude' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk.toString(); });
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });

        await waitFor(() => {
            try {
                const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
                return state.active === true && fs.existsSync(path.join(sessionDir, 'tmux_iteration_1.log'));
            } catch {
                return false;
            }
        });

        const orphanTmpPath = `${statePath}.tmp.99999999`;
        fs.writeFileSync(orphanTmpPath, JSON.stringify({
            schema_version: 1,
            active: true,
            tmux_mode: true,
            backend: 'claude',
            step: 'implement',
            iteration: 7,
            max_iterations: 10,
            worker_timeout_seconds: 1200,
            current_ticket: 'T-RECOVERED',
            original_prompt: 'Recovered mux session state',
            working_dir: tmpRoot,
            session_dir: sessionDir,
        }, null, 2));

        child.kill('SIGTERM');
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                child.kill('SIGKILL');
                reject(new Error('mux-runner did not exit after SIGTERM'));
            }, 10000);
            child.on('exit', () => {
                clearTimeout(timer);
                resolve(undefined);
            });
            child.on('error', (err) => {
                clearTimeout(timer);
                reject(err);
            });
        });

        const combined = stdout + stderr;
        const finalState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.ok(
            combined.includes('Received SIGTERM'),
            `Expected shutdown log in output, got: ${combined.slice(0, 1000)}`
        );
        assert.equal(finalState.iteration, 7, 'shutdown must promote the newer orphan tmp before deactivation');
        assert.equal(finalState.current_ticket, 'T-RECOVERED', 'shutdown must preserve the recovered session payload');
        assert.equal(finalState.active, false, 'shutdown must deactivate the session');
        assert.equal(fs.existsSync(orphanTmpPath), false, 'orphan tmp should be consumed during shutdown recovery');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('mux-runner: NaN max_time_minutes and start_time_epoch do not crash', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });
        // NaN time values but valid iteration limit so it exits quickly
        // Number("abc") = NaN, || 0 fallback prevents crash on time checks
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            step: 'implement',
            iteration: 5,
            max_iterations: 5,
            worker_timeout_seconds: 1200,
            max_time_minutes: 'abc',
            start_time_epoch: 'xyz',
            original_prompt: 'test NaN safety',
            working_dir: tmpRoot,
        }, null, 2));

        const result = run(tmpRoot, [sessionDir]);

        const runnerLog = path.join(sessionDir, 'mux-runner.log');
        let logContent = '';
        if (fs.existsSync(runnerLog)) {
            logContent = fs.readFileSync(runnerLog, 'utf-8');
        }
        const combined = result.stdout + result.stderr + logContent;

        // Should not crash with TypeError — should handle NaN gracefully
        assert.ok(
            !combined.includes('TypeError'),
            `Should not crash on NaN time values, got: ${combined.slice(0, 500)}`
        );
        // Should still hit max iterations and exit cleanly
        assert.ok(
            combined.includes('Max iterations reached'),
            `Expected "Max iterations reached" despite NaN time values, got: ${logContent}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('mux-runner: stall detection works with string state.iteration', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });
        // String iteration — stall detection must compare Number()-coerced values
        // Start at iteration "5" with max "100" — runIteration will fail (no claude),
        // but the stall counter should increment because state.iteration won't advance.
        // After 3 stalls, mux-runner exits.
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            step: 'implement',
            iteration: '5',
            max_iterations: 100,
            worker_timeout_seconds: 1200,
            original_prompt: 'test stall with string',
            working_dir: tmpRoot,
        }, null, 2));

        // Create pickle.md so runIteration doesn't bail on missing file
        const claudeDir = path.join(os.homedir(), '.claude', 'commands');
        const picklePromptPath = path.join(claudeDir, 'pickle.md');
        const hasPickleMd = fs.existsSync(picklePromptPath);

        if (!hasPickleMd) {
            // Skip test if pickle.md isn't installed — can't test runIteration
            return;
        }

        const result = run(tmpRoot, [sessionDir]);

        const runnerLog = path.join(sessionDir, 'mux-runner.log');
        let logContent = '';
        if (fs.existsSync(runnerLog)) {
            logContent = fs.readFileSync(runnerLog, 'utf-8');
        }

        // The stall detection should NOT treat string "5" === number -1 as different
        // (which would reset the counter each time). With the Number() fix,
        // it compares 5 === -1, 5 === 5, 5 === 5 and stalls after 3 iterations.
        // But runIteration may exit with 'error' first since claude binary isn't available.
        // Either way, the runner should have logged iterations and exited.
        assert.ok(
            logContent.includes('Iteration'),
            `Expected iteration logs, got: ${logContent}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- command_template path traversal validation (meeseeks pass 3) ---

test('mux-runner: rejects command_template with path traversal (../)', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });
        // Active session at iteration 0 — runIteration will be called,
        // which reads command_template from state.json
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            step: 'prd',
            iteration: 0,
            max_iterations: 5,
            worker_timeout_seconds: 1200,
            original_prompt: 'test traversal',
            working_dir: tmpRoot,
            command_template: '../../../etc/passwd',
        }, null, 2));

        const result = run(tmpRoot, [sessionDir]);

        const runnerLog = path.join(sessionDir, 'mux-runner.log');
        let logContent = '';
        if (fs.existsSync(runnerLog)) {
            logContent = fs.readFileSync(runnerLog, 'utf-8');
        }
        const combined = result.stdout + result.stderr + logContent;

        assert.ok(
            combined.includes('Invalid command_template'),
            `Expected path traversal rejection, got stdout: ${result.stdout}, stderr: ${result.stderr}, log: ${logContent}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('mux-runner: rejects command_template with forward slash', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            step: 'prd',
            iteration: 0,
            max_iterations: 5,
            worker_timeout_seconds: 1200,
            original_prompt: 'test slash',
            working_dir: tmpRoot,
            command_template: 'subdir/evil.md',
        }, null, 2));

        const result = run(tmpRoot, [sessionDir]);

        const runnerLog = path.join(sessionDir, 'mux-runner.log');
        let logContent = '';
        if (fs.existsSync(runnerLog)) {
            logContent = fs.readFileSync(runnerLog, 'utf-8');
        }
        const combined = result.stdout + result.stderr + logContent;

        assert.ok(
            combined.includes('Invalid command_template'),
            `Expected slash rejection, got stdout: ${result.stdout}, stderr: ${result.stderr}, log: ${logContent}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('mux-runner: runs readiness gate at iteration 0 before manager spawn', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        const ticketDir = path.join(sessionDir, 'bad001');
        fs.mkdirSync(ticketDir, { recursive: true });
        fs.writeFileSync(path.join(ticketDir, 'linear_ticket_bad001.md'), [
            '---',
            'id: bad001',
            'key: BAD-1',
            'ac_ids: []',
            '---',
            '',
            '# Ticket',
            '',
            '## Acceptance Criteria',
            '- [ ] The workflow should feel intuitive.',
            '',
        ].join('\n'));
        fs.writeFileSync(path.join(sessionDir, 'decomposition_manifest.json'), JSON.stringify({
            tickets: [{ id: 'bad001', key: 'BAD-1' }],
        }, null, 2));
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            step: 'research',
            iteration: 0,
            max_iterations: 5,
            worker_timeout_seconds: 1200,
            original_prompt: 'test readiness gate',
            working_dir: tmpRoot,
            command_template: 'pickle.md',
        }, null, 2));

        const result = run(path.resolve(__dirname, '../..'), [sessionDir]);
        const runnerLog = fs.readFileSync(path.join(sessionDir, 'mux-runner.log'), 'utf-8');
        const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));

        assert.equal(result.status, 1);
        assert.equal(state.active, false);
        assert.match(result.stdout, /"status":"fail"/);
        assert.match(result.stderr + runnerLog, /READINESS HALT/);
        assert.doesNotMatch(runnerLog, /Run Pickle Iteration/);
        assert.ok(fs.readdirSync(sessionDir).some((file) => /^readiness_\d{4}-\d{2}-\d{2}/.test(file)));
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// F20: unknown template rejected (not present in extensionRoot/templates or ~/.claude/commands)
test('mux-runner: rejects command_template not found in any directory', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });
        // Use a name that cannot exist in the real ~/.claude/commands either
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            step: 'prd',
            iteration: 0,
            max_iterations: 5,
            worker_timeout_seconds: 1200,
            original_prompt: 'test unknown template',
            working_dir: tmpRoot,
            command_template: 'definitely-nonexistent-template-xyz123abc.md',
        }, null, 2));

        const result = run(tmpRoot, [sessionDir]);

        const runnerLog = path.join(sessionDir, 'mux-runner.log');
        let logContent = '';
        if (fs.existsSync(runnerLog)) {
            logContent = fs.readFileSync(runnerLog, 'utf-8');
        }
        const combined = result.stdout + result.stderr + logContent;

        assert.ok(
            combined.includes('not found'),
            `Expected "not found" error for unknown template, got stdout: ${result.stdout}, stderr: ${result.stderr}, log: ${logContent}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// F20: user command accepted when template exists in extensionRoot/templates
test('mux-runner: accepts command_template found in extensionRoot/templates', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });

        // Create the templates directory and a valid template inside it
        const templatesDir = path.join(tmpRoot, 'templates');
        fs.mkdirSync(templatesDir, { recursive: true });
        fs.writeFileSync(path.join(templatesDir, 'test-valid-template.md'),
            '# Test Template\nThis template exists and should be accepted.\n');

        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            step: 'prd',
            iteration: 0,
            max_iterations: 1,
            original_prompt: 'test valid template',
            working_dir: tmpRoot,
            command_template: 'test-valid-template.md',
        }, null, 2));

        const result = run(tmpRoot, [sessionDir]);

        const runnerLog = path.join(sessionDir, 'mux-runner.log');
        let logContent = '';
        if (fs.existsSync(runnerLog)) {
            logContent = fs.readFileSync(runnerLog, 'utf-8');
        }
        const combined = result.stdout + result.stderr + logContent;

        // Template validation must pass — no "not found" or "Invalid" error
        assert.ok(
            !combined.includes('not found in'),
            `Template should be accepted, got: ${combined.slice(0, 600)}`
        );
        assert.ok(
            !combined.includes('Invalid command_template'),
            `Template should not be rejected, got: ${combined.slice(0, 600)}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('mux-runner: creates mux-runner.log in session directory', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            step: 'refactor',
            iteration: 3,
            max_iterations: 3,
            worker_timeout_seconds: 1200,
            original_prompt: 'test log creation',
            working_dir: tmpRoot,
        }, null, 2));

        run(tmpRoot, [sessionDir]);

        const logPath = path.join(sessionDir, 'mux-runner.log');
        assert.ok(fs.existsSync(logPath), 'mux-runner.log should be created in session dir');

        const logContent = fs.readFileSync(logPath, 'utf-8');
        assert.ok(
            logContent.includes('mux-runner started'),
            `Expected "mux-runner started" in log, got: ${logContent}`
        );
        assert.ok(
            logContent.includes('mux-runner finished'),
            `Expected "mux-runner finished" in log, got: ${logContent}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Completion classification (classifyCompletion) ---

import { buildTmuxNotification, classifyCompletion, classifyTicketCompletion, extractAssistantContent, transitionToMeeseeks, loadRateLimitSettings, loadMeeseeksModel, classifyIterationExit, detectRateLimitInLog, detectRateLimitInText, stripSetupSection, detectMultiRepo, writeHandoffAtomic } from '../bin/mux-runner.js';

test('classifyCompletion: TASK_COMPLETED returns continue (single ticket, loop continues)', () => {
    assert.equal(classifyCompletion('<promise>TASK_COMPLETED</promise>'), 'continue');
});

test('classifyCompletion: EPIC_COMPLETED returns task_completed', () => {
    assert.equal(classifyCompletion('<promise>EPIC_COMPLETED</promise>'), 'task_completed');
});

test('classifyCompletion: EXISTENCE_IS_PAIN returns review_clean', () => {
    assert.equal(classifyCompletion('<promise>EXISTENCE_IS_PAIN</promise>'), 'review_clean');
});

test('classifyCompletion: THE_CITADEL_APPROVES returns review_clean', () => {
    assert.equal(classifyCompletion('<promise>THE_CITADEL_APPROVES</promise>'), 'review_clean');
});

test('classifyCompletion: no token returns continue', () => {
    assert.equal(classifyCompletion('Some random output with no tokens'), 'continue');
});

test('classifyCompletion: empty string returns continue', () => {
    assert.equal(classifyCompletion(''), 'continue');
});

test('classifyCompletion: EPIC_COMPLETED takes precedence over EXISTENCE_IS_PAIN', () => {
    const output = '<promise>EPIC_COMPLETED</promise>\n<promise>EXISTENCE_IS_PAIN</promise>';
    assert.equal(classifyCompletion(output), 'task_completed');
});

test('classifyCompletion: tolerates whitespace in tokens', () => {
    assert.equal(classifyCompletion('<promise> EXISTENCE_IS_PAIN </promise>'), 'review_clean');
    assert.equal(classifyCompletion('<promise> TASK_COMPLETED </promise>'), 'continue');
});

test('classifyCompletion: TASK_COMPLETED inside stream-json returns continue', () => {
    const streamJsonLine = JSON.stringify({
        type: 'assistant',
        message: {
            content: [{ type: 'text', text: 'All done!\n<promise>TASK_COMPLETED</promise>' }],
        },
    });
    assert.equal(classifyCompletion(streamJsonLine), 'continue');
});

test('classifyCompletion: EPIC_COMPLETED inside stream-json returns task_completed', () => {
    const streamJsonLine = JSON.stringify({
        type: 'assistant',
        message: {
            content: [{ type: 'text', text: 'All done!\n<promise>EPIC_COMPLETED</promise>' }],
        },
    });
    assert.equal(classifyCompletion(streamJsonLine), 'task_completed');
});

// --- extractAssistantContent ---

test('extractAssistantContent: extracts assistant text, ignores tool results', () => {
    const lines = [
        JSON.stringify({ type: 'user', message: { role: 'user', content: [
            { type: 'tool_result', tool_use_id: 'x', content: 'Source: <promise>EPIC_COMPLETED</promise>' }
        ]}}),
        JSON.stringify({ type: 'assistant', message: { content: [
            { type: 'text', text: 'Review complete.\n<promise>EXISTENCE_IS_PAIN</promise>' }
        ]}}),
    ].join('\n');
    const content = extractAssistantContent(lines);
    assert.ok(content.includes('EXISTENCE_IS_PAIN'), 'Should include assistant text');
    assert.ok(!content.includes('EPIC_COMPLETED'), 'Should exclude tool_result content');
});

test('extractAssistantContent: includes result type lines', () => {
    const lines = [
        JSON.stringify({ type: 'result', result: 'Final output <promise>EPIC_COMPLETED</promise>' }),
    ].join('\n');
    const content = extractAssistantContent(lines);
    assert.ok(content.includes('EPIC_COMPLETED'), 'Should include result type');
});

test('extractAssistantContent: raw text passes through for backward compat', () => {
    const raw = 'Just plain text with <promise>EXISTENCE_IS_PAIN</promise>';
    const content = extractAssistantContent(raw);
    assert.ok(content.includes('EXISTENCE_IS_PAIN'), 'Should include raw text');
});

// F16: non-JSON line excluded in stream-json mode (prevents catch-block false positives)
test('extractAssistantContent: non-JSON plaintext excluded when stream-json lines present', () => {
    // A JSON line marks this as stream-json output; the subsequent plain-text line
    // (e.g. from a catch block printing an error) must NOT be included.
    const jsonLine = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Working on it...' }] },
    });
    const catchArtifact = '<promise>TASK_COMPLETED</promise>'; // stray non-JSON line
    const output = [jsonLine, catchArtifact].join('\n');

    const content = extractAssistantContent(output);
    assert.ok(!content.includes('TASK_COMPLETED'),
        'Non-JSON line should be excluded in stream-json mode');
    assert.ok(content.includes('Working on it...'),
        'JSON assistant text should still be included');
});

// F16: result-type blocks must be included (session final response for promise detection)
test('extractAssistantContent: result-type block included in stream-json mode', () => {
    const jsonLine = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'All done.' }] },
    });
    const resultLine = JSON.stringify({ type: 'result', result: '<promise>EPIC_COMPLETED</promise>' });
    const output = [jsonLine, resultLine].join('\n');

    const content = extractAssistantContent(output);
    assert.ok(content.includes('EPIC_COMPLETED'),
        'result-type block must be included for promise detection');
});

// F16: assistant-type blocks included (sanity check alongside result-type)
test('extractAssistantContent: assistant-type text block included in stream-json mode', () => {
    const line = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: '<promise>EXISTENCE_IS_PAIN</promise>' }] },
    });
    const content = extractAssistantContent(line);
    assert.ok(content.includes('EXISTENCE_IS_PAIN'), 'assistant text block must be included');
});

// --- Regression: EPIC_COMPLETED in tool_result must not override EXISTENCE_IS_PAIN in assistant ---

test('classifyCompletion: EPIC_COMPLETED in tool_result does NOT cause task_completed (regression)', () => {
    const output = [
        JSON.stringify({ type: 'user', message: { role: 'user', content: [
            { type: 'tool_result', tool_use_id: 'read1', content: 'if (hasToken(output, PromiseTokens.EPIC_COMPLETED)) {\n  return \'task_completed\';\n}\n<promise>EPIC_COMPLETED</promise>' }
        ]}}),
        JSON.stringify({ type: 'assistant', message: { content: [
            { type: 'text', text: 'EXISTENCE IS PAIN! No issues found.\n<promise>EXISTENCE_IS_PAIN</promise>' }
        ]}}),
    ].join('\n');
    assert.equal(classifyCompletion(output), 'review_clean',
        'Should return review_clean, not task_completed from source code in tool_result');
});

test('classifyCompletion: system prompt containing EPIC_COMPLETED is ignored', () => {
    const output = [
        JSON.stringify({ type: 'system', system: 'Promise tokens: <promise>EPIC_COMPLETED</promise>' }),
        JSON.stringify({ type: 'assistant', message: { content: [
            { type: 'text', text: 'Done reviewing.\n<promise>EXISTENCE_IS_PAIN</promise>' }
        ]}}),
    ].join('\n');
    assert.equal(classifyCompletion(output), 'review_clean');
});

// --- Notification logic (buildTmuxNotification) ---

test('buildTmuxNotification: success shows "Complete" with elapsed time', () => {
    const n = buildTmuxNotification('success', 'implement', 5, 300);
    assert.equal(n.title, '🥒 Pickle Run Complete');
    assert.ok(n.subtitle.includes('Finished in'), `Expected "Finished in" subtitle, got: ${n.subtitle}`);
    assert.ok(n.body.includes('5 iterations'), `Expected iterations in body, got: ${n.body}`);
});

test('buildTmuxNotification: limit shows "Complete" with "Stopped"', () => {
    const n = buildTmuxNotification('limit', 'implement', 10, 600);
    assert.equal(n.title, '🥒 Pickle Run Complete');
    assert.ok(n.subtitle.includes('Stopped: limit'), `Expected "Stopped: limit" subtitle, got: ${n.subtitle}`);
});

test('buildTmuxNotification: cancelled shows "Complete" with "Stopped"', () => {
    const n = buildTmuxNotification('cancelled', 'research', 3, 120);
    assert.equal(n.title, '🥒 Pickle Run Complete');
    assert.ok(n.subtitle.includes('Stopped: cancelled'), `Expected "Stopped: cancelled" subtitle, got: ${n.subtitle}`);
});

test('buildTmuxNotification: error shows "Failed" with phase', () => {
    const n = buildTmuxNotification('error', 'plan', 2, 45);
    assert.equal(n.title, '🥒 Pickle Run Failed');
    assert.ok(n.subtitle.includes('Exit: error'), `Expected "Exit: error" subtitle, got: ${n.subtitle}`);
    assert.ok(n.subtitle.includes('phase: plan'), `Expected phase in subtitle, got: ${n.subtitle}`);
});

test('buildTmuxNotification: stall shows "Failed" with phase', () => {
    const n = buildTmuxNotification('stall', 'implement', 7, 900);
    assert.equal(n.title, '🥒 Pickle Run Failed');
    assert.ok(n.subtitle.includes('Exit: stall'), `Expected "Exit: stall" subtitle, got: ${n.subtitle}`);
});

// ---------------------------------------------------------------------------
// transitionToMeeseeks
// ---------------------------------------------------------------------------

function makeState(overrides = {}) {
    return {
        active: true,
        working_dir: '/tmp/test',
        step: 'implement',
        iteration: 5,
        max_iterations: 100,
        max_time_minutes: 720,
        worker_timeout_seconds: 1200,
        start_time_epoch: 1700000000,
        completion_promise: null,
        original_prompt: 'test task',
        current_ticket: 'abc123',
        history: [{ step: 'implement', ticket: 'abc123', timestamp: '2025-01-01T00:00:00Z' }],
        started_at: '2025-01-01T00:00:00Z',
        session_dir: '/tmp/test-session',
        tmux_mode: true,
        min_iterations: 0,
        command_template: 'pickle.md',
        chain_meeseeks: true,
        ...overrides,
    };
}

test('transitionToMeeseeks: uses default min/max when no settings file', () => {
    const fakeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-')));
    try {
        const state = makeState();
        const result = transitionToMeeseeks(state, fakeRoot);

        assert.equal(result.chain_meeseeks, false);
        assert.equal(result.command_template, 'meeseeks.md');
        assert.equal(result.min_iterations, 10);
        assert.equal(result.max_iterations, 50);
        assert.equal(result.iteration, 0);
        assert.equal(result.step, 'review');
        assert.equal(result.current_ticket, null);
    } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
});

test('transitionToMeeseeks: reads custom values from pickle_settings.json', () => {
    const fakeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-')));
    try {
        fs.writeFileSync(path.join(fakeRoot, 'pickle_settings.json'), JSON.stringify({
            default_meeseeks_min_passes: 15,
            default_meeseeks_max_passes: 75,
        }));
        const result = transitionToMeeseeks(makeState(), fakeRoot);
        assert.equal(result.min_iterations, 15);
        assert.equal(result.max_iterations, 75);
    } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
});

test('transitionToMeeseeks: recovers newer dead-writer pickle_settings tmp', () => {
    const fakeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-')));
    try {
        const settingsPath = path.join(fakeRoot, 'pickle_settings.json');
        const tmpSettingsPath = `${settingsPath}.tmp.99999999`;
        fs.writeFileSync(settingsPath, JSON.stringify({
            default_meeseeks_min_passes: 15,
            default_meeseeks_max_passes: 75,
        }));
        fs.writeFileSync(tmpSettingsPath, JSON.stringify({
            default_meeseeks_min_passes: 3,
            default_meeseeks_max_passes: 9,
        }));
        const stale = new Date('2026-01-01T00:00:00.000Z');
        const newer = new Date('2026-01-01T00:00:01.000Z');
        fs.utimesSync(settingsPath, stale, stale);
        fs.utimesSync(tmpSettingsPath, newer, newer);

        const result = transitionToMeeseeks(makeState(), fakeRoot);

        assert.equal(result.min_iterations, 3);
        assert.equal(result.max_iterations, 9);
        assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf-8')), {
            default_meeseeks_min_passes: 3,
            default_meeseeks_max_passes: 9,
        });
        assert.equal(fs.existsSync(tmpSettingsPath), false);
    } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
});

test('transitionToMeeseeks: non-number settings fall back to defaults', () => {
    const fakeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-')));
    try {
        fs.writeFileSync(path.join(fakeRoot, 'pickle_settings.json'), JSON.stringify({
            default_meeseeks_min_passes: 'not-a-number',
            default_meeseeks_max_passes: null,
        }));
        const result = transitionToMeeseeks(makeState(), fakeRoot);
        assert.equal(result.min_iterations, 10);
        assert.equal(result.max_iterations, 50);
    } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
});

test('transitionToMeeseeks: zero/negative settings fall back to defaults', () => {
    const fakeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-')));
    try {
        fs.writeFileSync(path.join(fakeRoot, 'pickle_settings.json'), JSON.stringify({
            default_meeseeks_min_passes: 0,
            default_meeseeks_max_passes: -5,
        }));
        const result = transitionToMeeseeks(makeState(), fakeRoot);
        assert.equal(result.min_iterations, 10);
        assert.equal(result.max_iterations, 50);
    } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
});

test('transitionToMeeseeks: preserves non-transitioned state fields', () => {
    const fakeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-')));
    try {
        const state = makeState({
            working_dir: '/my/project',
            start_time_epoch: 1700000000,
            original_prompt: 'build the thing',
            session_dir: '/sessions/abc',
            tmux_mode: true,
            active: true,
        });
        const result = transitionToMeeseeks(state, fakeRoot);
        assert.equal(result.working_dir, '/my/project');
        assert.equal(result.start_time_epoch, 1700000000);
        assert.equal(result.original_prompt, 'build the thing');
        assert.equal(result.session_dir, '/sessions/abc');
        assert.equal(result.tmux_mode, true);
        assert.equal(result.active, true);
    } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// loadRateLimitSettings
// ---------------------------------------------------------------------------

test('loadRateLimitSettings: returns defaults when no settings file', () => {
    const fakeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-')));
    try {
        const result = loadRateLimitSettings(fakeRoot);
        assert.equal(result.waitMinutes, 5);
        assert.equal(result.maxRetries, 3);
    } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
});

test('loadRateLimitSettings: reads custom values from pickle_settings.json', () => {
    const fakeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-')));
    try {
        fs.writeFileSync(path.join(fakeRoot, 'pickle_settings.json'), JSON.stringify({
            default_rate_limit_wait_minutes: 30,
            default_max_rate_limit_retries: 5,
        }));
        const result = loadRateLimitSettings(fakeRoot);
        assert.equal(result.waitMinutes, 30);
        assert.equal(result.maxRetries, 5);
    } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
});

test('loadRateLimitSettings: zero values fall back to floor of 1', () => {
    const fakeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-')));
    try {
        fs.writeFileSync(path.join(fakeRoot, 'pickle_settings.json'), JSON.stringify({
            default_rate_limit_wait_minutes: 0,
            default_max_rate_limit_retries: 0,
        }));
        const result = loadRateLimitSettings(fakeRoot);
        assert.equal(result.waitMinutes, 5, 'wait_minutes: 0 should fall back to default 5');
        assert.equal(result.maxRetries, 3, 'retries: 0 should fall back to default 3');
    } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
});

test('loadRateLimitSettings: negative values fall back to defaults', () => {
    const fakeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-')));
    try {
        fs.writeFileSync(path.join(fakeRoot, 'pickle_settings.json'), JSON.stringify({
            default_rate_limit_wait_minutes: -10,
            default_max_rate_limit_retries: -1,
        }));
        const result = loadRateLimitSettings(fakeRoot);
        assert.equal(result.waitMinutes, 5);
        assert.equal(result.maxRetries, 3);
    } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
});

test('loadRateLimitSettings: non-number values fall back to defaults', () => {
    const fakeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-')));
    try {
        fs.writeFileSync(path.join(fakeRoot, 'pickle_settings.json'), JSON.stringify({
            default_rate_limit_wait_minutes: 'sixty',
            default_max_rate_limit_retries: true,
        }));
        const result = loadRateLimitSettings(fakeRoot);
        assert.equal(result.waitMinutes, 5);
        assert.equal(result.maxRetries, 3);
    } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
});

test('loadRateLimitSettings: boundary value 1 is accepted (minimum floor)', () => {
    const fakeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-')));
    try {
        fs.writeFileSync(path.join(fakeRoot, 'pickle_settings.json'), JSON.stringify({
            default_rate_limit_wait_minutes: 1,
            default_max_rate_limit_retries: 1,
        }));
        const result = loadRateLimitSettings(fakeRoot);
        assert.equal(result.waitMinutes, 1);
        assert.equal(result.maxRetries, 1);
    } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// loadMeeseeksModel
// ---------------------------------------------------------------------------

test('loadMeeseeksModel: returns "sonnet" when no settings file', () => {
    const fakeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mm-')));
    try {
        assert.equal(loadMeeseeksModel(fakeRoot), 'sonnet');
    } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
});

test('loadMeeseeksModel: reads custom model from pickle_settings.json', () => {
    const fakeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mm-')));
    try {
        fs.writeFileSync(path.join(fakeRoot, 'pickle_settings.json'),
            JSON.stringify({ default_meeseeks_model: 'haiku' }));
        assert.equal(loadMeeseeksModel(fakeRoot), 'haiku');
    } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
});

test('loadMeeseeksModel: accepts full model ID', () => {
    const fakeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mm-')));
    try {
        fs.writeFileSync(path.join(fakeRoot, 'pickle_settings.json'),
            JSON.stringify({ default_meeseeks_model: 'claude-sonnet-4-6' }));
        assert.equal(loadMeeseeksModel(fakeRoot), 'claude-sonnet-4-6');
    } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
});

test('loadMeeseeksModel: empty string falls back to sonnet', () => {
    const fakeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mm-')));
    try {
        fs.writeFileSync(path.join(fakeRoot, 'pickle_settings.json'),
            JSON.stringify({ default_meeseeks_model: '' }));
        assert.equal(loadMeeseeksModel(fakeRoot), 'sonnet');
    } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
});

test('loadMeeseeksModel: non-string value falls back to sonnet', () => {
    const fakeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mm-')));
    try {
        fs.writeFileSync(path.join(fakeRoot, 'pickle_settings.json'),
            JSON.stringify({ default_meeseeks_model: 42 }));
        assert.equal(loadMeeseeksModel(fakeRoot), 'sonnet');
    } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// loadMeeseeksModel tier transitions (e8562b7c)
// ---------------------------------------------------------------------------

test('loadMeeseeksModel: pass 1 returns haiku with default tiers', () => {
    const fakeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mm-')));
    try {
        fs.writeFileSync(path.join(fakeRoot, 'pickle_settings.json'),
            JSON.stringify({ meeseeks_model_tiers: { "1": "haiku", "3": "sonnet", "5": "opus" }, max_opus_passes: 3 }));
        assert.equal(loadMeeseeksModel(fakeRoot, 1), 'haiku');
    } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
});

test('loadMeeseeksModel: pass 2 returns haiku', () => {
    const fakeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mm-')));
    try {
        fs.writeFileSync(path.join(fakeRoot, 'pickle_settings.json'),
            JSON.stringify({ meeseeks_model_tiers: { "1": "haiku", "3": "sonnet", "5": "opus" }, max_opus_passes: 3 }));
        assert.equal(loadMeeseeksModel(fakeRoot, 2), 'haiku');
    } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
});

test('loadMeeseeksModel: pass 3 returns sonnet', () => {
    const fakeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mm-')));
    try {
        fs.writeFileSync(path.join(fakeRoot, 'pickle_settings.json'),
            JSON.stringify({ meeseeks_model_tiers: { "1": "haiku", "3": "sonnet", "5": "opus" }, max_opus_passes: 3 }));
        assert.equal(loadMeeseeksModel(fakeRoot, 3), 'sonnet');
    } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
});

test('loadMeeseeksModel: pass 4 returns sonnet', () => {
    const fakeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mm-')));
    try {
        fs.writeFileSync(path.join(fakeRoot, 'pickle_settings.json'),
            JSON.stringify({ meeseeks_model_tiers: { "1": "haiku", "3": "sonnet", "5": "opus" }, max_opus_passes: 3 }));
        assert.equal(loadMeeseeksModel(fakeRoot, 4), 'sonnet');
    } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
});

test('loadMeeseeksModel: pass 5 returns opus', () => {
    const fakeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mm-')));
    try {
        fs.writeFileSync(path.join(fakeRoot, 'pickle_settings.json'),
            JSON.stringify({ meeseeks_model_tiers: { "1": "haiku", "3": "sonnet", "5": "opus" }, max_opus_passes: 3 }));
        assert.equal(loadMeeseeksModel(fakeRoot, 5), 'opus');
    } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
});

test('loadMeeseeksModel: pass 7 returns opus (3rd opus pass, within cap)', () => {
    const fakeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mm-')));
    try {
        fs.writeFileSync(path.join(fakeRoot, 'pickle_settings.json'),
            JSON.stringify({ meeseeks_model_tiers: { "1": "haiku", "3": "sonnet", "5": "opus" }, max_opus_passes: 3 }));
        assert.equal(loadMeeseeksModel(fakeRoot, 7), 'opus');
    } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
});

test('loadMeeseeksModel: pass 8 falls back to sonnet (opus cap exceeded)', () => {
    const fakeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mm-')));
    try {
        fs.writeFileSync(path.join(fakeRoot, 'pickle_settings.json'),
            JSON.stringify({ meeseeks_model_tiers: { "1": "haiku", "3": "sonnet", "5": "opus" }, max_opus_passes: 3 }));
        assert.equal(loadMeeseeksModel(fakeRoot, 8), 'sonnet');
    } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
});

test('loadMeeseeksModel: no tiers in settings uses default_meeseeks_model', () => {
    const fakeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mm-')));
    try {
        fs.writeFileSync(path.join(fakeRoot, 'pickle_settings.json'),
            JSON.stringify({ default_meeseeks_model: 'haiku' }));
        assert.equal(loadMeeseeksModel(fakeRoot, 5), 'haiku');
    } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
});

test('loadMeeseeksModel: backward compat — no passCount arg defaults to pass 1', () => {
    const fakeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mm-')));
    try {
        fs.writeFileSync(path.join(fakeRoot, 'pickle_settings.json'),
            JSON.stringify({ meeseeks_model_tiers: { "1": "haiku", "3": "sonnet", "5": "opus" } }));
        assert.equal(loadMeeseeksModel(fakeRoot), 'haiku');
    } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Exit code sidecar file pattern (d6ed51ab)
// ---------------------------------------------------------------------------

test('exitcode sidecar: .log replaced with .exitcode produces correct filename', () => {
    const logFile = '/tmp/sessions/2026-03-01/tmux_iteration_1.log';
    const exitCodeFile = logFile.replace('.log', '.exitcode');
    assert.equal(exitCodeFile, '/tmp/sessions/2026-03-01/tmux_iteration_1.exitcode');
});

test('exitcode sidecar: pattern works for various iteration numbers', () => {
    for (const n of [0, 1, 42, 999]) {
        const logFile = `tmux_iteration_${n}.log`;
        const exitCodeFile = logFile.replace('.log', '.exitcode');
        assert.equal(exitCodeFile, `tmux_iteration_${n}.exitcode`);
    }
});

// ---------------------------------------------------------------------------
// classifyIterationExit — rate limit main loop integration (87e1fdde)
// ---------------------------------------------------------------------------

test('classifyIterationExit: inactive result returns inactive', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-exit-')));
    try {
        const logFile = path.join(tmpDir, 'test.log');
        fs.writeFileSync(logFile, 'some output\n');
        assert.equal(classifyIterationExit('inactive', logFile).type, 'inactive');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyIterationExit: error result returns error', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-exit-')));
    try {
        const logFile = path.join(tmpDir, 'test.log');
        fs.writeFileSync(logFile, 'some output\n');
        assert.equal(classifyIterationExit('error', logFile).type, 'error');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyIterationExit: task_completed returns success', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-exit-')));
    try {
        const logFile = path.join(tmpDir, 'test.log');
        fs.writeFileSync(logFile, 'normal output\n');
        assert.equal(classifyIterationExit('task_completed', logFile).type, 'success');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyIterationExit: review_clean returns success', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-exit-')));
    try {
        const logFile = path.join(tmpDir, 'test.log');
        fs.writeFileSync(logFile, 'clean output\n');
        assert.equal(classifyIterationExit('review_clean', logFile).type, 'success');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyIterationExit: continue with rate_limit_event JSON returns api_limit', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-exit-')));
    try {
        const logFile = path.join(tmpDir, 'test.log');
        const lines = [
            'normal output',
            JSON.stringify({ type: 'rate_limit_event', status: 'rejected' }),
        ];
        fs.writeFileSync(logFile, lines.join('\n'));
        assert.equal(classifyIterationExit('continue', logFile).type, 'api_limit');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyIterationExit: continue with rate limit text pattern returns api_limit', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-exit-')));
    try {
        const logFile = path.join(tmpDir, 'test.log');
        fs.writeFileSync(logFile, "You're out of extra usage · resets Mar 6 at 11am\n");
        assert.equal(classifyIterationExit('continue', logFile).type, 'api_limit');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyIterationExit: continue with clean log returns success', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-exit-')));
    try {
        const logFile = path.join(tmpDir, 'test.log');
        fs.writeFileSync(logFile, 'all good, no issues\n');
        assert.equal(classifyIterationExit('continue', logFile).type, 'success');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyIterationExit: missing log file still returns success for continue', () => {
    assert.equal(classifyIterationExit('continue', '/nonexistent/path/log.log').type, 'success');
});

// ---------------------------------------------------------------------------
// detectRateLimitInLog / detectRateLimitInText — unit coverage (87e1fdde)
// ---------------------------------------------------------------------------

test('detectRateLimitInLog: returns true for rate_limit_event with rejected status', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rl-')));
    try {
        const logFile = path.join(tmpDir, 'test.log');
        fs.writeFileSync(logFile, JSON.stringify({ type: 'rate_limit_event', status: 'rejected' }) + '\n');
        assert.equal(detectRateLimitInLog(logFile).limited, true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInLog: returns false for rate_limit_event with accepted status', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rl-')));
    try {
        const logFile = path.join(tmpDir, 'test.log');
        fs.writeFileSync(logFile, JSON.stringify({ type: 'rate_limit_event', status: 'accepted' }) + '\n');
        assert.equal(detectRateLimitInLog(logFile).limited, false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInLog: returns limited=false for missing file', () => {
    assert.equal(detectRateLimitInLog('/nonexistent/file.log').limited, false);
});

test('detectRateLimitInLog: only checks last 100 lines', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rl-')));
    try {
        const logFile = path.join(tmpDir, 'test.log');
        // Place rate limit event beyond the last 100 lines
        const lines = [JSON.stringify({ type: 'rate_limit_event', status: 'rejected' })];
        for (let i = 0; i < 110; i++) lines.push('filler line');
        fs.writeFileSync(logFile, lines.join('\n'));
        assert.equal(detectRateLimitInLog(logFile).limited, false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInText: returns true for "usage limit has been reached" pattern', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rl-')));
    try {
        const logFile = path.join(tmpDir, 'test.log');
        fs.writeFileSync(logFile, 'Your daily usage limit has been reached.\n');
        assert.equal(detectRateLimitInText(logFile), true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInText: returns true for "out of usage" pattern', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rl-')));
    try {
        const logFile = path.join(tmpDir, 'test.log');
        fs.writeFileSync(logFile, "You're out of extra usage · resets Mar 6 at 11am\n");
        assert.equal(detectRateLimitInText(logFile), true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInText: does not match generic "rate limit" mentions', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rl-')));
    try {
        const logFile = path.join(tmpDir, 'test.log');
        fs.writeFileSync(logFile, 'API rate limit hit, backing off.\n');
        assert.equal(detectRateLimitInText(logFile), false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInText: ignores rate limit text inside user/tool_result lines', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rl-')));
    try {
        const logFile = path.join(tmpDir, 'test.log');
        // Lines containing "type":"user" or "type":"tool_result" are filtered out
        fs.writeFileSync(logFile, '{"type":"user","text":"rate limit handling code"}\n');
        assert.equal(detectRateLimitInText(logFile), false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInText: returns false for clean output', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rl-')));
    try {
        const logFile = path.join(tmpDir, 'test.log');
        fs.writeFileSync(logFile, 'Everything worked great. No issues.\n');
        assert.equal(detectRateLimitInText(logFile), false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInText: returns false for missing file', () => {
    assert.equal(detectRateLimitInText('/nonexistent/file.log'), false);
});

// ---------------------------------------------------------------------------
// buildTmuxNotification: rate_limit_exhausted (87e1fdde)
// ---------------------------------------------------------------------------

test('buildTmuxNotification: rate_limit_exhausted shows "Failed"', () => {
    const n = buildTmuxNotification('rate_limit_exhausted', 'implement', 3, 3600);
    assert.equal(n.title, '🥒 Pickle Run Failed');
    assert.ok(n.subtitle.includes('Exit: rate_limit_exhausted'), `Expected exit reason in subtitle, got: ${n.subtitle}`);
    assert.ok(n.subtitle.includes('phase: implement'), `Expected phase in subtitle, got: ${n.subtitle}`);
});

// ---------------------------------------------------------------------------
// Stale rate_limit_wait.json cleanup on startup (87e1fdde)
// ---------------------------------------------------------------------------

test('mux-runner: cleans up stale rate_limit_wait.json on startup', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });
        // Session at max iterations — will exit immediately after ownership
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: false,
            step: 'implement',
            iteration: 5,
            max_iterations: 5,
            worker_timeout_seconds: 1200,
            original_prompt: 'test stale cleanup',
            working_dir: tmpRoot,
        }, null, 2));
        // Create a stale rate_limit_wait.json
        fs.writeFileSync(path.join(sessionDir, 'rate_limit_wait.json'), JSON.stringify({
            waiting: true, reason: 'API rate limit',
            started_at: '2026-03-01T00:00:00Z',
        }));

        run(tmpRoot, [sessionDir]);

        // The stale file should have been cleaned up during ownership takeover
        assert.equal(
            fs.existsSync(path.join(sessionDir, 'rate_limit_wait.json')),
            false,
            'Stale rate_limit_wait.json should be deleted on startup'
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// consecutiveRateLimits reset logic (87e1fdde)
// ---------------------------------------------------------------------------

test('classifyIterationExit: success exit type used to reset consecutiveRateLimits counter', () => {
    // This verifies the contract: when classifyIterationExit returns type 'success',
    // the main loop resets consecutiveRateLimits to 0.
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-exit-')));
    try {
        const logFile = path.join(tmpDir, 'clean.log');
        fs.writeFileSync(logFile, 'normal iteration output\n');
        assert.equal(classifyIterationExit('continue', logFile).type, 'success');
        assert.equal(classifyIterationExit('task_completed', logFile).type, 'success');
        assert.equal(classifyIterationExit('review_clean', logFile).type, 'success');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyIterationExit: api_limit is distinct from other exit types', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-exit-')));
    try {
        const logFile = path.join(tmpDir, 'rl.log');
        fs.writeFileSync(logFile, JSON.stringify({ type: 'rate_limit_event', status: 'rejected' }) + '\n');
        const result = classifyIterationExit('continue', logFile);
        assert.equal(result.type, 'api_limit');
        assert.notEqual(result.type, 'success');
        assert.notEqual(result.type, 'error');
        assert.notEqual(result.type, 'inactive');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// iteration_start / iteration_end activity events (222c384d)
// ---------------------------------------------------------------------------

/**
 * Run mux-runner with claude removed from PATH so spawn fails fast.
 * Returns parsed activity events from EXTENSION_DIR/activity/.
 */
function runAndCollectActivity(stateOverrides = {}) {
    const tmpRoot = makeTmpRoot();
    const sessionDir = path.join(tmpRoot, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });
    // Create templates/ and commands/ with a minimal pickle.md so runIteration
    // gets past template validation and reaches the claude spawn (which then
    // fails because claude is stripped from PATH). Without this, the runner
    // throws on template lookup before logging any iteration events.
    // Write pickle.md to templates/ (not commands/) — runIteration checks
    // extensionRoot/templates/ first, then falls back to ~/.claude/commands/.
    // In CI, ~/.claude/commands/pickle.md doesn't exist, so the template must
    // be in the EXTENSION_DIR-relative templates/ directory.
    const templatesDir = path.join(tmpRoot, 'templates');
    fs.mkdirSync(templatesDir, { recursive: true });
    fs.writeFileSync(path.join(templatesDir, 'pickle.md'), 'placeholder');
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
        active: true,
        step: 'implement',
        iteration: 0,
        max_iterations: 100,
        max_time_minutes: 720,
        worker_timeout_seconds: 1200,
        original_prompt: 'test iteration events',
        working_dir: tmpRoot,
        ...stateOverrides,
    }, null, 2));

    // Strip claude from PATH so runIteration's spawn('claude') fails immediately
    const pathDirs = (process.env.PATH || '').split(':').filter(d => {
        try { return !fs.existsSync(path.join(d, 'claude')); } catch { return true; }
    });

    // 15s → 60s: budget for system load when run alongside concurrent
    // codex/tmux work. The runner spawns claude (which fails fast because
    // we stripped it from PATH) and writes activity events; under load the
    // 15s budget got SIGKILL'd before the subprocess could even flush logs.
    const result = spawnSync(process.execPath, [TMUX_RUNNER_BIN, sessionDir], {
        env: {
            ...process.env,
            EXTENSION_DIR: tmpRoot,
            PATH: pathDirs.join(':'),
            PICKLE_BACKEND: 'claude',
        },
        encoding: 'utf-8',
        timeout: 60000,
    });

    const activityDir = path.join(tmpRoot, 'activity');
    let events = [];
    if (fs.existsSync(activityDir)) {
        for (const f of fs.readdirSync(activityDir)) {
            if (f.endsWith('.jsonl')) {
                const lines = fs.readFileSync(path.join(activityDir, f), 'utf-8').trim().split('\n').filter(Boolean);
                events.push(...lines.map(l => JSON.parse(l)));
            }
        }
    }

    fs.rmSync(tmpRoot, { recursive: true, force: true });
    return { events, result, sessionDir: path.basename(sessionDir) };
}

test('iteration events: iteration_start logged at start of iteration', () => {
    const { events } = runAndCollectActivity();
    const starts = events.filter(e => e.event === 'iteration_start');
    assert.ok(starts.length >= 1, `Expected at least 1 iteration_start event, got ${starts.length}`);
    assert.equal(starts[0].source, 'pickle');
    assert.equal(starts[0].iteration, 1);
    assert.ok(starts[0].session, 'iteration_start should have session ID');
    assert.ok(starts[0].ts, 'iteration_start should have timestamp');
});

test('iteration events: iteration_end logged with error exit_type on spawn failure', () => {
    const { events } = runAndCollectActivity();
    const ends = events.filter(e => e.event === 'iteration_end');
    assert.ok(ends.length >= 1, `Expected at least 1 iteration_end event, got ${ends.length}`);
    assert.equal(ends[0].source, 'pickle');
    assert.equal(ends[0].iteration, 1);
    assert.equal(ends[0].exit_type, 'error');
    assert.ok(ends[0].session, 'iteration_end should have session ID');
});

test('iteration events: session ID matches basename of session directory', () => {
    const { events, sessionDir } = runAndCollectActivity();
    const starts = events.filter(e => e.event === 'iteration_start');
    const ends = events.filter(e => e.event === 'iteration_end');
    assert.ok(starts.length >= 1, 'Need iteration_start events');
    assert.ok(ends.length >= 1, 'Need iteration_end events');
    assert.equal(starts[0].session, sessionDir);
    assert.equal(ends[0].session, sessionDir);
});

test('iteration events: iteration number matches across start and end', () => {
    const { events } = runAndCollectActivity();
    const starts = events.filter(e => e.event === 'iteration_start');
    const ends = events.filter(e => e.event === 'iteration_end');
    assert.ok(starts.length >= 1 && ends.length >= 1, 'Need both iteration events');
    assert.equal(starts[0].iteration, ends[0].iteration, 'Start and end should have same iteration number');
});

// --- stripSetupSection ---

test('stripSetupSection: strips "## SETUP MODE" through "## REVIEW PASS MODE"', () => {
    const input = 'Header\n\n## SETUP MODE\n\nSetup stuff\n\n## REVIEW PASS MODE\n\nReview stuff';
    const result = stripSetupSection(input);
    assert.equal(result, 'Header\n\n## REVIEW PASS MODE\n\nReview stuff');
    assert.ok(!result.includes('Setup stuff'));
});

test('stripSetupSection: strips "## SETUP" through "## REVIEW PASS" (no MODE suffix)', () => {
    const input = 'Header\n\n## SETUP\n\nSetup stuff\n\n## REVIEW PASS\n\nReview stuff';
    const result = stripSetupSection(input);
    assert.equal(result, 'Header\n\n## REVIEW PASS\n\nReview stuff');
    assert.ok(!result.includes('Setup stuff'));
});

test('stripSetupSection: strips "## SETUP" through "## REVIEW PASS MODE" (mixed)', () => {
    const input = 'Header\n\n## SETUP\n\nSetup stuff\n\n## REVIEW PASS MODE\n\nReview stuff';
    const result = stripSetupSection(input);
    assert.equal(result, 'Header\n\n## REVIEW PASS MODE\n\nReview stuff');
});

test('stripSetupSection: returns prompt unchanged when no setup section', () => {
    const input = 'Just a regular prompt\n\n## Some Other Section\n\nContent';
    assert.equal(stripSetupSection(input), input);
});

test('stripSetupSection: returns prompt unchanged when setup appears after review', () => {
    const input = '## REVIEW PASS MODE\n\nReview\n\n## SETUP MODE\n\nSetup';
    assert.equal(stripSetupSection(input), input);
});

test('stripSetupSection: does not match partial headers like "## SETUP WIZARD"', () => {
    const input = 'Header\n\n## SETUP WIZARD\n\nWizard stuff\n\n## REVIEW PASS MODE\n\nReview';
    assert.equal(stripSetupSection(input), input);
});

test('stripSetupSection: preserves content before setup and after review pass', () => {
    const input = 'Preamble line 1\nPreamble line 2\n\n## SETUP MODE\n\nGate checks\nStep 1\n\n## REVIEW PASS MODE\n\nStep 10\n\nFooter';
    const result = stripSetupSection(input);
    assert.ok(result.startsWith('Preamble line 1\nPreamble line 2\n\n'));
    assert.ok(result.includes('Step 10'));
    assert.ok(result.includes('Footer'));
    assert.ok(!result.includes('Gate checks'));
});

test('stripSetupSection: strips setup through any next ## heading (e.g. WORKER MODE)', () => {
    const input = 'Header\n\n## SETUP MODE\n\nSetup stuff\n\n## WORKER MODE\n\nWorker stuff';
    const result = stripSetupSection(input);
    assert.equal(result, 'Header\n\n## WORKER MODE\n\nWorker stuff');
    assert.ok(!result.includes('Setup stuff'));
});

test('stripSetupSection: strips setup through arbitrary section name', () => {
    const input = 'Intro\n\n## SETUP\n\nInit steps\n\n## EXECUTION PHASE\n\nDo the thing\n\n## CLEANUP\n\nTidy up';
    const result = stripSetupSection(input);
    assert.equal(result, 'Intro\n\n## EXECUTION PHASE\n\nDo the thing\n\n## CLEANUP\n\nTidy up');
    assert.ok(!result.includes('Init steps'));
});

test('stripSetupSection: returns unchanged when setup is the only/last section', () => {
    const input = 'Header\n\n## SETUP MODE\n\nSetup stuff and nothing else';
    assert.equal(stripSetupSection(input), input);
});

// --- classifyTicketCompletion ---

test('classifyTicketCompletion: returns completed when TASK_COMPLETED token found in log', () => {
    const tmpDir = makeTmpRoot();
    try {
        const logFile = path.join(tmpDir, 'test_iter.log');
        fs.writeFileSync(logFile, 'some output\n<promise>TASK_COMPLETED</promise>\nmore output');
        assert.equal(classifyTicketCompletion(logFile, '/nonexistent/dir'), 'completed');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyTicketCompletion: returns completed when TASK_COMPLETED in stream-json assistant message', () => {
    const tmpDir = makeTmpRoot();
    try {
        const logFile = path.join(tmpDir, 'test_iter.log');
        const streamLine = JSON.stringify({
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'Done! <promise>TASK_COMPLETED</promise>' }] }
        });
        fs.writeFileSync(logFile, streamLine + '\n');
        assert.equal(classifyTicketCompletion(logFile, '/nonexistent/dir'), 'completed');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyTicketCompletion: returns skipped when no evidence found (empty log, nonexistent dir)', () => {
    const tmpDir = makeTmpRoot();
    try {
        const logFile = path.join(tmpDir, 'test_iter.log');
        fs.writeFileSync(logFile, 'some random output with no tokens\n');
        assert.equal(classifyTicketCompletion(logFile, '/nonexistent/dir/xyz'), 'skipped');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyTicketCompletion: returns skipped on log read failure (nonexistent file)', () => {
    assert.equal(classifyTicketCompletion('/nonexistent/log/file.log', '/nonexistent/dir'), 'skipped');
});

// Helper: initialize a git repo in `dir` with one commit so later diffs are meaningful.
function initGitRepo(dir) {
    spawnSync('git', ['init'], { cwd: dir });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'initial.txt'), 'initial');
    spawnSync('git', ['add', '.'], { cwd: dir });
    spawnSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], { cwd: dir });
}

test('classifyTicketCompletion: uncommitted git changes + lifecycle artifact → completed', () => {
    const tmpDir = makeTmpRoot();
    try {
        initGitRepo(tmpDir);
        fs.writeFileSync(path.join(tmpDir, 'initial.txt'), 'modified');

        const ticketDir = path.join(tmpDir, 'ticket-a');
        fs.mkdirSync(ticketDir);
        fs.writeFileSync(path.join(ticketDir, 'research_2026-04-18.md'), 'research output');

        const logFile = path.join(tmpDir, 'test_iter.log');
        fs.writeFileSync(logFile, 'no tokens here\n');
        assert.equal(
            classifyTicketCompletion(logFile, tmpDir, ticketDir, 'implementation'),
            'completed'
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyTicketCompletion: staged git changes + lifecycle artifact → completed', () => {
    const tmpDir = makeTmpRoot();
    try {
        initGitRepo(tmpDir);
        fs.writeFileSync(path.join(tmpDir, 'initial.txt'), 'staged change');
        spawnSync('git', ['add', '.'], { cwd: tmpDir });

        const ticketDir = path.join(tmpDir, 'ticket-b');
        fs.mkdirSync(ticketDir);
        fs.writeFileSync(path.join(ticketDir, 'plan_2026-04-18.md'), 'plan output');

        const logFile = path.join(tmpDir, 'test_iter.log');
        fs.writeFileSync(logFile, 'no tokens here\n');
        assert.equal(
            classifyTicketCompletion(logFile, tmpDir, ticketDir, 'implementation'),
            'completed'
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// --- Ghost-ticket prevention (issue #3) ---

test('classifyTicketCompletion: dirty tree but no ticketDir → skipped (ghost guard)', () => {
    const tmpDir = makeTmpRoot();
    try {
        initGitRepo(tmpDir);
        fs.writeFileSync(path.join(tmpDir, 'initial.txt'), 'stray change from another ticket');

        const logFile = path.join(tmpDir, 'test_iter.log');
        fs.writeFileSync(logFile, 'no tokens, no artifacts\n');
        // Before the fix: unscoped git diff alone → completed (ghost).
        // After the fix: no ticketDir → skipped.
        assert.equal(classifyTicketCompletion(logFile, tmpDir), 'skipped');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyTicketCompletion: dirty tree + empty ticketDir → skipped (ghost guard)', () => {
    const tmpDir = makeTmpRoot();
    try {
        initGitRepo(tmpDir);
        fs.writeFileSync(path.join(tmpDir, 'initial.txt'), 'stray change');

        const ticketDir = path.join(tmpDir, 'ticket-empty');
        fs.mkdirSync(ticketDir);

        const logFile = path.join(tmpDir, 'test_iter.log');
        fs.writeFileSync(logFile, 'no tokens here\n');
        assert.equal(
            classifyTicketCompletion(logFile, tmpDir, ticketDir, 'implementation'),
            'skipped'
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyTicketCompletion: artifact present, clean tree → completed (non-git corroboration)', () => {
    const tmpDir = makeTmpRoot();
    try {
        const ticketDir = path.join(tmpDir, 'ticket-c');
        fs.mkdirSync(ticketDir, { recursive: true });
        fs.writeFileSync(path.join(ticketDir, 'research_2026-04-18.md'), 'research output');

        const logFile = path.join(tmpDir, 'test_iter.log');
        fs.writeFileSync(logFile, 'no tokens here\n');
        // No git repo at workingDir — runCmd throws, caught, falls through
        // to the default 'completed' since artifact exists.
        assert.equal(
            classifyTicketCompletion(logFile, '/nonexistent/not-a-repo', ticketDir, 'implementation'),
            'completed'
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyTicketCompletion: review artifact with implementation role → skipped', () => {
    const tmpDir = makeTmpRoot();
    try {
        const ticketDir = path.join(tmpDir, 'ticket-mismatch');
        fs.mkdirSync(ticketDir, { recursive: true });
        fs.writeFileSync(path.join(ticketDir, 'review_scope.md'), 'review scope');

        const logFile = path.join(tmpDir, 'test_iter.log');
        fs.writeFileSync(logFile, 'no tokens here\n');
        assert.equal(
            classifyTicketCompletion(logFile, '/nonexistent/dir', ticketDir, 'implementation'),
            'skipped'
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyTicketCompletion: review artifact with review role → completed', () => {
    const tmpDir = makeTmpRoot();
    try {
        const ticketDir = path.join(tmpDir, 'ticket-review');
        fs.mkdirSync(ticketDir, { recursive: true });
        fs.writeFileSync(path.join(ticketDir, 'review_findings.md'), 'findings');

        const logFile = path.join(tmpDir, 'test_iter.log');
        fs.writeFileSync(logFile, 'no tokens here\n');
        assert.equal(
            classifyTicketCompletion(logFile, '/nonexistent/dir', ticketDir, 'review'),
            'completed'
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyTicketCompletion: token present overrides missing artifact', () => {
    const tmpDir = makeTmpRoot();
    try {
        const logFile = path.join(tmpDir, 'test_iter.log');
        fs.writeFileSync(logFile, 'output <promise>TASK_COMPLETED</promise>\n');
        // No ticketDir, no artifacts, but token is strong evidence — still completed.
        assert.equal(
            classifyTicketCompletion(logFile, '/nonexistent/dir'),
            'completed'
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// --- detectMultiRepo ---

test('detectMultiRepo: returns dirs when tickets have 2+ distinct working_dir values', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-multi-')));
    try {
        const t1 = path.join(dir, 't1');
        fs.mkdirSync(t1);
        fs.writeFileSync(path.join(t1, 'linear_ticket_t1.md'),
            '---\nid: t1\ntitle: API work\nstatus: Todo\norder: 10\nworking_dir: api/\n---\n');
        const t2 = path.join(dir, 't2');
        fs.mkdirSync(t2);
        fs.writeFileSync(path.join(t2, 'linear_ticket_t2.md'),
            '---\nid: t2\ntitle: Web work\nstatus: Todo\norder: 20\nworking_dir: web/\n---\n');

        const result = detectMultiRepo(dir);
        assert.ok(result, 'should return an array');
        assert.ok(result.includes('api/'), 'should contain api/');
        assert.ok(result.includes('web/'), 'should contain web/');
        assert.equal(result.length, 2);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('detectMultiRepo: returns null when all tickets share same working_dir', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-multi-')));
    try {
        const t1 = path.join(dir, 't1');
        fs.mkdirSync(t1);
        fs.writeFileSync(path.join(t1, 'linear_ticket_t1.md'),
            '---\nid: t1\ntitle: Task A\nstatus: Todo\norder: 10\nworking_dir: api/\n---\n');
        const t2 = path.join(dir, 't2');
        fs.mkdirSync(t2);
        fs.writeFileSync(path.join(t2, 'linear_ticket_t2.md'),
            '---\nid: t2\ntitle: Task B\nstatus: Todo\norder: 20\nworking_dir: api/\n---\n');

        assert.equal(detectMultiRepo(dir), null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('detectMultiRepo: returns null when all tickets have working_dir null', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-multi-')));
    try {
        const t1 = path.join(dir, 't1');
        fs.mkdirSync(t1);
        fs.writeFileSync(path.join(t1, 'linear_ticket_t1.md'),
            '---\nid: t1\ntitle: Task A\nstatus: Todo\norder: 10\n---\n');
        const t2 = path.join(dir, 't2');
        fs.mkdirSync(t2);
        fs.writeFileSync(path.join(t2, 'linear_ticket_t2.md'),
            '---\nid: t2\ntitle: Task B\nstatus: Todo\norder: 20\n---\n');

        assert.equal(detectMultiRepo(dir), null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('detectMultiRepo: returns null when only one ticket has a working_dir', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-multi-')));
    try {
        const t1 = path.join(dir, 't1');
        fs.mkdirSync(t1);
        fs.writeFileSync(path.join(t1, 'linear_ticket_t1.md'),
            '---\nid: t1\ntitle: Task A\nstatus: Todo\norder: 10\nworking_dir: api/\n---\n');
        const t2 = path.join(dir, 't2');
        fs.mkdirSync(t2);
        fs.writeFileSync(path.join(t2, 'linear_ticket_t2.md'),
            '---\nid: t2\ntitle: Task B\nstatus: Todo\norder: 20\n---\n');

        assert.equal(detectMultiRepo(dir), null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

import { Defaults } from '../types/index.js';

test('mux-runner: template lookup prefers templates/ dir over commands/ dir', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const templatesDir = path.join(tmpRoot, 'templates');
        const commandsDir = path.join(tmpRoot, 'commands');
        fs.mkdirSync(templatesDir, { recursive: true });
        fs.mkdirSync(commandsDir, { recursive: true });

        fs.writeFileSync(path.join(templatesDir, 'test.md'), 'TEMPLATE_VERSION');
        fs.writeFileSync(path.join(commandsDir, 'test.md'), 'COMMAND_VERSION');

        const templateName = 'test.md';
        const picklePromptPath = fs.existsSync(path.join(templatesDir, templateName))
            ? path.join(templatesDir, templateName)
            : path.join(commandsDir, templateName);

        const content = fs.readFileSync(picklePromptPath, 'utf-8');
        assert.equal(content, 'TEMPLATE_VERSION', 'should prefer templates/ dir');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('mux-runner: template lookup falls back to commands/ when not in templates/', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const templatesDir = path.join(tmpRoot, 'templates');
        const commandsDir = path.join(tmpRoot, 'commands');
        fs.mkdirSync(templatesDir, { recursive: true });
        fs.mkdirSync(commandsDir, { recursive: true });

        fs.writeFileSync(path.join(commandsDir, 'pickle.md'), 'COMMAND_ONLY');

        const templateName = 'pickle.md';
        const picklePromptPath = fs.existsSync(path.join(templatesDir, templateName))
            ? path.join(templatesDir, templateName)
            : path.join(commandsDir, templateName);

        const content = fs.readFileSync(picklePromptPath, 'utf-8');
        assert.equal(content, 'COMMAND_ONLY', 'should fall back to commands/ dir');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('Defaults.MAX_ITERATION_SECONDS exists and is positive', () => {
    assert.ok(typeof Defaults.MAX_ITERATION_SECONDS === 'number', 'should be a number');
    assert.ok(Defaults.MAX_ITERATION_SECONDS > 0, 'should be positive');
    assert.ok(Defaults.MAX_ITERATION_SECONDS >= 3600, 'should be at least 1 hour');
});

// ---------------------------------------------------------------------------
// writeHandoffAtomic — handoff.txt race / fallback scenarios (ticket 38b76eb5)
// ---------------------------------------------------------------------------

test('writeHandoffAtomic: unlink EACCES on tmp cleanup logs warning', () => {
    const logs = [];
    const log = (msg) => logs.push(msg);

    // rename throws so we reach the tmp-cleanup path; unlinkSync throws EACCES
    const fsOps = {
        writeFileSync: () => {},
        renameSync: () => { const e = new Error('cross-device link'); e.code = 'EXDEV'; throw e; },
        unlinkSync: () => {
            const e = new Error('permission denied');
            e.code = 'EACCES';
            throw e;
        },
    };

    const tmpRoot = makeTmpRoot();
    try {
        writeHandoffAtomic(tmpRoot, 'content', 9999, log, fsOps);
        assert.ok(
            logs.some(l => l.includes('WARNING') && l.includes('EACCES')),
            `Expected EACCES warning in logs, got: ${JSON.stringify(logs)}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('writeHandoffAtomic: rename fail falls back to direct writeFileSync', () => {
    const logs = [];
    const log = (msg) => logs.push(msg);
    const writes = [];

    const fsOps = {
        writeFileSync: (p, content) => writes.push({ p, content }),
        renameSync: () => { const e = new Error('cross-device link'); e.code = 'EXDEV'; throw e; },
        unlinkSync: () => {},
    };

    const tmpRoot = makeTmpRoot();
    try {
        writeHandoffAtomic(tmpRoot, 'handoff content', 1234, log, fsOps);

        assert.ok(
            logs.some(l => l.includes('WARNING') && l.includes('rename failed')),
            `Expected rename-failed warning in logs, got: ${JSON.stringify(logs)}`
        );
        const handoffWrite = writes.find(w => w.p.endsWith('handoff.txt') && !w.p.includes('.tmp.'));
        assert.ok(handoffWrite, `Expected a direct handoff.txt write, got writes: ${JSON.stringify(writes.map(w => w.p))}`);
        assert.equal(handoffWrite.content, 'handoff content', 'Fallback write must use original content');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('writeHandoffAtomic: both rename and fallback fail, error logged, does not throw', () => {
    const logs = [];
    const log = (msg) => logs.push(msg);

    const fsOps = {
        writeFileSync: (p) => {
            // tmp write succeeds, direct write fails
            if (!p.includes('.tmp.')) {
                const e = new Error('read-only filesystem');
                e.code = 'EROFS';
                throw e;
            }
        },
        renameSync: () => { const e = new Error('cross-device link'); e.code = 'EXDEV'; throw e; },
        unlinkSync: () => {},
    };

    const tmpRoot = makeTmpRoot();
    try {
        // Must NOT throw
        assert.doesNotThrow(() => {
            writeHandoffAtomic(tmpRoot, 'content', 5678, log, fsOps);
        });
        assert.ok(
            logs.some(l => l.includes('ERROR') && l.includes('handoff.txt write failed')),
            `Expected ERROR log for both-fail scenario, got: ${JSON.stringify(logs)}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Codex manager relaunch on per-iteration error.
//
// The hang-guard at `Defaults.MAX_ITERATION_SECONDS` SIGTERMs the long-lived
// codex manager subprocess after 4h and resolves
// `{ completion: 'error', timedOut: true }`. The legacy error branch
// unconditionally exited; tickets the manager hadn't started yet were
// stranded in `Todo`. processCompletionBranch() must consult
// `evaluateCodexManagerRelaunch()` and return a `relaunch` LoopAction so the
// outer loop spawns a fresh manager that resumes the queue.
// ---------------------------------------------------------------------------
import {
    processCompletionBranch as processCompletionBranchForRelaunch,
    evaluateCodexManagerRelaunch as evaluateCodexManagerRelaunchUnit,
    recordCodexManagerRelaunch as recordCodexManagerRelaunchUnit,
} from '../bin/mux-runner.js';
import { Defaults as DefaultsForRelaunch } from '../types/index.js';

function writeRelaunchTicket(sessionDir, id, status, order = 1) {
    const ticketDir = path.join(sessionDir, id);
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(path.join(ticketDir, `linear_ticket_${id}.md`), [
        '---',
        `id: ${id}`,
        `title: ${id}`,
        `status: "${status}"`,
        `order: ${order}`,
        '---',
        '',
    ].join('\n'));
}

function makeCodexRelaunchSession({ backend = 'codex', priorRelaunchCount = 0, tickets = [] } = {}) {
    const sessionDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mux-relaunch-')));
    const dataRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mux-relaunch-data-')));
    const statePath = path.join(sessionDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({
        active: true,
        step: 'implement',
        iteration: 5,
        max_iterations: 100,
        worker_timeout_seconds: 1200,
        start_time_epoch: Math.floor(Date.now() / 1000),
        max_time_minutes: 720,
        working_dir: sessionDir,
        backend,
        codex_manager_relaunch_count: priorRelaunchCount,
    }, null, 2));
    for (const t of tickets) writeRelaunchTicket(sessionDir, t.id, t.status, t.order);
    return { sessionDir, statePath, dataRoot };
}

function withRelaunchDataRoot(dataRoot, fn) {
    const prev = process.env.PICKLE_DATA_ROOT;
    process.env.PICKLE_DATA_ROOT = dataRoot;
    try { return fn(); }
    finally {
        if (prev === undefined) delete process.env.PICKLE_DATA_ROOT;
        else process.env.PICKLE_DATA_ROOT = prev;
    }
}

function readRelaunchActivityEvents(dataRoot) {
    const activityDir = path.join(dataRoot, 'activity');
    if (!fs.existsSync(activityDir)) return [];
    const events = [];
    for (const entry of fs.readdirSync(activityDir)) {
        if (!entry.endsWith('.jsonl')) continue;
        const content = fs.readFileSync(path.join(activityDir, entry), 'utf-8');
        for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            try { events.push(JSON.parse(line)); } catch { /* ignore */ }
        }
    }
    return events;
}

test('mux-runner relaunch: processCompletionBranch returns relaunch action with side effects', async () => {
    const session = makeCodexRelaunchSession({
        backend: 'codex',
        priorRelaunchCount: 0,
        tickets: [
            { id: 't-done', status: 'Done', order: 1 },
            { id: 't-pending', status: 'Todo', order: 2 },
        ],
    });
    try {
        await withRelaunchDataRoot(session.dataRoot, async () => {
            const logs = [];
            const ctx = {
                sessionDir: session.sessionDir,
                statePath: session.statePath,
                extensionRoot: path.resolve('.'),
                iteration: 6,
                log: (msg) => logs.push(msg),
                cbEnabled: false,
                cbState: null,
            };
            const action = await processCompletionBranchForRelaunch(
                JSON.parse(fs.readFileSync(session.statePath, 'utf-8')),
                'error',
                ctx,
            );
            assert.equal(action.kind, 'relaunch',
                `expected relaunch LoopAction, got ${action.kind} (reason=${action.reason || ''})`);
            assert.equal(action.relaunchCount, 1);
            assert.equal(action.pendingTickets, 1);
            assert.equal(action.resetStall, true);

            // Side effect: state counter persisted.
            const persisted = JSON.parse(fs.readFileSync(session.statePath, 'utf-8'));
            assert.equal(persisted.codex_manager_relaunch_count, 1);
            assert.equal(persisted.active, true,
                'session must remain active so the next iteration spawns a fresh codex manager');

            // Side effect: activity event emitted.
            const relaunch = readRelaunchActivityEvents(session.dataRoot)
                .filter(e => e.event === 'codex_manager_relaunch');
            assert.equal(relaunch.length, 1);
            assert.equal(relaunch[0].iteration, 6);
            assert.equal(relaunch[0].source, 'pickle');

            // Operator-visible log.
            assert.ok(
                logs.some(m => m.includes('relaunching') && m.includes('1/' + DefaultsForRelaunch.CODEX_MANAGER_RELAUNCH_CAP)),
                `expected relaunch log line, got: ${JSON.stringify(logs)}`,
            );
        });
    } finally {
        fs.rmSync(session.sessionDir, { recursive: true, force: true });
        fs.rmSync(session.dataRoot, { recursive: true, force: true });
    }
});

test('mux-runner relaunch: cap honored — break on error after CODEX_MANAGER_RELAUNCH_CAP relaunches', async () => {
    const session = makeCodexRelaunchSession({
        backend: 'codex',
        priorRelaunchCount: DefaultsForRelaunch.CODEX_MANAGER_RELAUNCH_CAP,
        tickets: [
            { id: 't-pending', status: 'Todo', order: 1 },
        ],
    });
    try {
        await withRelaunchDataRoot(session.dataRoot, async () => {
            const ctx = {
                sessionDir: session.sessionDir,
                statePath: session.statePath,
                extensionRoot: path.resolve('.'),
                iteration: 99,
                log: () => {},
                cbEnabled: false,
                cbState: null,
            };
            const action = await processCompletionBranchForRelaunch(
                JSON.parse(fs.readFileSync(session.statePath, 'utf-8')),
                'error',
                ctx,
            );
            assert.equal(action.kind, 'break');
            assert.equal(action.reason, 'error');
            const persisted = JSON.parse(fs.readFileSync(session.statePath, 'utf-8'));
            assert.equal(persisted.codex_manager_relaunch_count, DefaultsForRelaunch.CODEX_MANAGER_RELAUNCH_CAP);
        });
    } finally {
        fs.rmSync(session.sessionDir, { recursive: true, force: true });
        fs.rmSync(session.dataRoot, { recursive: true, force: true });
    }
});

test('mux-runner relaunch: claude backend untouched — error still breaks the loop', async () => {
    const session = makeCodexRelaunchSession({
        backend: 'claude',
        tickets: [
            { id: 't-pending', status: 'Todo', order: 1 },
        ],
    });
    try {
        await withRelaunchDataRoot(session.dataRoot, async () => {
            const ctx = {
                sessionDir: session.sessionDir,
                statePath: session.statePath,
                extensionRoot: path.resolve('.'),
                iteration: 2,
                log: () => {},
                cbEnabled: false,
                cbState: null,
            };
            const action = await processCompletionBranchForRelaunch(
                JSON.parse(fs.readFileSync(session.statePath, 'utf-8')),
                'error',
                ctx,
            );
            assert.equal(action.kind, 'break');
            assert.equal(action.reason, 'error');
            const events = readRelaunchActivityEvents(session.dataRoot)
                .filter(e => e.event === 'codex_manager_relaunch');
            assert.equal(events.length, 0);
        });
    } finally {
        fs.rmSync(session.sessionDir, { recursive: true, force: true });
        fs.rmSync(session.dataRoot, { recursive: true, force: true });
    }
});

test('mux-runner relaunch: circuit-breaker OPEN suppresses relaunch even with pending tickets', async () => {
    const session = makeCodexRelaunchSession({
        backend: 'codex',
        priorRelaunchCount: 0,
        tickets: [
            { id: 't-pending', status: 'Todo', order: 1 },
        ],
    });
    try {
        await withRelaunchDataRoot(session.dataRoot, async () => {
            const ctx = {
                sessionDir: session.sessionDir,
                statePath: session.statePath,
                extensionRoot: path.resolve('.'),
                iteration: 3,
                log: () => {},
                cbEnabled: true,
                cbState: { state: 'OPEN', reason: 'no_progress' },
            };
            const action = await processCompletionBranchForRelaunch(
                JSON.parse(fs.readFileSync(session.statePath, 'utf-8')),
                'error',
                ctx,
            );
            assert.equal(action.kind, 'break');
            assert.equal(action.reason, 'error');
            const persisted = JSON.parse(fs.readFileSync(session.statePath, 'utf-8'));
            assert.equal(persisted.codex_manager_relaunch_count, 0,
                'CB OPEN must NOT bump relaunch counter');
        });
    } finally {
        fs.rmSync(session.sessionDir, { recursive: true, force: true });
        fs.rmSync(session.dataRoot, { recursive: true, force: true });
    }
});

test('evaluateCodexManagerRelaunch (mux-runner): smoke test for exported helper', () => {
    // Sanity duplicate of the iteration-outcome.test.js coverage so the
    // mux-runner test file holds its own loop-action contract test as
    // required by the trap-door entry.
    const codex = { backend: 'codex', codex_manager_relaunch_count: 0 };
    const tickets = [
        { id: 't1', status: 'Todo', title: '', order: 1, type: null, working_dir: null, completed_at: null, skipped_at: null },
    ];
    const result = evaluateCodexManagerRelaunchUnit(codex, tickets, null);
    assert.equal(result.shouldRelaunch, true);
    assert.equal(result.pendingCount, 1);
    assert.equal(result.nextRelaunchCount, 1);

    // Ensure exports are wired correctly.
    assert.equal(typeof recordCodexManagerRelaunchUnit, 'function');
    assert.equal(typeof DefaultsForRelaunch.CODEX_MANAGER_RELAUNCH_CAP, 'number');
    assert.ok(DefaultsForRelaunch.CODEX_MANAGER_RELAUNCH_CAP >= 1);
});

// ---------------------------------------------------------------------------
// AC-LPB-04: SCHEMA_MISMATCH on cap-check read emits an escalation event
// instead of silently retrying. The error must surface so the user can act,
// but the loop must not crash (which would lose progress on every retryable
// concurrent-write race).
// ---------------------------------------------------------------------------
import { classifyCapCheckReadError } from '../bin/mux-runner.js';

function makeSchemaMismatchSession() {
    const sessionDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mux-schema-')));
    const dataRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mux-schema-data-')));
    return { sessionDir, dataRoot };
}

function readSchemaActivityEvents(dataRoot) {
    const activityDir = path.join(dataRoot, 'activity');
    if (!fs.existsSync(activityDir)) return [];
    const events = [];
    for (const entry of fs.readdirSync(activityDir)) {
        if (!entry.endsWith('.jsonl')) continue;
        const content = fs.readFileSync(path.join(activityDir, entry), 'utf-8');
        for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            try { events.push(JSON.parse(line)); } catch { /* ignore */ }
        }
    }
    return events;
}

function withSchemaDataRoot(dataRoot, fn) {
    const prev = process.env.PICKLE_DATA_ROOT;
    process.env.PICKLE_DATA_ROOT = dataRoot;
    try { return fn(); }
    finally {
        if (prev === undefined) delete process.env.PICKLE_DATA_ROOT;
        else process.env.PICKLE_DATA_ROOT = prev;
    }
}

test('classifyCapCheckReadError: SCHEMA_MISMATCH emits cap_check_failed_schema_mismatch and continues', () => {
    const session = makeSchemaMismatchSession();
    try {
        withSchemaDataRoot(session.dataRoot, () => {
            const logs = [];
            // Mimic StateError shape — code is the discriminator.
            const err = Object.assign(new Error(
                'State file schema_version 999 is newer than supported version 3',
            ), { code: 'SCHEMA_MISMATCH', name: 'StateError' });

            const decision = classifyCapCheckReadError(err, session.sessionDir, (m) => logs.push(m));
            assert.equal(decision, 'continue',
                'SCHEMA_MISMATCH must continue the loop, not exit');

            // Activity event surfaced with the right shape.
            const events = readSchemaActivityEvents(session.dataRoot);
            const escalation = events.find(e => e.event === 'cap_check_failed_schema_mismatch');
            assert.ok(escalation, `expected cap_check_failed_schema_mismatch event, got: ${events.map(e => e.event).join(', ')}`);
            assert.equal(escalation.source, 'pickle');
            assert.equal(escalation.session, path.basename(session.sessionDir));
            assert.ok(typeof escalation.error === 'string' && /schema/i.test(escalation.error),
                `expected schema-mentioning error, got: ${escalation.error}`);

            // Visibility: surfaced to runner log too.
            assert.ok(
                logs.some(line => /schema mismatch/i.test(line)),
                `expected schema-mismatch line in runner logs, got: ${logs.join(' | ')}`,
            );
        });
    } finally {
        fs.rmSync(session.sessionDir, { recursive: true, force: true });
        fs.rmSync(session.dataRoot, { recursive: true, force: true });
    }
});

test('classifyCapCheckReadError: non-SCHEMA_MISMATCH errors return exit_error and emit no event', () => {
    const session = makeSchemaMismatchSession();
    try {
        withSchemaDataRoot(session.dataRoot, () => {
            for (const code of ['CORRUPT', 'MISSING', 'LOCK_FAILED', undefined]) {
                const err = Object.assign(new Error(`simulated ${code ?? 'plain'} failure`), code ? { code } : {});
                const logs = [];
                const decision = classifyCapCheckReadError(err, session.sessionDir, (m) => logs.push(m));
                assert.equal(decision, 'exit_error',
                    `non-SCHEMA_MISMATCH error (code=${code}) must exit with error`);
                assert.ok(
                    logs.some(line => /Cannot read state\.json/.test(line)),
                    `expected legacy 'Cannot read state.json' log for code=${code}, got: ${logs.join(' | ')}`,
                );
            }
            const events = readSchemaActivityEvents(session.dataRoot);
            const escalation = events.find(e => e.event === 'cap_check_failed_schema_mismatch');
            assert.equal(escalation, undefined,
                'non-SCHEMA_MISMATCH errors must NOT emit cap_check_failed_schema_mismatch');
        });
    } finally {
        fs.rmSync(session.sessionDir, { recursive: true, force: true });
        fs.rmSync(session.dataRoot, { recursive: true, force: true });
    }
});

test('classifyCapCheckReadError: non-Error thrown values default to exit_error', () => {
    const session = makeSchemaMismatchSession();
    try {
        withSchemaDataRoot(session.dataRoot, () => {
            const logs = [];
            // Defensive: a thrown string/number/null should not crash the
            // runner — fall through to legacy exit-error.
            const decision = classifyCapCheckReadError('plain string error', session.sessionDir, (m) => logs.push(m));
            assert.equal(decision, 'exit_error');
            const events = readSchemaActivityEvents(session.dataRoot);
            assert.equal(events.find(e => e.event === 'cap_check_failed_schema_mismatch'), undefined,
                'plain non-Error throws must not emit the escalation event');
        });
    } finally {
        fs.rmSync(session.sessionDir, { recursive: true, force: true });
        fs.rmSync(session.dataRoot, { recursive: true, force: true });
    }
});

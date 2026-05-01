import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { VALID_ACTIVITY_EVENTS } from '../types/index.js';
import { _setRetryDelayMs, _getPendingBuffer, _clearPendingBuffer } from '../services/activity-logger.js';
import { formatLocalDateKey } from '../services/pickle-utils.js';
import { readActivityFiles } from '../bin/standup.js';

// Helper: create temp dir that acts as extension root, return activity dir path
function withTempActivityDir(fn) {
    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-activity-'));
    const activityDir = path.join(extRoot, 'activity');
    const origEnv = process.env.EXTENSION_DIR;
    process.env.EXTENSION_DIR = extRoot;
    try {
        fn(activityDir, extRoot);
    } finally {
        process.env.EXTENSION_DIR = origEnv;
        if (origEnv === undefined) delete process.env.EXTENSION_DIR;
        fs.rmSync(extRoot, { recursive: true, force: true });
    }
}

// Re-import logActivity fresh per test to pick up env changes
async function getLogActivity() {
    // Dynamic import with cache-busting query param won't work in Node ESM,
    // but since EXTENSION_DIR is read at call time (not import time), static import is fine.
    const mod = await import('../services/activity-logger.js');
    return mod.logActivity;
}

function localDateWithOffset(daysOffset, hour = 12) {
    const d = new Date();
    d.setHours(hour, 0, 0, 0);
    d.setDate(d.getDate() + daysOffset);
    return d;
}

function withBrokenCanadianDateLocale(fn) {
    const original = Date.prototype.toLocaleDateString;
    Date.prototype.toLocaleDateString = function (locale, ...args) {
        if (locale === 'en-CA') {
            return '04/27/2026';
        }
        return original.call(this, locale, ...args);
    };
    try {
        fn();
    } finally {
        Date.prototype.toLocaleDateString = original;
    }
}

// --- VALID_ACTIVITY_EVENTS ---

test('VALID_ACTIVITY_EVENTS contains all 52 expected event types', () => {
    const expected = [
        'session_start', 'session_end', 'ticket_completed', 'epic_completed',
        'meeseeks_pass', 'commit', 'research', 'bug_fix', 'feature',
        'refactor', 'review', 'jar_start', 'jar_end',
        'circuit_open', 'circuit_recovery',
        'iteration_start', 'iteration_end',
        'rate_limit_wait', 'rate_limit_resume', 'rate_limit_exhausted',
        'multi_repo_warning', 'meeseeks_model_select',
        'pending_tickets_on_completion',
        'manager_false_epic_completed', 'manager_persistent_hallucination',
        'gate_baseline_captured', 'gate_run_complete', 'gate_skipped',
        'gate_unsafe_test_command_blocked', 'gate_remediation_complete',
        'gate_remediation_aborted_unverified_production_change',
        'gate_autofix_reverted', 'gate_workingdir_drift_detected',
        'gate_lock_acquired', 'gate_lock_timeout', 'gate_diff_scope_fallback',
        'gate_preexisting_tests_baselined', 'iteration_left_regression',
        'gate_regression_threshold_warning', 'gate_out_of_scope_failures_present',
        'commit_pending_probe_fired',
        'codex_manager_relaunch',
        'readiness_failed_post_correction',
        'archaeology_complete',
        'archaeology_skipped',
        'phase_personas_disabled_seen',
        'debate_solo_auto',
        'debate_user_declined_auto_promote',
        'debate_invalidated_by_correction',
        'debate_round_truncated',
        // AC-LPB-05: pipeline-runner / setup.ts emit on session reconstruction
        // so monitor/standup can distinguish fresh launches from resumed runs.
        'session_reconstructed_epoch_reset',
        // AC-LPB-04: mux-runner cap-check read swallows SCHEMA_MISMATCH
        // recoverably and surfaces it as an activity event so monitor/standup
        // can flag the deploy-drift class of failures.
        'cap_check_failed_schema_mismatch',
    ];
    assert.equal(VALID_ACTIVITY_EVENTS.length, 52);
    for (const e of expected) {
        assert.ok(VALID_ACTIVITY_EVENTS.includes(e), `Missing event type: ${e}`);
    }
});

test('VALID_ACTIVITY_EVENTS has no duplicates', () => {
    const unique = new Set(VALID_ACTIVITY_EVENTS);
    assert.equal(unique.size, VALID_ACTIVITY_EVENTS.length, 'should have no duplicate event types');
});

// --- logActivity ---

test('logActivity: appends valid JSONL to date-named file', async () => {
    const logActivity = await getLogActivity();
    withTempActivityDir((activityDir) => {
        logActivity({ event: 'commit', source: 'hook', commit_hash: 'abc1234' });
        const date = formatLocalDateKey(new Date());
        const filepath = path.join(activityDir, `${date}.jsonl`);
        assert.ok(fs.existsSync(filepath), 'JSONL file should exist');
        const line = fs.readFileSync(filepath, 'utf8').trim();
        const parsed = JSON.parse(line);
        assert.equal(parsed.event, 'commit');
        assert.equal(parsed.source, 'hook');
        assert.equal(parsed.commit_hash, 'abc1234');
    });
});

test('logActivity: sets ts field automatically', async () => {
    const logActivity = await getLogActivity();
    withTempActivityDir((activityDir) => {
        const before = new Date().toISOString();
        logActivity({ event: 'session_start', source: 'pickle' });
        const after = new Date().toISOString();
        const date = formatLocalDateKey(new Date());
        const filepath = path.join(activityDir, `${date}.jsonl`);
        const parsed = JSON.parse(fs.readFileSync(filepath, 'utf8').trim());
        assert.ok(parsed.ts >= before, 'ts should be >= test start');
        assert.ok(parsed.ts <= after, 'ts should be <= test end');
    });
});

test('logActivity: preserves caller-provided ts', async () => {
    const logActivity = await getLogActivity();
    withTempActivityDir((activityDir) => {
        const customDate = localDateWithOffset(-1);
        const customTs = customDate.toISOString();
        logActivity({ event: 'commit', source: 'hook', ts: customTs });
        const date = formatLocalDateKey(customDate);
        const filepath = path.join(activityDir, `${date}.jsonl`);
        const parsed = JSON.parse(fs.readFileSync(filepath, 'utf8').trim());
        assert.equal(parsed.ts, customTs);
    });
});

test('logActivity: uses strict YYYY-MM-DD partitions even when locale formatting falls back', async () => {
    const logActivity = await getLogActivity();
    withTempActivityDir((activityDir) => {
        const eventDate = new Date(2026, 3, 27, 12, 0, 0, 0);
        const eventTs = eventDate.toISOString();

        withBrokenCanadianDateLocale(() => {
            logActivity({ event: 'commit', source: 'hook', ts: eventTs, commit_hash: 'locale-bug' });
        });

        const expectedDate = formatLocalDateKey(eventDate);
        const expectedFile = path.join(activityDir, `${expectedDate}.jsonl`);
        assert.ok(fs.existsSync(expectedFile), 'event should be written under an ISO local-day filename');
        assert.equal(fs.existsSync(path.join(activityDir, '04/27/2026.jsonl')), false, 'locale fallback filename should never be used');

        const since = new Date(2026, 3, 27, 0, 0, 0, 0);
        const until = new Date(2026, 3, 28, 0, 0, 0, 0);
        const events = readActivityFiles(activityDir, since, until);
        assert.equal(events.length, 1);
        assert.equal(events[0].commit_hash, 'locale-bug');
    });
});

test('logActivity: creates activity dir if missing', async () => {
    const logActivity = await getLogActivity();
    withTempActivityDir((activityDir) => {
        assert.ok(!fs.existsSync(activityDir), 'activity dir should not exist yet');
        logActivity({ event: 'feature', source: 'persona', title: 'test' });
        assert.ok(fs.existsSync(activityDir), 'activity dir should be created');
    });
});

test('logActivity: multiple events append to same file', async () => {
    const logActivity = await getLogActivity();
    withTempActivityDir((activityDir) => {
        logActivity({ event: 'session_start', source: 'pickle' });
        logActivity({ event: 'ticket_completed', source: 'pickle', ticket: 'abc' });
        logActivity({ event: 'session_end', source: 'pickle' });
        const date = formatLocalDateKey(new Date());
        const filepath = path.join(activityDir, `${date}.jsonl`);
        const lines = fs.readFileSync(filepath, 'utf8').trim().split('\n');
        assert.equal(lines.length, 3);
        assert.equal(JSON.parse(lines[0]).event, 'session_start');
        assert.equal(JSON.parse(lines[1]).event, 'ticket_completed');
        assert.equal(JSON.parse(lines[2]).event, 'session_end');
    });
});

test('logActivity: silently catches errors on read-only directory', async () => {
    const logActivity = await getLogActivity();
    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-activity-'));
    const activityDir = path.join(extRoot, 'activity');
    fs.mkdirSync(activityDir);
    fs.chmodSync(activityDir, 0o444);
    const origEnv = process.env.EXTENSION_DIR;
    process.env.EXTENSION_DIR = extRoot;
    try {
        assert.doesNotThrow(() => {
            logActivity({ event: 'commit', source: 'hook' });
        });
    } finally {
        fs.chmodSync(activityDir, 0o755);
        process.env.EXTENSION_DIR = origEnv;
        if (origEnv === undefined) delete process.env.EXTENSION_DIR;
        fs.rmSync(extRoot, { recursive: true, force: true });
    }
});

test('logActivity: file permissions are 0o600', async () => {
    const logActivity = await getLogActivity();
    withTempActivityDir((activityDir) => {
        logActivity({ event: 'feature', source: 'persona', title: 'test perms' });
        const date = formatLocalDateKey(new Date());
        const filepath = path.join(activityDir, `${date}.jsonl`);
        const stats = fs.statSync(filepath);
        const mode = stats.mode & 0o777;
        assert.equal(mode, 0o600, `Expected 0o600, got 0o${mode.toString(8)}`);
    });
});

test('logActivity: includes all provided optional fields', async () => {
    const logActivity = await getLogActivity();
    withTempActivityDir((activityDir) => {
        logActivity({
            event: 'ticket_completed',
            source: 'pickle',
            session: 'sess-123',
            ticket: 'abc',
            step: 'implement',
            epic: 'my-epic',
        });
        const date = formatLocalDateKey(new Date());
        const filepath = path.join(activityDir, `${date}.jsonl`);
        const parsed = JSON.parse(fs.readFileSync(filepath, 'utf8').trim());
        assert.equal(parsed.session, 'sess-123');
        assert.equal(parsed.ticket, 'abc');
        assert.equal(parsed.step, 'implement');
        assert.equal(parsed.epic, 'my-epic');
    });
});

// --- Iteration events and new fields ---

test('logActivity: iteration_start event preserves iteration field', async () => {
    const logActivity = await getLogActivity();
    withTempActivityDir((activityDir) => {
        logActivity({ event: 'iteration_start', source: 'pickle', iteration: 3, session: 'sess-abc' });
        const date = formatLocalDateKey(new Date());
        const filepath = path.join(activityDir, `${date}.jsonl`);
        const parsed = JSON.parse(fs.readFileSync(filepath, 'utf8').trim());
        assert.equal(parsed.event, 'iteration_start');
        assert.equal(parsed.iteration, 3);
        assert.equal(parsed.session, 'sess-abc');
    });
});

test('logActivity: iteration_end event preserves iteration and exit_type fields', async () => {
    const logActivity = await getLogActivity();
    withTempActivityDir((activityDir) => {
        logActivity({ event: 'iteration_end', source: 'pickle', iteration: 5, exit_type: 'error' });
        const date = formatLocalDateKey(new Date());
        const filepath = path.join(activityDir, `${date}.jsonl`);
        const parsed = JSON.parse(fs.readFileSync(filepath, 'utf8').trim());
        assert.equal(parsed.event, 'iteration_end');
        assert.equal(parsed.iteration, 5);
        assert.equal(parsed.exit_type, 'error');
    });
});

test('logActivity: session_start event preserves original_prompt field', async () => {
    const logActivity = await getLogActivity();
    withTempActivityDir((activityDir) => {
        logActivity({ event: 'session_start', source: 'pickle', original_prompt: 'Build the portal gun' });
        const date = formatLocalDateKey(new Date());
        const filepath = path.join(activityDir, `${date}.jsonl`);
        const parsed = JSON.parse(fs.readFileSync(filepath, 'utf8').trim());
        assert.equal(parsed.event, 'session_start');
        assert.equal(parsed.original_prompt, 'Build the portal gun');
    });
});

// --- CLI: log-activity.js ---

const CLI_PATH = path.join(import.meta.dirname, '..', 'bin', 'log-activity.js');

function runCli(args, env = {}) {
    // 10s → 30s: budget for system load when run alongside concurrent
    // codex/tmux work. Tests validate CLI behavior, not wall-clock.
    return spawnSync(process.execPath, [CLI_PATH, ...args], {
        encoding: 'utf-8',
        timeout: 30000,
        env: { ...process.env, ...env },
    });
}

test('CLI: rejects unknown event type', () => {
    const result = runCli(['invalid_type', 'some title']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown event type/);
});

test('CLI: rejects missing event type', () => {
    const result = runCli([]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage/);
});

test('CLI: rejects -- prefixed event type', () => {
    const result = runCli(['--commit', 'some title']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage/);
});

test('CLI: rejects missing title', () => {
    const result = runCli(['feature']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Title is required/);
});

test('CLI: rejects -- prefixed title', () => {
    const result = runCli(['feature', '--verbose']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Title is required/);
});

test('CLI: rejects empty title after sanitization', () => {
    const result = runCli(['feature', '\n\r']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /empty/);
});

test('CLI: valid call exits 0 and writes event', () => {
    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-activity-'));
    try {
        const result = runCli(['bug_fix', 'Fixed the auth race'], { EXTENSION_DIR: extRoot });
        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
        const activityDir = path.join(extRoot, 'activity');
        const date = formatLocalDateKey(new Date());
        const filepath = path.join(activityDir, `${date}.jsonl`);
        assert.ok(fs.existsSync(filepath), 'JSONL file should exist');
        const parsed = JSON.parse(fs.readFileSync(filepath, 'utf8').trim());
        assert.equal(parsed.event, 'bug_fix');
        assert.equal(parsed.source, 'persona');
        assert.equal(parsed.title, 'Fixed the auth race');
    } finally {
        fs.rmSync(extRoot, { recursive: true, force: true });
    }
});

test('CLI: strips newlines from title', () => {
    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-activity-'));
    try {
        const result = runCli(['feature', 'line1\nline2\rline3'], { EXTENSION_DIR: extRoot });
        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
        const activityDir = path.join(extRoot, 'activity');
        const date = formatLocalDateKey(new Date());
        const filepath = path.join(activityDir, `${date}.jsonl`);
        const parsed = JSON.parse(fs.readFileSync(filepath, 'utf8').trim());
        assert.ok(!parsed.title.includes('\n'), 'title should not contain \\n');
        assert.ok(!parsed.title.includes('\r'), 'title should not contain \\r');
    } finally {
        fs.rmSync(extRoot, { recursive: true, force: true });
    }
});

test('CLI: strips ANSI escape codes from title', () => {
    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-activity-'));
    try {
        const ansiTitle = '\x1b[31mred text\x1b[0m and \x1b[1mbold\x1b[0m';
        const result = runCli(['feature', ansiTitle], { EXTENSION_DIR: extRoot });
        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
        const activityDir = path.join(extRoot, 'activity');
        const date = formatLocalDateKey(new Date());
        const filepath = path.join(activityDir, `${date}.jsonl`);
        const parsed = JSON.parse(fs.readFileSync(filepath, 'utf8').trim());
        assert.ok(!parsed.title.includes('\x1b'), 'title should not contain ANSI escape codes');
        assert.match(parsed.title, /red text.*bold/, 'text content should be preserved');
    } finally {
        fs.rmSync(extRoot, { recursive: true, force: true });
    }
});

test('CLI: strips control characters (bell, backspace, vertical tab) from title', () => {
    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-activity-'));
    try {
        // Use control chars that Node allows in CLI args (no null bytes)
        const controlTitle = 'before\x07bell\x08backspace\x0Bvtab after';
        const result = runCli(['bug_fix', controlTitle], { EXTENSION_DIR: extRoot });
        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
        const activityDir = path.join(extRoot, 'activity');
        const date = formatLocalDateKey(new Date());
        const filepath = path.join(activityDir, `${date}.jsonl`);
        const parsed = JSON.parse(fs.readFileSync(filepath, 'utf8').trim());
        assert.ok(!parsed.title.includes('\x07'), 'title should not contain bell char');
        assert.ok(!parsed.title.includes('\x08'), 'title should not contain backspace');
        assert.ok(!parsed.title.includes('\x0B'), 'title should not contain vertical tab');
        assert.ok(parsed.title.includes('before'), 'readable text should be preserved');
        assert.ok(parsed.title.includes('after'), 'readable text should be preserved');
    } finally {
        fs.rmSync(extRoot, { recursive: true, force: true });
    }
});

test('CLI: truncates title at 200 chars', () => {
    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-activity-'));
    try {
        const longTitle = 'x'.repeat(300);
        const result = runCli(['research', longTitle], { EXTENSION_DIR: extRoot });
        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
        const activityDir = path.join(extRoot, 'activity');
        const date = formatLocalDateKey(new Date());
        const filepath = path.join(activityDir, `${date}.jsonl`);
        const parsed = JSON.parse(fs.readFileSync(filepath, 'utf8').trim());
        assert.equal(parsed.title.length, 200);
    } finally {
        fs.rmSync(extRoot, { recursive: true, force: true });
    }
});

test('CLI: accepts all 25 valid event types', () => {
    const expected = [
        'session_start', 'session_end', 'ticket_completed', 'epic_completed',
        'meeseeks_pass', 'commit', 'research', 'bug_fix', 'feature',
        'refactor', 'review', 'jar_start', 'jar_end',
        'circuit_open', 'circuit_recovery',
        'iteration_start', 'iteration_end',
        'rate_limit_wait', 'rate_limit_resume', 'rate_limit_exhausted',
        'multi_repo_warning',
        'meeseeks_model_select',
        'pending_tickets_on_completion',
        'manager_false_epic_completed',
        'manager_persistent_hallucination',
    ];
    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-activity-'));
    try {
        for (const eventType of expected) {
            const result = runCli([eventType, `test ${eventType}`], { EXTENSION_DIR: extRoot });
            assert.equal(result.status, 0, `Event type "${eventType}" should be accepted, stderr: ${result.stderr}`);
        }
    } finally {
        fs.rmSync(extRoot, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Retry + buffer (F18)
// ---------------------------------------------------------------------------

test('logActivity: buffers event when write fails on both attempts (ENOSPC simulation)', async () => {
    _setRetryDelayMs(0); // no sleep in tests
    _clearPendingBuffer();
    const logActivity = await getLogActivity();

    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-activity-'));
    const activityDir = path.join(extRoot, 'activity');
    const origEnv = process.env.EXTENSION_DIR;
    process.env.EXTENSION_DIR = extRoot;
    try {
        fs.mkdirSync(activityDir);
        const date = formatLocalDateKey(new Date());
        const filepath = path.join(activityDir, `${date}.jsonl`);
        // Create file as read-only so both write attempts fail
        fs.writeFileSync(filepath, '', { mode: 0o444 });

        logActivity({ event: 'commit', source: 'hook', commit_hash: 'abc123' });

        assert.equal(_getPendingBuffer().length, 1, 'failed event should be buffered');
        assert.ok(
            _getPendingBuffer()[0].line.includes('"commit"'),
            'buffered entry should contain the event type'
        );
    } finally {
        fs.chmodSync(path.join(activityDir, formatLocalDateKey(new Date()) + '.jsonl'), 0o644);
        process.env.EXTENSION_DIR = origEnv;
        if (origEnv === undefined) delete process.env.EXTENSION_DIR;
        fs.rmSync(extRoot, { recursive: true, force: true });
        _clearPendingBuffer();
        _setRetryDelayMs(500);
    }
});

test('logActivity: flushes buffer on next successful write', async () => {
    _setRetryDelayMs(0);
    _clearPendingBuffer();
    const logActivity = await getLogActivity();

    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-activity-'));
    const activityDir = path.join(extRoot, 'activity');
    const origEnv = process.env.EXTENSION_DIR;
    process.env.EXTENSION_DIR = extRoot;
    try {
        fs.mkdirSync(activityDir);
        const date = formatLocalDateKey(new Date());
        const filepath = path.join(activityDir, `${date}.jsonl`);
        fs.writeFileSync(filepath, '', { mode: 0o444 });

        // First call fails → buffered
        logActivity({ event: 'commit', source: 'hook', commit_hash: 'aaa' });
        assert.equal(_getPendingBuffer().length, 1);

        // Restore write permission
        fs.chmodSync(filepath, 0o644);

        // Second call succeeds → new event written, then buffer flushed
        logActivity({ event: 'feature', source: 'persona', title: 'flush test' });
        assert.equal(_getPendingBuffer().length, 0, 'buffer should be empty after flush');

        const lines = fs.readFileSync(filepath, 'utf8').trim().split('\n').filter(Boolean);
        assert.equal(lines.length, 2, 'file should have new event + flushed buffered event');
        assert.equal(JSON.parse(lines[0]).event, 'feature', 'new event written first');
        assert.equal(JSON.parse(lines[1]).event, 'commit', 'buffered event flushed second');
    } finally {
        process.env.EXTENSION_DIR = origEnv;
        if (origEnv === undefined) delete process.env.EXTENSION_DIR;
        fs.rmSync(extRoot, { recursive: true, force: true });
        _clearPendingBuffer();
        _setRetryDelayMs(500);
    }
});

test('logActivity: buffered events flush back to the original day partition and standup reads that day', async () => {
    _setRetryDelayMs(0);
    _clearPendingBuffer();
    const logActivity = await getLogActivity();

    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-activity-'));
    const activityDir = path.join(extRoot, 'activity');
    const origEnv = process.env.EXTENSION_DIR;
    process.env.EXTENSION_DIR = extRoot;

    const yesterday = localDateWithOffset(-1);
    const yesterdayStart = new Date(yesterday);
    yesterdayStart.setHours(0, 0, 0, 0);
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const yesterdayFile = path.join(activityDir, `${formatLocalDateKey(yesterday)}.jsonl`);
    const todayFile = path.join(activityDir, `${formatLocalDateKey(todayStart)}.jsonl`);

    try {
        fs.mkdirSync(activityDir);
        fs.writeFileSync(yesterdayFile, '', { mode: 0o444 });

        logActivity({ event: 'commit', source: 'hook', commit_hash: 'retro123', ts: yesterday.toISOString() });
        assert.equal(_getPendingBuffer().length, 1, 'failed retro event should be buffered');

        fs.chmodSync(yesterdayFile, 0o644);
        logActivity({ event: 'feature', source: 'persona', title: 'today write succeeds' });

        assert.equal(_getPendingBuffer().length, 0, 'buffer should drain after the successful write');
        assert.equal(JSON.parse(fs.readFileSync(yesterdayFile, 'utf8').trim()).commit_hash, 'retro123');
        assert.equal(JSON.parse(fs.readFileSync(todayFile, 'utf8').trim()).event, 'feature');

        const events = readActivityFiles(activityDir, yesterdayStart, todayStart);
        assert.equal(events.length, 1, 'yesterday range should read the retro event from the restored file');
        assert.equal(events[0].commit_hash, 'retro123');
    } finally {
        if (fs.existsSync(yesterdayFile)) {
            fs.chmodSync(yesterdayFile, 0o644);
        }
        process.env.EXTENSION_DIR = origEnv;
        if (origEnv === undefined) delete process.env.EXTENSION_DIR;
        fs.rmSync(extRoot, { recursive: true, force: true });
        _clearPendingBuffer();
        _setRetryDelayMs(500);
    }
});

test('logActivity: buffer capped at 100 events — excess events dropped', async () => {
    _setRetryDelayMs(0);
    _clearPendingBuffer();
    const logActivity = await getLogActivity();

    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-activity-'));
    const activityDir = path.join(extRoot, 'activity');
    const date = formatLocalDateKey(new Date());
    const filepath = path.join(activityDir, `${date}.jsonl`);
    const origEnv = process.env.EXTENSION_DIR;
    process.env.EXTENSION_DIR = extRoot;
    try {
        fs.mkdirSync(activityDir);
        fs.writeFileSync(filepath, '', { mode: 0o444 });

        // Write 150 events — only first 100 should be buffered
        for (let i = 0; i < 150; i++) {
            logActivity({ event: 'commit', source: 'hook', commit_hash: `hash${i}` });
        }

        assert.equal(_getPendingBuffer().length, 100, 'buffer must be capped at 100 events');
    } finally {
        fs.chmodSync(filepath, 0o644);
        process.env.EXTENSION_DIR = origEnv;
        if (origEnv === undefined) delete process.env.EXTENSION_DIR;
        fs.rmSync(extRoot, { recursive: true, force: true });
        _clearPendingBuffer();
        _setRetryDelayMs(500);
    }
});

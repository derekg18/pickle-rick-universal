import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_ACTIVITY_BIN = path.resolve(__dirname, '../bin/log-activity.js');

/**
 * Run log-activity.js as a subprocess with an isolated EXTENSION_DIR.
 * Returns { stdout, stderr, status, events }.
 */
function run(args, envOverrides = {}) {
    const extRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-log-activity-')));
    // 10s → 30s: budget for system load when run alongside concurrent
    // codex/tmux work. Tests validate event-emission logic, not wall-clock.
    const result = spawnSync(process.execPath, [LOG_ACTIVITY_BIN, ...args], {
        env: { ...process.env, EXTENSION_DIR: extRoot, FORCE_COLOR: '0', ...envOverrides },
        encoding: 'utf-8',
        timeout: 30000,
    });
    // Collect any activity events written
    const activityDir = path.join(extRoot, 'activity');
    let events = [];
    if (fs.existsSync(activityDir)) {
        for (const f of fs.readdirSync(activityDir)) {
            if (f.endsWith('.jsonl')) {
                const lines = fs.readFileSync(path.join(activityDir, f), 'utf-8').trim().split('\n').filter(Boolean);
                events.push(...lines.map(l => JSON.parse(l)));
            }
        }
    }
    fs.rmSync(extRoot, { recursive: true, force: true });
    return {
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        status: result.status,
        events,
    };
}

// ---------------------------------------------------------------------------
// Argument validation — missing/invalid event type
// ---------------------------------------------------------------------------

test('log-activity: no args → exit 1, stderr includes Usage', () => {
    const { status, stderr } = run([]);
    assert.equal(status, 1);
    assert.ok(stderr.includes('Usage'), `stderr should include Usage, got: ${stderr}`);
});

test('log-activity: event type starts with -- → exit 1, stderr includes Usage', () => {
    const { status, stderr } = run(['--bogus', 'some title']);
    assert.equal(status, 1);
    assert.ok(stderr.includes('Usage'), `stderr should include Usage, got: ${stderr}`);
});

test('log-activity: unknown event type → exit 1, stderr includes "Unknown event type"', () => {
    const { status, stderr } = run(['not_a_real_event', 'some title']);
    assert.equal(status, 1);
    assert.ok(stderr.includes('Unknown event type'), `stderr should mention unknown type, got: ${stderr}`);
    assert.ok(stderr.includes('not_a_real_event'), `stderr should echo the bad type, got: ${stderr}`);
});

// ---------------------------------------------------------------------------
// Argument validation — missing/invalid title
// ---------------------------------------------------------------------------

test('log-activity: valid event type but no title → exit 1, stderr mentions title required', () => {
    const { status, stderr } = run(['commit']);
    assert.equal(status, 1);
    assert.ok(stderr.includes('Title is required'), `stderr should mention title required, got: ${stderr}`);
});

test('log-activity: title starts with -- → exit 1, stderr mentions title required', () => {
    const { status, stderr } = run(['commit', '--oops']);
    assert.equal(status, 1);
    assert.ok(stderr.includes('Title is required'), `stderr should mention title required, got: ${stderr}`);
});

// ---------------------------------------------------------------------------
// Title sanitization — ANSI escape sequences
// ---------------------------------------------------------------------------

test('log-activity: ANSI escape sequences stripped from title', () => {
    const { status, events } = run(['commit', '\x1b[31mred text\x1b[0m']);
    assert.equal(status, 0, 'should succeed after stripping ANSI');
    assert.equal(events.length, 1);
    assert.equal(events[0].title, 'red text');
});

test('log-activity: control characters replaced with spaces', () => {
    const { status, events } = run(['commit', 'hello\x01world\x02test']);
    assert.equal(status, 0, 'should succeed after sanitizing control chars');
    assert.equal(events.length, 1);
    assert.equal(events[0].title, 'hello world test');
});

test('log-activity: title truncated at 200 chars', () => {
    const longTitle = 'x'.repeat(300);
    const { status, events } = run(['commit', longTitle]);
    assert.equal(status, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].title.length, 200);
});

test('log-activity: title of only control chars → exit 1, empty after sanitization', () => {
    const { status, stderr } = run(['commit', '\x01\x02\x03\x04']);
    assert.equal(status, 1);
    assert.ok(stderr.includes('empty after sanitization'), `stderr should mention empty, got: ${stderr}`);
});

test('log-activity: title of only ANSI escapes → exit 1, empty after sanitization', () => {
    const { status, stderr } = run(['commit', '\x1b[31m\x1b[0m']);
    assert.equal(status, 1);
    assert.ok(stderr.includes('empty after sanitization'), `stderr should mention empty, got: ${stderr}`);
});

// ---------------------------------------------------------------------------
// Happy path — valid event types
// ---------------------------------------------------------------------------

test('log-activity: commit event logged successfully', () => {
    const { status, events } = run(['commit', 'fix: resolve null pointer']);
    assert.equal(status, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'commit');
    assert.equal(events[0].title, 'fix: resolve null pointer');
    assert.equal(events[0].source, 'persona');
});

test('log-activity: session_start event logged successfully', () => {
    const { status, events } = run(['session_start', 'New coding session']);
    assert.equal(status, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'session_start');
});

test('log-activity: meeseeks_pass event logged successfully', () => {
    const { status, events } = run(['meeseeks_pass', 'Pass 8 complete']);
    assert.equal(status, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'meeseeks_pass');
});

// ---------------------------------------------------------------------------
// Event structure
// ---------------------------------------------------------------------------

test('log-activity: event has ts field with ISO timestamp', () => {
    const before = new Date().toISOString();
    const { events } = run(['commit', 'timestamp test']);
    const after = new Date().toISOString();
    assert.equal(events.length, 1);
    assert.ok(events[0].ts >= before, 'ts should be >= test start');
    assert.ok(events[0].ts <= after, 'ts should be <= test end');
});

test('log-activity: event source is always "persona"', () => {
    const { events } = run(['feature', 'add dark mode']);
    assert.equal(events.length, 1);
    assert.equal(events[0].source, 'persona');
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test('log-activity: title with mixed ANSI and valid text preserves valid text', () => {
    const { status, events } = run(['commit', '\x1b[1mbold\x1b[0m normal \x1b[32mgreen\x1b[0m']);
    assert.equal(status, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].title, 'bold normal green');
});

test('log-activity: title with spaces only after sanitization → exit 1', () => {
    // C0 control chars become spaces, and spaces-only trims to empty
    const { status, stderr } = run(['commit', '\x01\x02\x03']);
    assert.equal(status, 1);
    assert.ok(stderr.includes('empty after sanitization'), `stderr should mention empty, got: ${stderr}`);
});

/**
 * FR-B12/B14 — executeTimeoutHalt side-effects:
 *   - writes state.json.activity halt entry
 *   - emits structured stderr JSON with remediation_code=RAISE_TIMEOUT
 *   - deactivates session (active: false)
 *   - resets circuit_breaker.json
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MUX_BIN = path.resolve(__dirname, '../bin/mux-runner.js');

const { executeTimeoutHalt } = await import(MUX_BIN);

function makeSession(overrides = {}) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-halt-')));
    const statePath = path.join(dir, 'state.json');
    const base = {
        active: true,
        working_dir: dir,
        step: 'implement',
        iteration: 2,
        max_iterations: 10,
        max_time_minutes: 720,
        worker_timeout_seconds: 1200,
        start_time_epoch: Math.floor(Date.now() / 1000),
        completion_promise: null,
        original_prompt: 'halt test',
        current_ticket: 'A',
        history: [],
        started_at: new Date().toISOString(),
        session_dir: dir,
    };
    fs.writeFileSync(statePath, JSON.stringify({ ...base, ...overrides }, null, 2));
    return { dir, statePath };
}

/** Captures stderr during fn(), returns captured text. */
function captureStderr(fn) {
    const orig = process.stderr.write.bind(process.stderr);
    let captured = '';
    process.stderr.write = (chunk, ...rest) => {
        captured += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
        return true;
    };
    // Also capture console.error which routes through stderr internally —
    // but overriding process.stderr.write catches it too on Node.
    try { fn(); } finally { process.stderr.write = orig; }
    return captured;
}

test('activity-entry: halt writes state.json.activity entry with expected fields', () => {
    const { dir, statePath } = makeSession();
    try {
        captureStderr(() => {
            executeTimeoutHalt({ statePath, sessionDir: dir, ticketNow: 'A', timeoutCount: 2 });
        });

        const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.ok(Array.isArray(state.activity), 'state.activity must be an array');
        const last = state.activity[state.activity.length - 1];
        assert.equal(last.event, 'halt');
        assert.equal(last.halt_reason, 'timeout_repeat');
        assert.equal(last.halted_ticket, 'A');
        assert.equal(last.timeout_count, 2);
        assert.ok(typeof last.halted_at === 'string' && last.halted_at.includes('T'), 'halted_at must be ISO timestamp');
        assert.ok(last.remediation.includes('RAISE_TIMEOUT') || last.remediation.includes('worker_timeout_seconds'),
            'remediation text should reference timeout / worker_timeout_seconds');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('remediation: stderr contains JSON line with remediation_code=RAISE_TIMEOUT', () => {
    const { dir, statePath } = makeSession();
    try {
        const stderr = captureStderr(() => {
            executeTimeoutHalt({ statePath, sessionDir: dir, ticketNow: 'A', timeoutCount: 2 });
        });

        // Find the JSON line — scan non-empty lines that parse to JSON with our markers.
        const lines = stderr.split('\n').filter(l => l.trim());
        const jsonLine = lines.find(l => {
            try { const o = JSON.parse(l); return o.remediation_code === 'RAISE_TIMEOUT'; }
            catch { return false; }
        });
        assert.ok(jsonLine, `No JSON line with remediation_code=RAISE_TIMEOUT in stderr:\n${stderr}`);
        const parsed = JSON.parse(jsonLine);
        assert.equal(parsed.exit_reason, 'timeout_repeat');
        assert.equal(parsed.remediation_code, 'RAISE_TIMEOUT');
        assert.equal(parsed.ticket_id, 'A');
        assert.equal(parsed.timeout_count, 2);
        assert.equal(parsed.state_path, statePath);
        assert.ok(parsed.message.includes('timed out'), 'message should describe the timeout');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('safe-deactivate: halt sets state.active=false', () => {
    const { dir, statePath } = makeSession({ active: true });
    try {
        captureStderr(() => {
            executeTimeoutHalt({ statePath, sessionDir: dir, ticketNow: 'A', timeoutCount: 2 });
        });

        const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(state.active, false, 'active must be false after halt');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('null ticket: halt with ticketNow=null still writes valid activity entry', () => {
    const { dir, statePath } = makeSession({ current_ticket: null });
    try {
        captureStderr(() => {
            executeTimeoutHalt({ statePath, sessionDir: dir, ticketNow: null, timeoutCount: 2 });
        });

        const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        const last = state.activity[state.activity.length - 1];
        assert.equal(last.halted_ticket, null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

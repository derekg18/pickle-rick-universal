/**
 * FR-B14 — Timeout-repeat halt MUST fire before circuit-breaker evaluation.
 * Tests:
 *   - source order: applyTimeoutCounter call precedes recordIterationResult call
 *   - cb-reset: executeTimeoutHalt collapses an OPEN circuit_breaker.json to CLOSED
 *   - exit-reason-timeout: halt break path sets exitReason='timeout_repeat'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MUX_BIN = path.resolve(__dirname, '../bin/mux-runner.js');
const MUX_SRC = path.resolve(__dirname, '../src/bin/mux-runner.ts');

const { executeTimeoutHalt } = await import(MUX_BIN);

function captureStderr(fn) {
    const orig = process.stderr.write.bind(process.stderr);
    let captured = '';
    process.stderr.write = (chunk) => { captured += typeof chunk === 'string' ? chunk : chunk.toString('utf-8'); return true; };
    try { fn(); } finally { process.stderr.write = orig; }
    return captured;
}

test('source-order: applyTimeoutCounter call precedes recordIterationResult call', () => {
    const src = fs.readFileSync(MUX_SRC, 'utf-8');

    // Find index of first applyTimeoutCounter invocation inside main-loop.
    const counterCallIdx = src.indexOf('applyTimeoutCounter({');
    const cbRecordIdx = src.indexOf('recordIterationResult(');
    assert.ok(counterCallIdx > 0, 'applyTimeoutCounter invocation must exist in main loop');
    assert.ok(cbRecordIdx > 0, 'recordIterationResult invocation must exist in main loop');
    assert.ok(counterCallIdx < cbRecordIdx,
        `Timeout halt must precede CB recording (FR-B14). counter@${counterCallIdx} CB@${cbRecordIdx}`);
});

test('source-order: halt break path sets exitReason=timeout_repeat before break', () => {
    const src = fs.readFileSync(MUX_SRC, 'utf-8');
    // Locate executeTimeoutHalt call site — expect exitReason assignment and break within 200 chars.
    const callSite = src.match(/executeTimeoutHalt\({[^}]*}\);\s*([\s\S]{0,200})/);
    assert.ok(callSite, 'executeTimeoutHalt call site must exist in main loop');
    const after = callSite[1];
    assert.ok(after.includes("exitReason = 'timeout_repeat'"),
        `exitReason='timeout_repeat' must appear after executeTimeoutHalt:\n${after}`);
    assert.ok(after.includes('break'),
        `break must appear after executeTimeoutHalt:\n${after}`);
});

test('cb-reset: executeTimeoutHalt collapses OPEN circuit_breaker.json to CLOSED', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-cb-prec-')));
    try {
        const statePath = path.join(dir, 'state.json');
        const cbPath = path.join(dir, 'circuit_breaker.json');
        fs.writeFileSync(statePath, JSON.stringify({
            active: true, working_dir: dir, step: 'implement', iteration: 5,
            max_iterations: 10, max_time_minutes: 720, worker_timeout_seconds: 1200,
            start_time_epoch: Math.floor(Date.now() / 1000), completion_promise: null,
            original_prompt: 'cb precedence', current_ticket: 'A', history: [],
            started_at: new Date().toISOString(), session_dir: dir,
        }, null, 2));

        // Pre-seed a tripped CB state.
        fs.writeFileSync(cbPath, JSON.stringify({
            state: 'OPEN',
            last_change: new Date().toISOString(),
            consecutive_no_progress: 8,
            consecutive_same_error: 5,
            last_error_signature: 'some error',
            last_known_head: 'abc123',
            last_known_step: 'implement',
            last_known_ticket: 'A',
            last_progress_iteration: 0,
            total_opens: 1,
            reason: 'Pre-existing failure streak',
            opened_at: new Date().toISOString(),
            history: [],
        }, null, 2));

        captureStderr(() => {
            executeTimeoutHalt({ statePath, sessionDir: dir, ticketNow: 'A', timeoutCount: 2 });
        });

        const cb = JSON.parse(fs.readFileSync(cbPath, 'utf-8'));
        assert.equal(cb.state, 'CLOSED', 'CB must be CLOSED after halt — no orphan streak');
        assert.equal(cb.consecutive_no_progress, 0, 'no-progress streak must reset');
        assert.equal(cb.consecutive_same_error, 0, 'same-error streak must reset');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('cb-already-closed: executeTimeoutHalt is a no-op for CB but still writes activity + deactivates', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-cb-prec-')));
    try {
        const statePath = path.join(dir, 'state.json');
        fs.writeFileSync(statePath, JSON.stringify({
            active: true, working_dir: dir, step: 'implement', iteration: 5,
            max_iterations: 10, max_time_minutes: 720, worker_timeout_seconds: 1200,
            start_time_epoch: Math.floor(Date.now() / 1000), completion_promise: null,
            original_prompt: 'cb already closed', current_ticket: 'A', history: [],
            started_at: new Date().toISOString(), session_dir: dir,
        }, null, 2));
        // No circuit_breaker.json — resetCircuitBreaker logs and returns without writing.

        captureStderr(() => {
            executeTimeoutHalt({ statePath, sessionDir: dir, ticketNow: 'A', timeoutCount: 2 });
        });

        const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(state.active, false);
        assert.ok(Array.isArray(state.activity) && state.activity.length >= 1);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

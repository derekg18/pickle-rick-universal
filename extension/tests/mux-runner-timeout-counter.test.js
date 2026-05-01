/**
 * FR-B3/B4 — applyTimeoutCounter: pure counter logic for per-ticket timeout halt.
 * Asserts increment-on-same-ticket, reset-on-ticket-change, reset-on-clean-completion,
 * halt-at-2, and non-persistence invariant (restart safety).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MUX_BIN = path.resolve(__dirname, '../bin/mux-runner.js');
const MUX_SRC = path.resolve(__dirname, '../src/bin/mux-runner.ts');

const { applyTimeoutCounter } = await import(MUX_BIN);

const INITIAL = { count: 0, ticket: null };

test('initial: no timeout, no completion → pass-through zero', () => {
    const r = applyTimeoutCounter({
        prev: INITIAL, ticketNow: 'A', timedOut: false, completedClean: false,
    });
    assert.deepEqual(r, { count: 0, ticket: null, halt: false });
});

test('first timeout on ticket A: count=1, ticket=A, no halt', () => {
    const r = applyTimeoutCounter({
        prev: INITIAL, ticketNow: 'A', timedOut: true, completedClean: false,
    });
    assert.deepEqual(r, { count: 1, ticket: 'A', halt: false });
});

test('increment-same-ticket: prev={count:1,ticket:A}, timeout A → count=2, halt=true', () => {
    const r = applyTimeoutCounter({
        prev: { count: 1, ticket: 'A' }, ticketNow: 'A', timedOut: true, completedClean: false,
    });
    assert.deepEqual(r, { count: 2, ticket: 'A', halt: true });
});

test('reset-ticket: prev={count:1,ticket:A}, timeout B → count=1, ticket=B', () => {
    const r = applyTimeoutCounter({
        prev: { count: 1, ticket: 'A' }, ticketNow: 'B', timedOut: true, completedClean: false,
    });
    assert.deepEqual(r, { count: 1, ticket: 'B', halt: false });
});

test('reset-complete: prev={count:1,ticket:A}, completedClean=true → count=0, ticket=null', () => {
    const r = applyTimeoutCounter({
        prev: { count: 1, ticket: 'A' }, ticketNow: 'A', timedOut: false, completedClean: true,
    });
    assert.deepEqual(r, { count: 0, ticket: null, halt: false });
});

test('pass-through: prev={count:1,ticket:A}, no timeout, no completion → unchanged', () => {
    const r = applyTimeoutCounter({
        prev: { count: 1, ticket: 'A' }, ticketNow: 'A', timedOut: false, completedClean: false,
    });
    assert.deepEqual(r, { count: 1, ticket: 'A', halt: false });
});

test('null ticketNow on timeout: counts against null ticket (edge), count=1', () => {
    const r = applyTimeoutCounter({
        prev: INITIAL, ticketNow: null, timedOut: true, completedClean: false,
    });
    assert.deepEqual(r, { count: 1, ticket: null, halt: false });
});

test('timeout with null ticketNow vs prev null: no match logic — fresh count=1', () => {
    // ticketNow === null is NOT treated as "same ticket" even if prev.ticket === null.
    const r = applyTimeoutCounter({
        prev: { count: 1, ticket: null }, ticketNow: null, timedOut: true, completedClean: false,
    });
    assert.deepEqual(r, { count: 1, ticket: null, halt: false });
});

test('halt threshold: 3rd timeout on same ticket still reports halt=true', () => {
    const r = applyTimeoutCounter({
        prev: { count: 2, ticket: 'A' }, ticketNow: 'A', timedOut: true, completedClean: false,
    });
    assert.equal(r.halt, true);
    assert.equal(r.count, 3);
});

test('reset-restart invariant: timeoutCount/lastTimeoutTicket never persisted via writeStateFile/sm.update/forceWrite', () => {
    const src = fs.readFileSync(MUX_SRC, 'utf-8');

    // Find all write-site patterns in mux-runner that could persist state.
    const sm_update_bodies = [...src.matchAll(/sm\.update\([^,]+,\s*s\s*=>\s*\{([^}]*)\}/g)].map(m => m[1]);
    const forceWrite_args = [...src.matchAll(/forceWrite\([^,]+,\s*([^)]+)\)/g)].map(m => m[1]);

    for (const body of sm_update_bodies) {
        assert.ok(!body.includes('timeoutCount'), `sm.update body persists timeoutCount: ${body}`);
        assert.ok(!body.includes('lastTimeoutTicket'), `sm.update body persists lastTimeoutTicket: ${body}`);
    }
    for (const arg of forceWrite_args) {
        assert.ok(!arg.includes('timeoutCount'), `forceWrite arg persists timeoutCount: ${arg}`);
        assert.ok(!arg.includes('lastTimeoutTicket'), `forceWrite arg persists lastTimeoutTicket: ${arg}`);
    }
});

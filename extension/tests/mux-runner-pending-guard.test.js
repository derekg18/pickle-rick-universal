import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPendingNonCurrentTickets } from '../bin/mux-runner.js';

const T = (id, status, extras = {}) => ({
    id,
    title: id,
    status,
    order: 0,
    type: null,
    working_dir: null,
    completed_at: null,
    skipped_at: null,
    ...extras,
});

test('findPendingNonCurrentTickets: empty list returns empty', () => {
    assert.deepEqual(findPendingNonCurrentTickets([], null), []);
    assert.deepEqual(findPendingNonCurrentTickets([], 'abc'), []);
});

test('findPendingNonCurrentTickets: all Done returns empty', () => {
    const tickets = [T('a', 'Done'), T('b', 'Done'), T('c', 'Done')];
    assert.deepEqual(findPendingNonCurrentTickets(tickets, 'a'), []);
    assert.deepEqual(findPendingNonCurrentTickets(tickets, null), []);
});

test('findPendingNonCurrentTickets: all Skipped returns empty', () => {
    const tickets = [T('a', 'Skipped'), T('b', 'Skipped')];
    assert.deepEqual(findPendingNonCurrentTickets(tickets, null), []);
});

test('findPendingNonCurrentTickets: mixed Done+Skipped returns empty', () => {
    const tickets = [T('a', 'Done'), T('b', 'Skipped'), T('c', 'Done')];
    assert.deepEqual(findPendingNonCurrentTickets(tickets, null), []);
});

test('findPendingNonCurrentTickets: status normalisation (case + quotes + whitespace)', () => {
    const tickets = [
        T('a', '"Done"'),       // YAML-quoted
        T('b', 'DONE'),         // upper
        T('c', 'done '),        // trailing space
        T('d', "'skipped'"),    // single-quoted
        T('e', 'Skipped'),
    ];
    assert.deepEqual(findPendingNonCurrentTickets(tickets, null), []);
});

test('findPendingNonCurrentTickets: pending tickets detected when current is Done', () => {
    // Mirrors the bug shape: model emits EPIC_COMPLETED while current=T08 is Done
    // but T09–T23 are still pending. This test only covers the helper — the
    // actual exit-code-1 fail-loud branch in main() is asserted separately
    // by `mux-runner-pending-guard.integration.test.js`.
    const tickets = [
        T('T05', 'Done'),
        T('T06', 'Done'),
        T('T07', 'Done'),
        T('T08', 'Done'),
        T('T09', 'Todo'),
        T('T10', 'Todo'),
        T('T23', null),  // unwritten status
    ];
    const pending = findPendingNonCurrentTickets(tickets, 'T08');
    assert.equal(pending.length, 3);
    assert.deepEqual(pending.map(t => t.id), ['T09', 'T10', 'T23']);
});

test('findPendingNonCurrentTickets: current_ticket is excluded even if pending', () => {
    // Current ticket is mid-iteration when EPIC_COMPLETED fires; the caller
    // will markTicketDone(current) afterwards, so the guard shouldn't flag it.
    const tickets = [T('a', 'Done'), T('b', 'In Progress'), T('c', 'Done')];
    assert.deepEqual(findPendingNonCurrentTickets(tickets, 'b'), []);
});

test('findPendingNonCurrentTickets: current_ticket null returns all pending', () => {
    const tickets = [T('a', 'Done'), T('b', 'Todo'), T('c', null)];
    const pending = findPendingNonCurrentTickets(tickets, null);
    assert.deepEqual(pending.map(t => t.id), ['b', 'c']);
});

test('findPendingNonCurrentTickets: unknown statuses count as pending', () => {
    const tickets = [
        T('a', 'In Progress'),
        T('b', 'Todo'),
        T('c', 'Blocked'),
        T('d', ''),
        T('e', null),
    ];
    const pending = findPendingNonCurrentTickets(tickets, null);
    assert.equal(pending.length, 5);
});

test('findPendingNonCurrentTickets: tickets with null id are dropped', () => {
    const tickets = [T(null, 'Todo'), T('a', 'Done'), T(null, null)];
    assert.deepEqual(findPendingNonCurrentTickets(tickets, null), []);
});

test('findPendingNonCurrentTickets: returns the original ticket objects (no mutation)', () => {
    const t = T('a', 'Todo');
    const [out] = findPendingNonCurrentTickets([t], null);
    assert.equal(out, t);
});

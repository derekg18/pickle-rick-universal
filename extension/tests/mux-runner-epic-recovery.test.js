// Regression coverage for the EPIC_COMPLETED recovery state machine in
// mux-runner.ts (`evaluateEpicCompletion`). Replaces the v1.56.x fail-loud
// behaviour that exited 1 on a single false EPIC_COMPLETED. The new
// behaviour is: log loudly, advance or retry, and only bail when the same
// ticket misbehaves past `FALSE_EPIC_THRESHOLD` consecutive iterations.
//
// Tests 1-4 mirror the user's task spec in prds/bmad-inspired-hardening
// (and the parent agent prompt). Test 5 covers counter-reset on
// genuine-advance to ensure recovery doesn't accumulate noise across
// unrelated tickets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateEpicCompletion } from '../bin/mux-runner.js';
import { FALSE_EPIC_THRESHOLD } from '../types/index.js';

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

// --- Test 1: genuine epic completion ---

test('evaluateEpicCompletion: all tickets Done → genuine epic completion', () => {
    const tickets = [T('a', 'Done'), T('b', 'Done'), T('c', 'Done')];
    const decision = evaluateEpicCompletion({
        tickets,
        currentTicket: 'c',
        priorFalseCount: 0,
        priorFalseTicket: null,
    });
    assert.equal(decision.kind, 'genuine');
    assert.equal(decision.doneCount, 3);
    assert.equal(decision.totalCount, 3);
});

test('evaluateEpicCompletion: status normalisation (case + quotes) on genuine path', () => {
    const tickets = [T('a', '"Done"'), T('b', 'DONE'), T('c', 'done ')];
    const decision = evaluateEpicCompletion({
        tickets,
        currentTicket: 'c',
        priorFalseCount: 0,
        priorFalseTicket: null,
    });
    assert.equal(decision.kind, 'genuine');
});

// --- Test 2: false EPIC, current_ticket IS Done → recover_advance ---

test('evaluateEpicCompletion: current_ticket Done but others pending → recover_advance, count 1', () => {
    const tickets = [
        T('a', 'Done'),
        T('b', 'Done'),
        T('c', 'Done'),  // current
        T('d', 'Todo'),
        T('e', 'Todo'),
    ];
    const decision = evaluateEpicCompletion({
        tickets,
        currentTicket: 'c',
        priorFalseCount: 0,
        priorFalseTicket: null,
    });
    assert.equal(decision.kind, 'recover_advance');
    assert.equal(decision.nextCount, 1);
    assert.equal(decision.doneCount, 3);
    assert.equal(decision.totalCount, 5);
    assert.deepEqual(decision.pendingIds, ['d', 'e']);
});

test('evaluateEpicCompletion: recover_advance increments existing counter for same ticket', () => {
    const tickets = [T('a', 'Done'), T('b', 'Todo')];
    const decision = evaluateEpicCompletion({
        tickets,
        currentTicket: 'a',
        priorFalseCount: 1,
        priorFalseTicket: 'a',
    });
    assert.equal(decision.kind, 'recover_advance');
    assert.equal(decision.nextCount, 2);
});

// --- Test 3: false EPIC, current_ticket NOT Done → recover_retry ---

test('evaluateEpicCompletion: current_ticket Todo and others pending → recover_retry', () => {
    const tickets = [
        T('a', 'Done'),
        T('b', 'Todo'),  // current — manager hallucinated
        T('c', 'Todo'),
    ];
    const decision = evaluateEpicCompletion({
        tickets,
        currentTicket: 'b',
        priorFalseCount: 0,
        priorFalseTicket: null,
    });
    assert.equal(decision.kind, 'recover_retry');
    assert.equal(decision.nextCount, 1);
    assert.equal(decision.doneCount, 1);
    assert.equal(decision.totalCount, 3);
    // current is excluded from pendingIds — it's the focus of the retry
    assert.deepEqual(decision.pendingIds, ['c']);
});

test('evaluateEpicCompletion: counter resets when current_ticket diverges from priorFalseTicket', () => {
    // Manager hallucinated on ticket A twice, then the model genuinely
    // advanced to ticket B. The counter must restart at 1, not continue
    // from 3 — different ticket means a fresh budget.
    const tickets = [T('a', 'Done'), T('b', 'Todo'), T('c', 'Todo')];
    const decision = evaluateEpicCompletion({
        tickets,
        currentTicket: 'b',
        priorFalseCount: 2,
        priorFalseTicket: 'a',
    });
    assert.equal(decision.kind, 'recover_retry');
    assert.equal(decision.nextCount, 1);
});

// --- Test 4: persistent hallucination → exit ---

test('evaluateEpicCompletion: false EPIC past threshold on same ticket → persistent_hallucination', () => {
    const tickets = [T('a', 'Done'), T('b', 'Todo')];
    const decision = evaluateEpicCompletion({
        tickets,
        currentTicket: 'b',
        priorFalseCount: FALSE_EPIC_THRESHOLD,  // already at threshold
        priorFalseTicket: 'b',
    });
    assert.equal(decision.kind, 'persistent_hallucination');
    assert.equal(decision.ticket, 'b');
    assert.equal(decision.nextCount, FALSE_EPIC_THRESHOLD + 1);
});

test('evaluateEpicCompletion: threshold parameter is honoured', () => {
    const tickets = [T('a', 'Done'), T('b', 'Todo')];
    const decision = evaluateEpicCompletion({
        tickets,
        currentTicket: 'b',
        priorFalseCount: 1,
        priorFalseTicket: 'b',
        threshold: 1,  // very strict
    });
    assert.equal(decision.kind, 'persistent_hallucination');
    assert.equal(decision.nextCount, 2);
});

test('evaluateEpicCompletion: counter at threshold-1 on different ticket does NOT bail', () => {
    // Counter belongs to a stale ticket — fresh budget on the new one.
    const tickets = [T('a', 'Done'), T('b', 'Todo')];
    const decision = evaluateEpicCompletion({
        tickets,
        currentTicket: 'b',
        priorFalseCount: FALSE_EPIC_THRESHOLD,  // would bail if same ticket
        priorFalseTicket: 'older-ticket',       // but it's a stale ticket
    });
    assert.equal(decision.kind, 'recover_retry');
    assert.equal(decision.nextCount, 1);
});

// --- Test 5: edge cases ---

test('evaluateEpicCompletion: current_ticket null, all Done → genuine', () => {
    const tickets = [T('a', 'Done'), T('b', 'Done')];
    const decision = evaluateEpicCompletion({
        tickets,
        currentTicket: null,
        priorFalseCount: 0,
        priorFalseTicket: null,
    });
    assert.equal(decision.kind, 'genuine');
});

test('evaluateEpicCompletion: current_ticket null with pending others → recover_retry', () => {
    const tickets = [T('a', 'Done'), T('b', 'Todo')];
    const decision = evaluateEpicCompletion({
        tickets,
        currentTicket: null,
        priorFalseCount: 0,
        priorFalseTicket: null,
    });
    // Falls through to recover_retry — currentIsDone is false so we ask the
    // manager to keep working rather than advance to a phantom ticket.
    assert.equal(decision.kind, 'recover_retry');
    assert.equal(decision.nextCount, 1);
});

test('evaluateEpicCompletion: empty ticket list (defensive) → genuine', () => {
    const decision = evaluateEpicCompletion({
        tickets: [],
        currentTicket: null,
        priorFalseCount: 0,
        priorFalseTicket: null,
    });
    assert.equal(decision.kind, 'genuine');
    assert.equal(decision.totalCount, 0);
    assert.equal(decision.doneCount, 0);
});

test('evaluateEpicCompletion: tickets with null id are excluded from counts', () => {
    const tickets = [T(null, 'Done'), T('a', 'Done'), T(null, 'Todo')];
    const decision = evaluateEpicCompletion({
        tickets,
        currentTicket: 'a',
        priorFalseCount: 0,
        priorFalseTicket: null,
    });
    assert.equal(decision.kind, 'genuine');
    assert.equal(decision.totalCount, 1);
    assert.equal(decision.doneCount, 1);
});

test('evaluateEpicCompletion: Skipped tickets do NOT count toward Done but are not pending', () => {
    // Skipped means the safety net couldn't verify — they shouldn't trigger
    // EPIC_COMPLETED but also shouldn't count as Todo for the recovery loop
    // (they're already a known-failure state; the loop won't make them Done
    // by retrying). Behaviour matches findPendingNonCurrentTickets.
    const tickets = [T('a', 'Done'), T('b', 'Skipped'), T('c', 'Todo')];
    const decision = evaluateEpicCompletion({
        tickets,
        currentTicket: 'a',
        priorFalseCount: 0,
        priorFalseTicket: null,
    });
    assert.equal(decision.kind, 'recover_advance');
    assert.deepEqual(decision.pendingIds, ['c']);  // Skipped excluded
});

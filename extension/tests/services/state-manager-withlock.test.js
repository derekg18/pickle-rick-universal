import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withLock } from '../../services/state-manager.js';
import { LockError } from '../../types/index.js';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function uniqueKey(label) {
  return `test-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ---------------------------------------------------------------------------
// Same-key serializes: two concurrent calls, total ≥ sum of fn durations
// ---------------------------------------------------------------------------

test('withLock: same-key calls serialize', async () => {
  const key = uniqueKey('serial');
  const FN_MS = 60;

  const start = Date.now();
  await Promise.all([
    withLock(key, {}, () => sleep(FN_MS)),
    withLock(key, {}, () => sleep(FN_MS)),
  ]);
  const elapsed = Date.now() - start;

  assert.ok(elapsed >= FN_MS * 2 - 10,
    `Expected serial elapsed ≥ ${FN_MS * 2 - 10}ms, got ${elapsed}ms`);
});

// ---------------------------------------------------------------------------
// Different-key parallel: two concurrent calls run in parallel
// ---------------------------------------------------------------------------

test('withLock: different-key calls run in parallel', async () => {
  const key1 = uniqueKey('par-a');
  const key2 = uniqueKey('par-b');
  const FN_MS = 60;

  const start = Date.now();
  await Promise.all([
    withLock(key1, {}, () => sleep(FN_MS)),
    withLock(key2, {}, () => sleep(FN_MS)),
  ]);
  const elapsed = Date.now() - start;

  // Parallel: total should be close to FN_MS, not 2×FN_MS
  assert.ok(elapsed < FN_MS * 2 - 10,
    `Expected parallel elapsed < ${FN_MS * 2 - 10}ms, got ${elapsed}ms`);
});

// ---------------------------------------------------------------------------
// Timeout throws LockError with kind + waited_ms
// ---------------------------------------------------------------------------

test('withLock: timeout throws LockError with kind and waited_ms', async () => {
  const key = uniqueKey('timeout');
  const HOLD_MS = 500;
  const TIMEOUT_MS = 80;

  // Acquire and hold for HOLD_MS — deliberately do not await yet
  const holder = withLock(key, {}, () => sleep(HOLD_MS));

  // Give holder a moment to actually grab the lock
  await sleep(10);

  let thrown;
  try {
    await withLock(key, { timeout_ms: TIMEOUT_MS, retry_interval_ms: 20 }, () => sleep(1));
  } catch (err) {
    thrown = err;
  }

  // Clean up holder
  await holder;

  assert.ok(thrown instanceof LockError, `Expected LockError, got: ${thrown}`);
  assert.equal(thrown.kind, 'LockError');
  assert.equal(thrown.key, key);
  assert.equal(thrown.timeout_ms, TIMEOUT_MS);
  assert.ok(typeof thrown.waited_ms === 'number' && thrown.waited_ms >= TIMEOUT_MS - 10,
    `Expected waited_ms ≥ ${TIMEOUT_MS - 10}, got ${thrown.waited_ms}`);
});

// ---------------------------------------------------------------------------
// Release on throw: if fn() throws, lock is released and second call succeeds
// ---------------------------------------------------------------------------

test('withLock: releases lock when fn() throws', async () => {
  const key = uniqueKey('release');

  await assert.rejects(
    () => withLock(key, {}, async () => { throw new Error('deliberate fn error'); }),
    /deliberate fn error/,
  );

  // Lock must be released — second call should succeed immediately
  let acquired = false;
  await withLock(key, { timeout_ms: 500 }, async () => { acquired = true; });
  assert.ok(acquired, 'Second call should acquire lock after first fn threw');
});

// ---------------------------------------------------------------------------
// onAcquire and onTimeout callbacks fire
// ---------------------------------------------------------------------------

test('withLock: onAcquire callback fires with waited_ms', async () => {
  const key = uniqueKey('on-acquire');
  let acquiredWaited = null;

  await withLock(key, { onAcquire: (w) => { acquiredWaited = w; } }, async () => {});

  assert.ok(acquiredWaited !== null, 'onAcquire should have fired');
  assert.ok(typeof acquiredWaited === 'number' && acquiredWaited >= 0);
});

test('withLock: onTimeout callback fires before throw', async () => {
  const key = uniqueKey('on-timeout');
  const TIMEOUT_MS = 60;
  let timeoutWaited = null;

  const holder = withLock(key, {}, () => sleep(300));
  await sleep(10);

  let thrown = false;
  try {
    await withLock(key, {
      timeout_ms: TIMEOUT_MS,
      retry_interval_ms: 20,
      onTimeout: (w) => { timeoutWaited = w; },
    }, async () => {});
  } catch {
    thrown = true;
  }

  await holder;

  assert.ok(thrown, 'Should have thrown on timeout');
  assert.ok(timeoutWaited !== null, 'onTimeout should have fired');
  assert.ok(typeof timeoutWaited === 'number' && timeoutWaited >= TIMEOUT_MS - 10);
});

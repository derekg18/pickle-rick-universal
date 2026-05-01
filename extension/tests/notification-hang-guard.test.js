// Regression test for anatomy-park iteration 4: displayMacNotification must
// not block indefinitely on a wedged `osascript` subprocess. A stuck macOS
// Notification Center, deadlocked AppleEvent daemon, or saturated
// NSDistributedNotificationCenter can hang osascript forever with no signal
// and no log output; without a per-call `timeout` option, the runner's
// exit-path notification blocks `process.exit` indefinitely — same silent-hang
// class as council-publish `gh` (iter 1), scope-resolver `rg`/`grep` (iter 2),
// and plumbus-frame-analyzer `bun` (iter 3).
//
// Strategy: unit-test the helper via the `spawnSyncFn` / `forceDarwin` test
// seams to verify (a) timeout is threaded through, (b) default value matches
// NOTIFICATION_TIMEOUT_MS, (c) non-darwin is a no-op, (d) exceptions are
// swallowed. Then wall-clock test with a real hanging shim bound by the
// injected timeout to exercise Node's actual spawnSync timeout machinery —
// the same pattern as the three prior hang-guard tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  displayMacNotification,
  NOTIFICATION_TIMEOUT_MS,
} from '../services/pickle-utils.js';

test('displayMacNotification: no-op when not darwin', () => {
  let called = 0;
  const spy = () => {
    called++;
    return /** @type {any} */ ({});
  };
  displayMacNotification('title', 'body', 'subtitle', {
    spawnSyncFn: spy,
    forceDarwin: false,
  });
  assert.equal(called, 0, 'spawnSync must not be invoked off darwin');
});

test('displayMacNotification: passes default NOTIFICATION_TIMEOUT_MS to spawnSync', () => {
  /** @type {any[]} */
  const captured = [];
  const spy = (cmd, args, opts) => {
    captured.push({ cmd, args, opts });
    return /** @type {any} */ ({});
  };
  displayMacNotification('title', 'body', 'subtitle', {
    spawnSyncFn: spy,
    forceDarwin: true,
  });
  assert.equal(captured.length, 1, 'spawnSync invoked exactly once');
  assert.equal(captured[0].cmd, 'osascript');
  assert.equal(
    captured[0].opts.timeout,
    NOTIFICATION_TIMEOUT_MS,
    'timeout must default to NOTIFICATION_TIMEOUT_MS',
  );
});

test('displayMacNotification: custom timeoutMs override is threaded through', () => {
  /** @type {any[]} */
  const captured = [];
  const spy = (cmd, args, opts) => {
    captured.push({ cmd, args, opts });
    return /** @type {any} */ ({});
  };
  displayMacNotification('t', 'b', undefined, {
    spawnSyncFn: spy,
    forceDarwin: true,
    timeoutMs: 1234,
  });
  assert.equal(captured[0].opts.timeout, 1234);
});

test('displayMacNotification: emits `subtitle` clause only when provided', () => {
  /** @type {any[]} */
  const captured = [];
  const spy = (cmd, args, opts) => {
    captured.push({ cmd, args, opts });
    return /** @type {any} */ ({});
  };
  displayMacNotification('t', 'b', undefined, {
    spawnSyncFn: spy,
    forceDarwin: true,
  });
  displayMacNotification('t', 'b', 'sub', {
    spawnSyncFn: spy,
    forceDarwin: true,
  });
  assert.equal(captured.length, 2);
  assert.ok(!captured[0].args[1].includes('subtitle'), 'no subtitle clause when undefined');
  assert.ok(captured[1].args[1].includes('subtitle "sub"'), 'subtitle clause when provided');
});

test('displayMacNotification: escapes embedded quotes and backslashes', () => {
  /** @type {any[]} */
  const captured = [];
  const spy = (cmd, args, opts) => {
    captured.push({ cmd, args, opts });
    return /** @type {any} */ ({});
  };
  displayMacNotification('t"x', 'b\\y', undefined, {
    spawnSyncFn: spy,
    forceDarwin: true,
  });
  const script = captured[0].args[1];
  assert.ok(script.includes('t\\"x'), 'quote escaped');
  assert.ok(script.includes('b\\\\y'), 'backslash escaped');
});

test('displayMacNotification: swallows thrown errors from spawnSyncFn', () => {
  assert.doesNotThrow(() => {
    displayMacNotification('t', 'b', undefined, {
      spawnSyncFn: () => { throw new Error('ENOENT: osascript not found'); },
      forceDarwin: true,
    });
  });
});

test('displayMacNotification: real hanging shim is bounded by timeoutMs', () => {
  // Wall-clock hang guard — mirrors scope-one-hop-hang-guard and
  // plumbus-frame-analyzer-hang-guard. The hanging shim sleeps 60s; the
  // injected timeoutMs is 500ms. If the timeout is not threaded through,
  // this test will time out waiting for the shim.
  const HANG_TIMEOUT_MS = 500;
  const tmpDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'notif-hang-')),
  );
  const shimPath = path.join(tmpDir, 'hanging-osascript');
  fs.writeFileSync(
    shimPath,
    `#!/usr/bin/env node
// Keep the event loop alive past the parent's spawnSync timeout.
// Parent sends SIGTERM on timeout; default Node handler exits cleanly.
setTimeout(() => process.exit(0), 60_000);
`,
  );
  fs.chmodSync(shimPath, 0o755);

  try {
    // Route the helper's spawnSync call to the hanging shim regardless of
    // the `osascript` cmd argument. We still pass `opts` so Node's real
    // timeout semantics apply — this validates the end-to-end behavior.
    const hangingSpawnSync = (_cmd, args, opts) =>
      spawnSync(shimPath, args, opts);

    const start = Date.now();
    displayMacNotification('t', 'b', undefined, {
      spawnSyncFn: hangingSpawnSync,
      forceDarwin: true,
      timeoutMs: HANG_TIMEOUT_MS,
    });
    const elapsed = Date.now() - start;

    assert.ok(
      elapsed < HANG_TIMEOUT_MS + 2_000,
      `elapsed ${elapsed}ms exceeds bound (timeout ${HANG_TIMEOUT_MS}ms + 2s slack); hang guard did not fire`,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  NOTIFICATION_KINDS,
  loadNotificationSettings,
  notifySessionEvent,
  resetNotificationDedupForTests,
} from '../services/notification-dispatcher.js';

const baseEvent = {
  kind: 'mux_session_end',
  session: 'session-1',
  severity: 'info',
  title: 'Run Complete',
  body: '5 iterations',
  subtitle: 'Finished',
};

beforeEach(() => {
  resetNotificationDedupForTests();
});

describe('notifySessionEvent', () => {
  test('dispatch wraps OS helper and returns os channel', () => {
    const delivered = [];
    const result = notifySessionEvent(baseEvent, {
      osProbe: () => true,
      osNotifier: (event, timeoutMs) => delivered.push({ event, timeoutMs }),
      terminalWrite: () => {
        throw new Error('terminal should not be used');
      },
      timeoutMs: 1234,
      nowMs: 1,
    });

    assert.deepEqual(result, { delivered: true, channel: 'os' });
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].event.title, 'Run Complete');
    assert.equal(delivered[0].timeoutMs, 1234);
  });

  test('missing OS notifier returns terminal fallback and never throws', () => {
    const lines = [];
    const result = notifySessionEvent(baseEvent, {
      osProbe: () => false,
      terminalWrite: (line) => lines.push(line),
      nowMs: 1,
    });

    assert.deepEqual(result, { delivered: true, channel: 'terminal', reason: 'os_unavailable' });
    assert.match(lines.join(''), /Run Complete: 5 iterations/);
  });

  test('OS notifier failure returns terminal fallback and never throws', () => {
    const lines = [];
    let result;
    assert.doesNotThrow(() => {
      result = notifySessionEvent(baseEvent, {
        osProbe: () => true,
        osNotifier: () => {
          throw new Error('osascript missing');
        },
        terminalWrite: (line) => lines.push(line),
        nowMs: 1,
      });
    });

    assert.equal(result.delivered, true);
    assert.equal(result.channel, 'terminal');
    assert.match(result.reason, /^os_failed:osascript missing$/);
    assert.match(lines.join(''), /Run Complete/);
  });

  test('settings can disable OS notifications while preserving terminal fallback', () => {
    let osCalls = 0;
    const lines = [];
    const result = notifySessionEvent(baseEvent, {
      settings: { os_enabled: false, terminal_fallback: true },
      osProbe: () => true,
      osNotifier: () => {
        osCalls++;
      },
      terminalWrite: (line) => lines.push(line),
      nowMs: 1,
    });

    assert.equal(osCalls, 0);
    assert.deepEqual(result, { delivered: true, channel: 'terminal', reason: 'os_disabled' });
    assert.match(lines.join(''), /Run Complete/);
  });

  test('dedup suppresses same kind/session within 60s at lower or equal severity', () => {
    const calls = [];
    const first = notifySessionEvent(baseEvent, {
      osProbe: () => true,
      osNotifier: (event) => calls.push(event),
      nowMs: 1_000,
    });
    const second = notifySessionEvent({ ...baseEvent, severity: 'info' }, {
      osProbe: () => true,
      osNotifier: (event) => calls.push(event),
      nowMs: 30_000,
    });

    assert.deepEqual(first, { delivered: true, channel: 'os' });
    assert.deepEqual(second, { delivered: false, channel: 'suppressed', reason: 'duplicate' });
    assert.equal(calls.length, 1);
  });

  test('dedup emits higher severity within 60s', () => {
    const calls = [];
    notifySessionEvent({ ...baseEvent, severity: 'warning' }, {
      osProbe: () => true,
      osNotifier: (event) => calls.push(event),
      nowMs: 1_000,
    });
    const second = notifySessionEvent({ ...baseEvent, severity: 'error' }, {
      osProbe: () => true,
      osNotifier: (event) => calls.push(event),
      nowMs: 30_000,
    });

    assert.deepEqual(second, { delivered: true, channel: 'os' });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].severity, 'error');
  });

  for (const kind of NOTIFICATION_KINDS) {
    test(`NotificationKind ${kind} has settings gate and dedup rule`, () => {
      const event = { ...baseEvent, kind, session: `session-${kind}` };
      const disabled = notifySessionEvent(event, {
        settings: { kinds: { [kind]: false } },
        osProbe: () => true,
        osNotifier: () => {
          throw new Error('disabled kind should not notify');
        },
        nowMs: 1,
      });
      assert.deepEqual(disabled, { delivered: false, channel: 'suppressed', reason: 'kind_disabled' });

      resetNotificationDedupForTests();
      const calls = [];
      notifySessionEvent(event, {
        osProbe: () => true,
        osNotifier: (notification) => calls.push(notification),
        nowMs: 1,
      });
      const duplicate = notifySessionEvent(event, {
        osProbe: () => true,
        osNotifier: (notification) => calls.push(notification),
        nowMs: 2,
      });

      assert.equal(calls.length, 1);
      assert.deepEqual(duplicate, { delivered: false, channel: 'suppressed', reason: 'duplicate' });
    });
  }
});

test('loadNotificationSettings reads notification block with defaults', () => {
  const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notif-settings-')));
  try {
    fs.writeFileSync(path.join(tmpDir, 'pickle_settings.json'), JSON.stringify({
      notifications: {
        os_enabled: false,
        kinds: { mux_session_end: false },
      },
    }));

    assert.deepEqual(loadNotificationSettings(tmpDir), {
      os_enabled: false,
      terminal_fallback: true,
      dedup_window_ms: 60_000,
      kinds: {
        mux_session_end: false,
        pipeline_session_end: true,
      },
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

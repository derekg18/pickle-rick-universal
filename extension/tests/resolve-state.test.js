import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveStateFile, loadActiveState, approve, selectScannedStateFile } from '../hooks/resolve-state.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-state-'));
}

function baseState(overrides = {}) {
  return {
    active: true,
    working_dir: process.cwd(),
    step: 'prd',
    iteration: 0,
    max_iterations: 5,
    max_time_minutes: 60,
    worker_timeout_seconds: 1200,
    start_time_epoch: Math.floor(Date.now() / 1000) - 30,
    completion_promise: null,
    original_prompt: 'test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: '/tmp/test',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveStateFile
// ---------------------------------------------------------------------------

test('resolveStateFile: returns env PICKLE_STATE_FILE when set and file exists', () => {
  const tmp = tmpDir();
  try {
    const stateFile = path.join(tmp, 'state.json');
    fs.writeFileSync(stateFile, JSON.stringify(baseState()));
    const orig = process.env.PICKLE_STATE_FILE;
    process.env.PICKLE_STATE_FILE = stateFile;
    try {
      const result = resolveStateFile(tmp);
      assert.equal(result, stateFile);
    } finally {
      if (orig === undefined) delete process.env.PICKLE_STATE_FILE;
      else process.env.PICKLE_STATE_FILE = orig;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test('resolveStateFile: stale env state for another cwd falls back to the live mapped session for this cwd', () => {
  const tmp = tmpDir();
  try {
    const staleSessionDir = path.join(tmp, 'sessions', 'stale-session');
    const liveSessionDir = path.join(tmp, 'sessions', 'live-session');
    fs.mkdirSync(staleSessionDir, { recursive: true });
    fs.mkdirSync(liveSessionDir, { recursive: true });
    const staleStateFile = path.join(staleSessionDir, 'state.json');
    const liveStateFile = path.join(liveSessionDir, 'state.json');
    fs.writeFileSync(
      staleStateFile,
      JSON.stringify(baseState({ working_dir: '/tmp/other-project', session_dir: staleSessionDir })),
    );
    fs.writeFileSync(
      liveStateFile,
      JSON.stringify(baseState({ working_dir: process.cwd(), session_dir: liveSessionDir })),
    );
    fs.writeFileSync(
      path.join(tmp, 'current_sessions.json'),
      JSON.stringify({ [process.cwd()]: liveSessionDir }),
    );

    const orig = process.env.PICKLE_STATE_FILE;
    process.env.PICKLE_STATE_FILE = staleStateFile;
    try {
      assert.equal(resolveStateFile(tmp), liveStateFile);
    } finally {
      if (orig === undefined) delete process.env.PICKLE_STATE_FILE;
      else process.env.PICKLE_STATE_FILE = orig;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test('resolveStateFile: returns null when env points to non-existent file', () => {
  const tmp = tmpDir();
  try {
    const orig = process.env.PICKLE_STATE_FILE;
    process.env.PICKLE_STATE_FILE = path.join(tmp, 'nope.json');
    try {
      assert.equal(resolveStateFile(tmp), null);
    } finally {
      if (orig === undefined) delete process.env.PICKLE_STATE_FILE;
      else process.env.PICKLE_STATE_FILE = orig;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test('resolveStateFile: falls back to sessions map when env not set', () => {
  const tmp = tmpDir();
  try {
    const sessionDir = path.join(tmp, 'session1');
    fs.mkdirSync(sessionDir);
    const stateFile = path.join(sessionDir, 'state.json');
    fs.writeFileSync(stateFile, JSON.stringify(baseState({ working_dir: process.cwd(), session_dir: sessionDir })));
    const map = { [process.cwd()]: sessionDir };
    fs.writeFileSync(path.join(tmp, 'current_sessions.json'), JSON.stringify(map));

    const orig = process.env.PICKLE_STATE_FILE;
    delete process.env.PICKLE_STATE_FILE;
    try {
      const result = resolveStateFile(tmp);
      assert.equal(result, stateFile);
    } finally {
      if (orig !== undefined) process.env.PICKLE_STATE_FILE = orig;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test('resolveStateFile: promotes newer dead current_sessions tmp before resolving hook state', () => {
  const tmp = tmpDir();
  try {
    const sessionDir = path.join(tmp, 'session1');
    fs.mkdirSync(sessionDir);
    const stateFile = path.join(sessionDir, 'state.json');
    fs.writeFileSync(stateFile, JSON.stringify(baseState({ working_dir: process.cwd(), session_dir: sessionDir })));

    const mapPath = path.join(tmp, 'current_sessions.json');
    const tmpMapPath = `${mapPath}.tmp.99999999.${Date.now()}`;
    fs.writeFileSync(mapPath, JSON.stringify({ '/other/cwd': '/other/session' }));
    fs.writeFileSync(tmpMapPath, JSON.stringify({ [process.cwd()]: sessionDir }));
    const baseTime = new Date('2026-04-28T12:00:00.000Z');
    const tmpTime = new Date('2026-04-28T12:00:01.000Z');
    fs.utimesSync(mapPath, baseTime, baseTime);
    fs.utimesSync(tmpMapPath, tmpTime, tmpTime);

    const orig = process.env.PICKLE_STATE_FILE;
    delete process.env.PICKLE_STATE_FILE;
    try {
      assert.equal(resolveStateFile(tmp), stateFile);
      assert.equal(fs.existsSync(tmpMapPath), false, 'dead tmp map should be promoted');
      assert.deepEqual(JSON.parse(fs.readFileSync(mapPath, 'utf-8')), { [process.cwd()]: sessionDir });
    } finally {
      if (orig !== undefined) process.env.PICKLE_STATE_FILE = orig;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test('resolveStateFile: returns null when sessions map is missing', () => {
  const tmp = tmpDir();
  try {
    const orig = process.env.PICKLE_STATE_FILE;
    delete process.env.PICKLE_STATE_FILE;
    try {
      assert.equal(resolveStateFile(tmp), null);
    } finally {
      if (orig !== undefined) process.env.PICKLE_STATE_FILE = orig;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test('resolveStateFile: falls back to sessions/*/state.json when the sessions map is missing', () => {
  const tmp = tmpDir();
  try {
    const sessionDir = path.join(tmp, 'sessions', 'session1');
    fs.mkdirSync(sessionDir, { recursive: true });
    const stateFile = path.join(sessionDir, 'state.json');
    fs.writeFileSync(stateFile, JSON.stringify(baseState({ working_dir: process.cwd() })));
    const orig = process.env.PICKLE_STATE_FILE;
    delete process.env.PICKLE_STATE_FILE;
    try {
      const result = resolveStateFile(tmp);
      assert.equal(result, stateFile);
    } finally {
      if (orig !== undefined) process.env.PICKLE_STATE_FILE = orig;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test('selectScannedStateFile: picks the newest active same-cwd session when older state files are listed first', () => {
  const tmp = tmpDir();
  try {
    const sessionsDir = path.join(tmp, 'sessions');
    const olderSessionDir = path.join(sessionsDir, 'older-session');
    const newerSessionDir = path.join(sessionsDir, 'newer-session');
    fs.mkdirSync(olderSessionDir, { recursive: true });
    fs.mkdirSync(newerSessionDir, { recursive: true });

    const olderStateFile = path.join(olderSessionDir, 'state.json');
    const newerStateFile = path.join(newerSessionDir, 'state.json');
    fs.writeFileSync(
      olderStateFile,
      JSON.stringify(baseState({
        session_dir: olderSessionDir,
        started_at: '2026-04-27T12:00:00.000Z',
      })),
    );
    fs.writeFileSync(
      newerStateFile,
      JSON.stringify(baseState({
        session_dir: newerSessionDir,
        started_at: '2026-04-28T12:00:00.000Z',
        current_ticket: 'latest-ticket',
      })),
    );
    assert.equal(
      selectScannedStateFile([olderStateFile, newerStateFile], process.cwd()),
      newerStateFile,
    );
    const resolvedState = loadActiveState(newerStateFile);
    assert.equal(resolvedState?.current_ticket, 'latest-ticket');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveStateFile: future-dated started_at does not outrank a newer same-cwd active session', () => {
  const tmp = tmpDir();
  try {
    const staleSessionDir = path.join(tmp, 'sessions', 'stale-session');
    const liveSessionDir = path.join(tmp, 'sessions', 'live-session');
    fs.mkdirSync(staleSessionDir, { recursive: true });
    fs.mkdirSync(liveSessionDir, { recursive: true });
    const staleStateFile = path.join(staleSessionDir, 'state.json');
    const liveStateFile = path.join(liveSessionDir, 'state.json');
    fs.writeFileSync(
      staleStateFile,
      JSON.stringify(baseState({
        schema_version: 1,
        session_dir: staleSessionDir,
        current_ticket: 'future-ticket',
        started_at: '2099-12-31T23:59:59.000Z',
      })),
    );
    fs.writeFileSync(
      liveStateFile,
      JSON.stringify(baseState({
        schema_version: 1,
        session_dir: liveSessionDir,
        current_ticket: 'live-ticket',
        started_at: '2026-04-28T12:00:00.000Z',
      })),
    );
    fs.utimesSync(staleStateFile, new Date('2026-04-01T12:00:00.000Z'), new Date('2026-04-01T12:00:00.000Z'));
    fs.utimesSync(liveStateFile, new Date('2026-04-28T12:00:00.000Z'), new Date('2026-04-28T12:00:00.000Z'));

    const orig = process.env.PICKLE_STATE_FILE;
    delete process.env.PICKLE_STATE_FILE;
    try {
      assert.equal(resolveStateFile(tmp), liveStateFile);
    } finally {
      if (orig !== undefined) process.env.PICKLE_STATE_FILE = orig;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveStateFile: stale mapped inactive session falls back to the live active state for the cwd', () => {
  const tmp = tmpDir();
  try {
    const staleSessionDir = path.join(tmp, 'sessions', 'stale-session');
    const liveSessionDir = path.join(tmp, 'sessions', 'live-session');
    fs.mkdirSync(staleSessionDir, { recursive: true });
    fs.mkdirSync(liveSessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(staleSessionDir, 'state.json'),
      JSON.stringify(baseState({ active: false, session_dir: staleSessionDir })),
    );
    const liveStateFile = path.join(liveSessionDir, 'state.json');
    fs.writeFileSync(
      liveStateFile,
      JSON.stringify(baseState({ active: true, session_dir: liveSessionDir })),
    );
    fs.writeFileSync(
      path.join(tmp, 'current_sessions.json'),
      JSON.stringify({ [process.cwd()]: staleSessionDir }),
    );

    const orig = process.env.PICKLE_STATE_FILE;
    delete process.env.PICKLE_STATE_FILE;
    try {
      assert.equal(resolveStateFile(tmp), liveStateFile);
    } finally {
      if (orig !== undefined) process.env.PICKLE_STATE_FILE = orig;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test('resolveStateFile: mapped dead-pid active session falls back to the live active state for the cwd', () => {
  const tmp = tmpDir();
  try {
    const staleSessionDir = path.join(tmp, 'sessions', 'stale-session');
    const liveSessionDir = path.join(tmp, 'sessions', 'live-session');
    fs.mkdirSync(staleSessionDir, { recursive: true });
    fs.mkdirSync(liveSessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(staleSessionDir, 'state.json'),
      JSON.stringify(baseState({ active: true, pid: 99999999, session_dir: staleSessionDir })),
    );
    const liveStateFile = path.join(liveSessionDir, 'state.json');
    fs.writeFileSync(
      liveStateFile,
      JSON.stringify(baseState({ active: true, session_dir: liveSessionDir })),
    );
    fs.writeFileSync(
      path.join(tmp, 'current_sessions.json'),
      JSON.stringify({ [process.cwd()]: staleSessionDir }),
    );

    const orig = process.env.PICKLE_STATE_FILE;
    delete process.env.PICKLE_STATE_FILE;
    try {
      assert.equal(resolveStateFile(tmp), liveStateFile);
    } finally {
      if (orig !== undefined) process.env.PICKLE_STATE_FILE = orig;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test('resolveStateFile: returns null when sessions map is corrupt JSON', () => {
  const tmp = tmpDir();
  try {
    fs.writeFileSync(path.join(tmp, 'current_sessions.json'), '{{{bad');
    const orig = process.env.PICKLE_STATE_FILE;
    delete process.env.PICKLE_STATE_FILE;
    try {
      assert.equal(resolveStateFile(tmp), null);
    } finally {
      if (orig !== undefined) process.env.PICKLE_STATE_FILE = orig;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test('resolveStateFile: returns null when cwd not in sessions map', () => {
  const tmp = tmpDir();
  try {
    const map = { '/some/other/dir': path.join(tmp, 'session1') };
    fs.writeFileSync(path.join(tmp, 'current_sessions.json'), JSON.stringify(map));
    const orig = process.env.PICKLE_STATE_FILE;
    delete process.env.PICKLE_STATE_FILE;
    try {
      assert.equal(resolveStateFile(tmp), null);
    } finally {
      if (orig !== undefined) process.env.PICKLE_STATE_FILE = orig;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test('resolveStateFile: returns null when session dir from map has no state.json', () => {
  const tmp = tmpDir();
  try {
    const sessionDir = path.join(tmp, 'session-empty');
    fs.mkdirSync(sessionDir);
    const map = { [process.cwd()]: sessionDir };
    fs.writeFileSync(path.join(tmp, 'current_sessions.json'), JSON.stringify(map));
    const orig = process.env.PICKLE_STATE_FILE;
    delete process.env.PICKLE_STATE_FILE;
    try {
      assert.equal(resolveStateFile(tmp), null);
    } finally {
      if (orig !== undefined) process.env.PICKLE_STATE_FILE = orig;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// loadActiveState
// ---------------------------------------------------------------------------

test('loadActiveState: returns state when active and working_dir matches cwd', () => {
  const tmp = tmpDir();
  try {
    const stateFile = path.join(tmp, 'state.json');
    const state = baseState({ working_dir: process.cwd() });
    fs.writeFileSync(stateFile, JSON.stringify(state));
    const result = loadActiveState(stateFile);
    assert.ok(result);
    assert.equal(result.active, true);
    assert.equal(result.step, 'prd');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test('loadActiveState: returns state when working_dir is empty (matches any cwd)', () => {
  const tmp = tmpDir();
  try {
    const stateFile = path.join(tmp, 'state.json');
    const state = baseState({ working_dir: '' });
    fs.writeFileSync(stateFile, JSON.stringify(state));
    const result = loadActiveState(stateFile);
    assert.ok(result);
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test('loadActiveState: returns state when working_dir is null (matches any cwd)', () => {
  const tmp = tmpDir();
  try {
    const stateFile = path.join(tmp, 'state.json');
    const state = baseState({ working_dir: null });
    fs.writeFileSync(stateFile, JSON.stringify(state));
    const result = loadActiveState(stateFile);
    assert.ok(result);
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test('loadActiveState: returns null when working_dir does not match cwd', () => {
  const tmp = tmpDir();
  try {
    const stateFile = path.join(tmp, 'state.json');
    const state = baseState({ working_dir: '/some/other/project' });
    fs.writeFileSync(stateFile, JSON.stringify(state));
    assert.equal(loadActiveState(stateFile), null);
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test('loadActiveState: returns null when session is inactive', () => {
  const tmp = tmpDir();
  try {
    const stateFile = path.join(tmp, 'state.json');
    const state = baseState({ active: false });
    fs.writeFileSync(stateFile, JSON.stringify(state));
    assert.equal(loadActiveState(stateFile), null);
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test('loadActiveState: returns null when active session belongs to a dead pid', () => {
  const tmp = tmpDir();
  try {
    const stateFile = path.join(tmp, 'state.json');
    const state = baseState({ active: true, pid: 99999999 });
    fs.writeFileSync(stateFile, JSON.stringify(state));
    assert.equal(loadActiveState(stateFile), null);
    const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(persisted.active, false, 'dead-pid recovery should persist active=false');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test('loadActiveState: returns null when state.json is corrupt', () => {
  const tmp = tmpDir();
  try {
    const stateFile = path.join(tmp, 'state.json');
    fs.writeFileSync(stateFile, '!!!not json!!!');
    assert.equal(loadActiveState(stateFile), null);
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test('loadActiveState: returns null when file does not exist', () => {
  assert.equal(loadActiveState('/tmp/nonexistent-state-xyz.json'), null);
});

// ---------------------------------------------------------------------------
// approve
// ---------------------------------------------------------------------------

test('approve: outputs JSON with decision "approve" to stdout', () => {
  const origLog = console.log;
  let output = '';
  console.log = (msg) => { output = msg; };
  try {
    approve();
    const parsed = JSON.parse(output);
    assert.equal(parsed.decision, 'approve');
  } finally {
    console.log = origLog;
  }
});

test('approve: never outputs "allow"', () => {
  const origLog = console.log;
  let output = '';
  console.log = (msg) => { output = msg; };
  try {
    approve();
    assert.ok(!output.includes('allow'), 'approve() must not contain "allow"');
  } finally {
    console.log = origLog;
  }
});

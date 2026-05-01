import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STOP_HOOK = path.resolve(__dirname, '../hooks/handlers/stop-hook.js');
const RESOLVE_STATE = path.resolve(__dirname, '../hooks/resolve-state.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a valid base state, with optional overrides. */
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
    original_prompt: 'test task',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: '/tmp/pickle-test',
    tmux_mode: false,
    ...overrides,
  };
}

/**
 * Run stop-hook.js as a subprocess.
 *
 * Options:
 *   state           – state object written to state.json
 *   response        – value for last_assistant_message in the hook input JSON
 *   role            – value for PICKLE_ROLE env var (omitted if undefined)
 *   setStateFileEnv – if true (default), sets PICKLE_STATE_FILE; if false,
 *                     the hook resolves state via current_sessions.json instead
 *
 * Returns { decision, state } where state is the (possibly updated)
 * state.json read back after the hook exits.
 */
function runHook(opts = {}) {
  const { state = baseState(), response = '', role = undefined, setStateFileEnv = true } = opts;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-'));
  const sessionDir = path.join(tmpDir, 'session');
  fs.mkdirSync(sessionDir);
  const stateFile = path.join(sessionDir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify(state));

  // Always write a sessions map so tests that set setStateFileEnv=false still work.
  fs.writeFileSync(
    path.join(tmpDir, 'current_sessions.json'),
    JSON.stringify({ [process.cwd()]: sessionDir })
  );

  const env = { ...process.env, EXTENSION_DIR: tmpDir, FORCE_COLOR: '0' };
  delete env.PICKLE_ROLE;
  delete env.PICKLE_STATE_FILE;
  if (setStateFileEnv) env.PICKLE_STATE_FILE = stateFile;
  if (role !== undefined) env.PICKLE_ROLE = role;

  try {
    const stdout = execFileSync(process.execPath, [STOP_HOOK], {
      input: JSON.stringify({ last_assistant_message: response }),
      encoding: 'utf-8',
      env,
    });
    return {
      decision: JSON.parse(stdout.trim()),
      state: JSON.parse(fs.readFileSync(stateFile, 'utf-8')),
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Run stop-hook.js with raw stdin (no JSON wrapping) for testing empty/corrupted input.
 * Returns { decision, debugLog }.
 */
function runHookRaw(opts = {}) {
  const { state = baseState(), stdin = '', setStateFileEnv = true } = opts;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-raw-'));
  const sessionDir = path.join(tmpDir, 'session');
  fs.mkdirSync(sessionDir);
  const stateFile = path.join(sessionDir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify(state));
  fs.writeFileSync(
    path.join(tmpDir, 'current_sessions.json'),
    JSON.stringify({ [process.cwd()]: sessionDir })
  );

  const env = { ...process.env, EXTENSION_DIR: tmpDir, FORCE_COLOR: '0' };
  delete env.PICKLE_ROLE;
  delete env.PICKLE_STATE_FILE;
  if (setStateFileEnv) env.PICKLE_STATE_FILE = stateFile;

  try {
    const stdout = execFileSync(process.execPath, [STOP_HOOK], {
      input: stdin,
      encoding: 'utf-8',
      env,
    });
    const debugLogPath = path.join(tmpDir, 'debug.log');
    const debugLog = fs.existsSync(debugLogPath)
      ? fs.readFileSync(debugLogPath, 'utf-8')
      : '';
    return { decision: JSON.parse(stdout.trim()), debugLog };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Bypass conditions — always approve, no state mutation
// ---------------------------------------------------------------------------

test('stop-hook: no state file found → approve', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-'));
  try {
    const env = {
      ...process.env,
      EXTENSION_DIR: tmpDir,
      FORCE_COLOR: '0',
      PICKLE_STATE_FILE: path.join(tmpDir, 'nonexistent.json'),
    };
    delete env.PICKLE_ROLE;
    const stdout = execFileSync(process.execPath, [STOP_HOOK], {
      input: JSON.stringify({ last_assistant_message: '' }),
      encoding: 'utf-8',
      env,
    });
    assert.deepEqual(JSON.parse(stdout.trim()), { decision: 'approve' });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('stop-hook: working_dir mismatch → approve, state unchanged', () => {
  const { decision, state } = runHook({
    state: baseState({ working_dir: '/tmp/some-other-project' }),
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true);
});

test('stop-hook: session inactive → approve', () => {
  const { decision, state } = runHook({ state: baseState({ active: false }) });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, false);
});

test('stop-hook: stale active=true dead pid from PICKLE_STATE_FILE is recovered to inactive before hook gating', () => {
  const { decision, state } = runHook({
    state: baseState({ active: true, pid: 99999999 }),
    response: '',
    setStateFileEnv: true,
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, false, 'dead-pid recovery must clear stale active sessions before stop-hook gating');
});

test('stop-hook: tmux_mode, no PICKLE_STATE_FILE (main window) → approve, state unchanged', () => {
  // Main Claude window: resolves state via sessions map, not PICKLE_STATE_FILE
  const { decision, state } = runHook({
    state: baseState({ tmux_mode: true }),
    setStateFileEnv: false,
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true, 'main window must not deactivate the session');
});

test('stop-hook: stale state (active:false + tmux_mode:true) → inactive path fires first, not tmux defer', () => {
    // REGRESSION: a stale state.json from a prior tmux session (active:false but
    // tmux_mode:true) used to short-circuit through the "tmux defer" early-exit
    // BEFORE the inactive check, masking a wrong-state-file resolution bug. The
    // inactive check must fire first so the decision reflects the actual state.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-stale-'));
    const sessionDir = path.join(tmpDir, 'session');
    fs.mkdirSync(sessionDir);
    const stateFile = path.join(sessionDir, 'state.json');
    fs.writeFileSync(stateFile, JSON.stringify(baseState({ active: false, tmux_mode: true })));
    fs.writeFileSync(
        path.join(tmpDir, 'current_sessions.json'),
        JSON.stringify({ [process.cwd()]: sessionDir }),
    );
    const env = { ...process.env, EXTENSION_DIR: tmpDir, FORCE_COLOR: '0', PICKLE_STATE_FILE: stateFile };
    delete env.PICKLE_ROLE;
    try {
        execFileSync(process.execPath, [STOP_HOOK], {
            input: JSON.stringify({ last_assistant_message: '' }),
            encoding: 'utf-8',
            env,
        });
        const debugLog = fs.readFileSync(path.join(tmpDir, 'debug.log'), 'utf-8');
        assert.match(debugLog, /Decision: APPROVE \(Session inactive\)/,
            'stale inactive session must hit the inactive branch, not tmux defer');
        assert.doesNotMatch(debugLog, /tmux mode — main window defers to tmux-runner/,
            'inactive check must fire before tmux defer check');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('stop-hook: tmux_mode, PICKLE_STATE_FILE set (subprocess) → does not early-exit', () => {
  // Subprocess: has PICKLE_STATE_FILE, should fall through to normal block logic
  const { decision } = runHook({
    state: baseState({ tmux_mode: true }),
    setStateFileEnv: true,
    response: '', // no token → default block
  });
  assert.equal(decision.decision, 'block', 'tmux subprocess must not bypass the hook');
});

// ---------------------------------------------------------------------------
// Exit conditions — approve and deactivate session
// ---------------------------------------------------------------------------

test('stop-hook: EPIC_COMPLETED → approve + active=false', () => {
  const { decision, state } = runHook({
    response: 'Work done. <promise>EPIC_COMPLETED</promise>',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, false);
});

test('stop-hook: TASK_COMPLETED → approve + active=false', () => {
  const { decision, state } = runHook({
    response: '<promise>TASK_COMPLETED</promise>',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, false);
});

test('stop-hook: recovered disabled auto-update settings suppress completion update spawn', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-update-settings-'));
  const sessionDir = path.join(tmpDir, 'session');
  const stateFile = path.join(sessionDir, 'state.json');
  const settingsPath = path.join(tmpDir, 'pickle_settings.json');
  const checkUpdateDir = path.join(tmpDir, 'extension', 'bin');
  const checkUpdatePath = path.join(checkUpdateDir, 'check-update.js');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(checkUpdateDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(baseState({ session_dir: sessionDir })));
  fs.writeFileSync(settingsPath, JSON.stringify({ auto_update_enabled: true }));
  fs.writeFileSync(`${settingsPath}.tmp.99999999`, JSON.stringify({ auto_update_enabled: false }));
  fs.writeFileSync(checkUpdatePath, 'process.exit(0);\n');
  const older = new Date(Date.now() - 10_000);
  const newer = new Date();
  fs.utimesSync(settingsPath, older, older);
  fs.utimesSync(`${settingsPath}.tmp.99999999`, newer, newer);

  const env = { ...process.env, EXTENSION_DIR: tmpDir, FORCE_COLOR: '0', PICKLE_STATE_FILE: stateFile };
  delete env.PICKLE_ROLE;

  try {
    const stdout = execFileSync(process.execPath, [STOP_HOOK], {
      input: JSON.stringify({ last_assistant_message: '<promise>TASK_COMPLETED</promise>' }),
      encoding: 'utf-8',
      env,
    });
    assert.deepEqual(JSON.parse(stdout.trim()), { decision: 'approve' });
    const debugLog = fs.readFileSync(path.join(tmpDir, 'debug.log'), 'utf-8');
    assert.match(debugLog, /Auto-update disabled in settings, skipping/);
    assert.doesNotMatch(debugLog, /Spawning detached check-update process/);
    assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf-8')).auto_update_enabled, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('stop-hook: EPIC_COMPLETED + tmux_mode → approve, active UNCHANGED (runner owns active)', () => {
  const { decision, state } = runHook({
    state: baseState({ tmux_mode: true }),
    response: '<promise>EPIC_COMPLETED</promise>',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true, 'tmux mode: runner owns active — hook must not deactivate');
});

test('stop-hook: TASK_COMPLETED + tmux_mode → approve, active UNCHANGED (runner owns active)', () => {
  const { decision, state } = runHook({
    state: baseState({ tmux_mode: true }),
    response: '<promise>TASK_COMPLETED</promise>',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true, 'tmux mode: runner owns active — hook must not deactivate');
});

test('stop-hook: custom completion_promise match → approve + active=false', () => {
  const { decision, state } = runHook({
    state: baseState({ completion_promise: 'MY_CUSTOM_DONE' }),
    response: 'All done. <promise>MY_CUSTOM_DONE</promise>',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, false);
});

test('stop-hook: completion_promise set but wrong token in response → block', () => {
  const { decision } = runHook({
    state: baseState({ completion_promise: 'MY_CUSTOM_DONE' }),
    response: 'Not done yet.',
  });
  assert.equal(decision.decision, 'block');
});

test('stop-hook: worker + I AM DONE → approve, active unchanged', () => {
  const { decision, state } = runHook({
    state: baseState({ active: true }),
    response: '<promise>I AM DONE</promise>',
    role: 'worker',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true, 'workers must not deactivate the session');
});

test('stop-hook: worker + EPIC_COMPLETED → approve, active unchanged', () => {
  const { decision, state } = runHook({
    state: baseState({ active: true }),
    response: '<promise>EPIC_COMPLETED</promise>',
    role: 'worker',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true, 'workers must not deactivate the session');
});

// ---------------------------------------------------------------------------
// Checkpoint conditions (non-tmux) — block with phase-specific feedback
// ---------------------------------------------------------------------------

test('stop-hook: PRD_COMPLETE (non-tmux) → block, feedback mentions breakdown', () => {
  const { decision } = runHook({ response: '<promise>PRD_COMPLETE</promise>' });
  assert.equal(decision.decision, 'block');
  assert.ok(decision.reason.includes('breakdown'), decision.reason);
});

test('stop-hook: TICKET_SELECTED (non-tmux) → block, feedback mentions research', () => {
  const { decision } = runHook({ response: '<promise>TICKET_SELECTED</promise>' });
  assert.equal(decision.decision, 'block');
  assert.ok(decision.reason.includes('research'), decision.reason);
});

// ---------------------------------------------------------------------------
// Checkpoint conditions (tmux subprocess) — approve, no state change
// ---------------------------------------------------------------------------

test('stop-hook: TICKET_SELECTED + tmux_mode + PICKLE_STATE_FILE → approve, no deactivate', () => {
  const { decision, state } = runHook({
    state: baseState({ tmux_mode: true }),
    setStateFileEnv: true,
    response: '<promise>TICKET_SELECTED</promise>',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true, 'checkpoint in tmux mode must not deactivate');
});

test('stop-hook: PRD_COMPLETE + tmux_mode + PICKLE_STATE_FILE → approve', () => {
  const { decision } = runHook({
    state: baseState({ tmux_mode: true }),
    setStateFileEnv: true,
    response: '<promise>PRD_COMPLETE</promise>',
  });
  assert.deepEqual(decision, { decision: 'approve' });
});

// ---------------------------------------------------------------------------
// Worker suppression — workers ignore manager checkpoint tokens
// ---------------------------------------------------------------------------

test('stop-hook: worker + PRD_COMPLETE → not treated as checkpoint, falls to default block', () => {
  // isWorker=true makes isPrdDone=false, so the checkpoint block is not entered
  const { decision } = runHook({
    state: baseState({ active: true }),
    response: '<promise>PRD_COMPLETE</promise>',
    role: 'worker',
  });
  assert.equal(decision.decision, 'block');
  assert.ok(!decision.reason.includes('breakdown'), 'should not include phase feedback');
});

test('stop-hook: state.worker=true (no PICKLE_ROLE) → NOT treated as worker, falls to default block', () => {
  // state.worker is a dead field — only PICKLE_ROLE=worker determines worker mode
  const { decision } = runHook({
    state: baseState({ worker: true }),
    response: '<promise>I AM DONE</promise>',
  });
  assert.equal(decision.decision, 'block', 'state.worker alone must not activate worker mode');
});

// ---------------------------------------------------------------------------
// Iteration and time limits
// ---------------------------------------------------------------------------

test('stop-hook: iteration >= max_iterations → approve + active=false', () => {
  const { decision, state } = runHook({
    state: baseState({ iteration: 5, max_iterations: 5 }),
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, false);
});

test('stop-hook: iteration > max_iterations → approve + active=false', () => {
  const { decision, state } = runHook({
    state: baseState({ iteration: 7, max_iterations: 5 }),
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, false);
});

test('stop-hook: max_iterations=0 (unlimited) → never fires limit, falls to default block', () => {
  const { decision } = runHook({
    state: baseState({ iteration: 999, max_iterations: 0 }),
  });
  assert.equal(decision.decision, 'block');
});

test('stop-hook: iteration limit + tmux_mode → approve, active UNCHANGED (runner handles limits)', () => {
  const { decision, state } = runHook({
    state: baseState({ tmux_mode: true, iteration: 5, max_iterations: 5 }),
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true, 'tmux mode: runner handles limits — hook must not deactivate');
});

test('stop-hook: time limit reached → approve + active=false', () => {
  const { decision, state } = runHook({
    state: baseState({
      start_time_epoch: Math.floor(Date.now() / 1000) - 3700, // 61 minutes ago
      max_time_minutes: 60,
    }),
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, false);
});

test('stop-hook: max_time_minutes=0 (unlimited) → never fires limit, falls to default block', () => {
  const { decision } = runHook({
    state: baseState({
      start_time_epoch: Math.floor(Date.now() / 1000) - 99999,
      max_time_minutes: 0,
    }),
  });
  assert.equal(decision.decision, 'block');
});

test('stop-hook: time limit + tmux_mode → approve, active UNCHANGED (runner handles limits)', () => {
  const { decision, state } = runHook({
    state: baseState({
      tmux_mode: true,
      start_time_epoch: Math.floor(Date.now() / 1000) - 3700,
      max_time_minutes: 60,
    }),
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true, 'tmux mode: runner handles limits — hook must not deactivate');
});

// ---------------------------------------------------------------------------
// Default block — active session, no tokens, no limits hit
// ---------------------------------------------------------------------------

test('stop-hook: active session, no tokens → block with iteration number', () => {
  const { decision } = runHook({
    state: baseState({ iteration: 3, max_iterations: 10 }),
  });
  assert.equal(decision.decision, 'block');
  assert.ok(decision.reason.includes('3'), decision.reason);
  assert.ok(decision.reason.includes('10'), decision.reason);
});

test('stop-hook: max_iterations=0 → block message has no "of N"', () => {
  const { decision } = runHook({
    state: baseState({ iteration: 2, max_iterations: 0 }),
  });
  assert.equal(decision.decision, 'block');
  assert.ok(!decision.reason.includes('of 0'), decision.reason);
});

test('stop-hook: promise token with surrounding text is still detected', () => {
  const { decision, state } = runHook({
    response: 'Done with everything!\n<promise>EPIC_COMPLETED</promise>\nGoodbye.',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, false);
});

test('stop-hook: token with extra whitespace inside tags IS matched (tolerant)', () => {
  // Whitespace-tolerant regex — spaces inside tags still trigger the match
  const { decision, state } = runHook({
    response: '<promise> EPIC_COMPLETED </promise>',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, false);
});

// ---------------------------------------------------------------------------
// resolve-state.ts exports
// ---------------------------------------------------------------------------

const { resolveStateFile, loadActiveState } = await import(RESOLVE_STATE);

test('resolve-state: resolveStateFile returns path when PICKLE_STATE_FILE set and file exists', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'));
  const stateFile = path.join(tmpDir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify(baseState()));
  const saved = process.env.PICKLE_STATE_FILE;
  try {
    process.env.PICKLE_STATE_FILE = stateFile;
    assert.equal(resolveStateFile(tmpDir), stateFile);
  } finally {
    if (saved === undefined) delete process.env.PICKLE_STATE_FILE;
    else process.env.PICKLE_STATE_FILE = saved;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolve-state: resolveStateFile returns null when PICKLE_STATE_FILE file is missing', () => {
  const saved = process.env.PICKLE_STATE_FILE;
  try {
    process.env.PICKLE_STATE_FILE = '/tmp/does-not-exist-ever.json';
    assert.equal(resolveStateFile('/tmp'), null);
  } finally {
    if (saved === undefined) delete process.env.PICKLE_STATE_FILE;
    else process.env.PICKLE_STATE_FILE = saved;
  }
});

test('resolve-state: resolveStateFile resolves via sessions map when no PICKLE_STATE_FILE', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'));
  const sessionDir = path.join(tmpDir, 'session');
  fs.mkdirSync(sessionDir);
  const stateFile = path.join(sessionDir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify(baseState({ session_dir: sessionDir })));
  fs.writeFileSync(
    path.join(tmpDir, 'current_sessions.json'),
    JSON.stringify({ [process.cwd()]: sessionDir })
  );
  const saved = process.env.PICKLE_STATE_FILE;
  try {
    delete process.env.PICKLE_STATE_FILE;
    assert.equal(resolveStateFile(tmpDir), stateFile);
  } finally {
    if (saved !== undefined) process.env.PICKLE_STATE_FILE = saved;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolve-state: resolveStateFile returns null when cwd not in sessions map', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'));
  fs.writeFileSync(
    path.join(tmpDir, 'current_sessions.json'),
    JSON.stringify({ '/some/other/dir': '/some/session' })
  );
  const saved = process.env.PICKLE_STATE_FILE;
  try {
    delete process.env.PICKLE_STATE_FILE;
    assert.equal(resolveStateFile(tmpDir), null);
  } finally {
    if (saved !== undefined) process.env.PICKLE_STATE_FILE = saved;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolve-state: loadActiveState returns state for active session with matching cwd', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'));
  const stateFile = path.join(tmpDir, 'state.json');
  const state = { active: true, working_dir: process.cwd(), step: 'prd' };
  fs.writeFileSync(stateFile, JSON.stringify(state));
  try {
    const loaded = loadActiveState(stateFile);
    assert.equal(loaded.active, true);
    assert.equal(loaded.step, 'prd');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolve-state: loadActiveState returns null for inactive session', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'));
  const stateFile = path.join(tmpDir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ active: false, working_dir: process.cwd() }));
  try {
    assert.equal(loadActiveState(stateFile), null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolve-state: loadActiveState returns null for cwd mismatch', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'));
  const stateFile = path.join(tmpDir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ active: true, working_dir: '/some/other/dir' }));
  try {
    assert.equal(loadActiveState(stateFile), null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolve-state: loadActiveState returns null when active is string "true" (strict check)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'));
  const stateFile = path.join(tmpDir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ active: "true", working_dir: process.cwd() }));
  try {
    assert.equal(loadActiveState(stateFile), null,
      'string "true" should not pass strict === true check');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Disabled marker — /disable-pickle creates this file to suppress the hook
// ---------------------------------------------------------------------------

test('stop-hook: disabled marker file → approve immediately, state unchanged', () => {
  const state = baseState();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-'));
  const sessionDir = path.join(tmpDir, 'session');
  fs.mkdirSync(sessionDir);
  const stateFile = path.join(sessionDir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify(state));
  // Create the disabled marker file
  fs.writeFileSync(path.join(tmpDir, 'disabled'), '');

  const env = { ...process.env, EXTENSION_DIR: tmpDir, FORCE_COLOR: '0', PICKLE_STATE_FILE: stateFile };
  delete env.PICKLE_ROLE;

  try {
    const stdout = execFileSync(process.execPath, [STOP_HOOK], {
      input: JSON.stringify({ last_assistant_message: '' }),
      encoding: 'utf-8',
      env,
    });
    assert.deepEqual(JSON.parse(stdout.trim()), { decision: 'approve' });
    // State should NOT be modified (no deactivation)
    const afterState = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    assert.equal(afterState.active, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('stop-hook: no disabled marker → hook processes normally (blocks active session)', () => {
  // Sanity check: without the marker, an active session with no tokens should block
  const { decision } = runHook({ state: baseState(), response: 'just some text' });
  assert.equal(decision.decision, 'block');
});

// ---------------------------------------------------------------------------
// Fail-open: corrupt state.json and invalid stdin
// ---------------------------------------------------------------------------

test('stop-hook: corrupt state.json → approve (fail-open)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-'));
  const sessionDir = path.join(tmpDir, 'session');
  fs.mkdirSync(sessionDir);
  const stateFile = path.join(sessionDir, 'state.json');
  fs.writeFileSync(stateFile, '{{{invalid json!!!');

  const env = { ...process.env, EXTENSION_DIR: tmpDir, FORCE_COLOR: '0', PICKLE_STATE_FILE: stateFile };
  delete env.PICKLE_ROLE;

  try {
    const stdout = execFileSync(process.execPath, [STOP_HOOK], {
      input: JSON.stringify({ last_assistant_message: '' }),
      encoding: 'utf-8',
      env,
    });
    assert.deepEqual(JSON.parse(stdout.trim()), { decision: 'approve' });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('stop-hook: empty stdin → approve (fail-open)', () => {
  const { decision } = runHook({ state: baseState({ active: false }), response: '' });
  assert.deepEqual(decision, { decision: 'approve' });
});

// ---------------------------------------------------------------------------
// Refinement worker — ANALYSIS_DONE token handling
// ---------------------------------------------------------------------------

test('stop-hook: refinement-worker + ANALYSIS_DONE → approve, active unchanged', () => {
  const { decision, state } = runHook({
    state: baseState({ active: true }),
    response: '<promise>ANALYSIS_DONE</promise>',
    role: 'refinement-worker',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true, 'refinement workers must not deactivate the session');
});

test('stop-hook: refinement-worker + no token → block (default continuation)', () => {
  const { decision } = runHook({
    state: baseState({ active: true }),
    response: 'Still working on analysis...',
    role: 'refinement-worker',
  });
  assert.equal(decision.decision, 'block');
});

test('stop-hook: non-refinement role + ANALYSIS_DONE → not treated as exit, block', () => {
  // ANALYSIS_DONE should only work for refinement-worker role
  const { decision } = runHook({
    state: baseState({ active: true }),
    response: '<promise>ANALYSIS_DONE</promise>',
    role: 'manager',
  });
  assert.equal(decision.decision, 'block');
});

// ---------------------------------------------------------------------------
// Number() coercion for string numeric state fields (deep review pass 5)
// ---------------------------------------------------------------------------

test('stop-hook: string max_iterations and iteration still trigger limit check', () => {
  const { decision, state } = runHook({
    state: baseState({ iteration: '3', max_iterations: '3' }),
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, false, 'should deactivate when string numerics match limit');
});

test('stop-hook: string start_time_epoch and max_time_minutes still trigger time limit', () => {
  const { decision, state } = runHook({
    state: baseState({
      start_time_epoch: String(Math.floor(Date.now() / 1000) - 3700),
      max_time_minutes: '60',
    }),
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, false, 'should deactivate when string time values exceed limit');
});

test('stop-hook: string "true" active is treated as inactive (strict boolean check)', () => {
  const { decision, state } = runHook({
    state: baseState({ active: "true" }),
    response: 'some text',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, "true", 'string "true" should not be modified — session treated as inactive');
});

test('stop-hook: string "true" tmux_mode is NOT treated as tmux mode (strict boolean check)', () => {
  // tmux_mode stored as string "true" (truthy but !== true) should NOT trigger tmux early-exit
  // setStateFileEnv: false so the tmux main-window branch (!process.env.PICKLE_STATE_FILE) is reachable
  const { decision } = runHook({
    state: baseState({ tmux_mode: "true" }),
    response: 'This is a longer response that avoids the degenerate short-response detection',
    setStateFileEnv: false,
  });
  // Should fall through to default block (active session, no tokens), not approve as tmux main-window
  assert.equal(decision.decision, 'block');
});

test('stop-hook: string "true" tmux_mode does NOT approve checkpoint tokens (strict boolean check)', () => {
  // tmux_mode stored as string "true" at the checkpoint path — should block, not approve
  const { decision } = runHook({
    state: baseState({ tmux_mode: "true" }),
    response: '<promise>PRD_COMPLETE</promise>',
  });
  // With real tmux_mode=true, this would approve. With string "true", it should block with feedback.
  assert.equal(decision.decision, 'block');
});

// ---------------------------------------------------------------------------
// EXISTENCE_IS_PAIN token — meeseeks code review loop
// ---------------------------------------------------------------------------

test('stop-hook: EXISTENCE_IS_PAIN → approve + active=false (standard completion)', () => {
  const { decision, state } = runHook({
    response: '<promise>EXISTENCE_IS_PAIN</promise>',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, false);
});

test('stop-hook: EXISTENCE_IS_PAIN below min_iterations (non-tmux) → block inline loop', () => {
  const { decision, state } = runHook({
    state: baseState({ min_iterations: 10, iteration: 3 }),
    response: '<promise>EXISTENCE_IS_PAIN</promise>',
  });
  assert.equal(decision.decision, 'block', 'non-tmux mode below min_iterations must block to continue inline loop');
  assert.equal(state.active, true, 'below min_iterations — active must stay true');
});

test('stop-hook: EXISTENCE_IS_PAIN below min_iterations (tmux) → approve for runner respawn', () => {
  const { decision, state } = runHook({
    state: baseState({ min_iterations: 10, iteration: 3, tmux_mode: true }),
    response: '<promise>EXISTENCE_IS_PAIN</promise>',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true, 'below min_iterations — active must stay true for runner to continue');
});

test('stop-hook: EXISTENCE_IS_PAIN at min_iterations → approve + active=false', () => {
  const { decision, state } = runHook({
    state: baseState({ min_iterations: 10, iteration: 10 }),
    response: '<promise>EXISTENCE_IS_PAIN</promise>',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, false, 'at min_iterations — should deactivate');
});

test('stop-hook: EXISTENCE_IS_PAIN at min_iterations + tmux_mode → approve, active UNCHANGED', () => {
  const { decision, state } = runHook({
    state: baseState({ tmux_mode: true, min_iterations: 10, iteration: 10 }),
    response: '<promise>EXISTENCE_IS_PAIN</promise>',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true, 'tmux mode: runner owns active — hook must not deactivate');
});

// ---------------------------------------------------------------------------
// THE_CITADEL_APPROVES token — council of ricks stack review loop
// ---------------------------------------------------------------------------

test('stop-hook: THE_CITADEL_APPROVES → approve + active=false (standard completion)', () => {
  const { decision, state } = runHook({
    response: '<promise>THE_CITADEL_APPROVES</promise>',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, false);
});

test('stop-hook: THE_CITADEL_APPROVES below min_iterations (non-tmux) → block inline loop', () => {
  const { decision, state } = runHook({
    state: baseState({ min_iterations: 10, iteration: 3 }),
    response: '<promise>THE_CITADEL_APPROVES</promise>',
  });
  assert.equal(decision.decision, 'block', 'non-tmux mode below min_iterations must block to continue inline loop');
  assert.equal(state.active, true, 'below min_iterations — active must stay true');
});

test('stop-hook: THE_CITADEL_APPROVES below min_iterations (tmux) → approve for runner respawn', () => {
  const { decision, state } = runHook({
    state: baseState({ min_iterations: 10, iteration: 3, tmux_mode: true }),
    response: '<promise>THE_CITADEL_APPROVES</promise>',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true, 'below min_iterations — active must stay true for runner to continue');
});

test('stop-hook: THE_CITADEL_APPROVES at min_iterations → approve + active=false', () => {
  const { decision, state } = runHook({
    state: baseState({ min_iterations: 10, iteration: 10 }),
    response: '<promise>THE_CITADEL_APPROVES</promise>',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, false, 'at min_iterations — should deactivate');
});

test('stop-hook: THE_CITADEL_APPROVES at min_iterations + tmux_mode → approve, active UNCHANGED', () => {
  const { decision, state } = runHook({
    state: baseState({ tmux_mode: true, min_iterations: 10, iteration: 10 }),
    response: '<promise>THE_CITADEL_APPROVES</promise>',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true, 'tmux mode: runner owns active — hook must not deactivate');
});

test('stop-hook: EPIC_COMPLETED ignores min_iterations → still deactivates', () => {
  const { decision, state } = runHook({
    state: baseState({ min_iterations: 10, iteration: 2 }),
    response: '<promise>EPIC_COMPLETED</promise>',
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, false, 'EPIC_COMPLETED must ignore min_iterations — no regression');
});

// ---------------------------------------------------------------------------
// Rate limit detection — approve exit so mux-runner handles backoff
// ---------------------------------------------------------------------------

test('stop-hook: short rate limit message → approve (hand off to runner)', () => {
  const { decision, state } = runHook({
    response: "You're out of extra usage · resets Mar 6 at 11am",
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true, 'rate limit approve must not deactivate — runner owns lifecycle');
});

test('stop-hook: "rate limit" short message → approve', () => {
  const { decision } = runHook({
    response: 'API rate limit exceeded.',
  });
  assert.deepEqual(decision, { decision: 'approve' });
});

test('stop-hook: "usage limit reached" short message → approve', () => {
  const { decision } = runHook({
    response: 'Your usage limit has been reached.',
  });
  assert.deepEqual(decision, { decision: 'approve' });
});

test('stop-hook: "hour limit" short message → approve', () => {
  const { decision } = runHook({
    response: 'You have exceeded your 5 requests per hour limit.',
  });
  assert.deepEqual(decision, { decision: 'approve' });
});

test('stop-hook: long response mentioning rate limit → block (not a real rate limit)', () => {
  // > 500 chars: normal conversation about rate limits, not a synthetic error
  const longText = 'I hit a rate limit but recovered and continued working on the task. ' +
    'Here is what I found during my research phase. '.repeat(15);
  assert.ok(longText.length > 500, 'test setup: text must be > 500 chars');
  const { decision } = runHook({ response: longText });
  assert.equal(decision.decision, 'block', 'long responses mentioning rate limits must not trigger early exit');
});

test('stop-hook: empty response → block (not a rate limit)', () => {
  const { decision } = runHook({ response: '' });
  assert.equal(decision.decision, 'block');
});

test('stop-hook: rate limit in tmux subprocess → approve, active unchanged', () => {
  const { decision, state } = runHook({
    state: baseState({ tmux_mode: true }),
    setStateFileEnv: true,
    response: "You're out of extra usage · resets Mar 6 at 11am",
  });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(state.active, true, 'tmux mode: runner owns active');
});

// ---------------------------------------------------------------------------
// NaN/undefined edge cases
// ---------------------------------------------------------------------------

test('stop-hook: NaN/undefined numeric state fields do not crash', () => {
  // max_iterations is undefined, iteration is "abc" → Number("abc") = NaN → || 0
  const { decision } = runHook({
    state: baseState({ iteration: 'abc', max_iterations: undefined, max_time_minutes: undefined, start_time_epoch: undefined }),
  });
  assert.equal(decision.decision, 'block', 'should fall through to default block without crashing');
});

// ---------------------------------------------------------------------------
// Edge cases: empty completion_promise, start_time_epoch=0 (pass 9)
// ---------------------------------------------------------------------------

test('stop-hook: completion_promise empty string → not treated as custom promise', () => {
  // !!("") is false, so hasPromise should be false even if responseText has <promise></promise>
  const { decision } = runHook({
    state: baseState({ completion_promise: '' }),
    response: 'no tokens here',
  });
  assert.equal(decision.decision, 'block', 'empty string completion_promise should not match anything');
});

test('stop-hook: start_time_epoch=0 with max_time_minutes>0 → time limit skipped', () => {
  // Line 210: maxTimeMins > 0 && startEpoch > 0 — when epoch is 0, the condition short-circuits
  const { decision } = runHook({
    state: baseState({
      start_time_epoch: 0,
      max_time_minutes: 1, // 1 minute — would trigger if epoch were valid
      iteration: 1,
      max_iterations: 100,
    }),
  });
  assert.equal(decision.decision, 'block', 'start_time_epoch=0 should disable time limit check');
});

// ---------------------------------------------------------------------------
// No-op / ack loop detection — approve exit to break degenerate feedback loops
// ---------------------------------------------------------------------------

test('stop-hook: "Acknowledged." response → approve (no-op detection)', () => {
  const { decision } = runHook({
    state: baseState({ iteration: 3, max_iterations: 50 }),
    response: 'Acknowledged.',
  });
  assert.equal(decision.decision, 'approve');
});

test('stop-hook: "OK" short response → approve (matches no-op pattern)', () => {
  // "OK" matches /^ok\.?$/i → no-op pattern → immediate approve regardless of counter.
  const { decision } = runHook({
    state: baseState({ iteration: 5, max_iterations: 50 }),
    response: 'OK',
  });
  assert.equal(decision.decision, 'approve');
});

test('stop-hook: "  Understood  " padded response → approve (no-op pattern after trim)', () => {
  // After trim: "Understood" (10 chars) matches /^understood\.?$/i → no-op → immediate approve.
  const { decision } = runHook({
    state: baseState({ iteration: 1, max_iterations: 10 }),
    response: '  Understood  ',
  });
  assert.equal(decision.decision, 'approve');
});

test('stop-hook: "Continuing." (12 chars) → approve (genuine no-op pattern match)', () => {
  // 12 chars after trim — above degenerate threshold, must be caught by no-op pattern
  const { decision } = runHook({
    state: baseState({ iteration: 2, max_iterations: 10 }),
    response: ' Continuing.',
  });
  assert.equal(decision.decision, 'approve');
});

test('stop-hook: "Got it." response → approve (matches no-op pattern)', () => {
  // "Got it." matches /^got it\.?$/i → no-op pattern → immediate approve regardless of counter.
  const { decision } = runHook({
    state: baseState({ iteration: 2, max_iterations: 10 }),
    response: 'Got it.',
  });
  assert.equal(decision.decision, 'approve');
});

test('stop-hook: substantive short response without tokens → still blocks (not a no-op)', () => {
  const { decision } = runHook({
    state: baseState({ iteration: 2, max_iterations: 10 }),
    response: 'I fixed the linting error in utils.ts and ran the tests.',
  });
  assert.equal(decision.decision, 'block');
});

test('stop-hook: no-op detection does not fire for empty response', () => {
  // Empty responses are handled by the existing default block path
  const { decision } = runHook({
    state: baseState({ iteration: 2, max_iterations: 10 }),
    response: '',
  });
  assert.equal(decision.decision, 'block');
});

// ---------------------------------------------------------------------------
// Degenerate short / whitespace response detection
// ---------------------------------------------------------------------------

test('stop-hook: whitespace-only response → approve + deactivate (inline mode)', () => {
  const { decision, state } = runHook({
    state: baseState({ iteration: 6, max_iterations: 50 }),
    response: '  \n\n',
  });
  assert.equal(decision.decision, 'approve');
  assert.equal(state.active, false, 'inline mode must deactivate on degenerate to prevent stale state');
});

test('stop-hook: 2-char non-matching response (counter=0) → block + counter=1 (polling tolerated)', () => {
  const { decision, state } = runHook({
    state: baseState({ iteration: 6, max_iterations: 50 }),
    response: 'no',
  });
  assert.equal(decision.decision, 'block', 'first short response is legitimate polling — must not exit');
  assert.equal(state.active, true, 'single short response must not deactivate session');
  assert.equal(state.consecutive_short_responses, 1);
});

test('stop-hook: 10-char response (counter=0) → block + counter=1 (degenerate boundary)', () => {
  const { decision, state } = runHook({
    state: baseState({ iteration: 3, max_iterations: 50 }),
    response: '0123456789',
  });
  assert.equal(decision.decision, 'block');
  assert.equal(state.consecutive_short_responses, 1);
});

test('stop-hook: 11-char non-matching response → block (above degenerate threshold)', () => {
  const { decision } = runHook({
    state: baseState({ iteration: 3, max_iterations: 50 }),
    response: '01234567890',
  });
  assert.equal(decision.decision, 'block');
});

test('stop-hook: 1-char response (counter=0) → block + counter=1', () => {
  const { decision, state } = runHook({
    state: baseState({ iteration: 2, max_iterations: 50 }),
    response: 'x',
  });
  assert.equal(decision.decision, 'block');
  assert.equal(state.consecutive_short_responses, 1);
});

test('stop-hook: tab-only response → approve (whitespace-only detection)', () => {
  const { decision } = runHook({
    state: baseState({ iteration: 2, max_iterations: 50 }),
    response: '\t\t',
  });
  assert.equal(decision.decision, 'approve');
});

test('stop-hook: \\r\\n response → approve (whitespace-only detection)', () => {
  const { decision } = runHook({
    state: baseState({ iteration: 2, max_iterations: 50 }),
    response: '\r\n',
  });
  assert.equal(decision.decision, 'approve');
});

test('stop-hook: single newline response → approve (whitespace-only detection)', () => {
  const { decision } = runHook({
    state: baseState({ iteration: 2, max_iterations: 50 }),
    response: '\n',
  });
  assert.equal(decision.decision, 'approve');
});

test('stop-hook: single short response in tmux mode → block + counter=1 (not yet degenerate)', () => {
  const { decision, state } = runHook({
    state: baseState({ tmux_mode: true, iteration: 3, max_iterations: 50 }),
    response: 'no',
  });
  assert.equal(decision.decision, 'block', 'first short response is not yet degenerate — must not exit');
  assert.equal(state.active, true, 'single short response must not deactivate — runner handles lifecycle');
  assert.equal(state.consecutive_short_responses, 1);
});

test('stop-hook: no-op "Acknowledged." in inline mode → approve + deactivate', () => {
  const { decision, state } = runHook({
    state: baseState({ iteration: 3, max_iterations: 50 }),
    response: 'Acknowledged.',
  });
  assert.equal(decision.decision, 'approve');
  assert.equal(state.active, false, 'inline mode must deactivate on no-op to prevent stale state');
});

test('stop-hook: whitespace-only response in tmux mode → approve', () => {
  const { decision, state } = runHook({
    state: baseState({ tmux_mode: true, iteration: 3, max_iterations: 50 }),
    response: '  \n\n',
  });
  assert.equal(decision.decision, 'approve');
  assert.equal(state.active, true, 'whitespace approve must not deactivate');
});

// ---------------------------------------------------------------------------
// Consecutive-short-response counter — tolerate polling messages, exit on looping
// ---------------------------------------------------------------------------

test('stop-hook: short response at counter=1 → block + counter=2 (below threshold)', () => {
  const { decision, state } = runHook({
    state: baseState({ iteration: 6, max_iterations: 50, consecutive_short_responses: 1 }),
    response: 'Waiting.',
  });
  assert.equal(decision.decision, 'block');
  assert.equal(state.active, true);
  assert.equal(state.consecutive_short_responses, 2);
});

test('stop-hook: short response at counter=2 → approve (hits threshold of 3) + counter reset', () => {
  const { decision, state } = runHook({
    state: baseState({ iteration: 6, max_iterations: 50, consecutive_short_responses: 2 }),
    response: 'Waiting.',
  });
  assert.equal(decision.decision, 'approve', 'third consecutive short response should exit');
  assert.equal(state.active, false, 'inline mode at threshold must deactivate');
  assert.equal(state.consecutive_short_responses, 0, 'counter must reset on exit');
});

test('stop-hook: short response at counter=2 + tmux_mode → approve, active unchanged', () => {
  const { decision, state } = runHook({
    state: baseState({ tmux_mode: true, iteration: 6, max_iterations: 50, consecutive_short_responses: 2 }),
    response: 'Waiting.',
  });
  assert.equal(decision.decision, 'approve');
  assert.equal(state.active, true, 'tmux mode at threshold must not deactivate — runner owns lifecycle');
  assert.equal(state.consecutive_short_responses, 0, 'counter must reset on exit');
});

test('stop-hook: substantive response at counter=2 → block + counter reset to 0', () => {
  const longResponse = 'I finished editing utils.ts and the tests are passing. Here is a detailed summary of the work.';
  assert.ok(longResponse.length > 10);
  const { decision, state } = runHook({
    state: baseState({ iteration: 4, max_iterations: 50, consecutive_short_responses: 2 }),
    response: longResponse,
  });
  assert.equal(decision.decision, 'block', 'substantive response continues loop');
  assert.equal(state.consecutive_short_responses, 0, 'counter must reset on substantive response');
});

test('stop-hook: worker + short response → approve immediately (counter not applied)', () => {
  const { decision } = runHook({
    state: baseState({ iteration: 2, max_iterations: 50 }),
    response: 'wait',
    role: 'worker',
  });
  assert.equal(decision.decision, 'approve', 'worker short response exits immediately (own lifecycle)');
});

test('stop-hook: refinement-worker + short response → approve immediately (counter not applied)', () => {
  const { decision } = runHook({
    state: baseState({ iteration: 2, max_iterations: 50 }),
    response: 'wait',
    role: 'refinement-worker',
  });
  assert.equal(decision.decision, 'approve');
});

test('stop-hook: whitespace-only at counter=2 → approve immediately + counter reset', () => {
  // Whitespace is never legitimate — must exit immediately regardless of counter state.
  const { decision, state } = runHook({
    state: baseState({ iteration: 5, max_iterations: 50, consecutive_short_responses: 2 }),
    response: '\n\t',
  });
  assert.equal(decision.decision, 'approve');
  assert.equal(state.active, false, 'whitespace-only deactivates inline session');
  assert.equal(state.consecutive_short_responses, 0);
});

test('stop-hook: no-op pattern at counter=2 → approve immediately + counter reset', () => {
  // No-op patterns are the explicit ack class — always exit immediately, no counting.
  const { decision, state } = runHook({
    state: baseState({ iteration: 5, max_iterations: 50, consecutive_short_responses: 2 }),
    response: 'Acknowledged.',
  });
  assert.equal(decision.decision, 'approve');
  assert.equal(state.active, false);
  assert.equal(state.consecutive_short_responses, 0);
});

test('stop-hook: counter reset feedback mentions N/threshold', () => {
  const { decision } = runHook({
    state: baseState({ iteration: 2, max_iterations: 50 }),
    response: 'Waiting.',
  });
  assert.equal(decision.decision, 'block');
  assert.ok(decision.reason.includes('1/3'), `expected progress indicator, got: ${decision.reason}`);
});

// ---------------------------------------------------------------------------
// F19: empty stdin + corrupted JSON handling
// ---------------------------------------------------------------------------

test('stop-hook: empty stdin → approve silently, no debug log written', () => {
  const { decision, debugLog } = runHookRaw({ stdin: '' });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(debugLog, '', 'must not write any log entry for empty stdin');
});

test('stop-hook: whitespace-only stdin → approve silently', () => {
  const { decision, debugLog } = runHookRaw({ stdin: '   \n  ' });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.equal(debugLog, '', 'must not write any log entry for whitespace stdin');
});

test('stop-hook: corrupted non-empty JSON → warn with 100-char preview, approve fail-open', () => {
  const corrupted = '{"broken": this is not valid json because values cannot be unquoted}';
  const { decision, debugLog } = runHookRaw({ stdin: corrupted });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.ok(debugLog.includes('WARN: corrupted hook input'), 'must log a WARN about corrupted input');
  assert.ok(debugLog.includes(corrupted.slice(0, 40)), 'must include a preview of the corrupted input');
});

test('stop-hook: corrupted input longer than 100 chars → preview truncated with ellipsis', () => {
  const corrupted = 'x'.repeat(200) + ' not json';
  const { decision, debugLog } = runHookRaw({ stdin: corrupted });
  assert.deepEqual(decision, { decision: 'approve' });
  assert.ok(debugLog.includes('...'), 'must include ellipsis when input exceeds 100 chars');
  assert.ok(!debugLog.includes(corrupted), 'must not log the full input');
});

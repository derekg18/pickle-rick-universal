import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HANDLER = path.resolve(__dirname, '../hooks/handlers/config-protection.js');

function baseState(overrides = {}) {
  return {
    active: true,
    working_dir: process.cwd(),
    step: 'implement',
    iteration: 1,
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
 * Run config-protection handler as subprocess.
 * Returns parsed decision object.
 */
function runHandler(opts = {}) {
  const {
    state = baseState(),
    toolName = 'Write',
    toolInput = {},
    withStateFile = true,
    withSessionsMap = withStateFile,
    setStateFileEnv = withStateFile,
    persistState = true,
    configChange = false,
  } = opts;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-'));
  const sessionDir = path.join(tmpDir, 'sessions', 'session');
  fs.mkdirSync(sessionDir, { recursive: true });

  const stateFile = path.join(sessionDir, 'state.json');

  // Set up session_dir and current_ticket in state
  const ticketId = state.current_ticket || 'test-ticket-01';
  const resolvedState = {
    ...state,
    session_dir: sessionDir,
    current_ticket: ticketId,
  };

  // Create ticket file if configChange requested
  if (configChange) {
    const ticketDir = path.join(sessionDir, ticketId);
    fs.mkdirSync(ticketDir, { recursive: true });
    const frontmatter = configChange
      ? `---\nid: ${ticketId}\ntitle: "Test"\nconfig_change: true\n---\n# Ticket\n`
      : `---\nid: ${ticketId}\ntitle: "Test"\n---\n# Ticket\n`;
    fs.writeFileSync(path.join(ticketDir, `linear_ticket_${ticketId}.md`), frontmatter);
  }

  if (persistState) {
    fs.writeFileSync(stateFile, JSON.stringify(resolvedState));
  }
  if (withSessionsMap) {
    fs.writeFileSync(
      path.join(tmpDir, 'current_sessions.json'),
      JSON.stringify({ [process.cwd()]: sessionDir })
    );
  }

  const env = { ...process.env, EXTENSION_DIR: tmpDir, FORCE_COLOR: '0' };
  delete env.PICKLE_STATE_FILE;
  if (setStateFileEnv) env.PICKLE_STATE_FILE = stateFile;

  const hookInput = JSON.stringify({ tool_name: toolName, tool_input: toolInput });

  const stdout = execFileSync(process.execPath, [HANDLER], {
    input: hookInput,
    encoding: 'utf-8',
    env,
  });

  return JSON.parse(stdout.trim());
}

// ---------------------------------------------------------------------------
// Block cases
// ---------------------------------------------------------------------------

test('blocks Write to .eslintrc.json', () => {
  const result = runHandler({ toolName: 'Write', toolInput: { file_path: '/project/.eslintrc.json' } });
  assert.equal(result.decision, 'block');
});

test('blocks Write to .eslintrc (no extension)', () => {
  const result = runHandler({ toolName: 'Write', toolInput: { file_path: '/project/.eslintrc' } });
  assert.equal(result.decision, 'block');
});

test('blocks Edit to tsconfig.json', () => {
  const result = runHandler({ toolName: 'Edit', toolInput: { file_path: '/project/tsconfig.json' } });
  assert.equal(result.decision, 'block');
});

test('blocks Edit to tsconfig.build.json', () => {
  const result = runHandler({ toolName: 'Edit', toolInput: { file_path: '/project/tsconfig.build.json' } });
  assert.equal(result.decision, 'block');
});

test('blocks Write to biome.json', () => {
  const result = runHandler({ toolName: 'Write', toolInput: { file_path: '/project/biome.json' } });
  assert.equal(result.decision, 'block');
});

test('blocks Write to .prettierrc.json', () => {
  const result = runHandler({ toolName: 'Write', toolInput: { file_path: '/project/.prettierrc.json' } });
  assert.equal(result.decision, 'block');
});

test('blocks Write to jest.config.js', () => {
  const result = runHandler({ toolName: 'Write', toolInput: { file_path: '/project/jest.config.js' } });
  assert.equal(result.decision, 'block');
});

test('blocks Write to vitest.config.ts', () => {
  const result = runHandler({ toolName: 'Write', toolInput: { file_path: '/project/vitest.config.ts' } });
  assert.equal(result.decision, 'block');
});

test('blocks Write to pyproject.toml', () => {
  const result = runHandler({ toolName: 'Write', toolInput: { file_path: '/project/pyproject.toml' } });
  assert.equal(result.decision, 'block');
});

test('blocks Write to .ruff.toml', () => {
  const result = runHandler({ toolName: 'Write', toolInput: { file_path: '/project/.ruff.toml' } });
  assert.equal(result.decision, 'block');
});

test('blocks Bash sed targeting tsconfig.json', () => {
  const result = runHandler({ toolName: 'Bash', toolInput: { command: 'sed -i "s/foo/bar/" tsconfig.json' } });
  assert.equal(result.decision, 'block');
});

test('blocks Bash awk targeting .eslintrc.json', () => {
  const result = runHandler({ toolName: 'Bash', toolInput: { command: 'awk \'{print}\' .eslintrc.json' } });
  assert.equal(result.decision, 'block');
});

test('blocks Bash echo redirect to tsconfig.json', () => {
  const result = runHandler({ toolName: 'Bash', toolInput: { command: 'echo "{}" > tsconfig.json' } });
  assert.equal(result.decision, 'block');
});

test('blocks Bash echo append to .prettierrc', () => {
  const result = runHandler({ toolName: 'Bash', toolInput: { command: 'echo "extra" >> .prettierrc' } });
  assert.equal(result.decision, 'block');
});

// ---------------------------------------------------------------------------
// Approve cases
// ---------------------------------------------------------------------------

test('approves Write to src/foo.ts', () => {
  const result = runHandler({ toolName: 'Write', toolInput: { file_path: '/project/src/foo.ts' } });
  assert.equal(result.decision, 'approve');
});

test('approves Edit to package.json (not in protected list)', () => {
  const result = runHandler({ toolName: 'Edit', toolInput: { file_path: '/project/package.json' } });
  assert.equal(result.decision, 'approve');
});

test('approves Bash npm test (no config target)', () => {
  const result = runHandler({ toolName: 'Bash', toolInput: { command: 'npm test' } });
  assert.equal(result.decision, 'approve');
});

test('approves Bash git commit', () => {
  const result = runHandler({ toolName: 'Bash', toolInput: { command: 'git commit -m "feat: add thing"' } });
  assert.equal(result.decision, 'approve');
});

test('approves Read tool (not Write/Edit/Bash)', () => {
  const result = runHandler({ toolName: 'Read', toolInput: { file_path: '/project/tsconfig.json' } });
  assert.equal(result.decision, 'approve');
});

test('approves protected config edits when disabled setting is in a newer orphan tmp', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-settings-tmp-'));
  const sessionDir = path.join(tmpDir, 'sessions', 'session');
  fs.mkdirSync(sessionDir, { recursive: true });

  const stateFile = path.join(sessionDir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify(baseState({ session_dir: sessionDir })));
  fs.writeFileSync(
    path.join(tmpDir, 'current_sessions.json'),
    JSON.stringify({ [process.cwd()]: sessionDir }),
  );

  const settingsPath = path.join(tmpDir, 'pickle_settings.json');
  const tmpSettingsPath = `${settingsPath}.tmp.99999999`;
  fs.writeFileSync(settingsPath, JSON.stringify({ enable_config_protection: true }));
  fs.writeFileSync(tmpSettingsPath, JSON.stringify({ enable_config_protection: false }));
  const baseTime = new Date('2026-04-28T12:00:00.000Z');
  const tmpTime = new Date('2026-04-28T12:00:01.000Z');
  fs.utimesSync(settingsPath, baseTime, baseTime);
  fs.utimesSync(tmpSettingsPath, tmpTime, tmpTime);

  const env = {
    ...process.env,
    EXTENSION_DIR: tmpDir,
    FORCE_COLOR: '0',
    PICKLE_STATE_FILE: stateFile,
  };

  try {
    const stdout = execFileSync(process.execPath, [HANDLER], {
      input: JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: '/project/.eslintrc.json' },
      }),
      encoding: 'utf-8',
      env,
    });
    assert.equal(JSON.parse(stdout.trim()).decision, 'approve');
    assert.equal(fs.existsSync(tmpSettingsPath), false, 'orphan tmp settings should be promoted');
    assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf-8')).enable_config_protection, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Override case
// ---------------------------------------------------------------------------

test('approves Write to .eslintrc.json when ticket has config_change: true', () => {
  const result = runHandler({
    toolName: 'Write',
    toolInput: { file_path: '/project/.eslintrc.json' },
    configChange: true,
  });
  assert.equal(result.decision, 'approve');
});

test('approves config_change override when resolved state.session_dir is stale', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-stale-session-dir-'));
  const liveSessionDir = path.join(tmpDir, 'sessions', 'live-session');
  const staleSessionDir = path.join(tmpDir, 'sessions', 'stale-session');
  fs.mkdirSync(liveSessionDir, { recursive: true });
  fs.mkdirSync(staleSessionDir, { recursive: true });

  const ticketId = 'test-ticket-01';
  const liveTicketDir = path.join(liveSessionDir, ticketId);
  fs.mkdirSync(liveTicketDir, { recursive: true });
  fs.writeFileSync(
    path.join(liveTicketDir, `linear_ticket_${ticketId}.md`),
    `---\nid: ${ticketId}\ntitle: "Test"\nconfig_change: true\n---\n# Ticket\n`,
  );

  const liveStateFile = path.join(liveSessionDir, 'state.json');
  fs.writeFileSync(
    liveStateFile,
    JSON.stringify(baseState({
      current_ticket: ticketId,
      session_dir: staleSessionDir,
    })),
  );
  fs.writeFileSync(
    path.join(tmpDir, 'current_sessions.json'),
    JSON.stringify({ [process.cwd()]: liveSessionDir }),
  );

  const env = {
    ...process.env,
    EXTENSION_DIR: tmpDir,
    FORCE_COLOR: '0',
    PICKLE_STATE_FILE: liveStateFile,
  };

  try {
    const stdout = execFileSync(process.execPath, [HANDLER], {
      input: JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: '/project/.eslintrc.json' },
      }),
      encoding: 'utf-8',
      env,
    });
    assert.equal(JSON.parse(stdout.trim()).decision, 'approve');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Inactive session cases
// ---------------------------------------------------------------------------

test('approves any tool when no state file exists', () => {
  const result = runHandler({
    toolName: 'Write',
    toolInput: { file_path: '/project/.eslintrc.json' },
    withSessionsMap: false,
    setStateFileEnv: false,
    persistState: false,
  });
  assert.equal(result.decision, 'approve');
});

test('approves any tool when session is inactive (active: false)', () => {
  const result = runHandler({
    state: baseState({ active: false }),
    toolName: 'Write',
    toolInput: { file_path: '/project/.eslintrc.json' },
  });
  assert.equal(result.decision, 'approve');
});

test('approves protected config edits when the resolved session is stale active=true with a dead pid', () => {
  const result = runHandler({
    state: baseState({ active: true, pid: 99999999 }),
    toolName: 'Write',
    toolInput: { file_path: '/project/.eslintrc.json' },
    setStateFileEnv: false,
  });
  assert.equal(result.decision, 'approve');
});

test('blocks protected config edits when the sessions map is missing but a live session state exists', () => {
  const result = runHandler({
    toolName: 'Write',
    toolInput: { file_path: '/project/tsconfig.json' },
    withSessionsMap: false,
    setStateFileEnv: false,
  });
  assert.equal(result.decision, 'block');
});

test('blocks protected config edits when PICKLE_STATE_FILE points to another cwd but a live same-cwd session exists', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-stale-env-'));
  const staleSessionDir = path.join(tmpDir, 'sessions', 'stale-session');
  const liveSessionDir = path.join(tmpDir, 'sessions', 'live-session');
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
    path.join(tmpDir, 'current_sessions.json'),
    JSON.stringify({ [process.cwd()]: liveSessionDir }),
  );

  const env = {
    ...process.env,
    EXTENSION_DIR: tmpDir,
    FORCE_COLOR: '0',
    PICKLE_STATE_FILE: staleStateFile,
  };

  try {
    const stdout = execFileSync(process.execPath, [HANDLER], {
      input: JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: '/project/.eslintrc.json' },
      }),
      encoding: 'utf-8',
      env,
    });
    assert.equal(JSON.parse(stdout.trim()).decision, 'block');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

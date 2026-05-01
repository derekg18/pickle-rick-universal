import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_COMMIT = path.resolve(__dirname, '../bin/log-commit.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runHook(stdinObj, envOverrides = {}, setup = undefined) {
  const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-'));
  if (setup) setup(extRoot);
  const env = { ...process.env, EXTENSION_DIR: extRoot, FORCE_COLOR: '0', ...envOverrides };
  try {
    const stdout = execFileSync(process.execPath, [LOG_COMMIT], {
      input: typeof stdinObj === 'string' ? stdinObj : JSON.stringify(stdinObj),
      encoding: 'utf-8',
      env,
    });
    const activityDir = path.join(extRoot, 'activity');
    let events = [];
    if (fs.existsSync(activityDir)) {
      for (const f of fs.readdirSync(activityDir)) {
        if (f.endsWith('.jsonl')) {
          const lines = fs.readFileSync(path.join(activityDir, f), 'utf-8').trim().split('\n').filter(Boolean);
          events.push(...lines.map(l => JSON.parse(l)));
        }
      }
    }
    return { stdout, events, exitCode: 0 };
  } catch (err) {
    return { stdout: '', events: [], exitCode: err.status ?? 1 };
  } finally {
    fs.rmSync(extRoot, { recursive: true, force: true });
  }
}

function commitInput(command, stdout) {
  return {
    session_id: 'test-session',
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    tool_response: { stdout },
  };
}

// ---------------------------------------------------------------------------
// Fast-path exits — non-commit commands
// ---------------------------------------------------------------------------

test('log-commit: non-commit command exits 0 with no stdout, no activity', () => {
  const { stdout, events, exitCode } = runHook(commitInput('ls -la', ''));
  assert.equal(exitCode, 0);
  assert.equal(stdout, '');
  assert.equal(events.length, 0);
});

test('log-commit: npm install exits 0 with no activity', () => {
  const { events, exitCode } = runHook(commitInput('npm install', 'added 50 packages'));
  assert.equal(exitCode, 0);
  assert.equal(events.length, 0);
});

test('log-commit: git status exits 0 with no activity', () => {
  const { events, exitCode } = runHook(commitInput('git status', 'On branch main'));
  assert.equal(exitCode, 0);
  assert.equal(events.length, 0);
});

// ---------------------------------------------------------------------------
// Commit detection — git commit
// ---------------------------------------------------------------------------

test('log-commit: git commit detected, hash parsed from stdout', () => {
  const { stdout, events, exitCode } = runHook(commitInput(
    'git commit -m "fix: something"',
    '[main 1a2b3c4] fix: something\n 1 file changed, 2 insertions(+)'
  ));
  assert.equal(exitCode, 0);
  assert.equal(stdout, '');
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'commit');
  assert.equal(events[0].source, 'hook');
  assert.equal(events[0].commit_hash, '1a2b3c4');
  assert.equal(events[0].commit_message, 'fix: something');
});

test('log-commit: git commit with longer hash', () => {
  const { events } = runHook(commitInput(
    'git commit -m "feat: add feature"',
    '[feature/branch abc1234def] feat: add feature\n 3 files changed'
  ));
  assert.equal(events.length, 1);
  assert.equal(events[0].commit_hash, 'abc1234def');
  assert.equal(events[0].commit_message, 'feat: add feature');
});

// ---------------------------------------------------------------------------
// Commit detection — git cherry-pick and git merge
// ---------------------------------------------------------------------------

test('log-commit: git cherry-pick detected', () => {
  const { events } = runHook(commitInput(
    'git cherry-pick abc1234',
    '[main deadbeef] cherry-picked commit\n 1 file changed'
  ));
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'commit');
  assert.equal(events[0].commit_hash, 'deadbeef');
});

test('log-commit: git merge detected', () => {
  const { events } = runHook(commitInput(
    'git merge feature-branch',
    '[main cafe123] Merge branch \'feature-branch\'\n 5 files changed'
  ));
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'commit');
  assert.equal(events[0].commit_hash, 'cafe123');
});

// ---------------------------------------------------------------------------
// Commit detection — git rebase
// ---------------------------------------------------------------------------

test('log-commit: git rebase detected', () => {
  const { events } = runHook(commitInput(
    'git rebase main',
    '[detached HEAD babe123] rebased commit\n 2 files changed'
  ));
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'commit');
  assert.equal(events[0].commit_hash, 'babe123');
});

test('log-commit: git rebase --continue detected', () => {
  const { events } = runHook(commitInput(
    'git rebase --continue',
    '[detached HEAD feed456] continued rebase\n 1 file changed'
  ));
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'commit');
  assert.equal(events[0].commit_hash, 'feed456');
});

// ---------------------------------------------------------------------------
// Multi-command chains
// ---------------------------------------------------------------------------

test('log-commit: multi-command chain with git commit detected', () => {
  const { events } = runHook(commitInput(
    'npm test && git commit -m "fix: tests pass"',
    'Tests passed\n[main 9876543] fix: tests pass\n 1 file changed'
  ));
  assert.equal(events.length, 1);
  assert.equal(events[0].commit_hash, '9876543');
  assert.equal(events[0].commit_message, 'fix: tests pass');
});

test('log-commit: piped command with git commit detected', () => {
  const { events } = runHook(commitInput(
    'git add . && git commit -m "chore: update"',
    '[main abcdef0] chore: update\n 2 files changed'
  ));
  assert.equal(events.length, 1);
  assert.equal(events[0].commit_hash, 'abcdef0');
});

test('log-commit: resolves the session mapped to the current cwd when multiple sessions are active', () => {
  const currentCwd = process.cwd();
  const { events } = runHook(
    commitInput(
      'git commit -m "fix: scoped attribution"',
      '[main 7654321] fix: scoped attribution\n 1 file changed'
    ),
    {},
    (dataRoot) => {
      const sessionsDir = path.join(dataRoot, 'sessions');
      const otherSession = path.join(sessionsDir, 'aaa-other');
      const currentSession = path.join(sessionsDir, 'zzz-current');
      fs.mkdirSync(otherSession, { recursive: true });
      fs.mkdirSync(currentSession, { recursive: true });

      fs.writeFileSync(
        path.join(otherSession, 'state.json'),
        JSON.stringify({ active: true, working_dir: '/tmp/not-this-repo' })
      );
      fs.writeFileSync(
        path.join(currentSession, 'state.json'),
        JSON.stringify({ active: true, working_dir: currentCwd })
      );
      fs.writeFileSync(
        path.join(dataRoot, 'current_sessions.json'),
        JSON.stringify({ [currentCwd]: currentSession })
      );
    }
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].session, 'zzz-current');
  assert.equal(events[0].commit_hash, '7654321');
});

test('log-commit: mapped session missing active does not outrank a scanned live same-cwd session', () => {
  const currentCwd = process.cwd();
  const { events } = runHook(
    commitInput(
      'git commit -m "fix: active session lookup"',
      '[main 1122334] fix: active session lookup\n 1 file changed'
    ),
    {},
    (dataRoot) => {
      const sessionsDir = path.join(dataRoot, 'sessions');
      const staleSession = path.join(sessionsDir, 'aaa-stale');
      const liveSession = path.join(sessionsDir, 'zzz-live');
      fs.mkdirSync(staleSession, { recursive: true });
      fs.mkdirSync(liveSession, { recursive: true });

      fs.writeFileSync(
        path.join(staleSession, 'state.json'),
        JSON.stringify({ working_dir: currentCwd, session_dir: staleSession })
      );
      fs.writeFileSync(
        path.join(liveSession, 'state.json'),
        JSON.stringify({ active: true, working_dir: currentCwd, session_dir: liveSession })
      );
      fs.writeFileSync(
        path.join(dataRoot, 'current_sessions.json'),
        JSON.stringify({ [currentCwd]: staleSession })
      );
    }
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].session, 'zzz-live');
  assert.equal(events[0].commit_hash, '1122334');
});

// ---------------------------------------------------------------------------
// Zero stdout verification
// ---------------------------------------------------------------------------

test('log-commit: writes zero stdout on commit detection', () => {
  const { stdout } = runHook(commitInput(
    'git commit -m "test"',
    '[main 1234567] test\n 1 file changed'
  ));
  assert.equal(stdout, '');
});

test('log-commit: writes zero stdout on fast-path exit', () => {
  const { stdout } = runHook(commitInput('echo hello', 'hello'));
  assert.equal(stdout, '');
});

// ---------------------------------------------------------------------------
// Graceful failure — malformed/empty stdin
// ---------------------------------------------------------------------------

test('log-commit: empty stdin exits 0 gracefully', () => {
  const { exitCode, events } = runHook('');
  assert.equal(exitCode, 0);
  assert.equal(events.length, 0);
});

test('log-commit: malformed JSON stdin exits 0 gracefully', () => {
  const { exitCode, events } = runHook('{{{invalid');
  assert.equal(exitCode, 0);
  assert.equal(events.length, 0);
});

test('log-commit: missing tool_input exits 0 gracefully', () => {
  const { exitCode, events } = runHook({ session_id: 'test', tool_response: {} });
  assert.equal(exitCode, 0);
  assert.equal(events.length, 0);
});

test('log-commit: missing tool_input.command exits 0 gracefully', () => {
  const { exitCode, events } = runHook({ tool_input: {}, tool_response: {} });
  assert.equal(exitCode, 0);
  assert.equal(events.length, 0);
});

// ---------------------------------------------------------------------------
// Edge cases — commit with no hash in stdout
// ---------------------------------------------------------------------------

test('log-commit: commit command with no hash in stdout still logs event', () => {
  const { events } = runHook(commitInput(
    'git commit -m "test"',
    'some unexpected output format'
  ));
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'commit');
  assert.equal(events[0].source, 'hook');
  assert.equal(events[0].commit_hash, undefined);
  assert.equal(events[0].commit_message, undefined);
});

test('log-commit: commit command with empty stdout still logs event', () => {
  const { events } = runHook(commitInput('git commit -m "test"', ''));
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'commit');
});

test('log-commit: missing tool_response still logs event (command matched)', () => {
  const { events } = runHook({
    tool_input: { command: 'git commit -m "test"' },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'commit');
  assert.equal(events[0].commit_hash, undefined);
});

// ---------------------------------------------------------------------------
// Negative regex matches — should NOT trigger
// ---------------------------------------------------------------------------

test('log-commit: "github commit" in command does not trigger (no word boundary)', () => {
  const { events } = runHook(commitInput('curl https://github.com/commit/abc', ''));
  assert.equal(events.length, 0);
});

test('log-commit: "git log" does not trigger', () => {
  const { events } = runHook(commitInput('git log --oneline', 'abc1234 fix: thing'));
  assert.equal(events.length, 0);
});

// ---------------------------------------------------------------------------
// stdin size guard (1MB limit via Buffer.alloc)
// ---------------------------------------------------------------------------

test('log-commit: handles large stdin without OOM (within 1MB)', () => {
  // Simulate a large but valid git commit output — well under 1MB
  const bigStdout = '[main 1234567] fix: big commit\n' + 'x'.repeat(500_000);
  const { events, exitCode } = runHook(commitInput('git commit -m "big"', bigStdout));
  assert.equal(exitCode, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].commit_hash, '1234567');
});

// ---------------------------------------------------------------------------
// Activity event structure
// ---------------------------------------------------------------------------

test('log-commit: activity event has ts field', () => {
  const before = new Date().toISOString();
  const { events } = runHook(commitInput(
    'git commit -m "ts test"',
    '[main 1111111] ts test\n 1 file changed'
  ));
  const after = new Date().toISOString();
  assert.equal(events.length, 1);
  assert.ok(events[0].ts >= before, 'ts should be >= test start');
  assert.ok(events[0].ts <= after, 'ts should be <= test end');
});

// ---------------------------------------------------------------------------
// Session attribution
// ---------------------------------------------------------------------------

test('log-commit: commit during active session includes session field', () => {
  const sessionId = '2026-01-01-abc12345';
  const { events } = runHook(
    commitInput('git commit -m "feat: session"', '[main aaa1111] feat: session\n 1 file changed'),
    {},
    (extRoot) => {
      const sessionDir = path.join(extRoot, 'sessions', sessionId);
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(
        path.join(sessionDir, 'state.json'),
        JSON.stringify({ active: true, working_dir: process.cwd() })
      );
    }
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].session, sessionId);
});

test('log-commit: commit with no active session omits session field', () => {
  const { events } = runHook(
    commitInput('git commit -m "feat: no session"', '[main bbb2222] feat: no session\n 1 file changed'),
    {},
    (extRoot) => {
      const sessionDir = path.join(extRoot, 'sessions', '2026-01-01-dead0000');
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({ active: false }));
    }
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].session, undefined);
});

test('log-commit: unreadable sessions dir falls back gracefully', () => {
  const { events } = runHook(
    commitInput('git commit -m "feat: broken"', '[main ccc3333] feat: broken\n 1 file changed'),
    {},
    (extRoot) => {
      // Create sessions as a file, not a directory — readdirSync will throw
      fs.writeFileSync(path.join(extRoot, 'sessions'), 'not a directory');
    }
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'commit');
  assert.equal(events[0].session, undefined);
});

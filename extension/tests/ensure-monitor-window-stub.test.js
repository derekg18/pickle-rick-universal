import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'child_process';
import { syncBuiltinESMExports } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REAL_SPAWN_SYNC = childProcess.spawnSync;

function makeStubTmuxEnv() {
  const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-monitor-stub-')));
  const shimDir = path.join(tmpRoot, 'bin');
  const sessionDir = path.join(tmpRoot, 'session');
  const extensionRoot = path.join(tmpRoot, 'ext');
  const callsLog = path.join(tmpRoot, 'calls.log');
  const monitorMarker = path.join(tmpRoot, 'monitor-exists');
  const modeMarker = path.join(tmpRoot, 'monitor-mode');
  const killMarker = path.join(tmpRoot, 'monitor-killed');

  fs.mkdirSync(shimDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(path.join(extensionRoot, 'extension', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({ command_template: 'council-of-ricks.md' }));
  fs.writeFileSync(path.join(extensionRoot, 'extension', 'scripts', 'tmux-monitor.sh'), '#!/bin/sh\nexit 0\n');

  fs.writeFileSync(
    path.join(shimDir, 'tmux'),
    `#!/bin/sh
echo "tmux $*" >> "${callsLog}"
case "$1" in
  display-message)
    echo "pickle-stub"
    ;;
  list-windows)
    if [ -f "${monitorMarker}" ]; then
      echo "monitor"
    else
      echo "runner"
    fi
    ;;
  show-option)
    if [ -f "${modeMarker}" ]; then
      cat "${modeMarker}"
    fi
    ;;
  kill-window)
    touch "${killMarker}"
    rm -f "${monitorMarker}" "${modeMarker}"
    ;;
  set-option)
    eval "mode=\\\${$#}"
    printf "%s" "$mode" > "${modeMarker}"
    touch "${monitorMarker}"
    ;;
esac
exit 0
`,
  );
  fs.writeFileSync(
    path.join(shimDir, 'bash'),
    `#!/bin/sh
echo "bash $*" >> "${callsLog}"
touch "${monitorMarker}"
exit 0
`,
  );
  fs.chmodSync(path.join(shimDir, 'tmux'), 0o755);
  fs.chmodSync(path.join(shimDir, 'bash'), 0o755);

  return {
    tmpRoot,
    shimDir,
    sessionDir,
    extensionRoot,
    callsLog,
    monitorMarker,
    modeMarker,
    killMarker,
    readCalls() {
      return fs.existsSync(callsLog) ? fs.readFileSync(callsLog, 'utf-8') : '';
    },
    cleanup() {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

test('ensureMonitorWindow: stub tmux creates, recreates, stamps mode, and preserves timeouts', async () => {
  const env = makeStubTmuxEnv();
  const originalPath = process.env.PATH ?? '';
  const captured = [];

  childProcess.spawnSync = (cmd, args, opts) => {
    captured.push({ cmd: String(cmd), args: args ?? [], timeout: opts?.timeout });
    return REAL_SPAWN_SYNC(cmd, args, opts);
  };
  syncBuiltinESMExports();
  process.env.PATH = `${env.shimDir}${path.delimiter}${originalPath}`;

  try {
    const { ensureMonitorWindow } = await import(`../services/pickle-utils.js?stub=${Date.now()}`);

    const created = ensureMonitorWindow({
      sessionDir: env.sessionDir,
      extensionRoot: env.extensionRoot,
      inTmux: true,
    });
    assert.equal(created.status, 'created');
    assert.ok(fs.existsSync(env.monitorMarker), 'monitor marker should be created');
    assert.equal(fs.readFileSync(env.modeMarker, 'utf-8'), 'council');

    fs.writeFileSync(env.modeMarker, 'pickle');
    const beforeRecreate = captured.length;
    const recreated = ensureMonitorWindow({
      sessionDir: env.sessionDir,
      extensionRoot: env.extensionRoot,
      inTmux: true,
    });
    assert.equal(recreated.status, 'recreated');
    assert.ok(fs.existsSync(env.killMarker), 'stale monitor should be killed');
    assert.equal(fs.readFileSync(env.modeMarker, 'utf-8'), 'council');

    const calls = env.readCalls();
    assert.match(calls, /tmux kill-window -t pickle-stub:monitor/);
    assert.match(calls, /bash .+tmux-monitor\.sh pickle-stub .+session council/);
    assert.match(calls, /tmux set-option -w -t pickle-stub:monitor @pickle_monitor_mode council/);

    const recreateTimeouts = captured.slice(beforeRecreate)
      .filter((call) => (
        call.args[0] === 'display-message' ||
        call.args[0] === 'list-windows' ||
        call.args[0] === 'kill-window' ||
        call.args[0] === 'set-option' ||
        call.cmd === 'bash'
      ))
      .map((call) => call.timeout);
    assert.deepEqual(recreateTimeouts, [5_000, 5_000, 5_000, 10_000, 5_000]);
  } finally {
    process.env.PATH = originalPath;
    childProcess.spawnSync = REAL_SPAWN_SYNC;
    syncBuiltinESMExports();
    env.cleanup();
  }
});

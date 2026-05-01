import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    ensureMonitorWindow,
    inferMonitorMode,
    monitorModesCompatible,
    restartDeadWatcherPanes,
} from '../services/pickle-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Set up a tmpdir with a fake tmux + fake bash so ensureMonitorWindow can be
 * exercised without a real tmux server. The shims record every invocation to
 * `$TMP/calls.log` so assertions can inspect what happened.
 */
function makeFakes(opts) {
    const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-monitor-')));
    const callsLog = path.join(tmpRoot, 'calls.log');
    const shimDir = path.join(tmpRoot, 'bin');
    fs.mkdirSync(shimDir, { recursive: true });

    // Session dir with minimal state.json — inferMonitorMode reads it.
    const sessionDir = path.join(tmpRoot, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
        path.join(sessionDir, 'state.json'),
        JSON.stringify({ active: true, command_template: opts.commandTemplate || null }),
    );

    // Extension root with a stub tmux-monitor.sh. We don't let the real one
    // run — the fake bash intercepts the shebang-less invocation and just
    // records its argv to the calls log.
    const extRoot = path.join(tmpRoot, 'ext');
    fs.mkdirSync(path.join(extRoot, 'extension', 'scripts'), { recursive: true });
    fs.writeFileSync(
        path.join(extRoot, 'extension', 'scripts', 'tmux-monitor.sh'),
        '#!/bin/sh\necho "real script would run" >&2\nexit 0\n',
    );

    // Fake tmux: dispatches on subcommand. `display-message` echoes the
    // session name; `list-windows` echoes either "monitor" or "runner"
    // depending on whether $TMP/.monitor-exists marker is present;
    // `show-option @pickle_monitor_mode` echoes whatever is in
    // $TMP/.monitor-mode (empty = unset); `kill-window` and `set-option`
    // drop a marker so assertions can observe them.
    const fakeTmux = path.join(tmpRoot, 'fake-tmux.sh');
    const pathTmux = path.join(shimDir, 'tmux');
    const markerPath = path.join(tmpRoot, '.monitor-exists');
    const modeMarkerPath = path.join(tmpRoot, '.monitor-mode');
    const killMarkerPath = path.join(tmpRoot, '.monitor-killed');
    const paneCommands = opts.paneCommands || { 1: 'node', 2: 'node', 3: 'node' };
    for (const pane of [1, 2, 3]) {
        fs.writeFileSync(path.join(tmpRoot, `.pane-${pane}`), paneCommands[pane] || '');
    }
    fs.writeFileSync(
        fakeTmux,
        `#!/bin/sh
echo "tmux $*" >> "${callsLog}"
case "$1" in
  display-message)
    case "$*" in
      *monitor.1*pane_current_command*) cat "${path.join(tmpRoot, '.pane-1')}" ;;
      *monitor.2*pane_current_command*) cat "${path.join(tmpRoot, '.pane-2')}" ;;
      *monitor.3*pane_current_command*) cat "${path.join(tmpRoot, '.pane-3')}" ;;
      *) echo "${opts.sessionName || 'pickle-test'}" ;;
    esac
    ;;
  list-windows)
    if [ -f "${markerPath}" ]; then
      echo monitor
    else
      echo runner
    fi
    ;;
  show-option)
    if [ -f "${modeMarkerPath}" ]; then
      cat "${modeMarkerPath}"
    fi
    ;;
  kill-window)
    touch "${killMarkerPath}"
    rm -f "${markerPath}"
    rm -f "${modeMarkerPath}"
    ;;
  set-option)
    # Last arg is the mode value; stamp it so subsequent show-option sees it.
    eval "mode=\\\${$#}"
    printf "%s" "$mode" > "${modeMarkerPath}"
    ;;
esac
exit 0
`,
    );
    fs.chmodSync(fakeTmux, 0o755);
    fs.copyFileSync(fakeTmux, pathTmux);
    fs.chmodSync(pathTmux, 0o755);

    // Fake bash: records invocation, doesn't actually execute the script.
    const fakeBash = path.join(tmpRoot, 'fake-bash.sh');
    fs.writeFileSync(
        fakeBash,
        `#!/bin/sh
echo "bash $*" >> "${callsLog}"
exit 0
`,
    );
    fs.chmodSync(fakeBash, 0o755);

    return {
        tmpRoot,
        sessionDir,
        extRoot,
        callsLog,
        markerPath,
        modeMarkerPath,
        killMarkerPath,
        tmuxBin: fakeTmux,
        bashBin: fakeBash,
        cleanup() {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        },
        readCalls() {
            return fs.existsSync(callsLog) ? fs.readFileSync(callsLog, 'utf-8') : '';
        },
        readRunnerLog() {
            const logPath = path.join(sessionDir, 'mux-runner.log');
            return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '';
        },
        withPath(fn) {
            const savedPath = process.env.PATH;
            try {
                process.env.PATH = `${shimDir}${path.delimiter}${savedPath || ''}`;
                fn();
            } finally {
                if (savedPath === undefined) delete process.env.PATH;
                else process.env.PATH = savedPath;
            }
        },
    };
}

function makeWatcherFakes(opts = {}) {
    const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-watcher-pane-')));
    const callsLog = path.join(tmpRoot, 'calls.log');
    const shimDir = path.join(tmpRoot, 'bin');
    fs.mkdirSync(shimDir, { recursive: true });

    const sessionDir = path.join(tmpRoot, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
        path.join(sessionDir, 'state.json'),
        JSON.stringify({ active: opts.active ?? true, command_template: opts.commandTemplate || null }),
    );

    const extRoot = path.join(tmpRoot, 'ext');
    fs.mkdirSync(path.join(extRoot, 'extension', 'bin'), { recursive: true });

    const paneCommands = opts.paneCommands || { 1: 'zsh', 2: 'bash', 3: 'fish' };
    for (const pane of [1, 2, 3]) {
        fs.writeFileSync(path.join(tmpRoot, `.pane-${pane}`), paneCommands[pane] || '');
    }

    const fakeTmux = path.join(shimDir, 'tmux');
    fs.writeFileSync(
        fakeTmux,
        `#!/bin/sh
echo "tmux $*" >> "${callsLog}"
if [ "$1" = "display-message" ]; then
  case "$*" in
    *monitor.1*pane_current_command*) cat "${path.join(tmpRoot, '.pane-1')}" ;;
    *monitor.2*pane_current_command*) cat "${path.join(tmpRoot, '.pane-2')}" ;;
    *monitor.3*pane_current_command*) cat "${path.join(tmpRoot, '.pane-3')}" ;;
    *) echo "${opts.sessionName || 'pickle-watch'}" ;;
  esac
fi
exit 0
`,
    );
    fs.chmodSync(fakeTmux, 0o755);

    return {
        tmpRoot,
        sessionDir,
        extRoot,
        callsLog,
        cleanup() {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        },
        readCalls() {
            return fs.existsSync(callsLog) ? fs.readFileSync(callsLog, 'utf-8') : '';
        },
        readRunnerLog() {
            const logPath = path.join(sessionDir, 'mux-runner.log');
            return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '';
        },
        withPath(fn) {
            const savedPath = process.env.PATH;
            try {
                process.env.PATH = `${shimDir}${path.delimiter}${savedPath || ''}`;
                fn();
            } finally {
                if (savedPath === undefined) delete process.env.PATH;
                else process.env.PATH = savedPath;
            }
        },
    };
}

function makeInjectedMonitorFakes(opts = {}) {
    const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-monitor-injected-')));
    const sessionDir = path.join(tmpRoot, 'session');
    const extRoot = path.join(tmpRoot, 'ext');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(path.join(extRoot, 'extension', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(extRoot, 'extension', 'scripts'), { recursive: true });
    fs.writeFileSync(
        path.join(extRoot, 'extension', 'scripts', 'tmux-monitor.sh'),
        '#!/bin/sh\nexit 0\n',
    );
    fs.writeFileSync(
        path.join(sessionDir, 'state.json'),
        JSON.stringify({ active: opts.active ?? true, command_template: opts.commandTemplate || null }),
    );

    const sessionName = opts.sessionName || 'pickle-injected';
    const monitorExists = opts.monitorExists ?? true;
    const monitorMode = opts.monitorMode || opts.mode || 'pickle';
    const paneCommands = opts.paneCommands || { 1: 'node', 2: 'node', 3: 'node' };
    const calls = [];
    const spawnSyncFn = (command, args = []) => {
        calls.push({ command, args: [...args] });
        if (command !== 'tmux') return { status: 0, stdout: '', stderr: '' };
        if (args[0] === 'display-message' && args[1] === '-p' && args[2] === '#S') {
            return { status: 0, stdout: `${sessionName}\n`, stderr: '' };
        }
        if (args[0] === 'display-message' && args[1] === '-p' && args[2] === '-t') {
            const target = args[3] || '';
            const pane = Number(target.split('.').at(-1));
            return { status: 0, stdout: `${paneCommands[pane] || ''}\n`, stderr: '' };
        }
        if (args[0] === 'list-windows') {
            return { status: 0, stdout: monitorExists ? 'monitor\n' : 'runner\n', stderr: '' };
        }
        if (args[0] === 'show-option') {
            return { status: 0, stdout: `${monitorMode}\n`, stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
    };

    return {
        tmpRoot,
        sessionDir,
        extRoot,
        calls,
        cleanup() {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        },
        readRunnerLog() {
            const logPath = path.join(sessionDir, 'mux-runner.log');
            return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '';
        },
        spawnSyncFn,
    };
}

function tmuxCalls(f, subcommand) {
    return f.calls.filter(call => call.command === 'tmux' && call.args[0] === subcommand);
}

test('ensureMonitorWindow: skipped when not inside tmux', () => {
    const f = makeFakes({});
    try {
        const result = ensureMonitorWindow({
            sessionDir: f.sessionDir,
            extensionRoot: f.extRoot,
            inTmux: false,
            tmuxBin: f.tmuxBin,
            bashBin: f.bashBin,
        });
        assert.equal(result.status, 'skipped');
        assert.equal(f.readCalls(), '', 'should not invoke tmux or bash when skipped');
    } finally {
        f.cleanup();
    }
});

test('ensureMonitorWindow: creates monitor when window does not exist', () => {
    const f = makeFakes({ sessionName: 'pickle-abc12345' });
    try {
        const result = ensureMonitorWindow({
            sessionDir: f.sessionDir,
            extensionRoot: f.extRoot,
            inTmux: true,
            tmuxBin: f.tmuxBin,
            bashBin: f.bashBin,
        });
        assert.equal(result.status, 'created');
        const calls = f.readCalls();
        assert.match(calls, /tmux display-message/);
        assert.match(calls, /tmux list-windows -t pickle-abc12345/);
        // bash invocation carries the script path, session name, session dir, mode
        assert.match(calls, /bash .+tmux-monitor\.sh pickle-abc12345 .+session pickle/);
    } finally {
        f.cleanup();
    }
});

test('ensureMonitorWindow: existing monitor respawns dead watcher panes with injected spawn capture', () => {
    const cases = [
        {
            mode: 'pickle',
            commandTemplate: null,
            pane2: /monitor\.2 node .+morty-watcher\.js .+session Enter/,
        },
        {
            mode: 'refinement',
            commandTemplate: null,
            pane2: /monitor\.2 node .+refinement-watcher\.js .+session Enter/,
        },
        {
            mode: undefined,
            monitorMode: 'meeseeks',
            commandTemplate: 'meeseeks.md',
            pane2: /monitor\.2 tail -F .+session\/mux-runner\.log Enter/,
        },
    ];

    for (const { mode, monitorMode, commandTemplate, pane2 } of cases) {
        const f = makeInjectedMonitorFakes({
            sessionName: `${monitorMode || mode}-dead`,
            mode,
            monitorMode,
            commandTemplate,
            paneCommands: { 1: 'zsh', 2: 'bash', 3: 'fish' },
        });
        try {
            const result = ensureMonitorWindow({
                sessionDir: f.sessionDir,
                extensionRoot: f.extRoot,
                inTmux: true,
                mode,
                spawnSyncFn: f.spawnSyncFn,
            });

            assert.equal(result.status, 'exists');
            const sendKeys = tmuxCalls(f, 'send-keys');
            assert.equal(sendKeys.length, 3);
            assert.match(sendKeys[0].args.join(' '), /monitor\.1 node .+log-watcher\.js .+session Enter/);
            assert.match(sendKeys[1].args.join(' '), pane2);
            assert.match(sendKeys[2].args.join(' '), /monitor\.3 node .+raw-morty\.js .+session Enter/);
            assert.equal(tmuxCalls(f, 'display-message').filter(call => call.args.includes('#{pane_current_command}')).length, 3);
            assert.doesNotMatch(f.readRunnerLog(), /failed to respawn/);
        } finally {
            f.cleanup();
        }
    }
});

test('ensureMonitorWindow: existing monitor with all watcher panes alive is a no-op', () => {
    const f = makeInjectedMonitorFakes({
        sessionName: 'pickle-alive',
        paneCommands: { 1: 'node', 2: 'node', 3: 'node' },
    });
    try {
        const result = ensureMonitorWindow({
            sessionDir: f.sessionDir,
            extensionRoot: f.extRoot,
            inTmux: true,
            spawnSyncFn: f.spawnSyncFn,
        });

        assert.equal(result.status, 'exists');
        assert.equal(tmuxCalls(f, 'send-keys').length, 0);
        assert.equal(tmuxCalls(f, 'display-message').filter(call => call.args.includes('#{pane_current_command}')).length, 3);
        assert.equal(f.readRunnerLog(), '');
    } finally {
        f.cleanup();
    }
});

test('ensureMonitorWindow: inactive existing monitor skips watcher respawn', () => {
    const f = makeInjectedMonitorFakes({
        active: false,
        sessionName: 'pickle-inactive',
        paneCommands: { 1: 'zsh', 2: 'bash', 3: 'fish' },
    });
    try {
        const result = ensureMonitorWindow({
            sessionDir: f.sessionDir,
            extensionRoot: f.extRoot,
            inTmux: true,
            spawnSyncFn: f.spawnSyncFn,
        });

        assert.equal(result.status, 'exists');
        assert.equal(tmuxCalls(f, 'send-keys').length, 0);
        assert.equal(tmuxCalls(f, 'display-message').filter(call => call.args.includes('#{pane_current_command}')).length, 0);
        assert.equal(f.readRunnerLog(), '');
    } finally {
        f.cleanup();
    }
});

test('ensureMonitorWindow: existing monitor window runs exactly one pane-recovery sweep', () => {
    const f = makeFakes({
        sessionName: 'pickle-abc12345',
        paneCommands: { 1: 'zsh', 2: 'node', 3: 'bash' },
    });
    // Simulate existing monitor window stamped with the same mode we'll infer.
    fs.writeFileSync(f.markerPath, '1');
    fs.writeFileSync(f.modeMarkerPath, 'pickle');
    try {
        let result;
        f.withPath(() => {
            result = ensureMonitorWindow({
                sessionDir: f.sessionDir,
                extensionRoot: f.extRoot,
                inTmux: true,
                tmuxBin: f.tmuxBin,
                bashBin: f.bashBin,
            });
        });
        assert.equal(result.status, 'exists');
        const calls = f.readCalls();
        assert.match(calls, /tmux list-windows/);
        assert.match(calls, /tmux show-option/, 'should read stamped mode');
        assert.match(calls, /tmux display-message -p -t pickle-abc12345:monitor\.1 #\{pane_current_command\}/);
        assert.match(calls, /tmux display-message -p -t pickle-abc12345:monitor\.2 #\{pane_current_command\}/);
        assert.match(calls, /tmux display-message -p -t pickle-abc12345:monitor\.3 #\{pane_current_command\}/);
        assert.match(calls, /tmux send-keys -t pickle-abc12345:monitor\.1 node .+log-watcher\.js .+session Enter/);
        assert.match(calls, /tmux send-keys -t pickle-abc12345:monitor\.3 node .+raw-morty\.js .+session Enter/);
        assert.equal((calls.match(/tmux send-keys/g) || []).length, 2, 'should respawn each dead pane once');
        assert.doesNotMatch(calls, /tmux kill-window/, 'should not kill a compatible window');
        assert.doesNotMatch(calls, /bash .+tmux-monitor\.sh/, 'should not spawn script when monitor exists');
        assert.match(f.readRunnerLog(), /restartDeadWatcherPanes: respawned log-watcher\.js in pane 1/);
        assert.match(f.readRunnerLog(), /restartDeadWatcherPanes: respawned raw-morty\.js in pane 3/);
    } finally {
        f.cleanup();
    }
});

test('ensureMonitorWindow: phase re-entry performs a fresh recovery sweep with mode-specific pane 2', () => {
    const cases = [
        ['pickle', 'pickle.md', /tmux send-keys -t pickle-phase:monitor\.2 node .+morty-watcher\.js .+session Enter/],
        ['refinement', null, /tmux send-keys -t refinement-phase:monitor\.2 node .+refinement-watcher\.js .+session Enter/],
        ['council', 'council-of-ricks.md', /tmux send-keys -t council-phase:monitor\.2 tail -F .+session\/mux-runner\.log Enter/],
    ];

    for (const [mode, commandTemplate, paneTwoPattern] of cases) {
        const f = makeFakes({
            sessionName: `${mode}-phase`,
            commandTemplate,
            paneCommands: { 1: 'node', 2: 'zsh', 3: 'node' },
        });
        fs.writeFileSync(f.markerPath, '1');
        fs.writeFileSync(f.modeMarkerPath, mode);
        try {
            let result;
            f.withPath(() => {
                result = ensureMonitorWindow({
                    sessionDir: f.sessionDir,
                    extensionRoot: f.extRoot,
                    inTmux: true,
                    tmuxBin: f.tmuxBin,
                    bashBin: f.bashBin,
                    mode,
                });
            });
            assert.equal(result.status, 'exists');
            const calls = f.readCalls();
            assert.match(calls, paneTwoPattern);
            assert.equal((calls.match(/tmux display-message -p -t/g) || []).length, 3);
            assert.equal((calls.match(/tmux send-keys/g) || []).length, 1);
            assert.doesNotMatch(calls, /bash .+tmux-monitor\.sh/);
        } finally {
            f.cleanup();
        }
    }
});

test('ensureMonitorWindow: same-mode refinement monitor respawns only refinement watcher pane', () => {
    const f = makeFakes({
        sessionName: 'refinement-same-mode',
        paneCommands: { 1: 'node', 2: 'zsh', 3: 'node' },
    });
    fs.writeFileSync(f.markerPath, '1');
    fs.writeFileSync(f.modeMarkerPath, 'refinement');
    try {
        let result;
        f.withPath(() => {
            result = ensureMonitorWindow({
                sessionDir: f.sessionDir,
                extensionRoot: f.extRoot,
                inTmux: true,
                tmuxBin: f.tmuxBin,
                bashBin: f.bashBin,
                mode: 'refinement',
            });
        });

        assert.equal(result.status, 'exists');
        const calls = f.readCalls();
        assert.equal((calls.match(/tmux send-keys/g) || []).length, 1);
        assert.match(
            calls,
            /tmux send-keys -t refinement-same-mode:monitor\.2 node .+refinement-watcher\.js .+session Enter/,
        );
        assert.doesNotMatch(calls, /morty-watcher\.js/);
        assert.doesNotMatch(calls, /tail -F .+mux-runner\.log/);
        assert.doesNotMatch(calls, /tmux kill-window/);
        assert.doesNotMatch(calls, /bash .+tmux-monitor\.sh/);
    } finally {
        f.cleanup();
    }
});

test('ensureMonitorWindow: runner call sites remain limited to pipeline, mux, and microverse', () => {
    const files = [
        path.resolve(__dirname, '../src/bin/pipeline-runner.ts'),
        path.resolve(__dirname, '../src/bin/mux-runner.ts'),
        path.resolve(__dirname, '../src/bin/microverse-runner.ts'),
    ];
    const counts = files.map(file => {
        const source = fs.readFileSync(file, 'utf-8');
        return (source.match(/ensureMonitorWindow\(\{/g) || []).length;
    });

    assert.deepEqual(counts, [1, 1, 1]);
});

test('restartDeadWatcherPanes: respawns dead pickle watcher panes 1, 2, and 3', () => {
    const f = makeWatcherFakes({ sessionName: 'pickle-dead', paneCommands: { 1: 'zsh', 2: 'bash', 3: 'fish' } });
    try {
        f.withPath(() => restartDeadWatcherPanes(f.sessionDir, f.extRoot, 'pickle'));

        const calls = f.readCalls();
        assert.match(calls, /tmux display-message -p #S/);
        assert.match(calls, /tmux display-message -p -t pickle-dead:monitor\.1 #\{pane_current_command\}/);
        assert.match(calls, /tmux send-keys -t pickle-dead:monitor\.1 node .+log-watcher\.js .+session Enter/);
        assert.match(calls, /tmux send-keys -t pickle-dead:monitor\.2 node .+morty-watcher\.js .+session Enter/);
        assert.match(calls, /tmux send-keys -t pickle-dead:monitor\.3 node .+raw-morty\.js .+session Enter/);
        assert.match(f.readRunnerLog(), /restartDeadWatcherPanes: respawned log-watcher\.js in pane 1/);
        assert.match(f.readRunnerLog(), /restartDeadWatcherPanes: respawned morty-watcher\.js in pane 2/);
        assert.match(f.readRunnerLog(), /restartDeadWatcherPanes: respawned raw-morty\.js in pane 3/);
    } finally {
        f.cleanup();
    }
});

test('restartDeadWatcherPanes: all watcher panes already running node is a no-op', () => {
    const f = makeWatcherFakes({ paneCommands: { 1: 'node', 2: 'node', 3: 'node' } });
    try {
        f.withPath(() => restartDeadWatcherPanes(f.sessionDir, f.extRoot, 'pickle'));

        const calls = f.readCalls();
        assert.match(calls, /tmux display-message -p -t pickle-watch:monitor\.1 #\{pane_current_command\}/);
        assert.doesNotMatch(calls, /tmux send-keys/);
        assert.equal(f.readRunnerLog(), '');
    } finally {
        f.cleanup();
    }
});

test('restartDeadWatcherPanes: inactive session skips pane probing and respawn', () => {
    const f = makeWatcherFakes({ active: false, paneCommands: { 1: 'zsh', 2: 'bash', 3: 'fish' } });
    try {
        f.withPath(() => restartDeadWatcherPanes(f.sessionDir, f.extRoot, 'pickle'));

        assert.equal(f.readCalls(), '');
        assert.equal(f.readRunnerLog(), '');
    } finally {
        f.cleanup();
    }
});

test('restartDeadWatcherPanes: non-node long-running command is treated as dead and logged as warn', () => {
    const f = makeWatcherFakes({ paneCommands: { 1: 'node', 2: 'vim', 3: 'node' } });
    try {
        f.withPath(() => restartDeadWatcherPanes(f.sessionDir, f.extRoot, 'pickle'));

        const calls = f.readCalls();
        assert.match(calls, /tmux send-keys -t pickle-watch:monitor\.2 node .+morty-watcher\.js .+session Enter/);
        assert.doesNotMatch(calls, /tmux send-keys -t pickle-watch:monitor\.1/);
        assert.doesNotMatch(calls, /tmux send-keys -t pickle-watch:monitor\.3/);
        assert.match(f.readRunnerLog(), /restartDeadWatcherPanes WARN: pane 2 command 'vim' is not node/);
    } finally {
        f.cleanup();
    }
});

test('restartDeadWatcherPanes: mode-specific pane 2 command uses refinement and mux log tail modes', () => {
    const cases = [
        ['refinement', /tmux send-keys -t refinement-watch:monitor\.2 node .+refinement-watcher\.js .+session Enter/],
        ['meeseeks', /tmux send-keys -t meeseeks-watch:monitor\.2 tail -F .+session\/mux-runner\.log Enter/],
        ['council', /tmux send-keys -t council-watch:monitor\.2 tail -F .+session\/mux-runner\.log Enter/],
    ];

    for (const [mode, paneTwoPattern] of cases) {
        const f = makeWatcherFakes({
            sessionName: `${mode}-watch`,
            paneCommands: { 1: 'node', 2: 'zsh', 3: 'node' },
        });
        try {
            f.withPath(() => restartDeadWatcherPanes(f.sessionDir, f.extRoot, mode));
            const calls = f.readCalls();
            assert.match(calls, paneTwoPattern);
            assert.doesNotMatch(calls, /refine-watcher/);
        } finally {
            f.cleanup();
        }
    }
});

test('restartDeadWatcherPanes: trap-door entry documents T3 regressions and size cap', () => {
    const claudeMd = fs.readFileSync(path.resolve(__dirname, '../CLAUDE.md'), 'utf-8');
    const entries = claudeMd
        .split('\n')
        .filter(line => line.includes('src/services/pickle-utils.ts') && line.includes('restartDeadWatcherPanes'));

    assert.equal(entries.length, 1);
    const [entry] = entries;
    assert.ok(entry.length <= 1500, `trap-door entry is ${entry.length} chars`);
    assert.match(entry, /INVARIANT:/);
    assert.match(
        entry,
        /BREAKS: monitor window has stale watcher panes for the rest of the pipeline lifetime; user has to manually relaunch each watcher\./,
    );
    assert.match(entry, /ENFORCE:/);
    assert.match(entry, /restartDeadWatcherPanes: respawns dead pickle watcher panes 1, 2, and 3/);
    assert.match(entry, /restartDeadWatcherPanes: all watcher panes already running node is a no-op/);
    assert.match(entry, /restartDeadWatcherPanes: inactive session skips pane probing and respawn/);
});

test('ensureMonitorWindow: kills and recreates when existing window has different @mode', () => {
    const f = makeFakes({ sessionName: 'pickle-abc12345', commandTemplate: 'council-of-ricks.md' });
    // Simulate an existing monitor window stamped for a different mode
    // (e.g. a previous anatomy-park / pickle pipeline phase).
    fs.writeFileSync(f.markerPath, '1');
    fs.writeFileSync(f.modeMarkerPath, 'pickle');
    try {
        const result = ensureMonitorWindow({
            sessionDir: f.sessionDir,
            extensionRoot: f.extRoot,
            inTmux: true,
            tmuxBin: f.tmuxBin,
            bashBin: f.bashBin,
        });
        assert.equal(result.status, 'recreated');
        const calls = f.readCalls();
        assert.match(calls, /tmux list-windows/);
        assert.match(calls, /tmux show-option -w -qv -t pickle-abc12345:monitor @pickle_monitor_mode/);
        assert.match(calls, /tmux kill-window -t pickle-abc12345:monitor/, 'should kill stale window');
        assert.match(calls, /bash .+tmux-monitor\.sh pickle-abc12345 .+session council/, 'should respawn in council mode');
        assert.match(calls, /tmux set-option -w -t pickle-abc12345:monitor @pickle_monitor_mode council/, 'should stamp new mode');
        assert.ok(fs.existsSync(f.killMarkerPath), 'kill-window must have fired');
    } finally {
        f.cleanup();
    }
});

test('monitorModesCompatible: unset existing => incompatible; matching => compatible', () => {
    assert.equal(monitorModesCompatible(null, 'council'), false);
    assert.equal(monitorModesCompatible('', 'council'), false);
    assert.equal(monitorModesCompatible('pickle', 'council'), false);
    assert.equal(monitorModesCompatible('council', 'council'), true);
    assert.equal(monitorModesCompatible('meeseeks', 'meeseeks'), true);
});

test('ensureMonitorWindow: infers meeseeks mode from state.command_template', () => {
    const f = makeFakes({ sessionName: 'meeseeks-abc', commandTemplate: 'meeseeks.md' });
    try {
        const result = ensureMonitorWindow({
            sessionDir: f.sessionDir,
            extensionRoot: f.extRoot,
            inTmux: true,
            tmuxBin: f.tmuxBin,
            bashBin: f.bashBin,
        });
        assert.equal(result.status, 'created');
        assert.match(f.readCalls(), /tmux-monitor\.sh meeseeks-abc .+session meeseeks/);
    } finally {
        f.cleanup();
    }
});

test('ensureMonitorWindow: infers council mode from state.command_template', () => {
    const f = makeFakes({ sessionName: 'council-abc', commandTemplate: 'council-of-ricks.md' });
    try {
        const result = ensureMonitorWindow({
            sessionDir: f.sessionDir,
            extensionRoot: f.extRoot,
            inTmux: true,
            tmuxBin: f.tmuxBin,
            bashBin: f.bashBin,
        });
        assert.equal(result.status, 'created');
        assert.match(f.readCalls(), /tmux-monitor\.sh council-abc .+session council/);
    } finally {
        f.cleanup();
    }
});

test('ensureMonitorWindow: explicit mode overrides state-inferred mode', () => {
    const f = makeFakes({ sessionName: 'pickle-abc', commandTemplate: 'meeseeks.md' });
    try {
        const result = ensureMonitorWindow({
            sessionDir: f.sessionDir,
            extensionRoot: f.extRoot,
            inTmux: true,
            tmuxBin: f.tmuxBin,
            bashBin: f.bashBin,
            mode: 'refinement',
        });
        assert.equal(result.status, 'created');
        assert.match(f.readCalls(), /tmux-monitor\.sh pickle-abc .+session refinement/);
    } finally {
        f.cleanup();
    }
});

test('ensureMonitorWindow: returns error when tmux-monitor.sh is missing', () => {
    const f = makeFakes({});
    // Delete the stub script to simulate a broken install.
    fs.rmSync(path.join(f.extRoot, 'extension', 'scripts', 'tmux-monitor.sh'));
    try {
        const result = ensureMonitorWindow({
            sessionDir: f.sessionDir,
            extensionRoot: f.extRoot,
            inTmux: true,
            tmuxBin: f.tmuxBin,
            bashBin: f.bashBin,
        });
        assert.equal(result.status, 'error');
        assert.match(result.reason, /script missing/);
    } finally {
        f.cleanup();
    }
});

test('inferMonitorMode: defaults to pickle when state.json missing', () => {
    const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mode-')));
    try {
        assert.equal(inferMonitorMode(tmpRoot), 'pickle');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('inferMonitorMode: maps command_template values', () => {
    const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mode-')));
    try {
        const write = (tpl) => fs.writeFileSync(
            path.join(tmpRoot, 'state.json'),
            JSON.stringify({ command_template: tpl }),
        );

        write('meeseeks.md');
        assert.equal(inferMonitorMode(tmpRoot), 'meeseeks');

        write('council-of-ricks.md');
        assert.equal(inferMonitorMode(tmpRoot), 'council');

        write('szechuan-sauce.md');
        assert.equal(inferMonitorMode(tmpRoot), 'pickle');

        write(null);
        assert.equal(inferMonitorMode(tmpRoot), 'pickle');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('inferMonitorMode: recovers orphan tmp state before reading command_template', () => {
    const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mode-')));
    try {
        const statePath = path.join(tmpRoot, 'state.json');
        fs.writeFileSync(
            statePath,
            JSON.stringify({ command_template: 'pickle.md', iteration: 1, schema_version: 1 }),
        );
        fs.writeFileSync(
            `${statePath}.tmp.99999999`,
            JSON.stringify({ command_template: 'meeseeks.md', iteration: 2, schema_version: 1 }),
        );

        assert.equal(inferMonitorMode(tmpRoot), 'meeseeks');
        const promoted = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(promoted.command_template, 'meeseeks.md');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

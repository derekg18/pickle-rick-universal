Launch a Pickle Rick epic in tmux with true context clearing between iterations — best for large epics with 8+ tasks.

# /pickle-tmux

## Step 1: Check tmux
Run `tmux -V`. If missing: "Install tmux: `brew install tmux` or `apt install tmux`, or use /pickle for interactive mode." Stop.

## Step 2: Session Setup
Extract flags from `$ARGUMENTS` (`--resume <path>`, `--max-iterations <N>`, `--backend <claude|codex>`, etc.). Pass flags before `--task`. Task text goes in `--task "..."`.

```bash
node "$HOME/.claude/pickle-rick/extension/bin/setup.js" --tmux <FLAGS> --task "<TASK_TEXT>"
```
No flags: `setup.js --tmux --task "$ARGUMENTS"`.
Resume example: `setup.js --tmux --resume /sessions/057f0263` (no --task needed).
Flags+task example: `setup.js --tmux --max-iterations 10 --task "refactor auth"`
Backend example: `setup.js --tmux --backend codex --task "refactor auth"` — routes worker/manager spawns through `codex exec` instead of `claude`. Backend persists in `state.json` and survives resume.

Extract `SESSION_ROOT=<path>` and `working_dir` from output.

## Step 3: tmux Session
Session name: `pickle-<hash>` from SESSION_ROOT basename.
```bash
tmux new-session -d -s <name> -c <working_dir>
sleep 1
```
Print attach command immediately: `tmux attach -t <name>` (Window 1 "monitor" = 4-pane; Window 0 "runner" = background, Ctrl+B 0).

## Step 4: Launch Runner
```bash
tmux send-keys -t <name>:0 "node $HOME/.claude/pickle-rick/extension/bin/mux-runner.js <SESSION_ROOT>; echo ''; echo 'Runner finished.  Ctrl+B 1 → monitor  |  Ctrl+B D → detach'; read" Enter
```

## Step 5: Monitor (4-pane)
mux-runner auto-creates the 4-pane monitor window on startup — no manual invocation needed.

## Step 6: Report
Print: session name, `tmux attach -t <name>`, window layout (monitor: dashboard top-left / log-stream top-right / morty-logs bottom-left / raw-morty bottom-right; runner: Ctrl+B 0), cancel: `cd <working_dir> && /eat-pickle`, emergency: `tmux kill-session -t <name>` then `node ~/.claude/pickle-rick/extension/bin/cancel.js`, state path: `<SESSION_ROOT>/state.json`.

Output: `<promise` + `>TASK_COMPLETED</promise>`

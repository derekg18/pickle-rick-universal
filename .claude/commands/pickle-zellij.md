Launch a Pickle Rick epic in Zellij with KDL layouts and true context clearing between iterations — best for large epics with 8+ tasks.

# /pickle-zellij

## Step 1: Check Zellij

Run `zellij --version`. If missing: "Install Zellij: `cargo install zellij` or `brew install zellij`, or use /pickle-tmux (tmux) or /pickle (interactive mode) instead." Stop.

Parse the version string to verify >= 0.40.0:
```bash
ZELLIJ_RAW=$(zellij --version 2>/dev/null || echo "")
ZELLIJ_VER=$(echo "$ZELLIJ_RAW" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
if [ -z "$ZELLIJ_VER" ]; then
  echo "Zellij not found. Install: cargo install zellij / brew install zellij"
  echo "Alternatives: /pickle-tmux (tmux) or /pickle (interactive)"
  exit 1
fi
IFS='.' read -r ZMJ ZMN ZPT <<< "$ZELLIJ_VER"
if [ "$ZMJ" -lt 0 ] || { [ "$ZMJ" -eq 0 ] && [ "$ZMN" -lt 40 ]; }; then
  echo "Zellij $ZELLIJ_VER too old — need >= 0.40.0. Run: cargo install zellij"
  exit 1
fi
echo "Zellij $ZELLIJ_VER OK"
```

If `$ZELLIJ` env var is set, warn: "Nested Zellij session detected — this may cause issues. Consider running from a non-Zellij terminal." Continue (non-fatal).

## Step 2: Session Setup
Extract flags from `$ARGUMENTS` (`--resume <path>`, `--max-iterations <N>`, etc.). Pass flags before `--task`. Task text goes in `--task "..."`.

```bash
node "$HOME/.claude/pickle-rick/extension/bin/setup.js" --tmux <FLAGS> --task "<TASK_TEXT>"
```
No flags: `setup.js --tmux --task "$ARGUMENTS"`.
Resume example: `setup.js --tmux --resume /sessions/057f0263` (no --task needed).
Flags+task example: `setup.js --tmux --max-iterations 10 --task "refactor auth"`

Extract `SESSION_ROOT=<path>` and `working_dir` from output.

## Step 3: Create Zellij Session
Session name: `pickle-<hash>` from SESSION_ROOT basename.

Pre-clean ghost sessions:
```bash
zellij delete-session pickle-<hash> 2>/dev/null || true
```

Export env vars for the KDL layout:
```bash
export PICKLE_SESSION_ROOT=<SESSION_ROOT>
export PICKLE_CWD=<working_dir>
export PICKLE_EXTENSION_ROOT=$HOME/.claude/pickle-rick
```

**Three-tier session creation** — try each approach in order, use the first that succeeds:

**(A) Preferred — `--new-session-with-layout` (Zellij >= 0.41):**
```bash
zellij --new-session-with-layout $HOME/.claude/pickle-rick/extension/layouts/monitor-pickle.kdl \
  attach --create-background pickle-<hash>
```

**(B) Fallback — `--layout` flag:**
```bash
zellij --layout $HOME/.claude/pickle-rick/extension/layouts/monitor-pickle.kdl \
  attach --create-background pickle-<hash>
```

**(C) Two-step fallback — create then apply layout:**
```bash
zellij attach --create-background pickle-<hash>
ZELLIJ_SESSION_NAME=pickle-<hash> zellij action new-tab --layout $HOME/.claude/pickle-rick/extension/layouts/monitor-pickle.kdl
# Remove the empty default tab created by attach
ZELLIJ_SESSION_NAME=pickle-<hash> zellij action go-to-previous-tab
ZELLIJ_SESSION_NAME=pickle-<hash> zellij action close-tab
```

The KDL layout (`monitor-pickle.kdl`) creates both tabs automatically:
- **runner** tab: mux-runner.js (background orchestrator)
- **monitor** tab (focused): dashboard top-left, log-stream top-right, morty-watcher bottom

## Step 4: Report
Print: session name, `zellij attach pickle-<hash>`, tab layout (monitor: dashboard top-left / log-stream top-right / morty-logs bottom; runner: switch tabs with Zellij keybinds), cancel: `cd <working_dir> && /eat-pickle` (graceful), emergency: `zellij delete-session pickle-<hash>` then `node ~/.claude/pickle-rick/extension/bin/cancel.js`, state path: `<SESSION_ROOT>/state.json`.

Output: `<promise>TASK_COMPLETED</promise>`

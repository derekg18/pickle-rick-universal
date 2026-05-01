Launch a Mr. Meeseeks code review loop in Zellij with KDL layouts and true context clearing between iterations.

> **DEPRECATED**: Use `/szechuan-sauce` for principle-driven code quality review or `/anatomy-park` for deep subsystem bug hunting. This command still works but will be removed in a future release.

# /meeseeks-zellij

## Step 1: Check Zellij

Run `zellij --version`. If missing: "Install Zellij: `cargo install zellij` or `brew install zellij`, or use /meeseeks (tmux) instead." Stop.

Parse the version string to verify >= 0.40.0:
```bash
ZELLIJ_RAW=$(zellij --version 2>/dev/null || echo "")
ZELLIJ_VER=$(echo "$ZELLIJ_RAW" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
if [ -z "$ZELLIJ_VER" ]; then
  echo "Zellij not found. Install: cargo install zellij / brew install zellij"
  echo "Alternative: /meeseeks (tmux)"
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

## Step 2: Read Settings

Read min/max passes from `pickle_settings.json`:
```bash
MIN_PASSES=$(node -e "const s=JSON.parse(require('fs').readFileSync('$HOME/.claude/pickle-rick/pickle_settings.json'));console.log(s.default_meeseeks_min_passes||10)")
MAX_PASSES=$(node -e "const s=JSON.parse(require('fs').readFileSync('$HOME/.claude/pickle-rick/pickle_settings.json'));console.log(s.default_meeseeks_max_passes||50)")
```

## Step 3: Parse Flags

From `$ARGUMENTS`: `--min-iterations <N>` overrides MIN_PASSES, `--max-iterations <N>` overrides MAX_PASSES. Remainder after flag extraction = task text.

## Step 4: Session Setup

```bash
node "$HOME/.claude/pickle-rick/extension/bin/setup.js" --tmux \
  --min-iterations $MIN_PASSES --max-iterations $MAX_PASSES \
  --command-template meeseeks.md --task "Mr. Meeseeks Code Review: <task-text>"
```

Default task (no task text provided): `"Mr. Meeseeks Code Review"`.

Extract `SESSION_ROOT=<path>` and `working_dir` from output.

## Step 5: Create Zellij Session

Session name: `meeseeks-<hash>` from SESSION_ROOT basename.

Pre-clean ghost sessions:
```bash
zellij delete-session meeseeks-<hash> 2>/dev/null || true
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
zellij --new-session-with-layout $HOME/.claude/pickle-rick/extension/layouts/monitor-meeseeks.kdl \
  attach --create-background meeseeks-<hash>
```

**(B) Fallback — `--layout` flag:**
```bash
zellij --layout $HOME/.claude/pickle-rick/extension/layouts/monitor-meeseeks.kdl \
  attach --create-background meeseeks-<hash>
```

**(C) Two-step fallback — create then apply layout:**
```bash
zellij attach --create-background meeseeks-<hash>
ZELLIJ_SESSION_NAME=meeseeks-<hash> zellij action new-tab --layout $HOME/.claude/pickle-rick/extension/layouts/monitor-meeseeks.kdl
# Remove the empty default tab created by attach
ZELLIJ_SESSION_NAME=meeseeks-<hash> zellij action go-to-previous-tab
ZELLIJ_SESSION_NAME=meeseeks-<hash> zellij action close-tab
```

The KDL layout (`monitor-meeseeks.kdl`) creates both tabs automatically:
- **runner** tab: mux-runner.js (background orchestrator)
- **monitor** tab (focused): dashboard top-left, log-stream top-right, runner-log bottom

## Step 6: Report

Print: session name, `zellij attach meeseeks-<hash>`, tab layout (monitor: dashboard top-left / log-stream top-right / runner-log bottom; runner: switch tabs with Zellij keybinds), min passes: `<MIN_PASSES>`, max passes: `<MAX_PASSES>`, cancel: `cd <working_dir> && /eat-pickle` (graceful), emergency: `zellij delete-session meeseeks-<hash>` then `node ~/.claude/pickle-rick/extension/bin/cancel.js`, state path: `<SESSION_ROOT>/state.json`.

"I'm Mr. Meeseeks, look at me! CAN DO!"

Output: `<promise>TASK_COMPLETED</promise>`

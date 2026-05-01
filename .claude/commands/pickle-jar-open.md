Execute all queued Pickle Jar tasks sequentially in Night Shift batch mode.

You are the **Grand Overseer** — manage the conveyor belt, do not write code.

**Step 1**: `node "$HOME/.claude/pickle-rick/extension/bin/jar-runner.js" $ARGUMENTS`

The runner finds all "marinating" tasks (oldest first), spawns a full Pickle Rick manager per task, marks each "consumed" or "failed".

**Step 2**: Do not interfere — let each task complete.

**Step 3**: When runner prints `Signal: Jar Complete`, announce results (succeeded/failed counts) and stop. Cancel mid-run: `/eat-pickle` in a separate terminal.

## Backend

`/pickle-jar-open` takes no `--backend` flag. Each queued task carries its own backend, resolved per-task from that task's `state.json` via `resolveBackend(state)` against the already-parsed state object. The runner routes the manager spawn through `codex exec` when `state.backend === 'codex'`, otherwise `claude`, and spreads `PICKLE_BACKEND=<backend>` into the child environment so transitively-spawned workers inherit it. A single jar run can therefore mix claude-backed and codex-backed tasks — whatever was stored at `/pickle ... --backend <x>` or `/add-to-pickle-jar` time is replayed faithfully. The active backend is printed in the "Running Jarred Task" panel for each task. If the outer jar process has `PICKLE_BACKEND` in its environment, per-task `state.backend` still wins; workers spawned under each task see `PICKLE_BACKEND` rewritten to match that task's backend.

If the manager CLI (`codex` or `claude`) is not on `PATH`, jar-runner prints an install hint and leaves that task's status untouched (still `marinating`) rather than marking it `failed` — a future `/pickle-jar-open` succeeds once the CLI is installed. When a codex-backed task hits ENOENT, remaining codex-backed tasks are short-circuited (they'd all ENOENT identically); claude-backed tasks further down the queue still run.

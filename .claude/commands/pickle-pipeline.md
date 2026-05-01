Full pipeline orchestrator: pickle-tmux build, anatomy-park, szechuan-sauce.

# /pickle-pipeline

You are launching the **full pipeline** — build it, inspect every organ, then clean the slop. Three phases, one tmux session, zero hand-holding between phases.

## When to invoke this skill
- User lists 2+ pipeline stages in one request ("refine then build then szechuan", "build, review, deslop")
- User says "full pipeline", "everything", "the whole flow", "X then Y then Z"
- User asks for a not-yet-started feature AND mentions verification/cleanup phases
- User says "use codex" / "--backend codex" alongside multiple stages → still this skill, append `--backend codex`

Step 0 (below) handles refinement automatically when triggered. Do NOT pre-invoke `/pickle-refine-prd` — this skill drives it. The runtime orchestrator (`pipeline-runner.js`) only runs build → anatomy-park → szechuan-sauce; refinement happens in Step 0 of THIS skill prompt, before tmux launches.

## When NOT to invoke
- User explicitly names ONE stage (`/pickle-tmux`, `/szechuan-sauce`, `/anatomy-park`) — use that skill directly
- Resuming an existing session — use the specific stage skill instead
- Single-file edit, typo fix, question — answer directly

## Step 0: Refinement Prerequisite

Decide whether to run `/pickle-refine-prd` before launching the build/review/deslop pipeline. Explicit flags win; otherwise auto-infer from the request.

**Pre-check:** If `$ARGUMENTS` contains BOTH `--refine` AND `--no-refine` → print `"Conflicting flags: --refine and --no-refine cannot both be passed. Pick one."` and stop. Do NOT proceed.

**Decision (first match wins):**
1. `$ARGUMENTS` contains `--no-refine` → `REFINE=false`
2. `$ARGUMENTS` contains `--refine` → `REFINE=true`
3. `$ARGUMENTS` matches `/\brefine[\s-]?prd\b|\bprd[\s-]?refinement\b|\b(refine|refinement|decompose)\b.{0,40}\b(prd|first)\b|\b(refine|refinement|decompose)\b\s*,?\s*then\s+(build|implement|impl|ship|launch|run|tmux|pipeline)\b/i` → `REFINE=true` (auto-inferred). This intentionally avoids triggering on feature-content uses like "refine the dropdown UX", "refine the dropdown before shipping", or "refinement loop". Use `--refine` to force, `--no-refine` to suppress when ambiguous.
4. Otherwise → `REFINE=false`

If `REFINE=false` → strip `--refine`/`--no-refine` from `$ARGUMENTS` if present and continue to Step 1.

**If `REFINE=true`:**

**0a — Resolve PRD path AND session, if any.** First match wins:
1. Explicit path in `$ARGUMENTS` (e.g. `path/to/prd.md`) → `PRD_PATH=<resolved>`, leave `SESSION_ROOT` unset (no session associated yet)
2. `prd.md` or `PRD.md` in current working directory → `PRD_PATH=<resolved>`, leave `SESSION_ROOT` unset
3. Most recent session's `prd.md` via `node "$HOME/.claude/pickle-rick/extension/bin/get-session.js"` → `PRD_PATH=<resolved>`, set `SESSION_ROOT=$(dirname "$PRD_PATH")` (the returned path is session-relative)

No PRD found → **fail fast**: print `"No prd.md found. Run /pickle-prd first to draft one, then re-invoke /pickle-pipeline."` Stop. Do NOT launch tmux.

**0b — Skip if already refined.** Only applies when `SESSION_ROOT` is set (path 3 above). If `${SESSION_ROOT}/prd_refined.md` exists → log `"PRD already refined at ${SESSION_ROOT}/prd_refined.md — skipping refinement."` Continue to Step 1, carrying `SESSION_ROOT` and `SESSION_INITIALIZED=true` forward so Step 3 resumes the same session.

**Mid-refinement detection.** Only applies when `SESSION_ROOT` is set (path 3 above). If `${SESSION_ROOT}/refinement_manifest.json` exists but `${SESSION_ROOT}/prd_refined.md` does NOT → refinement is in flight. Fail fast with: `"Session has in-progress refinement. Run /pickle-refine-prd --resume first to complete it, then re-invoke /pickle-pipeline --no-refine."` Stop.

For paths 1 and 2 (no session yet), skip both checks above and proceed directly to 0c — the refine skill will create the session.

**0c — Run `/pickle-refine-prd` inline.** Invoke the skill in the current Claude session, passing the resolved PRD path as `${TASK_ARGS}`. Do **NOT** pass `--backend` to the refine skill — refine pins itself to claude regardless. Wait for `<promise>TASK_COMPLETED</promise>` from the refine skill. The refine skill's Step 3 sets a `${SESSION_ROOT}` variable which remains in scope after refine returns — Step 3 of THIS skill reuses that same variable via `--resume "${SESSION_ROOT}"` instead of creating a fresh session. Set a marker `SESSION_INITIALIZED=true` for Step 3 to branch on.

Pipeline phases (pickle, anatomy-park, szechuan-sauce) honor whatever `--backend` was passed to this skill; only refinement is pinned to claude.

**Note on interactive gating:** `/pickle-refine-prd` Step 2c may pause and interview the user when PRD verification quality is PARTIAL or MISSING. The pipeline blocks until the interview completes. Pass a verification-ready PRD upfront to keep the run autonomous.

**0d — On refine failure** (no `prd_refined.md` produced, or skill aborted) → **fail fast**: surface the refine error and stop. Do NOT launch the pipeline against an unrefined PRD.

**0e — Continue.** Strip `--refine`/`--no-refine` from `$ARGUMENTS` so they aren't reparsed as TASK content. The `SESSION_ROOT` and `SESSION_INITIALIZED=true` markers from 0c carry forward — Step 3 will use `setup.js --resume "${SESSION_ROOT}" --tmux ...` instead of creating a new session, preserving `prd_refined.md` and the ticket directories.

## Step 0.5: Sizing Check (AC-LPB-08)

Only runs when `SESSION_INITIALIZED=true` and `${SESSION_ROOT}/decomposition_manifest.json` exists. Skip otherwise.

**0.5a — Count tickets and compute expected wall.**

```
TICKET_COUNT=$(jq '.tickets | length' "${SESSION_ROOT}/decomposition_manifest.json" 2>/dev/null || echo 0)
BACKEND="${BACKEND:-claude}"  # whatever was resolved in Step 0
THROUGHPUT=$(jq -r ".throughput_baselines[\"${BACKEND}\"] // 5.0" "$HOME/.claude/pickle-rick/pickle_settings.json")
EXPECTED_MIN=$(awk "BEGIN { print int((${TICKET_COUNT} / ${THROUGHPUT}) * 60 + 0.999) }")
RECOMMENDED_MIN=$(awk "BEGIN { print int(${EXPECTED_MIN} * 1.25 + 0.999) }")
```

**0.5b — Decide.** Let `MAX_TIME` be the value from `--max-time` if passed, else `default_max_time_minutes` from `pickle_settings.json` (720).

- If `MAX_TIME == 0` (unlimited) → skip the rest of Step 0.5.
- If `MAX_TIME >= EXPECTED_MIN * 0.8` → log `"sizing-check: ok (max_time=${MAX_TIME}m vs expected=${EXPECTED_MIN}m for ${TICKET_COUNT} tickets at ${THROUGHPUT} t/h)"` and continue.
- If `MAX_TIME < EXPECTED_MIN * 0.5` (gap >2×) AND `$ARGUMENTS` lacks `--acknowledge-undersized` → **block**: print
  `"--max-time=${MAX_TIME}m is severely undersized for ${TICKET_COUNT} tickets at ${THROUGHPUT} t/h on ${BACKEND} (estimate ${EXPECTED_MIN}m). Pass --max-time=${RECOMMENDED_MIN} or add --acknowledge-undersized to override."`
  Stop. Do NOT launch tmux.
- Otherwise (undersized but within 2× gap, or `--acknowledge-undersized` set) → suggest the recommended value:
  `"sizing-check: --max-time=${MAX_TIME}m is below recommended ${RECOMMENDED_MIN}m. setup.js will print the same warning to stderr. Continuing."`

**0.5c — Forward `--acknowledge-undersized`.** If the flag is in `$ARGUMENTS`, append it to the `setup.js` invocation in Step 3 so the launch-path warning is silenced for the actual setup call.

## Step 1: Check tmux
Run `tmux -V`. If missing: "Install tmux: `brew install tmux`." Stop.

## Step 2: Parse Arguments

From `$ARGUMENTS`:

**Pickle phase flags:**
- `--max-iterations <N>` → PICKLE_MAX_ITER (default: 500)
- `--max-time <M>` → MAX_TIME in minutes (default: 720)
- `--worker-timeout <S>` → WORKER_TIMEOUT in seconds (default: 1200)
- `--backend <claude|codex>` → BACKEND (default `claude`; `codex` routes every phase's worker/manager spawn through `codex exec` and propagates via `PICKLE_BACKEND` to sub-runners)

**Anatomy Park flags:**
- `--anatomy-max-iterations <N>` → AP_MAX_ITER (default: 100)
- `--anatomy-stall-limit <N>` → AP_STALL (default: 3)

**Szechuan Sauce flags:**
- `--szechuan-max-iterations <N>` → SZ_MAX_ITER (default: 50)
- `--szechuan-stall-limit <N>` → SZ_STALL (default: 5)
- `--szechuan-domain <name>` → SZ_DOMAIN (optional)
- `--szechuan-focus "<text>"` → SZ_FOCUS (optional)

**Phase control:**
- `--refine` → force refinement before pipeline (already consumed in Step 0)
- `--no-refine` → suppress auto-inferred refinement (already consumed in Step 0)
- `--skip-anatomy` → remove anatomy-park from pipeline
- `--skip-szechuan` → remove szechuan-sauce from pipeline
- `--target <path>` → TARGET for review phases (default: current working directory)

**Scope flags (optional):**
- `--scope <flag>` → SCOPE_FLAG (values: `branch`, `branch:one-hop`, `diff:<ref>`, `diff:<ref>:one-hop`, `paths:<glob,...>`)
- `--scope-base <ref>` → SCOPE_BASE (base ref override for `branch` mode)

When set, these flags are written into `pipeline.json` in Step 4 — do NOT pass them to `setup.js`. pipeline-runner reads them from `pipeline.json` at startup, resolves scope (writes `${SESSION_ROOT}/scope.json`), and refreshes per non-pickle phase (archives to `${SESSION_ROOT}/archive/scope.<phase>.json`). Empty diff at setup → WARN; empty diff at anatomy-park refresh → `SCOPE_EMPTY_POST_BUILD` error.

**Remainder** = TASK (the epic description for the pickle phase)

If no TASK provided, print error and stop.

Resolve TARGET to an absolute path. Verify it exists. If not found, print error and stop.

## Step 3: Session Setup

Branch on whether Step 0 already initialized a session via refinement (i.e. `SESSION_INITIALIZED=true` AND `SESSION_ROOT` is set).

**If Step 0 set `SESSION_INITIALIZED=true` (refinement ran):** call setup.js in resume mode to preserve refinement artifacts (`prd_refined.md`, ticket directories):
```bash
node "$HOME/.claude/pickle-rick/extension/bin/setup.js" --tmux --resume "${SESSION_ROOT}" --max-iterations <PICKLE_MAX_ITER> --max-time <MAX_TIME> --worker-timeout <WORKER_TIMEOUT> [--backend <BACKEND>]
```

**Otherwise (no refinement, fresh pipeline):**
```bash
node "$HOME/.claude/pickle-rick/extension/bin/setup.js" --tmux --max-iterations <PICKLE_MAX_ITER> --max-time <MAX_TIME> --worker-timeout <WORKER_TIMEOUT> [--backend <BACKEND>] --task "<TASK>"
```

Append `--backend <BACKEND>` only when the flag was passed. Extract `SESSION_ROOT=<path>` from output (resume mode echoes the same path).

## Step 4: Create pipeline.json

Build the phases array. Default: `["pickle", "anatomy-park", "szechuan-sauce"]`. Remove entries if `--skip-anatomy` or `--skip-szechuan` were passed.

Write `${SESSION_ROOT}/pipeline.json` with the required keys below. Append the optional keys ONLY when the corresponding flag was passed — do NOT emit placeholders or empty strings for unset values.

Required shape (example shown with `--backend codex`):
```json
{
  "phases": ["pickle", "anatomy-park", "szechuan-sauce"],
  "target": "<TARGET_ABSOLUTE_PATH>",
  "anatomy_stall_limit": <AP_STALL>,
  "szechuan_stall_limit": <SZ_STALL>,
  "anatomy_max_iterations": <AP_MAX_ITER>,
  "szechuan_max_iterations": <SZ_MAX_ITER>,
  "backend": "codex"
}
```

Optional keys — include each ONLY when the corresponding flag was set, and use the literal user-supplied value:
- `szechuan_domain` (string) — add when `--szechuan-domain` was passed
- `szechuan_focus` (string) — add when `--szechuan-focus` was passed
- `scope` (string) — add when `--scope` was passed
- `scope_base` (string) — add when `--scope-base` was passed
- `backend` (string: `"claude"` or `"codex"`) — add when `--backend` was passed; omit the key entirely otherwise

## Step 5: tmux Session

Session name: `pipeline-<hash>` from SESSION_ROOT basename.
```bash
tmux new-session -d -s <name> -c <working_dir>
sleep 1
```

Print attach command immediately: `tmux attach -t <name>`

## Step 6: Launch Runner

```bash
tmux send-keys -t <name>:0 "node $HOME/.claude/pickle-rick/extension/bin/pipeline-runner.js <SESSION_ROOT>; echo ''; echo 'Pipeline finished. Ctrl+B 1 → monitor | Ctrl+B D → detach'; read" Enter
```

## Step 7: Monitor (4-pane)

pipeline-runner auto-creates the 4-pane monitor window on startup — no manual invocation needed.

## Step 8: Report

Print:
```
Full Pipeline — Build → Review → Deslop

Task: <TASK>
Target: <TARGET>
Phases: <list of active phases>
Session: tmux attach -t <name>
Monitor: Ctrl+B 1 | Runner: Ctrl+B 0 | Detach: Ctrl+B D
Cancel: tmux kill-session -t <name>
State: <SESSION_ROOT>/state.json
Pipeline: <SESSION_ROOT>/pipeline.json

Phase Limits:
  Pickle:        max_iterations=<PICKLE_MAX_ITER>
  Anatomy Park:  max_iterations=<AP_MAX_ITER>, stall_limit=<AP_STALL>
  Szechuan Sauce: max_iterations=<SZ_MAX_ITER>, stall_limit=<SZ_STALL>

"I turned myself into a pipeline, Morty!
 Build, inspect, clean — the whole lifecycle.
 No meeseeks required."
```

Output: `<promise>TASK_COMPLETED</promise>`

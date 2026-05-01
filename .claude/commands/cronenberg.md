Meta-router: explicit `/cronenberg` picks the right pickle metaphor + cleanup chain for a build/implement request.

# /cronenberg

Mutate a request into the correct pipeline shape. Deterministic — same signals → same plan, no LLM judgment inside the matrix.

## When to invoke
User explicitly types `/cronenberg`. Never auto-trigger; persona's existing Routing rules are unchanged.

## When NOT to invoke
- User already named a skill (`/pickle`, `/pickle-tmux`, `/pickle-pipeline`, `/pickle-microverse`, `/council-of-ricks`, `/citadel`, `/anatomy-park`, `/szechuan-sauce`) — use that directly.
- One-liner / typo / single-file fix → just do it.
- Pure question → answer directly.

## Step 1: Parse Flags

From `$ARGUMENTS`:
- `--dry-run` — print the plan and stop without executing. Cronenberg-only. (Default behavior is to execute the plan.)
- `--no-followups` — skip cleanup chain. Cronenberg-only.
- `--no-refine` — force-skip the refinement pre-pass even when signals say it should run. Cronenberg-only.
- `--refine` — force-include the refinement pre-pass even when signals would skip it. Cronenberg flag (also forwarded to refine-prd if it accepts it).
- Everything else (flags + free text) → `FORWARD` — passed through verbatim to the chosen metaphor and its followups.

If `FORWARD` has no task description AND no PRD detected in Step 2 → print `"Cronenberg needs a task or prd.md. Add a task or run /pickle-prd first."` Stop.

## Step 2: Signals

| Signal | Definition (source) |
|---|---|
| `PRD_PRESENT` | `prd.md`/`PRD.md` in cwd OR most recent session has one (`get-session.js`) |
| `MEASURABLE_METRIC` | TASK/PRD names a measurable target: coverage %, latency budget, lint count, error rate, bundle size, "improve X to Y" |
| `TICKET_COUNT` | If `prd_refined.md` exists, count tickets; else infer from TASK verbs (1 / 2-3 / 4+) |
| `MULTI_STAGE` | TASK lists 2+ of: refine, build, optimize, cleanup, deslop, szechuan, anatomy-park, review |
| `STACK_REVIEW` | TASK is review-focused AND mentions PR stack, branch chain, `gt log`, graphite stack |
| `SUBSYSTEM_TOUCHES` | distinct top-level dirs implied by TASK + PRD file mentions (≥2 if multiple modules named) |
| `INTERACTIVE_HINT` | TASK contains "interactive", "watch me", "step through", or `FORWARD` has `--interactive` |
| `ALREADY_REFINED` | `prd_refined.md` or `refinement_manifest.json` exists in cwd OR most recent session |
| `AC_SHAPE_SMELL` | PRD body contains an AC heading whose body has ≥3 bullets each naming a distinct endpoint/handler/method, all repeating the same predicate, with no universal quantifier ("all", "every", "for any") in the AC headline. (Cheap regex pass over the PRD; same heuristic citadel T11.7 uses.) |
| `MACHINE_UNCHECKABLE_AC` | PRD body has any AC bullet that names no concrete artifact: no API path, no status code, no enum value, no symbol identifier, no numeric threshold, no file path. Pure prose ACs cannot be verified by citadel. |
| `CITADEL_RISK` | True when (`PRD_PRESENT` AND `TICKET_COUNT ≥ 3`) OR TASK mentions "conformance", "acceptance criteria", "spec compliance", or "audit against PRD" OR (`SUBSYSTEM_TOUCHES ≥ 2` AND `PRD_PRESENT`). |
| `REFINE_NEEDED` | See Step 2.5 — composite decision over the signals above |

## Step 2.5: Refine Decision (analyze, don't default)

Cronenberg evaluates whether to chain `/pickle-refine-prd` *before* the build. The default leans **toward refinement** when there's enough material to refine and it isn't already done. Decision matrix (first match wins):

| If | → |
|---|---|
| `--no-refine` flag passed | `REFINE_NEEDED = false` (user override) |
| `PRD_PRESENT = false` | `REFINE_NEEDED = false` (nothing to refine — TASK-only request) |
| `ALREADY_REFINED = true` AND no `--refine` flag | `REFINE_NEEDED = false` (don't redo) |
| `--refine` flag passed | `REFINE_NEEDED = true` (user override) |
| `AC_SHAPE_SMELL = true` OR `MACHINE_UNCHECKABLE_AC = true` | `REFINE_NEEDED = true` (PRD has known refinement-fixable issues) |
| `TICKET_COUNT ≥ 3` OR `SUBSYSTEM_TOUCHES ≥ 2` OR `MULTI_STAGE = true` | `REFINE_NEEDED = true` (multi-shape work benefits from atomic decomposition) |
| Single-file scope: `TICKET_COUNT = 1` AND `SUBSYSTEM_TOUCHES ≤ 1` AND no smells | `REFINE_NEEDED = false` (refinement overhead exceeds benefit) |
| Default | `REFINE_NEEDED = true` (when in doubt, refine — atomic tickets help every downstream metaphor) |

**Suppression rule**: if the chosen metaphor in Step 3 is `/pickle-pipeline`, `REFINE_NEEDED` is forced to `false` here — pipeline chains refinement internally as Step 0 of its skill prompt; running it twice would double-spend tokens and overwrite the manifest.

Record the trigger reason (e.g. `"refine: AC_SHAPE_SMELL"`, `"refine: TICKET_COUNT≥3"`, `"skip-refine: ALREADY_REFINED"`) — Step 5 prints it.

## Step 3: Pick Metaphor (first match wins)

| If | → |
|---|---|
| `STACK_REVIEW` | `/council-of-ricks` |
| `MEASURABLE_METRIC` and TASK reads "optimize/improve/reduce X to Y" | `/pickle-microverse` |
| `MULTI_STAGE` | `/pickle-pipeline` |
| `INTERACTIVE_HINT` | `/pickle` |
| `TICKET_COUNT ≥ 3` | `/pickle-tmux` |
| Default | `/pickle` |

## Step 4: Pick Followups

Skip all followups if any of: `--no-followups` was passed, OR chosen metaphor is `/pickle-pipeline` (chains citadel + anatomy-park + szechuan-sauce internally — followups would duplicate), OR chosen metaphor is `/pickle-microverse` or `/council-of-ricks` (their work is orthogonal to cleanup).

Otherwise append in order:

| If | → |
|---|---|
| `CITADEL_RISK` | `/citadel --prd <prd_path>` |
| `SUBSYSTEM_TOUCHES ≥ 2` | `/anatomy-park` |
| Expected diff ≥ 500 LOC OR ≥ 10 files OR TASK mentions "cleanup / deslop / refactor sweep" | `/szechuan-sauce` |

Hardening tickets are produced upstream by `/pickle-refine-prd`; followups only handle structural review and slop cleanup.

## Step 5: Print Plan

```
Cronenberg — request mutated.

Task: <TASK or "(driven by PRD)">
Signals: PRD=<y/n> refined=<y/n> tickets=<N> multi-stage=<y/n> metric=<y/n> stack=<y/n> subsystems=<N> interactive=<y/n> ac-smell=<y/n> uncheckable-ac=<y/n> conformance=<y/n>
Refine decision: <REFINE_NEEDED y/n> (<reason — e.g. "TICKET_COUNT≥3", "ALREADY_REFINED", "AC_SHAPE_SMELL", "user --no-refine">)

Plan:
  <if REFINE_NEEDED:> 1. /pickle-refine-prd <forwarded refine flags>
  <next>. <metaphor> <FORWARD>
  <numbered followups, each invoked with --target <cwd> + any FORWARD flags the followup accepts>

Forward any flag (e.g. --backend codex, --scope branch, --max-iterations 50) by passing it to /cronenberg — it carries through. Cronenberg-only flags: --dry-run, --no-followups, --no-refine, --refine.
```

## Step 6: Execute or Stop

**With `--dry-run`** → print `"Dry run. Re-invoke without --dry-run to execute, or copy the commands above."` Stop. Output `<promise>TASK_COMPLETED</promise>`.

**Default (no `--dry-run`)** — execution order:

1. **Refine pre-pass (when `REFINE_NEEDED = true`)** — invoke `/pickle-refine-prd` in-session and wait for `TASK_COMPLETED`. On failure, stop and report. The refined manifest at `prd_refined.md` / `refinement_manifest.json` is now available to the chosen metaphor.
2. **Chosen metaphor** — chain behavior depends on which one:

   - **`/pickle` (interactive, in-session)** — invoke and wait for `TASK_COMPLETED`. Then chain followups in-session with `--target <cwd>` + applicable forwarded flags. On any failure, stop and report the failed step.

   - **Tmux-launching metaphors (`/pickle-tmux`, `/pickle-pipeline`, `/pickle-microverse`, `/council-of-ricks`)** — these return `TASK_COMPLETED` immediately after detaching tmux. **Do NOT auto-chain followups** — they would race the in-progress build. Instead: (1) invoke the metaphor, (2) print `"Build launched in detached tmux. Followups will NOT auto-run — they would race the build. After the tmux session finishes, run:"` followed by the followup commands ready to copy, (3) output `<promise>TASK_COMPLETED</promise>`. Note: if refinement ran in step 1, it completed in-session before the tmux launch — so the metaphor sees the refined manifest.

## Logging

At Step 6 entry: `node ~/.claude/pickle-rick/extension/bin/log-activity.js research "cronenberg → <refine?>+<metaphor>+<followups> (<refine reason>)"`

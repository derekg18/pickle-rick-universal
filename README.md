<img src="images/pickle-rick.png" alt="Pickle Rick for Claude Code" width="100%" />

# 🥒 Pickle Rick for Claude Code

> *"Wubba Lubba Dub Dub! 🥒 I'm not just an AI assistant, Morty — I'm an **autonomous engineering machine** trapped in a pickle jar!"*

Pickle Rick is a complete agentic engineering toolbelt built on the [Ralph Wiggum loop](https://ghuntley.com/ralph/) and ideas from Andrej Karpathy's [AutoResearch](https://github.com/karpathy/autoresearch) project. Hand it a PRD — or let it draft one — and it decomposes work into tickets, spawns isolated worker subprocesses, and drives each through a full **research → plan → implement → verify → review → simplify** lifecycle without human intervention.

New to PRDs? See the **[PRD Writing Guide](PRD_GUIDE.md)** for developers or the **[Product Manager's Guide](PM_GUIDE.md)** for PMs defining and refining requirements. For internals, see [Internals](internals.md). For what's coming next, see the [Feature Roadmap](roadmap.md).

> **Recently released** — `/citadel` conformance audit · **v1.58** Convergence Toolchain Gates ([details](#convergence-gate)) · **v1.57** `/cronenberg` meta-router · **v1.56** pipeline resume hardening · **v1.55** Agent Teams mode (`/pickle --teams`) · **v1.51** Codex backend (`--backend codex`).

---

## How to Build Things with Pickle Rick

Two ways to drive every step: **just describe what you want** (Rick routes to the right skill) or **invoke the slash command yourself** (explicit control). Same artifacts either way.

> **Fire and forget** — for one-shot autopilot from goal to shipped code, hand the whole thing to `/pickle-pipeline "<goal>"` (build → citadel → anatomy-park → szechuan-sauce, sequential, with auto-refine when prose triggers it) or `/cronenberg "<goal>"` (meta-router that picks the right metaphor + cleanup chain for the task). Skip the step-by-step below.

### Step 1: Write a PRD

Every feature starts with a PRD. Just describe what you want:

```
"Help me write a PRD for caching loan status API responses in Redis"
```

Rick interrogates you — *why* are you building this, *who* is it for, and critically: **how will we verify each requirement automatically?** He explores your codebase during the interview, grounding the PRD in what actually exists.

Or write your own `prd.md` and skip the interview — whatever gets requirements on paper with machine-checkable acceptance criteria.

```bash
/pickle-prd                      # Slash-command alternative — same interactive interview
```

### Step 2: Refine the PRD

Just ask:

```
"Refine prd.md"
```

Three AI analysts run in parallel and tear your PRD apart from different angles — requirements gaps, codebase integration points, and risk/scope. They cross-reference each other across 3 cycles.

```bash
/pickle-refine-prd my-prd.md     # Slash-command alternative
```

What you get back:
- `prd_refined.md` — your PRD with concrete file paths, interface contracts, and gap fills
- Atomic tickets — each < 30 min of work, < 5 files, < 4 acceptance criteria, self-contained
- Wiring ticket (3+ tickets) — integrates isolated modules into a working whole
- **Hardening tickets** — auto-appended code quality review + data flow audit scoped to modified files

The hardening tickets (skipped for trivial/small single-ticket PRDs) run as normal Morty workers after all implementation work:
1. **Code Quality Hardening** — szechuan-sauce principles review (KISS, DRY, dead code, edge cases) on all modified files
2. **Data Flow Audit** — anatomy-park-style trace through affected subsystems (ID mismatches, stale schemas, cross-ticket interface alignment)

**Review the tickets before proceeding.** Check ordering, scope, and acceptance criteria. You can edit them directly — they're markdown files.

### Step 3: Implement with tmux (the Ralph Loop)

Just ask:

```
"Build the tickets"
```

This is where Rick takes over. Each ticket goes through 8 phases autonomously: Research → Review → Plan → Review → Implement → Spec Conformance → Code Review → Simplify. Context clears between every iteration — no drift, even on 500+ iteration epics.

```bash
/pickle-tmux --resume            # Slash-command alternative — picks up refined tickets
/pickle-refine-prd --run my-prd.md   # Combine refine + implement in one shot
```

Rick prints a `tmux attach` command — open a second terminal to watch the live 3-pane dashboard:
- **Top-left**: ticket status, phase, elapsed time, circuit breaker state
- **Top-right**: iteration log stream
- **Bottom**: live worker output (research, implementation, test runs, commits)

Sit back. Rick handles the rest.

> **Mode choice** — `/pickle` for short epics (1–7 iterations, full keyboard access); `/pickle-tmux` for long epics (8+) where each iteration spawns a fresh Claude subprocess with a clean context window.

> **Worker-spawn mechanism** — `/pickle --teams` swaps the per-ticket `claude -p` subprocess for a harness-native subagent on a team (`TeamCreate` + `Agent` + `TaskUpdate`). Same 8-phase lifecycle, same artifact contract, no token-sniffing log heuristics — cleaner completion signals and stricter artifact validation. Claude backend only; the default subprocess path is required for the codex backend and for everything that runs through `mux-runner` (`/pickle-tmux`, `/pickle-zellij`, `/pickle-microverse`, `/pickle-pipeline`). See [Agent Teams Mode](#agent-teams) below.

> **Backend choice** — append `--backend codex` (or export `PICKLE_BACKEND=codex`) to route worker/manager spawns through `codex exec` instead of `claude`. See [Codex backend](#codex-backend) below for precedence and examples.

> **If things go wrong** — `"Stop hook error"` in the Claude Code UI is normal: every `decision: block` from the stop hook is labelled that way. The loop is working. If a single ticket fails, run `/pickle-retry <ticket-id>` instead of restarting the whole epic.

### Step 4 (Optional): Metric-Driven Refinement

Just ask:

```
"Push test coverage to 90%"
```

If you can define a measurable goal — test coverage, response time, bundle size, extraction accuracy — the Microverse grinds toward it. Each cycle: make one change, measure, keep or revert. Failed approaches are tracked so it never repeats a dead end.

```bash
# Slash-command alternative:
/pickle-microverse --metric "npm run coverage:score" --task "hit 90% test coverage"
/pickle-microverse --metric "node perf-test.js" --task "reduce p99 latency" --direction lower
/pickle-microverse --goal "error messages are user-friendly and actionable" --task "improve UX"
```

<a id="codex-backend"></a>**Codex backend** — `/pickle`, `/pickle-tmux`, `/szechuan-sauce`, `/anatomy-park`, and `/pickle-microverse` accept `--backend codex` to route the implementation spawn through `codex exec` (via the installed Codex CLI plugin) instead of `claude`. The choice is persisted in `state.json` and survives resume; omit the flag to keep the default `claude` backend. Set `PICKLE_BACKEND=codex` for a session-independent alternative that persists across commands. Precedence: CLI flag > env var > session state > default `claude`. **Incompatible with `--teams`** — agent-teams mode is claude-harness-native; setup rejects the combination at session creation and on `--resume` in either direction.

```bash
/pickle --backend codex "refactor the auth middleware"
/pickle-tmux --backend codex "refactor the auth middleware"
/szechuan-sauce --backend codex src/services/
/anatomy-park --backend codex src/
/pickle-microverse --backend codex --metric "npm run coverage:score" --task "hit 90%"
PICKLE_BACKEND=codex /pickle-tmux "refactor the auth middleware"
```

`/council-of-ricks` integrates Codex differently — its Phase C runs an adversarial Codex subagent by default (`--no-codex` to disable, `--codex-timeout <sec>` to tune). See the Council of Ricks section below.

**Reasoning effort** *(codex backend)* — append `--effort <low|medium|high>` to opt into a non-default reasoning effort. Pickle threads it through to `codex exec` as `-c reasoning.effort=<level>` before the prompt separator. Omit the flag to inherit whatever your local `codex` CLI / `~/.codex/config.toml` is set at — Pickle does not override the default. Persisted in `state.json` and survives `--resume`. Claude path is a no-op (no public reasoning-effort flag for `claude -p`); refinement displays the level for visibility but does not pass it (claude-only).

```bash
/pickle --backend codex --effort high "refactor the auth middleware"
/pickle-tmux --backend codex --effort high "build the caching layer"
```

<a id="agent-teams"></a>**Agent Teams mode** *(v1.55+, claude backend only)* — `/pickle --teams` switches Phase 3 from spawning per-ticket `claude -p` subprocesses to spawning subagents on a harness-native team. Each ticket runs as a `morty-implementer` agent (`Agent` tool with `team_name` + `subagent_type`) that signals completion via `TaskUpdate(status="completed")` instead of the legacy `<promise>I AM DONE</promise>` token + log-size check. Manager-side validation switches to a strict all-of artifact check (`validate-teams-ticket.js`): every required prefix (`research_*.md`, `plan_*.md`, `conformance_*.md`, `code_review_*.md`) must have a matching file or the ticket is marked Failed. The flag is persisted in `state.json` and survives resume.

```bash
/pickle --teams "add a /healthz endpoint"
/pickle --teams --max-parallel 10 "build the caching layer"   # plumbed; v1 sequential
/pickle --resume                                              # teams_mode survives resume
```

Subagent definitions live at `~/.claude/agents/morty-implementer.md` (8-phase implementation lifecycle) and `~/.claude/agents/morty-reviewer.md` (4-phase review lifecycle). Both are deployed by `install.sh`. v1 always dispatches `morty-implementer`; review-group dispatch via `morty-reviewer` is a follow-up — see the [PRD](prds/pickle-agent-teams.md) for the v1 boundary. Legacy subprocess path is untouched and remains the default — passing no `--teams` flag preserves byte-for-byte v1.54 behavior.

When NOT to use: codex backend (rejected at setup), `/pickle-tmux` / `/pickle-zellij` / `/pickle-microverse` / `/pickle-pipeline` (out of scope for v1; legacy spawn only). When to use: epics where you want clean bidirectional comms with the worker, native completion notifications, and the strictest artifact gate available.

### Step 5 (Optional): Cleanup

Four options for polishing the result.

**Full Pipeline** — chains build, Citadel conformance audit, deep review, and deslop in a single tmux session. No manual intervention between phases. When refinement is mentioned in the request (or `--refine` is passed), the skill auto-runs `/pickle-refine-prd` first.

```
"Run the full pipeline to build the caching layer"
```

```bash
# Slash-command alternative:
/pickle-pipeline "build the caching layer"                            # No refinement (no trigger)
/pickle-pipeline "refine the prd then build the caching layer"        # Auto-inferred from prose
/pickle-pipeline --refine "build the caching layer"                   # Explicit force, prose silent
/pickle-pipeline --no-refine "refine the prd first then ship X"       # Suppress auto-inferred refinement
/pickle-pipeline --skip-anatomy "refactor auth"                       # Skip deep review
/pickle-pipeline --target src/services "add retry logic"              # Scope review phases
```

The auto-refine trigger fires on `refine-prd` / `prd refinement`, on `refine`/`refinement`/`decompose` near `prd` or `first` (within 40 chars), or on workflow ordering like `refine then build`. Bare `refine the dropdown UX` won't trigger — use `--refine` to force, `--no-refine` to suppress. Refinement always uses the `claude` backend regardless of `--backend` (refinement is planning, not implementation). Fails fast if no `prd.md` exists in cwd or session — run `/pickle-prd` first.

**Citadel** — audits the implemented branch against the PRD before deeper review phases. It reads PRD acceptance criteria, interface contracts, changed files, trap-door notes, and sibling phase artifacts when present. Findings are grouped by audit surface: PRD coverage, endpoint contract drift, trap-door enforcement, sibling route divergence, state-machine drift, frontend prop drift, cross-phase findings, and diff hygiene.

```bash
# Slash-command alternative:
/citadel --prd prd.md --diff main..HEAD
/citadel --prd prd.md --strict --report /tmp/citadel_report.json
```

Citadel writes a versioned JSON report with `schema: "1.0"`. Standalone runs use `--report <path>` when supplied; `/pickle-pipeline` writes `<session>/citadel_report.json` and passes that report to anatomy-park and szechuan-sauce. `--strict` makes High findings fail the phase; without it, only Critical findings halt the pipeline.

**Resume hardening** *(v1.56+)* — pipeline pre-flight excludes `prds/` and `docs/` from the clean-tree check by default, so doc churn during a long-running epic doesn't block resume. Override the list per-session via `pipeline.json.ignore_dirty_paths` (set `[]` to opt out entirely). The pickle phase pins its own `command_template` on entry — a stale `state.command_template` from a prior phase no longer misroutes resumed workers to the wrong skill prompt.

**Szechuan Sauce** — hunts coding principle violations (KISS, DRY, SOLID, security, style) and fixes them one at a time until zero remain. Great for post-feature polish before merging.

```
"Deslop src/services with szechuan sauce"
```

```bash
# Slash-command alternative:
/szechuan-sauce src/services/                  # Deslop a directory
/szechuan-sauce --dry-run src/                 # Catalog violations without fixing
/szechuan-sauce --focus "error handling" src/  # Narrow the review
```

**Anatomy Park** — traces data flows through subsystems looking for runtime bugs: data corruption, timezone issues, rounding errors, schema drift. Catalogs "trap doors" (files that keep breaking) in `CLAUDE.md` files for future engineers.

```
"Run anatomy park on src/"
```

```bash
# Slash-command alternative:
/anatomy-park src/                         # Deep subsystem review
/anatomy-park --dry-run                    # Review only, no fixes
```

**Cronenberg (meta-router)** — when you don't know which cleanup metaphor fits, describe the goal and let `/cronenberg` pick the right pickle metaphor + cleanup chain for the task. Explicit invocation only — never auto-triggers.

```bash
/cronenberg "tighten the integrations package"
```

### The Full Flow at a Glance

End-to-end Pickle Rick pipeline — applies regardless of how you kick it off (described task, individual slash commands, `/pickle-pipeline`, or `/cronenberg`). Each step is independently invocable; the diagram is the canonical happy path.

```
You describe a feature
       │
       ▼
  /pickle-prd              ← Interactive PRD drafting (or write your own)
       │
       ▼
  /pickle-refine-prd       ← 3 parallel analysts refine + decompose into tickets
       │                      Includes auto-generated hardening tickets:
       │                      • Code quality review (szechuan-sauce principles)
       │                      • Data flow audit (anatomy-park trace)
       ▼
  /pickle-tmux --resume    ← Autonomous implementation (Ralph loop)
       │                      Research → Plan → Implement → Verify → Review → Simplify
       │                      Context clears every iteration. Circuit breaker auto-stops runaways.
       │                      Hardening tickets run automatically after implementation.
       ▼
  /pickle-microverse       ← (Optional) Metric-driven optimization loop
       │
       ▼
  /pickle-pipeline         ← (Optional) Full lifecycle: build → citadel → deep review → deslop
  ─ or run phases individually ─
  /citadel                 ← (Optional) PRD conformance audit
  /anatomy-park            ← (Optional) Data flow correctness review
  /szechuan-sauce          ← (Optional) Code quality cleanup
       │
       ▼
  Ship it 🥒
```

---

## ⚡ Quick Start

### 1. Install

```bash
git clone https://github.com/gregorydickson/pickle-rick-claude.git
cd pickle-rick-claude
bash install.sh
```

### 2. Add the Pickle Rick persona to your project

The installer deploys `persona.md` to `~/.claude/pickle-rick/`. Add it to your project's `CLAUDE.md`:

```bash
# Already have a CLAUDE.md? Append (safe — won't overwrite your content):
cat ~/.claude/pickle-rick/persona.md >> /path/to/your/project/.claude/CLAUDE.md

# Starting fresh:
mkdir -p /path/to/your/project/.claude
cp ~/.claude/pickle-rick/persona.md /path/to/your/project/.claude/CLAUDE.md
```

> **After upgrading:** `bash install.sh` deploys a fresh `persona.md`. If you appended it to your project's `CLAUDE.md`, re-sync by replacing the old persona block with the updated one.

### 3. Run

> **Permissions:** Launch Claude with `claude --dangerously-skip-permissions`. Pickle Rick's loops spawn worker subprocesses that already run permissionless, but the root instance needs it too — otherwise you'll drown in permission prompts for every file write, bash command, and hook invocation.

```bash
cd /path/to/your/project
claude --dangerously-skip-permissions
# then follow the workflow above — start with a PRD
```

### 4. Uninstall

Two uninstall paths depending on how much you want to remove.

**Remove hooks only** — disables automatic behavior (Stop loop enforcement, commit logging, config protection) but keeps extension files and slash commands available for manual use:

```bash
bash uninstall-hooks.sh
```

Settings are backed up to `~/.claude/backups/settings.json.pickle-uninstall-hooks.<timestamp>` before modification. Run `bash install.sh` to re-enable hooks later — `install.sh` is idempotent, safe to re-run any time. Third-party hooks in `settings.json` (GitNexus, RTK, etc.) are never touched.

**What still works without hooks:**

- **One-shot utilities and reporters** (never needed hooks) — `/pickle-prd`, `/pickle-refine-prd`, `/pickle-dot`, `/pickle-dot-patterns`, `/pickle-metrics`, `/pickle-status`, `/pickle-standup`, `/help-pickle`, `/attract`.
- **Detached-runner commands** (bootstrap a separate process that runs independently inside tmux/zellij) — `/pickle-tmux`, `/pickle-zellij`, `/pickle-jar-open`, `/pickle-microverse`, `/szechuan-sauce`, `/anatomy-park`, `/pickle-pipeline`. These launch `mux-runner.js` / `jar-runner.js` / `microverse-runner.js` / `pipeline-runner.js` inside the multiplexer; the runner spawns its own `claude -p` subprocesses and drives iteration via Node.js, not via the Stop hook. In tmux mode the Stop hook is a pass-through anyway.

**What needs hooks** — in-session loops where the Stop hook is the iteration driver for the same Claude session: `/pickle` (interactive mode), `/council-of-ricks`, `/portal-gun`, `/project-mayhem`, `/pickle-retry`. Without hooks these run the first step and stop.

**Full uninstall** — removes hooks, extension scripts at `~/.claude/pickle-rick/`, and all pickle-rick slash commands at `~/.claude/commands/`:

```bash
bash uninstall.sh
```

**Preserved after full uninstall** (delete manually if desired):
- Session history at `~/.local/share/pickle-rick/sessions/`
- Activity logs at `~/.local/share/pickle-rick/activity/`
- Settings backups at `~/.claude/backups/`
- Project-local `CLAUDE.md` files — remove the appended persona block manually

Third-party hooks in `settings.json` (GitNexus, RTK, etc.) are never touched.

---

## Other Workflows

### Council of Ricks: Graphite Stack Review

Reviews your [Graphite](https://graphite.dev) PR stack iteratively — but never touches your code. Generates **agent-executable directives** you feed to your coding agent. Escalates through focus areas: stack structure → CLAUDE.md compliance → correctness → cross-branch contracts → test coverage → security → polish.

```bash
/council-of-ricks                  # Review the current Graphite stack
```

### Pickle Jar: Night Shift Batch Mode

Queue tasks for unattended batch execution overnight.

```bash
/add-to-pickle-jar                 # Queue current session
/pickle-jar-open                   # Run all queued tasks sequentially
```

---

## Tool Deep Dives

### 🔬 Microverse — Metric Convergence Loop

<p align="center">
  <img src="images/microverse.png" alt="The Microverse — powering your Pickle Rick app" width="100%" />
</p>

> *"I put a universe inside a box, Morty, and it powers my car battery. This is the same thing, except the universe is your codebase and the battery is a metric."*

Two modes: **Command Metric** (`--metric`) for objective numeric scores, and **LLM Judge** (`--goal`) for subjective quality assessment.

```
Gap Analysis (iteration 0)
    │ measure baseline, analyze codebase, identify bottlenecks
    ▼
┌─────────────────────────────────────────────────┐
│ Iteration Loop                                   │
│  1. Plan one targeted change (avoid failed list) │
│  2. Implement + commit                            │
│  3. Measure metric                                │
│     • Improved → accept, reset stall counter     │
│     • Held → accept, increment stall counter     │
│     • Regressed → git reset, log failed approach │
│  4. Converged? (stall_counter ≥ stall_limit)     │
└──────────────────────┬──────────────────────────┘
                       ▼
              Final Report
```

| | **Microverse** | **Pickle** |
|---|---|---|
| **Goal** | Optimize toward a measurable target | Build features from a PRD |
| **Iteration unit** | One atomic change per cycle | Full ticket lifecycle |
| **Progress signal** | Metric score | Ticket completion |
| **Defines "done"** | Convergence (score stops improving) | All tickets complete |

**Backend** — add `--backend codex` (or set `PICKLE_BACKEND=codex`) to run the per-iteration implementation via `codex exec` instead of `claude`. The measurement/judge step is unaffected.

### 🍗 Szechuan Sauce — Iterative Code Deslopping

<p align="center">
  <img src="images/szechwan-sauce.jpeg" alt="Command: Szechwan Sauce — The Quest for Clean Code" width="100%" />
</p>

> *"I'm not driven by avenging my dead family, Morty. That was fake. I-I-I'm driven by finding that McNugget sauce."*

Reads 30+ coding principles (KISS, YAGNI, DRY, SOLID, Guard Clauses, Fail-Fast, Encapsulation, Cognitive Load, etc.) and scores against a priority matrix (P0 security/data-loss through P4 style). Each iteration: find highest-priority violation, fix atomically, run tests, commit, measure. Regressions auto-revert.

**Phase 0: Contract Discovery** — greps the codebase for importers of every export in target files, builds a contract map, flags cross-module mismatches. Re-checked after every fix.

Supports `--domain <name>` for domain-specific principles (e.g., `financial` adds monetary precision, rounding, regulatory compliance) and `--focus "<text>"` to elevate specific concerns.

**Backend** — add `--backend codex` (or set `PICKLE_BACKEND=codex`) to swap the per-iteration fix spawn from `claude` to `codex exec`. Useful when Codex catches violations a Claude pass missed.

### 🏥 Anatomy Park — Deep Subsystem Review

<p align="center">
  <img src="images/anatomy-park.jpeg" alt="Anatomy Park — Deep Subsystem Review" width="100%" />
</p>

> *"Welcome to Anatomy Park! It's like Jurassic Park but inside a human body. Way more dangerous."*

Auto-discovers subsystems, rotates through them round-robin, three-phase protocol per iteration:
1. **Review** (read-only): trace data flows, check git history, rate CRITICAL/HIGH, propose fixes
2. **Fix**: apply minimal edits, write regression tests, run full suite
3. **Verify** (read-only): verify callers/consumers, combinatorial branch verification, revert on regression

**Trap doors** — files with repeated fixes or structural invariants get documented in subsystem `CLAUDE.md` files:

```markdown
## Trap Doors
- `bank-statement.service.ts` — borrowerFileId MUST equal S3 batch UUID; tenant isolation depends on effectiveLenderId threading
```

**Backend** — add `--backend codex` (or set `PICKLE_BACKEND=codex`) to run the Review/Fix/Verify phases through `codex exec` instead of `claude`. The subsystem rotation and trap-door cataloging behave identically regardless of backend.

<a id="convergence-gate"></a>### 🚪 Convergence Gate — Toolchain Truth Layer *(v1.58+)*

> *"Done means the gate says done, Morty. Not vibes."*

`/szechuan-sauce` and `/anatomy-park` can no longer declare convergence on a branch that's semantically clean but mechanically broken (failing typecheck, lint errors, red tests). The gate is the truth layer they consult before stopping.

**How it runs:**

- **Finalize** — at convergence-trigger time both skills hand off to `extension/src/bin/finalize-gate.ts`, which runs the project's typecheck + lint + tests (project-aware via `extension/data/gate-commands.json` — pnpm/npm/yarn/cargo/go), compares results against a baseline fingerprint set, and either lets the skill exit clean or kicks the remediator.
- **Per-iteration** (anatomy-park only) — `microverse-runner` runs a *changed-files* gate after each iteration commit. Regressions increment a soft counter; the loop continues with a one-time warning at threshold (default 5).
- **Remediator** — `morty-gate-remediator` is a mechanical-only worker: prettier/eslint autofix plus four hand-fix classes (control-regex, async-generator require-await, unnecessary-type-assertion, spec-mock alignment). Every fix runs inside a snapshot-and-revert envelope — if previously-green tests go red, the change is reverted and `gate_autofix_reverted` is logged. `/szechuan-sauce` caps the gate ↔ remediator loop at 3 cycles, `/anatomy-park` at 5.
- **Out-of-scope failures** — anything outside the session's `scope.json:allowed_paths` is written to `gate/out_of_scope_failures_<iso>.md` and surfaced without invoking the remediator.

**Baseline mode** — fingerprints are `(file, ruleOrCode, occurrence_index)` tuples persisted to `${SESSION_ROOT}/gate/baseline.json`. Strict mode requires zero failures. Baseline mode requires no *new* failures (pre-existing problems don't block convergence). Freshness invariant halts on missing or stale baseline (default 30 iterations / 4 hours).

**Hang & flake guards** — per-check timeouts (typecheck 120s / lint 60s / tests 300s) plus a 600s cumulative cap. Test scripts are filtered against a hard-refusal regex (`integration|e2e|golden|smoke|baseline|playwright|cypress|hardhat`) and a positive-allow list (`vitest|jest|node --test|mocha`). Add `convergence_gate.known_flake_files` to surface flaky test paths as `green-with-known-flake-warnings` instead of false-red.

**Kill-switch** — set `PICKLE_GATE_DISABLED=1` to bypass the post-runner gate entirely. The skill convergence rules revert to pre-1.58 behavior (semantic-only).

**Microverse opt-in** — `/pickle-microverse` runs are NOT gated by default. Add a filename to `convergence_gate.enabled_convergence_files` (default `["anatomy-park.json"]`) to opt a microverse-driven convergence file into per-iteration gating.

### 🧬 Cronenberg — The Meta-Router

<p align="center">
  <img src="images/cronenberg.jpg" alt="Cronenberg — Mutate the request. Pick the pipeline." width="100%" />
</p>

> *"This is a Cronenberg world, Morty. We just gotta accept it and route around it."*

`/cronenberg` is the **explicit-invocation meta-router**. You hand it a request — a task, a PRD path, a bag of flags — and it deterministically mutates that request into the correct pipeline shape: which build skill to launch, which cleanup skills to chain after, which flags to forward. Same signals always produce the same plan. No LLM judgment inside the matrix.

It's opt-in. The persona's existing routing rules are untouched — type `/cronenberg` only when you want the router to decide for you instead of guessing the right command yourself.

```
$ARGUMENTS  ──┐
PRD?         ─┤   ┌─────────────────────────┐    ┌──────────────────┐
git status   ─┼──►│  Step 2: gather signals │───►│ Step 3: pick     │
TASK verbs   ─┘   │  PRD / METRIC / TICKETS │    │   metaphor       │
                  │  MULTI_STAGE / STACK    │    └────────┬─────────┘
                  │  SUBSYSTEMS / INTERACT  │             │
                  └─────────────────────────┘             ▼
                                                ┌──────────────────┐
                                                │ Step 4: pick     │
                                                │   followups      │
                                                └────────┬─────────┘
                                                         ▼
                                                  Execute plan
                                              (or --dry-run to
                                                preview only)
```

**Decision matrix — metaphor (first match wins):**

| Signal | → |
|---|---|
| `STACK_REVIEW` (review-focused, mentions PR stack / `gt log`) | `/council-of-ricks` |
| `MEASURABLE_METRIC` and TASK reads "optimize/improve/reduce X to Y" | `/pickle-microverse` |
| `MULTI_STAGE` (TASK lists 2+ of refine/build/optimize/cleanup/review) | `/pickle-pipeline` |
| `INTERACTIVE_HINT` ("interactive", "watch me", "step through") | `/pickle` |
| `TICKET_COUNT ≥ 3` | `/pickle-tmux` |
| Default | `/pickle` |

**Decision matrix — followups (additive):**

| Signal | → |
|---|---|
| `CITADEL_RISK` (multi-ticket PRD, spec-conformance request, or multi-subsystem PRD task) | `/citadel --prd <prd_path>` |
| `SUBSYSTEM_TOUCHES ≥ 2` | `/anatomy-park` |
| Diff ≥ 500 LOC OR ≥ 10 files OR TASK mentions "cleanup / deslop / refactor sweep" | `/szechuan-sauce` |

Followups are skipped automatically when the chosen metaphor is `/pickle-pipeline` (it already chains citadel + anatomy-park + szechuan-sauce internally), `/pickle-microverse`, or `/council-of-ricks` (orthogonal to cleanup), or when you pass `--no-followups`. Hardening tickets are produced upstream by `/pickle-refine-prd` — there is no separate review-pass step.

**Tmux-detach safety:** `/pickle-tmux`, `/pickle-pipeline`, `/pickle-microverse`, and `/council-of-ricks` launch detached tmux sessions and return immediately. Cronenberg will **not** auto-chain followups onto these — they would race the in-progress build. Instead, when cronenberg routes to a tmux-launching metaphor, it launches the build and prints the followup commands ready to copy-paste once the session finishes.

**Flag pass-through:** `--dry-run`, `--no-followups`, `--no-refine`, and `--refine` are cronenberg-only (the latter two control the refinement decision). Everything else (`--backend codex`, `--scope branch`, `--max-iterations`, `--target`, `--interactive`, …) passes through verbatim to the chosen metaphor and applicable followups.

**Refine decision:** Cronenberg analyzes whether to run `/pickle-refine-prd` *before* the build, instead of defaulting to skip. Refinement runs when there's a PRD that hasn't been refined yet AND any of: ≥3 inferred tickets, ≥2 subsystems touched, multi-stage TASK, AC-shape smell (endpoint-enumerated AC bullets), or machine-uncheckable AC prose. Refinement is skipped when there's no PRD, when `prd_refined.md` already exists, when single-file scope, or when `/pickle-pipeline` is the chosen metaphor (it chains refinement internally). The plan output prints the trigger reason so you know why cronenberg made its call.

| | **Cronenberg** | **Persona Routing** |
|---|---|---|
| **Trigger** | Explicit `/cronenberg` | Automatic on every prompt |
| **Decision** | Deterministic matrix | LLM-judged from context |
| **Output** | Dry-run plan (or chained execution) | Direct skill invocation |
| **Flag handling** | Pass-through forwarded | Persona-curated |
| **When to use** | You want auditable, repeatable routing | You want fast, contextual routing |

**Example:**

```bash
/cronenberg refine then build the auth refactor and clean it up --backend codex
```

Plan:

```
1. /pickle-pipeline refine then build the auth refactor and clean it up --backend codex
   (followups skipped — pipeline chains citadel + anatomy-park + szechuan-sauce internally)
```

### 🏛️ Council of Ricks — Details

<p align="center">
  <img src="images/council-of-ricks.png" alt="Council of Ricks — Graphite PR Stack Reviewer" width="100%" />
</p>

Iterative Graphite stack reviewer that generates agent-executable directives and auto-publishes review comments to each branch's PR at session end. Every round fans out category- and branch-scoped subagents in parallel via the `Agent` tool — a round review that used to take 30–60 min of serial passes now finishes in one fan-out cycle.

**Requirements:**

- Graphite stack with ≥1 non-trunk branch (`gt log short`)
- A `CLAUDE.md` with project rules, passing lint, and architectural lint rules in ESLint
- **GitHub CLI (`gh`)** authed, if you want auto-publish (see note below on why `gh` and not `gt`)
- **Codex plugin** installed and authed, for the adversarial-review pass to be effective. Install: `/plugin install openai-codex` (or `npm i -g @openai/codex-cli` + `codex setup`). Without it, the Phase C Codex subagent is skipped — the rest of the round still runs, but you lose the adversarial-reviewer perspective.

**Round structure** — each round runs four phases; within a round every category runs concurrently:

- **Phase A — Historical Context** (serial, main agent): `git log` + prior PR comments (`gh pr list/view`) + in-file guidance comments → `historical-brief.md` consumed by Phase B/C subagents
- **Phase B — Category Team** (parallel fan-out, one `Agent` per category — at stack tier ≥ `l` each category shards per-branch, so `N_branches × N_categories` concurrent subagents):
  1. Stack Structure — PR sizing, commit hygiene, branch naming, stack ordering
  2. CLAUDE.md Compliance — project rule verification per branch diff
  3. Contract Discovery — producer→consumer map, Zod/enum/union coverage
  4. Cross-Branch Contracts + Combinatorial — 2^N boolean/nullable guard verification
  5. Test Coverage + Production Migration Safety — persisted-field change detection
  6. Security — input validation, auth gaps, injection, tenant isolation
  7. Migration Hygiene (conditional) — CHECK drift, idempotency, schema drift (skipped when no Drizzle journal)
  8. Szechuan Principles Sweep — P0–P4 scan against the principles reference
  9. Polish + Trap Door Candidates
- **Phase C — Branch Team** (parallel fan-out, same message as Phase B):
  - One `Agent` per non-trunk branch for per-branch Correctness + Data Flow (no checkout needed — pure diff review)
  - One `Agent` for the Codex sweep (internally sequential because checkout needed; conditional on Codex availability)
- **Phase D — Synthesis** (serial, main agent): false-positive pre-filter → confidence filter → dedupe (COUNCIL/CODEX merge) → directive + summary append

**Severity × Confidence scoring** — every finding scored `[P0–P4, conf=0–100]`. Confidence `< 80` drops before reporting. **P0 severity escape hatch**: P0 findings at conf ≥ 50 still surface tagged `[NEEDS-VERIFICATION]` (a maybe-real SQL injection is worth an eyeball). Composes with an explicit **false-positives filter** — pre-existing issues, linter/typechecker-catchable errors, author-silenced issues, uncodified style nits, and speculative future-risk are excluded before scoring. Rubric adapted from Anthropic's official `code-review` plugin.

**Approval gate** — `THE_CITADEL_APPROVES` fires only when all four conditions hold: (1) current round ≥ `min_iterations` (the tier-resolved value from Step 8 — see size-tier scaling below), (2) last two `## Round <N>:` headers in the summary both end with `— clean round.`, (3) across those two consecutive clean rounds no unconditional category (Phase A, B1–B6, B8, B9, Phase C per-branch Correctness) was `skipped`, (4) zero P0/P1 findings across COUNCIL + CODEX in those two rounds. Partial rounds (any unconditional skip) break the streak — Phase B7 Migration and Phase C Codex are conditional and may skip without demoting the round.

**Size-tier scaling** — at stack discovery the Council computes `git diff --numstat <trunk>...<tip>` and scales `min_rounds` to the stack's surface area, because each round surfaces findings that reframe code earlier rounds walked past. Large PRs need more rounds to converge:

| Stack diff LOC | OR | Files touched | Scaled min rounds |
|---|---|---|---|
| < 300 | or | < 10 | 2 |
| 300 – 1,499 | or | 10 – 29 | 3 |
| 1,500 – 4,999 | or | 30 – 79 | 4 |
| 5,000 – 9,999 | or | 80 – 149 | 5 |
| 10,000 – 19,999 | or | 150 – 299 | 6 |
| ≥ 20,000 | or | ≥ 300 | 7 |

Takes the max of the LOC tier and the files tier — either axis can flag "big enough." `effective_min = max(default_council_min_rounds, scaled_tier)`. `effective_max = max(default_council_max_rounds, effective_min + 2)` to guarantee two rounds of headroom above the floor. CLI flags `--min-iterations` / `--max-iterations` override the scaled values entirely — pass them when you want a quick sanity-check sweep on a big stack, or to force more rounds on a small one.

**Auto-publish at session end** — when the gate fires OR max_iterations is hit, one PR comment per non-trunk branch is posted via `gh pr comment` to the GitHub-backed PR that Graphite manages. Idempotent via `.published/<branch-slug>` markers. Fails open at every level — `gh` unavailable / no PR / per-branch post failure never blocks the terminal promise. Fallback body files written to `council-comments/<branch-slug>.md` on every skip class. Opt out with `--no-publish` or `default_council_publish: false`.

**Why `gh` and not `gt` for publishing** — Graphite's CLI has no `comment` subcommand and doesn't expose a comment-posting primitive. `gt` manages stacks (submit, restack, sync, create, branch); review comments are handled by Graphite's web dashboard, which syncs from GitHub. So the only mechanical path to post an actual comment is `gh pr comment` — the comment still shows up on the Graphite stack view because Graphite renders GitHub comments. If Graphite ever ships a `gt comment` or exposes an API token surface, the Council will switch to it.

**Trap Doors** — structural weaknesses (design constraints that will re-break if forgotten) go in the directive's Trap Door section. The Council never writes to repo files; the fixing agent decides whether to add them to `CLAUDE.md`.

**Directive contract (v1.50.0)** — every round writes `council-directive.json` atomically (tmp + rename) as the typed source of truth; `council-directive.md` is free-form human-readable output only, never scraped. Every subagent returns a shape-validated JSON payload (validator at `extension/src/services/council-schema.ts`); schema drift fails loud — the offending category is recorded as `skipped` with the jsonpath of the violation and the round demotes to partial. No more silent parser drift.

### 🌀 Portal Gun — Gene Transfusion

<p align="center">
  <img src="images/portal-gun.png" alt="Portal Gun — gene transfusion for codebases" width="100%" />
</p>

> *"You see that code over there, Morty? In that other repo? I'm gonna open a portal, reach in, and yank its DNA into OUR dimension."*

`/portal-gun` implements [gene transfusion](https://factory.strongdm.ai/techniques/gene-transfusion) — transferring proven coding patterns between codebases using AI agents. Point it at a GitHub URL, local file, npm package, or just describe a pattern, and it extracts the structural DNA, analyzes your target codebase, then generates a transplant PRD with behavioral validation tests and automatic refinement.

The `--run` flag goes further: after generating the transplant PRD, it launches a convergence loop that executes the migration, scans coverage against the original inventory, generates a delta PRD for any missing items, and re-executes until 100% of the donor pattern has been transplanted.

**v2** added a persistent **pattern library** (cached patterns reused across sessions), **complete file manifests** with anti-truncation enforcement, **multi-language import graph tracing** (TypeScript/JavaScript, Python, Go, Rust), **6-category transplant classification** (direct transplant, type-only, behavioral reference, replace with equivalent, environment prerequisite, not needed), a **PRD validation pass** that verifies every file path against the filesystem with 6 error classes, **post-edit consistency checking** that catches contradictions after scope changes, and **deep target diffs** with line-level modification specs.

```bash
/portal-gun https://github.com/org/repo/blob/main/src/auth.ts   # Transplant from GitHub
/portal-gun ../other-project/src/cache.ts                        # Transplant from local file
/portal-gun --run https://github.com/org/repo/tree/main/src/lib  # Transplant + auto-execute convergence loop
/portal-gun --save-pattern retry ../donor/retry-logic.ts         # Save pattern to library for reuse
/portal-gun --depth shallow https://github.com/org/repo           # Summary + structural pattern only
```

### 🪠 Plumbus — DAG Shaping Loop

<p align="center">
  <img src="images/plumbus.jpg" alt="Plumbus — iterative DAG shaping loop" width="100%" />
</p>

> *"Everybody has a plumbus in their home, Morty. First they take the dinglebop, smooth it out with a bunch of schleem..."*

The same convergence loop applied to a single attractor `.dot` pipeline. Runs the attractor validator as a hard gate, walks every edge, and converges against the `pickle-dot-patterns` rubric (DAG validity, Tier 1 mandatory patterns, anti-patterns). Use it after `/pickle-dot` generates a graph you want hardened before `/attract`.

```bash
/plumbus pipeline.dot                         # Shape a DAG into a proper plumbus
/plumbus --dry-run pipeline.dot               # Catalog violations only
/plumbus --focus "fan-out safety" pipeline.dot
/plumbus --no-validator pipeline.dot          # Pattern-only (no attractor repo)
```

**When to use which:** Szechuan Sauce asks *"is this code well-designed?"* — Anatomy Park asks *"is this code correct?"* — Plumbus asks *"will this DAG actually run without deadlocking?"*

#### Generative Audit Frames

Plumbus runs six analysis frames during the first iteration Edge Walk (Override 6). Each frame produces findings in `gap_analysis.md` under `## Generative Findings`, using a three-severity model (`pre_verification_severity` / `post_verification_severity` / `rendered_severity`).

| Frame | What it checks |
|-------|----------------|
| **Frame 1: Context Key Lifecycle Trace** | Orphan readers/writers, asymmetric writers, multi-writer conflicts |
| **Frame 2: Success/Failure Symmetry** | State-mutating nodes missing the opposite-outcome unwind |
| **Frame 3: Edge Condition Exhaustiveness** | Cartesian-product stuck states and non-deterministic routing |
| **Frame 4: Tool Exit Code Semantics Audit** | Routing-signal vs. build/check tool wiring mismatches |
| **Frame 5: Loop Convergence Proof Obligation** | SCCs without a reachable finite-exit convergence key |
| **Frame 6: Counterfactual Outcome Test** | State-mutating tool nodes lacking a direct or transitive guard |

**Kill-switch**: set `PLUMBUS_GENERATIVE_AUDIT=off` to skip Override 6 entirely (no analyzer invocation, no `## Generative Findings` written). Any other value (including absent) runs the audit normally.

---

## 🚀 Command & Flag Reference

Every slash command and flag — including command-scoped families and the `†`/Codex/Teams notes — lives in **[COMMANDS.md](COMMANDS.md)**.

---

> **Under the hood:** See [internals.md](internals.md) for the 8-phase ticket lifecycle, manager/worker model, stop-hook loop, context clearing, state schema, settings reference, and every internal system that makes this thing run.

---

## 📊 Metrics

```bash
/pickle-metrics                    # Last 7 days, daily breakdown
/pickle-metrics --days 30          # Last 30 days
/pickle-metrics --weekly           # Weekly buckets (defaults to 28 days)
/pickle-metrics --json             # Machine-readable JSON output
```

---

## 📋 Requirements

- **Node.js** 18+
- **Claude Code** CLI (`claude`) — v2.1.49+
- **jq** (for `install.sh`, `uninstall.sh`, `uninstall-hooks.sh`)
- **rsync** (for `install.sh`)
- **tmux** *(optional — for `/pickle-tmux`, `/szechuan-sauce`, `/anatomy-park`, `/pickle-pipeline`)*
- **Zellij** >= 0.40.0 *(optional — for `/pickle-zellij`)*
- **Graphite CLI** (`gt`) *(optional — for `/council-of-ricks`)*
- **GitHub CLI** (`gh`) authed *(optional — required only for `/council-of-ricks` auto-publish; the review itself works without it)*
- **Codex plugin** *(optional — required for `--backend codex` on `/pickle`, `/pickle-tmux`, `/pickle-microverse`, `/anatomy-park`, `/szechuan-sauce`, and for `/council-of-ricks` Phase C adversarial review. Without it, `--backend codex` spawns fail and Council's Phase C is skipped — Claude-backed runs and non-Codex Council rounds are unaffected. Install: `/plugin install openai-codex` or `npm i -g @openai/codex-cli` + `codex setup`)*
- macOS or Linux (Windows not supported)

---

## 🏆 Credits

This port stands on the shoulders of giants. *Wubba Lubba Dub Dub.*

| | |
|---|---|
| 🥒 **[galz10](https://github.com/galz10)** | Creator of the original [Pickle Rick Gemini CLI extension](https://github.com/galz10/pickle-rick-extension) — the autonomous lifecycle, manager/worker model, hook loop, and all the skill content that makes this thing work. This project is a faithful port of their work. |
| 🧠 **[Geoffrey Huntley](https://ghuntley.com)** | Inventor of the ["Ralph Wiggum" technique](https://ghuntley.com/ralph/) — the foundational insight that "Ralph is a Bash loop": feed an AI agent a prompt, block its exit, repeat until done. Everything here traces back to that idea. |
| 🔬 **[Andrej Karpathy](https://github.com/karpathy)** | [AutoResearch](https://github.com/karpathy/autoresearch) — agentic-research scaffolding whose ideas inform the PRD-driven decomposition + multi-analyst refinement loop. |
| 🔧 **[AsyncFuncAI/ralph-wiggum-extension](https://github.com/AsyncFuncAI/ralph-wiggum-extension)** | Reference implementation of the Ralph Wiggum loop that inspired the Pickle Rick extension. |
| ✍️ **[dexhorthy](https://github.com/dexhorthy)** | Context engineering and prompt techniques used throughout. |
| 📺 **Rick and Morty** | For *Pickle Riiiick!* 🥒 |

---

## 🥒 License

Apache 2.0.

---

*"I'm not a tool, Morty. I'm a **methodology**."* 🥒

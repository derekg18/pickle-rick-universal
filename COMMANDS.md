# Command Reference

All Pickle Rick slash commands and their flags. For workflow narrative and tool deep dives, see the [README](README.md).

## Commands

Status legend: **implemented** commands run the described workflow; **preview/report-plan** commands inspect inputs and emit plans or reports but avoid risky side effects by default; **skeleton-only** commands return typed non-destructive contracts and do not perform deploy, cloud, destructive rollback, secret rotation, persistence, or sandbox actions; **deprecated** commands route users to replacements; **internal** commands are worker prompts, not operator entrypoints.

### Core Lifecycle

| Command | Status | Description |
|---|---|---|
| `/pickle "task"` † | implemented | Start the full autonomous loop: PRD, breakdown, and 8-phase execution |
| `/pickle prd.md` † | implemented | Pick up an existing PRD and skip drafting |
| `/pickle-tmux "task"` † | implemented | Same loop with context clearing via tmux. Best for long epics. Requires `tmux` |
| `/pickle-zellij "task"` | implemented | Same loop in Zellij with KDL layouts. Requires Zellij >= 0.40.0 |
| `/pickle-pipeline "task"` † | implemented | Full lifecycle: pickle-tmux, Citadel, Anatomy Park, and Szechuan Sauce in one tmux session |
| `/pickle-prd` | implemented | Draft a PRD standalone |
| `/pickle-refine-prd [path]` | implemented | Refine a PRD with parallel analysts and decompose it into tickets |
| `/pickle-refine-prd --run [path]` | implemented | Refine, decompose, and auto-launch a tmux session |
| `/pickle-retry <ticket-id>` | implemented | Re-attempt a failed ticket; also used by Jerry Mode recovery handoff |
| `/eat-pickle` | implemented | Cancel the active loop |
| `/pickle-status` | implemented | Show current session phase, iteration, ticket status, and pause state |
| `/pickle-standup` | implemented | Linear-keyed standup from activity logs |
| `/pickle-metrics` | implemented | Token usage, commits, LOC, and machine-readable metrics |
| `/help-pickle` | implemented | Show all commands, flags, MVP tiers, and handoff settings |

### Review And Quality

| Command | Status | Description |
|---|---|---|
| `/anatomy-park [target]` † | implemented | Deep subsystem review: trace data flows, fix bugs, and catalog trap doors |
| `/szechuan-sauce [target]` † | implemented | Principle-driven code-quality review and remediation |
| `/citadel --prd <path>` | implemented | Post-implementation conformance audit against PRD acceptance criteria, branch diff, and trap doors |
| `/council-of-ricks` | implemented | Graphite PR stack review. Generates directives only and does not directly fix code |
| `/pickle-debate "<question>"` | implemented | Multi-agent implementation debate |
| `/plumbus <file.dot>` | implemented | Iterative DAG shaping on a single `.dot` file |
| `/cronenberg "task"` | implemented | Meta-router that chooses the right workflow and optional cleanup chain |
| `/meeseeks` | deprecated | Compatibility alias; use `/anatomy-park` or `/szechuan-sauce` |
| `/meeseeks-zellij` | deprecated | Compatibility alias; use `/anatomy-park` or `/szechuan-sauce` |

### PRD, Graph, And Migration

| Command | Status | Description |
|---|---|---|
| `/pickle-dot [path]` | implemented | Convert PRD text to an attractor-compatible DOT digraph |
| `/pickle-dot-patterns` | implemented | Inspect DOT builder patterns |
| `/attract [file.dot]` | implemented | Submit a `.dot` pipeline to the attractor server |
| `/portal-gun <source>` | implemented | Migration/transfusion inventory, scope confirmation, and migration PRD |
| `/portal-fluid` | preview/report-plan | Prepare a GitNexus dependency graph artifact |
| `/death-crystal` | preview/report-plan | Prepare a GitNexus impact-analysis artifact for a symbol |
| `/operation-phoenix` | preview/report-plan | Prepare a GitNexus clone-analysis artifact skeleton |
| `/blips-and-chitz` | preview/report-plan | Prepare a GitNexus coverage-analysis artifact skeleton |

### Runtime, Environment, And Safety

| Command | Status | Description |
|---|---|---|
| `/interdimensional-cable` | implemented | Parse and supervise service log streams |
| `/glorzo` | preview/report-plan | Prepare a focused runtime observability view |
| `/galactic-federation` | skeleton-only | Return a runtime observability audit skeleton; no runtime mutation is started |
| `/ghost-in-a-jar` | skeleton-only | Return the persistence contract; no persistence layer is created or changed |
| `/ricks-garage` | preview/report-plan | Prepare a deterministic local dev bootstrap environment plan |
| `/microverse-battery` | preview/report-plan | Validate nested-container devstack plans without starting containers by default |
| `/phoenix-person` | skeleton-only | Return the deploy rollback contract; no deploy or rollback is started |
| `/nimbus` | skeleton-only | Return the cloud provisioning contract; no cloud resource is created |
| `/interdimensional-customs` | preview/report-plan | Prepare a non-destructive downstream safety plan |
| `/evil-morty` | preview/report-plan | Prepare a non-destructive security review plan |
| `/fleeb-juice` | skeleton-only | Return the secret rotation contract; no secrets are rotated |
| `/wendys` | skeleton-only | Return the destructive rollback contract; no destructive rollback is run |
| `/froopyland` | skeleton-only | Return the sandbox safety contract; no sandbox/syscall action is run |
| `/scary-terry` | preview/report-plan | Prepare a non-destructive API fuzz plan |

### Performance, Frontend, And Workflow Probes

| Command | Status | Description |
|---|---|---|
| `/get-schwifty` | preview/report-plan | Prepare a benchmark and load-profile report plan |
| `/tiny-rick` | preview/report-plan | Prepare a build optimization report plan |
| `/time-crystal` | preview/report-plan | Prepare a bundle and build timing report plan |
| `/rickmobile` | preview/report-plan | Prepare a responsive frontend audit matrix |
| `/ants-in-my-eyes-johnson` | preview/report-plan | Prepare an accessibility audit report plan |
| `/vindicators` | implemented | Run fixture-driven multi-agent solver and judge workflow selection |
| `/story-train` | implemented | Run a workflow routing probe with staged story output |
| `/two-brothers` | implemented | Run a two-solver workflow routing probe |
| `/wubba-lubba-dub-dub` | implemented | Run delivery analytics workflow probe |

### Refactor, Scaffold, Batch, And Admin

| Command | Status | Description |
|---|---|---|
| `/pickle-microverse` † | implemented | Metric convergence loop. `--metric` for numeric, `--goal` for LLM judge |
| `/add-to-pickle-jar` | implemented | Queue a PRD/session for Night Shift |
| `/pickle-jar-open` | implemented | Run queued jar tasks sequentially |
| `/disable-pickle` | implemented | Disable Pickle Rick hooks globally |
| `/enable-pickle` | implemented | Re-enable Pickle Rick hooks |
| `/butter-robot` | preview/report-plan | Prepare a minimal daemon scaffold preview plan |
| `/gazorpazorp` | preview/report-plan | Prepare a non-destructive monorepo scaffold plan |
| `/ricks-flask` | preview/report-plan | Prepare schema-driven mock data seed previews |
| `/morty-smith-database` | preview/report-plan | Prepare schema migration plan artifacts without applying migrations |
| `/snake-jazz` | preview/report-plan | Prepare bounded retry plan artifacts without starting processes |
| `/unity` | preview/report-plan | Prepare a package scaffold preview plan without writing package files |
| `/project-mayhem` | implemented | Run chaos engineering workflow |
| `/detoxifier` | preview/report-plan | Preview cleanup-oriented refactor suggestions |
| `/doofus-rick` | preview/report-plan | Preview explainer-oriented code understanding notes |
| `/jerry-detector` | preview/report-plan | Preview technical debt findings and remediation ideas |
| `/memory-parasites` | preview/report-plan | Preview dead-code and stale-code findings |
| `/simple-rick` | preview/report-plan | Preview simplicity-focused refactor suggestions |
| `/squanch` | preview/report-plan | Preview regex search/replace changes with rollback artifacts |
| `/mr-poopybutthole` | implemented | Summarize companion runtime session state |

### Internal Worker Prompts

| Command | Status | Description |
|---|---|---|
| `/send-to-morty` | internal | Internal implementation worker prompt, auto-sent by managers |
| `/send-to-morty-review` | internal | Internal review worker prompt, auto-sent by managers |

† accepts `--backend <claude\|codex>` to swap the worker/manager spawn backend (or set `PICKLE_BACKEND=codex`). `/council-of-ricks` has a separate Codex integration (Phase C adversarial reviewer, `--no-codex` / `--codex-timeout`). `/pickle` additionally accepts `--teams` (claude only) to spawn workers via harness team primitives — see [Agent Teams](README.md#agent-teams).

Operator handoff: token accounting writes a token accounting JSON artifact and markdown summary under the session `memory/` directory when runtime finalization runs. Jerry Mode pause decisions use `pause_for_human`, set `human_help_recovery_command`, and point operators at `/pickle-retry <ticket-id>` when a ticket id is available. See [Runtime Settings And Operator Handoff](README.md#runtime-settings-and-operator-handoff).

## Flags

Most flags are command-scoped. The table groups them by command family — flags with no command prefix apply across `/pickle`, `/pickle-tmux`, `/pickle-zellij`, `/pickle-jar-open`, and `/pickle-pipeline` unless noted.

| Flag | Command | Description |
|---|---|---|
| `--max-iterations <N>` | General | Stop after N iterations (default: 500; 0 = unlimited) |
| `--max-time <M>` | General | Stop after M minutes (default: 720 / 12 hours; 0 = unlimited) |
| `--worker-timeout <S>` | General | Timeout for individual workers in seconds (default: 1200) |
| `--completion-promise "TXT"` | General | Only stop when the agent outputs `<promise>TXT</promise>` |
| `--resume [PATH]` | General | Resume from an existing session |
| `--reset` | General | Reset iteration counter and start time (use with `--resume`) |
| `--paused` | General | Start in paused mode (PRD only) |
| `--backend <claude\|codex>` | `/pickle`, `/pickle-tmux`, `/pickle-microverse`, `/anatomy-park`, `/szechuan-sauce`, `/pickle-pipeline` | Route worker/manager spawns through `codex exec` instead of `claude`. Persisted in `state.json`. Env var alternative: `PICKLE_BACKEND=codex`. Precedence: CLI flag > env var > session state > default `claude` |
| `--teams` | `/pickle` | Phase 3 spawns workers via harness team primitives (`TeamCreate` + `Agent` + `TaskUpdate`) instead of `spawn-morty.js` subprocesses. Persisted in `state.json`. Claude backend only — incompatible with `--backend codex`. Spec: [`prds/pickle-agent-teams.md`](prds/pickle-agent-teams.md) |
| `--max-parallel <N>` | `/pickle` (with `--teams`) | Concurrency cap for parallel `morty-implementer` teammates (default: 5). v1 ships sequential; this is plumbed for the parallel-fan-out follow-up. Requires `--teams`. Must be a positive integer |
| `--run` | `/pickle-refine-prd`, `/portal-gun` | Auto-launch tmux |
| `--interactive` | `/pickle-microverse` | Run inline instead of tmux |
| `--metric "<CMD>"` | `/pickle-microverse` | Shell command outputting a numeric score |
| `--goal "<TEXT>"` | `/pickle-microverse` | Natural language goal for LLM judge |
| `--direction <higher\|lower>` | `/pickle-microverse` | Optimization direction (default: higher) |
| `--judge-model <MODEL>` | `/pickle-microverse` | Judge model for LLM scoring |
| `--tolerance <N>` | `/pickle-microverse` | Score delta for "held" status (default: 0) |
| `--stall-limit <N>` | `/pickle-microverse` | Non-improving iterations before convergence (default: 5) |
| `--legacy` | `/pickle-dot` | Prompt-only fallback — skips builder codegen for this run |
| `--provider <name>` | `/pickle-dot` | LLM provider: anthropic, openai, qwen, gemini, deepseek, ollama, vllm |
| `--review-provider <name>` | `/pickle-dot` | Separate provider for review/critical nodes |
| `--isolated` | `/pickle-dot` | Isolated workspace mode |
| `--target <PATH>` | `/portal-gun` | Target repo (default: cwd) |
| `--depth <shallow\|deep>` | `/portal-gun` | Extraction depth (default: deep) |
| `--no-refine` | `/portal-gun` | Skip automatic refinement |
| `--max-passes <N>` | `/portal-gun` | Max convergence passes (default: 3) |
| `--save-pattern <NAME>` | `/portal-gun` | Persist pattern to library |
| `--target <PATH>` | `/pickle-pipeline` | Target directory for review phases (default: cwd) |
| `--refine` | `/pickle-pipeline` | Force `/pickle-refine-prd` before pipeline (auto-inferred if request mentions refinement) |
| `--no-refine` | `/pickle-pipeline` | Suppress auto-inferred refinement |
| `--skip-anatomy` | `/pickle-pipeline` | Skip anatomy-park phase |
| `--skip-szechuan` | `/pickle-pipeline` | Skip szechuan-sauce phase |
| `--anatomy-max-iterations <N>` | `/pickle-pipeline` | Anatomy Park iteration limit (default: 100) |
| `--anatomy-stall-limit <N>` | `/pickle-pipeline` | Anatomy Park stall limit (default: 3) |
| `--szechuan-max-iterations <N>` | `/pickle-pipeline` | Szechuan Sauce iteration limit (default: 50) |
| `--szechuan-stall-limit <N>` | `/pickle-pipeline` | Szechuan Sauce stall limit (default: 5) |
| `--szechuan-domain <name>` | `/pickle-pipeline` | Domain-specific principles for Szechuan phase |
| `--szechuan-focus "<text>"` | `/pickle-pipeline` | Focus directive for Szechuan phase |
| `--prd <path>` | `/citadel` | PRD to audit against. Required unless pipeline session state provides `state.prd_path` |
| `--diff <base..head>` | `/citadel` | Diff range to audit. Defaults to `state.start_commit..HEAD` when available |
| `--strict` | `/citadel` | Exit non-zero on High findings as well as Critical findings |
| `--report <path>` | `/citadel` | JSON report destination. Pipeline invocations write `<session>/citadel_report.json` |
| `--print-stubs` | `/citadel` | Print `node:test` skeletons for unguarded trap doors without modifying files |
| `--dry-run` | `/szechuan-sauce`, `/plumbus` | Catalog violations without fixing |
| `--focus "<text>"` | `/szechuan-sauce`, `/plumbus` | Direct review toward specific concern |
| `--domain <name>` | `/szechuan-sauce` | Domain-specific principles (e.g., financial) |
| `--no-validator` | `/plumbus` | Disable attractor validator gate (pattern-only review) |
| `--repo <PATH>` | `/council-of-ricks` | Target repo (default: cwd) |
| `--min-iterations <N>` | `/council-of-ricks` | Minimum review rounds before convergence (overrides size-tier scaling) |
| `--max-iterations <N>` | `/council-of-ricks` | Maximum review rounds before forced stop (overrides scaled headroom) |
| `--gitnexus` | `/council-of-ricks` | Enable GitNexus-backed code intelligence during review |
| `--effort <low\|medium\|high>` | `/pickle`, `/pickle-tmux`, `/pickle-microverse`, `/szechuan-sauce`, `/anatomy-park` | Codex reasoning effort (`-c reasoning.effort=<level>`); claude no-op |
| `--no-codex` | `/council-of-ricks` | Disable the Codex adversarial reviewer |
| `--codex-timeout <S>` | `/council-of-ricks` | Timeout for Codex adversarial reviewer (seconds) |
| `--no-publish` | `/council-of-ricks` | Skip auto-publishing PR comments at session end |
| `--dry-run` | `/cronenberg` | Print the chosen plan and stop (default: execute) |
| `--no-followups` | `/cronenberg` | Skip the cleanup chain regardless of signals |
| `--no-refine` | `/cronenberg` | Force-skip the refinement pre-pass even when signals say it should run |
| `--refine` | `/cronenberg` | Force-include the refinement pre-pass even when signals would skip it |

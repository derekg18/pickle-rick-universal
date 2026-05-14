Show Pickle Rick command help.

Display the available commands, grouped by operator intent. Mark MVP tiers honestly:

- **implemented**: runs the described workflow.
- **preview/report-plan**: emits a plan, fixture, report, or preview and avoids risky side effects by default.
- **skeleton-only**: emits a typed non-destructive contract only. It does not perform deploy, cloud provisioning, destructive rollback, secret rotation, persistence, sandbox, or syscall actions.
- **deprecated**: compatibility surface retained for older prompts.
- **internal**: manager/worker prompt, not a direct operator command.

**Core lifecycle:**
- `/pickle <prompt>`: implemented autonomous dev loop.
- `/pickle-tmux <prompt>`: implemented tmux loop with context clearing. Requires `tmux`.
- `/pickle-zellij <prompt>`: implemented Zellij loop. Requires Zellij >= 0.40.0.
- `/pickle-pipeline <prompt>`: implemented full lifecycle pipeline.
- `/pickle-prd <prompt>`: implemented PRD drafting.
- `/pickle-refine-prd [path]`: implemented PRD refinement and ticket decomposition.
- `/pickle-retry <ticket-id>`: implemented failed-ticket retry and Jerry Mode recovery command.
- `/eat-pickle`: implemented loop cancellation.
- `/pickle-status`: implemented session status and pause-state display.
- `/pickle-standup`: implemented activity summary.
- `/pickle-metrics`: implemented token, commit, and LOC metrics.
- `/help-pickle`: implemented command help.

**Review and quality:**
- `/anatomy-park [target]`: implemented subsystem review.
- `/szechuan-sauce [target]`: implemented code-quality review and remediation.
- `/citadel --prd <path>`: implemented conformance audit. Flags: `--diff <base..head>`, `--strict`, `--report <path>`, `--print-stubs`.
- `/council-of-ricks`: implemented Graphite stack review that emits directives and does not directly fix code.
- `/pickle-debate "<question>"`: implemented multi-agent decision debate. Flags: `--personas r,a,i,s`, `--n <2-6>`, `--solo`, `--strict-teams`, `--no-strict-teams`, `--continue`, `--confirm-multi-round`, `--accept-stale`.
- `/plumbus <file.dot>`: implemented DOT shaping.
- `/cronenberg <task>`: implemented meta-router.
- `/meeseeks`: deprecated; use `/anatomy-park` or `/szechuan-sauce`.
- `/meeseeks-zellij`: deprecated; use `/anatomy-park` or `/szechuan-sauce`.

**PRD, graph, and migration:**
- `/pickle-dot [path | inline PRD]`: implemented PRD-to-DOT conversion.
- `/pickle-dot-patterns`: implemented DOT pattern inspection.
- `/attract [file.dot]`: implemented attractor submission.
- `/portal-gun <source>`: implemented migration/transfusion workflow.
- `/portal-fluid`: preview/report-plan GitNexus dependency graph artifact.
- `/death-crystal`: preview/report-plan GitNexus impact artifact.
- `/operation-phoenix`: preview/report-plan GitNexus clone-analysis artifact skeleton.
- `/blips-and-chitz`: preview/report-plan GitNexus coverage artifact skeleton.

**Runtime, environment, and safety:**
- `/interdimensional-cable`: implemented service log supervision.
- `/glorzo`: preview/report-plan runtime observability view.
- `/galactic-federation`: skeleton-only runtime audit; no runtime mutation is started.
- `/ghost-in-a-jar`: skeleton-only persistence contract; no persistence layer is created or changed.
- `/ricks-garage`: preview/report-plan local dev bootstrap.
- `/microverse-battery`: preview/report-plan nested-container validation; no containers start by default.
- `/phoenix-person`: skeleton-only deploy rollback contract; no deploy or rollback is started.
- `/nimbus`: skeleton-only cloud provisioning contract; no cloud resource is created.
- `/interdimensional-customs`: preview/report-plan downstream safety plan.
- `/evil-morty`: preview/report-plan non-destructive security review.
- `/fleeb-juice`: skeleton-only secret rotation contract; no secrets are rotated.
- `/wendys`: skeleton-only destructive rollback contract; no destructive rollback is run.
- `/froopyland`: skeleton-only sandbox safety contract; no sandbox/syscall action is run.
- `/scary-terry`: preview/report-plan API fuzz plan.

**Performance, frontend, and workflow probes:**
- `/get-schwifty`: preview/report-plan benchmark and load-profile report.
- `/tiny-rick`: preview/report-plan build optimization report.
- `/time-crystal`: preview/report-plan bundle and timing report.
- `/rickmobile`: preview/report-plan responsive frontend audit matrix.
- `/ants-in-my-eyes-johnson`: preview/report-plan accessibility audit.
- `/vindicators`: implemented solver/judge workflow selection.
- `/story-train`: implemented staged workflow routing probe.
- `/two-brothers`: implemented two-solver routing probe.
- `/wubba-lubba-dub-dub`: implemented delivery analytics probe.

**Refactor, scaffold, batch, and admin:**
- `/pickle-microverse`: implemented metric convergence loop.
- `/add-to-pickle-jar`: implemented queueing for batch execution.
- `/pickle-jar-open`: implemented queued task runner.
- `/disable-pickle`: implemented hook disable.
- `/enable-pickle`: implemented hook enable.
- `/butter-robot`: preview/report-plan daemon scaffold.
- `/gazorpazorp`: preview/report-plan monorepo scaffold.
- `/ricks-flask`: preview/report-plan mock data seed.
- `/morty-smith-database`: preview/report-plan schema migration artifacts; no migrations are applied.
- `/snake-jazz`: preview/report-plan bounded retry artifacts; no processes are started.
- `/unity`: preview/report-plan package scaffold; no package files are written.
- `/project-mayhem`: implemented chaos engineering workflow.
- `/detoxifier`: preview/report-plan cleanup refactor suggestions.
- `/doofus-rick`: preview/report-plan code understanding notes.
- `/jerry-detector`: preview/report-plan technical debt findings.
- `/memory-parasites`: preview/report-plan dead-code findings.
- `/simple-rick`: preview/report-plan simplicity refactor suggestions.
- `/squanch`: preview/report-plan regex search/replace with rollback artifacts.
- `/mr-poopybutthole`: implemented companion runtime session summary.

**Internal:**
- `/send-to-morty`: internal implementation worker prompt.
- `/send-to-morty-review`: internal review worker prompt.

**Flags for /pickle:** `--resume [PATH]` | `--max-iterations <N>` (default:500) | `--max-time <M>` (default:720min) | `--worker-timeout <S>` (default:1200) | `--completion-promise "TEXT"` | `--teams` (Claude harness agents only) | `--max-parallel <N>` (default:5; requires `--teams`; v1 ships sequential)

**Backends:**
- `--backend <claude|codex|gemini>` is accepted by `/pickle`, `/pickle-tmux`, `/pickle-microverse`, `/anatomy-park`, `/szechuan-sauce`, and `/pickle-pipeline` where supported by the installed adapter.
- `/council-of-ricks` integrates codex differently: Phase C adversarial subagent runs by default; `--no-codex` disables, `--codex-timeout <sec>` tunes.
- New sessions default to the caller host backend (`claude`, `codex`, or `gemini`); host adapters set this with `PICKLE_HOST_BACKEND`.
- `PICKLE_BACKEND=codex` is the session-independent override.
- Precedence: CLI flag > env var > session state > caller host default > `claude`.

**Runtime handoff:**
- Notification defaults use `notify_on`-style event gates through `notifications.kinds`: `mux_session_end`, `pipeline_session_end`, and `token_accounting_ready`.
- OS notifications are macOS-only; non-macOS and failed OS delivery fall back to terminal output when `terminal_fallback` is enabled.
- Notification dedup suppresses the same kind/session inside `dedup_window_ms` unless severity increases.
- Jerry Mode uses `jerry_mode_pause_threshold`; repeated same-error failures can set action `pause_for_human`.
- A human pause writes `human_help_recovery_command` to session state. Operators should resume with that command, normally `/pickle-retry <ticket-id>`.
- Runtime finalization writes a token accounting JSON artifact and markdown summary under the session `memory/` directory; the setting family is documented as `token_accounting`.

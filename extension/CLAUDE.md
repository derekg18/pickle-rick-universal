# Pickle Rick Extension Guardrails

- `src/services/pickle-utils.ts` `restartDeadWatcherPanes` INVARIANT: monitor window recovery must respawn dead watcher panes without touching healthy panes. BREAKS: monitor window has stale watcher panes for the rest of the pipeline lifetime; user has to manually relaunch each watcher. ENFORCE: `restartDeadWatcherPanes: respawns dead pickle watcher panes 1, 2, and 3`; `restartDeadWatcherPanes: all watcher panes already running node is a no-op`; `restartDeadWatcherPanes: inactive session skips pane probing and respawn`.

## state.json Field Invariants

- INVARIANT: `active` is session liveness flag; owners set deliberately; recovery demotes dead owners. ENFORCE: extension/tests/state-field-invariants.test.js.
- INVARIANT: `working_dir` is canonical project directory; must come from recovered state before dispatch. ENFORCE: extension/tests/state-field-invariants.test.js.
- INVARIANT: `step` advances through lifecycle transitions understood by runners. ENFORCE: extension/tests/state-field-invariants.test.js.
- INVARIANT: `iteration` is current manager-loop counter; remains finite integer. ENFORCE: extension/tests/state-field-invariants.test.js.
- INVARIANT: `max_iterations` is positive integer budget for manager loops. ENFORCE: extension/tests/state-field-invariants.test.js.
- INVARIANT: `max_time_minutes` is positive integer wall-clock budget. ENFORCE: extension/tests/state-field-invariants.test.js.
- INVARIANT: `worker_timeout_seconds` is positive integer worker budget. ENFORCE: extension/tests/state-field-invariants.test.js.
- INVARIANT: `start_time_epoch` is numeric epoch used for elapsed-time gates. ENFORCE: extension/tests/state-field-invariants.test.js.
- INVARIANT: `completion_promise` is nullable evidence; never used as sole state authority. ENFORCE: extension/tests/state-field-invariants.test.js.
- INVARIANT: `original_prompt` preserves launch request for worker prompts/reports. ENFORCE: extension/tests/state-field-invariants.test.js.
- INVARIANT: `current_ticket` is nullable ticket pointer; changes via ticket lifecycle ops. ENFORCE: extension/tests/state-field-invariants.test.js.
- INVARIANT: `current_ticket_tier` stores the explicit active ticket complexity tier when frontmatter provides one. ENFORCE: extension/tests/state-field-invariants.test.js.
- INVARIANT: `current_ticket_budget` stores the positive iteration budget resolved from the active ticket tier. ENFORCE: extension/tests/state-field-invariants.test.js.
- INVARIANT: `history` is append-only lifecycle trace data. ENFORCE: extension/tests/state-field-invariants.test.js.
- INVARIANT: `started_at` is session start timestamp; parseable for recency ranking. ENFORCE: extension/tests/state-field-invariants.test.js.
- INVARIANT: `session_dir` is canonical session path written at setup. ENFORCE: extension/tests/state-field-invariants.test.js.
- INVARIANT: `tmux_mode` records if session controlled by tmux orchestration. ENFORCE: extension/tests/state-field-invariants.test.js.
- INVARIANT: `min_iterations` is optional non-negative lower bound for convergence. ENFORCE: extension/tests/state-field-invariants.test.js.
- INVARIANT: `command_template` is optional manager command replay template. ENFORCE: extension/tests/state-field-invariants.test.js.
- INVARIANT: `chain_meeseeks` is optional boolean follow-up review flag. ENFORCE: extension/tests/state-field-invariants.test.js.
- INVARIANT: `schema_version` matches current state schema after migration. ENFORCE: extension/tests/state-field-invariants.test.js.
- INVARIANT: `prd_path` is optional PRD path consumed by pipeline/citadel phases. ENFORCE: extension/tests/state-field-invariants.test.js.
- INVARIANT: `start_commit` is optional base commit consumed by diff-based phases. ENFORCE: extension/tests/state-field-invariants.test.js.
- INVARIANT: `pid` is owning process id when runner claims liveness. ENFORCE: extension/tests/state-field-invariants.test.js.
- INVARIANT: `consecutive_short_responses` counts degenerate manager replies; resets on substantive output. ENFORCE: extension/tests/state-field-invariants.test.js.
- INVARIANT: `phases_entered` is monotonically extending phase-refresh ledger. ENFORCE: extension/tests/state-field-invariants.test.js.
- INVARIANT: `activity` stores append-only per-session activity records. ENFORCE: extension/tests/state-field-invariants.test.js.
- INVARIANT: `backend` is worker implementation backend; falls back via documented precedence. ENFORCE: extension/tests/state-field-invariants.test.js.
- INVARIANT: `teams_mode` gates harness-team spawning; defaults off. ENFORCE: extension/tests/state-field-invariants.test.js.
- INVARIANT: `max_parallel` is optional positive worker concurrency cap. ENFORCE: extension/tests/state-field-invariants.test.js.
- INVARIANT: `false_epic_completed_count` tracks repeated false completion claims. ENFORCE: extension/tests/state-field-invariants.test.js.
- INVARIANT: `false_epic_completed_ticket` ties false completion counts to the ticket. ENFORCE: extension/tests/state-field-invariants.test.js.
- INVARIANT: `effort` is optional codex reasoning-effort value. ENFORCE: extension/tests/state-field-invariants.test.js.
- INVARIANT: `codex_manager_relaunch_count` is capped per state file. ENFORCE: extension/tests/state-field-invariants.test.js.
- INVARIANT: `archaeology` is nullable project-context metadata. ENFORCE: extension/tests/state-field-invariants.test.js.
- INVARIANT: `tickets_version` increments when course correction changes ticket state. ENFORCE: extension/tests/state-field-invariants.test.js.
- INVARIANT: `last_course_correction` stores nullable metadata for latest correction. ENFORCE: extension/tests/state-field-invariants.test.js.
- INVARIANT: `phase_personas_active` records whether phase persona files are installed for the active session. ENFORCE: extension/tests/state-field-invariants.test.js.
- INVARIANT: `flags` stores optional feature flags with typed known keys (`human_help_requested`, `human_help_reason`, `human_help_recovery_command`, `jerry_mode_signature`, `os_notifier_available`) and unknown-key preservation. ENFORCE: extension/tests/state-field-invariants.test.js.
- INVARIANT: `readiness` stores nullable readiness-cycle state read through StateManager recovery. ENFORCE: extension/tests/state-field-invariants.test.js.
- INVARIANT: `codex_version_seen` records the codex CLI version observed during setup, when available. ENFORCE: extension/tests/state-field-invariants.test.js.
- INVARIANT: `last_tool_error_retry_count` tracks bounded retries for repeated tool-use errors. ENFORCE: extension/tests/state-field-invariants.test.js.

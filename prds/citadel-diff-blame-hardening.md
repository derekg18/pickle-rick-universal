# Pickle Rick Pipeline Reliability and Usability PRD

| Pickle Rick Pipeline Reliability and Usability PRD | | Make Pickle Rick more reliable, understandable, recoverable, and user-controllable while preserving the Citadel generated-lockfile hardening foundation. |
|:---|:---|:---|
| **Author**: Codex via Pickle Rick **Contributors**: Derek Greene | **Status**: Refined Draft **Created**: 2026-05-07 | **Visibility**: Internal |

## Completion Checklist
- [x] Introduction
- [x] Problem
- [x] Scope
- [x] CUJs
- [x] Requirements
- [x] User-Facing Features
- [x] Contracts
- [x] Verification
- [x] Tests
- [x] Assumptions
- [x] Risks
- [x] Impact
- [x] Stakeholders
- [x] Implementation Task Breakdown

## Introduction
Citadel's diff walker enriches changed files with line ranges and git blame data for downstream conformance audits. A large generated dependency file, especially a lockfile, can cause `git blame --line-porcelain` to produce enough output to fail the pipeline or consume excessive memory.

The first mitigation skipped some lockfiles and raised the shared `runCmd()` output buffer globally. Code review and Pickle refinement found that this is not durable: the skip list omits common lockfiles, empty `blame: []` is ambiguous, and global buffer expansion increases availability risk for unrelated runtime commands. *(refined: requirements, codebase, risk-scope)*

The same incident exposed a broader product gap: when the autonomous loop fails, pauses, skips data, or needs user input, the user has to infer too much from raw logs, tmux panes, and session files. This PRD expands the Citadel hardening work into a pipeline usability program that makes runs easier to start, monitor, repair, resume, and trust.

## Problem Statement
**Current Process**: `buildCitadelAuditReport()` calls `walkDiff()`, which calls `summarizeChangedFile()` for every changed file. `summarizeChangedFile()` gathers changed line ranges and blame summaries. `summarizeBlame()` shells out through `runGit()` and shared `runCmd()`. Pipeline setup, tmux monitoring, ticket orchestration, readiness checks, Citadel, Anatomy Park, Szechuan Sauce, installer checksums, and recovery flows each emit their own partial status.

**Users**: Pickle Rick pipeline users, Codex/Claude/Gemini adapters, maintainers reviewing Citadel reports, users resuming crashed runs, and workers relying on session artifacts such as `state.json`, `citadel_report.json`, `pipeline-runner.log`, and `linear_ticket_*.md`.

**Pain Points**:
- Large generated lockfiles can still hit the same failure if their basename is not in the skip set, including `bun.lock`, `bun.lockb`, `deno.lock`, and `uv.lock`.
- Empty `blame: []` currently means several different things: deleted file, generated-file skip, threshold skip, or actual no blame.
- Raising `maxBuffer` inside shared `runCmd()` increases memory exposure for unrelated `gh`, `git`, scope resolver, circuit breaker, and PR factory paths.
- The regression test only covers `package-lock.json`, so the skip-list contract can drift.
- Fatal errors often identify the failing command but do not consistently explain impact, retry safety, repair commands, or resume commands.
- Users need to know whether a run is planning, implementing, auditing, blocked, waiting for rate limits, recovering, or safe to resume without reading multiple logs.
- Session artifacts exist but are scattered; users do not have one index that links PRD, tickets, reports, logs, changed files, and verification output.
- Existing autonomy modes, approval expectations, and risk budgets are implicit, making it hard to choose review-only, plan-only, approval-gated, or fully autonomous runs.
- There is no single preflight/doctor experience that catches checksum drift, missing tools, tmux conflicts, dirty worktree risk, likely large generated-file issues, or backend availability before the run starts.
- The loop lacks a first-class failure replay command, decision log, checkpoint summary, notification hooks, and human-friendly final diff summary.

**Importance**: Citadel runs before later hardening phases. A failure here blocks the full pipeline on common dependency changes, while an overly broad fix can introduce availability risk across the runtime. More broadly, the autonomous loop can only be trusted if users can understand what happened, what is happening now, what is safe to do next, and what the system will or will not change.

## Objective & Scope
**Objective**: Make Citadel diff/blame collection resilient for generated lockfiles and very large changed files, and improve the overall Pickle Rick user experience with preflight checks, actionable recovery, clear status, smart resume, session summaries, risk controls, and durable run artifacts.

**Ideal Outcome**: A user can run Pickle Rick on a real project, see issues before launch, understand each phase in plain language, recover from failures with exact commands, resume safely after interruption, inspect one session index for all outputs, and trust that generated files or high-risk edits are handled by explicit policy.

### In-scope / Goals
- Add `extension/src/services/citadel/generated-lockfiles.ts` exporting:
  - `GENERATED_LOCKFILE_BASENAMES: ReadonlySet<string>`
  - `isGeneratedLockfile(filePath: string): boolean`
- Include at minimum: `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`, `bun.lockb`, `deno.lock`, `uv.lock`, `poetry.lock`, `Pipfile.lock`, `Cargo.lock`, `go.sum`, `Gemfile.lock`, `composer.lock`.
- Match generated lockfiles by exact basename, case-sensitive. Nested paths such as `frontend/bun.lock` match by basename. Symlink target inspection is not required. *(refined: requirements, risk-scope)*
- Preserve `changedLines` for skipped text files. For binary generated lockfiles such as `bun.lockb`, `changedLines` may be `[]`; the skip reason remains required. *(refined: requirements)*
- Add `blameSkippedReason?: BlameSkippedReason` as the canonical per-file field. No alternative field shape is permitted. *(refined: requirements, risk-scope)*
- Add `LARGE_CHANGE_BLAME_THRESHOLD = 5000` changed lines, computed as the sum of `(end - start + 1)` across `changedLines` for a file. Files above this threshold skip blame before shelling out. *(refined: requirements, codebase, risk-scope)*
- Apply skip precedence in this exact order: `deleted` > `generated-lockfile` > `large-change-threshold`. *(refined: requirements)*
- Remove the global `runCmd()` `maxBuffer: 64 * 1024 * 1024` increase. The blame path should avoid the overflow by skip-before-shell-out for lockfiles and threshold cases. No localized buffer override is added in this PRD. *(refined: risk-scope)*
- Add `DiffSummary.skipCounts: Record<BlameSkippedReason, number>` and echo it in `citadel_report.json` under `sections.diff.skipCounts` or an equivalent existing diff section created by the implementation. *(refined: codebase)*
- Add user-readable skip summaries in Citadel report markdown and pipeline/status surfaces so users can see that blame was intentionally skipped without inspecting raw JSON.
- Add a preflight/doctor check that reports source/runtime checksum health, required CLIs, git worktree state, backend/model availability where detectable, tmux/session conflicts, and likely large generated-file risks before a run.
- Add actionable error cards for fatal pipeline/setup/runtime failures with `what_failed`, `why_it_matters`, `repair_command`, `retry_safe`, `resume_command`, and links to relevant session files.
- Add a pipeline health summary at the end of runs with phases completed, files changed, tests run, recovered failures, skipped work with reasons, and next recommended action.
- Add plain-English phase labels and blocked/waiting states for setup, PRD, breakdown, research, plan, implement, verify, review, refactor, Citadel, Anatomy Park, Szechuan Sauce, rate-limit wait, checksum mismatch, and repair-needed states.
- Add smart resume discovery that identifies the latest matching session, shows completed/pending tickets, warns when tickets changed, and prints the exact resume command.
- Add user intent modes: review-only, plan-only, implement with approval gates, fully autonomous, and fix-only-failing-checks.
- Add PRD/ticket preview before implementation starts with ticket count, risk level, likely files touched, verification commands, estimated complexity, and explicit non-goals.
- Add generated-file policy configuration for project-defined generated files after the built-in lockfile policy lands.
- Add risk budgets and approval gates for high-risk GitNexus impact, shared helper edits, global config/dotfile changes, install runs, and dirty unrelated files.
- Add durable checkpoints after PRD creation, ticket generation, each ticket completion, tests passed, install refresh, and final summary.
- Add failure replay for the last failed command/phase when the command is deterministic and safe to rerun.
- Add decision logs capturing why major choices were made, including skip policies, threshold choices, deferrals, and high-risk approvals.
- Add optional notifications for completion, approval-needed, tests-failed, rate-limit-wait, and fatal-repair-needed events.
- Add a session artifact index linking PRD, refined PRD, tickets, reports, logs, test outputs, changed files, install manifest, and resume/replay commands.
- Add human-friendly final diff summary and confidence/risk labels for each ticket/run.
- Add one-command repair helpers for common local failures, including runtime checksum repair, stale/dead tmux sessions, latest-session resume, and failure explanation.
- Add focused unit/regression tests and affected Citadel pipeline smoke coverage.
- Regenerate compiled JS mirrors with `cd extension && npx tsc` before install.
- Refresh installed runtime and checksums with `bash install.sh` only after source verification passes.

### Not-in-scope / Non-Goals
- Rewriting Citadel audit rules unrelated to diff collection.
- Changing pipeline phase ordering.
- Changing report severity behavior.
- Adding a `runGit()` opt-in `maxBuffer` parameter. If smoke tests reveal remaining non-skipped blame overflow, that is a follow-up PRD.
- Implementing asynchronous process execution for all runtime commands.
- Adding new package dependencies unless refinement proves an existing bundled tool cannot meet notification or dashboard requirements.
- Breaking existing user-facing command syntax. New commands and flags must be additive.
- Building a full web application dashboard if terminal/status/markdown surfaces satisfy the same acceptance criteria.
- Sending notifications by default. Notifications must be opt-in.
- Automatically applying repairs that modify user config, dotfiles, or installed runtime without an explicit command or approval gate.

## Product Requirements

### Critical User Journeys (CUJs)
1. **Large npm lockfile change does not crash Citadel**
   - Given a repo changes more than 5,000 lines in `package-lock.json`
   - When `walkDiff()` summarizes the diff
   - Then it returns changed line ranges, empty blame, `blameSkippedReason: "generated-lockfile"`, and does not execute `git blame`.

2. **Bun, Deno, uv, and other ecosystem lockfiles receive the same protection**
   - Given a repo changes `bun.lock`, `bun.lockb`, `deno.lock`, `uv.lock`, or another generated lockfile basename from `GENERATED_LOCKFILE_BASENAMES`
   - When `walkDiff()` summarizes the file
   - Then the file is skipped with `blameSkippedReason: "generated-lockfile"`.
   - For `bun.lockb`, `changedLines` may be empty because binary diffs do not have line ranges.

3. **Normal source file blame remains available**
   - Given a repo changes `src/service.ts`
   - When `walkDiff()` summarizes the diff
   - Then it reports author, commit, summary, and changed line numbers, and `blameSkippedReason` is absent.

4. **Very large non-lockfile changes fail soft**
   - Given a non-lockfile has more than 5,000 changed lines
   - When `walkDiff()` summarizes the diff
   - Then Citadel preserves changed ranges, skips blame before shelling out, and sets `blameSkippedReason: "large-change-threshold"`.

5. **Shared commands stay conservative**
   - Given `runCmd()` is called by non-blame runtime paths
   - When the command emits output larger than Node's default sync process buffer
   - Then the command does not silently benefit from a global 64 MiB override.

6. **Report consumers can distinguish skip causes**
   - Given a diff contains deleted files, generated lockfiles, and large non-lockfile changes
   - When Citadel writes `citadel_report.json`
   - Then each skipped file carries `blameSkippedReason` and the report exposes skip counts by reason.

7. **Users can understand why blame is missing**
   - Given Citadel intentionally skips blame for generated or very large files
   - When a user reads the pipeline log, monitor recent output, status output, or report markdown
   - Then they see a concise explanation such as `Blame skipped: generated-lockfile=2, large-change-threshold=1`, and the pipeline communicates that it continued safely.

8. **Users catch local setup problems before launch**
   - Given a user starts a Pickle Rick run
   - When preflight runs
   - Then it reports missing tools, checksum drift, session conflicts, dirty worktree risk, backend availability, and generated-file risk before implementation begins.

9. **Users can recover from fatal failures**
   - Given a pipeline phase fails
   - When the fatal error is printed and persisted
   - Then the user sees an actionable error card with impact, repair command, retry safety, resume command, and relevant artifact links.

10. **Users can resume the right run**
   - Given tmux exits, the shell disconnects, or a process crashes
   - When the user asks to resume
   - Then the tool finds the latest matching session, shows completed and pending work, warns if tickets changed, and prints or executes the exact resume command.

11. **Users can choose autonomy**
   - Given a user wants different control levels for different projects
   - When they start a run
   - Then they can choose review-only, plan-only, approval-gated implementation, fully autonomous, or fix-only-failing-checks mode, and the session records that choice.

12. **Users can inspect one session dashboard/index**
   - Given a session has run at least one phase
   - When the user opens the session index or dashboard/status view
   - Then they see current phase, current ticket, elapsed time, recent decisions, test status, risk labels, artifacts, and resume/replay commands.

13. **Users can replay deterministic failures**
   - Given a test, typecheck, install, or Citadel command fails
   - When the user runs the replay command
   - Then the last deterministic failing command reruns from the correct working directory and records a new replay result.

14. **Users can see final work product clearly**
   - Given a run completes or stops
   - When the user reads the final health summary
   - Then they see phases completed, files changed, tests run, skipped work, failures recovered, risk/confidence labels, and the next recommended action.

### User-Facing Features
| Feature | User Value | Acceptance |
|:---|:---|:---|
| Citadel blame skip explanation | Users can distinguish deliberate policy skips from lost data. | `citadel_report.json.markdown` includes a short line when `skipCounts` contains non-zero counts. |
| Pipeline health summary | Users monitoring a run can see whether Citadel continued safely after skips. | `pipeline-runner` logs a concise Citadel skip summary after the report is written. |
| Status/monitor visibility | Users do not have to open raw JSON to understand skipped blame. | Status or monitor output surfaces the latest Citadel skip summary when a session has `citadel_report.json`. |
| Run preflight / doctor | Users catch local environment problems before losing time to a run that cannot complete. | A preflight report has stable machine-readable findings and human-readable repair guidance. |
| Plain-English phase status | Users understand what the loop is doing without decoding internal phase names. | Status/monitor output maps internal phases to concise labels and blocked/waiting reasons. |
| Actionable error cards | Users know what failed, why it matters, and how to recover. | Fatal failures persist a structured card with repair, retry, resume, and artifact fields. |
| Session dashboard/index | Users can inspect one place for PRD, tickets, reports, logs, tests, changed files, and commands. | Each session writes `session_index.md` or equivalent index with stable links after major checkpoints. |
| Smart resume | Users restart the correct session safely. | Resume discovery shows latest session, completed/pending tickets, ticket-version drift, and exact resume command. |
| User intent modes | Users choose review-only, plan-only, approval-gated, full autonomous, or fix-only-failing-checks behavior. | Setup records an intent mode in state and downstream phases enforce the allowed edit/run behavior. |
| PRD/ticket preview | Users see planned blast radius before implementation. | Ticket preview lists ticket count, likely files, risk, verification commands, estimated complexity, and non-goals. |
| Generated-file policy | Users can declare project-specific generated files beyond built-in lockfiles. | Configured generated-file patterns are included in skip/explain output and tested with deterministic fixtures. |
| Risk budget and approval gates | Users can prevent broad or surprising changes. | Runs pause before high-risk symbols, global config, installs, dotfiles, or dirty unrelated files unless approved. |
| Checkpointed runs | Users can understand and recover from partial progress. | Durable checkpoints are written after PRD, tickets, ticket completion, tests, install refresh, and final summary. |
| Failure replay | Users can rerun the last deterministic failure without digging through logs. | Replay executes the recorded command from its original working directory and stores replay output. |
| Decision log | Users can audit why the agent made important choices. | Session contains timestamped decision entries with reason, inputs, and affected files/scope. |
| Notifications | Users can step away without missing approvals or failures. | Optional notification hooks emit completion, approval-needed, test-failed, rate-limit, and fatal-repair-needed events. |
| Human-friendly diff summary | Users see what changed in product terms. | Final summary groups changes by purpose and links to files/tests without requiring raw `git diff`. |
| Confidence and risk labels | Users know which results deserve extra review. | Each ticket/run records confidence, risk level, and reason based on tests, GitNexus impact, and touched files. |
| One-command repair | Users can repair common local breakages quickly. | Repair commands exist for runtime checksum drift, dead sessions, latest resume, and failure explanation. |

### Functional Requirements
| Priority | Requirement | User Story | Verification |
|:---|:---|:---|:---|
| P0 | Generated lockfile detection covers npm, yarn, pnpm, bun, Deno, uv, Python, Ruby, Rust, Go, and PHP lockfiles. | As a pipeline user, I can change dependency lockfiles without Citadel crashing. | `cd extension && node --test tests/citadel-diff-walker.test.js` includes every basename in a table-driven assertion. |
| P0 | `summarizeChangedFile()` skips blame for deleted files, generated lockfiles, and files above `LARGE_CHANGE_BLAME_THRESHOLD`, preserving changed lines when available. | As a report consumer, I can still see where files changed even when blame is skipped. | `tests/citadel-diff-walker.test.js` asserts `changedLines`, `blame`, and `blameSkippedReason` for deleted files, text lockfiles, binary lockfiles, and threshold skips. |
| P0 | Normal source files still receive blame summaries. | As a Citadel rule author, I can rely on blame data for human-authored code. | Existing source-file blame test remains green and asserts `blameSkippedReason === undefined`. |
| P0 | Global `runCmd()` buffer expansion is removed. | As a runtime maintainer, I avoid expanding memory risk for unrelated shell commands. | `tests/pickle-utils.test.js` asserts a >1 MiB captured command fails by default or otherwise verifies no 64 MiB global `maxBuffer` remains in `runArgvCmd()`/`runShellCmd()`. |
| P1 | `ChangedFileSummary` exposes `blameSkippedReason?: "deleted" \| "generated-lockfile" \| "large-change-threshold"`. | As a downstream phase, I can distinguish no blame because of policy from no blame because git returned none. | `cd extension && npx tsc --noEmit` verifies type shape; JSON report test asserts serialized reason. |
| P1 | `DiffSummary` exposes `skipCounts: Record<BlameSkippedReason, number>`. | As a maintainer, I can tell how often and why blame was skipped. | Unit test asserts counts for a mixed diff; Citadel report test asserts the object is echoed in report sections. |
| P1 | Citadel report markdown, pipeline log, and a session status surface expose a concise blame skip summary when skip counts are non-zero. | As a pipeline user, I can tell that missing blame was intentional without opening raw JSON. | Report/status tests assert the readable summary text and existing monitor recent-output behavior can display the pipeline log line. |
| P1 | Preflight produces structured findings before a run starts. | As a user, I can fix environment/session problems before the loop begins. | `cd extension && node --test tests/preflight-doctor.test.js` asserts finding shape, severity, repair command, and pass/fail exit behavior. |
| P1 | Fatal failures persist actionable error cards. | As a user, I know what failed and whether retry/resume is safe. | Tests assert structured card fields for checksum mismatch, command failure, and missing session state scenarios. |
| P1 | Status/monitor surfaces use plain-English phase and blocked-state labels. | As a user, I can understand current progress at a glance. | Status/monitor tests assert labels for PRD, breakdown, implementation, Citadel, rate-limit wait, checksum mismatch, and inactive sessions. |
| P1 | Smart resume selects and explains the latest matching session. | As a user, I can recover from a crash without guessing a session path. | Resume tests assert latest-session selection, ticket completion summary, ticket-version drift warning, and exact resume command. |
| P1 | Session index and health summary are written at checkpoints and finalization. | As a user, I can inspect one artifact for current status and outputs. | Artifact tests assert `session_index.md` and final summary contain PRD, tickets, reports, logs, tests, changed files, resume command, and next action. |
| P1 | User intent mode is captured and enforced. | As a user, I can choose how autonomous the loop should be. | Setup/orchestration tests assert review-only and plan-only do not edit implementation files, approval-gated mode pauses on gated operations, and fully autonomous preserves existing behavior. |
| P2 | Project generated-file policy integrates with built-in lockfile policy. | As a user, I can teach Pickle Rick about project-specific generated outputs. | Config tests assert configured patterns affect skip/explain behavior without weakening built-in lockfile tests. |
| P2 | Risk budgets and approval gates are enforced for high-risk changes. | As a user, I can cap blast radius. | GitNexus/check-readiness tests assert HIGH/CRITICAL impacts, shared helper edits, installs, dotfiles, global config, and unrelated dirty files pause unless approved. |
| P2 | Failure replay reruns the last deterministic failure. | As a user, I can reproduce the failure quickly. | Replay tests assert recorded command, cwd, env subset, exit code, and replay artifact output. |
| P2 | Decision log records major automated choices. | As a user, I can audit why the loop behaved as it did. | Decision-log tests assert entries for skip policy, threshold use, repair choice, risk approval, and deferral. |
| P2 | Optional notifications emit lifecycle events. | As a user, I can step away and still know when attention is needed. | Notification tests assert disabled-by-default behavior and opt-in event payloads for completion, approval, test failure, rate limit, and fatal repair. |
| P2 | Final summaries include human-friendly diff, confidence, and risk labels. | As a user, I know what changed and what needs review. | Summary tests assert grouped changes, tests run, risk/confidence labels, and next recommended action. |
| P1 | Lockfile classification is parity-tested against the JS lockfile subset of `WORKSPACE_ROOT_CONTROL_FILES`. | As a maintainer, I do not update one lockfile list while forgetting another. | Test imports `GENERATED_LOCKFILE_BASENAMES` and asserts `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`, and `bun.lockb` are covered. |
| P1 | Source-file blame failures still surface as errors. | As a maintainer, I do not silently lose blame on source files. | Unit test or existing behavior check asserts a non-skipped file blame failure throws instead of setting a skip reason. |
| P2 | Documentation/comments explain generated-file blame policy. | As a future maintainer, I understand the policy without reintroducing the crash. | `rg -n "generated-lockfile|blameSkippedReason|large-change-threshold" extension/src extension/tests` finds clear naming and tests. |

## Interface Contracts

### API Contracts
| Endpoint/Function | Input | Output | Error | Contract Test |
|:---|:---|:---|:---|:---|
| `isGeneratedLockfile(filePath: string)` | Any relative or absolute file path | `true` only when `path.basename(filePath)` exactly matches `GENERATED_LOCKFILE_BASENAMES` | Never throws for normal strings | Table-driven lockfile classifier test |
| `walkDiff(range: string, options?: WalkDiffOptions)` | Git diff range and optional `{ repoRoot?: string }` | `DiffSummary` with `changedFiles`, `claudeFiles`, and `skipCounts` | Throws on invalid/empty range or non-skipped git failures | `tests/citadel-diff-walker.test.js` |
| `summarizeChangedFile(entry, range, repoRoot)` | `DiffEntry`, parsed range, repo root | `ChangedFileSummary` with preserved `changedLines`, `blame`, and optional `blameSkippedReason` | Does not call blame for deleted/generated/threshold-skipped files | Covered indirectly through `walkDiff()` tests |
| `runCmd(cmd, options?)` | `string \| string[]`, `{ cwd?, check?, capture? }` | Trimmed stdout string | Throws with command/error output on checked failures; no global 64 MiB buffer | `tests/pickle-utils.test.js` |
| `buildCitadelAuditReport(options)` | Existing Citadel audit options | Existing report plus diff skip-count metadata in `sections` and readable markdown summary when skip counts are non-zero | Existing behavior for audit failures | Citadel report smoke/unit test |
| `showStatus(cwd)` / live monitor session display | Existing session directory discovery | Existing session fields plus latest readable Citadel skip summary when `citadel_report.json` exists | Existing unreadable-state behavior | Status/monitor test or focused helper test |
| `runPreflight(options)` | `{ repoRoot: string; sessionDir?: string; intentMode?: UserIntentMode }` | `PreflightReport` with stable findings and recommended next actions | Never mutates repo/runtime; returns blocking findings instead of throwing for expected local issues | `tests/preflight-doctor.test.js` |
| `buildActionableErrorCard(error, context)` | Error plus phase/session/command context | `ActionableErrorCard` persisted as JSON and rendered as text | Falls back to `unknown` fields without hiding original error message | `tests/actionable-error-card.test.js` |
| `resolveSmartResume(options)` | `{ cwd: string; explicitSessionDir?: string }` | `SmartResumeResult` with selected session, completed/pending tickets, drift warnings, and resume command | Returns no-match result instead of throwing when no session exists | `tests/smart-resume.test.js` |
| `writeSessionIndex(sessionDir)` | Existing session directory | `session_index.md` path and indexed artifact list | Missing optional artifacts are listed as unavailable, not fatal | `tests/session-index.test.js` |
| `recordCheckpoint(sessionDir, checkpoint)` | Checkpoint event and session dir | Appends durable checkpoint entry and refreshes session index | Invalid checkpoint type fails fast | `tests/checkpoints.test.js` |
| `recordDecision(sessionDir, decision)` | Decision event and session dir | Appends durable decision log entry | Redacts command secrets and truncates long evidence | `tests/decision-log.test.js` |
| `replayLastFailure(sessionDir)` | Session with replayable failure record | `ReplayResult` with command, cwd, exit code, and output artifact paths | Refuses non-deterministic or unsafe commands | `tests/failure-replay.test.js` |
| `emitNotification(event, options)` | Notification lifecycle event and opt-in settings | No-op when disabled; structured notification payload when enabled | Notification failures do not fail the pipeline | `tests/notifications.test.js` |

### Type Contracts
```ts
export interface BlameCommitSummary {
  commit: string;
  author: string;
  summary: string;
  lines: number[];
}

export type BlameSkippedReason =
  | 'deleted'
  | 'generated-lockfile'
  | 'large-change-threshold';

export interface ChangedFileSummary {
  path: string;
  status: DiffEntry['status'];
  kind: ChangedFileKind;
  changedLines: ChangedLineRange[];
  blame: BlameCommitSummary[];
  blameSkippedReason?: BlameSkippedReason;
}

export interface DiffSummary {
  range: string;
  base: string;
  head: string;
  repoRoot: string;
  changedFiles: ChangedFileSummary[];
  claudeFiles: string[];
  skipCounts: Record<BlameSkippedReason, number>;
}

export type UserIntentMode =
  | 'review-only'
  | 'plan-only'
  | 'approval-gated'
  | 'fully-autonomous'
  | 'fix-failing-checks';

export type UsabilitySeverity = 'info' | 'warning' | 'blocking';

export interface PreflightFinding {
  id: string;
  severity: UsabilitySeverity;
  area: 'runtime' | 'tools' | 'git' | 'backend' | 'tmux' | 'session' | 'generated-files' | 'config';
  title: string;
  detail: string;
  repairCommand?: string;
  docsPath?: string;
}

export interface PreflightReport {
  ok: boolean;
  repoRoot: string;
  sessionDir?: string;
  intentMode: UserIntentMode;
  findings: PreflightFinding[];
  nextActions: string[];
}

export interface ActionableErrorCard {
  id: string;
  phase: string;
  whatFailed: string;
  whyItMatters: string;
  repairCommand?: string;
  retrySafe: boolean;
  resumeCommand?: string;
  artifactPaths: string[];
  originalError: string;
}

export interface SmartResumeResult {
  selectedSessionDir: string | null;
  completedTickets: string[];
  pendingTickets: string[];
  ticketVersionChanged: boolean;
  warnings: string[];
  resumeCommand: string | null;
}

export interface PipelineHealthSummary {
  phasesCompleted: string[];
  filesChanged: string[];
  testsRun: string[];
  failuresRecovered: string[];
  skippedWork: Array<{ reason: string; count: number }>;
  risk: 'low' | 'medium' | 'high';
  confidence: 'low' | 'medium' | 'high';
  nextAction: string;
}

export interface SessionCheckpoint {
  type: 'prd' | 'tickets' | 'ticket-complete' | 'tests-passed' | 'install-refresh' | 'final-summary';
  at: string;
  sessionDir: string;
  ticketId?: string;
  artifactPaths: string[];
}

export interface DecisionLogEntry {
  id: string;
  at: string;
  decision: string;
  reason: string;
  inputs: string[];
  affectedFiles: string[];
  risk?: 'low' | 'medium' | 'high';
}

export interface ReplayResult {
  replayed: boolean;
  refusedReason?: string;
  command?: string;
  cwd?: string;
  exitCode?: number;
  outputPath?: string;
}

export interface NotificationEvent {
  type: 'completed' | 'approval-needed' | 'tests-failed' | 'rate-limit-wait' | 'fatal-repair-needed';
  sessionDir: string;
  title: string;
  body: string;
  artifactPaths: string[];
}
```

`blameSkippedReason` is the canonical field. No alternative key is permitted. *(refined: requirements, risk-scope)*

### State Transitions
| From | Event | To | Side Effects | Invariants |
|:---|:---|:---|:---|:---|
| Changed file discovered | File status is `D` | Summary with empty `changedLines`, empty `blame`, `blameSkippedReason: "deleted"` | No git blame command executes | Deleted files never invoke `git blame`. |
| Changed file discovered | Basename matches generated lockfile set | Summary with changed lines when available, empty blame, `generated-lockfile` reason | No git blame command executes | Binary lockfiles may have `changedLines: []`. |
| Changed file discovered | Sum of changed line counts exceeds `LARGE_CHANGE_BLAME_THRESHOLD` | Summary with changed lines, empty blame, `large-change-threshold` reason | No git blame command executes | Threshold is named constant and covered by tests. |
| Changed source file discovered | File is not skipped | Summary with changed lines and blame summaries | Git blame executes with default bounded process behavior | Existing blame semantics preserved. |

Skip reason precedence is always `deleted` > `generated-lockfile` > `large-change-threshold`.

## Verification Strategy
Automated conformance only; subjective review is not sufficient.

- **Type**: TypeScript compilation passes.
- **Build/mirror**: `cd extension && npx tsc` regenerates `extension/services/**/*.js` mirrors before install.
- **Lint**: ESLint reports no new errors on touched source files or touched lines.
- **Test**: Focused unit tests and Citadel pipeline smoke tests pass.
- **Contract**: `ChangedFileSummary`, `DiffSummary`, and report metadata shapes match implementation.
- **LLM**: Agent reads `diff-walker`, `generated-lockfiles`, `pickle-utils`, `git-utils`, convergence-gate lockfile handling, and tests; answers PASS/FAIL for each requirement with cited code.

### Verification Commands
| Check | Command | Expected |
|:---|:---|:---|
| Typecheck | `cd extension && npx tsc --noEmit` | Exit 0 |
| Compile mirrors | `cd extension && npx tsc` | Exit 0 and compiled JS mirrors reflect TS changes |
| Focused tests | `cd extension && node --test tests/citadel-diff-walker.test.js tests/pickle-utils.test.js tests/git-utils.test.js` | Exit 0 |
| Citadel smoke | `cd extension && node --test tests/citadel-pipeline-regression-smoke.test.js tests/citadel-command-surface.test.js tests/citadel-diff-hygiene.test.js` | Exit 0 |
| User-facing summary | `cd extension && node --test tests/citadel-pipeline-regression-smoke.test.js tests/status.test.js tests/monitor.test.js` | Exit 0 if matching tests exist; otherwise add focused tests for touched status/monitor helpers |
| Preflight/doctor | `cd extension && node --test tests/preflight-doctor.test.js tests/setup.test.js` | Exit 0 |
| Error cards and smart resume | `cd extension && node --test tests/actionable-error-card.test.js tests/smart-resume.test.js tests/resolve-state.test.js` | Exit 0 |
| Session artifacts | `cd extension && node --test tests/session-index.test.js tests/checkpoints.test.js tests/decision-log.test.js` | Exit 0 |
| Intent/risk controls | `cd extension && node --test tests/intent-modes.test.js tests/risk-budget.test.js tests/config-protection.test.js` | Exit 0 |
| Replay/notifications/summary | `cd extension && node --test tests/failure-replay.test.js tests/notifications.test.js tests/pipeline-health-summary.test.js` | Exit 0 |
| Lint touched source | `cd extension && npx eslint src/services/citadel/diff-walker.ts src/services/citadel/generated-lockfiles.ts src/services/pickle-utils.ts src/services/git-utils.ts` | Exit 0 or no new errors attributable to touched lines |
| Diff hygiene | `git diff --check` | Exit 0 |
| GitNexus scope | `npx gitnexus detect-changes --scope all` | Output reviewed; no unexpected files or flows beyond Citadel diff walker, lockfile classifier, report plumbing, and command-runner rollback |
| Install integrity | `bash install.sh` | Runtime installs and manifest/checksums refresh successfully |

## Test Expectations

### Unit Tests
| Requirement | Test File | Description | Assertion |
|:---|:---|:---|:---|
| Lockfile skip set complete | `extension/tests/citadel-diff-walker.test.js` | Table-driven test over every generated lockfile basename | Each text lockfile keeps changed lines, has empty blame, and reason `generated-lockfile`; `bun.lockb` may have empty changed lines |
| Source blame preserved | `extension/tests/citadel-diff-walker.test.js` | Existing source file modification test | `blame.length === 1`, author is expected, skip reason absent |
| Deleted skip reason | `extension/tests/citadel-diff-walker.test.js` | Delete a file in test repo | `changedLines` empty, `blame` empty, reason `deleted` |
| Threshold skip | `extension/tests/citadel-diff-walker.test.js` | Modify non-lockfile with 5,001 changed lines | `blame` empty, reason `large-change-threshold`, no throw |
| Skip precedence | `extension/tests/citadel-diff-walker.test.js` | Lockfile above threshold | Reason remains `generated-lockfile` |
| Shared command buffer restored | `extension/tests/pickle-utils.test.js` | Captured command emits >1 MiB without explicit opt-in | Default fails or code inspection helper proves no 64 MiB override remains |
| Lockfile parity | `extension/tests/services/convergence-gate-resolution.test.js` or new focused test | Compare JS lockfile control entries against classifier | `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`, `bun.lockb` are all covered |
| Preflight finding shape | `extension/tests/preflight-doctor.test.js` | Simulate checksum drift, missing tool, dirty worktree, and tmux conflict | Findings have stable IDs, severities, repair commands, and blocking/non-blocking behavior |
| Error card rendering | `extension/tests/actionable-error-card.test.js` | Convert representative fatal errors to cards | Cards include impact, repair, retry safety, resume command, and artifact paths |
| Smart resume | `extension/tests/smart-resume.test.js` | Multiple sessions for one cwd | Latest matching session is selected and drift warnings are included |
| Intent modes | `extension/tests/intent-modes.test.js` | Run setup/orchestration in each mode with mocked edit operations | Disallowed operations pause or refuse according to mode |
| Risk budgets | `extension/tests/risk-budget.test.js` | Simulate HIGH GitNexus impact and shared-helper edits | Approval gate triggers before edits/install/global config writes |
| Session index | `extension/tests/session-index.test.js` | Session with PRD, tickets, reports, logs, tests, and changed files | Index links every artifact and includes resume/replay commands |
| Checkpoints | `extension/tests/checkpoints.test.js` | Record each checkpoint type | Durable log and session index update in order |
| Decision log | `extension/tests/decision-log.test.js` | Record skip policy, threshold, approval, and deferral decisions | Entries are timestamped, redacted, and linked to affected files |
| Failure replay | `extension/tests/failure-replay.test.js` | Record deterministic and unsafe failures | Deterministic command replays; unsafe command is refused |
| Notifications | `extension/tests/notifications.test.js` | Disabled and opt-in notification settings | Disabled is no-op; enabled emits expected payloads without failing pipeline on delivery errors |
| Final summary | `extension/tests/pipeline-health-summary.test.js` | Completed and failed-run scenarios | Summary includes phases, files, tests, skipped work, risk, confidence, and next action |

### Integration Tests
| CUJ | Test File | Scenario | Expected |
|:---|:---|:---|:---|
| Citadel pipeline survives generated lockfile churn | `extension/tests/citadel-pipeline-regression-smoke.test.js` or new fixture | Pipeline session changes large lockfile and source file | Citadel writes report and exits according to findings, not process failure |
| Report contains skip metadata | Existing or new Citadel report test | Build report with deleted, generated, and threshold-skipped files | JSON contains per-file `blameSkippedReason` and `skipCounts` |
| User-facing skip summary | Existing or new Citadel/status/monitor tests | Build report with non-zero skip counts and inspect markdown/log/status output | Human-readable summary includes non-zero reason counts and does not imply an error |
| Preflight blocks unsafe launch | New or existing setup/preflight test | Missing runtime/checksum drift and dirty worktree risk | Blocking findings prevent automatic implementation start |
| Approval-gated mode pauses risky work | Intent/risk integration test | HIGH GitNexus impact or install refresh is required | Session records approval-needed state instead of proceeding |
| Session index survives partial runs | Session artifact integration test | Crash after ticket completion or test failure | Index shows last checkpoint, replay command, pending ticket, and resume command |

### Edge Cases
| Condition | Behavior | Test |
|:---|:---|:---|
| Lockfile in subdirectory, e.g. `frontend/bun.lock` | Basename match skips blame | Table-driven lockfile test with nested path |
| Binary lockfile `bun.lockb` | Empty changed lines allowed; generated skip reason required | Binary fixture test or classifier unit test |
| Renamed source file status `R` | New source path receives normal blame unless skipped by threshold | Rename test extends existing rename coverage |
| Renamed generated lockfile status `R` | New path basename decides skip behavior | Rename test with lockfile new path |
| Case variant `Package-Lock.json` | Does not match generated set on case-sensitive CI | Classifier unit test |
| Git blame failure on normal source file | Error surfaces with useful message | Targeted test or existing behavior preserved |

## Assumptions
- Citadel does not need author-level blame on generated dependency lockfiles.
- `git blame --line-porcelain` output volume is the dominant failure mode; CPU/time risk is secondary and controlled by existing process timeout.
- The large-change threshold is 5,000 changed lines summed across changed ranges per file.
- Exact basename matching is sufficient and intentionally case-sensitive.
- Preserving changed line ranges is enough for downstream diff hygiene and report context.
- Tests import compiled JS mirrors, so implementation must run `cd extension && npx tsc` before final test/install verification.
- User-facing improvements should prefer existing terminal/status/markdown surfaces before adding new UI dependencies.
- Existing slash-command syntax remains backward compatible; new commands and flags are additive.
- Notification delivery is optional and disabled by default.
- Failure replay only reruns deterministic commands recorded with a working directory and without interactive prompts.

## Risks & Mitigations
| Risk | Impact | Mitigation | Verification |
|:---|:---|:---|:---|
| Skip list omits a common lockfile | Citadel can still fail on dependency churn | Shared classifier and table-driven tests | Lockfile test table |
| Skip reason breaks downstream JSON consumers | Consumers may not expect new field | Add optional field only; keep `blame` array unchanged | Existing Citadel tests stay green |
| Removing global buffer reintroduces command failures | Legitimate non-skipped command output may exceed default | Threshold and generated-file skips prevent known blame overflow; remaining overflow becomes follow-up | Focused command-runner tests and Citadel smoke |
| Threshold skips blame for a legitimate large source file | Reduced audit context | Use a high 5,000 changed-line threshold and expose reason in report | Threshold tests and report metadata |
| Classifier work adds overhead to every changed file | Slower large-diff summarization | O(1) basename set lookup and existing changed-line parsing reused | Smoke runtime remains acceptable |
| Installed adapter checksum mismatch returns | Runtime differs from source | Run `bash install.sh` only after source verification | Installer output and runtime grep |
| User-facing summary becomes noisy | Users may ignore repeated low-value status lines | Show the summary only when counts are non-zero and keep it to one concise line | Status/monitor/report tests |
| Usability scope becomes too broad for one implementation pass | Incomplete or inconsistent feature delivery | Refine into sequential tickets with a wiring pass and hardening passes; each feature has machine-checkable output | Pickle refinement tickets and verification matrix |
| Preflight blocks legitimate expert workflows | Friction for advanced users | Distinguish blocking findings from warnings; support explicit override only where safe | Preflight tests for blocking vs warning behavior |
| Repair commands modify user environment unexpectedly | User trust and local configuration risk | Repairs that modify runtime, dotfiles, global config, or installs require explicit command/approval | Config-protection and repair-command tests |
| Smart resume picks the wrong session | Work resumes in the wrong project/session | Match by cwd/session metadata, show selected session before execution, and warn on ticket drift | Smart-resume tests with multiple sessions |
| Replay reruns an unsafe command | Duplicate side effects or data loss | Replay refuses commands marked interactive, destructive, install-mutating, or missing cwd | Failure-replay refusal tests |
| Notifications leak sensitive content | Privacy risk | Redact env values, long command output, and file contents; send only titles/body/artifact paths | Notification payload tests |
| Risk budgets depend on stale GitNexus data | False confidence or unnecessary blocking | Detect stale GitNexus warnings and require `npx gitnexus analyze` before relying on impact | Risk-budget tests and GitNexus command checks |

## Tradeoffs
- Skipping generated-file blame sacrifices author attribution for files that are usually machine-generated. This is acceptable because lockfile diffs are rarely useful for author-level Citadel findings.
- A threshold fallback can hide blame on unusually large source changes. The threshold is intentionally high and visible through `blameSkippedReason`.
- Removing the global buffer increase may expose unrelated command-output failures that were temporarily masked by the draft patch. That is preferable to broad memory exposure.

## Future Feature Opportunities
- Add a full browser dashboard after the terminal/status/session-index experience proves the right data model.
- Add a bounded streaming blame collector for large human-authored files so future work can recover blame data without global buffer expansion.
- Add remote notification providers beyond local shell/webhook adapters if users adopt the opt-in notification contract.
- Add interactive approval prompts inside the monitor after file-based approval gates are stable.
- Add team-level analytics across many sessions, such as recurring failure types and average repair time.

## Business Impact
| Metric | Current | Target | Impact |
|:---|:---|:---|:---|
| Pipeline completion on large lockfile diffs | Can fail in Citadel/Pickle phases | No process-buffer failure for known lockfiles or >5,000 changed-line files | Higher reliability for first-project adoption |
| Runtime command blast radius | Shared command buffer increased globally in draft patch | Global buffer restored to conservative default | Lower memory/availability risk |
| Debuggability of skipped blame | Empty `blame` is ambiguous | Skip reason and aggregate counts exposed | Faster maintenance and safer downstream phase decisions |
| User comprehension during pipeline runs | Users must inspect raw JSON or infer from failures | Report/log/status surfaces explain intentional skips | Lower support/debug time during first-project adoption |
| Time lost to bad launches | Setup failures appear after the run begins | Preflight finds blocking issues before implementation starts | Fewer failed first iterations |
| Recovery confidence | Users manually hunt sessions/logs after crashes | Smart resume, session index, error cards, and replay commands guide recovery | Faster and safer restart after interruption |
| Trust in autonomy | Users cannot easily cap blast radius | Intent modes, risk budgets, approval gates, and decision logs make control explicit | Higher confidence running on larger repos |
| Review efficiency | Users inspect raw diffs/logs to understand output | Health summary, human-friendly diff summary, risk labels, and artifact index summarize the result | Faster final review |
| Regression coverage | One lockfile covered | All listed lockfile basenames, binary lockfile behavior, precedence, and threshold fallback covered | Lower chance of repeat incident |

## Stakeholders
| Name | Team | Role | Note |
|:---|:---|:---|:---|
| Derek Greene | Pickle Rick | Maintainer/user | Needs reliable first-project pipeline runs and clearer operational UX |
| Pickle Rick runtime maintainers | Engineering | Maintainers | Own Citadel, runtime install, and command helpers |
| Pipeline users | Engineering | Users | Need dependency churn not to block autonomous loop and need understandable recovery paths |
| Citadel consumers | Pipeline phases | Report readers | Need accurate changed-file context and machine-readable skip reasons |

## Implementation Task Breakdown
| Order | ID | Title | Priority | Entry | Exit | Files |
|:---|:---|:---|:---|:---|:---|:---|
| 10 | 2aa03911 | Add generated lockfile classifier and parity coverage | High | Draft patch has inline skip set | Shared classifier exists and table/parity tests cover all lockfiles | `extension/src/services/citadel/generated-lockfiles.ts`, `extension/src/services/convergence-gate.ts`, `extension/tests/citadel-diff-walker.test.js`, parity test |
| 20 | 40bf8c3a | Add Citadel blame skip reasons and threshold behavior | High | Classifier exists | `ChangedFileSummary` has canonical skip reasons and 5,000-line threshold behavior | `extension/src/services/citadel/diff-walker.ts`, compiled JS mirror, `extension/tests/citadel-diff-walker.test.js` |
| 30 | a7427aef | Restore conservative command buffer defaults | High | Skip-before-shell-out behavior exists | Global 64 MiB `runCmd()` buffer is removed and regression-covered | `extension/src/services/pickle-utils.ts`, compiled JS mirror, `extension/tests/pickle-utils.test.js` |
| 40 | 35053933 | Surface Citadel blame skip telemetry and summaries | Medium | Diff summary exposes per-file reasons | Report JSON, markdown, pipeline log, and status/monitor surfaces explain non-zero skip counts | `extension/src/services/citadel/diff-walker.ts`, `extension/src/services/citadel/audit-runner.ts`, `extension/src/services/citadel/reporter.ts`, `extension/src/bin/pipeline-runner.ts`, `extension/src/bin/status.ts`, `extension/src/bin/monitor.ts`, tests |
| 50 | 9a3e0e5d | Add run preflight and doctor findings | High | Existing setup/session helpers | Preflight reports runtime, tools, git, backend, tmux, session, generated-file risks | `extension/src/services/adapter-preflight.ts`, `extension/src/bin/setup.ts`, new preflight service/bin, tests |
| 60 | 38e7d022 | Add actionable error cards and repair guidance | High | Fatal failure points identified | Fatal failures persist structured cards and readable repair/resume output | setup/pipeline/error-card service, tests |
| 70 | 8102a87a | Add smart resume selection and explanation | High | Session metadata exists | Latest-session resume summary includes completed/pending tickets, drift warnings, and exact command | `extension/src/bin/setup.ts`, `extension/src/bin/get-session.ts`, `extension/src/services/pickle-utils.ts`, tests |
| 80 | 849df77d | Add deterministic failure replay | Medium | Error cards/checkpoints can record failures | Safe deterministic failures replay from original cwd and unsafe replays are refused | new replay service/bin, pipeline/test integration |
| 90 | bb626f75 | Add session index and checkpoints | High | Session artifacts exist | `session_index.md` and checkpoint log update after major lifecycle events | session artifact service, setup/pipeline/mux hooks, tests |
| 100 | b3989b18 | Add decision log and pipeline health summary | Medium | Checkpoints and reports exist | Decisions and final health summary capture phases, files, tests, skipped work, risk/confidence, next action | activity/decision/summary services, pipeline runner, tests |
| 110 | cfb7f420 | Add plain-English status, monitor, and dashboard labels | Medium | Status/monitor can read session artifacts | Status/monitor show phase labels, blocked states, current risk, recent decisions, and artifact index path | `extension/src/bin/status.ts`, `extension/src/bin/monitor.ts`, tests |
| 120 | cbce615b | Add user intent modes | High | Setup parses flags/state | Review-only, plan-only, approval-gated, fully-autonomous, and fix-failing-checks modes are recorded and enforced | `extension/src/bin/setup.ts`, orchestration/config protection, tests |
| 130 | ca74541a | Add risk budgets and approval gates | High | Intent modes and GitNexus checks exist | High-risk symbols, shared helpers, installs, dotfiles, global config, and dirty unrelated files pause unless approved | `extension/src/hooks/handlers/config-protection.ts`, readiness/risk services, tests |
| 140 | bb249389 | Add generated-file project policy | Medium | Built-in lockfile classifier exists | Project patterns affect generated-file explain/skip behavior without weakening built-in lockfile protection | generated-file policy service/config, diff tests |
| 150 | c2a493c6 | Add optional notifications | Low | Error cards/checkpoints/summary events exist | Disabled mode is no-op and opt-in payloads emit completion, approval, test-failed, rate-limit, and repair-needed events | notification service, pipeline runner, tests |
| 160 | 0e738782 | Add PRD/ticket preview and final diff summary | Medium | Ticket collection and git summaries exist | Preview shows ticket count/risk/files/tests/non-goals; final summary groups changes and risk/confidence labels | preview/summary services, status/pipeline tests |
| 170 | 96059f19 | Wire regression coverage, compiled mirrors, and install integrity | High | Implementation tickets complete | Focused tests, compile mirrors, GitNexus review, and install pass | Test files, compiled JS mirrors, install manifest/runtime |
| 180 | 481c501f | Harden: code quality review of reliability/usability work | High | Implementation/wiring tickets complete | Zero P0/P1 code-quality findings in modified files | Modified source/test files |
| 190 | 12d59c8e | Audit: data flow integrity for session UX artifacts | High | Code quality hardening complete | Preflight, errors, checkpoints, decisions, reports, and summaries agree | Modified source/test files |
| 200 | 512c49a5 | Harden: test quality review of reliability/usability coverage | High | Data flow audit complete | Every refined PRD AC maps to strong tests | Modified test files |
| 210 | 3d9d2fbc | Audit: cross-reference consistency for PRD/runtime docs | Medium | Test hardening complete | PRD, tests, runtime docs, and command references agree | PRD/docs plus modified source references |

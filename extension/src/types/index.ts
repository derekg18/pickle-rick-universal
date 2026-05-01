export interface State {
  active: boolean;
  working_dir: string;
  step: Step;
  iteration: number;
  max_iterations: number;
  max_time_minutes: number;
  worker_timeout_seconds: number;
  start_time_epoch: number;
  completion_promise: string | null;
  original_prompt: string;
  current_ticket: string | null;
  history: Array<{ step: Step; ticket?: string; timestamp: string }>;
  started_at: string;
  session_dir: string;
  tmux_mode?: boolean;
  min_iterations?: number;
  command_template?: string;
  chain_meeseeks?: boolean;
  schema_version?: number;
  prd_path?: string;
  start_commit?: string;
  pid?: number;
  /** Count of consecutive short manager responses (≤ DEGENERATE_MAX_LENGTH). Reset on substantive response. */
  consecutive_short_responses?: number;
  /** Pipeline phases that have invoked refreshScope. Monotonically extends; guards against duplicate refresh. */
  phases_entered?: string[];
  /** Per-session activity log entries (e.g. halt records). Append-only. */
  activity?: ActivityLogEntry[];
  /** Implementation backend for worker/manager spawns. Defaults to 'claude' when absent. */
  backend?: Backend;
  /** When true, /pickle Phase 3 spawns workers via harness team primitives (TeamCreate + Agent + TaskUpdate) instead of `claude -p` subprocesses. claude backend only. */
  teams_mode?: boolean;
  /** Concurrency cap for parallel `morty-implementer` teammates when teams_mode is true. Default 5. v1 ships sequential; this field is plumbed for the parallel-fan-out follow-up. */
  max_parallel?: number;
  /**
   * Count of consecutive false EPIC_COMPLETED emissions on the same `current_ticket`.
   * Reset to 0 whenever the manager genuinely advances to a new ticket OR succeeds.
   * When this exceeds FALSE_EPIC_THRESHOLD on the same ticket, mux-runner exits with
   * `MANAGER_PERSISTENT_HALLUCINATION` rather than continuing to retry.
   */
  false_epic_completed_count?: number;
  /** Ticket ID associated with the current `false_epic_completed_count`. Resets the counter when current_ticket diverges. */
  false_epic_completed_ticket?: string | null;
  /**
   * Reasoning effort for worker spawns. Currently honored only by the codex
   * backend (`-c reasoning.effort=<value>`); claude has no public flag and
   * silently ignores. When unset, workers inherit the CLI default.
   */
  effort?: 'low' | 'medium' | 'high';
  /**
   * Codex tmux_mode: count of times mux-runner has relaunched the codex
   * manager subprocess after a per-iteration error (e.g. 4h hang-guard
   * SIGTERM) while tickets remained Todo/In Progress. Capped at
   * `Defaults.CODEX_MANAGER_RELAUNCH_CAP`; once exceeded, mux-runner falls
   * back to the legacy exit-on-error behavior. Claude backend never sets
   * this — its iterations are per-ticket spawns.
   */
  codex_manager_relaunch_count?: number;
  archaeology?: ProjectContext | null;
  tickets_version?: number;
  last_course_correction?: CourseCorrectionRecord | null;
  phase_personas_active?: boolean;
  flags?: StateFlags;
  readiness?: ReadinessState;
  codex_version_seen?: string | null;
}

/**
 * Threshold for consecutive false EPIC_COMPLETED emissions on the same ticket
 * before mux-runner gives up and exits with MANAGER_PERSISTENT_HALLUCINATION.
 * Recovery is the default; this guards against a manager stuck in a permanent
 * hallucination loop.
 */
export const FALSE_EPIC_THRESHOLD = 3;

export type Backend = 'claude' | 'codex';

export const BACKENDS: readonly Backend[] = ['claude', 'codex'] as const;

export interface ProjectContext {
  project_context_path: string;
  last_run_iso: string;
  file_count: number;
  project_type: string;
}

export interface CourseCorrectionRecord {
  proposal_path: string;
  applied_iso: string;
  restart_ticket_id: string | null;
  before_count: number;
  after_count: number;
}

export interface StateFlags {
  strict_teams?: boolean;
  [key: string]: unknown;
}

export interface ReadinessCycleHistoryEntry {
  cycle: number;
  status: string;
  suggested_analyst: string | null;
  user_action: string | null;
  timestamp: string;
}

export interface ReadinessState {
  cycle_history: ReadinessCycleHistoryEntry[];
  [key: string]: unknown;
}

export interface PhasePersona {
  phase: string;
  subagent_type: string;
  model?: string;
  [key: string]: unknown;
}

export interface ChangeProposal {
  proposal_path: string;
  restart_ticket_id: string | null;
  before_count: number;
  after_count: number;
  [key: string]: unknown;
}

export interface DebateRound {
  round: number;
  participants: string[];
  result_path?: string;
  [key: string]: unknown;
}

export interface ActivityLogEntry {
  event: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// StateManager Types & Errors
// ---------------------------------------------------------------------------

export interface StateManagerOptions {
  maxLockRetries: number;
  baseLockDelayMs: number;
  lockJitter: boolean;
  staleLockTimeoutMs: number;
  schemaVersion: number;
}

export const STATE_MANAGER_DEFAULTS: StateManagerOptions = {
  maxLockRetries: 10,
  baseLockDelayMs: 100,
  lockJitter: true,
  staleLockTimeoutMs: 30_000,
  schemaVersion: 3,
};

/** Latest schema_version that this code knows how to write/read. Must match the latest migration target in state-manager.ts. */
export const LATEST_SCHEMA_VERSION = 3;

export type StateErrorCode = 'MISSING' | 'CORRUPT' | 'SCHEMA_MISMATCH' | 'SCHEMA_DEPLOY_DRIFT' | 'LOCK_FAILED' | 'WRITE_FAILED';

export class StateError extends Error {
  readonly code: StateErrorCode;
  constructor(code: StateErrorCode, message: string) {
    super(message);
    this.name = 'StateError';
    this.code = code;
  }
}

export class LockError extends StateError {
  kind?: 'LockError';
  key?: string;
  timeout_ms?: number;
  waited_ms?: number;
  constructor(message: string) {
    super('LOCK_FAILED', message);
    this.name = 'LockError';
  }
}

export class TransactionError extends StateError {
  readonly rollbackErrors: Error[];
  constructor(message: string, rollbackErrors: Error[] = []) {
    super('WRITE_FAILED', message);
    this.name = 'TransactionError';
    this.rollbackErrors = rollbackErrors;
  }
}

export class SchemaVersionMismatchError extends StateError {
  readonly statePath: string;
  readonly onDiskVersion: number;
  readonly cachedVersion: number;

  constructor(statePath: string, onDiskVersion: number, cachedVersion: number) {
    super(
      'SCHEMA_MISMATCH',
      `State file ${statePath} schema_version ${onDiskVersion} is newer than transaction snapshot schema_version ${cachedVersion}`,
    );
    this.name = 'SchemaVersionMismatchError';
    this.statePath = statePath;
    this.onDiskVersion = onDiskVersion;
    this.cachedVersion = cachedVersion;
  }
}

export interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  permission_mode?: string;
  hook_event_name?: string;
  stop_hook_active?: boolean;
  last_assistant_message?: string;
  /** @deprecated Claude Code uses last_assistant_message instead */
  prompt_response?: string;
}

// ---------------------------------------------------------------------------
// Default Configuration Values
// ---------------------------------------------------------------------------

export const Defaults = {
  WORKER_TIMEOUT_SECONDS: 1200,
  /** Absolute ceiling for a single iteration when per-iteration timeout is disabled (4h). */
  MAX_ITERATION_SECONDS: 14_400,
  MANAGER_MAX_TURNS: 50,
  RATE_LIMIT_POLL_MS: 10_000,
  /**
   * Maximum number of times mux-runner will relaunch the codex manager
   * subprocess after a per-iteration error while pending tickets remain.
   * Codex tmux_mode runs ONE long-lived manager that loops across many
   * tickets internally; the 4h `MAX_ITERATION_SECONDS` hang-guard SIGTERMs
   * that subprocess and resolves `{ completion: 'error', timedOut: true }`,
   * which the loop would otherwise treat as terminal. Past this cap, fall
   * back to the legacy exit-on-error so a genuinely broken backend cannot
   * loop forever.
   */
  CODEX_MANAGER_RELAUNCH_CAP: 10,
} as const;

// ---------------------------------------------------------------------------
// Lifecycle Steps
// ---------------------------------------------------------------------------

export const VALID_STEPS = ['prd', 'breakdown', 'research', 'plan', 'implement', 'refactor', 'review'] as const;
export type Step = typeof VALID_STEPS[number];

// ---------------------------------------------------------------------------
// Promise Tokens
// ---------------------------------------------------------------------------

export { PROMISE_TOKENS, type PromiseToken } from '../services/promise-tokens.js';

export const PromiseTokens = {
  EPIC_COMPLETED: 'EPIC_COMPLETED',
  TASK_COMPLETED: 'TASK_COMPLETED',
  WORKER_DONE: 'I AM DONE',
  PRD_COMPLETE: 'PRD_COMPLETE',
  TICKET_SELECTED: 'TICKET_SELECTED',
  ANALYSIS_DONE: 'ANALYSIS_DONE',
  EXISTENCE_IS_PAIN: 'EXISTENCE_IS_PAIN',
  THE_CITADEL_APPROVES: 'THE_CITADEL_APPROVES',
} as const;

/** Returns true if `text` contains `<promise>TOKEN</promise>`, tolerating whitespace inside tags. */
export function hasToken(text: string, token: string): boolean {
  if (!text || !token) return false;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<promise>\\s*${escaped}\\s*</promise>`).test(text);
}

/** Wraps `token` in promise XML tags. */
export function wrapToken(token: string): string {
  return `<promise>${token}</promise>`;
}

// ---------------------------------------------------------------------------
// Lifecycle Artifacts
// ---------------------------------------------------------------------------

export type WorkerRole = 'implementation' | 'review';

// Prefixes written by the Morty worker prompts (send-to-morty.md and
// send-to-morty-review.md). A ticket with at least one matching `.md` file in
// its directory is evidence the lifecycle actually ran.
export const ARTIFACT_PREFIXES: Record<WorkerRole, readonly string[]> = {
  implementation: ['research', 'plan', 'conformance', 'code_review'],
  review: ['review_scope', 'review_findings', 'spec_conformance'],
};

/**
 * True when `files` contains at least one lifecycle artifact for `role`.
 * Matches exact `${prefix}.md` (e.g. `review_scope.md`) or `${prefix}_*.md`
 * (e.g. `research_2026-04-18.md`, `plan_review.md`). Pure — caller does readdir.
 */
export function hasLifecycleArtifact(files: readonly string[], role: WorkerRole): boolean {
  const prefixes = ARTIFACT_PREFIXES[role];
  return files.some(f =>
    prefixes.some(p => f === `${p}.md` || f.startsWith(`${p}_`))
  );
}

// ---------------------------------------------------------------------------
// Activity Events
// ---------------------------------------------------------------------------

export const VALID_ACTIVITY_EVENTS = [
  'session_start', 'session_end', 'ticket_completed', 'epic_completed',
  'meeseeks_pass', 'commit', 'research', 'bug_fix', 'feature',
  'refactor', 'review', 'jar_start', 'jar_end',
  'circuit_open', 'circuit_recovery',
  'iteration_start', 'iteration_end',
  'rate_limit_wait', 'rate_limit_resume', 'rate_limit_exhausted',
  'multi_repo_warning',
  'meeseeks_model_select',
  'pending_tickets_on_completion',
  'manager_false_epic_completed',
  'manager_persistent_hallucination',
  'gate_baseline_captured',
  'gate_run_complete',
  'gate_skipped',
  'gate_unsafe_test_command_blocked',
  'gate_remediation_complete',
  'gate_remediation_aborted_unverified_production_change',
  'gate_autofix_reverted',
  'gate_workingdir_drift_detected',
  'gate_lock_acquired',
  'gate_lock_timeout',
  'gate_diff_scope_fallback',
  'gate_preexisting_tests_baselined',
  'iteration_left_regression',
  'gate_regression_threshold_warning',
  'gate_out_of_scope_failures_present',
  'commit_pending_probe_fired',
  'codex_manager_relaunch',
  'readiness_failed_post_correction',
  'archaeology_complete',
  'archaeology_skipped',
  'phase_personas_disabled_seen',
  'debate_solo_auto',
  'debate_user_declined_auto_promote',
  'debate_invalidated_by_correction',
  'debate_round_truncated',
  'session_reconstructed_epoch_reset',
  'cap_check_failed_schema_mismatch',
] as const;

export type ActivityEventType = typeof VALID_ACTIVITY_EVENTS[number];

export type IterationExitType = 'success' | 'error' | 'api_limit' | 'inactive' | 'timeout';

export interface RateLimitInfo {
  limited: boolean;
  sawEvents?: boolean;     // true if structured rate_limit_event lines were found (even if not rejected)
  resetsAt?: number;       // Unix epoch seconds from API
  rateLimitType?: string;  // 'five_hour' | 'seven_day' etc.
}

export type IterationExitResult =
  | { type: 'inactive' }
  | { type: 'error' }
  | { type: 'success' }
  | { type: 'api_limit'; rateLimitInfo?: RateLimitInfo }
  | { type: 'timeout'; exitCode: number | null; wallSeconds: number };

export interface IterationOutcome {
  completion: 'task_completed' | 'review_clean' | 'continue' | 'error' | 'inactive';
  timedOut: boolean;
  exitCode: number | null;
  wallSeconds: number;
}

export interface RateLimitAction {
  action: 'wait' | 'bail';
  waitMs: number;
  waitSource: 'api' | 'config';
  resetCounter: boolean;
  hasResetsAt: boolean;
}

export interface ActivityEvent {
  ts: string;
  event: ActivityEventType;
  source: 'pickle' | 'hook' | 'persona';
  session?: string;
  epic?: string;
  ticket?: string;
  title?: string;
  step?: string;
  mode?: string;
  pass?: number;
  commit_hash?: string;
  commit_message?: string;
  duration_min?: number;
  duration_ms?: number;
  error?: string;
  iteration?: number;
  exit_type?: IterationExitType;
  original_prompt?: string;
  model?: string;
  backend?: Backend;
  project_type?: string;
  bytes_out_utf8?: number;
  tokens_in_estimated?: number;
  tokens_out_estimated?: number;
  round?: number;
  expected_tickets_version?: number;
  actual_tickets_version?: number;
  bytes_dropped?: number;
  gate_payload?: Record<string, unknown>;
  // AC-LPB-05: emitted by setup.ts/pipeline-runner.ts on session reconstruction
  // (resume) so monitor/standup consumers can distinguish a fresh launch from a
  // resumed run and reason about wall-clock budgets correctly.
  original_epoch?: number;
  new_epoch?: number;
}

// ---------------------------------------------------------------------------
// Auto-Update Types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Session Map Types
// ---------------------------------------------------------------------------

/** A session map entry in current_sessions.json. Stores the session path and PID of the process that created it. */
export interface SessionMapEntry {
  sessionPath: string;
  pid: number;
}

export interface UpdateCheckCache {
  last_check_epoch: number;
  latest_version: string;
  current_version: string;
}

export interface ReleaseAsset {
  name: string;
  url: string;
}

export interface ReleaseInfo {
  tagName: string;
  assets: ReleaseAsset[];
}

export interface UpdateSettings {
  auto_update_enabled: boolean;
  update_check_interval_hours: number;
}

export type UpdateStatus = 'up-to-date' | 'update-available' | 'error';

export interface UpdateResult {
  status: UpdateStatus;
  currentVersion: string;
  latestVersion?: string;
  error?: string;
}

export interface UpgradeResult {
  success: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Microverse Types
// ---------------------------------------------------------------------------

export interface MicroverseMetric {
  description: string;
  validation: string;
  type: 'command' | 'llm' | 'none';
  timeout_seconds: number;
  tolerance: number;
  direction?: 'higher' | 'lower';
  judge_model?: string;
}

export type FailureClass = 'tool_failure' | 'approach_exhaustion' | 'regression' | 'metric_unstable' | 'no_progress';

export interface ClassifiedFailure {
  iteration: number;
  failure_class: FailureClass;
  description: string;
  timestamp: string;
}

export interface MicroverseHistoryEntry {
  iteration: number;
  metric_value: string;
  score: number;
  action: 'accept' | 'revert';
  description: string;
  pre_iteration_sha: string;
  timestamp: string;
  classification?: 'improved' | 'held' | 'regressed';
  failure_class?: FailureClass;
}

export interface MicroverseSessionState {
  status: 'gap_analysis' | 'iterating' | 'converged' | 'stopped';
  prd_path: string;
  key_metric: MicroverseMetric;
  convergence: {
    stall_limit: number;
    stall_counter: number;
    history: MicroverseHistoryEntry[];
  };
  gap_analysis_path: string;
  judge_context_path?: string;
  failed_approaches: string[];
  baseline_score: number;
  convergence_target?: number;
  convergence_mode?: 'metric' | 'worker';
  convergence_file?: string;
  allowed_paths?: string[];
  exit_reason?: string;
  stash_ref?: string;
  failure_history: ClassifiedFailure[];
  approach_exhaustion_fired: boolean;
  iteration_regressions?: number;
  gate_regression_threshold_warning_emitted?: boolean;
}

// ---------------------------------------------------------------------------
// Gate Types
// ---------------------------------------------------------------------------

export interface GateFailure {
  check: 'typecheck' | 'lint' | 'tests';
  file: string;
  line: number;
  ruleOrCode: string;
  message: string;
  severity: 'error' | 'warning';
  occurrence_index: number;
}

export type GateMode = 'baseline' | 'strict';

export interface GateResult {
  status: 'green' | 'red' | 'green-with-known-flake-warnings';
  failures: GateFailure[];
  baseline_used: boolean;
  allowed_paths_used: boolean;
  elapsed_ms: number;
  total_raw_failure_count: number;
  new_failures_vs_baseline: number;
}

export interface GateBaselineFile {
  schema_version: 1;
  captured_at: string;
  working_dir: string;
  project_type: 'pnpm' | 'npm' | 'yarn' | 'cargo' | 'go';
  checks: ('typecheck' | 'lint' | 'tests')[];
  failures: GateFailure[];
}

export interface RemediationResult {
  iso: string;
  failures_in: number;
  failures_out: number;
  auto_fixes_applied: number;
  hand_fixes_applied: number;
  aborted: boolean;
  abort_reason: string | null;
  production_coverage_test_path: string | null;
  elapsed_ms: number;
}

export interface CreateMicroverseOpts {
  prdPath: string;
  metric: MicroverseMetric;
  stallLimit: number;
  convergenceTarget?: number;
  convergenceMode?: 'metric' | 'worker';
  convergenceFile?: string;
  allowedPaths?: string[];
}

// ---------------------------------------------------------------------------
// DOT Builder Types
// ---------------------------------------------------------------------------

export {
  AttrType,
  AttrScope,
  AttrDef,
  ATTRACTOR_SCHEMA_FALLBACK,
  ALL_ATTRS,
  AttrValidation,
  lookupAttr,
  validateAttrType,
  validateAttrs,
} from './attractor-schema.fallback.js';

export type BuildErrorCode =
  | 'EMPTY_SLUG'
  | 'EMPTY_GOAL'
  | 'DUPLICATE_PHASE'
  | 'INVALID_RATCHET'
  | 'NON_NUMERIC_TARGET'
  | 'ALREADY_BUILT'
  | 'INVALID_STRUCTURE'
  | 'START_HAS_INCOMING'
  | 'UNREACHABLE_NODE'
  | 'DIAMOND_MISSING_EDGES'
  | 'GOAL_GATE_NO_MAX_VISITS'
  | 'MISSING_AC_MAPPING'
  | 'MISSING_TIMEOUT'
  | 'PROMPT_PATH_MISMATCH'
  | 'REVIEW_MISSING_READONLY'
  | 'COMPONENT_NO_MERGE'
  | 'FAN_OUT_SCOPE_LEAK'
  | 'WORKSPACE_NO_HTTPS'
  | 'WORKSPACE_NO_PUSH'
  | 'PLAN_MODE_DEADLOCK'
  | 'MISSING_ALLOWED_PATHS'
  | 'INVALID_SPEC'
  | 'INVALID_TIMEOUT'
  | 'INVALID_ALLOWED_PATHS'
  | 'DUPLICATE_MODEL'
  | 'INVALID_CONVERGENCE_SPEC';

export interface Diagnostic {
  rule: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  nodeId?: string;
  edge?: [string, string];
  fix?: string;
}

export interface ValidationResult {
  valid: boolean;
  diagnostics: Diagnostic[];
}

export class BuildError extends Error {
  readonly code: BuildErrorCode;
  readonly diagnostics: Diagnostic[];
  constructor(code: BuildErrorCode, message: string, diagnostics: Diagnostic[] = []) {
    super(message);
    this.name = 'BuildError';
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

export interface MicroverseOpts {
  prompt: string;
  measureCommand: string;
  target: number;
  direction: 'reduce' | 'improve';
  allowedPaths: string[];
  timeout?: string;
  maxVisits?: number;
}

export interface WorkspaceOpts {
  repoUrl?: string;
  repoBranch?: string;
  cleanup?: 'delete' | 'preserve';
}

export interface StylesheetOverride {
  selector: string;
  model: string;
  effort?: string;
}

export interface StylesheetConfig {
  defaultModel: string;
  defaultEffort?: string;
  overrides?: StylesheetOverride[];
  defaultProvider?: string;
  criticalModel?: string;
  criticalProvider?: string;
  reviewModel?: string;
  reviewProvider?: string;
  reasoningEffort?: string;
}

export interface ConvergenceSpec {
  until: 'V_total == 0' | 'V_total == 0 && fixed_point' | 'V_total == 0 && fixed_point && reproducibility';
  maxVisits?: number;
  timeout?: string;
  impl: {
    harness: 'hermes' | 'claude-code';
    prompt: string;
  };
  sealedFromSource?: string;
  fixBackend?: {
    model: string;
    harness: 'hermes' | 'claude-code';
    prompt: string;
    timeout?: string;
    maxVisits?: number;
  };
  fixFrontend?: {
    model: string;
    harness: 'hermes' | 'claude-code';
    prompt: string;
    timeout?: string;
    maxVisits?: number;
  };
  mechanicalGates?: {
    buildApi?: string;
    testsApi?: string;
    buildUi?: string;
    lint?: string;
  };
  reviewers?: {
    be?: { model: string; harness: 'hermes' | 'claude-code'; prompt: string; timeout?: string; maxVisits?: number };
    fe?: { model: string; harness: 'hermes' | 'claude-code'; prompt: string; timeout?: string; maxVisits?: number };
    int?: { model: string; harness: 'hermes' | 'claude-code'; prompt: string; timeout?: string; maxVisits?: number };
  };
  adversary?: {
    model: string;
    harness: 'hermes' | 'claude-code';
    prompt: string;
    sealedFromSource?: string;
    timeout?: string;
    maxVisits?: number;
  };
  fpVerify?: {
    command: string;
    timeout?: string;
    maxVisits?: number;
  };
  reproVerify?: {
    command: string;
    timeout?: string;
    maxVisits?: number;
  };
  convergenceEpsilon?: number;
  maxIterations?: number;
}

export interface PhaseSpec {
  name: string;
  prompt: string;
  allowedPaths: string[];
  severity?: 'error' | 'warning' | 'info';
  dependsOn?: string[];
  contextOnSuccess?: Record<string, string>;
  escalateOn?: string[];
  specFirst?: boolean;
  goalGate?: boolean;
  retryTarget?: string;
  timeout?: string;
  threadId?: string;
  securityScan?: boolean;
  coverageTarget?: number;
  competing?: boolean;
  redTeam?: boolean;
  bddScenarios?: boolean;
  deliverables?: string[];
  docOnly?: boolean;
  maxVisits?: number;
  verifyCommand?: string;
  permissionMode?: string;
  requirements?: string[];
  testExpectations?: { count: number; isolation: boolean };
  uiType?: 'crud' | 'dashboard' | 'form' | 'wizard';
}

export interface DefenseMatrix {
  competitive: boolean;
  guardrails: string[];
  specDriven: 'NONE' | 'conformance' | 'BDD + conformance' | 'spec_file + conformance' | 'spec_file + BDD + conformance';
  permissions: string[];
  adversarial: boolean;
}

export interface BuildResult {
  dot: string;
  slug: string;
  patternsApplied: string[];
  defenseMatrix: DefenseMatrix;
  diagnostics: Diagnostic[];
}

export interface BuilderSpec {
  slug: string;
  goal: string;
  phases: PhaseSpec[];
  acceptanceCriteria: Record<string, string>;
  workingDir?: string;
  label?: string;
  defaultMaxRetry?: number;
  workspace?: 'isolated';
  workspaceOpts?: WorkspaceOpts;
  microverse?: { name: string; opts: MicroverseOpts };
  reviewRatchet?: number;
  modelStylesheet?: StylesheetConfig;
  specFile?: string;
  endgame?: { broadPass?: boolean };
  convergence?: ConvergenceSpec;
}

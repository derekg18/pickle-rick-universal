import * as path from 'path';
import type { MicroverseSessionState, MicroverseHistoryEntry, CreateMicroverseOpts, FailureClass } from '../types/index.js';
import { StateManager } from './state-manager.js';
import { safeErrorMessage } from './pickle-utils.js';
import { readRecoverableJsonObject } from './recoverable-json.js';
export { readRecoverableJsonObject } from './recoverable-json.js';

const sm = new StateManager();

const MICROVERSE_FILE = 'microverse.json';

export function compareMetric(
  current: number,
  previous: number,
  tolerance: number,
  direction?: 'higher' | 'lower'
): 'improved' | 'held' | 'regressed' {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || !Number.isFinite(tolerance)) {
    return 'held';
  }
  if ((direction ?? 'higher') === 'lower') {
    if (current < previous - tolerance) return 'improved';
    if (current > previous + tolerance) return 'regressed';
    return 'held';
  }
  if (current > previous + tolerance) return 'improved';
  if (current < previous - tolerance) return 'regressed';
  return 'held';
}

// eslint-disable-next-line complexity -- pre-existing — outside T0–T15 god-fn refactor scope; defer to follow-up epic
export function createMicroverseState(opts: CreateMicroverseOpts): MicroverseSessionState {
  const { prdPath, metric, stallLimit, convergenceTarget, convergenceMode, convergenceFile, allowedPaths } = opts;
  if (!Number.isInteger(stallLimit) || stallLimit < 1) {
    throw new Error(`stall_limit must be a positive integer, got ${stallLimit}`);
  }
  if (!Number.isFinite(metric.tolerance) || metric.tolerance < 0) {
    throw new Error(`tolerance must be a non-negative number, got ${metric.tolerance}`);
  }
  if ((metric.type === 'command' || metric.type === 'llm') && (!Number.isFinite(metric.timeout_seconds) || metric.timeout_seconds <= 0)) {
    throw new Error(`timeout_seconds must be a positive finite number for ${metric.type} metrics, got ${metric.timeout_seconds}`);
  }
  if (convergenceTarget != null && !Number.isFinite(convergenceTarget)) {
    throw new Error(`convergence_target must be a finite number, got ${convergenceTarget}`);
  }
  const state: MicroverseSessionState = {
    status: 'gap_analysis',
    prd_path: prdPath,
    key_metric: { ...metric, direction: metric.direction ?? 'higher' },
    convergence: {
      stall_limit: stallLimit,
      stall_counter: 0,
      history: [],
    },
    gap_analysis_path: '',
    failed_approaches: [],
    baseline_score: 0,
    failure_history: [],
    approach_exhaustion_fired: false,
    iteration_regressions: 0,
    gate_regression_threshold_warning_emitted: false,
  };
  if (convergenceTarget != null) state.convergence_target = convergenceTarget;
  if (convergenceMode != null) state.convergence_mode = convergenceMode;
  if (convergenceFile != null) state.convergence_file = convergenceFile;
  if (allowedPaths != null && allowedPaths.length > 0) state.allowed_paths = allowedPaths;
  return state;
}

/**
 * Record a scored iteration (agent made commits and metric was measured).
 * Stall counter resets on accepted improvements, increments otherwise.
 *
 * The optional `classification` parameter allows the caller to pass the
 * already-computed compareMetric result, avoiding a redundant (and
 * potentially inconsistent) re-classification inside this function.
 */
export function recordIteration(
  state: MicroverseSessionState,
  entry: MicroverseHistoryEntry,
  classification?: 'improved' | 'held' | 'regressed'
): MicroverseSessionState {
  const history = [...state.convergence.history, entry];
  if (!classification) {
    const lastAccepted = [...state.convergence.history].reverse().find(h => h.action === 'accept');
    const previousScore = lastAccepted ? lastAccepted.score : state.baseline_score;
    classification = compareMetric(entry.score, previousScore, state.key_metric.tolerance, state.key_metric.direction);
  }
  entry.classification = classification;
  const stallCounter = entry.action === 'accept' && classification === 'improved'
    ? 0
    : state.convergence.stall_counter + 1;

  return {
    ...state,
    convergence: {
      ...state.convergence,
      history,
      stall_counter: stallCounter,
    },
  };
}

/**
 * Record a stall (no commits or metric unmeasurable). Increments stall_counter
 * without adding a history entry. This is the ONLY place stall_counter is
 * incremented outside of recordIteration — centralizing stall logic.
 */
export function recordStall(state: MicroverseSessionState): MicroverseSessionState {
  return {
    ...state,
    convergence: {
      ...state.convergence,
      stall_counter: state.convergence.stall_counter + 1,
    },
  };
}

export function recordFailedApproach(
  state: MicroverseSessionState,
  description: string
): MicroverseSessionState {
  const approaches = [...state.failed_approaches, description];
  if (approaches.length > 100) approaches.shift();
  return {
    ...state,
    failed_approaches: approaches,
  };
}

/**
 * Classify the failure mode of an iteration. Returns null if the iteration
 * succeeded (improved). Priority-ordered — first matching class wins.
 */
// eslint-disable-next-line complexity -- pre-existing — outside T0–T15 god-fn refactor scope; defer to follow-up epic
export function classifyFailure(
  mvState: MicroverseSessionState,
  metricResult: { raw: string; score: number } | null,
  preIterSha: string,
  postIterSha: string,
): FailureClass | null {
  // 1. tool_failure — metric measurement itself failed
  if (metricResult === null) return 'tool_failure';

  // Check if this iteration improved
  const history = mvState.convergence.history;
  const lastAccepted = [...history].reverse().find(h => h.action === 'accept');
  const previousScore = lastAccepted ? lastAccepted.score : mvState.baseline_score;
  const classification = compareMetric(
    metricResult.score, previousScore,
    mvState.key_metric.tolerance, mvState.key_metric.direction,
  );
  if (classification === 'improved') return null;

  // 2. metric_unstable — alternating improve/regress in last 3 entries
  if (history.length >= 3) {
    const last3 = history.slice(-3).map(h => h.classification);
    const isOscillating =
      (last3[0] === 'improved' && last3[1] === 'regressed' && last3[2] === 'improved') ||
      (last3[0] === 'regressed' && last3[1] === 'improved' && last3[2] === 'regressed');
    if (isOscillating) return 'metric_unstable';
  }

  // 3. regression — score went backwards
  if (classification === 'regressed') return 'regression';

  // 4. approach_exhaustion — tried many things, none stick
  if (
    mvState.failed_approaches.length >= 3 &&
    mvState.convergence.stall_counter >= mvState.convergence.stall_limit / 2
  ) {
    return 'approach_exhaustion';
  }

  // 5. no_progress — no commits or 3+ consecutive 'held'
  if (preIterSha === postIterSha) return 'no_progress';
  if (history.length >= 3) {
    const last3 = history.slice(-3).map(h => h.classification);
    if (last3.every(c => c === 'held')) return 'no_progress';
  }

  return null;
}

export function isConverged(state: MicroverseSessionState): boolean {
  if (state.convergence.stall_counter >= state.convergence.stall_limit) return true;
  // Early exit: if a convergence_target is set and score has reached (or passed) it, we're done.
  // Direction-aware: for 'lower', score <= target; for 'higher', score >= target.
  if (state.convergence_target != null) {
    const lastAccepted = [...state.convergence.history].reverse().find(h => h.action === 'accept');
    const currentScore = lastAccepted ? lastAccepted.score : state.baseline_score;
    const direction = state.key_metric.direction ?? 'higher';
    if (direction === 'lower'
      ? currentScore <= state.convergence_target
      : currentScore >= state.convergence_target) return true;
  }
  return false;
}

export function writeMicroverseState(
  sessionDir: string,
  state: MicroverseSessionState
): void {
  // microverse.json is not a State file but uses atomic writes for consistency.
  // Uses forceWrite to avoid lock overhead — microverse state is single-writer.
  sm.forceWrite(path.join(sessionDir, MICROVERSE_FILE), state);
}

export function readMicroverseState(
  sessionDir: string
): MicroverseSessionState | null {
  const filePath = path.join(sessionDir, MICROVERSE_FILE);
  try {
    const parsed = readRecoverableJsonObject(filePath) as MicroverseSessionState | null;
    if (!parsed) return null;
    parsed.failure_history ??= [];
    parsed.approach_exhaustion_fired ??= false;
    parsed.iteration_regressions ??= 0;
    parsed.gate_regression_threshold_warning_emitted ??= false;
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    const msg = safeErrorMessage(err);
    console.error(`[microverse-state] Failed to read ${filePath}: ${msg}`);
    return null;
  }
}

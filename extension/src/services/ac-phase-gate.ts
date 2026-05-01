import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { auditCodexManagerRelaunchCaps } from './bundle-state-integrity.js';
import { safeErrorMessage } from './pickle-utils.js';

export const AC_PHASE_MANIFEST = 'ac-phase-manifest.json';

export type AcEvaluationPhase = 'pre-refinement' | 'post-refinement' | 'per-phase' | 'bundle-end';

const VALID_EVALUATION_PHASES = new Set<AcEvaluationPhase>([
  'pre-refinement',
  'post-refinement',
  'per-phase',
  'bundle-end',
]);

export interface AcPhaseCriterion {
  id: string;
  evaluation_phase: AcEvaluationPhase;
  command?: string | string[];
  cwd?: string;
  phase?: string;
  expected_exit_code?: number;
}

export interface AcPhaseGateFailure {
  id: string;
  reason: string;
}

export interface AcPhaseGateResult {
  status: 'pass' | 'fail';
  phase: AcEvaluationPhase;
  evaluated: string[];
  skipped: string[];
  failures: AcPhaseGateFailure[];
  manifestPath?: string;
}

interface RunAcPhaseGateOpts {
  sessionDir: string;
  evaluationPhase: AcEvaluationPhase;
  pipelinePhase?: string;
  cwd?: string;
  stdout?: (msg: string) => void;
  stderr?: (msg: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readManifestArray(manifestPath: string): unknown[] {
  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as unknown;
  if (Array.isArray(raw)) return raw;
  if (!isRecord(raw)) throw new Error('manifest root must be an object or array');
  const criteria = raw.acceptance_criteria ?? raw.acceptanceCriteria;
  if (!Array.isArray(criteria)) {
    throw new Error('manifest must contain acceptance_criteria or acceptanceCriteria array');
  }
  return criteria;
}

function normalizeCriterion(raw: unknown, index: number): AcPhaseCriterion | AcPhaseGateFailure {
  if (!isRecord(raw)) return { id: `#${index + 1}`, reason: 'criterion must be an object' };
  const id = typeof raw.id === 'string' && raw.id.trim().length > 0 ? raw.id : `#${index + 1}`;
  const evaluationPhase = raw.evaluation_phase;
  if (!VALID_EVALUATION_PHASES.has(evaluationPhase as AcEvaluationPhase)) {
    return { id, reason: 'missing or invalid evaluation_phase' };
  }
  const command = raw.command;
  if (command !== undefined && typeof command !== 'string' && (!Array.isArray(command) || command.length === 0 || !command.every((part) => typeof part === 'string'))) {
    return { id, reason: 'command must be a string or string array' };
  }
  const expectedExitCode = raw.expected_exit_code;
  if (expectedExitCode !== undefined && (typeof expectedExitCode !== 'number' || !Number.isInteger(expectedExitCode))) {
    return { id, reason: 'expected_exit_code must be an integer' };
  }
  return {
    id,
    evaluation_phase: evaluationPhase as AcEvaluationPhase,
    command: command as string | string[] | undefined,
    cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
    phase: typeof raw.phase === 'string' ? raw.phase : undefined,
    expected_exit_code: expectedExitCode as number | undefined,
  };
}

function isFailure(value: AcPhaseCriterion | AcPhaseGateFailure): value is AcPhaseGateFailure {
  return 'reason' in value;
}

function shouldEvaluate(criterion: AcPhaseCriterion, evaluationPhase: AcEvaluationPhase, pipelinePhase: string | undefined): boolean {
  if (criterion.evaluation_phase !== evaluationPhase) return false;
  if (evaluationPhase !== 'per-phase') return true;
  return !criterion.phase || criterion.phase === pipelinePhase;
}

function runBuiltinCriterion(criterion: AcPhaseCriterion, sessionDir: string): AcPhaseGateFailure | null {
  if (criterion.id !== 'AC-BUNDLE-03') return null;

  const result = auditCodexManagerRelaunchCaps(sessionDir);
  if (result.violations.length === 0) return null;

  const reason = result.violations
    .map((violation) => `${path.relative(sessionDir, violation.statePath) || 'state.json'}: ${violation.reason}`)
    .join('; ');
  return { id: criterion.id, reason };
}

function runCriterion(criterion: AcPhaseCriterion, cwd: string, sessionDir: string): AcPhaseGateFailure | null {
  const builtinFailure = runBuiltinCriterion(criterion, sessionDir);
  if (builtinFailure) return builtinFailure;
  if (!criterion.command) return null;
  const expected = criterion.expected_exit_code ?? 0;
  const commandCwd = criterion.cwd ?? cwd;
  const result = Array.isArray(criterion.command)
    ? spawnSync(criterion.command[0], criterion.command.slice(1), { cwd: commandCwd, encoding: 'utf-8' })
    : spawnSync(criterion.command, { cwd: commandCwd, encoding: 'utf-8', shell: true });
  if (result.error) {
    return { id: criterion.id, reason: safeErrorMessage(result.error) };
  }
  const actual = result.status ?? 1;
  if (actual !== expected) {
    const detail = result.stderr || result.stdout || `exit ${actual}`;
    return { id: criterion.id, reason: `expected exit ${expected}, got ${actual}: ${detail}`.slice(0, 500) };
  }
  return null;
}

export function runAcPhaseGate(opts: RunAcPhaseGateOpts): AcPhaseGateResult {
  const manifestPath = path.join(opts.sessionDir, AC_PHASE_MANIFEST);
  if (!fs.existsSync(manifestPath)) {
    return { status: 'pass', phase: opts.evaluationPhase, evaluated: [], skipped: [], failures: [] };
  }

  let rawCriteria: unknown[];
  try {
    rawCriteria = readManifestArray(manifestPath);
  } catch (err) {
    return {
      status: 'fail',
      phase: opts.evaluationPhase,
      evaluated: [],
      skipped: [],
      failures: [{ id: AC_PHASE_MANIFEST, reason: safeErrorMessage(err) }],
      manifestPath,
    };
  }

  const normalized = rawCriteria.map(normalizeCriterion);
  const failures = normalized.filter(isFailure);
  const criteria = normalized.filter((item): item is AcPhaseCriterion => !isFailure(item));
  const evaluated: string[] = [];
  const skipped: string[] = [];

  for (const criterion of criteria) {
    if (!shouldEvaluate(criterion, opts.evaluationPhase, opts.pipelinePhase)) {
      skipped.push(criterion.id);
      continue;
    }
    evaluated.push(criterion.id);
    const failure = runCriterion(criterion, opts.cwd ?? process.cwd(), opts.sessionDir);
    if (failure) failures.push(failure);
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      opts.stderr?.(`[ac-phase-gate] ${opts.evaluationPhase} ${failure.id}: ${failure.reason}`);
    }
  } else if (evaluated.length > 0) {
    opts.stdout?.(`[ac-phase-gate] ${opts.evaluationPhase}: ${evaluated.length} AC(s) passed`);
  }

  return {
    status: failures.length > 0 ? 'fail' : 'pass',
    phase: opts.evaluationPhase,
    evaluated,
    skipped,
    failures,
    manifestPath,
  };
}

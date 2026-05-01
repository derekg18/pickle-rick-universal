import * as path from 'path';
import type { MicroverseMetric } from '../types/index.js';
import { createMicroverseState, readRecoverableJsonObject, writeMicroverseState } from '../services/microverse-state.js';
import { safeErrorMessage } from '../services/pickle-utils.js';

const DEFAULT_METRIC: MicroverseMetric = {
  description: 'Number of coding principle violations (lower is better)',
  validation: 'Review the code at the target path for violations of established coding principles (KISS, YAGNI, DRY, SOLID, Small Functions, Guard Clauses, Cognitive Load, Self-Documenting Code, Encapsulation, Fail-Fast, etc). Count only REAL, actionable violations — not style nitpicks. A violation must be fixable and must clearly hurt readability, maintainability, or correctness. Score = number of violations found.',
  type: 'llm',
  timeout_seconds: 300,
  tolerance: 0,
  direction: 'lower',
  judge_model: 'claude-sonnet-4-6',
};

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  const value = args[idx + 1];
  if (!value || value.startsWith('--')) {
    console.error(`${flag} requires a value`);
    process.exit(1);
  }
  return value;
}

function parseConvergenceMode(raw: string | undefined): 'metric' | 'worker' | undefined {
  if (raw == null) return undefined;
  if (raw === 'metric' || raw === 'worker') return raw;
  console.error(`convergence_mode must be 'metric' or 'worker', got ${raw}`);
  process.exit(1);
}

if (process.argv[1] && path.basename(process.argv[1]) === 'init-microverse.js') {
  const args = process.argv.slice(2);
  const positional = args.filter((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1]?.startsWith('--')));

  const sessionDir = positional[0];
  const targetPath = positional[1];

  if (!sessionDir || !targetPath) {
    console.error('Usage: init-microverse <session-dir> <target-path> [--stall-limit N] [--convergence-target N] [--convergence-mode metric|worker] [--convergence-file <filename>] [--metric-json \'...\'] [--allowed-paths-file <path>]');
    process.exit(1);
  }

  const stallLimit = Number(parseFlag(args, '--stall-limit') ?? '5');
  const rawConvergence = parseFlag(args, '--convergence-target');
  const rawMetricJson = parseFlag(args, '--metric-json');
  const judgeContextPath = parseFlag(args, '--judge-context');
  const rawConvergenceMode = parseFlag(args, '--convergence-mode');
  const convergenceFile = parseFlag(args, '--convergence-file');
  const allowedPathsFile = parseFlag(args, '--allowed-paths-file');

  if (convergenceFile && (/[/\\]/.test(convergenceFile) || convergenceFile.includes('..'))) {
    console.error('convergence_file must be a bare filename');
    process.exit(1);
  }

  if (rawConvergenceMode === 'worker' && !convergenceFile) {
    console.error('worker mode requires --convergence-file');
    process.exit(1);
  }

  const convergenceMode = parseConvergenceMode(rawConvergenceMode);

  let metric: MicroverseMetric;
  if (rawMetricJson) {
    try {
      metric = JSON.parse(rawMetricJson) as MicroverseMetric;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Invalid --metric-json: ${msg}`);
      process.exit(1);
    }
  } else {
    metric = DEFAULT_METRIC;
  }

  if (metric.type === 'none' && convergenceMode !== 'worker') {
    console.error('type: none requires convergence_mode: worker');
    process.exit(1);
  }

  let allowedPaths: string[] | undefined;
  if (allowedPathsFile) {
    let raw: unknown;
    try {
      raw = readRecoverableJsonObject(allowedPathsFile);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Failed to read --allowed-paths-file ${allowedPathsFile}: ${msg}`);
      process.exit(1);
    }
    // Fail-fast: silently dropping scope filtering would defeat the purpose of the flag.
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      console.error(`--allowed-paths-file ${allowedPathsFile}: expected a JSON object with an 'allowed_paths' array`);
      process.exit(1);
    }
    const field = (raw as Record<string, unknown>).allowed_paths;
    if (!Array.isArray(field)) {
      console.error(`--allowed-paths-file ${allowedPathsFile}: 'allowed_paths' is missing or not an array`);
      process.exit(1);
    }
    if (!field.every((p) => typeof p === 'string')) {
      console.error(`--allowed-paths-file ${allowedPathsFile}: 'allowed_paths' must contain only strings`);
      process.exit(1);
    }
    allowedPaths = field as string[];
  }

  try {
    const convergenceTarget = rawConvergence != null ? Number(rawConvergence) : undefined;
    const state = createMicroverseState({ prdPath: targetPath, metric, stallLimit, convergenceTarget, convergenceMode, convergenceFile, allowedPaths });
    state.gap_analysis_path = path.join(sessionDir, 'gap_analysis.md');
    if (judgeContextPath) state.judge_context_path = judgeContextPath;
    writeMicroverseState(sessionDir, state);
    console.log('microverse.json created');
  } catch (err) {
    console.error(`Failed to init microverse: ${safeErrorMessage(err)}`);
    process.exit(1);
  }
}

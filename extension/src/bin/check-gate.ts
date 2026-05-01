import * as path from 'path';
import { runGate, type RunGateOpts } from '../services/convergence-gate.js';
import type { GateResult, GateMode } from '../types/index.js';
import { safeErrorMessage } from '../services/pickle-utils.js';
import { readRecoverableJsonObject } from '../services/microverse-state.js';

const USAGE = 'Usage: check-gate --mode baseline|strict --scope full|changed --checks typecheck,lint,tests --working-dir <path> [--since <ref>] [--baseline-path <path>] [--allowed-paths-file <scope.json>] [--json]';

const VALUE_FLAGS = new Set([
  '--mode', '--scope', '--since', '--checks',
  '--baseline-path', '--working-dir', '--allowed-paths-file',
]);
const BOOL_FLAGS = new Set(['--json', '--help', '-h']);
const ALL_FLAGS = new Set([...VALUE_FLAGS, ...BOOL_FLAGS]);
const VALID_CHECKS = new Set(['typecheck', 'lint', 'tests'] as const);
const VALID_MODES = new Set<string>(['baseline', 'strict']);
const VALID_SCOPES = new Set<string>(['full', 'changed']);

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  const value = args[idx + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

export interface CheckGateMainOpts {
  argv: string[];
  runGateFn?: (opts: RunGateOpts) => Promise<GateResult>;
  stdout?: (msg: string) => void;
  stderr?: (msg: string) => void;
}

function statusToExitCode(status: GateResult['status']): number {
  if (status === 'green') return 0;
  if (status === 'red') return 2;
  if (status === 'green-with-known-flake-warnings') return 3;
  return 1;
}

// eslint-disable-next-line complexity -- pre-existing — outside T0–T15 god-fn refactor scope; defer to follow-up epic
export async function checkGateMain(opts: CheckGateMainOpts): Promise<number> {
  const { argv, runGateFn = runGate } = opts;
  const out = opts.stdout ?? ((msg: string) => process.stdout.write(msg + '\n'));
  const err = opts.stderr ?? ((msg: string) => process.stderr.write(msg + '\n'));
  const jsonMode = hasFlag(argv, '--json');

  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    out(USAGE);
    return 0;
  }

  // Detect unknown flags
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('-')) continue;
    if (!ALL_FLAGS.has(arg)) {
      err(`Unknown flag: ${arg}\n${USAGE}`);
      return 1;
    }
    if (VALUE_FLAGS.has(arg)) i++; // skip value
  }

  const mode = parseFlag(argv, '--mode');
  const scope = parseFlag(argv, '--scope');
  const checks = parseFlag(argv, '--checks');
  const workingDir = parseFlag(argv, '--working-dir');
  const baselinePath = parseFlag(argv, '--baseline-path');
  const since = parseFlag(argv, '--since');
  const allowedPathsFile = parseFlag(argv, '--allowed-paths-file');

  if (!mode) { err(`--mode is required\n${USAGE}`); return 1; }
  if (!VALID_MODES.has(mode)) { err(`--mode must be baseline|strict, got: ${mode}`); return 1; }
  if (!scope) { err(`--scope is required\n${USAGE}`); return 1; }
  if (!VALID_SCOPES.has(scope)) { err(`--scope must be full|changed, got: ${scope}`); return 1; }
  if (!checks) { err(`--checks is required\n${USAGE}`); return 1; }
  if (!workingDir) { err(`--working-dir is required\n${USAGE}`); return 1; }

  const parsedChecks = checks.split(',').map(c => c.trim()).filter(Boolean);
  const invalidChecks = parsedChecks.filter(c => !VALID_CHECKS.has(c as 'typecheck' | 'lint' | 'tests'));
  if (invalidChecks.length > 0) {
    err(`--checks contains invalid values: ${invalidChecks.join(', ')}. Valid: typecheck,lint,tests`);
    return 1;
  }

  let allowedPaths: string[] | undefined;
  if (allowedPathsFile) {
    let raw: unknown;
    try {
      raw = readRecoverableJsonObject(allowedPathsFile);
    } catch (e) {
      err(`Failed to read --allowed-paths-file ${allowedPathsFile}: ${safeErrorMessage(e)}`);
      return 1;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      err(`--allowed-paths-file ${allowedPathsFile}: expected a JSON object with an 'allowed_paths' array`);
      return 1;
    }
    const field = (raw as Record<string, unknown>).allowed_paths;
    if (!Array.isArray(field)) {
      err(`--allowed-paths-file ${allowedPathsFile}: 'allowed_paths' is missing or not an array`);
      return 1;
    }
    if (!field.every((p) => typeof p === 'string')) {
      err(`--allowed-paths-file ${allowedPathsFile}: 'allowed_paths' must contain only strings`);
      return 1;
    }
    allowedPaths = field as string[];
  }

  let result: GateResult;
  try {
    result = await runGateFn({
      workingDir,
      mode: mode as GateMode,
      scope: scope as 'full' | 'changed',
      checks: parsedChecks as ('typecheck' | 'lint' | 'tests')[],
      baselinePath,
      since,
      allowedPaths,
    });
  } catch (e) {
    err(`check-gate internal error: ${safeErrorMessage(e)}`);
    return 1;
  }

  if (jsonMode) {
    out(JSON.stringify(result));
  } else {
    const badge = result.status === 'green' ? 'GREEN' : result.status === 'red' ? 'RED' : 'WARN';
    out(`[check-gate] ${badge} status=${result.status} failures=${result.failures.length} elapsed=${result.elapsed_ms}ms`);
    if (result.failures.length > 0) {
      for (const f of result.failures) {
        out(`  [${f.check}] ${f.file}:${f.line} ${f.ruleOrCode} — ${f.message.slice(0, 120)}`);
      }
    }
  }

  return statusToExitCode(result.status);
}

if (process.argv[1] && path.basename(process.argv[1]) === 'check-gate.js') {
  checkGateMain({ argv: process.argv.slice(2) }).then(code => process.exit(code)).catch((e) => {
    process.stderr.write(`check-gate fatal: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}

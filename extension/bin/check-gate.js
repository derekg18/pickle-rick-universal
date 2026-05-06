import * as path from 'path';
import { runGate } from '../services/convergence-gate.js';
import { safeErrorMessage } from '../services/pickle-utils.js';
import { readRecoverableJsonObject } from '../services/microverse-state.js';
const USAGE = 'Usage: check-gate --mode baseline|strict --scope full|changed --checks typecheck,lint,tests --working-dir <path> [--since <ref>] [--baseline-path <path>] [--allowed-paths-file <scope.json>] [--json]';
const VALUE_FLAGS = new Set([
    '--mode', '--scope', '--since', '--checks',
    '--baseline-path', '--working-dir', '--allowed-paths-file',
]);
const BOOL_FLAGS = new Set(['--json', '--help', '-h']);
const ALL_FLAGS = new Set([...VALUE_FLAGS, ...BOOL_FLAGS]);
const VALID_CHECKS = new Set(['typecheck', 'lint', 'tests']);
const VALID_MODES = new Set(['baseline', 'strict']);
const VALID_SCOPES = new Set(['full', 'changed']);
function parseFlag(args, flag) {
    const idx = args.indexOf(flag);
    if (idx === -1 || idx + 1 >= args.length)
        return undefined;
    const value = args[idx + 1];
    return value && !value.startsWith('--') ? value : undefined;
}
function hasFlag(args, flag) {
    return args.includes(flag);
}
function statusToExitCode(status) {
    if (status === 'green')
        return 0;
    if (status === 'red')
        return 2;
    if (status === 'green-with-known-flake-warnings')
        return 3;
    return 1;
}
function loadAllowedPathsFile(allowedPathsFile) {
    let raw;
    try {
        raw = readRecoverableJsonObject(allowedPathsFile);
    }
    catch (e) {
        return { error: `Failed to read --allowed-paths-file ${allowedPathsFile}: ${safeErrorMessage(e)}` };
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { error: `--allowed-paths-file ${allowedPathsFile}: expected a JSON object with an 'allowed_paths' array` };
    }
    const field = raw.allowed_paths;
    if (!Array.isArray(field)) {
        return { error: `--allowed-paths-file ${allowedPathsFile}: 'allowed_paths' is missing or not an array` };
    }
    if (!field.every((p) => typeof p === 'string')) {
        return { error: `--allowed-paths-file ${allowedPathsFile}: 'allowed_paths' must contain only strings` };
    }
    return { allowedPaths: field };
}
function parseCheckGateArgs(argv) {
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('-'))
            continue;
        if (!ALL_FLAGS.has(arg))
            return { error: `Unknown flag: ${arg}\n${USAGE}` };
        if (VALUE_FLAGS.has(arg))
            i++;
    }
    const mode = parseFlag(argv, '--mode');
    const scope = parseFlag(argv, '--scope');
    const checks = parseFlag(argv, '--checks');
    const workingDir = parseFlag(argv, '--working-dir');
    if (!mode)
        return { error: `--mode is required\n${USAGE}` };
    if (!VALID_MODES.has(mode))
        return { error: `--mode must be baseline|strict, got: ${mode}` };
    if (!scope)
        return { error: `--scope is required\n${USAGE}` };
    if (!VALID_SCOPES.has(scope))
        return { error: `--scope must be full|changed, got: ${scope}` };
    if (!checks)
        return { error: `--checks is required\n${USAGE}` };
    if (!workingDir)
        return { error: `--working-dir is required\n${USAGE}` };
    const parsedChecks = checks.split(',').map(c => c.trim()).filter(Boolean);
    const invalidChecks = parsedChecks.filter(c => !VALID_CHECKS.has(c));
    if (invalidChecks.length > 0) {
        return { error: `--checks contains invalid values: ${invalidChecks.join(', ')}. Valid: typecheck,lint,tests` };
    }
    return {
        parsed: {
            mode: mode,
            scope: scope,
            checks: parsedChecks,
            workingDir,
            baselinePath: parseFlag(argv, '--baseline-path'),
            since: parseFlag(argv, '--since'),
            allowedPathsFile: parseFlag(argv, '--allowed-paths-file'),
        },
    };
}
function writeTextResult(result, out) {
    const badge = result.status === 'green' ? 'GREEN' : result.status === 'red' ? 'RED' : 'WARN';
    out(`[check-gate] ${badge} status=${result.status} failures=${result.failures.length} elapsed=${result.elapsed_ms}ms`);
    for (const f of result.failures) {
        out(`  [${f.check}] ${f.file}:${f.line} ${f.ruleOrCode} — ${f.message.slice(0, 120)}`);
    }
}
export async function checkGateMain(opts) {
    const { argv, runGateFn = runGate } = opts;
    const out = opts.stdout ?? ((msg) => process.stdout.write(msg + '\n'));
    const err = opts.stderr ?? ((msg) => process.stderr.write(msg + '\n'));
    const jsonMode = hasFlag(argv, '--json');
    if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
        out(USAGE);
        return 0;
    }
    const { parsed, error } = parseCheckGateArgs(argv);
    if (error || !parsed) {
        err(error ?? USAGE);
        return 1;
    }
    let allowedPaths;
    if (parsed.allowedPathsFile) {
        const loadedAllowedPaths = loadAllowedPathsFile(parsed.allowedPathsFile);
        if (loadedAllowedPaths.error) {
            err(loadedAllowedPaths.error);
            return 1;
        }
        allowedPaths = loadedAllowedPaths.allowedPaths;
    }
    let result;
    try {
        result = await runGateFn({
            workingDir: parsed.workingDir,
            mode: parsed.mode,
            scope: parsed.scope,
            checks: parsed.checks,
            baselinePath: parsed.baselinePath,
            since: parsed.since,
            allowedPaths,
        });
    }
    catch (e) {
        err(`check-gate internal error: ${safeErrorMessage(e)}`);
        return 1;
    }
    if (jsonMode) {
        out(JSON.stringify(result));
    }
    else {
        writeTextResult(result, out);
    }
    return statusToExitCode(result.status);
}
if (process.argv[1] && path.basename(process.argv[1]) === 'check-gate.js') {
    checkGateMain({ argv: process.argv.slice(2) }).then(code => process.exit(code)).catch((e) => {
        process.stderr.write(`check-gate fatal: ${e instanceof Error ? e.message : String(e)}\n`);
        process.exit(1);
    });
}

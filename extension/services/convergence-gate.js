import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'node:crypto';
import { execFile, spawnSync } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { LockError } from '../types/index.js';
import { withLock } from './state-manager.js';
import { readRecoverableJsonObject } from './microverse-state.js';
import { writeStateFile } from './pickle-utils.js';
const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
function loadGateCommands() {
    const dataPath = path.resolve(__dirname, '../data/gate-commands.json');
    return JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
}
export class GateError extends Error {
    kind;
    constructor(kind, message) {
        super(message);
        this.name = 'GateError';
        this.kind = kind;
    }
}
export class GateTimeoutError extends GateError {
    check;
    timeout_ms;
    constructor(check, timeout_ms) {
        super('GATE_CHECK_TIMEOUT', `${check} timed out after ${timeout_ms}ms`);
        this.name = 'GateTimeoutError';
        this.check = check;
        this.timeout_ms = timeout_ms;
    }
}
export class BaselineMissingError extends GateError {
    constructor(baselinePath) {
        super('BASELINE_MISSING', `No baseline at ${baselinePath}`);
        this.name = 'BaselineMissingError';
    }
}
export class BaselineStaleError extends GateError {
    constructor(message) {
        super('BASELINE_STALE', message);
        this.name = 'BaselineStaleError';
    }
}
/** Event names emitted by the remediator layer after runGate. Exported for remediator callers. */
export const GATE_REMEDIATION_EVENT_NAMES = [
    'gate_remediation_complete',
    'gate_remediation_aborted_unverified_production_change',
    'gate_autofix_reverted',
];
const PER_CHECK_TIMEOUT_MS = {
    typecheck: 120_000,
    lint: 60_000,
    tests: 300_000,
};
const GATE_TOTAL_TIMEOUT_MS = 600_000;
const GATE_LOCK_TIMEOUT_MS = 30_000;
const WORKSPACE_ROOT_CONTROL_FILES = new Set([
    'package.json',
    'pnpm-workspace.yaml',
    'pnpm-lock.yaml',
    'yarn.lock',
    'package-lock.json',
    'bun.lock',
    'bun.lockb',
]);
const UNSAFE_TEST_SCRIPT_REGEX = /integration|e2e|golden|smoke|baseline|playwright|cypress|hardhat/i;
const SAFE_TEST_RUNNER_REGEX = /(vitest|jest|node|mocha)/;
function buildFingerprint(f) {
    return `${f.file}::${f.ruleOrCode}::${f.occurrence_index}`;
}
export function assignOccurrenceIndices(failures) {
    const groups = new Map();
    for (const f of failures) {
        const key = `${f.file}::${f.ruleOrCode}`;
        const group = groups.get(key) ?? [];
        group.push(f);
        groups.set(key, group);
    }
    const result = [];
    for (const group of groups.values()) {
        group.sort((a, b) => a.line - b.line);
        for (let i = 0; i < group.length; i++) {
            result.push({ ...group[i], occurrence_index: i });
        }
    }
    return result;
}
function validateBaselineStructure(data) {
    if (!data || typeof data !== 'object')
        return false;
    const d = data;
    return (d['schema_version'] === 1 &&
        typeof d['captured_at'] === 'string' &&
        typeof d['working_dir'] === 'string' &&
        typeof d['project_type'] === 'string' &&
        ['pnpm', 'npm', 'yarn', 'cargo', 'go'].includes(d['project_type']) &&
        Array.isArray(d['checks']) &&
        Array.isArray(d['failures']));
}
function loadBaselineFile(baselinePath) {
    const raw = readRecoverableJsonObject(baselinePath);
    if (!validateBaselineStructure(raw)) {
        throw new GateError('BASELINE_CORRUPT', `Invalid baseline file at ${baselinePath}`);
    }
    return raw;
}
export function subtractBaseline(current, baseline) {
    const baselineSet = new Set(baseline.failures.map(buildFingerprint));
    return current.filter(f => !baselineSet.has(buildFingerprint(f)));
}
export function assertBaselineFresh(baselinePath, opts) {
    if (!fs.existsSync(baselinePath)) {
        const dir = path.dirname(baselinePath);
        fs.mkdirSync(dir, { recursive: true });
        const now = new Date().toISOString();
        const iso = now.replace(/[:.]/g, '-');
        fs.writeFileSync(path.join(dir, `baseline_missing_${iso}.md`), `# Baseline Missing\n\nPath: \`${baselinePath}\`\nCaptured: ${now}\n`);
        throw new BaselineMissingError(baselinePath);
    }
    const stat = fs.statSync(baselinePath);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > opts.max_age_seconds * 1000) {
        throw new BaselineStaleError(`Baseline at ${baselinePath} is ${Math.round(ageMs / 1000)}s old (max ${opts.max_age_seconds}s)`);
    }
    if (opts.current_iteration >= opts.max_age_iterations) {
        throw new BaselineStaleError(`current_iteration (${opts.current_iteration}) >= max_age_iterations (${opts.max_age_iterations})`);
    }
}
export function detectProjectType(workingDir) {
    const has = (f) => fs.existsSync(path.join(workingDir, f));
    if (has('pnpm-lock.yaml') || has('pnpm-workspace.yaml'))
        return 'pnpm';
    if (has('yarn.lock'))
        return 'yarn';
    if (has('package-lock.json'))
        return 'npm';
    if (has('bun.lock') || has('bun.lockb'))
        return 'bun';
    if (has('package.json'))
        return 'npm';
    if (has('Cargo.toml'))
        return 'cargo';
    if (has('go.mod'))
        return 'go';
    return null;
}
function parsePnpmWorkspaceYaml(content) {
    const patterns = [];
    let inPackages = false;
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === 'packages:') {
            inPackages = true;
            continue;
        }
        if (!inPackages)
            continue;
        if (trimmed.startsWith('- ')) {
            patterns.push(trimmed.slice(2).replace(/^['"]|['"]$/g, ''));
        }
        else if (trimmed && !trimmed.startsWith('#')) {
            inPackages = false;
        }
    }
    return patterns;
}
function resolveWorkspaceGlobs(workingDir, patterns) {
    const results = new Set();
    const packageDirs = listWorkspacePackageDirs(workingDir).map(abs => ({
        abs,
        rel: normalizeScopePath(path.relative(workingDir, abs)),
    }));
    for (const pattern of patterns) {
        const normalizedPattern = normalizeScopePath(pattern);
        if (!/[*?]/.test(normalizedPattern)) {
            const resolved = path.resolve(workingDir, normalizedPattern);
            if (fs.existsSync(path.join(resolved, 'package.json')))
                results.add(resolved);
            continue;
        }
        const regex = workspaceGlobToRegex(normalizedPattern);
        for (const candidate of packageDirs) {
            if (regex.test(candidate.rel)) {
                results.add(candidate.abs);
            }
        }
    }
    return Array.from(results).sort();
}
export function getWorkspacePackages(workingDir) {
    const pnpmYaml = path.join(workingDir, 'pnpm-workspace.yaml');
    if (fs.existsSync(pnpmYaml)) {
        const patterns = parsePnpmWorkspaceYaml(fs.readFileSync(pnpmYaml, 'utf-8'));
        return resolveWorkspaceGlobs(workingDir, patterns);
    }
    const pkgJsonPath = path.join(workingDir, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
            const ws = pkg.workspaces;
            if (ws) {
                const patterns = Array.isArray(ws) ? ws : (ws.packages ?? []);
                return resolveWorkspaceGlobs(workingDir, patterns);
            }
        }
        catch {
            /* not a valid package.json with workspaces */
        }
    }
    return [];
}
function globToRegex(pattern) {
    // Strip trailing /** so the base dir itself matches: packages/b/** → ^packages/b(/.*)?$
    const pat = pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern;
    const re = pat
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '\x00')
        .replace(/\*/g, '[^/]*')
        .replace(/\x00/g, '.*')
        .replace(/\?/g, '[^/]');
    return new RegExp(`^${re}(/.*)?$`);
}
function workspaceGlobToRegex(pattern) {
    let re = '';
    let i = 0;
    while (i < pattern.length) {
        const c = pattern[i];
        if (c === '*') {
            if (pattern[i + 1] === '*') {
                re += '.*';
                i += 2;
                continue;
            }
            re += '[^/]*';
        }
        else if (c === '?') {
            re += '[^/]';
        }
        else if (/[.+^${}()|[\]\\]/.test(c)) {
            re += `\\${c}`;
        }
        else {
            re += c;
        }
        i += 1;
    }
    return new RegExp(`^${re}$`);
}
function listWorkspacePackageDirs(rootDir) {
    const found = new Set();
    const pending = [rootDir];
    while (pending.length > 0) {
        const current = pending.pop();
        let entries;
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        }
        catch {
            continue;
        }
        if (current !== rootDir &&
            entries.some(entry => entry.isFile() && entry.name === 'package.json')) {
            found.add(current);
        }
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            if (entry.name === '.git' || entry.name === 'node_modules')
                continue;
            pending.push(path.join(current, entry.name));
        }
    }
    return Array.from(found);
}
function normalizeScopePath(value) {
    return value.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
}
function staticScopePrefix(pattern) {
    const normalized = normalizeScopePath(pattern);
    const wildcardIdx = normalized.search(/[*?]/);
    const prefix = wildcardIdx === -1 ? normalized : normalized.slice(0, wildcardIdx);
    return prefix.replace(/\/+$/, '');
}
function matchesAllowedPath(candidate, allowedPaths) {
    const normalizedCandidate = normalizeScopePath(candidate);
    return allowedPaths.some((allowedPath) => {
        const normalizedAllowed = normalizeScopePath(allowedPath);
        if (globToRegex(normalizedAllowed).test(normalizedCandidate))
            return true;
        const prefix = staticScopePrefix(normalizedAllowed);
        if (!prefix)
            return true;
        return (prefix === normalizedCandidate ||
            prefix.startsWith(`${normalizedCandidate}/`) ||
            normalizedCandidate.startsWith(`${prefix}/`));
    });
}
function affectsAllWorkspacePackages(repoRelativePaths) {
    return repoRelativePaths.some((filePath) => WORKSPACE_ROOT_CONTROL_FILES.has(normalizeScopePath(filePath)));
}
function applyFlakeFilter(failures, workingDir, flakeGlobs) {
    if (flakeGlobs.length === 0)
        return { real: failures, flake: [] };
    const regexes = flakeGlobs.map(globToRegex);
    const isFlake = (f) => {
        const rel = path.relative(workingDir, f.file);
        return regexes.some(re => re.test(rel));
    };
    return { real: failures.filter(f => !isFlake(f)), flake: failures.filter(isFlake) };
}
export function filterByScope(files, opts) {
    if (!opts.allowedPaths || opts.allowedPaths.length === 0)
        return files;
    return files.filter((file) => matchesAllowedPath(file, opts.allowedPaths ?? []));
}
function getChangedSince(workingDir, since) {
    const result = spawnSync('git', ['diff', '--name-only', `${since}..HEAD`], {
        cwd: workingDir,
        encoding: 'utf-8',
        timeout: 30_000,
    });
    if ((result.status ?? 1) !== 0)
        return [];
    return (result.stdout || '').split('\n').filter(Boolean);
}
async function runCheckCommand(cmd, cwd, timeout_ms) {
    const parts = cmd.split(' ').filter((p) => p.length > 0);
    if (parts.length === 0) {
        throw new Error(`runCheckCommand: empty command — refusing to spawn`);
    }
    const bin = parts[0];
    const args = parts.slice(1);
    try {
        const { stdout, stderr } = await execFileAsync(bin, args, {
            cwd,
            timeout: timeout_ms,
            killSignal: 'SIGKILL',
            maxBuffer: 10 * 1024 * 1024,
        });
        return { stdout: stdout ?? '', stderr: stderr ?? '', exitCode: 0 };
    }
    catch (err) {
        const e = err;
        return {
            stdout: e.stdout ?? '',
            stderr: e.stderr ?? '',
            exitCode: typeof e.code === 'number' ? e.code : 1,
        };
    }
}
function parseTscOutput(output, pkgDir) {
    const failures = [];
    const re = /^(.+?)\((\d+),\d+\):\s+error\s+(TS\d+):\s+(.*)$/;
    for (const line of output.split('\n')) {
        const m = line.match(re);
        if (!m)
            continue;
        failures.push({
            check: 'typecheck',
            file: path.isAbsolute(m[1]) ? m[1] : path.resolve(pkgDir, m[1]),
            line: parseInt(m[2], 10),
            ruleOrCode: m[3],
            message: (m[4] ?? '').slice(0, 500),
            severity: 'error',
            occurrence_index: 0,
        });
    }
    return failures;
}
function parseEslintOutput(output, pkgDir) {
    const failures = [];
    let currentFile = '';
    const violationRe = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.*\S)\s{2,}(\S+)\s*$/;
    for (const line of output.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        if (/^[✖×√]/.test(trimmed) || /^\d+ problem/.test(trimmed))
            continue;
        if (line.charAt(0) !== ' ' && line.charAt(0) !== '\t') {
            currentFile = path.isAbsolute(trimmed) ? trimmed : path.resolve(pkgDir, trimmed);
        }
        else {
            const m = line.match(violationRe);
            if (m && currentFile) {
                failures.push({
                    check: 'lint',
                    file: currentFile,
                    line: parseInt(m[1], 10),
                    ruleOrCode: m[5].trim(),
                    message: m[4].trim().slice(0, 500),
                    severity: m[3] === 'error' ? 'error' : 'warning',
                    occurrence_index: 0,
                });
            }
        }
    }
    return failures;
}
function buildFailures(result, check, pkgDir) {
    if (result.exitCode === 0)
        return [];
    const output = (result.stderr || result.stdout).trim();
    if (check === 'typecheck') {
        const parsed = parseTscOutput(output, pkgDir);
        if (parsed.length > 0)
            return parsed;
    }
    if (check === 'lint') {
        const parsed = parseEslintOutput(output, pkgDir);
        if (parsed.length > 0)
            return parsed;
    }
    return [{
            check,
            file: pkgDir,
            line: 0,
            ruleOrCode: String(result.exitCode),
            message: output.slice(0, 500) || `${check} failed with exit code ${result.exitCode}`,
            severity: 'error',
            occurrence_index: 0,
        }];
}
const CHECK_KEY_MAP = {
    typecheck: 'typecheck',
    lint: 'lint',
    tests: 'test',
};
// eslint-disable-next-line complexity, max-lines-per-function -- pre-existing — outside T0–T15 god-fn refactor scope; defer to follow-up epic
export async function runGate(opts) {
    const start = Date.now();
    const emit = (event, data) => opts.onEvent?.(event, data);
    const empty = {
        status: 'green',
        failures: [],
        baseline_used: false,
        allowed_paths_used: false,
        elapsed_ms: 0,
        total_raw_failure_count: 0,
        new_failures_vs_baseline: 0,
    };
    function finalize(result) {
        emit('gate_run_complete', {
            gate_payload: {
                mode: opts.mode,
                scope: opts.scope,
                checks: opts.checks,
                status: result.status,
                failure_count: result.failures.length,
                total_raw_failure_count: result.total_raw_failure_count,
                new_failures_vs_baseline: result.new_failures_vs_baseline,
                elapsed_ms: result.elapsed_ms,
                allowed_paths_used: result.allowed_paths_used,
                baseline_used: result.baseline_used,
            },
        });
        return result;
    }
    const projectType = detectProjectType(opts.workingDir);
    if (!projectType) {
        emit('gate_skipped', { reason: 'no_project_type_detected' });
        return { ...empty, elapsed_ms: Date.now() - start };
    }
    const commands = loadGateCommands();
    const cmdMap = commands[projectType];
    if (!cmdMap) {
        emit('gate_skipped', { reason: 'project_type_low_confidence', detected_signals: [projectType] });
        return { ...empty, elapsed_ms: Date.now() - start };
    }
    const workspacePackages = getWorkspacePackages(opts.workingDir);
    const allowedPathsUsed = Boolean(opts.allowedPaths && opts.allowedPaths.length > 0);
    let targetDirs;
    if (workspacePackages.length > 0) {
        let candidates = workspacePackages;
        let changedFiles = [];
        if (opts.scope === 'changed' && opts.since) {
            changedFiles = getChangedSince(opts.workingDir, opts.since);
            if (!affectsAllWorkspacePackages(changedFiles)) {
                candidates = workspacePackages.filter(pkgDir => changedFiles.some(f => {
                    const absFile = path.resolve(opts.workingDir, f);
                    return absFile.startsWith(pkgDir + path.sep) || absFile === pkgDir;
                }));
            }
        }
        if (allowedPathsUsed && !affectsAllWorkspacePackages(opts.allowedPaths ?? [])) {
            const relCandidates = candidates.map(p => path.relative(opts.workingDir, p));
            const filtered = filterByScope(relCandidates, { scope: opts.scope, allowedPaths: opts.allowedPaths });
            candidates = filtered.map(rel => path.resolve(opts.workingDir, rel));
        }
        targetDirs = candidates;
    }
    else {
        if (opts.scope === 'changed' && opts.since) {
            const changedFiles = getChangedSince(opts.workingDir, opts.since);
            if (changedFiles.length === 0) {
                const result = { ...empty, elapsed_ms: Date.now() - start };
                emit('gate_diff_scope_fallback', { since: opts.since, reason: 'no_changed_files' });
                return finalize(result);
            }
        }
        targetDirs = [opts.workingDir];
    }
    if (opts.workerMode) {
        const porcelainR = spawnSync('git', ['status', '--porcelain'], {
            cwd: opts.workingDir, encoding: 'utf-8', timeout: 10_000,
        });
        const dirtyLines = (porcelainR.stdout ?? '').split('\n').filter(Boolean);
        if (dirtyLines.length > 0) {
            emit('gate_skipped', { reason: 'dirty_worktree_no_rescue' });
            return { ...empty, elapsed_ms: Date.now() - start };
        }
    }
    if (opts.expected_head !== undefined || opts.expected_branch !== undefined) {
        const headR = spawnSync('git', ['rev-parse', 'HEAD'], {
            cwd: opts.workingDir, encoding: 'utf-8', timeout: 10_000,
        });
        const branchR = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
            cwd: opts.workingDir, encoding: 'utf-8', timeout: 10_000,
        });
        const currentHead = (headR.stdout ?? '').trim();
        const currentBranch = (branchR.stdout ?? '').trim();
        const headMismatch = opts.expected_head !== undefined && currentHead !== opts.expected_head;
        const branchMismatch = opts.expected_branch !== undefined && currentBranch !== opts.expected_branch;
        if (headMismatch || branchMismatch) {
            const now = new Date().toISOString();
            const iso = now.replace(/[:.]/g, '-');
            const gateDir = path.join(opts.workingDir, 'gate');
            await fs.promises.mkdir(gateDir, { recursive: true });
            await fs.promises.writeFile(path.join(gateDir, `workingdir_drift_${iso}.md`), `# Working Directory Drift\n\nDetected at: ${now}\n\nExpected HEAD: ${opts.expected_head ?? '(any)'}\nCurrent HEAD: ${currentHead}\nExpected branch: ${opts.expected_branch ?? '(any)'}\nCurrent branch: ${currentBranch}\n`);
            emit('gate_workingdir_drift_detected', {
                expected_head: opts.expected_head,
                current_head: currentHead,
                expected_branch: opts.expected_branch,
                current_branch: currentBranch,
            });
            const driftResult = {
                status: 'red',
                failures: [{
                        check: 'tests',
                        file: '<workingdir-drift>',
                        line: 0,
                        ruleOrCode: 'GATE_WORKINGDIR_DRIFT',
                        message: `Working directory drift: expected branch "${opts.expected_branch ?? '(any)'}", got "${currentBranch}"; expected HEAD "${opts.expected_head ?? '(any)'}", got "${currentHead}"`,
                        severity: 'error',
                        occurrence_index: 0,
                    }],
                baseline_used: false,
                allowed_paths_used: allowedPathsUsed,
                elapsed_ms: Date.now() - start,
                total_raw_failure_count: 1,
                new_failures_vs_baseline: 0,
            };
            return finalize(driftResult);
        }
    }
    const totalDeadline = Date.now() + (opts._timeouts?.total ?? GATE_TOTAL_TIMEOUT_MS);
    const allFailures = [];
    outerLoop: for (const dir of targetDirs) {
        for (const check of opts.checks) {
            const remaining = totalDeadline - Date.now();
            if (remaining <= 0) {
                allFailures.push({
                    check,
                    file: '<timeout>',
                    line: 0,
                    ruleOrCode: 'GATE_CHECK_TIMEOUT',
                    message: `cumulative gate timeout exceeded`,
                    severity: 'error',
                    occurrence_index: 0,
                });
                break outerLoop;
            }
            const cmdKey = CHECK_KEY_MAP[check];
            const cmd = cmdMap[cmdKey];
            if (!cmd)
                continue;
            if (check === 'tests' && (projectType === 'pnpm' || projectType === 'npm' || projectType === 'yarn')) {
                const pkgJsonPath = path.join(dir, 'package.json');
                let scriptContent = '';
                try {
                    const raw = await fs.promises.readFile(pkgJsonPath, 'utf-8');
                    scriptContent = JSON.parse(raw).scripts?.test ?? '';
                }
                catch { /* file absent or unreadable — leave scriptContent empty */ }
                if (UNSAFE_TEST_SCRIPT_REGEX.test(scriptContent)) {
                    emit('gate_unsafe_test_command_blocked', { script: scriptContent });
                    continue;
                }
                if (!SAFE_TEST_RUNNER_REGEX.test(scriptContent)) {
                    continue;
                }
            }
            const perCheckMs = opts._timeouts?.perCheck?.[check] ?? PER_CHECK_TIMEOUT_MS[check];
            const effectiveMs = Math.min(perCheckMs, remaining);
            const checkPromise = runCheckCommand(cmd, dir, effectiveMs);
            let timeoutHandle;
            const timeoutPromise = new Promise((_, rej) => {
                timeoutHandle = setTimeout(() => rej(new GateTimeoutError(check, effectiveMs)), effectiveMs);
            });
            try {
                const result = await Promise.race([checkPromise, timeoutPromise]);
                clearTimeout(timeoutHandle);
                allFailures.push(...buildFailures(result, check, dir));
            }
            catch (err) {
                clearTimeout(timeoutHandle);
                if (err instanceof GateTimeoutError) {
                    // Drain the losing race so node doesn't crash on unhandledRejection,
                    // but keep the diagnostic so a wedged child surfaces in the activity log.
                    checkPromise.catch((raceErr) => {
                        const msg = raceErr instanceof Error ? raceErr.message : String(raceErr);
                        emit('gate_check_promise_lost', { check, message: msg });
                    });
                    allFailures.push({
                        check,
                        file: '<timeout>',
                        line: 0,
                        ruleOrCode: 'GATE_CHECK_TIMEOUT',
                        message: `${check} timed out after ${effectiveMs}ms`,
                        severity: 'error',
                        occurrence_index: 0,
                    });
                }
                else {
                    throw err;
                }
            }
        }
    }
    const flakeGlobs = opts.settings?.convergence_gate?.known_flake_files ?? [];
    const { real: realFailures, flake: flakeFailures } = applyFlakeFilter(allFailures, opts.workingDir, flakeGlobs);
    if (opts.mode === 'baseline' && opts.baselinePath) {
        const withIndices = assignOccurrenceIndices(realFailures);
        const lockKey = `gate-${createHash('sha256').update(opts.workingDir).digest('hex')}`;
        const lockMs = opts._timeouts?.lockMs ?? GATE_LOCK_TIMEOUT_MS;
        try {
            return finalize(await withLock(lockKey, { timeout_ms: lockMs }, async () => {
                emit('gate_lock_acquired', { lock_key: lockKey });
                const baselineExists = await fs.promises.access(opts.baselinePath).then(() => true, () => false);
                if (!baselineExists) {
                    const baseline = {
                        schema_version: 1,
                        captured_at: new Date().toISOString(),
                        working_dir: opts.workingDir,
                        // 'bun' and other low-confidence types are filtered by !cmdMap above, so this cast is safe
                        project_type: projectType,
                        checks: opts.checks,
                        failures: withIndices,
                    };
                    await fs.promises.mkdir(path.dirname(opts.baselinePath), { recursive: true });
                    writeStateFile(opts.baselinePath, baseline);
                    emit('gate_baseline_captured', { path: opts.baselinePath, failure_count: withIndices.length });
                    emit('gate_preexisting_tests_baselined', { failure_count: withIndices.length });
                    return {
                        status: 'green',
                        failures: [],
                        baseline_used: false,
                        allowed_paths_used: allowedPathsUsed,
                        elapsed_ms: Date.now() - start,
                        total_raw_failure_count: withIndices.length,
                        new_failures_vs_baseline: 0,
                    };
                }
                const baseline = loadBaselineFile(opts.baselinePath);
                const newFailures = subtractBaseline(withIndices, baseline);
                return {
                    status: newFailures.length === 0 ? 'green' : 'red',
                    failures: newFailures,
                    baseline_used: true,
                    allowed_paths_used: allowedPathsUsed,
                    elapsed_ms: Date.now() - start,
                    total_raw_failure_count: withIndices.length,
                    new_failures_vs_baseline: newFailures.length,
                };
            }));
        }
        catch (err) {
            if (err instanceof LockError) {
                emit('gate_lock_timeout', { lock_key: lockKey, waited_ms: err.waited_ms ?? lockMs });
                const lockTimeoutResult = {
                    status: 'red',
                    failures: [{
                            check: 'tests',
                            file: '<lock-timeout>',
                            line: 0,
                            ruleOrCode: 'GATE_LOCK_TIMEOUT',
                            message: `baseline lock timeout after ${err.waited_ms ?? lockMs}ms`,
                            severity: 'error',
                            occurrence_index: 0,
                        }],
                    baseline_used: false,
                    allowed_paths_used: allowedPathsUsed,
                    elapsed_ms: Date.now() - start,
                    total_raw_failure_count: 0,
                    new_failures_vs_baseline: 0,
                };
                return finalize(lockTimeoutResult);
            }
            throw err;
        }
    }
    if (realFailures.length === 0 && flakeFailures.length > 0) {
        const now = new Date().toISOString();
        const iso = now.replace(/[:.]/g, '-');
        const gateDir = path.join(opts.workingDir, 'gate');
        await fs.promises.mkdir(gateDir, { recursive: true });
        await fs.promises.writeFile(path.join(gateDir, `known_flake_failures_${iso}.md`), `# Known Flake Failures\n\nCaptured: ${now}\n\n${flakeFailures.map(f => `- \`${f.file}\` [${f.check}]: ${f.message.slice(0, 200)}`).join('\n')}\n`);
        emit('gate_out_of_scope_failures_present', { flake_count: flakeFailures.length, paths: flakeFailures.map(f => f.file) });
        return finalize({
            status: 'green-with-known-flake-warnings',
            failures: [],
            baseline_used: false,
            allowed_paths_used: allowedPathsUsed,
            elapsed_ms: Date.now() - start,
            total_raw_failure_count: allFailures.length,
            new_failures_vs_baseline: 0,
        });
    }
    const status = realFailures.length === 0 ? 'green' : 'red';
    if (status === 'red') {
        emit('gate_regression_threshold_warning', { failure_count: realFailures.length });
    }
    return finalize({
        status,
        failures: realFailures,
        baseline_used: false,
        allowed_paths_used: allowedPathsUsed,
        elapsed_ms: Date.now() - start,
        total_raw_failure_count: allFailures.length,
        new_failures_vs_baseline: 0,
    });
}

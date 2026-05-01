#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { printMinimalPanel, Style, getExtensionRoot, getDataRoot, withRetryLock, pruneOldSessions, safeErrorMessage, findSessionPathForCwd, formatLocalDateKey } from '../services/pickle-utils.js';
import { getHeadSha } from '../services/git-utils.js';
import { Defaults, LockError, BACKENDS, STATE_MANAGER_DEFAULTS } from '../types/index.js';
import { StateManager, assertSchemaVersionDeployParity, SchemaVersionDeployDriftError } from '../services/state-manager.js';
import { logActivity, pruneActivity } from '../services/activity-logger.js';
import { readRecoverableJsonObject } from '../services/microverse-state.js';
const sm = new StateManager();
const VALID_EFFORTS = ['low', 'medium', 'high'];
// AC-LPB-01: hard-coded fallback throughput baselines used when
// pickle_settings.json is missing or doesn't declare `throughput_baselines`.
const DEFAULT_THROUGHPUT_BASELINES = {
    claude: 5.0,
    codex: 3.5,
    deepseek: 4.0,
};
function die(message) {
    console.error(`${Style.RED}❌ Error: ${message}${Style.RESET}`);
    process.exit(1);
}
function resolveWorkingDirOrNull(value) {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim();
    if (!trimmed)
        return null;
    return path.resolve(trimmed);
}
function buildSetupPaths() {
    const dataDir = getDataRoot();
    return {
        rootDir: getExtensionRoot(),
        dataDir,
        sessionsRoot: path.join(dataDir, 'sessions'),
        jarRoot: path.join(dataDir, 'jar'),
        worktreesRoot: path.join(dataDir, 'worktrees'),
        sessionsMap: path.join(dataDir, 'current_sessions.json'),
    };
}
function createSetupConfig() {
    return {
        loopLimit: 100,
        timeLimit: 720,
        workerTimeout: Defaults.WORKER_TIMEOUT_SECONDS,
        promiseToken: null,
        resumeMode: false,
        resumePath: null,
        resetMode: false,
        pausedMode: false,
        tmuxMode: false,
        minIterations: 0,
        commandTemplate: undefined,
        chainMeeseeks: false,
        backend: undefined,
        teamsMode: false,
        maxParallel: 5,
        effort: undefined,
        prdPath: undefined,
        task: undefined,
        taskArgs: [],
        explicitFlags: new Set(),
        startEpoch: Math.floor(Date.now() / 1000),
        iterationBudgetPerBackend: null,
        throughputBaselines: null,
        acknowledgeUndersized: false,
    };
}
function applyPositiveIntegerSetting(settings, key, apply) {
    const value = settings[key];
    if (typeof value === 'number' && Number.isInteger(value) && value > 0)
        apply(value);
}
function readIterationBudgetPerBackend(settings) {
    const rawPerBackend = settings.iteration_budget_per_backend;
    if (!rawPerBackend || typeof rawPerBackend !== 'object' || Array.isArray(rawPerBackend))
        return null;
    const map = {};
    for (const backend of BACKENDS) {
        const value = rawPerBackend[backend];
        if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
            map[backend] = value;
        }
    }
    return Object.keys(map).length > 0 ? map : null;
}
/**
 * AC-LPB-02: parse `throughput_baselines` from pickle_settings.json. Values
 * are tickets/hour (positive finite numbers). Backend keys are arbitrary
 * strings (claude/codex/deepseek/…) so this stays open for new backends.
 */
function readThroughputBaselines(settings) {
    const raw = settings.throughput_baselines;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return null;
    const map = {};
    for (const [key, value] of Object.entries(raw)) {
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
            map[key] = value;
        }
    }
    return Object.keys(map).length > 0 ? map : null;
}
/**
 * AC-LPB-01: count tickets in the session's decomposition_manifest.json. Returns
 * 0 when the manifest is missing or malformed — caller treats 0 as "no sizing
 * data, skip the warning".
 */
export function countManifestTickets(sessionDir) {
    const manifestPath = path.join(sessionDir, 'decomposition_manifest.json');
    if (!fs.existsSync(manifestPath))
        return 0;
    try {
        const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        if (parsed && typeof parsed === 'object' && Array.isArray(parsed.tickets)) {
            return parsed.tickets.length;
        }
    }
    catch {
        /* malformed — treat as no data */
    }
    return 0;
}
/**
 * AC-LPB-01: warn when `--max-time` is undersized for the planned ticket count
 * given the backend's throughput baseline. Always returns; never blocks launch.
 *
 *   expected_minutes = (ticket_count / throughput) * 60
 *   warn iff max_time > 0 AND max_time < expected * 0.8
 *
 * --acknowledge-undersized silences the warning (CI use). Both the warning
 * header and the recommended budget are computed here so the message wording
 * stays in sync with the threshold logic.
 */
export function evaluateLaunchSizing(sessionDir, config, emit = (msg) => process.stderr.write(msg)) {
    const ticketCount = countManifestTickets(sessionDir);
    if (ticketCount <= 0)
        return null;
    if (!config.timeLimit || config.timeLimit <= 0)
        return null; // 0/unlimited — no sizing concern
    const baselines = config.throughputBaselines ?? DEFAULT_THROUGHPUT_BASELINES;
    const backend = config.backend || 'claude';
    const throughput = baselines[backend] ?? DEFAULT_THROUGHPUT_BASELINES[backend] ?? DEFAULT_THROUGHPUT_BASELINES.claude;
    const expectedMinutes = Math.ceil((ticketCount / throughput) * 60);
    const recommendedMinutes = Math.ceil(expectedMinutes * 1.25);
    const undersized = config.timeLimit < expectedMinutes * 0.8;
    if (!undersized)
        return null;
    if (config.acknowledgeUndersized) {
        return { warned: false, ticketCount, expectedMinutes, recommendedMinutes, throughput, backend };
    }
    emit(`⚠️  --max-time=${config.timeLimit}m may be undersized for ${ticketCount} tickets at ${throughput} t/h on ${backend}\n` +
        `   Estimated wall: ${expectedMinutes}m. Consider --max-time=${recommendedMinutes}m.\n` +
        `   Pass --acknowledge-undersized to proceed.\n`);
    return { warned: true, ticketCount, expectedMinutes, recommendedMinutes, throughput, backend };
}
function updateSessionMap(sessionsMap, cwd, sessionPath) {
    withRetryLock(sessionsMap + '.lock', () => {
        let map = {};
        try {
            const recovered = readRecoverableJsonObject(sessionsMap);
            if (recovered)
                map = recovered;
        }
        catch {
            /* ignore */
        }
        map[cwd] = { sessionPath, pid: process.pid };
        const tmpMap = sessionsMap + `.tmp.${process.pid}.${Date.now()}`;
        try {
            fs.writeFileSync(tmpMap, JSON.stringify(map, null, 2));
            fs.renameSync(tmpMap, sessionsMap);
        }
        catch (err) {
            try {
                fs.unlinkSync(tmpMap);
            }
            catch { /* cleanup best-effort */ }
            throw err;
        }
    });
}
function ensureCoreDirectories(paths) {
    [paths.sessionsRoot, paths.jarRoot, paths.worktreesRoot].forEach((dir) => {
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
    });
}
function loadSettings(config, rootDir) {
    const settingsFile = path.join(rootDir, 'pickle_settings.json');
    if (!fs.existsSync(settingsFile))
        return;
    try {
        const settings = readRecoverableJsonObject(settingsFile);
        if (!settings)
            return;
        applyPositiveIntegerSetting(settings, 'default_max_iterations', value => { config.loopLimit = value; });
        applyPositiveIntegerSetting(settings, 'default_max_time_minutes', value => { config.timeLimit = value; });
        applyPositiveIntegerSetting(settings, 'default_worker_timeout_seconds', value => { config.workerTimeout = value; });
        config.iterationBudgetPerBackend = readIterationBudgetPerBackend(settings);
        config.throughputBaselines = readThroughputBaselines(settings);
    }
    catch (err) {
        const msg = safeErrorMessage(err);
        console.error(`Warning: could not parse pickle_settings.json — using defaults: ${msg}`);
    }
}
function parseCodexVersion(output) {
    const match = output.match(/\b(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?\b/);
    if (!match)
        return null;
    const rawMajor = Number(match[1]);
    const rawMinor = Number(match[2]);
    const rawPatch = Number(match[3]);
    const major = Number.isFinite(rawMajor) ? rawMajor : -1;
    const minor = Number.isFinite(rawMinor) ? rawMinor : -1;
    const patch = Number.isFinite(rawPatch) ? rawPatch : -1;
    if (!Number.isInteger(major) || !Number.isInteger(minor) || !Number.isInteger(patch))
        return null;
    return { major, minor, patch, version: `${match[1]}.${match[2]}.${match[3]}` };
}
function compareVersion(left, right) {
    if (left.major !== right.major)
        return left.major - right.major;
    if (left.minor !== right.minor)
        return left.minor - right.minor;
    return left.patch - right.patch;
}
function caretUpperBound(minimum) {
    if (minimum.major > 0)
        return { major: minimum.major + 1, minor: 0, patch: 0, version: `${minimum.major + 1}.0.0` };
    if (minimum.minor > 0)
        return { major: 0, minor: minimum.minor + 1, patch: 0, version: `0.${minimum.minor + 1}.0` };
    return { major: 0, minor: 0, patch: minimum.patch + 1, version: `0.0.${minimum.patch + 1}` };
}
export function codexVersionSatisfiesRange(versionOutput, range) {
    const actual = parseCodexVersion(versionOutput);
    if (!actual)
        return false;
    const caret = range.match(/^\^(\d+\.\d+\.\d+)$/);
    if (!caret)
        return actual.version === range;
    const minimum = parseCodexVersion(caret[1]);
    if (!minimum)
        return false;
    return compareVersion(actual, minimum) >= 0 && compareVersion(actual, caretUpperBound(minimum)) < 0;
}
function readCodexEngineRange(extensionRoot) {
    const configuredPath = path.join(extensionRoot, 'extension', 'package.json');
    const packageJsonPath = fs.existsSync(configuredPath)
        ? configuredPath
        : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../package.json');
    let packageJson;
    try {
        packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    }
    catch (err) {
        die(`Could not read extension/package.json for codex backend smoke check: ${safeErrorMessage(err)}`);
    }
    const range = packageJson.engines?.codex;
    if (typeof range !== 'string' || range.trim() === '') {
        die('extension/package.json is missing engines.codex for codex backend smoke check');
    }
    return range.trim();
}
function readCodexVersion() {
    try {
        return execFileSync('codex', ['--version'], {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 10_000,
        }).trim();
    }
    catch (err) {
        die(`codex --version failed during codex backend smoke check: ${safeErrorMessage(err)}`);
    }
}
export function resolveCodexVersionForSetup(backend, extensionRoot = getExtensionRoot()) {
    if ((backend || 'claude') !== 'codex')
        return null;
    const versionOutput = readCodexVersion();
    const range = readCodexEngineRange(extensionRoot);
    if (!codexVersionSatisfiesRange(versionOutput, range)) {
        die(`codex version mismatch: codex --version returned "${versionOutput}", expected engines.codex "${range}"`);
    }
    return versionOutput;
}
/**
 * Apply the per-backend iteration budget AFTER CLI parsing, so we know which
 * backend was selected. Resolution order:
 *   1. Explicit --max-iterations CLI flag wins (already in config.loopLimit).
 *   2. iteration_budget_per_backend[backend] if present.
 *   3. default_max_iterations (already in config.loopLimit from loadSettings).
 *   4. Hard-coded 100 fallback (config default).
 *
 * Backend defaults to 'claude' when --backend is not passed (matches the
 * activation panel's `config.backend || 'claude'` rendering).
 */
function applyPerBackendBudget(config) {
    if (config.explicitFlags.has('max-iterations'))
        return;
    if (!config.iterationBudgetPerBackend)
        return;
    const backend = config.backend || 'claude';
    const perBackend = config.iterationBudgetPerBackend[backend];
    if (typeof perBackend === 'number' && Number.isInteger(perBackend) && perBackend >= 0) {
        config.loopLimit = perBackend;
    }
}
function parseIntegerFlag(args, index, flag, validate, errorMessage) {
    const raw = args[index + 1];
    const value = Number(raw);
    if (raw === undefined || raw.startsWith('--') || !Number.isInteger(value) || !validate(value))
        die(errorMessage);
    return value;
}
const ARG_HANDLERS = {
    '--max-iterations': (config, args, index) => {
        config.loopLimit = parseIntegerFlag(args, index, '--max-iterations', value => value >= 0, '--max-iterations requires a non-negative integer');
        config.explicitFlags.add('max-iterations');
        return index + 1;
    },
    '--max-time': (config, args, index) => {
        config.timeLimit = parseIntegerFlag(args, index, '--max-time', value => value >= 0, '--max-time requires a non-negative integer');
        config.explicitFlags.add('max-time');
        return index + 1;
    },
    '--worker-timeout': (config, args, index) => {
        config.workerTimeout = parseIntegerFlag(args, index, '--worker-timeout', value => value > 0, '--worker-timeout requires a positive integer');
        config.explicitFlags.add('worker-timeout');
        return index + 1;
    },
    '--completion-promise': (config, args, index) => {
        const value = args[index + 1];
        if (!value || value.startsWith('--'))
            die('--completion-promise requires a non-empty value');
        config.promiseToken = value;
        return index + 1;
    },
    '--resume': (config, args, index) => {
        config.resumeMode = true;
        if (args[index + 1] && !args[index + 1].startsWith('--')) {
            config.resumePath = args[index + 1];
            return index + 1;
        }
        return index;
    },
    '--reset': (config, _args, index) => {
        config.resetMode = true;
        return index;
    },
    '--paused': (config, _args, index) => {
        config.pausedMode = true;
        return index;
    },
    '--tmux': (config, _args, index) => {
        config.tmuxMode = true;
        return index;
    },
    '--task': (config, args, index) => {
        if (index + 1 < args.length)
            config.taskArgs.push(args[index + 1]);
        return index + 1;
    },
    '--min-iterations': (config, args, index) => {
        config.minIterations = parseIntegerFlag(args, index, '--min-iterations', value => value >= 0, '--min-iterations requires a non-negative integer');
        config.explicitFlags.add('min-iterations');
        return index + 1;
    },
    '--command-template': (config, args, index) => {
        const value = args[index + 1];
        if (!value || value.startsWith('--'))
            die('--command-template requires a non-empty value');
        if (value.includes('/') || value.includes('\\') || value.includes('..'))
            die('--command-template must be a plain filename');
        config.commandTemplate = value;
        config.explicitFlags.add('command-template');
        return index + 1;
    },
    '--chain-meeseeks': (config, _args, index) => {
        config.chainMeeseeks = true;
        return index;
    },
    '--backend': (config, args, index) => {
        const value = args[index + 1];
        if (!value || value.startsWith('--'))
            die('--backend requires a value (claude|codex)');
        if (!BACKENDS.includes(value)) {
            die(`--backend must be one of: ${BACKENDS.join(', ')}`);
        }
        config.backend = value;
        config.explicitFlags.add('backend');
        return index + 1;
    },
    '--teams': (config, _args, index) => {
        config.teamsMode = true;
        config.explicitFlags.add('teams');
        return index;
    },
    '--max-parallel': (config, args, index) => {
        const raw = args[index + 1];
        if (!raw || raw.startsWith('--'))
            die('--max-parallel requires a positive integer value (>= 1)');
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 1)
            die('--max-parallel requires a positive integer (>= 1)');
        config.maxParallel = value;
        config.explicitFlags.add('max-parallel');
        return index + 1;
    },
    '--effort': (config, args, index) => {
        const value = args[index + 1];
        if (!value || value.startsWith('--'))
            die(`--effort requires a value (${VALID_EFFORTS.join('|')})`);
        if (!VALID_EFFORTS.includes(value)) {
            die(`--effort must be one of: ${VALID_EFFORTS.join(', ')}`);
        }
        config.effort = value;
        config.explicitFlags.add('effort');
        return index + 1;
    },
    '--acknowledge-undersized': (config, _args, index) => {
        config.acknowledgeUndersized = true;
        config.explicitFlags.add('acknowledge-undersized');
        return index;
    },
    '-s': (_config, args, index) => (args[index + 1] && !args[index + 1].startsWith('--') ? index + 1 : index),
    '--session-id': (_config, args, index) => (args[index + 1] && !args[index + 1].startsWith('--') ? index + 1 : index),
};
function parseCommandLine(config, args) {
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const handler = ARG_HANDLERS[arg];
        if (!handler) {
            config.taskArgs.push(arg);
            continue;
        }
        i = handler(config, args, i);
    }
    config.task = config.taskArgs.join(' ').trim() || undefined;
    config.prdPath = resolvePrdPath(config.taskArgs);
}
function isMarkdownPrd(candidate) {
    const base = path.basename(candidate).toLowerCase();
    return base.endsWith('.md') && (base === 'prd.md' || candidate.toLowerCase().includes('prd'));
}
function resolveExistingPrdPath(candidate) {
    const cleaned = candidate.trim().replace(/^["'`(<]+|[)"'`,>]+$/g, '');
    if (!cleaned || !isMarkdownPrd(cleaned))
        return undefined;
    const resolved = path.resolve(cleaned);
    try {
        return fs.statSync(resolved).isFile() ? resolved : undefined;
    }
    catch {
        return undefined;
    }
}
function resolvePrdPath(taskArgs) {
    for (const arg of taskArgs) {
        const exact = resolveExistingPrdPath(arg);
        if (exact)
            return exact;
    }
    for (const arg of taskArgs) {
        for (const token of arg.split(/\s+/)) {
            const resolved = resolveExistingPrdPath(token);
            if (resolved)
                return resolved;
        }
    }
    return resolveExistingPrdPath('prd.md') ?? resolveExistingPrdPath('PRD.md');
}
function resolveStartCommit() {
    try {
        return getHeadSha(process.cwd());
    }
    catch {
        return undefined;
    }
}
function validateCommandLine(config) {
    if (config.explicitFlags.has('max-parallel') && !config.teamsMode) {
        die('--max-parallel requires --teams');
    }
    if (config.teamsMode && config.backend === 'codex') {
        die('--teams is incompatible with --backend codex (claude backend only)');
    }
}
function validateResumeCompatibility(preState, config) {
    const resumeWorkingDir = resolveWorkingDirOrNull(preState.working_dir);
    const currentWorkingDir = path.resolve(process.cwd());
    if (resumeWorkingDir && resumeWorkingDir !== currentWorkingDir) {
        die(`--resume session belongs to ${resumeWorkingDir}, not ${currentWorkingDir}. Refusing cross-repo resume.`);
    }
    const willHaveTeams = config.explicitFlags.has('teams') ? config.teamsMode : preState.teams_mode === true;
    const willHaveBackend = config.explicitFlags.has('backend') ? config.backend : preState.backend;
    if (willHaveTeams && willHaveBackend === 'codex') {
        die('--teams is incompatible with --backend codex (claude backend only). Resume would create a conflicting state — refusing to continue.');
    }
}
function applyResumeConfig(s, config, fullSessionPath, codexVersionSeen) {
    s.active = !config.pausedMode;
    if (config.resetMode) {
        s.iteration = 0;
        s.start_time_epoch = config.startEpoch;
    }
    // AC-LPB-05: when a session is reconstructed (resumed from crash/pause),
    // start_time_epoch must reset to the resume time so the wall-clock cap-check
    // doesn't subtract from a stale launch baseline. The reset is intentional
    // even without --reset because resume IS reconstruction. The activity event
    // is emitted by the caller (resumeSession) so we can compare original vs new.
    if (!config.resetMode) {
        s.start_time_epoch = config.startEpoch;
    }
    applyResumeLimitConfig(s, config);
    applyResumeModeConfig(s, config);
    if (codexVersionSeen)
        s.codex_version_seen = codexVersionSeen;
    s.session_dir = fullSessionPath;
}
function applyResumeLimitConfig(s, config) {
    if (config.explicitFlags.has('max-iterations'))
        s.max_iterations = config.loopLimit;
    if (config.explicitFlags.has('max-time'))
        s.max_time_minutes = config.timeLimit;
    if (config.explicitFlags.has('worker-timeout'))
        s.worker_timeout_seconds = config.workerTimeout;
    if (config.promiseToken)
        s.completion_promise = config.promiseToken;
    if (config.explicitFlags.has('min-iterations'))
        s.min_iterations = config.minIterations;
}
function applyResumeModeConfig(s, config) {
    if (config.explicitFlags.has('command-template'))
        s.command_template = config.commandTemplate;
    if (config.tmuxMode)
        s.tmux_mode = true;
    if (config.chainMeeseeks)
        s.chain_meeseeks = true;
    if (config.explicitFlags.has('backend') && config.backend)
        s.backend = config.backend;
    if (config.explicitFlags.has('teams'))
        s.teams_mode = config.teamsMode;
    if (config.explicitFlags.has('max-parallel'))
        s.max_parallel = config.maxParallel;
    if (config.explicitFlags.has('effort'))
        s.effort = config.effort;
}
function syncConfigFromState(config, state) {
    const rawLoopLimit = Number(state.max_iterations);
    config.loopLimit = Number.isFinite(rawLoopLimit) ? rawLoopLimit : config.loopLimit;
    const rawTimeLimit = Number(state.max_time_minutes);
    config.timeLimit = Number.isFinite(rawTimeLimit) ? rawTimeLimit : config.timeLimit;
    const rawWorkerTimeout = Number(state.worker_timeout_seconds);
    config.workerTimeout = Number.isFinite(rawWorkerTimeout) && rawWorkerTimeout > 0 ? rawWorkerTimeout : config.workerTimeout;
    const rawMinIter = Number(state.min_iterations);
    config.minIterations = Number.isFinite(rawMinIter) ? rawMinIter : 0;
    config.commandTemplate = state.command_template;
    config.chainMeeseeks = state.chain_meeseeks === true;
    if (state.backend && BACKENDS.includes(state.backend))
        config.backend = state.backend;
    config.teamsMode = state.teams_mode === true;
    const rawMaxParallel = Number(state.max_parallel);
    config.maxParallel = Number.isFinite(rawMaxParallel) && Number.isInteger(rawMaxParallel) && rawMaxParallel >= 1
        ? rawMaxParallel
        : config.maxParallel;
    if (typeof state.effort === 'string' && VALID_EFFORTS.includes(state.effort)) {
        config.effort = state.effort;
    }
    config.promiseToken = state.completion_promise;
}
function resumeSession(config) {
    const fullSessionPath = config.resumePath
        ? resolvePath(config.resumePath)
        : findSessionPathForCwd(process.cwd());
    if (!fullSessionPath || !fs.existsSync(fullSessionPath)) {
        die(`No active session found or path invalid: ${fullSessionPath}`);
    }
    const statePath = path.join(fullSessionPath, 'state.json');
    let preState = null;
    try {
        preState = sm.read(statePath);
    }
    catch {
        /* missing/corrupt — sm.update below will surface the right error */
    }
    if (preState)
        validateResumeCompatibility(preState, config);
    let state;
    const resumeBackend = config.explicitFlags.has('backend') ? config.backend : preState?.backend;
    const codexVersionSeen = resolveCodexVersionForSetup(resumeBackend);
    // AC-LPB-05: capture the pre-resume epoch so we can emit the
    // session_reconstructed_epoch_reset activity event with both timestamps.
    const originalEpoch = typeof preState?.start_time_epoch === 'number' ? preState.start_time_epoch : null;
    try {
        state = sm.update(statePath, s => {
            applyResumeConfig(s, config, fullSessionPath, codexVersionSeen);
        });
    }
    catch {
        die(`state.json is missing or corrupt in ${fullSessionPath}`);
    }
    // AC-LPB-05: emit activity event so monitor/standup/metrics consumers can
    // distinguish a fresh launch from a reconstructed-after-crash run. Best-effort —
    // a logging failure should not abort an otherwise-valid resume.
    if (originalEpoch !== null && state.start_time_epoch !== originalEpoch) {
        try {
            logActivity({
                event: 'session_reconstructed_epoch_reset',
                source: 'pickle',
                session: path.basename(fullSessionPath),
                original_epoch: originalEpoch,
                new_epoch: state.start_time_epoch,
            });
        }
        catch { /* ignore — telemetry should not block resume */ }
    }
    syncConfigFromState(config, state);
    return {
        sessionRoot: fullSessionPath,
        state,
    };
}
function resolveTask(config) {
    const taskStr = config.taskArgs.join(' ').trim();
    if (config.resumeMode)
        return taskStr;
    if (!taskStr && !config.pausedMode)
        die('No task specified. Run /pickle --help for usage.');
    if (!taskStr)
        return 'PRD Interview (task to be determined via interview)';
    return taskStr;
}
function createInitialState(config, sessionPath, taskStr) {
    const codexVersionSeen = resolveCodexVersionForSetup(config.backend);
    const state = {
        active: !config.pausedMode && !config.tmuxMode,
        working_dir: process.cwd(),
        step: 'prd',
        iteration: 0,
        max_iterations: config.loopLimit,
        max_time_minutes: config.timeLimit,
        worker_timeout_seconds: config.workerTimeout,
        start_time_epoch: config.startEpoch,
        completion_promise: config.promiseToken,
        original_prompt: taskStr,
        current_ticket: null,
        history: [],
        started_at: new Date().toISOString(),
        session_dir: sessionPath,
        tmux_mode: config.tmuxMode,
        min_iterations: config.minIterations,
        command_template: config.commandTemplate,
        chain_meeseeks: config.chainMeeseeks,
        schema_version: STATE_MANAGER_DEFAULTS.schemaVersion,
        backend: config.backend,
        teams_mode: config.teamsMode || undefined,
        max_parallel: config.teamsMode ? config.maxParallel : undefined,
        effort: config.effort,
        archaeology: null,
        tickets_version: 0,
        last_course_correction: null,
        phase_personas_active: false,
        flags: {},
        readiness: { cycle_history: [] },
        codex_version_seen: codexVersionSeen,
    };
    const startCommit = resolveStartCommit();
    if (config.prdPath)
        state.prd_path = config.prdPath;
    if (startCommit)
        state.start_commit = startCommit;
    return state;
}
function createSession(config, paths, taskStr) {
    const today = formatLocalDateKey(new Date());
    const hash = crypto.randomBytes(4).toString('hex');
    const sessionId = `${today}-${hash}`;
    const fullSessionPath = path.join(paths.sessionsRoot, sessionId);
    if (!fs.existsSync(fullSessionPath))
        fs.mkdirSync(fullSessionPath, { recursive: true });
    const state = createInitialState(config, fullSessionPath, taskStr);
    // eslint-disable-next-line pickle/no-raw-state-write -- initial creation: no existing state to lock against
    sm.forceWrite(path.join(fullSessionPath, 'state.json'), state);
    try {
        pruneActivity();
    }
    catch { /* must not block session start */ }
    logActivity({ event: 'session_start', source: 'pickle', session: sessionId, mode: config.tmuxMode ? 'tmux' : 'inline', original_prompt: taskStr });
    return { sessionRoot: fullSessionPath, state };
}
function printActivationPanel(paths, config, fullSessionPath, currentIteration) {
    printMinimalPanel('Pickle Rick Activated!', {
        Iteration: currentIteration,
        Limit: config.loopLimit > 0 ? config.loopLimit : '∞',
        'Max Time': config.timeLimit > 0 ? `${config.timeLimit}m` : '∞',
        'Worker TO': `${config.workerTimeout}s`,
        Promise: config.promiseToken || 'None',
        ...(config.minIterations > 0 ? { 'Min Passes': config.minIterations } : {}),
        ...(config.commandTemplate ? { Template: config.commandTemplate } : {}),
        ...(config.chainMeeseeks ? { 'Chain Meeseeks': 'Yes' } : {}),
        Backend: config.backend || 'claude',
        ...(config.effort ? { Effort: config.effort } : {}),
        ...(config.teamsMode ? { Teams: `Yes (parallel: ${config.maxParallel})` } : {}),
        Extension: paths.rootDir,
        Data: paths.dataDir,
        Path: fullSessionPath,
    }, 'GREEN', '🥒');
}
export function parseArguments(argv) {
    const paths = buildSetupPaths();
    const config = createSetupConfig();
    loadSettings(config, paths.rootDir);
    parseCommandLine(config, argv);
    validateCommandLine(config);
    applyPerBackendBudget(config);
    return config;
}
export function handleResumeSession(args) {
    const session = resumeSession(args);
    return { sessionRoot: session.sessionRoot, state: session.state };
}
export function initializeNewSession(args) {
    const paths = buildSetupPaths();
    ensureCoreDirectories(paths);
    const taskStr = resolveTask(args);
    const session = createSession(args, paths, taskStr);
    return { sessionRoot: session.sessionRoot, state: session.state };
}
export function displaySetupSummary(session) {
    const paths = buildSetupPaths();
    const config = createSetupConfig();
    syncConfigFromState(config, session.state);
    printActivationPanel(paths, config, session.sessionRoot, (Number(session.state.iteration) || 0) + 1);
    // Machine-readable line for reliable parsing even when ANSI codes are present
    process.stdout.write(`SESSION_ROOT=${session.sessionRoot}\n`);
    if (config.promiseToken) {
        console.log(`
${Style.YELLOW}⚠️  STRICT EXIT CONDITION ACTIVE${Style.RESET}`);
        console.log(`   You must output: <promise>${config.promiseToken}</promise>
`);
    }
}
async function main() {
    try {
        assertSchemaVersionDeployParity();
    }
    catch (err) {
        if (err instanceof SchemaVersionDeployDriftError) {
            process.stderr.write(`${safeErrorMessage(err)}\n`);
            process.exit(1);
        }
        throw err;
    }
    const paths = buildSetupPaths();
    ensureCoreDirectories(paths);
    pruneOldSessions(paths.sessionsRoot);
    const args = parseArguments(process.argv.slice(2));
    const session = args.resumeMode
        ? handleResumeSession(args)
        : initializeNewSession(args);
    // AC-LPB-01: warn (don't block) when --max-time is undersized for the planned
    // ticket count. Runs after session resolution so we can read the manifest from
    // the actual session dir. Best-effort; never throws.
    try {
        evaluateLaunchSizing(session.sessionRoot, args);
    }
    catch { /* sizing is advisory */ }
    try {
        updateSessionMap(paths.sessionsMap, process.cwd(), session.sessionRoot);
    }
    catch (err) {
        if (err instanceof LockError) {
            console.error(`[pickle] WARNING: session map not updated — ${safeErrorMessage(err)}`);
        }
        else {
            throw err;
        }
    }
    displaySetupSummary(session);
}
function resolvePath(p) {
    if (p.startsWith('~'))
        return path.join(os.homedir(), p.slice(1));
    return path.resolve(p);
}
if (process.argv[1] && path.basename(process.argv[1]) === 'setup.js') {
    main().catch((err) => die(safeErrorMessage(err)));
}

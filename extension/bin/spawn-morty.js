#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { printMinimalPanel, Style, formatTime, getExtensionRoot, getDataRoot, runCmd, safeErrorMessage, parseTicketFrontmatter, } from '../services/pickle-utils.js';
import { spawn } from 'child_process';
import { PromiseTokens, hasToken, Defaults, hasLifecycleArtifact } from '../types/index.js';
import { updateTicketStatus } from '../services/git-utils.js';
import { buildWorkerInvocation, loadBackendFromSession, backendEnvOverrides } from '../services/backend-spawn.js';
import { scrubForbiddenWorkerTokens } from '../services/promise-tokens.js';
import { StateManager, writeActivityEntry } from '../services/state-manager.js';
import { readRecoverableJsonObject } from '../services/microverse-state.js';
import { loadAgentMd } from '../services/agent-md-loader.js';
const TIER_MODEL_MAP = {
    trivial: 'haiku',
    small: 'sonnet',
    medium: 'sonnet',
    large: 'opus',
};
const sm = new StateManager();
const MIN_TIMEOUT_SECONDS = 30;
const VALID_AGENT_MODELS = new Set(['sonnet', 'opus', 'haiku']);
export function tierToModel(tier) {
    if (!tier)
        return 'sonnet';
    return TIER_MODEL_MAP[tier] ?? 'sonnet';
}
function isAgentModel(value) {
    return typeof value === 'string' && VALID_AGENT_MODELS.has(value);
}
const PHASE_PERSONAS_DISABLED_MESSAGE = '[phase-personas] feature available but disabled (calibration in progress); enable with: pickle settings set bmad_hardening.phase_personas_enabled true OR PICKLE_PHASE_PERSONAS=on';
function readBasePersona(extensionRoot) {
    try {
        const personaPath = path.join(extensionRoot, 'persona.md');
        if (!fs.existsSync(personaPath))
            return '';
        return fs.readFileSync(personaPath, 'utf-8').trim();
    }
    catch {
        return '';
    }
}
function readPhasePersonaEntry(sessionRoot, extensionRoot) {
    try {
        const state = readRecoverableJsonObject(path.join(sessionRoot, 'state.json'));
        const step = state?.step;
        if (!step)
            return null;
        const configPath = path.join(extensionRoot, 'extension', 'data', 'phase-personas.json');
        const config = readRecoverableJsonObject(configPath);
        const rawEntry = config?.[step];
        if (!rawEntry || typeof rawEntry !== 'object')
            return null;
        const entry = rawEntry;
        const subagentType = entry.subagent_type;
        if (typeof subagentType !== 'string' || !subagentType.trim())
            return null;
        return {
            subagent_type: subagentType,
            ...(isAgentModel(entry.model) ? { model: entry.model } : {}),
        };
    }
    catch {
        return null;
    }
}
function readBmadHardeningSettings(extensionRoot) {
    try {
        const settings = readRecoverableJsonObject(path.join(extensionRoot, 'pickle_settings.json'));
        const hardening = settings?.bmad_hardening;
        return hardening && typeof hardening === 'object' && !Array.isArray(hardening)
            ? hardening
            : null;
    }
    catch {
        return null;
    }
}
export function isPhasePersonasEnabled(extensionRoot) {
    const envValue = process.env.PICKLE_PHASE_PERSONAS;
    if (envValue === 'on')
        return true;
    if (envValue === 'off')
        return false;
    const hardening = readBmadHardeningSettings(extensionRoot);
    return hardening?.phase_personas_enabled === true;
}
function hasSeenDisabledPhasePersonas(sessionRoot) {
    try {
        const state = readRecoverableJsonObject(path.join(sessionRoot, 'state.json'));
        return Array.isArray(state?.activity)
            && state.activity.some((entry) => entry.event === 'phase_personas_disabled_seen');
    }
    catch {
        return false;
    }
}
function recordPhasePersonasDisabledSeen(sessionRoot) {
    if (hasSeenDisabledPhasePersonas(sessionRoot))
        return;
    console.log(PHASE_PERSONAS_DISABLED_MESSAGE);
    writeActivityEntry(path.join(sessionRoot, 'state.json'), {
        event: 'phase_personas_disabled_seen',
        ts: new Date().toISOString(),
    });
}
function readActivePersonaBlock(opts) {
    try {
        const entry = readPhasePersonaEntry(opts.sessionRoot, opts.extensionRoot);
        if (!entry)
            return '';
        if (!isPhasePersonasEnabled(opts.extensionRoot)) {
            recordPhasePersonasDisabledSeen(opts.sessionRoot);
            return '';
        }
        const agent = loadAgentMd(entry.subagent_type, { agentsDir: opts.agentsDir });
        if (!agent)
            return '';
        const parts = [readBasePersona(opts.extensionRoot), agent.body.trim()].filter(Boolean);
        return parts.length > 0 ? `\n\n## Active Persona\n${parts.join('\n\n')}` : '';
    }
    catch {
        return '';
    }
}
export function resolvePhasePersonaModel(sessionRoot, extensionRoot) {
    if (!isPhasePersonasEnabled(extensionRoot))
        return undefined;
    return readPhasePersonaEntry(sessionRoot, extensionRoot)?.model;
}
export function resolveWorkerModelFromTierAndPersona(ticketTier, personaModel) {
    if (ticketTier)
        return tierToModel(ticketTier);
    return personaModel ?? 'sonnet';
}
function readProjectContextBlock(sessionRoot) {
    try {
        if (isArchaeologyDisabled(sessionRoot))
            return '';
        const projectContextPath = path.join(sessionRoot, 'project-context.md');
        if (!fs.existsSync(projectContextPath))
            return '';
        const projectContext = fs.readFileSync(projectContextPath, 'utf-8').trim();
        return projectContext ? `\n\n## Project Context\n${projectContext}` : '';
    }
    catch {
        return '';
    }
}
function isArchaeologyDisabled(sessionRoot) {
    try {
        const state = readRecoverableJsonObject(path.join(sessionRoot, 'state.json'));
        return state?.flags?.no_archaeology === true;
    }
    catch {
        return false;
    }
}
function die(message) {
    console.error(message);
    process.exit(1);
}
function requireFlagValue(args, index) {
    const value = args[index + 1];
    if (!value || value.startsWith('--'))
        die('Error: --ticket-id and --ticket-path require non-empty values.');
    return value;
}
function parseTimeoutArg(argv) {
    const timeoutIndex = argv.indexOf('--timeout');
    if (timeoutIndex === -1)
        return Defaults.WORKER_TIMEOUT_SECONDS;
    const rawTimeout = argv[timeoutIndex + 1];
    if (!rawTimeout || !/^[1-9]\d*$/.test(rawTimeout)) {
        die(`Error: --timeout requires a positive integer, got: ${rawTimeout ?? 'missing'}`);
    }
    const parsed = Number(rawTimeout);
    if (!Number.isSafeInteger(parsed)) {
        die(`Error: --timeout requires a positive integer, got: ${rawTimeout}`);
    }
    return parsed;
}
function parseOutputFormatArg(argv) {
    const formatIndex = argv.indexOf('--output-format');
    const rawFormat = formatIndex !== -1 ? argv[formatIndex + 1] : undefined;
    return rawFormat && !rawFormat.startsWith('--') ? rawFormat : 'text';
}
function readTicketFileArg(argv) {
    const ticketFileIndex = argv.indexOf('--ticket-file');
    const rawTicketFile = ticketFileIndex !== -1 ? argv[ticketFileIndex + 1] : undefined;
    if (!rawTicketFile || rawTicketFile.startsWith('--') || !fs.existsSync(rawTicketFile)) {
        return { ticketFilePath: null, ticketContent: '' };
    }
    return { ticketFilePath: rawTicketFile, ticketContent: fs.readFileSync(rawTicketFile, 'utf-8') };
}
function normalizeTicketPath(ticketPath) {
    if (ticketPath.endsWith('.md') || (fs.existsSync(ticketPath) && fs.statSync(ticketPath).isFile())) {
        return path.dirname(ticketPath);
    }
    return ticketPath;
}
export function parseAndValidateArgs(argv) {
    if (argv.length < 1) {
        die('Usage: node spawn-morty.js <task> --ticket-id <id> --ticket-path <path> [--timeout <sec>] [--output-format <fmt>]');
    }
    const ticketIdIndex = argv.indexOf('--ticket-id');
    const ticketPathIndex = argv.indexOf('--ticket-path');
    if (ticketIdIndex === -1 || ticketPathIndex === -1) {
        die('Error: --ticket-id and --ticket-path are required.');
    }
    const ticketId = requireFlagValue(argv, ticketIdIndex);
    const ticketPath = normalizeTicketPath(requireFlagValue(argv, ticketPathIndex));
    if (!/^[a-zA-Z0-9_-]+$/.test(ticketId))
        die('Error: --ticket-id contains invalid characters.');
    const ticketFile = readTicketFileArg(argv);
    fs.mkdirSync(ticketPath, { recursive: true });
    return {
        ticket: argv[0],
        ticketId,
        ticketPath,
        ticketFilePath: ticketFile.ticketFilePath,
        ticketContent: ticketFile.ticketContent,
        sessionRoot: path.dirname(ticketPath),
        sessionLogPath: path.join(ticketPath, `worker_session_${process.pid}.log`),
        backend: 'claude',
        timeout: parseTimeoutArg(argv),
        outputFormat: parseOutputFormatArg(argv),
        isReviewTicket: argv.includes('--review'),
    };
}
export function resolveEffectiveTimeout(configuredTimeoutSec, parentState, wallClockNowMs) {
    const maxMins = Number(parentState?.max_time_minutes);
    const startEpoch = Number(parentState?.start_time_epoch);
    if (!Number.isFinite(maxMins) || maxMins <= 0 || !Number.isFinite(startEpoch) || startEpoch <= 0) {
        return configuredTimeoutSec;
    }
    const remaining = Math.floor(maxMins * 60 - (Math.floor(wallClockNowMs / 1000) - startEpoch));
    if (remaining <= 0)
        return Math.max(MIN_TIMEOUT_SECONDS, configuredTimeoutSec);
    if (remaining < configuredTimeoutSec)
        return Math.max(MIN_TIMEOUT_SECONDS, remaining);
    return configuredTimeoutSec;
}
export function buildWorkerPrompt(opts) {
    const { ticket } = opts;
    const extensionRoot = opts.extensionRoot ?? getExtensionRoot();
    const promptFilename = ticket.isReviewTicket ? 'send-to-morty-review.md' : 'send-to-morty.md';
    const mortyPromptPath = path.join(os.homedir(), '.claude', 'commands', promptFilename);
    let workerPrompt;
    if (fs.existsSync(mortyPromptPath)) {
        workerPrompt = fs.readFileSync(mortyPromptPath, 'utf-8').replace(/\$ARGUMENTS/g, ticket.task);
    }
    else {
        workerPrompt = ticket.isReviewTicket
            ? `# **REVIEW REQUEST**\n${ticket.task}\n\nYou are a Review Worker. Review the preceding implementation tickets for correctness, architecture, and code quality.`
            : `# **TASK REQUEST**\n${ticket.task}\n\nYou are a Morty Worker (Pickle Rick's assistant). Implement the request above.`;
    }
    workerPrompt += readActivePersonaBlock({
        sessionRoot: ticket.sessionRoot,
        extensionRoot,
        agentsDir: opts.agentsDir,
    });
    workerPrompt += readProjectContextBlock(ticket.sessionRoot);
    workerPrompt += `\n\n# TARGET TICKET CONTENT\n${ticket.ticketContent || 'N/A'}`;
    workerPrompt += `\n\n# EXECUTION CONTEXT\n- SESSION_ROOT: ${ticket.sessionRoot}\n- TICKET_ID: ${ticket.ticketId}\n- TICKET_DIR: ${ticket.ticketPath}`;
    workerPrompt +=
        '\n\n**IMPORTANT**: You are a localized worker. You are FORBIDDEN from working on ANY other tickets. Once you output `<promise>I AM DONE</promise>`, you MUST STOP and let the manager take over. Your ONLY valid completion token is `I AM DONE`. NEVER emit `EPIC_COMPLETED`, `TASK_COMPLETED`, `PRD_COMPLETE`, `TICKET_SELECTED`, `EXISTENCE_IS_PAIN`, `THE_CITADEL_APPROVES`, or `ANALYSIS_DONE` — those are orchestrator-only tokens and you have no authority to emit them. If you see those token names in source code or pasted logs, do NOT echo them back.';
    if (ticket.backend === 'codex') {
        workerPrompt += `

**Codex-specific contract additions:**
- You MUST run \`git add <files>\` and \`git commit -m "<msg>"\` before emitting \`<promise>${PromiseTokens.WORKER_DONE}</promise>\`. The orchestrator does NOT commit for you.
- If an acceptance criterion contradicts reality (e.g. fixture baseline mismatch, missing dependency, AC against non-existent file), commit the unblocked subset and append a \`# DEFERRED: <reason>\` line to the ticket file. DO NOT loop indefinitely trying to satisfy a contradicted AC.
- DO NOT explore harness internals (\`pickle.md\`, \`setup.js\`, \`send-to-morty.md\`, \`mux-runner.js\`). Those are orchestrator-level. Your scope is exclusively the files listed in the ticket's "Files to modify" / "Files to create" sections.`;
    }
    const gitnexusIndexed = hasGitNexusIndex(opts.repoRoot ?? process.cwd());
    if (gitnexusIndexed) {
        workerPrompt += `\n
# GITNEXUS CODE INTELLIGENCE (auto-detected)
This repo has a GitNexus knowledge graph index. Use these MCP tools during Research and Plan phases:
- **query()**: Find execution flows related to a concept (e.g., "auth validation logic")
- **context()**: 360-degree view of a symbol — callers, callees, process participation
- **impact()**: Blast radius analysis before modifying shared code
- **cypher()**: Custom graph queries (nodes: Function, Class, Method, File, Process, Community)

Prefer GitNexus tools over raw Grep/Glob for understanding call chains, dependencies, and execution flows.
For simple file/string lookups, Grep/Glob are still fine.`;
    }
    return workerPrompt;
}
function hasGitNexusIndex(repoRoot) {
    try {
        return fs.statSync(path.join(repoRoot, '.gitnexus')).isDirectory();
    }
    catch {
        return false;
    }
}
/**
 * P2: Post-flush guard helper. Returns true when the working dir has
 * uncommitted changes, staged changes, or commits whose committer date is
 * strictly greater than `sinceEpochSec`. Returns false on any error
 * (non-git dir, missing git binary, etc.) so the caller can fall through
 * to the original log-size heuristic for safe degradation.
 *
 * Uses `%ct` (committer epoch seconds) and a JS strict-greater comparison
 * because `git log --since=@<sec>` is not strictly greater-than — it can
 * include commits at the same second, leading to false positives when the
 * worker started immediately after a setup commit.
 */
export function checkGitEdits(workingDir, sinceEpochSec) {
    try {
        const uncommitted = runCmd(['git', 'diff', '--stat'], { cwd: workingDir, check: false });
        if (uncommitted.length > 0)
            return true;
        const staged = runCmd(['git', 'diff', '--stat', '--cached'], { cwd: workingDir, check: false });
        if (staged.length > 0)
            return true;
        // Inspect the last 10 commits' committer-epoch and accept iff any is
        // strictly greater than sinceEpochSec. 10 is a generous bound: a worker
        // that produced more than 10 commits is unambiguously productive.
        const cts = runCmd(['git', 'log', '-n', '10', '--pretty=format:%ct'], { cwd: workingDir, check: false });
        if (!cts)
            return false;
        // Accept commits whose committer-epoch is >= sinceEpochSec. The caller
        // is expected to subtract a small leniency before passing — see how
        // spawn-morty derives `startEpochSec` from `startTime` (Date.now()).
        for (const line of cts.split('\n')) {
            const ct = parseInt(line.trim(), 10);
            if (Number.isFinite(ct) && ct >= sinceEpochSec)
                return true;
        }
        return false;
    }
    catch {
        return false;
    }
}
function readSessionRuntime(args) {
    const parentStatePath = path.join(args.sessionRoot, 'state.json');
    const workerStatePath = path.join(args.ticketPath, 'state.json');
    let timeoutStatePath = null;
    if (fs.existsSync(parentStatePath))
        timeoutStatePath = parentStatePath;
    else if (fs.existsSync(workerStatePath))
        timeoutStatePath = workerStatePath;
    try {
        const state = timeoutStatePath ? sm.read(timeoutStatePath) : null;
        const sessionWorkingDir = state?.working_dir?.trim() ? state.working_dir : process.cwd();
        const sessionEffort = state?.effort === 'low' || state?.effort === 'medium' || state?.effort === 'high'
            ? state.effort
            : undefined;
        return { timeoutStatePath, workerStatePath, state, sessionWorkingDir, sessionEffort };
    }
    catch {
        return { timeoutStatePath, workerStatePath, state: null, sessionWorkingDir: process.cwd() };
    }
}
function readTicketInfo(ticketFilePath) {
    try {
        return ticketFilePath ? parseTicketFrontmatter(ticketFilePath) : null;
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[spawn-morty] WARNING: ticket frontmatter parse failed: ${msg}`);
        return null;
    }
}
function routeBackend(sessionRoot, ticketInfo) {
    let backend = loadBackendFromSession(sessionRoot);
    try {
        const settings = readRecoverableJsonObject(path.join(getExtensionRoot(), 'pickle_settings.json'));
        if (settings?.enable_backend_routing_heuristic !== true || backend !== 'codex')
            return backend;
        const routedReason = ticketInfo?.complexity_tier === 'large'
            ? 'complexity_tier=large'
            : ticketInfo?.title && /\b(UI|Wire|Audit)\b/i.test(ticketInfo.title) ? `title-signal:${ticketInfo.title}` : null;
        if (routedReason) {
            console.error(`[spawn-morty] backend routed: codex → claude (reason: ${routedReason})`);
            backend = 'claude';
        }
    }
    catch { /* settings missing or unreadable: no override */ }
    return backend;
}
function resolveWorkerModel(backend, extensionRoot, sessionRoot, ticketInfo) {
    if (backend !== 'claude')
        return undefined;
    let enableComplexityTiers = true;
    try {
        const settings = readRecoverableJsonObject(path.join(extensionRoot, 'pickle_settings.json'));
        if (settings?.enable_complexity_tiers === false)
            enableComplexityTiers = false;
    }
    catch { /* default true */ }
    try {
        const personaModel = resolvePhasePersonaModel(sessionRoot, extensionRoot);
        return enableComplexityTiers
            ? resolveWorkerModelFromTierAndPersona(ticketInfo?.complexity_tier, personaModel)
            : 'sonnet';
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[spawn-morty] WARNING: complexity tier subsystem failed: ${msg}`);
        return 'sonnet';
    }
}
function readWorkerLog(sessionLogPath) {
    try {
        return fs.readFileSync(sessionLogPath, 'utf-8');
    }
    catch (err) {
        console.error(`${Style.YELLOW}⚠️  Could not read worker log: ${safeErrorMessage(err)}${Style.RESET}`);
        return '';
    }
}
function scrubWorkerLog(sessionLogPath, logContent) {
    if (!logContent)
        return logContent;
    const scrub = scrubForbiddenWorkerTokens(logContent);
    const replacedTokens = Object.keys(scrub.replacements);
    if (replacedTokens.length === 0)
        return logContent;
    const summary = replacedTokens.map(t => `${t}=${scrub.replacements[t]}`).join(', ');
    console.error(`${Style.YELLOW}⚠️  Worker emitted forbidden orchestrator token(s) — scrubbed to ${PromiseTokens.WORKER_DONE}: ${summary}${Style.RESET}`);
    try {
        fs.writeFileSync(sessionLogPath, scrub.scrubbed, 'utf-8');
    }
    catch (err) {
        console.error(`${Style.YELLOW}⚠️  Could not persist scrubbed worker log: ${safeErrorMessage(err)}${Style.RESET}`);
    }
    return scrub.scrubbed;
}
function readTicketFiles(ticketPath) {
    try {
        return fs.readdirSync(ticketPath);
    }
    catch {
        return [];
    }
}
function buildValidationFailureReasons(checks) {
    return [
        checks.timedOut ? 'timeout' : null,
        !checks.tokenPresent ? 'no WORKER_DONE token' : null,
        !checks.hasArtifact ? `no ${checks.role} lifecycle artifact` : null,
        (!checks.logNonTrivial && !checks.hasEdits) ? `log ${checks.logContentLength}B < 200B and no git edits` : null,
    ].filter(Boolean).join(', ');
}
export async function runWorkerProcess(ctx) {
    const { args, ticketPath, ticketId, sessionRoot, sessionLog, sessionLogPath, sessionWorkingDir } = ctx;
    const invocation = buildWorkerInvocation(args.backend, {
        prompt: ctx.prompt,
        addDirs: [getExtensionRoot(), getDataRoot(), sessionWorkingDir, ticketPath],
        model: ctx.model,
        outputFormat: args.outputFormat,
        effort: ctx.effort,
    });
    try {
        updateTicketStatus(ticketId, 'In Progress', sessionRoot);
    }
    catch { /* best-effort */ }
    sessionLog.on('error', err => console.error(`${Style.RED}❌ Log stream error: ${safeErrorMessage(err)}${Style.RESET}`));
    const env = { ...process.env, ...backendEnvOverrides(args.backend), PICKLE_STATE_FILE: ctx.timeoutStatePath || ctx.workerStatePath, PICKLE_ROLE: 'worker', PYTHONUNBUFFERED: '1' };
    delete env['CLAUDECODE'];
    const proc = spawn(invocation.cmd, invocation.args, { cwd: sessionWorkingDir, env, stdio: ['inherit', 'pipe', 'pipe'] });
    proc.stdout?.pipe(sessionLog, { end: false });
    proc.stderr?.pipe(sessionLog, { end: false });
    const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let idx = 0;
    const startTime = Date.now();
    const interval = setInterval(() => {
        if (!process.stdout.isTTY)
            return;
        const spinChar = spinner[idx % spinner.length];
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        process.stdout.write(`\r   ${Style.CYAN}${spinChar}${Style.RESET} Worker Active... ${Style.DIM}[${formatTime(elapsed)}]${Style.RESET}\x1b[K`);
        idx++;
    }, 100);
    let killEscalation = null;
    const timeoutHandle = setTimeout(() => {
        ctx.mutableState.timedOut = true;
        console.log(`\n${Style.RED}❌ Worker timed out after ${Math.floor(ctx.effectiveTimeoutMs / 1000)}s${Style.RESET}`);
        try {
            proc.kill('SIGTERM');
        }
        catch { /* already dead */ }
        killEscalation = setTimeout(() => {
            try {
                proc.kill('SIGKILL');
            }
            catch { /* already dead */ }
        }, 2000);
    }, ctx.effectiveTimeoutMs);
    const hangGuard = setTimeout(() => {
        console.error(`${Style.RED}❌ Worker hang detected — forcing exit${Style.RESET}`);
        try {
            sessionLog.destroy();
        }
        catch { /* best-effort */ }
        try {
            const fd = fs.openSync(sessionLogPath, 'a');
            fs.fdatasyncSync(fd);
            fs.closeSync(fd);
        }
        catch { /* best-effort */ }
        try {
            updateTicketStatus(ticketId, 'Failed', sessionRoot);
        }
        catch { /* best-effort */ }
        process.exit(1);
    }, ctx.effectiveTimeoutMs + 30_000);
    hangGuard.unref();
    return new Promise(resolve => {
        const clearLifecycleTimers = () => {
            clearInterval(interval);
            clearTimeout(timeoutHandle);
            if (killEscalation)
                clearTimeout(killEscalation);
            clearTimeout(hangGuard);
            if (process.stdout.isTTY)
                process.stdout.write('\r\x1b[K');
        };
        proc.on('error', err => {
            clearLifecycleTimers();
            sessionLog.end();
            console.error(`${Style.RED}[pickle-rick] Failed to spawn '${invocation.cmd}' (backend=${args.backend}): ${safeErrorMessage(err)}${Style.RESET}`);
            try {
                updateTicketStatus(ticketId, 'Failed', sessionRoot);
            }
            catch { /* best-effort */ }
            printMinimalPanel('Worker Report', { status: 'spawn-error', validation: 'failed' }, 'RED', '🥒');
            process.exit(1);
        });
        proc.on('close', code => {
            clearLifecycleTimers();
            const flushTimeout = setTimeout(() => {
                console.error(`${Style.YELLOW}⚠️  Log flush timed out — reading partial log${Style.RESET}`);
                finalize(code);
            }, 5000);
            sessionLog.once('finish', () => {
                clearTimeout(flushTimeout);
                finalize(code);
            });
            sessionLog.end();
            function finalize(exitCode) {
                if (ctx.mutableState.finalized)
                    return;
                ctx.mutableState.finalized = true;
                clearTimeout(flushTimeout);
                const logContent = scrubWorkerLog(sessionLogPath, readWorkerLog(sessionLogPath));
                const role = args.isReviewTicket ? 'review' : 'implementation';
                const ticketFiles = readTicketFiles(ticketPath);
                const tokenPresent = hasToken(logContent, PromiseTokens.WORKER_DONE);
                const logNonTrivial = logContent.length > 200;
                const hasArtifact = hasLifecycleArtifact(ticketFiles, role);
                const hasEdits = checkGitEdits(sessionWorkingDir, Math.floor(startTime / 1000));
                const isSuccess = !ctx.mutableState.timedOut && tokenPresent && hasArtifact && (logNonTrivial || hasEdits);
                if (!isSuccess) {
                    const reasons = buildValidationFailureReasons({
                        timedOut: ctx.mutableState.timedOut, tokenPresent, hasArtifact, role,
                        logContentLength: logContent.length, logNonTrivial, hasEdits,
                    });
                    console.error(`${Style.RED}Worker validation failed: ${reasons}${Style.RESET}`);
                }
                try {
                    updateTicketStatus(ticketId, isSuccess ? 'Done' : 'Failed', sessionRoot);
                }
                catch { /* best-effort */ }
                printMinimalPanel('Worker Report', { status: ctx.mutableState.timedOut ? 'timeout' : `exit:${exitCode}`, validation: isSuccess ? 'successful' : 'failed' }, isSuccess ? 'GREEN' : 'RED', '🥒');
                if (!isSuccess)
                    process.exit(1);
                resolve({ exitCode: exitCode ?? 0, isSuccess });
            }
        });
    });
}
async function main() {
    const parsed = parseAndValidateArgs(process.argv.slice(2));
    const runtime = readSessionRuntime(parsed);
    const effectiveTimeout = resolveEffectiveTimeout(parsed.timeout, runtime.state, Date.now());
    if (runtime.state && effectiveTimeout > parsed.timeout) {
        console.log(`${Style.YELLOW}⚠️  Session time already elapsed; running with requested timeout.${Style.RESET}`);
    }
    else if (effectiveTimeout < parsed.timeout) {
        console.log(`${Style.YELLOW}⚠️  Worker timeout clamped: ${effectiveTimeout}s${Style.RESET}`);
    }
    const ticketInfo = readTicketInfo(parsed.ticketFilePath);
    const backend = routeBackend(parsed.sessionRoot, ticketInfo);
    const args = { ...parsed, backend };
    const extensionRoot = getExtensionRoot();
    const model = resolveWorkerModel(backend, extensionRoot, parsed.sessionRoot, ticketInfo);
    printMinimalPanel(args.isReviewTicket ? 'Spawning Review Worker' : 'Spawning Morty Worker', { Request: args.ticket, Ticket: args.ticketId, Type: args.isReviewTicket ? 'review' : 'implementation', Format: args.outputFormat, Backend: backend, Timeout: `${effectiveTimeout}s (Req: ${args.timeout}s)`, PID: process.pid }, args.isReviewTicket ? 'MAGENTA' : 'CYAN', '🥒');
    const prompt = buildWorkerPrompt({
        ticket: { task: args.ticket, ticketContent: args.ticketContent, ticketId: args.ticketId, ticketPath: args.ticketPath, sessionRoot: args.sessionRoot, backend, isReviewTicket: args.isReviewTicket },
        model: model ?? 'sonnet',
        repoRoot: runtime.sessionWorkingDir,
    });
    const sessionLog = fs.createWriteStream(args.sessionLogPath, { flags: 'w' });
    await runWorkerProcess({
        args, prompt, ticketPath: args.ticketPath, ticketId: args.ticketId, sessionRoot: args.sessionRoot, sessionLog,
        sessionLogPath: args.sessionLogPath, sessionWorkingDir: runtime.sessionWorkingDir,
        timeoutStatePath: runtime.timeoutStatePath, workerStatePath: runtime.workerStatePath,
        effectiveTimeoutMs: effectiveTimeout * 1000, mutableState: { finalized: false, timedOut: false },
        model, effort: runtime.sessionEffort,
    });
}
if (process.argv[1] && path.basename(process.argv[1]) === 'spawn-morty.js') {
    main().catch((err) => {
        const msg = safeErrorMessage(err);
        console.error(`${Style.RED}${msg}${Style.RESET}`);
        process.exit(1);
    });
}

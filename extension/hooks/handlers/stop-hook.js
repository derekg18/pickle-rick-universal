import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { PromiseTokens, hasToken } from '../../types/index.js';
import { PROMISE_TOKENS } from '../../services/promise-tokens.js';
import { resolveStateFile, approve } from '../resolve-state.js';
import { getExtensionRoot, getDataRoot, safeErrorMessage } from '../../services/pickle-utils.js';
import { StateManager } from '../../services/state-manager.js';
import { logActivity } from '../../services/activity-logger.js';
import { readRecoverableJsonObject } from '../../services/microverse-state.js';
const sm = new StateManager();
/**
 * Number of consecutive short manager responses tolerated before the degenerate-response
 * detector forces an exit. Long-running ticket work produces legitimate short poll messages
 * ("Waiting.", "Still running.") while a worker churns; a single one is benign, three in a
 * row means the manager is genuinely stuck in an ack loop.
 */
export const DEGENERATE_CONSECUTIVE_THRESHOLD = 3;
const RATE_LIMIT_PATTERNS = [
    /out of (extra )?usage/i,
    /rate limit/i,
    /usage.*limit.*reached/i,
    /limit.*reached.*try.*back/i,
    /hour.*limit/i,
];
const DEGENERATE_MAX_LENGTH = 10;
const NO_OP_MAX_LENGTH = 100;
const NO_OP_PATTERNS = [
    /^acknowledged\.?$/i,
    /^ok\.?$/i,
    /^done\.?$/i,
    /^understood\.?$/i,
    /^noted\.?$/i,
    /^continuing\.?$/i,
    /^ready\.?$/i,
    /^got it\.?$/i,
    /^will do\.?$/i,
    /^roger\.?$/i,
];
function finiteNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}
function roleAllowsToken(token, role) {
    if (token.kind === 'worker-done')
        return role === 'worker';
    if (token.kind === 'analysis-done')
        return role === 'refinement-worker';
    if (token.kind === 'prd-complete' || token.kind === 'ticket-selected')
        return role !== 'worker';
    return true;
}
function activeDelta(state, role, resetShortResponses = false) {
    const delta = {};
    const isWorkerRole = role === 'worker' || role === 'refinement-worker';
    if (!isWorkerRole && state.tmux_mode !== true)
        delta.active = false;
    if (resetShortResponses)
        delta.consecutive_short_responses = 0;
    return Object.keys(delta).length > 0 ? delta : undefined;
}
function isWhitespaceOnlyResponse(transcript, trimmed) {
    return transcript.length > 0 && trimmed.length === 0;
}
function isNoOpResponse(trimmed) {
    return trimmed.length > 0 && trimmed.length <= NO_OP_MAX_LENGTH &&
        NO_OP_PATTERNS.some((pattern) => pattern.test(trimmed));
}
function isShortResponse(trimmed) {
    return trimmed.length > 0 && trimmed.length <= DEGENERATE_MAX_LENGTH;
}
export function detectCompletionTokens(transcript, state) {
    if (state.completion_promise && hasToken(transcript, state.completion_promise)) {
        return { kind: 'completion-promise', promise: state.completion_promise };
    }
    if (hasToken(transcript, PromiseTokens.EPIC_COMPLETED))
        return { kind: 'epic-completed' };
    if (hasToken(transcript, PromiseTokens.TASK_COMPLETED))
        return { kind: 'task-completed' };
    if (hasToken(transcript, PromiseTokens.ANALYSIS_DONE))
        return { kind: 'analysis-done' };
    if (hasToken(transcript, PromiseTokens.EXISTENCE_IS_PAIN) ||
        hasToken(transcript, PromiseTokens.THE_CITADEL_APPROVES))
        return { kind: 'review-clean' };
    if (hasToken(transcript, PromiseTokens.WORKER_DONE))
        return { kind: 'worker-done' };
    if (hasToken(transcript, PromiseTokens.PRD_COMPLETE))
        return { kind: 'prd-complete' };
    if (hasToken(transcript, PromiseTokens.TICKET_SELECTED))
        return { kind: 'ticket-selected' };
    return { kind: 'none' };
}
export function enforceRateLimitGate(_state, transcript) {
    if (transcript.length > 0 &&
        transcript.length < 500 &&
        RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(transcript))) {
        return { decision: 'approve' };
    }
    return null;
}
export function enforceLimits(state) {
    const now = Math.floor(Date.now() / 1000);
    const startEpoch = finiteNumber(state.start_time_epoch);
    const maxTimeMins = finiteNumber(state.max_time_minutes);
    const maxIter = finiteNumber(state.max_iterations);
    const curIter = finiteNumber(state.iteration);
    const elapsedSeconds = startEpoch > 0 ? Math.max(0, now - startEpoch) : 0;
    if (maxIter > 0 && curIter >= maxIter) {
        return { decision: 'approve', stateMutations: state.tmux_mode === true ? undefined : { active: false } };
    }
    if (maxTimeMins > 0 && startEpoch > 0 && elapsedSeconds >= maxTimeMins * 60) {
        return { decision: 'approve', stateMutations: state.tmux_mode === true ? undefined : { active: false } };
    }
    return null;
}
export function detectDegenerateResponse(state, transcript, role = '') {
    const trimmed = transcript.trim();
    const whitespaceOnly = isWhitespaceOnlyResponse(transcript, trimmed);
    const noOp = isNoOpResponse(trimmed);
    const shortResponse = isShortResponse(trimmed);
    const isWorkerRole = role === 'worker' || role === 'refinement-worker';
    if (whitespaceOnly || noOp) {
        return { decision: 'approve', stateMutations: activeDelta(state, role, true) };
    }
    if (shortResponse) {
        if (isWorkerRole)
            return { decision: 'approve' };
        const newCount = (Number(state.consecutive_short_responses) || 0) + 1;
        if (newCount >= DEGENERATE_CONSECUTIVE_THRESHOLD) {
            return { decision: 'approve', stateMutations: activeDelta(state, role, true) };
        }
        return { decision: 'block', stateMutations: { consecutive_short_responses: newCount } };
    }
    if (!isWorkerRole && (Number(state.consecutive_short_responses) || 0) > 0) {
        return { decision: 'block', stateMutations: { consecutive_short_responses: 0 } };
    }
    return null;
}
export function classifyDecision(state, transcript, role) {
    return classifyDecisionInternal(state, transcript, role);
}
function classifyDecisionInternal(state, transcript, role) {
    const token = detectCompletionTokens(transcript, state);
    const isWorkerRole = role === 'worker' || role === 'refinement-worker';
    if (roleAllowsToken(token, role) && token.kind !== 'none') {
        const tokenDecision = classifyTokenDecision(state, token, isWorkerRole);
        if (tokenDecision)
            return tokenDecision;
    }
    const rateLimit = enforceRateLimitGate(state, transcript);
    if (rateLimit) {
        return { ...rateLimit, logMessage: 'Decision: APPROVE (Rate limit detected — handing off to runner for backoff)', token };
    }
    const limitDecision = classifyLimitDecision(state);
    if (limitDecision)
        return limitDecision;
    const degenerateDecision = classifyDegenerateDecision(state, transcript, role);
    if (degenerateDecision)
        return degenerateDecision;
    const maxIter = finiteNumber(state.max_iterations);
    const curIter = finiteNumber(state.iteration);
    const iterSuffix = maxIter > 0 ? ` of ${maxIter}` : '';
    return {
        decision: 'block',
        reason: `🥒 **Pickle Rick Loop Active** (Iteration ${curIter}${iterSuffix})`,
        logMessage: 'Decision: BLOCK (Default continuation)',
        token,
    };
}
function classifyTokenDecision(state, token, isWorkerRole) {
    if (token.kind === 'review-clean') {
        const minIter = finiteNumber(state.min_iterations);
        const curIter = finiteNumber(state.iteration);
        if (minIter > 0 && curIter < minIter) {
            if (state.tmux_mode === true) {
                return {
                    decision: 'approve',
                    logMessage: `Decision: APPROVE (review_clean at ${curIter}/${minIter} — below min, runner continues)`,
                    token,
                };
            }
            return {
                decision: 'block',
                reason: `🥒 Clean pass ${curIter}/${minIter} — continuing review`,
                logMessage: `Decision: BLOCK (review_clean at ${curIter}/${minIter} — below min, continuing inline loop)`,
                token,
            };
        }
    }
    if (token.kind === 'prd-complete' || token.kind === 'ticket-selected') {
        if (state.tmux_mode === true) {
            return { decision: 'approve', logMessage: 'Decision: APPROVE (tmux mode checkpoint — runner will respawn for next phase)', token };
        }
        const phase = token.kind === 'prd-complete'
            ? 'PRD finished, moving to breakdown...'
            : 'Ticket selected, starting research...';
        return {
            decision: 'block',
            reason: `🥒 **Pickle Rick Loop Active** - ${phase}`,
            logMessage: 'Decision: BLOCK (Checkpoint reached)',
            token,
        };
    }
    return {
        decision: 'approve',
        stateMutations: !isWorkerRole && state.tmux_mode !== true ? { active: false } : undefined,
        logMessage: 'Decision: APPROVE (Task/Worker complete)',
        token,
        activity: tokenActivity(token, isWorkerRole),
    };
}
function tokenActivity(token, isWorkerRole) {
    if (token.kind === 'review-clean')
        return 'review-clean';
    if (token.kind === 'epic-completed')
        return 'epic-completed';
    if (token.kind === 'task-completed' && !isWorkerRole)
        return 'ticket-completed';
    return undefined;
}
function classifyLimitDecision(state) {
    const now = Math.floor(Date.now() / 1000);
    const startEpoch = finiteNumber(state.start_time_epoch);
    const maxTimeMins = finiteNumber(state.max_time_minutes);
    const maxIter = finiteNumber(state.max_iterations);
    const curIter = finiteNumber(state.iteration);
    const elapsedSeconds = startEpoch > 0 ? Math.max(0, now - startEpoch) : 0;
    const limitResult = enforceLimits(state);
    if (!limitResult)
        return null;
    if (maxIter > 0 && curIter >= maxIter) {
        return {
            ...limitResult,
            logMessage: `Decision: APPROVE (Max iterations reached: ${curIter}/${maxIter})`,
            token: { kind: 'none' },
            activity: state.tmux_mode === true ? undefined : 'session-end',
            sessionEndDurationMin: startEpoch > 0 ? Math.round(elapsedSeconds / 60) : undefined,
        };
    }
    return {
        ...limitResult,
        logMessage: `Decision: APPROVE (Time limit reached: ${elapsedSeconds}/${maxTimeMins * 60}s)`,
        token: { kind: 'none' },
        activity: state.tmux_mode === true ? undefined : 'session-end',
        sessionEndDurationMin: Math.round(elapsedSeconds / 60),
    };
}
function classifyDegenerateDecision(state, transcript, role) {
    const result = detectDegenerateResponse(state, transcript, role);
    if (!result)
        return null;
    const trimmed = transcript.trim();
    const isWorkerRole = role === 'worker' || role === 'refinement-worker';
    const whitespaceOnly = isWhitespaceOnlyResponse(transcript, trimmed);
    const noOp = isNoOpResponse(trimmed);
    const newCount = result.stateMutations?.consecutive_short_responses ??
        ((Number(state.consecutive_short_responses) || 0) + 1);
    if (whitespaceOnly || noOp) {
        const reason = whitespaceOnly
            ? `Whitespace-only response — ${transcript.length} raw chars`
            : `No-op response detected: "${trimmed}" — breaking ack loop`;
        return { ...result, logMessage: `Decision: APPROVE (${reason})`, token: { kind: 'none' } };
    }
    if (result.decision === 'approve') {
        const roleText = isWorkerRole
            ? ` in ${role} role`
            : `: "${trimmed}" — ${trimmed.length} chars, ${newCount} consecutive`;
        return { ...result, logMessage: `Decision: APPROVE (Degenerate short response${roleText})`, token: { kind: 'none' } };
    }
    if (result.stateMutations?.consecutive_short_responses === 0) {
        return { ...result, logMessage: 'Decision: BLOCK (Default continuation)', token: { kind: 'none' } };
    }
    return {
        ...result,
        reason: `🥒 Short response (${newCount}/${DEGENERATE_CONSECUTIVE_THRESHOLD}) — continuing`,
        logMessage: `Decision: BLOCK (Short response: "${trimmed}" — ${trimmed.length} chars, ${newCount}/${DEGENERATE_CONSECUTIVE_THRESHOLD} consecutive)`,
        token: { kind: 'none' },
    };
}
function isCompletionToken(token) {
    return [
        'completion-promise',
        'epic-completed',
        'task-completed',
        'analysis-done',
        'review-clean',
        'worker-done',
    ].includes(token.kind);
}
function emitActivity(decision, state, stateFile, isWorker) {
    if (!decision.activity)
        return;
    const sessionId = path.basename(path.dirname(stateFile));
    if (decision.activity === 'review-clean') {
        logActivity({ event: 'meeseeks_pass', source: 'pickle', session: sessionId, pass: Number(state.iteration) || undefined });
    }
    else if (decision.activity === 'epic-completed') {
        logActivity({ event: 'epic_completed', source: 'pickle', session: sessionId, epic: state.original_prompt || undefined });
    }
    else if (decision.activity === 'ticket-completed' && !isWorker) {
        logActivity({ event: 'ticket_completed', source: 'pickle', session: sessionId, ticket: state.current_ticket || undefined, step: state.step });
    }
    else if (decision.activity === 'session-end') {
        logActivity({ event: 'session_end', source: 'pickle', session: sessionId, duration_min: decision.sessionEndDurationMin, mode: 'inline' });
    }
}
function promiseSummary(transcript, state, role) {
    const isWorker = role === 'worker';
    const isRefinementWorker = role === 'refinement-worker';
    const hasPromise = !!state.completion_promise && hasToken(transcript, state.completion_promise);
    const isEpicDone = hasToken(transcript, PromiseTokens.EPIC_COMPLETED);
    const isTaskFinished = hasToken(transcript, PromiseTokens.TASK_COMPLETED);
    const isAnalysisDone = isRefinementWorker && hasToken(transcript, PromiseTokens.ANALYSIS_DONE);
    const isExistenceIsPain = hasToken(transcript, PromiseTokens.EXISTENCE_IS_PAIN) ||
        hasToken(transcript, PromiseTokens.THE_CITADEL_APPROVES);
    const isWorkerDone = isWorker && hasToken(transcript, PromiseTokens.WORKER_DONE);
    const isPrdDone = !isWorker && hasToken(transcript, PromiseTokens.PRD_COMPLETE);
    const isTicketSelected = !isWorker && hasToken(transcript, PromiseTokens.TICKET_SELECTED);
    return `Promises(${PROMISE_TOKENS.length}): hasPromise=${hasPromise}, isEpicDone=${isEpicDone}, isTaskFinished=${isTaskFinished}, isWorkerDone=${isWorkerDone}, isAnalysisDone=${isAnalysisDone}, isExistenceIsPain=${isExistenceIsPain}, isPrdDone=${isPrdDone}, isTicketSelected=${isTicketSelected}`;
}
function maybeSpawnUpdateCheck(extensionDir, log) {
    const checkUpdatePath = path.join(extensionDir, 'extension', 'bin', 'check-update.js');
    if (!fs.existsSync(checkUpdatePath)) {
        log('check-update.js not found, skipping update check');
        return;
    }
    try {
        const settingsPath = path.join(extensionDir, 'pickle_settings.json');
        const raw = readRecoverableJsonObject(settingsPath);
        if (raw?.auto_update_enabled === false) {
            log('Auto-update disabled in settings, skipping');
            return;
        }
    }
    catch {
        // Settings missing/corrupted — default to enabled
    }
    log('Spawning detached check-update process');
    const child = spawn('node', [checkUpdatePath], { detached: true, stdio: 'ignore' });
    child.on('error', (err) => {
        log(`check-update spawn error: ${safeErrorMessage(err)}`);
    });
    child.unref();
}
function createHookLogger(extensionDir) {
    const globalDebugLog = path.join(extensionDir, 'debug.log');
    let sessionHooksLog = null;
    const log = (msg) => {
        const ts = new Date().toISOString();
        const formatted = `[${ts}] [StopHookJS] ${msg}\n`;
        try {
            fs.appendFileSync(globalDebugLog, formatted);
        }
        catch { /* ignore */ }
        if (sessionHooksLog) {
            try {
                fs.appendFileSync(sessionHooksLog, formatted);
            }
            catch { /* ignore */ }
        }
    };
    return { log, setSessionHooksLog: (file) => { sessionHooksLog = file; } };
}
function approveIfDisabled(extensionDir, log) {
    const disabledMarker = path.join(extensionDir, 'disabled');
    try {
        if (fs.existsSync(disabledMarker)) {
            approve();
            return true;
        }
    }
    catch {
        log('Disabled marker check failed; continuing fail-open path');
    }
    return false;
}
function readHookInput(log) {
    let inputData;
    try {
        inputData = fs.readFileSync(0, 'utf8');
    }
    catch {
        log('Failed to read stdin');
        approve();
        return null;
    }
    if (!inputData.trim()) {
        approve();
        return null;
    }
    try {
        return { input: JSON.parse(inputData), inputData };
    }
    catch {
        const preview = inputData.slice(0, 100);
        const ellipsis = inputData.length > 100 ? '...' : '';
        log(`WARN: corrupted hook input, approving fail-open. First 100 chars: "${preview}"${ellipsis}`);
        approve();
        return null;
    }
}
function readHookState(log, setSessionHooksLog) {
    const stateFile = resolveStateFile(getDataRoot());
    if (!stateFile) {
        log(`No state file found.`);
        approve();
        return null;
    }
    setSessionHooksLog(path.join(path.dirname(stateFile), 'hooks.log'));
    log(`State file found: ${stateFile}`);
    try {
        return { stateFile, state: sm.read(stateFile) };
    }
    catch {
        log('Failed to parse state.json');
        approve();
        return null;
    }
}
function approveEarlyIfNeeded(state, log) {
    if (state.working_dir && path.resolve(state.working_dir) !== path.resolve(process.cwd())) {
        log(`CWD Mismatch: ${process.cwd()} !== ${state.working_dir}`);
        approve();
        return true;
    }
    if (state.active !== true) {
        log('Decision: APPROVE (Session inactive)');
        approve();
        return true;
    }
    if (state.tmux_mode === true && !process.env.PICKLE_STATE_FILE) {
        log('Decision: APPROVE (tmux mode — main window defers to tmux-runner)');
        approve();
        return true;
    }
    return false;
}
async function main() {
    const extensionDir = getExtensionRoot();
    const { log, setSessionHooksLog } = createHookLogger(extensionDir);
    if (approveIfDisabled(extensionDir, log))
        return;
    const hookInput = readHookInput(log);
    if (!hookInput)
        return;
    const { input, inputData } = hookInput;
    log(`Processing Stop hook. Input size: ${inputData.length}`);
    const hookState = readHookState(log, setSessionHooksLog);
    if (!hookState)
        return;
    const { stateFile, state } = hookState;
    const role = process.env.PICKLE_ROLE;
    const isWorker = role === 'worker';
    log(`State: active=${state.active}, iteration=${state.iteration}/${state.max_iterations}`);
    log(`Context: role=${role}, isWorker=${isWorker}, cwd=${process.cwd()}`);
    if (approveEarlyIfNeeded(state, log))
        return;
    const responseText = input.last_assistant_message || input.prompt_response || '';
    log(`Agent response received (${responseText.length} chars)`);
    const decision = classifyDecisionInternal(state, responseText, role || '');
    log(promiseSummary(responseText, state, role || ''));
    log(decision.logMessage);
    if (decision.stateMutations && Object.keys(decision.stateMutations).length > 0) {
        try {
            sm.update(stateFile, (s) => { Object.assign(s, decision.stateMutations); });
        }
        catch {
            /* fail-open */
        }
    }
    if (decision.decision === 'approve') {
        if (isCompletionToken(decision.token))
            maybeSpawnUpdateCheck(extensionDir, log);
        emitActivity(decision, state, stateFile, isWorker);
        approve();
        return;
    }
    console.log(JSON.stringify({ decision: 'block', reason: decision.reason }));
}
function handleFatalStopHookError(err) {
    try {
        const extensionDir = getExtensionRoot();
        const debugLog = path.join(extensionDir, 'debug.log');
        const detail = err instanceof Error ? err.stack || err.message : String(err);
        fs.appendFileSync(debugLog, `[FATAL] ${detail}\n`);
    }
    catch {
        /* ignore */
    }
    approve();
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(handleFatalStopHookError);
}

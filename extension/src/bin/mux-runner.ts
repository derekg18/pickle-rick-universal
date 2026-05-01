#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, spawnSync } from 'child_process';
import { printMinimalPanel, Style, formatTime, getExtensionRoot, getDataRoot, buildHandoffSummary, sleep, writeStateFile, markTicketDone, markTicketSkipped, collectTickets, runCmd, safeErrorMessage, ensureMonitorWindow, displayMacNotification, type TicketInfo } from '../services/pickle-utils.js';
import { State, PromiseTokens, hasToken, VALID_STEPS, Defaults, FALSE_EPIC_THRESHOLD, hasLifecycleArtifact, type Backend, type RateLimitInfo, type IterationExitResult, type IterationOutcome, type RateLimitAction, type WorkerRole } from '../types/index.js';
import { StateManager, safeDeactivate, writeActivityEntry, writeTimeoutStub, assertSchemaVersionDeployParity, SchemaVersionDeployDriftError } from '../services/state-manager.js';
import { logActivity } from '../services/activity-logger.js';
import { loadSettings, initCircuitBreaker, canExecute, detectProgress, extractErrorSignature, recordIterationResult, resetCircuitBreaker, type CircuitBreakerConfig, type CircuitBreakerState } from '../services/circuit-breaker.js';
import { buildManagerInvocation, resolveBackend, backendEnvOverrides } from '../services/backend-spawn.js';
import { readRecoverableJsonObject } from '../services/microverse-state.js';
import { extractAssistantContent } from '../services/classifier-utils.js';
export { extractAssistantContent } from '../services/classifier-utils.js';

const sm = new StateManager();

let currentChildProc: import('child_process').ChildProcess | null = null;

function readRunnerState(statePath: string): State {
  return sm.read(statePath);
}

export function killCurrentChild(): void {
  if (currentChildProc && !currentChildProc.killed) {
    currentChildProc.kill('SIGTERM');
  }
}

/**
 * Strips the Setup section from dual-mode templates (e.g. meeseeks.md, szechuan-sauce.md).
 * The mux-runner always invokes with --resume, so Setup instructions are dead weight
 * that confuse the model. Strips from "## SETUP" (with or without " MODE" suffix) to
 * the next ##-level heading, regardless of its name. This avoids coupling to a specific
 * end-marker like "## REVIEW PASS MODE" — any template layout works.
 */
export function stripSetupSection(prompt: string): string {
  const setupRe = /^## SETUP(?: MODE)?$/m;
  const setupMatch = setupRe.exec(prompt);
  if (!setupMatch) return prompt;

  // Find the next ##-level heading after the setup section
  const afterSetup = prompt.slice(setupMatch.index + setupMatch[0].length);
  const nextHeadingRe = /^## \S/m;
  const nextMatch = nextHeadingRe.exec(afterSetup);
  if (!nextMatch) return prompt; // Setup is the last section — nothing to strip to

  const endIndex = setupMatch.index + setupMatch[0].length + nextMatch.index;
  return prompt.slice(0, setupMatch.index) + prompt.slice(endIndex);
}

const TASK_NOTE_PRIORITY: Record<string, number> = {
  'Next': 0,
  'Dead Ends': 1,
  'Key Discoveries': 2,
  'Progress': 3,
};

const TASK_NOTE_TRUNC_MARKER = '[truncated]';

interface TaskNoteSection { name: string; body: string; }

function parseTaskNoteSections(content: string): { preamble: string; sections: TaskNoteSection[] } {
  const sectionRegex = /^## .+$/gm;
  const sections: TaskNoteSection[] = [];
  let preamble = '';
  let lastIndex = 0;
  let lastHeader = '';
  let match: RegExpExecArray | null;

  while ((match = sectionRegex.exec(content)) !== null) {
    if (lastIndex === 0 && match.index > 0) {
      preamble = content.slice(0, match.index);
    } else if (lastHeader) {
      sections.push({ name: lastHeader, body: content.slice(lastIndex, match.index) });
    }
    lastHeader = match[0].replace(/^## /, '').trim();
    lastIndex = match.index;
  }
  if (lastHeader) {
    sections.push({ name: lastHeader, body: content.slice(lastIndex) });
  }
  return { preamble, sections };
}

function priorityFor(name: string): number {
  return TASK_NOTE_PRIORITY[name] ?? 3;
}

/**
 * Truncate TASK_NOTES.md content with section-aware priority.
 * Preserves ## Next and ## Dead Ends fully, trims ## Progress from oldest.
 * Sections without recognized headers are treated as Progress.
 */
export function truncateTaskNotes(content: string, maxChars: number = 2000): string {
  if (!content || !content.trim()) return '';
  if (content.length <= maxChars) return content;

  const { preamble, sections } = parseTaskNoteSections(content);

  // No recognized sections — treat entire content as trimmable from top
  if (sections.length === 0) {
    const marker = `${TASK_NOTE_TRUNC_MARKER}\n`;
    return marker + content.slice(content.length - (maxChars - marker.length));
  }

  // Phase 1: Drop Progress/unrecognized sections; add back the tail of the
  // most recent Progress section if any budget remains.
  const withoutProgress = sections.filter(s => priorityFor(s.name) < 3);
  let result = preamble + withoutProgress.map(s => s.body).join('');
  if (result.length <= maxChars) {
    const progress = sections.filter(s => priorityFor(s.name) === 3);
    const remaining = maxChars - result.length;
    if (remaining > 20 && progress.length > 0) {
      const tail = progress[progress.length - 1].body;
      result += `\n${TASK_NOTE_TRUNC_MARKER}\n` + tail.slice(tail.length - remaining);
    }
    return result.length <= maxChars ? result : result.slice(0, maxChars);
  }

  // Phase 2: Drop Key Discoveries too.
  const highPriority = sections.filter(s => priorityFor(s.name) <= 1);
  result = preamble + highPriority.map(s => s.body).join('');
  if (result.length <= maxChars) return `${result}\n${TASK_NOTE_TRUNC_MARKER}`;

  // Phase 3: Hard truncate from end.
  return result.slice(0, maxChars - (TASK_NOTE_TRUNC_MARKER.length + 2)) + `\n${TASK_NOTE_TRUNC_MARKER}`;
}

/**
 * Detects whether tickets in a session span multiple repositories.
 * Returns an array of distinct working_dir values if 2+, null otherwise.
 * Tickets with working_dir: null are excluded (they use session default).
 */
export function detectMultiRepo(sessionDir: string): string[] | null {
  const tickets = collectTickets(sessionDir);
  const dirs = new Set(
    tickets
      .map(t => t.working_dir)
      .filter((d): d is string => d !== null && d !== undefined)
  );
  return dirs.size >= 2 ? [...dirs] : null;
}

/**
 * Returns tickets that are still pending (not Done, not Skipped) excluding
 * `currentTicket`. Used to fail-loud when the model emits EPIC_COMPLETED but
 * the ticket queue is not actually drained — silent loop-termination on a
 * partial epic is the most expensive class of bug for autonomous agents.
 *
 * Status comparison is case-insensitive and strips quotes (matches the
 * normalisation already used at line ~1017 and in monitor.ts).
 */
export function findPendingNonCurrentTickets(
  tickets: readonly TicketInfo[],
  currentTicket: string | null
): TicketInfo[] {
  const norm = (s: string | null): string =>
    (s || '').toLowerCase().replace(/["']/g, '').trim();
  return tickets.filter(t => {
    if (!t.id) return false;
    if (t.id === currentTicket) return false;
    const s = norm(t.status);
    return s !== 'done' && s !== 'skipped';
  });
}

/**
 * Decision returned by `evaluateEpicCompletion`. Replaces the prior fail-loud
 * "exit 1 on any false EPIC_COMPLETED" behaviour with structural recovery.
 *
 * - `genuine` — every ticket reports `status: Done` (case/quote-insensitive).
 *   Behave as today: mark current Done, exit success or chain meeseeks.
 * - `recover_advance` — manager lied about epic completion BUT current_ticket
 *   really is Done. Treat as a single TASK_COMPLETED; advance to next ticket,
 *   keep iterating. Increment false-epic counter for telemetry.
 * - `recover_retry` — manager lied AND current_ticket is not Done either.
 *   Force another iteration on the same ticket with a stricter retry brief.
 *   Increment counter; reset on next genuine advance.
 * - `persistent_hallucination` — counter has crossed the threshold for the
 *   same ticket. Bail with a distinct exit class so a human can intervene.
 *
 * Pure function — no I/O. Caller owns ticket collection, state mutation, and
 * iteration handoff. Behaviour is fully deterministic from inputs.
 */
export type EpicCompletionDecision =
  | { kind: 'genuine'; doneCount: number; totalCount: number }
  | { kind: 'recover_advance'; doneCount: number; totalCount: number; pendingIds: string[]; nextCount: number }
  | { kind: 'recover_retry'; doneCount: number; totalCount: number; pendingIds: string[]; nextCount: number }
  | { kind: 'persistent_hallucination'; doneCount: number; totalCount: number; ticket: string; nextCount: number };

export interface EvaluateEpicCompletionInput {
  tickets: readonly TicketInfo[];
  currentTicket: string | null;
  /** Prior counter value from `state.false_epic_completed_count` (0 if absent). */
  priorFalseCount: number;
  /** Ticket the prior counter is associated with. Counter resets when this differs from `currentTicket`. */
  priorFalseTicket: string | null;
  /** Threshold beyond which we exit with MANAGER_PERSISTENT_HALLUCINATION. Defaults to FALSE_EPIC_THRESHOLD. */
  threshold?: number;
}

/**
 * Decide what to do when the manager emits EPIC_COMPLETED. This is the
 * single source of truth for the recovery state machine — the main loop just
 * acts on the returned decision.
 */
export function evaluateEpicCompletion(input: EvaluateEpicCompletionInput): EpicCompletionDecision {
  const { tickets, currentTicket, priorFalseCount, priorFalseTicket } = input;
  const threshold = input.threshold ?? FALSE_EPIC_THRESHOLD;

  const norm = (s: string | null): string =>
    (s || '').toLowerCase().replace(/["']/g, '').trim();

  const totalCount = tickets.filter(t => !!t.id).length;
  const doneCount = tickets.filter(t => !!t.id && norm(t.status) === 'done').length;
  const pendingIds = tickets
    .filter(t => !!t.id && norm(t.status) !== 'done' && norm(t.status) !== 'skipped' && t.id !== currentTicket)
    .map(t => t.id!)
    .filter((s): s is string => typeof s === 'string');

  const currentInfo = currentTicket ? tickets.find(t => t.id === currentTicket) : null;
  const currentIsDone = !!currentInfo && norm(currentInfo.status) === 'done';

  // The current ticket is allowed to count as "about to be Done" because the
  // manager normally marks it Done in the same iteration as EPIC_COMPLETED.
  // We treat it as Done iff it is BOTH actually Done AND no other tickets are
  // pending. This keeps the genuine path identical to the prior guard.
  if (pendingIds.length === 0 && (currentTicket == null || currentIsDone)) {
    return { kind: 'genuine', doneCount, totalCount };
  }

  // From here on the manager lied. Bump the counter (resetting when ticket
  // changes — different ticket means we're not stuck in the same loop).
  const sameTicket = currentTicket != null && priorFalseTicket === currentTicket;
  const nextCount = (sameTicket ? priorFalseCount : 0) + 1;

  if (currentTicket != null && nextCount > threshold) {
    return { kind: 'persistent_hallucination', doneCount, totalCount, ticket: currentTicket, nextCount };
  }

  if (currentIsDone) {
    return { kind: 'recover_advance', doneCount, totalCount, pendingIds, nextCount };
  }
  return { kind: 'recover_retry', doneCount, totalCount, pendingIds, nextCount };
}

/**
 * Classifies iteration output into a completion result.
 * EPIC_COMPLETED → 'task_completed' (exits the loop — all tickets done)
 * EXISTENCE_IS_PAIN / THE_CITADEL_APPROVES → 'review_clean' (subject to min_iterations gate)
 * TASK_COMPLETED / anything else → 'continue' (single ticket done, loop continues)
 *
 * Only checks assistant message content (via extractAssistantContent) to avoid
 * false positives from promise tokens in reviewed source code.
 */
export function classifyCompletion(output: string): 'task_completed' | 'review_clean' | 'continue' {
  const content = extractAssistantContent(output);
  if (hasToken(content, PromiseTokens.EPIC_COMPLETED)) {
    return 'task_completed';
  }
  if (hasToken(content, PromiseTokens.EXISTENCE_IS_PAIN) || hasToken(content, PromiseTokens.THE_CITADEL_APPROVES)) {
    return 'review_clean';
  }
  return 'continue';
}

/**
 * Post-hoc safety net: validates whether a ticket was actually completed
 * before marking it Done. TASK_COMPLETED token is strong evidence. Otherwise
 * require a ticket-scoped lifecycle artifact — unscoped git diff alone is a
 * ghost source (changes from any other ticket in the tree pass). Never throws.
 */
export function classifyTicketCompletion(
  iterLogFile: string,
  workingDir: string,
  ticketDir?: string,
  role: WorkerRole = 'implementation'
): 'completed' | 'skipped' {
  try {
    const logContent = fs.readFileSync(iterLogFile, 'utf-8');
    const assistantContent = extractAssistantContent(logContent);
    if (hasToken(assistantContent, PromiseTokens.TASK_COMPLETED)) return 'completed';
  } catch (err) { process.stderr.write(`[mux-runner:classify-ticket:log-read] ${safeErrorMessage(err)}\n`); /* fall through to artifact check */ }

  if (!ticketDir) return 'skipped';
  let files: string[];
  try { files = fs.readdirSync(ticketDir); } catch { return 'skipped'; }
  if (!hasLifecycleArtifact(files, role)) return 'skipped';

  // Artifact exists — corroborate with git diff. Artifacts alone are
  // sufficient because the worker wrote them during its lifecycle, but a
  // dirty tree is a stronger signal that code actually changed.
  try {
    const uncommitted = runCmd(['git', 'diff', '--stat'], { cwd: workingDir, check: false });
    if (uncommitted.length > 0) return 'completed';
    const staged = runCmd(['git', 'diff', '--stat', '--cached'], { cwd: workingDir, check: false });
    if (staged.length > 0) return 'completed';
  } catch (err) { process.stderr.write(`[mux-runner:classify-ticket:git-probe] ${safeErrorMessage(err)}\n`); /* artifact alone suffices */ }

  return 'completed';
}

/**
 * Reads `pickle_settings.json` as an untyped bag, returning `{}` on any
 * read/parse failure. Emits a labeled stderr breadcrumb keyed by the caller
 * site so a missing/corrupt settings file never silently yields defaults.
 * Every call site in this module consumes its own subset of keys with its
 * own defaults; this helper owns only the file I/O + JSON decode step.
 */
function loadSettingsBag(extensionRoot: string, site: string): Record<string, unknown> {
  const settingsPath = path.join(extensionRoot, 'pickle_settings.json');
  const raw = readRecoverableJsonObject(settingsPath);
  if (raw) return raw as Record<string, unknown>;
  if (!fs.existsSync(settingsPath)) return {};
  try {
    fs.readFileSync(settingsPath, 'utf-8');
  } catch (err) {
    process.stderr.write(`[${site}] ${safeErrorMessage(err)}\n`);
  }
  return {};
}

function positiveIntegerOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Transitions a session from ticket-execution mode to Meeseeks review mode.
 * Pure function — returns a new state object without side effects.
 */
export function transitionToMeeseeks(state: State, extensionRoot: string): State {
  let minPasses = 10;
  let maxPasses = 50;

  const settings = loadSettingsBag(extensionRoot, 'mux-runner:transition-meeseeks:settings');
  const rawMin = Number(settings.default_meeseeks_min_passes);
  if (Number.isFinite(rawMin) && rawMin > 0) minPasses = rawMin;
  const rawMax = Number(settings.default_meeseeks_max_passes);
  if (Number.isFinite(rawMax) && rawMax > 0) maxPasses = rawMax;

  return {
    ...state,
    chain_meeseeks: false,
    command_template: 'meeseeks.md',
    min_iterations: minPasses,
    max_iterations: maxPasses,
    iteration: 0,
    step: 'review',
    current_ticket: null,
  };
}

// eslint-disable-next-line complexity -- pre-existing model tier resolver; out of scope for ticket 53caa9a4
export function loadMeeseeksModel(extensionRoot: string, passCount: number = 1): string {
  const fallback = 'sonnet';
  let defaultModel = fallback;
  let tiers: Record<string, string> | null = null;
  let maxOpusPasses = 3;
  let enableModelTiers = true;

  const raw = loadSettingsBag(extensionRoot, 'mux-runner:load-meeseeks-model:settings');
  if (typeof raw.default_meeseeks_model === 'string' && raw.default_meeseeks_model.length > 0) {
    defaultModel = raw.default_meeseeks_model;
  }
  if (raw.meeseeks_model_tiers && typeof raw.meeseeks_model_tiers === 'object') {
    tiers = raw.meeseeks_model_tiers as Record<string, string>;
  }
  const rawCap = Number(raw.max_opus_passes);
  if (Number.isFinite(rawCap) && rawCap > 0) maxOpusPasses = rawCap;
  // Feature flag: enable_model_tiers (default true — missing flag = enabled)
  if (raw.enable_model_tiers === false) enableModelTiers = false;

  if (!tiers || !enableModelTiers) return defaultModel;

  // Find the highest threshold that doesn't exceed passCount
  let resolvedModel = defaultModel;
  let highestThreshold = 0;
  for (const [key, model] of Object.entries(tiers)) {
    const threshold = Number(key);
    if (Number.isFinite(threshold) && threshold <= passCount && threshold > highestThreshold) {
      highestThreshold = threshold;
      resolvedModel = String(model);
    }
  }

  // Cap opus passes: if resolved model is opus and we've used more than the allowed count, fall back to sonnet
  if (resolvedModel === 'opus') {
    const opusPassNumber = passCount - highestThreshold + 1;
    if (opusPassNumber > maxOpusPasses) resolvedModel = 'sonnet';
  }

  return resolvedModel;
}

export function loadRateLimitSettings(extensionRoot: string): { waitMinutes: number; maxRetries: number } {
  let waitMinutes = 5;
  let maxRetries = 3;
  const raw = loadSettingsBag(extensionRoot, 'mux-runner:load-rate-limit-settings');
  const rawWait = raw.default_rate_limit_wait_minutes;
  if (typeof rawWait === 'number' && rawWait >= 1) waitMinutes = rawWait;
  const rawRetries = raw.default_max_rate_limit_retries;
  if (typeof rawRetries === 'number' && rawRetries >= 1) maxRetries = rawRetries;
  return { waitMinutes, maxRetries };
}

export function detectRateLimitInLog(logFile: string): RateLimitInfo {
  const result: RateLimitInfo = { limited: false, sawEvents: false };
  try {
    const content = fs.readFileSync(logFile, 'utf-8');
    const lines = content.split('\n');
    const tail = lines.slice(-100);
    for (const line of tail) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type !== 'rate_limit_event') continue;
        result.sawEvents = true;
        // Real API nests under rate_limit_info; check both paths for robustness
        const info = parsed.rate_limit_info ?? parsed;
        const status = info.status;
        if (status === 'rejected') {
          result.limited = true;
          if (typeof info.resetsAt === 'number') result.resetsAt = info.resetsAt;
          if (typeof info.rateLimitType === 'string') result.rateLimitType = info.rateLimitType;
        }
      } catch { /* not JSON */ }
    }
  } catch { /* file missing */ }
  return result;
}

export function detectRateLimitInText(logFile: string): boolean {
  try {
    const content = fs.readFileSync(logFile, 'utf-8');
    const lines = content.split('\n');
    // Only check the very tail — rate limit messages appear at the end when
    // the process is killed. 20 lines is plenty; 100 was catching assistant
    // text *about* rate limits as false positives.
    const tail = lines.slice(-20);
    // Filter out JSON content fields (assistant text, user messages, tool results)
    // to avoid matching on *discussion about* rate limits
    const filtered = tail.filter(l =>
      !l.includes('"type":"user"') &&
      !l.includes('"type":"tool_result"') &&
      !l.includes('"type":"assistant"') &&
      !l.includes('"type":"text"') &&
      !l.includes('"content":[') &&
      !l.includes('"content":"')
    );
    const text = filtered.join('\n');
    // Tightened patterns — require more specific phrasing to avoid matching
    // code comments or discussions about rate limiting
    const patterns = [
      /your .* usage limit has been reached/i,
      /usage is limited.*try again/i,
      /out of (extra )?usage/i,
      /rate limited.*try again/i,
    ];
    return patterns.some(p => p.test(text));
  } catch { /* file missing */ }
  return false;
}

export function classifyIterationExit(
  completionResult: string,
  logFile: string,
  timing?: { didTimeout: boolean; exitCode: number | null; wallSeconds: number },
): IterationExitResult {
  if (completionResult === 'inactive') return { type: 'inactive' };
  if (completionResult === 'error') return { type: 'error' };
  if (completionResult === 'task_completed' || completionResult === 'review_clean') return { type: 'success' };
  const rlInfo = detectRateLimitInLog(logFile);
  if (rlInfo.limited) return { type: 'api_limit', rateLimitInfo: rlInfo };
  // Only fall back to text detection if we found NO structured rate_limit_event
  // entries at all. If structured events exist but none say 'rejected', trust
  // that — don't let fuzzy text matching override structured signals.
  if (!rlInfo.sawEvents && detectRateLimitInText(logFile)) return { type: 'api_limit' };
  if (timing?.didTimeout) {
    return { type: 'timeout', exitCode: timing.exitCode, wallSeconds: timing.wallSeconds };
  }
  return { type: 'success' };
}

/**
 * Pure decision function: given rate limit context, returns whether to wait or bail.
 * Extracted from main() for testability. No side effects.
 *
 * When resetsAt is available from the API, always waits (the API told us when to come back).
 * Only bails when no resetsAt AND consecutive retries >= max.
 * Resets the counter after an API-guided wait completes.
 */
export function computeRateLimitAction(
  exitResult: IterationExitResult,
  consecutiveRateLimits: number,
  maxRetries: number,
  configWaitMinutes: number,
): RateLimitAction {
  const configWaitMs = configWaitMinutes * 60 * 1000;
  const maxApiWaitMs = configWaitMs * 3;
  let waitMs = configWaitMs;
  let waitSource: 'api' | 'config' = 'config';
  const rlResetsAt = exitResult.type === 'api_limit' ? exitResult.rateLimitInfo?.resetsAt : undefined;
  const hasResetsAt = typeof rlResetsAt === 'number' && rlResetsAt > 0;

  if (hasResetsAt) {
    const apiWaitMs = (rlResetsAt * 1000) - Date.now();
    if (apiWaitMs > 0 && apiWaitMs <= maxApiWaitMs) {
      waitMs = apiWaitMs + 30_000; // 30s buffer
      waitSource = 'api';
    }
    // apiWaitMs > maxApiWaitMs → capped, falls through to config default
    // apiWaitMs <= 0 → resetsAt in the past, use config default
  }

  // Bail only when blind (no resetsAt) AND retries exhausted
  if (!hasResetsAt && consecutiveRateLimits >= maxRetries) {
    return { action: 'bail', waitMs: 0, waitSource: 'config', resetCounter: false, hasResetsAt };
  }

  return {
    action: 'wait',
    waitMs,
    waitSource,
    resetCounter: waitSource === 'api',
    hasResetsAt,
  };
}

// eslint-disable-next-line max-lines-per-function, complexity -- ticket 53caa9a4 forbids modifying runIteration
export async function runIteration(sessionDir: string, iterationNum: number, extensionRoot: string, meeseeksModel: string): Promise<IterationOutcome> {
  const statePath = path.join(sessionDir, 'state.json');
  let state: State;
  try {
    state = readRunnerState(statePath);
  } catch (err) {
    const msg = safeErrorMessage(err);
    throw new Error(`Failed to read state.json for iteration ${iterationNum}: ${msg}`);
  }

  if (state.active !== true) return { completion: 'inactive', timedOut: false, exitCode: null, wallSeconds: 0 };

  const templateName = state.command_template || 'pickle.md';
  // Validate at read time (not just at setup.ts CLI parse time) — state.json could be tampered with
  if (templateName.includes('/') || templateName.includes('\\') || templateName.includes('..')) {
    throw new Error(`Invalid command_template in state.json: "${templateName}" — must be a plain filename`);
  }
  // Check internal templates first (hidden from slash command list), then user-facing commands.
  // Use extensionRoot for templatesDir so tests can inject an isolated directory via EXTENSION_DIR.
  const templatesDir = path.join(extensionRoot, 'templates');
  const commandsDir = path.join(os.homedir(), '.claude/commands');
  // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
  const picklePromptPath = fs.existsSync(path.join(templatesDir, templateName))
    ? path.join(templatesDir, templateName)
    : path.join(commandsDir, templateName);
  // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
  if (!fs.existsSync(picklePromptPath)) {
    throw new Error(`${templateName} not found in ${templatesDir} or ${commandsDir}. Run install.sh first.`);
  }
  // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
  let managerPrompt = fs.readFileSync(picklePromptPath, 'utf-8')
    .replace(/\$ARGUMENTS/g, `--resume ${sessionDir}`);

  managerPrompt = stripSetupSection(managerPrompt);

  const handoffPath = path.join(sessionDir, 'handoff.txt');
  // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
  if (fs.existsSync(handoffPath)) {
    // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
    managerPrompt += '\n\n' + fs.readFileSync(handoffPath, 'utf-8');
    // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
    try { fs.unlinkSync(handoffPath); } catch (unlinkErr) {
      const code = (unlinkErr as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'ENOENT') {
        console.warn(`[mux-runner] WARNING: Cannot remove handoff.txt (${code})`);
      }
    }
  } else {
    managerPrompt += '\n\n' + buildHandoffSummary(state, sessionDir, iterationNum);
  }

  const settings = loadSettingsBag(extensionRoot, 'mux-runner:run-iteration:settings');

  // Feature flag: enable_task_notes (default true — missing flag = enabled)
  const enableTaskNotes = settings.enable_task_notes !== false;

  // Inject TASK_NOTES.md from session directory (persists across iterations)
  if (enableTaskNotes) {
    const taskNotesPath = path.join(sessionDir, 'TASK_NOTES.md');
    try {
      // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
      if (fs.existsSync(taskNotesPath)) {
        // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
        const raw = fs.readFileSync(taskNotesPath, 'utf-8');
        const truncated = truncateTaskNotes(raw, 2000);
        if (truncated.trim()) {
          managerPrompt += '\n\n=== TASK NOTES (from previous iterations) ===\n' + truncated;
        }
      }
    } catch (readErr) {
      const msg = readErr instanceof Error ? readErr.message : String(readErr);
      console.warn(`[mux-runner] WARNING: task notes subsystem failed: ${msg}`);
    }
  }

  let maxTurns: number = Defaults.MANAGER_MAX_TURNS;
  maxTurns = positiveIntegerOrNull(settings.default_tmux_max_turns)
    ?? positiveIntegerOrNull(settings.default_manager_max_turns)
    ?? maxTurns;
  const logFile = path.join(sessionDir, `tmux_iteration_${iterationNum}.log`);
  const backend = resolveBackend(state);
  // meeseeks review passes run on a cheaper model (default: sonnet on claude).
  // Codex exposes a different model vocabulary, so only apply the override for claude.
  const iterationModel = templateName === 'meeseeks.md' && meeseeksModel && backend === 'claude'
    ? meeseeksModel
    : undefined;
  const invocation = buildManagerInvocation(backend, {
    prompt: managerPrompt,
    addDirs: [extensionRoot, getDataRoot(), sessionDir],
    model: iterationModel,
    maxTurns,
    streamJson: true,
    noSessionPersistence: true,
  });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...backendEnvOverrides(backend),
    PICKLE_STATE_FILE: statePath,
    PYTHONUNBUFFERED: '1',
  };
  // Remove CLAUDECODE so the spawned claude process doesn't think it's nested
  // inside another Claude Code session (which would alter its behavior).
  delete env['CLAUDECODE'];
  // Remove PICKLE_ROLE so manager subprocesses aren't misidentified as workers
  // by the stop-hook (tmux-runner spawns managers, not workers).
  delete env['PICKLE_ROLE'];

  // Use a raw file descriptor with synchronous writes so every chunk hits
  // the disk immediately. Node's WriteStream buffers up to 16KB internally,
  // which starves log-watcher (it polls file size via statSync).
  // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
  const logFd = fs.openSync(logFile, 'w');

  function writeToLog(chunk: Buffer) {
    try { fs.writeSync(logFd, chunk); } catch { /* fd closed — ignore late writes */ }
  }

  return new Promise((resolve) => {
    let settled = false;
    const start = Date.now();
    let didTimeout = false;

    const proc = spawn(invocation.cmd, invocation.args, {
      cwd: state.working_dir || process.cwd(),
      env,
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    currentChildProc = proc;

    const hangGuardMs = Defaults.MAX_ITERATION_SECONDS * 1000;
    const hangGuard = setTimeout(() => {
      if (settled) return;
      settled = true;
      didTimeout = true;
      currentChildProc = null;
      try { proc.kill('SIGTERM'); } catch { /* already dead */ }
      try { fs.fsyncSync(logFd); } catch { /* already closed or error */ }
      try { fs.closeSync(logFd); } catch { /* already closed */ }
      console.error(`${Style.RED}❌ Iteration ${iterationNum} hang detected — forcing failure${Style.RESET}`);
      resolve({ completion: 'error', timedOut: true, exitCode: null, wallSeconds: (Date.now() - start) / 1000 });
    }, hangGuardMs);
    hangGuard.unref();

    // Direct data handlers: write each chunk to both the log file (sync,
    // no buffering) and the terminal (for the tmux-runner pane).
    proc.stdout?.on('data', (chunk: Buffer) => {
      writeToLog(chunk);
      process.stderr.write(chunk);
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      writeToLog(chunk);
      process.stderr.write(chunk);
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      currentChildProc = null;
      if (hangGuard) clearTimeout(hangGuard);
      try { fs.fsyncSync(logFd); } catch { /* already closed or error */ }
      try { fs.closeSync(logFd); } catch { /* already closed */ }
      const exitCodeFile = logFile.replace('.log', '.exitcode');
      try { fs.writeFileSync(exitCodeFile, String(code ?? -1)); } catch { /* best effort */ }
      let output = '';
      try { output = fs.readFileSync(logFile, 'utf-8'); } catch { /* missing/unreadable log */ }
      resolve({
        completion: classifyCompletion(output),
        timedOut: didTimeout,
        exitCode: code ?? null,
        wallSeconds: (Date.now() - start) / 1000,
      });
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      currentChildProc = null;
      if (hangGuard) clearTimeout(hangGuard);
      const msg = safeErrorMessage(err);
      console.error(`${Style.RED}Failed to spawn ${invocation.cmd}: ${msg}${Style.RESET}`);
      try { fs.fsyncSync(logFd); } catch { /* already closed or error */ }
      try { fs.closeSync(logFd); } catch { /* already closed */ }
      resolve({ completion: 'error', timedOut: false, exitCode: null, wallSeconds: (Date.now() - start) / 1000 });
    });
  });
}

/**
 * Atomically writes handoff.txt via a tmp file + rename.
 * On rename failure, falls back to a direct (non-atomic) write.
 * On both failures, logs an error but does NOT throw — handoff is non-critical.
 * Warns (does not throw) when tmp cleanup unlinkSync hits EACCES/ENOENT.
 *
 * @param sessionDir  - session directory path
 * @param content     - handoff content to write
 * @param pid         - process id used to make tmp filename unique
 * @param log         - logging function (e.g. the runner's log() closure)
 * @param fsOps       - injectable fs subset (default: real fs — override in tests)
 */
export function writeHandoffAtomic(
  sessionDir: string,
  content: string,
  pid: number,
  log: (msg: string) => void,
  fsOps: { writeFileSync: typeof fs.writeFileSync; renameSync: typeof fs.renameSync; unlinkSync: typeof fs.unlinkSync } = fs
): void {
  const handoffTmp = path.join(sessionDir, `handoff.txt.tmp.${pid}`);
  const handoffPath = path.join(sessionDir, 'handoff.txt');

  // Step 1: write to tmp
  try {
    fsOps.writeFileSync(handoffTmp, content);
  } catch (err) {
    const msg = safeErrorMessage(err);
    log(`ERROR: handoff.txt tmp write failed (non-critical): ${msg}`);
    return;
  }

  // Step 2: atomic rename
  try {
    fsOps.renameSync(handoffTmp, handoffPath);
    return; // success
  } catch {
    log('WARNING: handoff.txt rename failed — falling back to direct write');
  }

  // Step 3: non-atomic fallback
  try {
    fsOps.writeFileSync(handoffPath, content);
  } catch (writeErr) {
    const msg = safeErrorMessage(writeErr);
    log(`ERROR: handoff.txt write failed (non-critical): ${msg}`);
  }

  // Step 4: clean up leftover tmp
  try {
    fsOps.unlinkSync(handoffTmp);
  } catch (unlinkErr) {
    const code = (unlinkErr as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'ENOENT') {
      log(`WARNING: Cannot remove tmp handoff file (${code})`);
    }
  }
}

// ---------------------------------------------------------------------------
// Commit-pending health probe (codex-only) — RCA: codex-backend "commit-skip"
// failure mode. Codex sometimes produces edits but never `git add` + `git
// commit`, leaving valid work orphaned in the working tree when the breaker
// trips. Pre-spawn we detect uncommitted edits + iteration stagnation and
// nudge the next worker turn to commit and signal Done with a DEFERRED note.
// ---------------------------------------------------------------------------

export interface CommitPendingProbeInput {
  sessionDir: string;
  workingDir: string;
  backend: Backend;
  iteration: number;
  lastProgressIteration: number;
  threshold: number;
  pid: number;
  log: (msg: string) => void;
}

export type CommitPendingProbeResult =
  | 'skipped:not-codex'
  | 'skipped:no-stagnation'
  | 'skipped:no-uncommitted'
  | 'skipped:existing-handoff'
  | 'fired';

export const COMMIT_PENDING_HANDOFF_TEXT = `## CIRCUIT BREAKER HEALTH PROBE — COMMIT PENDING

You have uncommitted edits in the working tree but the iteration counter has not advanced for N iterations. This commonly means you are looping on a contradiction or over-exploring instead of shipping.

REQUIRED THIS TURN:
1. Run \`git add <files>\` and \`git commit -m "<msg>"\` to lock in current edits.
2. If an acceptance criterion is blocked (e.g. fixture mismatch, missing dependency), append a \`# DEFERRED: <reason>\` line to the ticket file and signal Done.
3. Do NOT continue exploring — your unblocked subset is already valuable and must not be orphaned.

After committing, emit \`<promise>${PromiseTokens.WORKER_DONE}</promise>\` as usual.
`;

/**
 * Pre-spawn health probe. Detects the codex "commit-skip" failure mode:
 * uncommitted edits in the working tree combined with iteration counter
 * stagnation. When triggered, writes handoff.txt with a direct nudge so the
 * next worker turn commits + signals Done before the circuit breaker trips.
 *
 * Triggers ONLY when ALL are true:
 *   - backend === 'codex' (claude lacks this failure mode per RCA)
 *   - iteration - lastProgressIteration >= threshold (default 2)
 *   - `git diff --stat` OR `git diff --stat --cached` is non-empty
 *
 * Idempotent: if handoff.txt already exists at probe time (e.g. user-written
 * or rate-limit handoff), the probe defers and skips. Never throws — best
 * effort. Returns a string status for tests/logs.
 */
export function commitPendingProbe(input: CommitPendingProbeInput): CommitPendingProbeResult {
  const { sessionDir, workingDir, backend, iteration, lastProgressIteration, threshold, pid, log } = input;

  if (backend !== 'codex') return 'skipped:not-codex';

  const stagnation = iteration - lastProgressIteration;
  if (stagnation < threshold) return 'skipped:no-stagnation';

  const handoffPath = path.join(sessionDir, 'handoff.txt');
  if (fs.existsSync(handoffPath)) {
    log(`commit-pending probe deferred: existing handoff.txt at ${handoffPath}`);
    return 'skipped:existing-handoff';
  }

  // Detect uncommitted edits using the same git-diff pattern as
  // classifyTicketCompletion (lines ~381-384). Both unstaged and staged
  // diffs count as "pending commit" — codex has been observed leaving
  // either flavor.
  let hasUncommitted = false;
  try {
    const unstaged = runCmd(['git', 'diff', '--stat'], { cwd: workingDir, check: false });
    if (unstaged.length > 0) hasUncommitted = true;
    if (!hasUncommitted) {
      const staged = runCmd(['git', 'diff', '--stat', '--cached'], { cwd: workingDir, check: false });
      if (staged.length > 0) hasUncommitted = true;
    }
  } catch (err) {
    log(`commit-pending probe: git probe failed (${safeErrorMessage(err)}) — skipping`);
    return 'skipped:no-uncommitted';
  }

  if (!hasUncommitted) return 'skipped:no-uncommitted';

  const content = COMMIT_PENDING_HANDOFF_TEXT.replace('N iterations', `${stagnation} iterations`);
  writeHandoffAtomic(sessionDir, content, pid, log);
  log(`commit-pending probe FIRED: stagnation=${stagnation} (>= threshold ${threshold}), uncommitted edits present — handoff.txt written`);
  return 'fired';
}

export interface MuxReadinessGateInput {
  sessionDir: string;
  repoRoot: string;
  extensionRoot: string;
  log: (msg: string) => void;
}

export function runMuxReadinessGate(input: MuxReadinessGateInput): number {
  const localBinPath = path.join(input.extensionRoot, 'extension', 'bin', 'check-readiness.js');
  const installedBinPath = path.join(input.extensionRoot, 'bin', 'check-readiness.js');
  const binPath = fs.existsSync(localBinPath) ? localBinPath : installedBinPath;
  if (!fs.existsSync(binPath)) {
    input.log(`readiness gate skipped: ${binPath} not found`);
    return 0;
  }
  const result = spawnSync(process.execPath, [
    binPath,
    '--session-dir', input.sessionDir,
    '--repo-root', input.repoRoot,
  ], {
    cwd: input.repoRoot,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.status ?? 1;
}

/**
 * Best-effort append of a one-line marker to `pipeline-runner.log` in the
 * session directory. The pipeline-runner owns that file when it spawns
 * mux-runner; in standalone mux-runner runs the file may not exist (we never
 * create it). Failure is silent — the same marker also lands in mux-runner's
 * own log via the caller's `log()`. This exists so a human reading the
 * pipeline log alone sees the recovery event.
 */
export function appendPipelineRunnerMarker(sessionDir: string, message: string): void {
  const target = path.join(sessionDir, 'pipeline-runner.log');
  if (!fs.existsSync(target)) return; // standalone mux-runner — nothing to annotate
  try {
    fs.appendFileSync(target, `[${new Date().toISOString()}] [mux-runner] ${message}\n`);
  } catch { /* non-critical — the marker is also in mux-runner.log */ }
}

export type ExitReason = 'success' | 'cancelled' | 'error' | 'limit' | 'stall' | 'circuit_open' | 'rate_limit_exhausted' | 'timeout_repeat' | 'manager_persistent_hallucination';

const isHaltExit = (r: ExitReason): boolean => r === 'cancelled' || r === 'limit' || r === 'timeout_repeat';
const isFailureExit = (r: ExitReason): boolean => r === 'error' || r === 'stall' || r === 'circuit_open' || r === 'rate_limit_exhausted' || r === 'timeout_repeat' || r === 'manager_persistent_hallucination';

// ---------------------------------------------------------------------------
// Per-ticket timeout counter (FR-B3/B4/B12/B14) — non-persisted loop state
// ---------------------------------------------------------------------------

export interface TimeoutCounterState {
  count: number;
  ticket: string | null;
}

export interface TimeoutCounterInput {
  prev: TimeoutCounterState;
  ticketNow: string | null;
  timedOut: boolean;
  completedClean: boolean;
}

/**
 * Pure counter update: increment on same-ticket timeout, reset to 1 on
 * different-ticket timeout, zero on clean completion, pass-through otherwise.
 * `halt: true` when count reaches 2 on the same ticket.
 */
export function applyTimeoutCounter(input: TimeoutCounterInput): TimeoutCounterState & { halt: boolean } {
  const { prev, ticketNow, timedOut, completedClean } = input;
  if (timedOut) {
    if (ticketNow !== null && ticketNow === prev.ticket) {
      const count = prev.count + 1;
      return { count, ticket: ticketNow, halt: count >= 2 };
    }
    return { count: 1, ticket: ticketNow, halt: false };
  }
  if (completedClean) {
    return { count: 0, ticket: null, halt: false };
  }
  return { count: prev.count, ticket: prev.ticket, halt: false };
}

export interface TimeoutHaltContext {
  statePath: string;
  sessionDir: string;
  ticketNow: string | null;
  timeoutCount: number;
}

/**
 * Halt side-effects for FR-B12/B14: reset CB (prevent orphan streak),
 * write state.json.activity entry, emit structured stderr JSON with
 * remediation_code=RAISE_TIMEOUT, safeDeactivate. Caller sets exitReason
 * and breaks the loop.
 */
export function executeTimeoutHalt(ctx: TimeoutHaltContext): void {
  const { statePath, sessionDir, ticketNow, timeoutCount } = ctx;
  resetCircuitBreaker(sessionDir, 'timeout_repeat halt');
  writeActivityEntry(statePath, {
    event: 'halt',
    halt_reason: 'timeout_repeat',
    halted_ticket: ticketNow,
    halted_at: new Date().toISOString(),
    timeout_count: timeoutCount,
    remediation: `Re-run via /pickle-pipeline --worker-timeout <N> for fresh session, or edit worker_timeout_seconds in ${statePath} and run /pickle-retry for this session.`,
  });
  console.error(JSON.stringify({
    exit_reason: 'timeout_repeat',
    remediation_code: 'RAISE_TIMEOUT',
    ticket_id: ticketNow,
    timeout_count: timeoutCount,
    message: 'Ticket timed out on 2 consecutive attempts.',
    state_path: statePath,
  }));
  safeDeactivate(statePath);
}

export type LoopAction =
  | ({ kind: 'continue' } & LoopActionEffects)
  | ({ kind: 'break'; reason: ExitReason } & LoopActionEffects)
  | ({ kind: 'noop' } & LoopActionEffects)
  | ({ kind: 'relaunch'; relaunchCount: number; pendingTickets: number } & LoopActionEffects);

interface LoopActionEffects {
  consecutiveRateLimits?: number;
  timeoutCount?: number;
  lastTimeoutTicket?: string | null;
  cbState?: CircuitBreakerState | null;
  resetStall?: boolean;
}

export interface LoopContext {
  sessionDir: string;
  statePath: string;
  extensionRoot: string;
  iteration: number;
  log: (msg: string) => void;
  exitResult?: IterationExitResult;
  outcome?: IterationOutcome;
  iterLogFile?: string;
  consecutiveRateLimits?: number;
  maxRateLimitRetries?: number;
  rateLimitWaitMinutes?: number;
  cbEnabled?: boolean;
  cbState?: CircuitBreakerState | null;
  cbSettings?: CircuitBreakerConfig;
  cbPath?: string;
  timeoutCount?: number;
  lastTimeoutTicket?: string | null;
  lastStateIteration?: number;
  stallCount?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  readState?: (statePath: string) => State;
  deactivate?: (statePath: string) => void;
  writeState?: (targetPath: string, value: unknown) => void;
  unlink?: (targetPath: string) => void;
  writeHandoff?: (sessionDir: string, content: string, pid: number, log: (msg: string) => void) => void;
  writeTimeout?: typeof writeTimeoutStub;
  updateState?: (mutator: (state: State) => void) => void;
  transitionToMeeseeks?: (state: State) => State;
}

function ctxNow(ctx: LoopContext): number {
  return ctx.now ? ctx.now() : Date.now();
}

function ctxReadState(ctx: LoopContext): State {
  return (ctx.readState || readRunnerState)(ctx.statePath);
}

function ctxDeactivate(ctx: LoopContext): void {
  (ctx.deactivate || safeDeactivate)(ctx.statePath);
}

function writeLoopState(ctx: LoopContext, targetPath: string, value: unknown): void {
  (ctx.writeState || writeStateFile)(targetPath, value as object);
}

function applyTimeoutCounterForLoop(input: TimeoutCounterInput): TimeoutCounterState & { halt: boolean } {
  return applyTimeoutCounter({ ...input });
}

function unlinkLoopPath(ctx: LoopContext, targetPath: string): void {
  if (ctx.unlink) {
    ctx.unlink(targetPath);
    return;
  }
  try { fs.unlinkSync(targetPath); } catch { /* ok */ }
}

export function validateStartupState(state: State, statePath: string): void {
  const rawObj = state as unknown as Record<string, unknown>;
  const issues: string[] = [];
  const maxIterField = rawObj.max_iterations;
  const rawMaxIter = Number(maxIterField);
  if (maxIterField == null || !Number.isFinite(rawMaxIter) || rawMaxIter < 0) {
    issues.push(`max_iterations must be >= 0 (got ${maxIterField})`);
  }
  const rawTimeout = Number(rawObj.worker_timeout_seconds);
  if (!Number.isFinite(rawTimeout) || rawTimeout <= 0) issues.push(`worker_timeout_seconds must be > 0 (got ${rawObj.worker_timeout_seconds})`);
  else if (rawTimeout > 86400) issues.push(`worker_timeout_seconds > 86400s implausible (got ${rawTimeout}); edit state.json`);
  const iterField = rawObj.iteration;
  const rawIter = Number(iterField);
  if (iterField == null || !Number.isFinite(rawIter) || rawIter < 0) issues.push(`iteration must be >= 0 (got ${iterField})`);
  if (issues.length > 0) throw new Error(`Invalid state at ${statePath}:\n  - ${issues.join('\n  - ')}`);
}

export function setupSignalHandlers(statePath: string, log: (msg: string) => void): void {
  const handleShutdownSignal = (signal: string) => {
    log(`Received ${signal} — deactivating session`);
    safeDeactivate(statePath);
    if (currentChildProc && !currentChildProc.killed) currentChildProc.kill('SIGTERM');
    logActivity({ event: 'session_end', source: 'pickle', session: path.basename(path.dirname(statePath)), mode: 'tmux' });
    process.exit(0);
  };
  process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'));
  process.on('SIGINT', () => handleShutdownSignal('SIGINT'));
  process.on('SIGHUP', () => handleShutdownSignal('SIGHUP'));
}

/**
 * AC-LPB-04: classify a `StateManager.read()` failure on the per-iteration
 * cap-check read.
 *
 * `SCHEMA_MISMATCH` is a recoverable concurrent-writer race — a fresh read
 * on the next outer-loop turn will see the migrated state. Emit an
 * escalation activity event so the user can act if it persists, surface the
 * failure to `mux-runner.log` for visibility, then signal `'continue'` so
 * the caller retries instead of exiting (which would strand pending work).
 *
 * Every other StateError code (MISSING, CORRUPT, LOCK_FAILED, …) is
 * terminal — return `'exit_error'` so the legacy code path runs.
 */
export type CapCheckReadDecision = 'continue' | 'exit_error';
export function classifyCapCheckReadError(
  err: unknown,
  sessionDir: string,
  log: (msg: string) => void,
): CapCheckReadDecision {
  const msg = safeErrorMessage(err);
  const code = err && typeof err === 'object' ? (err as { code?: string }).code : undefined;
  if (code === 'SCHEMA_MISMATCH') {
    log(`WARN: state.json schema mismatch on cap-check read: ${msg}. Retrying next iteration.`);
    logActivity({
      event: 'cap_check_failed_schema_mismatch',
      source: 'pickle',
      session: path.basename(sessionDir),
      error: msg,
    });
    return 'continue';
  }
  log(`ERROR: Cannot read state.json: ${msg}. Exiting loop.`);
  return 'exit_error';
}

export function shouldExitMainLoop(state: State, ctx: LoopContext): { exit: true; reason: ExitReason } | { exit: false } {
  if (state.active !== true) {
    ctx.log('Session inactive. Exiting.');
    return { exit: true, reason: 'cancelled' };
  }
  const curIter = Number.isFinite(Number(state.iteration)) ? Number(state.iteration) : 0;
  const limitAction = shouldExitForLimits(state, ctx, curIter);
  if (limitAction.exit) return limitAction;
  if (ctx.cbEnabled && ctx.cbState && !canExecute(ctx.cbState)) {
    ctx.log(`Circuit breaker OPEN: ${ctx.cbState.reason}. Exiting.`);
    ctxDeactivate(ctx);
    return { exit: true, reason: 'circuit_open' };
  }
  if (!ctx.cbEnabled && curIter === ctx.lastStateIteration && (ctx.stallCount || 0) >= 1) {
    ctx.log(`WARNING: state.iteration has not advanced in 2 outer-loop iterations (stuck at ${state.iteration}). Exiting to avoid wasted API calls.`);
    ctxDeactivate(ctx);
    return { exit: true, reason: 'stall' };
  }
  return { exit: false };
}

function shouldExitForLimits(state: State, ctx: LoopContext, curIter: number): { exit: true; reason: ExitReason } | { exit: false } {
  const maxIter = Number.isFinite(Number(state.max_iterations)) ? Number(state.max_iterations) : 0;
  if (maxIter > 0 && curIter >= maxIter) {
    ctx.log(`Max iterations reached (${curIter}/${maxIter}). Exiting.`);
    ctxDeactivate(ctx);
    return { exit: true, reason: 'limit' };
  }
  const startEpoch = Number.isFinite(Number(state.start_time_epoch)) ? Number(state.start_time_epoch) : 0;
  const maxTimeMins = Number.isFinite(Number(state.max_time_minutes)) ? Number(state.max_time_minutes) : 0;
  const elapsed = startEpoch > 0 ? Math.max(0, Math.floor(ctxNow(ctx) / 1000) - startEpoch) : 0;
  if (maxTimeMins > 0 && startEpoch > 0 && elapsed >= maxTimeMins * 60) {
    ctx.log(`Time limit reached (${elapsed}s). Exiting.`);
    ctxDeactivate(ctx);
    return { exit: true, reason: 'limit' };
  }
  return { exit: false };
}

export async function processRateLimitCycle(state: State, ctx: LoopContext): Promise<LoopAction> {
  const exitResult = ctx.exitResult;
  if (exitResult?.type !== 'api_limit') return { kind: 'noop' };
  const consecutiveRateLimits = (ctx.consecutiveRateLimits || 0) + 1;
  const maxRetries = ctx.maxRateLimitRetries || 3;
  const waitMinutes = ctx.rateLimitWaitMinutes || 5;
  ctx.log(`API rate limit detected (consecutive: ${consecutiveRateLimits}/${maxRetries})`);
  const rlAction = computeRateLimitAction(exitResult, consecutiveRateLimits, maxRetries, waitMinutes);
  if (rlAction.action === 'bail') {
    logActivity({ event: 'rate_limit_exhausted', source: 'pickle', session: path.basename(ctx.sessionDir), error: `max retries (${maxRetries}) exceeded, no resetsAt available` });
    ctxDeactivate(ctx);
    return { kind: 'break', reason: 'rate_limit_exhausted', consecutiveRateLimits };
  }
  return processRateLimitWait(state, ctx, exitResult, rlAction, consecutiveRateLimits);
}

async function processRateLimitWait(
  state: State,
  ctx: LoopContext,
  exitResult: Extract<IterationExitResult, { type: 'api_limit' }>,
  rlAction: RateLimitAction,
  consecutiveRateLimits: number,
): Promise<LoopAction> {
  const waitSource = rlAction.waitSource;
  const waitPath = path.join(ctx.sessionDir, 'rate_limit_wait.json');
  const waitUntil = new Date(ctxNow(ctx) + rlAction.waitMs).toISOString();
  logActivity({ event: 'rate_limit_wait', source: 'pickle', session: path.basename(ctx.sessionDir), duration_min: Math.ceil(rlAction.waitMs / 60_000) });
  writeLoopState(ctx, waitPath, {
    waiting: true, reason: 'API rate limit', started_at: new Date(ctxNow(ctx)).toISOString(), wait_until: waitUntil,
    consecutive_waits: consecutiveRateLimits, rate_limit_type: exitResult.rateLimitInfo?.rateLimitType || null,
    resets_at_epoch: exitResult.rateLimitInfo?.resetsAt || null, wait_source: waitSource,
  });
  const limitedWait = await waitThroughRateLimit(state, ctx, rlAction.waitMs);
  if (limitedWait.exit) return { kind: 'break', reason: limitedWait.reason, consecutiveRateLimits };
  unlinkLoopPath(ctx, waitPath);
  const nextConsecutive = rlAction.resetCounter ? 0 : consecutiveRateLimits;
  logActivity({ event: 'rate_limit_resume', source: 'pickle', session: path.basename(ctx.sessionDir) });
  const handoffContent = [
    buildHandoffSummary(state, ctx.sessionDir, ctx.iteration + 1), '',
    `NOTE: Resumed after ${Math.ceil(rlAction.waitMs / 60_000)}-minute API rate limit wait (source: ${waitSource}).`,
    'Resume from current phase — do not repeat the rate-limited iteration.',
  ].join('\n');
  (ctx.writeHandoff || writeHandoffAtomic)(ctx.sessionDir, handoffContent, process.pid, ctx.log);
  return { kind: 'continue', consecutiveRateLimits: nextConsecutive };
}

async function waitThroughRateLimit(state: State, ctx: LoopContext, computedWaitMs: number): Promise<{ exit: false } | { exit: true; reason: ExitReason }> {
  const epoch = Number.isFinite(Number(state.start_time_epoch)) ? Number(state.start_time_epoch) : 0;
  const maxMins = Number.isFinite(Number(state.max_time_minutes)) ? Number(state.max_time_minutes) : 0;
  let actualWaitMs = computedWaitMs;
  if (maxMins > 0 && epoch > 0) {
    const remaining = (maxMins * 60) - (Math.floor(ctxNow(ctx) / 1000) - epoch);
    if (remaining <= 0) {
      ctxDeactivate(ctx);
      return { exit: true, reason: 'limit' };
    }
    actualWaitMs = Math.min(actualWaitMs, remaining * 1000);
  }
  const waitEnd = ctxNow(ctx) + actualWaitMs;
  while (ctxNow(ctx) < waitEnd) {
    await (ctx.sleep || sleep)(Defaults.RATE_LIMIT_POLL_MS);
    try {
      if (ctxReadState(ctx).active !== true) return { exit: true, reason: 'cancelled' };
    } catch { /* proceed */ }
    if (maxMins > 0 && epoch > 0 && Math.floor(ctxNow(ctx) / 1000) - epoch >= maxMins * 60) return { exit: true, reason: 'limit' };
  }
  return { exit: false };
}

export async function processIterationOutcome(state: State, outcome: IterationOutcome, ctx: LoopContext): Promise<LoopAction> {
  const result = outcome.completion;
  const timeoutAction = processTimeoutOutcome(state, outcome, ctx);
  if (timeoutAction.kind === 'break') return timeoutAction;
  const cbAction = recordCircuitBreakerOutcome(state, result, ctx);
  if (cbAction.kind === 'break') return { ...timeoutAction, ...cbAction };
  const branchAction = await processCompletionBranch(state, result, ctx);
  return { ...timeoutAction, ...branchAction, cbState: cbAction.cbState };
}

function processTimeoutOutcome(state: State, outcome: IterationOutcome, ctx: LoopContext): LoopAction {
  let ticketForTimeout: string | null = state.current_ticket || null;
  try { ticketForTimeout = ctxReadState(ctx).current_ticket || null; } catch { /* keep pre-iteration ticket */ }
  const counterNext = applyTimeoutCounterForLoop({
    prev: { count: ctx.timeoutCount || 0, ticket: ctx.lastTimeoutTicket || null },
    ticketNow: ticketForTimeout,
    timedOut: outcome.timedOut === true,
    completedClean: outcome.completion === 'task_completed',
  });
  if (outcome.timedOut) {
    (ctx.writeTimeout || writeTimeoutStub)(ctx.sessionDir, {
      ticketId: ticketForTimeout, iteration: ctx.iteration, wallSeconds: outcome.wallSeconds,
      workerTimeoutSeconds: Number(state.worker_timeout_seconds) || 0, timeoutCount: counterNext.count,
      logFile: ctx.iterLogFile || path.join(ctx.sessionDir, `tmux_iteration_${ctx.iteration}.log`),
    });
  }
  if (!counterNext.halt) return { kind: 'noop', timeoutCount: counterNext.count, lastTimeoutTicket: counterNext.ticket };
  ctx.log(`Timeout halt: ticket ${ticketForTimeout} timed out ${counterNext.count} consecutive iterations`);
  executeTimeoutHalt({ statePath: ctx.statePath, sessionDir: ctx.sessionDir, ticketNow: ticketForTimeout, timeoutCount: counterNext.count });
  // Preserves the legacy source-order invariant: exitReason = 'timeout_repeat' before break.
  return { kind: 'break', reason: 'timeout_repeat', timeoutCount: counterNext.count, lastTimeoutTicket: counterNext.ticket };
}

function recordCircuitBreakerOutcome(state: State, result: IterationOutcome['completion'], ctx: LoopContext): LoopAction {
  if (!ctx.cbEnabled || !ctx.cbState || !ctx.cbSettings || result === 'error' || result === 'inactive') return { kind: 'noop', cbState: ctx.cbState };
  const errorSig = readCircuitBreakerErrorSignature(ctx);
  const postIterState = readPostIterationState(state, ctx);
  const progress = detectProgress(
    postIterState.working_dir || process.cwd(), ctx.cbState.last_known_head, ctx.cbState.last_known_step,
    postIterState.step, ctx.cbState.last_known_ticket, postIterState.current_ticket,
  );
  const prevCBState = ctx.cbState.state;
  const cbState = recordIterationResult(ctx.cbState, { hasProgress: progress.hasProgress, errorSignature: errorSig }, ctx.iteration, ctx.cbSettings);
  cbState.last_known_head = progress.currentHead;
  cbState.last_known_step = postIterState.step;
  cbState.last_known_ticket = postIterState.current_ticket;
  if (ctx.cbPath) writeLoopState(ctx, ctx.cbPath, cbState);
  if (prevCBState !== 'OPEN' && cbState.state === 'OPEN') {
    logActivity({ event: 'circuit_open', source: 'pickle', session: path.basename(ctx.sessionDir), error: cbState.reason });
    ctx.log(`Circuit breaker tripped: ${cbState.reason}`);
    ctxDeactivate(ctx);
    return { kind: 'break', reason: 'circuit_open', cbState };
  }
  if (prevCBState === 'HALF_OPEN' && cbState.state === 'CLOSED') {
    logActivity({ event: 'circuit_recovery', source: 'pickle', session: path.basename(ctx.sessionDir) });
    ctx.log('Circuit breaker recovered (HALF_OPEN → CLOSED)');
  }
  return { kind: 'noop', cbState };
}

function readCircuitBreakerErrorSignature(ctx: LoopContext): string | null {
  try {
    const logContent = fs.readFileSync(ctx.iterLogFile || '', 'utf-8');
    return logContent ? extractErrorSignature(logContent) : null;
  } catch {
    return null;
  }
}

function readPostIterationState(state: State, ctx: LoopContext): State {
  try {
    return ctxReadState(ctx);
  } catch {
    return state;
  }
}

/**
 * Codex tmux_mode runs ONE long-lived manager subprocess that internally
 * loops across many tickets. The 4h `Defaults.MAX_ITERATION_SECONDS`
 * hang-guard SIGTERMs that subprocess and resolves the iteration with
 * `{ completion: 'error', timedOut: true }`. The legacy error branch
 * unconditionally deactivates the session, stranding any tickets that
 * the manager had not yet picked up.
 *
 * This helper computes whether mux-runner should relaunch the codex
 * manager (next outer-loop iteration spawns a fresh subprocess that
 * resumes the remaining ticket queue) instead of exiting.
 *
 * Conditions (ALL must hold):
 *   - backend === 'codex' (claude is per-ticket; an error there is terminal)
 *   - tickets remain (Todo or In Progress, status normalized lower-case
 *     and quote-stripped to match the rest of the file)
 *   - relaunch counter is below `Defaults.CODEX_MANAGER_RELAUNCH_CAP`
 *   - circuit breaker is not OPEN (a tripped CB is the real failure mode
 *     and must surface; relaunch cannot heal it)
 */
export interface CodexRelaunchDecision {
  shouldRelaunch: boolean;
  pendingCount: number;
  nextRelaunchCount: number;
  reason: 'eligible' | 'not_codex' | 'no_pending' | 'cap_exceeded' | 'circuit_open' | 'time_limit';
}

export function evaluateCodexManagerRelaunch(
  state: State,
  tickets: readonly TicketInfo[],
  cbState: CircuitBreakerState | null,
): CodexRelaunchDecision {
  const backend = resolveBackend(state);
  if (backend !== 'codex') {
    return { shouldRelaunch: false, pendingCount: 0, nextRelaunchCount: 0, reason: 'not_codex' };
  }
  // AC-LPB-03: Hard wall-clock cap — relaunching after the time budget is
  // exhausted only burns API turns the user already opted out of. Mirror the
  // cap-gate in shouldExitForLimits() so codex relaunches honor the same
  // budget as the main loop. Runs BEFORE every other decision branch so the
  // budget cannot be papered over by pending tickets or a closed CB.
  const startEpoch = Number.isFinite(Number(state.start_time_epoch)) ? Number(state.start_time_epoch) : 0;
  const maxTimeMins = Number.isFinite(Number(state.max_time_minutes)) ? Number(state.max_time_minutes) : 0;
  if (maxTimeMins > 0 && startEpoch > 0) {
    const elapsedSec = Math.max(0, Math.floor(Date.now() / 1000) - startEpoch);
    if (elapsedSec > maxTimeMins * 60) {
      return { shouldRelaunch: false, pendingCount: 0, nextRelaunchCount: 0, reason: 'time_limit' };
    }
  }
  // Tripped circuit breaker → real backend failure, do not paper over it.
  if (cbState && cbState.state === 'OPEN') {
    return { shouldRelaunch: false, pendingCount: 0, nextRelaunchCount: 0, reason: 'circuit_open' };
  }
  const norm = (s: string | null): string =>
    (s || '').toLowerCase().replace(/["']/g, '').trim();
  const pending = tickets.filter(t => {
    if (!t.id) return false;
    const s = norm(t.status);
    return s !== 'done' && s !== 'skipped';
  });
  if (pending.length === 0) {
    return { shouldRelaunch: false, pendingCount: 0, nextRelaunchCount: 0, reason: 'no_pending' };
  }
  const prior = Number(state.codex_manager_relaunch_count) || 0;
  const cap = Defaults.CODEX_MANAGER_RELAUNCH_CAP;
  if (prior >= cap) {
    return { shouldRelaunch: false, pendingCount: pending.length, nextRelaunchCount: prior, reason: 'cap_exceeded' };
  }
  return { shouldRelaunch: true, pendingCount: pending.length, nextRelaunchCount: prior + 1, reason: 'eligible' };
}

/**
 * Persists the codex-manager relaunch decision: bumps
 * `state.codex_manager_relaunch_count` via the StateManager so concurrent
 * readers see the update, and emits a `codex_manager_relaunch` activity
 * event so standup/metrics surface it. Best-effort — caller already
 * decided to relaunch; a state-write failure logs a warning but still
 * lets the next iteration spawn a fresh manager.
 */
export function recordCodexManagerRelaunch(
  statePath: string,
  sessionDir: string,
  decision: CodexRelaunchDecision,
  iteration: number,
  log: (msg: string) => void,
): void {
  try {
    sm.update(statePath, s => {
      s.codex_manager_relaunch_count = decision.nextRelaunchCount;
    });
  } catch (err) {
    log(`WARN: failed to persist codex_manager_relaunch_count: ${safeErrorMessage(err)}`);
  }
  logActivity({
    event: 'codex_manager_relaunch',
    source: 'pickle',
    session: path.basename(sessionDir),
    iteration,
  });
}

export async function processCompletionBranch(state: State, result: IterationOutcome['completion'], ctx: LoopContext): Promise<LoopAction> {
  if (result === 'task_completed') return processTaskCompleted(state, ctx);
  if (result === 'review_clean') return processReviewClean(ctx);
  if (result === 'inactive') {
    ctx.log('Session deactivated. Exiting loop.');
    return { kind: 'break', reason: 'cancelled' };
  }
  if (result === 'error') {
    // Codex tmux_mode runs one long-lived manager across many tickets.
    // A 4h hang-guard SIGTERM (or other subprocess error) does not mean
    // the work is doomed — relaunch the manager and let it pick up the
    // remaining ticket queue. Bounded by CODEX_MANAGER_RELAUNCH_CAP and
    // gated on circuit-breaker state.
    let postState: State = state;
    try { postState = ctxReadState(ctx); } catch { /* fall back to pre-iteration state */ }
    const decision = evaluateCodexManagerRelaunch(
      postState,
      collectTickets(ctx.sessionDir),
      ctx.cbState ?? null,
    );
    if (decision.shouldRelaunch) {
      ctx.log(
        `Codex manager subprocess errored with ${decision.pendingCount} ticket(s) still pending — ` +
        `relaunching (count ${decision.nextRelaunchCount}/${Defaults.CODEX_MANAGER_RELAUNCH_CAP}).`,
      );
      recordCodexManagerRelaunch(ctx.statePath, ctx.sessionDir, decision, ctx.iteration, ctx.log);
      // Relaunch IS progress — reset stall counter. Do NOT deactivate.
      // Do NOT reset the circuit breaker: a 4h hang-guard timeout is
      // exactly the kind of repeated event the CB should observe.
      return { kind: 'relaunch', relaunchCount: decision.nextRelaunchCount, pendingTickets: decision.pendingCount, resetStall: true };
    }
    ctx.log('Subprocess error. Exiting loop.');
    ctxDeactivate(ctx);
    return { kind: 'break', reason: 'error' };
  }
  await (ctx.sleep || sleep)(1000);
  return { kind: 'noop' };
}

function processTaskCompleted(state: State, ctx: LoopContext): LoopAction {
  let curState: State;
  try { curState = ctxReadState(ctx); } catch (err) {
    ctx.log(`ERROR: Cannot read state.json after task_completed: ${safeErrorMessage(err)}. Exiting.`);
    return { kind: 'break', reason: 'success' };
  }
  const decision = evaluateEpicCompletion({
    tickets: collectTickets(ctx.sessionDir), currentTicket: curState.current_ticket || null,
    priorFalseCount: Number(curState.false_epic_completed_count) || 0,
    priorFalseTicket: curState.false_epic_completed_ticket ?? null,
  });
  if (decision.kind === 'persistent_hallucination') {
    ctxDeactivate(ctx);
    return { kind: 'break', reason: 'manager_persistent_hallucination' };
  }
  if (decision.kind === 'recover_advance' || decision.kind === 'recover_retry') {
    const handoffSummary = buildHandoffSummary(state, ctx.sessionDir, ctx.iteration + 1);
    (ctx.writeHandoff || writeHandoffAtomic)(ctx.sessionDir, handoffSummary, process.pid, ctx.log);
    return { kind: 'continue', resetStall: true };
  }
  if (curState.current_ticket) markTicketDone(ctx.sessionDir, curState.current_ticket);
  if (curState.chain_meeseeks === true) {
    if (ctx.updateState) ctx.updateState(s => Object.assign(s, ctx.transitionToMeeseeks ? ctx.transitionToMeeseeks(s) : transitionToMeeseeks(s, ctx.extensionRoot)));
    return { kind: 'continue', resetStall: true };
  }
  ctx.log('Task completed. Exiting loop.');
  ctxDeactivate(ctx);
  return { kind: 'break', reason: 'success' };
}

function processReviewClean(ctx: LoopContext): LoopAction {
  let curState: State;
  try { curState = ctxReadState(ctx); } catch (err) {
    ctx.log(`ERROR: Cannot read state.json after review_clean: ${safeErrorMessage(err)}. Treating as completed.`);
    return { kind: 'break', reason: 'success' };
  }
  const minIter = Number.isFinite(Number(curState.min_iterations)) ? Number(curState.min_iterations) : 0;
  const curIterNow = Number.isFinite(Number(curState.iteration)) ? Number(curState.iteration) : 0;
  if (minIter > 0 && curIterNow < minIter) {
    ctx.log(`Clean pass at iteration ${curIterNow}, but min_iterations=${minIter}. Continuing.`);
    return { kind: 'noop' };
  }
  ctx.log('Review clean. Exiting loop.');
  ctxDeactivate(ctx);
  return { kind: 'break', reason: 'success' };
}

async function main() {
  try {
    assertSchemaVersionDeployParity();
  } catch (err) {
    if (err instanceof SchemaVersionDeployDriftError) {
      process.stderr.write(`${safeErrorMessage(err)}\n`);
      process.exit(1);
    }
    throw err;
  }
  await runMuxRunnerMain();
}

// eslint-disable-next-line max-lines-per-function, complexity -- legacy loop retained while extracted helpers are tested independently
async function runMuxRunnerMain() {
  const sessionDir = process.argv[2];
  // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
  if (!sessionDir || sessionDir.startsWith('--') || !fs.existsSync(path.join(sessionDir, 'state.json'))) {
    console.error('Usage: node mux-runner.js <session-dir>');
    process.exit(1);
  }

  const extensionRoot = getExtensionRoot();
  const statePath = path.join(sessionDir, 'state.json');
  const runnerLog = path.join(sessionDir, 'mux-runner.log');

  const log = (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(runnerLog, line);
    process.stderr.write(line);
  };

  log('mux-runner started');

  // Auto-spawn the 4-pane monitor window. Previously each pickle skill prompt
  // (pickle-tmux, pickle-pipeline, pickle-refine-prd, …) ended with a manual
  // `bash tmux-monitor.sh …` step that the agent sometimes dropped silently.
  // Owning it here makes it unskippable. No-op when not inside tmux.
  try {
    const result = ensureMonitorWindow({ sessionDir, extensionRoot, log });
    log(`ensureMonitorWindow: ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
  } catch (err) {
    log(`ensureMonitorWindow: threw (ignored): ${safeErrorMessage(err)}`);
  }

  // Graceful shutdown: deactivate session on SIGTERM/SIGINT so it doesn't
  // remain orphaned with active: true when the tmux pane is closed.
  const handleShutdownSignal = (signal: string) => {
    log(`Received ${signal} — deactivating session`);
    safeDeactivate(statePath);
    if (currentChildProc && !currentChildProc.killed) {
      currentChildProc.kill('SIGTERM');
    }
    logActivity({ event: 'session_end', source: 'pickle', session: path.basename(sessionDir), mode: 'tmux' });
    process.exit(0);
  };
  process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'));
  process.on('SIGINT', () => handleShutdownSignal('SIGINT'));
  process.on('SIGHUP', () => handleShutdownSignal('SIGHUP'));

  // Take ownership: setup.js writes active: false in tmux mode so the main
  // Claude window's stop hook is released immediately. We set active: true here
  // before entering the loop so workers and state readers see a live session.
  let ownerState: State;
  try {
    ownerState = readRunnerState(statePath);
  } catch (err) {
    const msg = safeErrorMessage(err);
    throw new Error(`Cannot read initial state.json: ${msg}`);
  }
  // Startup validation — mux-runner only. microverse-runner owns its own sentinels
  // (worker_timeout_seconds=0 disables per-iteration timeout there; max_iterations=0
  // means unlimited iterations there). These rules must NOT be shared.
  {
    // Use raw object to detect null (JSON-serialized NaN) vs absent vs zero
    const rawObj = ownerState as unknown as Record<string, unknown>;
    const issues: string[] = [];

    const maxIterField = rawObj.max_iterations;
    const rawMaxIter = Number(maxIterField);
    if (maxIterField == null || !Number.isFinite(rawMaxIter) || rawMaxIter < 0) {
      issues.push(`max_iterations must be >= 0 (got ${maxIterField})`);
    }

    const rawTimeout = Number(rawObj.worker_timeout_seconds);
    if (!Number.isFinite(rawTimeout) || rawTimeout <= 0) {
      issues.push(`worker_timeout_seconds must be > 0 (got ${rawObj.worker_timeout_seconds})`);
    } else if (rawTimeout > 86400) {
      issues.push(`worker_timeout_seconds > 86400s implausible (got ${rawTimeout}); edit state.json`);
    }

    // iteration=0 is valid (fresh session); null/undefined are not — check explicitly
    // before numeric coercion since Number(null)=0 would otherwise pass.
    const iterField = rawObj.iteration;
    const rawIter = Number(iterField);
    if (iterField == null || !Number.isFinite(rawIter) || rawIter < 0) {
      issues.push(`iteration must be >= 0 (got ${iterField})`);
    }

    if (issues.length > 0) {
      console.error(`Invalid state at ${statePath}:\n  - ${issues.join('\n  - ')}`);
      process.exit(2);
    }
  }

  if (
    ownerState.tmux_mode === true &&
    (ownerState.active !== true || ownerState.pid !== process.pid)
  ) {
    sm.update(statePath, s => {
      s.active = true;
      s.pid = process.pid;
    });
    log(
      ownerState.active === true
        ? 'Session ownership refreshed (pid updated)'
        : 'Session ownership taken (active: false → true)',
    );
  }

  // Clean up stale rate_limit_wait.json from a previous crashed session
  // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
  try { fs.unlinkSync(path.join(sessionDir, 'rate_limit_wait.json')); } catch { /* not present */ }

  const cbSettings = loadSettings(extensionRoot);
  const cbEnabled = cbSettings.enabled;
  let cbState: CircuitBreakerState | null = cbEnabled ? initCircuitBreaker(sessionDir, cbSettings) : null;
  const cbPath = path.join(sessionDir, 'circuit_breaker.json');

  const { waitMinutes: rateLimitWaitMinutes, maxRetries: maxRateLimitRetries } = loadRateLimitSettings(extensionRoot);

  const startTime = Date.now();
  let iteration = 0;
  let meeseeksPassCount = 0;
  let lastStateIteration = -1;
  let stallCount = 0;
  let consecutiveRateLimits = 0;
  let previousTicket: string | null = null;
  let exitReason: ExitReason = 'error';
  // Non-persisted per-ticket timeout counter (FR-B3/B4) — resets on runner restart.
  let timeoutCount = 0;
  let lastTimeoutTicket: string | null = null;
  // Commit-pending probe: track the last outer-loop iteration where state.iteration
  // advanced. Used to detect stagnation independently of the circuit breaker (the
  // probe runs whether CB is enabled or not).
  let lastProgressOuterIteration = 0;
  let lastObservedStateIteration = -1;
  // Settings bag for the commit-pending probe threshold (default 2). Read once
  // at startup; the loop is short-lived enough that hot-reloading isn't worth
  // the disk traffic.
  const probeSettings = loadSettingsBag(extensionRoot, 'mux-runner:commit-pending-probe:settings');
  const rawProbeThreshold = Number(probeSettings.commit_pending_probe_threshold);
  const commitPendingProbeThreshold =
    Number.isFinite(rawProbeThreshold) && rawProbeThreshold > 0 ? rawProbeThreshold : 2;
  let readinessGateChecked = false;

  while (true) {
    let state: State;
    try {
      state = readRunnerState(statePath);
    } catch (err) {
      const decision = classifyCapCheckReadError(err, sessionDir, log);
      if (decision === 'continue') {
        await sleep(1000);
        continue;
      }
      exitReason = 'error';
      break;
    }

    if (state.active !== true) {
      log('Session inactive. Exiting.');
      exitReason = 'cancelled';
      break;
    }

    const rawMaxIter = Number(state.max_iterations);
    const maxIter = Number.isFinite(rawMaxIter) ? rawMaxIter : 0;
    const rawCurIter = Number(state.iteration);
    const curIter = Number.isFinite(rawCurIter) ? rawCurIter : 0;
    if (maxIter > 0 && curIter >= maxIter) {
      log(`Max iterations reached (${curIter}/${maxIter}). Exiting.`);
      safeDeactivate(statePath);
      exitReason = 'limit';
      break;
    }

    const rawStartEpoch = Number(state.start_time_epoch);
    const startEpoch = Number.isFinite(rawStartEpoch) ? rawStartEpoch : 0;
    const rawMaxTimeMins = Number(state.max_time_minutes);
    const maxTimeMins = Number.isFinite(rawMaxTimeMins) ? rawMaxTimeMins : 0;
    const elapsed = startEpoch > 0 ? Math.max(0, Math.floor(Date.now() / 1000) - startEpoch) : 0;
    if (maxTimeMins > 0 && startEpoch > 0 && elapsed >= maxTimeMins * 60) {
      log(`Time limit reached (${elapsed}s). Exiting.`);
      safeDeactivate(statePath);
      exitReason = 'limit';
      break;
    }

    // Circuit breaker gate: if CB is OPEN, exit immediately
    if (cbEnabled && cbState && !canExecute(cbState)) {
      log(`Circuit breaker OPEN: ${cbState.reason}. Exiting.`);
      safeDeactivate(statePath);
      exitReason = 'circuit_open';
      break;
    }

    // Stall detection fallback (only when CB is disabled)
    if (!cbEnabled) {
      if (curIter === lastStateIteration) {
        stallCount++;
        if (stallCount >= 2) { // Stall threshold only consulted when !cbEnabled; CB-enabled sessions use CB's own progress threshold
          log(`WARNING: state.iteration has not advanced in 2 outer-loop iterations (stuck at ${state.iteration}). Exiting to avoid wasted API calls.`);
          safeDeactivate(statePath);
          exitReason = 'stall';
          break;
        }
      } else {
        stallCount = 0;
      }
      lastStateIteration = curIter;
    }

    iteration++;
    const preTicket = state.current_ticket || null;
    if (previousTicket === null) previousTicket = preTicket;
    log(`--- Iteration ${iteration} (state.iteration=${state.iteration}) ---`);
    logActivity({ event: 'iteration_start', source: 'pickle', session: path.basename(sessionDir), iteration });

    if (!readinessGateChecked && curIter === 0) {
      readinessGateChecked = true;
      const readinessStatus = runMuxReadinessGate({
        sessionDir,
        repoRoot: state.working_dir || process.cwd(),
        extensionRoot,
        log,
      });
      if (readinessStatus !== 0) {
        log(`READINESS HALT: check-readiness exited ${readinessStatus}; no manager spawn attempted`);
        safeDeactivate(statePath);
        exitReason = 'error';
        break;
      }
    }

    // Multi-repo advisory check (once, on first iteration)
    if (iteration === 1) {
      const multiRepoDirs = detectMultiRepo(sessionDir);
      if (multiRepoDirs) {
        log(`⚠️  MULTI-REPO DETECTED: Tickets span [${multiRepoDirs.join(', ')}]. Pickle Rick works best with single-repo sessions.`);
        logActivity({ event: 'multi_repo_warning', source: 'pickle', session: path.basename(sessionDir) });
      }
    }

    // Resolve meeseeks model per-pass based on tier mapping
    const templateName = state.command_template || 'pickle.md';
    if (templateName === 'meeseeks.md') meeseeksPassCount++;
    const meeseeksModel = loadMeeseeksModel(extensionRoot, meeseeksPassCount);
    if (templateName === 'meeseeks.md') {
      log(`Meeseeks pass ${meeseeksPassCount} → model: ${meeseeksModel}`);
      logActivity({ event: 'meeseeks_model_select', source: 'pickle', session: path.basename(sessionDir), iteration, model: meeseeksModel, pass: meeseeksPassCount });
    }

    // Update outer-loop progress tracker for the commit-pending probe.
    // First observation seeds both fields so a fresh session never trips
    // the probe at iteration 1 from the default zero-init.
    if (lastObservedStateIteration < 0) {
      lastObservedStateIteration = curIter;
      lastProgressOuterIteration = iteration;
    } else if (curIter > lastObservedStateIteration) {
      lastObservedStateIteration = curIter;
      lastProgressOuterIteration = iteration;
    }

    // Pre-spawn commit-pending health probe (codex-only). RCA: codex
    // sometimes produces edits but never `git add` + `git commit`; if
    // stagnation persists past the threshold, nudge the next worker turn
    // to commit + signal Done so the breaker doesn't strand orphan work.
    try {
      const probeBackend = resolveBackend(state);
      const probeWorkingDir = state.working_dir || process.cwd();
      const probeResult = commitPendingProbe({
        sessionDir,
        workingDir: probeWorkingDir,
        backend: probeBackend,
        iteration,
        lastProgressIteration: lastProgressOuterIteration,
        threshold: commitPendingProbeThreshold,
        pid: process.pid,
        log,
      });
      if (probeResult === 'fired') {
        logActivity({
          event: 'commit_pending_probe_fired',
          source: 'pickle',
          session: path.basename(sessionDir),
          iteration,
        });
      }
    } catch (err) {
      // Probe is best-effort — never block the iteration on probe failure.
      log(`commit-pending probe threw (ignored): ${safeErrorMessage(err)}`);
    }

    const outcome = await runIteration(sessionDir, iteration, extensionRoot, meeseeksModel);
    const result = outcome.completion;

    // Move iterLogFile computation BEFORE transition block (needed by classifyTicketCompletion)
    const iterLogFile = path.join(sessionDir, `tmux_iteration_${iteration}.log`);

    // Detect ticket transitions: validate completion before marking Done
    try {
      const postState = readRunnerState(statePath);
      const postTicket = postState.current_ticket || null;
      if (previousTicket && postTicket !== previousTicket) {
        // Check if the model already marked it Done via prompt-driven validation
        const tickets = collectTickets(sessionDir);
        const prevTicketInfo = tickets.find(t => t.id === previousTicket);
        if (prevTicketInfo?.status?.toLowerCase().replace(/["']/g, '') === 'done') {
          log(`Ticket ${previousTicket} already marked Done by model — skipping validation`);
        } else {
          // Drift scenario: model changed current_ticket without following protocol
          const ticketWorkingDir = prevTicketInfo?.working_dir || state.working_dir || process.cwd();
          const prevTicketDir = path.join(sessionDir, previousTicket);
          const role: WorkerRole = prevTicketInfo?.type === 'review' ? 'review' : 'implementation';
          const verdict = classifyTicketCompletion(iterLogFile, ticketWorkingDir, prevTicketDir, role);
          if (verdict === 'completed') {
            if (markTicketDone(sessionDir, previousTicket)) {
              log(`Marked ticket ${previousTicket} as Done (validated: evidence found)`);
            }
          } else {
            if (markTicketSkipped(sessionDir, previousTicket)) {
              log(`Marked ticket ${previousTicket} as Skipped (no completion evidence)`);
            }
          }
        }
      }
      previousTicket = postTicket;
    } catch { /* state read failed — skip transition check */ }

    // --- Rate limit classification (MUST run before CB to prevent CB poisoning) ---
    const exitResult = classifyIterationExit(outcome.completion, iterLogFile, {
      didTimeout: outcome.timedOut,
      exitCode: outcome.exitCode,
      wallSeconds: outcome.wallSeconds,
    });
    const exitType = exitResult.type;
    logActivity({ event: 'iteration_end', source: 'pickle', session: path.basename(sessionDir), iteration, exit_type: exitType });

    if (exitType === 'api_limit') {
      consecutiveRateLimits++;
      log(`API rate limit detected (consecutive: ${consecutiveRateLimits}/${maxRateLimitRetries})`);
      if (exitResult.rateLimitInfo?.resetsAt) {
        log(`API reports reset at ${new Date(exitResult.rateLimitInfo.resetsAt * 1000).toISOString()} (type: ${exitResult.rateLimitInfo.rateLimitType || 'unknown'})`);
      }

      const rlAction = computeRateLimitAction(exitResult, consecutiveRateLimits, maxRateLimitRetries, rateLimitWaitMinutes);

      if (rlAction.action === 'bail') {
        exitReason = 'rate_limit_exhausted';
        logActivity({ event: 'rate_limit_exhausted', source: 'pickle',
          session: path.basename(sessionDir), error: `max retries (${maxRateLimitRetries}) exceeded, no resetsAt available` });
        safeDeactivate(statePath);
        break;
      }

      const { waitMs: computedWaitMs, waitSource } = rlAction;
      if (waitSource === 'api') {
        log(`Using API-provided reset time: ${Math.ceil(computedWaitMs / 60_000)}min wait (vs ${rateLimitWaitMinutes}min config default)`);
      }

      const waitUntil = new Date(Date.now() + computedWaitMs).toISOString();
      logActivity({ event: 'rate_limit_wait', source: 'pickle',
        session: path.basename(sessionDir), duration_min: Math.ceil(computedWaitMs / 60_000) });
      writeStateFile(path.join(sessionDir, 'rate_limit_wait.json'), {
        waiting: true, reason: 'API rate limit',
        started_at: new Date().toISOString(),
        wait_until: waitUntil,
        consecutive_waits: consecutiveRateLimits,
        rate_limit_type: exitResult.rateLimitInfo?.rateLimitType || null,
        resets_at_epoch: exitResult.rateLimitInfo?.resetsAt || null,
        wait_source: waitSource,
      });

      // Pre-wait time check
      const rawEpoch = Number(state.start_time_epoch);
      const epoch = Number.isFinite(rawEpoch) ? rawEpoch : 0;
      const rawMax = Number(state.max_time_minutes);
      const maxMins = Number.isFinite(rawMax) ? rawMax : 0;
      let actualWaitMs = computedWaitMs;
      if (maxMins > 0 && epoch > 0) {
        const elapsed = Math.floor(Date.now() / 1000) - epoch;
        const remaining = (maxMins * 60) - elapsed;
        if (remaining <= 0) { exitReason = 'limit'; safeDeactivate(statePath); break; }
        actualWaitMs = Math.min(actualWaitMs, remaining * 1000);
      }

      // Cancellable + time-limit-aware sleep loop
      const waitEnd = Date.now() + actualWaitMs;
      while (Date.now() < waitEnd) {
        await sleep(Defaults.RATE_LIMIT_POLL_MS);
        try {
          const ws = readRunnerState(statePath);
          if (ws.active !== true) { exitReason = 'cancelled'; break; }
        } catch { /* proceed */ }
        if (maxMins > 0 && epoch > 0) {
          const elapsed = Math.floor(Date.now() / 1000) - epoch;
          if (elapsed >= maxMins * 60) { exitReason = 'limit'; break; }
        }
      }
      if (isHaltExit(exitReason)) {
        safeDeactivate(statePath); break;
      }

      // Wake: cleanup + handoff
      // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
      try { fs.unlinkSync(path.join(sessionDir, 'rate_limit_wait.json')); } catch { /* ok */ }
      if (rlAction.resetCounter) consecutiveRateLimits = 0;
      logActivity({ event: 'rate_limit_resume', source: 'pickle', session: path.basename(sessionDir) });
      const waitedMinutes = Math.ceil(computedWaitMs / 60_000);
      const handoffContent = [
        buildHandoffSummary(state, sessionDir, iteration + 1), '',
        `NOTE: Resumed after ${waitedMinutes}-minute API rate limit wait (source: ${waitSource}).`,
        'Resume from current phase — do not repeat the rate-limited iteration.',
      ].join('\n');
      writeHandoffAtomic(sessionDir, handoffContent, process.pid, log);
      continue;  // Skip CB recording + result branching entirely
    }
    if (exitType === 'success') consecutiveRateLimits = 0;

    // --- Per-ticket timeout halt (FR-B3/B4/B12/B14) — MUST run BEFORE CB recording ---
    let ticketForTimeout: string | null = state.current_ticket || null;
    try {
      const postState = readRunnerState(statePath);
      ticketForTimeout = postState.current_ticket || null;
    } catch { /* keep pre-iteration ticket as fallback */ }

    const counterNext = applyTimeoutCounterForLoop({
      prev: { count: timeoutCount, ticket: lastTimeoutTicket },
      ticketNow: ticketForTimeout,
      timedOut: outcome.timedOut === true,
      completedClean: result === 'task_completed',
    });
    timeoutCount = counterNext.count;
    lastTimeoutTicket = counterNext.ticket;

    if (outcome.timedOut) {
      writeTimeoutStub(sessionDir, {
        ticketId: ticketForTimeout,
        iteration,
        wallSeconds: outcome.wallSeconds,
        workerTimeoutSeconds: Number(state.worker_timeout_seconds) || 0,
        timeoutCount,
        logFile: iterLogFile,
      });
    }

    if (counterNext.halt) {
      log(`Timeout halt: ticket ${ticketForTimeout} timed out ${timeoutCount} consecutive iterations`);
      executeTimeoutHalt({ statePath, sessionDir, ticketNow: ticketForTimeout, timeoutCount });
      exitReason = 'timeout_repeat';
      break;
    }

    // === Existing CB recording — only reached for non-rate-limit ===

    // Circuit breaker: record iteration outcome (skip for subprocess failures)
    if (cbEnabled && cbState && result !== 'error' && result !== 'inactive') {
      let errorSig: string | null = null;
      try {
        // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
        const logContent = fs.readFileSync(iterLogFile, 'utf-8');
        errorSig = extractErrorSignature(logContent);
      } catch { /* log may not exist */ }

      let prevCBState = cbState.state;
      // Write CB state inside sm.update to keep circuit_breaker.json in sync with state.json iteration
      try {
        sm.update(statePath, s => {
          const progress = detectProgress(
            s.working_dir || process.cwd(),
            cbState!.last_known_head,
            cbState!.last_known_step,
            s.step,
            cbState!.last_known_ticket,
            s.current_ticket
          );
          prevCBState = cbState!.state;
          cbState = recordIterationResult(
            cbState!,
            { hasProgress: progress.hasProgress, errorSignature: errorSig },
            iteration,
            cbSettings
          );
          cbState.last_known_head = progress.currentHead;
          cbState.last_known_step = s.step;
          cbState.last_known_ticket = s.current_ticket;
          writeStateFile(cbPath, cbState);
        });
      } catch {
        // sm.update failed — fall back to direct reads/writes (iteration desync possible but non-fatal)
        let postIterState: State = state;
        try {
          postIterState = readRunnerState(statePath);
        } catch { /* use last known state */ }
        const progress = detectProgress(
          postIterState.working_dir || process.cwd(),
          cbState.last_known_head, cbState.last_known_step, postIterState.step,
          cbState.last_known_ticket, postIterState.current_ticket
        );
        prevCBState = cbState.state;
        cbState = recordIterationResult(
          cbState,
          { hasProgress: progress.hasProgress, errorSignature: errorSig },
          iteration,
          cbSettings
        );
        cbState.last_known_head = progress.currentHead;
        cbState.last_known_step = postIterState.step;
        cbState.last_known_ticket = postIterState.current_ticket;
        writeStateFile(cbPath, cbState);
      }

      if (prevCBState !== 'OPEN' && cbState.state === 'OPEN') {
        logActivity({ event: 'circuit_open', source: 'pickle', session: path.basename(sessionDir), error: cbState.reason });
        log(`Circuit breaker tripped: ${cbState.reason}`);
        safeDeactivate(statePath);
        exitReason = 'circuit_open';
        break;
      }

      if (prevCBState === 'HALF_OPEN' && cbState.state === 'CLOSED') {
        logActivity({ event: 'circuit_recovery', source: 'pickle', session: path.basename(sessionDir) });
        log('Circuit breaker recovered (HALF_OPEN → CLOSED)');
      }
    }

    if (result === 'task_completed') {
      // EPIC_COMPLETED / TASK_COMPLETED — check for meeseeks chain before exiting
      let curState: State;
      try {
        curState = readRunnerState(statePath);
      } catch (err) {
        const msg = safeErrorMessage(err);
        log(`ERROR: Cannot read state.json after task_completed: ${msg}. Exiting.`);
        exitReason = 'success';
        break;
      }
      // Verify EPIC_COMPLETED against ticket frontmatter. The pure helper
      // below is the only place that decides genuine vs. recoverable vs.
      // pathological — a single false EPIC_COMPLETED no longer kills the
      // pipeline. See `evaluateEpicCompletion` for the full state machine.
      const allTickets = collectTickets(sessionDir);
      const decision = evaluateEpicCompletion({
        tickets: allTickets,
        currentTicket: curState.current_ticket || null,
        priorFalseCount: Number(curState.false_epic_completed_count) || 0,
        priorFalseTicket: curState.false_epic_completed_ticket ?? null,
      });

      if (decision.kind === 'persistent_hallucination') {
        log(`MANAGER_PERSISTENT_HALLUCINATION: ticket ${decision.ticket} emitted ${PromiseTokens.EPIC_COMPLETED} ${decision.nextCount} times without finishing (threshold ${FALSE_EPIC_THRESHOLD}). Done=${decision.doneCount}/${decision.totalCount}. Bailing for human review.\n       Iteration log: ${iterLogFile}`);
        appendPipelineRunnerMarker(sessionDir, `MANAGER_PERSISTENT_HALLUCINATION ticket=${decision.ticket} count=${decision.nextCount} done=${decision.doneCount}/${decision.totalCount}`);
        try {
          sm.update(statePath, s => {
            s.false_epic_completed_count = decision.nextCount;
            s.false_epic_completed_ticket = decision.ticket;
          });
        } catch (err) { log(`WARN: failed to persist false_epic counter: ${safeErrorMessage(err)}`); }
        logActivity({
          event: 'manager_persistent_hallucination',
          source: 'pickle',
          session: path.basename(sessionDir),
          ticket: decision.ticket,
          error: `${PromiseTokens.EPIC_COMPLETED} hallucinated ${decision.nextCount}× on ticket ${decision.ticket} (done ${decision.doneCount}/${decision.totalCount})`,
        });
        safeDeactivate(statePath);
        exitReason = 'manager_persistent_hallucination';
        break;
      }

      if (decision.kind === 'recover_advance' || decision.kind === 'recover_retry') {
        const tag = decision.kind === 'recover_advance' ? 'advancing' : 'retrying same ticket';
        const currentId = curState.current_ticket || '(none)';
        log(`MANAGER_FALSE_${PromiseTokens.EPIC_COMPLETED}: ${PromiseTokens.EPIC_COMPLETED} claimed but ${decision.doneCount} of ${decision.totalCount} tickets Done (pending: ${decision.pendingIds.join(', ') || '(none)'}). Treating as ${PromiseTokens.TASK_COMPLETED} — ${tag}. count=${decision.nextCount}/${FALSE_EPIC_THRESHOLD}.\n       Iteration log: ${iterLogFile}`);
        appendPipelineRunnerMarker(sessionDir, `MANAGER_FALSE_${PromiseTokens.EPIC_COMPLETED} ticket=${currentId} mode=${tag} count=${decision.nextCount}/${FALSE_EPIC_THRESHOLD} done=${decision.doneCount}/${decision.totalCount} pending=${decision.pendingIds.join(',')}`);
        logActivity({
          event: 'manager_false_epic_completed',
          source: 'pickle',
          session: path.basename(sessionDir),
          ticket: curState.current_ticket || undefined,
          error: `${PromiseTokens.EPIC_COMPLETED} with ${decision.totalCount - decision.doneCount} pending — ${tag}`,
        });

        if (decision.kind === 'recover_advance' && curState.current_ticket) {
          // current_ticket is already Done — close it out so the next
          // iteration picks the next non-Done ticket. Counter persists at the
          // CURRENT ticket so a subsequent false epic on the SAME current
          // ticket doesn't get a fresh budget.
          if (markTicketDone(sessionDir, curState.current_ticket)) {
            log(`Marked ticket ${curState.current_ticket} as Done (recover_advance)`);
          }
        }

        try {
          sm.update(statePath, s => {
            s.false_epic_completed_count = decision.nextCount;
            s.false_epic_completed_ticket = curState.current_ticket || null;
          });
        } catch (err) { log(`WARN: failed to persist false_epic counter: ${safeErrorMessage(err)}`); }

        // Stricter retry brief — handed to the next iteration via handoff.txt.
        const retryBrief = [
          `=== MANAGER FALSE EPIC RECOVERY (count ${decision.nextCount}/${FALSE_EPIC_THRESHOLD}) ===`,
          `You emitted <promise>${PromiseTokens.EPIC_COMPLETED}</promise> but only ${decision.doneCount} of ${decision.totalCount} tickets are status: Done.`,
          decision.pendingIds.length > 0 ? `Pending tickets: ${decision.pendingIds.join(', ')}.` : '',
          decision.kind === 'recover_advance'
            ? `Continue with the next non-Done ticket. Do NOT emit ${PromiseTokens.EPIC_COMPLETED} again until every linear_ticket_*.md file in the session root reports status: Done.`
            : `Resume work on current_ticket=${curState.current_ticket}. It is NOT yet Done. Do NOT emit ${PromiseTokens.EPIC_COMPLETED} again until every linear_ticket_*.md file in the session root reports status: Done.`,
          `Use ${PromiseTokens.TASK_COMPLETED} for single-ticket completions; reserve ${PromiseTokens.EPIC_COMPLETED} for the moment all tickets are Done.`,
        ].filter(Boolean).join('\n');
        const handoffSummary = buildHandoffSummary(state, sessionDir, iteration + 1);
        writeHandoffAtomic(sessionDir, `${handoffSummary}\n\n${retryBrief}`, process.pid, log);

        // Reset stall counter so the recovery iteration isn't immediately
        // killed by the no-progress detector — the manager IS making progress
        // (we just disagree about whether it's done).
        lastStateIteration = -1;
        stallCount = 0;
        await sleep(1000);
        continue;
      }

      // Genuine epic completion — clear any lingering false-epic counter and
      // proceed as before.
      if (Number(curState.false_epic_completed_count) > 0) {
        try {
          sm.update(statePath, s => {
            s.false_epic_completed_count = 0;
            s.false_epic_completed_ticket = null;
          });
        } catch (err) { log(`WARN: failed to clear false_epic counter: ${safeErrorMessage(err)}`); }
      }

      // Mark final ticket as Done before exiting or chaining
      if (curState.current_ticket) {
        if (markTicketDone(sessionDir, curState.current_ticket)) {
          log(`Marked final ticket ${curState.current_ticket} as Done`);
        }
      }
      if (curState.chain_meeseeks === true) {
        sm.update(statePath, s => { Object.assign(s, transitionToMeeseeks(s, extensionRoot)); });
        lastStateIteration = -1;
        stallCount = 0;
        if (cbEnabled) {
          // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
          try { fs.unlinkSync(cbPath); } catch { /* may not exist */ }
          cbState = initCircuitBreaker(sessionDir, cbSettings);
        }
        log('Transitioning to Meeseeks review mode (chain_meeseeks). Continuing loop.');
        continue;
      }
      log('Task completed. Exiting loop.');
      safeDeactivate(statePath);
      exitReason = 'success';
      break;
    } else if (result === 'review_clean') {
      // review_clean (EXISTENCE_IS_PAIN / THE_CITADEL_APPROVES) — apply min_iterations gate
      let curState: State;
      try {
        curState = readRunnerState(statePath);
      } catch (err) {
        const msg = safeErrorMessage(err);
        log(`ERROR: Cannot read state.json after review_clean: ${msg}. Treating as completed.`);
        exitReason = 'success';
        break;
      }
      const rawMinIter = Number(curState.min_iterations);
      const minIter = Number.isFinite(rawMinIter) ? rawMinIter : 0;
      const rawCurIter2 = Number(curState.iteration);
      const curIterNow = Number.isFinite(rawCurIter2) ? rawCurIter2 : 0;
      if (minIter > 0 && curIterNow < minIter) {
        log(`Clean pass at iteration ${curIterNow}, but min_iterations=${minIter}. Continuing.`);
      } else {
        log('Review clean. Exiting loop.');
        safeDeactivate(statePath);
        exitReason = 'success';
        break;
      }
    } else if (result === 'inactive') { log('Session deactivated. Exiting loop.'); exitReason = 'cancelled'; break; }
    else if (result === 'error') {
      // Codex tmux_mode runs ONE long-lived manager subprocess that loops
      // across many tickets internally. The 4h hang-guard SIGTERMs it with
      // `{ completion: 'error', timedOut: true }`. Treating that as terminal
      // strands every Todo ticket the manager hadn't picked up yet. Bounded
      // relaunch path keeps the queue draining; CB-OPEN and the cap still
      // fall through to the legacy exit-on-error.
      let postState: State = state;
      try { postState = readRunnerState(statePath); } catch { /* fall back */ }
      const relaunchDecision = evaluateCodexManagerRelaunch(
        postState,
        collectTickets(sessionDir),
        cbState,
      );
      if (relaunchDecision.shouldRelaunch) {
        log(
          `Codex manager subprocess errored with ${relaunchDecision.pendingCount} ticket(s) still pending — ` +
          `relaunching (count ${relaunchDecision.nextRelaunchCount}/${Defaults.CODEX_MANAGER_RELAUNCH_CAP}).`,
        );
        recordCodexManagerRelaunch(statePath, sessionDir, relaunchDecision, iteration, log);
        // Relaunch IS progress for outer-loop stall detection — reset stall.
        // Do NOT clear the circuit breaker: a 4h hang-guard timeout is the
        // exact event the CB should observe across relaunches.
        lastStateIteration = -1;
        stallCount = 0;
        await sleep(1000);
        continue;
      }
      log('Subprocess error. Exiting loop.');
      safeDeactivate(statePath);
      exitReason = 'error';
      break;
    }

    await sleep(1000);
  }

  const totalElapsed = Math.floor((Date.now() - startTime) / 1000);
  const isFailedExit = isFailureExit(exitReason);
  logActivity({ event: 'session_end', source: 'pickle', session: path.basename(sessionDir), duration_min: Math.round(totalElapsed / 60), mode: 'tmux', ...(isFailedExit ? { error: exitReason } : {}) });
  let finalStep = 'unknown';
  let finalActive = 'unknown';
  let finalMinIter = 0;
  try {
    const finalState = readRunnerState(statePath);
    const rawStep = finalState.step || 'unknown';
    finalStep = (VALID_STEPS as readonly string[]).includes(rawStep) ? rawStep : 'unknown';
    finalActive = String(finalState.active);
    const rawFinalMinIter = Number(finalState.min_iterations);
    finalMinIter = Number.isFinite(rawFinalMinIter) ? rawFinalMinIter : 0;
  } catch { /* use fallback values */ }

  printMinimalPanel('mux-runner Complete', {
    Iterations: iteration,
    Elapsed: formatTime(totalElapsed),
    FinalPhase: finalStep,
    Active: finalActive,
    ...(finalMinIter > 0 ? { 'Min Passes': finalMinIter } : {}),
  }, 'GREEN', '🥒');

  log(`mux-runner finished. ${iteration} iterations, ${formatTime(totalElapsed)}`);

  const notif = buildTmuxNotification(exitReason, finalStep, iteration, totalElapsed);
  displayMacNotification(notif.title, notif.body, notif.subtitle);

  // Explicit exit code so parent processes (pipeline-runner) can detect failure.
  // Matches microverse-runner.ts pattern.
  const exitCode = isFailedExit ? 1 : 0;
  process.exit(exitCode);
}

export function buildTmuxNotification(exitReason: ExitReason, finalStep: string, iteration: number, totalElapsed: number) {
  const isFailure = isFailureExit(exitReason);
  const title = isFailure
    ? '🥒 Pickle Run Failed'
    : '🥒 Pickle Run Complete';
  const subtitle = isFailure
    ? `Exit: ${exitReason} (phase: ${finalStep})`
    : exitReason === 'success'
      ? `Finished in ${formatTime(totalElapsed)}`
      : `Stopped: ${exitReason} (${formatTime(totalElapsed)})`;
  const body = `${iteration} iterations, ${formatTime(totalElapsed)}`;
  return { title, subtitle, body };
}

if (process.argv[1] && path.basename(process.argv[1]) === 'mux-runner.js') {
  main().catch((err) => {
    const msg = safeErrorMessage(err);
    console.error(`${Style.RED}[FATAL] ${msg}${Style.RESET}`);
    process.exit(1);
  });
}

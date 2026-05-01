import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StringDecoder } from 'string_decoder';
import { State, VALID_STEPS, LockError, SessionMapEntry } from '../types/index.js';
import { StateManager } from './state-manager.js';
import { readRecoverableJsonObject } from './recoverable-json.js';
import { updateTicketStatusInTransaction } from './transaction-ticket-ops.js';

/** Extracts a string message from any thrown value. Never throws. */
export function safeErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const Style = {
  GREEN: '\x1b[32m',
  RED: '\x1b[31m',
  BLUE: '\x1b[34m',
  CYAN: '\x1b[36m',
  YELLOW: '\x1b[33m',
  MAGENTA: '\x1b[35m',
  BOLD: '\x1b[1m',
  DIM: '\x1b[2m',
  RESET: '\x1b[0m',
} as const;

type StyleColor = keyof typeof Style;

export function getWidth(maxW: number = 90): number {
  const cols = process.stdout.columns || 80;
  return Math.min(cols - 4, maxW);
}

export function getHeight(fallback: number = 24): number {
  const rows = process.stdout.rows;
  return rows && rows > 0 ? rows : fallback;
}

export function wrapText(text: string, width: number): string[] {
  if (!Number.isFinite(width) || width <= 0) return [text];
  const lines: string[] = [];
  const words = text.split(' ');
  let currentLine = '';

  for (const word of words) {
    if ((currentLine === '' ? word : currentLine + ' ' + word).length <= width) {
      currentLine += (currentLine === '' ? '' : ' ') + word;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
      while (currentLine.length > width) {
        lines.push(currentLine.slice(0, width));
        currentLine = currentLine.slice(width);
      }
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines.length > 0 ? lines : [''];
}

export function printMinimalPanel(
  title: string,
  fields: Record<string, string | number | boolean | null | undefined>,
  colorName: StyleColor = 'GREEN',
  icon: string = '🥒'
) {
  const width = getWidth();
  const c = Style[colorName] || Style.GREEN;
  const r = Style.RESET;
  const b = Style.BOLD;
  const d = Style.DIM;

  if (title) {
    process.stdout.write(`\n${c}${icon} ${b}${title}${r}\n`);
  }

  const fieldKeys = Object.keys(fields);
  if (fieldKeys.length === 0) {
    process.stdout.write('\n');
    return;
  }

  const maxKeyLen = Math.max(...fieldKeys.map((k) => k.length)) + 1;

  for (const [key, value] of Object.entries(fields)) {
    const valWidth = width - maxKeyLen - 5;
    const wrappedVal = wrapText(String(value), valWidth);

    process.stdout.write(
      `  ${d}${key + ':'}${' '.repeat(maxKeyLen - key.length - 1)}${r} ${wrappedVal[0]}\n`
    );
    for (let i = 1; i < wrappedVal.length; i++) {
      process.stdout.write(`  ${' '.repeat(maxKeyLen)} ${wrappedVal[i]}\n`);
    }
  }
  process.stdout.write('\n');
}

export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}m ${s}s`;
}

/** Compact ISO stamp safe for use in file/dir names: `2026-04-27T20-15-30Z`. */
export function isoCompactStamp(d: Date = new Date()): string {
  return d.toISOString().replace(/:/g, '-').replace(/\..+/, 'Z');
}

/** Local calendar day key used for filenames/report buckets: `YYYY-MM-DD`. */
export function formatLocalDateKey(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

interface ShellError extends Error {
  stderr?: Buffer | string;
  stdout?: Buffer | string;
}

// eslint-disable-next-line complexity -- command wrapper intentionally handles shell and argv forms plus checked/unchecked failures
export function runCmd(
  cmd: string | string[],
  options: { cwd?: string; check?: boolean; capture?: boolean } = {}
): string {
  const { cwd, check = true, capture = true } = options;

  // Array form: use spawnSync so each argument is passed verbatim (no shell splitting).
  // String form: use execSync via the shell (supports pipes, globs, etc.).
  if (Array.isArray(cmd)) {
    const result = spawnSync(cmd[0], cmd.slice(1), {
      cwd,
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    if (check && (result.status ?? 1) !== 0) {
      throw new Error(`Command failed: ${cmd.join(' ')}\nError: ${result.stderr || ''}`);
    }
    return (result.stdout || '').trim();
  }

  try {
    const stdout = execSync(cmd, {
      cwd,
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    return (stdout || '').trim();
  } catch (error) {
    if (check) {
      const stderr = error instanceof Error && 'stderr' in error
        ? String((error as ShellError).stderr || '')
        : '';
      const msg = stderr || safeErrorMessage(error);
      throw new Error(`Command failed: ${cmd}\nError: ${msg}`);
    }
    const stdout = error instanceof Error && 'stdout' in error
      ? String((error as ShellError).stdout || '')
      : '';
    return stdout.trim();
  }
}

/**
 * Returns the pickle-rick **package root** — `~/.claude/pickle-rick` — which
 * holds `pickle_settings.json`, `persona.md`, `szechuan-sauce-*-principles.md`,
 * `debug.log`, `templates/`, and the `extension/` code tree as a subdirectory.
 *
 * To reach the compiled JS (hooks/, services/, bin/), callers must join
 * `'extension'` themselves: `path.join(getExtensionRoot(), 'extension', 'bin', 'xxx.js')`.
 * The name is historical — it predates the `extension/` subdirectory layout.
 */
export function getExtensionRoot(): string {
  return process.env.EXTENSION_DIR || path.join(os.homedir(), '.claude/pickle-rick');
}

/**
 * Root directory for pickle data that must NOT live under ~/.claude (Claude Code
 * gates ~/.claude writes with permission prompts). Session dirs, the jar queue,
 * worktrees, activity logs, metrics cache, and the session map all live here.
 *
 * Resolution order:
 *   1. PICKLE_DATA_ROOT (canonical explicit override)
 *   2. PICKLE_DATA_DIR (legacy explicit override — production or test)
 *   3. EXTENSION_DIR — ONLY when it's been pinned to a non-canonical path
 *      (test-harness convenience: tests redirect data into the same tmp dir
 *      they pin the extension root to). The hook dispatcher sets EXTENSION_DIR
 *      to the canonical install path (~/.claude/pickle-rick) in production,
 *      which would otherwise poison data resolution — every hook subprocess
 *      would read sessions from the install dir instead of the XDG data dir.
 *   4. ~/.local/share/pickle-rick (production default)
 */
export function getDataRoot(): string {
  if (process.env.PICKLE_DATA_ROOT) return process.env.PICKLE_DATA_ROOT;
  if (process.env.PICKLE_DATA_DIR) return process.env.PICKLE_DATA_DIR;
  const extDir = process.env.EXTENSION_DIR;
  if (extDir) {
    const canonicalExtDir = path.join(os.homedir(), '.claude/pickle-rick');
    if (path.resolve(extDir) !== path.resolve(canonicalExtDir)) return extDir;
  }
  return path.join(os.homedir(), '.local/share/pickle-rick');
}

export function statusSymbol(status: string | null): string {
  const s = (status || '').toLowerCase().replace(/^["']|["']$/g, '');
  if (s === 'done') return '[x]';
  if (s === 'in progress') return '[~]';
  if (s === 'skipped') return '[!]';
  return '[ ]';
}

/**
 * Safely extracts YAML frontmatter from a string without catastrophic regex backtracking.
 * Uses indexOf for delimiter search — O(n) regardless of content shape.
 * Returns the frontmatter body and byte offsets, or null if no valid block found.
 */
export function extractFrontmatter(content: string): { body: string; start: number; end: number } | null {
  // Support both Unix (\n) and Windows (\r\n) line endings
  const openLen = content.startsWith('---\r\n') ? 5 : content.startsWith('---\n') ? 4 : 0;
  if (openLen === 0) return null;
  const closeIdx = content.indexOf('\n---', openLen);
  if (closeIdx === -1) return null;
  // +4 for '\n---', +1 more if followed by a newline to consume the full delimiter line
  const rawEnd = closeIdx + 4;
  const end = content[rawEnd] === '\n' ? rawEnd + 1 : content[rawEnd] === '\r' && content[rawEnd + 1] === '\n' ? rawEnd + 2 : rawEnd;
  return { body: content.slice(openLen, closeIdx), start: 0, end };
}

export function clearTicketResolutionTimestamps(content: string): string {
  const fm = extractFrontmatter(content);
  if (!fm) return content;
  const filteredBody = fm.body
    .split(/\r?\n/)
    .filter((line) => !/^(completed_at|skipped_at):\s*/.test(line))
    .join('\n');
  return content.slice(0, fm.start) + `---\n${filteredBody}\n---\n` + content.slice(fm.end);
}

export interface TicketInfo {
  id: string | null;
  title: string | null;
  status: string | null;
  order: number;
  type: string | null;
  working_dir: string | null;
  completed_at: string | null;
  skipped_at: string | null;
  complexity_tier?: 'trivial' | 'small' | 'medium' | 'large';
  /** IDs of tickets this ticket depends on (must run before this one). */
  depends_on: string[];
}

/**
 * Read a string-array field from a YAML-ish frontmatter body. Supports both
 * inline `field: [a, b]` and block list:
 *   field:
 *     - a
 *     - b
 * Mirrors the extractor in `check-readiness.ts:dependencyRefs`.
 */
function readFrontmatterStringArray(body: string, key: string): string[] {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const inline = new RegExp(`^${escaped}:\\s*\\[(.*?)\\]\\s*$`, 'm').exec(body);
  if (inline) {
    return inline[1]
      .split(',')
      .map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }
  const lines = body.split(/\r?\n/);
  const index = lines.findIndex((line) => new RegExp(`^${escaped}:\\s*$`).test(line));
  if (index < 0) return [];
  const values: string[] = [];
  for (let i = index + 1; i < lines.length; i += 1) {
    const match = /^\s+-\s+(.+?)\s*$/.exec(lines[i]);
    if (!match) break;
    values.push(match[1].replace(/^['"]|['"]$/g, ''));
  }
  return values;
}

export function parseTicketFrontmatter(filePath: string): TicketInfo | null {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const fm = extractFrontmatter(content);
    if (!fm) return null;
    const get = (field: string): string | null => {
      const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const m = fm.body.match(new RegExp(`^${escaped}:\\s*(.+)$`, 'm'));
      return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
    };
    const tierRaw = get('complexity_tier');
    const validTiers = ['trivial', 'small', 'medium', 'large'] as const;
    const complexity_tier = tierRaw && validTiers.includes(tierRaw as typeof validTiers[number])
      ? tierRaw as typeof validTiers[number]
      : 'medium';
    // AC-SSV-05: collect both `depends_on` and the legacy `dependencies` alias,
    // strip optional `external:` prefix, dedupe. These edges feed topoSortTickets.
    const rawDeps = [
      ...readFrontmatterStringArray(fm.body, 'depends_on'),
      ...readFrontmatterStringArray(fm.body, 'dependencies'),
    ];
    const seen = new Set<string>();
    const depends_on: string[] = [];
    for (const dep of rawDeps) {
      const cleaned = dep.replace(/^external:\s*/i, '').trim();
      if (!cleaned || seen.has(cleaned)) continue;
      seen.add(cleaned);
      depends_on.push(cleaned);
    }
    return {
      id: get('id'),
      title: get('title'),
      status: get('status'),
      order: parseInt(get('order') || '0', 10) || 0,
      type: get('type'),
      working_dir: get('working_dir'),
      completed_at: get('completed_at'),
      skipped_at: get('skipped_at'),
      complexity_tier,
      depends_on,
    };
  } catch {
    return null;
  }
}

/**
 * Marks a ticket's frontmatter status as "Done" by rewriting the status line.
 * No-op if ticket dir or file doesn't exist, or status is already Done.
 */
export function markTicketDone(sessionDir: string, ticketId: string): boolean {
  try {
    const planned = updateTicketStatusInTransaction(ticketId, 'Done', sessionDir);
    fs.writeFileSync(planned.path, planned.content);
    return true;
  } catch {
    return false;
  }
}

export function markTicketSkipped(sessionDir: string, ticketId: string): boolean {
  try {
    const planned = updateTicketStatusInTransaction(ticketId, 'Skipped', sessionDir);
    fs.writeFileSync(planned.path, planned.content);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the dependency graph (indegree + reverse edges) for topoSortTickets.
 * Extracted purely to keep the main function under cyclomatic-complexity 15.
 */
function buildTicketDepGraph(tickets: TicketInfo[]): {
  indegree: Map<number, number>;
  edges: Map<number, number[]>;
} {
  const byId = new Map<string, number>();
  tickets.forEach((t, index) => {
    if (t.id) byId.set(t.id, index);
  });
  const indegree = new Map<number, number>();
  const edges = new Map<number, number[]>();
  for (let i = 0; i < tickets.length; i++) {
    indegree.set(i, 0);
    edges.set(i, []);
  }
  for (let i = 0; i < tickets.length; i++) {
    for (const depId of tickets[i].depends_on) {
      const depIdx = byId.get(depId);
      if (depIdx === undefined) continue; // external/unknown dep — ignore for ordering
      edges.get(depIdx)!.push(i);
      indegree.set(i, (indegree.get(i) || 0) + 1);
    }
  }
  return { indegree, edges };
}

/**
 * Topologically sort tickets so that any ticket whose ID appears in another
 * ticket's `depends_on` list comes BEFORE the dependent ticket. Ties (no
 * incoming-edge difference) break on the numeric `order` field, then on
 * stable insertion index. Throws on cycle detection with both/all member IDs
 * in the message.
 *
 * Implementation: Kahn's algorithm with a ready-queue re-sorted by
 * `(order, originalIndex)` for deterministic output.
 *
 * AC-SSV-05: replaces the prior pure-numeric sort that allowed C-T0 (order 200)
 * to run before NEW-T2 (order 300) when NEW-T2 depended on C-T0, even when the
 * caller supplied them in dependent-first form.
 */
export function topoSortTickets(tickets: TicketInfo[]): TicketInfo[] {
  if (tickets.length <= 1) return [...tickets];
  const { indegree, edges } = buildTicketDepGraph(tickets);
  const compare = (a: number, b: number): number => {
    const oa = tickets[a].order;
    const ob = tickets[b].order;
    return oa !== ob ? oa - ob : a - b;
  };
  const ready: number[] = [];
  for (let i = 0; i < tickets.length; i++) {
    if ((indegree.get(i) || 0) === 0) ready.push(i);
  }
  ready.sort(compare);
  const out: TicketInfo[] = [];
  while (ready.length > 0) {
    const i = ready.shift()!;
    out.push(tickets[i]);
    for (const next of edges.get(i)!) {
      const nextDeg = (indegree.get(next) || 0) - 1;
      indegree.set(next, nextDeg);
      if (nextDeg === 0) {
        ready.push(next);
        ready.sort(compare);
      }
    }
  }
  if (out.length !== tickets.length) {
    const stuck = tickets.filter((_, i) => (indegree.get(i) || 0) > 0).map((t) => t.id || '<unknown>');
    throw new Error(`Ticket dependency cycle detected: ${stuck.join(' → ')} → ${stuck[0] || '<unknown>'}`);
  }
  return out;
}

export function collectTickets(sessionDir: string): TicketInfo[] {
  try {
    const entries = fs.readdirSync(sessionDir, { withFileTypes: true });
    const tickets: TicketInfo[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subDir = path.join(sessionDir, entry.name);
      try {
        const files = fs.readdirSync(subDir);
        for (const file of files) {
          if (!file.startsWith('linear_ticket_') || !file.endsWith('.md')) continue;
          const parsed = parseTicketFrontmatter(path.join(subDir, file));
          if (parsed) tickets.push(parsed);
        }
      } catch {
        /* skip */
      }
    }
    return topoSortTickets(tickets);
  } catch {
    return [];
  }
}

// eslint-disable-next-line complexity -- summary composition is centralized to preserve stable handoff wording
export function buildHandoffSummary(state: Partial<State>, sessionDir: string, iterationNum?: number): string {
  const task = state.original_prompt || '';
  const truncatedTask = task.length > 300 ? task.slice(0, 300) + ' [truncated]' : task;
  const prdPath = path.join(sessionDir, 'prd.md');
  const prdExists = fs.existsSync(prdPath);
  const tickets = collectTickets(sessionDir);
  const iter = Number(state.iteration) || 0;
  const maxIter = Number(state.max_iterations) || 0;
  const iterLine = maxIter > 0
    ? `${iter} of ${maxIter}`
    : `${iter}`;
  const lines = [
    '=== PICKLE RICK LOOP CONTEXT ===',
    `Phase: ${state.step || 'unknown'}`,
    `Iteration: ${iterLine}`,
    `Session: ${sessionDir}`,
    `Ticket: ${state.current_ticket || 'none'}`,
    `Task: ${truncatedTask}`,
    `PRD: ${prdExists ? 'exists' : 'not yet created'}`,
  ];
  const rawMinIter = Number(state.min_iterations);
  const minIter = Number.isFinite(rawMinIter) ? rawMinIter : 0;
  if (minIter > 0) {
    lines.push(`Min Passes: ${minIter}`);
  }
  if (state.command_template) {
    lines.push(`Template: ${state.command_template}`);
  }
  if (tickets.length > 0) {
    lines.push('Tickets:');
    for (const t of tickets) {
      const sym = statusSymbol(t.status || '');
      const title = (t.title || '').length > 60
        ? (t.title || '').slice(0, 60) + '...'
        : (t.title || '');
      const typeTag = t.type === 'review' ? ' [REVIEW]' : '';
      const dirTag = t.working_dir && t.working_dir !== state.working_dir ? ` (${t.working_dir})` : '';
      const tierTag = t.complexity_tier && t.complexity_tier !== 'medium'
        ? ` [${t.complexity_tier}]`
        : '';
      const skippedNote = (t.status || '').toLowerCase().replace(/["']/g, '') === 'skipped'
        ? ' (no verified completion — re-attempt)'
        : '';
      lines.push(`  ${sym} ${t.id || '?'}: ${title}${typeTag}${tierTag}${dirTag}${skippedNote}`);
    }
  }
  const workingDirs = new Set(tickets.map(t => t.working_dir).filter(Boolean));
  if (workingDirs.size >= 2) {
    lines.push('');
    lines.push(`⚠️  MULTI-REPO: Tickets span ${[...workingDirs].join(', ')}. Consider separate sessions per repo.`);
  }
  const isFirstIteration = (iterationNum === 1 || iterationNum === undefined)
    && (Number(state.iteration) || 0) === 0
    && (state.history || []).length === 0;
  if (isFirstIteration) {
    lines.push(
      '',
      'THIS IS A NEW SESSION. Begin the lifecycle from the current phase.',
      'Read state.json for full context, then start working on the task.',
    );
  } else {
    lines.push(
      '',
      'NEXT ACTION: Resume from current phase. Read state.json for context.',
      'Do NOT restart from scratch. Continue where you left off.',
    );
  }
  return lines.join('\n');
}

// Shared buffer for Atomics.wait()-based synchronous sleep (no CPU spin).
const _sleepBuf = new Int32Array(new SharedArrayBuffer(4));

/** Synchronous sleep that yields to the OS scheduler instead of busy-waiting. */
function sleepMs(ms: number): void {
  Atomics.wait(_sleepBuf, 0, 0, ms);
}

export interface RetryLockOptions {
  /** Maximum number of retry attempts before throwing LockError. Default: 10. */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff. Default: 100. */
  baseLockDelayMs?: number;
  /** Age threshold in ms after which a lock file is considered stale and stolen. Default: 30000. */
  staleLockTimeoutMs?: number;
  /** Whether to add random jitter to backoff delays. Default: true. */
  lockJitter?: boolean;
}

const RETRY_LOCK_DEFAULTS = {
  maxRetries: 10,
  baseLockDelayMs: 100,
  staleLockTimeoutMs: 30_000,
  lockJitter: true,
} as const;

/**
 * Acquires an exclusive file lock before executing fn, then releases it.
 * Uses O_EXCL atomic create for lock acquisition. Retries with exponential
 * backoff and optional jitter, stealing locks older than staleLockTimeoutMs.
 * Writes PID to lock file for stale detection. NEVER silently falls through —
 * throws LockError if maxRetries is exhausted.
 */
// eslint-disable-next-line complexity -- lock acquisition loop keeps stale-lock, retry, and cleanup semantics together
export function withRetryLock<T>(lockPath: string, fn: () => T, opts: RetryLockOptions = {}): T {
  const maxRetries = opts.maxRetries ?? RETRY_LOCK_DEFAULTS.maxRetries;
  const baseLockDelayMs = opts.baseLockDelayMs ?? RETRY_LOCK_DEFAULTS.baseLockDelayMs;
  const staleLockTimeoutMs = opts.staleLockTimeoutMs ?? RETRY_LOCK_DEFAULTS.staleLockTimeoutMs;
  const lockJitter = opts.lockJitter ?? RETRY_LOCK_DEFAULTS.lockJitter;

  let attempt = 0;

  while (true) {
    // Steal stale lock if present — unlink + create in tight sequence to minimize TOCTOU window
    try {
      const stats = fs.statSync(lockPath);
      if (Date.now() - stats.mtimeMs > staleLockTimeoutMs) {
        try { fs.unlinkSync(lockPath); } catch { /* already gone — race is fine */ }
      }
    } catch { /* lock file doesn't exist — expected */ }

    // Atomic exclusive create; write PID for stale-detection by other processes
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try { fs.writeSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }

      try {
        return fn();
      } finally {
        try { fs.unlinkSync(lockPath); } catch { /* ignore cleanup failure */ }
      }
    } catch (e) {
      const code = e instanceof Error ? (e as NodeJS.ErrnoException).code : undefined;
      if (code !== 'EEXIST') throw e;

      if (attempt >= maxRetries) {
        throw new LockError(
          `[pickle] Lock acquisition failed after ${maxRetries} retries (${lockPath})`
        );
      }

      // Exponential backoff with optional jitter — cap at 5s per sleep
      const backoff = baseLockDelayMs * Math.pow(2, attempt);
      const jitter = lockJitter ? Math.random() * baseLockDelayMs : 0;
      sleepMs(Math.min(backoff + jitter, 5000));
      attempt++;
    }
  }
}

/**
 * Extracts the session path from a session map entry.
 * Handles both the legacy string format and the current object format ({ sessionPath, pid })
 * for backward compatibility with existing current_sessions.json files.
 */
export function resolveSessionPath(entry: string | SessionMapEntry | unknown): string {
  if (typeof entry === 'string') return entry;
  if (entry !== null && typeof entry === 'object' && typeof (entry as SessionMapEntry).sessionPath === 'string') {
    return (entry as SessionMapEntry).sessionPath;
  }
  return '';
}

function sameWorkingDir(a: unknown, b: string): boolean {
  return typeof a === 'string' && path.resolve(a) === path.resolve(b);
}

interface SessionLookupState {
  active?: unknown;
  working_dir?: unknown;
  started_at?: unknown;
  state_mtime_ms?: number;
}

interface SessionLookupCandidate {
  sessionPath: string;
  recencyMs: number;
}

const MAX_FUTURE_RECENCY_DRIFT_MS = 5 * 60 * 1000;

function readSessionLookupState(sessionPath: string): SessionLookupState | null {
  try {
    const statePath = path.join(sessionPath, 'state.json');
    let stateMtimeMs = 0;
    try { stateMtimeMs = fs.statSync(statePath).mtimeMs; } catch { /* missing state read below will fail */ }
    const state = new StateManager().read(statePath);
    return {
      active: state.active,
      working_dir: state.working_dir,
      started_at: state.started_at,
      state_mtime_ms: stateMtimeMs,
    };
  } catch {
    return null;
  }
}

function getSessionRecencyMs(state: SessionLookupState): number {
  if (typeof state.started_at === 'string') {
    const startedAtMs = new Date(state.started_at).getTime();
    const maxTrustedFutureMs = Date.now() + MAX_FUTURE_RECENCY_DRIFT_MS;
    if (Number.isFinite(startedAtMs) && startedAtMs <= maxTrustedFutureMs) {
      return startedAtMs;
    }
  }
  return state.state_mtime_ms ?? 0;
}

function preferNewerSession(
  best: SessionLookupCandidate | null,
  candidate: SessionLookupCandidate,
): SessionLookupCandidate {
  if (!best) return candidate;
  if (candidate.recencyMs !== best.recencyMs) {
    return candidate.recencyMs > best.recencyMs ? candidate : best;
  }
  return candidate.sessionPath.localeCompare(best.sessionPath) > 0 ? candidate : best;
}

function selectScannedSessionPath(
  sessionPaths: string[],
  cwd: string,
  requireActive: boolean,
): string {
  let activeMatch: SessionLookupCandidate | null = null;
  let inactiveMatch: SessionLookupCandidate | null = null;

  for (const sessionPath of sessionPaths) {
    const state = readSessionLookupState(sessionPath);
    if (!state) continue;
    if (!sameWorkingDir(state.working_dir, cwd)) continue;
    const candidate = {
      sessionPath,
      recencyMs: getSessionRecencyMs(state),
    };
    if (state.active === true) {
      activeMatch = preferNewerSession(activeMatch, candidate);
      continue;
    }
    if (!requireActive) {
      inactiveMatch = preferNewerSession(inactiveMatch, candidate);
    }
  }

  return activeMatch?.sessionPath ?? inactiveMatch?.sessionPath ?? '';
}

/**
 * Resolves the session for a cwd from the session map first, then falls back
 * to scanning session state by working_dir when the map is missing or stale.
 */
// eslint-disable-next-line complexity -- resolver preserves map fallback and active-session scan precedence in one place
export function findSessionPathForCwd(
  cwd: string,
  options: { requireActive?: boolean } = {},
): string {
  const { requireActive = false } = options;
  const dataRoot = getDataRoot();
  const sessionsMapPath = path.join(dataRoot, 'current_sessions.json');
  let mappedFallback = '';

  try {
    const map = readRecoverableJsonObject(sessionsMapPath) as Record<string, unknown> | null;
    if (map) {
      const mappedPath = resolveSessionPath(map[cwd]);
      if (mappedPath && fs.existsSync(mappedPath)) {
        const state = readSessionLookupState(mappedPath);
        if (!state) {
          if (!requireActive) mappedFallback = mappedPath;
        } else if (sameWorkingDir(state.working_dir, cwd)) {
          if (state.active === true) return mappedPath;
          if (!requireActive) mappedFallback = mappedPath;
        } else if (!requireActive && (state.working_dir == null || state.working_dir === '')) {
          mappedFallback = mappedPath;
        }
      }
    }
  } catch {
    // Fall back to scanning session state below.
  }

  const sessionsDir = path.join(dataRoot, 'sessions');
  let entries: string[];
  try {
    entries = fs.readdirSync(sessionsDir);
  } catch {
    return mappedFallback;
  }

  const scannedMatch = selectScannedSessionPath(
    entries.map((entry) => path.join(sessionsDir, entry)),
    cwd,
    requireActive,
  );
  if (scannedMatch) {
    return scannedMatch;
  }

  return mappedFallback;
}

/** Matrix palette shared across all monitor panes. */
export const MatrixStyle = {
  BRIGHT: '\x1b[1;32m',    // bold green
  GREEN: '\x1b[32m',       // normal green
  DIM: '\x1b[2;32m',       // dim green
  CYAN: '\x1b[36m',        // cyan accent
  ERR: '\x1b[1;31m',       // bold red
  WARN: '\x1b[33m',        // yellow
  R: '\x1b[0m',            // reset
} as const;

export const RAIN_CHARS = 'ﾊﾐﾋｰｳｼﾅﾓﾆｻﾜﾂｵﾘｱﾎﾃﾏｹﾒｴｶｷﾑﾕﾗｾﾈｽﾀﾇﾍ012345789Z:."=*+-<>¦╌╎';

/** Generates a Matrix-styled separator line with random rain characters. */
export function matrixSeparator(width: number): string {
  const line: string[] = [];
  for (let i = 0; i < width; i++) {
    line.push(Math.random() < 0.2
      ? RAIN_CHARS[Math.floor(Math.random() * RAIN_CHARS.length)]
      : '─');
  }
  return `${MatrixStyle.DIM}${line.join('')}${MatrixStyle.R}`;
}

/** Finds the most recent tmux_iteration_N.log in a session directory. */
export function latestIterationLog(sessionDir: string): string | null {
  try {
    const logs = fs
      .readdirSync(sessionDir)
      .filter((f) => f.startsWith('tmux_iteration_') && f.endsWith('.log'))
      .sort((a, b) => {
        const numA = parseInt(a.replace('tmux_iteration_', '').replace('.log', ''), 10);
        const numB = parseInt(b.replace('tmux_iteration_', '').replace('.log', ''), 10);
        return (numA || 0) - (numB || 0);
      });
    return logs.length > 0 ? path.join(sessionDir, logs[logs.length - 1]) : null;
  } catch {
    return null;
  }
}

const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;
const DRAIN_CHUNK = 65536; // 64 KiB

/**
 * Reads stream-json log from `offset`, processes complete lines via the
 * provided `processor`, and emits output. Returns new offset and partial
 * trailing line buffer.
 */
export function drainStreamJsonLines(
  logPath: string,
  offset: number,
  lineBuf: string,
  processor: (line: string) => string | null,
  emit: (text: string) => void,
): { offset: number; lineBuf: string } {
  let fd: number | null = null;
  try {
    const { size } = fs.statSync(logPath);
    if (size <= offset) return { offset, lineBuf };
    fd = fs.openSync(logPath, 'r');
    let pos = offset;
    let buf = lineBuf;
    while (pos < size) {
      const toRead = Math.min(DRAIN_CHUNK, size - pos);
      const raw = Buffer.allocUnsafe(toRead);
      const bytesRead = fs.readSync(fd, raw, 0, toRead, pos);
      if (bytesRead === 0) break;
      buf += raw.subarray(0, bytesRead).toString('utf-8');
      pos += bytesRead;
    }
    fs.closeSync(fd);
    fd = null;
    const lines = buf.split('\n');
    const trailing = lines.pop() ?? '';
    for (const line of lines) {
      const result = processor(line);
      if (result !== null) emit(result);
    }
    return { offset: pos, lineBuf: trailing };
  } catch {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    return { offset, lineBuf };
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Emits log content to stdout, stripping ANSI codes and truncating long lines. */
function emitLog(content: string): void {
  const width = Math.min((process.stdout.columns || 80) - 2, 120);
  const lines = content.replace(ANSI_REGEX, '').split('\n').filter((l) => l.trim());
  for (const line of lines) {
    process.stdout.write((line.length > width ? line.slice(0, width - 1) + '…' : line) + '\n');
  }
}

/**
 * Reads new bytes from a log file starting at `offset`, emits them to stdout,
 * and returns the new offset. Reads in 64 KiB chunks to limit memory usage.
 */
export function drainLog(logPath: string, offset: number): number {
  let fd: number | null = null;
  try {
    const { size } = fs.statSync(logPath);
    if (size <= offset) return offset;
    fd = fs.openSync(logPath, 'r');
    const decoder = new StringDecoder('utf-8');
    let pos = offset;
    while (pos < size) {
      const toRead = Math.min(DRAIN_CHUNK, size - pos);
      const buf = Buffer.allocUnsafe(toRead);
      const bytesRead = fs.readSync(fd, buf, 0, toRead, pos);
      if (bytesRead === 0) break; // EOF — file was truncated
      emitLog(decoder.write(buf.subarray(0, bytesRead)));
      pos += bytesRead;
    }
    const trailing = decoder.end();
    if (trailing) emitLog(trailing);
    fs.closeSync(fd);
    return pos;
  } catch {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore double-close */ }
    }
    return offset;
  }
}

/**
 * Atomically writes `state` as pretty-printed JSON to `filePath`.
 * Writes to a `.tmp` sibling first, then renames — prevents partial reads.
 */
export function writeStateFile(filePath: string, state: State | object): void {
  const tmp = `${filePath}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore cleanup failure */ }
    throw err;
  }
}

/**
 * Updates a single key in a session's state.json with validation.
 * Numeric, boolean, and step keys are type-checked before writing.
 */
export function updateState(key: string, value: string, sessionDir: string): void {
  const statePath = path.join(sessionDir, 'state.json');

  if (!fs.existsSync(statePath)) {
    throw new Error(`state.json not found at ${statePath}`);
  }

  if (key === 'step' && !(VALID_STEPS as readonly string[]).includes(value)) {
    throw new Error(`Invalid step "${value}". Must be one of: ${VALID_STEPS.join(', ')}`);
  }

  const NUMERIC_KEYS = new Set(['iteration', 'max_iterations', 'max_time_minutes', 'worker_timeout_seconds', 'start_time_epoch', 'min_iterations']);
  const BOOLEAN_KEYS = new Set(['tmux_mode', 'chain_meeseeks']);
  // active and completion_promise are owned by tmux-runner/cancel.js — never via CLI
  const ALLOWED_KEYS = new Set([
    ...NUMERIC_KEYS, ...BOOLEAN_KEYS, 'step', 'working_dir',
    'original_prompt', 'current_ticket', 'started_at', 'session_dir', 'command_template',
  ]);
  if (!ALLOWED_KEYS.has(key)) {
    throw new Error(`Unknown state key "${key}". Allowed: ${[...ALLOWED_KEYS].join(', ')}`);
  }

  // Validate value BEFORE acquiring lock to fail fast
  if (NUMERIC_KEYS.has(key)) {
    const num = Number(value);
    if (!Number.isFinite(num)) {
      throw new Error(`Key "${key}" requires a finite number, got "${value}"`);
    }
    if (!Number.isInteger(num)) {
      throw new Error(`Key "${key}" requires an integer, got "${value}"`);
    }
    if (['iteration', 'max_iterations', 'max_time_minutes', 'start_time_epoch', 'min_iterations'].includes(key) && num < 0) {
      throw new Error(`Key "${key}" requires a non-negative integer, got "${value}"`);
    }
    if (key === 'worker_timeout_seconds' && num <= 0) {
      throw new Error(`Key "${key}" requires a positive integer, got "${value}"`);
    }
  } else if (BOOLEAN_KEYS.has(key)) {
    if (value !== 'true' && value !== 'false') {
      throw new Error(`Key "${key}" requires "true" or "false", got "${value}"`);
    }
  }

  const sm = new StateManager();
  sm.update(statePath, state => {
    if (NUMERIC_KEYS.has(key)) {
      (state as unknown as Record<string, unknown>)[key] = Number(value);
    } else if (BOOLEAN_KEYS.has(key)) {
      (state as unknown as Record<string, unknown>)[key] = value === 'true';
    } else {
      (state as unknown as Record<string, unknown>)[key] = value;
    }
  });
  console.log(`Successfully updated ${key} to ${value} in ${statePath}`);
}

/**
 * Monitor-window modes — map to the layout selector inside tmux-monitor.sh.
 * `pickle` is the default (2×2 grid with morty-watcher in the bottom-left);
 * `meeseeks` / `council` swap morty-watcher for mux-runner.log tail;
 * `refinement` swaps in refinement-watcher.
 */
export type MonitorMode = 'pickle' | 'meeseeks' | 'council' | 'refinement';

type WatcherPane = 1 | 2 | 3;

interface WatcherPaneCommand {
  pane: WatcherPane;
  name: string;
  command: string;
}

export interface EnsureMonitorWindowResult {
  status: 'skipped' | 'created' | 'exists' | 'recreated' | 'error';
  reason?: string;
}

export interface EnsureMonitorWindowOptions {
  sessionDir: string;
  extensionRoot?: string;
  /** Force a specific mode; if omitted, inferred from state.json.command_template. */
  mode?: MonitorMode;
  /** Test override: inject process spawns for tmux/bash calls. */
  spawnSyncFn?: typeof spawnSync;
  /** Test override: if false, skip even when process.env.TMUX is set. */
  inTmux?: boolean;
  /** Test override: tmux binary name (default: "tmux"). */
  tmuxBin?: string;
  /** Test override: bash binary name (default: "bash"). */
  bashBin?: string;
  /** Optional logger — called with human-readable status lines. */
  log?: (msg: string) => void;
}

/** Infers monitor mode from state.json's command_template. Defaults to 'pickle'. */
export function inferMonitorMode(sessionDir: string): MonitorMode {
  try {
    const state = new StateManager().read(path.join(sessionDir, 'state.json')) as { command_template?: string };
    const tpl = (state.command_template || '').toLowerCase();
    if (tpl === 'meeseeks.md') return 'meeseeks';
    if (tpl === 'council-of-ricks.md') return 'council';
    return 'pickle';
  } catch {
    return 'pickle';
  }
}

export function restartDeadWatcherPanes(
  sessionDir: string,
  extensionRoot: string,
  mode: MonitorMode,
  spawnSyncFn: typeof spawnSync = spawnSync,
): void {
  if (isSessionInactive(sessionDir)) return;

  const sessionName = readCurrentTmuxSessionName(spawnSyncFn);
  if (!sessionName) {
    appendWatcherRestartLog(sessionDir, 'restartDeadWatcherPanes WARN: unable to resolve tmux session name');
    return;
  }

  for (const watcher of watcherPaneCommands(sessionDir, extensionRoot, mode)) {
    const target = `${sessionName}:monitor.${watcher.pane}`;
    const currentCommand = readPaneCurrentCommand(target, spawnSyncFn);
    if (currentCommand === null) {
      appendWatcherRestartLog(
        sessionDir,
        `restartDeadWatcherPanes WARN: unable to read pane_current_command for pane ${watcher.pane}`,
      );
      continue;
    }
    if (currentCommand === 'node') continue;

    appendWatcherRestartLog(
      sessionDir,
      `restartDeadWatcherPanes WARN: pane ${watcher.pane} command '${currentCommand || '(empty)'}' is not node`,
    );
    const result = spawnSyncFn('tmux', ['send-keys', '-t', target, watcher.command, 'Enter'], {
      encoding: 'utf-8',
      timeout: 5_000,
    });
    if (result.status === 0) {
      appendWatcherRestartLog(
        sessionDir,
        `restartDeadWatcherPanes: respawned ${watcher.name} in pane ${watcher.pane}`,
      );
    } else {
      const err = (result.stderr || result.stdout || '').toString().trim();
      appendWatcherRestartLog(
        sessionDir,
        `restartDeadWatcherPanes WARN: failed to respawn ${watcher.name} in pane ${watcher.pane}: ${err || 'non-zero exit'}`,
      );
    }
  }
}

function isSessionInactive(sessionDir: string): boolean {
  try {
    const state = new StateManager().read(path.join(sessionDir, 'state.json')) as { active?: unknown };
    return state.active === false;
  } catch {
    return false;
  }
}

function readCurrentTmuxSessionName(spawnSyncFn: typeof spawnSync): string | null {
  const result = spawnSyncFn('tmux', ['display-message', '-p', '#S'], {
    encoding: 'utf-8',
    timeout: 5_000,
  });
  if (result.status !== 0) return null;
  const sessionName = (result.stdout || '').trim();
  return sessionName || null;
}

function readPaneCurrentCommand(target: string, spawnSyncFn: typeof spawnSync): string | null {
  const result = spawnSyncFn('tmux', ['display-message', '-p', '-t', target, '#{pane_current_command}'], {
    encoding: 'utf-8',
    timeout: 5_000,
  });
  if (result.status !== 0) return null;
  return (result.stdout || '').trim();
}

function watcherPaneCommands(sessionDir: string, extensionRoot: string, mode: MonitorMode): WatcherPaneCommand[] {
  const binRoot = path.join(extensionRoot, 'extension', 'bin');
  const paneTwo = watcherPaneTwoCommand(sessionDir, binRoot, mode);

  return [
    {
      pane: 1,
      name: 'log-watcher.js',
      command: `node ${path.join(binRoot, 'log-watcher.js')} ${sessionDir}`,
    },
    paneTwo,
    {
      pane: 3,
      name: 'raw-morty.js',
      command: `node ${path.join(binRoot, 'raw-morty.js')} ${sessionDir}`,
    },
  ];
}

function watcherPaneTwoCommand(sessionDir: string, binRoot: string, mode: MonitorMode): WatcherPaneCommand {
  if (mode === 'refinement') {
    return {
      pane: 2,
      name: 'refinement-watcher.js',
      command: `node ${path.join(binRoot, 'refinement-watcher.js')} ${sessionDir}`,
    };
  }
  if (mode === 'meeseeks' || mode === 'council') {
    return {
      pane: 2,
      name: 'mux-runner.log tail',
      command: `tail -F ${path.join(sessionDir, 'mux-runner.log')}`,
    };
  }
  return {
    pane: 2,
    name: 'morty-watcher.js',
    command: `node ${path.join(binRoot, 'morty-watcher.js')} ${sessionDir}`,
  };
}

function appendWatcherRestartLog(sessionDir: string, line: string): void {
  try {
    fs.appendFileSync(path.join(sessionDir, 'mux-runner.log'), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Best-effort diagnostic logging must not break pane recovery.
  }
}

/**
 * Idempotently creates the 4-pane monitor window in the current tmux session.
 *
 * Called at the start of every long-running pickle tmux runner (mux-runner,
 * pipeline-runner) so agents never have to invoke tmux-monitor.sh explicitly —
 * previously Step 11e of several skill prompts, silently dropped when the
 * agent's context was tight.
 *
 * Never throws. Returns a status so callers can log the outcome:
 *   - `skipped`    → not inside tmux (headless or direct invocation)
 *   - `exists`     → monitor window already present for this mode, no-op
 *   - `created`    → monitor window spawned
 *   - `recreated`  → stale monitor (different mode) killed and respawned
 *   - `error`      → tmux/bash call failed; check `reason`
 *
 * Mode compatibility: the monitor window's layout is mode-specific
 * (pickle/meeseeks/council/refinement). We persist the mode it was built for
 * via a tmux user-option (`@pickle_monitor_mode`) on the window itself, then
 * on re-entry compare against the mode this invocation wants. Mismatch =>
 * kill + recreate. Silent reuse would leave the wrong layout in place.
 */
export function ensureMonitorWindow(opts: EnsureMonitorWindowOptions): EnsureMonitorWindowResult {
  const log = opts.log || (() => { /* no-op */ });
  const inTmux = opts.inTmux !== undefined ? opts.inTmux : !!process.env.TMUX;

  if (!inTmux) {
    log('ensureMonitorWindow: not inside tmux, skipping');
    return { status: 'skipped', reason: 'not in tmux' };
  }

  activeMonitorWindowContext = {
    opts,
    log,
    tmuxBin: opts.tmuxBin || 'tmux',
    bashBin: opts.bashBin || 'bash',
    spawnSyncFn: opts.spawnSyncFn || spawnSync,
    mode: opts.mode || inferMonitorMode(opts.sessionDir),
  };
  try {
    const sessionName = getSessionName();
    if (!sessionName) return activeMonitorWindowContext.outcome || { status: 'error', reason: 'empty session name' };
    const { recreate } = checkAndRecreateWindow(sessionName);
    if (activeMonitorWindowContext.outcome) return activeMonitorWindowContext.outcome;
    createMonitorWindow(sessionName);
    if (activeMonitorWindowContext.outcome) return activeMonitorWindowContext.outcome;
    if (recreate) {
      log(`ensureMonitorWindow: recreated 4-pane monitor (mode=${activeMonitorWindowContext.mode}) on ${sessionName}`);
      return { status: 'recreated' };
    }
    log(`ensureMonitorWindow: created 4-pane monitor (mode=${activeMonitorWindowContext.mode}) on ${sessionName}`);
    return { status: 'created' };
  } finally {
    activeMonitorWindowContext = null;
  }
}

interface MonitorWindowContext {
  opts: EnsureMonitorWindowOptions;
  log: (msg: string) => void;
  tmuxBin: string;
  bashBin: string;
  spawnSyncFn: typeof spawnSync;
  mode: MonitorMode;
  outcome?: EnsureMonitorWindowResult;
}

let activeMonitorWindowContext: MonitorWindowContext | null = null;

function currentMonitorWindowContext(): MonitorWindowContext {
  if (!activeMonitorWindowContext) throw new Error('ensureMonitorWindow context not initialized');
  return activeMonitorWindowContext;
}

function getSessionName(): string | null {
  const { log, spawnSyncFn, tmuxBin } = currentMonitorWindowContext();
  // Resolve session name via tmux itself — the TMUX env var alone only proves
  // we're inside *some* tmux, not which session owns this pane.
  const displayName = spawnSyncFn(tmuxBin, ['display-message', '-p', '#S'], {
    encoding: 'utf-8',
    timeout: 5_000,
  });
  if (displayName.status !== 0) {
    const err = (displayName.stderr || '').toString().trim();
    log(`ensureMonitorWindow: tmux display-message failed: ${err}`);
    activeMonitorWindowContext!.outcome = { status: 'error', reason: `display-message: ${err || 'non-zero exit'}` };
    return null;
  }
  const sessionName = (displayName.stdout || '').trim();
  if (!sessionName) {
    log('ensureMonitorWindow: empty tmux session name');
    activeMonitorWindowContext!.outcome = { status: 'error', reason: 'empty session name' };
    return null;
  }
  return sessionName;
}

function checkAndRecreateWindow(sessionName: string): { recreate: boolean } {
  const { log, mode, opts, spawnSyncFn, tmuxBin } = currentMonitorWindowContext();
  const target = `${sessionName}:monitor`;

  // Compatibility guard — a "monitor" window from a previous command (e.g.
  // anatomy-park then council) has the wrong layout. Check the window's
  // `@pickle_monitor_mode` user-option and recreate on mismatch.
  const listWindows = spawnSyncFn(tmuxBin, ['list-windows', '-t', sessionName, '-F', '#W'], {
    encoding: 'utf-8',
    timeout: 5_000,
  });
  if (listWindows.status !== 0) return { recreate: false };
  const names = (listWindows.stdout || '').split('\n').map(s => s.trim());
  if (!names.includes('monitor')) return { recreate: false };

  const existingMode = readWindowMode(tmuxBin, target, spawnSyncFn);
  if (monitorModesCompatible(existingMode, mode)) {
    log(`ensureMonitorWindow: monitor window already exists on ${sessionName} (mode=${mode})`);
    restartDeadWatcherPanes(opts.sessionDir, opts.extensionRoot || getExtensionRoot(), mode, spawnSyncFn);
    activeMonitorWindowContext!.outcome = { status: 'exists' };
    return { recreate: false };
  }

  log(
    `ensureMonitorWindow: mode mismatch on ${sessionName} ` +
    `(existing=${existingMode || 'unset'}, want=${mode}) — killing stale window`,
  );
  const kill = spawnSyncFn(tmuxBin, ['kill-window', '-t', target], {
    encoding: 'utf-8',
    timeout: 5_000,
  });
  if (kill.status !== 0) {
    const err = (kill.stderr || '').toString().trim();
    log(`ensureMonitorWindow: kill-window failed: ${err}`);
    activeMonitorWindowContext!.outcome = { status: 'error', reason: `kill-window: ${err || 'non-zero exit'}` };
    return { recreate: false };
  }
  return { recreate: true };
}

function createMonitorWindow(sessionName: string): void {
  const { bashBin, log, mode, opts, spawnSyncFn, tmuxBin } = currentMonitorWindowContext();
  const target = `${sessionName}:monitor`;
  const extensionRoot = opts.extensionRoot || getExtensionRoot();
  const script = path.join(extensionRoot, 'extension', 'scripts', 'tmux-monitor.sh');
  if (!fs.existsSync(script)) {
    log(`ensureMonitorWindow: tmux-monitor.sh missing at ${script}`);
    activeMonitorWindowContext!.outcome = { status: 'error', reason: `script missing: ${script}` };
    return;
  }

  const result = spawnSyncFn(bashBin, [script, sessionName, opts.sessionDir, mode], {
    encoding: 'utf-8',
    timeout: 10_000,
  });
  if (result.status !== 0) {
    const err = (result.stderr || result.stdout || '').toString().trim();
    log(`ensureMonitorWindow: tmux-monitor.sh failed (exit ${result.status}): ${err}`);
    activeMonitorWindowContext!.outcome = { status: 'error', reason: `script exit ${result.status}: ${err || 'no stderr'}` };
    return;
  }

  // Stamp the mode on the freshly-created window so the next invocation can
  // detect compatibility. Non-fatal if it fails — we log and move on.
  const setOpt = spawnSyncFn(
    tmuxBin,
    ['set-option', '-w', '-t', target, '@pickle_monitor_mode', mode],
    { encoding: 'utf-8', timeout: 5_000 },
  );
  if (setOpt.status !== 0) {
    const err = (setOpt.stderr || '').toString().trim();
    log(`ensureMonitorWindow: set-option @pickle_monitor_mode failed (non-fatal): ${err}`);
  }
}

/** Reads the monitor window's stamped mode via tmux user-option, or null. */
function readWindowMode(tmuxBin: string, target: string, spawnSyncFn: typeof spawnSync): string | null {
  const show = spawnSyncFn(
    tmuxBin,
    ['show-option', '-w', '-qv', '-t', target, '@pickle_monitor_mode'],
    { encoding: 'utf-8', timeout: 5_000 },
  );
  if (show.status !== 0) return null;
  const val = (show.stdout || '').trim();
  return val || null;
}

/**
 * Returns true iff we can reuse an existing monitor window without recreating.
 * Unset existing mode counts as incompatible — we can't prove the layout matches
 * what this mode needs, so play it safe and rebuild.
 */
export function monitorModesCompatible(existing: string | null, want: MonitorMode): boolean {
  if (!existing) return false;
  return existing === want;
}

/** Default timeout for macOS notification shell-outs (`osascript`). Kept short
 *  because notifications run on the exit path — a wedged Notification Center /
 *  AppleEvent daemon must NOT block `process.exit` on the runner. Four prior
 *  "improve notification" passes (8db2771, 2f19356, f9f37ef, 2da7fe5, 8cc31a6)
 *  added features and fixed content but none passed a `timeout`; see trap door
 *  in extension/CLAUDE.md and anatomy-park iteration 4 commit. */
export const NOTIFICATION_TIMEOUT_MS = 5_000;

export interface DisplayMacNotificationOptions {
  /** @internal test seam — override `spawnSync` to capture invocations / inject hangs */
  spawnSyncFn?: typeof spawnSync;
  /** @internal test seam — force the darwin code path on any platform */
  forceDarwin?: boolean;
  /** Override the default NOTIFICATION_TIMEOUT_MS (primarily for tests) */
  timeoutMs?: number;
}

/** Display a macOS notification via `osascript`. No-op on non-darwin platforms.
 *  Every invocation passes an explicit `timeout` so a wedged UI server cannot
 *  block the caller indefinitely. Any error (ENOENT, SIGTERM on timeout,
 *  non-zero exit) is swallowed — notifications are best-effort at program exit. */
export function displayMacNotification(
  title: string,
  body: string,
  subtitle?: string,
  opts: DisplayMacNotificationOptions = {},
): void {
  const isDarwin = opts.forceDarwin ?? process.platform === 'darwin';
  if (!isDarwin) return;
  const timeoutMs = opts.timeoutMs ?? NOTIFICATION_TIMEOUT_MS;
  const spawnSyncFn = opts.spawnSyncFn ?? spawnSync;
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = subtitle
    ? `display notification "${esc(body)}" with title "${esc(title)}" subtitle "${esc(subtitle)}"`
    : `display notification "${esc(body)}" with title "${esc(title)}"`;
  try {
    spawnSyncFn('osascript', ['-e', script], { timeout: timeoutMs, encoding: 'utf-8' });
  } catch { /* best-effort: ENOENT / timeout / non-zero exit are all non-fatal */ }
}

/** Removes inactive session directories older than maxAgeDays from sessionsRoot. */
export function pruneOldSessions(sessionsRoot: string, maxAgeDays = 7): void {
  if (!fs.existsSync(sessionsRoot)) return;
  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const maxTrustedFutureMs = Date.now() + MAX_FUTURE_RECENCY_DRIFT_MS;
  const sm = new StateManager();
  for (const entry of fs.readdirSync(sessionsRoot)) {
    const sessionDir = path.join(sessionsRoot, entry);
    const statePath = path.join(sessionDir, 'state.json');
    if (!fs.existsSync(statePath)) continue;
    try {
      const sessionDirMtimeMs = fs.statSync(sessionDir).mtimeMs;
      const state = sm.read(statePath);
      if (state.active === true) continue;
      const rawMs = state.started_at
        ? new Date(state.started_at).getTime()
        : NaN;
      const startedMs = Number.isFinite(rawMs) && rawMs <= maxTrustedFutureMs
        ? rawMs
        : sessionDirMtimeMs;
      if (startedMs < cutoffMs) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      }
    } catch { /* skip unreadable or already-deleted sessions */ }
  }
}

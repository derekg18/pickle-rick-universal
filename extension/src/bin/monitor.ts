#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { collectTickets, statusSymbol, formatTime, getWidth, getHeight, Style, sleep, MatrixStyle, matrixSeparator, latestIterationLog, safeErrorMessage, TicketInfo } from '../services/pickle-utils.js';
import { StateManager } from '../services/state-manager.js';
import { readMicroverseState, readRecoverableJsonObject } from '../services/microverse-state.js';
import { readCircuitBreakerState } from '../services/circuit-breaker.js';
import { State, MicroverseSessionState } from '../types/index.js';

type PipelineLifecycleStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown' | 'none';
const sm = new StateManager();

/**
 * Watchdog timeout for stdout writes. When `process.stdout.write()` reports
 * backpressure (returns `false`) and the kernel buffer never drains within
 * this window, the monitor exits with a clear stderr message rather than
 * blocking forever in a synchronous write. Without this guard a wedged
 * tmux pane (scrollback frozen, pipe buffer full) prevents Node from
 * servicing SIGINT, so `Ctrl-C` cannot kill the monitor.
 *
 * AC-SSV-07: 2000ms is long enough to ride out routine pane redraws on
 * busy machines but short enough that a wedged pane is detected before
 * the user reaches for `kill -9`.
 */
export const MONITOR_STDOUT_WATCHDOG_MS = 2000;

/**
 * Minimal sink interface used by the write watchdog. `process.stdout`
 * satisfies it; the test harness substitutes a wedged `Writable` to
 * simulate a frozen tmux pane.
 */
export interface MonitorWriteSink {
  write(chunk: string, cb?: (err?: Error | null) => void): boolean;
  once(event: 'drain' | 'error' | 'close', listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
}

/**
 * Write `chunk` to `sink`, returning a promise that resolves once the
 * write has flushed (or the kernel has reported drain when backpressure
 * was applied). Rejects with a backpressure error if neither the
 * write callback nor a `drain` event arrives within `watchdogMs`.
 *
 * AC-SSV-07: synchronous `process.stdout.write` blocks indefinitely
 * when the underlying pipe buffer is full and the consumer (the tmux
 * pane) is wedged. `setTimeout` cannot fire while Node is parked in a
 * blocking syscall, so we drive the write through the async callback
 * path and arm the timer alongside it. If the timer wins, we surface
 * the wedge instead of joining it.
 */
export function writeWithWatchdog(
  sink: MonitorWriteSink,
  chunk: string,
  watchdogMs: number = MONITOR_STDOUT_WATCHDOG_MS
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => {
      finish(new Error(
        `monitor stdout watchdog: no drain within ${watchdogMs}ms (pane wedged?)`
      ));
    }, watchdogMs);
    // Allow the process to exit if the watchdog timer is the only
    // remaining handle (e.g., during shutdown).
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }

    let okSync: boolean;
    try {
      // The write callback fires once data has been flushed (or errored).
      // It alone is enough to resolve us in the healthy path; the drain
      // listener is a belt-and-braces fallback for sinks that signal
      // completion only via 'drain'.
      okSync = sink.write(chunk, (err) => {
        if (err) finish(err);
        else finish();
      });
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    if (!okSync) {
      // Kernel buffer is full — wait for drain or the watchdog.
      sink.once('drain', () => finish());
      sink.once('error', (err: unknown) => {
        finish(err instanceof Error ? err : new Error(String(err)));
      });
    }
  });
}

/**
 * Render the `Elapsed` field value. When `maxTimeMin > 0` and the
 * elapsed wall clock has already overrun the budget, append a bold-red
 * ` EXCEEDED` suffix so operators notice that the run is past its
 * configured time-box.
 *
 * AC-LPB-06: large-pipeline budgets that were undersized at launch
 * still keep running, but the monitor must visibly flag that the
 * configured ceiling has been crossed instead of silently rendering
 * `1000m / 720m` as if it were normal.
 *
 * Exported for unit testing.
 */
export function renderElapsedField(elapsedSec: number, maxTimeMin: number): string {
  const safeElapsed = Math.max(0, Math.floor(elapsedSec));
  const base = formatTime(safeElapsed);
  if (!(maxTimeMin > 0)) {
    return `${MX.GREEN}${base}${MX.R}`;
  }
  const withCeiling = `${base} / ${maxTimeMin}m`;
  const exceeded = safeElapsed / 60 > maxTimeMin;
  if (!exceeded) return `${MX.GREEN}${withCeiling}${MX.R}`;
  return `${MX.GREEN}${withCeiling}${MX.R} ${MX.ERR}EXCEEDED${MX.R}`;
}

/**
 * Extracts a short readable summary from a stream-json log line.
 * Returns the original line (sans ANSI) if it's not valid JSON.
 */
// eslint-disable-next-line complexity -- pre-existing — outside T0–T15 god-fn refactor scope; defer to follow-up epic
export function summarizeLine(raw: string): string {
  const clean = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
  if (!clean) return '';
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(clean);
  } catch {
    return clean;
  }
  if (typeof parsed !== 'object' || parsed === null) return clean;

  const type = parsed.type;

  if (type === 'assistant') {
    const msg = parsed.message as Record<string, unknown> | undefined;
    if (!msg || !Array.isArray(msg.content)) return '';
    const parts: string[] = [];
    for (const block of msg.content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string') {
        const first = (b.text as string).split('\n')[0].trim();
        if (first) parts.push(first);
      } else if (b.type === 'tool_use' && typeof b.name === 'string') {
        parts.push(`🔧 ${b.name}`);
      }
    }
    return parts.join(' | ') || '';
  }
  if (type === 'result') {
    const isError = typeof parsed.subtype === 'string' && (parsed.subtype as string).startsWith('error');
    return isError ? `❌ ${parsed.subtype}` : '✅ success';
  }
  if (type === 'system' && parsed.subtype === 'init') {
    return `🚀 init (${typeof parsed.model === 'string' ? parsed.model : 'unknown'})`;
  }
  return '';
}

const MX = MatrixStyle;

/** Unicode sparkline from a sequence of numbers. */
export function sparkline(values: number[]): string {
  if (values.length === 0) return '';
  const blocks = '▁▂▃▄▅▆▇█';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  return values
    .map(v => blocks[Math.min(blocks.length - 1, Math.round(((v - min) / range) * (blocks.length - 1)))])
    .join('');
}

/** Render a compact microverse convergence trend section. */
export function renderMicroverseTrend(mv: MicroverseSessionState, width: number): string[] {
  const out: string[] = [];
  const sep = matrixSeparator(width);
  const history = mv.convergence.history;
  const direction = mv.key_metric.direction ?? 'higher';
  const targetLabel = mv.convergence_target != null ? String(mv.convergence_target) : '—';

  out.push(`\n${sep}\n${MX.BRIGHT}Metric Trend${MX.R} ${MX.DIM}(${direction} is better, target: ${targetLabel})${MX.R}\n`);

  if (history.length === 0) {
    out.push(`  ${MX.DIM}No measurements yet${MX.R}\n`);
    return out;
  }

  // Sparkline of all scores (accepted + reverted)
  const scores = history.map(h => h.score);
  const spark = sparkline(scores);
  const latest = scores[scores.length - 1];
  const latestAction = history[history.length - 1].action;
  const latestColor = latestAction === 'accept' ? MX.GREEN : MX.ERR;

  out.push(`  ${MX.DIM}Score:${MX.R} ${latestColor}${latest}${MX.R}  ${MX.GREEN}${spark}${MX.R}\n`);

  // Compact history: last 8 entries as "iter:score(action)"
  const tail = history.slice(-8);
  const entries = tail.map(h => {
    const sym = h.action === 'accept' ? '✓' : '✗';
    const c = h.action === 'accept' ? MX.GREEN : MX.ERR;
    return `${c}${h.iteration}:${h.score}${sym}${MX.R}`;
  });
  out.push(`  ${entries.join(` ${MX.DIM}→${MX.R} `)}\n`);

  // Stall counter
  const { stall_counter, stall_limit } = mv.convergence;
  if (stall_counter > 0) {
    const stallColor = stall_counter >= stall_limit - 1 ? MX.ERR : MX.WARN;
    out.push(`  ${stallColor}Stall: ${stall_counter}/${stall_limit}${MX.R}\n`);
  }

  // Status badge
  if (mv.status === 'converged') {
    out.push(`  ${MX.BRIGHT}${MX.GREEN}◆ CONVERGED${MX.R}\n`);
  } else if (mv.status === 'stopped') {
    out.push(`  ${MX.WARN}◇ STOPPED${mv.exit_reason ? ` (${mv.exit_reason})` : ''}${MX.R}\n`);
  }

  return out;
}

/**
 * Format the `Current` header field as `<id>: <title>` when a matching ticket
 * exists, truncated to pane width. Falls back to bare id or "none".
 */
export function formatCurrentField(
  currentTicketId: string | null | undefined,
  tickets: TicketInfo[],
  width: number
): string {
  if (!currentTicketId) return `${MX.DIM}none${MX.R}`;
  const match = tickets.find((t) => t.id === currentTicketId);
  const title = match?.title?.trim();
  const raw = title ? `${currentTicketId}: ${title}` : String(currentTicketId);
  // Reserve ~16 cols for the "  Current: " label + padding
  const maxLen = Math.max(8, width - 16);
  const display = raw.length > maxLen ? raw.slice(0, maxLen - 1) + '…' : raw;
  return `${MX.BRIGHT}${display}${MX.R}`;
}

/**
 * Build the ticket list section as an array of pre-formatted lines (each
 * ending in `\n`). When `tickets.length` fits within `budget`, renders the
 * full list. Otherwise, windows the slice around the current (or last-done)
 * ticket, keeping the current ticket visible with a trailing buffer of
 * upcoming tickets, and emits `... N more above/below ...` indicators.
 *
 * Exported for unit testing. `budget` is the max number of ticket body lines
 * available (including any indicator lines). Caller accounts for the
 * "Tickets:" section header separately.
 */
// eslint-disable-next-line complexity -- pre-existing — outside T0–T15 god-fn refactor scope; defer to follow-up epic
export function buildTicketLines(
  tickets: TicketInfo[],
  currentTicketId: string | null | undefined,
  budget: number
): string[] {
  if (tickets.length === 0) return [];

  const renderOne = (ticket: TicketInfo): string => {
    const status = (ticket.status || '').toLowerCase();
    const sym = statusSymbol(ticket.status);
    const coloredSym =
      status === 'done'
        ? `${MX.GREEN}${sym}${MX.R}`
        : status === 'in progress'
          ? `${MX.WARN}${sym}${MX.R}`
          : `${MX.DIM}${sym}${MX.R}`;
    const isCurrent = ticket.id === currentTicketId;
    const prefix = isCurrent ? `${MX.BRIGHT}▸${MX.R}` : ' ';
    const titleStr = isCurrent
      ? `${MX.BRIGHT}${ticket.title || ''}${MX.R}`
      : `${MX.GREEN}${ticket.title || ''}${MX.R}`;
    return `${prefix} ${coloredSym} ${MX.DIM}${ticket.id}:${MX.R} ${titleStr}\n`;
  };

  if (budget <= 0 || tickets.length <= budget) {
    return tickets.map(renderOne);
  }

  const currentIdx = currentTicketId
    ? tickets.findIndex((t) => t.id === currentTicketId)
    : -1;
  let anchorIdx: number;
  if (currentIdx >= 0) {
    anchorIdx = currentIdx;
  } else {
    let lastDone = -1;
    for (let i = 0; i < tickets.length; i++) {
      if ((tickets[i].status || '').toLowerCase() === 'done') lastDone = i;
    }
    anchorIdx = lastDone >= 0 ? lastDone : 0;
  }

  // Reserve up to 2 lines for the above/below indicators.
  const bodyBudget = Math.max(1, budget - 2);
  const trailingBuffer = 3;

  let end = Math.min(tickets.length, anchorIdx + trailingBuffer + 1);
  let start = Math.max(0, end - bodyBudget);

  if (anchorIdx < start || anchorIdx >= end) {
    start = Math.max(0, anchorIdx - Math.floor(bodyBudget / 2));
    end = Math.min(tickets.length, start + bodyBudget);
  }

  if (end === tickets.length) {
    start = Math.max(0, tickets.length - bodyBudget);
  }
  if (start === 0) {
    end = Math.min(tickets.length, bodyBudget);
  }

  const out: string[] = [];
  if (start > 0) {
    out.push(`  ${MX.DIM}... ${start} more above ...${MX.R}\n`);
  }
  for (let i = start; i < end; i++) {
    out.push(renderOne(tickets[i]));
  }
  if (end < tickets.length) {
    out.push(`  ${MX.DIM}... ${tickets.length - end} more below ...${MX.R}\n`);
  }
  return out;
}

function readTailUtf8(filePath: string, maxBytes: number): string {
  const { size } = fs.statSync(filePath);
  const readStart = Math.max(0, size - maxBytes);
  if (readStart === 0) return fs.readFileSync(filePath, 'utf-8');

  const buf = Buffer.allocUnsafe(size - readStart);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buf, 0, buf.length, readStart);
  } finally {
    fs.closeSync(fd);
  }

  const raw = buf.toString('utf-8');
  const firstNewline = raw.indexOf('\n');
  return firstNewline !== -1 ? raw.slice(firstNewline + 1) : raw;
}

export function readPipelineLifecycle(sessionDir: string): PipelineLifecycleStatus {
  const pipelinePath = path.join(sessionDir, 'pipeline.json');
  if (!fs.existsSync(pipelinePath)) return 'none';

  const statusPath = path.join(sessionDir, 'pipeline-status.json');
  try {
    const raw = readRecoverableJsonObject(statusPath) as { status?: unknown } | null;
    if (raw && (
      raw.status === 'running' ||
      raw.status === 'completed' ||
      raw.status === 'failed' ||
      raw.status === 'cancelled'
    )) {
      return raw.status;
    }
  } catch {
    // Fall back to the runner log for older sessions without pipeline-status.json.
  }

  const runnerLogPath = path.join(sessionDir, 'pipeline-runner.log');
  try {
    const tail = readTailUtf8(runnerLogPath, 8192);
    if (tail.includes('Pipeline finished:')) return 'completed';
    if (tail.includes('shutting down pipeline')) return 'cancelled';
    if (tail.includes('pipeline-runner started')) return 'running';
  } catch {
    // No runner log yet — treat as in-progress until proven terminal.
  }

  return 'unknown';
}

export function shouldMonitorExit(sessionDir: string, active: boolean): boolean {
  if (active) return false;
  const lifecycle = readPipelineLifecycle(sessionDir);
  if (lifecycle === 'none') return true;
  return lifecycle === 'completed' || lifecycle === 'failed' || lifecycle === 'cancelled';
}

function countRows(segments: string[]): number {
  let n = 0;
  for (const s of segments) {
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  }
  return n;
}

// eslint-disable-next-line complexity, max-lines-per-function -- pre-existing — outside T0–T15 god-fn refactor scope; defer to follow-up epic
async function render(sessionDir: string, sink: MonitorWriteSink = process.stdout): Promise<boolean> {
  // If the session directory itself is gone, signal exit (not just "waiting")
  if (!fs.existsSync(sessionDir)) return false;

  const statePath = path.join(sessionDir, 'state.json');
  let state: State;
  try {
    state = sm.read(statePath);
  } catch {
    await writeWithWatchdog(sink, `\x1b[2J\x1b[H${MX.DIM}Awaiting signal...${MX.R}\n`);
    return true;
  }

  const width = getWidth();
  const sep = matrixSeparator(width);

  const startEpoch = Number(state.start_time_epoch) || 0;
  const elapsed = startEpoch > 0 ? Math.max(0, Math.floor(Date.now() / 1000) - startEpoch) : 0;
  const tickets = collectTickets(sessionDir);
  const maxIter = Number(state.max_iterations) || 0;
  const maxTime = Number(state.max_time_minutes) || 0;
  const iterStr = maxIter > 0
    ? `${state.iteration} / ${state.max_iterations}`
    : `${state.iteration}`;

  const workDir = state.working_dir || '';
  const project = workDir ? path.basename(workDir) : 'unknown';
  const task = state.original_prompt || '';
  const taskDisplay = task.length > width - 20 ? task.slice(0, width - 23) + '…' : (task || 'none');

  const fields: [string, string][] = [
    ['Project', `${MX.BRIGHT}${project}${MX.R}`],
    ['Task', `${MX.GREEN}${taskDisplay}${MX.R}`],
    ['Phase', `${MX.CYAN}${state.step || 'unknown'}${MX.R}`],
    ['Iteration', `${MX.GREEN}${iterStr}${MX.R}`],
    ['Elapsed', renderElapsedField(elapsed, maxTime)],
    ['Current', formatCurrentField(state.current_ticket, tickets, width)],
    ['Active', state.active === true ? `${MX.BRIGHT}▣ ONLINE${MX.R}` : `${MX.ERR}▢ OFFLINE${MX.R}`],
  ];

  try {
    const cb = readCircuitBreakerState(sessionDir);
    if (!cb) throw new Error('circuit breaker state unavailable');
    if (cb.state === 'CLOSED') {
      fields.push(['Circuit', `${MX.GREEN}CLOSED${MX.R}`]);
    } else if (cb.state === 'HALF_OPEN') {
      fields.push(['Circuit', `${MX.WARN}HALF_OPEN (${cb.reason || ''})${MX.R}`]);
    } else if (cb.state === 'OPEN') {
      fields.push(['Circuit', `${MX.ERR}OPEN (${cb.reason || ''})${MX.R}`]);
    }
  } catch {
    // circuit_breaker.json missing or corrupt — skip field
  }

  // Rate limit wait display
  try {
    const waitPath = path.join(sessionDir, 'rate_limit_wait.json');
    const waitData = readRecoverableJsonObject(waitPath) as Record<string, unknown> | null;
    if (waitData && waitData.waiting === true && waitData.wait_until) {
      const remainMs = new Date(String(waitData.wait_until)).getTime() - Date.now();
      const typeLabel = waitData.rate_limit_type ? ` [${String(waitData.rate_limit_type)}]` : '';
      const sourceLabel = waitData.wait_source === 'api' ? ' (API reset)' : '';
      if (remainMs > 0) {
        const remainSec = Math.ceil(remainMs / 1000);
        fields.push(['Rate Limit', `${MX.WARN}⏳ Rate limited${typeLabel}${sourceLabel} (${formatTime(remainSec)} remaining)${MX.R}`]);
      } else {
        fields.push(['Rate Limit', `${MX.WARN}⏳ Rate limit wait ending...${MX.R}`]);
      }
    }
  } catch { /* no wait state */ }

  const keyWidth = Math.max(...fields.map(([k]) => k.length)) + 1;

  const out: string[] = ['\x1b[2J\x1b[H'];
  out.push(`\n${MX.BRIGHT}◤ PICKLE RICK — LIVE MONITOR ◢${MX.R}\n`);
  out.push(`${sep}\n`);
  for (const [k, v] of fields) {
    out.push(`  ${MX.DIM}${k + ':'}${' '.repeat(keyWidth - k.length)}${MX.R} ${v}\n`);
  }

  // Microverse convergence trend (szechuan-sauce, pickle-microverse, etc.)
  try {
    const mv = readMicroverseState(sessionDir);
    if (mv?.convergence?.history) {
      out.push(...renderMicroverseTrend(mv, width));
    }
  } catch {
    // No microverse session — skip
  }

  // Build the "Recent output" section first so we can reserve its rows
  // before sizing the ticket window.
  const recentOut: string[] = [];
  try {
    const logPath = latestIterationLog(sessionDir);
    if (logPath) {
      // Read only the tail of the file (last 64KB) instead of the entire log,
      // which can grow to multi-MB during long sessions. 64KB is more than
      // enough to capture the last 10 NDJSON lines.
      const TAIL_BYTES = 65536;
      const tail = readTailUtf8(logPath, TAIL_BYTES);
      const summaryLines = tail
        .split('\n')
        .filter((l) => l.trim())
        .slice(-10)
        .map(summarizeLine)
        .filter((l) => l.length > 0)
        .slice(-5);
      if (summaryLines.length > 0) {
        recentOut.push(`\n${sep}\n${MX.DIM}Recent output:${MX.R}\n`);
        for (const logLine of summaryLines) {
          const truncated =
            logLine.length > width - 2 ? logLine.slice(0, width - 5) + '…' : logLine;
          recentOut.push(`${MX.GREEN}  ${truncated}${MX.R}\n`);
        }
      }
    }
  } catch {
    /* ignore */
  }

  const footer = `\n${MX.DIM}Refreshing every 2s  •  Ctrl+C to detach${MX.R}\n`;

  if (tickets.length > 0) {
    const ticketHeader = `\n${sep}\n${MX.BRIGHT}Tickets:${MX.R}\n`;
    // The ticket section header consumes 3 rows (leading blank, separator,
    // "Tickets:" label). Size the body budget from the actual rendered
    // header/footer/recent row counts so dynamic sections (microverse,
    // circuit breaker, rate limit) shrink the window correctly.
    const headerRows = countRows(out);
    const recentRows = countRows(recentOut);
    const footerRows = countRows([footer]);
    const ticketHeaderRows = 3;
    const height = getHeight();
    const budget = Math.max(
      1,
      height - headerRows - recentRows - footerRows - ticketHeaderRows - 1
    );
    const ticketLines = buildTicketLines(tickets, state.current_ticket, budget);
    if (ticketLines.length > 0) {
      out.push(ticketHeader);
      out.push(...ticketLines);
    }
  }

  out.push(...recentOut);
  out.push(footer);
  await writeWithWatchdog(sink, out.join(''));
  return state.active === true;
}

async function main() {
  const sessionDir = process.argv[2];
  // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
  if (!sessionDir || sessionDir.startsWith('--') || !fs.existsSync(sessionDir)) {
    console.error('Usage: node monitor.js <session-dir>');
    process.exit(1);
  }

  process.on('SIGINT', () => {
    // AC-SSV-07: never block on stdout in the signal handler. If the pane
    // is wedged a synchronous write would prevent the exit. Try the
    // detach banner asynchronously, but exit unconditionally either way
    // so Ctrl-C always wins.
    try {
      process.stdout.write(`\x1b[2J\x1b[H${MX.DIM}Monitor detached.${MX.R}\n`, () => {
        process.exit(0);
      });
    } catch { /* fall through */ }
    setTimeout(() => process.exit(0), 50).unref();
  });

  // AC-SSV-07: render() awaits writeWithWatchdog internally, so a wedged
  // stdout surfaces here as a rejected promise rather than a blocked
  // iteration. We exit with status 2 + a clear stderr message instead of
  // joining the wedge — kill -9 should never be required.
  while (true) {
    let active: boolean;
    try {
      active = await render(sessionDir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[monitor] ${msg}\n`);
      process.exit(2);
    }
    if (!active) {
      await sleep(3000);
      let stillInactive: boolean;
      try {
        stillInactive = !(await render(sessionDir));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[monitor] ${msg}\n`);
        process.exit(2);
      }
      if (stillInactive && shouldMonitorExit(sessionDir, false)) {
        try {
          await writeWithWatchdog(process.stdout, `\n${MX.BRIGHT}◤ SESSION COMPLETE ◢${MX.R}\n`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[monitor] ${msg}\n`);
          process.exit(2);
        }
        break;
      }
    }
    await sleep(2000);
  }
}

if (process.argv[1] && path.basename(process.argv[1]) === 'monitor.js') {
  main().catch((err) => {
    const msg = safeErrorMessage(err);
    console.error(`${Style.RED}[monitor] ${msg}${Style.RESET}`);
    process.exit(1);
  });
}

#!/usr/bin/env node
/**
 * raw-morty.ts — Matrix-styled raw output stream from Morty workers.
 *
 * Parses stream-json NDJSON from tmux_iteration_N.log and emits the
 * FULL assistant text output (not summaries), plus styled tool calls.
 * This is the "you're watching the Morty think in real-time" pane.
 */
import * as fs from 'fs';
import * as path from 'path';
import { sleep, MatrixStyle, matrixSeparator, latestIterationLog, drainStreamJsonLines, RAIN_CHARS, safeErrorMessage } from '../services/pickle-utils.js';
import { StateManager } from '../services/state-manager.js';

const MX = {
  ...MatrixStyle,
  TOOL: MatrixStyle.CYAN, // alias for tool call styling
} as const;
const sm = new StateManager();

type RawMortyRuntime = {
  sessionDir: string;
  currentLog: string | null;
  offset: number;
  lineBuf: string;
  emit: (text: string) => void;
  sep: () => string;
};

function randomRainChar(): string {
  return RAIN_CHARS[Math.floor(Math.random() * RAIN_CHARS.length)];
}

function renderRainLine(width: number): string {
  const line: string[] = [];
  for (let i = 0; i < width; i++) {
    const r = Math.random();
    if (r < 0.15) {
      line.push(`${MX.BRIGHT}${randomRainChar()}${MX.R}`);
    } else if (r < 0.35) {
      line.push(`${MX.DIM}${randomRainChar()}${MX.R}`);
    } else {
      line.push(' ');
    }
  }
  return line.join('');
}

function matrixBanner(width: number): string {
  const lines: string[] = [];
  for (let i = 0; i < 3; i++) lines.push(renderRainLine(width));
  const title = '◤ RAW MORTY FEED ◢';
  const pad = Math.max(0, Math.floor((width - title.length) / 2));
  lines.push(`${MX.BRIGHT}${' '.repeat(pad)}${title}${MX.R}`);
  const sub = 'wake up, Morty...';
  const pad2 = Math.max(0, Math.floor((width - sub.length) / 2));
  lines.push(`${MX.DIM}${' '.repeat(pad2)}${sub}${MX.R}`);
  for (let i = 0; i < 2; i++) lines.push(renderRainLine(width));
  return lines.join('\n');
}

// ── Format tool call in Matrix style ────────────────────────────
function formatTool(name: string, input: Record<string, unknown>): string {
  let detail = '';
  switch (name) {
    case 'Bash': detail = typeof input.command === 'string' ? input.command : ''; break;
    case 'Edit':
    case 'Read':
    case 'Write': detail = typeof input.file_path === 'string' ? input.file_path : ''; break;
    case 'Glob': detail = typeof input.pattern === 'string' ? input.pattern : ''; break;
    case 'Grep': detail = typeof input.pattern === 'string' ? input.pattern : ''; break;
    case 'Agent':
    case 'Task': detail = typeof input.description === 'string' ? input.description : ''; break;
    default: break;
  }
  return detail ? `${MX.TOOL}⚡ ${name}${MX.DIM} → ${detail}${MX.R}` : `${MX.TOOL}⚡ ${name}${MX.R}`;
}

function formatAssistantMessage(parsed: Record<string, unknown>): string | null {
  const msg = parsed.message as Record<string, unknown> | undefined;
  if (!msg || !Array.isArray(msg.content)) return null;
  const parts: string[] = [];
  for (const block of msg.content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(`${MX.GREEN}${b.text}${MX.R}`);
    } else if (b.type === 'tool_use' && typeof b.name === 'string') {
      const input = (typeof b.input === 'object' && b.input !== null)
        ? b.input as Record<string, unknown> : {};
      parts.push(formatTool(b.name, input));
    }
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

function formatResultMessage(parsed: Record<string, unknown>): string {
  const subtype = typeof parsed.subtype === 'string' ? parsed.subtype : '';
  const isError = subtype.startsWith('error');
  const turns = typeof parsed.num_turns === 'number' ? parsed.num_turns : '?';
  const cost = typeof parsed.total_cost_usd === 'number'
    ? `$${(parsed.total_cost_usd as number).toFixed(2)}` : '$?';
  return isError
    ? `${MX.ERR}✖ ERROR: ${subtype} (${turns} turns, ${cost})${MX.R}`
    : `${MX.BRIGHT}✓ COMPLETE (${turns} turns, ${cost})${MX.R}`;
}

function formatSystemMessage(parsed: Record<string, unknown>): string | null {
  if (parsed.subtype !== 'init') return null;
  const model = typeof parsed.model === 'string' ? parsed.model : 'unknown';
  return `${MX.BRIGHT}▸ INIT ${MX.DIM}model=${model}${MX.R}`;
}

// ── Process a single stream-json line ───────────────────────────
export function processLineRaw(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return `${MX.DIM}${trimmed}${MX.R}`;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const type = parsed.type;

  if (type === 'assistant') {
    return formatAssistantMessage(parsed);
  }

  if (type === 'result') {
    return formatResultMessage(parsed);
  }

  if (type === 'system') {
    return formatSystemMessage(parsed);
  }

  return null;
}

// ── Main loop ───────────────────────────────────────────────────
function requireSessionDir(): string {
  const sessionDir = process.argv[2];
  // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
  if (!sessionDir || sessionDir.startsWith('--') || !fs.existsSync(sessionDir)) {
    console.error('Usage: node raw-morty.js <session-dir>');
    process.exit(1);
  }
  return sessionDir;
}

function installSignalHandlers(): void {
  process.on('SIGINT', () => {
    process.stdout.write(`\n${MX.DIM}Feed disconnected.${MX.R}\n`);
    process.exit(0);
  });
}

function renderStartupBanner(): () => string {
  const width = () => Math.min((process.stdout.columns || 60) - 2, 80);
  const sep = () => matrixSeparator(width());

  process.stdout.write('\x1b[2J\x1b[H');
  process.stdout.write(matrixBanner(width()) + '\n');
  process.stdout.write(sep() + '\n');
  return sep;
}

function isSessionActive(sessionDir: string): boolean {
  try {
    const state = sm.read(path.join(sessionDir, 'state.json'));
    return state.active === true;
  } catch {
    return true;
  }
}

function writeTerminationBanner(sep: () => string): void {
  process.stdout.write(`\n${sep()}\n${MX.BRIGHT}◤ FEED TERMINATED ◢${MX.R}\n`);
}

async function awaitNextLog(runtime: RawMortyRuntime): Promise<boolean> {
  if (!isSessionActive(runtime.sessionDir)) {
    writeTerminationBanner(runtime.sep);
    return false;
  }

  process.stdout.write(`\r${MX.DIM}Awaiting signal...${MX.R}\x1b[K`);
  await sleep(1000);
  return true;
}

function rotateIterationLog(runtime: RawMortyRuntime, log: string): void {
  if (log === runtime.currentLog) return;

  runtime.currentLog = log;
  runtime.offset = 0;
  runtime.lineBuf = '';
  const n = path.basename(log, '.log').replace('tmux_iteration_', '');
  process.stdout.write(`\n${runtime.sep()}\n${MX.BRIGHT}▸ ITERATION ${n}${MX.R}\n${runtime.sep()}\n`);
}

function drainCurrentLog(runtime: RawMortyRuntime): void {
  if (!runtime.currentLog) return;
  const result = drainStreamJsonLines(
    runtime.currentLog,
    runtime.offset,
    runtime.lineBuf,
    processLineRaw,
    runtime.emit,
  );
  runtime.offset = result.offset;
  runtime.lineBuf = result.lineBuf;
}

async function finishIfInactive(runtime: RawMortyRuntime): Promise<boolean> {
  if (isSessionActive(runtime.sessionDir)) return false;

  await sleep(2000);
  drainCurrentLog(runtime);
  writeTerminationBanner(runtime.sep);
  return true;
}

async function followRawMortyFeed(runtime: RawMortyRuntime): Promise<void> {
  while (true) {
    const log = latestIterationLog(runtime.sessionDir);
    if (!log) {
      if (await awaitNextLog(runtime)) continue;
      break;
    }

    rotateIterationLog(runtime, log);
    drainCurrentLog(runtime);
    if (await finishIfInactive(runtime)) break;
    await sleep(500);
  }
}

async function main() {
  const sessionDir = requireSessionDir();
  installSignalHandlers();
  const sep = renderStartupBanner();
  await followRawMortyFeed({
    sessionDir,
    currentLog: null,
    offset: 0,
    lineBuf: '',
    emit: (text: string) => process.stdout.write(text + '\n'),
    sep,
  });
}

if (process.argv[1] && path.basename(process.argv[1]) === 'raw-morty.js') {
  main().catch((err) => {
    const msg = safeErrorMessage(err);
    console.error(`${MX.ERR}[raw-morty] ${msg}${MX.R}`);
    process.exit(1);
  });
}

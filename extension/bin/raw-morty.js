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
};
const sm = new StateManager();
function randomRainChar() {
    return RAIN_CHARS[Math.floor(Math.random() * RAIN_CHARS.length)];
}
function renderRainLine(width) {
    const line = [];
    for (let i = 0; i < width; i++) {
        const r = Math.random();
        if (r < 0.15) {
            line.push(`${MX.BRIGHT}${randomRainChar()}${MX.R}`);
        }
        else if (r < 0.35) {
            line.push(`${MX.DIM}${randomRainChar()}${MX.R}`);
        }
        else {
            line.push(' ');
        }
    }
    return line.join('');
}
function matrixBanner(width) {
    const lines = [];
    for (let i = 0; i < 3; i++)
        lines.push(renderRainLine(width));
    const title = '◤ RAW MORTY FEED ◢';
    const pad = Math.max(0, Math.floor((width - title.length) / 2));
    lines.push(`${MX.BRIGHT}${' '.repeat(pad)}${title}${MX.R}`);
    const sub = 'wake up, Morty...';
    const pad2 = Math.max(0, Math.floor((width - sub.length) / 2));
    lines.push(`${MX.DIM}${' '.repeat(pad2)}${sub}${MX.R}`);
    for (let i = 0; i < 2; i++)
        lines.push(renderRainLine(width));
    return lines.join('\n');
}
// ── Format tool call in Matrix style ────────────────────────────
function formatTool(name, input) {
    let detail = '';
    switch (name) {
        case 'Bash':
            detail = typeof input.command === 'string' ? input.command : '';
            break;
        case 'Edit':
        case 'Read':
        case 'Write':
            detail = typeof input.file_path === 'string' ? input.file_path : '';
            break;
        case 'Glob':
            detail = typeof input.pattern === 'string' ? input.pattern : '';
            break;
        case 'Grep':
            detail = typeof input.pattern === 'string' ? input.pattern : '';
            break;
        case 'Agent':
        case 'Task':
            detail = typeof input.description === 'string' ? input.description : '';
            break;
        default: break;
    }
    return detail ? `${MX.TOOL}⚡ ${name}${MX.DIM} → ${detail}${MX.R}` : `${MX.TOOL}⚡ ${name}${MX.R}`;
}
// ── Process a single stream-json line ───────────────────────────
// eslint-disable-next-line complexity -- pre-existing — outside T0–T15 god-fn refactor scope; defer to follow-up epic
export function processLineRaw(line) {
    const trimmed = line.trim();
    if (!trimmed)
        return null;
    let parsed;
    try {
        parsed = JSON.parse(trimmed);
    }
    catch {
        return `${MX.DIM}${trimmed}${MX.R}`;
    }
    if (typeof parsed !== 'object' || parsed === null)
        return null;
    const type = parsed.type;
    if (type === 'assistant') {
        const msg = parsed.message;
        if (!msg || !Array.isArray(msg.content))
            return null;
        const parts = [];
        for (const block of msg.content) {
            if (typeof block !== 'object' || block === null)
                continue;
            const b = block;
            if (b.type === 'text' && typeof b.text === 'string') {
                parts.push(`${MX.GREEN}${b.text}${MX.R}`);
            }
            else if (b.type === 'tool_use' && typeof b.name === 'string') {
                const input = (typeof b.input === 'object' && b.input !== null)
                    ? b.input : {};
                parts.push(formatTool(b.name, input));
            }
        }
        return parts.length > 0 ? parts.join('\n') : null;
    }
    if (type === 'result') {
        const isError = typeof parsed.subtype === 'string' && parsed.subtype.startsWith('error');
        const turns = typeof parsed.num_turns === 'number' ? parsed.num_turns : '?';
        const cost = typeof parsed.total_cost_usd === 'number'
            ? `$${parsed.total_cost_usd.toFixed(2)}` : '$?';
        return isError
            ? `${MX.ERR}✖ ERROR: ${parsed.subtype} (${turns} turns, ${cost})${MX.R}`
            : `${MX.BRIGHT}✓ COMPLETE (${turns} turns, ${cost})${MX.R}`;
    }
    if (type === 'system') {
        if (parsed.subtype === 'init') {
            const model = typeof parsed.model === 'string' ? parsed.model : 'unknown';
            return `${MX.BRIGHT}▸ INIT ${MX.DIM}model=${model}${MX.R}`;
        }
        return null;
    }
    return null;
}
// ── Main loop ───────────────────────────────────────────────────
async function main() {
    const sessionDir = process.argv[2];
    // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
    if (!sessionDir || sessionDir.startsWith('--') || !fs.existsSync(sessionDir)) {
        console.error('Usage: node raw-morty.js <session-dir>');
        process.exit(1);
    }
    process.on('SIGINT', () => {
        process.stdout.write(`\n${MX.DIM}Feed disconnected.${MX.R}\n`);
        process.exit(0);
    });
    const width = () => Math.min((process.stdout.columns || 60) - 2, 80);
    const sep = () => matrixSeparator(width());
    process.stdout.write('\x1b[2J\x1b[H');
    process.stdout.write(matrixBanner(width()) + '\n');
    process.stdout.write(sep() + '\n');
    const emit = (text) => {
        process.stdout.write(text + '\n');
    };
    let currentLog = null;
    let offset = 0;
    let lineBuf = '';
    while (true) {
        const log = latestIterationLog(sessionDir);
        if (!log) {
            try {
                const state = sm.read(path.join(sessionDir, 'state.json'));
                if (state.active !== true) {
                    process.stdout.write(`\n${sep()}\n${MX.BRIGHT}◤ FEED TERMINATED ◢${MX.R}\n`);
                    break;
                }
            }
            catch { /* */ }
            process.stdout.write(`\r${MX.DIM}Awaiting signal...${MX.R}\x1b[K`);
            await sleep(1000);
            continue;
        }
        if (log !== currentLog) {
            currentLog = log;
            offset = 0;
            lineBuf = '';
            const n = path.basename(log, '.log').replace('tmux_iteration_', '');
            process.stdout.write(`\n${sep()}\n${MX.BRIGHT}▸ ITERATION ${n}${MX.R}\n${sep()}\n`);
        }
        const result = drainStreamJsonLines(currentLog, offset, lineBuf, processLineRaw, emit);
        offset = result.offset;
        lineBuf = result.lineBuf;
        try {
            const state = sm.read(path.join(sessionDir, 'state.json'));
            if (state.active !== true) {
                await sleep(2000);
                drainStreamJsonLines(currentLog, offset, lineBuf, processLineRaw, emit);
                process.stdout.write(`\n${sep()}\n${MX.BRIGHT}◤ FEED TERMINATED ◢${MX.R}\n`);
                break;
            }
        }
        catch { /* */ }
        await sleep(500);
    }
}
if (process.argv[1] && path.basename(process.argv[1]) === 'raw-morty.js') {
    main().catch((err) => {
        const msg = safeErrorMessage(err);
        console.error(`${MX.ERR}[raw-morty] ${msg}${MX.R}`);
        process.exit(1);
    });
}

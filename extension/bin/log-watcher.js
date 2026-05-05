#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { Style, sleep, MatrixStyle, matrixSeparator, latestIterationLog, drainStreamJsonLines, safeErrorMessage } from '../services/pickle-utils.js';
import { StateManager } from '../services/state-manager.js';
const sm = new StateManager();
/**
 * Extracts the most informative parameter from a tool_use input object.
 */
export function formatToolUse(name, input) {
    switch (name) {
        case 'Bash': return typeof input.command === 'string' ? input.command : name;
        case 'Edit':
        case 'Read':
        case 'Write': return typeof input.file_path === 'string' ? input.file_path : name;
        case 'Glob': return typeof input.pattern === 'string' ? input.pattern : name;
        case 'Grep': return typeof input.pattern === 'string' ? input.pattern : name;
        case 'Task':
        case 'Agent': return typeof input.description === 'string' ? input.description : name;
        default: return name;
    }
}
/**
 * Processes a single line from a stream-json log.
 * Returns a human-readable string or null to skip.
 */
export function processLine(line) {
    const trimmed = line.trim();
    if (!trimmed)
        return null;
    let parsed;
    try {
        parsed = JSON.parse(trimmed);
    }
    catch {
        // Not JSON — display as-is (backward compat with non-stream-json output)
        return trimmed;
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
                parts.push(b.text);
            }
            else if (b.type === 'tool_use' && typeof b.name === 'string') {
                const input = (typeof b.input === 'object' && b.input !== null)
                    ? b.input
                    : {};
                parts.push(`🔧 ${b.name}: ${formatToolUse(b.name, input)}`);
            }
        }
        return parts.length > 0 ? parts.join('\n') : null;
    }
    if (type === 'result') {
        const isError = typeof parsed.subtype === 'string' && parsed.subtype.startsWith('error');
        const turns = typeof parsed.num_turns === 'number' ? parsed.num_turns : '?';
        const cost = typeof parsed.total_cost_usd === 'number'
            ? `$${parsed.total_cost_usd.toFixed(2)}`
            : '$?';
        return isError
            ? `❌ Session ${parsed.subtype} (${turns} turns, ${cost})`
            : `✅ Session success (${turns} turns, ${cost})`;
    }
    if (type === 'system') {
        const subtype = parsed.subtype;
        if (subtype === 'init') {
            const model = typeof parsed.model === 'string' ? parsed.model : 'unknown';
            return `🚀 Session started (model: ${model})`;
        }
        return null;
    }
    // Unknown type — skip
    return null;
}
async function main() {
    const sessionDir = process.argv[2];
    // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
    if (!sessionDir || sessionDir.startsWith('--') || !fs.existsSync(sessionDir)) {
        console.error('Usage: node log-watcher.js <session-dir>');
        process.exit(1);
    }
    process.on('SIGINT', () => {
        process.stdout.write('\nDetached.\n');
        process.exit(0);
    });
    const MX = MatrixStyle;
    const width = () => Math.min((process.stdout.columns || 60) - 2, 60);
    const sep = () => matrixSeparator(width());
    const emit = (text) => {
        for (const line of text.split('\n')) {
            const truncated = line.length > width() ? line.slice(0, width() - 3) + '…' : line;
            process.stdout.write(`${MX.GREEN}${truncated}${MX.R}\n`);
        }
    };
    process.stdout.write(`\n${MX.BRIGHT}◤ LOG STREAM ◢${MX.R}\n${sep()}\n`);
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
            catch { /* ignore */ }
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
        const result = drainStreamJsonLines(currentLog, offset, lineBuf, processLine, emit);
        offset = result.offset;
        lineBuf = result.lineBuf;
        try {
            const state = sm.read(path.join(sessionDir, 'state.json'));
            if (state.active !== true) {
                await sleep(2000);
                drainStreamJsonLines(currentLog, offset, lineBuf, processLine, emit);
                process.stdout.write(`\n${sep()}\n${MX.BRIGHT}◤ FEED TERMINATED ◢${MX.R}\n`);
                break;
            }
        }
        catch {
            /* ignore */
        }
        await sleep(500);
    }
}
if (process.argv[1] && path.basename(process.argv[1]) === 'log-watcher.js') {
    main().catch((err) => {
        const msg = safeErrorMessage(err);
        console.error(`${Style.RED}[log-watcher] ${msg}${Style.RESET}`);
        process.exit(1);
    });
}

import * as fs from 'fs';
import * as path from 'path';
import { resolveStateFile, loadActiveState, approve } from '../resolve-state.js';
import { getExtensionRoot, getDataRoot, extractFrontmatter, parseTicketFrontmatter } from '../../services/pickle-utils.js';
import { readRecoverableJsonObject } from '../../services/microverse-state.js';
import { BACKENDS } from '../../types/index.js';
const PROTECTED_PATTERNS = [
    /^\.eslintrc(\..*)?$/,
    /^\.prettierrc(\..*)?$/,
    /^biome\.json$/,
    /^tsconfig(\..*)?\.json$/,
    /^pyproject\.toml$/,
    /^\.ruff\.toml$/,
    /^jest\.config\./,
    /^vitest\.config\./,
];
function isProtectedFile(filePath) {
    const base = path.basename(filePath);
    return PROTECTED_PATTERNS.some(p => p.test(base));
}
function isBashTargetingConfig(command) {
    // Extract space/quote-separated tokens and test each as a potential filename
    const tokens = command.split(/[\s'"]+/).filter(t => t.length > 0);
    return tokens.some(token => isProtectedFile(token));
}
function hasConfigChangeOverride(sessionDir, state) {
    try {
        if (!state.current_ticket)
            return false;
        const ticketDir = path.join(sessionDir, state.current_ticket);
        const files = fs.readdirSync(ticketDir);
        const ticketFile = files.find(f => f.startsWith('linear_ticket_') && f.endsWith('.md'));
        if (!ticketFile)
            return false;
        const content = fs.readFileSync(path.join(ticketDir, ticketFile), 'utf8');
        const fm = extractFrontmatter(content);
        if (!fm)
            return false;
        return /^config_change:\s*true$/m.test(fm.body);
    }
    catch {
        return false;
    }
}
function block(reason) {
    console.log(JSON.stringify({ decision: 'block', reason }));
}
function readInputData() {
    try {
        return fs.readFileSync(0, 'utf8');
    }
    catch {
        return null;
    }
}
function parseInput(inputData) {
    if (!inputData.trim())
        return null;
    try {
        return JSON.parse(inputData);
    }
    catch {
        return null;
    }
}
function isConfigProtectionDisabled(extensionDir) {
    try {
        const flagSettings = readRecoverableJsonObject(path.join(extensionDir, 'pickle_settings.json'));
        return flagSettings?.enable_config_protection === false;
    }
    catch { /* default true — continue with protection enabled */ }
    return false;
}
function getConfigProtectionRoot() {
    return process.env.EXTENSION_DIR || getExtensionRoot();
}
function loadSessionState() {
    const stateFile = resolveStateFile(getDataRoot());
    if (!stateFile)
        return null;
    const state = loadActiveState(stateFile);
    if (!state)
        return null;
    return { stateFile, state };
}
function targetedConfigFile(input) {
    const toolName = input.tool_name || '';
    const filePath = input.tool_input?.file_path || '';
    const command = input.tool_input?.command || '';
    if ((toolName === 'Write' || toolName === 'Edit') && filePath) {
        return isProtectedFile(filePath) ? path.basename(filePath) : null;
    }
    if (toolName === 'Bash' && command) {
        return isBashTargetingConfig(command) ? '<config file>' : null;
    }
    return null;
}
function resolveHookPrecheckBackend(state) {
    if (typeof state.backend === 'string' && BACKENDS.includes(state.backend)) {
        return state.backend;
    }
    const envBackend = process.env.PICKLE_BACKEND;
    if (typeof envBackend === 'string' && BACKENDS.includes(envBackend)) {
        return envBackend;
    }
    return 'claude';
}
function supportsHookPrecheck(backend) {
    return backend === 'claude';
}
function isWorkerSpawnPrecheck(input) {
    return input.tool_name === 'Bash'
        && typeof input.tool_input?.command === 'string'
        && /\bspawn-morty\.js\b/.test(input.tool_input.command);
}
function currentTicketFile(sessionDir, ticketId) {
    try {
        const ticketDir = path.join(sessionDir, ticketId);
        const files = fs.readdirSync(ticketDir);
        const ticketFile = files.find(f => f.startsWith('linear_ticket_') && f.endsWith('.md'));
        return ticketFile ? path.join(ticketDir, ticketFile) : null;
    }
    catch {
        return null;
    }
}
function codexRequiredWorkerBlockReason(sessionDir, state) {
    const backend = resolveHookPrecheckBackend(state);
    if (!supportsHookPrecheck(backend))
        return null;
    if (!state.current_ticket)
        return null;
    const ticketFile = currentTicketFile(sessionDir, state.current_ticket);
    if (!ticketFile)
        return null;
    const ticket = parseTicketFrontmatter(ticketFile);
    if (!ticket?.codex_required)
        return null;
    return `Ticket ${state.current_ticket} requires codex; current hook precheck backend is ${backend}. Run with --backend codex.`;
}
async function main() {
    const extensionDir = getConfigProtectionRoot();
    const inputData = readInputData();
    if (inputData === null) {
        approve();
        return;
    }
    const input = parseInput(inputData);
    if (!input || isConfigProtectionDisabled(extensionDir)) {
        approve();
        return;
    }
    const session = loadSessionState();
    if (!session) {
        approve();
        return;
    }
    const configFile = targetedConfigFile(input);
    if (!configFile || hasConfigChangeOverride(path.dirname(session.stateFile), session.state)) {
        if (isWorkerSpawnPrecheck(input)) {
            const reason = codexRequiredWorkerBlockReason(path.dirname(session.stateFile), session.state);
            if (reason)
                block(reason);
            else
                approve();
            return;
        }
        approve();
        return;
    }
    block(`Config file protected: ${configFile}. Set config_change: true in ticket frontmatter to override.`);
}
main().catch((err) => {
    try {
        const msg = err instanceof Error ? err.message : String(err);
        const extensionDir = getExtensionRoot();
        fs.appendFileSync(path.join(extensionDir, 'debug.log'), `[config-protection] FATAL: ${msg}\n`);
    }
    catch {
        /* ignore */
    }
    approve();
});

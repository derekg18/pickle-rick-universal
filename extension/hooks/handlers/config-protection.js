import * as fs from 'fs';
import * as path from 'path';
import { resolveStateFile, loadActiveState, approve } from '../resolve-state.js';
import { getExtensionRoot, getDataRoot, extractFrontmatter } from '../../services/pickle-utils.js';
import { readRecoverableJsonObject } from '../../services/microverse-state.js';
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
// eslint-disable-next-line complexity -- pre-existing — outside T0–T15 god-fn refactor scope; defer to follow-up epic
async function main() {
    const extensionDir = getExtensionRoot();
    let inputData;
    try {
        // eslint-disable-next-line pickle/no-sync-in-async -- stdin read (fd 0) has no async alternative
        inputData = fs.readFileSync(0, 'utf8');
    }
    catch {
        approve();
        return;
    }
    if (!inputData.trim()) {
        approve();
        return;
    }
    let input;
    try {
        input = JSON.parse(inputData);
    }
    catch {
        approve();
        return;
    }
    // Feature flag: enable_config_protection (default true — missing flag = enabled)
    try {
        const flagSettings = readRecoverableJsonObject(path.join(extensionDir, 'pickle_settings.json'));
        if (flagSettings?.enable_config_protection === false) {
            approve();
            return;
        }
    }
    catch { /* default true — continue with protection enabled */ }
    // Activation guard: only active during automated sessions
    const stateFile = resolveStateFile(getDataRoot());
    if (!stateFile) {
        approve();
        return;
    }
    const state = loadActiveState(stateFile);
    if (!state) {
        approve();
        return;
    }
    const toolName = input.tool_name || '';
    const filePath = input.tool_input?.file_path || '';
    const command = input.tool_input?.command || '';
    let targetedConfigFile = null;
    if ((toolName === 'Write' || toolName === 'Edit') && filePath) {
        if (isProtectedFile(filePath)) {
            targetedConfigFile = path.basename(filePath);
        }
    }
    else if (toolName === 'Bash' && command) {
        if (isBashTargetingConfig(command)) {
            targetedConfigFile = '<config file>';
        }
    }
    if (!targetedConfigFile) {
        approve();
        return;
    }
    // Check per-ticket override
    if (hasConfigChangeOverride(path.dirname(stateFile), state)) {
        approve();
        return;
    }
    block(`Config file protected: ${targetedConfigFile}. Set config_change: true in ticket frontmatter to override.`);
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

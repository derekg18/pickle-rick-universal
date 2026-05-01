import * as fs from 'fs';
import * as path from 'path';
import { Defaults } from '../types/index.js';
import { safeErrorMessage } from './pickle-utils.js';
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function statePathsForBundle(sessionDir) {
    const statePaths = [path.join(sessionDir, 'state.json')];
    let entries;
    try {
        entries = fs.readdirSync(sessionDir, { withFileTypes: true });
    }
    catch {
        return statePaths;
    }
    for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith('microverse_'))
            continue;
        const childStatePath = path.join(sessionDir, entry.name, 'state.json');
        if (fs.existsSync(childStatePath))
            statePaths.push(childStatePath);
    }
    return statePaths;
}
function readCount(statePath) {
    const raw = fs.readFileSync(statePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed))
        return null;
    const value = parsed.codex_manager_relaunch_count;
    if (value === undefined || value === null)
        return 0;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
export function auditCodexManagerRelaunchCaps(sessionDir) {
    const cap = Defaults.CODEX_MANAGER_RELAUNCH_CAP;
    const checkedStatePaths = statePathsForBundle(sessionDir);
    const violations = [];
    for (const statePath of checkedStatePaths) {
        try {
            const count = readCount(statePath);
            if (count === null) {
                violations.push({
                    statePath,
                    count,
                    cap,
                    reason: 'state file is not an object or has a non-numeric codex_manager_relaunch_count',
                });
            }
            else if (count > cap) {
                violations.push({
                    statePath,
                    count,
                    cap,
                    reason: `codex_manager_relaunch_count ${count} exceeds cap ${cap}`,
                });
            }
        }
        catch (err) {
            violations.push({
                statePath,
                count: null,
                cap,
                reason: `state file is unreadable: ${safeErrorMessage(err)}`,
            });
        }
    }
    return { cap, checkedStatePaths, violations };
}

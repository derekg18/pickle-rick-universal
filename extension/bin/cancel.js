#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { printMinimalPanel, getDataRoot, withRetryLock, findSessionPathForCwd, safeErrorMessage } from '../services/pickle-utils.js';
import { StateManager } from '../services/state-manager.js';
import { LockError } from '../types/index.js';
import { readRecoverableJsonObject } from '../services/recoverable-json.js';
const sm = new StateManager();
export function cancelSession(cwd) {
    const SESSIONS_MAP = path.join(getDataRoot(), 'current_sessions.json');
    const sessionPath = findSessionPathForCwd(cwd);
    if (!sessionPath || !fs.existsSync(sessionPath)) {
        console.log('No active session found for this directory.');
        return;
    }
    const statePath = path.join(sessionPath, 'state.json');
    if (!fs.existsSync(statePath)) {
        console.log('State file not found.');
        return;
    }
    try {
        if (sm.read(statePath).active !== true) {
            console.log('No active session found for this directory.');
            return;
        }
    }
    catch {
        console.log('State file is unreadable.');
        return;
    }
    // Deactivate state AND remove map entry inside one lock to prevent inconsistent state
    // if the process crashes between the two operations.
    let cancelled = false;
    try {
        withRetryLock(SESSIONS_MAP + '.lock', () => {
            // Deactivate state.json
            try {
                sm.update(statePath, s => { s.active = false; });
            }
            catch {
                console.log('State file is unreadable.');
                return;
            }
            cancelled = true;
            // Remove stale entry from the sessions map
            let freshMap = {};
            try {
                freshMap = (readRecoverableJsonObject(SESSIONS_MAP) || {});
            }
            catch { /* ignore */ }
            delete freshMap[cwd];
            const tmpMap = SESSIONS_MAP + `.tmp.${process.pid}`;
            try {
                fs.writeFileSync(tmpMap, JSON.stringify(freshMap, null, 2));
                fs.renameSync(tmpMap, SESSIONS_MAP);
            }
            catch (writeErr) {
                try {
                    fs.unlinkSync(tmpMap);
                }
                catch { /* ignore cleanup failure */ }
                throw writeErr;
            }
        });
    }
    catch (err) {
        if (err instanceof LockError) {
            // Lock exhausted — deactivate state without map consistency guarantee
            console.error(`[pickle] WARNING: session map not updated — ${safeErrorMessage(err)}`);
            try {
                sm.update(statePath, s => { s.active = false; });
                cancelled = true;
            }
            catch { /* session already deactivated or unreadable */ }
        }
        else {
            throw err;
        }
    }
    if (cancelled) {
        printMinimalPanel('Loop Cancelled', {
            Session: path.basename(sessionPath),
            Status: 'Inactive',
        }, 'RED', '🛑');
    }
    else {
        console.log('Failed to cancel session — state file unreadable.');
    }
}
if (process.argv[1] && path.basename(process.argv[1]) === 'cancel.js') {
    cancelSession(process.cwd());
}

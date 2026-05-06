#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { printMinimalPanel, getDataRoot, withRetryLock, findSessionPathForCwd, safeErrorMessage } from '../services/pickle-utils.js';
import { StateManager } from '../services/state-manager.js';
import { LockError } from '../types/index.js';
import { readRecoverableJsonObject } from '../services/recoverable-json.js';
const sm = new StateManager();
function deactivateSessionState(statePath) {
    try {
        sm.update(statePath, s => { s.active = false; });
        return true;
    }
    catch {
        console.log('State file is unreadable.');
        return false;
    }
}
function removeSessionMapEntry(sessionsMapPath, cwd) {
    let freshMap = {};
    try {
        freshMap = (readRecoverableJsonObject(sessionsMapPath) || {});
    }
    catch { /* ignore */ }
    delete freshMap[cwd];
    const tmpMap = sessionsMapPath + `.tmp.${process.pid}`;
    try {
        fs.writeFileSync(tmpMap, JSON.stringify(freshMap, null, 2));
        fs.renameSync(tmpMap, sessionsMapPath);
    }
    catch (writeErr) {
        try {
            fs.unlinkSync(tmpMap);
        }
        catch { /* ignore cleanup failure */ }
        throw writeErr;
    }
}
function cancelWithSessionMapLock(sessionsMapPath, statePath, cwd) {
    let cancelled = false;
    withRetryLock(sessionsMapPath + '.lock', () => {
        cancelled = deactivateSessionState(statePath);
        if (!cancelled)
            return;
        removeSessionMapEntry(sessionsMapPath, cwd);
    });
    return cancelled;
}
function cancelWithoutSessionMapConsistency(statePath, err) {
    console.error(`[pickle] WARNING: session map not updated — ${safeErrorMessage(err)}`);
    try {
        sm.update(statePath, s => { s.active = false; });
        return true;
    }
    catch {
        return false;
    }
}
function printCancelOutcome(cancelled, sessionPath) {
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
    let cancelled = false;
    try {
        cancelled = cancelWithSessionMapLock(SESSIONS_MAP, statePath, cwd);
    }
    catch (err) {
        if (err instanceof LockError) {
            cancelled = cancelWithoutSessionMapConsistency(statePath, err);
        }
        else {
            throw err;
        }
    }
    printCancelOutcome(cancelled, sessionPath);
}
if (process.argv[1] && path.basename(process.argv[1]) === 'cancel.js') {
    cancelSession(process.cwd());
}

import * as fs from 'fs';
import * as path from 'path';
import { resolveSessionPath } from '../services/pickle-utils.js';
import { readRecoverableJsonObject } from '../services/recoverable-json.js';
import { StateManager } from '../services/state-manager.js';
const ALLOW = JSON.stringify({ decision: 'approve' });
const sm = new StateManager();
function sameWorkingDir(a, b) {
    return typeof a === 'string' && path.resolve(a) === path.resolve(b);
}
const MAX_FUTURE_RECENCY_DRIFT_MS = 5 * 60 * 1000;
function readLookupState(stateFile) {
    try {
        let stateMtimeMs = 0;
        try {
            stateMtimeMs = fs.statSync(stateFile).mtimeMs;
        }
        catch { /* sm.read below handles missing file */ }
        const state = sm.read(stateFile);
        return {
            active: state.active,
            working_dir: state.working_dir,
            started_at: state.started_at,
            state_mtime_ms: stateMtimeMs,
        };
    }
    catch {
        return null;
    }
}
function getStateFileRecencyMs(state) {
    if (typeof state.started_at === 'string') {
        const startedAtMs = new Date(state.started_at).getTime();
        const maxTrustedFutureMs = Date.now() + MAX_FUTURE_RECENCY_DRIFT_MS;
        if (Number.isFinite(startedAtMs) && startedAtMs <= maxTrustedFutureMs) {
            return startedAtMs;
        }
    }
    return state.state_mtime_ms ?? 0;
}
function preferNewerStateFile(best, candidate) {
    if (!best)
        return candidate;
    if (candidate.recencyMs !== best.recencyMs) {
        return candidate.recencyMs > best.recencyMs ? candidate : best;
    }
    return candidate.stateFile.localeCompare(best.stateFile) > 0 ? candidate : best;
}
function resolveMatchingStateFile(stateFile, cwd) {
    if (!fs.existsSync(stateFile))
        return null;
    const state = readLookupState(stateFile);
    if (!state || !sameWorkingDir(state.working_dir, cwd))
        return null;
    return { stateFile, active: state.active };
}
export function selectScannedStateFile(stateFiles, cwd) {
    let activeMatch = null;
    let inactiveMatch = null;
    for (const stateFile of stateFiles) {
        const state = readLookupState(stateFile);
        if (!state || !sameWorkingDir(state.working_dir, cwd))
            continue;
        const candidate = {
            stateFile,
            recencyMs: getStateFileRecencyMs(state),
        };
        if (state.active === true) {
            activeMatch = preferNewerStateFile(activeMatch, candidate);
            continue;
        }
        inactiveMatch = preferNewerStateFile(inactiveMatch, candidate);
    }
    return activeMatch?.stateFile ?? inactiveMatch?.stateFile ?? null;
}
function resolveStateFileFromSessionsDir(dataDir) {
    const sessionsDir = path.join(dataDir, 'sessions');
    let entries;
    try {
        entries = fs.readdirSync(sessionsDir);
    }
    catch {
        return null;
    }
    return selectScannedStateFile(entries.map((entry) => path.join(sessionsDir, entry, 'state.json')), process.cwd());
}
/**
 * Resolves the state file path from env or the sessions map.
 * `dataDir` is where current_sessions.json lives (pickle data root, not the
 * extension install dir). Returns null if no matching state file is found.
 */
export function resolveStateFile(dataDir) {
    const cwd = process.cwd();
    let fallbackStateFile = null;
    const envStateFile = process.env.PICKLE_STATE_FILE;
    if (envStateFile) {
        const envMatch = resolveMatchingStateFile(envStateFile, cwd);
        if (envMatch) {
            if (envMatch.active === true)
                return envMatch.stateFile;
            fallbackStateFile = envMatch.stateFile;
        }
    }
    const sessionsMapPath = path.join(dataDir, 'current_sessions.json');
    try {
        const map = readRecoverableJsonObject(sessionsMapPath);
        if (map) {
            const sessionPath = resolveSessionPath(map[cwd]);
            if (sessionPath) {
                const mappedStateFile = path.join(sessionPath, 'state.json');
                const mappedMatch = resolveMatchingStateFile(mappedStateFile, cwd);
                if (mappedMatch) {
                    if (mappedMatch.active === true)
                        return mappedMatch.stateFile;
                    if (!fallbackStateFile)
                        fallbackStateFile = mappedMatch.stateFile;
                }
            }
        }
    }
    catch {
        /* corrupt sessions map — fall through to state scan below */
    }
    const scannedStateFile = resolveStateFileFromSessionsDir(dataDir);
    if (scannedStateFile)
        return scannedStateFile;
    return fallbackStateFile;
}
/**
 * Loads state from a state file, returning null if the session is
 * inactive or the working directory doesn't match the current cwd.
 */
export function loadActiveState(stateFile) {
    try {
        const state = sm.read(stateFile);
        if (state.working_dir != null && state.working_dir !== '' && path.resolve(state.working_dir) !== path.resolve(process.cwd())) {
            return null;
        }
        if (state.active !== true)
            return null;
        return state;
    }
    catch {
        return null;
    }
}
/** Prints the "approve" decision to stdout. */
export function approve() {
    console.log(ALLOW);
}

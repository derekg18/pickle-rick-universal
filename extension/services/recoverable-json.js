import * as fs from 'fs';
import * as path from 'path';
function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function parseJsonObjectFile(filePath) {
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    }
    catch {
        return null;
    }
}
function listEntries(dir) {
    try {
        return fs.readdirSync(dir);
    }
    catch {
        return null;
    }
}
function parseDeadTmp(tmpPath, baseMtimeMs) {
    const parsed = parseJsonObjectFile(tmpPath);
    if (!parsed) {
        try {
            fs.unlinkSync(tmpPath);
        }
        catch { /* ignore invalid tmp cleanup failure */ }
        return null;
    }
    let mtimeMs;
    try {
        mtimeMs = fs.statSync(tmpPath).mtimeMs;
    }
    catch {
        return null;
    }
    if (mtimeMs <= baseMtimeMs) {
        try {
            fs.unlinkSync(tmpPath);
        }
        catch { /* ignore stale tmp cleanup failure */ }
        return null;
    }
    return { parsed, mtimeMs };
}
export function readRecoverableJsonObject(filePath) {
    const base = parseJsonObjectFile(filePath);
    const dir = path.dirname(filePath);
    const baseName = path.basename(filePath);
    const entries = listEntries(dir);
    if (!entries)
        return base;
    const tmpPattern = new RegExp(`^${baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.tmp\\.(\\d+)(?:\\..+)?$`);
    let baseMtimeMs;
    try {
        baseMtimeMs = fs.existsSync(filePath) ? fs.statSync(filePath).mtimeMs : 0;
    }
    catch {
        baseMtimeMs = 0;
    }
    let winner = null;
    for (const entry of entries) {
        const match = entry.match(tmpPattern);
        if (!match)
            continue;
        const tmpPid = Number(match[1]);
        if (Number.isFinite(tmpPid) && isProcessAlive(tmpPid))
            continue;
        const tmpPath = path.join(dir, entry);
        const candidate = parseDeadTmp(tmpPath, baseMtimeMs);
        if (candidate && (!winner || candidate.mtimeMs > winner.mtimeMs)) {
            winner = { tmpPath, ...candidate };
        }
    }
    if (!winner)
        return base;
    try {
        fs.renameSync(winner.tmpPath, filePath);
        return winner.parsed;
    }
    catch {
        return base;
    }
}

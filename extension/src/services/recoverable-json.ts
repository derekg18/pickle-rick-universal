import * as fs from 'fs';
import * as path from 'path';

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseJsonObjectFile(filePath: string): object | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function listEntries(dir: string): string[] | null {
  try {
    return fs.readdirSync(dir);
  } catch {
    return null;
  }
}

function parseDeadTmp(
  tmpPath: string,
  baseMtimeMs: number,
): { parsed: object; mtimeMs: number } | null {
  const parsed = parseJsonObjectFile(tmpPath);
  if (!parsed) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore invalid tmp cleanup failure */ }
    return null;
  }
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(tmpPath).mtimeMs;
  } catch {
    return null;
  }
  if (mtimeMs <= baseMtimeMs) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore stale tmp cleanup failure */ }
    return null;
  }
  return { parsed, mtimeMs };
}

export function readRecoverableJsonObject(filePath: string): object | null {
  const base = parseJsonObjectFile(filePath);
  const dir = path.dirname(filePath);
  const baseName = path.basename(filePath);
  const entries = listEntries(dir);
  if (!entries) return base;

  const tmpPattern = new RegExp(`^${baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.tmp\\.(\\d+)(?:\\..+)?$`);
  let baseMtimeMs: number;
  try {
    baseMtimeMs = fs.existsSync(filePath) ? fs.statSync(filePath).mtimeMs : 0;
  } catch {
    baseMtimeMs = 0;
  }
  let winner: { tmpPath: string; parsed: object; mtimeMs: number } | null = null;

  for (const entry of entries) {
    const match = entry.match(tmpPattern);
    if (!match) continue;
    const tmpPid = Number(match[1]);
    if (Number.isFinite(tmpPid) && isProcessAlive(tmpPid)) continue;

    const tmpPath = path.join(dir, entry);
    const candidate = parseDeadTmp(tmpPath, baseMtimeMs);
    if (candidate && (!winner || candidate.mtimeMs > winner.mtimeMs)) {
      winner = { tmpPath, ...candidate };
    }
  }

  if (!winner) return base;
  try {
    fs.renameSync(winner.tmpPath, filePath);
    return winner.parsed;
  } catch {
    return base;
  }
}

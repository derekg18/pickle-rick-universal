import * as fs from 'fs';
import * as path from 'path';
import { ActivityEvent, ActivityEventType } from '../types/index.js';
import { formatLocalDateKey, getDataRoot, safeErrorMessage } from './pickle-utils.js';

export function getActivityDir(): string {
  return path.join(getDataRoot(), 'activity');
}

const MAX_BUFFER = 100;
interface PendingActivityEntry {
  filepath: string;
  line: string;
}

const pendingBuffer: PendingActivityEntry[] = [];

// Configurable retry delay — override in tests via _setRetryDelayMs(0)
let retryDelayMs = 500;

// Shared buffer for Atomics.wait()-based synchronous sleep (no CPU spin).
const _sleepBuf = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(_sleepBuf, 0, 0, ms);
}

/** Exported for tests only. */
export function _setRetryDelayMs(ms: number): void { retryDelayMs = ms; }
export function _getPendingBuffer(): PendingActivityEntry[] { return pendingBuffer; }
export function _clearPendingBuffer(): void { pendingBuffer.splice(0); }

function getActivityFilepath(activityDir: string, ts: string): string {
  const parsed = new Date(ts);
  const date = Number.isFinite(parsed.getTime())
    ? formatLocalDateKey(parsed)
    : formatLocalDateKey(new Date());
  return path.join(activityDir, `${date}.jsonl`);
}

export function logActivity(
  event: Partial<ActivityEvent> & { event: ActivityEventType; source: ActivityEvent['source'] }
): void {
  try {
    const activityDir = getActivityDir();
    fs.mkdirSync(activityDir, { recursive: true });
    const fullEvent: ActivityEvent = { ts: new Date().toISOString(), ...event };
    const filepath = getActivityFilepath(activityDir, fullEvent.ts);
    const line = JSON.stringify(fullEvent) + '\n';

    // Attempt primary write; retry once after retryDelayMs on failure
    let writeErr: Error | null = null;
    try {
      // mode only applies on file creation (ignored if file exists) — first write = 0o600
      fs.appendFileSync(filepath, line, { mode: 0o600 });
    } catch {
      sleepSync(retryDelayMs);
      try {
        fs.appendFileSync(filepath, line, { mode: 0o600 });
      } catch (retryErr) {
        writeErr = retryErr instanceof Error ? retryErr : new Error(String(retryErr));
      }
    }

    if (writeErr) {
      // Buffer event (capped at MAX_BUFFER) for flush on next success
      if (pendingBuffer.length < MAX_BUFFER) {
        pendingBuffer.push({ filepath, line });
      }
      process.stderr.write(`[activity-logger] Failed to log event (buffered ${pendingBuffer.length}/${MAX_BUFFER}): ${writeErr.message}\n`);
      return;
    }

    // Flush buffered events on success
    if (pendingBuffer.length > 0) {
      const toFlush = pendingBuffer.splice(0);
      const byPath = new Map<string, PendingActivityEntry[]>();
      for (const entry of toFlush) {
        const list = byPath.get(entry.filepath) || [];
        list.push(entry);
        byPath.set(entry.filepath, list);
      }
      for (const [flushPath, entries] of byPath) {
        try {
          fs.appendFileSync(flushPath, entries.map((entry) => entry.line).join(''), { mode: 0o600 });
        } catch {
          for (const entry of entries) {
            if (pendingBuffer.length < MAX_BUFFER) {
              pendingBuffer.push(entry);
            }
          }
        }
      }
    }
  } catch (err) {
    // Activity logging must never break the caller, but warn so data loss is visible
    const msg = safeErrorMessage(err);
    process.stderr.write(`[activity-logger] Failed to log event: ${msg}\n`);
  }
}

const DATE_JSONL_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

/**
 * Deletes JSONL activity files older than maxAgeDays by filename date.
 * Handles ENOENT race (concurrent sessions may delete the same file).
 */
export function pruneActivity(maxAgeDays = 365): number {
  const activityDir = getActivityDir();
  if (!fs.existsSync(activityDir)) return 0;

  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const cutoffMs = now.getTime() - maxAgeDays * 86_400_000;

  let deleted = 0;
  for (const entry of fs.readdirSync(activityDir)) {
    if (!DATE_JSONL_RE.test(entry)) continue;
    const dateStr = path.basename(entry, '.jsonl');
    const fileMs = new Date(dateStr + 'T00:00:00').getTime();
    if (!Number.isFinite(fileMs)) continue;
    if (fileMs >= cutoffMs) continue;
    try {
      fs.unlinkSync(path.join(activityDir, entry));
      deleted++;
    } catch (err) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
  }
  return deleted;
}

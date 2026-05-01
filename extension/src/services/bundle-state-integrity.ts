import * as fs from 'fs';
import * as path from 'path';
import { Defaults } from '../types/index.js';
import { safeErrorMessage } from './pickle-utils.js';

export interface RelaunchCapAuditViolation {
  statePath: string;
  count: number | null;
  cap: number;
  reason: string;
}

export interface RelaunchCapAuditResult {
  cap: number;
  checkedStatePaths: string[];
  violations: RelaunchCapAuditViolation[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function statePathsForBundle(sessionDir: string): string[] {
  const statePaths = [path.join(sessionDir, 'state.json')];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessionDir, { withFileTypes: true });
  } catch {
    return statePaths;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('microverse_')) continue;
    const childStatePath = path.join(sessionDir, entry.name, 'state.json');
    if (fs.existsSync(childStatePath)) statePaths.push(childStatePath);
  }

  return statePaths;
}

function readCount(statePath: string): number | null {
  const raw = fs.readFileSync(statePath, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) return null;
  const value = parsed.codex_manager_relaunch_count;
  if (value === undefined || value === null) return 0;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function auditCodexManagerRelaunchCaps(sessionDir: string): RelaunchCapAuditResult {
  const cap = Defaults.CODEX_MANAGER_RELAUNCH_CAP;
  const checkedStatePaths = statePathsForBundle(sessionDir);
  const violations: RelaunchCapAuditViolation[] = [];

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
      } else if (count > cap) {
        violations.push({
          statePath,
          count,
          cap,
          reason: `codex_manager_relaunch_count ${count} exceeds cap ${cap}`,
        });
      }
    } catch (err) {
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

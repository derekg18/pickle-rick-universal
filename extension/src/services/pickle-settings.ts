import * as fs from 'fs';
import * as path from 'path';
import { readRecoverableJsonObject } from './microverse-state.js';

export interface PickleSettingsLoadOptions {
  extensionRoot?: string;
  sessionRoot?: string;
}

export function resolvePickleSettingsPath(input: string | PickleSettingsLoadOptions): string {
  const root = typeof input === 'string'
    ? input
    : input.extensionRoot ?? input.sessionRoot;
  if (!root) {
    throw new Error('resolvePickleSettingsPath requires extensionRoot or sessionRoot');
  }
  return path.join(root, 'pickle_settings.json');
}

export function loadPickleSettings(input: string | PickleSettingsLoadOptions): Record<string, unknown> | null {
  const settingsPath = resolvePickleSettingsPath(input);
  const raw = readRecoverableJsonObject(settingsPath) as Record<string, unknown> | null;
  if (!raw && fs.existsSync(settingsPath)) {
    console.warn(`[pickle-settings] Malformed settings at ${settingsPath}; using defaults`);
  }
  return raw;
}

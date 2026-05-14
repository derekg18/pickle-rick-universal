import * as fs from 'fs';
import * as path from 'path';
import { readRecoverableJsonObject } from './microverse-state.js';
export function resolvePickleSettingsPath(input) {
    const root = typeof input === 'string'
        ? input
        : input.extensionRoot ?? input.sessionRoot;
    if (!root) {
        throw new Error('resolvePickleSettingsPath requires extensionRoot or sessionRoot');
    }
    return path.join(root, 'pickle_settings.json');
}
export function loadPickleSettings(input) {
    const settingsPath = resolvePickleSettingsPath(input);
    const raw = readRecoverableJsonObject(settingsPath);
    if (!raw && fs.existsSync(settingsPath)) {
        console.warn(`[pickle-settings] Malformed settings at ${settingsPath}; using defaults`);
    }
    return raw;
}

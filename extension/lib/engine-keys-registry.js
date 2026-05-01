import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_REGISTRY_PATH = path.resolve(__dirname, '../data/engine-injected-keys.json');
function globToRegExp(pattern) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`);
}
function assertStringArray(data, key) {
    const value = data[key];
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
        throw new Error(`engine-injected-keys.json: ${key} must be an array of strings`);
    }
    return value;
}
export function loadEngineKeysRegistry(registryPath) {
    const p = registryPath ?? DEFAULT_REGISTRY_PATH;
    const raw = fs.readFileSync(p, 'utf8');
    const data = JSON.parse(raw);
    if (data.schema_version !== 1) {
        throw new Error(`engine-injected-keys.json: unsupported schema_version ${data.schema_version} (loader supports 1)`);
    }
    return {
        schema_version: 1,
        engine_keys: assertStringArray(data, 'engine_keys'),
        engine_key_patterns: assertStringArray(data, 'engine_key_patterns'),
        user_written_patterns: assertStringArray(data, 'user_written_patterns'),
    };
}
export function isUserWritten(key, registry) {
    return registry.user_written_patterns.some(p => globToRegExp(p).test(key));
}
export function isEngineWritten(key, registry) {
    if (isUserWritten(key, registry))
        return false;
    if (registry.engine_keys.includes(key))
        return true;
    return registry.engine_key_patterns.some(p => globToRegExp(p).test(key));
}

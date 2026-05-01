#!/usr/bin/env node
import * as path from 'path';
import { updateState, safeErrorMessage } from '../services/pickle-utils.js';
export { updateState };
if (process.argv[1] && path.basename(process.argv[1]) === 'update-state.js') {
    const [key, value, sessionDir] = process.argv.slice(2);
    if (!key || !value || !sessionDir || sessionDir.startsWith('--')) {
        console.error('Usage: node update-state.js <key> <value> <session_dir>');
        process.exit(1);
    }
    try {
        updateState(key, value, sessionDir);
    }
    catch (err) {
        console.error(`Failed to update state: ${safeErrorMessage(err)}`);
        process.exit(1);
    }
}

#!/usr/bin/env node
import * as path from 'path';
import { runRuntimeObservabilityCommandByName, } from '../services/runtime-observability.js';
function main() {
    const [command, ...args] = process.argv.slice(2);
    if (!command) {
        console.error('Usage: node runtime-observability.js <command> [args...]');
        process.exit(1);
    }
    const ctx = {
        workspaceDir: process.cwd(),
        sessionDir: process.env.PICKLE_SESSION_DIR,
    };
    const result = runRuntimeObservabilityCommandByName(command, args, ctx);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status === 'failed')
        process.exit(1);
}
if (process.argv[1] && path.basename(process.argv[1]) === 'runtime-observability.js') {
    main();
}

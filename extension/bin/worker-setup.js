#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { printMinimalPanel, safeErrorMessage, findSessionPathForCwd } from '../services/pickle-utils.js';
function main() {
    const args = process.argv.slice(2);
    let sessionPath = '';
    let resumePathProvided = false;
    // Find session path from args or map
    const resumeIndex = args.indexOf('--resume');
    if (resumeIndex !== -1 && args[resumeIndex + 1] && !args[resumeIndex + 1].startsWith('--')) {
        resumePathProvided = true;
        sessionPath = args[resumeIndex + 1];
    }
    if (resumePathProvided && !fs.existsSync(sessionPath)) {
        console.error('Worker Error: No session path found.');
        process.exit(1);
    }
    if (!sessionPath) {
        sessionPath = findSessionPathForCwd(process.cwd(), { requireActive: true });
    }
    if (!sessionPath || !fs.existsSync(sessionPath)) {
        console.error('Worker Error: No session path found.');
        process.exit(1);
    }
    printMinimalPanel('Morty Worker Initialized', {
        Session: path.basename(sessionPath),
        CWD: process.cwd(),
    }, 'BLUE', '👶');
}
if (process.argv[1] && path.basename(process.argv[1]) === 'worker-setup.js') {
    try {
        main();
    }
    catch (err) {
        console.error(safeErrorMessage(err));
        process.exit(1);
    }
}

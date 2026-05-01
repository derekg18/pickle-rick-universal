import * as fs from 'fs';
import * as path from 'path';
import { logActivity } from '../services/activity-logger.js';
import { findSessionPathForCwd } from '../services/pickle-utils.js';
const COMMIT_CMD_RE = /\bgit\s+(commit|cherry-pick|merge|rebase)\b/;
const COMMIT_HASH_RE = /\[[^\]]*\s+([a-f0-9]{7,})\]\s+(.+)/;
function findActiveSession() {
    try {
        const cwd = process.cwd();
        const sessionPath = findSessionPathForCwd(cwd, { requireActive: true });
        return sessionPath ? path.basename(sessionPath) : null;
    }
    catch {
        return null;
    }
}
// eslint-disable-next-line complexity -- pre-existing — outside T0–T15 god-fn refactor scope; defer to follow-up epic
function main() {
    const MAX_STDIN = 1024 * 1024; // 1 MB guard — truncate oversized input
    let raw = '';
    try {
        raw = fs.readFileSync(0, 'utf8');
        if (raw.length > MAX_STDIN)
            raw = raw.slice(0, MAX_STDIN);
    }
    catch {
        process.exit(0);
    }
    let input;
    try {
        input = JSON.parse(raw || '{}');
    }
    catch {
        process.exit(0);
    }
    const command = input.tool_input?.command;
    if (!command || !COMMIT_CMD_RE.test(command)) {
        process.exit(0);
    }
    const stdout = input.tool_response?.stdout ?? '';
    const match = COMMIT_HASH_RE.exec(stdout);
    const commit_hash = match?.[1];
    const commit_message = match?.[2]?.trim();
    const session = findActiveSession();
    logActivity({
        event: 'commit',
        source: 'hook',
        ...(commit_hash ? { commit_hash } : {}),
        ...(commit_message ? { commit_message } : {}),
        ...(session ? { session } : {}),
    });
    process.exit(0);
}
if (process.argv[1] && path.basename(process.argv[1]) === 'log-commit.js') {
    main();
}

#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { findMissingPrefixes } from '../services/artifact-validation.js';
import { ARTIFACT_PREFIXES } from '../types/index.js';
const USAGE = 'Usage: node validate-teams-ticket.js --ticket-path <dir> [--role <implementation|review>]';
const VALID_ROLES = ['implementation', 'review'];
function isValidRole(value) {
    return VALID_ROLES.includes(value);
}
export function parseArgs(argv) {
    let ticketPath;
    let role = 'implementation';
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--ticket-path') {
            const v = argv[++i];
            if (!v || v.startsWith('--')) {
                throw new Error(`--ticket-path requires a non-empty value\n${USAGE}`);
            }
            ticketPath = v;
        }
        else if (a === '--role') {
            const v = argv[++i];
            if (!v || v.startsWith('--')) {
                throw new Error(`--role requires a non-empty value\n${USAGE}`);
            }
            if (!isValidRole(v)) {
                throw new Error(`--role must be one of: ${VALID_ROLES.join(', ')}`);
            }
            role = v;
        }
        else {
            throw new Error(`Unknown argument: ${a}\n${USAGE}`);
        }
    }
    if (!ticketPath) {
        throw new Error(`--ticket-path is required\n${USAGE}`);
    }
    return { ticketPath, role };
}
export async function main(argv = process.argv.slice(2)) {
    let parsed;
    try {
        parsed = parseArgs(argv);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(msg);
        process.exit(1);
    }
    const { ticketPath, role } = parsed;
    let files;
    try {
        // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call: short-lived CLI, single dir read
        files = fs.readdirSync(ticketPath);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Cannot read ticket directory ${ticketPath}: ${msg}`);
        process.exit(1);
    }
    // Strict all-of: every required prefix must have at least one matching file.
    // Stricter than `hasLifecycleArtifact` (any-of) because teams mode lacks the
    // WORKER_DONE token + log-size signals that the legacy spawn-morty path uses
    // — the artifact set is the only completion proof, so we hold the bar high.
    const missing = findMissingPrefixes(files, ARTIFACT_PREFIXES[role]);
    if (missing.length === 0) {
        process.exit(0);
    }
    console.error(`Ticket ${ticketPath} is missing required ${role} lifecycle artifacts (need one of each prefix): ${missing.join(', ')}`);
    process.exit(1);
}
if (process.argv[1] && path.basename(process.argv[1]) === 'validate-teams-ticket.js') {
    main().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(msg);
        process.exit(1);
    });
}

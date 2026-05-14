import * as fs from 'fs';
import * as path from 'path';
const COMMANDS = [
    'interdimensional-cable',
    'mr-poopybutthole',
    'glorzo',
    'galactic-federation',
    'ghost-in-a-jar',
];
function isRuntimeObservabilityCommand(value) {
    return COMMANDS.includes(value);
}
function defaultArtifact(command, ctx) {
    return {
        kind: 'runtime-observability-summary',
        workspace_dir: ctx.workspaceDir ?? null,
        session_dir: ctx.sessionDir ?? null,
        generated_at: (ctx.now ?? new Date()).toISOString(),
        commands: [command],
    };
}
function splitLogTokens(args) {
    const tokens = [];
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === '--log' || arg === '--service') {
            const next = args[index + 1];
            if (next) {
                tokens.push(...next.split(','));
                index++;
            }
            continue;
        }
        if (arg.startsWith('--log=')) {
            tokens.push(...arg.slice('--log='.length).split(','));
            continue;
        }
        if (arg.startsWith('--service=')) {
            tokens.push(...arg.slice('--service='.length).split(','));
            continue;
        }
        if (!arg.startsWith('--')) {
            tokens.push(...arg.split(','));
        }
    }
    return tokens.map((token) => token.trim()).filter(Boolean);
}
export function parseRuntimeLogSpecs(args) {
    return splitLogTokens(args).flatMap((token) => {
        const separator = token.indexOf('=');
        if (separator <= 0 || separator === token.length - 1)
            return [];
        const service = token.slice(0, separator).trim();
        const source = token.slice(separator + 1).trim();
        return service && source ? [{ service, source }] : [];
    });
}
function readPreview(filePath, ctx) {
    const text = ctx.readTextFile
        ? ctx.readTextFile(filePath)
        : fs.readFileSync(filePath, 'utf-8');
    return text.split(/\r?\n/).filter(Boolean).slice(0, 5);
}
function failed(command, summary, remediation, ctx) {
    return {
        command,
        status: 'failed',
        summary,
        remediation,
        artifact: defaultArtifact(command, ctx),
    };
}
function runInterdimensionalCable(args, ctx) {
    const specs = parseRuntimeLogSpecs(args);
    if (specs.length === 0) {
        return failed('interdimensional-cable', 'No service log specs were provided.', 'Pass one or more log specs as service=/path/to/log, separated by spaces or commas.', ctx);
    }
    const exists = ctx.fileExists ?? fs.existsSync;
    const missing = specs.filter((spec) => !exists(spec.source));
    if (missing.length > 0) {
        return failed('interdimensional-cable', `Missing log source for ${missing.map((spec) => spec.service).join(', ')}.`, 'Create the log file or pass a valid service=/path/to/log source.', ctx);
    }
    const pane_config = specs.map((spec) => ({
        service: spec.service,
        channel: `logs:${spec.service}`,
        source: path.resolve(spec.source),
        mode: 'fake-log-tail',
        supervised: true,
        preview: readPreview(spec.source, ctx),
    }));
    return {
        command: 'interdimensional-cable',
        status: 'success',
        summary: `Supervising ${pane_config.length} service log stream${pane_config.length === 1 ? '' : 's'}.`,
        pane_config,
        artifact: defaultArtifact('interdimensional-cable', ctx),
    };
}
function requireSession(command, ctx) {
    if (ctx.sessionDir)
        return ctx.sessionDir;
    return failed(command, 'No session source was provided.', 'Run from an active Pickle session or pass a session directory in the command context.', ctx);
}
function runCompanion(ctx) {
    const sessionDir = requireSession('mr-poopybutthole', ctx);
    if (typeof sessionDir !== 'string')
        return sessionDir;
    return {
        command: 'mr-poopybutthole',
        status: 'success',
        summary: 'Companion runtime session summary is ready.',
        companion: {
            role: 'companion',
            session_dir: sessionDir,
            activity_source: path.join(sessionDir, 'activity.jsonl'),
        },
        artifact: defaultArtifact('mr-poopybutthole', ctx),
    };
}
function runFocus(args, ctx) {
    const workspaceDir = ctx.workspaceDir;
    if (!workspaceDir) {
        return failed('glorzo', 'No workspace source was provided.', 'Run from a workspace or pass a workspace directory in the command context.', ctx);
    }
    const focus = args.find((arg) => !arg.startsWith('--')) ?? 'runtime';
    return {
        command: 'glorzo',
        status: 'success',
        summary: `Focus runtime view prepared for ${focus}.`,
        focus: {
            role: 'focus',
            workspace_dir: workspaceDir,
            focus,
        },
        artifact: defaultArtifact('glorzo', ctx),
    };
}
function runAudit(ctx) {
    const workspaceDir = ctx.workspaceDir;
    if (!workspaceDir) {
        return failed('galactic-federation', 'No workspace source was provided.', 'Run from a workspace or pass a workspace directory in the command context.', ctx);
    }
    return {
        command: 'galactic-federation',
        status: 'success',
        summary: 'Runtime audit skeleton is ready.',
        audit: {
            role: 'audit',
            workspace_dir: workspaceDir,
            checks: ['process-source', 'log-source', 'session-summary'],
        },
        artifact: defaultArtifact('galactic-federation', ctx),
    };
}
function runGhost(ctx) {
    return {
        command: 'ghost-in-a-jar',
        status: 'success',
        summary: 'Persistence command is skeleton-only in v1.',
        persistence: {
            role: 'persistence',
            skeleton_only: true,
            action: 'none',
            started: false,
        },
        artifact: defaultArtifact('ghost-in-a-jar', ctx),
    };
}
export function runRuntimeObservabilityCommand(command, args = [], ctx = {}) {
    switch (command) {
        case 'interdimensional-cable':
            return runInterdimensionalCable(args, ctx);
        case 'mr-poopybutthole':
            return runCompanion(ctx);
        case 'glorzo':
            return runFocus(args, ctx);
        case 'galactic-federation':
            return runAudit(ctx);
        case 'ghost-in-a-jar':
            return runGhost(ctx);
    }
}
export function runRuntimeObservabilityCommandByName(command, args = [], ctx = {}) {
    if (!isRuntimeObservabilityCommand(command)) {
        return {
            command: 'galactic-federation',
            status: 'failed',
            summary: `Unknown runtime observability command: ${command}`,
            remediation: `Use one of: ${COMMANDS.join(', ')}.`,
            artifact: defaultArtifact('galactic-federation', ctx),
        };
    }
    return runRuntimeObservabilityCommand(command, args, ctx);
}

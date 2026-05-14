const COMMANDS = [
    'evil-morty',
    'scary-terry',
    'fleeb-juice',
    'interdimensional-customs',
    'wendys',
    'froopyland',
];
const UNSAFE_FLAGS = new Set([
    '--apply',
    '--container',
    '--destructive-rollback',
    '--execute',
    '--exec',
    '--no-dry-run',
    '--rollback',
    '--rotate-secret',
    '--run',
    '--sandbox',
    '--syscall',
]);
const BLOCKED_ACTIONS = [
    'container',
    'secret-rotation',
    'destructive-rollback',
    'syscall',
];
function isSecuritySafetyCommand(value) {
    return COMMANDS.includes(value);
}
function parseArgs(args) {
    const positional = [];
    const unsafe = [];
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        const flag = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
        if (UNSAFE_FLAGS.has(flag)) {
            unsafe.push(arg);
            continue;
        }
        if ((arg === '--target' || arg === '--repo' || arg === '--pr' || arg === '--endpoint') && args[index + 1]) {
            positional.push(args[index + 1]);
            index++;
            continue;
        }
        if (arg.startsWith('--target=') || arg.startsWith('--repo=') || arg.startsWith('--pr=') || arg.startsWith('--endpoint=')) {
            positional.push(arg.slice(arg.indexOf('=') + 1));
            continue;
        }
        if (!arg.startsWith('--'))
            positional.push(arg);
    }
    return {
        target: positional.join(' ').trim() || null,
        unsafe,
    };
}
function defaultArtifact(command, parsed, ctx) {
    return {
        kind: 'security-safety-command-result',
        command,
        workspace_dir: ctx.workspaceDir ?? null,
        generated_at: (ctx.now ?? new Date()).toISOString(),
        target: parsed.target,
        non_destructive: true,
        executed_actions: [],
    };
}
function failed(command, parsed, ctx, summary, remediation) {
    return {
        command,
        status: 'failed',
        summary,
        remediation,
        artifact: defaultArtifact(command, parsed, ctx),
    };
}
function unsafeRequestFailure(command, parsed, ctx) {
    if (parsed.unsafe.length === 0)
        return null;
    return failed(command, parsed, ctx, `Unsafe execution flags are not supported by /${command}.`, 'Re-run without execution, container, secret rotation, rollback, sandbox, or syscall flags; v1 only emits non-destructive plans or typed skeletons.');
}
function targetOrWorkspace(parsed, ctx) {
    return parsed.target ?? ctx.workspaceDir ?? 'workspace';
}
function runEvilMorty(args, ctx) {
    const parsed = parseArgs(args);
    const unsafe = unsafeRequestFailure('evil-morty', parsed, ctx);
    if (unsafe)
        return unsafe;
    const target = targetOrWorkspace(parsed, ctx);
    return {
        command: 'evil-morty',
        status: 'success',
        summary: `Prepared non-destructive security review plan for ${target}.`,
        review: {
            role: 'security-review',
            target,
            findings_plan: [
                'map authentication and authorization boundaries',
                'inspect input validation and output encoding paths',
                'review secret handling without reading or rotating secret values',
                'identify dependency and configuration risks from static evidence',
            ],
            evidence_sources: ['diff', 'tests', 'configuration', 'dependency metadata'],
        },
        artifact: defaultArtifact('evil-morty', parsed, ctx),
    };
}
function runScaryTerry(args, ctx) {
    const parsed = parseArgs(args);
    const unsafe = unsafeRequestFailure('scary-terry', parsed, ctx);
    if (unsafe)
        return unsafe;
    const target = targetOrWorkspace(parsed, ctx);
    return {
        command: 'scary-terry',
        status: 'success',
        summary: `Prepared non-destructive API fuzz plan for ${target}.`,
        fuzz: {
            role: 'api-fuzz-plan',
            target,
            payload_matrix: [
                { category: 'auth', payload: 'missing bearer token', expected_check: '401 or documented anonymous behavior' },
                { category: 'input', payload: 'oversized string fields', expected_check: 'bounded validation error' },
                { category: 'encoding', payload: 'reserved URL characters and unicode separators', expected_check: 'stable parser behavior' },
                { category: 'rate-limit', payload: 'burst request schedule', expected_check: 'documented throttling or backpressure' },
            ],
        },
        artifact: defaultArtifact('scary-terry', parsed, ctx),
    };
}
function runInterdimensionalCustoms(args, ctx) {
    const parsed = parseArgs(args);
    const unsafe = unsafeRequestFailure('interdimensional-customs', parsed, ctx);
    if (unsafe)
        return unsafe;
    const target = targetOrWorkspace(parsed, ctx);
    return {
        command: 'interdimensional-customs',
        status: 'success',
        summary: `Prepared non-destructive downstream safety plan for ${target}.`,
        downstream: {
            role: 'downstream-safety',
            target,
            checks: [
                'catalog external API/schema consumers',
                'compare request and response contract changes',
                'flag migration or rollout steps that require human approval',
                'produce remediation notes without applying rollback actions',
            ],
        },
        artifact: defaultArtifact('interdimensional-customs', parsed, ctx),
    };
}
function runSkeleton(command, reason, args, ctx) {
    const parsed = parseArgs(args);
    const unsafe = unsafeRequestFailure(command, parsed, ctx);
    if (unsafe)
        return unsafe;
    return {
        command,
        status: 'success',
        summary: `/${command} is skeleton-only in v1; no safety action was started.`,
        skeleton: {
            role: 'skeleton',
            skeleton_only: true,
            reason,
            action: 'none',
            started: false,
            blocked_actions: BLOCKED_ACTIONS,
        },
        artifact: defaultArtifact(command, parsed, ctx),
    };
}
export function runSecuritySafetyCommand(command, args = [], ctx = {}) {
    switch (command) {
        case 'evil-morty':
            return runEvilMorty(args, ctx);
        case 'scary-terry':
            return runScaryTerry(args, ctx);
        case 'interdimensional-customs':
            return runInterdimensionalCustoms(args, ctx);
        case 'fleeb-juice':
            return runSkeleton(command, 'SECRET_ROTATION_NOT_IMPLEMENTED', args, ctx);
        case 'wendys':
            return runSkeleton(command, 'DESTRUCTIVE_ROLLBACK_NOT_IMPLEMENTED', args, ctx);
        case 'froopyland':
            return runSkeleton(command, 'SANDBOX_NOT_IMPLEMENTED', args, ctx);
    }
}
export function runSecuritySafetyCommandByName(command, args = [], ctx = {}) {
    if (!isSecuritySafetyCommand(command)) {
        const parsed = parseArgs(args);
        return failed('evil-morty', parsed, ctx, `Unknown security/safety command: ${command}`, `Use one of: ${COMMANDS.join(', ')}.`);
    }
    return runSecuritySafetyCommand(command, args, ctx);
}

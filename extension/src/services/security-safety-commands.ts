export type SecuritySafetyCommand =
  | 'evil-morty'
  | 'scary-terry'
  | 'fleeb-juice'
  | 'interdimensional-customs'
  | 'wendys'
  | 'froopyland';

export type PickleCommandStatus = 'success' | 'failed';

export type SafetySkeletonReason =
  | 'SECRET_ROTATION_NOT_IMPLEMENTED'
  | 'DESTRUCTIVE_ROLLBACK_NOT_IMPLEMENTED'
  | 'SANDBOX_NOT_IMPLEMENTED';

export interface SecuritySafetyContext {
  workspaceDir?: string;
  now?: Date;
  startContainer?: () => void;
  rotateSecret?: () => void;
  destructiveRollback?: () => void;
  execSyscall?: () => void;
}

export interface PickleCommandResult {
  command: SecuritySafetyCommand;
  status: PickleCommandStatus;
  summary: string;
  remediation?: string;
  artifact: SecuritySafetyArtifact;
  review?: SecurityReviewPlan;
  fuzz?: ApiFuzzPlan;
  downstream?: DownstreamSafetyPlan;
  skeleton?: SafetySkeleton;
}

export interface SecuritySafetyArtifact {
  kind: 'security-safety-command-result';
  command: SecuritySafetyCommand;
  workspace_dir: string | null;
  generated_at: string;
  target: string | null;
  non_destructive: true;
  executed_actions: [];
}

export interface SecurityReviewPlan {
  role: 'security-review';
  target: string;
  findings_plan: string[];
  evidence_sources: string[];
}

export interface ApiFuzzPlan {
  role: 'api-fuzz-plan';
  target: string;
  payload_matrix: PayloadMatrixRow[];
}

export interface PayloadMatrixRow {
  category: 'auth' | 'input' | 'encoding' | 'rate-limit';
  payload: string;
  expected_check: string;
}

export interface DownstreamSafetyPlan {
  role: 'downstream-safety';
  target: string;
  checks: string[];
}

export interface SafetySkeleton {
  role: 'skeleton';
  skeleton_only: true;
  reason: SafetySkeletonReason;
  action: 'none';
  started: false;
  blocked_actions: readonly string[];
}

interface ParsedArgs {
  target: string | null;
  unsafe: string[];
}

const COMMANDS: readonly SecuritySafetyCommand[] = [
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
] as const;

function isSecuritySafetyCommand(value: string): value is SecuritySafetyCommand {
  return (COMMANDS as readonly string[]).includes(value);
}

function parseArgs(args: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const unsafe: string[] = [];

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
    if (!arg.startsWith('--')) positional.push(arg);
  }

  return {
    target: positional.join(' ').trim() || null,
    unsafe,
  };
}

function defaultArtifact(
  command: SecuritySafetyCommand,
  parsed: ParsedArgs,
  ctx: SecuritySafetyContext,
): SecuritySafetyArtifact {
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

function failed(
  command: SecuritySafetyCommand,
  parsed: ParsedArgs,
  ctx: SecuritySafetyContext,
  summary: string,
  remediation: string,
): PickleCommandResult {
  return {
    command,
    status: 'failed',
    summary,
    remediation,
    artifact: defaultArtifact(command, parsed, ctx),
  };
}

function unsafeRequestFailure(
  command: SecuritySafetyCommand,
  parsed: ParsedArgs,
  ctx: SecuritySafetyContext,
): PickleCommandResult | null {
  if (parsed.unsafe.length === 0) return null;
  return failed(
    command,
    parsed,
    ctx,
    `Unsafe execution flags are not supported by /${command}.`,
    'Re-run without execution, container, secret rotation, rollback, sandbox, or syscall flags; v1 only emits non-destructive plans or typed skeletons.',
  );
}

function targetOrWorkspace(parsed: ParsedArgs, ctx: SecuritySafetyContext): string {
  return parsed.target ?? ctx.workspaceDir ?? 'workspace';
}

function runEvilMorty(args: readonly string[], ctx: SecuritySafetyContext): PickleCommandResult {
  const parsed = parseArgs(args);
  const unsafe = unsafeRequestFailure('evil-morty', parsed, ctx);
  if (unsafe) return unsafe;
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

function runScaryTerry(args: readonly string[], ctx: SecuritySafetyContext): PickleCommandResult {
  const parsed = parseArgs(args);
  const unsafe = unsafeRequestFailure('scary-terry', parsed, ctx);
  if (unsafe) return unsafe;
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

function runInterdimensionalCustoms(args: readonly string[], ctx: SecuritySafetyContext): PickleCommandResult {
  const parsed = parseArgs(args);
  const unsafe = unsafeRequestFailure('interdimensional-customs', parsed, ctx);
  if (unsafe) return unsafe;
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

function runSkeleton(
  command: 'fleeb-juice' | 'wendys' | 'froopyland',
  reason: SafetySkeletonReason,
  args: readonly string[],
  ctx: SecuritySafetyContext,
): PickleCommandResult {
  const parsed = parseArgs(args);
  const unsafe = unsafeRequestFailure(command, parsed, ctx);
  if (unsafe) return unsafe;
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

export function runSecuritySafetyCommand(
  command: SecuritySafetyCommand,
  args: readonly string[] = [],
  ctx: SecuritySafetyContext = {},
): PickleCommandResult {
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

export function runSecuritySafetyCommandByName(
  command: string,
  args: readonly string[] = [],
  ctx: SecuritySafetyContext = {},
): PickleCommandResult {
  if (!isSecuritySafetyCommand(command)) {
    const parsed = parseArgs(args);
    return failed(
      'evil-morty',
      parsed,
      ctx,
      `Unknown security/safety command: ${command}`,
      `Use one of: ${COMMANDS.join(', ')}.`,
    );
  }
  return runSecuritySafetyCommand(command, args, ctx);
}

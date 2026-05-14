export type EnvironmentCommand =
  | 'microverse-battery'
  | 'ricks-garage'
  | 'phoenix-person'
  | 'nimbus'
  | 'citadel';

export type EnvironmentCommandStatus = 'success' | 'needs_followup' | 'not_implemented' | 'failed';

export type EnvironmentPlanKind =
  | 'dev-bootstrap'
  | 'environment-config'
  | 'nested-container-validation'
  | 'deploy-skeleton'
  | 'cloud-skeleton';

export type UnsafeEnvironmentAction =
  | 'destructive'
  | 'cloud-cost'
  | 'cloud-provision'
  | 'deploy-rollback'
  | 'nested-container';

export interface EnvironmentCommandContext {
  workspaceDir?: string;
  now?: Date;
  stackFixture?: EnvironmentStackFixture;
  startContainer?: () => void;
  provisionCloud?: () => void;
  deployRollback?: () => void;
  destructiveAction?: () => void;
}

export interface EnvironmentStackFixture {
  services?: readonly string[];
  env?: Record<string, string>;
  seed?: readonly string[];
}

export interface EnvironmentCommandArtifact {
  kind: 'environment-command-result';
  command: EnvironmentCommand;
  workspace_dir: string | null;
  generated_at: string;
  target_environment: string;
  dry_run: boolean;
  force: boolean;
  confirmed: boolean;
  executed_actions: [];
  unsafe_actions: UnsafeEnvironmentAction[];
}

export interface EnvironmentCommandResult {
  command: EnvironmentCommand;
  status: EnvironmentCommandStatus;
  summary: string;
  remediation?: string;
  artifact: EnvironmentCommandArtifact;
  plan?: EnvironmentPlan;
  skeleton?: EnvironmentSkeleton;
}

export interface EnvironmentPlan {
  role: 'environment-plan';
  kind: EnvironmentPlanKind;
  target_environment: string;
  workspace_path: string;
  services: string[];
  env: EnvironmentVariablePlan[];
  seed: string[];
  checks: string[];
  actions: string[];
}

export interface EnvironmentVariablePlan {
  name: string;
  value: string;
}

export interface EnvironmentSkeleton {
  role: 'skeleton';
  skeleton_only: true;
  kind: EnvironmentPlanKind;
  reason:
    | 'DEPLOY_ROLLBACK_NOT_IMPLEMENTED'
    | 'CLOUD_PROVISIONING_NOT_IMPLEMENTED'
    | 'ACTION_REQUIRES_CONFIRMATION';
  action: 'none';
  started: false;
  blocked_actions: UnsafeEnvironmentAction[];
}

interface ParsedArgs {
  workspacePath: string | null;
  targetEnvironment: string;
  dryRun: boolean;
  force: boolean;
  confirmed: boolean;
  services: string[];
  env: Record<string, string>;
  seed: string[];
  unsafeActions: UnsafeEnvironmentAction[];
}

const COMMANDS: readonly EnvironmentCommand[] = [
  'microverse-battery',
  'ricks-garage',
  'phoenix-person',
  'nimbus',
  'citadel',
];

const UNSAFE_FLAG_ACTIONS: Record<string, UnsafeEnvironmentAction> = {
  '--apply': 'destructive',
  '--cloud-cost': 'cloud-cost',
  '--cloud-provision': 'cloud-provision',
  '--container': 'nested-container',
  '--destroy': 'destructive',
  '--destructive': 'destructive',
  '--deploy-rollback': 'deploy-rollback',
  '--nested-container': 'nested-container',
  '--no-dry-run': 'destructive',
  '--provision': 'cloud-provision',
  '--rollback': 'deploy-rollback',
  '--run': 'destructive',
};

const DEFAULT_FIXTURE: Required<EnvironmentStackFixture> = {
  services: ['api', 'worker', 'postgres'],
  env: {
    NODE_ENV: 'development',
    DATABASE_URL: 'postgres://localhost/pickle',
  },
  seed: ['schema', 'fixtures'],
};

function isEnvironmentCommand(value: string): value is EnvironmentCommand {
  return (COMMANDS as readonly string[]).includes(value);
}

function addUnsafeAction(actions: UnsafeEnvironmentAction[], action: UnsafeEnvironmentAction): void {
  if (!actions.includes(action)) actions.push(action);
}

function parseEnvAssignment(value: string, env: Record<string, string>): void {
  const equalsIndex = value.indexOf('=');
  if (equalsIndex <= 0) return;
  env[value.slice(0, equalsIndex)] = value.slice(equalsIndex + 1);
}

function parseArgs(args: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    workspacePath: null,
    targetEnvironment: 'development',
    dryRun: true,
    force: false,
    confirmed: false,
    services: [],
    env: {},
    seed: [],
    unsafeActions: [],
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const flag = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    const inlineValue = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : null;
    const next = args[index + 1];

    if (flag in UNSAFE_FLAG_ACTIONS) {
      addUnsafeAction(parsed.unsafeActions, UNSAFE_FLAG_ACTIONS[flag]);
      if (arg === '--no-dry-run') parsed.dryRun = false;
      continue;
    }
    if (arg === '--confirm') {
      parsed.confirmed = true;
      continue;
    }
    if (arg === '--force') {
      parsed.force = true;
      parsed.confirmed = true;
      continue;
    }
    if ((arg === '--workspace' || arg === '--workspace-path') && next) {
      parsed.workspacePath = next;
      index++;
      continue;
    }
    if (arg.startsWith('--workspace=') || arg.startsWith('--workspace-path=')) {
      parsed.workspacePath = inlineValue;
      continue;
    }
    if ((arg === '--env' || arg === '--target-environment') && next) {
      parsed.targetEnvironment = next;
      index++;
      continue;
    }
    if (arg.startsWith('--env=') || arg.startsWith('--target-environment=')) {
      parsed.targetEnvironment = inlineValue ?? parsed.targetEnvironment;
      continue;
    }
    if (arg === '--service' && next) {
      parsed.services.push(next);
      index++;
      continue;
    }
    if (arg.startsWith('--service=')) {
      if (inlineValue) parsed.services.push(inlineValue);
      continue;
    }
    if (arg === '--env-var' && next) {
      parseEnvAssignment(next, parsed.env);
      index++;
      continue;
    }
    if (arg.startsWith('--env-var=')) {
      if (inlineValue) parseEnvAssignment(inlineValue, parsed.env);
      continue;
    }
    if (arg === '--seed' && next) {
      parsed.seed.push(next);
      index++;
      continue;
    }
    if (arg.startsWith('--seed=')) {
      if (inlineValue) parsed.seed.push(inlineValue);
      continue;
    }
    if (!arg.startsWith('--') && parsed.workspacePath === null) {
      parsed.workspacePath = arg;
    }
  }

  return parsed;
}

function stackFixture(ctx: EnvironmentCommandContext): Required<EnvironmentStackFixture> {
  return {
    services: [...(ctx.stackFixture?.services ?? DEFAULT_FIXTURE.services)],
    env: { ...DEFAULT_FIXTURE.env, ...(ctx.stackFixture?.env ?? {}) },
    seed: [...(ctx.stackFixture?.seed ?? DEFAULT_FIXTURE.seed)],
  };
}

function sortedEnvRows(env: Record<string, string>): EnvironmentVariablePlan[] {
  return Object.entries(env)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => ({ name, value }));
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function workspacePath(parsed: ParsedArgs, ctx: EnvironmentCommandContext): string {
  return parsed.workspacePath ?? ctx.workspaceDir ?? 'workspace';
}

function defaultArtifact(
  command: EnvironmentCommand,
  parsed: ParsedArgs,
  ctx: EnvironmentCommandContext,
): EnvironmentCommandArtifact {
  return {
    kind: 'environment-command-result',
    command,
    workspace_dir: parsed.workspacePath ?? ctx.workspaceDir ?? null,
    generated_at: (ctx.now ?? new Date()).toISOString(),
    target_environment: parsed.targetEnvironment,
    dry_run: parsed.dryRun,
    force: parsed.force,
    confirmed: parsed.confirmed,
    executed_actions: [],
    unsafe_actions: [...parsed.unsafeActions],
  };
}

function failed(
  command: EnvironmentCommand,
  parsed: ParsedArgs,
  ctx: EnvironmentCommandContext,
  summary: string,
  remediation: string,
): EnvironmentCommandResult {
  return {
    command,
    status: 'failed',
    summary,
    remediation,
    artifact: defaultArtifact(command, parsed, ctx),
  };
}

function needsConfirmation(
  command: EnvironmentCommand,
  parsed: ParsedArgs,
  ctx: EnvironmentCommandContext,
): EnvironmentCommandResult | null {
  if (parsed.unsafeActions.length === 0 || parsed.confirmed) return null;
  return {
    command,
    status: 'needs_followup',
    summary: `/${command} requires explicit confirmation before unsafe environment actions.`,
    remediation: 'Re-run with --confirm or --force only after reviewing the emitted plan and accepting the cost or destructive risk.',
    artifact: defaultArtifact(command, parsed, ctx),
    skeleton: {
      role: 'skeleton',
      skeleton_only: true,
      kind: 'deploy-skeleton',
      reason: 'ACTION_REQUIRES_CONFIRMATION',
      action: 'none',
      started: false,
      blocked_actions: [...parsed.unsafeActions],
    },
  };
}

function buildPlan(
  command: EnvironmentCommand,
  parsed: ParsedArgs,
  ctx: EnvironmentCommandContext,
  kind: EnvironmentPlanKind,
  extraChecks: readonly string[],
  extraActions: readonly string[],
): EnvironmentCommandResult {
  const fixture = stackFixture(ctx);
  const services = uniqueSorted([...fixture.services, ...parsed.services]);
  const env = sortedEnvRows({ ...fixture.env, ...parsed.env });
  const seed = uniqueSorted([...fixture.seed, ...parsed.seed]);
  const target = parsed.targetEnvironment;
  const plan: EnvironmentPlan = {
    role: 'environment-plan',
    kind,
    target_environment: target,
    workspace_path: workspacePath(parsed, ctx),
    services,
    env,
    seed,
    checks: [
      'verify workspace path exists before execution',
      'diff environment variables before writing files',
      'keep dry-run enabled unless confirmation is explicit',
      ...extraChecks,
    ],
    actions: [
      'write plan artifact',
      'do not execute external processes by default',
      ...extraActions,
    ],
  };

  return {
    command,
    status: 'success',
    summary: `Prepared ${kind} plan for ${target}.`,
    artifact: defaultArtifact(command, parsed, ctx),
    plan,
  };
}

function runMicroverseBattery(args: readonly string[], ctx: EnvironmentCommandContext): EnvironmentCommandResult {
  const parsed = parseArgs(args);
  if (parsed.unsafeActions.some((action) => action !== 'nested-container')) {
    const followup = needsConfirmation('microverse-battery', parsed, ctx);
    if (followup) return followup;
  }
  return buildPlan(
    'microverse-battery',
    parsed,
    ctx,
    'nested-container-validation',
    ['validate requested nested-container topology without starting containers'],
    ['record nested-container request as validation-only'],
  );
}

function runRicksGarage(args: readonly string[], ctx: EnvironmentCommandContext): EnvironmentCommandResult {
  const parsed = parseArgs(args);
  const followup = needsConfirmation('ricks-garage', parsed, ctx);
  if (followup) return followup;
  return buildPlan(
    'ricks-garage',
    parsed,
    ctx,
    'dev-bootstrap',
    ['verify service graph and seed list are deterministic'],
    ['emit setup plan with services, env, and seed steps'],
  );
}

function runCitadel(args: readonly string[], ctx: EnvironmentCommandContext): EnvironmentCommandResult {
  const parsed = parseArgs(args);
  const followup = needsConfirmation('citadel', parsed, ctx);
  if (followup) return followup;
  return buildPlan(
    'citadel',
    parsed,
    ctx,
    'environment-config',
    ['compare target environment config before audit/deploy gates'],
    ['emit config diff plan for conformance review'],
  );
}

function skeletonCommand(
  command: 'phoenix-person' | 'nimbus',
  args: readonly string[],
  ctx: EnvironmentCommandContext,
  kind: EnvironmentPlanKind,
  reason: EnvironmentSkeleton['reason'],
): EnvironmentCommandResult {
  const parsed = parseArgs(args);
  const followup = needsConfirmation(command, parsed, ctx);
  if (followup) return followup;
  return {
    command,
    status: 'not_implemented',
    summary: `/${command} is skeleton-only in v1; no deploy or cloud action was started.`,
    remediation: 'Use the emitted skeleton to plan the action, then implement an executor in a later version.',
    artifact: defaultArtifact(command, parsed, ctx),
    skeleton: {
      role: 'skeleton',
      skeleton_only: true,
      kind,
      reason,
      action: 'none',
      started: false,
      blocked_actions: kind === 'cloud-skeleton'
        ? ['cloud-cost', 'cloud-provision']
        : ['deploy-rollback', 'destructive'],
    },
  };
}

export function runEnvironmentCommandGroup(
  command: EnvironmentCommand,
  args: readonly string[] = [],
  ctx: EnvironmentCommandContext = {},
): EnvironmentCommandResult {
  switch (command) {
    case 'microverse-battery':
      return runMicroverseBattery(args, ctx);
    case 'ricks-garage':
      return runRicksGarage(args, ctx);
    case 'citadel':
      return runCitadel(args, ctx);
    case 'phoenix-person':
      return skeletonCommand(command, args, ctx, 'deploy-skeleton', 'DEPLOY_ROLLBACK_NOT_IMPLEMENTED');
    case 'nimbus':
      return skeletonCommand(command, args, ctx, 'cloud-skeleton', 'CLOUD_PROVISIONING_NOT_IMPLEMENTED');
  }
}

export function runEnvironmentCommandGroupByName(
  command: string,
  args: readonly string[] = [],
  ctx: EnvironmentCommandContext = {},
): EnvironmentCommandResult {
  if (!isEnvironmentCommand(command)) {
    const parsed = parseArgs(args);
    return failed(
      'ricks-garage',
      parsed,
      ctx,
      `Unknown environment command: ${command}`,
      `Use one of: ${COMMANDS.join(', ')}.`,
    );
  }
  return runEnvironmentCommandGroup(command, args, ctx);
}

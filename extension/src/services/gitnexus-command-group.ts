export type GitNexusCommand =
  | 'death-crystal'
  | 'portal-fluid'
  | 'operation-phoenix'
  | 'blips-and-chitz';

export type GitNexusCommandStatus = 'success' | 'needs_followup' | 'failed';

export type GitNexusOutputFormat = 'json' | 'markdown';

export interface GitNexusRequest {
  tool: 'gitnexus_impact' | 'gitnexus_query';
  args: Record<string, string | number | boolean>;
}

export interface GitNexusCommandArtifact {
  kind: 'gitnexus-command-summary';
  command: GitNexusCommand;
  workspace_dir: string | null;
  generated_at: string;
  format: GitNexusOutputFormat;
  target: string | null;
  requests: GitNexusRequest[];
  skeleton: boolean;
}

export interface GitNexusCommandResult {
  command: GitNexusCommand;
  status: GitNexusCommandStatus;
  summary: string;
  remediation?: string;
  artifact: GitNexusCommandArtifact;
}

export interface GitNexusCommandContext {
  workspaceDir?: string;
  now?: Date;
  gitnexusResponse?: unknown;
}

interface ParsedArgs {
  target: string | null;
  format: GitNexusOutputFormat;
}

const COMMANDS: readonly GitNexusCommand[] = [
  'death-crystal',
  'portal-fluid',
  'operation-phoenix',
  'blips-and-chitz',
];

const ANALYZE_REMEDIATION = 'Run `npx gitnexus analyze` in the repository, then retry the command.';

function isGitNexusCommand(value: string): value is GitNexusCommand {
  return (COMMANDS as readonly string[]).includes(value);
}

function parseArgs(args: readonly string[]): ParsedArgs {
  let format: GitNexusOutputFormat = 'json';
  const positional: string[] = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--format') {
      const next = args[index + 1];
      if (next === 'markdown') format = 'markdown';
      if (next === 'json') format = 'json';
      if (next) index++;
      continue;
    }
    if (arg.startsWith('--format=')) {
      const value = arg.slice('--format='.length);
      if (value === 'markdown' || value === 'json') format = value;
      continue;
    }
    if (!arg.startsWith('--')) positional.push(arg);
  }

  return {
    target: positional.join(' ').trim() || null,
    format,
  };
}

function defaultArtifact(
  command: GitNexusCommand,
  parsed: ParsedArgs,
  ctx: GitNexusCommandContext,
  requests: GitNexusRequest[],
  skeleton: boolean,
): GitNexusCommandArtifact {
  return {
    kind: 'gitnexus-command-summary',
    command,
    workspace_dir: ctx.workspaceDir ?? null,
    generated_at: (ctx.now ?? new Date()).toISOString(),
    format: parsed.format,
    target: parsed.target,
    requests,
    skeleton,
  };
}

function needsAnalyze(response: unknown): boolean {
  if (response == null) return false;
  const text = typeof response === 'string' ? response : JSON.stringify(response);
  return /index is stale|stale index|missing gitnexus index|index missing|not indexed|run .*gitnexus analyze/i.test(text);
}

function failed(
  command: GitNexusCommand,
  parsed: ParsedArgs,
  ctx: GitNexusCommandContext,
  summary: string,
  remediation: string,
): GitNexusCommandResult {
  return {
    command,
    status: 'failed',
    summary,
    remediation,
    artifact: defaultArtifact(command, parsed, ctx, [], true),
  };
}

function needsFollowup(
  command: GitNexusCommand,
  parsed: ParsedArgs,
  ctx: GitNexusCommandContext,
  requests: GitNexusRequest[],
  summary: string,
): GitNexusCommandResult {
  return {
    command,
    status: 'needs_followup',
    summary,
    remediation: ANALYZE_REMEDIATION,
    artifact: defaultArtifact(command, parsed, ctx, requests, true),
  };
}

function runDeathCrystal(args: readonly string[], ctx: GitNexusCommandContext): GitNexusCommandResult {
  const parsed = parseArgs(args);
  if (!parsed.target) {
    return failed(
      'death-crystal',
      parsed,
      ctx,
      'No symbol target was provided.',
      'Pass a symbol name, for example `/death-crystal validateUser`.',
    );
  }

  const requests: GitNexusRequest[] = [
    {
      tool: 'gitnexus_impact',
      args: {
        target: parsed.target,
        direction: 'upstream',
        maxDepth: 3,
      },
    },
    {
      tool: 'gitnexus_query',
      args: {
        query: `execution flows and dependencies for ${parsed.target}`,
      },
    },
  ];

  if (needsAnalyze(ctx.gitnexusResponse)) {
    return needsFollowup(
      'death-crystal',
      parsed,
      ctx,
      requests,
      'GitNexus index is stale or missing; impact prediction was not produced.',
    );
  }

  return {
    command: 'death-crystal',
    status: 'success',
    summary: `Prepared GitNexus impact requests for ${parsed.target}.`,
    artifact: defaultArtifact('death-crystal', parsed, ctx, requests, false),
  };
}

function skeletonCommand(
  command: GitNexusCommand,
  args: readonly string[],
  ctx: GitNexusCommandContext,
  summary: string,
  request: GitNexusRequest | null,
): GitNexusCommandResult {
  const parsed = parseArgs(args);
  const requests = request ? [request] : [];
  if (needsAnalyze(ctx.gitnexusResponse)) {
    return needsFollowup(command, parsed, ctx, requests, 'GitNexus index is stale or missing; refresh is required before analysis.');
  }
  return {
    command,
    status: 'success',
    summary,
    artifact: defaultArtifact(command, parsed, ctx, requests, true),
  };
}

export function runGitNexusCommandGroup(
  command: GitNexusCommand,
  args: readonly string[] = [],
  ctx: GitNexusCommandContext = {},
): GitNexusCommandResult {
  switch (command) {
    case 'death-crystal':
      return runDeathCrystal(args, ctx);
    case 'portal-fluid': {
      const parsed = parseArgs(args);
      return skeletonCommand(
        command,
        args,
        ctx,
        'Dependency graph artifact skeleton is ready.',
        parsed.target
          ? { tool: 'gitnexus_query', args: { query: `dependency graph for ${parsed.target}` } }
          : null,
      );
    }
    case 'operation-phoenix': {
      const parsed = parseArgs(args);
      return skeletonCommand(
        command,
        args,
        ctx,
        'Clone analysis artifact skeleton is ready.',
        parsed.target
          ? { tool: 'gitnexus_query', args: { query: `duplicate or clone candidates for ${parsed.target}` } }
          : null,
      );
    }
    case 'blips-and-chitz': {
      const parsed = parseArgs(args);
      return skeletonCommand(
        command,
        args,
        ctx,
        'Coverage analysis artifact skeleton is ready.',
        parsed.target
          ? { tool: 'gitnexus_query', args: { query: `coverage gaps for ${parsed.target}` } }
          : null,
      );
    }
  }
}

export function runGitNexusCommandGroupByName(
  command: string,
  args: readonly string[] = [],
  ctx: GitNexusCommandContext = {},
): GitNexusCommandResult {
  if (!isGitNexusCommand(command)) {
    const parsed = parseArgs(args);
    return {
      command: 'death-crystal',
      status: 'failed',
      summary: `Unknown GitNexus command: ${command}`,
      remediation: `Use one of: ${COMMANDS.join(', ')}.`,
      artifact: defaultArtifact('death-crystal', parsed, ctx, [], true),
    };
  }
  return runGitNexusCommandGroup(command, args, ctx);
}

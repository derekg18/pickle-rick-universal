import * as fs from 'fs';
import * as path from 'path';

export type RuntimeObservabilityCommand =
  | 'interdimensional-cable'
  | 'mr-poopybutthole'
  | 'glorzo'
  | 'galactic-federation'
  | 'ghost-in-a-jar';

export type PickleCommandStatus = 'success' | 'failed';

export interface PickleCommandResult {
  command: RuntimeObservabilityCommand;
  status: PickleCommandStatus;
  summary: string;
  remediation?: string;
  pane_config?: RuntimePaneConfig[];
  artifact?: RuntimeSummaryArtifact;
  companion?: RuntimeCompanionResult;
  focus?: RuntimeFocusResult;
  audit?: RuntimeAuditResult;
  persistence?: RuntimePersistenceResult;
}

export interface RuntimePaneConfig {
  service: string;
  channel: string;
  source: string;
  mode: 'fake-log-tail';
  supervised: boolean;
  preview: string[];
}

export interface RuntimeSummaryArtifact {
  kind: 'runtime-observability-summary';
  workspace_dir: string | null;
  session_dir: string | null;
  generated_at: string;
  commands: RuntimeObservabilityCommand[];
}

export interface RuntimeCompanionResult {
  role: 'companion';
  session_dir: string;
  activity_source: string;
}

export interface RuntimeFocusResult {
  role: 'focus';
  workspace_dir: string;
  focus: string;
}

export interface RuntimeAuditResult {
  role: 'audit';
  workspace_dir: string;
  checks: string[];
}

export interface RuntimePersistenceResult {
  role: 'persistence';
  skeleton_only: true;
  action: 'none';
  started: false;
}

export interface RuntimeObservabilityContext {
  workspaceDir?: string;
  sessionDir?: string;
  now?: Date;
  fileExists?: (filePath: string) => boolean;
  readTextFile?: (filePath: string) => string;
  startPersistence?: () => void;
}

interface LogSpec {
  service: string;
  source: string;
}

type RuntimeResultPayload = Omit<PickleCommandResult, 'command' | 'status' | 'summary' | 'remediation' | 'artifact'>;

const COMMANDS: readonly RuntimeObservabilityCommand[] = [
  'interdimensional-cable',
  'mr-poopybutthole',
  'glorzo',
  'galactic-federation',
  'ghost-in-a-jar',
];

function isRuntimeObservabilityCommand(value: string): value is RuntimeObservabilityCommand {
  return (COMMANDS as readonly string[]).includes(value);
}

function defaultArtifact(
  command: RuntimeObservabilityCommand,
  ctx: RuntimeObservabilityContext,
): RuntimeSummaryArtifact {
  return {
    kind: 'runtime-observability-summary',
    workspace_dir: ctx.workspaceDir ?? null,
    session_dir: ctx.sessionDir ?? null,
    generated_at: (ctx.now ?? new Date()).toISOString(),
    commands: [command],
  };
}

function splitLogTokens(args: readonly string[]): string[] {
  const tokens: string[] = [];
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

export function parseRuntimeLogSpecs(args: readonly string[]): LogSpec[] {
  return splitLogTokens(args).flatMap((token) => {
    const separator = token.indexOf('=');
    if (separator <= 0 || separator === token.length - 1) return [];
    const service = token.slice(0, separator).trim();
    const source = token.slice(separator + 1).trim();
    return service && source ? [{ service, source }] : [];
  });
}

function readPreview(filePath: string, ctx: RuntimeObservabilityContext): string[] {
  const text = ctx.readTextFile
    ? ctx.readTextFile(filePath)
    : fs.readFileSync(filePath, 'utf-8');
  return text.split(/\r?\n/).filter(Boolean).slice(0, 5);
}

function failed(
  command: RuntimeObservabilityCommand,
  summary: string,
  remediation: string,
  ctx: RuntimeObservabilityContext,
): PickleCommandResult {
  return {
    command,
    status: 'failed',
    summary,
    remediation,
    artifact: defaultArtifact(command, ctx),
  };
}

function succeeded(
  command: RuntimeObservabilityCommand,
  summary: string,
  ctx: RuntimeObservabilityContext,
  payload: RuntimeResultPayload = {},
): PickleCommandResult {
  return {
    command,
    status: 'success',
    summary,
    ...payload,
    artifact: defaultArtifact(command, ctx),
  };
}

function runInterdimensionalCable(
  args: readonly string[],
  ctx: RuntimeObservabilityContext,
): PickleCommandResult {
  const specs = parseRuntimeLogSpecs(args);
  if (specs.length === 0) {
    return failed(
      'interdimensional-cable',
      'No service log specs were provided.',
      'Pass one or more log specs as service=/path/to/log, separated by spaces or commas.',
      ctx,
    );
  }

  const exists = ctx.fileExists ?? fs.existsSync;
  const missing = specs.filter((spec) => !exists(spec.source));
  if (missing.length > 0) {
    return failed(
      'interdimensional-cable',
      `Missing log source for ${missing.map((spec) => spec.service).join(', ')}.`,
      'Create the log file or pass a valid service=/path/to/log source.',
      ctx,
    );
  }

  const pane_config = specs.map((spec): RuntimePaneConfig => ({
    service: spec.service,
    channel: `logs:${spec.service}`,
    source: path.resolve(spec.source),
    mode: 'fake-log-tail',
    supervised: true,
    preview: readPreview(spec.source, ctx),
  }));

  return succeeded(
    'interdimensional-cable',
    `Supervising ${pane_config.length} service log stream${pane_config.length === 1 ? '' : 's'}.`,
    ctx,
    { pane_config },
  );
}

function requireSession(
  command: RuntimeObservabilityCommand,
  ctx: RuntimeObservabilityContext,
): string | PickleCommandResult {
  if (ctx.sessionDir) return ctx.sessionDir;
  return failed(
    command,
    'No session source was provided.',
    'Run from an active Pickle session or pass a session directory in the command context.',
    ctx,
  );
}

function runCompanion(ctx: RuntimeObservabilityContext): PickleCommandResult {
  const sessionDir = requireSession('mr-poopybutthole', ctx);
  if (typeof sessionDir !== 'string') return sessionDir;
  return succeeded('mr-poopybutthole', 'Companion runtime session summary is ready.', ctx, {
    companion: {
      role: 'companion',
      session_dir: sessionDir,
      activity_source: path.join(sessionDir, 'activity.jsonl'),
    },
  });
}

function runFocus(args: readonly string[], ctx: RuntimeObservabilityContext): PickleCommandResult {
  const workspaceDir = ctx.workspaceDir;
  if (!workspaceDir) {
    return failed(
      'glorzo',
      'No workspace source was provided.',
      'Run from a workspace or pass a workspace directory in the command context.',
      ctx,
    );
  }
  const focus = args.find((arg) => !arg.startsWith('--')) ?? 'runtime';
  return succeeded('glorzo', `Focus runtime view prepared for ${focus}.`, ctx, {
    focus: {
      role: 'focus',
      workspace_dir: workspaceDir,
      focus,
    },
  });
}

function runAudit(ctx: RuntimeObservabilityContext): PickleCommandResult {
  const workspaceDir = ctx.workspaceDir;
  if (!workspaceDir) {
    return failed(
      'galactic-federation',
      'No workspace source was provided.',
      'Run from a workspace or pass a workspace directory in the command context.',
      ctx,
    );
  }
  return succeeded('galactic-federation', 'Runtime audit skeleton is ready.', ctx, {
    audit: {
      role: 'audit',
      workspace_dir: workspaceDir,
      checks: ['process-source', 'log-source', 'session-summary'],
    },
  });
}

function runGhost(ctx: RuntimeObservabilityContext): PickleCommandResult {
  return succeeded('ghost-in-a-jar', 'Persistence command is skeleton-only in v1.', ctx, {
    persistence: {
      role: 'persistence',
      skeleton_only: true,
      action: 'none',
      started: false,
    },
  });
}

export function runRuntimeObservabilityCommand(
  command: RuntimeObservabilityCommand,
  args: readonly string[] = [],
  ctx: RuntimeObservabilityContext = {},
): PickleCommandResult {
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

export function runRuntimeObservabilityCommandByName(
  command: string,
  args: readonly string[] = [],
  ctx: RuntimeObservabilityContext = {},
): PickleCommandResult {
  if (!isRuntimeObservabilityCommand(command)) {
    return failed(
      'galactic-federation',
      `Unknown runtime observability command: ${command}`,
      `Use one of: ${COMMANDS.join(', ')}.`,
      ctx,
    );
  }
  return runRuntimeObservabilityCommand(command, args, ctx);
}

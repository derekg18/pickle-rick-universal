export type PerformanceFrontendCommand =
  | 'get-schwifty'
  | 'tiny-rick'
  | 'time-crystal'
  | 'rickmobile'
  | 'ants-in-my-eyes-johnson';

export type PerformanceFrontendStatus = 'success' | 'needs_followup' | 'failed';

export type PerformanceFrontendReportKind =
  | 'benchmark-plan'
  | 'build-optimization-plan'
  | 'bundle-report-plan'
  | 'mobile-audit-plan'
  | 'accessibility-audit-plan';

export type PerformanceFrontendTool = 'autocannon' | 'npm' | 'lighthouse' | 'playwright' | 'axe';

export interface PerformanceFrontendContext {
  workspaceDir?: string;
  now?: Date;
  reportDir?: string;
  changedFiles?: readonly string[];
  availableTools?: readonly PerformanceFrontendTool[];
  startLoadTest?: (target: string) => void;
  runAudit?: (target: string) => void;
}

export interface MetricRow {
  name: string;
  unit: string;
  source: string;
  threshold: number | null;
}

export interface ReportArtifact {
  kind: PerformanceFrontendReportKind;
  command: PerformanceFrontendCommand;
  workspace_dir: string | null;
  generated_at: string;
  app_path: string;
  target: string | null;
  report_path: string;
  metrics: MetricRow[];
  deterministic: true;
  started_external_actions: [];
}

export interface BenchmarkPlan {
  role: 'benchmark-plan';
  target: string;
  plan: readonly string[];
  load_test_started: false;
}

export interface BuildOptimizationPlan {
  role: 'build-optimization';
  changed_files: readonly string[];
  build_set: readonly string[];
  skipped: readonly string[];
}

export interface AuditMatrixRow {
  viewport: string;
  width: number;
  height: number;
  audits: readonly string[];
}

export interface FrontendAuditPlan {
  role: 'frontend-audit';
  target: string;
  matrix: readonly AuditMatrixRow[];
}

export interface ToolRemediation {
  code: 'MISSING_EXTERNAL_TOOL';
  tool: PerformanceFrontendTool;
  install_command: string;
}

export interface PerformanceFrontendResult {
  command: PerformanceFrontendCommand;
  status: PerformanceFrontendStatus;
  summary: string;
  artifact: ReportArtifact;
  remediation?: string;
  followup?: ToolRemediation;
  benchmark?: BenchmarkPlan;
  build?: BuildOptimizationPlan;
  audit?: FrontendAuditPlan;
}

interface ParsedArgs {
  appPath: string;
  target: string | null;
  viewports: AuditMatrixRow[];
  externalTargetExplicit: boolean;
}

interface ParseState {
  appPath: string;
  target: string | null;
  externalTargetExplicit: boolean;
  viewportRows: AuditMatrixRow[];
  positional: string[];
}

interface ConsumeResult {
  nextIndex: number;
  error?: PerformanceFrontendResult;
}

const COMMANDS: readonly PerformanceFrontendCommand[] = [
  'get-schwifty',
  'tiny-rick',
  'time-crystal',
  'rickmobile',
  'ants-in-my-eyes-johnson',
];

const DEFAULT_VIEWPORTS: readonly AuditMatrixRow[] = [
  { viewport: 'mobile', width: 390, height: 844, audits: ['layout', 'performance'] },
  { viewport: 'desktop', width: 1440, height: 900, audits: ['layout', 'performance'] },
];

const TOOL_INSTALL_COMMANDS: Record<PerformanceFrontendTool, string> = {
  autocannon: 'npm install --save-dev autocannon',
  npm: 'Install Node.js and npm, then run npm install in the app workspace.',
  lighthouse: 'npm install --save-dev lighthouse',
  playwright: 'npm install --save-dev @playwright/test && npx playwright install',
  axe: 'npm install --save-dev @axe-core/playwright',
};

function isPerformanceFrontendCommand(value: string): value is PerformanceFrontendCommand {
  return (COMMANDS as readonly string[]).includes(value);
}

function slug(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return normalized || 'workspace';
}

function isExternalUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function requiredTool(command: PerformanceFrontendCommand): PerformanceFrontendTool {
  switch (command) {
    case 'get-schwifty':
      return 'autocannon';
    case 'tiny-rick':
    case 'time-crystal':
      return 'npm';
    case 'rickmobile':
      return 'lighthouse';
    case 'ants-in-my-eyes-johnson':
      return 'axe';
  }
}

function reportKind(command: PerformanceFrontendCommand): PerformanceFrontendReportKind {
  switch (command) {
    case 'get-schwifty':
      return 'benchmark-plan';
    case 'tiny-rick':
      return 'build-optimization-plan';
    case 'time-crystal':
      return 'bundle-report-plan';
    case 'rickmobile':
      return 'mobile-audit-plan';
    case 'ants-in-my-eyes-johnson':
      return 'accessibility-audit-plan';
  }
}

function parseViewport(value: string): AuditMatrixRow | null {
  const [namePart, sizePart] = value.split('=');
  const size = sizePart ?? namePart;
  const match = /^(\d{2,5})x(\d{2,5})$/i.exec(size.trim());
  if (!match) return null;
  const width = parsePositiveInteger(match[1]);
  const height = parsePositiveInteger(match[2]);
  if (width === null || height === null) return null;
  const viewport = sizePart ? namePart.trim() : `${width}x${height}`;
  return {
    viewport: viewport || `${width}x${height}`,
    width,
    height,
    audits: ['layout', 'performance'],
  };
}

function parsePositiveInteger(value: string): number | null {
  const raw = Number(value);
  if (!Number.isFinite(raw) || !Number.isSafeInteger(raw) || raw <= 0) return null;
  return raw;
}

function appendViewportRows(value: string, viewportRows: AuditMatrixRow[]): PerformanceFrontendResult | null {
  for (const viewport of value.split(',')) {
    const parsed = parseViewport(viewport);
    if (!parsed) return invalidViewportResult(viewport);
    viewportRows.push(parsed);
  }
  return null;
}

function flagValue(arg: string, prefix: string): string | null {
  return arg.startsWith(prefix) ? arg.slice(prefix.length) : null;
}

export function parsePerformanceFrontendArgs(args: readonly string[]): ParsedArgs | PerformanceFrontendResult {
  const state: ParseState = {
    appPath: '.',
    target: null,
    externalTargetExplicit: false,
    viewportRows: [],
    positional: [],
  };

  for (let index = 0; index < args.length; index++) {
    const consumed = consumeAppArg(args, index, state)
      ?? consumeTargetArg(args, index, state)
      ?? consumeViewportArg(args, index, state);
    if (consumed?.error) return consumed.error;
    if (consumed) {
      index = consumed.nextIndex;
      continue;
    }
    if (!args[index].startsWith('--')) state.positional.push(args[index]);
  }

  if (!state.target && state.positional.length > 0) state.target = state.positional.join(' ');

  return {
    appPath: state.appPath,
    target: state.target,
    externalTargetExplicit: state.externalTargetExplicit,
    viewports: state.viewportRows.length > 0 ? state.viewportRows : [...DEFAULT_VIEWPORTS],
  };
}

function consumeAppArg(args: readonly string[], index: number, state: ParseState): ConsumeResult | null {
  const arg = args[index];
  if ((arg === '--app' || arg === '--app-path') && args[index + 1]) {
    state.appPath = args[index + 1];
    return { nextIndex: index + 1 };
  }
  const inlineApp = flagValue(arg, '--app=') ?? flagValue(arg, '--app-path=');
  if (inlineApp === null) return null;
  state.appPath = inlineApp;
  return { nextIndex: index };
}

function consumeTargetArg(args: readonly string[], index: number, state: ParseState): ConsumeResult | null {
  const arg = args[index];
  if ((arg === '--target' || arg === '--url') && args[index + 1]) {
    state.target = args[index + 1];
    state.externalTargetExplicit = true;
    return { nextIndex: index + 1 };
  }
  if (flagValue(arg, '--target=') === null && flagValue(arg, '--url=') === null) return null;
  state.target = arg.slice(arg.indexOf('=') + 1);
  state.externalTargetExplicit = true;
  return { nextIndex: index };
}

function consumeViewportArg(args: readonly string[], index: number, state: ParseState): ConsumeResult | null {
  const arg = args[index];
  if ((arg === '--viewport' || arg === '--viewports') && args[index + 1]) {
    return consumeViewportValue(args[index + 1], state, index + 1);
  }
  if (flagValue(arg, '--viewport=') === null && flagValue(arg, '--viewports=') === null) return null;
  return consumeViewportValue(arg.slice(arg.indexOf('=') + 1), state, index);
}

function consumeViewportValue(value: string, state: ParseState, nextIndex: number): ConsumeResult {
  const invalid = appendViewportRows(value, state.viewportRows);
  return invalid ? { nextIndex, error: invalid } : { nextIndex };
}

function invalidViewportResult(value: string): PerformanceFrontendResult {
  const parsed = {
    appPath: '.',
    target: null,
    viewports: [...DEFAULT_VIEWPORTS],
    externalTargetExplicit: false,
  };
  return {
    command: 'rickmobile',
    status: 'failed',
    summary: `Invalid viewport "${value}".`,
    remediation: 'Use viewport dimensions as <name>=<width>x<height> or <width>x<height>.',
    artifact: defaultArtifact('rickmobile', parsed, {}, []),
  };
}

function defaultArtifact(
  command: PerformanceFrontendCommand,
  parsed: ParsedArgs,
  ctx: PerformanceFrontendContext,
  metrics: MetricRow[],
): ReportArtifact {
  const reportDir = ctx.reportDir ?? 'reports/pickle';
  const targetSlug = slug(parsed.target ?? parsed.appPath);
  return {
    kind: reportKind(command),
    command,
    workspace_dir: ctx.workspaceDir ?? null,
    generated_at: (ctx.now ?? new Date()).toISOString(),
    app_path: parsed.appPath,
    target: parsed.target,
    report_path: `${reportDir}/${command}-${targetSlug}.json`,
    metrics,
    deterministic: true,
    started_external_actions: [],
  };
}

export function metric(name: string, unit: string, source: string, threshold: number | null = null): MetricRow {
  return { name, unit, source, threshold };
}

function missingTool(
  command: PerformanceFrontendCommand,
  parsed: ParsedArgs,
  ctx: PerformanceFrontendContext,
  tool: PerformanceFrontendTool,
  metrics: MetricRow[],
): PerformanceFrontendResult {
  return {
    command,
    status: 'needs_followup',
    summary: `/${command} requires ${tool} before a report plan can be completed.`,
    remediation: TOOL_INSTALL_COMMANDS[tool],
    followup: {
      code: 'MISSING_EXTERNAL_TOOL',
      tool,
      install_command: TOOL_INSTALL_COMMANDS[tool],
    },
    artifact: defaultArtifact(command, parsed, ctx, metrics),
  };
}

function hasRequiredTool(command: PerformanceFrontendCommand, ctx: PerformanceFrontendContext): boolean {
  const tools = ctx.availableTools;
  if (!tools) return true;
  return tools.includes(requiredTool(command));
}

function fixtureChangedFiles(ctx: PerformanceFrontendContext): readonly string[] {
  return ctx.changedFiles ?? [];
}

function buildSet(changedFiles: readonly string[]): readonly string[] {
  const scopes = new Set<string>();
  for (const file of changedFiles) {
    if (file.startsWith('src/') || file.startsWith('app/') || file.startsWith('pages/')) scopes.add('app');
    if (file.includes('package.json') || file.includes('vite.config') || file.includes('next.config')) scopes.add('build-config');
    if (file.endsWith('.css') || file.endsWith('.scss')) scopes.add('styles');
  }
  return [...scopes].sort();
}

function skippedSet(changedFiles: readonly string[]): readonly string[] {
  const build = new Set(buildSet(changedFiles));
  return ['app', 'build-config', 'styles'].filter((scope) => !build.has(scope));
}

export function runPerformanceFrontendCommand(
  command: PerformanceFrontendCommand,
  args: readonly string[] = [],
  ctx: PerformanceFrontendContext = {},
): PerformanceFrontendResult {
  const parsed = parsePerformanceFrontendArgs(args);
  if ('status' in parsed) return { ...parsed, command };

  const metrics = metricsForCommand(command);
  if (!hasRequiredTool(command, ctx)) {
    return missingTool(command, parsed, ctx, requiredTool(command), metrics);
  }

  if (command === 'get-schwifty' && parsed.target && isExternalUrl(parsed.target) && !parsed.externalTargetExplicit) {
    return {
      command,
      status: 'needs_followup',
      summary: 'External URL load-test target was not explicit, so no load test was started.',
      remediation: 'Pass the external URL with --target or --url after confirming the target is authorized.',
      artifact: defaultArtifact(command, parsed, ctx, metrics),
    };
  }

  switch (command) {
    case 'get-schwifty':
      return runBenchmarkPlan(command, parsed, ctx, metrics);
    case 'tiny-rick':
    case 'time-crystal':
      return runBuildPlan(command, parsed, ctx, metrics);
    case 'rickmobile':
    case 'ants-in-my-eyes-johnson':
      return runAuditPlan(command, parsed, ctx, metrics);
  }
}

function runBenchmarkPlan(
  command: PerformanceFrontendCommand,
  parsed: ParsedArgs,
  ctx: PerformanceFrontendContext,
  metrics: MetricRow[],
): PerformanceFrontendResult {
  const target = parsed.target ?? parsed.appPath;
  return {
    command,
    status: 'success',
    summary: `Benchmark report plan emitted for ${target}.`,
    benchmark: {
      role: 'benchmark-plan',
      target,
      plan: ['resolve target', 'capture baseline metrics', 'write benchmark report artifact'],
      load_test_started: false,
    },
    artifact: defaultArtifact(command, parsed, ctx, metrics),
  };
}

function runBuildPlan(
  command: PerformanceFrontendCommand,
  parsed: ParsedArgs,
  ctx: PerformanceFrontendContext,
  metrics: MetricRow[],
): PerformanceFrontendResult {
  const changed_files = fixtureChangedFiles(ctx);
  return {
    command,
    status: 'success',
    summary: `Build report plan emitted with ${changed_files.length} changed file fixture${changed_files.length === 1 ? '' : 's'}.`,
    build: {
      role: 'build-optimization',
      changed_files,
      build_set: buildSet(changed_files),
      skipped: skippedSet(changed_files),
    },
    artifact: defaultArtifact(command, parsed, ctx, metrics),
  };
}

function runAuditPlan(
  command: PerformanceFrontendCommand,
  parsed: ParsedArgs,
  ctx: PerformanceFrontendContext,
  metrics: MetricRow[],
): PerformanceFrontendResult {
  const target = parsed.target ?? parsed.appPath;
  const audits = command === 'ants-in-my-eyes-johnson' ? ['accessibility', 'keyboard', 'contrast'] : ['layout', 'performance'];
  return {
    command,
    status: 'success',
    summary: `Frontend audit matrix emitted for ${target}.`,
    audit: {
      role: 'frontend-audit',
      target,
      matrix: parsed.viewports.map((viewport) => ({ ...viewport, audits })),
    },
    artifact: defaultArtifact(command, parsed, ctx, metrics),
  };
}

function metricsForCommand(command: PerformanceFrontendCommand): MetricRow[] {
  switch (command) {
    case 'get-schwifty':
      return [
        metric('requests_per_second', 'rps', 'fixture-target', null),
        metric('p95_latency', 'ms', 'fixture-target', 500),
      ];
    case 'tiny-rick':
      return [
        metric('build_scope_count', 'count', 'changed-file-fixture', null),
        metric('skipped_scope_count', 'count', 'changed-file-fixture', null),
      ];
    case 'time-crystal':
      return [
        metric('bundle_size', 'bytes', 'bundle-fixture', null),
        metric('bundle_delta', 'bytes', 'bundle-fixture', 0),
      ];
    case 'rickmobile':
      return [
        metric('viewport_count', 'count', 'viewport-fixture', null),
        metric('largest_contentful_paint', 'ms', 'audit-fixture', 2500),
      ];
    case 'ants-in-my-eyes-johnson':
      return [
        metric('a11y_violations', 'count', 'audit-fixture', 0),
        metric('keyboard_paths', 'count', 'audit-fixture', null),
      ];
  }
}

export function runPerformanceFrontendCommandByName(
  command: string,
  args: readonly string[] = [],
  ctx: PerformanceFrontendContext = {},
): PerformanceFrontendResult {
  if (!isPerformanceFrontendCommand(command)) {
    const parsed = {
      appPath: '.',
      target: null,
      viewports: [...DEFAULT_VIEWPORTS],
      externalTargetExplicit: false,
    };
    return {
      command: 'get-schwifty',
      status: 'failed',
      summary: `Unknown performance/frontend command: ${command}`,
      remediation: `Use one of: ${COMMANDS.join(', ')}.`,
      artifact: defaultArtifact('get-schwifty', parsed, ctx, []),
    };
  }
  return runPerformanceFrontendCommand(command, args, ctx);
}

import * as fs from 'fs';
import * as path from 'path';

export type QualityRefactorCommand =
  | 'squanch'
  | 'simple-rick'
  | 'memory-parasites'
  | 'jerry-detector'
  | 'detoxifier'
  | 'doofus-rick';

export type PickleCommandStatus = 'success' | 'failed';

export interface QualityRefactorContext {
  workspaceDir?: string;
  now?: Date;
  fileExists?: (filePath: string) => boolean;
  readTextFile?: (filePath: string) => string;
  writeTextFile?: (filePath: string, text: string) => void;
  mkdir?: (dirPath: string) => void;
}

export interface QualityRefactorArtifact {
  kind: 'quality-refactor-preview';
  command: QualityRefactorCommand;
  target: string;
  preview_only: boolean;
  preview_path: string;
  rollback_path: string;
  generated_at: string;
}

export interface SuggestedChange {
  file: string;
  line?: number;
  summary: string;
  before?: string;
  after?: string;
}

export interface QualityRefactorPreview {
  mode: 'preview';
  dry_run: true;
  apply_requested: boolean;
  suggested_changes: SuggestedChange[];
}

export interface QualityRefactorResult {
  command: QualityRefactorCommand;
  status: PickleCommandStatus;
  summary: string;
  remediation?: string;
  preview?: QualityRefactorPreview;
  artifact?: QualityRefactorArtifact;
}

interface ParsedArgs {
  target?: string;
  pattern?: string;
  replacement?: string;
  apply: boolean;
  confirmApply: boolean;
}

interface AnalyzedTarget {
  absolutePath: string;
  files: string[];
}

const COMMANDS: readonly QualityRefactorCommand[] = [
  'squanch',
  'simple-rick',
  'memory-parasites',
  'jerry-detector',
  'detoxifier',
  'doofus-rick',
];

const COMMAND_SUMMARIES: Record<Exclude<QualityRefactorCommand, 'squanch'>, string> = {
  'simple-rick': 'Simplicity analysis preview is ready.',
  'memory-parasites': 'Dead-code analysis preview is ready.',
  'jerry-detector': 'Technical-debt analysis preview is ready.',
  detoxifier: 'Cleanup analysis preview is ready.',
  'doofus-rick': 'Explainer analysis preview is ready.',
};

export function isQualityRefactorCommand(value: string): value is QualityRefactorCommand {
  return (COMMANDS as readonly string[]).includes(value);
}

function optionValue(args: readonly string[], index: number, name: string): string | undefined {
  const arg = args[index];
  if (arg === name) return args[index + 1];
  if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  return undefined;
}

export function parseQualityRefactorArgs(args: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    apply: false,
    confirmApply: false,
  };
  const positional: string[] = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--apply') {
      parsed.apply = true;
      continue;
    }
    if (arg === '--confirm-apply') {
      parsed.confirmApply = true;
      continue;
    }

    const target = optionValue(args, index, '--target') ?? optionValue(args, index, '--path');
    if (target !== undefined) {
      parsed.target = target;
      if (arg === '--target' || arg === '--path') index++;
      continue;
    }

    const pattern = optionValue(args, index, '--pattern') ?? optionValue(args, index, '--regex');
    if (pattern !== undefined) {
      parsed.pattern = pattern;
      if (arg === '--pattern' || arg === '--regex') index++;
      continue;
    }

    const replacement = optionValue(args, index, '--replacement') ?? optionValue(args, index, '--replace');
    if (replacement !== undefined) {
      parsed.replacement = replacement;
      if (arg === '--replacement' || arg === '--replace') index++;
      continue;
    }

    if (!arg.startsWith('--')) positional.push(arg);
  }

  if (!parsed.target && positional.length > 0) parsed.target = positional[0];
  if (!parsed.pattern && positional.length > 1) parsed.pattern = positional[1];
  if (parsed.replacement === undefined && positional.length > 2) parsed.replacement = positional[2];
  return parsed;
}

function failed(
  command: QualityRefactorCommand,
  summary: string,
  remediation: string,
): QualityRefactorResult {
  return {
    command,
    status: 'failed',
    summary,
    remediation,
  };
}

function ensurePreviewMode(command: QualityRefactorCommand, parsed: ParsedArgs): QualityRefactorResult | null {
  if (parsed.apply && !parsed.confirmApply) {
    return failed(
      command,
      'Destructive apply was requested without confirmation.',
      'Re-run without --apply for a preview, or pass both --apply and --confirm-apply after reviewing the preview and rollback artifact.',
    );
  }
  return null;
}

function safeStamp(ctx: QualityRefactorContext): string {
  return (ctx.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
}

function resolveTarget(command: QualityRefactorCommand, parsed: ParsedArgs, ctx: QualityRefactorContext): AnalyzedTarget | QualityRefactorResult {
  const rawTarget = parsed.target?.trim();
  if (!rawTarget) {
    return failed(
      command,
      'No target path was provided.',
      'Pass --target <file-or-directory> so the command can produce a bounded preview.',
    );
  }

  const workspace = ctx.workspaceDir ?? process.cwd();
  const absolutePath = path.resolve(workspace, rawTarget);
  const exists = ctx.fileExists ?? fs.existsSync;
  if (!exists(absolutePath)) {
    return failed(
      command,
      `Target path does not exist: ${rawTarget}`,
      'Pass an existing file or directory path. Preview mode never creates missing targets.',
    );
  }

  return {
    absolutePath,
    files: collectFiles(absolutePath),
  };
}

function collectFiles(targetPath: string): string[] {
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) return [targetPath];
  if (!stat.isDirectory()) return [];

  const ignored = new Set(['.git', 'node_modules', '.pickle']);
  const files: string[] = [];
  const stack = [targetPath];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  }
  return files.sort();
}

function readText(filePath: string, ctx: QualityRefactorContext): string | null {
  const text = ctx.readTextFile ? ctx.readTextFile(filePath) : fs.readFileSync(filePath, 'utf-8');
  return text.includes('\u0000') ? null : text;
}

function makeRegex(command: QualityRefactorCommand, pattern: string | undefined): RegExp | QualityRefactorResult {
  const trimmed = pattern?.trim();
  if (!trimmed) {
    return failed(
      command,
      'No search regex was provided.',
      'Pass --pattern <regex> and --replacement <text> to generate a search/replace preview.',
    );
  }
  if (trimmed === '.*' || trimmed === '.+' || trimmed === '^' || trimmed === '$') {
    return failed(
      command,
      `Unsafe search regex rejected: ${trimmed}`,
      'Use a narrower regex that cannot match every line or a zero-width position.',
    );
  }
  try {
    const regex = new RegExp(trimmed, 'g');
    if (regex.test('')) {
      return failed(
        command,
        `Unsafe search regex rejected: ${trimmed}`,
        'Use a regex that cannot match empty strings.',
      );
    }
    return new RegExp(trimmed, 'g');
  } catch (err) {
    return failed(
      command,
      `Invalid search regex: ${String(err instanceof Error ? err.message : err)}`,
      'Fix the regular expression syntax and re-run in preview mode.',
    );
  }
}

function lineNumberForIndex(text: string, index: number): number {
  return text.slice(0, index).split(/\r?\n/).length;
}

function artifactDir(ctx: QualityRefactorContext): string {
  return path.join(ctx.workspaceDir ?? process.cwd(), '.pickle', 'quality-refactor');
}

function writeArtifacts(
  command: QualityRefactorCommand,
  target: AnalyzedTarget,
  preview: QualityRefactorPreview,
  rollbackEntries: Record<string, string>,
  ctx: QualityRefactorContext,
): QualityRefactorArtifact {
  const dir = artifactDir(ctx);
  const mkdir = ctx.mkdir ?? ((dirPath: string) => fs.mkdirSync(dirPath, { recursive: true }));
  const write = ctx.writeTextFile ?? ((filePath: string, text: string) => fs.writeFileSync(filePath, text));
  mkdir(dir);

  const stamp = safeStamp(ctx);
  const basename = `${command}-${stamp}`;
  const previewPath = path.join(dir, `${basename}.preview.json`);
  const rollbackPath = path.join(dir, `${basename}.rollback.json`);
  const generatedAt = (ctx.now ?? new Date()).toISOString();
  const artifact: QualityRefactorArtifact = {
    kind: 'quality-refactor-preview',
    command,
    target: target.absolutePath,
    preview_only: true,
    preview_path: previewPath,
    rollback_path: rollbackPath,
    generated_at: generatedAt,
  };

  write(previewPath, `${JSON.stringify({ artifact, preview }, null, 2)}\n`);
  write(rollbackPath, `${JSON.stringify({
    command,
    target: target.absolutePath,
    generated_at: generatedAt,
    entries: rollbackEntries,
  }, null, 2)}\n`);
  return artifact;
}

function runSquanch(parsed: ParsedArgs, ctx: QualityRefactorContext): QualityRefactorResult {
  const regex = makeRegex('squanch', parsed.pattern);
  if (!(regex instanceof RegExp)) return regex;
  const target = resolveTarget('squanch', parsed, ctx);
  if ('status' in target) return target;

  const replacement = parsed.replacement ?? '';
  const suggestedChanges: SuggestedChange[] = [];
  const rollbackEntries: Record<string, string> = {};

  for (const file of target.files) {
    const text = readText(file, ctx);
    if (text === null) continue;
    regex.lastIndex = 0;
    let match = regex.exec(text);
    while (match) {
      const before = match[0];
      const after = before.replace(new RegExp(regex.source), replacement);
      suggestedChanges.push({
        file,
        line: lineNumberForIndex(text, match.index),
        summary: `Replace ${JSON.stringify(before)} with ${JSON.stringify(after)}.`,
        before,
        after,
      });
      rollbackEntries[file] = text;
      match = regex.exec(text);
    }
  }

  const preview: QualityRefactorPreview = {
    mode: 'preview',
    dry_run: true,
    apply_requested: parsed.apply,
    suggested_changes: suggestedChanges,
  };
  const artifact = writeArtifacts('squanch', target, preview, rollbackEntries, ctx);
  return {
    command: 'squanch',
    status: 'success',
    summary: `Search/replace preview generated with ${suggestedChanges.length} suggested change${suggestedChanges.length === 1 ? '' : 's'}.`,
    preview,
    artifact,
  };
}

function runAnalysisCommand(command: Exclude<QualityRefactorCommand, 'squanch'>, parsed: ParsedArgs, ctx: QualityRefactorContext): QualityRefactorResult {
  const target = resolveTarget(command, parsed, ctx);
  if ('status' in target) return target;

  const suggestedChanges: SuggestedChange[] = target.files.slice(0, 25).map((file) => ({
    file,
    summary: analysisSummaryFor(command, file),
  }));
  const preview: QualityRefactorPreview = {
    mode: 'preview',
    dry_run: true,
    apply_requested: parsed.apply,
    suggested_changes: suggestedChanges,
  };
  const artifact = writeArtifacts(command, target, preview, {}, ctx);
  return {
    command,
    status: 'success',
    summary: COMMAND_SUMMARIES[command],
    preview,
    artifact,
  };
}

function analysisSummaryFor(command: QualityRefactorCommand, file: string): string {
  switch (command) {
    case 'simple-rick':
      return `Review ${file} for simpler control flow and smaller responsibilities.`;
    case 'memory-parasites':
      return `Review ${file} for unused exports, dead branches, and stale fixtures.`;
    case 'jerry-detector':
      return `Review ${file} for debt markers, fragile coupling, and unclear ownership.`;
    case 'detoxifier':
      return `Review ${file} for cleanup candidates that can be changed safely after preview.`;
    case 'doofus-rick':
      return `Prepare an explainer outline for ${file} without modifying it.`;
    case 'squanch':
      return `Preview regex replacements in ${file}.`;
  }
}

export function runQualityRefactorCommand(
  command: QualityRefactorCommand,
  args: readonly string[] = [],
  ctx: QualityRefactorContext = {},
): QualityRefactorResult {
  const parsed = parseQualityRefactorArgs(args);
  const applyError = ensurePreviewMode(command, parsed);
  if (applyError) return applyError;

  if (command === 'squanch') return runSquanch(parsed, ctx);
  return runAnalysisCommand(command, parsed, ctx);
}

export function runQualityRefactorCommandByName(
  command: string,
  args: readonly string[] = [],
  ctx: QualityRefactorContext = {},
): QualityRefactorResult {
  if (!isQualityRefactorCommand(command)) {
    return failed(
      'doofus-rick',
      `Unknown quality/refactor command: ${command}`,
      `Use one of: ${COMMANDS.join(', ')}.`,
    );
  }
  return runQualityRefactorCommand(command, args, ctx);
}

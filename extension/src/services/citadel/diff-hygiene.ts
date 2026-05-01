import { existsSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DiffSummary, ChangedFileSummary } from './diff-walker.js';

export type DiffHygieneSeverity = 'Critical' | 'High' | 'Medium';
export type SzechuanDiffHygienePriority = 'P0' | 'P1' | 'P2';
export type DiffHygieneRule =
  | 'root-markdown-orphan'
  | 'root-scratch-artifact'
  | 'env-file'
  | 'large-unignored-file';

export const ROOT_MARKDOWN_ALLOWLIST = new Set([
  'AGENTS.md',
  'CHANGELOG.md',
  'CLAUDE.md',
  'LICENSE.md',
  'README.md',
]);

export const LARGE_FILE_BYTES = 1024 * 1024;
export const ENV_FILE_ALLOWLIST = new Set(['.env.example']);

export interface DiffHygieneFinding {
  id: string;
  severity: DiffHygieneSeverity;
  message: string;
  rule: DiffHygieneRule;
  file: string;
  size_bytes?: number;
  category: 'hygiene';
}

export interface DiffHygieneReport {
  findings: DiffHygieneFinding[];
  summary: {
    added_files_scanned: number;
    findings: number;
    suppressed_by_szechuan: number;
  };
}

export interface SzechuanDiffHygieneFinding {
  id: string;
  priority: SzechuanDiffHygienePriority;
  severity: SzechuanDiffHygienePriority;
  message: string;
  rule: DiffHygieneRule;
  file: string;
  size_bytes?: number;
  category: 'hygiene';
  principle: 'Diff Hygiene';
}

export interface SzechuanDiffHygieneReport {
  findings: SzechuanDiffHygieneFinding[];
  summary: {
    added_files_scanned: number;
    findings: number;
  };
}

export interface SzechuanFindingLike {
  id?: unknown;
  category?: unknown;
  file?: unknown;
  path?: unknown;
  target?: unknown;
  evidence?: unknown;
  rule?: unknown;
}

export interface AuditDiffHygieneOptions {
  szechuanFindings?: SzechuanFindingLike[];
}

interface SuppressionIndex {
  ids: Set<string>;
  paths: Set<string>;
  pathRules: Set<string>;
}

export function auditDiffHygiene(
  diff: DiffSummary,
  options: AuditDiffHygieneOptions = {},
): DiffHygieneReport {
  const addedFiles = diff.changedFiles.filter((file) => file.status === 'A');
  const suppression = buildSuppressionIndex(options.szechuanFindings ?? []);
  const findings: DiffHygieneFinding[] = [];
  let suppressed = 0;

  for (const file of addedFiles) {
    for (const finding of findingsForAddedFile(diff.repoRoot, file)) {
      if (isSuppressed(finding, suppression)) {
        suppressed += 1;
      } else {
        findings.push(finding);
      }
    }
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule));
  return {
    findings,
    summary: {
      added_files_scanned: addedFiles.length,
      findings: findings.length,
      suppressed_by_szechuan: suppressed,
    },
  };
}

export function auditSzechuanDiffHygiene(diff: DiffSummary): SzechuanDiffHygieneReport {
  const addedFiles = diff.changedFiles.filter((file) => file.status === 'A');
  const findings = addedFiles.flatMap((file) => szechuanFindingsForAddedFile(diff.repoRoot, file));

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule));
  return {
    findings,
    summary: {
      added_files_scanned: addedFiles.length,
      findings: findings.length,
    },
  };
}

interface RuleMatch {
  file: string;
  rule: DiffHygieneRule;
  sizeBytes?: number;
}

function findingsForAddedFile(repoRoot: string, file: ChangedFileSummary): DiffHygieneFinding[] {
  return ruleMatchesForAddedFile(repoRoot, file)
    .map((match) => makeFinding(match.file, match.rule, citadelSeverityForRule(match.rule), match.sizeBytes));
}

function szechuanFindingsForAddedFile(repoRoot: string, file: ChangedFileSummary): SzechuanDiffHygieneFinding[] {
  return ruleMatchesForAddedFile(repoRoot, file)
    .map((match) => makeSzechuanFinding(
      match.file,
      match.rule,
      szechuanPriorityForRule(match.rule),
      match.sizeBytes,
    ));
}

function ruleMatchesForAddedFile(repoRoot: string, file: ChangedFileSummary): RuleMatch[] {
  const normalized = toPosixPath(file.path);
  const basename = path.posix.basename(normalized);
  const matches: RuleMatch[] = [];

  if (isEnvFile(basename)) {
    matches.push({ file: file.path, rule: 'env-file' });
  }

  if (isTopLevel(normalized)) {
    if (isDisallowedRootMarkdown(basename)) {
      matches.push({ file: file.path, rule: 'root-markdown-orphan' });
    }
    if (isRootScratchArtifact(basename)) {
      matches.push({ file: file.path, rule: 'root-scratch-artifact' });
    }
  }

  const size = fileSize(repoRoot, file.path);
  if (size > LARGE_FILE_BYTES && !isGitIgnored(repoRoot, file.path)) {
    matches.push({ file: file.path, rule: 'large-unignored-file', sizeBytes: size });
  }

  return matches;
}

function makeFinding(
  file: string,
  rule: DiffHygieneRule,
  severity: DiffHygieneSeverity,
  sizeBytes?: number,
): DiffHygieneFinding {
  return {
    id: `citadel-diff-hygiene-${slug(rule)}-${slug(file)}`,
    severity,
    message: messageForRule(rule, file, sizeBytes),
    rule,
    file,
    size_bytes: sizeBytes,
    category: 'hygiene',
  };
}

function makeSzechuanFinding(
  file: string,
  rule: DiffHygieneRule,
  priority: SzechuanDiffHygienePriority,
  sizeBytes?: number,
): SzechuanDiffHygieneFinding {
  return {
    id: `szechuan-diff-hygiene-${slug(rule)}-${slug(file)}`,
    priority,
    severity: priority,
    message: szechuanMessageForRule(rule, file, sizeBytes),
    rule,
    file,
    size_bytes: sizeBytes,
    category: 'hygiene',
    principle: 'Diff Hygiene',
  };
}

function messageForRule(rule: DiffHygieneRule, file: string, sizeBytes: number | undefined): string {
  switch (rule) {
    case 'root-markdown-orphan':
      return `Top-level markdown file ${file} is not in the documented root allowlist.`;
    case 'root-scratch-artifact':
      return `Top-level scratch artifact ${file} is not part of the documented change shape.`;
    case 'env-file':
      return `Environment file ${file} must not be committed unless it is .env.example.`;
    case 'large-unignored-file':
      return `Large added file ${file} is ${sizeBytes ?? 0} bytes and is not gitignored.`;
  }
}

function szechuanMessageForRule(rule: DiffHygieneRule, file: string, sizeBytes: number | undefined): string {
  switch (rule) {
    case 'root-markdown-orphan':
      return `orphan planning doc ${file} was added at repo root; move it to docs/ or prds/ or delete it.`;
    case 'root-scratch-artifact':
      return `Top-level scratch artifact ${file} was added; move it under an owned docs/prds path or delete it.`;
    case 'env-file':
      return `Secret leak risk: ${file} must not be committed unless it is .env.example.`;
    case 'large-unignored-file':
      return `Binary leak risk: ${file} is ${sizeBytes ?? 0} bytes and is not gitignored.`;
  }
}

function citadelSeverityForRule(rule: DiffHygieneRule): DiffHygieneSeverity {
  switch (rule) {
    case 'env-file':
      return 'Critical';
    case 'large-unignored-file':
      return 'High';
    case 'root-markdown-orphan':
    case 'root-scratch-artifact':
      return 'Medium';
  }
}

function szechuanPriorityForRule(rule: DiffHygieneRule): SzechuanDiffHygienePriority {
  switch (rule) {
    case 'env-file':
      return 'P0';
    case 'root-markdown-orphan':
    case 'root-scratch-artifact':
      return 'P1';
    case 'large-unignored-file':
      return 'P2';
  }
}

function isTopLevel(filePath: string): boolean {
  return !filePath.includes('/');
}

function isDisallowedRootMarkdown(basename: string): boolean {
  return basename.endsWith('.md') && !ROOT_MARKDOWN_ALLOWLIST.has(basename);
}

function isRootScratchArtifact(basename: string): boolean {
  return /\.(?:txt|log|tmp)$/i.test(basename)
    || basename.startsWith('scratch')
    || basename.startsWith('notes')
    || basename.startsWith('WIP')
    || basename.startsWith('tmp');
}

function isEnvFile(basename: string): boolean {
  return basename.startsWith('.env') && !ENV_FILE_ALLOWLIST.has(basename);
}

function fileSize(repoRoot: string, filePath: string): number {
  const fullPath = path.join(repoRoot, filePath);
  if (!existsSync(fullPath)) return 0;
  return statSync(fullPath).size;
}

function isGitIgnored(repoRoot: string, filePath: string): boolean {
  const result = spawnSync('git', ['check-ignore', '--quiet', '--', filePath], {
    cwd: repoRoot,
    stdio: 'ignore',
  });
  return result.status === 0;
}

function buildSuppressionIndex(findings: SzechuanFindingLike[]): SuppressionIndex {
  const index: SuppressionIndex = {
    ids: new Set(),
    paths: new Set(),
    pathRules: new Set(),
  };

  for (const finding of findings) {
    const id = typeof finding.id === 'string' ? finding.id : undefined;
    if (id) index.ids.add(id);

    if (finding.category !== 'hygiene') continue;
    const filePath = extractFindingPath(finding);
    if (!filePath) continue;
    index.paths.add(filePath);

    if (typeof finding.rule === 'string') {
      index.pathRules.add(`${filePath}:${finding.rule}`);
    }
  }

  return index;
}

function isSuppressed(finding: DiffHygieneFinding, suppression: SuppressionIndex): boolean {
  return suppression.ids.has(finding.id)
    || suppression.pathRules.has(`${toPosixPath(finding.file)}:${finding.rule}`)
    || suppression.paths.has(toPosixPath(finding.file));
}

function extractFindingPath(finding: SzechuanFindingLike): string | undefined {
  for (const value of [finding.file, finding.path, finding.target]) {
    if (typeof value === 'string' && value.trim()) return toPosixPath(value.trim());
  }
  if (typeof finding.evidence === 'string') {
    const match = finding.evidence.match(/^([^:\n]+):\d+(?::\d+)?$/);
    if (match) return toPosixPath(match[1]);
  }
  return undefined;
}

function slug(value: string): string {
  return toPosixPath(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'root';
}

function toPosixPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { ChangedFileSummary, DiffSummary } from './diff-walker.js';

export type RuleSetInvariantSeverity = 'High' | 'Medium';
export type RuleSetDeclarationKind = 'array' | 'enum' | 'object';

export interface RuleSetInvariantEvidence {
  file: string;
  line: number;
  text: string;
}

export interface ExplicitInvariantClause {
  line: number;
  text: string;
  matchedMembers: string[];
}

export interface RuleSetInventoryRow {
  declarationName: string;
  kind: RuleSetDeclarationKind;
  file: string;
  line: number;
  members: string[];
  invariantCovered: boolean;
  invariantEvidence: RuleSetInvariantEvidence[];
  explicitInvariant?: ExplicitInvariantClause;
  severity?: RuleSetInvariantSeverity;
}

export interface RuleSetInvariantFinding {
  id: string;
  severity: RuleSetInvariantSeverity;
  message: string;
  declaration: {
    name: string;
    kind: RuleSetDeclarationKind;
    file: string;
    line: number;
    members: string[];
  };
  explicitInvariant?: ExplicitInvariantClause;
}

export interface RuleSetInvariantReport {
  inventory: RuleSetInventoryRow[];
  findings: RuleSetInvariantFinding[];
  markdownTable: string;
  summary: {
    declarations: number;
    covered: number;
    missing: number;
    promoted: number;
  };
}

export interface AuditRuleSetInvariantsOptions {
  repoRoot?: string;
  prdMarkdown?: string;
  maxEvidencePerDeclaration?: number;
}

interface LoadedFile {
  path: string;
  content: string;
  lines: string[];
  lineStarts: number[];
  changedLines: ChangedFileSummary['changedLines'];
}

interface DeclarationCandidate {
  declarationName: string;
  kind: RuleSetDeclarationKind;
  file: string;
  line: number;
  members: string[];
}

const DEFAULT_MAX_EVIDENCE = 3;
const CODE_FILE_PATTERN = /\.[cm]?[jt]sx?$/i;
const RULE_SET_NAME_PATTERN = /(?:RULE|RULES|ACTION|ACTIONS|VALID_ACTIONS|CODE|CODES|STATUS|STATUSES|STATE|STATES|TRANSITION|TRANSITIONS|MACHINE)/;
const ARRAY_DECLARATION_PATTERN =
  /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*\[([\s\S]*?)\]\s*(?:as\s+const)?\s*;?/g;
const ENUM_DECLARATION_PATTERN = /export\s+enum\s+([A-Za-z_$][\w$]*)\s*\{([\s\S]*?)\}/g;
const OBJECT_DECLARATION_PATTERN =
  /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*\{([\s\S]*?)\}\s*(?:as\s+const)?\s*;?/g;
const RELATIONSHIP_ASSERTION_PATTERN =
  /(?:\.length\s*\)|\.length\s*\}|\btoBe\s*\(\s*1\s*\)|\btoHaveLength\s*\(\s*1\s*\)|\btoEqual\s*\(|\btoStrictEqual\s*\(|\btoContainEqual\s*\(|\bforEach\s*\(|\bfor\.each\s*\(|mutually\s+exclusive|exactly\s+one|at\s+most\s+one|partition\s+of)/i;
const EXPLICIT_INVARIANT_PATTERN = /\b(?:exactly\s+one\s+of|at\s+most\s+one\s+of|mutually\s+exclusive|partition\s+of)\b/i;

export function auditRuleSetInvariants(
  diff: DiffSummary,
  options: AuditRuleSetInvariantsOptions = {},
): RuleSetInvariantReport {
  const repoRoot = path.resolve(options.repoRoot ?? diff.repoRoot);
  const maxEvidence = options.maxEvidencePerDeclaration ?? DEFAULT_MAX_EVIDENCE;
  const productionFiles = loadFiles(diff.changedFiles, repoRoot, 'production');
  const testFiles = loadFiles(diff.changedFiles, repoRoot, 'test');
  const declarations = productionFiles.flatMap(findRuleSetDeclarations);
  const rows = declarations.map((declaration) =>
    buildInventoryRow(declaration, testFiles, options.prdMarkdown ?? '', maxEvidence),
  );
  const findings = rows.filter((row) => !row.invariantCovered).map(toFinding);

  return {
    inventory: rows,
    findings,
    markdownTable: renderRuleSetInvariantMarkdownTable(rows),
    summary: {
      declarations: rows.length,
      covered: rows.filter((row) => row.invariantCovered).length,
      missing: findings.length,
      promoted: findings.filter((finding) => finding.severity === 'High').length,
    },
  };
}

export function renderRuleSetInvariantMarkdownTable(rows: RuleSetInventoryRow[]): string {
  return [
    '| Declaration | Kind | Members | Invariant Covered | Severity | Evidence |',
    '|---|---|---:|:---:|---|---|',
    ...rows.map(
      (row) =>
        `| ${escapeTableCell(row.declarationName)} | ${row.kind} | ${row.members.length} | ${row.invariantCovered ? 'yes' : 'no'} | ${row.severity ?? ''} | ${escapeTableCell(formatEvidence(row))} |`,
    ),
  ].join('\n');
}

function buildInventoryRow(
  declaration: DeclarationCandidate,
  testFiles: LoadedFile[],
  prdMarkdown: string,
  maxEvidence: number,
): RuleSetInventoryRow {
  const invariantEvidence = findInvariantEvidence(declaration, testFiles, maxEvidence);
  const explicitInvariant = findExplicitInvariantClause(prdMarkdown, declaration.members);
  const severity = invariantEvidence.length > 0 ? undefined : explicitInvariant ? 'High' : 'Medium';
  return {
    declarationName: declaration.declarationName,
    kind: declaration.kind,
    file: declaration.file,
    line: declaration.line,
    members: declaration.members,
    invariantCovered: invariantEvidence.length > 0,
    invariantEvidence,
    explicitInvariant,
    severity,
  };
}

function toFinding(row: RuleSetInventoryRow): RuleSetInvariantFinding {
  const severity = row.severity ?? 'Medium';
  return {
    id: `citadel-rule-set-invariant-${slug(row.file)}-${slug(row.declarationName)}`,
    severity,
    message: `Rule-set "${row.declarationName}" lacks an interaction invariant test.`,
    declaration: {
      name: row.declarationName,
      kind: row.kind,
      file: row.file,
      line: row.line,
      members: row.members,
    },
    explicitInvariant: row.explicitInvariant,
  };
}

function loadFiles(
  changedFiles: ChangedFileSummary[],
  repoRoot: string,
  kind: ChangedFileSummary['kind'],
): LoadedFile[] {
  return changedFiles.flatMap((summary) => {
    if (summary.status === 'D' || summary.kind !== kind || !CODE_FILE_PATTERN.test(summary.path)) return [];
    try {
      const content = readFileSync(path.join(repoRoot, summary.path), 'utf-8');
      return [{
        path: summary.path,
        content,
        lines: content.split(/\r?\n/),
        lineStarts: lineStartsForContent(content),
        changedLines: summary.changedLines,
      }];
    } catch {
      return [];
    }
  });
}

function findRuleSetDeclarations(file: LoadedFile): DeclarationCandidate[] {
  return [
    ...findArrayDeclarations(file),
    ...findEnumDeclarations(file),
    ...findObjectDeclarations(file),
  ].sort((a, b) => a.line - b.line || a.declarationName.localeCompare(b.declarationName));
}

function findArrayDeclarations(file: LoadedFile): DeclarationCandidate[] {
  const declarations: DeclarationCandidate[] = [];
  for (const match of file.content.matchAll(ARRAY_DECLARATION_PATTERN)) {
    const name = match[1];
    if (!looksLikeRuleSetName(name)) continue;
    const line = lineNumberAtOffset(file.lineStarts, match.index ?? 0);
    if (!lineIsChanged(file.changedLines, line)) continue;
    const members = extractArrayMembers(match[2]);
    if (members.length < 3) continue;
    declarations.push({
      declarationName: name,
      kind: 'array',
      file: file.path,
      line,
      members,
    });
  }
  return declarations;
}

function findEnumDeclarations(file: LoadedFile): DeclarationCandidate[] {
  const declarations: DeclarationCandidate[] = [];
  for (const match of file.content.matchAll(ENUM_DECLARATION_PATTERN)) {
    const line = lineNumberAtOffset(file.lineStarts, match.index ?? 0);
    if (!lineIsChanged(file.changedLines, line)) continue;
    const members = uniqueSortedStrings([...match[2].matchAll(/^\s*([A-Za-z_$][\w$]*)/gm)].map((entry) => entry[1]));
    if (members.length < 3) continue;
    declarations.push({
      declarationName: match[1],
      kind: 'enum',
      file: file.path,
      line,
      members,
    });
  }
  return declarations;
}

function findObjectDeclarations(file: LoadedFile): DeclarationCandidate[] {
  const declarations: DeclarationCandidate[] = [];
  for (const match of file.content.matchAll(OBJECT_DECLARATION_PATTERN)) {
    const name = match[1];
    if (!looksLikeRuleSetName(name)) continue;
    const line = lineNumberAtOffset(file.lineStarts, match.index ?? 0);
    if (!lineIsChanged(file.changedLines, line)) continue;
    const members = extractObjectKeys(match[2]);
    if (members.length < 3) continue;
    declarations.push({
      declarationName: name,
      kind: 'object',
      file: file.path,
      line,
      members,
    });
  }
  return declarations;
}

function extractArrayMembers(body: string): string[] {
  const quoted = [...body.matchAll(/["'`]([A-Za-z0-9_.:-]+)["'`]/g)].map((match) => match[1]);
  if (quoted.length > 0) return uniqueSortedStrings(quoted);
  return uniqueSortedStrings([...body.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)].map((match) => match[1]));
}

function extractObjectKeys(body: string): string[] {
  return uniqueSortedStrings(
    [...body.matchAll(/^\s*(?:["'`]?)([A-Za-z_$][\w$.-]*)(?:["'`]?)\s*:/gm)].map((match) => match[1]),
  );
}

function findInvariantEvidence(
  declaration: DeclarationCandidate,
  testFiles: LoadedFile[],
  maxEvidence: number,
): RuleSetInvariantEvidence[] {
  const evidence: RuleSetInvariantEvidence[] = [];
  for (const file of testFiles) {
    const statements = collectAssertionWindows(file);
    for (const statement of statements) {
      const referenced = declaration.members.filter((member) => statement.text.includes(member));
      if (referenced.length < 2 || !RELATIONSHIP_ASSERTION_PATTERN.test(statement.text)) continue;
      evidence.push({
        file: file.path,
        line: statement.line,
        text: file.lines[statement.line - 1]?.trim() ?? '',
      });
      if (evidence.length >= maxEvidence) return evidence;
    }
  }
  return evidence;
}

function collectAssertionWindows(file: LoadedFile): Array<{ line: number; text: string }> {
  const windows: Array<{ line: number; text: string }> = [];
  for (let index = 0; index < file.lines.length; index += 1) {
    const line = file.lines[index];
    if (!lineIsChanged(file.changedLines, index + 1)) continue;
    if (!/(?:expect|assert|forEach|for\.each|mutually\s+exclusive|exactly\s+one|at\s+most\s+one)/i.test(line)) continue;
    const text = file.lines.slice(index, Math.min(file.lines.length, index + 6)).join('\n');
    windows.push({ line: index + 1, text });
  }
  return windows;
}

function findExplicitInvariantClause(prdMarkdown: string, members: string[]): ExplicitInvariantClause | undefined {
  const lines = prdMarkdown.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!EXPLICIT_INVARIANT_PATTERN.test(line)) continue;
    const matchedMembers = members.filter((member) => line.includes(member));
    if (matchedMembers.length < 2) continue;
    return {
      line: index + 1,
      text: line.trim(),
      matchedMembers,
    };
  }
  return undefined;
}

function lineStartsForContent(content: string): number[] {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function lineNumberAtOffset(lineStarts: number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (lineStarts[mid] <= offset) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return high + 1;
}

function lineIsChanged(changedLines: ChangedFileSummary['changedLines'], line: number): boolean {
  return changedLines.length === 0 || changedLines.some((range) => line >= range.start && line <= range.end);
}

function looksLikeRuleSetName(name: string): boolean {
  return RULE_SET_NAME_PATTERN.test(name);
}

function formatEvidence(row: RuleSetInventoryRow): string {
  if (row.invariantEvidence.length > 0) {
    return row.invariantEvidence.map((evidence) => `${evidence.file}:${evidence.line}`).join(', ');
  }
  return row.explicitInvariant ? `missing; PRD:${row.explicitInvariant.line}` : 'missing';
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function uniqueSortedStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'unknown';
}

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { AcceptanceCriterion } from './prd-parser.js';
import { ChangedFileSummary, DiffSummary } from './diff-walker.js';

export type CoverageMatchType = 'ac_id' | 'keyword_anchor' | 'symbol' | 'llm_entity';
export type CoverageSeverity = 'Critical' | 'High';

export interface CoverageEvidence {
  file: string;
  line: number;
  text: string;
  matchType: CoverageMatchType;
  match: string;
  symbol?: string;
}

export interface AcCoverageRow {
  id: string;
  implemented: boolean;
  tested: boolean;
  acLine: number;
  acText: string;
  keywordAnchors: string[];
  implementationSymbols: string[];
  implementationEvidence: CoverageEvidence[];
  testEvidence: CoverageEvidence[];
}

export interface AcCoverageFinding {
  id: string;
  acId: string;
  severity: CoverageSeverity;
  message: string;
  evidence: CoverageEvidence[];
  keywordAnchors: string[];
}

export interface AcCoverageScorecard {
  rows: AcCoverageRow[];
  findings: AcCoverageFinding[];
  markdownTable: string;
  summary: {
    total: number;
    implemented: number;
    tested: number;
    missingImplementation: number;
    missingTests: number;
  };
}

export interface BuildAcCoverageScorecardOptions {
  repoRoot?: string;
  maxEvidencePerKind?: number;
  llmEntityMappings?: readonly LlmEntityMapping[];
}

export interface LlmEntityMapping {
  acId: string;
  expectedSymbols?: readonly string[];
  expectedCallSites?: readonly string[];
}

interface LoadedChangedFile {
  summary: ChangedFileSummary;
  lines: string[];
}

const DEFAULT_MAX_EVIDENCE = 3;
const COMMON_WORDS = new Set([
  'acceptance',
  'criterion',
  'criteria',
  'should',
  'must',
  'with',
  'from',
  'that',
  'this',
  'when',
  'then',
  'than',
  'into',
  'over',
  'under',
  'between',
  'without',
  'where',
  'which',
  'each',
  'all',
  'and',
  'or',
  'the',
  'for',
  'not',
  'pass',
  'passes',
  'verify',
  'verified',
  'test',
  'tests',
  'tested',
]);
const AC_ID_PATTERN = /\bAC-[A-Z0-9]+(?:-[A-Z0-9]+)*(?:-\d+)?\b/g;
const WORD_PATTERN = /[A-Za-z][A-Za-z0-9]*/g;
const SYMBOL_PATTERN =
  /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)|(?:^|\s)([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?(?:\([^)]*\)\s*=>|function\b)/;

export function buildAcCoverageScorecard(
  acceptanceCriteria: AcceptanceCriterion[],
  diff: DiffSummary,
  options: BuildAcCoverageScorecardOptions = {},
): AcCoverageScorecard {
  const repoRoot = path.resolve(options.repoRoot ?? diff.repoRoot);
  const maxEvidencePerKind = options.maxEvidencePerKind ?? DEFAULT_MAX_EVIDENCE;
  const files = loadChangedFiles(diff.changedFiles, repoRoot);
  const productionFiles = files.filter((file) => file.summary.kind === 'production');
  const testFiles = files.filter((file) => file.summary.kind === 'test');
  const llmEntityMappings = normalizeLlmEntityMappings(options.llmEntityMappings ?? []);

  const rows = acceptanceCriteria.map((criterion) =>
    buildRow(criterion, productionFiles, testFiles, maxEvidencePerKind, llmEntityMappings.get(criterion.id) ?? []),
  );
  const findings = rows.flatMap(buildFindings);

  return {
    rows,
    findings,
    markdownTable: renderAcCoverageMarkdownTable(rows),
    summary: {
      total: rows.length,
      implemented: rows.filter((row) => row.implemented).length,
      tested: rows.filter((row) => row.tested).length,
      missingImplementation: rows.filter((row) => !row.implemented).length,
      missingTests: rows.filter((row) => row.implemented && !row.tested).length,
    },
  };
}

export function renderAcCoverageMarkdownTable(rows: AcCoverageRow[]): string {
  return [
    '| ID | Implemented | Tested | File:line evidence |',
    '|---|:---:|:---:|---|',
    ...rows.map((row) =>
      `| ${escapeTableCell(row.id)} | ${row.implemented ? '✓' : '✗'} | ${row.tested ? '✓' : '✗'} | ${escapeTableCell(formatEvidenceCell(row))} |`,
    ),
  ].join('\n');
}

export function extractKeywordAnchors(text: string): string[] {
  const withoutIds = text.replace(AC_ID_PATTERN, ' ');
  const words = withoutIds.match(WORD_PATTERN) ?? [];
  const anchors = words
    .flatMap(splitIdentifierWords)
    .map((word) => word.toLowerCase())
    .filter((word) => word.length >= 4 && !COMMON_WORDS.has(word));
  return uniqueSortedStrings(anchors);
}

function buildRow(
  criterion: AcceptanceCriterion,
  productionFiles: LoadedChangedFile[],
  testFiles: LoadedChangedFile[],
  maxEvidencePerKind: number,
  llmEntities: string[],
): AcCoverageRow {
  const keywordAnchors = extractKeywordAnchors(criterion.text);
  const implementationEvidence = findProductionEvidence(
    criterion,
    keywordAnchors,
    llmEntities,
    productionFiles,
    maxEvidencePerKind,
  );
  const implementationSymbols = uniqueSortedStrings(
    implementationEvidence.map((evidence) => evidence.symbol).filter((symbol): symbol is string => Boolean(symbol)),
  );
  const testEvidence = findTestEvidence(
    criterion,
    keywordAnchors,
    uniqueSortedStrings([...implementationSymbols, ...llmEntities]),
    testFiles,
    maxEvidencePerKind,
  );

  return {
    id: criterion.id,
    implemented: implementationEvidence.length > 0,
    tested: testEvidence.length > 0,
    acLine: criterion.line,
    acText: criterion.text,
    keywordAnchors,
    implementationSymbols,
    implementationEvidence,
    testEvidence,
  };
}

function findProductionEvidence(
  criterion: AcceptanceCriterion,
  keywordAnchors: string[],
  llmEntities: string[],
  files: LoadedChangedFile[],
  maxEvidence: number,
): CoverageEvidence[] {
  const evidence: CoverageEvidence[] = [];
  for (const file of files) {
    scanLines(file, (line, lineNumber) => {
      if (line.includes(criterion.id)) {
        evidence.push(toEvidence(file.summary.path, lineNumber, line, 'ac_id', criterion.id, extractSymbolName(line)));
        return;
      }
      const matchedEntity = llmEntities.find((entity) => line.includes(entity));
      if (matchedEntity) {
        evidence.push(toEvidence(file.summary.path, lineNumber, line, 'llm_entity', matchedEntity, matchedEntity));
        return;
      }
      const symbol = extractSymbolName(line);
      if (!symbol) return;
      const matchedAnchor = keywordAnchors.find((anchor) => symbolContainsAnchor(symbol, anchor));
      if (matchedAnchor) {
        evidence.push(toEvidence(file.summary.path, lineNumber, line, 'keyword_anchor', matchedAnchor, symbol));
      }
    });
    if (evidence.length >= maxEvidence) break;
  }
  return evidence.slice(0, maxEvidence);
}

function findTestEvidence(
  criterion: AcceptanceCriterion,
  keywordAnchors: string[],
  implementationSymbols: string[],
  files: LoadedChangedFile[],
  maxEvidence: number,
): CoverageEvidence[] {
  const evidence: CoverageEvidence[] = [];
  for (const file of files) {
    scanLines(file, (line, lineNumber) => {
      if (line.includes(criterion.id)) {
        evidence.push(toEvidence(file.summary.path, lineNumber, line, 'ac_id', criterion.id));
        return;
      }
      const matchedSymbol = implementationSymbols.find((symbol) => line.includes(symbol));
      if (matchedSymbol) {
        evidence.push(toEvidence(file.summary.path, lineNumber, line, 'symbol', matchedSymbol, matchedSymbol));
        return;
      }
      const normalized = normalizeIdentifier(line);
      const matchedAnchor = keywordAnchors.find((anchor) => normalized.includes(anchor));
      if (matchedAnchor) {
        evidence.push(toEvidence(file.summary.path, lineNumber, line, 'keyword_anchor', matchedAnchor));
      }
    });
    if (evidence.length >= maxEvidence) break;
  }
  return evidence.slice(0, maxEvidence);
}

function buildFindings(row: AcCoverageRow): AcCoverageFinding[] {
  if (!row.implemented) {
    return [
      {
        id: `citadel-ac-coverage-${row.id}-implementation`,
        acId: row.id,
        severity: 'Critical',
        message: `${row.id} has no production implementation evidence in changed files.`,
        evidence: [],
        keywordAnchors: row.keywordAnchors,
      },
    ];
  }
  if (!row.tested) {
    return [
      {
        id: `citadel-ac-coverage-${row.id}-test`,
        acId: row.id,
        severity: 'High',
        message: `${row.id} has production evidence but no changed test evidence.`,
        evidence: row.implementationEvidence,
        keywordAnchors: row.keywordAnchors,
      },
    ];
  }
  return [];
}

function loadChangedFiles(changedFiles: ChangedFileSummary[], repoRoot: string): LoadedChangedFile[] {
  return changedFiles.flatMap((summary) => {
    if (summary.status === 'D') return [];
    try {
      const content = readFileSync(path.join(repoRoot, summary.path), 'utf-8');
      return [{ summary, lines: content.split(/\r?\n/) }];
    } catch {
      return [];
    }
  });
}

function scanLines(file: LoadedChangedFile, onLine: (line: string, lineNumber: number) => void): void {
  file.lines.forEach((line, index) => onLine(line, index + 1));
}

function toEvidence(
  file: string,
  line: number,
  text: string,
  matchType: CoverageMatchType,
  match: string,
  symbol?: string,
): CoverageEvidence {
  return {
    file,
    line,
    text: text.trim(),
    matchType,
    match,
    ...(symbol ? { symbol } : {}),
  };
}

function extractSymbolName(line: string): string | undefined {
  const match = line.match(SYMBOL_PATTERN);
  return match?.[1] ?? match?.[2];
}

function symbolContainsAnchor(symbol: string, anchor: string): boolean {
  return normalizeIdentifier(symbol).includes(anchor);
}

function normalizeIdentifier(value: string): string {
  return splitIdentifierWords(value).join('').toLowerCase();
}

function splitIdentifierWords(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .match(WORD_PATTERN) ?? [];
}

function formatEvidenceCell(row: AcCoverageRow): string {
  const implementation = row.implementationEvidence[0];
  const test = row.testEvidence[0];
  if (!implementation) return '(no enforcement found)';
  if (!test) return `${formatEvidenceRef(implementation)} + (no test found)`;
  return `${formatEvidenceRef(implementation)} + ${formatEvidenceRef(test)}`;
}

function formatEvidenceRef(evidence: CoverageEvidence): string {
  return `${evidence.file}:${evidence.line}`;
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function uniqueSortedStrings(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function normalizeLlmEntityMappings(mappings: readonly LlmEntityMapping[]): Map<string, string[]> {
  const byAcId = new Map<string, string[]>();
  for (const mapping of mappings) {
    const entities = [
      ...(mapping.expectedSymbols ?? []),
      ...(mapping.expectedCallSites ?? []),
    ].map((entity) => entity.trim()).filter(Boolean);
    if (entities.length === 0) continue;
    byAcId.set(mapping.acId, uniqueSortedStrings([...(byAcId.get(mapping.acId) ?? []), ...entities]));
  }
  return byAcId;
}

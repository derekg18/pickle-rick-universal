import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

export interface AcShapeEvidence {
  file: string;
  line: number;
  text: string;
}

export interface AcShapeDecisionRequired {
  id: string;
  severity: 'Medium' | 'High';
  acId: string;
  message: string;
  suggestion: string;
  bulletCount: number;
  distinctTargets: string[];
  refinementTicketCount: number;
  evidence: AcShapeEvidence[];
}

export interface AcShapeFinding {
  id: string;
  severity: 'High';
  acId: string;
  message: string;
  suggestion: string;
  refinementTicketCount: number;
  evidence: AcShapeEvidence[];
}

export interface AcShapeAuditReport {
  decisionsRequired: AcShapeDecisionRequired[];
  findings: AcShapeFinding[];
  summary: {
    decisionsRequired: number;
    highFindings: number;
  };
}

export interface AuditAcShapeOptions {
  prdPath: string;
  sessionDir?: string;
}

interface AcBlock {
  id: string;
  line: number;
  headline: string;
  body: AcShapeEvidence[];
}

interface BulletAnalysis {
  evidence: AcShapeEvidence;
  target: string;
  predicate: string;
}

interface ManifestFanout {
  count: number;
  justified: boolean;
}

const AC_ID_PATTERN = /\bAC-[A-Z0-9]+(?:-[A-Z0-9]+)*(?:-\d+)?\b/g;
const BULLET_PATTERN = /^\s*(?:[-*]|\d+[.)])\s+(.+)$/;
const ENDPOINT_PATTERN = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+[`'"]?(\/[^\s`'")|,;]+)/gi;
const UNIVERSAL_QUANTIFIER_PATTERN = /\b(?:all|any|each|every|entire|all\s+\w+\s+endpoints?|every\s+\w+\s+route)\b/i;
const SUGGESTION = "Rewrite as 'every <resource> endpoint <predicate>' with a parametrized test.";

export function auditAcShape(options: AuditAcShapeOptions): AcShapeAuditReport {
  const prdPath = path.resolve(options.prdPath);
  const markdown = readFileSync(prdPath, 'utf-8');
  const manifestText = readManifestText(options.sessionDir);
  const decisionsRequired = parseAcBlocks(markdown, prdPath)
    .map((block) => toDecisionRequired(block, fanoutForAc(manifestText, block.id)))
    .filter((decision): decision is AcShapeDecisionRequired => decision !== undefined)
    .sort(compareAcShapeItems);
  const findings = decisionsRequired
    .filter((decision) => decision.severity === 'High')
    .map(toFinding)
    .sort(compareAcShapeItems);

  return {
    decisionsRequired,
    findings,
    summary: {
      decisionsRequired: decisionsRequired.length,
      highFindings: findings.length,
    },
  };
}

function parseAcBlocks(markdown: string, prdPath: string): AcBlock[] {
  const blocks: AcBlock[] = [];
  let current: AcBlock | undefined;
  const lines = markdown.split(/\r?\n/);

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const acIds = uniqueMatches(line, AC_ID_PATTERN);
    if (acIds.length > 0) {
      if (current) blocks.push(current);
      current = {
        id: acIds[0],
        line: lineNumber,
        headline: line.trim(),
        body: [],
      };
      return;
    }

    if (!current) return;
    current.body.push({ file: prdPath, line: lineNumber, text: line.trim() });
  });

  if (current) blocks.push(current);
  return blocks;
}

function toDecisionRequired(block: AcBlock, fanout: ManifestFanout): AcShapeDecisionRequired | undefined {
  if (UNIVERSAL_QUANTIFIER_PATTERN.test(block.headline)) return undefined;

  const analyzed = block.body
    .map(analyzeBullet)
    .filter((analysis): analysis is BulletAnalysis => analysis !== undefined);
  if (analyzed.length < 3) return undefined;

  const distinctTargets = uniqueSortedStrings(analyzed.map((analysis) => analysis.target));
  if (distinctTargets.length < 3) return undefined;
  if (!hasRepeatedPredicate(analyzed)) return undefined;

  const severity: AcShapeDecisionRequired['severity'] = fanout.count >= 3 && !fanout.justified ? 'High' : 'Medium';
  return {
    id: `citadel-ac-shape-${slug(block.id)}`,
    severity,
    acId: block.id,
    message: `${block.id} enumerates ${distinctTargets.length} distinct targets with a repeated predicate; rewrite as a universal invariant before refinement fan-out misses sibling targets.`,
    suggestion: SUGGESTION,
    bulletCount: analyzed.length,
    distinctTargets,
    refinementTicketCount: fanout.count,
    evidence: [
      { file: analyzed[0].evidence.file, line: block.line, text: block.headline },
      ...analyzed.map((analysis) => analysis.evidence),
    ],
  };
}

function analyzeBullet(evidence: AcShapeEvidence): BulletAnalysis | undefined {
  const bullet = evidence.text.match(BULLET_PATTERN);
  if (!bullet) return undefined;
  const content = bullet[1];
  const target = extractTarget(content);
  if (!target) return undefined;
  const predicate = normalizePredicate(content);
  if (!predicate) return undefined;
  return { evidence, target, predicate };
}

function extractTarget(content: string): string | undefined {
  const endpointMatch = [...content.matchAll(ENDPOINT_PATTERN)][0];
  if (endpointMatch) return `${endpointMatch[1].toUpperCase()} ${endpointMatch[2]}`;

  const handlerMatch = content.match(/\b(?:handler|method|endpoint|route)\s+`?([A-Za-z_]\w*)`?/i);
  if (handlerMatch) return handlerMatch[1];

  const codeIdentifierMatch = content.match(/`([A-Za-z_]\w*)`/);
  return codeIdentifierMatch?.[1];
}

function normalizePredicate(content: string): string {
  return content
    .replace(ENDPOINT_PATTERN, ' ')
    .replace(/\b(?:handler|method|endpoint|route)\s+`?[A-Za-z_]\w*`?/gi, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/gi, ' ')
    .replace(/\/[A-Za-z0-9_{}:[\]/.-]+/g, ' ')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .toLowerCase();
}

function hasRepeatedPredicate(analyses: BulletAnalysis[]): boolean {
  const counts = new Map<string, number>();
  for (const analysis of analyses) {
    counts.set(analysis.predicate, (counts.get(analysis.predicate) ?? 0) + 1);
  }
  return [...counts.values()].some((count) => count >= 3);
}

function readManifestText(sessionDir: string | undefined): string {
  if (!sessionDir) return '';
  const paths = [
    path.join(sessionDir, 'prd_refined.md'),
    path.join(sessionDir, 'refinement_manifest.json'),
  ];
  return paths
    .filter((filePath) => existsSync(filePath))
    .map((filePath) => readFileSync(filePath, 'utf-8'))
    .join('\n');
}

function fanoutForAc(manifestText: string, acId: string): ManifestFanout {
  if (!manifestText) return { count: 0, justified: false };
  const acPattern = new RegExp(`\\b${escapeRegExp(acId)}\\b`, 'g');
  const lines = manifestText.split(/\r?\n/);
  const matchingLineIndexes = lines
    .map((line, index) => (line.match(acPattern) ? index : -1))
    .filter((index) => index >= 0);
  return {
    count: matchingLineIndexes.length,
    justified: matchingLineIndexes.some((index) => justificationWindow(lines, index).includes('// JUSTIFICATION:')),
  };
}

function justificationWindow(lines: string[], index: number): string {
  return lines.slice(index, index + 3).join('\n');
}

function toFinding(decision: AcShapeDecisionRequired): AcShapeFinding {
  return {
    id: `${decision.id}-unjustified-fanout`,
    severity: 'High',
    acId: decision.acId,
    message: `${decision.acId} fanned out into ${decision.refinementTicketCount} refinement tickets without a justification block.`,
    suggestion: decision.suggestion,
    refinementTicketCount: decision.refinementTicketCount,
    evidence: decision.evidence,
  };
}

function uniqueMatches(text: string, pattern: RegExp): string[] {
  pattern.lastIndex = 0;
  return uniqueSortedStrings([...text.matchAll(pattern)].map((match) => match[0]));
}

function compareAcShapeItems(a: { acId: string; id: string }, b: { acId: string; id: string }): number {
  return a.acId.localeCompare(b.acId) || a.id.localeCompare(b.id);
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function uniqueSortedStrings(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

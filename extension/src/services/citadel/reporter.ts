export type CitadelSeverity = 'Critical' | 'High' | 'Medium' | 'Low';

export interface CitadelEvidence {
  file?: unknown;
  line?: unknown;
  text?: unknown;
}

export interface CitadelFinding {
  id: string;
  severity: CitadelSeverity;
  message?: string;
  acId?: string;
  trapDoorId?: string;
  evidence?: CitadelEvidence[] | string;
  file?: string;
  line?: number;
  [key: string]: unknown;
}

export interface CitadelDecision {
  id: string;
  severity?: CitadelSeverity;
  message?: string;
  evidence?: CitadelEvidence[] | string;
  file?: string;
  line?: number;
}

export interface CitadelJsonReport {
  schema: '1.0';
  schema_version: '1.0';
  prd_path: string;
  diff_range: string;
  exit_code: number;
  exitCode: number;
  sections: Record<string, unknown>;
  findings: CitadelFinding[];
  decision_required: CitadelDecision[];
  decisions: CitadelDecision[];
  summary: CitadelSummary;
  markdown: string;
}

export interface CitadelSummary {
  findings: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  decision_required: number;
  decisions: number;
  unguarded_trap_doors: number;
}

export interface ReporterInput {
  prdPath: string;
  diffRange: string;
  sections: Record<string, unknown>;
  findings: CitadelFinding[];
  decisions: CitadelDecision[];
  strict?: boolean;
}

export interface CitadelRunResult extends CitadelJsonReport {
  exitCode: number;
  decisions: CitadelDecision[];
  json: CitadelJsonReport;
}

const SEVERITY_RANK: Record<CitadelSeverity, number> = {
  Critical: 0,
  High: 1,
  Medium: 2,
  Low: 3,
};

export class Reporter {
  build(input: ReporterInput): CitadelRunResult {
    const findings = rankFindings(input.findings);
    const decisions = [...input.decisions].sort(compareDecisions);
    const summary = summarize(findings, decisions);
    const exitCode = exitCodeFor(findings, decisions, input.strict);
    const json: CitadelJsonReport = {
      schema: '1.0',
      schema_version: '1.0',
      prd_path: input.prdPath,
      diff_range: input.diffRange,
      exit_code: exitCode,
      exitCode,
      sections: input.sections,
      findings,
      decision_required: decisions,
      decisions,
      summary,
      markdown: renderMarkdown(findings, decisions, summary, exitCode),
    };

    return {
      ...json,
      exitCode,
      decisions,
      json,
    };
  }

  renderMarkdown(report: Pick<CitadelJsonReport, 'findings' | 'decisions' | 'summary' | 'exitCode'>): string {
    return renderMarkdown(report.findings, report.decisions, report.summary, report.exitCode);
  }
}

export function rankFindings(findings: CitadelFinding[]): CitadelFinding[] {
  return [...findings].sort(compareFindings);
}

function compareFindings(a: CitadelFinding, b: CitadelFinding): number {
  return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    || citationFor(a).localeCompare(citationFor(b))
    || a.id.localeCompare(b.id);
}

function compareDecisions(a: CitadelDecision, b: CitadelDecision): number {
  return decisionSeverityRank(a) - decisionSeverityRank(b)
    || citationFor(a).localeCompare(citationFor(b))
    || a.id.localeCompare(b.id);
}

function decisionSeverityRank(decision: CitadelDecision): number {
  return decision.severity ? SEVERITY_RANK[decision.severity] : SEVERITY_RANK.Medium;
}

function summarize(findings: CitadelFinding[], decisions: CitadelDecision[]): CitadelSummary {
  return {
    findings: findings.length,
    critical: countSeverity(findings, 'Critical'),
    high: countSeverity(findings, 'High'),
    medium: countSeverity(findings, 'Medium'),
    low: countSeverity(findings, 'Low'),
    decision_required: decisions.length,
    decisions: decisions.length,
    unguarded_trap_doors: countUnguardedTrapDoors(findings),
  };
}

function countSeverity(findings: CitadelFinding[], severity: CitadelSeverity): number {
  return findings.filter((finding) => finding.severity === severity).length;
}

function countUnguardedTrapDoors(findings: CitadelFinding[]): number {
  return findings.filter((finding) => {
    const id = finding.id.toLowerCase();
    const message = typeof finding.message === 'string' ? finding.message.toLowerCase() : '';
    return id.includes('trap-door') || message.includes('unguarded trap door');
  }).length;
}

function exitCodeFor(findings: CitadelFinding[], decisions: CitadelDecision[], strict = false): number {
  const critical = countSeverity(findings, 'Critical');
  const high = countSeverity(findings, 'High');
  const strictDecisionFindings = strict ? decisions.length : 0;
  return critical + (strict ? high : 0) + strictDecisionFindings > 0 ? 1 : 0;
}

function renderMarkdown(
  findings: CitadelFinding[],
  decisions: CitadelDecision[],
  summary: CitadelSummary,
  exitCode: number,
): string {
  const lines = ['# Citadel Findings', ''];
  if (findings.length === 0) {
    lines.push('No findings.', '');
  } else {
    for (const finding of findings) {
      lines.push(`- **${finding.severity}** ${labelFor(finding)} ${citationFor(finding)} - ${descriptionFor(finding)}`);
    }
    lines.push('');
  }

  lines.push(`Decisions required: ${decisions.length}`);
  lines.push(summaryLine(summary, exitCode));
  return `${lines.join('\n')}\n`;
}

function summaryLine(summary: CitadelSummary, exitCode: number): string {
  return [
    `Conformance audit: ${summary.findings} findings`,
    `(CRITICAL=${summary.critical}, HIGH=${summary.high}, MEDIUM=${summary.medium}, LOW=${summary.low})`,
    `${summary.decision_required} decisions required`,
    `${summary.unguarded_trap_doors} unguarded trap doors`,
    `exit ${exitCode}`,
  ].join(' ');
}

function labelFor(finding: CitadelFinding): string {
  const id = typeof finding.acId === 'string'
    ? finding.acId
    : typeof finding.trapDoorId === 'string'
      ? finding.trapDoorId
      : finding.id;
  return `[${id}]`;
}

function citationFor(item: CitadelFinding | CitadelDecision): string {
  const evidence = Array.isArray(item.evidence) ? item.evidence[0] : item.evidence;
  if (typeof evidence === 'string') return citationFromString(evidence);
  const file = typeof evidence?.file === 'string'
    ? evidence.file
    : typeof item.file === 'string'
      ? item.file
      : 'unknown';
  const line = typeof evidence?.line === 'number'
    ? evidence.line
    : typeof item.line === 'number'
      ? item.line
      : 0;
  return `${file}:${line}`;
}

function citationFromString(value: string): string {
  const match = /(.+):(\d+)$/.exec(value.trim());
  return match ? `${match[1]}:${match[2]}` : 'unknown:0';
}

function descriptionFor(finding: CitadelFinding): string {
  if (typeof finding.message === 'string' && finding.message.trim().length > 0) {
    return oneSentence(finding.message);
  }
  return oneSentence(finding.id);
}

function oneSentence(value: string): string {
  const first = value.trim().split(/(?<=[.!?])\s+/)[0] ?? value.trim();
  return first.replace(/\s+/g, ' ');
}

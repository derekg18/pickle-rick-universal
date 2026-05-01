const SEVERITY_RANK = {
    Critical: 0,
    High: 1,
    Medium: 2,
    Low: 3,
};
export class Reporter {
    build(input) {
        const findings = rankFindings(input.findings);
        const decisions = [...input.decisions].sort(compareDecisions);
        const summary = summarize(findings, decisions);
        const exitCode = exitCodeFor(findings, decisions, input.strict);
        const json = {
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
    renderMarkdown(report) {
        return renderMarkdown(report.findings, report.decisions, report.summary, report.exitCode);
    }
}
export function rankFindings(findings) {
    return [...findings].sort(compareFindings);
}
function compareFindings(a, b) {
    return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
        || citationFor(a).localeCompare(citationFor(b))
        || a.id.localeCompare(b.id);
}
function compareDecisions(a, b) {
    return decisionSeverityRank(a) - decisionSeverityRank(b)
        || citationFor(a).localeCompare(citationFor(b))
        || a.id.localeCompare(b.id);
}
function decisionSeverityRank(decision) {
    return decision.severity ? SEVERITY_RANK[decision.severity] : SEVERITY_RANK.Medium;
}
function summarize(findings, decisions) {
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
function countSeverity(findings, severity) {
    return findings.filter((finding) => finding.severity === severity).length;
}
function countUnguardedTrapDoors(findings) {
    return findings.filter((finding) => {
        const id = finding.id.toLowerCase();
        const message = typeof finding.message === 'string' ? finding.message.toLowerCase() : '';
        return id.includes('trap-door') || message.includes('unguarded trap door');
    }).length;
}
function exitCodeFor(findings, decisions, strict = false) {
    const critical = countSeverity(findings, 'Critical');
    const high = countSeverity(findings, 'High');
    const strictDecisionFindings = strict ? decisions.length : 0;
    return critical + (strict ? high : 0) + strictDecisionFindings > 0 ? 1 : 0;
}
function renderMarkdown(findings, decisions, summary, exitCode) {
    const lines = ['# Citadel Findings', ''];
    if (findings.length === 0) {
        lines.push('No findings.', '');
    }
    else {
        for (const finding of findings) {
            lines.push(`- **${finding.severity}** ${labelFor(finding)} ${citationFor(finding)} - ${descriptionFor(finding)}`);
        }
        lines.push('');
    }
    lines.push(`Decisions required: ${decisions.length}`);
    lines.push(summaryLine(summary, exitCode));
    return `${lines.join('\n')}\n`;
}
function summaryLine(summary, exitCode) {
    return [
        `Conformance audit: ${summary.findings} findings`,
        `(CRITICAL=${summary.critical}, HIGH=${summary.high}, MEDIUM=${summary.medium}, LOW=${summary.low})`,
        `${summary.decision_required} decisions required`,
        `${summary.unguarded_trap_doors} unguarded trap doors`,
        `exit ${exitCode}`,
    ].join(' ');
}
function labelFor(finding) {
    const id = typeof finding.acId === 'string'
        ? finding.acId
        : typeof finding.trapDoorId === 'string'
            ? finding.trapDoorId
            : finding.id;
    return `[${id}]`;
}
function citationFor(item) {
    const evidence = Array.isArray(item.evidence) ? item.evidence[0] : item.evidence;
    if (typeof evidence === 'string')
        return citationFromString(evidence);
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
function citationFromString(value) {
    const match = /(.+):(\d+)$/.exec(value.trim());
    return match ? `${match[1]}:${match[2]}` : 'unknown:0';
}
function descriptionFor(finding) {
    if (typeof finding.message === 'string' && finding.message.trim().length > 0) {
        return oneSentence(finding.message);
    }
    return oneSentence(finding.id);
}
function oneSentence(value) {
    const first = value.trim().split(/(?<=[.!?])\s+/)[0] ?? value.trim();
    return first.replace(/\s+/g, ' ');
}

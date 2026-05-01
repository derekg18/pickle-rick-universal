import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { auditStateTransitions } from '../services/citadel/state-transition-audit.js';
import { parsePrdMarkdown } from '../services/citadel/prd-parser.js';

function writeFile(repoRoot, filePath, content) {
  const fullPath = path.join(repoRoot, filePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function changedFile(filePath, kind = 'production') {
  return {
    path: filePath,
    status: 'M',
    kind,
    changedLines: [],
    blame: [],
  };
}

function diffSummary(repoRoot, changedFiles) {
  return {
    range: 'main..HEAD',
    base: 'main',
    head: 'HEAD',
    repoRoot,
    changedFiles,
    claudeFiles: [],
  };
}

describe('parsePrdMarkdown transition audit rows', () => {
  test('extracts Transition | Audit table rows with PRD citations', () => {
    const parsed = parsePrdMarkdown(
      [
        '# Feature PRD',
        '',
        '| Transition | Audit | Expected call site |',
        '|---|---|---|',
        '| draft -> approved | loan.approved | LoanStateService.approve |',
        '| approved -> funded | loan.funded | LoanStateService.fund |',
        '',
      ].join('\n'),
    );

    assert.deepEqual(parsed.transitionAuditRows, [
      {
        transition: 'draft -> approved',
        auditAction: 'loan.approved',
        expectedCallSite: 'LoanStateService.approve',
        line: 5,
        text: '| draft -> approved | loan.approved | LoanStateService.approve |',
      },
      {
        transition: 'approved -> funded',
        auditAction: 'loan.funded',
        expectedCallSite: 'LoanStateService.fund',
        line: 6,
        text: '| approved -> funded | loan.funded | LoanStateService.fund |',
      },
    ]);
  });

  test('does not carry transition table state into a following table header', () => {
    const parsed = parsePrdMarkdown(
      [
        '| Transition | Audit |',
        '|---|---|',
        '| draft -> approved | loan.approved |',
        '| Status | Code |',
        '| rejected | 409 |',
        '',
      ].join('\n'),
    );

    assert.deepEqual(
      parsed.transitionAuditRows.map((row) => [row.transition, row.auditAction]),
      [['draft -> approved', 'loan.approved']],
    );
  });
});

describe('auditStateTransitions', () => {
  test('reports emitted transitions and High findings for missing audit emits', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-transition-audit-'));
    try {
      writeFile(
        repoRoot,
        'src/loan-state.ts',
        [
          'export function approve(audit) {',
          '  audit.emit("loan.approved");',
          '}',
          '',
        ].join('\n'),
      );

      const parsed = parsePrdMarkdown(
        [
          '| Transition | Audit | Expected call site |',
          '|---|---|---|',
          '| draft -> approved | loan.approved | LoanStateService.approve |',
          '| approved -> funded | loan.funded | LoanStateService.fund |',
          '',
        ].join('\n'),
      );
      const report = auditStateTransitions(
        parsed.transitionAuditRows,
        diffSummary(repoRoot, [changedFile('src/loan-state.ts')]),
      );

      assert.equal(report.summary.total, 2);
      assert.equal(report.summary.emitted, 1);
      assert.equal(report.summary.missing, 1);
      assert.equal(report.rows[0].emitted, true);
      assert.deepEqual(report.rows[0].emitEvidence, [
        {
          file: 'src/loan-state.ts',
          line: 2,
          text: 'audit.emit("loan.approved");',
        },
      ]);
      assert.equal(report.findings.length, 1);
      assert.equal(report.findings[0].severity, 'High');
      assert.equal(report.findings[0].auditAction, 'loan.funded');
      assert.equal(report.findings[0].prd.line, 4);
      assert.equal(report.findings[0].expectedCallSite, 'LoanStateService.fund');
      assert.match(report.markdownTable, /draft -> approved/);
      assert.match(report.markdownTable, /missing; expected LoanStateService\.fund/);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('scans a 22k-line production diff within the AC-CIT-09 performance budget', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-transition-audit-'));
    try {
      const lines = Array.from({ length: 22_000 }, (_, index) => {
        if (index === 21_500) return 'audit.emit("loan.closed");';
        return `export const filler${index} = ${index};`;
      });
      writeFile(repoRoot, 'src/large-state-machine.ts', `${lines.join('\n')}\n`);

      const parsed = parsePrdMarkdown(
        [
          '| Transition | Audit | Expected call site |',
          '|---|---|---|',
          '| funded -> closed | loan.closed | LoanStateService.close |',
          '',
        ].join('\n'),
      );

      const start = process.hrtime.bigint();
      const report = auditStateTransitions(
        parsed.transitionAuditRows,
        diffSummary(repoRoot, [changedFile('src/large-state-machine.ts')]),
      );
      const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;

      assert.equal(report.summary.missing, 0);
      assert.equal(report.rows[0].emitEvidence[0].line, 21_501);
      assert.ok(durationMs < 120_000, `expected audit under 120s, got ${durationMs}ms`);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

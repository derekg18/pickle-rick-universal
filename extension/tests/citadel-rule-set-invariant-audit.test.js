import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { auditRuleSetInvariants } from '../services/citadel/rule-set-invariant-audit.js';
import { runCitadelAudit } from '../services/citadel/audit-runner.js';

function writeFile(repoRoot, filePath, content) {
  const fullPath = path.join(repoRoot, filePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function changedFile(filePath, kind = 'production', changedLines = [{ start: 1, end: 100 }]) {
  return {
    path: filePath,
    status: 'M',
    kind,
    changedLines,
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

function git(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf-8' }).trim();
}

function makeRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-rule-set-runner-'));
  git(repoRoot, ['init', '-q']);
  git(repoRoot, ['config', 'user.email', 'test@example.com']);
  git(repoRoot, ['config', 'user.name', 'Test User']);
  writeFile(repoRoot, 'prd.md', '# PRD\n\nNo invariant clauses.\n');
  writeFile(repoRoot, 'src/diff.ts', 'export const before = true;\n');
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-qm', 'base']);
  const base = git(repoRoot, ['rev-parse', 'HEAD']);
  writeFile(
    repoRoot,
    'src/diff.ts',
    [
      'export const DIFFERENCE_CODES = [',
      '  "DIFF_001",',
      '  "DIFF_002",',
      '  "DIFF_003",',
      '] as const;',
      '',
    ].join('\n'),
  );
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-qm', 'head']);
  return { repoRoot, base };
}

describe('auditRuleSetInvariants', () => {
  test('emits a Medium finding when a changed rule-set lacks an interaction invariant test', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-rule-set-'));
    try {
      writeFile(
        repoRoot,
        'src/diff.ts',
        [
          'export const DIFFERENCE_CODES = [',
          '  "DIFF_001",',
          '  "DIFF_002",',
          '  "DIFF_003",',
          '] as const;',
          '',
        ].join('\n'),
      );

      const report = auditRuleSetInvariants(
        diffSummary(repoRoot, [changedFile('src/diff.ts')]),
        { prdMarkdown: '# PRD\n' },
      );

      assert.equal(report.summary.declarations, 1);
      assert.equal(report.summary.covered, 0);
      assert.equal(report.summary.missing, 1);
      assert.equal(report.findings[0].severity, 'Medium');
      assert.equal(report.findings[0].declaration.name, 'DIFFERENCE_CODES');
      assert.deepEqual(report.inventory[0].members, ['DIFF_001', 'DIFF_002', 'DIFF_003']);
      assert.match(report.markdownTable, /DIFFERENCE_CODES/);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('marks a rule-set covered when a changed spec names multiple members and asserts a relationship', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-rule-set-'));
    try {
      writeFile(
        repoRoot,
        'src/diff.ts',
        [
          'export const DIFFERENCE_CODES = [',
          '  "DIFF_001",',
          '  "DIFF_002",',
          '  "DIFF_003",',
          '] as const;',
          '',
        ].join('\n'),
      );
      writeFile(
        repoRoot,
        'tests/diff.test.ts',
        [
          'test("single-field changes fire exactly one diff", () => {',
          '  const fired = ["DIFF_001"];',
          '  expect(["DIFF_001", "DIFF_002"].filter((code) => fired.includes(code)).length).toBe(1);',
          '});',
          '',
        ].join('\n'),
      );

      const report = auditRuleSetInvariants(
        diffSummary(repoRoot, [
          changedFile('src/diff.ts'),
          changedFile('tests/diff.test.ts', 'test'),
        ]),
        { prdMarkdown: '# PRD\n' },
      );

      assert.equal(report.summary.declarations, 1);
      assert.equal(report.summary.covered, 1);
      assert.equal(report.summary.missing, 0);
      assert.equal(report.findings.length, 0);
      assert.equal(report.inventory[0].invariantEvidence[0].file, 'tests/diff.test.ts');
      assert.equal(report.inventory[0].invariantEvidence[0].line, 1);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('promotes missing invariant findings to High when the PRD declares an explicit invariant', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-rule-set-'));
    try {
      writeFile(
        repoRoot,
        'src/diff.ts',
        [
          'export enum DifferenceCode {',
          '  DIFF_001 = "DIFF_001",',
          '  DIFF_002 = "DIFF_002",',
          '  DIFF_003 = "DIFF_003",',
          '}',
          '',
        ].join('\n'),
      );

      const report = auditRuleSetInvariants(
        diffSummary(repoRoot, [changedFile('src/diff.ts')]),
        {
          prdMarkdown: [
            '# PRD',
            '',
            'Exactly one of {DIFF_001, DIFF_002, DIFF_003} may fire for a single-field change.',
            '',
          ].join('\n'),
        },
      );

      assert.equal(report.summary.promoted, 1);
      assert.equal(report.findings[0].severity, 'High');
      assert.equal(report.findings[0].explicitInvariant.line, 3);
      assert.deepEqual(report.findings[0].explicitInvariant.matchedMembers, ['DIFF_001', 'DIFF_002', 'DIFF_003']);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('runCitadelAudit rule-set invariant integration', () => {
  test('exposes rule-set invariant coverage under the Citadel report sections', async () => {
    const { repoRoot, base } = makeRepo();
    try {
      const report = await runCitadelAudit({
        prdPath: 'prd.md',
        diffRange: `${base}..HEAD`,
        repoRoot,
      });

      assert.equal(report.sections.rule_set_invariants.summary.declarations, 1);
      assert.equal(report.sections.rule_set_invariants.summary.missing, 1);
      assert.ok(report.findings.some((finding) => finding.source_section === 'rule_set_invariants'));
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

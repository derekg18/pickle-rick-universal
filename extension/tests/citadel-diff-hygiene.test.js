import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCitadelAudit } from '../services/citadel/audit-runner.js';
import {
  auditDiffHygiene,
  auditSzechuanDiffHygiene,
  ENV_FILE_ALLOWLIST,
  LARGE_FILE_BYTES,
  ROOT_MARKDOWN_ALLOWLIST,
} from '../services/citadel/diff-hygiene.js';

function git(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf-8' }).trim();
}

function writeFile(repoRoot, filePath, content) {
  const fullPath = path.join(repoRoot, filePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function createRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-diff-hygiene-'));
  git(repoRoot, ['init', '-q']);
  git(repoRoot, ['config', 'user.email', 'test@example.com']);
  git(repoRoot, ['config', 'user.name', 'Test User']);
  writeFile(repoRoot, 'prd.md', '# PRD\n\n## Acceptance Criteria\n\n**AC-TEST-01**: Stable.\n');
  writeFile(repoRoot, '.gitignore', 'ignored-large.bin\n');
  writeFile(repoRoot, 'src/index.ts', 'export const before = true;\n');
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-qm', 'base']);
  return { repoRoot, base: git(repoRoot, ['rev-parse', 'HEAD']) };
}

function addHygieneFiles(repoRoot) {
  writeFile(repoRoot, 'continuation_plan.md', '# accidental plan\n');
  writeFile(repoRoot, 'README.md', '# allowed\n');
  writeFile(repoRoot, 'notes.txt', 'scratch\n');
  writeFile(repoRoot, 'nested/notes.md', '# nested allowed by T10.9 root rule\n');
  writeFile(repoRoot, '.env.local', 'SECRET=value\n');
  writeFile(repoRoot, '.env.example', 'SECRET=\n');
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-qm', 'add hygiene files']);
}

async function runAudit(repoRoot, base, sessionDir) {
  return runCitadelAudit({
    prdPath: 'prd.md',
    diffRange: `${base}..HEAD`,
    repoRoot,
    sessionDir,
  });
}

describe('citadel diff hygiene', () => {
  test('exports shared diff-hygiene allowlist constants', () => {
    assert.deepEqual(
      [...ROOT_MARKDOWN_ALLOWLIST].sort(),
      ['AGENTS.md', 'CHANGELOG.md', 'CLAUDE.md', 'LICENSE.md', 'README.md'],
    );
    assert.deepEqual([...ENV_FILE_ALLOWLIST], ['.env.example']);
    assert.equal(LARGE_FILE_BYTES, 1024 * 1024);
    assert.equal(ROOT_MARKDOWN_ALLOWLIST.has('notes.md'), false);
  });

  test('reports root notes.md as a P1 szechuan hygiene finding', () => {
    const report = auditSzechuanDiffHygiene({
      range: 'base..HEAD',
      base: 'base',
      head: 'HEAD',
      repoRoot: process.cwd(),
      claudeFiles: [],
      changedFiles: [{
        path: 'notes.md',
        status: 'A',
        kind: 'production',
        changedLines: [{ start: 1, end: 1 }],
        blame: [],
      }],
    });

    const finding = report.findings.find((candidate) => candidate.file === 'notes.md');
    assert.ok(finding, 'expected root notes.md to produce a hygiene finding');
    assert.equal(finding.priority, 'P1');
    assert.equal(finding.severity, 'P1');
    assert.equal(finding.category, 'hygiene');
    assert.equal(finding.principle, 'Diff Hygiene');
    assert.ok(finding.message.includes('orphan planning doc'));
  });

  test('reports T10.9 added-file hygiene findings and allowlist exceptions', async () => {
    const { repoRoot, base } = createRepo();
    try {
      addHygieneFiles(repoRoot);

      const report = await runAudit(repoRoot, base);
      const byFile = new Map(report.sections.diff_hygiene.findings.map((finding) => [finding.file, finding]));

      assert.equal(report.sections.diff_hygiene.summary.added_files_scanned, 6);
      assert.equal(report.sections.diff_hygiene.summary.suppressed_by_szechuan, 0);
      assert.equal(byFile.get('continuation_plan.md')?.rule, 'root-markdown-orphan');
      assert.equal(byFile.get('continuation_plan.md')?.severity, 'Medium');
      assert.equal(byFile.get('notes.txt')?.rule, 'root-scratch-artifact');
      assert.equal(byFile.get('.env.local')?.rule, 'env-file');
      assert.equal(byFile.get('.env.local')?.severity, 'Critical');
      assert.ok(!byFile.has('README.md'));
      assert.ok(!byFile.has('.env.example'));
      assert.ok(!byFile.has('nested/notes.md'));
      assert.ok(report.findings.some((finding) => finding.source_section === 'diff_hygiene'));
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('suppresses same-diff hygiene findings already reported by szechuan-sauce', async () => {
    const { repoRoot, base } = createRepo();
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-diff-hygiene-session-'));
    try {
      addHygieneFiles(repoRoot);
      writeFile(sessionDir, 'szechuan-sauce.json', JSON.stringify({
        findings: [
          {
            id: 'szechuan-hygiene-notes',
            severity: 'Medium',
            category: 'hygiene',
            rule: 'root-scratch-artifact',
            file: 'notes.txt',
            message: 'Root notes file is an orphan planning artifact.',
          },
        ],
      }));

      const report = await runAudit(repoRoot, base, sessionDir);
      const files = report.sections.diff_hygiene.findings.map((finding) => finding.file);

      assert.equal(report.sections.diff_hygiene.summary.suppressed_by_szechuan, 1);
      assert.ok(!files.includes('notes.txt'));
      assert.ok(files.includes('continuation_plan.md'));
      assert.ok(report.sections.cross_phase.findings.some((finding) => finding.id === 'szechuan-hygiene-notes'));
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  test('does not report large files that match gitignore', () => {
    const { repoRoot } = createRepo();
    try {
      writeFile(repoRoot, 'ignored-large.bin', 'x'.repeat(1024 * 1024 + 1));

      const report = auditDiffHygiene({
        range: 'base..HEAD',
        base: 'base',
        head: 'HEAD',
        repoRoot,
        claudeFiles: [],
        changedFiles: [{
          path: 'ignored-large.bin',
          status: 'A',
          kind: 'production',
          changedLines: [{ start: 1, end: 1 }],
          blame: [],
        }],
      });

      assert.deepEqual(report.findings, []);
      assert.equal(report.summary.added_files_scanned, 1);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('reports large added files when they are not gitignored', () => {
    const { repoRoot } = createRepo();
    try {
      writeFile(repoRoot, 'large.bin', 'x'.repeat(1024 * 1024 + 1));

      const report = auditDiffHygiene({
        range: 'base..HEAD',
        base: 'base',
        head: 'HEAD',
        repoRoot,
        claudeFiles: [],
        changedFiles: [{
          path: 'large.bin',
          status: 'A',
          kind: 'production',
          changedLines: [{ start: 1, end: 1 }],
          blame: [],
        }],
      });

      assert.equal(report.findings.length, 1);
      assert.equal(report.findings[0].rule, 'large-unignored-file');
      assert.equal(report.findings[0].severity, 'High');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

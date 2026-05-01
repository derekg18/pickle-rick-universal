import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCitadelAudit } from '../services/citadel/audit-runner.js';

function git(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf-8' }).trim();
}

function writeFile(repoRoot, filePath, content) {
  const fullPath = path.join(repoRoot, filePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function createRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-divergence-'));
  git(repoRoot, ['init', '-q']);
  git(repoRoot, ['config', 'user.email', 'test@example.com']);
  git(repoRoot, ['config', 'user.name', 'Test User']);
  writeFile(repoRoot, 'prd.md', [
    '# PRD',
    '',
    '## Acceptance Criteria',
    '',
    '**AC-FF-05**: Feature flag off behavior returns 403 for comparison retry endpoints.',
    '',
  ].join('\n'));
  writeFile(repoRoot, 'src/index.ts', 'export const behavior = "prd";\n');
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-qm', 'base']);
  return { repoRoot, base: git(repoRoot, ['rev-parse', 'HEAD']) };
}

describe('citadel divergence reconciliation', () => {
  test('reports test and trap-door PRD divergences as decision-required only', async () => {
    const { repoRoot, base } = createRepo();
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-divergence-session-'));
    try {
      writeFile(repoRoot, 'src/index.ts', 'export const behavior = "shipped";\n');
      writeFile(repoRoot, 'tests/behavior.test.js', [
        'import assert from "node:assert/strict";',
        '',
        'assert.equal("live", "live"); // AC-FF-05 product decision: shipped behavior contradicts PRD and test locks it.',
        '',
      ].join('\n'));
      writeFile(repoRoot, 'CLAUDE.md', [
        '# Local contracts',
        '',
        '- trap-door: rollback must stay live; this contradicts PRD AC-FF-05 until product amends one document.',
        '',
      ].join('\n'));
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-qm', 'add divergent behavior']);

      const report = await runCitadelAudit({
        prdPath: 'prd.md',
        diffRange: `${base}..HEAD`,
        repoRoot,
        sessionDir,
        strict: true,
      });

      assert.equal(report.sections.divergence_reconciliation.summary.changed_tests_scanned, 1);
      assert.equal(report.sections.divergence_reconciliation.summary.trap_door_files_scanned, 1);
      assert.equal(report.sections.divergence_reconciliation.decisionsRequired.length, 2);
      assert.equal(report.sections.divergence_reconciliation.findings.length, 0);
      assert.ok(report.decision_required.some((decision) => decision.kind === 'test-locks-prd-divergence'));
      assert.ok(report.decision_required.some((decision) => decision.kind === 'trap-door-prd-contradiction'));
      assert.ok(!report.findings.some((finding) => finding.source_section === 'divergence_reconciliation'));
      assert.equal(report.exit_code, 1);

      const persisted = JSON.parse(fs.readFileSync(path.join(sessionDir, 'citadel_report.json'), 'utf-8'));
      assert.equal(persisted.summary.decision_required, 2);
      assert.equal(persisted.sections.divergence_reconciliation.decisionsRequired.length, 2);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { auditAcShape } from '../services/citadel/ac-shape-audit.js';
import { runCitadelAudit } from '../services/citadel/audit-runner.js';

function writeFile(root, filePath, content) {
  const fullPath = path.join(root, filePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function git(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf-8' }).trim();
}

function loaShapePrd() {
  return [
    '# LOA-618 PRD',
    '',
    '## Acceptance Criteria',
    '',
    '**AC-FF-05**: Feature flag off behavior is enforced.',
    '- POST /api/runs/{runId}/retry returns 403 when comparison_retry_enabled is off.',
    '- POST /api/runs/{runId}/cancel returns 403 when comparison_retry_enabled is off.',
    '- PATCH /api/runs/{runId}/override returns 403 when comparison_retry_enabled is off.',
    '',
  ].join('\n');
}

function refinedManifestRows(extra = '') {
  return [
    '# Refined PRD',
    '',
    '| Order | Key | ID | Source PRD | Section | Title | ACs |',
    '|---|---|---|---|---|---|---|',
    '| 1 | T1 | a | `prd.md` | Tasks | Retry flag | AC-FF-05 |',
    '| 2 | T2 | b | `prd.md` | Tasks | Cancel flag | AC-FF-05 |',
    '| 3 | T3 | c | `prd.md` | Tasks | Override flag | AC-FF-05 |',
    extra,
    '',
  ].join('\n');
}

describe('auditAcShape', () => {
  test('surfaces LOA-shaped AC-FF-05 in decision required with suggested rewrite', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-ac-shape-'));
    try {
      const prdPath = path.join(tmp, 'loa-618-prd.md');
      fs.writeFileSync(prdPath, loaShapePrd());

      const report = auditAcShape({ prdPath });

      assert.equal(report.decisionsRequired.length, 1);
      assert.equal(report.decisionsRequired[0].acId, 'AC-FF-05');
      assert.equal(report.decisionsRequired[0].severity, 'Medium');
      assert.match(report.decisionsRequired[0].message, /AC-FF-05 enumerates 3 distinct targets/);
      assert.equal(
        report.decisionsRequired[0].suggestion,
        "Rewrite as 'every <resource> endpoint <predicate>' with a parametrized test.",
      );
      assert.equal(report.findings.length, 0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('escalates to High when refined manifest fans AC-FF-05 into three unjustified tickets', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-ac-shape-'));
    try {
      const prdPath = path.join(tmp, 'loa-618-prd.md');
      fs.writeFileSync(prdPath, loaShapePrd());
      fs.writeFileSync(path.join(tmp, 'prd_refined.md'), refinedManifestRows());

      const report = auditAcShape({ prdPath, sessionDir: tmp });

      assert.equal(report.decisionsRequired.length, 1);
      assert.equal(report.decisionsRequired[0].severity, 'High');
      assert.equal(report.decisionsRequired[0].refinementTicketCount, 3);
      assert.equal(report.findings.length, 1);
      assert.equal(report.findings[0].severity, 'High');
      assert.match(report.findings[0].message, /without a justification block/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('keeps fan-out as decision-only when manifest has a justification block', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-ac-shape-'));
    try {
      const prdPath = path.join(tmp, 'loa-618-prd.md');
      fs.writeFileSync(prdPath, loaShapePrd());
      fs.writeFileSync(path.join(tmp, 'prd_refined.md'), refinedManifestRows('// JUSTIFICATION: endpoint split is required by deployment ownership.'));

      const report = auditAcShape({ prdPath, sessionDir: tmp });

      assert.equal(report.decisionsRequired.length, 1);
      assert.equal(report.decisionsRequired[0].severity, 'Medium');
      assert.equal(report.findings.length, 0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('detects repeated predicates across plain handler targets', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-ac-shape-'));
    try {
      const prdPath = path.join(tmp, 'handler-prd.md');
      fs.writeFileSync(prdPath, [
        '# Handler PRD',
        '',
        '## Acceptance Criteria',
        '',
        '**AC-HND-01**: Retry lockouts are enforced.',
        '- handler retryRun rejects requests when retry_lock_enabled is off.',
        '- handler cancelRun rejects requests when retry_lock_enabled is off.',
        '- handler overrideRun rejects requests when retry_lock_enabled is off.',
        '',
      ].join('\n'));

      const report = auditAcShape({ prdPath });

      assert.equal(report.decisionsRequired.length, 1);
      assert.equal(report.decisionsRequired[0].acId, 'AC-HND-01');
      assert.deepEqual(report.decisionsRequired[0].distinctTargets, ['cancelRun', 'overrideRun', 'retryRun']);
      assert.match(report.decisionsRequired[0].message, /enumerates 3 distinct targets/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('runCitadelAudit AC-CIT-12 behavior', () => {
  test('writes AC-shape decisions and High escalation into the Citadel report', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-ac-shape-repo-'));
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-ac-shape-session-'));
    try {
      git(repoRoot, ['init', '-q']);
      git(repoRoot, ['config', 'user.email', 'test@example.com']);
      git(repoRoot, ['config', 'user.name', 'Test User']);
      writeFile(repoRoot, 'prd.md', loaShapePrd());
      writeFile(repoRoot, 'src/index.ts', 'export const before = true;\n');
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-qm', 'base']);
      const base = git(repoRoot, ['rev-parse', 'HEAD']);
      writeFile(repoRoot, 'src/index.ts', 'export const after = true;\n');
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-qm', 'head']);
      fs.writeFileSync(path.join(sessionDir, 'prd_refined.md'), refinedManifestRows());

      const report = await runCitadelAudit({
        prdPath: 'prd.md',
        diffRange: `${base}..HEAD`,
        repoRoot,
        sessionDir,
        strict: true,
      });

      assert.equal(report.decision_required.length, 1);
      assert.equal(report.decision_required[0].acId, 'AC-FF-05');
      assert.equal(report.sections.ac_shape.findings.length, 1);
      assert.equal(report.summary.high, 1);
      assert.equal(report.exit_code, 1);
      const persisted = JSON.parse(fs.readFileSync(path.join(sessionDir, 'citadel_report.json'), 'utf-8'));
      assert.equal(persisted.decision_required[0].suggestion, "Rewrite as 'every <resource> endpoint <predicate>' with a parametrized test.");
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});

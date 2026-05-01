import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { auditFrontendPropDrift } from '../services/citadel/frontend-prop-drift-audit.js';
import { runCitadelAudit } from '../services/citadel/audit-runner.js';

function writeFile(repoRoot, filePath, content) {
  const fullPath = path.join(repoRoot, filePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function changedFile(filePath) {
  return {
    path: filePath,
    status: 'M',
    kind: 'production',
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

function git(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf-8' }).trim();
}

function createGitRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-frontend-prop-'));
  git(repoRoot, ['init', '-q']);
  git(repoRoot, ['config', 'user.email', 'test@example.com']);
  git(repoRoot, ['config', 'user.name', 'Test User']);
  writeFile(repoRoot, 'prd.md', '# Fixture PRD\n');
  writeFile(repoRoot, 'src/Page.tsx', 'export function Page() { return null; }\n');
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-qm', 'base']);
  const base = git(repoRoot, ['rev-parse', 'HEAD']);
  return { repoRoot, base };
}

const comparisonFixture = [
  'interface ComparisonCardProps {',
  '  title: string;',
  '}',
  '',
  'function ComparisonCard(props: ComparisonCardProps) {',
  '  return <section>{props.title}</section>;',
  '}',
  '',
  'export function Page() {',
  '  return <ComparisonCard title="Run" comparisonData={{ id: "run-1" }} />;',
  '}',
  '',
].join('\n');

describe('auditFrontendPropDrift', () => {
  test('reports comparisonData passed to a component whose props omit it', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-frontend-prop-'));
    try {
      writeFile(repoRoot, 'src/Page.tsx', comparisonFixture);

      const report = auditFrontendPropDrift(diffSummary(repoRoot, [changedFile('src/Page.tsx')]));

      assert.equal(report.findings.length, 1);
      assert.equal(report.findings[0].severity, 'High');
      assert.equal(report.findings[0].component, 'ComparisonCard');
      assert.deepEqual(report.findings[0].undeclaredProps, ['comparisonData']);
      assert.deepEqual(report.findings[0].declaredProps, ['title']);
      assert.match(report.findings[0].message, /comparisonData/);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('records spread props as blind spots without flagging explicit drift on that invocation', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-frontend-spread-'));
    try {
      writeFile(
        repoRoot,
        'src/Page.tsx',
        [
          'type ComparisonCardProps = { title: string };',
          'const ComparisonCard = (props: ComparisonCardProps) => <section>{props.title}</section>;',
          'export function Page() {',
          '  const rest = { comparisonData: { id: "run-1" } };',
          '  return <ComparisonCard {...rest} title="Run" comparisonData={{ id: "run-2" }} />;',
          '}',
          '',
        ].join('\n'),
      );

      const report = auditFrontendPropDrift(diffSummary(repoRoot, [changedFile('src/Page.tsx')]));

      assert.equal(report.findings.length, 0);
      assert.equal(report.spreadBlindSpots.length, 1);
      assert.equal(report.spreadBlindSpots[0].component, 'ComparisonCard');
      assert.match(report.header, /Spread props are not analyzed/);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('runCitadelAudit frontend_prop_drift section', () => {
  test('writes frontend prop drift findings into the Citadel report and summary', async () => {
    const { repoRoot, base } = createGitRepo();
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-session-'));
    try {
      writeFile(repoRoot, 'src/Page.tsx', comparisonFixture);
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-qm', 'head']);

      const report = await runCitadelAudit({
        prdPath: 'prd.md',
        diffRange: `${base}..HEAD`,
        repoRoot,
        sessionDir,
        strict: true,
      });
      const persisted = JSON.parse(fs.readFileSync(path.join(sessionDir, 'citadel_report.json'), 'utf-8'));

      assert.equal(report.exit_code, 1);
      assert.equal(report.summary.findings, 2);
      assert.equal(report.summary.high, 1);
      assert.equal(report.summary.low, 1);
      assert.equal(report.sections.frontend_prop_drift.findings.length, 1);
      assert.equal(report.sections.cross_phase.findings[0].id, 'anatomy-park:missing');
      assert.equal(persisted.sections.frontend_prop_drift.findings[0].undeclaredProps[0], 'comparisonData');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});

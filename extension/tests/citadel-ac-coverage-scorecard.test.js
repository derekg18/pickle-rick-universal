import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildAcCoverageScorecard, extractKeywordAnchors } from '../services/citadel/ac-coverage-scorecard.js';

function writeFile(repoRoot, filePath, content) {
  const fullPath = path.join(repoRoot, filePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function changedFile(filePath, kind) {
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

describe('buildAcCoverageScorecard', () => {
  test('matches implementation by keyword-anchor symbol and test by symbol reference', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-ac-scorecard-'));
    try {
      writeFile(
        repoRoot,
        'src/comparison-retry.ts',
        [
          'export function buildComparisonRetryGuard() {',
          '  return true;',
          '}',
          '',
        ].join('\n'),
      );
      writeFile(
        repoRoot,
        'tests/comparison-retry.test.ts',
        [
          'import { buildComparisonRetryGuard } from "../src/comparison-retry";',
          '',
          'test("comparison retry guard", () => {',
          '  assert.equal(buildComparisonRetryGuard(), true);',
          '});',
          '',
        ].join('\n'),
      );

      const result = buildAcCoverageScorecard(
        [
          {
            id: 'AC-FF-01',
            line: 7,
            text: '- **AC-FF-01**: Comparison retry validates failed child extraction.',
          },
        ],
        diffSummary(repoRoot, [
          changedFile('src/comparison-retry.ts', 'production'),
          changedFile('tests/comparison-retry.test.ts', 'test'),
        ]),
      );

      assert.equal(result.summary.total, 1);
      assert.equal(result.summary.implemented, 1);
      assert.equal(result.summary.tested, 1);
      assert.deepEqual(result.findings, []);
      assert.equal(result.rows[0].implementationEvidence[0].match, 'comparison');
      assert.equal(result.rows[0].implementationEvidence[0].symbol, 'buildComparisonRetryGuard');
      assert.equal(result.rows[0].testEvidence[0].matchType, 'symbol');
      assert.match(result.markdownTable, /\| AC-FF-01 \| ✓ \| ✓ \| src\/comparison-retry\.ts:1 \+ tests\/comparison-retry\.test\.ts:1 \|/);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('matches direct AC IDs and emits High finding when changed test evidence is missing', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-ac-scorecard-'));
    try {
      writeFile(
        repoRoot,
        'src/audit-phase.ts',
        [
          '// AC-CIT-04: phase integration validates scorecard behavior',
          'export function runCitadelPhase() {',
          '  return "ok";',
          '}',
          '',
        ].join('\n'),
      );

      const result = buildAcCoverageScorecard(
        [
          {
            id: 'AC-CIT-04',
            line: 11,
            text: '- **AC-CIT-04**: pipeline phase integration validates scorecard behavior.',
          },
        ],
        diffSummary(repoRoot, [changedFile('src/audit-phase.ts', 'production')]),
      );

      assert.equal(result.rows[0].implemented, true);
      assert.equal(result.rows[0].tested, false);
      assert.equal(result.findings.length, 1);
      assert.equal(result.findings[0].severity, 'High');
      assert.equal(result.findings[0].acId, 'AC-CIT-04');
      assert.match(result.markdownTable, /\(no test found\)/);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('emits Critical finding and no-enforcement table evidence when implementation is absent', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-ac-scorecard-'));
    try {
      writeFile(repoRoot, 'tests/orphan.test.ts', 'test("unrelated", () => {});\n');

      const result = buildAcCoverageScorecard(
        [
          {
            id: 'AC-FF-05',
            line: 19,
            text: '- **AC-FF-05**: destructive role drift is rejected.',
          },
        ],
        diffSummary(repoRoot, [changedFile('tests/orphan.test.ts', 'test')]),
      );

      assert.equal(result.summary.missingImplementation, 1);
      assert.equal(result.summary.missingTests, 0);
      assert.equal(result.rows[0].implemented, false);
      assert.equal(result.rows[0].tested, false);
      assert.equal(result.findings.length, 1);
      assert.equal(result.findings[0].severity, 'Critical');
      assert.match(result.markdownTable, /\| AC-FF-05 \| ✗ \| ✗ \| \(no enforcement found\) \|/);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('uses optional LLM entity mappings when keyword anchors miss implementation symbols', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-ac-scorecard-'));
    try {
      writeFile(
        repoRoot,
        'src/routes.ts',
        [
          'export function enforceLoa618RetryChildExtraction() {',
          '  return true;',
          '}',
          '',
        ].join('\n'),
      );
      writeFile(
        repoRoot,
        'tests/routes.test.ts',
        [
          'import { enforceLoa618RetryChildExtraction } from "../src/routes";',
          '',
          'test("regression keeps LOA-618 route locked", () => {',
          '  assert.equal(enforceLoa618RetryChildExtraction(), true);',
          '});',
          '',
        ].join('\n'),
      );

      const acceptanceCriteria = [
        {
          id: 'AC-CIT-99',
          line: 21,
          text: '- **AC-CIT-99**: Coverage captures the semantic regression.',
        },
      ];
      const diff = diffSummary(repoRoot, [
        changedFile('src/routes.ts', 'production'),
        changedFile('tests/routes.test.ts', 'test'),
      ]);

      const keywordOnly = buildAcCoverageScorecard(acceptanceCriteria, diff);
      assert.equal(keywordOnly.rows[0].implemented, false);
      assert.equal(keywordOnly.findings[0].severity, 'Critical');

      const assisted = buildAcCoverageScorecard(acceptanceCriteria, diff, {
        llmEntityMappings: [
          {
            acId: 'AC-CIT-99',
            expectedSymbols: ['enforceLoa618RetryChildExtraction'],
          },
        ],
      });

      assert.equal(assisted.rows[0].implemented, true);
      assert.equal(assisted.rows[0].tested, true);
      assert.deepEqual(assisted.findings, []);
      assert.equal(assisted.rows[0].implementationEvidence[0].matchType, 'llm_entity');
      assert.equal(assisted.rows[0].implementationEvidence[0].match, 'enforceLoa618RetryChildExtraction');
      assert.equal(assisted.rows[0].testEvidence[0].matchType, 'symbol');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('extractKeywordAnchors', () => {
  test('drops IDs and filler words while preserving useful anchors', () => {
    assert.deepEqual(extractKeywordAnchors('AC-FF-01: Comparison retry validates failed child extraction tests'), [
      'child',
      'comparison',
      'extraction',
      'failed',
      'retry',
      'validates',
    ]);
  });
});

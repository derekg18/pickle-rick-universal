import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectAllowlistDeadEntries } from '../services/citadel/allowlist-dead-entry-detector.js';

function writeFile(repoRoot, filePath, content) {
  const fullPath = path.join(repoRoot, filePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function changedFile(filePath, changedLines) {
  return {
    path: filePath,
    status: 'M',
    kind: 'production',
    changedLines: changedLines.map((line) => ({ start: line, end: line })),
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

describe('detectAllowlistDeadEntries', () => {
  test('reports added allowlist entries with no production callers', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-allowlist-dead-'));
    try {
      writeFile(
        repoRoot,
        'src/allowlists.ts',
        [
          'export const VALID_ACTIONS = [',
          "  'audit.live',",
          "  'audit.dead',",
          "  'audit.test_only',",
          '];',
          '',
          'export const lender_feature_flags = {',
          '  live_flag: true,',
          '  dead_flag: true,',
          '};',
          '',
          'export enum AppraisalEvent {',
          "  Live = 'appraisal.live',",
          "  Dead = 'appraisal.dead',",
          '}',
          '',
        ].join('\n'),
      );
      writeFile(
        repoRoot,
        'src/live-callers.ts',
        [
          "export const emittedAction = 'audit.live';",
          "export const enabledFlag = 'live_flag';",
          "export const emittedEvent = 'appraisal.live';",
          '',
        ].join('\n'),
      );
      writeFile(
        repoRoot,
        'tests/allowlist.test.ts',
        [
          "test('references are not callers', () => {",
          "  const action = 'audit.test_only';",
          "  const flag = 'dead_flag';",
          "  const event = 'appraisal.dead';",
          '});',
          '',
        ].join('\n'),
      );

      const result = detectAllowlistDeadEntries(
        diffSummary(repoRoot, [changedFile('src/allowlists.ts', [2, 3, 4, 8, 9, 13, 14])]),
      );

      assert.deepEqual(
        result.entries.map((entry) => [entry.kind, entry.value, entry.file, entry.line]),
        [
          ['valid_action', 'audit.live', 'src/allowlists.ts', 2],
          ['valid_action', 'audit.dead', 'src/allowlists.ts', 3],
          ['valid_action', 'audit.test_only', 'src/allowlists.ts', 4],
          ['lender_feature_flag', 'live_flag', 'src/allowlists.ts', 8],
          ['lender_feature_flag', 'dead_flag', 'src/allowlists.ts', 9],
          ['enum_value', 'appraisal.live', 'src/allowlists.ts', 13],
          ['enum_value', 'appraisal.dead', 'src/allowlists.ts', 14],
        ],
      );
      assert.deepEqual(
        result.liveEntries.map((live) => [live.entry.kind, live.entry.value, live.callers[0].file, live.callers[0].line]),
        [
          ['valid_action', 'audit.live', 'src/live-callers.ts', 1],
          ['lender_feature_flag', 'live_flag', 'src/live-callers.ts', 2],
          ['enum_value', 'appraisal.live', 'src/live-callers.ts', 3],
        ],
      );
      assert.deepEqual(
        result.findings.map((finding) => [
          finding.severity,
          finding.entry.kind,
          finding.entry.value,
          finding.declaration.file,
          finding.declaration.line,
        ]),
        [
          ['High', 'valid_action', 'audit.dead', 'src/allowlists.ts', 3],
          ['High', 'valid_action', 'audit.test_only', 'src/allowlists.ts', 4],
          ['High', 'lender_feature_flag', 'dead_flag', 'src/allowlists.ts', 9],
          ['High', 'enum_value', 'appraisal.dead', 'src/allowlists.ts', 14],
        ],
      );
      assert.match(result.findings[0].message, /dead allowlist; deploy-ordering smell/);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

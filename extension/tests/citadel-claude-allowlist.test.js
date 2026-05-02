import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { auditAllowlistDeadEntries } from '../services/citadel/allowlist-dead-entry-detector.js';

function writeFile(repoRoot, filePath, content) {
  const fullPath = path.join(repoRoot, filePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function changedFile(filePath, changedLines, kind = 'production') {
  return {
    path: filePath,
    status: 'M',
    kind,
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
    claudeFiles: changedFiles.filter(f => f.path.endsWith('CLAUDE.md')).map(f => f.path),
  };
}

describe('auditAllowlistDeadEntries with CLAUDE.md', () => {
  test('reports dead entries declared in CLAUDE.md', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-claude-allowlist-'));
    try {
      writeFile(
        repoRoot,
        'CLAUDE.md',
        [
          '# Rules',
          '',
          '## VALID_ACTIONS',
          "- `action.live`",
          "- `action.dead`",
          '',
          '## lender_feature_flags',
          '| Flag | Description |',
          '|------|-------------|',
          '| `flag.live` | Live |',
          '| `flag.dead` | Dead |',
        ].join('\n'),
      );
      writeFile(
        repoRoot,
        'src/app.ts',
        [
          "const a = 'action.live';",
          "const b = 'flag.live';",
        ].join('\n'),
      );

      const result = auditAllowlistDeadEntries(
        diffSummary(repoRoot, [
          changedFile('CLAUDE.md', [4, 5, 10, 11], 'production'),
        ]),
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
          ['High', 'valid_action', 'action.dead', 'CLAUDE.md', 5],
          ['High', 'lender_feature_flag', 'flag.dead', 'CLAUDE.md', 11],
        ],
      );
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

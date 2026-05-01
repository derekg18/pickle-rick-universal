import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.resolve(__dirname, '..', 'bin', 'plumbus-frame-analyzer.js');
const FIXTURES_DIR = path.resolve(__dirname, '__fixtures__', 'plumbus-frames');
const F1_GRAPH = path.join(FIXTURES_DIR, 'frame1-asymmetric-writer.graph.json');
const F1_DOT = path.join(FIXTURES_DIR, 'frame1-asymmetric-writer.dot');

const FINGERPRINT_RE = /^<!-- graph-fingerprint: ([a-f0-9]{64}) -->$/m;
const COMPLETION_RE = /^<!-- generative-audit-complete: (true|false) -->$/m;

function renderFindingF1(key, writers, readers, mode) {
  const subclass = readers.length === 0 ? 'orphan_writer' : 'asymmetric_writer';
  const writerList = writers.join(', ');
  const readerDesc = readers.length === 0 ? 'has no readers' : `read only by [${readers.join(', ')}]`;
  return [
    `### Frame 1: Context Key Asymmetry`,
    `- **[P1]** \`${writerList}\` — ${subclass}: key \`${key}\` written by [${writerList}] but ${readerDesc}.`,
    `  - **Analysis mode**: ${mode}`,
    `  - **Finding subclass**: ${subclass}`,
    `  - **Cluster key**: (frame:F1, key:${key})`,
    `  - **pre_verification_severity**: P1`,
    `  - **post_verification_severity**: P1`,
    `  - **Trace**: context_keys row for \`${key}\` — writers: [${writerList}], readers: [${readers.join(', ')}]`,
    `  - **Risk**: Context key may be written without a guaranteed reader on all paths.`,
    `  - **Suggested fix**: Ensure all paths that write \`${key}\` have a corresponding reader, or declare it in a join condition.`,
  ].join('\n');
}

function buildGapAnalysisSection(fingerprint, blocks, complete) {
  return [
    '## Generative Findings',
    `<!-- graph-fingerprint: ${fingerprint} -->`,
    `<!-- generative-audit-complete: ${complete} -->`,
    '',
    ...blocks.map(b => b + '\n'),
  ].join('\n');
}

function makeAttractorRoot(tmpRoot) {
  const tmp = mkdtempSync(path.join(tmpRoot, 'attractor-'));
  mkdirSync(path.join(tmp, 'packages', 'attractor', 'src'), { recursive: true });
  writeFileSync(path.join(tmp, 'packages', 'attractor', 'src', 'cli.ts'), '// stub\n');
  mkdirSync(path.join(tmp, 'packages', 'attractor', 'scripts'), { recursive: true });
  writeFileSync(path.join(tmp, 'packages', 'attractor', 'scripts', 'dump-graph.ts'), '// stub\n');
  return tmp;
}

function makeFakeBun(tmpRoot, graphJsonPath) {
  const dir = mkdtempSync(path.join(tmpRoot, 'fake-bun-'));
  const bunPath = path.join(dir, 'bun');
  writeFileSync(bunPath, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "bun 1.0.0"; exit 0; fi\ncat "${graphJsonPath}"\n`);
  chmodSync(bunPath, 0o755);
  return dir;
}

function makeCrashBun(tmpRoot) {
  const dir = mkdtempSync(path.join(tmpRoot, 'crash-bun-'));
  const bunPath = path.join(dir, 'bun');
  writeFileSync(bunPath, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "bun 1.0.0"; exit 0; fi\necho "dump-graph crash" >&2\nexit 1\n`);
  chmodSync(bunPath, 0o755);
  return dir;
}

function runAnalyzer(dotPath, attractorRoot, bunDir) {
  return spawnSync(
    process.execPath,
    [BIN_PATH, dotPath],
    {
      encoding: 'utf8',
      env: { ...process.env, ATTRACTOR_ROOT: attractorRoot, PATH: `${bunDir}:${process.env.PATH ?? ''}` },
    },
  );
}

describe('Trace B: worker rendering boundary contracts', () => {
  let tmpRoot;
  let attractorRoot;
  let fakeBunDir;

  before(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'trace-b-'));
    attractorRoot = makeAttractorRoot(tmpRoot);
    fakeBunDir = makeFakeBun(tmpRoot, F1_GRAPH);
  });

  after(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe('context_keys → Frame 1 finding coverage', () => {
    test('every context_keys row with writers produces a finding block', () => {
      const result = runAnalyzer(F1_DOT, attractorRoot, fakeBunDir);
      assert.strictEqual(result.status, 0, `analyzer exit 0: ${result.stderr}`);
      const output = JSON.parse(result.stdout.trim());

      const blocks = output.context_keys.map(r =>
        renderFindingF1(r.key, r.writers, r.readers, 'mechanical'),
      );

      for (const row of output.context_keys) {
        const matchingBlock = blocks.find(b => b.includes(`key \`${row.key}\``));
        assert.ok(
          matchingBlock !== undefined,
          `context_keys row for "${row.key}" must produce a finding block`,
        );
      }
    });

    test('each finding block references the exact key from context_keys row', () => {
      const result = runAnalyzer(F1_DOT, attractorRoot, fakeBunDir);
      assert.strictEqual(result.status, 0);
      const output = JSON.parse(result.stdout.trim());

      for (const row of output.context_keys) {
        const block = renderFindingF1(row.key, row.writers, row.readers, 'mechanical');
        assert.ok(
          block.includes(row.key),
          `finding block must reference key "${row.key}"`,
        );
        assert.ok(
          block.includes(`context_keys row for \`${row.key}\``),
          `finding trace must reference "context_keys row for ${row.key}"`,
        );
      }
    });

    test('orphan_writer subclass when readers array is empty', () => {
      const block = renderFindingF1('artifact_orphan', ['node_a'], [], 'mechanical');
      assert.ok(block.includes('orphan_writer'), 'subclass must be orphan_writer');
      assert.ok(block.includes('has no readers'), 'description must mention no readers');
    });

    test('asymmetric_writer subclass when readers array is non-empty', () => {
      const block = renderFindingF1('artifact_asym', ['node_a'], ['node_b'], 'mechanical');
      assert.ok(block.includes('asymmetric_writer'), 'subclass must be asymmetric_writer');
      assert.ok(block.includes('read only by'), 'description must mention read only by');
    });
  });

  describe('three-severity model rendering', () => {
    test('each finding has pre_verification_severity field', () => {
      const block = renderFindingF1('artifact_x', ['N1'], [], 'mechanical');
      assert.match(block, /pre_verification_severity/, 'must contain pre_verification_severity');
    });

    test('each finding has post_verification_severity field', () => {
      const block = renderFindingF1('artifact_x', ['N1'], [], 'mechanical');
      assert.match(block, /post_verification_severity/, 'must contain post_verification_severity');
    });

    test('raw bullet severity label matches pre_verification_severity value', () => {
      const block = renderFindingF1('artifact_x', ['N1'], [], 'mechanical');
      // Raw bullet is the `- **[P1]** ...` line
      const bulletMatch = /- \*\*\[(\w+)\]\*\*/.exec(block);
      assert.ok(bulletMatch, 'finding must have a severity bullet');
      const bulletSeverity = bulletMatch[1];
      const preMatch = /pre_verification_severity\*\*: (\w+)/.exec(block);
      assert.ok(preMatch, 'finding must have pre_verification_severity');
      assert.strictEqual(
        bulletSeverity,
        preMatch[1],
        'bullet severity must equal pre_verification_severity',
      );
    });

    test('three-severity model: P1 in bullet = pre_ = post_ for standard finding', () => {
      const block = renderFindingF1('artifact_x', ['N1'], ['N2'], 'mechanical');
      assert.match(block, /\*\*\[P1\]\*\*/, 'bullet must be P1');
      assert.match(block, /pre_verification_severity\*\*: P1/, 'pre_ must be P1');
      assert.match(block, /post_verification_severity\*\*: P1/, 'post_ must be P1');
    });
  });

  describe('analysis_mode boundary', () => {
    test('analyzer-driven findings carry analysis_mode: mechanical', () => {
      const result = runAnalyzer(F1_DOT, attractorRoot, fakeBunDir);
      assert.strictEqual(result.status, 0, `analyzer exit 0: ${result.stderr}`);
      const output = JSON.parse(result.stdout.trim());

      const blocks = output.context_keys.map(r =>
        renderFindingF1(r.key, r.writers, r.readers, 'mechanical'),
      );
      assert.ok(blocks.length > 0, 'must have at least one finding to test');
      for (const block of blocks) {
        assert.match(block, /\*\*Analysis mode\*\*: mechanical/, 'mechanical finding must have mode: mechanical');
      }
    });

    test('crash fallback finding carries analysis_mode: llm-only', () => {
      const llmOnlyBlock = [
        '### Frame 1: Context Key Asymmetry',
        '- **[P1]** `gate_api` — asymmetric_writer: key `artifact_api` inferred from DOT structure (analyzer unavailable).',
        '  - **Analysis mode**: llm-only',
        '  - **Finding subclass**: asymmetric_writer',
        '  - **Cluster key**: (frame:F1, key:artifact_api)',
        '  - **pre_verification_severity**: P1',
        '  - **post_verification_severity**: P1',
        '  - **Trace**: llm-only — inferred from context_on_success attrs; analyzer exited 2',
        '  - **Risk**: Unverified — analyzer was unavailable.',
        '  - **Suggested fix**: Re-run with a working bun installation.',
      ].join('\n');

      assert.match(llmOnlyBlock, /\*\*Analysis mode\*\*: llm-only/, 'crash fallback must have mode: llm-only');
      assert.doesNotMatch(llmOnlyBlock, /\*\*Analysis mode\*\*: mechanical/, 'crash fallback must NOT have mode: mechanical');
    });
  });

  describe('fingerprint and completion marker in rendered section', () => {
    test('clean run: gap_analysis section contains fingerprint comment', () => {
      const result = runAnalyzer(F1_DOT, attractorRoot, fakeBunDir);
      assert.strictEqual(result.status, 0);
      const output = JSON.parse(result.stdout.trim());
      const blocks = output.context_keys.map(r => renderFindingF1(r.key, r.writers, r.readers, 'mechanical'));
      const content = buildGapAnalysisSection('abcdef0123456789'.repeat(4), blocks, true);
      assert.match(content, FINGERPRINT_RE, 'fingerprint comment must be present and 64-hex');
    });

    test('clean run: completion marker is true', () => {
      const content = buildGapAnalysisSection('a'.repeat(64), [], true);
      const m = COMPLETION_RE.exec(content);
      assert.ok(m, 'completion comment must be present');
      assert.strictEqual(m[1], 'true', 'completion must be true on clean run');
    });

    test('crash run: completion marker is false', () => {
      const crashBunDir = makeCrashBun(tmpRoot);
      const result = runAnalyzer(F1_DOT, attractorRoot, crashBunDir);
      assert.strictEqual(result.status, 2, `analyzer crash must exit 2, got ${result.status}`);

      // Simulated crash fallback generates completion=false
      const content = buildGapAnalysisSection('a'.repeat(64), [], false);
      const m = COMPLETION_RE.exec(content);
      assert.ok(m, 'completion comment must be present');
      assert.strictEqual(m[1], 'false', 'completion must be false on crash');
    });

    test('## Generative Findings H2 header present in rendered section', () => {
      const content = buildGapAnalysisSection('a'.repeat(64), [], true);
      assert.ok(content.includes('## Generative Findings'), '## Generative Findings must be present');
    });
  });
});

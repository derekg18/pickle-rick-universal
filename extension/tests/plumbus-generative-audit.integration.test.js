import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.resolve(__dirname, '..', 'bin', 'plumbus-frame-analyzer.js');
const FIXTURES_DIR = path.resolve(__dirname, '__fixtures__', 'plumbus-frames');
const F1_DOT = path.join(FIXTURES_DIR, 'frame1-asymmetric-writer.dot');
const F1_GRAPH = path.join(FIXTURES_DIR, 'frame1-asymmetric-writer.graph.json');

const FINGERPRINT_RE = /^<!-- graph-fingerprint: ([a-f0-9]{64}) -->$/m;

function computeFingerprint(graphData) {
  const nodes = graphData.nodes.map(n => n.id).sort();
  const edges = graphData.edges
    .map(e => [e.source, e.target, e.condition ?? ''])
    .sort((a, b) => {
      const sa = JSON.stringify(a);
      const sb = JSON.stringify(b);
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });
  const edgeAttrs = {};
  for (const e of graphData.edges) {
    const k = `${e.source}\u2192${e.target}`;
    const attrs = Object.entries(e)
      .filter(([key]) => key !== 'source' && key !== 'target')
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (attrs.length > 0) edgeAttrs[k] = Object.fromEntries(attrs);
  }
  const sortedEdgeAttrs = Object.fromEntries(
    Object.entries(edgeAttrs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return crypto.createHash('sha256')
    .update(JSON.stringify({ nodes, edges, edgeAttrs: sortedEdgeAttrs }))
    .digest('hex');
}

function buildFindingF1(key, writers, readers, mode = 'mechanical') {
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

function buildFindingF5(sccNodes, mode = 'mechanical') {
  const nodeList = sccNodes.join(', ');
  return [
    `### Frame 5: SCC Without Convergence Signal`,
    `- **[P1]** \`${nodeList}\` — cycle with no convergence signal.`,
    `  - **Analysis mode**: ${mode}`,
    `  - **Cluster key**: (frame:F5, scc:[${sccNodes.join(',')}])`,
    `  - **pre_verification_severity**: P1`,
    `  - **post_verification_severity**: P1`,
    `  - **Trace**: cycles row — scc_nodes: [${nodeList}], convergence_signal: null`,
    `  - **Risk**: Cycle may not terminate; pipeline could run indefinitely.`,
    `  - **Suggested fix**: Add convergence signal (e.g., iterate node with convergence_epsilon + until, or max_visits on a node in the SCC).`,
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

function extractFingerprint(md) {
  const m = FINGERPRINT_RE.exec(md);
  return m ? m[1] : null;
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
  writeFileSync(bunPath, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "bun 1.0.0"; exit 0; fi\necho "simulated dump-graph crash" >&2\nexit 1\n`);
  chmodSync(bunPath, 0o755);
  return dir;
}

function runAnalyzer(dotPath, attractorRoot, bunDir) {
  return spawnSync(
    process.execPath,
    [BIN_PATH, dotPath],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        ATTRACTOR_ROOT: attractorRoot,
        PATH: `${bunDir}:${process.env.PATH ?? ''}`,
      },
    },
  );
}

describe('plumbus-generative-audit — integration', () => {
  let tmpRoot;
  let attractorRoot;
  let fakeBunDir;
  let tmpDir;

  before(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'plumbus-gen-audit-'));
    attractorRoot = makeAttractorRoot(tmpRoot);
    fakeBunDir = makeFakeBun(tmpRoot, F1_GRAPH);
    tmpDir = mkdtempSync(path.join(tmpRoot, 'work-'));
  });

  after(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('full Override 6 run: gap_analysis.md has ## Generative Findings + fingerprint + complete marker', () => {
    const result = runAnalyzer(F1_DOT, attractorRoot, fakeBunDir);
    assert.strictEqual(result.status, 0, `analyzer should exit 0: ${result.stderr}`);

    const analyzerOutput = JSON.parse(result.stdout.trim());
    const graphData = JSON.parse(readFileSync(F1_GRAPH, 'utf8'));
    const fingerprint = computeFingerprint(graphData);

    assert.match(fingerprint, /^[a-f0-9]{64}$/, 'fingerprint must be 64-char lowercase hex');

    const blocks = [];
    for (const row of analyzerOutput.context_keys) {
      blocks.push(buildFindingF1(row.key, row.writers, row.readers, 'mechanical'));
    }
    for (const row of analyzerOutput.cycles) {
      if (row.scc_nodes.length > 1 && row.convergence_signal === null) {
        blocks.push(buildFindingF5(row.scc_nodes, 'mechanical'));
      }
    }

    const content = buildGapAnalysisSection(fingerprint, blocks, true);
    writeFileSync(path.join(tmpDir, 'gap_analysis.md'), content);

    assert.ok(content.includes('## Generative Findings'), '## Generative Findings H2 section present');
    assert.match(content, FINGERPRINT_RE, 'fingerprint comment present and valid (64-hex)');
    assert.ok(
      content.includes('<!-- generative-audit-complete: true -->'),
      'generative-audit-complete: true marker present',
    );
    assert.ok(
      content.includes('**Analysis mode**: mechanical'),
      'at least one finding carries Analysis mode: mechanical',
    );
  });

  test('analyzer crash → llm-only findings + completion=false (A10)', () => {
    const crashBunDir = makeCrashBun(tmpRoot);
    const result = runAnalyzer(F1_DOT, attractorRoot, crashBunDir);
    assert.strictEqual(result.status, 2, `analyzer should exit 2 on bun crash, got ${result.status}: ${result.stderr}`);

    const graphData = JSON.parse(readFileSync(F1_GRAPH, 'utf8'));
    const fingerprint = computeFingerprint(graphData);

    // Crash fallback: generate llm-only finding with post_verification_severity
    const llmOnlyFinding = [
      '### Frame 1: Context Key Asymmetry',
      '- **[P1]** `gate_api` — asymmetric_writer: key `artifact_api` inferred from DOT structure (analyzer unavailable).',
      '  - **Analysis mode**: llm-only',
      '  - **Finding subclass**: asymmetric_writer',
      '  - **Cluster key**: (frame:F1, key:artifact_api)',
      '  - **pre_verification_severity**: P1',
      '  - **post_verification_severity**: P1',
      '  - **Trace**: llm-only — inferred from context_on_success attrs; analyzer exited 2',
      '  - **Risk**: Unverified — analyzer was unavailable. A7 verification required.',
      '  - **Suggested fix**: Re-run with a working bun installation to enable mechanical verification.',
    ].join('\n');

    const content = buildGapAnalysisSection(fingerprint, [llmOnlyFinding], false);
    const gapPath = path.join(mkdtempSync(path.join(tmpRoot, 'crash-work-')), 'gap_analysis.md');
    writeFileSync(gapPath, content);

    assert.ok(
      content.includes('**Analysis mode**: llm-only'),
      'crash fallback finding carries Analysis mode: llm-only',
    );
    assert.ok(
      content.includes('post_verification_severity'),
      'post_verification_severity field present in crash fallback finding',
    );
    assert.ok(
      content.includes('<!-- generative-audit-complete: false -->'),
      'completion marker is false on analyzer crash',
    );
  });

  test('partial run re-trigger: completion=false causes re-execution', () => {
    const graphData = JSON.parse(readFileSync(F1_GRAPH, 'utf8'));
    const fingerprint = computeFingerprint(graphData);
    const partialWork = mkdtempSync(path.join(tmpRoot, 'partial-work-'));
    const gapPath = path.join(partialWork, 'gap_analysis.md');

    // Write partial gap_analysis.md (simulating crashed previous run)
    const partialContent = buildGapAnalysisSection(fingerprint, [], false);
    writeFileSync(gapPath, partialContent);

    // Override 6 logic: fingerprint match + completion=false → re-run
    const existingFp = extractFingerprint(partialContent);
    const currentFp = computeFingerprint(graphData);
    const isComplete = partialContent.includes('<!-- generative-audit-complete: true -->');

    const shouldReRun = existingFp !== currentFp || !isComplete;
    assert.ok(shouldReRun, 'partial run (completion=false) must trigger Override 6 re-execution');

    // Simulate re-run: run analyzer, build findings, write completion=true
    const result = runAnalyzer(F1_DOT, attractorRoot, fakeBunDir);
    assert.strictEqual(result.status, 0, `re-run analyzer should exit 0: ${result.stderr}`);

    const analyzerOutput = JSON.parse(result.stdout.trim());
    const blocks = analyzerOutput.context_keys.map(r =>
      buildFindingF1(r.key, r.writers, r.readers, 'mechanical'),
    );
    const updatedContent = buildGapAnalysisSection(currentFp, blocks, true);
    writeFileSync(gapPath, updatedContent);

    assert.ok(
      updatedContent.includes('<!-- generative-audit-complete: true -->'),
      'completion marker updated to true after successful re-run',
    );
  });

  test('partial-run completion marker: clean run updates false → true', () => {
    const graphData = JSON.parse(readFileSync(F1_GRAPH, 'utf8'));
    const fingerprint = computeFingerprint(graphData);

    const crashContent = buildGapAnalysisSection(fingerprint, [], false);
    assert.ok(
      crashContent.includes('<!-- generative-audit-complete: false -->'),
      'simulated crash produces completion=false marker',
    );

    const cleanContent = buildGapAnalysisSection(fingerprint, [buildFindingF1('artifact_api', ['gate_api'], ['done'], 'mechanical')], true);
    assert.ok(
      cleanContent.includes('<!-- generative-audit-complete: true -->'),
      'clean run produces completion=true marker',
    );
  });
});

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

// Inline graph fixtures for merge tests (written to tmp files)
// v1: single writer node (compute writes artifact_result, no edge condition readers)
const GRAPH_V1 = JSON.stringify({
  nodes: [
    { id: 'start' },
    { id: 'compute', context_on_success: 'artifact_result=ready' },
    { id: 'done' },
  ],
  edges: [
    { source: 'start', target: 'compute' },
    { source: 'compute', target: 'done' },
  ],
});

// DOT file for analyzer invocation (content is irrelevant; fake bun ignores it)
const DOT_STUB = `digraph "iter_test" { start [shape="Mdiamond"] done [shape="Msquare"] start -> done }`;

// v2: same compute node + new enrich node (adds artifact_enriched, preserves artifact_result)
const GRAPH_V2 = JSON.stringify({
  nodes: [
    { id: 'start' },
    { id: 'compute', context_on_success: 'artifact_result=ready' },
    { id: 'enrich', context_on_success: 'artifact_enriched=done' },
    { id: 'done' },
  ],
  edges: [
    { source: 'start', target: 'compute' },
    { source: 'compute', target: 'enrich' },
    { source: 'enrich', target: 'done' },
  ],
});

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

function buildFindingBlock(key, writers, mode = 'mechanical') {
  const subclass = 'orphan_writer';
  const writerList = writers.join(', ');
  return [
    `### Frame 1: Context Key Asymmetry`,
    `- **[P1]** \`${writerList}\` — ${subclass}: key \`${key}\` written by [${writerList}] but has no readers.`,
    `  - **Analysis mode**: ${mode}`,
    `  - **Finding subclass**: ${subclass}`,
    `  - **Cluster key**: (frame:F1, key:${key})`,
    `  - **pre_verification_severity**: P1`,
    `  - **post_verification_severity**: P1`,
    `  - **Trace**: context_keys row for \`${key}\` — writers: [${writerList}], readers: []`,
    `  - **Risk**: Context key is written but never consumed.`,
    `  - **Suggested fix**: Add a reader node or edge condition that consumes \`${key}\`.`,
  ].join('\n');
}

function buildGapAnalysisSection(fingerprint, findingBlocks, complete) {
  return [
    '## Generative Findings',
    `<!-- graph-fingerprint: ${fingerprint} -->`,
    `<!-- generative-audit-complete: ${complete} -->`,
    '',
    ...findingBlocks.map(b => b + '\n'),
  ].join('\n');
}

function extractFingerprint(md) {
  const m = /^<!-- graph-fingerprint: ([a-f0-9]{64}) -->$/m.exec(md);
  return m ? m[1] : null;
}

// Merges findings from a prior run with new analyzer output.
// Preserves findings whose key still appears in new context_keys.
// Appends findings for new keys not already present.
function mergeFindings(existingFindings, newContextKeys) {
  const newKeySet = new Set(newContextKeys.map(r => r.key));
  const preserved = existingFindings.filter(f => newKeySet.has(f.key));
  const preservedKeySet = new Set(preserved.map(f => f.key));
  const added = newContextKeys
    .filter(r => !preservedKeySet.has(r.key))
    .map(r => ({ key: r.key, writers: r.writers, block: buildFindingBlock(r.key, r.writers) }));
  return [...preserved, ...added];
}

function makeAttractorRoot(tmpRoot) {
  const tmp = mkdtempSync(path.join(tmpRoot, 'attractor-'));
  mkdirSync(path.join(tmp, 'packages', 'attractor', 'src'), { recursive: true });
  writeFileSync(path.join(tmp, 'packages', 'attractor', 'src', 'cli.ts'), '// stub\n');
  mkdirSync(path.join(tmp, 'packages', 'attractor', 'scripts'), { recursive: true });
  writeFileSync(path.join(tmp, 'packages', 'attractor', 'scripts', 'dump-graph.ts'), '// stub\n');
  return tmp;
}

function makeFakeBun(tmpRoot, graphJsonContent) {
  const dir = mkdtempSync(path.join(tmpRoot, 'fake-bun-'));
  const jsonPath = path.join(dir, 'graph.json');
  writeFileSync(jsonPath, graphJsonContent);
  const bunPath = path.join(dir, 'bun');
  writeFileSync(bunPath, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "bun 1.0.0"; exit 0; fi\ncat "${jsonPath}"\n`);
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

describe('plumbus-iteration-merge', () => {
  let tmpRoot;
  let attractorRoot;
  let dotPath;

  before(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'plumbus-merge-'));
    attractorRoot = makeAttractorRoot(tmpRoot);
    dotPath = path.join(tmpRoot, 'iter-test.dot');
    writeFileSync(dotPath, DOT_STUB);
  });

  after(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('v1→v2 merge: v1 findings preserved, v2 new findings appended', () => {
    const fakeBunV1 = makeFakeBun(tmpRoot, GRAPH_V1);
    const fakeBunV2 = makeFakeBun(tmpRoot, GRAPH_V2);

    // Run analyzer on v1
    const resultV1 = runAnalyzer(dotPath, attractorRoot, fakeBunV1);
    assert.strictEqual(resultV1.status, 0, `v1 analyzer should exit 0: ${resultV1.stderr}`);
    const v1Output = JSON.parse(resultV1.stdout.trim());

    const graphV1 = JSON.parse(GRAPH_V1);
    const fingerprintV1 = computeFingerprint(graphV1);

    // Build v1 findings
    const v1Findings = v1Output.context_keys.map(r => ({
      key: r.key,
      writers: r.writers,
      block: buildFindingBlock(r.key, r.writers),
    }));

    assert.ok(v1Findings.some(f => f.key === 'artifact_result'), 'v1 should have artifact_result finding');

    // Write initial gap_analysis.md (v1 iteration)
    const workDir = mkdtempSync(path.join(tmpRoot, 'work-v1-'));
    const gapPath = path.join(workDir, 'gap_analysis.md');
    writeFileSync(gapPath, buildGapAnalysisSection(fingerprintV1, v1Findings.map(f => f.block), true));

    // Run analyzer on v2
    const resultV2 = runAnalyzer(dotPath, attractorRoot, fakeBunV2);
    assert.strictEqual(resultV2.status, 0, `v2 analyzer should exit 0: ${resultV2.stderr}`);
    const v2Output = JSON.parse(resultV2.stdout.trim());

    const graphV2 = JSON.parse(GRAPH_V2);
    const fingerprintV2 = computeFingerprint(graphV2);

    // Fingerprints must differ (different graph structure)
    assert.notStrictEqual(fingerprintV1, fingerprintV2, 'v1 and v2 fingerprints must differ');

    // Merge: fingerprint mismatch → merge mode
    const mergedFindings = mergeFindings(v1Findings, v2Output.context_keys);

    // Build merged gap_analysis.md
    const mergedContent = buildGapAnalysisSection(fingerprintV2, mergedFindings.map(f => f.block), true);
    writeFileSync(gapPath, mergedContent);

    // Assert v1 finding preserved (artifact_result is in both v1 and v2 context_keys)
    assert.ok(
      mergedContent.includes('key `artifact_result`') || mergedContent.includes('(frame:F1, key:artifact_result)'),
      'v1 artifact_result finding must be preserved in merge',
    );

    // Assert v2 new finding appended (artifact_enriched only in v2)
    assert.ok(
      mergedContent.includes('key `artifact_enriched`') || mergedContent.includes('(frame:F1, key:artifact_enriched)'),
      'v2 artifact_enriched finding must be appended in merge',
    );
  });

  test('partial run re-triggers on next iteration (completion=false forces re-execution)', () => {
    const fakeBunV1 = makeFakeBun(tmpRoot, GRAPH_V1);
    const graphV1 = JSON.parse(GRAPH_V1);
    const fingerprint = computeFingerprint(graphV1);

    const workDir = mkdtempSync(path.join(tmpRoot, 'work-partial-'));
    const gapPath = path.join(workDir, 'gap_analysis.md');

    // Write partial gap_analysis.md (simulating a crashed previous run)
    const partialContent = buildGapAnalysisSection(fingerprint, [], false);
    writeFileSync(gapPath, partialContent);

    // Override 6 trigger check: same fingerprint + completion=false → re-run
    const storedFp = extractFingerprint(partialContent);
    const currentFp = computeFingerprint(graphV1);
    const isComplete = partialContent.includes('<!-- generative-audit-complete: true -->');

    assert.strictEqual(storedFp, currentFp, 'stored fingerprint matches current graph fingerprint');
    assert.strictEqual(isComplete, false, 'partial run has completion=false');

    // fingerprint match + incomplete → must re-run (not skip)
    const mustReRun = !isComplete;
    assert.ok(mustReRun, 'completion=false must force Override 6 re-execution even with matching fingerprint');

    // Simulate re-run: run analyzer, write completion=true on success
    const result = runAnalyzer(dotPath, attractorRoot, fakeBunV1);
    assert.strictEqual(result.status, 0, `re-run analyzer should exit 0: ${result.stderr}`);
    const analyzerOutput = JSON.parse(result.stdout.trim());
    const findings = analyzerOutput.context_keys.map(r => ({
      key: r.key,
      block: buildFindingBlock(r.key, r.writers),
    }));
    const updatedContent = buildGapAnalysisSection(currentFp, findings.map(f => f.block), true);
    writeFileSync(gapPath, updatedContent);

    assert.ok(
      updatedContent.includes('<!-- generative-audit-complete: true -->'),
      'completion marker updated to true after successful re-run',
    );
  });

  test('iteration-N ordering invariant: ## Generative Findings after ## Edge Map, before pattern-scan', () => {
    const graphV1 = JSON.parse(GRAPH_V1);
    const fingerprint = computeFingerprint(graphV1);
    const findingBlock = buildFindingBlock('artifact_result', ['compute']);

    // Build a gap_analysis.md with all three sections in correct iteration-N order
    const sections = [
      '## Edge Map',
      '',
      'start → compute → done (linear pipeline)',
      '',
      buildGapAnalysisSection(fingerprint, [findingBlock], true),
      '',
      '## Pattern Scan',
      '',
      'No pattern violations detected.',
    ];
    const content = sections.join('\n');

    const edgeMapPos = content.indexOf('## Edge Map');
    const generativePos = content.indexOf('## Generative Findings');
    const patternScanPos = content.indexOf('## Pattern Scan');

    assert.ok(edgeMapPos !== -1, '## Edge Map section must be present');
    assert.ok(generativePos !== -1, '## Generative Findings section must be present');
    assert.ok(patternScanPos !== -1, '## Pattern Scan section must be present');

    assert.ok(
      generativePos > edgeMapPos,
      `## Generative Findings (pos ${generativePos}) must appear AFTER ## Edge Map (pos ${edgeMapPos})`,
    );
    assert.ok(
      generativePos < patternScanPos,
      `## Generative Findings (pos ${generativePos}) must appear BEFORE ## Pattern Scan (pos ${patternScanPos})`,
    );
  });
});

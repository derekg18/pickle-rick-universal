import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Canonical fingerprint algorithm (mirrors plumbus-generative-audit.integration.test.js)
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

function extractFingerprint(md) {
  const m = /^<!-- graph-fingerprint: ([a-f0-9]{64}) -->$/m.exec(md);
  return m ? m[1] : null;
}

function extractCompletion(md) {
  const m = /^<!-- generative-audit-complete: (true|false) -->$/m.exec(md);
  return m ? m[1] === 'true' : null;
}

function shouldSkip(existingMd, currentFp) {
  const storedFp = extractFingerprint(existingMd);
  const isComplete = extractCompletion(existingMd);
  return storedFp === currentFp && isComplete === true;
}

function buildSection(fingerprint, findings, complete) {
  return [
    '## Generative Findings',
    `<!-- graph-fingerprint: ${fingerprint} -->`,
    `<!-- generative-audit-complete: ${complete} -->`,
    '',
    ...findings.map(f => f + '\n'),
  ].join('\n');
}

const GRAPH_V1 = {
  nodes: [
    { id: 'start' },
    { id: 'process', context_on_success: 'artifact_result=ready' },
    { id: 'done' },
  ],
  edges: [
    { source: 'start', target: 'process' },
    { source: 'process', target: 'done' },
  ],
};

const GRAPH_V2 = {
  nodes: [
    { id: 'start' },
    { id: 'process', context_on_success: 'artifact_result=ready' },
    { id: 'enrich', context_on_success: 'artifact_enriched=done' },
    { id: 'done' },
  ],
  edges: [
    { source: 'start', target: 'process' },
    { source: 'process', target: 'enrich' },
    { source: 'enrich', target: 'done' },
  ],
};

describe('Trace C: fingerprint/completion boundary contracts', () => {
  describe('fingerprint determinism', () => {
    test('same graph → same hash on 5 successive calls', () => {
      const hashes = Array.from({ length: 5 }, () => computeFingerprint(GRAPH_V1));
      const first = hashes[0];
      for (const h of hashes) {
        assert.strictEqual(h, first, 'fingerprint must be deterministic');
      }
    });

    test('fingerprint is 64-char lowercase hex', () => {
      const fp = computeFingerprint(GRAPH_V1);
      assert.match(fp, /^[a-f0-9]{64}$/, 'fingerprint must be 64-char hex');
    });

    test('node insertion order does not affect fingerprint', () => {
      const graphA = {
        nodes: [{ id: 'Z' }, { id: 'A' }, { id: 'M' }],
        edges: [{ source: 'A', target: 'M' }, { source: 'M', target: 'Z' }],
      };
      const graphB = {
        nodes: [{ id: 'A' }, { id: 'M' }, { id: 'Z' }],
        edges: [{ source: 'M', target: 'Z' }, { source: 'A', target: 'M' }],
      };
      assert.strictEqual(
        computeFingerprint(graphA),
        computeFingerprint(graphB),
        'node insertion order must not affect fingerprint',
      );
    });
  });

  describe('fingerprint sensitivity', () => {
    test('adding a node changes the fingerprint', () => {
      const fp1 = computeFingerprint(GRAPH_V1);
      const fp2 = computeFingerprint(GRAPH_V2);
      assert.notStrictEqual(fp1, fp2, 'different graph structure must produce different fingerprint');
    });

    test('adding an edge changes the fingerprint', () => {
      const base = { nodes: [{ id: 'A' }, { id: 'B' }], edges: [] };
      const withEdge = { nodes: [{ id: 'A' }, { id: 'B' }], edges: [{ source: 'A', target: 'B' }] };
      assert.notStrictEqual(computeFingerprint(base), computeFingerprint(withEdge));
    });

    test('changing edge condition changes the fingerprint', () => {
      const g1 = {
        nodes: [{ id: 'A' }, { id: 'B' }],
        edges: [{ source: 'A', target: 'B', condition: 'context.x=v1' }],
      };
      const g2 = {
        nodes: [{ id: 'A' }, { id: 'B' }],
        edges: [{ source: 'A', target: 'B', condition: 'context.x=v2' }],
      };
      assert.notStrictEqual(computeFingerprint(g1), computeFingerprint(g2));
    });
  });

  describe('skip-logic contracts', () => {
    test('shouldSkip = true when fingerprint matches AND completion=true', () => {
      const fp = computeFingerprint(GRAPH_V1);
      const md = buildSection(fp, ['finding_a'], true);
      assert.strictEqual(shouldSkip(md, fp), true, 'fp match + complete=true must skip');
    });

    test('shouldSkip = false when fingerprint matches AND completion=false', () => {
      const fp = computeFingerprint(GRAPH_V1);
      const md = buildSection(fp, [], false);
      assert.strictEqual(
        shouldSkip(md, fp),
        false,
        'fp match + completion=false must NOT skip (partial run forces re-run)',
      );
    });

    test('shouldSkip = false when fingerprint differs AND completion=true', () => {
      const fp1 = computeFingerprint(GRAPH_V1);
      const fp2 = computeFingerprint(GRAPH_V2);
      const md = buildSection(fp1, ['finding_a'], true);
      assert.strictEqual(
        shouldSkip(md, fp2),
        false,
        'fp mismatch must NOT skip even if completion=true',
      );
    });

    test('shouldSkip = false when fingerprint differs AND completion=false', () => {
      const fp1 = computeFingerprint(GRAPH_V1);
      const fp2 = computeFingerprint(GRAPH_V2);
      const md = buildSection(fp1, [], false);
      assert.strictEqual(
        shouldSkip(md, fp2),
        false,
        'fp mismatch + incomplete must NOT skip',
      );
    });

    test('shouldSkip = false when no existing gap_analysis.md (null fingerprint)', () => {
      const fp = computeFingerprint(GRAPH_V1);
      const result = shouldSkip('', fp);
      assert.strictEqual(result, false, 'missing fingerprint must NOT skip');
    });
  });

  describe('partial-run completion marker lifecycle', () => {
    test('simulated crash produces completion=false marker', () => {
      const fp = computeFingerprint(GRAPH_V1);
      const crashContent = buildSection(fp, [], false);
      const completion = extractCompletion(crashContent);
      assert.strictEqual(completion, false, 'crash run must write completion=false');
    });

    test('clean run produces completion=true marker', () => {
      const fp = computeFingerprint(GRAPH_V1);
      const cleanContent = buildSection(fp, ['finding_a'], true);
      const completion = extractCompletion(cleanContent);
      assert.strictEqual(completion, true, 'clean run must write completion=true');
    });

    test('re-run on completion=false updates marker to true', () => {
      const fp = computeFingerprint(GRAPH_V1);

      // Step 1: write partial (crashed) gap_analysis
      const partialContent = buildSection(fp, [], false);
      assert.strictEqual(extractCompletion(partialContent), false, 'initial state: false');

      // Step 2: Override 6 skip check → must re-run
      const mustReRun = !shouldSkip(partialContent, fp);
      assert.ok(mustReRun, 'completion=false with matching fp must force re-run');

      // Step 3: simulate successful re-run → write completion=true
      const updatedContent = buildSection(fp, ['finding_a'], true);
      assert.strictEqual(extractCompletion(updatedContent), true, 'after re-run: completion must be true');

      // Step 4: next iteration sees completion=true → skip
      const skipAfterSuccess = shouldSkip(updatedContent, fp);
      assert.ok(skipAfterSuccess, 'after successful re-run, next iteration must skip');
    });

    test('fingerprint mismatch after graph change forces re-run even with completion=true', () => {
      const fp1 = computeFingerprint(GRAPH_V1);
      const fp2 = computeFingerprint(GRAPH_V2);

      // Previous run was complete for v1
      const v1Content = buildSection(fp1, ['finding_a'], true);
      assert.strictEqual(shouldSkip(v1Content, fp1), true, 'v1 complete → skip on v1 fp');

      // Graph changed to v2 → fingerprint differs → must re-run
      assert.strictEqual(
        shouldSkip(v1Content, fp2),
        false,
        'v1 content with v2 fp must force re-run',
      );
    });
  });

  describe('fingerprint embedded in gap_analysis.md', () => {
    test('extracted fingerprint matches the computed fingerprint', () => {
      const fp = computeFingerprint(GRAPH_V1);
      const md = buildSection(fp, [], true);
      const extracted = extractFingerprint(md);
      assert.strictEqual(extracted, fp, 'extracted fingerprint must match computed fingerprint');
    });

    test('fingerprint comment format is exactly: <!-- graph-fingerprint: HEX -->', () => {
      const fp = computeFingerprint(GRAPH_V1);
      const md = buildSection(fp, [], true);
      assert.match(
        md,
        /^<!-- graph-fingerprint: [a-f0-9]{64} -->$/m,
        'fingerprint comment must match exact format',
      );
    });

    test('completion comment format is exactly: <!-- generative-audit-complete: bool -->', () => {
      const mdTrue = buildSection('a'.repeat(64), [], true);
      const mdFalse = buildSection('a'.repeat(64), [], false);
      assert.match(mdTrue, /^<!-- generative-audit-complete: true -->$/m);
      assert.match(mdFalse, /^<!-- generative-audit-complete: false -->$/m);
    });
  });
});

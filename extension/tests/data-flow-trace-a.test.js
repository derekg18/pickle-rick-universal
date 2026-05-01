import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB_DIR = path.resolve(__dirname, '..', 'lib');
const BIN_PATH = path.resolve(__dirname, '..', 'bin', 'plumbus-frame-analyzer.js');
const FIXTURES_DIR = path.resolve(__dirname, '__fixtures__', 'plumbus-frames');

const { buildContextKeyMatrix } = await import(path.join(LIB_DIR, 'context-key-matrix.js'));
const { buildDiamondRouting } = await import(path.join(LIB_DIR, 'diamond-routing.js'));
const { buildCycles } = await import(path.join(LIB_DIR, 'tarjan-scc.js'));

const BASE_REGISTRY = {
  schema_version: 1,
  engine_keys: ['outcome', 'current_node', 'workspace.path', 'runId', 'graph.goal', 'tool.output'],
  engine_key_patterns: ['pool_count_reviewer_*', '__last_failure_*', '__pool_findings__', '__fix_attempt_history', '__ladder_position.*'],
  user_written_patterns: ['artifact_*'],
};

let tmpRoot;

function makeAttractorRoot() {
  const tmp = mkdtempSync(path.join(tmpRoot, 'attractor-'));
  mkdirSync(path.join(tmp, 'packages', 'attractor', 'src'), { recursive: true });
  writeFileSync(path.join(tmp, 'packages', 'attractor', 'src', 'cli.ts'), '// stub\n');
  mkdirSync(path.join(tmp, 'packages', 'attractor', 'scripts'), { recursive: true });
  writeFileSync(path.join(tmp, 'packages', 'attractor', 'scripts', 'dump-graph.ts'), '// stub\n');
  return tmp;
}

function makeFakeBun(graphJsonContent) {
  const dir = mkdtempSync(path.join(tmpRoot, 'fake-bun-'));
  const jsonPath = path.join(dir, 'graph.json');
  writeFileSync(jsonPath, graphJsonContent);
  const bunPath = path.join(dir, 'bun');
  writeFileSync(bunPath, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "bun 1.0.0"; exit 0; fi\ncat "${jsonPath}"\n`);
  chmodSync(bunPath, 0o755);
  return dir;
}

describe('Trace A: analyzer-internal boundary invariants', () => {
  before(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'trace-a-'));
  });

  after(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe('context_keys sort invariants', () => {
    test('rows sorted lexicographically by key', () => {
      const graph = {
        nodes: [
          { id: 'N_zzz', context_on_success: 'artifact_zzz=v' },
          { id: 'N_aaa', context_on_success: 'artifact_aaa=v' },
          { id: 'N_mmm', context_on_success: 'artifact_mmm=v' },
        ],
        edges: [],
      };
      const rows = buildContextKeyMatrix(graph, BASE_REGISTRY);
      assert.ok(rows.length >= 3, 'expected 3+ rows');
      for (let i = 1; i < rows.length; i++) {
        assert.ok(
          rows[i - 1].key <= rows[i].key,
          `rows not sorted: "${rows[i - 1].key}" should come before "${rows[i].key}"`,
        );
      }
    });

    test('writers array sorted within each row regardless of insertion order', () => {
      const graph = {
        nodes: [
          { id: 'N3', context_on_success: 'artifact_shared=v' },
          { id: 'N1', context_on_success: 'artifact_shared=v' },
          { id: 'N2', context_on_success: 'artifact_shared=v' },
        ],
        edges: [],
      };
      const rows = buildContextKeyMatrix(graph, BASE_REGISTRY);
      const row = rows.find(r => r.key === 'artifact_shared');
      assert.ok(row, 'artifact_shared row must exist');
      const sorted = [...row.writers].sort();
      assert.deepStrictEqual(row.writers, sorted, 'writers must be sorted');
    });

    test('readers array sorted within each row regardless of insertion order', () => {
      const graph = {
        nodes: [
          { id: 'N1', context_on_success: 'artifact_read=v' },
          { id: 'N_reader_b' },
          { id: 'N_reader_a' },
        ],
        edges: [
          { target: 'N_reader_b', condition: 'context.artifact_read=v' },
          { target: 'N_reader_a', condition: 'context.artifact_read=v' },
        ],
      };
      const rows = buildContextKeyMatrix(graph, BASE_REGISTRY);
      const row = rows.find(r => r.key === 'artifact_read');
      assert.ok(row, 'artifact_read row must exist');
      const sorted = [...row.readers].sort();
      assert.deepStrictEqual(row.readers, sorted, 'readers must be sorted');
    });
  });

  describe('node ID preservation', () => {
    test('every writer in context_keys is a node ID that exists in graph.nodes', () => {
      const graph = {
        nodes: [
          { id: 'writer_node_1', context_on_success: 'artifact_x=v' },
          { id: 'writer_node_2', context_on_success: 'artifact_y=v' },
          { id: 'reader_node' },
        ],
        edges: [
          { target: 'reader_node', condition: 'context.artifact_x=v' },
        ],
      };
      const nodeIds = new Set(graph.nodes.map(n => n.id));
      const rows = buildContextKeyMatrix(graph, BASE_REGISTRY);
      for (const row of rows) {
        for (const writer of row.writers) {
          assert.ok(nodeIds.has(writer), `writer "${writer}" not in graph.nodes`);
        }
        for (const reader of row.readers) {
          assert.ok(nodeIds.has(reader), `reader "${reader}" not in graph.nodes`);
        }
      }
    });

    test('node IDs never disappear: fixture graph nodes appear in writers/readers', () => {
      const fixture = {
        nodes: [
          { id: 'gate_api', context_on_success: 'artifact_api=seeded' },
          { id: 'diamond_api', class: 'diamond' },
          { id: 'done' },
        ],
        edges: [
          { source: 'diamond_api', target: 'done', condition: 'context.artifact_api=seeded' },
        ],
      };
      const rows = buildContextKeyMatrix(fixture, BASE_REGISTRY);
      const row = rows.find(r => r.key === 'artifact_api');
      assert.ok(row, 'artifact_api row must exist');
      assert.ok(row.writers.includes('gate_api'), 'gate_api must be a writer');
      assert.ok(row.readers.includes('done'), 'done must be a reader');
    });
  });

  describe('diamond_routing sort invariants', () => {
    test('diamond_routing rows sorted by diamond field', () => {
      const graph = {
        nodes: [
          { id: 'zoo_diamond', class: 'diamond' },
          { id: 'aaa_diamond', class: 'diamond' },
          { id: 'writer', context_on_success: 'artifact_state=ready,artifact_state=fail' },
        ],
        edges: [
          { source: 'zoo_diamond', target: 'a', condition: 'context.artifact_state=ready' },
          { source: 'zoo_diamond', target: 'b', condition: 'context.artifact_state=fail' },
          { source: 'aaa_diamond', target: 'a', condition: 'context.artifact_state=ready' },
          { source: 'aaa_diamond', target: 'b', condition: 'context.artifact_state=fail' },
        ],
      };
      const rows = buildDiamondRouting(graph);
      assert.ok(rows.length >= 2, 'expected 2+ diamond rows');
      for (let i = 1; i < rows.length; i++) {
        assert.ok(
          rows[i - 1].diamond <= rows[i].diamond,
          `rows not sorted: "${rows[i - 1].diamond}" should come before "${rows[i].diamond}"`,
        );
      }
    });

    test('covered and stuck cells are exhaustive (union = all Cartesian cells)', () => {
      const graph = {
        nodes: [
          { id: 'decision', class: 'diamond' },
          { id: 'writer', context_on_success: 'artifact_phase=ready', context_on_failure: 'artifact_phase=fail' },
        ],
        edges: [
          { source: 'decision', target: 'path_a', condition: 'context.artifact_phase=ready' },
          { source: 'decision', target: 'path_b', condition: 'context.artifact_phase=fail' },
        ],
      };
      const rows = buildDiamondRouting(graph);
      const row = rows.find(r => r.diamond === 'decision');
      assert.ok(row, 'decision row must exist');
      const total = row.covered_states.length + row.stuck_states.length;
      // 3 values: ready, fail, unset → total = 3
      assert.strictEqual(total, 3, `covered+stuck should cover all 3 cells, got ${total}`);
    });
  });

  describe('cycles sort invariants', () => {
    test('scc_nodes sorted within each cycle row', () => {
      const graph = {
        nodes: [{ id: 'C' }, { id: 'A' }, { id: 'B' }],
        edges: [
          { source: 'C', target: 'A' },
          { source: 'A', target: 'B' },
          { source: 'B', target: 'C' },
        ],
      };
      const rows = buildCycles(graph);
      assert.ok(rows.length === 1, 'expected 1 cycle row');
      const sorted = [...rows[0].scc_nodes].sort();
      assert.deepStrictEqual(rows[0].scc_nodes, sorted, 'scc_nodes must be sorted');
      assert.deepStrictEqual(rows[0].scc_nodes, ['A', 'B', 'C']);
    });
  });

  describe('idempotency', () => {
    test('three successive calls with same graph produce identical context_keys JSON', () => {
      const graph = {
        nodes: [
          { id: 'N3', context_on_success: 'artifact_zzz=v' },
          { id: 'N1', context_on_success: 'artifact_aaa=v' },
          { id: 'N2', context_on_success: 'artifact_mmm=v,artifact_aaa=v2' },
        ],
        edges: [
          { target: 'N4', condition: 'context.artifact_aaa=v' },
          { target: 'N3', condition: 'context.artifact_zzz=v' },
        ],
      };
      const r1 = JSON.stringify(buildContextKeyMatrix(graph, BASE_REGISTRY));
      const r2 = JSON.stringify(buildContextKeyMatrix(graph, BASE_REGISTRY));
      const r3 = JSON.stringify(buildContextKeyMatrix(graph, BASE_REGISTRY));
      assert.strictEqual(r1, r2, 'call 1 and call 2 must match');
      assert.strictEqual(r2, r3, 'call 2 and call 3 must match');
    });

    test('three successive calls with same graph produce identical diamond_routing JSON', () => {
      const graph = {
        nodes: [
          { id: 'd1', class: 'diamond' },
          { id: 'w1', context_on_success: 'artifact_s=ok', context_on_failure: 'artifact_s=fail' },
        ],
        edges: [
          { source: 'd1', target: 'a', condition: 'context.artifact_s=ok' },
          { source: 'd1', target: 'b', condition: 'context.artifact_s=fail' },
        ],
      };
      const r1 = JSON.stringify(buildDiamondRouting(graph));
      const r2 = JSON.stringify(buildDiamondRouting(graph));
      const r3 = JSON.stringify(buildDiamondRouting(graph));
      assert.strictEqual(r1, r2);
      assert.strictEqual(r2, r3);
    });

    test('three successive calls with same graph produce identical cycles JSON', () => {
      const graph = {
        nodes: [{ id: 'X' }, { id: 'Y' }, { id: 'Z' }],
        edges: [
          { source: 'X', target: 'Y' },
          { source: 'Y', target: 'Z' },
          { source: 'Z', target: 'X' },
        ],
      };
      const r1 = JSON.stringify(buildCycles(graph));
      const r2 = JSON.stringify(buildCycles(graph));
      const r3 = JSON.stringify(buildCycles(graph));
      assert.strictEqual(r1, r2);
      assert.strictEqual(r2, r3);
    });
  });

  describe('CARTESIAN_CAP exceeded → cap note propagation', () => {
    test('diamond with >256 cells produces cap note in stuck_states', () => {
      // 9 keys each with 2 observed values → 3^9 = 19683 cells (>256)
      const contextWrites = Array.from({ length: 9 }, (_, i) => `artifact_k${i}=v1,artifact_k${i}=v2`).join(',');
      const edges = Array.from({ length: 9 }, (_, i) => [
        { source: 'big_diamond', target: `path_${i}_a`, condition: `context.artifact_k${i}=v1` },
        { source: 'big_diamond', target: `path_${i}_b`, condition: `context.artifact_k${i}=v2` },
      ]).flat();

      const graph = {
        nodes: [
          { id: 'big_diamond', class: 'diamond' },
          { id: 'writer', context_on_success: contextWrites },
        ],
        edges,
      };
      const rows = buildDiamondRouting(graph);
      const row = rows.find(r => r.diamond === 'big_diamond');
      assert.ok(row, 'big_diamond row must exist');
      assert.strictEqual(row.covered_states.length, 0, 'no covered states when cap exceeded');
      assert.ok(row.stuck_states.length > 0, 'stuck_states must be populated with cap marker');
      const note = row.stuck_states[0].note;
      assert.ok(
        typeof note === 'string' && note.includes('complex'),
        `expected cap note to mention "complex", got: "${note}"`,
      );
    });
  });

  describe('CLI-level AnalyzerOutput schema', () => {
    test('stdout has exactly 3 keys: context_keys, diamond_routing, cycles', () => {
      const graphContent = JSON.stringify({
        nodes: [
          { id: 'n1', context_on_success: 'artifact_x=v' },
          { id: 'n2', class: 'diamond' },
        ],
        edges: [
          { source: 'n2', target: 'n3', condition: 'context.artifact_x=v' },
          { source: 'n2', target: 'n4', condition: 'context.outcome=fail' },
        ],
      });
      const attractorRoot = makeAttractorRoot();
      const bunDir = makeFakeBun(graphContent);
      const dotPath = path.join(FIXTURES_DIR, 'frame1-asymmetric-writer.dot');

      const result = spawnSync(
        process.execPath,
        [BIN_PATH, dotPath],
        {
          encoding: 'utf8',
          env: { ...process.env, ATTRACTOR_ROOT: attractorRoot, PATH: `${bunDir}:${process.env.PATH ?? ''}` },
        },
      );
      assert.strictEqual(result.status, 0, `expected exit 0: ${result.stderr}`);
      const parsed = JSON.parse(result.stdout.trim());
      assert.deepStrictEqual(
        Object.keys(parsed).sort(),
        ['context_keys', 'cycles', 'diamond_routing'],
        'AnalyzerOutput must have exactly these 3 keys',
      );
      assert.ok(Array.isArray(parsed.context_keys), 'context_keys must be an array');
      assert.ok(Array.isArray(parsed.diamond_routing), 'diamond_routing must be an array');
      assert.ok(Array.isArray(parsed.cycles), 'cycles must be an array');
    });

    test('CLI stdout sort invariants preserved end-to-end', () => {
      // Graph with multiple context keys; verify CLI output has them sorted
      const graphContent = JSON.stringify({
        nodes: [
          { id: 'N_z', context_on_success: 'artifact_zzz=v' },
          { id: 'N_a', context_on_success: 'artifact_aaa=v' },
          { id: 'N_m', context_on_success: 'artifact_mmm=v' },
        ],
        edges: [],
      });
      const attractorRoot = makeAttractorRoot();
      const bunDir = makeFakeBun(graphContent);
      const dotPath = path.join(FIXTURES_DIR, 'frame1-asymmetric-writer.dot');

      const result = spawnSync(
        process.execPath,
        [BIN_PATH, dotPath],
        {
          encoding: 'utf8',
          env: { ...process.env, ATTRACTOR_ROOT: attractorRoot, PATH: `${bunDir}:${process.env.PATH ?? ''}` },
        },
      );
      assert.strictEqual(result.status, 0, `expected exit 0: ${result.stderr}`);
      const parsed = JSON.parse(result.stdout.trim());
      const keys = parsed.context_keys.map(r => r.key);
      for (let i = 1; i < keys.length; i++) {
        assert.ok(keys[i - 1] <= keys[i], `context_keys out of sort order at index ${i}: "${keys[i - 1]}" > "${keys[i]}"`);
      }
    });
  });
});

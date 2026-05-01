import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildContextKeyMatrix } from '../lib/context-key-matrix.js';

const BASE_REGISTRY = {
  schema_version: 1,
  engine_keys: ['outcome', 'current_node', 'workspace.path', 'runId', 'graph.goal', 'tool.output'],
  engine_key_patterns: ['pool_count_reviewer_*', '__last_failure_*', '__pool_findings__', '__fix_attempt_history', '__ladder_position.*'],
  user_written_patterns: ['artifact_*'],
};

describe('buildContextKeyMatrix', () => {
  test('user-written key included — writer node and reader edge produce a row', () => {
    const graph = {
      nodes: [{ id: 'N1', context_on_success: 'artifact_foo=seeded' }],
      edges: [{ target: 'N2', attrs: { condition: 'context.artifact_foo=seeded' } }],
    };
    const matrix = buildContextKeyMatrix(graph, BASE_REGISTRY);
    assert.deepStrictEqual(matrix[0], { key: 'artifact_foo', writers: ['N1'], readers: ['N2'] });
  });

  test('engine key filtered — outcome never appears in matrix', () => {
    const graph = {
      nodes: [{ id: 'N1', context_on_success: 'outcome=ok' }],
      edges: [],
    };
    const matrix = buildContextKeyMatrix(graph, BASE_REGISTRY);
    assert.strictEqual(matrix.find(r => r.key === 'outcome'), undefined);
  });

  test('registry override — custom engine pattern suppresses test_key_foo', () => {
    const customRegistry = {
      ...BASE_REGISTRY,
      engine_key_patterns: [...BASE_REGISTRY.engine_key_patterns, 'test_key_*'],
    };
    const graph = {
      nodes: [{ id: 'N1', context_on_success: 'test_key_foo=bar' }],
      edges: [],
    };
    const matrix = buildContextKeyMatrix(graph, customRegistry);
    assert.strictEqual(matrix.find(r => r.key === 'test_key_foo'), undefined);
  });

  test('deterministic sort — same input produces identical output on two calls', () => {
    const graph = {
      nodes: [
        { id: 'N3', context_on_success: 'artifact_zzz=v' },
        { id: 'N1', context_on_success: 'artifact_aaa=v' },
        { id: 'N2', context_on_success: 'artifact_mmm=v,artifact_aaa=v2' },
      ],
      edges: [
        { target: 'N4', attrs: { condition: 'context.artifact_aaa=v' } },
        { target: 'N3', attrs: { condition: 'context.artifact_zzz=v' } },
      ],
    };
    const matrix1 = buildContextKeyMatrix(graph, BASE_REGISTRY);
    const matrix2 = buildContextKeyMatrix(graph, BASE_REGISTRY);
    assert.strictEqual(JSON.stringify(matrix1), JSON.stringify(matrix2));
    assert.ok(matrix1.length > 0);
    for (let i = 1; i < matrix1.length; i++) {
      assert.ok(matrix1[i - 1].key <= matrix1[i].key, 'rows must be sorted by key');
    }
    for (const row of matrix1) {
      const writersSorted = [...row.writers].sort();
      const readersSorted = [...row.readers].sort();
      assert.deepStrictEqual(row.writers, writersSorted);
      assert.deepStrictEqual(row.readers, readersSorted);
    }
  });

  test('context_on_failure writes are tracked', () => {
    const graph = {
      nodes: [{ id: 'N1', context_on_failure: 'artifact_bar=failed' }],
      edges: [],
    };
    const matrix = buildContextKeyMatrix(graph, BASE_REGISTRY);
    assert.ok(matrix.find(r => r.key === 'artifact_bar'), 'artifact_bar should be in matrix');
    assert.deepStrictEqual(matrix.find(r => r.key === 'artifact_bar')?.writers, ['N1']);
  });

  test('context_keys attr on node declares a reader', () => {
    const graph = {
      nodes: [
        { id: 'N1', context_on_success: 'artifact_baz=v' },
        { id: 'N2', context_keys: 'artifact_baz' },
      ],
      edges: [],
    };
    const matrix = buildContextKeyMatrix(graph, BASE_REGISTRY);
    const row = matrix.find(r => r.key === 'artifact_baz');
    assert.ok(row);
    assert.deepStrictEqual(row.readers, ['N2']);
  });

  test('flat edge condition (no attrs wrapper) falls back gracefully', () => {
    const graph = {
      nodes: [{ id: 'N1', context_on_success: 'artifact_qux=v' }],
      edges: [{ target: 'N2', condition: 'context.artifact_qux=v' }],
    };
    const matrix = buildContextKeyMatrix(graph, BASE_REGISTRY);
    const row = matrix.find(r => r.key === 'artifact_qux');
    assert.ok(row);
    assert.deepStrictEqual(row.readers, ['N2']);
  });

  test('malformed attrs tolerated — missing id node skipped, no throw', () => {
    const graph = {
      nodes: [
        { context_on_success: 'artifact_noid=v' },
        { id: 42, context_on_success: 'artifact_badid=v' },
      ],
      edges: [],
    };
    assert.doesNotThrow(() => buildContextKeyMatrix(graph, BASE_REGISTRY));
    const matrix = buildContextKeyMatrix(graph, BASE_REGISTRY);
    assert.strictEqual(matrix.find(r => r.key === 'artifact_noid'), undefined);
    assert.strictEqual(matrix.find(r => r.key === 'artifact_badid'), undefined);
  });

  test('empty graph produces empty matrix', () => {
    const matrix = buildContextKeyMatrix({ nodes: [], edges: [] }, BASE_REGISTRY);
    assert.deepStrictEqual(matrix, []);
  });

  test('tool_command ATTRACTOR_CTX: write is discovered', () => {
    const graph = {
      nodes: [{ id: 'N1', tool_command: 'bun verify.ts && echo ATTRACTOR_CTX:category=foo' }],
      edges: [],
    };
    const matrix = buildContextKeyMatrix(graph, BASE_REGISTRY);
    assert.ok(matrix.find(r => r.key === 'category' && r.writers.includes('N1')));
  });

  test('prompt ${ATTRACTOR_CTX_*} read is discovered', () => {
    const graph = {
      nodes: [{ id: 'N1', prompt: 'use ${ATTRACTOR_CTX_PAYLOAD} for this step' }],
      edges: [],
    };
    const matrix = buildContextKeyMatrix(graph, BASE_REGISTRY);
    assert.ok(matrix.find(r => r.key === 'PAYLOAD' && r.readers.includes('N1')));
  });

  test('whitespace-tolerant write pattern matches ATTRACTOR_CTX: key = val', () => {
    const graph = {
      nodes: [{ id: 'N1', tool_command: 'echo ATTRACTOR_CTX: foo =bar' }],
      edges: [],
    };
    const matrix = buildContextKeyMatrix(graph, BASE_REGISTRY);
    assert.ok(matrix.find(r => r.key === 'foo'));
  });

  test('engine-key filter applies to regex-discovered tool_command write', () => {
    const graph = {
      nodes: [{ id: 'N1', tool_command: 'echo ATTRACTOR_CTX:outcome=ok' }],
      edges: [],
    };
    const matrix = buildContextKeyMatrix(graph, BASE_REGISTRY);
    assert.strictEqual(matrix.find(r => r.key === 'outcome'), undefined);
  });
});

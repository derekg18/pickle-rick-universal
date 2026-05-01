import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildCycles } from '../lib/tarjan-scc.js';

describe('cycles-convergence: convergence signal classification', () => {
  test('iterate signal — node with class=iterate, epsilon>0, until present', () => {
    const graph = {
      nodes: [
        { id: 'A', class: 'iterate', convergence_epsilon: 0.1, until: 'score_stable' },
        { id: 'B' },
      ],
      edges: [
        { source: 'A', target: 'B' },
        { source: 'B', target: 'A' },
      ],
    };
    const rows = buildCycles(graph);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].convergence_signal, 'iterate');
  });

  test('iterate signal not fired when epsilon is 0', () => {
    const graph = {
      nodes: [
        { id: 'A', class: 'iterate', convergence_epsilon: 0, until: 'score_stable' },
        { id: 'B' },
      ],
      edges: [
        { source: 'A', target: 'B' },
        { source: 'B', target: 'A' },
      ],
    };
    const rows = buildCycles(graph);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].convergence_signal, null);
  });

  test('iterate signal not fired when until is absent', () => {
    const graph = {
      nodes: [
        { id: 'A', class: 'iterate', convergence_epsilon: 0.1 },
        { id: 'B' },
      ],
      edges: [
        { source: 'A', target: 'B' },
        { source: 'B', target: 'A' },
      ],
    };
    const rows = buildCycles(graph);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].convergence_signal, null);
  });

  test('fix_attempt_history signal via __fix_attempt_history in context_keys', () => {
    const graph = {
      nodes: [
        { id: 'A', context_keys: '__fix_attempt_history,other_key' },
        { id: 'B' },
      ],
      edges: [
        { source: 'A', target: 'B' },
        { source: 'B', target: 'A' },
      ],
    };
    const rows = buildCycles(graph);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].convergence_signal, 'fix_attempt_history');
  });

  test('fix_attempt_history signal via __pool_findings__ in context_keys', () => {
    const graph = {
      nodes: [
        { id: 'A', context_keys: '__pool_findings__' },
        { id: 'B' },
      ],
      edges: [
        { source: 'A', target: 'B' },
        { source: 'B', target: 'A' },
      ],
    };
    const rows = buildCycles(graph);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].convergence_signal, 'fix_attempt_history');
  });

  test('fix_attempt_history signal via __last_failure_output in context_keys', () => {
    const graph = {
      nodes: [
        { id: 'A', context_keys: 'results,__last_failure_output' },
        { id: 'B' },
      ],
      edges: [
        { source: 'A', target: 'B' },
        { source: 'B', target: 'A' },
      ],
    };
    const rows = buildCycles(graph);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].convergence_signal, 'fix_attempt_history');
  });

  test('model_ladder signal — node with model_ladder and ladder_advance_on=rollback', () => {
    const graph = {
      nodes: [
        { id: 'A', model_ladder: 'llama3', ladder_advance_on: 'rollback' },
        { id: 'B' },
      ],
      edges: [
        { source: 'A', target: 'B' },
        { source: 'B', target: 'A' },
      ],
    };
    const rows = buildCycles(graph);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].convergence_signal, 'model_ladder');
  });

  test('model_ladder not fired when ladder_advance_on is not rollback', () => {
    const graph = {
      nodes: [
        { id: 'A', model_ladder: 'llama3', ladder_advance_on: 'success' },
        { id: 'B' },
      ],
      edges: [
        { source: 'A', target: 'B' },
        { source: 'B', target: 'A' },
      ],
    };
    const rows = buildCycles(graph);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].convergence_signal, null);
  });

  test('no signal — plain 2-node cycle with no recognized attributes', () => {
    const graph = {
      nodes: [{ id: 'A' }, { id: 'B' }],
      edges: [
        { source: 'A', target: 'B' },
        { source: 'B', target: 'A' },
      ],
    };
    const rows = buildCycles(graph);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].convergence_signal, null);
  });

  test('iterate signal takes priority over fix_attempt_history', () => {
    const graph = {
      nodes: [
        {
          id: 'A',
          class: 'iterate',
          convergence_epsilon: 0.5,
          until: 'done',
          context_keys: '__fix_attempt_history',
        },
        { id: 'B' },
      ],
      edges: [
        { source: 'A', target: 'B' },
        { source: 'B', target: 'A' },
      ],
    };
    const rows = buildCycles(graph);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].convergence_signal, 'iterate');
  });

  test('signal detected on second node in SCC', () => {
    const graph = {
      nodes: [
        { id: 'A' },
        { id: 'B', class: 'iterate', convergence_epsilon: 1.0, until: 'stable' },
      ],
      edges: [
        { source: 'A', target: 'B' },
        { source: 'B', target: 'A' },
      ],
    };
    const rows = buildCycles(graph);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].convergence_signal, 'iterate');
  });
});

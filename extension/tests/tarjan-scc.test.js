import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildCycles } from '../lib/tarjan-scc.js';

describe('tarjan-scc: SCC detection', () => {
  test('2-node cycle produces one SCC', () => {
    const graph = {
      nodes: [{ id: 'A' }, { id: 'B' }],
      edges: [
        { source: 'A', target: 'B' },
        { source: 'B', target: 'A' },
      ],
    };
    const sccs = buildCycles(graph);
    assert.strictEqual(sccs.length, 1);
    assert.deepStrictEqual(sccs[0].scc_nodes, ['A', 'B']);
    assert.strictEqual(sccs[0].convergence_signal, null);
  });

  test('self-loop produces one SCC', () => {
    const graph = {
      nodes: [{ id: 'A' }],
      edges: [{ source: 'A', target: 'A' }],
    };
    const sccs = buildCycles(graph);
    assert.strictEqual(sccs.length, 1);
    assert.deepStrictEqual(sccs[0].scc_nodes, ['A']);
    assert.strictEqual(sccs[0].convergence_signal, null);
  });

  test('disconnected graph — only cyclic pair is returned', () => {
    const graph = {
      nodes: [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }],
      edges: [
        { source: 'A', target: 'B' },
        { source: 'B', target: 'A' },
        { source: 'C', target: 'D' },
      ],
    };
    const sccs = buildCycles(graph);
    assert.strictEqual(sccs.length, 1);
    assert.deepStrictEqual(sccs[0].scc_nodes, ['A', 'B']);
  });

  test('3-node cycle with extra acyclic edge', () => {
    const graph = {
      nodes: [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }, { id: 'E' }],
      edges: [
        { source: 'A', target: 'B' },
        { source: 'B', target: 'C' },
        { source: 'C', target: 'A' },
        { source: 'D', target: 'E' },
      ],
    };
    const sccs = buildCycles(graph);
    assert.strictEqual(sccs.length, 1);
    assert.deepStrictEqual(sccs[0].scc_nodes, ['A', 'B', 'C']);
  });

  test('empty graph returns empty array', () => {
    const graph = { nodes: [], edges: [] };
    const sccs = buildCycles(graph);
    assert.deepStrictEqual(sccs, []);
  });

  test('no cycles returns empty array', () => {
    const graph = {
      nodes: [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
      edges: [
        { source: 'A', target: 'B' },
        { source: 'B', target: 'C' },
      ],
    };
    const sccs = buildCycles(graph);
    assert.deepStrictEqual(sccs, []);
  });

  test('scc_nodes are sorted alphabetically', () => {
    const graph = {
      nodes: [{ id: 'Z' }, { id: 'A' }, { id: 'M' }],
      edges: [
        { source: 'Z', target: 'A' },
        { source: 'A', target: 'M' },
        { source: 'M', target: 'Z' },
      ],
    };
    const sccs = buildCycles(graph);
    assert.strictEqual(sccs.length, 1);
    assert.deepStrictEqual(sccs[0].scc_nodes, ['A', 'M', 'Z']);
  });

  test('two independent cycles', () => {
    const graph = {
      nodes: [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }],
      edges: [
        { source: 'A', target: 'B' },
        { source: 'B', target: 'A' },
        { source: 'C', target: 'D' },
        { source: 'D', target: 'C' },
      ],
    };
    const sccs = buildCycles(graph);
    assert.strictEqual(sccs.length, 2);
    const nodesets = sccs.map(s => s.scc_nodes.join(','));
    assert.ok(nodesets.includes('A,B'));
    assert.ok(nodesets.includes('C,D'));
  });

  test('from/to edge aliases work', () => {
    const graph = {
      nodes: [{ id: 'A' }, { id: 'B' }],
      edges: [
        { from: 'A', to: 'B' },
        { from: 'B', to: 'A' },
      ],
    };
    const sccs = buildCycles(graph);
    assert.strictEqual(sccs.length, 1);
    assert.deepStrictEqual(sccs[0].scc_nodes, ['A', 'B']);
  });
});

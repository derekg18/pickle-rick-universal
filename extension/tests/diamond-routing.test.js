import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB_PATH = path.resolve(__dirname, '..', 'lib', 'diamond-routing.js');
const { buildDiamondRouting } = await import(LIB_PATH);

describe('buildDiamondRouting', () => {
  test('v9-trap: stuck cells detected for (unset, non-empty) and (seed_failed, non-empty)', () => {
    // Diamond with 3 outgoing condition edges referencing 2 keys.
    // Third edge covers pool_count=unset so only (artifact!=seeded AND pool=non-empty) are stuck.
    const graph = {
      nodes: [
        { id: 'd_api', class: 'diamond' },
        {
          id: 'n_artifact_writer',
          context_on_success: 'artifact_api_controller=seeded',
          context_on_failure: 'artifact_api_controller=seed_failed',
        },
        {
          id: 'n_pool_writer',
          context_on_success: 'pool_count_reviewer_controller=non-empty',
          context_on_failure: 'pool_count_reviewer_controller=empty',
        },
      ],
      edges: [
        {
          source: 'd_api',
          target: 'impl_patch',
          condition: 'context.artifact_api_controller=seeded',
          attrs: { weight: 2 },
        },
        {
          source: 'd_api',
          target: 'impl_seed',
          condition: 'context.pool_count_reviewer_controller=empty',
        },
        {
          source: 'd_api',
          target: 'impl_init',
          condition: 'context.pool_count_reviewer_controller=unset',
        },
      ],
    };

    const result = buildDiamondRouting(graph);

    assert.strictEqual(result.length, 1);
    const row = result[0];
    assert.strictEqual(row.diamond, 'd_api');
    assert.strictEqual(row.stuck_states.length, 2);

    const stuckCells = row.stuck_states.map(s => s.cell);
    const hasUnsetNonEmpty = stuckCells.some(
      c =>
        c['artifact_api_controller'] === 'unset' &&
        c['pool_count_reviewer_controller'] === 'non-empty',
    );
    const hasSeedFailedNonEmpty = stuckCells.some(
      c =>
        c['artifact_api_controller'] === 'seed_failed' &&
        c['pool_count_reviewer_controller'] === 'non-empty',
    );

    assert.ok(hasUnsetNonEmpty, 'stuck_states must contain (unset, non-empty)');
    assert.ok(hasSeedFailedNonEmpty, 'stuck_states must contain (seed_failed, non-empty)');
    assert.ok(row.stuck_states.every(s => s.matchingEdges.length === 0));
  });

  test('non-deterministic overlap: cell matched by ≥2 edges recorded in matchingEdges', () => {
    // Two edges where both conditions are satisfied by the same cell.
    const graph = {
      nodes: [
        { id: 'd1', class: 'diamond' },
        {
          id: 'writer',
          context_on_success: 'status=ready,mode=active',
        },
      ],
      edges: [
        { source: 'd1', target: 'handler_a', condition: 'context.status=ready' },
        { source: 'd1', target: 'handler_b', condition: 'context.mode=active' },
      ],
    };

    const result = buildDiamondRouting(graph);
    assert.strictEqual(result.length, 1);

    const row = result[0];
    const overlapping = row.covered_states.find(s => s.matchingEdges.length >= 2);
    assert.ok(overlapping !== undefined, 'expected at least one cell with matchingEdges.length >= 2');
    assert.strictEqual(overlapping.matchingEdges.length, 2);
  });

  test('cap exceeded: 5 keys × 5 values (>256 cells) emits marker row', () => {
    // 5 keys, each with 4 observed values → 5 total (including "unset") → 5^5 = 3125 > 256
    const writerNodes = ['k0', 'k1', 'k2', 'k3', 'k4'].map(k => ({
      id: `writer_${k}`,
      context_on_success: `${k}=va,${k}=vb`,
      context_on_failure: `${k}=vc,${k}=vd`,
    }));

    const edges = ['k0', 'k1', 'k2', 'k3', 'k4'].map(k => ({
      source: 'd_fat',
      target: `target_${k}`,
      condition: `context.${k}=va`,
    }));

    const graph = {
      nodes: [{ id: 'd_fat', class: 'diamond' }, ...writerNodes],
      edges,
    };

    const result = buildDiamondRouting(graph);
    assert.strictEqual(result.length, 1);

    const row = result[0];
    assert.strictEqual(row.covered_states.length, 0);
    assert.strictEqual(row.stuck_states.length, 1);

    const marker = row.stuck_states[0];
    assert.ok(
      typeof marker.note === 'string' && marker.note.includes('too complex'),
      `expected note to include "too complex", got: ${marker.note}`,
    );
  });

  test('determinism: two runs on same input produce identical JSON', () => {
    const graph = {
      nodes: [
        { id: 'd1', class: 'diamond' },
        {
          id: 'w1',
          context_on_success: 'foo=bar',
          context_on_failure: 'foo=baz',
        },
      ],
      edges: [
        { source: 'd1', target: 't1', condition: 'context.foo=bar' },
        { source: 'd1', target: 't2', condition: 'context.foo=baz' },
      ],
    };

    const out1 = buildDiamondRouting(graph);
    const out2 = buildDiamondRouting(graph);
    assert.strictEqual(JSON.stringify(out1), JSON.stringify(out2));
  });
});

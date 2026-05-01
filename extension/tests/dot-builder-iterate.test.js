import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DotBuilder, BuildError } from '../services/dot-builder.js';
import { parseDot } from './__helpers__/dot-parse.js';

function makeConvergenceSpec(overrides = {}) {
  return {
    slug: 'iter-test',
    goal: 'test convergence',
    phases: [{ name: 'core', prompt: 'implement', allowedPaths: ['src/'] }],
    acceptanceCriteria: {},
    convergence: {
      until: 'V_total == 0 && fixed_point && reproducibility',
      impl: { harness: 'claude-code', prompt: 'Implement the feature' },
      ...overrides,
    },
  };
}

describe('iterate convergence', () => {
  it('AC3: basic convergence emission', () => {
    const { dot } = DotBuilder.fromSpec(makeConvergenceSpec()).build();
    const { nodes } = parseDot(dot);
    assert.ok(dot.includes('class="iterate"'), 'converge node must have class="iterate"');
    assert.ok(dot.includes('subgraph cluster_iter_body'), 'iter body subgraph must be emitted');
    const expected = new Set([
      'fix_backend', 'fix_frontend',
      'run_build_api', 'run_tests_api', 'run_build_ui', 'run_lint',
      'review_be', 'review_fe', 'review_int', 'adversary_node',
    ]);
    for (const id of expected) {
      assert.ok(nodes.has(id), `v8 body node "${id}" must be present`);
    }
  });

  it('AC6: all three reviewer lenses on correct nodes', () => {
    const { dot } = DotBuilder.fromSpec(makeConvergenceSpec()).build();
    const { nodes } = parseDot(dot);
    const be = nodes.get('review_be');
    assert.ok(be, 'review_be node should exist');
    assert.equal(be.reviewer_lens, 'backend', 'review_be should have backend lens');
    const fe = nodes.get('review_fe');
    assert.ok(fe, 'review_fe node should exist');
    assert.equal(fe.reviewer_lens, 'frontend', 'review_fe should have frontend lens');
    const int = nodes.get('review_int');
    assert.ok(int, 'review_int node should exist');
    assert.equal(int.reviewer_lens, 'integration', 'review_int should have integration lens');
  });

  it('AC7: adversary sealed_from_source camelCase→snake_case', () => {
    const spec = makeConvergenceSpec({ sealedFromSource: '/tmp/spec.md' });
    const { dot } = DotBuilder.fromSpec(spec).build();
    assert.ok(dot.includes('sealed_from_source="/tmp/spec.md"'), 'sealedFromSource must convert to sealed_from_source in DOT output');
    // Verify with a different value to confirm camelCase→snake_case conversion
    const spec2 = makeConvergenceSpec({ sealedFromSource: 'app/**,lib/**' });
    const { dot: dot2 } = DotBuilder.fromSpec(spec2).build();
    assert.ok(dot2.includes('sealed_from_source="app/**,lib/**"'), 'sealedFromSource should be converted to snake_case in DOT');
  });

  it('AC5/AC11: duplicate model rejected', () => {
    const spec = {
      ...makeConvergenceSpec(),
      modelStylesheet: {
        defaultModel: 'sonnet',
        overrides: [
          { selector: '.impl', model: 'opus' },
          { selector: '.honest_review', model: 'opus' },
        ],
      },
    };
    assert.throws(
      () => DotBuilder.fromSpec(spec).build(),
      (err) => {
        assert.ok(err instanceof BuildError, 'must throw BuildError');
        assert.equal(err.code, 'DUPLICATE_MODEL');
        return true;
      },
    );
  });

  it('AC13: invalid until predicate rejected', () => {
    const spec = makeConvergenceSpec({ until: 'custom_predicate' });
    assert.throws(
      () => DotBuilder.fromSpec(spec).build(),
      (err) => {
        assert.ok(err instanceof BuildError, 'must throw BuildError');
        assert.equal(err.code, 'INVALID_CONVERGENCE_SPEC');
        return true;
      },
    );
  });

  it('AC12: traditional endgame chain suppressed', () => {
    const { dot } = DotBuilder.fromSpec(makeConvergenceSpec()).build();
    assert.ok(!dot.includes('verify_typecheck'), 'verify_typecheck must NOT appear in convergence output');
    assert.ok(!dot.includes('fix_types'), 'fix_types must NOT appear in convergence output');
    assert.ok(!dot.includes('verify_lint'), 'verify_lint must NOT appear in convergence output');
    assert.ok(!dot.includes('fix_lint'), 'fix_lint must NOT appear in convergence output');
    assert.ok(!dot.includes('verify_tests'), 'verify_tests must NOT appear in convergence output');
    assert.ok(!dot.includes('fix_tests'), 'fix_tests must NOT appear in convergence output');
  });

  it('AC14: P25 (regression_check -> setup_deps) suppressed', () => {
    const { dot } = DotBuilder.fromSpec(makeConvergenceSpec()).build();
    assert.ok(!dot.includes('regression_check'), 'regression_check must NOT appear in convergence output');
    // The P25 loop-restart edge must not be emitted
    assert.ok(
      !dot.includes('loop_restart'),
      'loop_restart edge (P25) must be suppressed in convergence mode',
    );
  });

  it('AC8: P0 composition — commit_and_push injected for isolated workspace', () => {
    const spec = { ...makeConvergenceSpec(), workspace: 'isolated' };
    const { dot, patternsApplied } = DotBuilder.fromSpec(spec).build();
    const { nodes, edges } = parseDot(dot);
    assert.ok(nodes.has('commit_and_push'), 'commit_and_push must be injected for workspace=isolated');
    // v8 terminal chain: repro_verify -> commit_and_push -> done
    const rpToCp = edges.find(e => e.from === 'repro_verify' && e.to === 'commit_and_push');
    assert.ok(rpToCp, 'repro_verify must route to commit_and_push');
    assert.equal(rpToCp.attrs.label, 'pass', 'rewired repro->cp edge must carry label="pass" for consistency with sibling success edges');
    const cpToDone = edges.find(e => e.from === 'commit_and_push' && e.to === 'done');
    assert.ok(cpToDone, 'commit_and_push must route to done');
    assert.equal(cpToDone.attrs.label, 'pass', 'rewired cp->done edge must carry label="pass" for consistency with sibling success edges');
    assert.ok(patternsApplied.includes('P0'), 'patternsApplied must include P0 for workspace=isolated composition');
  });

  it('AC15: P1 composition — setup_deps emitted before converge', () => {
    const { dot } = DotBuilder.fromSpec(makeConvergenceSpec()).build();
    const setupIdx = dot.search(/^  setup_deps \[/m);
    const convergeIdx = dot.search(/^  converge \[/m);
    assert.ok(setupIdx >= 0, 'setup_deps node must be present');
    assert.ok(convergeIdx >= 0, 'converge node must be present');
    assert.ok(setupIdx < convergeIdx, 'setup_deps must appear before converge in DOT output');
  });

  it('node ID stability — all body nodes match v8 topology', () => {
    const { dot } = DotBuilder.fromSpec(makeConvergenceSpec()).build();
    const { nodes } = parseDot(dot);
    const expectedIds = [
      'fix_backend', 'fix_frontend',
      'run_build_api', 'run_tests_api', 'run_build_ui', 'run_lint',
      'review_be', 'review_fe', 'review_int', 'adversary_node',
    ];
    for (const id of expectedIds) {
      assert.ok(nodes.has(id), `v8 body node "${id}" must be present`);
    }
    // Verify old pre-v8 iter_* IDs are NOT present
    assert.ok(!nodes.has('iter_impl'), 'no legacy iter_impl node in v8');
    assert.ok(!nodes.has('iter_review_be'), 'no legacy iter_review_be node in v8');
    assert.ok(!nodes.has('iter_adversary'), 'no legacy iter_adversary node in v8');
  });

  it('P32 in patternsApplied', () => {
    const { patternsApplied } = DotBuilder.fromSpec(makeConvergenceSpec()).build();
    assert.ok(patternsApplied.includes('P32'), 'patternsApplied must include P32 for convergence');
  });

  it('default maxVisits and timeout applied when not specified', () => {
    const { dot } = DotBuilder.fromSpec(makeConvergenceSpec()).build();
    const { nodes } = parseDot(dot);
    const conv = nodes.get('converge');
    assert.ok(conv, 'converge node must be present');
    assert.equal(conv.max_visits, '5', 'default max_visits must be 5 on converge node (v8)');
    assert.equal(conv.timeout, '21600s', 'default timeout must be 21600s on converge node (v8)');
  });

  it('P1-1 regression: isolated workspace edge rewiring preserves dedup set', () => {
    const spec = { ...makeConvergenceSpec(), workspace: 'isolated' };
    const { dot } = DotBuilder.fromSpec(spec).build();
    const { edges } = parseDot(dot);
    // After rewiring repro_verify -> done to repro_verify -> commit_and_push -> done,
    // the original repro_verify -> done direct edge must be fully removed.
    const rpToDoneDirect = edges.filter(e => e.from === 'repro_verify' && e.to === 'done');
    assert.equal(rpToDoneDirect.length, 0, 'repro_verify -> done direct edge must be removed by rewire');
    // commit_and_push -> done must appear exactly once
    const cpToDone = edges.filter(e => e.from === 'commit_and_push' && e.to === 'done');
    assert.equal(cpToDone.length, 1, 'commit_and_push -> done must appear exactly once');
  });

  it('explicit maxVisits override on convergence node', () => {
    const spec = makeConvergenceSpec({ maxVisits: 10 });
    const { dot } = DotBuilder.fromSpec(spec).build();
    // The converge node should have the overridden max_visits
    const convergeMatch = dot.match(/converge \[([^\]]+)\]/);
    assert.ok(convergeMatch, 'converge node must be present');
    assert.ok(convergeMatch[1].includes('max_visits="10"'), 'max_visits must be 10 when explicitly set');
  });

  it('explicit timeout override on convergence node', () => {
    const spec = makeConvergenceSpec({ timeout: '120m' });
    const { dot } = DotBuilder.fromSpec(spec).build();
    const convergeMatch = dot.match(/converge \[([^\]]+)\]/);
    assert.ok(convergeMatch, 'converge node must be present');
    assert.ok(convergeMatch[1].includes('timeout="120m"'), 'timeout must be 120m when explicitly set');
  });

  it('minimal until predicate V_total == 0 accepted', () => {
    const spec = makeConvergenceSpec({ until: 'V_total == 0' });
    const { dot } = DotBuilder.fromSpec(spec).build();
    assert.ok(dot.includes('until="V_total == 0"'), 'minimal until predicate must be accepted');
  });

  it('three distinct convergence models accepted', () => {
    const spec = {
      ...makeConvergenceSpec(),
      modelStylesheet: {
        defaultModel: 'sonnet',
        overrides: [
          { selector: '.impl', model: 'opus' },
          { selector: '.honest_review', model: 'haiku' },
          { selector: '.adversary', model: 'sonnet' },
        ],
      },
    };
    // Should not throw — all three models are distinct
    const { dot } = DotBuilder.fromSpec(spec).build();
    assert.ok(dot.includes('model_stylesheet='), 'model_stylesheet must be present');
  });

  it('middle until predicate V_total == 0 && fixed_point accepted', () => {
    const spec = makeConvergenceSpec({ until: 'V_total == 0 && fixed_point' });
    const { dot } = DotBuilder.fromSpec(spec).build();
    const converge = parseDot(dot).nodes.get('converge');
    assert.ok(converge, 'converge node must be present');
    assert.equal(converge.until, 'V_total == 0 && fixed_point',
      'middle until predicate must be emitted verbatim on the converge node');
  });
});

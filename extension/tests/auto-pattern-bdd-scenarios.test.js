/**
 * BDD Scenarios for Pickle-Dot Codegen Builder Auto-Patterns
 *
 * Behavior-Driven Development scenarios from a pipeline author's perspective
 * for the 18 auto-applied patterns in the builder.
 *
 * Pattern IDs: 0a, 0b, 0c, 0d, 0e, 1, 3, 4, 6, 6b, 10, 13, 14, 15, 21, 22, 23, 25
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DotBuilder } from '../services/dot-builder.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract node id → attribute Map from a DOT string.
 * Processes line-by-line to correctly handle `]` inside quoted attribute values
 * (e.g. shell commands like `[ $(git status ...) ]`).
 */
function parseDotNodes(dot) {
  const nodes = new Map();
  for (const line of dot.split('\n')) {
    // Match a node definition line: <id> [<attrs>]
    // Use greedy (.+) so it extends to the LAST `]` on the line, not the first.
    const lineMatch = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\[(.+)\]\s*$/.exec(line);
    if (!lineMatch) continue;
    const nodeId = lineMatch[1];
    if (nodeId === 'graph') continue; // skip graph-level attributes
    const attrsStr = lineMatch[2];
    const attrs = new Map();
    // Match key="value" where value can contain `]` but not unescaped `"`.
    // Pattern: any chars except `"` or `\`, OR `\` followed by any char.
    const attrRegex = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;
    let attrMatch;
    while ((attrMatch = attrRegex.exec(attrsStr)) !== null) {
      attrs.set(attrMatch[1], attrMatch[2]);
    }
    nodes.set(nodeId, attrs);
  }
  return nodes;
}

/**
 * Extract edges array from a DOT string.
 * Uses ` *` (spaces only) instead of `\s*` after captures to avoid consuming
 * the trailing newline + leading whitespace of the next line, which would break
 * the `^` anchor on subsequent matches.
 */
function parseDotEdges(dot) {
  const edges = [];
  const edgeRegex = /^ *([a-zA-Z_][a-zA-Z0-9_]*) *-> *([a-zA-Z_][a-zA-Z0-9_]*) *(?:\[([^\]]*)\])?/gm;
  let match;
  while ((match = edgeRegex.exec(dot)) !== null) {
    const source = match[1];
    const target = match[2];
    const attrsStr = match[3] ?? '';
    const attrs = new Map();
    const attrRegex = /([a-zA-Z_][a-zA-Z0-9_]*)="([^"]*)"/g;
    let am;
    while ((am = attrRegex.exec(attrsStr)) !== null) {
      attrs.set(am[1], am[2]);
    }
    edges.push({ source, target, attrs });
  }
  return edges;
}

/** Minimal valid phase spec. */
function phase(name, overrides = {}) {
  return { name, prompt: `implement ${name}`, allowedPaths: ['src/'], timeout: '10m', ...overrides };
}

// ---------------------------------------------------------------------------
// BDD Scenarios — 18 auto-applied patterns
// ---------------------------------------------------------------------------

describe('Pickle-Dot Builder Auto-Patterns - BDD Scenarios', () => {

  describe('Pattern 0a: Dependency Setup', () => {
    test('0a: Given any spec, When the builder generates the pipeline, Then it automatically includes a setup_deps node with npm/pnpm/yarn fallback chain', () => {
      const builder = new DotBuilder({
        slug: 'test-project',
        goal: 'Build a simple API',
        phases: [phase('api')],
        acceptanceCriteria: {},
      });
      const result = builder.build();

      const nodes = parseDotNodes(result.dot);
      assert.ok(nodes.has('setup_deps'), 'should have setup_deps node');

      const setupDeps = nodes.get('setup_deps');
      assert.equal(setupDeps.get('shape'), 'parallelogram', 'setup_deps should have shape="parallelogram"');

      const toolCmd = setupDeps.get('tool_command') ?? '';
      assert.ok(toolCmd.includes('npm install'), 'setup_deps must include npm install');
      assert.ok(toolCmd.includes('pnpm install'), 'setup_deps must include pnpm install fallback');
      assert.ok(toolCmd.includes('yarn install'), 'setup_deps must include yarn install fallback');

      const edges = parseDotEdges(result.dot);
      assert.ok(edges.some(e => e.source === 'start' && e.target === 'setup_deps'),
        'start must edge to setup_deps');
      assert.ok(result.patternsApplied.includes('P0a'), 'patternsApplied must include P0a');
    });
  });

  describe('Pattern 0b: Parallel Limit', () => {
    test('0b: Given a fan-out spec (2+ independent phases), When the pipeline is generated, Then split_phases has max_parallel=1', () => {
      const result = new DotBuilder({
        slug: 'multi-phase-project',
        goal: 'Build multiple components in parallel',
        phases: [phase('auth'), phase('api')],
        acceptanceCriteria: {},
      }).build();

      const nodes = parseDotNodes(result.dot);
      assert.ok(nodes.has('split_phases'), 'should have split_phases node');

      const splitPhases = nodes.get('split_phases');
      assert.equal(splitPhases.get('shape'), 'component', 'split_phases should have shape="component"');
      assert.equal(splitPhases.get('max_parallel'), '1', 'split_phases should have max_parallel="1"');
      assert.ok(result.patternsApplied.includes('P0b'), 'patternsApplied must include P0b');
    });
  });

  describe('Pattern 0c: Baseline Snapshot', () => {
    test('0c: Given any spec, When the builder generates the pipeline, Then it includes a capture_baseline node that snapshots lint and typecheck error counts', () => {
      const result = new DotBuilder({
        slug: 'baseline-test',
        goal: 'Test baseline capture',
        phases: [phase('core')],
        acceptanceCriteria: {},
      }).build();

      const nodes = parseDotNodes(result.dot);
      assert.ok(nodes.has('capture_baseline'), 'should have capture_baseline node');

      const captureBaseline = nodes.get('capture_baseline');
      const toolCommand = captureBaseline.get('tool_command') ?? '';
      assert.ok(toolCommand.includes('npx tsc --noEmit'), 'should include tsc command');
      assert.ok(toolCommand.includes('npx eslint'), 'should include eslint command');
      assert.ok(toolCommand.includes('grep -c'), 'should include grep -c for counting');
      assert.equal(captureBaseline.get('read_only'), 'true', 'capture_baseline must be read_only');
      assert.ok(result.patternsApplied.includes('P0c'), 'patternsApplied must include P0c');
    });
  });

  describe('Pattern 0d: Delta-Aware Verify', () => {
    test('0d: Given phases, When verify nodes are generated, Then they compare CURRENT against BASELINE for regression detection', () => {
      const result = new DotBuilder({
        slug: 'delta-test',
        goal: 'Test delta-aware verification',
        phases: [phase('module')],
        acceptanceCriteria: {},
      }).build();

      // verify_lint label encodes BASELINE/CURRENT semantics
      assert.match(result.dot, /verify_lint/, 'must have verify_lint node');
      assert.match(result.dot, /BASELINE/, 'verify nodes must reference BASELINE');
      assert.match(result.dot, /CURRENT/, 'verify nodes must reference CURRENT');
      assert.ok(result.patternsApplied.includes('P0d'), 'patternsApplied must include P0d');
    });
  });

  describe('Pattern 0e: Progress Gate', () => {
    test('0e: Given an impl phase, When the builder generates the pipeline, Then it adds a check_progress node (read_only, max_visits=3, git status)', () => {
      const result = new DotBuilder({
        slug: 'progress-test',
        goal: 'Test progress monitoring',
        phases: [phase('backend')],
        acceptanceCriteria: {},
      }).build();

      const nodes = parseDotNodes(result.dot);
      assert.ok(nodes.has('check_progress_backend'), 'should have check_progress_backend node');

      const cp = nodes.get('check_progress_backend');
      assert.equal(cp.get('read_only'), 'true', 'check_progress must be read_only');
      assert.equal(cp.get('max_visits'), '3', 'check_progress must have max_visits=3');
      const toolCmd = cp.get('tool_command') ?? '';
      assert.ok(toolCmd.includes('git status --porcelain'), 'check_progress must use git status');
      assert.ok(result.patternsApplied.includes('P0e'), 'patternsApplied must include P0e');
    });

    test('0e: Given 2 sequential phases, When the builder generates the pipeline, Then each phase gets its own check_progress node', () => {
      const result = new DotBuilder({
        slug: 'progress-multi-test',
        goal: 'Test multi-phase progress monitoring',
        phases: [
          phase('frontend'),
          phase('backend', { dependsOn: ['frontend'] }),
        ],
        acceptanceCriteria: {},
      }).build();

      // Sequential pipeline emits check_progress_frontend and check_progress_backend
      assert.match(result.dot, /check_progress/, 'should have check_progress node(s)');
      const nodes = parseDotNodes(result.dot);
      assert.ok(nodes.has('check_progress_frontend'), 'phase 0 should have check_progress_frontend');
      assert.ok(nodes.has('check_progress_backend'), 'phase 1 should have check_progress_backend');
    });
  });

  describe('Pattern 1: Test-Fix Loops', () => {
    test('1: Given an impl phase, When the builder generates the pipeline, Then it creates a test diamond gate and fix loop for iterative correction', () => {
      const result = new DotBuilder({
        slug: 'test-fix-test',
        goal: 'Test test-fix loop',
        phases: [phase('feature')],
        acceptanceCriteria: {},
      }).build();

      const nodes = parseDotNodes(result.dot);
      assert.ok(nodes.has('test_feature'), 'should have test_feature node');
      assert.ok(nodes.has('fix_feature'), 'should have fix_feature node');

      const testAttrs = nodes.get('test_feature');
      assert.equal(testAttrs.get('shape'), 'diamond', 'test node must be a diamond');

      // Fix loop: fix → impl
      const edges = parseDotEdges(result.dot);
      assert.ok(edges.some(e => e.source === 'fix_feature' && e.target === 'impl_feature'),
        'fix must loop back to impl');
      // Fail edge: test → fix
      assert.ok(edges.some(e => e.source === 'test_feature' && e.target === 'fix_feature'),
        'test fail edge must go to fix');
      assert.ok(result.patternsApplied.includes('P1'), 'patternsApplied must include P1');
    });
  });

  describe('Pattern 3: Conditional Routing (≥2 outgoing edges on diamonds)', () => {
    test('3: Given any generated diamond node, When the pipeline is built, Then it has at least 2 outgoing edges', () => {
      const result = new DotBuilder({
        slug: 'conditional-test',
        goal: 'Test conditional routing',
        phases: [phase('feature')],
        acceptanceCriteria: {},
      }).build();

      const diamonds = [...result.dot.matchAll(/(\w+)\s*\[.*?shape="diamond"/g)].map(m => m[1]);
      assert.ok(diamonds.length > 0, 'must have at least one diamond node');

      for (const d of diamonds) {
        const outEdges = result.dot.match(new RegExp(`${d}\\s*->`, 'g')) ?? [];
        assert.ok(outEdges.length >= 2, `diamond ${d} must have ≥2 outgoing edges, got ${outEdges.length}`);
      }
      assert.ok(result.patternsApplied.includes('P3'), 'patternsApplied must include P3');
    });
  });

  describe('Pattern 4: Fan-Out/Fan-In', () => {
    test('4: Given 2+ independent phases (no dependsOn), When the builder generates the pipeline, Then it creates split/merge fan-out topology', () => {
      const result = new DotBuilder({
        slug: 'fan-out-test',
        goal: 'Test fan-out topology',
        phases: [phase('phase1'), phase('phase2'), phase('phase3')],
        acceptanceCriteria: {},
      }).build();

      const nodes = parseDotNodes(result.dot);
      assert.ok(nodes.has('split_phases'), 'should have split_phases node');
      assert.ok(nodes.has('merge_phases'), 'should have merge_phases node');
      assert.equal(nodes.get('split_phases').get('shape'), 'component', 'split_phases must be component');
      assert.equal(nodes.get('merge_phases').get('shape'), 'tripleoctagon', 'merge_phases must be tripleoctagon');

      const edges = parseDotEdges(result.dot);
      const splitEdges = edges.filter(e => e.source === 'split_phases');
      assert.ok(splitEdges.length >= 3, 'split_phases should fan out to all 3 phases');

      const mergeEdges = edges.filter(e => e.target === 'merge_phases');
      assert.ok(mergeEdges.length >= 3, 'all phase branches must converge to merge_phases');
      assert.ok(result.patternsApplied.includes('P4'), 'patternsApplied must include P4');
    });

    test('4: Given phases where some have dependsOn, When the builder generates, Then only independent phases fan-out; dependent phases serialize after merge', () => {
      const result = new DotBuilder({
        slug: 'mixed-dep-test',
        goal: 'Test mixed dependency fan-out',
        phases: [
          phase('auth'),
          phase('api'),
          phase('integration', { dependsOn: ['auth'] }),
        ],
        acceptanceCriteria: {},
      }).build();

      const nodes = parseDotNodes(result.dot);
      // auth + api are independent → fan-out; integration depends on auth → serializes after merge
      assert.ok(nodes.has('split_phases'), 'should have split_phases');
      assert.ok(nodes.has('merge_phases'), 'should have merge_phases');
      assert.ok(result.patternsApplied.includes('P4'), 'patternsApplied must include P4');
    });
  });

  describe('Pattern 6: Max Visits', () => {
    test('6: Given nodes with incoming retry edges, When the builder finalizes the pipeline, Then impl nodes get max_visits=5 to prevent infinite loops', () => {
      const result = new DotBuilder({
        slug: 'max-visits-test',
        goal: 'Test max visits injection',
        phases: [phase('feature')],
        acceptanceCriteria: {},
      }).build();

      assert.match(result.dot, /max_visits="5"/, 'retry-target nodes must have max_visits=5');
      assert.ok(result.patternsApplied.includes('P6'), 'patternsApplied must include P6');
    });

    test('6: Given a goalGate phase with defaultMaxRetry, When built, Then max_visits uses defaultMaxRetry (not hardcoded 5)', () => {
      const result = new DotBuilder({
        slug: 'max-visits-goal-test',
        goal: 'Test goalGate max visits',
        phases: [phase('validate', { goalGate: true, retryTarget: 'impl_validate' })],
        acceptanceCriteria: {},
        defaultMaxRetry: 3,
      }).build();

      assert.match(result.dot, /max_visits="3"/, 'goalGate conformance must use defaultMaxRetry=3');
      assert.ok(result.patternsApplied.includes('P6'), 'patternsApplied must include P6');
    });

    test('6: check_progress max_visits=3 is not overwritten by the impl max_visits=5', () => {
      const result = new DotBuilder({
        slug: 'max-visits-no-overwrite-test',
        goal: 'Verify max_visits is not overwritten',
        phases: [phase('feature')],
        acceptanceCriteria: {},
      }).build();

      // check_progress must keep max_visits=3
      assert.match(result.dot, /check_progress_feature\s*\[.*max_visits="3"/, 'check_progress must have max_visits=3');
      // impl must have max_visits=5
      assert.match(result.dot, /impl_feature\s*\[.*max_visits="5"/, 'impl must have max_visits=5');
    });
  });

  describe('Pattern 6b: Read-Only + STATUS on Review Nodes', () => {
    test('6b: Given review-class nodes, When built, Then they have read_only=true and STATUS markers in prompts', () => {
      const result = new DotBuilder({
        slug: 'read-only-test',
        goal: 'Test read-only enforcement',
        phases: [phase('code')],
        acceptanceCriteria: {},
      }).build();

      const reviewNodes = [...result.dot.matchAll(/(\w+)\s*\[.*?class="review"/g)].map(m => m[1]);
      assert.ok(reviewNodes.length > 0, 'must have at least one review-class node');

      for (const node of reviewNodes) {
        const nodeBlock = result.dot.match(new RegExp(`${node}\\s*\\[([^\\]]+)\\]`));
        assert.ok(nodeBlock, `${node} must have attributes`);
        assert.ok(nodeBlock[1].includes('read_only="true"'), `${node} must have read_only=true`);
      }
      assert.match(result.dot, /STATUS:/, 'review prompts must include STATUS markers');
      assert.ok(result.patternsApplied.includes('P6b'), 'patternsApplied must include P6b');
    });
  });

  describe('Pattern 10: Scope Creep Check', () => {
    test('10: Given an impl phase, When the builder generates the pipeline, Then it adds scope_check after impl to verify in-scope file changes', () => {
      const result = new DotBuilder({
        slug: 'scope-test',
        goal: 'Test scope creep prevention',
        phases: [phase('api')],
        acceptanceCriteria: {},
      }).build();

      const nodes = parseDotNodes(result.dot);
      assert.ok(nodes.has('scope_check_api'), 'should have scope_check_api node');

      const sc = nodes.get('scope_check_api');
      assert.equal(sc.get('class'), 'review', 'scope_check must have class=review');
      assert.equal(sc.get('read_only'), 'true', 'scope_check must be read_only');
      assert.equal(sc.get('shape'), 'parallelogram', 'scope_check must have shape=cds');

      // impl → scope_check edge
      const edges = parseDotEdges(result.dot);
      assert.ok(edges.some(e => e.source === 'impl_api' && e.target === 'scope_check_api'),
        'impl must edge to scope_check');
      assert.ok(result.patternsApplied.includes('P10'), 'patternsApplied must include P10');
    });

    test('10: scope_check prompt references git diff and allowed_paths', () => {
      const result = new DotBuilder({
        slug: 'scope-prompt-test',
        goal: 'Test scope_check prompt',
        phases: [phase('feature')],
        acceptanceCriteria: {},
      }).build();

      assert.match(result.dot, /git diff.*allowed_paths|allowed_paths.*git diff/,
        'scope_check prompt must reference git diff and allowed_paths');
    });
  });

  describe('Pattern 13: Lint Gate', () => {
    test('13: Given the verify chain, When generated, Then it includes a verify_lint node after check_progress', () => {
      const result = new DotBuilder({
        slug: 'lint-test',
        goal: 'Test lint gate',
        phases: [phase('module')],
        acceptanceCriteria: {},
      }).build();

      assert.match(result.dot, /verify_lint/, 'must have verify_lint node');

      const cpIdx = result.dot.indexOf('check_progress_module');
      const lintIdx = result.dot.indexOf('verify_lint_module');
      assert.ok(cpIdx > -1 && lintIdx > -1, 'both check_progress and verify_lint must exist');
      assert.ok(cpIdx < lintIdx, 'check_progress must precede verify_lint');
      assert.ok(result.patternsApplied.includes('P13'), 'patternsApplied must include P13');
    });
  });

  describe('Pattern 14: Typecheck Gate', () => {
    test('14: Given the verify chain, When generated, Then it includes a verify_types node after verify_lint', () => {
      const result = new DotBuilder({
        slug: 'typecheck-test',
        goal: 'Test typecheck gate',
        phases: [phase('module')],
        acceptanceCriteria: {},
      }).build();

      assert.match(result.dot, /verify_types/, 'must have verify_types node');

      const lintIdx = result.dot.indexOf('verify_lint_module');
      const typesIdx = result.dot.indexOf('verify_types_module');
      assert.ok(lintIdx > -1 && typesIdx > -1, 'both verify_lint and verify_types must exist');
      assert.ok(lintIdx < typesIdx, 'verify_lint must precede verify_types');
      assert.ok(result.patternsApplied.includes('P14'), 'patternsApplied must include P14');
    });
  });

  describe('Pattern 15: Conformance Audit', () => {
    test('15: Given each impl phase, When built, Then it includes a conformance review node with timeout=15m', () => {
      const result = new DotBuilder({
        slug: 'conformance-test',
        goal: 'Test conformance audit',
        phases: [
          phase('auth', { allowedPaths: ['src/auth/'] }),
          phase('data', { allowedPaths: ['src/data/'], dependsOn: ['auth'] }),
        ],
        acceptanceCriteria: {},
      }).build();

      const nodes = parseDotNodes(result.dot);

      // Phase 0 → conformance_auth; Phase 1 → conformance_data
      assert.ok(nodes.has('conformance_auth'), 'should have conformance_auth node for phase 0');
      assert.ok(nodes.has('conformance_data'), 'should have conformance_data node for phase 1');

      for (const id of ['conformance_auth', 'conformance_data']) {
        const attrs = nodes.get(id);
        assert.equal(attrs.get('class'), 'review', `${id} must have class=review`);
        assert.equal(attrs.get('read_only'), 'true', `${id} must be read_only`);
        assert.equal(attrs.get('timeout'), '15m', `${id} must have timeout=15m`);
      }
      assert.ok(result.patternsApplied.includes('P15'), 'patternsApplied must include P15');
    });
  });

  describe('Pattern 21: Disaggregated Verify/Fix Endgame Chain', () => {
    test('21: Given the final pipeline, When generated, Then disaggregated verify/fix chain is emitted', () => {
      const result = new DotBuilder({
        slug: 'endgame-chain-test',
        goal: 'Test disaggregated endgame chain',
        phases: [
          phase('auth', { allowedPaths: ['src/auth/'] }),
          phase('api', { allowedPaths: ['src/api/'], dependsOn: ['auth'] }),
        ],
        acceptanceCriteria: {},
      }).build();

      const nodes = parseDotNodes(result.dot);
      // All endgame nodes present
      for (const id of ['audit', 'verify_typecheck', 'verify_lint', 'verify_tests',
                        'fix_types', 'fix_lint', 'fix_tests', 'regression_check', 'quality_review']) {
        assert.ok(nodes.has(id), `should have ${id} node`);
      }
      // No fix_all without broadPass
      assert.ok(!nodes.has('fix_all'), 'fix_all should NOT exist without broadPass');

      const fixTypes = nodes.get('fix_types');
      assert.equal(fixTypes.get('class'), 'codergen', 'fix_types must be class=codergen');
      assert.equal(fixTypes.get('timeout'), '30m', 'fix_types must have timeout=30m');
      assert.equal(fixTypes.get('permission_mode'), 'auto', 'fix_types must have permission_mode=auto');

      // fix_types allowed_paths = union of all phase paths
      const ap = fixTypes.get('allowed_paths') ?? '';
      assert.ok(ap.includes('src/auth/'), 'fix_types allowed_paths must include auth paths');
      assert.ok(ap.includes('src/api/'), 'fix_types allowed_paths must include api paths');

      const edges = parseDotEdges(result.dot);
      assert.ok(edges.some(e => e.source === 'audit' && e.target === 'verify_typecheck'),
        'must have audit -> verify_typecheck edge');
      assert.ok(edges.some(e => e.source === 'regression_check' && e.target === 'quality_review'),
        'must have regression_check -> quality_review edge');

      assert.ok(result.patternsApplied.includes('P21'), 'patternsApplied must include P21');
    });
  });

  describe('Pattern 22: Permission Scoping', () => {
    test('22: Given codergen nodes, When built, Then they get allowed_paths, permission_mode=auto, and escalate_on', () => {
      const result = new DotBuilder({
        slug: 'permission-test',
        goal: 'Test permission scoping',
        phases: [phase('api', { allowedPaths: ['src/api/**'], escalateOn: ['package.json', '*.lock'] })],
        acceptanceCriteria: {},
      }).build();

      const nodes = parseDotNodes(result.dot);
      assert.ok(nodes.has('impl_api'), 'should have impl_api node');

      const implAttrs = nodes.get('impl_api');
      assert.equal(implAttrs.get('class'), 'codergen', 'impl must have class=codergen');
      assert.ok(implAttrs.has('allowed_paths'), 'impl must have allowed_paths');
      assert.ok(implAttrs.has('escalate_on'), 'impl must have escalate_on');
      assert.equal(implAttrs.get('permission_mode'), 'auto', 'impl must have permission_mode=auto');
      assert.ok(result.patternsApplied.includes('P22'), 'patternsApplied must include P22');
    });
  });

  describe('Pattern 23: Defense Matrix', () => {
    test('23: Given any generated pipeline, When .build() completes, Then it includes a DEFENSE MATRIX comment block', () => {
      const result = new DotBuilder({
        slug: 'defense-test',
        goal: 'Test defense matrix generation',
        phases: [phase('secure')],
        acceptanceCriteria: {},
      }).build();

      assert.match(result.dot, /\/\* DEFENSE MATRIX/, 'must include DEFENSE MATRIX comment block');

      const matrixStart = result.dot.indexOf('/* DEFENSE MATRIX');
      const matrixEnd = result.dot.indexOf('*/', matrixStart);
      const matrix = result.dot.substring(matrixStart, matrixEnd + 2);

      assert.ok(matrix.includes('competitive:'), 'matrix must contain competitive');
      assert.ok(matrix.includes('adversarial:'), 'matrix must contain adversarial');
      assert.ok(matrix.includes('specDriven:'), 'matrix must contain specDriven');
      assert.ok(matrix.includes('guardrails:'), 'matrix must contain guardrails');
      assert.ok(matrix.includes('permissions:'), 'matrix must contain permissions');
      assert.ok(result.patternsApplied.includes('P23'), 'patternsApplied must include P23');
    });

    test('23: defenseMatrix in BuildResult reflects security layers', () => {
      const result = new DotBuilder({
        slug: 'defense-matrix-test',
        goal: 'Test defenseMatrix result field',
        phases: [phase('feature', { redTeam: true })],
        acceptanceCriteria: {},
      }).build();

      assert.equal(typeof result.defenseMatrix, 'object', 'defenseMatrix must be an object');
      assert.equal(typeof result.defenseMatrix.competitive, 'boolean', 'competitive must be boolean');
      assert.equal(typeof result.defenseMatrix.adversarial, 'boolean', 'adversarial must be boolean');
      assert.ok(Array.isArray(result.defenseMatrix.guardrails), 'guardrails must be array');
      assert.ok(Array.isArray(result.defenseMatrix.permissions), 'permissions must be array');
      assert.equal(result.defenseMatrix.adversarial, true, 'redTeam:true must set adversarial=true');
    });
  });

  describe('Pattern 25: Catastrophic Recovery', () => {
    test('25: Given a sequential pipeline with retry loops, When built, Then regression_check has a loop_restart edge back to setup_deps', () => {
      const result = new DotBuilder({
        slug: 'catastrophic-test',
        goal: 'Test catastrophic recovery',
        phases: [phase('critical')],
        acceptanceCriteria: {},
      }).build();

      const edges = parseDotEdges(result.dot);
      const catastrophicEdge = edges.find(
        e => e.source === 'regression_check' && e.target === 'setup_deps',
      );

      assert.ok(catastrophicEdge, 'must have regression_check -> setup_deps edge');
      assert.equal(catastrophicEdge.attrs.get('loop_restart'), 'true',
        'catastrophic edge must have loop_restart=true');
      assert.ok(result.patternsApplied.includes('P25'), 'patternsApplied must include P25');
    });

    test('25: Fan-out pipelines do NOT get the catastrophic recovery edge', () => {
      const result = new DotBuilder({
        slug: 'fanout-no-catastrophic',
        goal: 'Fan-out pipeline without recovery',
        phases: [phase('auth'), phase('api')],
        acceptanceCriteria: {},
      }).build();

      // Fan-out pipelines do not emit the loop_restart edge
      assert.ok(!result.patternsApplied.includes('P25'),
        'fan-out pipeline must NOT include P25');
      // No loop_restart edge in the edges section
      const edges = parseDotEdges(result.dot);
      const hasLoopRestart = edges.some(e => e.attrs.get('loop_restart') === 'true');
      assert.ok(!hasLoopRestart, 'fan-out must not have loop_restart edge');
    });
  });

  describe('Multi-Scenario Validation', () => {
    test('All 18 auto-patterns fire correctly in a multi-phase sequential pipeline', () => {
      const result = new DotBuilder({
        slug: 'complex-project',
        goal: 'Build a complex multi-phase application',
        phases: [
          phase('foundation', { allowedPaths: ['src/foundation/'], specFirst: true, bddScenarios: true }),
          phase('api', { allowedPaths: ['src/api/'], dependsOn: ['foundation'], escalateOn: ['package.json'] }),
        ],
        acceptanceCriteria: {},
      }).build();

      const nodes = parseDotNodes(result.dot);

      // P0a
      assert.ok(nodes.has('setup_deps'), 'P0a: should have setup_deps');
      // P0c
      assert.ok(nodes.has('capture_baseline'), 'P0c: should have capture_baseline');
      // P0d
      assert.match(result.dot, /BASELINE/, 'P0d: verify must reference BASELINE');
      // P0e
      assert.ok(nodes.has('check_progress_foundation'), 'P0e: should have check_progress_foundation');
      // P1
      assert.ok(nodes.has('test_foundation'), 'P1: should have test diamond');
      // P3
      const diamonds = [...result.dot.matchAll(/(\w+)\s*\[.*?shape="diamond"/g)].map(m => m[1]);
      for (const d of diamonds) {
        const outs = result.dot.match(new RegExp(`${d}\\s*->`, 'g')) ?? [];
        assert.ok(outs.length >= 2, `P3: diamond ${d} must have ≥2 outgoing edges`);
      }
      // P6
      assert.match(result.dot, /max_visits="5"/, 'P6: impl nodes must have max_visits=5');
      // P6b
      const reviewNodes = [...result.dot.matchAll(/(\w+)\s*\[.*?class="review"/g)].map(m => m[1]);
      assert.ok(reviewNodes.length > 0, 'P6b: must have review nodes');
      // P10
      assert.ok(nodes.has('scope_check_foundation'), 'P10: should have scope_check_foundation');
      // P13
      assert.match(result.dot, /verify_lint/, 'P13: must have verify_lint');
      // P14
      assert.match(result.dot, /verify_types/, 'P14: must have verify_types');
      // P15
      assert.ok(nodes.has('conformance_foundation'), 'P15: should have conformance_foundation');
      // P16b (opt-in via bddScenarios)
      assert.ok(nodes.has('bdd_scenarios_foundation'), 'P16b: foundation has bddScenarios=true');
      // P21
      assert.ok(nodes.has('audit'), 'P21: should have audit');
      assert.ok(nodes.has('verify_typecheck'), 'P21: should have verify_typecheck');
      assert.ok(nodes.has('verify_tests'), 'P21: should have verify_tests');
      assert.ok(nodes.has('regression_check'), 'P21: should have regression_check');
      // P22
      assert.ok(nodes.has('impl_foundation'), 'P22: should have impl nodes');
      assert.equal(nodes.get('impl_foundation').get('class'), 'codergen', 'P22: impl must be codergen');
      // P23
      assert.match(result.dot, /\/\* DEFENSE MATRIX/, 'P23: must have DEFENSE MATRIX comment');
      // P25
      assert.ok(result.patternsApplied.includes('P25'), 'P25: sequential pipeline must have P25');
    });
  });
});

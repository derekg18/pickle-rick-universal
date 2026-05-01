import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DotBuilder, BuildError } from '../services/dot-builder.js';
import { parseDot, parseAttrs } from './__helpers__/dot-parse.js';
import {
  DEFAULT_FIX_BACKEND_PROMPT,
  DEFAULT_FIX_FRONTEND_PROMPT,
  DEFAULT_REVIEW_BE_PROMPT,
  DEFAULT_REVIEW_FE_PROMPT,
  DEFAULT_REVIEW_INT_PROMPT,
  DEFAULT_ADVERSARY_PROMPT,
  DEFAULT_BUILD_API_CMD,
  DEFAULT_TESTS_API_CMD,
  DEFAULT_BUILD_UI_CMD,
  DEFAULT_LINT_CMD,
  DEFAULT_FP_VERIFY_CMD,
  DEFAULT_REPRO_VERIFY_CMD,
  DEFAULT_FIX_BACKEND_MODEL,
  DEFAULT_FIX_FRONTEND_MODEL,
  DEFAULT_REVIEW_BE_MODEL,
  DEFAULT_REVIEW_FE_MODEL,
  DEFAULT_REVIEW_INT_MODEL,
  DEFAULT_ADVERSARY_MODEL,
  DEFAULT_ADVERSARY_SEALED_FROM_SOURCE,
  DEFAULT_CONVERGENCE_EPSILON,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_CONVERGE_MAX_VISITS,
  DEFAULT_CONVERGE_TIMEOUT,
  DEFAULT_FIX_BACKEND_HARNESS,
} from '../services/convergence-defaults.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Thin Map-returning wrappers over the shared parseDot helper. This file's
// call sites use .get()/.set() and {source,target} edge shapes; centralize
// the state-machine parser in __helpers__/dot-parse.js instead of carrying
// a second copy here.
function parseAttrList(body) {
    return new Map(Object.entries(parseAttrs(body)));
}

function parseDotNodes(dot) {
    const out = new Map();
    for (const [id, attrs] of parseDot(dot).nodes) {
        out.set(id, new Map(Object.entries(attrs)));
    }
    return out;
}

function parseDotEdges(dot) {
    return parseDot(dot).edges.map(e => ({
        source: e.from,
        target: e.to,
        attrs: new Map(Object.entries(e.attrs)),
    }));
}

/** Minimal valid spec. */
function baseSpec(overrides = {}) {
    return { slug: 'snapshot-test', goal: 'Auto-pattern snapshot', phases: [], acceptanceCriteria: {}, ...overrides };
}

/** Minimal valid phase. */
function phase(name, overrides = {}) {
    return { name, prompt: `implement ${name}`, allowedPaths: ['src/'], timeout: '10m', ...overrides };
}

// ---------------------------------------------------------------------------
// Auto-pattern snapshot tests — 18 auto-applied patterns
//
// One test per pattern. Each builds a pipeline whose spec meets the pattern's
// preconditions, calls .build(), and asserts pattern-specific DOT attributes.
// ---------------------------------------------------------------------------

describe('Auto-pattern snapshot tests (18 auto-applied patterns)', () => {

    // P0a: Dependency Setup ---------------------------------------------------
    test('P0a — setup_deps node with shape=cds and npm/pnpm/yarn fallback', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [phase('core')],
        })).build();

        const nodes = parseDotNodes(dot);
        assert.ok(nodes.has('setup_deps'), 'setup_deps node must exist');
        assert.equal(nodes.get('setup_deps').get('shape'), 'parallelogram');
        const cmd = nodes.get('setup_deps').get('tool_command') ?? '';
        assert.ok(cmd.includes('npm install'), 'must include npm install');
        assert.ok(cmd.includes('pnpm install'), 'must include pnpm install');
        assert.ok(cmd.includes('yarn install'), 'must include yarn install');
        assert.ok(patternsApplied.includes('P0a'));
    });

    // P0b: Parallel Limit -----------------------------------------------------
    test('P0b — split_phases gets max_parallel=1 when fan-out active', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [phase('auth'), phase('api')],
        })).build();

        const nodes = parseDotNodes(dot);
        assert.ok(nodes.has('split_phases'), 'split_phases must exist');
        assert.equal(nodes.get('split_phases').get('max_parallel'), '1');
        assert.ok(patternsApplied.includes('P0b'));
    });

    // P0c: Baseline Snapshot --------------------------------------------------
    test('P0c — capture_baseline node with read_only, tsc and eslint counting', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [phase('core')],
        })).build();

        const nodes = parseDotNodes(dot);
        assert.ok(nodes.has('capture_baseline'), 'capture_baseline must exist');
        const cb = nodes.get('capture_baseline');
        assert.equal(cb.get('read_only'), 'true');
        const cmd = cb.get('tool_command') ?? '';
        assert.ok(cmd.includes('npx tsc --noEmit'), 'must count tsc errors');
        assert.ok(cmd.includes('npx eslint'), 'must count eslint errors');
        assert.ok(cmd.includes('grep -c'), 'must use grep -c for counting');
        assert.ok(patternsApplied.includes('P0c'));
    });

    // P0d: Delta-Aware Verify -------------------------------------------------
    test('P0d — verify nodes compare CURRENT against BASELINE', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [phase('feature')],
        })).build();

        assert.match(dot, /verify_lint/, 'must have verify_lint');
        assert.match(dot, /verify_types/, 'must have verify_types');
        assert.match(dot, /BASELINE/, 'must reference BASELINE');
        assert.match(dot, /CURRENT/, 'must reference CURRENT');
        assert.ok(patternsApplied.includes('P0d'));
    });

    // P0e: Progress Gate ------------------------------------------------------
    test('P0e — check_progress with read_only, max_visits=3, git status', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [phase('backend')],
        })).build();

        const nodes = parseDotNodes(dot);
        assert.ok(nodes.has('check_progress_backend'), 'check_progress_backend must exist');
        const cp = nodes.get('check_progress_backend');
        assert.equal(cp.get('read_only'), 'true');
        assert.equal(cp.get('max_visits'), '3');
        assert.ok((cp.get('tool_command') ?? '').includes('git status --porcelain'));
        assert.ok(patternsApplied.includes('P0e'));
    });

    // P1: Test-Fix Loops ------------------------------------------------------
    test('P1 — diamond test gate with fix loop back to impl', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [phase('service')],
        })).build();

        const nodes = parseDotNodes(dot);
        assert.ok(nodes.has('test_service'), 'test_service must exist');
        assert.equal(nodes.get('test_service').get('shape'), 'diamond');
        assert.ok(nodes.has('fix_service'), 'fix_service must exist');

        const edges = parseDotEdges(dot);
        assert.ok(edges.some(e => e.source === 'test_service' && e.target === 'fix_service'), 'test fail → fix');
        assert.ok(edges.some(e => e.source === 'fix_service' && e.target === 'impl_service'), 'fix → impl loop');
        assert.ok(patternsApplied.includes('P1'));
    });

    // P3: Conditional Routing -------------------------------------------------
    test('P3 — every diamond node has ≥2 outgoing edges', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [phase('feature')],
        })).build();

        const diamonds = [...dot.matchAll(/(\w+)\s*\[.*?shape="diamond"/g)].map(m => m[1]);
        assert.ok(diamonds.length > 0, 'must have at least one diamond');
        const edges = parseDotEdges(dot);
        for (const d of diamonds) {
            const outs = edges.filter(e => e.source === d);
            assert.ok(outs.length >= 2, `diamond ${d} must have ≥2 outgoing edges, got ${outs.length}`);
        }
        assert.ok(patternsApplied.includes('P3'));
    });

    // P4: Fan-Out/Fan-In (2 independent phases, no dependsOn) -----------------
    test('P4 — 2 independent phases emit split[component] → branches → merge[tripleoctagon]', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [phase('auth'), phase('api')],
        })).build();

        const nodes = parseDotNodes(dot);
        assert.ok(nodes.has('split_phases'), 'split_phases must exist');
        assert.ok(nodes.has('merge_phases'), 'merge_phases must exist');
        assert.equal(nodes.get('split_phases').get('shape'), 'component');
        assert.equal(nodes.get('merge_phases').get('shape'), 'tripleoctagon');

        const edges = parseDotEdges(dot);
        const fromSplit = edges.filter(e => e.source === 'split_phases');
        assert.ok(fromSplit.length >= 2, 'split must fan out to ≥2 branches');
        const toMerge = edges.filter(e => e.target === 'merge_phases');
        assert.ok(toMerge.length >= 2, '≥2 branches must converge to merge');
        assert.ok(patternsApplied.includes('P4'));
    });

    // P6: Max Visits Guard ----------------------------------------------------
    test('P6 — impl nodes get max_visits=5, check_progress keeps max_visits=3', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [phase('feature')],
        })).build();

        const nodes = parseDotNodes(dot);
        assert.equal(nodes.get('impl_feature')?.get('max_visits'), '5', 'impl must have max_visits=5');
        assert.equal(nodes.get('check_progress_feature')?.get('max_visits'), '3', 'check_progress must keep max_visits=3');
        assert.ok(patternsApplied.includes('P6'));
    });

    // P6b: Read-Only + STATUS -------------------------------------------------
    test('P6b — review-class nodes have read_only=true and STATUS markers', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [phase('code')],
        })).build();

        const reviewNodes = [...dot.matchAll(/(\w+)\s*\[.*?class="review"/g)].map(m => m[1]);
        assert.ok(reviewNodes.length > 0, 'must have review-class nodes');
        const nodes = parseDotNodes(dot);
        for (const id of reviewNodes) {
            assert.equal(nodes.get(id)?.get('read_only'), 'true', `${id} must be read_only`);
        }
        assert.match(dot, /STATUS:/, 'review prompts must include STATUS markers');
        assert.ok(patternsApplied.includes('P6b'));
    });

    // P10: Scope Creep Check --------------------------------------------------
    test('P10 — scope_check review node with read_only, shape=cds, git diff + allowed_paths', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [phase('api')],
        })).build();

        const nodes = parseDotNodes(dot);
        assert.ok(nodes.has('scope_check_api'), 'scope_check_api must exist');
        const sc = nodes.get('scope_check_api');
        assert.equal(sc.get('class'), 'review');
        assert.equal(sc.get('read_only'), 'true');
        assert.equal(sc.get('shape'), 'parallelogram');

        const edges = parseDotEdges(dot);
        assert.ok(edges.some(e => e.source === 'impl_api' && e.target === 'scope_check_api'), 'impl → scope_check');
        assert.match(dot, /git diff.*allowed_paths|allowed_paths.*git diff/, 'prompt must reference git diff + allowed_paths');
        assert.ok(patternsApplied.includes('P10'));
    });

    // P13: Lint Gate ----------------------------------------------------------
    test('P13 — verify_lint node in verify chain after check_progress', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [phase('module')],
        })).build();

        const nodes = parseDotNodes(dot);
        assert.ok(nodes.has('verify_lint_module'), 'verify_lint_module must exist');
        assert.ok(dot.indexOf('check_progress_module') < dot.indexOf('verify_lint_module'), 'check_progress before verify_lint');
        assert.ok(patternsApplied.includes('P13'));
    });

    // P14: Type-Check Gate ----------------------------------------------------
    test('P14 — verify_types node in verify chain after verify_lint', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [phase('module')],
        })).build();

        const nodes = parseDotNodes(dot);
        assert.ok(nodes.has('verify_types_module'), 'verify_types_module must exist');
        assert.ok(dot.indexOf('verify_lint_module') < dot.indexOf('verify_types_module'), 'verify_lint before verify_types');
        assert.ok(patternsApplied.includes('P14'));
    });

    // P15: Conformance Audit --------------------------------------------------
    test('P15 — conformance review node with read_only, timeout=15m, after scope_check', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [phase('feature')],
        })).build();

        const nodes = parseDotNodes(dot);
        assert.ok(nodes.has('conformance_feature'), 'conformance_feature must exist');
        const conf = nodes.get('conformance_feature');
        assert.equal(conf.get('class'), 'review');
        assert.equal(conf.get('read_only'), 'true');
        assert.equal(conf.get('timeout'), '15m');
        assert.ok(dot.indexOf('scope_check_feature') < dot.indexOf('conformance_feature'), 'scope_check before conformance');
        assert.ok(patternsApplied.includes('P15'));
    });

    // P21: Disaggregated verify/fix endgame chain ------------------------------
    test('P21 — disaggregated verify/fix chain with audit, verify_typecheck/lint/tests, fix_types/lint/tests, regression_check, quality_review', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [
                phase('auth', { allowedPaths: ['src/auth/'] }),
                phase('api', { allowedPaths: ['src/api/'], dependsOn: ['auth'] }),
            ],
        })).build();

        const nodes = parseDotNodes(dot);
        // All endgame nodes must exist
        for (const id of ['audit', 'verify_typecheck', 'verify_lint', 'verify_tests',
                          'fix_types', 'fix_lint', 'fix_tests', 'regression_check', 'quality_review']) {
            assert.ok(nodes.has(id), `${id} must exist`);
        }
        // fix_types has union of allowed_paths
        const ft = nodes.get('fix_types');
        assert.equal(ft.get('class'), 'codergen');
        assert.equal(ft.get('timeout'), '30m');
        assert.equal(ft.get('permission_mode'), 'auto');
        const ap = ft.get('allowed_paths') ?? '';
        assert.ok(ap.includes('src/auth/'), 'must include auth paths');
        assert.ok(ap.includes('src/api/'), 'must include api paths');

        // verify nodes have correct shapes and retry targets
        assert.equal(nodes.get('verify_typecheck').get('shape'), 'parallelogram');
        assert.equal(nodes.get('verify_typecheck').get('retry_target'), 'fix_types');
        assert.equal(nodes.get('verify_lint').get('shape'), 'parallelogram');
        assert.equal(nodes.get('verify_lint').get('retry_target'), 'fix_lint');
        assert.equal(nodes.get('verify_tests').get('shape'), 'parallelogram');
        assert.equal(nodes.get('verify_tests').get('retry_target'), 'fix_tests');

        // No fix_all without broadPass
        assert.ok(!nodes.has('fix_all'), 'fix_all should NOT exist without broadPass');

        const edges = parseDotEdges(dot);
        // Chain: audit -> verify_typecheck -> verify_lint -> verify_tests -> regression_check -> quality_review
        assert.ok(edges.some(e => e.source === 'audit' && e.target === 'verify_typecheck'), 'audit -> verify_typecheck');
        assert.ok(edges.some(e => e.source === 'regression_check' && e.target === 'quality_review'), 'regression_check -> quality_review');
        assert.ok(patternsApplied.includes('P21'));
    });

    // P22: Permission Scoping -------------------------------------------------
    test('P22 — codergen impl nodes get allowed_paths, escalate_on, permission_mode=auto', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [phase('feature', { allowedPaths: ['src/', 'lib/'], escalateOn: ['package.json', '*.lock'] })],
        })).build();

        const nodes = parseDotNodes(dot);
        const impl = nodes.get('impl_feature');
        assert.ok(impl, 'impl_feature must exist');
        assert.equal(impl.get('class'), 'codergen');
        assert.equal(impl.get('permission_mode'), 'auto');
        assert.ok(impl.has('allowed_paths'), 'must have allowed_paths');
        assert.ok(impl.has('escalate_on'), 'must have escalate_on');
        assert.ok(patternsApplied.includes('P22'));
    });

    // P23: Defense Matrix -----------------------------------------------------
    test('P23 — DEFENSE MATRIX comment block with all 5 fields + defenseMatrix result', () => {
        const result = new DotBuilder(baseSpec({
            phases: [phase('secure')],
        })).build();

        assert.match(result.dot, /\/\* DEFENSE MATRIX/, 'must have DEFENSE MATRIX comment');
        const block = result.dot.substring(
            result.dot.indexOf('/* DEFENSE MATRIX'),
            result.dot.indexOf('*/', result.dot.indexOf('/* DEFENSE MATRIX')) + 2,
        );
        assert.ok(block.includes('competitive:'), 'must include competitive');
        assert.ok(block.includes('adversarial:'), 'must include adversarial');
        assert.ok(block.includes('specDriven:'), 'must include specDriven');
        assert.ok(block.includes('guardrails:'), 'must include guardrails');
        assert.ok(block.includes('permissions:'), 'must include permissions');

        assert.equal(typeof result.defenseMatrix, 'object');
        assert.equal(typeof result.defenseMatrix.competitive, 'boolean');
        assert.equal(typeof result.defenseMatrix.adversarial, 'boolean');
        assert.ok(Array.isArray(result.defenseMatrix.guardrails));
        assert.ok(Array.isArray(result.defenseMatrix.permissions));
        assert.ok(result.patternsApplied.includes('P23'));
    });

    // P25: Catastrophic Recovery ----------------------------------------------
    test('P25 — regression_check → setup_deps loop_restart edge on sequential pipelines', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [phase('critical')],
        })).build();

        const edges = parseDotEdges(dot);
        const recovery = edges.find(e => e.source === 'regression_check' && e.target === 'setup_deps');
        assert.ok(recovery, 'must have regression_check → setup_deps edge');
        assert.equal(recovery.attrs.get('loop_restart'), 'true');
        assert.ok(patternsApplied.includes('P25'));
    });
});

// ---------------------------------------------------------------------------
// Remaining pattern snapshot tests
// ---------------------------------------------------------------------------

describe('Remaining pattern snapshot tests', () => {

    // P0: Workspace isolation + commit_and_push --------------------------------
    test('P0 — workspace=isolated emits graph-level workspace attr and commit_and_push node', () => {
        const builder = new DotBuilder(baseSpec({
            phases: [phase('commit_and_push', { prompt: 'commit and push changes', allowedPaths: ['src/'] })],
        }));
        builder.workspace({ repoUrl: 'https://github.com/test/repo.git', cleanup: 'delete' });
        const { dot, patternsApplied } = builder.build();

        assert.match(dot, /workspace="isolated"/, 'graph must have workspace=isolated');
        assert.ok(patternsApplied.includes('P0'), 'P0 must be applied');

        const nodes = parseDotNodes(dot);
        const impl = nodes.get('impl_commit_and_push');
        assert.ok(impl, 'impl_commit_and_push must exist');
        assert.equal(impl.get('repo_url'), 'https://github.com/test/repo.git');
        assert.equal(impl.get('cleanup'), 'delete');
    });

    // P2: Goal gates with retry_target + max_visits ----------------------------
    test('P2 — goalGate phase emits conformance with goal_gate=true and max_visits from defaultMaxRetry', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [phase('gate', { goalGate: true, retryTarget: 'impl_gate', allowedPaths: ['src/'] })],
            defaultMaxRetry: 3,
        })).build();

        assert.ok(patternsApplied.includes('P2'), 'P2 must be applied');

        const nodes = parseDotNodes(dot);
        const conf = nodes.get('conformance_gate');
        assert.ok(conf, 'conformance_gate node must exist');
        assert.equal(conf.get('goal_gate'), 'true');
        assert.equal(conf.get('max_visits'), '3');

        const testNode = nodes.get('test_gate');
        assert.ok(testNode, 'test_gate must exist');
        assert.equal(testNode.get('retry_target'), 'impl_gate');
        assert.equal(testNode.get('max_visits'), '3');
    });

    // P8: Security scan after check_progress -----------------------------------
    test('P8 — securityScan phase emits review node with read_only after check_progress', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [
                phase('impl', { allowedPaths: ['src/'] }),
                { name: 'sec_scan', prompt: 'Run security audit. STATUS: report findings.', allowedPaths: ['src/'], securityScan: true },
            ],
        })).build();

        assert.ok(patternsApplied.includes('P8'), 'P8 must be applied');

        const nodes = parseDotNodes(dot);
        assert.ok(nodes.has('sec_scan'), 'sec_scan node must exist');
        assert.equal(nodes.get('sec_scan').get('class'), 'review');
        assert.equal(nodes.get('sec_scan').get('read_only'), 'true');
    });

    // P9: Coverage gate after test success -------------------------------------
    test('P9 — coverageTarget emits test_run → coverage_gate diamond between verify_types and conformance', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [phase('tested', { coverageTarget: 80, allowedPaths: ['src/'] })],
        })).build();

        assert.ok(patternsApplied.includes('P9'), 'P9 must be applied');

        const nodes = parseDotNodes(dot);
        assert.ok(nodes.has('test_run_tested'), 'test_run_tested must exist');
        assert.ok(nodes.has('coverage_gate_tested'), 'coverage_gate_tested must exist');
        assert.equal(nodes.get('coverage_gate_tested').get('shape'), 'diamond');
        assert.equal(nodes.get('coverage_gate_tested').get('coverage_target'), '80');

        const edges = parseDotEdges(dot);
        assert.ok(edges.some(e => e.source === 'verify_types_tested' && e.target === 'test_run_tested'), 'verify_types → test_run');
        assert.ok(edges.some(e => e.source === 'test_run_tested' && e.target === 'coverage_gate_tested'), 'test_run → coverage_gate');
        assert.ok(edges.some(e => e.source === 'coverage_gate_tested' && e.target === 'conformance_tested'), 'coverage_gate → conformance');
    });

    // P16: Spec-first default-on with goalGate + opt-out via specFirst:false ----
    test('P16 — goalGate phase gets spec_file by default; specFirst:false suppresses it', () => {
        // goalGate without specFirst:false → spec_file emitted
        const withSpec = new DotBuilder(baseSpec({
            phases: [phase('gated', { goalGate: true, retryTarget: 'impl_gated', allowedPaths: ['src/'] })],
            defaultMaxRetry: 3,
        })).build();

        assert.ok(withSpec.patternsApplied.includes('P16'), 'P16 must be applied when goalGate default-on');
        const nodesWith = parseDotNodes(withSpec.dot);
        assert.ok(nodesWith.has('spec_file_gated'), 'spec_file_gated must exist for goalGate without opt-out');

        const edgesWith = parseDotEdges(withSpec.dot);
        assert.ok(edgesWith.some(e => e.source === 'spec_file_gated' && e.target === 'impl_gated'), 'spec_file → impl');

        // goalGate with specFirst:false → spec_file suppressed
        const withoutSpec = new DotBuilder(baseSpec({
            phases: [phase('gated', { goalGate: true, retryTarget: 'impl_gated', specFirst: false, allowedPaths: ['src/'] })],
            defaultMaxRetry: 3,
        })).build();

        assert.ok(!withoutSpec.patternsApplied.includes('P16'), 'P16 must NOT be applied when specFirst:false');
        const nodesWithout = parseDotNodes(withoutSpec.dot);
        assert.ok(!nodesWithout.has('spec_file_gated'), 'spec_file_gated must NOT exist when specFirst:false');
    });

    // P16b: BDD scenarios opt-in only when bddScenarios:true -------------------
    test('P16b — bddScenarios:true emits bdd_scenarios node before spec_file; absent by default', () => {
        // With bddScenarios:true on a goalGate phase (spec_file also emitted)
        const withBDD = new DotBuilder(baseSpec({
            phases: [phase('gated', { goalGate: true, retryTarget: 'impl_gated', bddScenarios: true, allowedPaths: ['src/'] })],
            defaultMaxRetry: 3,
        })).build();

        assert.ok(withBDD.patternsApplied.includes('P16b'), 'P16b must be applied');
        const nodesBDD = parseDotNodes(withBDD.dot);
        assert.ok(nodesBDD.has('bdd_scenarios_gated'), 'bdd_scenarios_gated must exist');
        assert.ok(nodesBDD.has('spec_file_gated'), 'spec_file_gated must also exist');

        const edgesBDD = parseDotEdges(withBDD.dot);
        assert.ok(edgesBDD.some(e => e.source === 'bdd_scenarios_gated' && e.target === 'spec_file_gated'), 'bdd_scenarios → spec_file');
        assert.ok(edgesBDD.some(e => e.source === 'spec_file_gated' && e.target === 'impl_gated'), 'spec_file → impl');

        // Without bddScenarios → no bdd_scenarios node
        const withoutBDD = new DotBuilder(baseSpec({
            phases: [phase('gated', { goalGate: true, retryTarget: 'impl_gated', allowedPaths: ['src/'] })],
            defaultMaxRetry: 3,
        })).build();

        assert.ok(!withoutBDD.patternsApplied.includes('P16b'), 'P16b must NOT be applied without bddScenarios');
        const nodesNoBDD = parseDotNodes(withoutBDD.dot);
        assert.ok(!nodesNoBDD.has('bdd_scenarios_gated'), 'bdd_scenarios_gated must NOT exist without opt-in');
    });

    // P17: Red team after conformance ------------------------------------------
    test('P17 — redTeam:true emits red_team node after test pass edge', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [phase('hardened', { redTeam: true, allowedPaths: ['src/'] })],
        })).build();

        assert.ok(patternsApplied.includes('P17'), 'P17 must be applied');

        const nodes = parseDotNodes(dot);
        assert.ok(nodes.has('red_team_hardened'), 'red_team_hardened must exist');
        assert.equal(nodes.get('red_team_hardened').get('read_only'), 'true');

        const edges = parseDotEdges(dot);
        assert.ok(edges.some(e => e.source === 'test_hardened' && e.target === 'red_team_hardened' && e.attrs.get('label') === 'pass'),
            'test → red_team on pass edge');
    });

    // P18: Competing implementations — component + tripleoctagon ---------------
    test('P18 — competing:true emits A/B component branches and tripleoctagon merge', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [phase('solver', { competing: true, allowedPaths: ['src/'] })],
        })).build();

        assert.ok(patternsApplied.includes('P18'), 'P18 must be applied');

        const nodes = parseDotNodes(dot);
        assert.ok(nodes.has('solver_a'), 'solver_a must exist');
        assert.ok(nodes.has('solver_b'), 'solver_b must exist');
        assert.ok(nodes.has('competing_merge'), 'competing_merge must exist');
        assert.equal(nodes.get('solver_a').get('shape'), 'component');
        assert.equal(nodes.get('solver_b').get('shape'), 'component');
        assert.equal(nodes.get('competing_merge').get('shape'), 'tripleoctagon');

        const edges = parseDotEdges(dot);
        assert.ok(edges.some(e => e.source === 'capture_baseline' && e.target === 'solver_a'), 'baseline → A');
        assert.ok(edges.some(e => e.source === 'capture_baseline' && e.target === 'solver_b'), 'baseline → B');
        assert.ok(edges.some(e => e.source === 'solver_a' && e.target === 'competing_merge'), 'A → merge');
        assert.ok(edges.some(e => e.source === 'solver_b' && e.target === 'competing_merge'), 'B → merge');
        assert.ok(edges.some(e => e.source === 'competing_merge' && e.target === 'exit'), 'merge → exit');
    });

    // P19: Review ratchet N-pass topology --------------------------------------
    test('P19 — reviewRatchet emits N review_pass components chained to tripleoctagon merge with fix loop', () => {
        const builder = new DotBuilder(baseSpec({
            phases: [phase('reviewed')],
        }));
        builder.reviewRatchet(3);
        const { dot, patternsApplied } = builder.build();

        assert.ok(patternsApplied.includes('P19'), 'P19 must be applied');

        const nodes = parseDotNodes(dot);
        assert.ok(nodes.has('review_pass_1'), 'review_pass_1 must exist');
        assert.ok(nodes.has('review_pass_2'), 'review_pass_2 must exist');
        assert.ok(nodes.has('review_pass_3'), 'review_pass_3 must exist');
        assert.ok(nodes.has('review_merge'), 'review_merge must exist');
        assert.ok(nodes.has('fix_review'), 'fix_review must exist');

        for (let i = 1; i <= 3; i++) {
            assert.equal(nodes.get(`review_pass_${i}`).get('shape'), 'component', `review_pass_${i} shape=component`);
        }
        assert.equal(nodes.get('review_merge').get('shape'), 'tripleoctagon');
        assert.equal(nodes.get('review_merge').get('ratchet_count'), '3');

        const edges = parseDotEdges(dot);
        assert.ok(edges.some(e => e.source === 'review_pass_1' && e.target === 'review_pass_2'), 'pass_1 → pass_2');
        assert.ok(edges.some(e => e.source === 'review_pass_2' && e.target === 'review_pass_3'), 'pass_2 → pass_3');
        assert.ok(edges.some(e => e.source === 'review_pass_3' && e.target === 'review_merge'), 'pass_3 → merge');
        assert.ok(edges.some(e => e.source === 'review_merge' && e.target === 'exit' && e.attrs.get('label') === 'pass'), 'merge → exit on pass');
        assert.ok(edges.some(e => e.source === 'review_merge' && e.target === 'fix_review' && e.attrs.get('label') === 'fail'), 'merge → fix on fail');
        assert.ok(edges.some(e => e.source === 'fix_review' && e.target === 'review_pass_1'), 'fix → pass_1 loop');
    });

    // P20: Microverse optimize-measure-compare-check loop ----------------------
    test('P20 — microverse emits optimize→measure→compare→check loop with direction and target', () => {
        const builder = new DotBuilder(baseSpec({
            phases: [phase('perf')],
        }));
        builder.microverse('latency', {
            prompt: 'reduce p99 latency',
            measureCommand: 'npm run bench',
            target: 50,
            direction: 'reduce',
            allowedPaths: ['src/'],
            maxVisits: 8,
        });
        const { dot, patternsApplied } = builder.build();

        assert.ok(patternsApplied.includes('P20'), 'P20 must be applied');

        const nodes = parseDotNodes(dot);
        assert.ok(nodes.has('commit_baseline'), 'commit_baseline must exist');
        assert.ok(nodes.has('baseline'), 'baseline must exist');
        assert.ok(nodes.has('optimize'), 'optimize must exist');
        assert.ok(nodes.has('measure'), 'measure must exist');
        assert.ok(nodes.has('compare'), 'compare must exist');
        assert.ok(nodes.has('check'), 'check must exist');

        assert.equal(nodes.get('compare').get('shape'), 'diamond');
        assert.equal(nodes.get('compare').get('direction'), 'reduce');
        assert.equal(nodes.get('compare').get('target'), '50');
        assert.equal(nodes.get('compare').get('max_visits'), '8');
        assert.equal(nodes.get('check').get('shape'), 'diamond');

        const edges = parseDotEdges(dot);
        assert.ok(edges.some(e => e.source === 'commit_baseline' && e.target === 'baseline'), 'commit_baseline → baseline');
        assert.ok(edges.some(e => e.source === 'baseline' && e.target === 'optimize'), 'baseline → optimize');
        assert.ok(edges.some(e => e.source === 'optimize' && e.target === 'measure'), 'optimize → measure');
        assert.ok(edges.some(e => e.source === 'measure' && e.target === 'compare'), 'measure → compare');
        assert.ok(edges.some(e => e.source === 'compare' && e.target === 'optimize' && e.attrs.get('label') === 'miss'), 'compare → optimize on miss');
        assert.ok(edges.some(e => e.source === 'compare' && e.target === 'check' && e.attrs.get('label') === 'hit'), 'compare → check on hit');
        assert.ok(edges.some(e => e.source === 'check' && e.target === 'exit' && e.attrs.get('label') === 'accept'), 'check → exit on accept');
        assert.ok(edges.some(e => e.source === 'check' && e.target === 'optimize' && e.attrs.get('label') === 'reject'), 'check → optimize on reject');
    });

    // specFirst:true on non-goal-gated phase -----------------------------------
    test('specFirst:true on non-goal-gated phase enables spec_file', () => {
        const { dot, patternsApplied } = new DotBuilder(baseSpec({
            phases: [phase('plain', { specFirst: true, allowedPaths: ['src/'] })],
        })).build();

        assert.ok(patternsApplied.includes('P16'), 'P16 must be applied for explicit specFirst:true');

        const nodes = parseDotNodes(dot);
        assert.ok(nodes.has('spec_file_plain'), 'spec_file_plain must exist');

        const edges = parseDotEdges(dot);
        assert.ok(edges.some(e => e.source === 'spec_file_plain' && e.target === 'impl_plain'), 'spec_file → impl_plain');
    });

    // .modelStylesheet() generates valid stylesheet output ---------------------
    test('.modelStylesheet() generates valid stylesheet in selector { property: value; } format', () => {
        const builder = new DotBuilder(baseSpec({
            phases: [phase('styled')],
        }));
        builder.modelStylesheet({
            defaultModel: 'claude-sonnet-4-5-20250514',
            defaultEffort: 'high',
            overrides: [
                { selector: '.critical', model: 'claude-opus-4-5-20250514', effort: 'max' },
                { selector: '.review', model: 'claude-sonnet-4-5-20250514' },
            ],
        });
        const { dot } = builder.build();

        // Extract stylesheet value from graph attrs
        const ssMatch = /model_stylesheet="([^"]*)"/.exec(dot);
        assert.ok(ssMatch, 'must have model_stylesheet graph attribute');
        const ss = ssMatch[1];

        // Validate default selector
        assert.match(ss, /\.default\s*\{[^}]*llm_model:\s*claude-sonnet-4-5-20250514;/, '.default selector must set llm_model');
        assert.match(ss, /\.default\s*\{[^}]*reasoning_effort:\s*high;/, '.default selector must set reasoning_effort');

        // Validate class selectors
        assert.match(ss, /\.critical\s*\{[^}]*llm_model:\s*claude-opus-4-5-20250514;/, '.critical must set llm_model');
        assert.match(ss, /\.critical\s*\{[^}]*reasoning_effort:\s*max;/, '.critical must set reasoning_effort');
        assert.match(ss, /\.review\s*\{[^}]*llm_model:\s*claude-sonnet-4-5-20250514;/, '.review must set llm_model');

        // Validate format: only valid selectors (.default and .className) and valid properties (llm_model, reasoning_effort)
        const selectors = [...ss.matchAll(/([^\s{]+)\s*\{/g)].map(m => m[1]);
        for (const sel of selectors) {
            assert.ok(/^\.[a-zA-Z][a-zA-Z0-9_]*$/.test(sel),
                `selector "${sel}" must be .className`);
        }
        const properties = [...ss.matchAll(/(\w+):/g)].map(m => m[1]);
        const validProps = new Set(['llm_model', 'reasoning_effort']);
        for (const prop of properties) {
            assert.ok(validProps.has(prop), `property "${prop}" must be llm_model or reasoning_effort`);
        }
    });
});

// ---------------------------------------------------------------------------
// Convergence v8 topology ACs — refined PRD §5
//
// One test per AC (or AC family). Every structural assertion consumes the
// shared parseDot helper from tests/__helpers__/dot-parse.js. Prompt and
// command bytes reference the DEFAULT_* constants from convergence-defaults.js
// — no hardcoded prompt text.
// ---------------------------------------------------------------------------

function convSpec(overrides = {}) {
    return {
        slug: 'conv-test',
        goal: 'converge on the spec',
        phases: [],
        acceptanceCriteria: {},
        convergence: {
            until: 'V_total == 0 && fixed_point && reproducibility',
            impl: { harness: 'claude-code', prompt: 'seed implementation prompt' },
            ...(overrides.convergence ?? {}),
        },
        ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== 'convergence')),
    };
}

const V8_BODY_CHAIN = [
    'fix_backend', 'fix_frontend',
    'run_build_api', 'run_tests_api', 'run_build_ui', 'run_lint',
    'review_be', 'review_fe', 'review_int', 'adversary_node',
];

describe('Convergence v8 topology — refined PRD §5 ACs', () => {

    // AC-BUILD-1
    test('AC-BUILD-1 — build() returns { dot, patternsApplied } with P32 applied', () => {
        const result = DotBuilder.fromSpec(convSpec()).build();
        assert.ok(typeof result.dot === 'string' && result.dot.length > 0, 'dot must be non-empty string');
        assert.ok(Array.isArray(result.patternsApplied), 'patternsApplied must be an array');
        assert.ok(result.patternsApplied.includes('P32'), 'P32 must be applied in convergence mode');
    });

    // AC-STRUCT-1..11
    test('AC-STRUCT-1 — 10 body nodes present with matching v8 IDs', () => {
        const { dot } = DotBuilder.fromSpec(convSpec()).build();
        const { nodes } = parseDot(dot);
        for (const id of V8_BODY_CHAIN) {
            assert.ok(nodes.has(id), `body node "${id}" must be present`);
        }
        assert.equal(V8_BODY_CHAIN.length, 10, 'v8 body must define exactly 10 nodes');
    });

    test('AC-STRUCT-2 — 9 body edges with outcome=success', () => {
        const { dot } = DotBuilder.fromSpec(convSpec()).build();
        const { edges } = parseDot(dot);
        let count = 0;
        for (let i = 0; i < V8_BODY_CHAIN.length - 1; i++) {
            const e = edges.find(e => e.from === V8_BODY_CHAIN[i] && e.to === V8_BODY_CHAIN[i + 1]);
            assert.ok(e, `body edge ${V8_BODY_CHAIN[i]} -> ${V8_BODY_CHAIN[i + 1]} must exist`);
            assert.equal(e.attrs.condition, 'outcome=success', `body edge ${i} must have condition=outcome=success`);
            count++;
        }
        assert.equal(count, 9, 'body chain must have exactly 9 success-conditioned edges');
    });

    test('AC-STRUCT-3 — body chain order preserved', () => {
        const { dot } = DotBuilder.fromSpec(convSpec()).build();
        let prev = -1;
        for (const id of V8_BODY_CHAIN) {
            const idx = dot.search(new RegExp(`^    ${id} \\[`, 'm'));
            assert.ok(idx > prev, `node ${id} must appear after previous body node`);
            prev = idx;
        }
    });

    test('AC-STRUCT-4 — converge node has v8 attrs', () => {
        const { dot } = DotBuilder.fromSpec(convSpec()).build();
        const { nodes } = parseDot(dot);
        const c = nodes.get('converge');
        assert.ok(c, 'converge node must exist');
        assert.equal(c.class, 'iterate');
        assert.equal(c.shape, 'house');
        assert.equal(c.retry_target, 'converge');
        assert.equal(c.body, 'iter-body');
    });

    test('AC-STRUCT-5 — fp_verify/repro_verify/done are OUTSIDE cluster_iter_body', () => {
        const { dot } = DotBuilder.fromSpec(convSpec()).build();
        const lines = dot.split('\n');
        const openIdx = lines.findIndex(l => /^\s*subgraph cluster_iter_body/.test(l));
        assert.ok(openIdx >= 0, 'cluster_iter_body subgraph must exist');
        let depth = 0;
        let closeIdx = -1;
        for (let i = openIdx; i < lines.length; i++) {
            if (lines[i].includes('{')) depth++;
            if (lines[i].includes('}')) {
                depth--;
                if (depth === 0) { closeIdx = i; break; }
            }
        }
        assert.ok(closeIdx > openIdx, 'cluster_iter_body must close');
        const after = lines.slice(closeIdx + 1).join('\n');
        assert.match(after, /^\s*fp_verify \[/m, 'fp_verify must be outside cluster_iter_body');
        assert.match(after, /^\s*repro_verify \[/m, 'repro_verify must be outside cluster_iter_body');
        assert.match(after, /^\s*done \[/m, 'done must be outside cluster_iter_body');
    });

    test('AC-STRUCT-6 — post-chain edges with correct conditions', () => {
        const { dot } = DotBuilder.fromSpec(convSpec()).build();
        const { edges } = parseDot(dot);
        const advToFp = edges.find(e => e.from === 'adversary_node' && e.to === 'fp_verify');
        assert.ok(advToFp, 'adversary_node -> fp_verify must exist');
        const fpToRp = edges.find(e => e.from === 'fp_verify' && e.to === 'repro_verify' && e.attrs.condition === 'outcome=success');
        assert.ok(fpToRp, 'fp_verify -> repro_verify [success] must exist');
        const rpToDone = edges.find(e => e.from === 'repro_verify' && e.to === 'done' && e.attrs.condition === 'outcome=success');
        assert.ok(rpToDone, 'repro_verify -> done [success] must exist');
        const fpToConv = edges.find(e => e.from === 'fp_verify' && e.to === 'converge' && e.attrs.condition === 'outcome=fail');
        assert.ok(fpToConv, 'fp_verify -> converge [fail] must exist');
        const rpToFp = edges.find(e => e.from === 'repro_verify' && e.to === 'fp_verify' && e.attrs.condition === 'outcome=fail');
        assert.ok(rpToFp, 'repro_verify -> fp_verify [fail] must exist');
    });

    test('AC-STRUCT-7 — single Msquare terminal = done', () => {
        const { dot } = DotBuilder.fromSpec(convSpec()).build();
        const { nodes } = parseDot(dot);
        const msquares = [...nodes.entries()].filter(([, a]) => a.shape === 'Msquare');
        assert.equal(msquares.length, 1, 'exactly one Msquare-shaped node must exist');
        assert.equal(msquares[0][0], 'done', 'the Msquare terminal must be "done"');
    });

    test('AC-STRUCT-8 — reachability edges converge -> {fix_backend, fp_verify}', () => {
        const { dot } = DotBuilder.fromSpec(convSpec()).build();
        const { edges } = parseDot(dot);
        const toFb = edges.find(e => e.from === 'converge' && e.to === 'fix_backend');
        assert.ok(toFb, 'converge -> fix_backend must exist');
        assert.equal(toFb.attrs.weight, '1', 'converge -> fix_backend weight=1');
        const toFp = edges.find(e => e.from === 'converge' && e.to === 'fp_verify');
        assert.ok(toFp, 'converge -> fp_verify must exist');
        assert.equal(toFp.attrs.weight, '2', 'converge -> fp_verify weight=2');
    });

    test('AC-STRUCT-9 — no exit node in convergence mode', () => {
        const { dot } = DotBuilder.fromSpec(convSpec()).build();
        const { nodes } = parseDot(dot);
        assert.ok(!nodes.has('exit'), '"exit" node must NOT be emitted in convergence mode');
    });

    test('AC-STRUCT-10 — cluster_iter_body subgraph exists with label="iter-body"', () => {
        const { dot } = DotBuilder.fromSpec(convSpec()).build();
        assert.match(dot, /subgraph cluster_iter_body \{/, 'cluster_iter_body subgraph must open');
        assert.match(dot, /label="iter-body"/, 'subgraph label must be "iter-body"');
    });

    test('AC-STRUCT-11 — capture_baseline -> converge edge exists', () => {
        const { dot } = DotBuilder.fromSpec(convSpec()).build();
        const { edges } = parseDot(dot);
        const e = edges.find(e => e.from === 'capture_baseline' && e.to === 'converge');
        assert.ok(e, 'capture_baseline -> converge edge must exist');
    });

    // AC-MERGE-1..4
    test('AC-MERGE-1 — empty user AC merges to built-in fp_pass+repro_pass', () => {
        const { dot } = DotBuilder.fromSpec(convSpec()).build();
        const { graphAttrs } = parseDot(dot);
        assert.equal(graphAttrs.acceptance_criteria, 'context.fp_pass=true && context.repro_pass=true');
    });

    test('AC-MERGE-2 — unmapped custom AC key in convergence rejected by validator', () => {
        // Convergence mode rejects AC keys that no emitted node maps via
        // context_on_success. Only fp_pass/repro_pass (auto-mapped by the
        // fp_verify/repro_verify gates) are valid built-ins.
        const spec = convSpec({ acceptanceCriteria: { custom_key: 'custom_val' } });
        assert.throws(
            () => DotBuilder.fromSpec(spec).build(),
            err => err instanceof BuildError && err.code === 'MISSING_AC_MAPPING',
        );
    });

    test('AC-MERGE-3 — built-in fp_pass/repro_pass win over user override', () => {
        const spec = convSpec({ acceptanceCriteria: { fp_pass: 'maybe', repro_pass: 'maybe' } });
        const { dot } = DotBuilder.fromSpec(spec).build();
        const { graphAttrs } = parseDot(dot);
        assert.equal(
            graphAttrs.acceptance_criteria,
            'context.fp_pass=true && context.repro_pass=true',
            'built-in true values must override user-provided fp_pass/repro_pass',
        );
    });

    test('AC-MERGE-4 — merged AC keys are sorted lexicographically', () => {
        // The built-ins are emitted in sorted order: `fp_pass` precedes
        // `repro_pass`. Verify the serialized graph attr preserves that order.
        const { dot } = DotBuilder.fromSpec(convSpec()).build();
        const { graphAttrs } = parseDot(dot);
        const ac = graphAttrs.acceptance_criteria;
        const fpIdx = ac.indexOf('fp_pass');
        const rpIdx = ac.indexOf('repro_pass');
        assert.ok(fpIdx >= 0 && rpIdx >= 0, 'both built-ins must be present');
        assert.ok(fpIdx < rpIdx, 'fp_pass must come before repro_pass in sorted order');
    });

    // AC-OVERRIDE-1..8
    test('AC-OVERRIDE-1 — fixBackend.model overrides default', () => {
        const spec = convSpec({
            convergence: { fixBackend: { model: 'custom/backend-1', harness: 'hermes', prompt: 'p' } },
        });
        const { dot } = DotBuilder.fromSpec(spec).build();
        const { nodes } = parseDot(dot);
        assert.equal(nodes.get('fix_backend').model, 'custom/backend-1');
    });

    test('AC-OVERRIDE-2 — fixBackend.harness overrides default', () => {
        const spec = convSpec({
            convergence: { fixBackend: { model: 'm', harness: 'claude-code', prompt: 'p' } },
        });
        const { dot } = DotBuilder.fromSpec(spec).build();
        const { nodes } = parseDot(dot);
        assert.equal(nodes.get('fix_backend').harness, 'claude-code');
    });

    test('AC-OVERRIDE-3 — fixFrontend.prompt overrides DEFAULT_FIX_FRONTEND_PROMPT', () => {
        const custom = 'custom frontend prompt body';
        const spec = convSpec({
            convergence: { fixFrontend: { model: 'm', harness: 'hermes', prompt: custom } },
        });
        const { dot } = DotBuilder.fromSpec(spec).build();
        const { nodes } = parseDot(dot);
        assert.equal(nodes.get('fix_frontend').prompt, custom);
        assert.notEqual(nodes.get('fix_frontend').prompt, DEFAULT_FIX_FRONTEND_PROMPT);
    });

    test('AC-OVERRIDE-4 — mechanicalGates.buildApi overrides DEFAULT_BUILD_API_CMD', () => {
        const custom = 'cd /custom && make api-build';
        const spec = convSpec({ convergence: { mechanicalGates: { buildApi: custom } } });
        const { dot } = DotBuilder.fromSpec(spec).build();
        const { nodes } = parseDot(dot);
        assert.equal(nodes.get('run_build_api').tool_command, custom);
        assert.notEqual(nodes.get('run_build_api').tool_command, DEFAULT_BUILD_API_CMD);
    });

    test('AC-OVERRIDE-5 — reviewers.be.model overrides DEFAULT_REVIEW_BE_MODEL', () => {
        const spec = convSpec({
            convergence: { reviewers: { be: { model: 'custom/reviewer-be', harness: 'hermes', prompt: 'p' } } },
        });
        const { dot } = DotBuilder.fromSpec(spec).build();
        const { nodes } = parseDot(dot);
        assert.equal(nodes.get('review_be').model, 'custom/reviewer-be');
        assert.notEqual(nodes.get('review_be').model, DEFAULT_REVIEW_BE_MODEL);
    });

    test('AC-OVERRIDE-6 — fromSpec round-trip threads every override', () => {
        const raw = {
            slug: 'full',
            goal: 'full round-trip',
            phases: [],
            acceptanceCriteria: {},
            convergence: {
                until: 'V_total == 0 && fixed_point && reproducibility',
                impl: { harness: 'hermes', prompt: 'seed' },
                maxVisits: 12,
                timeout: '99s',
                sealedFromSource: 'secret/**',
                fixBackend: { model: 'rt/be', harness: 'hermes', prompt: 'rt-be-prompt' },
                fixFrontend: { model: 'rt/fe', harness: 'hermes', prompt: 'rt-fe-prompt' },
                mechanicalGates: {
                    buildApi: 'rt build api',
                    testsApi: 'rt tests api',
                    buildUi: 'rt build ui',
                    lint: 'rt lint',
                },
                reviewers: {
                    be: { model: 'rt/rbe', harness: 'hermes', prompt: 'rt-rbe-prompt' },
                    fe: { model: 'rt/rfe', harness: 'hermes', prompt: 'rt-rfe-prompt' },
                    int: { model: 'rt/rint', harness: 'hermes', prompt: 'rt-rint-prompt' },
                },
                adversary: { model: 'rt/adv', harness: 'hermes', prompt: 'rt-adv-prompt' },
                fpVerify: { command: 'rt fp cmd' },
                reproVerify: { command: 'rt repro cmd' },
                convergenceEpsilon: 77,
                maxIterations: 3,
            },
        };
        const { dot } = DotBuilder.fromSpec(raw).build();
        const { nodes } = parseDot(dot);
        const conv = nodes.get('converge');
        assert.equal(conv.max_visits, '12');
        assert.equal(conv.timeout, '99s');
        assert.equal(conv.convergence_epsilon, '77');
        assert.equal(conv.max_iterations, '3');
        assert.equal(nodes.get('fix_backend').model, 'rt/be');
        assert.equal(nodes.get('fix_backend').prompt, 'rt-be-prompt');
        assert.equal(nodes.get('fix_frontend').model, 'rt/fe');
        assert.equal(nodes.get('run_build_api').tool_command, 'rt build api');
        assert.equal(nodes.get('run_tests_api').tool_command, 'rt tests api');
        assert.equal(nodes.get('run_build_ui').tool_command, 'rt build ui');
        assert.equal(nodes.get('run_lint').tool_command, 'rt lint');
        assert.equal(nodes.get('review_be').model, 'rt/rbe');
        assert.equal(nodes.get('review_fe').model, 'rt/rfe');
        assert.equal(nodes.get('review_int').model, 'rt/rint');
        assert.equal(nodes.get('adversary_node').model, 'rt/adv');
        assert.equal(nodes.get('adversary_node').sealed_from_source, 'secret/**');
        assert.equal(nodes.get('fp_verify').tool_command, 'rt fp cmd');
        assert.equal(nodes.get('repro_verify').tool_command, 'rt repro cmd');
    });

    test('AC-OVERRIDE-7 — adversary sealedFromSource precedence chain', () => {
        // adversary.sealedFromSource beats spec.convergence.sealedFromSource
        const spec = convSpec({
            convergence: {
                sealedFromSource: 'convergence-wins/**',
                adversary: { model: 'm', harness: 'hermes', prompt: 'p', sealedFromSource: 'adversary-wins/**' },
            },
        });
        const { dot } = DotBuilder.fromSpec(spec).build();
        const { nodes } = parseDot(dot);
        assert.equal(nodes.get('adversary_node').sealed_from_source, 'adversary-wins/**');
        // Without adversary override, spec.convergence.sealedFromSource wins over DEFAULT
        const spec2 = convSpec({ convergence: { sealedFromSource: 'convergence-wins/**' } });
        const { dot: dot2 } = DotBuilder.fromSpec(spec2).build();
        const { nodes: n2 } = parseDot(dot2);
        assert.equal(n2.get('adversary_node').sealed_from_source, 'convergence-wins/**');
        assert.notEqual(n2.get('adversary_node').sealed_from_source, DEFAULT_ADVERSARY_SEALED_FROM_SOURCE);
    });

    test('AC-OVERRIDE-8 — three distinct models via stylesheet build cleanly', () => {
        const spec = {
            ...convSpec(),
            modelStylesheet: {
                defaultModel: 'sonnet',
                overrides: [
                    { selector: '.impl', model: 'opus' },
                    { selector: '.honest_review', model: 'haiku' },
                    { selector: '.adversary', model: 'sonnet' },
                ],
            },
        };
        assert.doesNotThrow(() => DotBuilder.fromSpec(spec).build());
        // Duplicate any pair — throws DUPLICATE_MODEL
        const dup = {
            ...convSpec(),
            modelStylesheet: {
                defaultModel: 'sonnet',
                overrides: [
                    { selector: '.impl', model: 'opus' },
                    { selector: '.honest_review', model: 'opus' },
                ],
            },
        };
        assert.throws(
            () => DotBuilder.fromSpec(dup).build(),
            err => err instanceof BuildError && err.code === 'DUPLICATE_MODEL',
        );
    });

    test('AC-OVERRIDE-8b — DUPLICATE_MODEL via direct-attr fields (no stylesheet)', () => {
        // Pins the §3.1 precedence rule: direct-attr fields feed the same
        // modelMap the stylesheet-override path does. Here .impl comes from
        // fixBackend.model and .honest_review from reviewers.be.model — both
        // 'shared/dup-model' — and the builder must throw.
        const spec = convSpec({
            convergence: {
                fixBackend: { model: 'shared/dup-model', harness: 'hermes', prompt: 'p' },
                reviewers: { be: { model: 'shared/dup-model', harness: 'hermes', prompt: 'p' } },
            },
        });
        assert.throws(
            () => DotBuilder.fromSpec(spec).build(),
            err => err instanceof BuildError && err.code === 'DUPLICATE_MODEL',
        );
    });

    // AC-GOAL-1..2
    test('AC-GOAL-1 — non-empty goal emitted as graph attr', () => {
        const { dot } = DotBuilder.fromSpec(convSpec()).build();
        const { graphAttrs } = parseDot(dot);
        assert.equal(graphAttrs.goal, 'converge on the spec');
    });

    test('AC-GOAL-2 — empty goal throws BuildError EMPTY_GOAL', () => {
        const spec = { ...convSpec(), goal: '   ' };
        assert.throws(
            () => DotBuilder.fromSpec(spec).build(),
            err => err instanceof BuildError && err.code === 'EMPTY_GOAL' && /goal.*required|goal.*empty/i.test(err.message),
        );
    });

    // AC-SUB-1..4
    test('AC-SUB-1 — default tool_command substitutes ${WORKING_DIR} when workingDir unset', () => {
        const { dot } = DotBuilder.fromSpec(convSpec()).build();
        const { nodes } = parseDot(dot);
        const buildApi = nodes.get('run_build_api');
        assert.ok(buildApi.tool_command.includes('${WORKING_DIR}'), 'default build_api must contain ${WORKING_DIR}');
        assert.ok(!buildApi.tool_command.includes('/repos/benchmark'), '/repos/benchmark must be substituted out');
    });

    test('AC-SUB-2 — prompts are never substituted (byte-equal to DEFAULT_*)', () => {
        const { dot } = DotBuilder.fromSpec(convSpec()).build();
        const { nodes } = parseDot(dot);
        assert.equal(nodes.get('fix_backend').prompt, DEFAULT_FIX_BACKEND_PROMPT);
        assert.equal(nodes.get('fix_frontend').prompt, DEFAULT_FIX_FRONTEND_PROMPT);
        assert.equal(nodes.get('review_be').prompt, DEFAULT_REVIEW_BE_PROMPT);
        assert.equal(nodes.get('review_fe').prompt, DEFAULT_REVIEW_FE_PROMPT);
        assert.equal(nodes.get('review_int').prompt, DEFAULT_REVIEW_INT_PROMPT);
        assert.equal(nodes.get('adversary_node').prompt, DEFAULT_ADVERSARY_PROMPT);
    });

    test('AC-SUB-3 — custom spec.workingDir substitutes into default commands', () => {
        const spec = { ...convSpec(), workingDir: '/custom/wd' };
        const { dot } = DotBuilder.fromSpec(spec).build();
        const { nodes } = parseDot(dot);
        assert.ok(nodes.get('run_tests_api').tool_command.includes('/custom/wd'));
        assert.ok(!nodes.get('run_tests_api').tool_command.includes('/repos/benchmark'));
    });

    test('AC-SUB-4 — /repos/benchmark in custom fpVerify.command passes through literally', () => {
        const custom = 'cd /repos/benchmark && echo passthrough';
        const spec = convSpec({ convergence: { fpVerify: { command: custom } } });
        const { dot } = DotBuilder.fromSpec(spec).build();
        const { nodes } = parseDot(dot);
        assert.equal(nodes.get('fp_verify').tool_command, custom);
    });

    // AC-INSTALL-1..2
    test('AC-INSTALL-1 — setup_deps precedes converge in file order', () => {
        const { dot } = DotBuilder.fromSpec(convSpec()).build();
        const setupIdx = dot.search(/^  setup_deps \[/m);
        const convIdx = dot.search(/^  converge \[/m);
        assert.ok(setupIdx >= 0 && convIdx >= 0, 'both nodes must be present');
        assert.ok(setupIdx < convIdx, 'setup_deps must appear before converge');
    });

    test('AC-INSTALL-2 — setup_deps -> capture_baseline -> converge edge chain', () => {
        const { dot } = DotBuilder.fromSpec(convSpec()).build();
        const { edges } = parseDot(dot);
        assert.ok(edges.find(e => e.from === 'setup_deps' && e.to === 'capture_baseline'), 'setup_deps -> capture_baseline must exist');
        assert.ok(edges.find(e => e.from === 'capture_baseline' && e.to === 'converge'), 'capture_baseline -> converge must exist');
    });

    // AC-PATTERN-1
    test('AC-PATTERN-1 — P32 preserved in patternsApplied', () => {
        const { patternsApplied } = DotBuilder.fromSpec(convSpec()).build();
        assert.ok(patternsApplied.includes('P32'));
    });

    // AC-GATE-1..5
    test('AC-GATE-1 — fp_verify is a goal gate', () => {
        const { dot } = DotBuilder.fromSpec(convSpec()).build();
        const { nodes } = parseDot(dot);
        const fp = nodes.get('fp_verify');
        assert.equal(fp.goal_gate, 'true');
        assert.equal(fp.context_on_success, 'fp_pass=true');
        assert.equal(fp.context_on_failure, 'fp_pass=false');
    });

    test('AC-GATE-2 — repro_verify is a goal gate', () => {
        const { dot } = DotBuilder.fromSpec(convSpec()).build();
        const { nodes } = parseDot(dot);
        const rp = nodes.get('repro_verify');
        assert.equal(rp.goal_gate, 'true');
        assert.equal(rp.context_on_success, 'repro_pass=true');
        assert.equal(rp.context_on_failure, 'repro_pass=false');
    });

    test('AC-GATE-3 — backend mechanical gates retry to fix_backend', () => {
        const { dot } = DotBuilder.fromSpec(convSpec()).build();
        const { nodes } = parseDot(dot);
        assert.equal(nodes.get('run_build_api').retry_target, 'fix_backend');
        assert.equal(nodes.get('run_tests_api').retry_target, 'fix_backend');
        assert.equal(nodes.get('run_lint').retry_target, 'fix_backend');
    });

    test('AC-GATE-4 — frontend mechanical gate retries to fix_frontend', () => {
        const { dot } = DotBuilder.fromSpec(convSpec()).build();
        const { nodes } = parseDot(dot);
        assert.equal(nodes.get('run_build_ui').retry_target, 'fix_frontend');
    });

    test('AC-GATE-5 — all mechanical gates have shape=parallelogram', () => {
        const { dot } = DotBuilder.fromSpec(convSpec()).build();
        const { nodes } = parseDot(dot);
        for (const id of ['run_build_api', 'run_tests_api', 'run_build_ui', 'run_lint', 'fp_verify', 'repro_verify']) {
            assert.equal(nodes.get(id).shape, 'parallelogram', `${id} must have shape=parallelogram`);
        }
    });

    // AC-INT-1..2
    test('AC-INT-1/2 — attractor integration gate (skip when unreachable)', (t) => {
        const cliPath = '/Users/gregorydickson/loanlight/attractor/packages/attractor/src/cli.ts';
        if (!fs.existsSync(cliPath)) {
            process.stderr.write(`[AC-INT-2] attractor unreachable: ${cliPath} missing\n`);
            t.skip(`attractor unreachable: ${cliPath} missing`);
            return;
        }
        // 2s → 10s: load-tolerance for bun probe under concurrent test runs.
        const ver = spawnSync('bun', ['--version'], { timeout: 10000, encoding: 'utf8' });
        if (ver.status !== 0) {
            process.stderr.write('[AC-INT-2] attractor unreachable: bun --version failed\n');
            t.skip('attractor unreachable: bun --version failed');
            return;
        }
        // AC-INT-1: integration reachable. Invoke the CLI with `--help` to probe the
        // binary without coupling to the attractor parser — the goal is to verify
        // the gate ran, not to assert cross-project parser compatibility.
        // 10s → 30s: load-tolerance for bun --help under concurrent test runs.
        const run = spawnSync('bun', [cliPath, '--help'], { timeout: 30000, encoding: 'utf8' });
        assert.ok(run.signal !== 'SIGTERM', `attractor CLI must not time out: signal=${run.signal}`);
        process.stderr.write(`[AC-INT-1] attractor reachable, --help status=${run.status}\n`);
    });

    // AC-SANITY-1
    test('AC-SANITY-1 — both convergence and non-convergence specs build without error', () => {
        assert.doesNotThrow(() => DotBuilder.fromSpec(convSpec()).build(), 'convergence spec must build');
        const nonConv = {
            slug: 'sanity-nc',
            goal: 'non-convergence sanity',
            phases: [{ name: 'core', prompt: 'implement', allowedPaths: ['src/'] }],
            acceptanceCriteria: { done: 'true' },
        };
        assert.doesNotThrow(() => DotBuilder.fromSpec(nonConv).build(), 'non-convergence spec must build');
    });

    // AC-VALIDATOR-PARITY-1 — grRule6 and grRule16 see the same acceptance map
    // in convergence mode. Regression for bug where grRule16 received the raw
    // user ac while grRule6 received the merged map, causing every convergence
    // build to emit spurious ORPHANED_CONTEXT_KEY warnings for the built-in
    // fp_pass/repro_pass keys that convergence itself injects.
    test('AC-VALIDATOR-PARITY-1 — grRule16 sees merged ac in convergence mode', () => {
        const { diagnostics } = DotBuilder.fromSpec(convSpec()).build();
        const orphaned = diagnostics.filter(d =>
            d.rule === 'ORPHANED_CONTEXT_KEY' &&
            (d.nodeId === 'fp_verify' || d.nodeId === 'repro_verify')
        );
        assert.deepEqual(orphaned, [], `no ORPHANED_CONTEXT_KEY warnings expected for fp_verify/repro_verify, got: ${JSON.stringify(orphaned)}`);
    });

    // AC-COMPOUND-1
    test('AC-COMPOUND-1 — isolated workspace + stylesheet + convergence compose', () => {
        const spec = {
            ...convSpec(),
            workspace: 'isolated',
            modelStylesheet: {
                defaultModel: 'sonnet',
                overrides: [
                    { selector: '.impl', model: 'opus' },
                    { selector: '.honest_review', model: 'haiku' },
                    { selector: '.adversary', model: 'mistral' },
                ],
            },
        };
        const { dot, patternsApplied } = DotBuilder.fromSpec(spec).build();
        const { nodes, edges, graphAttrs } = parseDot(dot);
        assert.ok(nodes.has('commit_and_push'), 'commit_and_push must be injected');
        assert.ok(!edges.find(e => e.from === 'repro_verify' && e.to === 'done'), 'direct repro_verify -> done must be removed');
        assert.ok(edges.find(e => e.from === 'repro_verify' && e.to === 'commit_and_push'), 'repro_verify -> commit_and_push must exist');
        assert.ok(edges.find(e => e.from === 'commit_and_push' && e.to === 'done'), 'commit_and_push -> done must exist');
        assert.equal(graphAttrs.workspace, 'isolated');
        assert.ok(graphAttrs.model_stylesheet, 'stylesheet must be present');
        assert.ok(patternsApplied.includes('P0'), 'P0 applied');
        assert.ok(patternsApplied.includes('P32'), 'P32 applied');
    });

    // -----------------------------------------------------------------------
    // §5 hardening — additive structural coverage for ACs whose primary test
    // above drifted into a different assertion. Each test below consumes
    // parseDot() and asserts the PRD's literal field-level requirement.
    // -----------------------------------------------------------------------

    test('AC-STRUCT-3 (retry targets) — mechanical gates retry to fix_backend/fix_frontend; adversary has none', () => {
        const { dot } = DotBuilder.fromSpec(convSpec()).build();
        const { nodes } = parseDot(dot);
        assert.equal(nodes.get('run_build_api').retry_target, 'fix_backend');
        assert.equal(nodes.get('run_tests_api').retry_target, 'fix_backend');
        assert.equal(nodes.get('run_lint').retry_target, 'fix_backend');
        assert.equal(nodes.get('run_build_ui').retry_target, 'fix_frontend');
        assert.equal(nodes.get('adversary_node').retry_target, undefined,
            'adversary_node must NOT emit a retry_target attribute');
        assert.equal(nodes.get('fix_backend').allow_multi_retry_target, 'true');
        assert.equal(nodes.get('fix_frontend').allow_multi_retry_target, undefined,
            'fix_frontend must not set allow_multi_retry_target');
    });

    test('AC-STRUCT-4 (gate self-retry invariant) — every reports_to_v node retries to something other than itself', () => {
        const { dot } = DotBuilder.fromSpec(convSpec()).build();
        const { nodes } = parseDot(dot);
        let checked = 0;
        for (const [id, attrs] of nodes) {
            if (!attrs.reports_to_v) continue;
            checked++;
            assert.ok(attrs.retry_target,
                `node ${id} with reports_to_v must declare a retry_target`);
            assert.notEqual(attrs.retry_target, id,
                `node ${id} must not retry to itself (got retry_target=${attrs.retry_target})`);
        }
        assert.ok(checked > 0, 'at least one reports_to_v node must be present in convergence mode');
    });

    test('AC-STRUCT-8 (graph retry_target) — convergence mode sets graph-level retry_target="converge"', () => {
        const { dot } = DotBuilder.fromSpec(convSpec()).build();
        const { graphAttrs } = parseDot(dot);
        assert.equal(graphAttrs.retry_target, 'converge',
            'graph-level retry_target must be "converge" in convergence mode');
    });

    test('AC-STRUCT-9 (converge defaults) — default converge node carries v8 default attrs', () => {
        const spec = convSpec();
        const { dot } = DotBuilder.fromSpec(spec).build();
        const { nodes } = parseDot(dot);
        const c = nodes.get('converge');
        assert.ok(c, 'converge node must exist');
        assert.equal(c.max_iterations, String(DEFAULT_MAX_ITERATIONS));
        assert.equal(c.convergence_epsilon, String(DEFAULT_CONVERGENCE_EPSILON));
        assert.equal(c.until, spec.convergence.until);
        assert.equal(c.max_visits, String(DEFAULT_CONVERGE_MAX_VISITS));
        assert.equal(c.timeout, DEFAULT_CONVERGE_TIMEOUT);
    });

    test('AC-STRUCT-10 (context_keys) — fix_backend and fix_frontend expose the v8 context_keys bundle', () => {
        const { dot } = DotBuilder.fromSpec(convSpec()).build();
        const { nodes } = parseDot(dot);
        const expected = '__pool_findings__,__last_failure_output,__fix_attempt_history';
        assert.equal(nodes.get('fix_backend').context_keys, expected);
        assert.equal(nodes.get('fix_frontend').context_keys, expected);
    });

    test('AC-STRUCT-11 (legacy absence) — legacy v7 node ids do not appear in convergence DOT', () => {
        const { dot } = DotBuilder.fromSpec(convSpec()).build();
        const { nodes } = parseDot(dot);
        const legacy = [
            'iter_impl', 'iter_review_be', 'iter_review_fe',
            'iter_review_int', 'iter_adversary', 'quality_review',
        ];
        for (const id of legacy) {
            assert.ok(!nodes.has(id),
                `legacy node "${id}" must NOT be present in v8 convergence DOT`);
            const re = new RegExp(String.raw`^\s*${id}\s*\[`, 'm');
            assert.ok(!re.test(dot),
                `legacy node "${id}" must not appear line-anchored in the DOT source`);
        }
    });

    test('AC-INSTALL-1 — default fp_verify/repro_verify run npm install before npx tsc and npm test', () => {
        const { dot } = DotBuilder.fromSpec(convSpec()).build();
        const { nodes } = parseDot(dot);
        for (const id of ['fp_verify', 'repro_verify']) {
            const cmd = nodes.get(id).tool_command;
            assert.ok(cmd, `${id} must declare a tool_command`);
            const iInstall = cmd.search(/\bnpm install\b/);
            const iTsc = cmd.search(/\bnpx tsc\b/);
            const iTest = cmd.search(/\bnpm test\b/);
            assert.ok(iInstall >= 0, `${id} must include "npm install"`);
            assert.ok(iTsc >= 0, `${id} must include "npx tsc"`);
            assert.ok(iTest >= 0, `${id} must include "npm test"`);
            assert.ok(iInstall < iTsc, `${id}: npm install must precede npx tsc`);
            assert.ok(iInstall < iTest, `${id}: npm install must precede npm test`);
        }
    });

    test('AC-OVERRIDE-2 (harness cascade) — impl.harness falls through when fixBackend.harness is unset', () => {
        // (a) direct override wins over impl.harness
        const direct = convSpec({
            convergence: { fixBackend: { harness: 'claude-code' }, impl: { harness: 'hermes', prompt: 'p' } },
        });
        const { dot: dotA } = DotBuilder.fromSpec(direct).build();
        assert.equal(parseDot(dotA).nodes.get('fix_backend').harness, 'claude-code',
            'fixBackend.harness must win over impl.harness');

        // (b) no fixBackend.harness → impl.harness flows through
        const cascade = convSpec({
            convergence: { impl: { harness: 'claude-code', prompt: 'p' } },
        });
        const { dot: dotB } = DotBuilder.fromSpec(cascade).build();
        assert.equal(parseDot(dotB).nodes.get('fix_backend').harness, 'claude-code',
            'impl.harness must cascade into fix_backend when fixBackend.harness is unset');

        // (c) both fixBackend.harness and impl.harness unset → DEFAULT_FIX_BACKEND_HARNESS ('hermes').
        //     fromSpec() coerces impl.harness to 'claude-code' on missing input, so we
        //     construct the builder directly to exercise the line 1589 fallback.
        const builder = new DotBuilder({
            slug: 'conv-test',
            goal: 'converge on the spec',
            phases: [],
            acceptanceCriteria: {},
        });
        builder.convergence({
            until: 'V_total == 0 && fixed_point && reproducibility',
            impl: { harness: undefined, prompt: 'p' },
        });
        const { dot: dotC } = builder.build();
        assert.equal(parseDot(dotC).nodes.get('fix_backend').harness, DEFAULT_FIX_BACKEND_HARNESS,
            'fix_backend.harness must fall through to DEFAULT_FIX_BACKEND_HARNESS when neither direct nor impl.harness is set');
    });

    test('AC-OVERRIDE-3 (sealedFromSource default) — adversary_node.sealed_from_source defaults when neither direct nor convergence override is set', () => {
        const { dot } = DotBuilder.fromSpec(convSpec()).build();
        const adv = parseDot(dot).nodes.get('adversary_node');
        assert.ok(adv, 'adversary_node must be present in convergence mode');
        assert.equal(adv.sealed_from_source, DEFAULT_ADVERSARY_SEALED_FROM_SOURCE,
            'adversary_node.sealed_from_source must equal DEFAULT_ADVERSARY_SEALED_FROM_SOURCE when unset');
    });

    test('AC-OVERRIDE-4 (max_iterations/max_visits independence) — converge node emits each independently', () => {
        const spec = convSpec({ convergence: { maxIterations: 10, maxVisits: 3 } });
        const { dot } = DotBuilder.fromSpec(spec).build();
        const converge = parseDot(dot).nodes.get('converge');
        assert.ok(converge, 'converge node must be present');
        assert.equal(converge.max_iterations, '10', 'maxIterations must flow through to converge.max_iterations');
        assert.equal(converge.max_visits, '3', 'maxVisits must flow through to converge.max_visits');
    });

    test('AC-GOAL-2 (goal edge cases) — empty, whitespace-only, and undefined goals throw EMPTY_GOAL', () => {
        for (const badGoal of ['', '   ', '\t\n', undefined]) {
            assert.throws(
                () => DotBuilder.fromSpec(convSpec({ goal: badGoal })).build(),
                (err) => err instanceof BuildError && err.code === 'EMPTY_GOAL',
                `goal=${JSON.stringify(badGoal)} must throw EMPTY_GOAL`,
            );
        }
    });

    test('AC-OVERRIDE-7 (direct-attr > stylesheet) — fixBackend.model wins over modelStylesheet override', () => {
        const spec = convSpec({
            modelStylesheet: {
                overrides: [
                    { selector: '.impl', model: 'stylesheet-impl-model' },
                    { selector: '.honest_review', model: 'stylesheet-review-model' },
                    { selector: '.adversary', model: 'stylesheet-adversary-model' },
                ],
            },
            convergence: {
                fixBackend: { model: 'direct-impl-model' },
                reviewers: { be: { model: 'direct-review-model', harness: 'hermes', prompt: 'p' } },
                adversary: { model: 'direct-adversary-model' },
            },
        });
        const { dot } = DotBuilder.fromSpec(spec).build();
        const fb = parseDot(dot).nodes.get('fix_backend');
        assert.ok(fb, 'fix_backend node must be present');
        assert.equal(fb.model, 'direct-impl-model',
            'fix_backend.model must come from fixBackend.model direct attr, not the .impl stylesheet override');
    });
});

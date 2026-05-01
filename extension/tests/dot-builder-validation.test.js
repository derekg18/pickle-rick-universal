import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DotBuilder, BuildError } from '../services/dot-builder.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid spec — override fields to inject specific defects. */
function baseSpec(overrides = {}) {
    return {
        slug: 'val-test',
        goal: 'Validate structural rules',
        phases: [],
        acceptanceCriteria: {},
        ...overrides,
    };
}

/** Minimal valid phase — override to inject defects. */
function phase(name, overrides = {}) {
    return { name, prompt: `implement ${name}`, allowedPaths: ['src/'], ...overrides };
}

// ---------------------------------------------------------------------------
// 15 Structural Validation Rules (BDD Scenarios)
//
// Each test constructs a DotBuilder with a specific defect, calls .build(),
// and asserts BuildError with the correct code and diagnostic.
// ---------------------------------------------------------------------------

describe('Structural validation — 15 rules', () => {

    // Rule 1: single start/exit -----------------------------------------------
    test('Rule 1 INVALID_STRUCTURE — phase named "start" collides with reserved start node', () => {
        const builder = new DotBuilder(baseSpec({
            phases: [phase('start')],
        }));
        assert.throws(
            () => builder.build(),
            (err) => {
                assert.ok(err instanceof BuildError, 'must throw BuildError');
                assert.equal(err.code, 'INVALID_STRUCTURE');
                assert.ok(err.diagnostics.length > 0, 'must include diagnostics');
                assert.ok(
                    err.diagnostics.some(d => d.severity === 'error'),
                    'must have error-severity diagnostic',
                );
                return true;
            },
        );
    });

    // Rule 2: no incoming edges to start --------------------------------------
    test('Rule 2 START_HAS_INCOMING — retryTarget pointing to start creates incoming edge', () => {
        const builder = new DotBuilder(baseSpec({
            phases: [phase('fix', { retryTarget: 'start' })],
        }));
        assert.throws(
            () => builder.build(),
            (err) => {
                assert.ok(err instanceof BuildError);
                assert.equal(err.code, 'START_HAS_INCOMING');
                assert.ok(err.diagnostics.some(
                    d => d.rule === 'START_HAS_INCOMING' && d.severity === 'error',
                ));
                return true;
            },
        );
    });

    // Rule 3: reachability ----------------------------------------------------
    test('Rule 3 UNREACHABLE_NODE — phase with unresolvable dependsOn creates orphan', () => {
        const builder = new DotBuilder(baseSpec({
            phases: [
                phase('alpha'),
                phase('beta', { dependsOn: ['nonexistent'] }),
            ],
        }));
        assert.throws(
            () => builder.build(),
            (err) => {
                assert.ok(err instanceof BuildError);
                assert.equal(err.code, 'UNREACHABLE_NODE');
                assert.ok(err.diagnostics.some(
                    d => d.rule === 'UNREACHABLE_NODE' && d.severity === 'error' && d.nodeId,
                ));
                return true;
            },
        );
    });

    // Rule 4: diamond branching -----------------------------------------------
    test('Rule 4 DIAMOND_MISSING_EDGES — goalGate without retryTarget auto-corrected with warning', () => {
        const builder = new DotBuilder(baseSpec({
            phases: [phase('check', { goalGate: true })],
        }));
        const result = builder.build();
        assert.ok(result.dot.length > 0, 'should produce valid DOT');
        assert.ok(result.diagnostics.some(
            d => d.rule === 'DIAMOND_MISSING_EDGES' && d.severity === 'warning',
        ), 'should emit warning for auto-corrected retryTarget');
    });

    // Rule 5: goal_gate → max_visits ------------------------------------------
    // Rule 5 GOAL_GATE_NO_MAX_VISITS: The builder auto-applies default max_visits
    // for goalGate phases, so this rule validates already-built DOT output.
    // Test confirms the builder correctly sets max_visits on goalGate nodes.
    test('Rule 5 GOAL_GATE_NO_MAX_VISITS — builder auto-applies max_visits for goalGate', () => {
        const builder = new DotBuilder(baseSpec({
            phases: [phase('gate', { goalGate: true, retryTarget: 'fix_gate', timeout: '15m' })],
        }));
        const result = builder.build();
        // Both conformance and test_gate should have max_visits
        const lines = result.dot.split('\n');
        const conformanceLine = lines.find(l => l.startsWith('  conformance_gate ['));
        const testLine = lines.find(l => l.startsWith('  test_gate ['));
        assert.ok(conformanceLine && conformanceLine.includes('max_visits='),
            'conformance node has max_visits');
        assert.ok(testLine && testLine.includes('max_visits='),
            'test_gate diamond has max_visits');
    });

    // Rule 6: AC mapping ------------------------------------------------------
    test('Rule 6 MISSING_AC_MAPPING — single-phase auto-maps, multi-phase with no match still errors', () => {
        // Single-phase: auto-corrected (no error)
        const builder1 = new DotBuilder(baseSpec({
            phases: [phase('impl')],
            acceptanceCriteria: { custom_metric: 'must reach 100%' },
        }));
        const result1 = builder1.build();
        assert.ok(result1.dot.length > 0, 'single-phase should auto-map and succeed');
        assert.ok(result1.diagnostics.some(
            d => d.rule === 'MISSING_AC_MAPPING' && d.severity === 'info',
        ), 'should emit info for auto-mapping');

        // Multi-phase with unmatchable key: still errors
        const builder2 = new DotBuilder(baseSpec({
            phases: [
                phase('auth', { dependsOn: undefined }),
                phase('api', { dependsOn: ['auth'] }),
            ],
            acceptanceCriteria: { totally_unrelated: 'true' },
        }));
        assert.throws(
            () => builder2.build(),
            (err) => {
                assert.ok(err instanceof BuildError);
                assert.equal(err.code, 'MISSING_AC_MAPPING');
                assert.ok(err.diagnostics.some(
                    d => d.rule === 'MISSING_AC_MAPPING' && d.severity === 'error',
                ));
                return true;
            },
        );
    });

    // Rule 7: timeout presence — impl nodes now default to 30m
    test('Rule 7 MISSING_TIMEOUT — codergen impl node gets default timeout=30m', () => {
        const builder = new DotBuilder(baseSpec({
            phases: [phase('impl')],
        }));
        const result = builder.build();
        assert.ok(result.dot.includes('timeout="30m"'),
            'impl node without explicit timeout should get default timeout=30m');
    });

    // Rule 8: prompt ↔ allowed_paths ------------------------------------------
    test('Rule 8 PROMPT_PATH_MISMATCH — prompt references paths outside allowed_paths', () => {
        const builder = new DotBuilder(baseSpec({
            phases: [phase('impl', {
                prompt: 'Edit src/auth/login.ts to add OAuth support',
                allowedPaths: ['docs/'],
            })],
        }));
        assert.throws(
            () => builder.build(),
            (err) => {
                assert.ok(err instanceof BuildError);
                assert.equal(err.code, 'PROMPT_PATH_MISMATCH');
                assert.ok(err.diagnostics.some(
                    d => d.rule === 'PROMPT_PATH_MISMATCH' && d.severity === 'error',
                ));
                return true;
            },
        );
    });

    // Rule 9: read_only + STATUS on review nodes ------------------------------
    test('Rule 9 REVIEW_MISSING_READONLY — review node lacks read_only or STATUS marker', () => {
        const builder = new DotBuilder(baseSpec({
            phases: [phase('security_audit', { securityScan: true })],
        }));
        assert.throws(
            () => builder.build(),
            (err) => {
                assert.ok(err instanceof BuildError);
                assert.equal(err.code, 'REVIEW_MISSING_READONLY');
                assert.ok(err.diagnostics.some(
                    d => d.rule === 'REVIEW_MISSING_READONLY' && d.severity === 'error',
                ));
                return true;
            },
        );
    });

    // Rule 10: component ↔ tripleoctagon merge --------------------------------
    test('Rule 10 COMPONENT_NO_MERGE — builder auto-emits tripleoctagon merge for fan-out', () => {
        // Two independent phases trigger fan-out (Pattern 4). The builder always
        // auto-emits a tripleoctagon merge_phases node, so Rule 10 finds both
        // component and tripleoctagon present — no warning needed. This test
        // verifies the auto-emission invariant rather than the warning path.
        const result = new DotBuilder(baseSpec({
            phases: [
                phase('alpha'),
                phase('beta'),  // no dependsOn → independent → fan-out
            ],
        })).build();

        // DOT must contain the auto-emitted tripleoctagon merge node
        assert.match(result.dot, /merge_phases\s*\[.*shape="tripleoctagon"/, 'merge_phases must be tripleoctagon');

        // Rule 10 does NOT warn because builder guarantees the merge node exists
        const warn = result.diagnostics.find(d => d.rule === 'COMPONENT_NO_MERGE');
        assert.equal(warn, undefined, 'no COMPONENT_NO_MERGE warning when merge node is auto-emitted');
    });

    // Rule 11: fan_out_scope --------------------------------------------------
    test('Rule 11 FAN_OUT_SCOPE_LEAK — retryTarget escapes fan-out component scope', () => {
        const builder = new DotBuilder(baseSpec({
            phases: [
                phase('alpha', { retryTarget: 'impl_beta' }),
                phase('beta'),
            ],
        }));
        assert.throws(
            () => builder.build(),
            (err) => {
                assert.ok(err instanceof BuildError);
                assert.equal(err.code, 'FAN_OUT_SCOPE_LEAK');
                assert.ok(err.diagnostics.some(
                    d => d.rule === 'FAN_OUT_SCOPE_LEAK' && d.severity === 'error',
                ));
                return true;
            },
        );
    });

    // Rule 12: workspace_config — HTTPS required for isolated workspace -------
    test('Rule 12 WORKSPACE_NO_HTTPS — auto-converts SSH to HTTPS with warning', () => {
        const builder = new DotBuilder(baseSpec({
            phases: [phase('impl')],
            workspace: 'isolated',
            workspaceOpts: { repoUrl: 'git@github.com:org/repo.git' },
        }));
        const result = builder.build();
        assert.ok(result.dot.length > 0, 'should produce valid DOT');
        assert.ok(result.diagnostics.some(
            d => d.rule === 'WORKSPACE_NO_HTTPS' && d.severity === 'warning',
        ), 'should emit warning for auto-converted URL');
    });

    // Rule 13: workspace_push — auto-injects commit_and_push ------------------
    test('Rule 13 WORKSPACE_NO_PUSH — auto-injects commit_and_push with warning', () => {
        const builder = new DotBuilder(baseSpec({
            phases: [phase('impl')],
            workspace: 'isolated',
            workspaceOpts: { repoUrl: 'https://github.com/org/repo.git' },
        }));
        const result = builder.build();
        assert.ok(result.dot.length > 0, 'should produce valid DOT');
        assert.ok(result.dot.includes('commit_and_push'), 'should have auto-injected commit_and_push');
        assert.ok(result.diagnostics.some(
            d => d.rule === 'WORKSPACE_NO_PUSH' && d.severity === 'warning',
        ), 'should emit warning for auto-injected push');
    });

    // Rule 14: permission_mode_plan -------------------------------------------
    test('Rule 14 PLAN_MODE_DEADLOCK — plan permission mode in headless pipeline', () => {
        const builder = new DotBuilder(baseSpec({
            phases: [phase('impl', { specFirst: true, goalGate: true })],
        }));
        assert.throws(
            () => builder.build(),
            (err) => {
                assert.ok(err instanceof BuildError);
                assert.equal(err.code, 'PLAN_MODE_DEADLOCK');
                assert.ok(err.diagnostics.some(
                    d => d.rule === 'PLAN_MODE_DEADLOCK' && d.severity === 'error',
                ));
                return true;
            },
        );
    });

    // Rule 15: allowed_paths auto-correction ------------------------------------
    test('Rule 15 MISSING_ALLOWED_PATHS — auto-corrects empty allowed_paths with warning', () => {
        const builder = new DotBuilder(baseSpec({
            phases: [phase('impl', { allowedPaths: [] })],
        }));
        const result = builder.build();
        // Should succeed (warning, not error) and auto-fill paths
        assert.ok(result.dot.length > 0);
        assert.ok(result.diagnostics.some(
            d => d.rule === 'MISSING_ALLOWED_PATHS' && d.severity === 'warning',
        ));
    });
});

// ---------------------------------------------------------------------------
// Auto-Correction Tests
// ---------------------------------------------------------------------------

describe('Auto-corrections (preflight)', () => {

    test('auto-corrects goalGate without retryTarget (warning, not error)', () => {
        const builder = new DotBuilder(baseSpec({
            phases: [phase('critical', { goalGate: true })],
        }));
        const result = builder.build();
        assert.ok(result.dot.length > 0, 'should produce valid DOT');
        assert.ok(result.diagnostics.some(
            d => d.rule === 'DIAMOND_MISSING_EDGES' && d.severity === 'warning',
        ), 'should emit warning for auto-corrected retryTarget');
    });

    test('auto-converts SSH to HTTPS repoUrl (warning, not error)', () => {
        const builder = new DotBuilder(baseSpec({
            phases: [phase('impl')],
        }));
        builder.workspace({ repoUrl: 'git@github.com:org/repo.git', repoBranch: 'main', cleanup: 'preserve' });
        const result = builder.build();
        assert.ok(result.dot.length > 0, 'should produce valid DOT');
        assert.ok(result.dot.includes('https://github.com/org/repo.git') || result.diagnostics.some(
            d => d.rule === 'WORKSPACE_NO_HTTPS' && d.severity === 'warning',
        ), 'should auto-convert SSH URL or emit warning');
    });

    test('auto-injects commit_and_push for isolated workspace (warning, not error)', () => {
        const builder = new DotBuilder(baseSpec({
            phases: [phase('impl')],
        }));
        builder.workspace({ repoUrl: 'https://github.com/org/repo.git', repoBranch: 'main', cleanup: 'preserve' });
        const result = builder.build();
        assert.ok(result.dot.length > 0, 'should produce valid DOT');
        assert.ok(result.dot.includes('commit_and_push'), 'should auto-inject commit_and_push node');
    });

    test('single-phase pipeline auto-maps custom AC keys', () => {
        const builder = new DotBuilder(baseSpec({
            phases: [phase('search')],
            acceptanceCriteria: { tests_pass: 'true', search_works: 'true' },
        }));
        const result = builder.build();
        assert.ok(result.dot.length > 0, 'should produce valid DOT');
        assert.ok(result.dot.includes('search_works'), 'should include auto-mapped AC key in context_on_success');
        assert.ok(result.diagnostics.some(
            d => d.rule === 'MISSING_AC_MAPPING' && d.severity === 'info',
        ), 'should emit info diagnostic for auto-mapping');
    });

    test('multi-phase pipeline auto-maps AC keys by name match', () => {
        const builder = new DotBuilder(baseSpec({
            phases: [
                phase('auth', { dependsOn: undefined }),
                phase('api', { dependsOn: ['auth'] }),
            ],
            acceptanceCriteria: { tests_pass: 'true', auth_complete: 'true' },
        }));
        const result = builder.build();
        assert.ok(result.dot.length > 0, 'should produce valid DOT');
        assert.ok(result.diagnostics.some(
            d => d.rule === 'MISSING_AC_MAPPING' && d.severity === 'info' && d.message.includes('auth'),
        ), 'should auto-map auth_complete to auth phase');
    });

    test('AC mapping diagnostic includes fix hint with phase suggestion', () => {
        const builder = new DotBuilder(baseSpec({
            phases: [
                phase('auth', { dependsOn: undefined }),
                phase('api', { dependsOn: ['auth'] }),
            ],
            acceptanceCriteria: { tests_pass: 'true', something_custom: 'true' },
        }));
        // something_custom won't match any phase name — should get helpful fix hint
        assert.throws(
            () => builder.build(),
            (err) => {
                assert.ok(err instanceof BuildError);
                assert.ok(err.diagnostics.some(d =>
                    d.rule === 'MISSING_AC_MAPPING' && d.fix && d.fix.includes('Phases:'),
                ), 'should include phase list in fix hint');
                return true;
            },
        );
    });
});

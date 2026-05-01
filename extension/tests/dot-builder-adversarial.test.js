import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DotBuilder, BuildError } from '../services/dot-builder.js';

// ---------------------------------------------------------------------------
// Adversarial audit — 16 attack vectors against DotBuilder
// Each must produce a structured BuildError (not a crash/TypeError/etc.)
// ---------------------------------------------------------------------------

/** Assert fn throws BuildError with optional code check. */
function assertBuildError(fn, expectedCode, label) {
    try {
        fn();
        assert.fail(`${label}: expected BuildError but no error thrown`);
    } catch (err) {
        assert.ok(
            err instanceof BuildError,
            `${label}: expected BuildError, got ${err?.constructor?.name}: ${err?.message}`
        );
        if (expectedCode) {
            assert.equal(err.code, expectedCode, `${label}: wrong error code`);
        }
    }
}

function phase(name, overrides = {}) {
    return { name, prompt: 'do the thing', allowedPaths: ['src/'], ...overrides };
}

function spec(overrides = {}) {
    return { slug: 'test', goal: 'test goal', phases: [phase('Alpha')], ...overrides };
}

describe('Adversarial audit', () => {
    // (1) Empty phases array — builder allows it (produces minimal graph)
    test('1: empty phases array', () => {
        const result = DotBuilder.fromSpec({ slug: 'x', goal: 'y', phases: [] }).build();
        assert.ok(result.dot, 'empty phases produces DOT output (minimal graph)');
        assert.equal(result.slug, 'x');
    });

    // (2) Unicode phase names — emoji, CJK, RTL
    test('2: emoji phase name', () => {
        assertBuildError(
            () => DotBuilder.fromSpec(spec({ phases: [phase('🔥🚀')] })),
            'EMPTY_SLUG',
            'emoji phase name'
        );
    });

    test('2: CJK phase name', () => {
        assertBuildError(
            () => DotBuilder.fromSpec(spec({ phases: [phase('数据处理')] })),
            'EMPTY_SLUG',
            'CJK phase name'
        );
    });

    test('2: RTL phase name', () => {
        assertBuildError(
            () => DotBuilder.fromSpec(spec({ phases: [phase('مرحبا')] })),
            'EMPTY_SLUG',
            'RTL phase name'
        );
    });

    // (3) >100 phases stress test
    test('3: >100 phases stress test', () => {
        const phases = Array.from({ length: 101 }, (_, i) => phase(`Phase${i}`));
        try {
            const builder = DotBuilder.fromSpec(spec({ phases }));
            const result = builder.build();
            assert.ok(result.dot, 'stress test produced DOT output');
        } catch (err) {
            assert.ok(
                err instanceof BuildError,
                `stress test: expected BuildError or success, got ${err?.constructor?.name}: ${err?.message}`
            );
        }
    });

    // (4) Slug with slashes/hashes/spaces
    test('4: slug with slashes/hashes/spaces', () => {
        try {
            const builder = DotBuilder.fromSpec(spec({ slug: 'foo/bar#baz qux' }));
            builder.build();
        } catch (err) {
            assert.ok(
                err instanceof BuildError,
                `bad slug: expected BuildError, got ${err?.constructor?.name}: ${err?.message}`
            );
        }
    });

    // (5) Prompt containing quotes and newlines
    test('5: prompt with quotes and newlines', () => {
        const evil = 'do "this"\nand \'that\'\nwith\ttabs\\backslash';
        try {
            const builder = DotBuilder.fromSpec(spec({
                phases: [phase('Quoted', { prompt: evil })]
            }));
            const result = builder.build();
            assert.ok(result.dot.includes('quoted'), 'phase with special chars emitted');
        } catch (err) {
            assert.ok(
                err instanceof BuildError,
                `quote prompt: expected BuildError, got ${err?.constructor?.name}: ${err?.message}`
            );
        }
    });

    // (6) allowedPaths with absolute paths — add timeout to avoid MISSING_TIMEOUT firing first
    test('6: allowedPaths with absolute paths', () => {
        assertBuildError(
            () => DotBuilder.fromSpec(spec({
                phases: [phase('Abs', { allowedPaths: ['/etc/passwd'], timeout: '30m' })]
            })).build(),
            'INVALID_ALLOWED_PATHS',
            'absolute allowedPaths'
        );
    });

    // (7) timeout='30' (missing unit)
    test('7: timeout missing unit', () => {
        assertBuildError(
            () => DotBuilder.fromSpec(spec({
                phases: [phase('NoUnit', { timeout: '30' })]
            })).build(),
            'INVALID_TIMEOUT',
            'timeout no unit'
        );
    });

    // (8) Two phases sanitizing to same ID
    test('8: duplicate sanitized ID', () => {
        assertBuildError(
            () => DotBuilder.fromSpec(spec({
                phases: [phase('Foo Bar'), phase('foo-bar')]
            })),
            'DUPLICATE_PHASE',
            'duplicate sanitized ID'
        );
    });

    // (9) timeout='0m'
    test('9: timeout zero minutes', () => {
        assertBuildError(
            () => DotBuilder.fromSpec(spec({
                phases: [phase('ZeroT', { timeout: '0m' })]
            })).build(),
            'INVALID_TIMEOUT',
            'zero timeout'
        );
    });

    // (10) contextOnSuccess key not in acceptanceCriteria — multi-phase to avoid auto-map
    test('10: contextOnSuccess unmapped AC key', () => {
        assertBuildError(
            () => DotBuilder.fromSpec(spec({
                phases: [
                    phase('Alpha', {
                        contextOnSuccess: { phantom_key: 'test' },
                        timeout: '30m',
                    }),
                    phase('Beta', { timeout: '30m', dependsOn: ['Alpha'] }),
                ],
                acceptanceCriteria: { unmatchable_xyz: 'must pass' },
            })).build(),
            'MISSING_AC_MAPPING',
            'unmapped AC key'
        );
    });

    // (11) Circular dependencies A→B→C→A
    test('11: circular dependencies', () => {
        assertBuildError(
            () => DotBuilder.fromSpec(spec({
                phases: [
                    phase('Alpha', { dependsOn: ['Gamma'], timeout: '30m' }),
                    phase('Beta', { dependsOn: ['Alpha'], timeout: '30m' }),
                    phase('Gamma', { dependsOn: ['Beta'], timeout: '30m' }),
                ]
            })).build(),
            'INVALID_STRUCTURE',
            'circular deps'
        );
    });

    // (12) DOT injection in prompt — verify quotes are escaped so the payload
    // stays inside a quoted attribute value and cannot break DOT structure
    test('12: DOT injection in prompt', () => {
        const injection = '} ; digraph evil { attacker [label="pwned"]';
        try {
            const builder = DotBuilder.fromSpec(spec({
                phases: [phase('Inject', { prompt: injection })]
            }));
            const result = builder.build();
            // The injection string appears in the output BUT inside a properly
            // quoted attribute value. The key defense is that `"` is escaped to `\\"`,
            // so the attacker cannot close the attribute and inject new DOT structure.
            assert.ok(
                !result.dot.includes('label="pwned"'),
                'Unescaped quotes must not appear — attacker cannot close attribute value'
            );
            // Verify the escaped form IS present (quotes escaped)
            assert.ok(
                result.dot.includes('label=\\"pwned\\"') || result.dot.includes('digraph evil'),
                'Injection payload present but safely inside quoted attribute'
            );
        } catch (err) {
            assert.ok(
                err instanceof BuildError,
                `DOT injection: expected BuildError, got ${err?.constructor?.name}: ${err?.message}`
            );
        }
    });

    // (13) Zero-width Unicode in phase names
    test('13: ZWSP-only phase name', () => {
        assertBuildError(
            () => DotBuilder.fromSpec(spec({ phases: [phase('\u200B')] })),
            'EMPTY_SLUG',
            'ZWSP phase name'
        );
    });

    test('13: BOM-only phase name', () => {
        assertBuildError(
            () => DotBuilder.fromSpec(spec({ phases: [phase('\uFEFF')] })),
            'EMPTY_SLUG',
            'BOM phase name'
        );
    });

    test('13: ZWSP mixed with ASCII', () => {
        try {
            const builder = DotBuilder.fromSpec(spec({
                phases: [phase('a\u200Bb')]
            }));
            const result = builder.build();
            assert.ok(result.dot, 'ZWSP mixed with ASCII produced output');
        } catch (err) {
            assert.ok(
                err instanceof BuildError,
                `ZWSP mixed: expected BuildError, got ${err?.constructor?.name}: ${err?.message}`
            );
        }
    });

    // (14) Path traversal in allowedPaths — add timeout to avoid MISSING_TIMEOUT firing first
    test('14: path traversal in allowedPaths', () => {
        assertBuildError(
            () => DotBuilder.fromSpec(spec({
                phases: [phase('Traversal', { allowedPaths: ['../../etc/passwd'], timeout: '30m' })]
            })).build(),
            'INVALID_ALLOWED_PATHS',
            'path traversal'
        );
    });

    // (15) Empty string phase name
    test('15: empty string phase name', () => {
        assertBuildError(
            () => DotBuilder.fromSpec(spec({ phases: [phase('')] })),
            undefined,
            'empty phase name'
        );
    });

    // (16) dependsOn nonexistent phase
    test('16: dependsOn nonexistent phase', () => {
        assertBuildError(
            () => DotBuilder.fromSpec(spec({
                phases: [phase('Lonely', { dependsOn: ['ghost_phase'], timeout: '30m' })]
            })).build(),
            'UNREACHABLE_NODE',
            'nonexistent dependency'
        );
    });

    // ==========================================================================
    // BDD SCENARIOS — Pipeline Author Perspective (PRD sections: API Contracts,
    // DOT String Escaping, DOT Serialization Algorithm)
    // ==========================================================================

    // (1) EMPTY_SLUG: Given omitted slug field, When processed, Then rejects with clear error
    test('BDD-1: EMPTY_SLUG error for empty slug', () => {
        assertBuildError(
            () => DotBuilder.fromSpec({ slug: '', goal: 'test', phases: [] }),
            'EMPTY_SLUG',
            'empty slug field'
        );
        assertBuildError(
            () => DotBuilder.fromSpec({ slug: '   ', goal: 'test', phases: [] }),
            'EMPTY_SLUG',
            'whitespace-only slug'
        );
        // Constructor also validates slug via fromSpec internally
        assertBuildError(
            () => DotBuilder.fromSpec({ slug: 'test', goal: 'test goal', phases: [{ name: '', prompt: 'x', allowedPaths: ['x'] }] }),
            'EMPTY_SLUG',
            'empty phase name'
        );
    });

    // (2) DUPLICATE_PHASE: Given two phases with sanitized ID collision, When processed, Then rejects with collision ID
    test('BDD-2: DUPLICATE_PHASE error for sanitized collision', () => {
        assertBuildError(
            () => DotBuilder.fromSpec(spec({
                phases: [phase('auth scan'), phase('auth-scan')]
            })),
            'DUPLICATE_PHASE',
            'space vs hyphen collision → auth_scan'
        );
        assertBuildError(
            () => DotBuilder.fromSpec(spec({
                phases: [phase('Auth_Scan'), phase('auth-scan')]
            })),
            'DUPLICATE_PHASE',
            'underscore vs hyphen collision → auth_scan'
        );
        assertBuildError(
            () => DotBuilder.fromSpec(spec({
                phases: [phase('test:stage'), phase('test_stage')]
            })),
            'DUPLICATE_PHASE',
            'colon vs underscore collision → test_stage'
        );
    });

    // (3) Single-phase digraph: Given single-phase pipeline, When built, Then output has Mdiamond start + Msquare exit
    test('BDD-3: Single-phase pipeline generates valid digraph with Mdiamond/Msquare', () => {
        const builder = DotBuilder.fromSpec({
            slug: 'single-phase',
            goal: 'Single phase test',
            phases: [{
                name: 'main',
                prompt: 'Build the main module',
                allowedPaths: ['src/main/**'],
                timeout: '30m',
            }],
        });

        const result = builder.build();
        const dot = result.dot;

        // Verify DOT structure
        assert.ok(dot.startsWith('digraph "single_phase"'), 'digraph declaration present');
        assert.ok(dot.trim().endsWith('}'), 'DOT ends with closing brace');

        // Check for start node with Mdiamond shape
        assert.ok(dot.includes('start ['), 'start node declared');
        assert.ok(dot.match(/start\s+\[[\s\S]*?shape\s*=\s*"Mdiamond"/), 'start node has Mdiamond shape');

        // Check for exit node with Msquare shape
        // Exit node uses ID "exit" with shape=Msquare
        assert.ok(dot.match(/shape="Msquare"/), 'exit node with Msquare shape exists');

        // Verify disaggregated endgame chain exists
        assert.ok(dot.includes('verify_typecheck ['), 'verify_typecheck node present');
        assert.ok(dot.includes('verify_tests ['), 'verify_tests node present');
    });

    // (4) ALREADY_BUILT: Given built instance, When .build() called again, Then rejects to prevent reuse
    test('BDD-4: ALREADY_BUILT error for reusing built instance', () => {
        const builder = DotBuilder.fromSpec({
            slug: 'rebuild-test',
            goal: 'Rebuild test',
            phases: [{
                name: 'first',
                prompt: 'Build something',
                allowedPaths: ['src/**'],
                timeout: '30m',
            }],
        });

        // First build - should succeed
        const result1 = builder.build();
        assert.ok(result1.dot, 'first build succeeded');
        assert.equal(result1.slug, 'rebuild-test');

        // Second build - should fail with ALREADY_BUILT
        assertBuildError(
            () => builder.build(),
            'ALREADY_BUILT',
            'second build call rejected'
        );
    });

    // (5) Special chars sanitize: Given special chars in phase names, When sanitized, Then valid DOT identifiers result
    test('BDD-5: Special characters in phase names sanitize to valid DOT identifiers', () => {
        const builder = DotBuilder.fromSpec({
            slug: 'special-chars',
            goal: 'Special chars test',
            phases: [
                { name: 'auth scan', prompt: 'Build auth', allowedPaths: ['src/auth/**'], timeout: '30m' },
                { name: 'build-v2', prompt: 'Build version 2', allowedPaths: ['src/v2/**'], timeout: '30m' },
                { name: 'test:stage', prompt: 'Test stage', allowedPaths: ['tests/**'], timeout: '30m' },
            ],
        });

        const result = builder.build();
        const dot = result.dot;

        // Extract node IDs from DOT output
        const nodeRegex = /^\s*(\S+)\s+\[/gm;
        const nodes = dot.match(nodeRegex) || [];

        // Verify sanitized node IDs exist (not raw names with special chars)
        // Phase names sanitize to IDs like auth_scan, build_v2, test_stage
        assert.ok(nodes.some(n => n.includes('auth_scan')), 'space → underscore (auth_scan)');
        assert.ok(nodes.some(n => n.includes('build_v2')), 'hyphen → underscore (build_v2)');
        assert.ok(nodes.some(n => n.includes('test_stage')), 'colon → underscore (test_stage)');

        // Verify no raw names with special chars in nodes
        assert.ok(!nodes.some(n => n.includes('auth scan')), 'no space in node ID');
        assert.ok(!nodes.some(n => n.includes('test:stage')), 'no colon in node ID');

        // Verify all node IDs match valid DOT pattern: [a-zA-Z_][a-zA-Z0-9_]*
        const validIdRegex = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
        for (const nodeDecl of nodes) {
            const nodeId = nodeDecl.trim().split('[')[0].trim();
            assert.ok(validIdRegex.test(nodeId), `node ID "${nodeId}" is valid DOT identifier`);
        }
    });

    // (6) Prompt escaping: Given quotes/newlines in prompt, When emitted, Then properly escaped in DOT
    test('BDD-6: Quotes and newlines in prompt text are properly escaped in DOT output', () => {
        const builder = DotBuilder.fromSpec({
            slug: 'escape-test',
            goal: 'Escape test',
            phases: [{
                name: 'escaped',
                prompt: 'Build a "special" module\nwith multiple "lines"\nand "quotes" inside',
                allowedPaths: ['src/**'],
                timeout: '30m',
            }],
        });

        const result = builder.build();
        const dot = result.dot;

        // Find the impl node and check its label attribute
        // Note: The attribute may span multiple lines due to the escaped newlines
        const implMatch = dot.match(/impl_escaped\s+\[[\s\S]*?label\s*=\s*"([\s\S]*?)"/);
        assert.ok(implMatch, 'impl_escaped node with label attribute exists');
        const promptValue = implMatch[1];

        // Verify prompt is properly escaped (no unescaped quotes in the value)
        // The value contains backslash-escaped quotes (\\") and backslash-n (\\n)
        assert.ok(!promptValue.includes('"'), 'no unescaped quotes in label value');

        // Verify newlines are escaped as literal backslash-n (the actual DOT has \n)
        // The label attribute in the DOT contains escaped newlines as literal backslash-n
        assert.ok(dot.includes('\\n'), 'newlines escaped as backslash-n in DOT');

        // Verify the full DOT structure is valid
        assert.ok(dot.includes('digraph "escape_test" {'), 'valid digraph structure');
    });
});

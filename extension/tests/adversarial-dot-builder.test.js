import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DotBuilder, BuildError } from '../services/dot-builder.js';

// Helper: minimal valid spec
function baseSpec(overrides = {}) {
    return {
        slug: 'test-slug',
        goal: 'test goal',
        phases: [],
        acceptanceCriteria: {},
        ...overrides,
    };
}

function phase(overrides = {}) {
    return {
        name: 'impl',
        prompt: 'do the thing',
        allowedPaths: ['src/'],
        ...overrides,
    };
}

/** Assert that fn throws BuildError (not a raw crash) */
function assertBuildError(fn, label) {
    try {
        fn();
        assert.fail(`${label}: expected BuildError but no error thrown`);
    } catch (err) {
        assert.ok(err instanceof BuildError,
            `${label}: expected BuildError, got ${err?.constructor?.name}: ${err?.message}`);
    }
}

/** Assert fn does NOT throw (produces valid output or structured error) */
function assertNoRawCrash(fn, label) {
    try {
        fn();
    } catch (err) {
        assert.ok(err instanceof BuildError,
            `${label}: expected BuildError or success, got ${err?.constructor?.name}: ${err?.message}`);
    }
}

// =========================================================================

describe('Adversarial DotBuilder audit', () => {

    // (1) Empty phases array
    test('(1) empty phases array — should build without crash', () => {
        const b = DotBuilder.fromSpec(baseSpec({ phases: [] }));
        const result = b.build();
        assert.ok(result.dot.includes('digraph'), 'should emit valid digraph');
        assert.ok(result.dot.includes('capture_baseline'), 'should still have setup nodes');
    });

    // (2) Unicode phase names — emoji, CJK, RTL
    test('(2a) emoji phase name sanitizes to empty → BuildError', () => {
        assertBuildError(() => {
            DotBuilder.fromSpec(baseSpec({
                phases: [phase({ name: '🚀🔥💀' })],
            }));
        }, 'emoji-only name');
    });

    test('(2b) CJK phase name sanitizes to empty → BuildError', () => {
        assertBuildError(() => {
            DotBuilder.fromSpec(baseSpec({
                phases: [phase({ name: '数据处理' })],
            }));
        }, 'CJK-only name');
    });

    test('(2c) RTL phase name sanitizes to empty → BuildError', () => {
        assertBuildError(() => {
            DotBuilder.fromSpec(baseSpec({
                phases: [phase({ name: 'مرحبا' })],
            }));
        }, 'RTL-only name');
    });

    test('(2d) mixed ASCII+emoji keeps ASCII portion', () => {
        assertNoRawCrash(() => {
            const b = DotBuilder.fromSpec(baseSpec({
                phases: [phase({ name: 'build🚀thing', timeout: '30m' })],
            }));
            b.build();
        }, 'mixed ascii+emoji');
    });

    // (3) >100 phases stress test
    test('(3) 101 phases with unique names — no crash', () => {
        const phases = [];
        for (let i = 0; i < 101; i++) {
            phases.push(phase({
                name: `phase_${i}`,
                prompt: `do step ${i}`,
                allowedPaths: ['src/'],
                timeout: '10m',
                dependsOn: i > 0 ? [`phase_${i - 1}`] : undefined,
            }));
        }
        assertNoRawCrash(() => {
            const b = DotBuilder.fromSpec(baseSpec({ phases }));
            b.build();
        }, '101 phases');
    });

    // (4) Slug with slashes, hashes, spaces
    test('(4a) slug with slashes', () => {
        assertNoRawCrash(() => {
            const b = DotBuilder.fromSpec(baseSpec({ slug: 'my/slug/here' }));
            b.build();
        }, 'slash slug');
    });

    test('(4b) slug with hashes and spaces', () => {
        assertNoRawCrash(() => {
            const b = DotBuilder.fromSpec(baseSpec({ slug: 'my #slug here' }));
            b.build();
        }, 'hash+space slug');
    });

    // (5) Prompt containing quotes and newlines
    test('(5) prompt with quotes and newlines — escaped in DOT output', () => {
        const b = DotBuilder.fromSpec(baseSpec({
            phases: [phase({
                prompt: 'say "hello"\nand \'goodbye\'\nwith\\backslash',
                timeout: '30m',
            })],
        }));
        const result = b.build();
        // Must not crash; quotes must be escaped
        assert.ok(!result.dot.includes('say "hello"'),
            'raw double quotes should be escaped');
    });

    // (6) allowedPaths with absolute paths
    test('(6a) absolute path /etc/passwd → BuildError', () => {
        assertBuildError(() => {
            const b = DotBuilder.fromSpec(baseSpec({
                phases: [phase({
                    allowedPaths: ['/etc/passwd'],
                    timeout: '30m',
                })],
            }));
            b.build();
        }, 'absolute path');
    });

    // (7) timeout='30' (missing unit)
    test('(7) timeout without unit → BuildError', () => {
        assertBuildError(() => {
            const b = DotBuilder.fromSpec(baseSpec({
                phases: [phase({ timeout: '30' })],
            }));
            b.build();
        }, 'timeout missing unit');
    });

    // (8) Two phases sanitizing to same ID
    test('(8) two phases collide after sanitization → BuildError', () => {
        assertBuildError(() => {
            DotBuilder.fromSpec(baseSpec({
                phases: [
                    phase({ name: 'My Phase!' }),
                    phase({ name: 'my_phase' }),
                ],
            }));
        }, 'duplicate sanitized ID');
    });

    // (9) timeout='0m'
    test('(9) timeout=0m → BuildError', () => {
        assertBuildError(() => {
            const b = DotBuilder.fromSpec(baseSpec({
                phases: [phase({ timeout: '0m' })],
            }));
            b.build();
        }, 'zero timeout');
    });

    // (10) contextOnSuccess key not in acceptanceCriteria
    test('(10) contextOnSuccess key outside AC — no crash', () => {
        assertNoRawCrash(() => {
            const b = DotBuilder.fromSpec(baseSpec({
                acceptanceCriteria: { done: 'all tests pass' },
                phases: [phase({
                    contextOnSuccess: { orphan_key: 'some value' },
                    goalGate: true,
                    retryTarget: 'impl',
                    timeout: '30m',
                })],
                defaultMaxRetry: 3,
            }));
            b.build();
        }, 'orphan contextOnSuccess key');
    });

    // (11) Circular phase dependencies A→B→C→A
    test('(11) circular dependsOn → BuildError', () => {
        assertBuildError(() => {
            const b = DotBuilder.fromSpec(baseSpec({
                phases: [
                    phase({ name: 'A', dependsOn: ['C'], timeout: '10m' }),
                    phase({ name: 'B', dependsOn: ['A'], timeout: '10m' }),
                    phase({ name: 'C', dependsOn: ['B'], timeout: '10m' }),
                ],
            }));
            b.build();
        }, 'circular deps');
    });

    // (12) DOT injection — closing brace to escape digraph context
    test('(12) prompt with DOT injection (closing brace) — escaped', () => {
        const b = DotBuilder.fromSpec(baseSpec({
            phases: [phase({
                prompt: '} ; inject [label="pwned"] ; digraph evil {',
                timeout: '30m',
            })],
        }));
        const result = b.build();
        assert.ok(!result.dot.includes('inject [label="pwned"]'),
            'injected DOT should be escaped inside attribute string');
    });

    // (13) Zero-width Unicode in phase names
    test('(13a) zero-width space U+200B only → BuildError', () => {
        assertBuildError(() => {
            DotBuilder.fromSpec(baseSpec({
                phases: [phase({ name: '\u200B\u200B\u200B' })],
            }));
        }, 'zero-width space only');
    });

    test('(13b) BOM U+FEFF only → BuildError', () => {
        assertBuildError(() => {
            DotBuilder.fromSpec(baseSpec({
                phases: [phase({ name: '\uFEFF' })],
            }));
        }, 'BOM only');
    });

    test('(13c) zero-width chars mixed with ASCII — keeps ASCII', () => {
        assertNoRawCrash(() => {
            const b = DotBuilder.fromSpec(baseSpec({
                phases: [phase({ name: '\u200Bbuild\uFEFFthing', timeout: '30m' })],
            }));
            b.build();
        }, 'ZW+ASCII mix');
    });

    // (14) allowedPaths with path traversal
    test('(14a) path traversal ../../etc/passwd → BuildError', () => {
        assertBuildError(() => {
            const b = DotBuilder.fromSpec(baseSpec({
                phases: [phase({
                    allowedPaths: ['../../etc/passwd'],
                    timeout: '30m',
                })],
            }));
            b.build();
        }, 'path traversal');
    });

    test('(14b) path traversal ../secret → BuildError', () => {
        assertBuildError(() => {
            const b = DotBuilder.fromSpec(baseSpec({
                phases: [phase({
                    allowedPaths: ['../secret'],
                    timeout: '30m',
                })],
            }));
            b.build();
        }, 'single-level traversal');
    });

    // (15) Empty string phase name
    test('(15) empty string phase name → BuildError', () => {
        assertBuildError(() => {
            DotBuilder.fromSpec(baseSpec({
                phases: [phase({ name: '' })],
            }));
        }, 'empty name');
    });

    // (16) dependsOn referencing nonexistent phase
    test('(16) dependsOn nonexistent phase → BuildError', () => {
        assertBuildError(() => {
            const b = DotBuilder.fromSpec(baseSpec({
                phases: [phase({
                    name: 'lonely',
                    dependsOn: ['ghost_phase'],
                    timeout: '30m',
                })],
            }));
            b.build();
        }, 'dangling dependsOn');
    });
});

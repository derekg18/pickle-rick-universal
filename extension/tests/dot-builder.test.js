import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    BuilderSpec,
    PhaseSpec,
    BuildError,
    Diagnostic,
    BuildResult,
    DefenseMatrix,
    ValidationResult,
    BuildErrorCode,
    MicroverseOpts,
    WorkspaceOpts,
    StylesheetConfig,
    BUILD_ERROR_CODES,
    DotBuilder,
} from '../services/dot-builder.js';

// ---------------------------------------------------------------------------
// Type contract tests — RED phase (no production code exists yet)
// ---------------------------------------------------------------------------

describe('BuilderSpec interface', () => {
    test('has all 13 fields with correct defaults/types', () => {
        const spec = {
            slug: 'test-pipeline',
            goal: 'Build something',
            phases: [],
            acceptanceCriteria: { done: 'true' },
            workingDir: '/tmp',
            label: 'Test',
            defaultMaxRetry: 3,
            workspace: 'isolated',
            workspaceOpts: { cleanup: 'delete' },
            microverse: { name: 'mv', opts: { prompt: 'p', measureCommand: 'echo 1', target: 0, direction: 'reduce', allowedPaths: ['.'] } },
            reviewRatchet: 2,
            modelStylesheet: { defaultModel: 'sonnet' },
            specFile: '/tmp/spec.md',
        };
        // BuilderSpec should be usable as a type guard / validator
        assert.ok(BuilderSpec, 'BuilderSpec should be exported');
        assert.equal(typeof BuilderSpec.validate, 'function', 'BuilderSpec.validate should exist');
        const result = BuilderSpec.validate(spec);
        assert.ok(result.valid, 'valid spec should pass validation');
    });

    test('rejects spec missing required fields', () => {
        const result = BuilderSpec.validate({});
        assert.equal(result.valid, false);
        assert.ok(result.diagnostics.length >= 3, 'should report slug, goal, phases missing');
    });

    test('slug must be non-empty string', () => {
        const result = BuilderSpec.validate({ slug: '', goal: 'g', phases: [], acceptanceCriteria: {} });
        assert.equal(result.valid, false);
        assert.ok(result.diagnostics.some(d => d.rule === 'EMPTY_SLUG'));
    });

    test('workspace only accepts "isolated" or undefined', () => {
        const result = BuilderSpec.validate({
            slug: 's', goal: 'g', phases: [], acceptanceCriteria: {},
            workspace: 'shared',
        });
        assert.equal(result.valid, false);
    });

    test('reviewRatchet must be >= 2', () => {
        const result = BuilderSpec.validate({
            slug: 's', goal: 'g', phases: [], acceptanceCriteria: {},
            reviewRatchet: 1,
        });
        assert.equal(result.valid, false);
        assert.ok(result.diagnostics.some(d => d.rule === 'INVALID_RATCHET'));
    });
});

describe('PhaseSpec interface', () => {
    test('has required fields: name, prompt, allowedPaths', () => {
        assert.ok(PhaseSpec, 'PhaseSpec should be exported');
        assert.equal(typeof PhaseSpec.validate, 'function');
        const result = PhaseSpec.validate({ name: 'p1', prompt: 'do stuff', allowedPaths: ['src/'] });
        assert.ok(result.valid);
    });

    test('has optional fields: dependsOn, contextOnSuccess, escalateOn, specFirst, goalGate, retryTarget, timeout, threadId, securityScan, coverageTarget, competing, redTeam, bddScenarios, docOnly', () => {
        const full = {
            name: 'p1',
            prompt: 'do stuff',
            allowedPaths: ['src/'],
            dependsOn: ['p0'],
            contextOnSuccess: { key: 'val' },
            escalateOn: ['*.lock'],
            specFirst: true,
            goalGate: true,
            retryTarget: 'fix_p1',
            timeout: '30m',
            threadId: 'phase_1',
            securityScan: true,
            coverageTarget: 80,
            competing: false,
            redTeam: false,
            bddScenarios: true,
            docOnly: false,
        };
        const result = PhaseSpec.validate(full);
        assert.ok(result.valid, 'full PhaseSpec with all optional fields should be valid');
    });

    test('docOnly suppresses verify chain', () => {
        const phase = { name: 'docs', prompt: 'write docs', allowedPaths: ['docs/'], docOnly: true };
        const result = PhaseSpec.validate(phase);
        assert.ok(result.valid);
        // docOnly phases should be flagged as such
        assert.equal(result.docOnly, true, 'validation result should reflect docOnly');
    });

    test('dependsOn references must be strings', () => {
        const result = PhaseSpec.validate({
            name: 'p1', prompt: 'x', allowedPaths: ['.'],
            dependsOn: [123],
        });
        assert.equal(result.valid, false);
    });

    test('rejects phase missing required fields', () => {
        const result = PhaseSpec.validate({});
        assert.equal(result.valid, false);
        // name + prompt required; allowedPaths now auto-corrected by preflight
        assert.ok(result.diagnostics.length >= 2);
    });
});

describe('BuildError', () => {
    test('extends Error', () => {
        const err = new BuildError('EMPTY_SLUG', 'slug is empty');
        assert.ok(err instanceof Error);
        assert.ok(err instanceof BuildError);
    });

    test('has code property matching BuildErrorCode', () => {
        const err = new BuildError('DUPLICATE_PHASE', 'dup');
        assert.equal(err.code, 'DUPLICATE_PHASE');
    });

    test('has diagnostics array defaulting to empty', () => {
        const err = new BuildError('EMPTY_GOAL', 'no goal');
        assert.ok(Array.isArray(err.diagnostics));
        assert.equal(err.diagnostics.length, 0);
    });

    test('accepts diagnostics in constructor', () => {
        const diag = { rule: 'EMPTY_GOAL', severity: 'error', message: 'goal is empty' };
        const err = new BuildError('EMPTY_GOAL', 'no goal', [diag]);
        assert.equal(err.diagnostics.length, 1);
        assert.equal(err.diagnostics[0].rule, 'EMPTY_GOAL');
    });

    test('name is BuildError', () => {
        const err = new BuildError('INVALID_SPEC', 'bad');
        assert.equal(err.name, 'BuildError');
    });

    test('message is set correctly', () => {
        const err = new BuildError('EMPTY_SLUG', 'slug cannot be empty');
        assert.equal(err.message, 'slug cannot be empty');
    });
});

describe('Diagnostic', () => {
    test('has required fields: rule, severity, message', () => {
        assert.ok(Diagnostic, 'Diagnostic should be exported');
        const d = Diagnostic.create({ rule: 'EMPTY_SLUG', severity: 'error', message: 'bad' });
        assert.equal(d.rule, 'EMPTY_SLUG');
        assert.equal(d.severity, 'error');
        assert.equal(d.message, 'bad');
    });

    test('has optional fields: nodeId, edge, fix', () => {
        const d = Diagnostic.create({
            rule: 'UNREACHABLE_NODE',
            severity: 'warning',
            message: 'node unreachable',
            nodeId: 'impl_p1',
            edge: ['start', 'impl_p1'],
            fix: 'add edge from start',
        });
        assert.equal(d.nodeId, 'impl_p1');
        assert.deepEqual(d.edge, ['start', 'impl_p1']);
        assert.equal(d.fix, 'add edge from start');
    });

    test('severity must be error, warning, or info', () => {
        assert.throws(() => {
            Diagnostic.create({ rule: 'x', severity: 'fatal', message: 'y' });
        });
    });

    test('edge must be a tuple of two strings', () => {
        assert.throws(() => {
            Diagnostic.create({ rule: 'x', severity: 'error', message: 'y', edge: ['only_one'] });
        });
    });
});

describe('BuildResult', () => {
    test('has all required fields: dot, slug, patternsApplied, defenseMatrix, diagnostics', () => {
        assert.ok(BuildResult, 'BuildResult should be exported');
        // Verify shape via a mock result
        const result = {
            dot: 'digraph {}',
            slug: 'test',
            patternsApplied: ['0a', '0b'],
            defenseMatrix: {
                competitive: false,
                guardrails: ['max_visits'],
                specDriven: 'NONE',
                permissions: ['allowed_paths'],
                adversarial: false,
            },
            diagnostics: [],
        };
        assert.equal(typeof BuildResult.validate, 'function');
        const validation = BuildResult.validate(result);
        assert.ok(validation.valid);
    });

    test('dot must be a non-empty string', () => {
        const validation = BuildResult.validate({ dot: '', slug: 's', patternsApplied: [], defenseMatrix: {}, diagnostics: [] });
        assert.equal(validation.valid, false);
    });

    test('patternsApplied must be string array', () => {
        const validation = BuildResult.validate({
            dot: 'digraph {}', slug: 's', patternsApplied: [1, 2],
            defenseMatrix: { competitive: false, guardrails: [], specDriven: 'NONE', permissions: [], adversarial: false },
            diagnostics: [],
        });
        assert.equal(validation.valid, false);
    });
});

describe('DefenseMatrix', () => {
    test('has all 5 fields: competitive, guardrails, specDriven, permissions, adversarial', () => {
        assert.ok(DefenseMatrix, 'DefenseMatrix should be exported');
        const dm = {
            competitive: true,
            guardrails: ['max_visits', 'no-op', 'read_only'],
            specDriven: 'BDD + conformance',
            permissions: ['allowed_paths', 'escalate_on'],
            adversarial: true,
        };
        assert.equal(typeof DefenseMatrix.validate, 'function');
        const result = DefenseMatrix.validate(dm);
        assert.ok(result.valid);
    });

    test('competitive and adversarial must be booleans', () => {
        const result = DefenseMatrix.validate({
            competitive: 'yes', guardrails: [], specDriven: 'NONE', permissions: [], adversarial: 0,
        });
        assert.equal(result.valid, false);
    });

    test('guardrails and permissions must be string arrays', () => {
        const result = DefenseMatrix.validate({
            competitive: false, guardrails: 'max_visits', specDriven: 'NONE', permissions: 42, adversarial: false,
        });
        assert.equal(result.valid, false);
    });

    test('specDriven must be one of the valid computed values', () => {
        const validValues = ['NONE', 'conformance', 'BDD + conformance', 'spec_file + conformance', 'spec_file + BDD + conformance'];
        for (const val of validValues) {
            const result = DefenseMatrix.validate({
                competitive: false, guardrails: [], specDriven: val, permissions: [], adversarial: false,
            });
            assert.ok(result.valid, `specDriven="${val}" should be valid`);
        }
        const bad = DefenseMatrix.validate({
            competitive: false, guardrails: [], specDriven: 'INVALID', permissions: [], adversarial: false,
        });
        assert.equal(bad.valid, false);
    });
});

describe('ValidationResult', () => {
    test('has valid boolean and diagnostics array', () => {
        assert.ok(ValidationResult, 'ValidationResult should be exported');
        const vr = { valid: true, diagnostics: [] };
        assert.equal(typeof vr.valid, 'boolean');
        assert.ok(Array.isArray(vr.diagnostics));
    });

    test('diagnostics entries conform to Diagnostic shape', () => {
        const vr = {
            valid: false,
            diagnostics: [{ rule: 'EMPTY_SLUG', severity: 'error', message: 'slug empty' }],
        };
        assert.equal(typeof ValidationResult.validate, 'function');
        const result = ValidationResult.validate(vr);
        assert.ok(result.valid);
    });
});

describe('BuildErrorCode union', () => {
    const EXPECTED_CODES = [
        'EMPTY_SLUG', 'EMPTY_GOAL', 'DUPLICATE_PHASE', 'INVALID_RATCHET',
        'NON_NUMERIC_TARGET', 'ALREADY_BUILT', 'INVALID_STRUCTURE', 'START_HAS_INCOMING',
        'UNREACHABLE_NODE', 'DIAMOND_MISSING_EDGES', 'GOAL_GATE_NO_MAX_VISITS',
        'MISSING_AC_MAPPING', 'MISSING_TIMEOUT', 'PROMPT_PATH_MISMATCH',
        'REVIEW_MISSING_READONLY', 'COMPONENT_NO_MERGE', 'FAN_OUT_SCOPE_LEAK',
        'WORKSPACE_NO_HTTPS', 'WORKSPACE_NO_PUSH', 'PLAN_MODE_DEADLOCK',
        'MISSING_ALLOWED_PATHS', 'INVALID_SPEC', 'INVALID_TIMEOUT', 'INVALID_ALLOWED_PATHS',
        'DUPLICATE_MODEL', 'INVALID_CONVERGENCE_SPEC',
    ];

    test('BUILD_ERROR_CODES contains all 26 codes', () => {
        assert.ok(BUILD_ERROR_CODES, 'BUILD_ERROR_CODES should be exported');
        assert.ok(Array.isArray(BUILD_ERROR_CODES) || BUILD_ERROR_CODES instanceof Set,
            'BUILD_ERROR_CODES should be iterable');
        const codes = [...BUILD_ERROR_CODES];
        assert.equal(codes.length, 26, `expected 26 codes, got ${codes.length}`);
    });

    test('every expected code is present', () => {
        const codes = new Set([...BUILD_ERROR_CODES]);
        for (const code of EXPECTED_CODES) {
            assert.ok(codes.has(code), `missing code: ${code}`);
        }
    });

    test('no unexpected codes exist', () => {
        const expected = new Set(EXPECTED_CODES);
        for (const code of BUILD_ERROR_CODES) {
            assert.ok(expected.has(code), `unexpected code: ${code}`);
        }
    });
});

describe('MicroverseOpts', () => {
    test('has required fields: prompt, measureCommand, target, direction, allowedPaths', () => {
        assert.ok(MicroverseOpts, 'MicroverseOpts should be exported');
        const opts = {
            prompt: 'optimize',
            measureCommand: 'echo 42',
            target: 10,
            direction: 'reduce',
            allowedPaths: ['src/'],
        };
        const result = MicroverseOpts.validate(opts);
        assert.ok(result.valid);
    });

    test('has optional fields: timeout, maxVisits', () => {
        const opts = {
            prompt: 'optimize',
            measureCommand: 'echo 42',
            target: 10,
            direction: 'improve',
            allowedPaths: ['src/'],
            timeout: '45m',
            maxVisits: 12,
        };
        const result = MicroverseOpts.validate(opts);
        assert.ok(result.valid);
    });

    test('direction must be reduce or improve', () => {
        const result = MicroverseOpts.validate({
            prompt: 'p', measureCommand: 'echo 1', target: 0,
            direction: 'minimize', allowedPaths: ['.'],
        });
        assert.equal(result.valid, false);
    });

    test('maxVisits must be positive integer >= 1', () => {
        const result = MicroverseOpts.validate({
            prompt: 'p', measureCommand: 'echo 1', target: 0,
            direction: 'reduce', allowedPaths: ['.'], maxVisits: 0,
        });
        assert.equal(result.valid, false);
    });
});

describe('WorkspaceOpts', () => {
    test('has optional fields: repoUrl, repoBranch, cleanup', () => {
        assert.ok(WorkspaceOpts, 'WorkspaceOpts should be exported');
        const opts = {
            repoUrl: 'https://github.com/org/repo',
            repoBranch: 'main',
            cleanup: 'delete',
        };
        const result = WorkspaceOpts.validate(opts);
        assert.ok(result.valid);
    });

    test('cleanup must be delete or preserve', () => {
        const result = WorkspaceOpts.validate({ cleanup: 'archive' });
        assert.equal(result.valid, false, 'archive was removed from valid cleanup values');
    });

    test('empty object is valid (all fields optional)', () => {
        const result = WorkspaceOpts.validate({});
        assert.ok(result.valid);
    });
});

describe('StylesheetConfig', () => {
    test('has required field: defaultModel', () => {
        assert.ok(StylesheetConfig, 'StylesheetConfig should be exported');
        const config = { defaultModel: 'claude-sonnet-4-6' };
        const result = StylesheetConfig.validate(config);
        assert.ok(result.valid);
    });

    test('has optional fields: defaultProvider, criticalModel, criticalProvider, reviewModel, reviewProvider, reasoningEffort', () => {
        const config = {
            defaultModel: 'claude-sonnet-4-6',
            defaultProvider: 'anthropic',
            criticalModel: 'claude-opus-4-6',
            criticalProvider: 'anthropic',
            reviewModel: 'claude-sonnet-4-6',
            reviewProvider: 'anthropic',
            reasoningEffort: 'high',
        };
        const result = StylesheetConfig.validate(config);
        assert.ok(result.valid);
    });

    test('rejects missing defaultModel', () => {
        const result = StylesheetConfig.validate({});
        assert.equal(result.valid, false);
    });
});

// ---------------------------------------------------------------------------
// DotBuilder BDD scenarios — RED phase (no production code exists yet)
// ---------------------------------------------------------------------------

/** Helper: minimal valid spec for DotBuilder construction */
function validSpec() {
    return {
        slug: 'test-pipeline',
        goal: 'Build something cool',
        phases: [],
        acceptanceCriteria: {},
    };
}

/** Helper: minimal valid phase */
function validPhase(name = 'impl', prompt = 'implement the thing') {
    return { name, prompt, allowedPaths: ['src/'], timeout: '30m' };
}

describe('DotBuilder constructor validation', () => {
    test('accepts a valid BuilderSpec', () => {
        const builder = new DotBuilder(validSpec());
        assert.ok(builder, 'constructor should return a builder instance');
    });

    test('throws BuildError with EMPTY_SLUG for empty slug', () => {
        assert.throws(
            () => new DotBuilder({ ...validSpec(), slug: '' }),
            (err) => err instanceof BuildError && err.code === 'EMPTY_SLUG',
        );
    });

    test('throws BuildError with EMPTY_SLUG for whitespace-only slug', () => {
        assert.throws(
            () => new DotBuilder({ ...validSpec(), slug: '   ' }),
            (err) => err instanceof BuildError && err.code === 'EMPTY_SLUG',
        );
    });

    test('throws BuildError with EMPTY_GOAL for empty goal', () => {
        assert.throws(
            () => new DotBuilder({ ...validSpec(), goal: '' }),
            (err) => err instanceof BuildError && err.code === 'EMPTY_GOAL',
        );
    });

    test('throws BuildError with EMPTY_GOAL for whitespace-only goal', () => {
        assert.throws(
            () => new DotBuilder({ ...validSpec(), goal: '\t\n' }),
            (err) => err instanceof BuildError && err.code === 'EMPTY_GOAL',
        );
    });

    test('throws BuildError with INVALID_RATCHET when reviewRatchet < 2', () => {
        assert.throws(
            () => new DotBuilder({ ...validSpec(), reviewRatchet: 1 }),
            (err) => err instanceof BuildError && err.code === 'INVALID_RATCHET',
        );
    });

    test('accepts reviewRatchet of exactly 2', () => {
        const builder = new DotBuilder({ ...validSpec(), reviewRatchet: 2 });
        assert.ok(builder);
    });
});

describe('DotBuilder.phase() fluent chaining', () => {
    test('returns the builder instance for chaining', () => {
        const builder = new DotBuilder(validSpec());
        const returned = builder.phase(validPhase('p1'));
        assert.strictEqual(returned, builder, 'phase() must return this');
    });

    test('supports chaining multiple phases', () => {
        const builder = new DotBuilder(validSpec());
        const result = builder
            .phase(validPhase('p1', 'first'))
            .phase(validPhase('p2', 'second'))
            .phase(validPhase('p3', 'third'));
        assert.strictEqual(result, builder);
    });

    test('phases added via chaining appear in build output', () => {
        const builder = new DotBuilder(validSpec());
        builder
            .phase(validPhase('alpha', 'do alpha'))
            .phase({ ...validPhase('beta', 'do beta'), dependsOn: ['alpha'] });
        const result = builder.build();
        assert.ok(result.dot.includes('alpha'), 'DOT should contain phase alpha');
        assert.ok(result.dot.includes('beta'), 'DOT should contain phase beta');
    });
});

describe('DotBuilder duplicate phase detection', () => {
    test('throws DUPLICATE_PHASE for exact name match', () => {
        const builder = new DotBuilder(validSpec());
        builder.phase(validPhase('auth'));
        assert.throws(
            () => builder.phase(validPhase('auth')),
            (err) => err instanceof BuildError && err.code === 'DUPLICATE_PHASE',
        );
    });

    test('throws DUPLICATE_PHASE for sanitized collision: "auth scan" vs "auth-scan"', () => {
        const builder = new DotBuilder(validSpec());
        builder.phase(validPhase('auth scan'));
        assert.throws(
            () => builder.phase(validPhase('auth-scan')),
            (err) => err instanceof BuildError && err.code === 'DUPLICATE_PHASE',
        );
    });

    test('throws DUPLICATE_PHASE for sanitized collision: "Auth Scan" vs "auth_scan"', () => {
        const builder = new DotBuilder(validSpec());
        builder.phase(validPhase('Auth Scan'));
        assert.throws(
            () => builder.phase(validPhase('auth_scan')),
            (err) => err instanceof BuildError && err.code === 'DUPLICATE_PHASE',
        );
    });

    test('throws DUPLICATE_PHASE for sanitized collision with special chars', () => {
        const builder = new DotBuilder(validSpec());
        builder.phase(validPhase('run tests!'));
        assert.throws(
            () => builder.phase(validPhase('run-tests')),
            (err) => err instanceof BuildError && err.code === 'DUPLICATE_PHASE',
        );
    });

    test('allows phases with different sanitized IDs', () => {
        const builder = new DotBuilder(validSpec());
        builder.phase(validPhase('auth'));
        builder.phase(validPhase('deploy'));
        assert.ok(true, 'no error thrown');
    });
});

describe('DotBuilder.build() single-use guard', () => {
    test('returns a BuildResult on first call', () => {
        const builder = new DotBuilder(validSpec());
        builder.phase(validPhase('impl'));
        const result = builder.build();
        assert.ok(result, 'build() should return a result');
        assert.equal(typeof result.dot, 'string');
        assert.equal(result.slug, 'test-pipeline');
        assert.ok(Array.isArray(result.patternsApplied));
        assert.ok(Array.isArray(result.diagnostics));
    });

    test('throws ALREADY_BUILT on second call', () => {
        const builder = new DotBuilder(validSpec());
        builder.phase(validPhase('impl'));
        builder.build();
        assert.throws(
            () => builder.build(),
            (err) => err instanceof BuildError && err.code === 'ALREADY_BUILT',
        );
    });

    test('throws ALREADY_BUILT even if first build had warnings', () => {
        const builder = new DotBuilder(validSpec());
        builder.phase(validPhase('impl'));
        builder.build(); // may have diagnostics
        assert.throws(
            () => builder.build(),
            (err) => err instanceof BuildError && err.code === 'ALREADY_BUILT',
        );
    });

    test('phase() throws after build() has been called', () => {
        const builder = new DotBuilder(validSpec());
        builder.phase(validPhase('impl'));
        builder.build();
        assert.throws(
            () => builder.phase(validPhase('late')),
            (err) => err instanceof BuildError && err.code === 'ALREADY_BUILT',
        );
    });
});

describe('DOT emission: Mdiamond and Msquare shapes', () => {
    test('start node has shape=Mdiamond', () => {
        const builder = new DotBuilder(validSpec());
        builder.phase(validPhase('impl'));
        const { dot } = builder.build();
        assert.match(dot, /start\s*\[.*shape\s*=\s*"?Mdiamond"?/, 'start node must use Mdiamond');
    });

    test('exit node has shape=Msquare', () => {
        const builder = new DotBuilder(validSpec());
        builder.phase(validPhase('impl'));
        const { dot } = builder.build();
        assert.match(dot, /exit\s*\[.*shape\s*=\s*"?Msquare"?/, 'exit node must use Msquare');
    });

    test('output begins with "digraph"', () => {
        const builder = new DotBuilder(validSpec());
        builder.phase(validPhase('impl'));
        const { dot } = builder.build();
        assert.match(dot, /^digraph\s/, 'DOT must start with "digraph"');
    });

    test('output contains graph label with slug', () => {
        const builder = new DotBuilder({ ...validSpec(), slug: 'my-pipeline' });
        builder.phase(validPhase('impl'));
        const { dot } = builder.build();
        assert.ok(dot.includes('my-pipeline'), 'DOT should contain the slug');
    });
});

describe('DOT emission: string escaping', () => {
    test('escapes double quotes in labels', () => {
        const builder = new DotBuilder(validSpec());
        builder.phase(validPhase('impl', 'say "hello" world'));
        const { dot } = builder.build();
        // DOT requires \" inside quoted strings
        assert.ok(dot.includes('\\"hello\\"') || dot.includes('say \\"hello\\" world'),
            'double quotes must be escaped in DOT output');
    });

    test('escapes backslashes in labels', () => {
        const builder = new DotBuilder(validSpec());
        builder.phase(validPhase('impl', 'path\\to\\thing'));
        const { dot } = builder.build();
        assert.ok(dot.includes('path\\\\to\\\\thing'),
            'backslashes must be escaped in DOT output');
    });

    test('escapes newlines in labels', () => {
        const builder = new DotBuilder(validSpec());
        builder.phase(validPhase('impl', 'line1\nline2'));
        const { dot } = builder.build();
        assert.ok(dot.includes('line1\\nline2') || dot.includes('line1\\\\nline2'),
            'newlines must be escaped in DOT output');
    });

    test('handles combined special characters', () => {
        const builder = new DotBuilder(validSpec());
        builder.phase(validPhase('impl', 'he said "no\\way"\nnope'));
        const { dot } = builder.build();
        // Should not contain raw unescaped quotes or newlines
        assert.ok(!dot.includes('"no\\way"') || dot.includes('\\"no\\\\way\\"'),
            'combined special chars must all be escaped');
    });
});

describe('Node ID sanitization', () => {
    test('lowercases the phase name', () => {
        const builder = new DotBuilder(validSpec());
        builder.phase(validPhase('MyPhase'));
        const { dot } = builder.build();
        assert.ok(dot.includes('myphase'), 'node ID should be lowercased');
        assert.ok(!dot.match(/\bMyPhase\b.*\[/), 'original case should not appear as node ID');
    });

    test('replaces spaces with underscores', () => {
        const builder = new DotBuilder(validSpec());
        builder.phase(validPhase('run tests'));
        const { dot } = builder.build();
        assert.match(dot, /run_tests/, 'spaces should become underscores in node ID');
    });

    test('replaces hyphens with underscores', () => {
        const builder = new DotBuilder(validSpec());
        builder.phase(validPhase('auth-scan'));
        const { dot } = builder.build();
        assert.match(dot, /auth_scan/, 'hyphens should become underscores in node ID');
    });

    test('strips non-alphanumeric/underscore characters', () => {
        const builder = new DotBuilder(validSpec());
        builder.phase(validPhase('run tests!@#'));
        const { dot } = builder.build();
        assert.match(dot, /run_tests/, 'special chars should be stripped from node ID');
        assert.ok(!dot.includes('!') && !dot.includes('@') && !dot.includes('#'),
            'special chars should not appear in DOT');
    });

    test('prefixes numeric-leading IDs with underscore', () => {
        const builder = new DotBuilder(validSpec());
        builder.phase(validPhase('123start'));
        const { dot } = builder.build();
        // DOT identifiers cannot start with digits
        assert.match(dot, /_123start/, 'numeric-leading ID should be prefixed');
    });
});

describe('Attribute formatting', () => {
    test('attributes are alphabetically ordered', () => {
        const builder = new DotBuilder(validSpec());
        builder.phase(validPhase('impl'));
        const { dot } = builder.build();
        // Find a node with multiple attributes and verify order
        // start node should have at least label and shape
        const startMatch = dot.match(/start\s*\[([^\]]+)\]/);
        assert.ok(startMatch, 'start node should have attributes');
        const attrs = startMatch[1];
        const keys = [...attrs.matchAll(/(\w+)\s*=/g)].map(m => m[1]);
        const sorted = [...keys].sort();
        assert.deepEqual(keys, sorted, `attributes should be alphabetical: got [${keys}], expected [${sorted}]`);
    });

    test('attribute values are double-quoted', () => {
        const builder = new DotBuilder(validSpec());
        builder.phase(validPhase('impl'));
        const { dot } = builder.build();
        // Every DOT node/edge attribute assignment should use double quotes around the value
        // Extract bracket-delimited attr sections, then parse top-level key=value assignments
        const bracketSections = [...dot.matchAll(/\[([^\]]+)\]/g)].map(m => m[1]);
        assert.ok(bracketSections.length > 0, 'should have bracket-delimited attribute sections');
        for (const section of bracketSections) {
            // Split on commas that are outside quotes to get individual key=value pairs
            const pairs = [];
            let current = '';
            let inQuote = false;
            for (const ch of section) {
                if (ch === '"') inQuote = !inQuote;
                else if (ch === ',' && !inQuote) { pairs.push(current.trim()); current = ''; continue; }
                current += ch;
            }
            if (current.trim()) pairs.push(current.trim());
            for (const pair of pairs) {
                const eqIdx = pair.indexOf('=');
                if (eqIdx < 0) continue;
                const key = pair.slice(0, eqIdx).trim();
                const val = pair.slice(eqIdx + 1).trim();
                if (key === 'rankdir' || key === 'compound') continue;
                assert.ok(val.startsWith('"'), `value for ${key} should start with quote: ${key}=${val}`);
            }
        }
    });

    test('node attributes use consistent formatting', () => {
        const builder = new DotBuilder(validSpec());
        builder.phase(validPhase('alpha'));
        builder.phase({ ...validPhase('beta'), dependsOn: ['alpha'] });
        const { dot } = builder.build();
        // All node declarations should follow pattern: id [key="val", key="val"]
        const nodeLines = dot.split('\n').filter(l => l.match(/^\s+\w+\s*\[/));
        assert.ok(nodeLines.length >= 2, 'should have at least start and exit nodes plus phases');
        for (const line of nodeLines) {
            assert.match(line, /\[.*\]/, `node line should have bracket-delimited attrs: ${line}`);
        }
    });
});

// ---------------------------------------------------------------------------
// Adversarial audit — crash/validation tests for edge cases
// ---------------------------------------------------------------------------

describe('Adversarial: empty/invalid phase names', () => {
    test('empty string phase name throws BuildError', () => {
        const builder = new DotBuilder(validSpec());
        assert.throws(
            () => builder.phase(validPhase('')),
            (err) => err instanceof BuildError,
            'empty phase name must throw BuildError, not produce empty node ID',
        );
    });

    test('emoji-only phase name throws BuildError', () => {
        const builder = new DotBuilder(validSpec());
        assert.throws(
            () => builder.phase(validPhase('\u{1F525}\u{1F680}')),
            (err) => err instanceof BuildError,
            'emoji-only phase name sanitizes to empty string — must throw',
        );
    });

    test('CJK-only phase name throws BuildError', () => {
        const builder = new DotBuilder(validSpec());
        assert.throws(
            () => builder.phase(validPhase('\u6D4B\u8BD5\u9636\u6BB5')),
            (err) => err instanceof BuildError,
            'CJK-only phase name sanitizes to empty string — must throw',
        );
    });

    test('RTL-only phase name throws BuildError', () => {
        const builder = new DotBuilder(validSpec());
        assert.throws(
            () => builder.phase(validPhase('\u0645\u0631\u062D\u0644\u0629')),
            (err) => err instanceof BuildError,
            'RTL-only phase name sanitizes to empty string — must throw',
        );
    });

    test('zero-width unicode phase name (U+200B, U+FEFF) throws BuildError', () => {
        const builder = new DotBuilder(validSpec());
        assert.throws(
            () => builder.phase(validPhase('\u200B\uFEFF')),
            (err) => err instanceof BuildError,
            'zero-width chars sanitize to empty string — must throw',
        );
    });
});

describe('Adversarial: timeout validation', () => {
    test('timeout without unit suffix (e.g. "30") throws BuildError with INVALID_TIMEOUT', () => {
        assert.throws(
            () => DotBuilder.fromSpec({
                ...validSpec(),
                phases: [{ name: 'impl', prompt: 'do stuff', allowedPaths: ['src/'], timeout: '30' }],
            }).build(),
            (err) => err instanceof BuildError && err.code === 'INVALID_TIMEOUT',
            'timeout="30" (missing unit) must throw INVALID_TIMEOUT',
        );
    });

    test('timeout="0m" throws BuildError with INVALID_TIMEOUT', () => {
        assert.throws(
            () => DotBuilder.fromSpec({
                ...validSpec(),
                phases: [{ name: 'impl', prompt: 'do stuff', allowedPaths: ['src/'], timeout: '0m' }],
            }).build(),
            (err) => err instanceof BuildError && err.code === 'INVALID_TIMEOUT',
            'timeout="0m" (zero duration) must throw INVALID_TIMEOUT',
        );
    });
});

describe('Adversarial: allowedPaths validation', () => {
    test('absolute paths in allowedPaths throw BuildError with INVALID_ALLOWED_PATHS', () => {
        assert.throws(
            () => DotBuilder.fromSpec({
                ...validSpec(),
                phases: [{ name: 'impl', prompt: 'do stuff', allowedPaths: ['/etc/passwd'], timeout: '30m' }],
            }).build(),
            (err) => err instanceof BuildError && err.code === 'INVALID_ALLOWED_PATHS',
            'absolute paths in allowedPaths must throw INVALID_ALLOWED_PATHS',
        );
    });

    test('path traversal (../../etc/passwd) in allowedPaths throws BuildError', () => {
        assert.throws(
            () => DotBuilder.fromSpec({
                ...validSpec(),
                phases: [{ name: 'impl', prompt: 'do stuff', allowedPaths: ['../../etc/passwd'], timeout: '30m' }],
            }).build(),
            (err) => err instanceof BuildError && err.code === 'INVALID_ALLOWED_PATHS',
            'path traversal in allowedPaths must throw INVALID_ALLOWED_PATHS',
        );
    });
});

describe('Adversarial: circular dependency detection', () => {
    test('circular dependsOn (A->B->C->A) throws BuildError', () => {
        assert.throws(
            () => DotBuilder.fromSpec({
                ...validSpec(),
                phases: [
                    { name: 'alpha', prompt: 'a', allowedPaths: ['src/'], timeout: '30m', dependsOn: ['charlie'] },
                    { name: 'beta', prompt: 'b', allowedPaths: ['src/'], timeout: '30m', dependsOn: ['alpha'] },
                    { name: 'charlie', prompt: 'c', allowedPaths: ['src/'], timeout: '30m', dependsOn: ['beta'] },
                ],
            }).build(),
            (err) => err instanceof BuildError,
            'circular dependencies must throw BuildError — infinite loops in pipeline',
        );
    });
});

describe('Adversarial: DOT injection safety', () => {
    test('prompt containing closing brace and digraph injection is safely escaped', () => {
        const builder = new DotBuilder(validSpec());
        builder.phase(validPhase('impl', '}\ndigraph evil { evil [label="pwned"]'));
        const { dot } = builder.build();
        const digraphCount = (dot.match(/^digraph\s/gm) || []).length;
        assert.equal(digraphCount, 1, 'only one digraph declaration should exist — injection must be escaped');
        assert.ok(!dot.includes('\nevil ['), 'injected node should not appear as real DOT node');
    });
});

describe('Adversarial: stress test', () => {
    test('>100 phases does not crash', () => {
        const phases = [];
        for (let i = 0; i < 101; i++) {
            phases.push({ name: `phase_${i}`, prompt: `step ${i}`, allowedPaths: ['src/'], timeout: '30m' });
        }
        const result = DotBuilder.fromSpec({ ...validSpec(), phases }).build();
        assert.ok(result.dot.includes('digraph'), 'should produce valid DOT');
        assert.ok(result.dot.includes('phase_100'), 'should contain last phase');
    });
});

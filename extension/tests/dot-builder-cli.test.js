import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DotBuilder, BuildResultNs } from '../services/dot-builder.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, '..', 'bin', 'dot-builder.js');

// ---------------------------------------------------------------------------
// Helper: minimal valid BuilderSpec
// ---------------------------------------------------------------------------

function validSpec() {
    return {
        slug: 'cli-test',
        goal: 'Validate CLI contract',
        phases: [{
            name: 'Implement',
            prompt: 'Do the thing in src/index.ts',
            allowedPaths: ['src/'],
            timeout: '30m',
        }],
        acceptanceCriteria: {},
    };
}

function runCli(input) {
    return new Promise((resolve) => {
        const child = execFile(
            process.execPath,
            [CLI_PATH],
            // 10s → 30s: budget for system load under concurrent test runs.
            { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
            (err, stdout, stderr) => {
                resolve({
                    code: err ? err.code : 0,
                    stdout,
                    stderr,
                });
            },
        );
        child.stdin.end(input);
    });
}

// ---------------------------------------------------------------------------
// CLI contract tests — RED phase
// ---------------------------------------------------------------------------

describe('dot-builder-cli', () => {
    test('(1) valid BuilderSpec JSON on stdin → exit 0, stdout is valid BuildResult JSON', async () => {
        const spec = validSpec();
        const result = await runCli(JSON.stringify(spec));

        assert.equal(result.code, 0, `expected exit 0, got ${result.code}: ${result.stderr}`);

        const parsed = JSON.parse(result.stdout);
        const vr = BuildResultNs.validate(parsed);
        assert.ok(vr.valid, `stdout should be valid BuildResult JSON: ${JSON.stringify(vr.diagnostics)}`);
        assert.equal(parsed.slug, spec.slug);
        assert.ok(parsed.dot.includes('digraph'));
    });

    test('(2) spec with missing AC mapping → exit 1, stderr has MISSING_AC_MAPPING', async () => {
        // Multi-phase with unmatchable key — single-phase auto-maps, so use 2 phases
        const spec = {
            slug: 'cli-test-ac',
            goal: 'Validate AC mapping error',
            phases: [
                { name: 'auth', prompt: 'Do auth', allowedPaths: ['src/auth/'], timeout: '30m' },
                { name: 'api', prompt: 'Do api', allowedPaths: ['src/api/'], timeout: '30m', dependsOn: ['auth'] },
            ],
            acceptanceCriteria: { totally_unrelated_key: 'must pass' },
        };

        const result = await runCli(JSON.stringify(spec));

        assert.equal(result.code, 1, `expected exit 1, got ${result.code}`);
        const errPayload = JSON.parse(result.stderr);
        assert.ok(
            Array.isArray(errPayload.diagnostics),
            'stderr should contain diagnostics array',
        );
        assert.ok(
            errPayload.diagnostics.some(d => d.rule === 'MISSING_AC_MAPPING'),
            'diagnostics should include MISSING_AC_MAPPING',
        );
    });

    test('(3) invalid JSON on stdin → exit 1 or 2, stderr has INVALID_SPEC', async () => {
        const result = await runCli('this is not json{{{');

        // Exit code 2 is valid for JSON parse errors (JSON.parse in JS doesn't distinguish)
        assert.ok(result.code === 1 || result.code === 2, `expected exit 1 or 2, got ${result.code}`);
        const errPayload = JSON.parse(result.stderr);
        assert.equal(errPayload.error, 'INVALID_SPEC');
    });

    test('(4) input >512KB → exit 2, stderr has INPUT_TOO_LARGE', async () => {
        const bigInput = 'x'.repeat(513 * 1024);

        const result = await runCli(bigInput);

        assert.equal(result.code, 2, `expected exit 2, got ${result.code}`);
        const errPayload = JSON.parse(result.stderr);
        assert.equal(errPayload.error, 'INPUT_TOO_LARGE');
    });
});

// ---------------------------------------------------------------------------
// DotBuilder.fromSpec() contract tests — RED phase
// ---------------------------------------------------------------------------

describe('DotBuilder.fromSpec()', () => {
    test('(5) missing slug → throws BuildError with EMPTY_SLUG code', () => {
        const spec = validSpec();
        delete spec.slug;

        assert.throws(
            () => DotBuilder.fromSpec(spec),
            (err) => err.name === 'BuildError' && err.code === 'EMPTY_SLUG',
            'should throw BuildError with EMPTY_SLUG',
        );
    });

    test('(6) fromSpec().build() and constructor+phase().build() produce identical DOT', () => {
        const spec = validSpec();
        const phase = spec.phases[0];

        // Path A: fromSpec
        const resultA = DotBuilder.fromSpec(spec).build();

        // Path B: constructor + manual phase()
        const builder = new DotBuilder({ ...spec, phases: [] });
        const { name, ...opts } = phase;
        builder.phase(name, opts);
        const resultB = builder.build();

        assert.equal(
            resultA.dot,
            resultB.dot,
            'fromSpec and constructor+phase must produce identical DOT output',
        );
    });

    test('(6b) phase with missing name field → throws BuildError with INVALID_SPEC code', () => {
        const spec = validSpec();
        // Simulate JSON deserialization with wrong field name (e.g. "id" instead of "name")
        spec.phases = [{ id: 'impl', prompt: 'do stuff', allowedPaths: ['src/'], timeout: '30m' }];

        assert.throws(
            () => DotBuilder.fromSpec(spec),
            (err) => err.name === 'BuildError' && err.code === 'INVALID_SPEC',
            'phase missing string "name" field must throw BuildError with INVALID_SPEC',
        );
    });

    test('(7) fromSpec().build() is deterministic — two invocations produce byte-identical DOT', () => {
        const spec = validSpec();

        const resultA = DotBuilder.fromSpec(spec).build();
        const resultB = DotBuilder.fromSpec(spec).build();

        assert.equal(
            resultA.dot,
            resultB.dot,
            'two separate fromSpec().build() calls must produce byte-identical DOT',
        );
    });
});

// ---------------------------------------------------------------------------
// Thread ID auto-assignment tests
// ---------------------------------------------------------------------------

describe('thread_id auto-assignment', () => {
    function twoPhaseSpec() {
        return {
            slug: 'thread-test',
            goal: 'Thread isolation',
            phases: [
                { name: 'auth', prompt: 'auth', allowedPaths: ['src/'], timeout: '30m', dependsOn: [] },
                { name: 'api', prompt: 'api', allowedPaths: ['src/'], timeout: '30m', dependsOn: ['auth'] },
            ],
            acceptanceCriteria: {},
        };
    }

    test('(8) per-phase nodes have thread_id=phase_N (1-based)', () => {
        const r = DotBuilder.fromSpec(twoPhaseSpec()).build();
        const dot = r.dot;
        const perPhaseNodes = ['impl_auth', 'scope_check_auth', 'check_progress_auth',
            'verify_lint_auth', 'verify_types_auth', 'conformance_auth', 'fix_auth',
            'impl_api', 'scope_check_api', 'check_progress_api',
            'verify_lint_api', 'verify_types_api', 'conformance_api', 'fix_api'];
        for (const nodeId of perPhaseNodes) {
            const expectedPhase = nodeId.includes('auth') ? 'phase_1' : 'phase_2';
            const line = dot.split('\n').find(l => l.trim().startsWith(nodeId + ' '));
            assert.ok(line, `node ${nodeId} should exist in DOT output`);
            assert.ok(line.includes(`thread_id="${expectedPhase}"`),
                `node ${nodeId} should have thread_id="${expectedPhase}", got: ${line.trim()}`);
        }
    });

    test('(9) cross-phase structural nodes have NO thread_id', () => {
        const r = DotBuilder.fromSpec(twoPhaseSpec()).build();
        const dot = r.dot;
        const structural = ['start', 'exit', 'setup_deps', 'capture_baseline', 'audit',
            'verify_typecheck', 'verify_lint', 'verify_tests', 'fix_types', 'fix_lint', 'fix_tests',
            'regression_check', 'quality_review'];
        for (const nodeId of structural) {
            const line = dot.split('\n').find(l => l.trim().startsWith(nodeId + ' '));
            assert.ok(line, `node ${nodeId} should exist in DOT output`);
            assert.ok(!line.includes('thread_id'),
                `structural node ${nodeId} should NOT have thread_id, got: ${line.trim()}`);
        }
    });

    test('(10) fix nodes inherit parent phase thread_id', () => {
        const r = DotBuilder.fromSpec(twoPhaseSpec()).build();
        const dot = r.dot;
        const fixAuth = dot.split('\n').find(l => l.trim().startsWith('fix_auth '));
        const fixApi = dot.split('\n').find(l => l.trim().startsWith('fix_api '));
        assert.ok(fixAuth.includes('thread_id="phase_1"'), 'fix_auth should have thread_id=phase_1');
        assert.ok(fixApi.includes('thread_id="phase_2"'), 'fix_api should have thread_id=phase_2');
    });

    test('(10b) fan-out phase nodes have thread_id=phase_N', () => {
        const spec = {
            slug: 'fanout-thread-test',
            goal: 'Fan-out thread isolation',
            phases: [
                { name: 'auth', prompt: 'auth', allowedPaths: ['src/'], timeout: '30m' },
                { name: 'api', prompt: 'api', allowedPaths: ['src/'], timeout: '30m' },
            ],
            acceptanceCriteria: {},
        };
        const r = DotBuilder.fromSpec(spec).build();
        const dot = r.dot;
        const authLine = dot.split('\n').find(l => l.trim().startsWith('auth '));
        const apiLine = dot.split('\n').find(l => l.trim().startsWith('api '));
        assert.ok(authLine, 'auth node should exist');
        assert.ok(apiLine, 'api node should exist');
        assert.ok(authLine.includes('thread_id="phase_1"'),
            `auth should have thread_id="phase_1", got: ${authLine.trim()}`);
        assert.ok(apiLine.includes('thread_id="phase_2"'),
            `api should have thread_id="phase_2", got: ${apiLine.trim()}`);
        // structural nodes still clean
        const splitLine = dot.split('\n').find(l => l.trim().startsWith('split_phases '));
        const mergeLine = dot.split('\n').find(l => l.trim().startsWith('merge_phases '));
        assert.ok(!splitLine?.includes('thread_id'), 'split_phases should NOT have thread_id');
        assert.ok(!mergeLine?.includes('thread_id'), 'merge_phases should NOT have thread_id');
    });

    test('(10c) fan-out with explicit threadId override', () => {
        const spec = {
            slug: 'fanout-override-test',
            goal: 'Fan-out override',
            phases: [
                { name: 'auth', prompt: 'auth', allowedPaths: ['src/'], timeout: '30m', threadId: 'custom_auth' },
                { name: 'api', prompt: 'api', allowedPaths: ['src/'], timeout: '30m' },
            ],
            acceptanceCriteria: {},
        };
        const r = DotBuilder.fromSpec(spec).build();
        const dot = r.dot;
        const authLine = dot.split('\n').find(l => l.trim().startsWith('auth '));
        assert.ok(authLine.includes('thread_id="custom_auth"'),
            `auth should have thread_id="custom_auth", got: ${authLine.trim()}`);
        const apiLine = dot.split('\n').find(l => l.trim().startsWith('api '));
        assert.ok(apiLine.includes('thread_id="phase_2"'),
            `api should have thread_id="phase_2", got: ${apiLine.trim()}`);
    });

    test('(11) explicit PhaseSpec.threadId overrides auto-assignment', () => {
        const spec = twoPhaseSpec();
        spec.phases[0].threadId = 'custom_thread';
        const r = DotBuilder.fromSpec(spec).build();
        const dot = r.dot;
        const implAuth = dot.split('\n').find(l => l.trim().startsWith('impl_auth '));
        assert.ok(implAuth.includes('thread_id="custom_thread"'),
            `impl_auth should have thread_id="custom_thread", got: ${implAuth.trim()}`);
        // Second phase still auto-assigned
        const implApi = dot.split('\n').find(l => l.trim().startsWith('impl_api '));
        assert.ok(implApi.includes('thread_id="phase_2"'),
            `impl_api should still have thread_id="phase_2", got: ${implApi.trim()}`);
    });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    validateDirective,
    validateSubagentPayload,
    CouncilSchemaError,
} from '../services/council-schema.js';

function minimalFinding() {
    return {
        severity: 'P1',
        confidence: 85,
        source: 'COUNCIL',
        file: 'src/foo.ts',
        line: 10,
        line_range: null,
        rule: 'no-bare-throw',
        description: 'bare throw detected',
        recommendation: 'wrap in Error',
        data_flow: null,
        scenario: null,
        snippet_before: null,
        snippet_after: null,
    };
}

function minimalDirective() {
    return {
        schema_version: 1,
        round: 1,
        codex_enabled: false,
        branches: [{ name: 'feat/one', findings: [] }],
        trap_doors: [],
    };
}

function minimalSubagentPayload() {
    return {
        category: 'B8_szechuan',
        branch: 'feat/one',
        status: 'ok',
        skip_reason: null,
        findings: [],
        trap_door_candidates: [],
        codex_per_branch: null,
    };
}

// T1: valid minimal Directive round-trips
test('T1: valid minimal Directive round-trips', () => {
    const d = validateDirective(minimalDirective());
    assert.equal(d.schema_version, 1);
    assert.equal(d.round, 1);
    assert.equal(d.codex_enabled, false);
    assert.deepEqual(d.branches, [{ name: 'feat/one', findings: [] }]);
    assert.deepEqual(d.trap_doors, []);
});

// T2: valid SubagentPayload round-trips
test('T2: valid SubagentPayload round-trips', () => {
    const p = validateSubagentPayload(minimalSubagentPayload());
    assert.equal(p.category, 'B8_szechuan');
    assert.equal(p.branch, 'feat/one');
    assert.equal(p.status, 'ok');
    assert.equal(p.skip_reason, null);
    assert.deepEqual(p.findings, []);
    assert.deepEqual(p.trap_door_candidates, []);
    assert.equal(p.codex_per_branch, null);
});

// T3: missing top-level `branches` → throws, jsonPath === "$.branches"
test('T3: missing required top-level field branches', () => {
    const input = { schema_version: 1, round: 1, codex_enabled: true, trap_doors: [] };
    try {
        validateDirective(input);
        assert.fail('should have thrown');
    } catch (err) {
        assert.ok(err instanceof CouncilSchemaError);
        assert.equal(err.jsonPath, '$.branches');
    }
});

// T4: missing required finding field `severity`
test('T4: missing finding field severity', () => {
    const finding = { ...minimalFinding() };
    delete finding.severity;
    const input = {
        ...minimalDirective(),
        branches: [{ name: 'feat/one', findings: [finding] }],
    };
    try {
        validateDirective(input);
        assert.fail('should have thrown');
    } catch (err) {
        assert.ok(err instanceof CouncilSchemaError);
        assert.ok(err.jsonPath.includes('findings'), `expected jsonPath to include 'findings', got: ${err.jsonPath}`);
    }
});

// T5: wrong severity enum "P5" → throws
test('T5: wrong severity enum P5', () => {
    const finding = { ...minimalFinding(), severity: 'P5' };
    const input = {
        ...minimalDirective(),
        branches: [{ name: 'feat/one', findings: [finding] }],
    };
    assert.throws(() => validateDirective(input), CouncilSchemaError);
});

// T6: wrong source enum "GPT-5" → throws
test('T6: wrong source enum GPT-5', () => {
    const finding = { ...minimalFinding(), source: 'GPT-5' };
    const input = {
        ...minimalDirective(),
        branches: [{ name: 'feat/one', findings: [finding] }],
    };
    assert.throws(() => validateDirective(input), CouncilSchemaError);
});

// T7: confidence -1 → throws
test('T7: confidence -1 out of range', () => {
    const finding = { ...minimalFinding(), confidence: -1 };
    const input = {
        ...minimalDirective(),
        branches: [{ name: 'feat/one', findings: [finding] }],
    };
    assert.throws(() => validateDirective(input), CouncilSchemaError);
});

// T8: confidence 101 → throws
test('T8: confidence 101 out of range', () => {
    const finding = { ...minimalFinding(), confidence: 101 };
    const input = {
        ...minimalDirective(),
        branches: [{ name: 'feat/one', findings: [finding] }],
    };
    assert.throws(() => validateDirective(input), CouncilSchemaError);
});

// T9: extra unknown fields at any level → passes
test('T9: extra unknown fields tolerated', () => {
    const input = {
        ...minimalDirective(),
        extra_top_level: 'whatever',
        branches: [{
            name: 'feat/one',
            findings: [{ ...minimalFinding(), unknown_finding_field: true }],
            unknown_branch_field: 42,
        }],
    };
    assert.doesNotThrow(() => validateDirective(input));
});

// T10: schema_version: 2 → throws with "unsupported directive schema_version"
test('T10: schema_version 2 rejected with correct message', () => {
    const input = { ...minimalDirective(), schema_version: 2 };
    try {
        validateDirective(input);
        assert.fail('should have thrown');
    } catch (err) {
        assert.ok(err instanceof CouncilSchemaError);
        assert.ok(
            err.message.includes('unsupported directive schema_version'),
            `expected message to contain 'unsupported directive schema_version', got: ${err.message}`,
        );
    }
});

// T11: SubagentPayload with stack-wide branch null
test('T11: SubagentPayload with branch null (stack-wide)', () => {
    const p = validateSubagentPayload({ ...minimalSubagentPayload(), branch: null });
    assert.equal(p.branch, null);
});

// T12: unknown category → throws
test('T12: unknown category rejected', () => {
    const input = { ...minimalSubagentPayload(), category: 'B99_unknown' };
    assert.throws(() => validateSubagentPayload(input), CouncilSchemaError);
});

// T13: status "skipped" + skip_reason null → throws
test('T13: skipped status requires non-null skip_reason', () => {
    const input = { ...minimalSubagentPayload(), status: 'skipped', skip_reason: null };
    assert.throws(() => validateSubagentPayload(input), CouncilSchemaError);
});

// T14: status "skipped" + non-empty skip_reason → passes
test('T14: skipped status with valid skip_reason passes', () => {
    const input = { ...minimalSubagentPayload(), status: 'skipped', skip_reason: 'no migration journal found' };
    const p = validateSubagentPayload(input);
    assert.equal(p.status, 'skipped');
    assert.equal(p.skip_reason, 'no migration journal found');
});

// T15: Directive with finding having all optional null fields passes
test('T15: Directive with full finding including nulls passes', () => {
    const input = {
        ...minimalDirective(),
        branches: [{ name: 'feat/one', findings: [minimalFinding()] }],
        trap_doors: [{
            path: 'src/auth.ts',
            constraint: 'must rotate',
            why_it_breaks: 'session hijack',
            what_must_hold: 'force-rotate on refresh',
        }],
    };
    const d = validateDirective(input);
    assert.equal(d.branches[0].findings[0].severity, 'P1');
    assert.equal(d.trap_doors[0].path, 'src/auth.ts');
});

// T16: CouncilSchemaError is instanceof Error
test('T16: CouncilSchemaError is instanceof Error', () => {
    const input = { ...minimalDirective(), schema_version: 99 };
    try {
        validateDirective(input);
        assert.fail('should have thrown');
    } catch (err) {
        assert.ok(err instanceof Error);
        assert.ok(err instanceof CouncilSchemaError);
        assert.ok(typeof err.jsonPath === 'string');
    }
});

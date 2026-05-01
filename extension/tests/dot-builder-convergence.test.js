import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DotBuilder } from '../services/dot-builder.js';

function makeSpec(phaseOverrides = {}) {
    return {
        slug: 'convergence-test',
        goal: 'Test convergence fields',
        phases: [{
            name: 'phase1',
            prompt: 'Build the thing',
            allowedPaths: ['src/'],
            ...phaseOverrides,
        }],
        acceptanceCriteria: { done: 'implemented' },
    };
}

/** Extract label attribute value for a node from DOT output. */
function getNodeLabel(dot, nodeId) {
    const pattern = new RegExp(`\\b${nodeId}\\s+\\[([^\\]]+)\\]`);
    const match = dot.match(pattern);
    if (!match) return null;
    const labelMatch = match[1].match(/label="((?:[^"\\]|\\.)*)"/);
    return labelMatch ? labelMatch[1] : null;
}

/** Extract a specific attribute for a node from DOT output. */
function getNodeAttr(dot, nodeId, attr) {
    const pattern = new RegExp(`\\b${nodeId}\\s+\\[([^\\]]+)\\]`);
    const match = dot.match(pattern);
    if (!match) return null;
    const attrPattern = new RegExp(`${attr}="((?:[^"\\\\]|\\\\.)*)"`);
    const attrMatch = match[1].match(attrPattern);
    return attrMatch ? attrMatch[1] : null;
}

describe('convergence fields', () => {
    test('conformance gate label contains all requirements when provided', () => {
        const spec = makeSpec({ requirements: ['JWT refresh', 'token revocation', 'scope validation'] });
        const { dot } = new DotBuilder(spec).build();
        const label = getNodeLabel(dot, 'conformance_phase1');
        assert.ok(label, 'conformance_phase1 node must exist');
        assert.ok(label.includes('JWT refresh'), 'label must contain "JWT refresh"');
        assert.ok(label.includes('token revocation'), 'label must contain "token revocation"');
        assert.ok(label.includes('scope validation'), 'label must contain "scope validation"');
        assert.ok(label.includes('3 requirements'), 'label must mention "3 requirements"');
    });

    test('BDD gate label contains requirement count', () => {
        const spec = makeSpec({
            requirements: ['auth', 'roles', 'perms', 'audit'],
            specFirst: true,
            bddScenarios: true,
        });
        const { dot } = new DotBuilder(spec).build();
        const label = getNodeLabel(dot, 'bdd_scenarios_phase1');
        assert.ok(label, 'bdd_scenarios_phase1 node must exist');
        assert.ok(label.includes('4 scenarios'), 'BDD label must mention "4 scenarios"');
    });

    test('spec gate label contains requirement count', () => {
        const spec = makeSpec({
            requirements: ['endpoint1', 'endpoint2'],
            specFirst: true,
        });
        const { dot } = new DotBuilder(spec).build();
        const label = getNodeLabel(dot, 'spec_file_phase1');
        assert.ok(label, 'spec_file_phase1 node must exist');
        assert.ok(label.includes('2 machine-checkable acceptance criteria'), 'spec label must mention count');
    });

    test('test isolation gate emitted when testExpectations.isolation is true', () => {
        const spec = makeSpec({ testExpectations: { count: 8, isolation: true } });
        const { dot } = new DotBuilder(spec).build();
        assert.ok(dot.includes('test_isolation_'), 'DOT must contain a test_isolation_ node');
    });

    test('max_visits computed from testExpectations.count', () => {
        // computeMaxVisits(12) = Math.max(3, Math.ceil(12/3)) = Math.max(3, 4) = 4
        const spec = makeSpec({ testExpectations: { count: 12, isolation: false } });
        const { dot } = new DotBuilder(spec).build();
        const maxVisits = getNodeAttr(dot, 'test_phase1', 'max_visits');
        assert.equal(maxVisits, '4', 'test diamond max_visits must be 4 for count=12');
    });

    test('UI crud type injects pagination/edit/delete/empty-state requirements', () => {
        const spec = makeSpec({ uiType: 'crud', requirements: [] });
        const { dot } = new DotBuilder(spec).build();
        const label = getNodeLabel(dot, 'conformance_phase1');
        assert.ok(label, 'conformance_phase1 node must exist');
        assert.ok(label.includes('pagination'), 'label must contain "pagination"');
        assert.ok(label.includes('edit form'), 'label must contain "edit form"');
        assert.ok(label.includes('delete action'), 'label must contain "delete action"');
        assert.ok(label.includes('empty state'), 'label must contain "empty state"');
    });

    test('diagnostic emitted for missing requirements on complex phase', () => {
        const spec = makeSpec({ allowedPaths: ['a/', 'b/', 'c/', 'd/'] });
        const { diagnostics } = new DotBuilder(spec).build();
        const diag = diagnostics.find(d => d.rule === 'MISSING_REQUIREMENTS');
        assert.ok(diag, 'diagnostics must contain a MISSING_REQUIREMENTS entry');
    });

    test('no behavior change when new fields are omitted (backward compat)', () => {
        const spec = makeSpec();
        const { dot, diagnostics } = new DotBuilder(spec).build();
        const label = getNodeLabel(dot, 'conformance_phase1');
        assert.ok(label, 'conformance_phase1 node must exist');
        assert.ok(
            label.includes('Review the implementation against the phase spec'),
            'label must use old static text when no requirements provided'
        );
        const maxVisits = getNodeAttr(dot, 'test_phase1', 'max_visits');
        assert.ok(maxVisits === '5' || maxVisits === '3', `test diamond max_visits must be 5 or 3, got: ${maxVisits}`);
        const missingReqs = diagnostics.find(d => d.rule === 'MISSING_REQUIREMENTS');
        assert.equal(missingReqs, undefined, 'no MISSING_REQUIREMENTS diagnostic for simple single-path phase');
    });
});

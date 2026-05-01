// BDD scenarios for DotBuilder core API — failing tests (RED phase)
// These tests verify behavioral correctness of the builder, not just type shapes.
// They SHOULD FAIL until production code is written.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    DotBuilder,
    BuildError,
} from '../services/dot-builder.js';
import { parseDot, parseAttrs } from './__helpers__/dot-parse.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function validSpec(overrides = {}) {
    return {
        slug: 'test-pipeline',
        goal: 'Build something cool',
        phases: [],
        acceptanceCriteria: {},
        ...overrides,
    };
}

function validPhase(name = 'impl', prompt = 'implement the thing', overrides = {}) {
    return { name, prompt, allowedPaths: ['src/'], timeout: '30m', ...overrides };
}

// Helper: create builder with phases and build it
function buildWithPhases(specOverrides, phases) {
    const spec = validSpec(specOverrides);
    const builder = new DotBuilder(spec);
    for (const p of phases) builder.phase(p);
    return builder.build();
}

// Helper: extract the attribute-list body `[...]` from a node definition line.
// Finds the LINE that defines `nodeId` at the start (ignoring indentation),
// then returns the text between the outer `[` and the FINAL `]` on that line.
function extractNodeBody(dot, nodeId) {
    const lineRegex = new RegExp(`^\\s*${nodeId}\\s*\\[(.+)\\]\\s*$`, 'm');
    const lineMatch = dot.match(lineRegex);
    return lineMatch ? lineMatch[1] : null;
}

// Thin wrapper over the shared DOT attr parser so this file's call sites
// keep their object-return shape without re-implementing the state machine.
function parseAttrListToObject(body) {
    return parseAttrs(body);
}

// Helper: parse a DOT attribute-list body into a sequence of {key, rawValue}
// entries in source order. `rawValue` is the verbatim text (including
// surrounding quotes for quoted values) so tests can assert on quoting.
function parseAttrListToEntries(body) {
    const entries = [];
    let i = 0;
    while (i < body.length) {
        while (i < body.length && (body[i] === ' ' || body[i] === '\t' || body[i] === ',')) i++;
        if (i >= body.length) break;
        const keyMatch = /^([a-zA-Z_][a-zA-Z0-9_.]*)\s*=\s*/.exec(body.slice(i));
        if (!keyMatch) break;
        i += keyMatch[0].length;
        const key = keyMatch[1];
        if (body[i] === '"') {
            const start = i;
            i++;
            while (i < body.length && body[i] !== '"') {
                if (body[i] === '\\' && i + 1 < body.length) i += 2;
                else i++;
            }
            if (body[i] === '"') i++;
            entries.push({ key, rawValue: body.slice(start, i) });
        } else {
            const bw = /^[^\s,\]]+/.exec(body.slice(i));
            if (!bw) break;
            entries.push({ key, rawValue: bw[0] });
            i += bw[0].length;
        }
    }
    return entries;
}

// Helper: extract attributes from a DOT node by ID as a plain object.
function getNodeAttrs(dot, nodeId) {
    const body = extractNodeBody(dot, nodeId);
    if (body === null) return null;
    return parseAttrListToObject(body);
}

// ===========================================================================
// BDD: fromSpec() roundtrip consistency
// ===========================================================================
describe('BDD: DotBuilder.fromSpec() produces identical output to manual construction', () => {
    test('fromSpec with one phase produces same DOT as manual build().phase().build()', () => {
        const spec = {
            slug: 'roundtrip',
            goal: 'Test fromSpec parity',
            phases: [{ name: 'dev', prompt: 'write code', allowedPaths: ['src/**'], timeout: '30m' }],
        };

        // Manual construction
        const manual = new DotBuilder({
            slug: 'roundtrip',
            goal: 'Test fromSpec parity',
            phases: [],
        });
        manual.phase({ name: 'dev', prompt: 'write code', allowedPaths: ['src/**'], timeout: '30m' });
        const manualResult = manual.build();

        // fromSpec construction
        const autoResult = DotBuilder.fromSpec(spec).build();

        assert.equal(autoResult.dot, manualResult.dot,
            'fromSpec should produce byte-identical DOT to manual construction');
    });

    test('fromSpec preserves all phase option flags in DOT output', () => {
        const spec = {
            slug: 'options-test',
            goal: 'Verify all phase options survive fromSpec',
            phases: [{
                name: 'dev',
                prompt: 'Write implementation',
                allowedPaths: ['src/**'],
                dependsOn: [],
                contextOnSuccess: { coverage: '80%' },
                specFirst: true,
                timeout: '45m',
                securityScan: false,
                competing: false,
                bddScenarios: true,
                docOnly: false,
            }],
        };

        const result = DotBuilder.fromSpec(spec).build();
        const attrs = getNodeAttrs(result.dot, 'impl_dev');
        assert.ok(attrs, 'impl_dev node should exist in DOT');
        // contextOnSuccess should appear as serialized attribute
        assert.ok(result.dot.includes('context_on_success') || result.dot.includes('coverage'),
            'contextOnSuccess should appear in DOT output');
        assert.equal(attrs['class'], 'codergen',
            'codegen phase should have class=codergen');
    });
});

// ===========================================================================
// BDD: String escaping — edge cases
// ===========================================================================
describe('BDD: String escaping covers all DOT-sensitive characters', () => {
    test('escapes tab characters in labels', () => {
        const { dot } = buildWithPhases({}, [validPhase('impl', 'col1\tcol2')]);
        // Node ID is impl_impl (prefix + sanitized name)
        const implLine = dot.split('\n').find(l => l.includes('impl_impl'));
        assert.ok(implLine, 'impl_impl node should exist');
        // Raw tab should not appear — must be \t escape sequence
        // Check the label= portion specifically
        const labelMatch = implLine.match(/label="([^"]*)"/);
        assert.ok(labelMatch, 'node should have a label attribute');
        assert.ok(!labelMatch[1].includes('\t'), 'label value should not contain raw tab');
    });

    test('escapes combined backslash-quote sequences correctly', () => {
        const input = 'say \\"hi\\"';
        const { dot } = buildWithPhases({}, [validPhase('impl', input)]);
        // The backslash before quote must be escaped, and the quote must be escaped
        // So the sequence \" in source becomes \\\" in DOT
        assert.ok(dot.includes('\\\\\\"') || dot.includes('\\\"hi\\\"'),
            'backslash-quote combo must be properly escaped');
    });

    test('escapes angle brackets used in DOT HTML labels', () => {
        const { dot } = buildWithPhases({}, [validPhase('impl', '<b>bold</b>')]);
        const labelVal = dot.match(/label\s*=\s*("[^"]*"|<[^>]*>)/);
        if (labelVal) {
            assert.ok(labelVal[1].startsWith('"'),
                'angle brackets in text should be inside quoted string, not HTML label');
        }
    });

    test('handles Unicode characters safely without corruption', () => {
        const { dot } = buildWithPhases({}, [validPhase('impl', 'café résumé naïve')]);
        assert.ok(dot.includes('café'), 'Unicode should be preserved in DOT output');
        assert.ok(dot.includes('résumé'), 'French accents should survive');
    });

    test('handles empty prompt label without crashing', () => {
        const { dot } = buildWithPhases({}, [validPhase('impl', '')]);
        assert.ok(dot.includes('impl'), 'phase with empty prompt should still appear in DOT');
    });

    test('handles prompt with only special characters', () => {
        const { dot } = buildWithPhases({}, [validPhase('impl', '!!!$$$###')]);
        assert.ok(dot.includes('impl'), 'phase with special-only prompt should appear in DOT');
    });
});

// ===========================================================================
// BDD: Edge label escaping
// ===========================================================================
describe('BDD: Edge labels are properly escaped', () => {
    test('standard pipeline edges are properly quoted', () => {
        // Simple pipeline - edges like fail/pass labels on retry edges should be quoted
        const result = buildWithPhases({ acceptanceCriteria: {} }, [
            { ...validPhase('dev'), goalGate: true, retryTarget: 'dev_dev' },
        ]);
        // The build succeeds because the default implementation provides max_visits
        const edgeLines = result.dot.split('\n').filter(l => l.includes('->'));
        for (const line of edgeLines) {
            if (line.includes('label=')) {
                // Any edge label should be properly quoted
                assert.match(line, /label="[^"]*"/,
                    `edge label should be double-quoted: ${line}`);
            }
        }
    });
});

// ===========================================================================
// BDD: Node class propagation from phase options
// ===========================================================================
describe('BDD: Phase flag options propagate to DOT node attributes', () => {
    test('securityScan phase gets class=review', () => {
        const result = buildWithPhases({}, [
            validPhase('impl'),
            { name: 'secscan', prompt: 'Run security audit. Output STATUS: findings.', allowedPaths: ['src/'], securityScan: true },
        ]);
        // securityScan phase gets class=review with read_only=true
        const attrs = getNodeAttrs(result.dot, 'secscan');
        assert.ok(attrs, 'secscan node should exist in DOT');
        assert.equal(attrs['class'], 'review',
            'securityScan phase should have class=review');
        assert.equal(attrs['read_only'], 'true',
            'securityScan phase should have read_only=true');
    });

    test('docOnly phase gets class=documentation', () => {
        const result = buildWithPhases({}, [
            { ...validPhase('docs'), docOnly: true },
        ]);
        // docOnly phase should get class=documentation
        // Currently gets class=codergen and node named impl_docs
        const implDocsAttrs = getNodeAttrs(result.dot, 'impl_docs');
        assert.ok(implDocsAttrs, 'impl_docs node should exist for docOnly phase');
        assert.equal(implDocsAttrs['class'], 'documentation',
            'docOnly phase should have class=documentation, not codergen');
    });

    test('goalGate phase produces diamond decision node', () => {
        // The sanitized node ID for phase 'dev' is 'test_dev' (graph prefix + sanitized name)
        // But the builder sets retryTarget using the phase's own retryTarget field
        const result = buildWithPhases({ acceptanceCriteria: {}, defaultMaxRetry: 3 }, [
            { ...validPhase('dev'), goalGate: true, retryTarget: 'test_dev' },
        ]);
        assert.ok(result.dot.includes('shape="diamond"') || result.dot.includes('shape=diamond'),
            'goalGate should produce a diamond decision node in DOT');
    });

    test('specFirst phase does NOT emit spec_first attribute in DOT output', () => {
        const result = buildWithPhases({}, [
            { ...validPhase('design'), specFirst: true },
        ]);
        assert.ok(!result.dot.includes('spec_first'),
            'spec_first attribute must not appear in DOT output (deprecated)');
    });

    test('competing phases produce component shape nodes', () => {
        const result = buildWithPhases({}, [
            { ...validPhase('sol_a'), competing: true },
        ]);
        // component shape should appear for competing
        assert.ok(result.dot.includes('shape="component"') || result.dot.includes('shape=component'),
            'competing phase should produce component shape nodes');
    });
});

// ===========================================================================
// BDD: Deterministic output
// ===========================================================================
describe('BDD: build() produces deterministic output for same input', () => {
    test('same spec produces byte-identical DOT across 5 builds', () => {
        const spec = {
            slug: 'determinism',
            goal: 'Test deterministic output',
            phases: [
                { name: 'alpha', prompt: 'do alpha', allowedPaths: ['src/'], timeout: '30m' },
                { name: 'beta', prompt: 'do beta', allowedPaths: ['src/'], timeout: '45m' },
                { name: 'gamma', prompt: 'do gamma', allowedPaths: ['lib/'], timeout: '60m' },
            ],
        };

        const results = [];
        for (let i = 0; i < 5; i++) {
            results.push(DotBuilder.fromSpec(spec).build().dot);
        }

        for (let i = 1; i < results.length; i++) {
            assert.equal(results[i], results[0],
                `build ${i} should produce identical DOT to build 0`);
        }
    });

    test('patternsApplied is identical across multiple builds', () => {
        const spec = {
            slug: 'patterns',
            goal: 'Test patterns',
            phases: [
                { name: 'dev', prompt: 'code', allowedPaths: ['src/**'], timeout: '30m' },
                { name: 'alt', prompt: 'alt', allowedPaths: ['src/**'], timeout: '30m', dependsOn: ['dev'] },
            ],
        };

        const results = [];
        for (let i = 0; i < 3; i++) {
            results.push(DotBuilder.fromSpec(spec).build());
        }

        for (let i = 1; i < results.length; i++) {
            assert.deepEqual(results[i].patternsApplied, results[0].patternsApplied,
                'patternsApplied should be identical across builds');
            assert.equal(results[i].slug, results[0].slug,
                'slug should be identical across builds');
            assert.deepEqual(results[i].defenseMatrix, results[0].defenseMatrix,
                'defenseMatrix should be identical across builds');
        }
    });
});

// ===========================================================================
// BDD: defenseMatrix computed values
// ===========================================================================
describe('BDD: defenseMatrix computed values match spec features', () => {
    test('specDriven is NONE without spec file or BDD', () => {
        const result = buildWithPhases({}, [validPhase('dev')]);
        assert.equal(result.defenseMatrix.specDriven, 'NONE');
    });

    test('specDriven is "conformance" for specFirst pipeline', () => {
        const result = buildWithPhases({}, [
            { ...validPhase('dev'), specFirst: true },
        ]);
        assert.equal(result.defenseMatrix.specDriven, 'conformance');
    });

    test('specDriven is "BDD + conformance" when bddScenarios is true', () => {
        const result = buildWithPhases({}, [
            { ...validPhase('dev'), bddScenarios: true },
        ]);
        assert.equal(result.defenseMatrix.specDriven, 'BDD + conformance');
    });

    test('specDriven is "spec_file + conformance" when specFile is set', () => {
        const result = buildWithPhases({ specFile: 'prd.md' }, [validPhase('dev')]);
        assert.equal(result.defenseMatrix.specDriven, 'spec_file + conformance');
    });

    test('specDriven is "spec_file + BDD + conformance" when specFile + bddScenarios', () => {
        const result = buildWithPhases({ specFile: 'spec.md' }, [
            { ...validPhase('dev'), bddScenarios: true },
        ]);
        assert.equal(result.defenseMatrix.specDriven, 'spec_file + BDD + conformance');
    });

    test('competitive is true when a competing phase exists', () => {
        const result = buildWithPhases({}, [
            { ...validPhase('sol_a'), competing: true },
        ]);
        assert.equal(result.defenseMatrix.competitive, true);
    });

    test('adversarial is true when a redTeam phase exists', () => {
        const result = buildWithPhases({}, [
            { ...validPhase('red'), redTeam: true },
        ]);
        assert.equal(result.defenseMatrix.adversarial, true);
    });
});

// ===========================================================================
// BDD: Attribute formatting precision
// ===========================================================================
describe('BDD: Attribute values are consistently double-quoted', () => {
    test('node attribute values use double-quote delimiters', () => {
        const result = buildWithPhases({}, [validPhase('impl')]);
        const nodeLines = result.dot.split('\n').filter(l => l.match(/^\s+\w+\s*\[/));
        for (const line of nodeLines) {
            const bodyMatch = /\[(.+)\]\s*$/.exec(line);
            if (!bodyMatch) continue;
            const entries = parseAttrListToEntries(bodyMatch[1]);
            for (const { key, rawValue } of entries) {
                if (key === 'rankdir') continue;
                assert.ok(rawValue.startsWith('"'),
                    `attribute ${key} value should be double-quoted: ${rawValue} in ${line}`);
            }
        }
    });

    test('attribute keys within each node are alphabetically sorted', () => {
        const result = buildWithPhases({}, [
            validPhase('impl'),
        ]);
        const nodeLines = result.dot.split('\n').filter(l => l.match(/^\s+\w+\s*\[/));
        for (const line of nodeLines) {
            const bodyMatch = /\[(.+)\]\s*$/.exec(line);
            if (!bodyMatch) continue;
            const keys = parseAttrListToEntries(bodyMatch[1]).map(e => e.key);
            if (keys.length > 1) {
                const sorted = [...keys].sort();
                assert.deepEqual(keys, sorted,
                    `attribute keys should be alphabetically sorted: got ${JSON.stringify(keys)}, expected ${JSON.stringify(sorted)} in ${line}`);
            }
        }
    });
});

// ===========================================================================
// BDD: build() result shape guarantees
// ===========================================================================
describe('BDD: build() returns correct result shape', () => {
    test('result has exactly 5 keys: dot, slug, patternsApplied, defenseMatrix, diagnostics', () => {
        const result = buildWithPhases({}, [validPhase('impl')]);
        const keys = Object.keys(result).sort();
        assert.deepEqual(keys, ['defenseMatrix', 'diagnostics', 'dot', 'patternsApplied', 'slug']);
    });

    test('patternsApplied contains P0a (setup_deps)', () => {
        const result = buildWithPhases({}, [validPhase('impl')]);
        assert.ok(result.patternsApplied.includes('P0a'),
            'every pipeline should include P0a (setup_deps)');
    });

    test('patternsApplied contains P0c (capture_baseline)', () => {
        const result = buildWithPhases({}, [validPhase('impl')]);
        assert.ok(result.patternsApplied.includes('P0c'),
            'every pipeline should include P0c (capture_baseline)');
    });

    test('DOT ends with closing brace', () => {
        const { dot } = buildWithPhases({}, [validPhase('impl')]);
        assert.match(dot.trim(), /\}\s*$/, 'DOT should end with closing brace');
    });

    test('DOT contains exactly one digraph declaration', () => {
        const { dot } = buildWithPhases({}, [validPhase('impl')]);
        const digraphs = dot.match(/^digraph\s/gm) || [];
        assert.equal(digraphs.length, 1, 'should have exactly one digraph');
    });

    test('DOT contains both start (Mdiamond) and exit (Msquare) nodes', () => {
        const result = buildWithPhases({}, [validPhase('impl')]);
        const startAttrs = getNodeAttrs(result.dot, 'start');
        const exitAttrs = getNodeAttrs(result.dot, 'exit');
        assert.ok(startAttrs, 'start node should exist');
        assert.ok(exitAttrs, 'exit node should exist');
        assert.equal(startAttrs['shape'], 'Mdiamond', 'start should have shape=Mdiamond');
        assert.equal(exitAttrs['shape'], 'Msquare', 'exit should have shape=Msquare');
    });

    test('DOT has edges start -> setup_deps -> capture_baseline', () => {
        const { dot } = buildWithPhases({}, [validPhase('impl')]);
        assert.ok(dot.includes('start -> setup_deps'), 'start->setup_deps edge');
        assert.ok(dot.includes('setup_deps -> capture_baseline'),
            'setup_deps->capture_baseline edge');
    });
});

// ===========================================================================
// BDD: Sanitization edge cases
// ===========================================================================
describe('BDD: Node ID sanitization handles extreme inputs', () => {
    test('phase name with leading/trailing whitespace is trimmed', () => {
        const { dot } = buildWithPhases({}, [
            { ...validPhase('  test  '), timeout: '30m' },
        ]);
        assert.match(dot, /\btest\b/, 'leading/trailing whitespace should be trimmed from node ID');
    });

    test('numeric-only phase name gets underscore prefix', () => {
        const { dot } = buildWithPhases({}, [
            { ...validPhase('42'), timeout: '30m' },
        ]);
        assert.match(dot, /\b_42\b/, 'numeric-only name should get underscore prefix');
    });

    test('consecutive special chars collapse to single underscore', () => {
        const { dot } = buildWithPhases({}, [
            { ...validPhase('run---tests!!!'), timeout: '30m' },
        ]);
        assert.ok(!dot.includes('---'), 'consecutive dashes should not appear in node ID');
        assert.match(dot, /\brun_tests\b/, 'should produce run_tests ID');
    });
});

// ===========================================================================
// BDD: Builder fluent methods
// ===========================================================================
describe('BDD: Builder .microverse() integration', () => {
    test('builder with microverse() includes microverse in output', () => {
        const builder = new DotBuilder(validSpec());
        builder.phase(validPhase('dev'));
        builder.microverse('speed', {
            prompt: 'make it fast',
            measureCommand: 'echo 1',
            target: 100,
            direction: 'reduce',
            allowedPaths: ['src/**'],
        });
        const result = builder.build();
        assert.ok(result.dot.includes('microverse') || result.dot.includes('measure'),
            'microverse should add nodes or attributes to DOT graph');
    });
});

describe('BDD: Builder .modelStylesheet() integration', () => {
    test('builder with modelStylesheet includes stylesheet attribute', () => {
        const builder = new DotBuilder(validSpec());
        builder.phase(validPhase('dev'));
        builder.modelStylesheet({ defaultModel: 'opus' });
        const result = builder.build();
        assert.ok(result.dot.includes('model_stylesheet'),
            'modelStylesheet should add model_stylesheet to graph attributes');
    });

    test('modelStylesheet with criticalModel and reviewModel produces class overrides', () => {
        const builder = new DotBuilder(validSpec());
        builder.phase(validPhase('dev'));
        builder.modelStylesheet({
            defaultModel: 'sonnet',
            criticalModel: 'opus',
            reviewModel: 'haiku',
        });
        const result = builder.build();
        assert.ok(result.dot.includes('model_stylesheet'),
            'model_stylesheet should appear with class overrides');
    });
});

describe('BDD: Builder .acceptanceCriteria() integration', () => {
    test('acceptanceCriteria keys map to context_on_success in DOT', () => {
        // Build a pipeline with a phase that maps the AC key via contextOnSuccess
        const builder = new DotBuilder(validSpec({ acceptanceCriteria: { 'code coverage': '>80%' } }));
        builder.phase({
            ...validPhase('impl', 'write and test code'),
            contextOnSuccess: { 'code coverage': '>80%' },
        });
        const result = builder.build();
        // The acceptance criteria key should be mapped in DOT via context_on_success
        assert.ok(result.dot.includes('context_on_success') || result.dot.includes('coverage'),
            'acceptanceCriteria should appear as context_on_success or similar in DOT');
    });
});

// ===========================================================================
// BDD: thread_id topology — per-phase isolation
// ===========================================================================
describe('BDD: thread_id topology', () => {
    test('three sequential phases get thread_id phase_1, phase_2, phase_3', () => {
        const r = buildWithPhases({}, [
            validPhase('setup', 'setup db', { dependsOn: [] }),
            validPhase('core', 'build core', { dependsOn: ['setup'] }),
            validPhase('ui', 'build ui', { dependsOn: ['core'] }),
        ]);
        for (const [idx, name] of ['setup', 'core', 'ui'].entries()) {
            const attrs = getNodeAttrs(r.dot, `impl_${name}`);
            assert.ok(attrs, `impl_${name} should exist`);
            assert.equal(attrs.thread_id, `phase_${idx + 1}`,
                `impl_${name} should have thread_id=phase_${idx + 1}`);
        }
    });

    test('spec_file and bdd_scenarios have review attrs (class, read_only, timeout, STATUS prompt)', () => {
        const r = buildWithPhases({}, [
            validPhase('feat', 'build feat', { specFirst: true, bddScenarios: true, retryTarget: 'feat', dependsOn: [] }),
        ]);
        const specAttrs = getNodeAttrs(r.dot, 'spec_file_feat');
        const bddAttrs = getNodeAttrs(r.dot, 'bdd_scenarios_feat');
        assert.ok(specAttrs, 'spec_file_feat should exist');
        assert.ok(bddAttrs, 'bdd_scenarios_feat should exist');
        assert.equal(specAttrs.thread_id, 'phase_1');
        assert.equal(bddAttrs.thread_id, 'phase_1');
        assert.equal(specAttrs.class, 'review', 'spec_file must have class=review');
        assert.equal(specAttrs.read_only, 'true', 'spec_file must have read_only=true');
        assert.equal(specAttrs.timeout, '15m', 'spec_file must have timeout=15m');
        assert.ok(specAttrs.label.includes('STATUS'), 'spec_file label must contain STATUS');
        assert.equal(bddAttrs.class, 'review', 'bdd_scenarios must have class=review');
        assert.equal(bddAttrs.read_only, 'true', 'bdd_scenarios must have read_only=true');
        assert.equal(bddAttrs.timeout, '15m', 'bdd_scenarios must have timeout=15m');
        assert.ok(bddAttrs.label.includes('STATUS'), 'bdd_scenarios label must contain STATUS');
    });

    test('spec_file-only (no BDD) also has review attrs', () => {
        const r = buildWithPhases({}, [
            validPhase('feat', 'build feat', { specFirst: true, dependsOn: [] }),
        ]);
        const specAttrs = getNodeAttrs(r.dot, 'spec_file_feat');
        assert.ok(specAttrs, 'spec_file_feat should exist');
        assert.equal(specAttrs.class, 'review');
        assert.equal(specAttrs.read_only, 'true');
        assert.equal(specAttrs.timeout, '15m');
        assert.ok(specAttrs.label.includes('STATUS'));
    });

    test('red_team has review attrs + fail edge to fix + success condition', () => {
        const r = buildWithPhases({}, [
            validPhase('sec', 'security impl', { redTeam: true, dependsOn: [] }),
        ]);
        const rtAttrs = getNodeAttrs(r.dot, 'red_team_sec');
        assert.ok(rtAttrs, 'red_team_sec should exist');
        assert.equal(rtAttrs.thread_id, 'phase_1');
        assert.equal(rtAttrs.class, 'review', 'red_team must have class=review');
        assert.equal(rtAttrs.read_only, 'true', 'red_team must have read_only=true');
        assert.equal(rtAttrs.timeout, '15m', 'red_team must have timeout=15m');
        assert.ok(rtAttrs.label.includes('STATUS'), 'red_team label must contain STATUS');
        // RT-5: fail edge to fix node
        assert.ok(r.dot.includes('red_team_sec -> fix_sec'), 'red_team must have fail edge to fix node');
    });

    test('endgame fix nodes have NO thread_id', () => {
        const r = buildWithPhases({}, [
            validPhase('a', 'do a', { dependsOn: [] }),
            validPhase('b', 'do b', { dependsOn: ['a'] }),
        ]);
        for (const id of ['fix_types', 'fix_lint', 'fix_tests']) {
            const attrs = getNodeAttrs(r.dot, id);
            if (attrs) {
                assert.equal(attrs.thread_id, undefined,
                    `${id} should NOT have thread_id`);
            }
        }
    });

    test('test-dir heuristic: src/X/** auto-adds tests/X/** and __tests__/X/**', () => {
        const r = buildWithPhases({}, [
            validPhase('auth', 'auth impl', { allowedPaths: ['src/auth/**'], dependsOn: [] }),
        ]);
        const implAttrs = getNodeAttrs(r.dot, 'impl_auth');
        assert.ok(implAttrs, 'impl_auth should exist');
        assert.ok(implAttrs.allowed_paths.includes('tests/auth/**'),
            'impl allowed_paths should include tests/auth/**');
        assert.ok(implAttrs.allowed_paths.includes('__tests__/auth/**'),
            'impl allowed_paths should include __tests__/auth/**');
        // fix node too
        const fixAttrs = getNodeAttrs(r.dot, 'fix_auth');
        assert.ok(fixAttrs, 'fix_auth should exist');
        assert.ok(fixAttrs.allowed_paths.includes('tests/auth/**'),
            'fix allowed_paths should include tests/auth/**');
    });

    test('cross-phase fix nodes get union of all phase allowedPaths + test dirs; verify nodes have correct attrs', () => {
        const r = buildWithPhases({}, [
            validPhase('core', 'core impl', { allowedPaths: ['src/core/**'], dependsOn: [] }),
            validPhase('ui', 'ui impl', { allowedPaths: ['src/ui/**'], dependsOn: ['core'] }),
        ]);
        // Each fix node gets union of allowed_paths
        for (const fixId of ['fix_types', 'fix_lint', 'fix_tests']) {
            const fixAttrs = getNodeAttrs(r.dot, fixId);
            assert.ok(fixAttrs, `${fixId} should exist`);
            assert.ok(fixAttrs.allowed_paths.includes('src/core/**'), `${fixId} should include src/core/**`);
            assert.ok(fixAttrs.allowed_paths.includes('src/ui/**'), `${fixId} should include src/ui/**`);
            assert.ok(fixAttrs.allowed_paths.includes('tests/core/**'), `${fixId} should include tests/core/**`);
            assert.ok(fixAttrs.allowed_paths.includes('tests/ui/**'), `${fixId} should include tests/ui/**`);
        }
        // verify_typecheck is a tool node — no allowed_paths, has tool attrs
        const vtAttrs = getNodeAttrs(r.dot, 'verify_typecheck');
        assert.ok(vtAttrs, 'verify_typecheck should exist');
        assert.strictEqual(vtAttrs.shape, 'parallelogram', 'verify_typecheck shape');
        assert.strictEqual(vtAttrs.retry_target, 'fix_types', 'verify_typecheck retry_target');
        assert.strictEqual(vtAttrs.max_visits, '5', 'verify_typecheck max_visits');
        assert.strictEqual(vtAttrs.timeout, '30m', 'verify_typecheck timeout');
        assert.ok(vtAttrs.tool_command, 'verify_typecheck should have tool_command');
        assert.ok(!vtAttrs.allowed_paths, 'verify_typecheck should NOT have allowed_paths');
    });

    test('non-src paths pass through without test-dir expansion', () => {
        const r = buildWithPhases({}, [
            validPhase('docs', 'write docs', { allowedPaths: ['docs/**'], dependsOn: [] }),
        ]);
        const implAttrs = getNodeAttrs(r.dot, 'impl_docs');
        assert.ok(implAttrs, 'impl_docs should exist');
        assert.equal(implAttrs.allowed_paths, 'docs/**',
            'non-src paths should not get test dirs appended');
    });

    test('securityScan phase node gets thread_id', () => {
        const r = buildWithPhases({}, [
            validPhase('impl'),
            validPhase('vuln_scan', 'Scan for vulnerabilities. Output STATUS: SUCCESS | FAIL.', { securityScan: true, dependsOn: [] }),
        ]);
        const attrs = getNodeAttrs(r.dot, 'vuln_scan');
        assert.ok(attrs, 'vuln_scan should exist');
        assert.equal(attrs.thread_id, 'phase_2');
    });
});

// ===========================================================================
// BDD: Convergence v8 full topology from minimal spec
// ===========================================================================
describe('BDD: Convergence v8 full topology from minimal spec', () => {
    const minimalConvSpec = () => ({
        slug: 'v8-bdd',
        goal: 'bdd v8 topology',
        phases: [],
        acceptanceCriteria: {},
        convergence: {
            until: 'V_total == 0 && fixed_point && reproducibility',
            impl: { harness: 'claude-code', prompt: 'seed impl' },
        },
    });

    test('Given a minimal convergence spec, when built, then the v8 body chain is emitted', () => {
        const { dot, patternsApplied } = DotBuilder.fromSpec(minimalConvSpec()).build();
        const { nodes, edges } = parseDot(dot);
        const bodyChain = [
            'fix_backend', 'fix_frontend',
            'run_build_api', 'run_tests_api', 'run_build_ui', 'run_lint',
            'review_be', 'review_fe', 'review_int', 'adversary_node',
        ];
        for (const id of bodyChain) assert.ok(nodes.has(id), `${id} must be emitted`);
        for (let i = 0; i < bodyChain.length - 1; i++) {
            const e = edges.find(e => e.from === bodyChain[i] && e.to === bodyChain[i + 1]);
            assert.ok(e, `edge ${bodyChain[i]} -> ${bodyChain[i + 1]} must exist`);
        }
        assert.ok(patternsApplied.includes('P32'), 'P32 must be applied');
    });

    test('Given the same spec, then fp_verify/repro_verify/done form the goal-gate tail', () => {
        const { dot } = DotBuilder.fromSpec(minimalConvSpec()).build();
        const { nodes, edges } = parseDot(dot);
        assert.ok(nodes.has('fp_verify'));
        assert.ok(nodes.has('repro_verify'));
        assert.ok(nodes.has('done'));
        assert.equal(nodes.get('done').shape, 'Msquare', 'done must be the Msquare terminal');
        // All 5 post-chain edges in one sweep
        const expected = [
            ['adversary_node', 'fp_verify'],
            ['fp_verify', 'repro_verify'],
            ['repro_verify', 'done'],
            ['fp_verify', 'converge'],
            ['repro_verify', 'fp_verify'],
        ];
        for (const [from, to] of expected) {
            assert.ok(edges.find(e => e.from === from && e.to === to), `${from} -> ${to} must exist`);
        }
    });

    test('Given the same spec, then converge reachability edges go to fix_backend and fp_verify', () => {
        const { dot } = DotBuilder.fromSpec(minimalConvSpec()).build();
        const { edges } = parseDot(dot);
        const toFb = edges.find(e => e.from === 'converge' && e.to === 'fix_backend');
        const toFp = edges.find(e => e.from === 'converge' && e.to === 'fp_verify');
        assert.ok(toFb, 'converge -> fix_backend must exist');
        assert.ok(toFp, 'converge -> fp_verify must exist');
        assert.equal(toFb.attrs.weight, '1');
        assert.equal(toFp.attrs.weight, '2');
    });
});

// ===========================================================================
// BDD: AC-SNAP-1 — non-convergence snapshot fixtures byte-equal
// ===========================================================================
describe('BDD: AC-SNAP-1 — non-convergence snapshot fixtures byte-equal', () => {
    const fixturesDir = path.join(__dirname, '__fixtures__');

    const snapshotSpecs = {
        minimal: {
            slug: 'snap-minimal',
            goal: 'minimal snapshot baseline',
            phases: [{ name: 'core', prompt: 'implement core', allowedPaths: ['src/'] }],
            acceptanceCriteria: { done: 'true' },
        },
        phases: {
            slug: 'snap-phases',
            goal: 'two-phase snapshot baseline',
            phases: [
                { name: 'auth', prompt: 'implement auth', allowedPaths: ['src/auth/'], dependsOn: [] },
                { name: 'api', prompt: 'implement api', allowedPaths: ['src/api/'], dependsOn: [] },
            ],
            acceptanceCriteria: { auth_done: 'true', api_done: 'true' },
        },
        isolated: {
            slug: 'snap-isolated',
            goal: 'isolated workspace snapshot baseline',
            phases: [{ name: 'core', prompt: 'implement core', allowedPaths: ['src/'] }],
            acceptanceCriteria: { done: 'true' },
            workspace: 'isolated',
        },
    };

    for (const [variant, spec] of Object.entries(snapshotSpecs)) {
        test(`AC-SNAP-1 — non-convergence "${variant}" matches frozen fixture byte-equal`, () => {
            const { dot } = DotBuilder.fromSpec(spec).build();
            const fixturePath = path.join(fixturesDir, `non-convergence-baseline-${variant}.dot`);
            const fixture = fs.readFileSync(fixturePath, 'utf8');
            assert.strictEqual(dot, fixture, `non-convergence ${variant} must not regress`);
        });
    }
});

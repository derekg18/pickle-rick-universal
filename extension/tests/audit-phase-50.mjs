#!/usr/bin/env node
// Phase 50: Conformance Audit
// Requirements:
// (1) All 28 active v1 patterns have snapshot tests
// (2) Opt-in patterns absent when not requested
// (3) Default-on Pattern 16 opt-out works via specFirst:false
// (4) .modelStylesheet() generates valid CSS-like syntax
// (5) competing:true activates Pattern 18 (component→tripleoctagon) NOT Pattern 4
// (6) docOnly phases skip verify chain

import { DotBuilder } from '../services/dot-builder.js';

// Helper functions
function baseSpec(overrides = {}) {
    return {
        slug: 'pattern-test',
        goal: 'Test auto-pattern emission',
        phases: [],
        acceptanceCriteria: {},
        ...overrides,
    };
}

function phase(name, overrides = {}) {
    return { name, prompt: 'implement ' + name, allowedPaths: ['src/'], timeout: '10m', ...overrides };
}

console.log('=== PHASE 50: CONFORMANCE AUDIT ===\n');

let allPassed = true;

// AUDIT REQUIREMENT 1: Verify all 28 active v1 patterns have snapshot tests
console.log('AUDIT REQUIREMENT 1: All 28 active v1 patterns have snapshot tests');
const fs = await import('fs');
const patternsTestContent = fs.readFileSync('extension/tests/dot-builder-patterns.test.js', 'utf8');

// Extract pattern tests from the test file - match full pattern names
const testMatches = [...patternsTestContent.matchAll(/test\(['"`](P\d+[a-z]?) .*?['"`]/gi)];
const uniqueTests = [];
for (const m of testMatches) {
    const patternName = m[1];
    if (patternName && !uniqueTests.includes(patternName)) {
        uniqueTests.push(patternName);
    }
}

// Active v1 patterns list (from dot-builder.js applied.add('P...'))
const activePatterns = [
    'P0', 'P0a', 'P0b', 'P0c', 'P0d', 'P0e',
    'P1', 'P2', 'P3', 'P4', 'P6', 'P6b', 'P8', 'P9',
    'P10', 'P13', 'P14', 'P15', 'P16', 'P16b', 'P17',
    'P18', 'P19', 'P20', 'P21', 'P22', 'P23', 'P25'
];

const missingTests = [];
for (const p of activePatterns) {
    const hasTest = uniqueTests.includes(p);
    if (!hasTest) {
        missingTests.push(p);
    }
}

console.log(`Active patterns: ${activePatterns.length}`);
console.log(`Patterns with tests: ${uniqueTests.length}`);
console.log(`Missing tests: ${missingTests.length > 0 ? missingTests.join(', ') : 'none'}`);

const test1Passed = missingTests.length === 0;
console.log(`TEST 1: ${test1Passed ? 'PASS' : 'FAIL'}\n`);
allPassed = allPassed && test1Passed;

// AUDIT REQUIREMENT 2: Opt-in patterns absent when not requested
console.log('AUDIT REQUIREMENT 2: Opt-in patterns absent when not requested');
const spec2a = baseSpec({
    defaultMaxRetry: 3,
    phases: [phase('validate API', { goalGate: true, retryTarget: 'impl_validate_api' })],
});
const result2a = new DotBuilder(spec2a).build();

// P16b is opt-in (requires bddScenarios:true)
const p16bAbsent = !result2a.patternsApplied.includes('P16b');
// P2 is opt-in (requires defaultMaxRetry)
const p2Present = result2a.patternsApplied.includes('P2');
console.log(`P16b absent (opt-in, bddScenarios not specified): ${p16bAbsent ? 'PASS' : 'FAIL'}`);
console.log(`P2 present (opt-in, defaultMaxRetry=3): ${p2Present ? 'PASS' : 'FAIL'}`);

const test2Passed = p16bAbsent && p2Present;
console.log(`TEST 2: ${test2Passed ? 'PASS' : 'FAIL'}\n`);
allPassed = allPassed && test2Passed;

// AUDIT REQUIREMENT 3: Default-on Pattern 16 opt-out works via specFirst:false
console.log('AUDIT REQUIREMENT 3: Default-on Pattern 16 opt-out via specFirst:false');
const spec3a = baseSpec({
    defaultMaxRetry: 3,
    phases: [phase('validate API', { goalGate: true, retryTarget: 'impl_validate_api' })],
});
const result3a = new DotBuilder(spec3a).build();
const p16PresentDefault = result3a.patternsApplied.includes('P16');
console.log(`goalGate without specFirst:false - P16 present (default): ${p16PresentDefault ? 'PASS' : 'FAIL'}`);

const spec3b = baseSpec({
    defaultMaxRetry: 3,
    phases: [phase('validate API', { goalGate: true, retryTarget: 'impl_validate_api', specFirst: false })],
});
const result3b = new DotBuilder(spec3b).build();
const p16AbsentOptOut = !result3b.patternsApplied.includes('P16');
const specTestsAbsent = !result3b.dot.includes('spec_file_');
console.log(`specFirst:false - P16 absent (opt-out): ${p16AbsentOptOut ? 'PASS' : 'FAIL'}`);
console.log(`specFirst:false - spec_file node absent: ${specTestsAbsent ? 'PASS' : 'FAIL'}`);

const test3Passed = p16PresentDefault && p16AbsentOptOut && specTestsAbsent;
console.log(`TEST 3: ${test3Passed ? 'PASS' : 'FAIL'}\n`);
allPassed = allPassed && test3Passed;

// AUDIT REQUIREMENT 4: .modelStylesheet() generates valid CSS-like syntax
console.log('AUDIT REQUIREMENT 4: .modelStylesheet() generates valid CSS-like syntax');
const result4 = new DotBuilder(baseSpec({
    phases: [phase('implement feature')],
}))
.modelStylesheet({
    defaultModel: 'claude-sonnet-4-6',
    defaultEffort: 'high',
    overrides: [
        { selector: 'critical', model: 'claude-opus-4-6', effort: 'max' },
        { selector: '.review', model: 'claude-sonnet-4-6' },
    ],
})
.build();

const hasStylesheetAttr = result4.dot.includes('model_stylesheet=');
const ssMatch = result4.dot.match(/model_stylesheet="([^"]+)"/);
const cssValid = ssMatch && (
    ssMatch[1].includes('* {') &&
    ssMatch[1].includes('.critical {') &&
    ssMatch[1].includes('.review {') &&
    ssMatch[1].includes('llm_model:') &&
    ssMatch[1].includes('reasoning_effort:')
);
console.log(`Has model_stylesheet graph attr: ${hasStylesheetAttr ? 'PASS' : 'FAIL'}`);
console.log(`Valid CSS-like syntax (*, .className selectors with llm_model/reasoning_effort): ${cssValid ? 'PASS' : 'FAIL'}`);

const test4Passed = hasStylesheetAttr && cssValid;
console.log(`TEST 4: ${test4Passed ? 'PASS' : 'FAIL'}\n`);
allPassed = allPassed && test4Passed;

// AUDIT REQUIREMENT 5: competing:true activates Pattern 18 (component→tripleoctagon) NOT Pattern 4
console.log('AUDIT REQUIREMENT 5: competing:true activates P18 (component→tripleoctagon), NOT P4');
const spec5 = baseSpec({
    phases: [phase('implement parser', { competing: true })],
});
const result5 = new DotBuilder(spec5).build();

const p18Present = result5.patternsApplied.includes('P18');
const p4Absent = !result5.patternsApplied.includes('P4');

// Check P18 specific nodes
const hasAComponent = result5.dot.includes('_a [') || result5.dot.includes('_a ');
const hasBComponent = result5.dot.includes('_b [') || result5.dot.includes('_b ');
const hasTripleOctagon = result5.dot.includes('tripleoctagon');
const hasCompetingMerge = result5.dot.includes('competing_merge');

console.log(`P18 present: ${p18Present ? 'PASS' : 'FAIL'}`);
console.log(`P4 absent: ${p4Absent ? 'PASS' : 'FAIL'}`);
console.log(`Has _a component node: ${hasAComponent ? 'PASS' : 'FAIL'}`);
console.log(`Has _b component node: ${hasBComponent ? 'PASS' : 'FAIL'}`);
console.log(`Has tripleoctagon shape: ${hasTripleOctagon ? 'PASS' : 'FAIL'}`);
console.log(`Has competing_merge node: ${hasCompetingMerge ? 'PASS' : 'FAIL'}`);

const test5Passed = p18Present && p4Absent && hasAComponent && hasBComponent && hasTripleOctagon && hasCompetingMerge;
console.log(`TEST 5: ${test5Passed ? 'PASS' : 'FAIL'}\n`);
allPassed = allPassed && test5Passed;

// AUDIT REQUIREMENT 6: docOnly phases skip verify chain
console.log('AUDIT REQUIREMENT 6: docOnly phases skip verify chain');
// Test that a docOnly phase does NOT emit verify_lint, verify_types, test diamond, fix nodes
const spec6 = baseSpec({
    phases: [
        phase('generate docs', { docOnly: true, prompt: 'Generate API docs' }),
    ],
});
const result6 = new DotBuilder(spec6).build();

// docOnly phases should NOT have these patterns
const p0dAbsent = !result6.patternsApplied.includes('P0d'); // Delta-Aware Verify
const p1Absent = !result6.patternsApplied.includes('P1'); // Test-Fix Loops
const p13Absent = !result6.patternsApplied.includes('P13'); // Lint Gate
const p14Absent = !result6.patternsApplied.includes('P14'); // Type-Check Gate

// Verify no verify_lint, verify_types, test_* nodes in the output
const hasVerifyLint = result6.dot.includes('verify_lint');
const hasVerifyTypes = result6.dot.includes('verify_types');
const hasTestNode = result6.dot.match(/test_\w+/);

console.log(`P0d absent (Delta-Aware Verify): ${p0dAbsent ? 'PASS' : 'FAIL'}`);
console.log(`P1 absent (Test-Fix Loops): ${p1Absent ? 'PASS' : 'FAIL'}`);
console.log(`P13 absent (Lint Gate): ${p13Absent ? 'PASS' : 'FAIL'}`);
console.log(`P14 absent (Type-Check Gate): ${p14Absent ? 'PASS' : 'FAIL'}`);
console.log(`No verify_lint node: ${!hasVerifyLint ? 'PASS' : 'FAIL'}`);
console.log(`No verify_types node: ${!hasVerifyTypes ? 'PASS' : 'FAIL'}`);
console.log(`No test_* node: ${!hasTestNode ? 'PASS' : 'FAIL'}`);

const test6Passed = p0dAbsent && p1Absent && p13Absent && p14Absent && !hasVerifyLint && !hasVerifyTypes && !hasTestNode;
console.log(`TEST 6: ${test6Passed ? 'PASS' : 'FAIL'}\n`);
allPassed = allPassed && test6Passed;

// Final summary
console.log('=== AUDIT SUMMARY ===');
if (allPassed) {
    console.log('STATUS: SUCCESS');
} else {
    console.log('STATUS: FAIL');
}

process.exit(allPassed ? 0 : 1);

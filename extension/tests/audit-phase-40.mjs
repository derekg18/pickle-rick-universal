#!/usr/bin/env node
// Phase 40: Conformance Audit

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

console.log('=== PHASE 40: CONFORMANCE AUDIT ===\n');

let allPassed = true;

// AUDIT REQUIREMENT 1: Verify all 18+ auto patterns implemented in codebase
console.log('AUDIT REQUIREMENT 1: All auto patterns implemented');
// Extract patterns from code
const fs = await import('fs');
const content = fs.readFileSync('extension/services/dot-builder.js', 'utf8');
const patternMatches = [...content.matchAll(/applied\.add\('P(\w+)'\)/g)];
const patterns = new Set();
for (const m of patternMatches) {
    patterns.add(m[1]);
}
console.log(`Total patterns implemented: ${patterns.size}`);
console.log(`Patterns: ${[...patterns].sort().join(', ')}`);

// All pattern numbers (0-25, excluding some)
const expectedPatterns = new Set(['0', '0a', '0b', '0c', '0d', '0e', '1', '2', '3', '4', '6', '6b', '8', '9', '10', '13', '14', '15', '16', '16b', '17', '18', '19', '20', '21', '22', '23', '25']);
const missing = [];
for (const p of expectedPatterns) {
    if (!patterns.has(p)) {
        missing.push(p);
    }
}
const hasAllPatterns = missing.length === 0;
console.log(`Missing patterns: ${missing.length > 0 ? missing.join(', ') : 'none'}`);
console.log(`TEST 1: ${hasAllPatterns ? 'PASS' : 'FAIL'}\n`);
allPassed = allPassed && hasAllPatterns;

// AUDIT REQUIREMENT 2: BuildResult.patternsApplied for 2-phase spec with no dependsOn
console.log('AUDIT REQUIREMENT 2: 2-phase spec (no dependsOn) - Fan-out scenario');
const spec1 = baseSpec({
    phases: [
        phase('implement auth'),
        phase('implement api'),
    ],
});
const result1 = new DotBuilder(spec1).build();
console.log('patternsApplied:', result1.patternsApplied.sort().join(', '));
console.log('Pattern count:', result1.patternsApplied.length);

// In fan-out mode, the applicable patterns are:
// P0a (always), P0b (fan-out), P0c (always), P4 (fan-out), P21 (fan-out converge), P23 (defense matrix)
const expectedFanOutPatterns = ['P0a', 'P0b', 'P0c', 'P4', 'P21', 'P23'];
const allFanOutPresent = expectedFanOutPatterns.every(p => result1.patternsApplied.includes(p));
const noSequentialOnlyPatterns = !result1.patternsApplied.some(p => ['P0d', 'P0e', 'P6', 'P6b', 'P10', 'P13', 'P14', 'P15', 'P16', 'P16b'].includes(p));

console.log(`Expected fan-out patterns present: ${allFanOutPresent ? 'PASS' : 'FAIL'}`);
console.log(`Sequential-only patterns absent: ${noSequentialOnlyPatterns ? 'PASS' : 'FAIL'}`);

// Check split_phases and merge_phases exist
const hasSplitPhases = result1.dot.includes('split_phases');
const hasMergePhases = result1.dot.includes('merge_phases');
console.log(`Has split_phases: ${hasSplitPhases ? 'PASS' : 'FAIL'}`);
console.log(`Has merge_phases: ${hasMergePhases ? 'PASS' : 'FAIL'}`);

const test2Passed = allFanOutPresent && noSequentialOnlyPatterns && hasSplitPhases && hasMergePhases;
console.log(`TEST 2: ${test2Passed ? 'PASS' : 'FAIL'}\n`);
allPassed = allPassed && test2Passed;

// AUDIT REQUIREMENT 3: Pattern 16b NOT applied unless bddScenarios:true
console.log('AUDIT REQUIREMENT 3: P16b only when bddScenarios:true');
const spec2a = baseSpec({
    defaultMaxRetry: 3,
    phases: [phase('validate API', { goalGate: true, retryTarget: 'impl_validate_api' })],
});
const result2a = new DotBuilder(spec2a).build();
const p16bAbsent = !result2a.patternsApplied.includes('P16b');
console.log(`Without bddScenarios: P16b absent = ${p16bAbsent ? 'PASS' : 'FAIL'}`);

const spec2b = baseSpec({
    defaultMaxRetry: 3,
    phases: [phase('validate API', { goalGate: true, retryTarget: 'impl_validate_api', bddScenarios: true })],
});
const result2b = new DotBuilder(spec2b).build();
const p16bPresent = result2b.patternsApplied.includes('P16b');
console.log(`With bddScenarios:true: P16b present = ${p16bPresent ? 'PASS' : 'FAIL'}`);

const test3Passed = p16bAbsent && p16bPresent;
console.log(`TEST 3: ${test3Passed ? 'PASS' : 'FAIL'}\n`);
allPassed = allPassed && test3Passed;

// AUDIT REQUIREMENT 4: Conditional patterns present because preconditions met
console.log('AUDIT REQUIREMENT 4: Conditional patterns (0b, 4, 25) with correct preconditions');

// Sequential (precondition: single phase, no dependsOn = 0 independent)
const spec3a = baseSpec({
    phases: [phase('implement feature')],
});
const result3a = new DotBuilder(spec3a).build();
const p0bAbsentSequential = !result3a.patternsApplied.includes('P0b');
const p4AbsentSequential = !result3a.patternsApplied.includes('P4');
const p25PresentSequential = result3a.patternsApplied.includes('P25');
console.log(`Sequential - P0b absent (no fan-out): ${p0bAbsentSequential ? 'PASS' : 'FAIL'}`);
console.log(`Sequential - P4 absent (no fan-out): ${p4AbsentSequential ? 'PASS' : 'FAIL'}`);
console.log(`Sequential - P25 present (retry loops): ${p25PresentSequential ? 'PASS' : 'FAIL'}`);

// Fan-out (precondition: 2+ independent phases)
const spec3b = baseSpec({
    phases: [
        phase('implement auth'),
        phase('implement api'),
    ],
});
const result3b = new DotBuilder(spec3b).build();
const p0bPresentFanout = result3b.patternsApplied.includes('P0b');
const p4PresentFanout = result3b.patternsApplied.includes('P4');
const p25AbsentFanout = !result3b.patternsApplied.includes('P25');
console.log(`Fan-out - P0b present (has fan-out): ${p0bPresentFanout ? 'PASS' : 'FAIL'}`);
console.log(`Fan-out - P4 present (has fan-out): ${p4PresentFanout ? 'PASS' : 'FAIL'}`);
console.log(`Fan-out - P25 absent (no retry loops in fan-out): ${p25AbsentFanout ? 'PASS' : 'FAIL'}`);

const test4Passed = p0bAbsentSequential && p4AbsentSequential && p25PresentSequential &&
                    p0bPresentFanout && p4PresentFanout && p25AbsentFanout;
console.log(`TEST 4: ${test4Passed ? 'PASS' : 'FAIL'}\n`);
allPassed = allPassed && test4Passed;

// AUDIT REQUIREMENT 5: Pattern 4 emits split_phases/merge_phases only when >=2 independent phases
console.log('AUDIT REQUIREMENT 5: Pattern 4 emits split_phases/merge_phases only for >=2 independent phases');

// Fan-out has them
const hasSplitMergeFanout = result3b.dot.includes('split_phases') && result3b.dot.includes('merge_phases');
console.log(`Fan-out - has split_phases+merge_phases: ${hasSplitMergeFanout ? 'PASS' : 'FAIL'}`);

// Sequential doesn't
const hasSplitMergeSequential = result3a.dot.includes('split_phases') || result3a.dot.includes('merge_phases');
console.log(`Sequential - has split_phases+merge_phases: ${!hasSplitMergeSequential ? 'PASS' : 'FAIL'}`);

const test5Passed = hasSplitMergeFanout && !hasSplitMergeSequential;
console.log(`TEST 5: ${test5Passed ? 'PASS' : 'FAIL'}\n`);
allPassed = allPassed && test5Passed;

// Final summary
console.log('=== AUDIT SUMMARY ===');
if (allPassed) {
    console.log('STATUS: SUCCESS');
} else {
    console.log('STATUS: FAIL');
}

process.exit(allPassed ? 0 : 1);

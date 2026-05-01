import { DotBuilder } from './services/dot-builder.js';

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
    return { name, prompt: `implement ${name}`, allowedPaths: ['src/'], timeout: '10m', ...overrides };
}

console.log("=== CONFORMANCE AUDIT PHASE 40 ===\n");

let allTestsPassed = true;

// (1) Verify: all 18 auto patterns implemented
console.log("(1) Verifying all 18 auto patterns implemented:");
const expectedPatterns = ['P0a', 'P0b', 'P0c', 'P0d', 'P0e', 'P1', 'P3', 'P4', 'P6', 'P6b', 'P10', 'P13', 'P14', 'P15', 'P21', 'P22', 'P23', 'P25'];

function checkPattern(name, builder) {
    return builder.patternsApplied.includes(name);
}

const results = {};
results.P0a = checkPattern('P0a', new DotBuilder(baseSpec({ phases: [phase('a')] })).build());
results.P0b = checkPattern('P0b', new DotBuilder(baseSpec({ phases: [phase('a'), phase('b')] })).build());
results.P0c = checkPattern('P0c', new DotBuilder(baseSpec({ phases: [phase('a')] })).build());
results.P0d = checkPattern('P0d', new DotBuilder(baseSpec({ phases: [phase('a')] })).build());
results.P0e = checkPattern('P0e', new DotBuilder(baseSpec({ phases: [phase('a')] })).build());
results.P1 = checkPattern('P1', new DotBuilder(baseSpec({ phases: [phase('a')] })).build());
results.P3 = checkPattern('P3', new DotBuilder(baseSpec({ phases: [phase('a')] })).build());
results.P4 = checkPattern('P4', new DotBuilder(baseSpec({ phases: [phase('a'), phase('b')] })).build());
results.P6 = checkPattern('P6', new DotBuilder(baseSpec({ phases: [phase('a')] })).build());
results.P6b = checkPattern('P6b', new DotBuilder(baseSpec({ phases: [phase('a')] })).build());
results.P10 = checkPattern('P10', new DotBuilder(baseSpec({ phases: [phase('a')] })).build());
results.P13 = checkPattern('P13', new DotBuilder(baseSpec({ phases: [phase('a')] })).build());
results.P14 = checkPattern('P14', new DotBuilder(baseSpec({ phases: [phase('a')] })).build());
results.P15 = checkPattern('P15', new DotBuilder(baseSpec({ phases: [phase('a')] })).build());
results.P21 = checkPattern('P21', new DotBuilder(baseSpec({ phases: [phase('a')] })).build());
results.P22 = checkPattern('P22', new DotBuilder(baseSpec({ phases: [phase('a')] })).build());
results.P23 = checkPattern('P23', new DotBuilder(baseSpec({ phases: [phase('a')] })).build());
results.P25 = checkPattern('P25', new DotBuilder(baseSpec({ phases: [phase('a')] })).build());

let patternsPassed = 0;
for (const p of expectedPatterns) {
    console.log(`  ${p}: ${results[p] ? 'PASS' : 'FAIL'}`);
    if (results[p]) patternsPassed++;
}
console.log(`  Result: ${patternsPassed}/${expectedPatterns.length} patterns implemented\n`);
const test1Passed = patternsPassed === expectedPatterns.length;
allTestsPassed = allTestsPassed && test1Passed;

// (2) Verify: BuildResult.patternsApplied includes every auto pattern for a 2-phase spec with no dependsOn
console.log("(2) Verifying BuildResult.patternsApplied for 2-phase spec with no dependsOn:");
const twoPhaseSpec = new DotBuilder(baseSpec({
    phases: [
        phase('implement auth'),
        phase('implement api'),
    ],
})).build();
console.log(`  patternsApplied: ${JSON.stringify(twoPhaseSpec.patternsApplied)}`);
// For 2 independent phases, we expect: P0a, P0c, P4, P0b, P21, P23
const expectedForTwoPhase = ['P0a', 'P0c', 'P4', 'P0b', 'P21', 'P23'];
const allExpectedPresent = expectedForTwoPhase.every(p => twoPhaseSpec.patternsApplied.includes(p));
console.log(`  Expected patterns present: ${allExpectedPresent ? 'PASS' : 'FAIL'}\n`);
const test2Passed = allExpectedPresent;
allTestsPassed = allTestsPassed && test2Passed;

// (3) Verify: Pattern 16b (BDD) NOT applied unless bddScenarios:true
console.log("(3) Verifying Pattern 16b (BDD) NOT applied unless bddScenarios:true:");
const noBDD = new DotBuilder(baseSpec({ defaultMaxRetry: 3, phases: [phase('a', { goalGate: true, retryTarget: 'impl_a' })] })).build();
const withBDD = new DotBuilder(baseSpec({ defaultMaxRetry: 3, phases: [phase('a', { goalGate: true, retryTarget: 'impl_a', bddScenarios: true })] })).build();
console.log(`  Without bddScenarios: P16b applied = ${noBDD.patternsApplied.includes('P16b')} (expected: false)`);
console.log(`  With bddScenarios: P16b applied = ${withBDD.patternsApplied.includes('P16b')} (expected: true)`);
const test3Passed = !noBDD.patternsApplied.includes('P16b') && withBDD.patternsApplied.includes('P16b');
console.log(`  Result: ${test3Passed ? 'PASS' : 'FAIL'}\n`);
allTestsPassed = allTestsPassed && test3Passed;

// (4) Verify: conditional patterns (0b, 4, 25) present because preconditions met
console.log("(4) Verifying conditional patterns (0b, 4, 25) with correct preconditions:");
const sequential = new DotBuilder(baseSpec({ phases: [phase('a')] })).build();
const fanOut = new DotBuilder(baseSpec({ phases: [phase('a'), phase('b')] })).build();

// P0b: fan-out max_parallel=1 only when 2+ independent phases
const p0bCorrect = !sequential.patternsApplied.includes('P0b') && fanOut.patternsApplied.includes('P0b');
console.log(`  P0b (fan-out parallel limit): sequential=${!sequential.patternsApplied.includes('P0b')}, fanOut=${fanOut.patternsApplied.includes('P0b')} ${p0bCorrect ? 'PASS' : 'FAIL'}`);

// P4: split/merge fan-out only when 2+ independent phases
const p4Correct = !sequential.patternsApplied.includes('P4') && fanOut.patternsApplied.includes('P4');
console.log(`  P4 (fan-out topology): sequential=${!sequential.patternsApplied.includes('P4')}, fanOut=${fanOut.patternsApplied.includes('P4')} ${p4Correct ? 'PASS' : 'FAIL'}`);

// P25: catastrophic recovery only when sequential with retry loops
const p25Correct = sequential.patternsApplied.includes('P25') && !fanOut.patternsApplied.includes('P25');
console.log(`  P25 (catastrophic recovery): sequential=${sequential.patternsApplied.includes('P25')}, fanOut=${!fanOut.patternsApplied.includes('P25')} ${p25Correct ? 'PASS' : 'FAIL'}`);

const test4Passed = p0bCorrect && p4Correct && p25Correct;
console.log(`  Result: ${test4Passed ? 'PASS' : 'FAIL'}\n`);
allTestsPassed = allTestsPassed && test4Passed;

// (5) Verify: Pattern 4 emits split_phases/merge_phases only when >=2 independent phases
console.log("(5) Verifying Pattern 4 emits split_phases/merge_phases only when >=2 independent phases:");
console.log(`  1 phase - split_phases: ${sequential.dot.includes('split_phases')} (expected: false)`);
console.log(`  2 phases - split_phases: ${fanOut.dot.includes('split_phases')} (expected: true)`);
console.log(`  1 phase - merge_phases: ${sequential.dot.includes('merge_phases')} (expected: false)`);
console.log(`  2 phases - merge_phases: ${fanOut.dot.includes('merge_phases')} (expected: true)`);
const test5Passed = !sequential.dot.includes('split_phases') && fanOut.dot.includes('split_phases') &&
                    !sequential.dot.includes('merge_phases') && fanOut.dot.includes('merge_phases');
console.log(`  Result: ${test5Passed ? 'PASS' : 'FAIL'}\n`);
allTestsPassed = allTestsPassed && test5Passed;

// Final result
console.log("=== CONFORMANCE AUDIT RESULT ===");
if (allTestsPassed) {
    console.log("STATUS: SUCCESS");
} else {
    console.log("STATUS: FAIL");
}

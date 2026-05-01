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

// Test 1: All patterns for a 2-phase spec with no dependsOn
console.log("=== Test 1: 2 independent phases (fan-out) ===");
const result1 = new DotBuilder(baseSpec({
    phases: [
        phase('implement auth'),
        phase('implement api'),
    ],
})).build();

console.log("patternsApplied:", JSON.stringify(result1.patternsApplied));
console.log("Total patterns:", result1.patternsApplied.length);

// Test 2: Verify P16b NOT applied unless bddScenarios:true
console.log("\n=== Test 2: Pattern 16b (BDD) control ===");
const resultNoBDD = new DotBuilder(baseSpec({
    phases: [phase('implement auth')],
})).build();

const resultWithBDD = new DotBuilder(baseSpec({
    defaultMaxRetry: 3,
    phases: [phase('implement auth', { bddScenarios: true, goalGate: true, retryTarget: 'impl_implement_auth' })],
})).build();

console.log("Without bddScenarios - P16b applied:", resultNoBDD.patternsApplied.includes('P16b'));
console.log("With bddScenarios - P16b applied:", resultWithBDD.patternsApplied.includes('P16b'));

// Test 3: Verify conditional patterns (0b, 4, 25) preconditions
console.log("\n=== Test 3: Conditional patterns ===");

// 0b: fan-out max_parallel=1
const resultFanOut = new DotBuilder(baseSpec({
    phases: [phase('a'), phase('b')],
})).build();
console.log("Fan-out P0b applied:", resultFanOut.patternsApplied.includes('P0b'));

// 4: split/merge fan-out
console.log("Fan-out P4 applied:", resultFanOut.patternsApplied.includes('P4'));

// 25: catastrophic recovery (sequential with retry loops)
const resultSequential = new DotBuilder(baseSpec({
    phases: [phase('a')],
})).build();
console.log("Sequential P25 applied:", resultSequential.patternsApplied.includes('P25'));
console.log("Fan-out P25 applied:", resultFanOut.patternsApplied.includes('P25'));

// Test 4: Verify Pattern 4 split_phases/merge_phases only when >=2 independent phases
console.log("\n=== Test 4: Pattern 4 split/merge only for >=2 independent phases ===");
console.log("1 phase - split_phases:", resultSequential.dot.includes('split_phases'));
console.log("2 phases - split_phases:", resultFanOut.dot.includes('split_phases'));
console.log("1 phase - merge_phases:", resultSequential.dot.includes('merge_phases'));
console.log("2 phases - merge_phases:", resultFanOut.dot.includes('merge_phases'));

console.log("\n=== Verifying all patterns in comprehensive spec ===");
const allPatterns = [
    'P0', 'P0a', 'P0b', 'P0c', 'P0d', 'P0e',
    'P1', 'P2', 'P3', 'P4', 'P6', 'P6b',
    'P8', 'P9', 'P10', 'P13', 'P14', 'P15',
    'P16', 'P16b', 'P17', 'P18', 'P19', 'P20',
    'P21', 'P22', 'P23', 'P25'
];

// Test comprehensive spec with all conditions met (no specFirst+goalGate combo)
const resultComprehensive = new DotBuilder({
    slug: 'comprehensive',
    goal: 'Comprehensive pattern test',
    phases: [
        phase('auth', { allowedPaths: ['src/auth/'], bddScenarios: true, goalGate: true, retryTarget: 'impl_auth', contextOnSuccess: { 'AC1': 'success' } }),
        phase('api', { allowedPaths: ['src/api/'], dependsOn: ['auth'], escalateOn: ['package.json'] }),
    ],
    acceptanceCriteria: { 'AC1': 'Test' },
    defaultMaxRetry: 3,
    reviewRatchet: 3,
}).build();

const found = allPatterns.filter(p => resultComprehensive.patternsApplied.includes(p));
const missing = allPatterns.filter(p => !resultComprehensive.patternsApplied.includes(p));
console.log("All patterns found:", found.length);
console.log("Total patterns in spec:", allPatterns.length);
console.log("Missing patterns:", missing);

// Check P16b specifically
console.log("\nP16b check:");
console.log("- With bddScenarios:", resultComprehensive.patternsApplied.includes('P16b'));

// Test for P2 phase (goalGate with retryTarget)
console.log("\n=== P2 phase check ===");
const resultP2 = new DotBuilder(baseSpec({
    defaultMaxRetry: 3,
    phases: [phase('validate', { goalGate: true, retryTarget: 'impl_validate' })],
})).build();
console.log("P2 applied:", resultP2.patternsApplied.includes('P2'));

// Test for P8 phase (securityScan)
console.log("\n=== P8 phase check ===");
const resultP8 = new DotBuilder(baseSpec({
    phases: [
        phase('feature'),
        phase('security audit', { securityScan: true, prompt: 'Scan for OWASP Top 10. STATUS: SUCCESS | FAIL' }),
    ],
})).build();
console.log("P8 applied:", resultP8.patternsApplied.includes('P8'));

// Test for P9 phase (coverageTarget)
console.log("\n=== P9 phase check ===");
const resultP9 = new DotBuilder(baseSpec({
    phases: [phase('feature', { coverageTarget: 80 })],
})).build();
console.log("P9 applied:", resultP9.patternsApplied.includes('P9'));

// Test for P17 phase (redTeam)
console.log("\n=== P17 phase check ===");
const resultP17 = new DotBuilder(baseSpec({
    phases: [phase('feature', { redTeam: true })],
})).build();
console.log("P17 applied:", resultP17.patternsApplied.includes('P17'));

// Test for P18 phase (competing)
console.log("\n=== P18 phase check ===");
const resultP18 = new DotBuilder(baseSpec({
    phases: [phase('parser', { competing: true })],
})).build();
console.log("P18 applied:", resultP18.patternsApplied.includes('P18'));

// Test for P19 phase (reviewRatchet)
console.log("\n=== P19 phase check ===");
const resultP19 = new DotBuilder(baseSpec({
    phases: [phase('feature')],
    reviewRatchet: 3,
})).build();
console.log("P19 applied:", resultP19.patternsApplied.includes('P19'));

// Test for P20 phase (microverse)
console.log("\n=== P20 phase check ===");
const resultP20 = new DotBuilder(baseSpec({
    phases: [phase('feature')],
}))
.microverse('bundle_size', {
    prompt: 'Reduce bundle size',
    measureCommand: 'du -sb dist/ | cut -f1',
    target: 500000,
    direction: 'reduce',
    allowedPaths: ['src/'],
    maxVisits: 8,
})
.build();
console.log("P20 applied:", resultP20.patternsApplied.includes('P20'));

// List all patterns found in comprehensive spec
console.log("\n=== All patterns found in comprehensive spec ===");
console.log(JSON.stringify(resultComprehensive.patternsApplied));

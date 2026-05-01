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

// Patterns from BDD scenarios comment: 0a, 0b, 0c, 0d, 0e, 1, 3, 4, 6, 6b, 10, 13, 14, 15, 21, 22, 23, 25
const expectedPatterns = ['P0a', 'P0b', 'P0c', 'P0d', 'P0e', 'P1', 'P3', 'P4', 'P6', 'P6b', 'P10', 'P13', 'P14', 'P15', 'P21', 'P22', 'P23', 'P25'];

console.log("=== Verifying 18 expected patterns are implemented ===\n");

// Test each pattern
const results = {};

// P0a: setup_deps (always)
const r0a = new DotBuilder(baseSpec({ phases: [phase('a')] })).build();
results.P0a = r0a.patternsApplied.includes('P0a');

// P0b: fan-out max_parallel (2+ independent phases)
const r0b = new DotBuilder(baseSpec({ phases: [phase('a'), phase('b')] })).build();
results.P0b = r0b.patternsApplied.includes('P0b');

// P0c: capture_baseline (always)
const r0c = new DotBuilder(baseSpec({ phases: [phase('a')] })).build();
results.P0c = r0c.patternsApplied.includes('P0c');

// P0d: delta-aware verify (always - via verify_lint/verify_types)
const r0d = new DotBuilder(baseSpec({ phases: [phase('a')] })).build();
results.P0d = r0d.patternsApplied.includes('P0d');

// P0e: check_progress (always)
const r0e = new DotBuilder(baseSpec({ phases: [phase('a')] })).build();
results.P0e = r0e.patternsApplied.includes('P0e');

// P1: test-fix loop (always)
const r1 = new DotBuilder(baseSpec({ phases: [phase('a')] })).build();
results.P1 = r1.patternsApplied.includes('P1');

// P3: diamond >=2 edges (always - via test diamond)
const r3 = new DotBuilder(baseSpec({ phases: [phase('a')] })).build();
results.P3 = r3.patternsApplied.includes('P3');

// P4: fan-out (2+ independent phases)
const r4 = new DotBuilder(baseSpec({ phases: [phase('a'), phase('b')] })).build();
results.P4 = r4.patternsApplied.includes('P4');

// P6: max_visits (always - via retry-target nodes)
const r6 = new DotBuilder(baseSpec({ phases: [phase('a')] })).build();
results.P6 = r6.patternsApplied.includes('P6');

// P6b: read_only + STATUS (always - via review nodes)
const r6b = new DotBuilder(baseSpec({ phases: [phase('a')] })).build();
results.P6b = r6b.patternsApplied.includes('P6b');

// P10: scope_check (always)
const r10 = new DotBuilder(baseSpec({ phases: [phase('a')] })).build();
results.P10 = r10.patternsApplied.includes('P10');

// P13: verify_lint (always)
const r13 = new DotBuilder(baseSpec({ phases: [phase('a')] })).build();
results.P13 = r13.patternsApplied.includes('P13');

// P14: verify_types (always)
const r14 = new DotBuilder(baseSpec({ phases: [phase('a')] })).build();
results.P14 = r14.patternsApplied.includes('P14');

// P15: conformance (always)
const r15 = new DotBuilder(baseSpec({ phases: [phase('a')] })).build();
results.P15 = r15.patternsApplied.includes('P15');

// P21: fix_all (always when impl phases)
const r21 = new DotBuilder(baseSpec({ phases: [phase('a')] })).build();
results.P21 = r21.patternsApplied.includes('P21');

// P22: permission scoping (always for codergen)
const r22 = new DotBuilder(baseSpec({ phases: [phase('a')] })).build();
results.P22 = r22.patternsApplied.includes('P22');

// P23: defense matrix (always)
const r23 = new DotBuilder(baseSpec({ phases: [phase('a')] })).build();
results.P23 = r23.patternsApplied.includes('P23');

// P25: catastrophic recovery (sequential with retry loops)
const r25 = new DotBuilder(baseSpec({ phases: [phase('a')] })).build();
results.P25 = r25.patternsApplied.includes('P25');

// Check all expected patterns
console.log("Expected patterns check:");
let allPassed = true;
for (const p of expectedPatterns) {
    const passed = results[p];
    console.log(`${p}: ${passed ? 'PASS' : 'FAIL'}`);
    if (!passed) allPassed = false;
}

console.log(`\n${expectedPatterns.length} patterns verified: ${allPassed ? 'ALL PASS' : 'SOME FAIL'}`);

// Additional patterns not in the 18 but implemented
console.log("\n=== Additional patterns implemented ===");
const r2 = new DotBuilder(baseSpec({ defaultMaxRetry: 3, phases: [phase('a', { goalGate: true, retryTarget: 'impl_a' })] })).build();
console.log(`P2 (goalGate max_visits): ${r2.patternsApplied.includes('P2')}`);

const r8 = new DotBuilder(baseSpec({ phases: [phase('a'), phase('security', { securityScan: true, prompt: 'Scan for OWASP Top 10. STATUS: SUCCESS | FAIL' })] })).build();
console.log(`P8 (securityScan): ${r8.patternsApplied.includes('P8')}`);

const r9 = new DotBuilder(baseSpec({ phases: [phase('a', { coverageTarget: 80 })] })).build();
console.log(`P9 (coverageTarget): ${r9.patternsApplied.includes('P9')}`);

const r16 = new DotBuilder(baseSpec({ defaultMaxRetry: 3, phases: [phase('a', { goalGate: true, retryTarget: 'impl_a' })] })).build();
console.log(`P16 (specFirst default): ${r16.patternsApplied.includes('P16')}`);

const r16b = new DotBuilder(baseSpec({ defaultMaxRetry: 3, phases: [phase('a', { goalGate: true, retryTarget: 'impl_a', bddScenarios: true })] })).build();
console.log(`P16b (BDD opt-in): ${r16b.patternsApplied.includes('P16b')}`);

const r17 = new DotBuilder(baseSpec({ phases: [phase('a', { redTeam: true })] })).build();
console.log(`P17 (redTeam): ${r17.patternsApplied.includes('P17')}`);

const r18 = new DotBuilder(baseSpec({ phases: [phase('a', { competing: true })] })).build();
console.log(`P18 (competing): ${r18.patternsApplied.includes('P18')}`);

const r19 = new DotBuilder(baseSpec({ phases: [phase('a')], reviewRatchet: 3 })).build();
console.log(`P19 (reviewRatchet): ${r19.patternsApplied.includes('P19')}`);

const r20 = new DotBuilder(baseSpec({ phases: [phase('a')] }))
    .microverse('size', { prompt: 'Reduce', measureCommand: 'echo 1', target: 100, direction: 'reduce', allowedPaths: ['src/'], maxVisits: 5 })
    .build();
console.log(`P20 (microverse): ${r20.patternsApplied.includes('P20')}`);

const r0 = new DotBuilder(baseSpec({ 
    workspace: 'isolated',
    workspaceOpts: { repoUrl: 'https://github.com/org/repo.git', cleanup: 'delete' },
    phases: [phase('a'), phase('commit_and_push', { allowedPaths: ['src/'] })],
})).build();
console.log(`P0 (workspace isolated): ${r0.patternsApplied.includes('P0')}`);

console.log("\n=== Summary ===");
console.log(`Expected patterns (18): ${expectedPatterns.length} checked, ${expectedPatterns.filter(p => results[p]).length} passed`);
console.log(`Additional patterns (10): ${['P2','P8','P9','P16','P16b','P17','P18','P19','P20','P0'].filter(p => {
    if (p === 'P0') return r0.patternsApplied.includes(p);
    if (p === 'P2') return r2.patternsApplied.includes(p);
    if (p === 'P8') return r8.patternsApplied.includes(p);
    if (p === 'P9') return r9.patternsApplied.includes(p);
    if (p === 'P16') return r16.patternsApplied.includes(p);
    if (p === 'P16b') return r16b.patternsApplied.includes(p);
    if (p === 'P17') return r17.patternsApplied.includes(p);
    if (p === 'P18') return r18.patternsApplied.includes(p);
    if (p === 'P19') return r19.patternsApplied.includes(p);
    if (p === 'P20') return r20.patternsApplied.includes(p);
    return false;
}).length} passed`);

const totalImpl = expectedPatterns.filter(p => results[p]).length + ['P2','P8','P9','P16','P16b','P17','P18','P19','P20','P0'].filter(p => {
    if (p === 'P0') return r0.patternsApplied.includes(p);
    if (p === 'P2') return r2.patternsApplied.includes(p);
    if (p === 'P8') return r8.patternsApplied.includes(p);
    if (p === 'P9') return r9.patternsApplied.includes(p);
    if (p === 'P16') return r16.patternsApplied.includes(p);
    if (p === 'P16b') return r16b.patternsApplied.includes(p);
    if (p === 'P17') return r17.patternsApplied.includes(p);
    if (p === 'P18') return r18.patternsApplied.includes(p);
    if (p === 'P19') return r19.patternsApplied.includes(p);
    if (p === 'P20') return r20.patternsApplied.includes(p);
    return false;
}).length;
console.log(`Total patterns implemented: ${totalImpl}`);

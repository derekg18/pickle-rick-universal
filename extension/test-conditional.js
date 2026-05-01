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

const sequential = new DotBuilder(baseSpec({ phases: [phase('a')] })).build();
const fanOut = new DotBuilder(baseSpec({ phases: [phase('a'), phase('b')] })).build();

console.log("Sequential patterns:", sequential.patternsApplied);
console.log("FanOut patterns:", fanOut.patternsApplied);

console.log("\nP0b in sequential:", sequential.patternsApplied.includes('P0b'));
console.log("P0b in fanOut:", fanOut.patternsApplied.includes('P0b'));

console.log("\nP4 in sequential:", sequential.patternsApplied.includes('P4'));
console.log("P4 in fanOut:", fanOut.patternsApplied.includes('P4'));

console.log("\nP25 in sequential:", sequential.patternsApplied.includes('P25'));
console.log("P25 in fanOut:", fanOut.patternsApplied.includes('P25'));

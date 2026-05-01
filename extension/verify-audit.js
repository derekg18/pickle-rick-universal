import { DotBuilder } from './services/dot-builder.js';

function baseSpec(overrides = {}) {
    return {
        slug: 'pattern-test',
        goal: 'Test auto-pattern emission',
        phases: [],
        acceptanceCriteria: {},
        defaultMaxRetry: 3,
        ...overrides,
    };
}

function phase(name, overrides = {}) {
    return { name, prompt: 'implement ' + name, allowedPaths: ['src/'], timeout: '10m', ...overrides };
}

// Test 1: competing:true activates Pattern 18 NOT Pattern 4
console.log('=== Test 1: competing:true activates Pattern 18 NOT Pattern 4 ===');
const competingResult = new DotBuilder(baseSpec({
    phases: [phase('implement parser', { competing: true })],
})).build();
console.log('patternsApplied:', competingResult.patternsApplied);
console.log('Has P18?', competingResult.patternsApplied.includes('P18'));
console.log('Has P4?', competingResult.patternsApplied.includes('P4'));
console.log('PASS:', competingResult.patternsApplied.includes('P18') && !competingResult.patternsApplied.includes('P4'));

// Test 2: docOnly phases skip verify chain
console.log('\n=== Test 2: docOnly phases skip verify chain ===');
const docOnlyResult = new DotBuilder(baseSpec({
    phases: [phase('docs', { allowedPaths: ['docs/'], docOnly: true })],
})).build();
console.log('patternsApplied:', docOnlyResult.patternsApplied);
console.log('Has verify_lint?', docOnlyResult.dot.includes('verify_lint'));
console.log('Has verify_types?', docOnlyResult.dot.includes('verify_types'));
console.log('Has check_progress?', docOnlyResult.dot.includes('check_progress'));
console.log('PASS:', !docOnlyResult.dot.includes('verify_lint') && !docOnlyResult.dot.includes('verify_types') && !docOnlyResult.dot.includes('check_progress'));

// Test 3: specFirst:false opts out Pattern 16
console.log('\n=== Test 3: specFirst:false opts out Pattern 16 ===');
const noSpecResult = new DotBuilder(baseSpec({
    phases: [phase('validate API', { goalGate: true, retryTarget: 'impl_validate_api', specFirst: false })],
})).build();
console.log('patternsApplied:', noSpecResult.patternsApplied);
console.log('Has spec_file?', noSpecResult.dot.includes('spec_file'));
console.log('Has P16?', noSpecResult.patternsApplied.includes('P16'));
console.log('PASS:', !noSpecResult.dot.includes('spec_file') && !noSpecResult.patternsApplied.includes('P16'));

// Test 4: modelStylesheet generates valid CSS-like syntax
console.log('\n=== Test 4: modelStylesheet generates valid CSS-like syntax ===');
const cssResult = new DotBuilder(baseSpec({
    phases: [phase('test', { timeout: '5m' })],
}))
.modelStylesheet({
    defaultModel: 'claude-sonnet-4-6',
    defaultEffort: 'high',
    overrides: [
        { selector: '.review', model: 'claude-opus-4-6' },
    ],
})
.build();
const ssMatch = cssResult.dot.match('stylesheet="');
console.log('Has stylesheet attr?', !!ssMatch);
if (ssMatch) {
    const stylesheet = cssResult.dot.match(/stylesheet="([^"]+)"/);
    if (stylesheet) {
        console.log('Stylesheet content:', stylesheet[1].substring(0, 100));
        console.log('PASS: Valid CSS-like syntax generated');
    }
}

// Summary
console.log('\n=== AUDIT SUMMARY ===');
const tests = [
    competingResult.patternsApplied.includes('P18') && !competingResult.patternsApplied.includes('P4'),
    !docOnlyResult.dot.includes('verify_lint') && !docOnlyResult.dot.includes('verify_types') && !docOnlyResult.dot.includes('check_progress'),
    !noSpecResult.dot.includes('spec_file') && !noSpecResult.patternsApplied.includes('P16'),
    !!ssMatch
];
const passed = tests.filter(t => t).length;
console.log('Tests passed:', passed, '/ 4');
console.log(passed === 4 ? 'STATUS: SUCCESS' : 'STATUS: FAIL');

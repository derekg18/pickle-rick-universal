import { DotBuilder, BuildError } from './services/dot-builder.js';

const testResults = { passed: 0, failed: 0, tests: [] };

function baseSpec(overrides = {}) {
  return {
    slug: 'val-test',
    goal: 'Validate structural rules',
    phases: [],
    acceptanceCriteria: {},
    ...overrides,
  };
}

function phase(name, overrides = {}) {
  return { name, prompt: 'implement ' + name, allowedPaths: ['src/'], ...overrides };
}

// Rule 11 test
try {
  const builder11 = new DotBuilder(baseSpec({
    phases: [
      phase('alpha', { retryTarget: 'impl_beta' }),
      phase('beta'),
    ],
  }));
  builder11.build();
  testResults.tests.push({ name: 'Rule 11 FAN_OUT_SCOPE_LEAK', passed: false, error: 'Should have thrown BuildError' });
  testResults.failed++;
} catch (err) {
  if (err instanceof BuildError && err.code === 'FAN_OUT_SCOPE_LEAK') {
    testResults.tests.push({ name: 'Rule 11 FAN_OUT_SCOPE_LEAK', passed: true });
    testResults.passed++;
  } else {
    testResults.tests.push({ name: 'Rule 11 FAN_OUT_SCOPE_LEAK', passed: false, error: 'Wrong error: ' + (err?.code || err) });
    testResults.failed++;
  }
}

// Rule 12 test
try {
  const builder12 = new DotBuilder(baseSpec({
    phases: [phase('impl')],
    workspace: 'isolated',
    workspaceOpts: { repoUrl: 'git@github.com:org/repo.git' },
  }));
  builder12.build();
  testResults.tests.push({ name: 'Rule 12 WORKSPACE_NO_HTTPS', passed: false, error: 'Should have thrown BuildError' });
  testResults.failed++;
} catch (err) {
  if (err instanceof BuildError && err.code === 'WORKSPACE_NO_HTTPS') {
    testResults.tests.push({ name: 'Rule 12 WORKSPACE_NO_HTTPS', passed: true });
    testResults.passed++;
  } else {
    testResults.tests.push({ name: 'Rule 12 WORKSPACE_NO_HTTPS', passed: false, error: 'Wrong error: ' + (err?.code || err) });
    testResults.failed++;
  }
}

// Rule 13 test
try {
  const builder13 = new DotBuilder(baseSpec({
    phases: [phase('impl')],
    workspace: 'isolated',
    workspaceOpts: { repoUrl: 'https://github.com/org/repo.git' },
  }));
  builder13.build();
  testResults.tests.push({ name: 'Rule 13 WORKSPACE_NO_PUSH', passed: false, error: 'Should have thrown BuildError' });
  testResults.failed++;
} catch (err) {
  if (err instanceof BuildError && err.code === 'WORKSPACE_NO_PUSH') {
    testResults.tests.push({ name: 'Rule 13 WORKSPACE_NO_PUSH', passed: true });
    testResults.passed++;
  } else {
    testResults.tests.push({ name: 'Rule 13 WORKSPACE_NO_PUSH', passed: false, error: 'Wrong error: ' + (err?.code || err) });
    testResults.failed++;
  }
}

// Rule 14 test
try {
  const builder14 = new DotBuilder(baseSpec({
    phases: [phase('impl', { specFirst: true, goalGate: true })],
  }));
  builder14.build();
  testResults.tests.push({ name: 'Rule 14 PLAN_MODE_DEADLOCK', passed: false, error: 'Should have thrown BuildError' });
  testResults.failed++;
} catch (err) {
  if (err instanceof BuildError && err.code === 'PLAN_MODE_DEADLOCK') {
    testResults.tests.push({ name: 'Rule 14 PLAN_MODE_DEADLOCK', passed: true });
    testResults.passed++;
  } else {
    testResults.tests.push({ name: 'Rule 14 PLAN_MODE_DEADLOCK', passed: false, error: 'Wrong error: ' + (err?.code || err) });
    testResults.failed++;
  }
}

// Rule 15 test
try {
  const builder15 = new DotBuilder(baseSpec({
    phases: [phase('impl', { allowedPaths: [] })],
  }));
  builder15.build();
  testResults.tests.push({ name: 'Rule 15 MISSING_ALLOWED_PATHS', passed: false, error: 'Should have thrown BuildError' });
  testResults.failed++;
} catch (err) {
  if (err instanceof BuildError && err.code === 'MISSING_ALLOWED_PATHS') {
    testResults.tests.push({ name: 'Rule 15 MISSING_ALLOWED_PATHS', passed: true });
    testResults.passed++;
  } else {
    testResults.tests.push({ name: 'Rule 15 MISSING_ALLOWED_PATHS', passed: false, error: 'Wrong error: ' + (err?.code || err) });
    testResults.failed++;
  }
}

// Print results
console.log('\n=== RULES 11-15 VALIDATION RESULTS ===');
testResults.tests.forEach(function(t) {
  console.log((t.passed ? 'PASS' : 'FAIL') + ' ' + t.name + (t.error ? ' - ' + t.error : ''));
});
console.log('\nPassed: ' + testResults.passed + '/5');
console.log('Failed: ' + testResults.failed + '/5');

if (testResults.failed === 0) {
  console.log('\nSTATUS: SUCCESS');
} else {
  console.log('\nSTATUS: FAIL');
}

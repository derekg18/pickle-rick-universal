import { DotBuilder, BuildError } from './services/dot-builder.js';

// Test that diagnostics have correct structure for rules 11-15
console.log('=== DIAGNOSTIC STRUCTURE VERIFICATION ===\n');

// Rule 11: FAN_OUT_SCOPE_LEAK
try {
  const builder = new DotBuilder({
    slug: 'test',
    goal: 'test',
    phases: [
      { name: 'alpha', prompt: 'test', allowedPaths: ['src/'], retryTarget: 'impl_beta' },
      { name: 'beta', prompt: 'test', allowedPaths: ['src/'] }
    ]
  });
  builder.build();
  console.log('FAIL: Rule 11 should have thrown');
} catch (e) {
  if (e instanceof BuildError && e.code === 'FAN_OUT_SCOPE_LEAK') {
    const diag = e.diagnostics.find(d => d.rule === 'FAN_OUT_SCOPE_LEAK');
    console.log('Rule 11 diagnostic structure:', diag);
    console.log('  - Has rule:', 'rule' in diag, 'value:', diag?.rule);
    console.log('  - Has severity:', 'severity' in diag, 'value:', diag?.severity);
    console.log('  - Has message:', 'message' in diag, 'value:', diag?.message);
    console.log('  - Has nodeId:', 'nodeId' in diag, 'value:', diag?.nodeId);
    console.log('  - Has edge:', 'edge' in diag, 'value:', diag?.edge);
  }
}

// Rule 12: WORKSPACE_NO_HTTPS
try {
  const builder = new DotBuilder({
    slug: 'test',
    goal: 'test',
    workspace: 'isolated',
    workspaceOpts: { repoUrl: 'git@github.com:org/repo.git' },
    phases: [{ name: 'impl', prompt: 'test', allowedPaths: ['src/'] }]
  });
  builder.build();
  console.log('FAIL: Rule 12 should have thrown');
} catch (e) {
  if (e instanceof BuildError && e.code === 'WORKSPACE_NO_HTTPS') {
    const diag = e.diagnostics.find(d => d.rule === 'WORKSPACE_NO_HTTPS');
    console.log('\nRule 12 diagnostic structure:', diag);
    console.log('  - Has rule:', 'rule' in diag, 'value:', diag?.rule);
    console.log('  - Has severity:', 'severity' in diag, 'value:', diag?.severity);
    console.log('  - Has message:', 'message' in diag, 'value:', diag?.message);
    console.log('  - Has nodeId:', 'nodeId' in diag, 'value:', diag?.nodeId);
    console.log('  - Has edge:', 'edge' in diag, 'value:', diag?.edge);
  }
}

// Rule 13: WORKSPACE_NO_PUSH
try {
  const builder = new DotBuilder({
    slug: 'test',
    goal: 'test',
    workspace: 'isolated',
    workspaceOpts: { repoUrl: 'https://github.com/org/repo.git' },
    phases: [{ name: 'impl', prompt: 'test', allowedPaths: ['src/'] }]
  });
  builder.build();
  console.log('FAIL: Rule 13 should have thrown');
} catch (e) {
  if (e instanceof BuildError && e.code === 'WORKSPACE_NO_PUSH') {
    const diag = e.diagnostics.find(d => d.rule === 'WORKSPACE_NO_PUSH');
    console.log('\nRule 13 diagnostic structure:', diag);
    console.log('  - Has rule:', 'rule' in diag, 'value:', diag?.rule);
    console.log('  - Has severity:', 'severity' in diag, 'value:', diag?.severity);
    console.log('  - Has message:', 'message' in diag, 'value:', diag?.message);
    console.log('  - Has nodeId:', 'nodeId' in diag, 'value:', diag?.nodeId);
    console.log('  - Has edge:', 'edge' in diag, 'value:', diag?.edge);
  }
}

// Rule 14: PLAN_MODE_DEADLOCK
try {
  const builder = new DotBuilder({
    slug: 'test',
    goal: 'test',
    phases: [{ name: 'impl', prompt: 'test', allowedPaths: ['src/'], specFirst: true, goalGate: true }]
  });
  builder.build();
  console.log('FAIL: Rule 14 should have thrown');
} catch (e) {
  if (e instanceof BuildError && e.code === 'PLAN_MODE_DEADLOCK') {
    const diag = e.diagnostics.find(d => d.rule === 'PLAN_MODE_DEADLOCK');
    console.log('\nRule 14 diagnostic structure:', diag);
    console.log('  - Has rule:', 'rule' in diag, 'value:', diag?.rule);
    console.log('  - Has severity:', 'severity' in diag, 'value:', diag?.severity);
    console.log('  - Has message:', 'message' in diag, 'value:', diag?.message);
    console.log('  - Has nodeId:', 'nodeId' in diag, 'value:', diag?.nodeId);
    console.log('  - Has edge:', 'edge' in diag, 'value:', diag?.edge);
  }
}

// Rule 15: MISSING_ALLOWED_PATHS
try {
  const builder = new DotBuilder({
    slug: 'test',
    goal: 'test',
    phases: [{ name: 'impl', prompt: 'test', allowedPaths: [] }]
  });
  builder.build();
  console.log('FAIL: Rule 15 should have thrown');
} catch (e) {
  if (e instanceof BuildError && e.code === 'MISSING_ALLOWED_PATHS') {
    const diag = e.diagnostics.find(d => d.rule === 'MISSING_ALLOWED_PATHS');
    console.log('\nRule 15 diagnostic structure:', diag);
    console.log('  - Has rule:', 'rule' in diag, 'value:', diag?.rule);
    console.log('  - Has severity:', 'severity' in diag, 'value:', diag?.severity);
    console.log('  - Has message:', 'message' in diag, 'value:', diag?.message);
    console.log('  - Has nodeId:', 'nodeId' in diag, 'value:', diag?.nodeId);
    console.log('  - Has edge:', 'edge' in diag, 'value:', diag?.edge);
  }
}

console.log('\n=== ALL DIAGNOSTICS VERIFIED ===');

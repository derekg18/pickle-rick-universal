import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parsePerformanceFrontendArgs,
  runPerformanceFrontendCommand,
  runPerformanceFrontendCommandByName,
} from '../services/performance-frontend-commands.js';

const fixedContext = {
  workspaceDir: '/repo',
  reportDir: 'reports/fixtures',
  now: new Date('2026-05-13T00:00:00.000Z'),
  availableTools: ['autocannon', 'npm', 'lighthouse', 'axe'],
};

test('/get-schwifty emits deterministic benchmark plan artifact without starting load tests', () => {
  let started = false;
  const result = runPerformanceFrontendCommand('get-schwifty', ['--app', 'apps/web', '--target', 'http://localhost:3000'], {
    ...fixedContext,
    startLoadTest: () => {
      started = true;
    },
  });

  assert.equal(result.status, 'success');
  assert.equal(result.command, 'get-schwifty');
  assert.equal(result.artifact.kind, 'benchmark-plan');
  assert.equal(result.artifact.report_path, 'reports/fixtures/get-schwifty-http-localhost-3000.json');
  assert.deepEqual(result.artifact.started_external_actions, []);
  assert.equal(result.benchmark.load_test_started, false);
  assert.deepEqual(result.benchmark.plan, [
    'resolve target',
    'capture baseline metrics',
    'write benchmark report artifact',
  ]);
  assert.equal(started, false);
});

test('/get-schwifty blocks positional external URL load targets until target is explicit', () => {
  const result = runPerformanceFrontendCommand('get-schwifty', ['https://example.com'], fixedContext);

  assert.equal(result.status, 'needs_followup');
  assert.match(result.summary, /External URL/);
  assert.match(result.remediation, /--target/);
  assert.deepEqual(result.artifact.started_external_actions, []);
});

test('build and bundle commands compute deterministic build and skipped sets from changed file fixtures', () => {
  const ctx = {
    ...fixedContext,
    changedFiles: ['src/App.tsx', 'styles/site.css', 'README.md'],
  };
  const build = runPerformanceFrontendCommand('tiny-rick', ['--app=apps/web'], ctx);
  const bundle = runPerformanceFrontendCommand('time-crystal', ['--app=apps/web'], ctx);

  for (const result of [build, bundle]) {
    assert.equal(result.status, 'success');
    assert.equal(result.build.role, 'build-optimization');
    assert.deepEqual(result.build.changed_files, ctx.changedFiles);
    assert.deepEqual(result.build.build_set, ['app', 'styles']);
    assert.deepEqual(result.build.skipped, ['build-config']);
    assert.equal(result.artifact.deterministic, true);
  }
});

test('frontend and mobile audit commands validate viewport args and return report paths', () => {
  const mobile = runPerformanceFrontendCommand('rickmobile', [
    '--target=/checkout',
    '--viewports',
    'phone=390x844,tablet=768x1024',
  ], fixedContext);
  const a11y = runPerformanceFrontendCommand('ants-in-my-eyes-johnson', [
    '--target',
    '/checkout',
    '--viewport=desktop=1440x900',
  ], fixedContext);

  assert.equal(mobile.status, 'success');
  assert.equal(mobile.audit.matrix.length, 2);
  assert.deepEqual(mobile.audit.matrix.map((row) => [row.viewport, row.width, row.height]), [
    ['phone', 390, 844],
    ['tablet', 768, 1024],
  ]);
  assert.equal(mobile.artifact.report_path, 'reports/fixtures/rickmobile-checkout.json');
  assert.equal(a11y.status, 'success');
  assert.deepEqual(a11y.audit.matrix[0].audits, ['accessibility', 'keyboard', 'contrast']);
  assert.equal(a11y.artifact.report_path, 'reports/fixtures/ants-in-my-eyes-johnson-checkout.json');
});

test('invalid viewport args fail with remediation', () => {
  const parsed = parsePerformanceFrontendArgs(['--viewport=wide']);

  assert.equal(parsed.status, 'failed');
  assert.match(parsed.summary, /Invalid viewport/);
  assert.match(parsed.remediation, /<width>x<height>/);
});

test('missing external tools produce typed remediation', () => {
  const result = runPerformanceFrontendCommand('ants-in-my-eyes-johnson', ['--target=/checkout'], {
    ...fixedContext,
    availableTools: ['npm'],
  });

  assert.equal(result.status, 'needs_followup');
  assert.equal(result.followup.code, 'MISSING_EXTERNAL_TOOL');
  assert.equal(result.followup.tool, 'axe');
  assert.match(result.followup.install_command, /@axe-core\/playwright/);
});

test('unknown command names return failed typed command result', () => {
  const result = runPerformanceFrontendCommandByName('unknown', [], fixedContext);

  assert.equal(result.status, 'failed');
  assert.match(result.remediation, /get-schwifty/);
});

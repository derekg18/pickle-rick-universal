import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runEnvironmentCommandGroup,
  runEnvironmentCommandGroupByName,
} from '../services/environment-command-group.js';

const fixedContext = {
  workspaceDir: '/repo',
  now: new Date('2026-05-13T00:00:00.000Z'),
  stackFixture: {
    services: ['api', 'postgres'],
    env: {
      DATABASE_URL: 'postgres://fixture/app',
      FEATURE_FLAG: 'true',
    },
    seed: ['schema', 'demo-user'],
  },
};

test('/ricks-garage produces a deterministic dev bootstrap plan from a stack fixture', () => {
  const result = runEnvironmentCommandGroup('ricks-garage', [
    '--env',
    'local',
    '--service',
    'worker',
    '--env-var',
    'CACHE_URL=redis://localhost',
    '--seed',
    'sample-data',
  ], fixedContext);

  assert.equal(result.status, 'success');
  assert.equal(result.command, 'ricks-garage');
  assert.equal(result.artifact.kind, 'environment-command-result');
  assert.equal(result.artifact.dry_run, true);
  assert.deepEqual(result.artifact.executed_actions, []);
  assert.equal(result.plan.role, 'environment-plan');
  assert.equal(result.plan.kind, 'dev-bootstrap');
  assert.equal(result.plan.target_environment, 'local');
  assert.deepEqual(result.plan.services, ['api', 'postgres', 'worker']);
  assert.deepEqual(result.plan.seed, ['demo-user', 'sample-data', 'schema']);
  assert.deepEqual(result.plan.env.map((row) => row.name), [
    'CACHE_URL',
    'DATABASE_URL',
    'FEATURE_FLAG',
    'NODE_ENV',
  ]);
});

test('/citadel produces deterministic environment config plans as a strict superset artifact', () => {
  const result = runEnvironmentCommandGroup('citadel', [
    '/repo',
    '--env=staging',
    '--service=web',
    '--env-var=FEATURE_FLAG=false',
  ], fixedContext);

  assert.equal(result.status, 'success');
  assert.equal(result.command, 'citadel');
  assert.equal(result.artifact.workspace_dir, '/repo');
  assert.equal(result.artifact.target_environment, 'staging');
  assert.deepEqual(result.artifact.executed_actions, []);
  assert.equal(result.plan.kind, 'environment-config');
  assert.deepEqual(result.plan.services, ['api', 'postgres', 'web']);
  assert.deepEqual(
    result.plan.env.find((row) => row.name === 'FEATURE_FLAG'),
    { name: 'FEATURE_FLAG', value: 'false' },
  );
  assert.ok(result.plan.checks.some((check) => check.includes('config')));
});

test('/microverse-battery validates nested-container requests without starting containers by default', () => {
  let started = false;
  const result = runEnvironmentCommandGroup('microverse-battery', ['--nested-container', '--service', 'sandbox'], {
    ...fixedContext,
    startContainer: () => {
      started = true;
    },
  });

  assert.equal(result.status, 'success');
  assert.equal(result.plan.kind, 'nested-container-validation');
  assert.deepEqual(result.artifact.unsafe_actions, ['nested-container']);
  assert.deepEqual(result.artifact.executed_actions, []);
  assert.ok(result.plan.checks.some((check) => check.includes('nested-container')));
  assert.equal(started, false);
});

test('unsafe environment actions return typed followup unless explicitly confirmed', () => {
  let rolledBack = false;
  const result = runEnvironmentCommandGroup('ricks-garage', ['--deploy-rollback'], {
    ...fixedContext,
    deployRollback: () => {
      rolledBack = true;
    },
  });

  assert.equal(result.status, 'needs_followup');
  assert.equal(result.skeleton.reason, 'ACTION_REQUIRES_CONFIRMATION');
  assert.deepEqual(result.skeleton.blocked_actions, ['deploy-rollback']);
  assert.deepEqual(result.artifact.executed_actions, []);
  assert.equal(rolledBack, false);
});

test('skeleton deploy and cloud commands return typed not_implemented results without side effects', () => {
  const cases = [
    ['phoenix-person', 'deploy-skeleton', 'DEPLOY_ROLLBACK_NOT_IMPLEMENTED'],
    ['nimbus', 'cloud-skeleton', 'CLOUD_PROVISIONING_NOT_IMPLEMENTED'],
  ];

  for (const [command, kind, reason] of cases) {
    const called = {
      cloud: false,
      rollback: false,
    };
    const result = runEnvironmentCommandGroupByName(command, [], {
      ...fixedContext,
      provisionCloud: () => {
        called.cloud = true;
      },
      deployRollback: () => {
        called.rollback = true;
      },
    });

    assert.equal(result.status, 'not_implemented');
    assert.equal(result.command, command);
    assert.equal(result.skeleton.kind, kind);
    assert.equal(result.skeleton.reason, reason);
    assert.equal(result.skeleton.started, false);
    assert.deepEqual(result.artifact.executed_actions, []);
    assert.deepEqual(called, { cloud: false, rollback: false });
  }
});

test('cloud-cost and provisioning requests return typed followup without provisioning', () => {
  let provisioned = false;
  const result = runEnvironmentCommandGroup('nimbus', ['--cloud-cost', '--cloud-provision'], {
    ...fixedContext,
    provisionCloud: () => {
      provisioned = true;
    },
  });

  assert.equal(result.status, 'needs_followup');
  assert.equal(result.skeleton.reason, 'ACTION_REQUIRES_CONFIRMATION');
  assert.deepEqual(result.skeleton.blocked_actions, ['cloud-cost', 'cloud-provision']);
  assert.equal(provisioned, false);
});

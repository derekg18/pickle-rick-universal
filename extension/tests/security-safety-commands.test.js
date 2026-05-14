import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runSecuritySafetyCommand,
  runSecuritySafetyCommandByName,
} from '../services/security-safety-commands.js';

const fixedContext = {
  workspaceDir: '/repo',
  now: new Date('2026-05-13T00:00:00.000Z'),
};

test('/evil-morty produces a non-destructive security findings plan from a fixture PR', () => {
  let executed = false;
  const result = runSecuritySafetyCommand('evil-morty', ['--pr', 'PR-42'], {
    ...fixedContext,
    execSyscall: () => {
      executed = true;
    },
  });

  assert.equal(result.status, 'success');
  assert.equal(result.command, 'evil-morty');
  assert.equal(result.artifact.kind, 'security-safety-command-result');
  assert.equal(result.artifact.non_destructive, true);
  assert.deepEqual(result.artifact.executed_actions, []);
  assert.equal(result.review.role, 'security-review');
  assert.equal(result.review.target, 'PR-42');
  assert.ok(result.review.findings_plan.some((item) => item.includes('authentication')));
  assert.equal(executed, false);
});

test('/scary-terry produces a non-destructive API fuzz payload matrix artifact', () => {
  let executed = false;
  const result = runSecuritySafetyCommand('scary-terry', ['--endpoint=/v1/users'], {
    ...fixedContext,
    execSyscall: () => {
      executed = true;
    },
  });

  assert.equal(result.status, 'success');
  assert.equal(result.command, 'scary-terry');
  assert.equal(result.fuzz.role, 'api-fuzz-plan');
  assert.equal(result.fuzz.target, '/v1/users');
  assert.deepEqual(
    result.fuzz.payload_matrix.map((row) => row.category),
    ['auth', 'input', 'encoding', 'rate-limit'],
  );
  assert.equal(result.artifact.non_destructive, true);
  assert.equal(executed, false);
});

test('/interdimensional-customs produces a downstream safety plan without rollback actions', () => {
  let rolledBack = false;
  const result = runSecuritySafetyCommand('interdimensional-customs', ['--target', 'payments-api'], {
    ...fixedContext,
    destructiveRollback: () => {
      rolledBack = true;
    },
  });

  assert.equal(result.status, 'success');
  assert.equal(result.downstream.role, 'downstream-safety');
  assert.equal(result.downstream.target, 'payments-api');
  assert.ok(result.downstream.checks.some((check) => check.includes('rollback')));
  assert.deepEqual(result.artifact.executed_actions, []);
  assert.equal(rolledBack, false);
});

test('skeleton-only safety commands perform no container, secret rotation, rollback, or syscall action', () => {
  const commands = ['fleeb-juice', 'wendys', 'froopyland'];
  for (const command of commands) {
    const called = {
      container: false,
      rotate: false,
      rollback: false,
      syscall: false,
    };
    const result = runSecuritySafetyCommandByName(command, [], {
      ...fixedContext,
      startContainer: () => {
        called.container = true;
      },
      rotateSecret: () => {
        called.rotate = true;
      },
      destructiveRollback: () => {
        called.rollback = true;
      },
      execSyscall: () => {
        called.syscall = true;
      },
    });

    assert.equal(result.status, 'success');
    assert.equal(result.skeleton.skeleton_only, true);
    assert.equal(result.skeleton.action, 'none');
    assert.equal(result.skeleton.started, false);
    assert.deepEqual(result.skeleton.blocked_actions, [
      'container',
      'secret-rotation',
      'destructive-rollback',
      'syscall',
    ]);
    assert.deepEqual(called, {
      container: false,
      rotate: false,
      rollback: false,
      syscall: false,
    });
  }
});

test('/froopyland uses SANDBOX_NOT_IMPLEMENTED and no exec/container syscall path', () => {
  let containerStarted = false;
  let syscallExecuted = false;
  const result = runSecuritySafetyCommand('froopyland', ['repo'], {
    ...fixedContext,
    startContainer: () => {
      containerStarted = true;
    },
    execSyscall: () => {
      syscallExecuted = true;
    },
  });

  assert.equal(result.status, 'success');
  assert.equal(result.skeleton.reason, 'SANDBOX_NOT_IMPLEMENTED');
  assert.equal(result.skeleton.action, 'none');
  assert.equal(result.skeleton.started, false);
  assert.deepEqual(result.artifact.executed_actions, []);
  assert.equal(containerStarted, false);
  assert.equal(syscallExecuted, false);
});

test('unsafe execution flags fail with remediation instead of running safety actions', () => {
  let rotated = false;
  const result = runSecuritySafetyCommand('fleeb-juice', ['--rotate-secret'], {
    ...fixedContext,
    rotateSecret: () => {
      rotated = true;
    },
  });

  assert.equal(result.status, 'failed');
  assert.match(result.summary, /Unsafe execution flags/);
  assert.match(result.remediation, /v1 only emits non-destructive plans or typed skeletons/);
  assert.equal(result.artifact.non_destructive, true);
  assert.equal(rotated, false);
});

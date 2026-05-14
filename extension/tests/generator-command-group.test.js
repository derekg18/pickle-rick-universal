import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runGeneratorCommandGroup,
  runGeneratorCommandGroupByName,
} from '../services/generator-command-group.js';

const fixedContext = {
  workspaceDir: '/repo',
  tempDir: '/tmp/pickle-preview',
  now: new Date('2026-05-13T00:00:00.000Z'),
};

const oldSchema = JSON.stringify({
  name: 'old',
  tables: [
    { name: 'users', columns: { id: 'string', email: 'string' } },
  ],
});

const newSchema = JSON.stringify({
  name: 'new',
  tables: [
    { name: 'users', columns: { id: 'string', email: 'string', active: 'boolean' } },
    { name: 'posts', columns: { id: 'string', user_id: 'string', title: 'string' } },
  ],
});

test('/butter-robot emits daemon scaffold plan and refuses non-empty targets without force', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'butter-robot-'));
  const target = path.join(root, 'daemon');
  mkdirSync(target);
  writeFileSync(path.join(target, 'existing.txt'), 'keep');

  const rejected = runGeneratorCommandGroup('butter-robot', ['--target', target, '--task', 'sync invoices'], fixedContext);

  assert.equal(rejected.status, 'failed');
  assert.equal(rejected.code, 'TARGET_DIR_NOT_EMPTY');
  assert.deepEqual(rejected.artifact.executed_actions, []);
  assert.equal(rejected.artifact.preview_only, true);

  const forced = runGeneratorCommandGroup('butter-robot', ['--target', target, '--task', 'sync invoices', '--force'], fixedContext);

  assert.equal(forced.status, 'success');
  assert.equal(forced.plan.role, 'scaffold-plan');
  assert.equal(forced.plan.kind, 'daemon-scaffold-plan');
  assert.deepEqual(forced.plan.files.map((file) => file.path), [
    'package.json',
    'src/daemon.ts',
    'src/tasks/sync-invoices.ts',
    'README.md',
  ]);
  assert.equal(forced.plan.writes_package, false);
  assert.deepEqual(forced.artifact.executed_actions, []);
});

test('schema mock and migration commands parse fixture schemas and emit plan artifacts', () => {
  const mock = runGeneratorCommandGroup('ricks-flask', ['--schema', newSchema], fixedContext);

  assert.equal(mock.status, 'success');
  assert.equal(mock.plan.role, 'mock-seed-preview');
  assert.equal(mock.artifact.plan_path, '/tmp/pickle-preview/ricks-flask/ricks-flask-plan.json');
  assert.deepEqual(mock.plan.rows.find((row) => row.table === 'posts').values.user_id, 'user-1');
  assert.equal(mock.artifact.preview_only, true);

  const migration = runGeneratorCommandGroup('morty-smith-database', [
    '--old-schema',
    oldSchema,
    '--new-schema',
    newSchema,
  ], fixedContext);

  assert.equal(migration.status, 'success');
  assert.equal(migration.plan.role, 'migration-plan');
  assert.equal(migration.plan.apply_migration, false);
  assert.ok(migration.plan.operations.some((operation) => operation.action === 'create_table' && operation.table === 'posts'));
  assert.ok(migration.plan.operations.some((operation) => operation.action === 'add_column' && operation.column === 'active'));
});

test('package, monorepo, and retry commands return valid non-destructive command results', () => {
  const cases = [
    runGeneratorCommandGroup('unity', ['--target=/repo/pkg', '--name=shared-lib'], fixedContext),
    runGeneratorCommandGroup('gazorpazorp', ['--target=/repo/workspace', '--name=platform'], fixedContext),
    runGeneratorCommandGroup('snake-jazz', ['--task', 'sync webhook', '--attempts=4'], fixedContext),
  ];

  for (const result of cases) {
    assert.equal(result.status, 'success');
    assert.equal(result.artifact.kind, 'generator-command-result');
    assert.equal(result.artifact.preview_only, true);
    assert.deepEqual(result.artifact.executed_actions, []);
    assert.ok(result.artifact.plan_path.endsWith(`${result.command}-plan.json`));
    assert.ok(result.summary.length > 0);
  }

  assert.equal(cases[0].plan.role, 'scaffold-plan');
  assert.equal(cases[0].plan.writes_package, false);
  assert.equal(cases[1].plan.kind, 'monorepo-scaffold-plan');
  assert.equal(cases[2].plan.role, 'retry-plan');
  assert.equal(cases[2].plan.starts_processes, false);
});

test('unsafe write and migration requests require explicit confirmation', () => {
  const packageWrite = runGeneratorCommandGroup('unity', ['--write', '--target=/repo/pkg'], fixedContext);
  const migrationApply = runGeneratorCommandGroup('morty-smith-database', ['--apply'], fixedContext);

  assert.equal(packageWrite.status, 'needs_followup');
  assert.equal(packageWrite.code, 'ACTION_REQUIRES_CONFIRMATION');
  assert.deepEqual(packageWrite.artifact.executed_actions, []);
  assert.equal(migrationApply.status, 'needs_followup');
  assert.equal(migrationApply.code, 'ACTION_REQUIRES_CONFIRMATION');
});

test('unknown generator command returns a typed command result', () => {
  const result = runGeneratorCommandGroupByName('unknown-command', [], fixedContext);

  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'UNKNOWN_COMMAND');
  assert.equal(result.command, 'butter-robot');
  assert.equal(result.artifact.preview_only, true);
});

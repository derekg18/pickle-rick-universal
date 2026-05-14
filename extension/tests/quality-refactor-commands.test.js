import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  runQualityRefactorCommand,
  runQualityRefactorCommandByName,
} from '../services/quality-refactor-commands.js';

function withTempDir(fn) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'quality-refactor-')));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('/squanch writes regex preview and rollback artifacts without mutating files', () => withTempDir((dir) => {
  const srcDir = path.join(dir, 'src');
  fs.mkdirSync(srcDir);
  const filePath = path.join(srcDir, 'feature.ts');
  fs.writeFileSync(filePath, 'const oldName = 1;\nconsole.log(oldName);\n');

  const result = runQualityRefactorCommand(
    'squanch',
    ['--target', 'src', '--pattern', 'oldName', '--replacement', 'newName'],
    { workspaceDir: dir, now: new Date('2026-05-13T12:00:00.000Z') },
  );

  assert.equal(result.status, 'success');
  assert.equal(result.command, 'squanch');
  assert.equal(result.preview.dry_run, true);
  assert.equal(result.artifact.preview_only, true);
  assert.equal(result.preview.suggested_changes.length, 2);
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'const oldName = 1;\nconsole.log(oldName);\n');
  assert.equal(fs.existsSync(result.artifact.preview_path), true);
  assert.equal(fs.existsSync(result.artifact.rollback_path), true);

  const preview = readJson(result.artifact.preview_path);
  const rollback = readJson(result.artifact.rollback_path);
  assert.equal(preview.preview.suggested_changes[0].after, 'newName');
  assert.equal(rollback.entries[filePath], 'const oldName = 1;\nconsole.log(oldName);\n');
}));

test('simplicity, dead-code, debt, cleanup, and explainer commands are preview-only by default', () => withTempDir((dir) => {
  fs.writeFileSync(path.join(dir, 'module.ts'), 'export function work() { return 1; }\n');
  const commands = ['simple-rick', 'memory-parasites', 'jerry-detector', 'detoxifier', 'doofus-rick'];

  for (const command of commands) {
    const result = runQualityRefactorCommandByName(command, ['--target', 'module.ts'], {
      workspaceDir: dir,
      now: new Date('2026-05-13T12:00:00.000Z'),
    });

    assert.equal(result.status, 'success');
    assert.equal(result.command, command);
    assert.equal(result.preview.dry_run, true);
    assert.equal(result.preview.apply_requested, false);
    assert.equal(result.artifact.kind, 'quality-refactor-preview');
    assert.equal(result.artifact.preview_only, true);
    assert.equal(fs.existsSync(result.artifact.preview_path), true);
    assert.equal(fs.existsSync(result.artifact.rollback_path), true);
  }
}));

test('unsafe or empty targets fail with actionable remediation', () => withTempDir((dir) => {
  const missingTarget = runQualityRefactorCommand('simple-rick', [], { workspaceDir: dir });
  assert.equal(missingTarget.status, 'failed');
  assert.match(missingTarget.summary, /No target path/);
  assert.match(missingTarget.remediation, /--target/);

  const missingPath = runQualityRefactorCommand('detoxifier', ['--target', 'missing.ts'], { workspaceDir: dir });
  assert.equal(missingPath.status, 'failed');
  assert.match(missingPath.summary, /does not exist/);
  assert.match(missingPath.remediation, /existing file or directory/);

  const unsafeRegex = runQualityRefactorCommand(
    'squanch',
    ['--target', '.', '--pattern', '.*', '--replacement', 'x'],
    { workspaceDir: dir },
  );
  assert.equal(unsafeRegex.status, 'failed');
  assert.match(unsafeRegex.summary, /Unsafe search regex/);
  assert.match(unsafeRegex.remediation, /narrower regex/);
}));

test('destructive request without explicit confirmation fails before write', () => withTempDir((dir) => {
  const filePath = path.join(dir, 'feature.ts');
  fs.writeFileSync(filePath, 'const oldName = 1;\n');

  const result = runQualityRefactorCommand(
    'squanch',
    ['--target', 'feature.ts', '--pattern', 'oldName', '--replacement', 'newName', '--apply'],
    { workspaceDir: dir },
  );

  assert.equal(result.status, 'failed');
  assert.match(result.summary, /without confirmation/);
  assert.match(result.remediation, /--confirm-apply/);
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'const oldName = 1;\n');
  assert.equal(fs.existsSync(path.join(dir, '.pickle')), false);
}));

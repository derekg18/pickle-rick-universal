/**
 * FR-B16 — Intra-phase-only: timeout stub is scoped to the current phase.
 * On phase transition, cleanPhaseArtifacts archives TASK_NOTES.md to
 * TASK_NOTES-pickle.md and removes the canonical path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SM_PATH = path.resolve(__dirname, '../services/state-manager.js');
const PR_PATH = path.resolve(__dirname, '../bin/pipeline-runner.js');

const { writeTimeoutStub } = await import(SM_PATH);
const { cleanPhaseArtifacts } = await import(PR_PATH);

const MARKER = '<!-- pickle-rick: timeout-stub v1 -->';

function makeDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-lifecycle-')));
}

test('FR-B16: pickle stub archived to TASK_NOTES-pickle.md on phase transition; canonical path absent post-transition', () => {
  const dir = makeDir();
  const stubPath = path.join(dir, 'TASK_NOTES.md');
  const archivedPath = path.join(dir, 'TASK_NOTES-pickle.md');
  const logFile = path.join(dir, 'iter.log');
  fs.writeFileSync(logFile, 'last log entry\n');

  try {
    writeTimeoutStub(dir, {
      ticketId: 'abc',
      iteration: 2,
      wallSeconds: 120,
      workerTimeoutSeconds: 600,
      timeoutCount: 1,
      logFile,
    });

    assert.ok(fs.existsSync(stubPath), 'stub must exist before transition');
    const stubContent = fs.readFileSync(stubPath, 'utf-8');
    assert.ok(stubContent.startsWith(MARKER), 'stub must start with marker');

    cleanPhaseArtifacts(dir, 'pickle');

    assert.ok(!fs.existsSync(stubPath), 'canonical TASK_NOTES.md must be absent post-transition');
    assert.ok(fs.existsSync(archivedPath), 'TASK_NOTES-pickle.md must exist post-transition');

    const archived = fs.readFileSync(archivedPath, 'utf-8');
    assert.ok(archived.startsWith(MARKER), 'archived content must start with marker');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('FR-B16: canonical path empty post-transition when no TASK_NOTES.md written', () => {
  const dir = makeDir();
  const stubPath = path.join(dir, 'TASK_NOTES.md');

  try {
    assert.ok(!fs.existsSync(stubPath), 'precondition: no stub');
    cleanPhaseArtifacts(dir, 'pickle');
    assert.ok(!fs.existsSync(stubPath), 'canonical path absent when nothing to archive');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('FR-B16: Morty-written TASK_NOTES.md also archived on phase transition', () => {
  const dir = makeDir();
  const stubPath = path.join(dir, 'TASK_NOTES.md');
  const archivedPath = path.join(dir, 'TASK_NOTES-pickle.md');
  const mortyContent = '## Progress\nMorty notes here\n## Next\nDo more things\n';
  fs.writeFileSync(stubPath, mortyContent);

  try {
    cleanPhaseArtifacts(dir, 'pickle');
    assert.ok(!fs.existsSync(stubPath), 'canonical path absent after transition');
    assert.ok(fs.existsSync(archivedPath), 'archive must exist');
    assert.equal(fs.readFileSync(archivedPath, 'utf-8'), mortyContent);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

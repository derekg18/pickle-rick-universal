/**
 * FR-B8/B9 — writeTimeoutStub behavior:
 *   - Written when TASK_NOTES.md is absent
 *   - Written when TASK_NOTES.md is empty
 *   - NOT written when Morty-written content exists (preserved)
 *   - First line is the stub marker
 *   - Fields (ticket_id, wallSeconds, iteration) present
 *   - Last non-empty log line included
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SM_PATH = path.resolve(__dirname, '../services/state-manager.js');

const { writeTimeoutStub } = await import(SM_PATH);

const MARKER = '<!-- pickle-rick: timeout-stub v1 -->';

function makeDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-stub-')));
}

function defaultMeta(logFile) {
  return {
    ticketId: 'abc123',
    iteration: 3,
    wallSeconds: 87.4,
    workerTimeoutSeconds: 1200,
    timeoutCount: 1,
    logFile,
  };
}

test('absent: stub written when TASK_NOTES.md does not exist', () => {
  const dir = makeDir();
  const stubPath = path.join(dir, 'TASK_NOTES.md');
  const logFile = path.join(dir, 'test.log');
  fs.writeFileSync(logFile, 'some log line\n');
  try {
    assert.ok(!fs.existsSync(stubPath), 'precondition: file absent');
    writeTimeoutStub(dir, defaultMeta(logFile));
    assert.ok(fs.existsSync(stubPath), 'stub must be written');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('empty: stub written when TASK_NOTES.md is 0 bytes', () => {
  const dir = makeDir();
  const stubPath = path.join(dir, 'TASK_NOTES.md');
  const logFile = path.join(dir, 'test.log');
  fs.writeFileSync(logFile, 'entry\n');
  fs.writeFileSync(stubPath, '');
  try {
    writeTimeoutStub(dir, defaultMeta(logFile));
    const content = fs.readFileSync(stubPath, 'utf-8');
    assert.ok(content.length > 0, 'stub must be written over empty file');
    assert.ok(content.startsWith(MARKER), 'must start with marker');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('preserve: Morty-written non-empty content is NOT overwritten', () => {
  const dir = makeDir();
  const stubPath = path.join(dir, 'TASK_NOTES.md');
  const logFile = path.join(dir, 'test.log');
  const mortyContent = '## Progress\nMorty did a thing\n';
  fs.writeFileSync(logFile, 'entry\n');
  fs.writeFileSync(stubPath, mortyContent);
  try {
    writeTimeoutStub(dir, defaultMeta(logFile));
    const content = fs.readFileSync(stubPath, 'utf-8');
    assert.equal(content, mortyContent, 'Morty content must be preserved');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('marker: first line of stub is the exact marker', () => {
  const dir = makeDir();
  const stubPath = path.join(dir, 'TASK_NOTES.md');
  const logFile = path.join(dir, 'test.log');
  fs.writeFileSync(logFile, 'line\n');
  try {
    writeTimeoutStub(dir, defaultMeta(logFile));
    const content = fs.readFileSync(stubPath, 'utf-8');
    const firstLine = content.split('\n')[0];
    assert.equal(firstLine, MARKER);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fields: stub contains ticket_id, wallSeconds, iteration', () => {
  const dir = makeDir();
  const logFile = path.join(dir, 'test.log');
  fs.writeFileSync(logFile, 'line\n');
  const meta = {
    ticketId: 'ticket-xyz',
    iteration: 7,
    wallSeconds: 543,
    workerTimeoutSeconds: 900,
    timeoutCount: 2,
    logFile,
  };
  try {
    writeTimeoutStub(dir, meta);
    const content = fs.readFileSync(path.join(dir, 'TASK_NOTES.md'), 'utf-8');
    assert.ok(content.includes('ticket-xyz'), 'must include ticketId');
    assert.match(content, /SIGTERM'd at 543s of 900s budget/,
      'wallSeconds must appear inside "SIGTERM\'d at …s of …s budget" phrase');
    assert.ok(content.includes('Iteration 7'), 'must include iteration');
    assert.match(content, /within 900s\./,
      'workerTimeoutSeconds must appear inside a "within …s." phrase');
    assert.ok(content.includes('Attempt: 2'), 'must include timeoutCount');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('last-log-line: stub includes last non-empty line of log file', () => {
  const dir = makeDir();
  const logFile = path.join(dir, 'test.log');
  fs.writeFileSync(logFile, 'first line\nsecond line\nthird line\n\n');
  try {
    writeTimeoutStub(dir, defaultMeta(logFile));
    const content = fs.readFileSync(path.join(dir, 'TASK_NOTES.md'), 'utf-8');
    assert.ok(content.includes('third line'), 'must include last non-empty log line');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('missing-log: stub written with placeholder when log file absent', () => {
  const dir = makeDir();
  const meta = defaultMeta(path.join(dir, 'nonexistent.log'));
  try {
    writeTimeoutStub(dir, meta);
    const content = fs.readFileSync(path.join(dir, 'TASK_NOTES.md'), 'utf-8');
    assert.ok(content.startsWith(MARKER));
    assert.ok(content.includes('(no log output)'), 'must have placeholder for missing log');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('idempotent: existing stub (marker) is not re-written', () => {
  const dir = makeDir();
  const stubPath = path.join(dir, 'TASK_NOTES.md');
  const logFile = path.join(dir, 'test.log');
  const existingStub = `${MARKER}\n# TASK_NOTES.md (synthesized stub)\n\n## Progress\nOld stub\n`;
  fs.writeFileSync(logFile, 'line\n');
  fs.writeFileSync(stubPath, existingStub);
  try {
    writeTimeoutStub(dir, defaultMeta(logFile));
    const content = fs.readFileSync(stubPath, 'utf-8');
    assert.equal(content, existingStub, 'existing stub must not be overwritten');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

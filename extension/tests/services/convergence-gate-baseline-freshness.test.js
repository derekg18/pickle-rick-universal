import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { assertBaselineFresh, BaselineMissingError, BaselineStaleError } from '../../services/convergence-gate.js';

function writeMinimalBaseline(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({
    schema_version: 1,
    captured_at: new Date().toISOString(),
    working_dir: '/tmp',
    project_type: 'npm',
    checks: [],
    failures: [],
  }));
}

test('assertBaselineFresh: throws BaselineMissingError + writes recovery md when baseline absent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fresh-missing-'));
  try {
    const baselinePath = path.join(dir, 'gate', 'baseline.json');
    assert.throws(
      () => assertBaselineFresh(baselinePath, { max_age_iterations: 30, max_age_seconds: 14400, current_iteration: 0 }),
      (err) => err instanceof BaselineMissingError
    );
    const gateDir = path.join(dir, 'gate');
    const files = fs.readdirSync(gateDir);
    assert.ok(
      files.some(f => f.startsWith('baseline_missing_') && f.endsWith('.md')),
      'recovery md written in gate/ dir'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('assertBaselineFresh: throws BaselineStaleError when mtime exceeds max_age_seconds', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fresh-mtime-'));
  try {
    const baselinePath = path.join(dir, 'baseline.json');
    writeMinimalBaseline(baselinePath);
    // Backdate mtime by 5 hours (> 14400s default)
    const oldTime = new Date(Date.now() - 5 * 3600 * 1000);
    fs.utimesSync(baselinePath, oldTime, oldTime);

    assert.throws(
      () => assertBaselineFresh(baselinePath, { max_age_iterations: 30, max_age_seconds: 14400, current_iteration: 0 }),
      (err) => err instanceof BaselineStaleError
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('assertBaselineFresh: throws BaselineStaleError when current_iteration >= max_age_iterations', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fresh-iter-'));
  try {
    const baselinePath = path.join(dir, 'baseline.json');
    writeMinimalBaseline(baselinePath);

    assert.throws(
      () => assertBaselineFresh(baselinePath, { max_age_iterations: 30, max_age_seconds: 14400, current_iteration: 30 }),
      (err) => err instanceof BaselineStaleError
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('assertBaselineFresh: does not throw for fresh baseline', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fresh-ok-'));
  try {
    const baselinePath = path.join(dir, 'baseline.json');
    writeMinimalBaseline(baselinePath);

    assert.doesNotThrow(() =>
      assertBaselineFresh(baselinePath, { max_age_iterations: 30, max_age_seconds: 14400, current_iteration: 0 })
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

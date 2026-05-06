import assert from 'node:assert';
import { test, describe, before, after } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { writeFinalReport, getBestScore, markMicroverseFatalError } from '../bin/microverse-runner.js';

describe('microverse-runner finalizer', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-finalizer-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('getBestScore returns baseline in worker mode (missing convergence)', () => {
    const state = {
      key_metric: { direction: 'higher' },
      baseline_score: 70,
      // no convergence object
    };
    const score = getBestScore(state);
    assert.strictEqual(score, 70, 'Should return baseline_score when convergence is missing');
  });

  test('getBestScore returns null for partial worker state without metric fields', () => {
    const state = {
      status: 'stopped',
      exit_reason: 'error',
      // no key_metric, baseline_score, or convergence object
    };
    const score = getBestScore(state);
    assert.strictEqual(score, null, 'Should tolerate partial worker state without throwing');
  });

  test('writeFinalReport does not throw in worker mode (missing convergence)', () => {
    const state = {
      status: 'converged',
      exit_reason: 'converged',
      key_metric: { description: 'test worker metric', type: 'none' },
      convergence_mode: 'worker',
      convergence_file: 'anatomy-park.json',
      failed_approaches: [],
      failure_history: [],
      // no convergence object
    };

    // Should not throw
    writeFinalReport(tmpDir, state, 'converged', 2, 100);

    const memoryDir = path.join(tmpDir, 'memory');
    assert.ok(fs.existsSync(memoryDir), 'Memory dir should be created');
    
    const files = fs.readdirSync(memoryDir);
    const reportFile = files.find(f => f.startsWith('microverse_report_'));
    assert.ok(reportFile, 'Final report file should be created');

    const content = fs.readFileSync(path.join(memoryDir, reportFile), 'utf8');
    assert.ok(content.includes('**Convergence Mode**: worker'), 'Report should show worker mode');
    assert.ok(content.includes('**Worker Convergence Signal**: see anatomy-park.json'), 'Report should reference convergence file');
    assert.ok(!content.includes('Iteration History'), 'Report should omit history table when missing');
  });

  test('writeFinalReport handles empty failure history', () => {
     const state = {
      status: 'stopped',
      exit_reason: 'error',
      key_metric: { description: 'test metric', type: 'command' },
      convergence: { history: [], stall_limit: 5, stall_counter: 0 },
      failed_approaches: [],
      failure_history: [],
    };

    writeFinalReport(tmpDir, state, 'error', 0, 10);
    // Success is not throwing
  });

  test('markMicroverseFatalError preserves success marker', () => {
    const mvPath = path.join(tmpDir, 'microverse.json');
    const successState = {
      status: 'converged',
      exit_reason: 'converged',
      key_metric: { description: 'test', type: 'none' },
    };
    fs.writeFileSync(mvPath, JSON.stringify(successState));

    const testError = new Error('Post-success crash');
    markMicroverseFatalError(tmpDir, testError);

    const preserved = JSON.parse(fs.readFileSync(mvPath, 'utf8'));
    assert.strictEqual(preserved.exit_reason, 'converged', 'Should not overwrite successful exit_reason');
    assert.strictEqual(preserved.finalizer_error.message, 'Post-success crash', 'Should record finalizer error message in main file');

    const errorPath = path.join(tmpDir, 'microverse-finalizer-error.json');
    assert.ok(fs.existsSync(errorPath), 'Should write sibling error file');
    const errorData = JSON.parse(fs.readFileSync(errorPath, 'utf8'));
    assert.strictEqual(errorData.status, 'crashed');
    assert.strictEqual(errorData.error.message, 'Post-success crash', 'Error field should have a message property');
  });
});

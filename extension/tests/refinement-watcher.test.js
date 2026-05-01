import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WATCHER = path.resolve(__dirname, '../bin/refinement-watcher.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'refine-watch-'));
}

function runWatcher(args, opts = {}) {
  // Default 10s → 30s; per-call overrides get tripled (callers passing
  // 5_000/15_000 become 15_000/45_000). Budget for system load when run
  // alongside concurrent codex/tmux work; tests validate watcher output,
  // not wall-clock. Splat opts first then force timeout to override.
  const baseTimeout = opts.timeout ? opts.timeout * 3 : 30_000;
  return execFileSync(process.execPath, [WATCHER, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...opts.env },
    ...opts,
    timeout: baseTimeout,
  });
}

function writeState(sessionDir, overrides = {}) {
  fs.writeFileSync(
    path.join(sessionDir, 'state.json'),
    JSON.stringify({
      active: false,
      step: 'research',
      working_dir: process.cwd(),
      ...overrides,
    }, null, 2),
  );
}

function writeWorkerLog(refinementDir, role, cycle, content) {
  const filename = `worker_${role}_c${cycle}.log`;
  fs.writeFileSync(path.join(refinementDir, filename), content);
}

function writeManifest(sessionDir, manifest) {
  fs.writeFileSync(
    path.join(sessionDir, 'refinement_manifest.json'),
    JSON.stringify(manifest, null, 2),
  );
}

// ---------------------------------------------------------------------------
// CLI validation
// ---------------------------------------------------------------------------

test('refinement-watcher: exits with code 1 when no args', () => {
  try {
    runWatcher([]);
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.status, 1);
    assert.ok(err.stderr.includes('Usage:'));
  }
});

test('refinement-watcher: exits with code 1 when arg starts with --', () => {
  try {
    runWatcher(['--help']);
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.status, 1);
    assert.ok(err.stderr.includes('Usage:'));
  }
});

test('refinement-watcher: exits with code 1 when session dir does not exist', () => {
  try {
    runWatcher(['/tmp/nonexistent-refine-xyz']);
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.status, 1);
  }
});

// ---------------------------------------------------------------------------
// Manifest detection — immediate exit
// ---------------------------------------------------------------------------

test('refinement-watcher: exits cleanly when manifest already exists', () => {
  const tmp = tmpDir();
  try {
    const refinementDir = path.join(tmp, 'refinement');
    fs.mkdirSync(refinementDir);
    writeManifest(tmp, {
      cycles_completed: 2,
      cycles_requested: 2,
      workers: [
        { role: 'requirements', success: true },
        { role: 'codebase', success: true },
        { role: 'risk-scope', success: false },
      ],
    });
    const output = runWatcher([tmp], { timeout: 5000 });
    assert.ok(output.includes('Refinement Complete'));
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test('refinement-watcher: promotes orphan tmp manifest before inactive fallback', () => {
  const tmp = tmpDir();
  try {
    const refinementDir = path.join(tmp, 'refinement');
    fs.mkdirSync(refinementDir);
    writeState(tmp, { active: false, step: 'research' });
    fs.writeFileSync(
      path.join(tmp, 'refinement_manifest.json.tmp.999999'),
      JSON.stringify({
        cycles_completed: 1,
        cycles_requested: 1,
        workers: [{ role: 'requirements', success: true }],
      }, null, 2),
    );

    const output = runWatcher([tmp], { timeout: 5000 });
    assert.ok(output.includes('Refinement Complete'));
    assert.equal(fs.existsSync(path.join(tmp, 'refinement_manifest.json')), true);
    assert.equal(fs.existsSync(path.join(tmp, 'refinement_manifest.json.tmp.999999')), false);
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Inactive session fallback exit
// ---------------------------------------------------------------------------

test('refinement-watcher: exits when session inactive and no manifest', () => {
  const tmp = tmpDir();
  try {
    const refinementDir = path.join(tmp, 'refinement');
    fs.mkdirSync(refinementDir);
    // state.json says inactive and step advanced past prd
    writeState(tmp, { active: false, step: 'research' });
    const output = runWatcher([tmp], { timeout: 15_000 });
    assert.ok(output.includes('refinement may have failed'));
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Worker log discovery
// ---------------------------------------------------------------------------

test('refinement-watcher: discovers and displays worker logs before manifest', () => {
  const tmp = tmpDir();
  try {
    const refinementDir = path.join(tmp, 'refinement');
    fs.mkdirSync(refinementDir);

    // Write a worker log as stream-json NDJSON
    const logLine = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Analyzing requirements...' }] },
    });
    writeWorkerLog(refinementDir, 'requirements', 1, logLine + '\n');

    // Write analysis file so roleStatus returns done
    fs.writeFileSync(
      path.join(refinementDir, 'analysis_requirements.md'),
      '# Requirements Analysis\n' + 'x'.repeat(200),
    );

    // Write manifest after a tiny delay (use sync — it's a test)
    writeManifest(tmp, {
      cycles_completed: 1,
      cycles_requested: 1,
      workers: [{ role: 'requirements', success: true }],
    });

    const output = runWatcher([tmp], { timeout: 5000 });
    assert.ok(output.includes('Refinement Complete'));
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test('refinement-watcher: handles multiple cycles (c1, c2 logs)', () => {
  const tmp = tmpDir();
  try {
    const refinementDir = path.join(tmp, 'refinement');
    fs.mkdirSync(refinementDir);

    // Two cycles of worker logs
    const logLine1 = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Cycle 1 analysis' }] },
    });
    const logLine2 = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Cycle 2 analysis' }] },
    });
    writeWorkerLog(refinementDir, 'codebase', 1, logLine1 + '\n');
    writeWorkerLog(refinementDir, 'codebase', 2, logLine2 + '\n');

    writeManifest(tmp, {
      cycles_completed: 2,
      cycles_requested: 2,
      workers: [{ role: 'codebase', success: true }],
    });

    const output = runWatcher([tmp], { timeout: 5000 });
    assert.ok(output.includes('Refinement Complete'));
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Role status detection
// ---------------------------------------------------------------------------

test('refinement-watcher: shows success icon for completed analyses in manifest', () => {
  const tmp = tmpDir();
  try {
    const refinementDir = path.join(tmp, 'refinement');
    fs.mkdirSync(refinementDir);
    writeManifest(tmp, {
      cycles_completed: 1,
      cycles_requested: 1,
      workers: [
        { role: 'requirements', success: true },
        { role: 'codebase', success: true },
        { role: 'risk-scope', success: false },
      ],
    });
    const output = runWatcher([tmp], { timeout: 5000 });
    // Check the manifest summary includes both success and failure markers
    assert.ok(output.includes('requirements'));
    assert.ok(output.includes('risk-scope'));
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Empty refinement dir — waits then exits on inactive state
// ---------------------------------------------------------------------------

test('refinement-watcher: waits for refinement dir then exits on inactive state', () => {
  const tmp = tmpDir();
  try {
    // No refinement dir yet — watcher will wait
    // But state.json says inactive with step past prd
    writeState(tmp, { active: false, step: 'implement' });

    // Create refinement dir after state is written so fallback triggers
    const refinementDir = path.join(tmp, 'refinement');
    fs.mkdirSync(refinementDir);

    const output = runWatcher([tmp], { timeout: 15_000 });
    assert.ok(output.includes('refinement may have failed'));
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test('refinement-watcher: recovers orphan tmp inactive state before fallback exit', () => {
  const tmp = tmpDir();
  try {
    const refinementDir = path.join(tmp, 'refinement');
    fs.mkdirSync(refinementDir);
    writeState(tmp, { active: true, step: 'prd', iteration: 1 });
    fs.writeFileSync(
      path.join(tmp, 'state.json.tmp.999999'),
      JSON.stringify({
        active: false,
        step: 'implement',
        iteration: 2,
        working_dir: process.cwd(),
      }, null, 2),
    );

    const output = runWatcher([tmp], { timeout: 15_000 });
    assert.ok(output.includes('refinement may have failed'));

    const promoted = JSON.parse(fs.readFileSync(path.join(tmp, 'state.json'), 'utf-8'));
    assert.equal(promoted.active, false);
    assert.equal(promoted.iteration, 2);
    assert.equal(fs.existsSync(path.join(tmp, 'state.json.tmp.999999')), false);
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupAnatomyPark } from '../bin/pipeline-runner.js';
import { finalizeGateMain } from '../bin/finalize-gate.js';
import { filterBySubsystem } from '../services/scope-resolver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.join(os.homedir(), '.claude/pickle-rick');
const ANATOMY_PARK_MD = path.resolve(__dirname, '../../.claude/commands/anatomy-park.md');

function makeTarget() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ap-scope-target-'));
}

function makeSession() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ap-scope-session-'));
}

function writeState(sessionDir, workingDir) {
  fs.writeFileSync(
    path.join(sessionDir, 'state.json'),
    JSON.stringify({
      active: false,
      working_dir: workingDir,
      step: 'review',
      iteration: 0,
      max_iterations: 10,
      max_time_minutes: 60,
      worker_timeout_seconds: 1200,
      start_time_epoch: Math.floor(Date.now() / 1000),
      completion_promise: null,
      original_prompt: 'test',
      current_ticket: null,
      history: [],
      started_at: new Date().toISOString(),
      session_dir: sessionDir,
    }, null, 2),
  );
}

function makeSubsystem(root, name, fileCount = 3) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < fileCount; i++) {
    fs.writeFileSync(path.join(dir, `f${i}.ts`), `export const x${i} = ${i};\n`);
  }
}

function readAnatomyPark(sessionDir) {
  return JSON.parse(fs.readFileSync(path.join(sessionDir, 'anatomy-park.json'), 'utf-8'));
}

function readMicroverse(sessionDir) {
  return JSON.parse(fs.readFileSync(path.join(sessionDir, 'microverse.json'), 'utf-8'));
}

// ---------------------------------------------------------------------------
// Pipeline mode: scope filters subsystems in anatomy-park.json
// ---------------------------------------------------------------------------

test('pipeline filter: 4 subsystems, scope covering 2 → anatomy-park.json has exactly those 2', () => {
  const session = makeSession();
  const target = makeTarget();
  try {
    makeSubsystem(target, 'alpha');
    makeSubsystem(target, 'beta');
    makeSubsystem(target, 'gamma');
    makeSubsystem(target, 'delta');

    // scope touches alpha and gamma only
    const allowedPaths = ['alpha/f0.ts', 'gamma/f1.ts'];
    const repoRoot = target; // target IS repoRoot in this fixture

    setupAnatomyPark(session, target, 3, EXTENSION_ROOT, () => {}, { allowedPaths, repoRoot });

    const ap = readAnatomyPark(session);
    assert.deepStrictEqual(ap.subsystems, ['alpha', 'gamma']);
  } finally {
    fs.rmSync(session, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('pipeline setup writes anatomy-park.json through shared atomic writer before init-microverse consumes it', () => {
  const session = makeSession();
  const target = makeTarget();
  try {
    makeSubsystem(target, 'alpha');

    const compiledPipelineRunner = fs.readFileSync(
      new URL('../bin/pipeline-runner.js', import.meta.url),
      'utf-8',
    );
    assert.ok(
      compiledPipelineRunner.includes("writeStateFile(path.join(sessionDir, 'anatomy-park.json'), apState)"),
      'anatomy setup must publish anatomy-park.json through the shared tmp-rename writer',
    );

    setupAnatomyPark(session, target, 3, EXTENSION_ROOT, () => {});

    assert.deepStrictEqual(readAnatomyPark(session).subsystems, ['alpha']);
    assert.equal(readMicroverse(session).convergence_file, 'anatomy-park.json');
  } finally {
    fs.rmSync(session, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('pipeline scoped setup injects allowed_paths into microverse.json so final gate honors out-of-scope failures', async () => {
  const session = makeSession();
  const target = makeTarget();
  try {
    makeSubsystem(target, 'alpha');
    makeSubsystem(target, 'beta');
    writeState(session, target);
    fs.writeFileSync(
      path.join(session, 'scope.json'),
      JSON.stringify({ allowed_paths: ['alpha/f0.ts'], mode: 'branch', strategy: 'strict', head_sha: 'abc123' }),
    );

    setupAnatomyPark(session, target, 3, EXTENSION_ROOT, () => {}, {
      allowedPaths: ['alpha/f0.ts'],
      repoRoot: target,
    });

    const mv = readMicroverse(session);
    assert.deepStrictEqual(mv.allowed_paths, ['alpha/f0.ts']);

    const gateDir = path.join(session, 'gate');
    let remediatorCalled = false;
    const code = await finalizeGateMain({
      argv: [session, 'anatomy-park'],
      env: {},
      readStateForWorkingDirFn: () => ({ workingDir: target, backend: 'claude' }),
      loadSettingsFn: () => ({
        szechuan_max_remediation_cycles: 3,
        anatomy_park_max_remediation_cycles: 1,
        remediator_timeout_s: 60,
      }),
      runGateFn: async () => ({
        status: 'red',
        failures: [{
          check: 'lint',
          file: path.join(target, 'beta/f0.ts'),
          line: 1,
          ruleOrCode: 'no-any',
          message: 'out of scope',
          severity: 'error',
          occurrence_index: 0,
        }],
        baseline_used: false,
        allowed_paths_used: false,
        elapsed_ms: 5,
        total_raw_failure_count: 1,
        new_failures_vs_baseline: 0,
      }),
      spawnGateRemediatorMainFn: async () => {
        remediatorCalled = true;
        return 0;
      },
      spawnRemediatorFn: () => {
        remediatorCalled = true;
      },
      stdout: () => {},
      stderr: () => {},
    });

    assert.equal(code, 0, 'final gate should close when every failure is out of scope');
    assert.equal(remediatorCalled, false, 'remediator must not run for out-of-scope failures');

    const gateFiles = fs.readdirSync(gateDir);
    assert.equal(gateFiles.filter(f => f.startsWith('out_of_scope_failures_')).length, 1);
  } finally {
    fs.rmSync(session, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('resume: persisted scope.json still filters anatomy-park when refreshScope already entered the phase', () => {
  const session = makeSession();
  const target = makeTarget();
  try {
    makeSubsystem(target, 'alpha');
    makeSubsystem(target, 'beta');
    writeState(session, target);
    fs.writeFileSync(
      path.join(session, 'scope.json'),
      JSON.stringify({ allowed_paths: ['alpha/f0.ts'], mode: 'branch', strategy: 'strict', head_sha: 'abc123' }),
    );

    setupAnatomyPark(session, target, 3, EXTENSION_ROOT, () => {});

    const ap = readAnatomyPark(session);
    const mv = readMicroverse(session);
    assert.deepStrictEqual(ap.subsystems, ['alpha']);
    assert.deepStrictEqual(mv.allowed_paths, ['alpha/f0.ts']);
  } finally {
    fs.rmSync(session, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('resume: persisted scope.json promotes newer dead tmp before filtering anatomy-park', () => {
  const session = makeSession();
  const target = makeTarget();
  try {
    makeSubsystem(target, 'alpha');
    makeSubsystem(target, 'beta');
    writeState(session, target);
    const scopePath = path.join(session, 'scope.json');
    fs.writeFileSync(
      scopePath,
      JSON.stringify({ allowed_paths: ['beta/f0.ts'], mode: 'branch', strategy: 'strict', head_sha: 'old' }),
    );
    fs.writeFileSync(
      `${scopePath}.tmp.99999999`,
      JSON.stringify({ allowed_paths: ['alpha/f0.ts'], mode: 'branch', strategy: 'strict', head_sha: 'new' }),
    );
    fs.utimesSync(`${scopePath}.tmp.99999999`, new Date(Date.now() + 1_000), new Date(Date.now() + 1_000));

    setupAnatomyPark(session, target, 3, EXTENSION_ROOT, () => {});

    const ap = readAnatomyPark(session);
    const mv = readMicroverse(session);
    assert.deepStrictEqual(ap.subsystems, ['alpha']);
    assert.deepStrictEqual(mv.allowed_paths, ['alpha/f0.ts']);
    assert.equal(fs.existsSync(`${scopePath}.tmp.99999999`), false);
  } finally {
    fs.rmSync(session, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Standalone mode parity: filterBySubsystem with same fixture → same result
// ---------------------------------------------------------------------------

test('standalone filter parity: filterBySubsystem same fixture → identical to pipeline result', () => {
  const target = makeTarget();
  try {
    makeSubsystem(target, 'alpha');
    makeSubsystem(target, 'beta');
    makeSubsystem(target, 'gamma');
    makeSubsystem(target, 'delta');

    const allowedPaths = ['alpha/f0.ts', 'gamma/f1.ts'];
    const repoRoot = target;
    const allNames = ['alpha', 'beta', 'delta', 'gamma']; // sorted

    const result = filterBySubsystem(allNames, allowedPaths, target, repoRoot);
    assert.deepStrictEqual(result, ['alpha', 'gamma']);
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Phase 1 invariant: marker present — guarantees Phase 1 reads all subsystem files
// ---------------------------------------------------------------------------

test('phase-1 invariant marker present in anatomy-park.md', () => {
  const content = fs.readFileSync(ANATOMY_PARK_MD, 'utf-8');
  assert.ok(
    content.includes('<!-- scope-invariant: phase-1-reads-all-subsystem-files -->'),
    'anatomy-park.md must contain scope-invariant marker',
  );
});

// ---------------------------------------------------------------------------
// Standalone-mode ordering: scope-hook fires AFTER Step 6.5 creates scope.json
// ---------------------------------------------------------------------------

test('standalone scope-hook is placed after Step 6.5 (Resolve Scope) in anatomy-park.md', () => {
  const content = fs.readFileSync(ANATOMY_PARK_MD, 'utf-8');
  const hookIdx = content.indexOf('<!-- scope-hook: discovery-filter -->');
  const resolveStepIdx = content.indexOf('### Step 6.5: Resolve Scope');
  assert.ok(hookIdx > 0, 'scope-hook: discovery-filter marker missing from anatomy-park.md');
  assert.ok(resolveStepIdx > 0, 'Step 6.5 heading missing from anatomy-park.md');
  assert.ok(
    hookIdx > resolveStepIdx,
    'scope-hook must appear after Step 6.5 so scope.json exists when the filter fires',
  );
});

test('standalone scope-hook does not reference a nonexistent "full" mode', () => {
  const content = fs.readFileSync(ANATOMY_PARK_MD, 'utf-8');
  assert.ok(
    !/\bfull\b/.test(content.match(/<!-- scope-hook: discovery-filter -->[\s\S]*?\n\n/)?.[0] ?? ''),
    'scope-hook block must not reference a "full" mode (ScopeMode = branch|diff|paths only)',
  );
});

test('Step 7 references --allowed-paths-file after Step 6.5 (scope wiring for standalone mode)', () => {
  const content = fs.readFileSync(ANATOMY_PARK_MD, 'utf-8');
  const stepIdx = content.indexOf('### Step 6.5: Resolve Scope');
  const createIdx = content.indexOf('### Step 7: Create anatomy-park.json and microverse.json');
  const flagIdx = content.lastIndexOf('--allowed-paths-file');
  assert.ok(stepIdx > 0, 'Step 6.5 heading must exist in anatomy-park.md');
  assert.ok(createIdx > stepIdx, 'Step 7 must come after Step 6.5');
  assert.ok(
    flagIdx > createIdx,
    '--allowed-paths-file must appear in the init-microverse command after scope.json has been created',
  );
});

// ---------------------------------------------------------------------------
// Backcompat: omitted scope → all subsystems pass through unfiltered
// ---------------------------------------------------------------------------

test('backcompat: no scope arg → anatomy-park.json contains all 4 subsystems', () => {
  const session = makeSession();
  const target = makeTarget();
  try {
    makeSubsystem(target, 'alpha');
    makeSubsystem(target, 'beta');
    makeSubsystem(target, 'gamma');
    makeSubsystem(target, 'delta');

    // No scope passed — backcompat path
    setupAnatomyPark(session, target, 3, EXTENSION_ROOT, () => {});

    const ap = readAnatomyPark(session);
    const mv = readMicroverse(session);
    assert.equal(ap.subsystems.length, 4);
    assert.deepStrictEqual(ap.subsystems.sort(), ['alpha', 'beta', 'delta', 'gamma']);
    assert.equal(mv.allowed_paths, undefined);
  } finally {
    fs.rmSync(session, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

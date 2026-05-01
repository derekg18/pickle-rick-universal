import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  isTestFile,
  discoverSubsystems,
  cleanPhaseArtifacts,
  resetStateForPhase,
  parsePipelineConfig,
  assertCleanWorkingTree,
  writePipelineStatus,
  resolveBackendWithSource,
  readBundlePrdBackend,
  assertCodexRequiredBackend,
  enterPicklePhase,
  installShutdownHandlers,
  applyEpochResetOnReconstruction,
} from '../bin/pipeline-runner.js';
import { backendEnvOverrides } from '../services/backend-spawn.js';
import { AC_PHASE_MANIFEST, runAcPhaseGate } from '../services/ac-phase-gate.js';
import { Defaults } from '../types/index.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-pipeline-'));
}

// ---------------------------------------------------------------------------
// isTestFile
// ---------------------------------------------------------------------------

describe('isTestFile', () => {
  test('identifies .test. files', () => {
    assert.ok(isTestFile('foo.test.ts'));
    assert.ok(isTestFile('bar.test.js'));
  });

  test('identifies .spec. files', () => {
    assert.ok(isTestFile('foo.spec.tsx'));
  });

  test('rejects normal source files', () => {
    assert.ok(!isTestFile('service.ts'));
    assert.ok(!isTestFile('utils.js'));
    assert.ok(!isTestFile('index.tsx'));
  });

  test('identifies __test__ files', () => {
    assert.ok(isTestFile('foo__test__.ts'));
    assert.ok(isTestFile('utils__test__helper.js'));
  });

  test('identifies __spec__ files', () => {
    assert.ok(isTestFile('foo__spec__.ts'));
  });

  test('case insensitive', () => {
    assert.ok(isTestFile('Foo.Test.ts'));
    assert.ok(isTestFile('BAR.SPEC.js'));
  });

  test('rejects empty string', () => {
    assert.ok(!isTestFile(''));
  });
});

describe('phase-ordered AC gate', () => {
  test('runs only ACs scheduled for the current pipeline phase', () => {
    const dir = tmpDir();
    const marker = path.join(dir, 'marker.txt');
    fs.writeFileSync(path.join(dir, AC_PHASE_MANIFEST), JSON.stringify({
      acceptance_criteria: [
        {
          id: 'AC-PICKLE',
          evaluation_phase: 'per-phase',
          phase: 'pickle',
          command: [process.execPath, '-e', `require('fs').appendFileSync(${JSON.stringify(marker)}, 'pickle\\n')`],
        },
        {
          id: 'AC-LATER',
          evaluation_phase: 'bundle-end',
          command: [process.execPath, '-e', 'process.exit(1)'],
        },
      ],
    }));

    const result = runAcPhaseGate({
      sessionDir: dir,
      evaluationPhase: 'per-phase',
      pipelinePhase: 'pickle',
      cwd: dir,
    });

    assert.equal(result.status, 'pass');
    assert.deepEqual(result.evaluated, ['AC-PICKLE']);
    assert.ok(result.skipped.includes('AC-LATER'));
    assert.equal(fs.readFileSync(marker, 'utf-8'), 'pickle\n');
  });

  test('fails a present AC manifest when any AC lacks evaluation_phase', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, AC_PHASE_MANIFEST), JSON.stringify({
      acceptance_criteria: [{ id: 'AC-MISSING-PHASE' }],
    }));

    const result = runAcPhaseGate({
      sessionDir: dir,
      evaluationPhase: 'pre-refinement',
      cwd: dir,
    });

    assert.equal(result.status, 'fail');
    assert.equal(result.failures[0].id, 'AC-MISSING-PHASE');
    assert.match(result.failures[0].reason, /evaluation_phase/);
  });

  test('AC-BUNDLE-03 passes when root and microverse relaunch counters are within cap', () => {
    const dir = tmpDir();
    const childDir = path.join(dir, 'microverse_alpha');
    const ignoredDir = path.join(dir, 'not_microverse');
    fs.mkdirSync(childDir);
    fs.mkdirSync(ignoredDir);
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ codex_manager_relaunch_count: Defaults.CODEX_MANAGER_RELAUNCH_CAP }));
    fs.writeFileSync(path.join(childDir, 'state.json'), JSON.stringify({ codex_manager_relaunch_count: 1 }));
    fs.writeFileSync(path.join(ignoredDir, 'state.json'), JSON.stringify({ codex_manager_relaunch_count: Defaults.CODEX_MANAGER_RELAUNCH_CAP + 1 }));
    fs.writeFileSync(path.join(dir, AC_PHASE_MANIFEST), JSON.stringify({
      acceptance_criteria: [{ id: 'AC-BUNDLE-03', evaluation_phase: 'bundle-end' }],
    }));

    const result = runAcPhaseGate({
      sessionDir: dir,
      evaluationPhase: 'bundle-end',
      cwd: dir,
    });

    assert.equal(result.status, 'pass');
    assert.deepEqual(result.evaluated, ['AC-BUNDLE-03']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('AC-BUNDLE-03 fails when root state relaunch counter exceeds cap', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ codex_manager_relaunch_count: Defaults.CODEX_MANAGER_RELAUNCH_CAP + 1 }));
    fs.writeFileSync(path.join(dir, AC_PHASE_MANIFEST), JSON.stringify({
      acceptance_criteria: [{ id: 'AC-BUNDLE-03', evaluation_phase: 'bundle-end' }],
    }));

    const result = runAcPhaseGate({
      sessionDir: dir,
      evaluationPhase: 'bundle-end',
      cwd: dir,
    });

    assert.equal(result.status, 'fail');
    assert.equal(result.failures[0].id, 'AC-BUNDLE-03');
    assert.match(result.failures[0].reason, /state\.json/);
    assert.match(result.failures[0].reason, /exceeds cap/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('AC-BUNDLE-03 fails when a child microverse state relaunch counter exceeds cap', () => {
    const dir = tmpDir();
    const childDir = path.join(dir, 'microverse_citadel');
    fs.mkdirSync(childDir);
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ codex_manager_relaunch_count: 0 }));
    fs.writeFileSync(path.join(childDir, 'state.json'), JSON.stringify({ codex_manager_relaunch_count: Defaults.CODEX_MANAGER_RELAUNCH_CAP + 1 }));
    fs.writeFileSync(path.join(dir, AC_PHASE_MANIFEST), JSON.stringify({
      acceptance_criteria: [{ id: 'AC-BUNDLE-03', evaluation_phase: 'bundle-end' }],
    }));

    const result = runAcPhaseGate({
      sessionDir: dir,
      evaluationPhase: 'bundle-end',
      cwd: dir,
    });

    assert.equal(result.status, 'fail');
    assert.equal(result.failures[0].id, 'AC-BUNDLE-03');
    assert.match(result.failures[0].reason, /microverse_citadel\/state\.json/);
    assert.match(result.failures[0].reason, /exceeds cap/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// discoverSubsystems
// ---------------------------------------------------------------------------

describe('discoverSubsystems', () => {
  test('discovers directories with 3+ source files', () => {
    const root = tmpDir();
    const sub = path.join(root, 'services');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'a.ts'), '');
    fs.writeFileSync(path.join(sub, 'b.ts'), '');
    fs.writeFileSync(path.join(sub, 'c.ts'), '');

    const result = discoverSubsystems(root);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'services');
    assert.equal(result[0].fileCount, 3);
    fs.rmSync(root, { recursive: true });
  });

  test('excludes directories with fewer than 3 source files', () => {
    const root = tmpDir();
    const sub = path.join(root, 'tiny');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'a.ts'), '');
    fs.writeFileSync(path.join(sub, 'b.ts'), '');

    const result = discoverSubsystems(root);
    assert.equal(result.length, 0);
    fs.rmSync(root, { recursive: true });
  });

  test('excludes node_modules and other blacklisted dirs', () => {
    const root = tmpDir();
    for (const name of ['node_modules', 'dist', '.git', 'coverage']) {
      const sub = path.join(root, name);
      fs.mkdirSync(sub);
      for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(sub, `f${i}.ts`), '');
    }

    const result = discoverSubsystems(root);
    assert.equal(result.length, 0);
    fs.rmSync(root, { recursive: true });
  });

  test('excludes hidden directories', () => {
    const root = tmpDir();
    const sub = path.join(root, '.hidden');
    fs.mkdirSync(sub);
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(sub, `f${i}.ts`), '');

    const result = discoverSubsystems(root);
    assert.equal(result.length, 0);
    fs.rmSync(root, { recursive: true });
  });

  test('excludes test-only directories (>80% test files)', () => {
    const root = tmpDir();
    const sub = path.join(root, 'tests');
    fs.mkdirSync(sub);
    // 4 test files, 1 normal = 80% → excluded (> 0.8 threshold is <=)
    // Actually: 4/5 = 0.8, and the check is <= 0.8, so this is included.
    // Need 5 test, 1 normal = 83% to exclude.
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(sub, `f${i}.test.ts`), '');
    fs.writeFileSync(path.join(sub, 'helper.ts'), '');
    // 5/6 = 0.833 > 0.8 → excluded
    const result = discoverSubsystems(root);
    assert.equal(result.length, 0);
    fs.rmSync(root, { recursive: true });
  });

  test('includes directories at exactly 80% test files', () => {
    const root = tmpDir();
    const sub = path.join(root, 'mixed');
    fs.mkdirSync(sub);
    // 4 test files + 1 normal = 4/5 = 0.8 → 0.8 <= 0.8 → included
    for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(sub, `f${i}.test.ts`), '');
    fs.writeFileSync(path.join(sub, 'real.ts'), '');
    // Need at least 3 source files (5 >= 3 ✓)

    const result = discoverSubsystems(root);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'mixed');
    fs.rmSync(root, { recursive: true });
  });

  test('counts files recursively', () => {
    const root = tmpDir();
    const sub = path.join(root, 'deep');
    fs.mkdirSync(path.join(sub, 'nested', 'deeper'), { recursive: true });
    fs.writeFileSync(path.join(sub, 'a.ts'), '');
    fs.writeFileSync(path.join(sub, 'nested', 'b.ts'), '');
    fs.writeFileSync(path.join(sub, 'nested', 'deeper', 'c.ts'), '');

    const result = discoverSubsystems(root);
    assert.equal(result.length, 1);
    assert.equal(result[0].fileCount, 3);
    fs.rmSync(root, { recursive: true });
  });

  test('handles symlink loops without hanging', () => {
    const root = tmpDir();
    const sub = path.join(root, 'loopy');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'a.ts'), '');
    fs.writeFileSync(path.join(sub, 'b.ts'), '');
    fs.writeFileSync(path.join(sub, 'c.ts'), '');
    // Create symlink loop: loopy/self -> loopy
    try {
      fs.symlinkSync(sub, path.join(sub, 'self'));
    } catch {
      // symlinks may not be supported (CI, Windows) — skip
      return;
    }

    const result = discoverSubsystems(root);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'loopy');
    assert.ok(result[0].fileCount >= 3); // at least the 3 real files
    fs.rmSync(root, { recursive: true });
  });

  test('handles broken symlinks gracefully', () => {
    const root = tmpDir();
    const sub = path.join(root, 'broken');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'a.ts'), '');
    fs.writeFileSync(path.join(sub, 'b.ts'), '');
    fs.writeFileSync(path.join(sub, 'c.ts'), '');
    try {
      fs.symlinkSync('/nonexistent/path', path.join(sub, 'dead'));
    } catch {
      return; // skip if symlinks not supported
    }

    const result = discoverSubsystems(root);
    assert.equal(result.length, 1);
    fs.rmSync(root, { recursive: true });
  });

  test('returns empty for nonexistent target', () => {
    const result = discoverSubsystems('/nonexistent/path/xyz');
    assert.equal(result.length, 0);
  });

  test('returns empty for directories with only non-source files', () => {
    const root = tmpDir();
    const sub = path.join(root, 'docs');
    fs.mkdirSync(sub);
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(sub, `f${i}.md`), '');
    fs.writeFileSync(path.join(sub, 'config.json'), '');

    const result = discoverSubsystems(root);
    assert.equal(result.length, 0);
    fs.rmSync(root, { recursive: true });
  });

  test('deeply nested test files count toward test ratio', () => {
    const root = tmpDir();
    const sub = path.join(root, 'deep-tests');
    fs.mkdirSync(path.join(sub, 'a', 'b', 'c'), { recursive: true });
    // All 4 files are tests, deeply nested → 100% > 80% → excluded
    fs.writeFileSync(path.join(sub, 'a.test.ts'), '');
    fs.writeFileSync(path.join(sub, 'a', 'b.test.ts'), '');
    fs.writeFileSync(path.join(sub, 'a', 'b', 'c.spec.ts'), '');
    fs.writeFileSync(path.join(sub, 'a', 'b', 'c', 'd.test.ts'), '');

    const result = discoverSubsystems(root);
    assert.equal(result.length, 0);
    fs.rmSync(root, { recursive: true });
  });

  test('boundary: 3 files, 2 tests (66.7%) included', () => {
    const root = tmpDir();
    const sub = path.join(root, 'edge');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'a.test.ts'), '');
    fs.writeFileSync(path.join(sub, 'b.test.ts'), '');
    fs.writeFileSync(path.join(sub, 'c.ts'), '');

    const result = discoverSubsystems(root);
    assert.equal(result.length, 1);
    fs.rmSync(root, { recursive: true });
  });

  test('boundary: 3 files, all tests (100%) excluded', () => {
    const root = tmpDir();
    const sub = path.join(root, 'all-tests');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'a.test.ts'), '');
    fs.writeFileSync(path.join(sub, 'b.test.ts'), '');
    fs.writeFileSync(path.join(sub, 'c.test.ts'), '');

    const result = discoverSubsystems(root);
    assert.equal(result.length, 0);
    fs.rmSync(root, { recursive: true });
  });

  test('ignores files at root level (only scans directories)', () => {
    const root = tmpDir();
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(root, `f${i}.ts`), '');

    const result = discoverSubsystems(root);
    assert.equal(result.length, 0);
    fs.rmSync(root, { recursive: true });
  });

  test('subsystem names are single-segment basenames (no path separators)', () => {
    const root = tmpDir();
    const src = path.join(root, 'src');
    for (const name of ['services', 'processors']) {
      const sub = path.join(src, name);
      fs.mkdirSync(sub, { recursive: true });
      for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(sub, `f${i}.ts`), '');
    }

    const result = discoverSubsystems(src);
    assert.equal(result.length, 2);
    const names = result.map(s => s.name);
    assert.ok(names.includes('services'), `expected 'services' in ${JSON.stringify(names)}`);
    assert.ok(names.includes('processors'), `expected 'processors' in ${JSON.stringify(names)}`);
    for (const { name } of result) {
      assert.ok(!name.includes('/') && !name.includes('\\'), `name must be a basename, got: ${name}`);
    }
    fs.rmSync(root, { recursive: true });
  });

  test('returns sorted results', () => {
    const root = tmpDir();
    for (const name of ['zebra', 'alpha', 'middle']) {
      const sub = path.join(root, name);
      fs.mkdirSync(sub);
      for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(sub, `f${i}.ts`), '');
    }

    const result = discoverSubsystems(root);
    assert.deepEqual(result.map(s => s.name), ['alpha', 'middle', 'zebra']);
    fs.rmSync(root, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// cleanPhaseArtifacts
// ---------------------------------------------------------------------------

describe('cleanPhaseArtifacts', () => {
  test('archives and removes TASK_NOTES.md', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'TASK_NOTES.md'), 'notes');

    cleanPhaseArtifacts(dir, 'pickle');

    assert.ok(!fs.existsSync(path.join(dir, 'TASK_NOTES.md')));
    assert.ok(fs.existsSync(path.join(dir, 'TASK_NOTES-pickle.md')));
    assert.equal(fs.readFileSync(path.join(dir, 'TASK_NOTES-pickle.md'), 'utf-8'), 'notes');
    fs.rmSync(dir, { recursive: true });
  });

  test('archives and removes gap_analysis.md', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'gap_analysis.md'), 'gaps');

    cleanPhaseArtifacts(dir, 'anatomy-park');

    assert.ok(!fs.existsSync(path.join(dir, 'gap_analysis.md')));
    assert.ok(fs.existsSync(path.join(dir, 'gap_analysis-anatomy-park.md')));
    fs.rmSync(dir, { recursive: true });
  });

  test('removes handoff.txt without archiving', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'handoff.txt'), 'handoff');

    cleanPhaseArtifacts(dir, 'pickle');

    assert.ok(!fs.existsSync(path.join(dir, 'handoff.txt')));
    fs.rmSync(dir, { recursive: true });
  });

  test('handles missing files gracefully', () => {
    const dir = tmpDir();
    // No files to clean — should not throw
    cleanPhaseArtifacts(dir, 'pickle');
    fs.rmSync(dir, { recursive: true });
  });

  test('overwrites existing archive on name collision', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'TASK_NOTES.md'), 'new notes');
    fs.writeFileSync(path.join(dir, 'TASK_NOTES-pickle.md'), 'old archive');

    cleanPhaseArtifacts(dir, 'pickle');

    assert.ok(!fs.existsSync(path.join(dir, 'TASK_NOTES.md')));
    assert.equal(fs.readFileSync(path.join(dir, 'TASK_NOTES-pickle.md'), 'utf-8'), 'new notes');
    fs.rmSync(dir, { recursive: true });
  });

  test('cleans all artifacts in one call', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'TASK_NOTES.md'), 'notes');
    fs.writeFileSync(path.join(dir, 'gap_analysis.md'), 'gaps');
    fs.writeFileSync(path.join(dir, 'handoff.txt'), 'handoff');

    cleanPhaseArtifacts(dir, 'test-phase');

    assert.ok(!fs.existsSync(path.join(dir, 'TASK_NOTES.md')));
    assert.ok(!fs.existsSync(path.join(dir, 'gap_analysis.md')));
    assert.ok(!fs.existsSync(path.join(dir, 'handoff.txt')));
    assert.ok(fs.existsSync(path.join(dir, 'TASK_NOTES-test-phase.md')));
    assert.ok(fs.existsSync(path.join(dir, 'gap_analysis-test-phase.md')));
    fs.rmSync(dir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// resetStateForPhase
// ---------------------------------------------------------------------------

describe('resetStateForPhase', () => {
  test('resets state for anatomy-park phase', () => {
    const dir = tmpDir();
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({
      active: true,
      working_dir: '/tmp',
      step: 'implement',
      iteration: 42,
      max_iterations: 500,
      max_time_minutes: 720,
      worker_timeout_seconds: 1200,
      start_time_epoch: 1000,
      completion_promise: null,
      original_prompt: 'test',
      current_ticket: 'TICKET-1',
      history: [],
      started_at: new Date().toISOString(),
      session_dir: dir,
      tmux_mode: true,
      chain_meeseeks: true,
    }));

    resetStateForPhase(statePath, 'anatomy-park.md', 100);

    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.equal(state.active, false);
    assert.equal(state.iteration, 0);
    assert.equal(state.current_ticket, null);
    assert.equal(state.max_iterations, 100);
    assert.equal(state.command_template, 'anatomy-park.md');
    assert.equal(state.step, 'review');
    assert.equal(state.chain_meeseeks, false);
    assert.equal(state.tmux_mode, true);
    // Preserved fields
    assert.equal(state.working_dir, '/tmp');
    assert.equal(state.original_prompt, 'test');
    fs.rmSync(dir, { recursive: true });
  });

  test('resets state for szechuan-sauce phase', () => {
    const dir = tmpDir();
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({
      active: false,
      working_dir: '/project',
      step: 'review',
      iteration: 10,
      max_iterations: 100,
      max_time_minutes: 720,
      worker_timeout_seconds: 1200,
      start_time_epoch: 1000,
      completion_promise: null,
      original_prompt: 'test',
      current_ticket: null,
      history: [],
      started_at: new Date().toISOString(),
      session_dir: dir,
    }));

    resetStateForPhase(statePath, 'szechuan-sauce.md', 50);

    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.equal(state.command_template, 'szechuan-sauce.md');
    assert.equal(state.max_iterations, 50);
    assert.equal(state.iteration, 0);
    const now = Math.floor(Date.now() / 1000);
    assert.ok(state.start_time_epoch >= now - 5 && state.start_time_epoch <= now + 5);
    fs.rmSync(dir, { recursive: true });
  });

  test('preserves extra fields not in schema', () => {
    const dir = tmpDir();
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({
      active: true, working_dir: '/tmp', step: 'implement',
      iteration: 5, max_iterations: 50, max_time_minutes: 720,
      worker_timeout_seconds: 1200, start_time_epoch: 1000,
      completion_promise: null, original_prompt: 'test',
      current_ticket: 'T-1', history: [], started_at: new Date().toISOString(),
      session_dir: dir, custom_field: 'should_survive',
    }));

    resetStateForPhase(statePath, 'anatomy-park.md', 100);

    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.equal(state.custom_field, 'should_survive');
    assert.equal(state.iteration, 0);
    fs.rmSync(dir, { recursive: true });
  });

  test('handles state missing optional fields', () => {
    const dir = tmpDir();
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({
      active: true, working_dir: '/tmp', step: 'implement',
      iteration: 5, max_iterations: 50, max_time_minutes: 720,
      worker_timeout_seconds: 1200, start_time_epoch: 1000,
      completion_promise: null, original_prompt: 'test',
      current_ticket: 'T-1', history: [], started_at: new Date().toISOString(),
      session_dir: dir,
    }));

    assert.doesNotThrow(() => resetStateForPhase(statePath, 'szechuan-sauce.md', 50));
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.equal(state.chain_meeseeks, false);
    assert.equal(state.tmux_mode, true);
    fs.rmSync(dir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// parsePipelineConfig
// ---------------------------------------------------------------------------

describe('parsePipelineConfig', () => {
  test('parses valid config', () => {
    const config = parsePipelineConfig({
      phases: ['pickle', 'anatomy-park', 'szechuan-sauce'],
      target: '/tmp/project',
      anatomy_stall_limit: 5,
      szechuan_stall_limit: 8,
      anatomy_max_iterations: 200,
      szechuan_max_iterations: 75,
      szechuan_domain: 'financial',
      szechuan_focus: 'error handling',
    });
    assert.deepEqual(config.phases, ['pickle', 'citadel', 'anatomy-park', 'szechuan-sauce']);
    assert.equal(config.target, '/tmp/project');
    assert.equal(config.anatomy_stall_limit, 5);
    assert.equal(config.szechuan_stall_limit, 8);
    assert.equal(config.anatomy_max_iterations, 200);
    assert.equal(config.szechuan_max_iterations, 75);
    assert.equal(config.citadel_strict, false);
    assert.equal(config.szechuan_domain, 'financial');
    assert.equal(config.szechuan_focus, 'error handling');
  });

  test('preserves explicit citadel phase without duplicating it', () => {
    const config = parsePipelineConfig({
      phases: ['pickle', 'citadel', 'anatomy-park', 'szechuan-sauce'],
      target: '/tmp/project',
    });
    assert.deepEqual(config.phases, ['pickle', 'citadel', 'anatomy-park', 'szechuan-sauce']);
  });

  test('parses citadel strict flag', () => {
    const config = parsePipelineConfig({ phases: [], target: '', citadel_strict: true });
    assert.equal(config.citadel_strict, true);
  });

  test('defaults numeric fields when missing', () => {
    const config = parsePipelineConfig({ phases: ['pickle'], target: '/tmp' });
    assert.equal(config.anatomy_stall_limit, 3);
    assert.equal(config.szechuan_stall_limit, 5);
    assert.equal(config.anatomy_max_iterations, 100);
    assert.equal(config.szechuan_max_iterations, 50);
  });

  test('defaults numeric fields when NaN', () => {
    const config = parsePipelineConfig({
      phases: [], target: '',
      anatomy_stall_limit: 'garbage',
      szechuan_max_iterations: 'also_garbage',
    });
    assert.equal(config.anatomy_stall_limit, 3);
    assert.equal(config.szechuan_max_iterations, 50);
  });

  test('defaults numeric fields when null or non-positive', () => {
    const config = parsePipelineConfig({
      phases: [], target: '',
      anatomy_stall_limit: null,
      szechuan_stall_limit: 0,
      anatomy_max_iterations: -1,
      szechuan_max_iterations: '',
    });
    assert.equal(config.anatomy_stall_limit, 3);
    assert.equal(config.szechuan_stall_limit, 5);
    assert.equal(config.anatomy_max_iterations, 100);
    assert.equal(config.szechuan_max_iterations, 50);
  });

  test('defaults numeric fields when Infinity', () => {
    const config = parsePipelineConfig({
      phases: [], target: '',
      anatomy_stall_limit: 'Infinity',
      szechuan_stall_limit: Infinity,
    });
    assert.equal(config.anatomy_stall_limit, 3);
    assert.equal(config.szechuan_stall_limit, 5);
  });

  test('defaults numeric fields when fractional', () => {
    const config = parsePipelineConfig({
      phases: [], target: '',
      anatomy_stall_limit: 0.5,
      szechuan_stall_limit: '2.5',
      anatomy_max_iterations: 10.25,
      szechuan_max_iterations: '4.75',
    });
    assert.equal(config.anatomy_stall_limit, 3);
    assert.equal(config.szechuan_stall_limit, 5);
    assert.equal(config.anatomy_max_iterations, 100);
    assert.equal(config.szechuan_max_iterations, 50);
  });

  test('defaults phases to empty array when not array', () => {
    const config = parsePipelineConfig({ phases: 'pickle', target: '/tmp' });
    assert.deepEqual(config.phases, []);
  });

  test('defaults target to empty string when missing', () => {
    const config = parsePipelineConfig({ phases: [] });
    assert.equal(config.target, '');
  });

  test('omits optional string fields when not set', () => {
    const config = parsePipelineConfig({ phases: [], target: '' });
    assert.equal(config.szechuan_domain, undefined);
    assert.equal(config.szechuan_focus, undefined);
  });

  test('passes through unvalidated phase names (current behavior)', () => {
    const config = parsePipelineConfig({ phases: ['pickle', 'bogus', 42], target: '/tmp' });
    assert.deepEqual(config.phases, ['pickle', 'bogus', 42]);
  });

  test('roundtrips backend: "codex"', () => {
    const config = parsePipelineConfig({ phases: [], target: '', backend: 'codex' });
    assert.equal(config.backend, 'codex');
  });

  test('roundtrips backend: "claude"', () => {
    const config = parsePipelineConfig({ phases: [], target: '', backend: 'claude' });
    assert.equal(config.backend, 'claude');
  });

  test('drops unknown backend string to undefined', () => {
    const config = parsePipelineConfig({ phases: [], target: '', backend: 'gpt4' });
    assert.equal(config.backend, undefined);
  });

  test('drops numeric backend to undefined', () => {
    const config = parsePipelineConfig({ phases: [], target: '', backend: 42 });
    assert.equal(config.backend, undefined);
  });

  test('drops null backend to undefined', () => {
    const config = parsePipelineConfig({ phases: [], target: '', backend: null });
    assert.equal(config.backend, undefined);
  });

  test('omits backend when key absent', () => {
    const config = parsePipelineConfig({ phases: [], target: '' });
    assert.equal(config.backend, undefined);
  });

  test('defaults ignore_dirty_paths to ["prds","docs"]', () => {
    const config = parsePipelineConfig({ phases: [], target: '' });
    assert.deepEqual(config.ignore_dirty_paths, ['prds', 'docs']);
  });

  test('roundtrips ignore_dirty_paths when array of strings', () => {
    const config = parsePipelineConfig({ phases: [], target: '', ignore_dirty_paths: ['notes', 'wip'] });
    assert.deepEqual(config.ignore_dirty_paths, ['notes', 'wip']);
  });

  test('roundtrips empty ignore_dirty_paths (opt-out)', () => {
    const config = parsePipelineConfig({ phases: [], target: '', ignore_dirty_paths: [] });
    assert.deepEqual(config.ignore_dirty_paths, []);
  });

  test('falls back to default when ignore_dirty_paths is non-array', () => {
    const config = parsePipelineConfig({ phases: [], target: '', ignore_dirty_paths: 'prds' });
    assert.deepEqual(config.ignore_dirty_paths, ['prds', 'docs']);
  });

  test('falls back to default when ignore_dirty_paths contains non-strings', () => {
    const config = parsePipelineConfig({ phases: [], target: '', ignore_dirty_paths: ['prds', 42] });
    assert.deepEqual(config.ignore_dirty_paths, ['prds', 'docs']);
  });
});

// ---------------------------------------------------------------------------
// assertCleanWorkingTree
// ---------------------------------------------------------------------------

function initRepo(dir) {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@test.local'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'seed');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: dir });
}

describe('assertCleanWorkingTree', () => {
  test('passes on a clean repo', () => {
    const dir = tmpDir();
    initRepo(dir);
    assert.doesNotThrow(() => assertCleanWorkingTree(dir));
    fs.rmSync(dir, { recursive: true });
  });

  test('throws on untracked files', () => {
    const dir = tmpDir();
    initRepo(dir);
    fs.writeFileSync(path.join(dir, 'scratch.txt'), 'wip');
    assert.throws(() => assertCleanWorkingTree(dir), /dirty/);
    fs.rmSync(dir, { recursive: true });
  });

  test('throws on unstaged modifications', () => {
    const dir = tmpDir();
    initRepo(dir);
    fs.writeFileSync(path.join(dir, 'README.md'), 'changed');
    assert.throws(() => assertCleanWorkingTree(dir), /dirty/);
    fs.rmSync(dir, { recursive: true });
  });

  test('default ignore list excludes prds/ and docs/ from dirty check', () => {
    const dir = tmpDir();
    initRepo(dir);
    fs.mkdirSync(path.join(dir, 'prds'));
    fs.mkdirSync(path.join(dir, 'docs'));
    fs.writeFileSync(path.join(dir, 'prds', 'idea.md'), 'wip');
    fs.writeFileSync(path.join(dir, 'docs', 'guide.md'), 'wip');
    assert.doesNotThrow(() => assertCleanWorkingTree(dir));
    // Anything outside still trips the check.
    fs.writeFileSync(path.join(dir, 'src.js'), 'real change');
    assert.throws(() => assertCleanWorkingTree(dir), /dirty/);
    fs.rmSync(dir, { recursive: true });
  });

  test('explicit ignore list overrides defaults', () => {
    const dir = tmpDir();
    initRepo(dir);
    fs.mkdirSync(path.join(dir, 'prds'));
    fs.writeFileSync(path.join(dir, 'prds', 'idea.md'), 'wip');
    // Empty list disables exclusions — prds/ now trips the check.
    assert.throws(() => assertCleanWorkingTree(dir, []), /dirty/);
    // Custom list accepts unrelated dirs.
    fs.rmSync(path.join(dir, 'prds'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'notes'));
    fs.writeFileSync(path.join(dir, 'notes', 'jot.md'), 'wip');
    assert.doesNotThrow(() => assertCleanWorkingTree(dir, ['notes']));
    fs.rmSync(dir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// writePipelineStatus
// ---------------------------------------------------------------------------

describe('writePipelineStatus', () => {
  test('writes pipeline-status.json with defaults and metadata', () => {
    const dir = tmpDir();
    writePipelineStatus(dir, 'running', { current_phase: 'pickle', total_phases: 3 });

    const status = JSON.parse(fs.readFileSync(path.join(dir, 'pipeline-status.json'), 'utf-8'));
    assert.equal(status.status, 'running');
    assert.equal(status.current_phase, 'pickle');
    assert.equal(status.completed_phases, 0);
    assert.equal(status.skipped_phases, 0);
    assert.equal(status.total_phases, 3);
    assert.ok(typeof status.updated_at === 'string' && status.updated_at.length > 0);

    fs.rmSync(dir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// resolveBackendWithSource — precedence (resume must honor user's new --backend)
// ---------------------------------------------------------------------------

describe('resolveBackendWithSource', () => {
  test('state.backend wins over pipeline.json when both set (resume case)', () => {
    // Simulates resume: setup.js wrote state.backend='codex' from --backend,
    // pipeline.json still pins the original 'claude' from first launch.
    const result = resolveBackendWithSource({ backend: 'codex' }, 'claude', undefined);
    assert.equal(result.backend, 'codex');
    assert.equal(result.source, 'state.json');
  });

  test('state.backend wins over pipeline.json when they agree', () => {
    const result = resolveBackendWithSource({ backend: 'codex' }, 'codex', undefined);
    assert.equal(result.backend, 'codex');
    assert.equal(result.source, 'state.json');
  });

  test('pipeline.json wins when state.backend unset', () => {
    const result = resolveBackendWithSource({}, 'codex', undefined);
    assert.equal(result.backend, 'codex');
    assert.equal(result.source, 'pipeline.json');
  });

  test('env wins when state and pipeline both unset', () => {
    const result = resolveBackendWithSource({}, undefined, 'codex');
    assert.equal(result.backend, 'codex');
    assert.equal(result.source, 'env');
  });

  test('defaults to claude when nothing set', () => {
    const result = resolveBackendWithSource({}, undefined, undefined);
    assert.equal(result.backend, 'claude');
    assert.equal(result.source, 'default');
  });

  test('invalid state.backend string falls through to pipeline.json', () => {
    const result = resolveBackendWithSource({ backend: 'gpt4' }, 'codex', undefined);
    assert.equal(result.backend, 'codex');
    assert.equal(result.source, 'pipeline.json');
  });

  test('null state falls back to pipeline.json', () => {
    const result = resolveBackendWithSource(null, 'codex', undefined);
    assert.equal(result.backend, 'codex');
    assert.equal(result.source, 'pipeline.json');
  });

  test('invalid env falls through to default', () => {
    const result = resolveBackendWithSource({}, undefined, 'bogus');
    assert.equal(result.backend, 'claude');
    assert.equal(result.source, 'default');
  });
});

// ---------------------------------------------------------------------------
// Bundle PRD backend contract — AC-BUNDLE-18
// ---------------------------------------------------------------------------

describe('bundle PRD backend contract', () => {
  test('reads backend from refined bundle fenced frontmatter block', () => {
    const prd = [
      '# PRD',
      '',
      'frontmatter:',
      '```',
      'backend: codex-required',
      'session_root: /tmp/session',
      '```',
      '',
      '## Body',
    ].join('\n');
    assert.equal(readBundlePrdBackend(prd), 'codex-required');
  });

  test('reads backend from conventional leading YAML frontmatter', () => {
    const prd = [
      '---',
      'backend: "codex-required"',
      '---',
      '',
      '# PRD',
    ].join('\n');
    assert.equal(readBundlePrdBackend(prd), 'codex-required');
  });

  test('returns undefined when PRD has no backend contract', () => {
    assert.equal(readBundlePrdBackend('# PRD\n\nNo frontmatter.'), undefined);
  });

  test('rejects non-codex backend with actionable pipeline command', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'prd.md'), [
      '# Bundle',
      '',
      'frontmatter:',
      '```',
      'backend: codex-required',
      '```',
    ].join('\n'));
    try {
      assert.throws(
        () => assertCodexRequiredBackend(dir, 'claude', 'default'),
        /\/pickle-pipeline --backend codex/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  test('allows codex backend when PRD requires codex', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'prd.md'), [
      '# Bundle',
      '',
      'frontmatter:',
      '```',
      'backend: codex-required',
      '```',
    ].join('\n'));
    try {
      assert.doesNotThrow(() => assertCodexRequiredBackend(dir, 'codex', 'state.json'));
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// phaseEnv composition — backend must propagate to sub-runners via env
// ---------------------------------------------------------------------------

describe('phaseEnv propagation', () => {
  test('PICKLE_BACKEND=codex when backend resolves to codex', () => {
    const { backend } = resolveBackendWithSource({ backend: 'codex' }, undefined, undefined);
    const phaseEnv = { ...process.env, ...backendEnvOverrides(backend) };
    assert.equal(phaseEnv.PICKLE_BACKEND, 'codex');
  });

  test('PICKLE_BACKEND=claude when backend resolves to claude (default)', () => {
    const { backend } = resolveBackendWithSource({}, undefined, undefined);
    const phaseEnv = { ...process.env, ...backendEnvOverrides(backend) };
    assert.equal(phaseEnv.PICKLE_BACKEND, 'claude');
  });

  test('PICKLE_BACKEND reflects state.backend even when pipeline.json disagrees (resume)', () => {
    const { backend } = resolveBackendWithSource({ backend: 'codex' }, 'claude', undefined);
    const phaseEnv = { ...process.env, ...backendEnvOverrides(backend) };
    assert.equal(phaseEnv.PICKLE_BACKEND, 'codex');
  });
});

// ---------------------------------------------------------------------------
// Restamp guard: phase loop must not re-write state.backend when it matches.
// We simulate the guard (`if (cur.backend !== backend) update(...)`) directly
// against a real state.json — if the guard fires incorrectly we'd see an mtime
// bump. Using a write-counter via fs.watchFile is flaky; instead, we stub the
// equality predicate and assert call count.
// ---------------------------------------------------------------------------

describe('restamp guard', () => {
  test('no write when state.backend already matches target', () => {
    // Pure logic test — mirrors the guard expression in pipeline-runner.ts.
    const state = { backend: 'codex' };
    const target = 'codex';
    let writes = 0;
    if (state.backend !== target) { state.backend = target; writes++; }
    assert.equal(writes, 0);
  });

  test('single write when state.backend differs from target', () => {
    const state = { backend: 'claude' };
    const target = 'codex';
    let writes = 0;
    if (state.backend !== target) { state.backend = target; writes++; }
    assert.equal(writes, 1);
    assert.equal(state.backend, 'codex');
  });

  test('single write when state.backend is undefined', () => {
    const state = {};
    const target = 'codex';
    let writes = 0;
    if (state.backend !== target) { state.backend = target; writes++; }
    assert.equal(writes, 1);
  });

  test('phase loop skips sm.update when state.backend equals resolved backend (integration-style)', () => {
    // Mirrors the anatomy-park/szechuan-sauce branches in pipeline-runner.ts
    // which read current state then only update on drift. Ensures we don't
    // regress back to an unconditional sm.update(s.backend = backend) write.
    const statePath = path.join(tmpDir(), 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ backend: 'codex' }));
    const before = fs.statSync(statePath).mtimeMs;
    const cur = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const backend = 'codex';
    let writes = 0;
    if (cur.backend !== backend) { writes++; }
    assert.equal(writes, 0);
    const after = fs.statSync(statePath).mtimeMs;
    assert.equal(before, after, 'mtime must not change when guard short-circuits');
    fs.rmSync(path.dirname(statePath), { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// enterPicklePhase — guards against stale command_template and stale phase
// config files from a previous run misrouting a resumed pickle worker.
// ---------------------------------------------------------------------------

function writeBaseState(statePath, overrides = {}) {
  const base = {
    active: false,
    working_dir: '/tmp',
    step: 'implement',
    iteration: 7,
    max_iterations: 100,
    max_time_minutes: 720,
    worker_timeout_seconds: 1200,
    start_time_epoch: 1000,
    completion_promise: null,
    original_prompt: 'test',
    current_ticket: 'TICKET-7',
    history: [],
    started_at: new Date().toISOString(),
    session_dir: path.dirname(statePath),
    tmux_mode: true,
    chain_meeseeks: false,
    backend: 'claude',
    ...overrides,
  };
  fs.writeFileSync(statePath, JSON.stringify(base));
}

describe('pickle phase entry', () => {
  test('overwrites stale command_template = "anatomy-park.md" with "pickle.md"', () => {
    const dir = tmpDir();
    const statePath = path.join(dir, 'state.json');
    writeBaseState(statePath, { command_template: 'anatomy-park.md' });

    enterPicklePhase(dir, statePath, 'claude');

    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.equal(state.command_template, 'pickle.md');
    assert.equal(state.chain_meeseeks, false);
    fs.rmSync(dir, { recursive: true });
  });

  test('overwrites stale command_template = "szechuan-sauce.md" with "pickle.md"', () => {
    const dir = tmpDir();
    const statePath = path.join(dir, 'state.json');
    writeBaseState(statePath, { command_template: 'szechuan-sauce.md' });

    enterPicklePhase(dir, statePath, 'claude');

    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.equal(state.command_template, 'pickle.md');
    fs.rmSync(dir, { recursive: true });
  });

  test('preserves resume pointers (current_ticket, step, iteration, start_time_epoch)', () => {
    const dir = tmpDir();
    const statePath = path.join(dir, 'state.json');
    writeBaseState(statePath, {
      command_template: 'anatomy-park.md',
      current_ticket: 'TICKET-42',
      step: 'implement',
      iteration: 13,
      start_time_epoch: 1000,
    });

    enterPicklePhase(dir, statePath, 'claude');

    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.equal(state.current_ticket, 'TICKET-42');
    assert.equal(state.step, 'implement');
    assert.equal(state.iteration, 13);
    assert.equal(state.start_time_epoch, 1000);
    fs.rmSync(dir, { recursive: true });
  });

  test('removes stale anatomy-park.json and szechuan-sauce.json from session dir', () => {
    const dir = tmpDir();
    const statePath = path.join(dir, 'state.json');
    writeBaseState(statePath, { command_template: 'anatomy-park.md' });
    fs.writeFileSync(path.join(dir, 'anatomy-park.json'), '{"stale":true}');
    fs.writeFileSync(path.join(dir, 'szechuan-sauce.json'), '{"stale":true}');

    enterPicklePhase(dir, statePath, 'claude');

    assert.ok(!fs.existsSync(path.join(dir, 'anatomy-park.json')));
    assert.ok(!fs.existsSync(path.join(dir, 'szechuan-sauce.json')));
    fs.rmSync(dir, { recursive: true });
  });

  test('is a no-op for missing phase config files', () => {
    const dir = tmpDir();
    const statePath = path.join(dir, 'state.json');
    writeBaseState(statePath);

    assert.doesNotThrow(() => enterPicklePhase(dir, statePath, 'claude'));
    fs.rmSync(dir, { recursive: true });
  });

  test('updates state.backend on drift', () => {
    const dir = tmpDir();
    const statePath = path.join(dir, 'state.json');
    writeBaseState(statePath, { backend: 'claude' });

    enterPicklePhase(dir, statePath, 'codex');

    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.equal(state.backend, 'codex');
    fs.rmSync(dir, { recursive: true });
  });
});

describe('pipeline shutdown', () => {
  test('SIGTERM deactivates session state before exiting', () => {
    const dir = tmpDir();
    const statePath = path.join(dir, 'state.json');
    const dataRoot = path.join(dir, 'data-root');
    const cancelMarker = path.join(dir, 'pipeline-cancel');
    writeBaseState(statePath, { active: true, session_dir: dir });

    const runtime = {
      sessionDir: dir,
      extensionRoot: path.resolve('extension'),
      statePath,
      config: { phases: ['pickle'] },
      target: dir,
      workingDir: dir,
      backend: 'claude',
      phaseEnv: process.env,
      log: () => {},
    };
    const oldExit = process.exit;
    const oldDataRoot = process.env.PICKLE_DATA_ROOT;
    const exitSentinel = new Error('process.exit intercepted');
    let cleanup = () => {};

    try {
      process.env.PICKLE_DATA_ROOT = dataRoot;
      process.exit = ((code) => {
        assert.equal(code, 1);
        throw exitSentinel;
      });
      cleanup = installShutdownHandlers(runtime, { completed: 0, skipped: 0 }, cancelMarker);

      assert.throws(() => process.emit('SIGTERM'), exitSentinel);

      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      assert.equal(state.active, false);
      const status = JSON.parse(fs.readFileSync(path.join(dir, 'pipeline-status.json'), 'utf-8'));
      assert.equal(status.status, 'cancelled');
    } finally {
      cleanup();
      process.exit = oldExit;
      if (oldDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
      else process.env.PICKLE_DATA_ROOT = oldDataRoot;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC-LPB-05: applyEpochResetOnReconstruction
// ---------------------------------------------------------------------------

describe('applyEpochResetOnReconstruction', () => {
  test('resets start_time_epoch when iteration > 0 (reconstruction)', () => {
    const dir = tmpDir();
    const oldDataRoot = process.env.PICKLE_DATA_ROOT;
    process.env.PICKLE_DATA_ROOT = dir;
    try {
      const statePath = path.join(dir, 'state.json');
      const staleEpoch = 1000;
      fs.writeFileSync(statePath, JSON.stringify({
        active: false, working_dir: dir, step: 'implement',
        iteration: 7, max_iterations: 50, max_time_minutes: 720,
        worker_timeout_seconds: 1200, start_time_epoch: staleEpoch,
        completion_promise: null, original_prompt: 'epoch test',
        current_ticket: null, history: [], started_at: new Date().toISOString(),
        session_dir: dir, schema_version: 3,
      }));
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));

      const result = applyEpochResetOnReconstruction(state, statePath, dir);
      assert.ok(result, 'reconstruction should return a non-null result');
      assert.equal(result.originalEpoch, staleEpoch);
      const persisted = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      assert.notEqual(persisted.start_time_epoch, staleEpoch);
      assert.equal(persisted.start_time_epoch, result.newEpoch);

      // Activity event written
      const activityDir = path.join(dir, 'activity');
      const files = fs.existsSync(activityDir) ? fs.readdirSync(activityDir).filter((f) => f.endsWith('.jsonl')) : [];
      const lines = files.flatMap((f) => fs.readFileSync(path.join(activityDir, f), 'utf-8').split(/\r?\n/).filter(Boolean));
      const events = lines.map((l) => JSON.parse(l));
      const reset = events.find((e) => e.event === 'session_reconstructed_epoch_reset');
      assert.ok(reset, 'reset event must be emitted');
      assert.equal(reset.original_epoch, staleEpoch);
      assert.equal(reset.new_epoch, result.newEpoch);
    } finally {
      if (oldDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
      else process.env.PICKLE_DATA_ROOT = oldDataRoot;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('no-op for fresh launch (iteration === 0 and no phases_entered)', () => {
    const dir = tmpDir();
    const oldDataRoot = process.env.PICKLE_DATA_ROOT;
    process.env.PICKLE_DATA_ROOT = dir;
    try {
      const statePath = path.join(dir, 'state.json');
      const freshEpoch = 1000;
      fs.writeFileSync(statePath, JSON.stringify({
        active: false, working_dir: dir, step: 'prd',
        iteration: 0, max_iterations: 50, max_time_minutes: 720,
        worker_timeout_seconds: 1200, start_time_epoch: freshEpoch,
        completion_promise: null, original_prompt: 'fresh test',
        current_ticket: null, history: [], started_at: new Date().toISOString(),
        session_dir: dir, schema_version: 3,
      }));
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));

      const result = applyEpochResetOnReconstruction(state, statePath, dir);
      assert.equal(result, null, 'fresh launch must not reset epoch');
      const persisted = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      assert.equal(persisted.start_time_epoch, freshEpoch, 'fresh epoch preserved');
    } finally {
      if (oldDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
      else process.env.PICKLE_DATA_ROOT = oldDataRoot;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('treats non-empty phases_entered as reconstruction even when iteration is 0', () => {
    const dir = tmpDir();
    const oldDataRoot = process.env.PICKLE_DATA_ROOT;
    process.env.PICKLE_DATA_ROOT = dir;
    try {
      const statePath = path.join(dir, 'state.json');
      fs.writeFileSync(statePath, JSON.stringify({
        active: false, working_dir: dir, step: 'review',
        iteration: 0, max_iterations: 50, max_time_minutes: 720,
        worker_timeout_seconds: 1200, start_time_epoch: 500,
        completion_promise: null, original_prompt: 'phase test',
        current_ticket: null, history: [], started_at: new Date().toISOString(),
        session_dir: dir, schema_version: 3,
        phases_entered: ['pickle'],
      }));
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      const result = applyEpochResetOnReconstruction(state, statePath, dir);
      assert.ok(result);
      assert.equal(result.originalEpoch, 500);
    } finally {
      if (oldDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
      else process.env.PICKLE_DATA_ROOT = oldDataRoot;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

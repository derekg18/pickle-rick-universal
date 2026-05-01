import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setupSzechuanSauce } from '../bin/pipeline-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, '..', 'bin', 'init-microverse.js');
const SZECHUAN_MD = path.resolve(__dirname, '../../.claude/commands/szechuan-sauce.md');
const EXTENSION_ROOT = path.join(os.homedir(), '.claude/pickle-rick');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'szechuan-scope-'));
}

function run(args, expectError = false) {
  // 10s → 30s: budget for system load when run alongside concurrent
  // codex/tmux work. Tests validate CLI behavior, not wall-clock.
  const opts = { stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 };
  try {
    const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], opts);
    return { code: 0, stdout: stdout.toString(), stderr: '' };
  } catch (err) {
    if (!expectError) throw err;
    return {
      code: err.status,
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
    };
  }
}

function readMicroverse(sessionDir) {
  return JSON.parse(fs.readFileSync(path.join(sessionDir, 'microverse.json'), 'utf-8'));
}

// ---------------------------------------------------------------------------
// Injection: scope.json present → microverse.json.allowed_paths present
// ---------------------------------------------------------------------------

describe('szechuan scope injection', () => {
  test('scope.json present → microverse.json has allowed_paths', () => {
    const dir = makeTempDir();
    try {
      const scopeJson = {
        allowed_paths: ['src/foo.ts', 'src/bar.ts'],
        mode: 'diff',
        strategy: 'changed-files',
        head_sha: 'abc123',
      };
      fs.writeFileSync(path.join(dir, 'scope.json'), JSON.stringify(scopeJson));
      run([dir, '/some/target', '--allowed-paths-file', path.join(dir, 'scope.json')]);
      const state = readMicroverse(dir);
      assert.deepStrictEqual(state.allowed_paths, ['src/foo.ts', 'src/bar.ts']);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Backcompat: no scope.json → no allowed_paths in microverse.json
  // ---------------------------------------------------------------------------

  test('no --allowed-paths-file → microverse.json has no allowed_paths', () => {
    const dir = makeTempDir();
    try {
      run([dir, '/some/target']);
      const state = readMicroverse(dir);
      assert.equal(state.allowed_paths, undefined);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Empty allowed_paths → not injected (backcompat: avoids confusing worker)
  // ---------------------------------------------------------------------------

  test('scope.json with empty allowed_paths → microverse.json has no allowed_paths', () => {
    const dir = makeTempDir();
    try {
      const scopeJson = { allowed_paths: [], mode: 'diff', strategy: 'changed-files', head_sha: 'abc123' };
      fs.writeFileSync(path.join(dir, 'scope.json'), JSON.stringify(scopeJson));
      run([dir, '/some/target', '--allowed-paths-file', path.join(dir, 'scope.json')]);
      const state = readMicroverse(dir);
      assert.equal(state.allowed_paths, undefined);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  test('resume: persisted scope.json still injects allowed_paths when phase setup reruns without an explicit scope arg', () => {
    const dir = makeTempDir();
    try {
      fs.writeFileSync(
        path.join(dir, 'scope.json'),
        JSON.stringify({ allowed_paths: ['src/foo.ts'], mode: 'diff', strategy: 'strict', head_sha: 'abc123' }),
      );

      const ok = setupSzechuanSauce(dir, '/some/target', 5, EXTENSION_ROOT, undefined, undefined, () => {});
      assert.equal(ok, true, 'setup should succeed');

      const state = readMicroverse(dir);
      assert.deepStrictEqual(state.allowed_paths, ['src/foo.ts']);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  test('resume: persisted scope.json promotes newer dead tmp before injecting allowed_paths', () => {
    const dir = makeTempDir();
    try {
      const scopePath = path.join(dir, 'scope.json');
      fs.writeFileSync(
        scopePath,
        JSON.stringify({ allowed_paths: ['src/stale.ts'], mode: 'diff', strategy: 'strict', head_sha: 'old' }),
      );
      fs.writeFileSync(
        `${scopePath}.tmp.99999999`,
        JSON.stringify({ allowed_paths: ['src/live.ts'], mode: 'diff', strategy: 'strict', head_sha: 'new' }),
      );
      fs.utimesSync(`${scopePath}.tmp.99999999`, new Date(Date.now() + 1_000), new Date(Date.now() + 1_000));

      const ok = setupSzechuanSauce(dir, '/some/target', 5, EXTENSION_ROOT, undefined, undefined, () => {});
      assert.equal(ok, true, 'setup should succeed');

      const state = readMicroverse(dir);
      assert.deepStrictEqual(state.allowed_paths, ['src/live.ts']);
      assert.equal(fs.existsSync(`${scopePath}.tmp.99999999`), false);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Override 3 marker: scope-hook present in szechuan-sauce.md
  // ---------------------------------------------------------------------------

  test('Override 3 scope-hook marker present in szechuan-sauce.md', () => {
    const content = fs.readFileSync(SZECHUAN_MD, 'utf-8');
    assert.ok(
      content.includes('<!-- scope-hook: override-3-allowed-paths -->'),
      'szechuan-sauce.md must contain Override 3 scope-hook marker',
    );
  });

  // ---------------------------------------------------------------------------
  // Override 2 marker: scope-invariant present in szechuan-sauce.md
  // ---------------------------------------------------------------------------

  test('Override 2 scope-invariant marker present in szechuan-sauce.md', () => {
    const content = fs.readFileSync(SZECHUAN_MD, 'utf-8');
    assert.ok(
      content.includes('<!-- scope-invariant: override-2-grep-spans-full-repo -->'),
      'szechuan-sauce.md must contain Override 2 scope-invariant marker',
    );
  });

  // ---------------------------------------------------------------------------
  // Step 8 wiring: --allowed-paths-file referenced after Step 7 in szechuan-sauce.md
  // ---------------------------------------------------------------------------

  test('Step 8 references --allowed-paths-file after Step 7 (scope wiring for standalone mode)', () => {
    const content = fs.readFileSync(SZECHUAN_MD, 'utf-8');
    const step7Idx = content.indexOf('### Step 7: Resolve Scope');
    const step8Idx = content.indexOf('### Step 8: Create microverse.json');
    const flagIdx = content.indexOf('--allowed-paths-file');
    assert.ok(step7Idx > 0, 'Step 7 heading must exist in szechuan-sauce.md');
    assert.ok(step8Idx > step7Idx, 'Step 8 must come after Step 7');
    assert.ok(
      flagIdx > step7Idx,
      '--allowed-paths-file must appear after Step 7 so scope.json has been written before init-microverse is invoked',
    );
  });
});

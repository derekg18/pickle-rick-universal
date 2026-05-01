import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, '..', 'bin', 'resolve-scope.js');

function git(args, cwd) {
  const res = spawnSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.invalid',
      GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test.invalid',
    },
    encoding: 'utf-8',
  });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${res.stderr}`);
  return (res.stdout || '').trim();
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-scope-cli-'));
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
  git(['add', '.'], dir);
  git(['commit', '-qm', 'initial'], dir);
  return dir;
}

function run(args, { cwd = process.cwd(), expectError = false } = {}) {
  // 15s → 45s: budget for system load when run alongside concurrent
  // codex/tmux work. Tests validate scope resolution, not wall-clock.
  const opts = { stdio: ['pipe', 'pipe', 'pipe'], timeout: 45_000, cwd };
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

test('resolve-scope-cli: --help exits 0', () => {
  const result = run(['--help']);
  assert.equal(result.code, 0);
  assert.ok(result.stdout.includes('--scope'));
  assert.ok(result.stdout.includes('--session-root'));
});

test('resolve-scope-cli: happy path writes scope.json and exits 0', () => {
  const repo = makeRepo();
  const session = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-scope-session-'));
  try {
    git(['checkout', '-qb', 'feature'], repo);
    fs.writeFileSync(path.join(repo, 'new.ts'), 'export const x = 1;\n');
    git(['add', '.'], repo);
    git(['commit', '-qm', 'add new'], repo);

    run([
      '--scope', 'branch',
      '--scope-base', 'main',
      '--session-root', session,
    ], { cwd: repo });

    const scopePath = path.join(session, 'scope.json');
    assert.ok(fs.existsSync(scopePath), 'scope.json written');
    const scope = JSON.parse(fs.readFileSync(scopePath, 'utf-8'));
    assert.equal(scope.version, 1);
    assert.equal(scope.mode, 'branch');
    assert.deepStrictEqual(scope.allowed_paths, ['new.ts']);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(session, { recursive: true, force: true });
  }
});

test('resolve-scope-cli: missing --session-root exits 1 (usage error, not JSON)', () => {
  const result = run(['--scope', 'branch'], { expectError: true });
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes('--session-root'));
  // Usage errors are plain text, not JSON
  assert.throws(() => JSON.parse(result.stderr));
});

test('resolve-scope-cli: error-json — empty diff exits 2 with JSON stderr', () => {
  const repo = makeRepo();
  const session = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-scope-session-'));
  try {
    // No changes since main — diff is empty → SCOPE_EMPTY_DIFF
    const result = run([
      '--scope', 'branch',
      '--scope-base', 'main',
      '--session-root', session,
    ], { cwd: repo, expectError: true });

    assert.equal(result.code, 2);
    const parsed = JSON.parse(result.stderr.trim());
    assert.equal(parsed.code, 'SCOPE_EMPTY_DIFF');
    assert.ok(typeof parsed.message === 'string' && parsed.message.length > 0);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(session, { recursive: true, force: true });
  }
});

test('resolve-scope-cli: idempotence — two runs produce same allowed_paths', () => {
  const repo = makeRepo();
  const session = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-scope-session-'));
  try {
    git(['checkout', '-qb', 'feature'], repo);
    fs.writeFileSync(path.join(repo, 'alpha.ts'), 'a\n');
    fs.writeFileSync(path.join(repo, 'beta.ts'), 'b\n');
    git(['add', '.'], repo);
    git(['commit', '-qm', 'two files'], repo);

    const cliArgs = ['--scope', 'branch', '--scope-base', 'main', '--session-root', session];
    run(cliArgs, { cwd: repo });
    const first = JSON.parse(fs.readFileSync(path.join(session, 'scope.json'), 'utf-8'));
    run(cliArgs, { cwd: repo });
    const second = JSON.parse(fs.readFileSync(path.join(session, 'scope.json'), 'utf-8'));

    assert.deepStrictEqual(first.allowed_paths, second.allowed_paths);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(session, { recursive: true, force: true });
  }
});

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { walkDiff } from '../services/citadel/diff-walker.js';

function git(cwd, args, options = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...options.env },
  }).trim();
}

function writeFile(repo, filePath, content) {
  const fullPath = path.join(repo, filePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function commit(repo, message, authorName) {
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', message], {
    env: {
      GIT_AUTHOR_NAME: authorName,
      GIT_AUTHOR_EMAIL: `${authorName.toLowerCase().replace(/\s+/g, '.')}@test.local`,
      GIT_COMMITTER_NAME: authorName,
      GIT_COMMITTER_EMAIL: `${authorName.toLowerCase().replace(/\s+/g, '.')}@test.local`,
    },
  });
  return git(repo, ['rev-parse', 'HEAD']);
}

function createRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-diff-walker-'));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['config', 'user.email', 'test@test.local']);
  git(repo, ['config', 'user.name', 'Test User']);
  return repo;
}

describe('walkDiff', () => {
  test('returns deterministic changed files, claude files, and blame for changed lines', () => {
    const repo = createRepo();
    try {
      writeFile(repo, 'src/feature/service.ts', 'export function value() {\n  return 1;\n}\n');
      writeFile(repo, 'src/feature/service.test.ts', 'import { value } from "./service";\n');
      const base = commit(repo, 'base service', 'Alice Base');

      writeFile(repo, 'src/feature/CLAUDE.md', '# Feature Rules\n');
      writeFile(repo, 'src/feature/service.ts', 'export function value() {\n  return 2;\n}\n');
      writeFile(repo, 'src/feature/service.test.ts', 'import { value } from "./service";\n\ntest("value", () => value());\n');
      writeFile(repo, 'src/feature/nested/extra.ts', 'export const extra = true;\n');
      commit(repo, 'change feature', 'Bob Change');

      const summary = walkDiff(`${base}..HEAD`, { repoRoot: repo });

      assert.equal(summary.base, base);
      assert.equal(summary.head, 'HEAD');
      assert.deepEqual(
        summary.changedFiles.map((file) => [file.path, file.status, file.kind]),
        [
          ['src/feature/CLAUDE.md', 'A', 'production'],
          ['src/feature/nested/extra.ts', 'A', 'production'],
          ['src/feature/service.test.ts', 'M', 'test'],
          ['src/feature/service.ts', 'M', 'production'],
        ],
      );
      assert.deepEqual(summary.claudeFiles, ['src/feature/CLAUDE.md']);

      const service = summary.changedFiles.find((file) => file.path === 'src/feature/service.ts');
      assert.deepEqual(service.changedLines, [{ start: 2, end: 2 }]);
      assert.equal(service.blame.length, 1);
      assert.equal(service.blame[0].author, 'Bob Change');
      assert.deepEqual(service.blame[0].lines, [2]);
      assert.match(service.blame[0].commit, /^[0-9a-f]{40}$/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('accepts a single base ref and defaults head to HEAD', () => {
    const repo = createRepo();
    try {
      writeFile(repo, 'src/app.ts', 'export const app = 1;\n');
      const base = commit(repo, 'base app', 'Alice Base');
      writeFile(repo, 'src/app.ts', 'export const app = 2;\n');
      commit(repo, 'change app', 'Bob Change');

      const summary = walkDiff(base, { repoRoot: repo });

      assert.equal(summary.base, base);
      assert.equal(summary.head, 'HEAD');
      assert.deepEqual(summary.changedFiles.map((file) => file.path), ['src/app.ts']);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

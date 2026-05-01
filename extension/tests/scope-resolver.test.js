import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveScope } from '../services/scope-resolver.js';

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
    if (res.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed:\n${res.stderr}`);
    }
    return (res.stdout || '').trim();
}

function makeRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-resolver-'));
    git(['init', '-q', '-b', 'main'], dir);
    git(['config', 'commit.gpgsign', 'false'], dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
    fs.writeFileSync(path.join(dir, 'c.txt'), 'c\n');
    git(['add', '.'], dir);
    git(['commit', '-qm', 'initial'], dir);
    return dir;
}

function cleanup(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
}

test('resolveScope: branch mode — A+M+R included, D excluded', () => {
    const repo = makeRepo();
    const session = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-session-'));
    try {
        git(['checkout', '-qb', 'feature'], repo);
        fs.writeFileSync(path.join(repo, 'new.ts'), 'new\n');
        fs.writeFileSync(path.join(repo, 'b.txt'), 'b-changed\n');
        fs.unlinkSync(path.join(repo, 'c.txt'));
        git(['mv', 'a.txt', 'renamed.ts'], repo);
        git(['add', '-A'], repo);
        git(['commit', '-qm', 'feature'], repo);

        const scope = resolveScope({
            scopeFlag: 'branch',
            scopeBase: 'main',
            sessionRoot: session,
            repoRoot: repo,
        });

        assert.deepStrictEqual(scope.allowed_paths, ['b.txt', 'new.ts', 'renamed.ts']);
        assert.equal(scope.mode, 'branch');
        assert.equal(scope.strategy, 'strict');
        assert.equal(scope.base_ref, 'main');
        assert.ok(scope.base_sha && scope.base_sha.length === 40, 'base_sha is a full SHA');
        assert.ok(scope.head_sha && scope.head_sha.length === 40, 'head_sha is a full SHA');
        assert.ok(fs.existsSync(path.join(session, 'scope.json')), 'scope.json written');
    } finally {
        cleanup(repo);
        cleanup(session);
    }
});

test('resolveScope: diff:<ref> mode equivalent to branch with same base', () => {
    const repo = makeRepo();
    const session = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-session-'));
    try {
        git(['checkout', '-qb', 'feature'], repo);
        fs.writeFileSync(path.join(repo, 'new.ts'), 'new\n');
        git(['add', '.'], repo);
        git(['commit', '-qm', 'add new'], repo);

        const scope = resolveScope({
            scopeFlag: 'diff:main',
            sessionRoot: session,
            repoRoot: repo,
        });

        assert.deepStrictEqual(scope.allowed_paths, ['new.ts']);
        assert.equal(scope.mode, 'diff');
        assert.equal(scope.base_ref, 'main');
    } finally {
        cleanup(repo);
        cleanup(session);
    }
});

test('resolveScope: paths mode matches globs against working tree', () => {
    const repo = makeRepo();
    const session = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-session-'));
    try {
        fs.mkdirSync(path.join(repo, 'src', 'x'), { recursive: true });
        fs.writeFileSync(path.join(repo, 'src', 'x', 'y.ts'), 'y\n');
        fs.writeFileSync(path.join(repo, 'src', 'x', 'z.ts'), 'z\n');
        fs.writeFileSync(path.join(repo, 'readme.md'), 'md\n');
        git(['add', '.'], repo);
        git(['commit', '-qm', 'src tree'], repo);

        const scope = resolveScope({
            scopeFlag: 'paths:src/**/*.ts',
            sessionRoot: session,
            repoRoot: repo,
        });

        assert.deepStrictEqual(scope.allowed_paths, ['src/x/y.ts', 'src/x/z.ts']);
        assert.equal(scope.mode, 'paths');
        assert.equal(scope.base_ref, null);
        assert.equal(scope.base_sha, null);
    } finally {
        cleanup(repo);
        cleanup(session);
    }
});

test('resolveScope: base-default falls back to "main" when no upstream', () => {
    const repo = makeRepo();
    const session = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-session-'));
    try {
        git(['checkout', '-qb', 'feature'], repo);
        fs.writeFileSync(path.join(repo, 'new.ts'), 'new\n');
        git(['add', '.'], repo);
        git(['commit', '-qm', 'work'], repo);

        const scope = resolveScope({
            scopeFlag: 'branch',
            // no scopeBase — force default resolution
            sessionRoot: session,
            repoRoot: repo,
        });

        assert.equal(scope.base_ref, 'main',
            'no upstream is configured in fixture; default must be "main"');
        assert.deepStrictEqual(scope.allowed_paths, ['new.ts']);
    } finally {
        cleanup(repo);
        cleanup(session);
    }
});

test('resolveScope: determinism — two calls produce byte-identical allowed_paths', () => {
    const repo = makeRepo();
    const session = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-session-'));
    try {
        git(['checkout', '-qb', 'feature'], repo);
        // Files whose natural walk order differs from byte-order sort
        fs.writeFileSync(path.join(repo, 'z.ts'), 'z\n');
        fs.writeFileSync(path.join(repo, 'A.ts'), 'A\n');
        fs.writeFileSync(path.join(repo, 'm.ts'), 'm\n');
        git(['add', '.'], repo);
        git(['commit', '-qm', 'sort test'], repo);

        const first = resolveScope({
            scopeFlag: 'branch', scopeBase: 'main', sessionRoot: session, repoRoot: repo,
        });
        const second = resolveScope({
            scopeFlag: 'branch', scopeBase: 'main', sessionRoot: session, repoRoot: repo,
        });

        assert.deepStrictEqual(first.allowed_paths, second.allowed_paths);
        // Byte-order places 'A.ts' before 'm.ts' before 'z.ts'
        assert.deepStrictEqual(first.allowed_paths, ['A.ts', 'm.ts', 'z.ts']);
    } finally {
        cleanup(repo);
        cleanup(session);
    }
});

test('resolveScope: --target narrows allowed_paths to subtree', () => {
    const repo = makeRepo();
    const session = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-session-'));
    try {
        git(['checkout', '-qb', 'feature'], repo);
        fs.mkdirSync(path.join(repo, 'pkg'), { recursive: true });
        fs.writeFileSync(path.join(repo, 'pkg', 'inside.ts'), 'inside\n');
        fs.writeFileSync(path.join(repo, 'outside.ts'), 'outside\n');
        git(['add', '.'], repo);
        git(['commit', '-qm', 'mixed'], repo);

        const scope = resolveScope({
            scopeFlag: 'branch',
            scopeBase: 'main',
            target: path.join(repo, 'pkg'),
            sessionRoot: session,
            repoRoot: repo,
        });

        assert.deepStrictEqual(scope.allowed_paths, ['pkg/inside.ts']);
    } finally {
        cleanup(repo);
        cleanup(session);
    }
});

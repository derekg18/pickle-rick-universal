import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveScope, ScopeError } from '../services/scope-resolver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ANATOMY_PARK_MD = path.resolve(__dirname, '../../.claude/commands/anatomy-park.md');
const SZECHUAN_MD = path.resolve(__dirname, '../../.claude/commands/szechuan-sauce.md');

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

function initRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-err-'));
    git(['init', '-q', '-b', 'main'], dir);
    git(['config', 'commit.gpgsign', 'false'], dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    git(['add', '.'], dir);
    git(['commit', '-qm', 'initial'], dir);
    return dir;
}

function cleanup(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
}

test('SCOPE_BAD_FLAG: unknown flag token', () => {
    const repo = initRepo();
    const session = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-session-'));
    try {
        assert.throws(
            () => resolveScope({
                scopeFlag: 'bogus', sessionRoot: session, repoRoot: repo,
            }),
            (err) => err instanceof ScopeError && err.code === 'SCOPE_BAD_FLAG',
        );
    } finally {
        cleanup(repo);
        cleanup(session);
    }
});

test('SCOPE_NOT_A_REPO: path without .git', () => {
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-nonrepo-'));
    const session = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-session-'));
    try {
        assert.throws(
            () => resolveScope({
                scopeFlag: 'branch', sessionRoot: session, repoRoot: nonRepo,
            }),
            (err) => err instanceof ScopeError && err.code === 'SCOPE_NOT_A_REPO',
        );
    } finally {
        cleanup(nonRepo);
        cleanup(session);
    }
});

test('SCOPE_BASE_MISSING: unknown base ref', () => {
    const repo = initRepo();
    const session = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-session-'));
    try {
        assert.throws(
            () => resolveScope({
                scopeFlag: 'branch',
                scopeBase: 'nonexistent-ref-xyz',
                sessionRoot: session,
                repoRoot: repo,
            }),
            (err) => err instanceof ScopeError && err.code === 'SCOPE_BASE_MISSING',
        );
    } finally {
        cleanup(repo);
        cleanup(session);
    }
});

test('SCOPE_EMPTY_DIFF: HEAD == base, no changes', () => {
    const repo = initRepo();
    const session = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-session-'));
    try {
        // No branch, no new commits — HEAD == main; diff is empty
        assert.throws(
            () => resolveScope({
                scopeFlag: 'branch',
                scopeBase: 'main',
                sessionRoot: session,
                repoRoot: repo,
            }),
            (err) => err instanceof ScopeError && err.code === 'SCOPE_EMPTY_DIFF',
        );
    } finally {
        cleanup(repo);
        cleanup(session);
    }
});

test('SCOPE_EMPTY_PATHS: glob matches zero files', () => {
    const repo = initRepo();
    const session = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-session-'));
    try {
        assert.throws(
            () => resolveScope({
                scopeFlag: 'paths:zzz-no-match-*.xyz',
                sessionRoot: session,
                repoRoot: repo,
            }),
            (err) => err instanceof ScopeError && err.code === 'SCOPE_EMPTY_PATHS',
        );
    } finally {
        cleanup(repo);
        cleanup(session);
    }
});

// ---------------------------------------------------------------------------
// SCOPE_DRYRUN_CONFLICT: both .md files document the error
// ---------------------------------------------------------------------------

test('SCOPE_DRYRUN_CONFLICT: anatomy-park.md documents --scope + --dry-run error', () => {
    const content = fs.readFileSync(ANATOMY_PARK_MD, 'utf-8');
    assert.ok(
        content.includes('SCOPE_DRYRUN_CONFLICT'),
        'anatomy-park.md must contain SCOPE_DRYRUN_CONFLICT',
    );
});

test('SCOPE_DRYRUN_CONFLICT: szechuan-sauce.md documents --scope + --dry-run error', () => {
    const content = fs.readFileSync(SZECHUAN_MD, 'utf-8');
    assert.ok(
        content.includes('SCOPE_DRYRUN_CONFLICT'),
        'szechuan-sauce.md must contain SCOPE_DRYRUN_CONFLICT',
    );
});

// ---------------------------------------------------------------------------
// standalone-empty: standalone resolve (CUJ-6b) → SCOPE_EMPTY_DIFF, no scope.json
// ---------------------------------------------------------------------------

test('standalone-empty: resolveScope on branch at base SHA → SCOPE_EMPTY_DIFF, scope.json not written', () => {
    const repo = initRepo();
    const session = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-standalone-empty-'));
    try {
        // HEAD == main, no commits beyond initial → empty diff
        assert.throws(
            () => resolveScope({
                scopeFlag: 'branch',
                scopeBase: 'main',
                sessionRoot: session,
                repoRoot: repo,
            }),
            (err) => err instanceof ScopeError && err.code === 'SCOPE_EMPTY_DIFF',
        );
        assert.ok(
            !fs.existsSync(path.join(session, 'scope.json')),
            'scope.json must NOT be written when standalone call throws SCOPE_EMPTY_DIFF (CUJ-6b)',
        );
    } finally {
        cleanup(repo);
        cleanup(session);
    }
});

/**
 * pipeline-e2e — E2E scope pipeline integration test.
 *
 * Fixture: git repo with a branch containing changed files.
 * Asserts:
 *   - scope.json written with correct allowed_paths (scope present)
 *   - anatomy-park skipped_by_scope artifact captures filtered/kept subsystems
 *   - szechuan-sauce skipped_by_scope artifact captures clamped allowed_paths
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setupScope, writeSkippedByScope } from '../../bin/pipeline-runner.js';
import { ScopeError } from '../../services/scope-resolver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function git(args, cwd) {
    const res = spawnSync('git', args, {
        cwd,
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@test.invalid',
            GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@test.invalid',
        },
        encoding: 'utf-8',
    });
    if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${res.stderr}`);
    return (res.stdout || '').trim();
}

function makeRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-e2e-repo-'));
    git(['init', '-q', '-b', 'main'], dir);
    git(['config', 'commit.gpgsign', 'false'], dir);
    fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
    git(['add', '.'], dir);
    git(['commit', '-qm', 'initial'], dir);
    return dir;
}

function makeSession(repoRoot) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-e2e-session-'));
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        active: false,
        working_dir: repoRoot,
        step: 'review',
        iteration: 0,
        max_iterations: 10,
        max_time_minutes: 60,
        worker_timeout_seconds: 1200,
        start_time_epoch: Math.floor(Date.now() / 1000),
        completion_promise: null,
        original_prompt: 'e2e pipeline test',
        current_ticket: null,
        history: [],
        started_at: new Date().toISOString(),
        session_dir: dir,
    }, null, 2));
    return dir;
}

function cleanup(...dirs) {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// E2E: scope.json present with correct allowed_paths
// ---------------------------------------------------------------------------

test('pipeline-e2e: scope.json present with correct allowed_paths on feature branch', () => {
    const repo = makeRepo();
    const session = makeSession(repo);
    try {
        git(['checkout', '-qb', 'feature'], repo);

        // Create two subsystem directories — only alpha changes on branch
        fs.mkdirSync(path.join(repo, 'alpha'));
        fs.mkdirSync(path.join(repo, 'beta'));
        for (let i = 0; i < 2; i++) {
            fs.writeFileSync(path.join(repo, 'alpha', `a${i}.ts`), `export const a${i} = ${i};\n`);
            fs.writeFileSync(path.join(repo, 'beta', `b${i}.ts`), `export const b${i} = ${i};\n`);
        }
        git(['add', 'alpha'], repo);
        git(['commit', '-qm', 'add alpha subsystem'], repo);

        const messages = [];
        const scope = setupScope({
            sessionDir: session,
            workingDir: repo,
            target: repo,
            scopeFlag: 'branch',
            scopeBase: 'main',
            log: (m) => messages.push(m),
        });

        assert.ok(scope, 'setupScope returned a scope object');

        const scopePath = path.join(session, 'scope.json');
        assert.ok(fs.existsSync(scopePath), 'scope.json written to session dir');

        const persisted = JSON.parse(fs.readFileSync(scopePath, 'utf-8'));
        assert.equal(persisted.version, 1, 'scope.json version=1');
        assert.equal(persisted.mode, 'branch', 'scope mode=branch');
        assert.ok(persisted.allowed_paths.some((p) => p.startsWith('alpha/')), 'alpha files in allowed_paths');
        assert.ok(!persisted.allowed_paths.some((p) => p.startsWith('beta/')), 'beta files NOT in allowed_paths');

        const state = JSON.parse(fs.readFileSync(path.join(session, 'state.json'), 'utf-8'));
        assert.deepStrictEqual(state.phases_entered, [], 'phases_entered initialized to []');
    } finally {
        cleanup(repo, session);
    }
});

// ---------------------------------------------------------------------------
// E2E: anatomy-park filtered — skipped_by_scope artifact captures subsystem split
// ---------------------------------------------------------------------------

test('pipeline-e2e: anatomy-park phase writes skipped_by_scope artifact (filtered)', () => {
    const repo = makeRepo();
    const session = makeSession(repo);
    try {
        // Build two subsystem directories; scope covers only alpha
        for (const name of ['alpha', 'beta', 'gamma']) {
            const d = path.join(repo, name);
            fs.mkdirSync(d);
            for (let i = 0; i < 3; i++) {
                fs.writeFileSync(path.join(d, `f${i}.ts`), `export const v = ${i};\n`);
            }
        }

        const scope = {
            version: 1, mode: 'branch', strategy: 'strict',
            base_ref: 'main', base_sha: null, head_sha: 'abc'.repeat(14),
            allowed_paths: ['alpha/f0.ts', 'alpha/f1.ts'],
            resolved_at: new Date().toISOString(),
            refresh_history: [],
        };

        writeSkippedByScope(session, 'anatomy-park', scope, repo, repo);

        const artifactPath = path.join(session, 'archive', 'skipped_by_scope.anatomy-park.json');
        assert.ok(fs.existsSync(artifactPath), 'skipped_by_scope.anatomy-park.json written');

        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf-8'));
        assert.equal(artifact.phase, 'anatomy-park');
        assert.deepStrictEqual(artifact.allowed_paths, scope.allowed_paths);
        assert.ok(artifact.subsystems_discovered.includes('alpha'), 'alpha in discovered');
        assert.ok(artifact.subsystems_discovered.includes('beta'), 'beta in discovered');
        assert.ok(artifact.subsystems_discovered.includes('gamma'), 'gamma in discovered');
        assert.deepStrictEqual(artifact.subsystems_kept, ['alpha'], 'only alpha kept');
        assert.ok(artifact.subsystems_skipped.includes('beta'), 'beta skipped');
        assert.ok(artifact.subsystems_skipped.includes('gamma'), 'gamma skipped');
    } finally {
        cleanup(repo, session);
    }
});

// ---------------------------------------------------------------------------
// E2E: szechuan-sauce clamped — skipped_by_scope artifact has flat allowed_paths
// ---------------------------------------------------------------------------

test('pipeline-e2e: szechuan-sauce phase writes skipped_by_scope artifact (clamped)', () => {
    const repo = makeRepo();
    const session = makeSession(repo);
    try {
        const allowedPaths = ['src/a.ts', 'src/b.ts'];
        const scope = {
            version: 1, mode: 'branch', strategy: 'strict',
            base_ref: 'main', base_sha: null, head_sha: 'def'.repeat(14),
            allowed_paths: allowedPaths,
            resolved_at: new Date().toISOString(),
            refresh_history: [],
        };

        writeSkippedByScope(session, 'szechuan-sauce', scope, repo, repo);

        const artifactPath = path.join(session, 'archive', 'skipped_by_scope.szechuan-sauce.json');
        assert.ok(fs.existsSync(artifactPath), 'skipped_by_scope.szechuan-sauce.json written');

        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf-8'));
        assert.equal(artifact.phase, 'szechuan-sauce');
        assert.deepStrictEqual(artifact.allowed_paths, allowedPaths, 'allowed_paths clamped to scope');
        assert.equal(artifact.subsystems_discovered, undefined, 'no subsystem fields for szechuan-sauce');
        assert.equal(artifact.subsystems_kept, undefined, 'no subsystem fields for szechuan-sauce');
        assert.equal(artifact.subsystems_skipped, undefined, 'no subsystem fields for szechuan-sauce');
    } finally {
        cleanup(repo, session);
    }
});

// ---------------------------------------------------------------------------
// E2E: SCOPE_BAD_FLAG propagates at setup
// ---------------------------------------------------------------------------

test('pipeline-e2e: ScopeError propagates on bad scope flag', () => {
    const repo = makeRepo();
    const session = makeSession(repo);
    try {
        assert.throws(
            () => setupScope({
                sessionDir: session,
                workingDir: repo,
                target: repo,
                scopeFlag: 'not-a-real-flag',
                log: () => {},
            }),
            (err) => err instanceof ScopeError && err.code === 'SCOPE_BAD_FLAG',
        );
    } finally {
        cleanup(repo, session);
    }
});

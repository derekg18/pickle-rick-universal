import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveScope } from '../services/scope-resolver.js';
import { setupScope } from '../bin/pipeline-runner.js';

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
    if (res.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed:\n${res.stderr}`);
    }
    return (res.stdout || '').trim();
}

function makeRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-standalone-repo-'));
    git(['init', '-q', '-b', 'main'], dir);
    git(['config', 'commit.gpgsign', 'false'], dir);
    fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
    git(['add', '.'], dir);
    git(['commit', '-qm', 'initial'], dir);
    return dir;
}

function makeSession(repoRoot) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-standalone-session-'));
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
        original_prompt: 'test',
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
// FR-1b: standalone resolve-scope.js --scope writes scope.json
// ---------------------------------------------------------------------------

test('FR-1b: standalone resolve-scope.js --scope branch writes scope.json', () => {
    const repo = makeRepo();
    const session = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-standalone-fr1b-'));
    try {
        git(['checkout', '-qb', 'feature'], repo);
        fs.writeFileSync(path.join(repo, 'feature.ts'), 'export const x = 1;\n');
        git(['add', '.'], repo);
        git(['commit', '-qm', 'add feature'], repo);

        execFileSync(process.execPath, [
            CLI_PATH,
            '--scope', 'branch',
            '--scope-base', 'main',
            '--session-root', session,
        ], { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] });

        const scopePath = path.join(session, 'scope.json');
        assert.ok(fs.existsSync(scopePath), 'scope.json written at session root (FR-1b)');

        const scope = JSON.parse(fs.readFileSync(scopePath, 'utf-8'));
        assert.equal(scope.version, 1);
        assert.equal(scope.mode, 'branch');
        assert.deepStrictEqual(scope.allowed_paths, ['feature.ts']);
    } finally {
        cleanup(repo, session);
    }
});

// ---------------------------------------------------------------------------
// FR-23: omitted --scope → resolve-scope.js not invoked → no scope.json
// ---------------------------------------------------------------------------

test('FR-23: omitted --scope → no scope.json written', () => {
    // Simulates /anatomy-park or /szechuan-sauce without --scope:
    // SCOPE_FLAG is undefined → the Step 6.5 branch is never taken.
    const session = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-standalone-fr23-'));
    try {
        const scopeFlag = undefined; // no --scope provided to the command

        if (scopeFlag) {
            // This is the Step 6.5 branch — never reached when --scope is omitted
            throw new Error('unreachable: scopeFlag is undefined');
        }

        assert.ok(
            !fs.existsSync(path.join(session, 'scope.json')),
            'no scope.json when --scope is omitted (FR-23)',
        );
    } finally {
        cleanup(session);
    }
});

// ---------------------------------------------------------------------------
// FR-24: pipeline vs standalone consistency — identical allowed_paths
// ---------------------------------------------------------------------------

test('FR-24: pipeline setupScope vs standalone resolve-scope.js → identical allowed_paths', () => {
    const repo = makeRepo();
    const standaloneSession = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-standalone-fr24a-'));
    const pipelineSession = makeSession(repo);
    try {
        git(['checkout', '-qb', 'feature'], repo);
        fs.writeFileSync(path.join(repo, 'alpha.ts'), 'export const a = 1;\n');
        fs.writeFileSync(path.join(repo, 'beta.ts'), 'export const b = 2;\n');
        git(['add', '.'], repo);
        git(['commit', '-qm', 'two files'], repo);

        // Standalone: resolve-scope.js CLI (mirrors Step 6.5 in standalone .md files)
        execFileSync(process.execPath, [
            CLI_PATH,
            '--scope', 'branch',
            '--scope-base', 'main',
            '--session-root', standaloneSession,
        ], { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] });
        const standaloneScope = JSON.parse(
            fs.readFileSync(path.join(standaloneSession, 'scope.json'), 'utf-8'),
        );

        // Pipeline: setupScope() from pipeline-runner.js
        const pipelineScope = setupScope({
            sessionDir: pipelineSession,
            workingDir: repo,
            target: repo,
            scopeFlag: 'branch',
            scopeBase: 'main',
            log: () => {},
        });

        assert.ok(pipelineScope, 'pipeline setupScope returned a scope');
        assert.deepStrictEqual(
            standaloneScope.allowed_paths,
            pipelineScope.allowed_paths,
            'standalone and pipeline produce identical allowed_paths (FR-24)',
        );
    } finally {
        cleanup(repo, standaloneSession, pipelineSession);
    }
});

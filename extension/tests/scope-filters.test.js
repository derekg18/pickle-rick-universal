import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { filterBySubsystem, filterByPaths, resolveScope } from '../services/scope-resolver.js';
import { discoverSubsystems } from '../bin/pipeline-runner.js';

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

test('filterBySubsystem: 4 subsystems, 2 have files in allowedPaths → returns those 2', () => {
    const repoRoot = '/repo';
    const target = '/repo/pkg';
    const subsystems = ['alpha', 'beta', 'gamma', 'delta'];
    const allowedPaths = [
        'pkg/alpha/index.ts',
        'pkg/gamma/util.ts',
        'pkg/gamma/helper.ts',
    ];
    const result = filterBySubsystem(subsystems, allowedPaths, target, repoRoot);
    assert.deepStrictEqual(result, ['alpha', 'gamma']);
});

test('filterByPaths: 10 files, 3 in allowedPaths → returns those 3', () => {
    const repoRoot = '/repo';
    const allowedPaths = ['src/a.ts', 'src/c.ts', 'src/g.ts'];
    const absFiles = [
        '/repo/src/a.ts',
        '/repo/src/b.ts',
        '/repo/src/c.ts',
        '/repo/src/d.ts',
        '/repo/src/e.ts',
        '/repo/src/f.ts',
        '/repo/src/g.ts',
        '/repo/src/h.ts',
        '/repo/src/i.ts',
        '/repo/src/j.ts',
    ];
    const result = filterByPaths(absFiles, allowedPaths, repoRoot);
    assert.deepStrictEqual(result, ['/repo/src/a.ts', '/repo/src/c.ts', '/repo/src/g.ts']);
});

test('resolveScope: binary file (.png) excluded from allowed_paths per FR-26', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-binary-'));
    const session = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-binary-sess-'));
    try {
        git(['init', '-q', '-b', 'main'], dir);
        git(['config', 'commit.gpgsign', 'false'], dir);
        fs.writeFileSync(path.join(dir, 'initial.ts'), 'initial\n');
        git(['add', '.'], dir);
        git(['commit', '-qm', 'initial'], dir);

        git(['checkout', '-qb', 'feature'], dir);
        fs.writeFileSync(path.join(dir, 'feature.ts'), 'export const x = 1;\n');
        // NUL byte makes git detect this as binary
        fs.writeFileSync(path.join(dir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]));
        git(['add', '.'], dir);
        git(['commit', '-qm', 'feature'], dir);

        const scope = resolveScope({
            scopeFlag: 'branch',
            scopeBase: 'main',
            sessionRoot: session,
            repoRoot: dir,
        });

        assert.ok(!scope.allowed_paths.includes('image.png'), '.png must not appear in allowed_paths');
        assert.ok(scope.allowed_paths.includes('feature.ts'), 'text file must appear in allowed_paths');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(session, { recursive: true, force: true });
    }
});

test('filterBySubsystem: allowedPaths outside target subtree → returns []', () => {
    const repoRoot = '/repo';
    const target = '/repo/pkg';
    const subsystems = ['alpha', 'beta'];
    // Paths are under 'other/', not 'pkg/' — completely outside target
    const allowedPaths = [
        'other/alpha/index.ts',
        'other/beta/util.ts',
    ];
    const result = filterBySubsystem(subsystems, allowedPaths, target, repoRoot);
    assert.deepStrictEqual(result, []);
});

test('pipeline-mode integration: discoverSubsystems names feed filterBySubsystem correctly', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-pipeline-int-'));
    try {
        // 4 subsystems — only alpha and gamma are in the scope diff
        for (const name of ['alpha', 'beta', 'gamma', 'delta']) {
            const sub = path.join(root, name);
            fs.mkdirSync(sub);
            for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(sub, `f${i}.ts`), '');
        }

        const discovered = discoverSubsystems(root);
        const names = discovered.map(s => s.name);
        assert.deepStrictEqual(names, ['alpha', 'beta', 'delta', 'gamma']); // sorted

        const allowedPaths = ['alpha/f0.ts', 'gamma/f1.ts'];
        const kept = filterBySubsystem(names, allowedPaths, root, root);
        assert.deepStrictEqual(kept, ['alpha', 'gamma']);

        // Simulate the pipeline-runner filter: kept set narrows the discovered list
        const keptSet = new Set(kept);
        const filtered = discovered.filter(s => keptSet.has(s.name));
        assert.equal(filtered.length, 2);
        assert.deepStrictEqual(filtered.map(s => s.name), ['alpha', 'gamma']);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

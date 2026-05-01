import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { computeOneHop, ScopeError } from '../services/scope-resolver.js';

function cleanup(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
}

test('computeOneHop: basic one-hop — importer detected, unrelated file excluded', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-one-hop-basic-'));
    try {
        fs.writeFileSync(path.join(repo, 'a.ts'), 'export function foo() {}\n');
        fs.writeFileSync(path.join(repo, 'b.ts'), "import { foo } from './a';\n");
        fs.writeFileSync(path.join(repo, 'c.ts'), 'const x = 1;\n');

        const result = computeOneHop(['a.ts'], repo);

        assert.ok(result.includes('a.ts'), 'includes diff file a.ts');
        assert.ok(result.includes('b.ts'), 'includes importer b.ts');
        assert.ok(!result.includes('c.ts'), 'excludes unrelated c.ts');
        assert.deepStrictEqual(result, [...new Set(result)].sort(), 'sorted and deduplicated');
    } finally {
        cleanup(repo);
    }
});

test('computeOneHop: isolated module with no importers yields only diff files', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-one-hop-isolated-'));
    try {
        fs.writeFileSync(path.join(repo, 'a.ts'), 'export function foo() {}\n');
        fs.writeFileSync(path.join(repo, 'c.ts'), 'const x = 1;\n');

        // c.ts has no exports — no importers exist
        const result = computeOneHop(['c.ts'], repo);

        assert.deepStrictEqual(result, ['c.ts'], 'only the diff file returned');
    } finally {
        cleanup(repo);
    }
});

test('computeOneHop: 101-file diff throws SCOPE_ONE_HOP_TOO_LARGE with remediation hint', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-one-hop-cap-'));
    try {
        const diffFiles = Array.from({ length: 101 }, (_, i) => `file${i}.ts`);

        assert.throws(
            () => computeOneHop(diffFiles, repo),
            (err) => {
                assert.ok(err instanceof ScopeError, 'is a ScopeError');
                assert.equal(err.code, 'SCOPE_ONE_HOP_TOO_LARGE');
                assert.ok(err.message.includes('101'), 'message includes file count');
                assert.ok(
                    err.message.includes('--scope paths:') || err.message.includes('one-hop'),
                    'message includes remediation hint',
                );
                return true;
            },
        );
    } finally {
        cleanup(repo);
    }
});

test('computeOneHop: aliased import (import { foo as bar }) not detected — documented miss', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-one-hop-alias-'));
    try {
        fs.writeFileSync(path.join(repo, 'a.ts'), 'export function foo() {}\n');
        // b.ts imports foo under alias bar — grep pattern misses this (aliased import limitation)
        fs.writeFileSync(path.join(repo, 'b.ts'), "import { foo as bar } from './a';\n");

        const result = computeOneHop(['a.ts'], repo);

        assert.ok(result.includes('a.ts'), 'diff file included');
        assert.ok(!result.includes('b.ts'), 'aliased import b.ts not detected (documented miss)');
    } finally {
        cleanup(repo);
    }
});

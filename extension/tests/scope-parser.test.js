import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScope, ScopeError } from '../services/scope-resolver.js';

test('parseScope: bare branch → strict', () => {
    assert.deepStrictEqual(parseScope('branch'), {
        mode: 'branch', strategy: 'strict', base: null,
    });
});

test('parseScope: branch:strict explicit', () => {
    assert.deepStrictEqual(parseScope('branch:strict'), {
        mode: 'branch', strategy: 'strict', base: null,
    });
});

test('parseScope: branch:one-hop', () => {
    assert.deepStrictEqual(parseScope('branch:one-hop'), {
        mode: 'branch', strategy: 'one-hop', base: null,
    });
});

test('parseScope: diff:<ref> → strict', () => {
    assert.deepStrictEqual(parseScope('diff:origin/main'), {
        mode: 'diff', strategy: 'strict', base: 'origin/main',
    });
});

test('parseScope: diff:<ref>:one-hop', () => {
    assert.deepStrictEqual(parseScope('diff:main:one-hop'), {
        mode: 'diff', strategy: 'one-hop', base: 'main',
    });
});

test('parseScope: paths:<glob,glob>', () => {
    assert.deepStrictEqual(parseScope('paths:src/a/**,src/b/**'), {
        mode: 'paths', strategy: 'strict', base: 'src/a/**,src/b/**',
    });
});

test('parseScope: bare empty string throws SCOPE_BAD_FLAG', () => {
    assert.throws(
        () => parseScope(''),
        (err) => err instanceof ScopeError && err.code === 'SCOPE_BAD_FLAG',
    );
});

test('parseScope: unknown token throws SCOPE_BAD_FLAG', () => {
    assert.throws(
        () => parseScope('bogus'),
        (err) => err instanceof ScopeError && err.code === 'SCOPE_BAD_FLAG',
    );
});

test('parseScope: diff without ref throws SCOPE_BAD_FLAG', () => {
    assert.throws(
        () => parseScope('diff:'),
        (err) => err instanceof ScopeError && err.code === 'SCOPE_BAD_FLAG',
    );
});

test('parseScope: paths without glob throws SCOPE_BAD_FLAG', () => {
    assert.throws(
        () => parseScope('paths:'),
        (err) => err instanceof ScopeError && err.code === 'SCOPE_BAD_FLAG',
    );
});

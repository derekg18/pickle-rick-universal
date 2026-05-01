import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleTaskEnoent, validateTaskIntegrity } from '../bin/jar-runner.js';

function makeTaskDir() {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-jar-runner-helpers-')));
}

test('validateTaskIntegrity: valid task returns ok', () => {
    const taskDir = makeTaskDir();
    try {
        const prd = '# Valid PRD\n';
        fs.writeFileSync(path.join(taskDir, 'prd.md'), prd);
        const prdHash = crypto.createHash('sha256').update(prd).digest('hex');

        assert.deepEqual(validateTaskIntegrity(taskDir, { prd_hash: prdHash }), { kind: 'ok' });
    } finally {
        fs.rmSync(taskDir, { recursive: true, force: true });
    }
});

test('validateTaskIntegrity: tampered PRD returns hash-mismatch', () => {
    const taskDir = makeTaskDir();
    try {
        fs.writeFileSync(path.join(taskDir, 'prd.md'), '# Changed PRD\n');
        const staleHash = crypto.createHash('sha256').update('# Original PRD\n').digest('hex');

        assert.deepEqual(
            validateTaskIntegrity(taskDir, { prd_hash: staleHash }),
            { kind: 'fail', reason: 'hash-mismatch' },
        );
    } finally {
        fs.rmSync(taskDir, { recursive: true, force: true });
    }
});

test('validateTaskIntegrity: escaping prd_path returns path-traversal', () => {
    const taskDir = makeTaskDir();
    try {
        const prdHash = crypto.createHash('sha256').update('irrelevant').digest('hex');

        assert.deepEqual(
            validateTaskIntegrity(taskDir, { prd_hash: prdHash, prd_path: '../../etc/passwd' }),
            { kind: 'fail', reason: 'path-traversal' },
        );
    } finally {
        fs.rmSync(taskDir, { recursive: true, force: true });
    }
});

test('validateTaskIntegrity: absent PRD returns missing-file', () => {
    const taskDir = makeTaskDir();
    try {
        const prdHash = crypto.createHash('sha256').update('# Missing PRD\n').digest('hex');

        assert.deepEqual(
            validateTaskIntegrity(taskDir, { prd_hash: prdHash }),
            { kind: 'fail', reason: 'missing-file' },
        );
    } finally {
        fs.rmSync(taskDir, { recursive: true, force: true });
    }
});

test('handleTaskEnoent: codex ENOENT returns remaining queued codex task IDs', () => {
    const tasks = [
        { task_id: 'current', status: 'marinating', backend: 'codex' },
        { task_id: 'next-codex', status: 'marinating', backend: 'codex' },
        { task_id: 'next-claude', status: 'marinating', backend: 'claude' },
        { task_id: 'done-codex', status: 'consumed', backend: 'codex' },
    ];

    assert.deepEqual(
        handleTaskEnoent({ ok: false, enoent: true, backend: 'codex' }, tasks, 'current'),
        { skippedTasks: ['next-codex'] },
    );
});

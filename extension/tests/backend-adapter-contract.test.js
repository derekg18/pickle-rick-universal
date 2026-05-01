import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BACKENDS } from '../types/index.js';
import {
    backendAdapters,
    buildJudgeInvocation,
    buildManagerInvocation,
    buildWorkerInvocation,
} from '../services/backend-spawn.js';

test('backend adapter contract: every BACKENDS value has worker, manager, and judge builders', () => {
    assert.deepEqual(Object.keys(backendAdapters).sort(), [...BACKENDS].sort());

    for (const backend of BACKENDS) {
        const adapter = backendAdapters[backend];
        assert.equal(adapter.backend, backend);
        assert.equal(typeof adapter.buildWorkerInvocation, 'function');
        assert.equal(typeof adapter.buildManagerInvocation, 'function');
        assert.equal(typeof adapter.buildJudgeInvocation, 'function');
    }
});

test('backend adapter contract: exported builders dispatch through backend-owned adapters', () => {
    for (const backend of BACKENDS) {
        const worker = buildWorkerInvocation(backend, { prompt: `worker-${backend}`, addDirs: [] });
        const manager = buildManagerInvocation(backend, { prompt: `manager-${backend}`, addDirs: [] });
        const judge = buildJudgeInvocation(backend, { prompt: `judge-${backend}`, addDirs: [] });

        assert.equal(worker.backend, backend);
        assert.equal(manager.backend, backend);
        assert.equal(judge.backend, backend);
        assert.equal(worker.cmd, backend);
        assert.equal(manager.cmd, backend);
        assert.equal(judge.cmd, backend);
    }
});

/**
 * Integration test: szechuan strict gate cycle
 * 1 failure on cycle 0, remediator runs, gate green on cycle 1 → exit 0.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { finalizeGateMain } from '../../bin/finalize-gate.js';

function makeTmpDir() {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fg-sz-')));
}

function makeGateResult(status, failures = []) {
    return { status, failures, baseline_used: false, allowed_paths_used: false, elapsed_ms: 5, total_raw_failure_count: failures.length, new_failures_vs_baseline: 0 };
}

test('szechuan: 1 failure → remediator clears → gate green → exit 0', async () => {
    const sessionRoot = makeTmpDir();
    const workingDir = makeTmpDir();
    const gateDir = path.join(sessionRoot, 'gate');
    fs.mkdirSync(gateDir, { recursive: true });

    const failure = {
        check: 'lint', file: path.join(workingDir, 'src/foo.ts'),
        line: 1, ruleOrCode: 'no-any', message: 'no any', severity: 'error', occurrence_index: 0,
    };

    let gateCalls = 0;
    let remediatorCalled = false;
    let spawnRemediatorCalled = false;

    const code = await finalizeGateMain({
        argv: [sessionRoot, 'szechuan'],
        env: {},
        readMicroverseStateFn: () => ({ status: 'iterating', allowed_paths: undefined }),
        readStateForWorkingDirFn: () => ({ workingDir, backend: 'claude' }),
        loadSettingsFn: () => ({ szechuan_max_remediation_cycles: 3, anatomy_park_max_remediation_cycles: 5, remediator_timeout_s: 60 }),
        mkdirSyncFn: (p) => fs.mkdirSync(p, { recursive: true }),
        writeFileFn: (p, data) => fs.writeFileSync(p, data, 'utf-8'),
        logActivityFn: () => {},
        isoFn: () => `2026-01-01T00-00-0${gateCalls}Z`,
        runGateFn: async () => {
            const call = gateCalls++;
            if (call === 0) return makeGateResult('red', [failure]);
            return makeGateResult('green');
        },
        spawnGateRemediatorMainFn: async (briefOpts) => {
            remediatorCalled = true;
            const briefPath = path.join(gateDir, 'brief.md');
            fs.writeFileSync(briefPath, '# Brief', 'utf-8');
            briefOpts.stdout?.(`BRIEF_PATH=${briefPath}`);
            return 0;
        },
        spawnRemediatorFn: () => { spawnRemediatorCalled = true; },
        stdout: () => {},
        stderr: () => {},
    });

    assert.equal(code, 0, 'should exit 0 after remediator clears the failure');
    assert.equal(gateCalls, 2, 'gate should run twice: once red, once green');
    assert.equal(remediatorCalled, true, 'remediator brief-prep should run');
    assert.equal(spawnRemediatorCalled, true, 'remediator subprocess should spawn');

    fs.rmSync(sessionRoot, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
});

test('szechuan: green on first cycle → no remediator', async () => {
    const sessionRoot = makeTmpDir();
    fs.mkdirSync(path.join(sessionRoot, 'gate'), { recursive: true });
    let remediatorCalled = false;

    const code = await finalizeGateMain({
        argv: [sessionRoot, 'szechuan'],
        env: {},
        readMicroverseStateFn: () => ({ status: 'iterating', allowed_paths: undefined }),
        readStateForWorkingDirFn: () => ({ workingDir: '/tmp', backend: 'claude' }),
        loadSettingsFn: () => ({ szechuan_max_remediation_cycles: 3, anatomy_park_max_remediation_cycles: 5, remediator_timeout_s: 60 }),
        mkdirSyncFn: () => {},
        writeFileFn: () => {},
        logActivityFn: () => {},
        isoFn: () => '2026-01-01T00-00-00Z',
        runGateFn: async () => makeGateResult('green'),
        spawnGateRemediatorMainFn: async () => { remediatorCalled = true; return 0; },
        stdout: () => {},
        stderr: () => {},
    });

    assert.equal(code, 0);
    assert.equal(remediatorCalled, false);

    fs.rmSync(sessionRoot, { recursive: true, force: true });
});

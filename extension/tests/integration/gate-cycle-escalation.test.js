/**
 * Integration test: gate cap escalation
 * Persistent failure through all cycles → exit 2 + escalation file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { finalizeGateMain } from '../../bin/finalize-gate.js';

function makeTmpDir() {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fg-esc-')));
}

function makeRedResult(failures) {
    return { status: 'red', failures, baseline_used: false, allowed_paths_used: false, elapsed_ms: 5, total_raw_failure_count: failures.length, new_failures_vs_baseline: 0 };
}

test('szechuan cap=3: persistent failure → exit 2 + escalation file', async () => {
    const sessionRoot = makeTmpDir();
    const workingDir = makeTmpDir();
    const gateDir = path.join(sessionRoot, 'gate');
    fs.mkdirSync(gateDir, { recursive: true });

    const failure = {
        check: 'lint', file: path.join(workingDir, 'src/bar.ts'),
        line: 5, ruleOrCode: 'no-unused-vars', message: 'unused var', severity: 'error', occurrence_index: 0,
    };

    let gateCalls = 0;
    let remediatorCalls = 0;

    const code = await finalizeGateMain({
        argv: [sessionRoot, 'szechuan'],
        env: {},
        readMicroverseStateFn: () => ({ status: 'iterating', allowed_paths: undefined }),
        readStateForWorkingDirFn: () => ({ workingDir, backend: 'claude' }),
        loadSettingsFn: () => ({ szechuan_max_remediation_cycles: 3, anatomy_park_max_remediation_cycles: 5, remediator_timeout_s: 60 }),
        mkdirSyncFn: (p) => fs.mkdirSync(p, { recursive: true }),
        writeFileFn: (p, data) => fs.writeFileSync(p, data, 'utf-8'),
        logActivityFn: () => {},
        isoFn: () => `2026-01-01T${String(gateCalls).padStart(2, '0')}-00-00Z`,
        runGateFn: async () => { gateCalls++; return makeRedResult([failure]); },
        spawnGateRemediatorMainFn: async (briefOpts) => {
            remediatorCalls++;
            const briefPath = path.join(gateDir, `brief_${remediatorCalls}.md`);
            fs.writeFileSync(briefPath, '# Brief', 'utf-8');
            briefOpts.stdout?.(`BRIEF_PATH=${briefPath}`);
            return 0;
        },
        spawnRemediatorFn: () => { /* no-op: gate stays red */ },
        stdout: () => {},
        stderr: () => {},
    });

    assert.equal(code, 2, 'should exit 2 after cap exhausted');
    assert.equal(gateCalls, 3, 'gate should run exactly 3 times (cap)');
    assert.equal(remediatorCalls, 3, 'remediator should run once per cycle');

    const files = fs.readdirSync(gateDir);
    assert.ok(
        files.some(f => f.startsWith('escalation_')),
        `escalation file missing. gate/ contents: ${files.join(', ')}`
    );

    const escalationFile = files.find(f => f.startsWith('escalation_'));
    const content = fs.readFileSync(path.join(gateDir, escalationFile), 'utf-8');
    assert.ok(content.includes('Cap Exhausted'), 'escalation file should mention cap exhausted');
    assert.ok(content.includes('szechuan'), 'escalation file should name the skill');
    assert.ok(content.includes('3'), 'escalation file should show cap');

    fs.rmSync(sessionRoot, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
});

test('anatomy-park cap=5: persistent failure → exit 2', async () => {
    const sessionRoot = makeTmpDir();
    const workingDir = makeTmpDir();
    const gateDir = path.join(sessionRoot, 'gate');
    fs.mkdirSync(gateDir, { recursive: true });

    const failure = {
        check: 'typecheck', file: path.join(workingDir, 'src/index.ts'),
        line: 1, ruleOrCode: 'TS2345', message: 'type error', severity: 'error', occurrence_index: 0,
    };

    let gateCalls = 0;

    const code = await finalizeGateMain({
        argv: [sessionRoot, 'anatomy-park'],
        env: {},
        readMicroverseStateFn: () => ({ status: 'iterating', allowed_paths: undefined }),
        readStateForWorkingDirFn: () => ({ workingDir, backend: 'claude' }),
        loadSettingsFn: () => ({ szechuan_max_remediation_cycles: 3, anatomy_park_max_remediation_cycles: 5, remediator_timeout_s: 60 }),
        mkdirSyncFn: (p) => fs.mkdirSync(p, { recursive: true }),
        writeFileFn: (p, data) => fs.writeFileSync(p, data, 'utf-8'),
        logActivityFn: () => {},
        isoFn: () => `2026-01-01T${String(gateCalls).padStart(2, '0')}-00-00Z`,
        runGateFn: async () => { gateCalls++; return makeRedResult([failure]); },
        spawnGateRemediatorMainFn: async (briefOpts) => {
            const briefPath = path.join(gateDir, `brief_${gateCalls}.md`);
            fs.writeFileSync(briefPath, '# Brief', 'utf-8');
            briefOpts.stdout?.(`BRIEF_PATH=${briefPath}`);
            return 0;
        },
        spawnRemediatorFn: () => {},
        stdout: () => {},
        stderr: () => {},
    });

    assert.equal(code, 2);
    assert.equal(gateCalls, 5, 'anatomy-park cap should be 5');

    fs.rmSync(sessionRoot, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
});

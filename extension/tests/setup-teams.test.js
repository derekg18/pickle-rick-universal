import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETUP = path.resolve(__dirname, '../bin/setup.js');
const REPO_ROOT = path.resolve(__dirname, '../..');

function runSetup(args, extraEnv = {}) {
    const output = execFileSync(process.execPath, [SETUP, ...args], {
        encoding: 'utf-8',
        env: { ...process.env, FORCE_COLOR: '0', ...extraEnv },
    });
    const match = output.match(/SESSION_ROOT=(.+)/);
    if (!match) throw new Error(`SESSION_ROOT not found in output:\n${output}`);
    return match[1].trim();
}

function runSetupExpectFail(args) {
    const result = spawnSync(process.execPath, [SETUP, ...args], {
        encoding: 'utf-8',
        env: { ...process.env, FORCE_COLOR: '0' },
    });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function cleanup(sessionPath) {
    try { fs.rmSync(sessionPath, { recursive: true, force: true }); } catch { /* ignore */ }
}

function makeCodexSmokeEnv() {
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-setup-teams-codex-bin-'));
    const shimPath = path.join(shimDir, 'codex');
    fs.writeFileSync(shimPath, '#!/bin/sh\necho "codex 0.42.1"\n');
    fs.chmodSync(shimPath, 0o755);
    return {
        env: { EXTENSION_DIR: REPO_ROOT, PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ''}` },
        cleanup: () => fs.rmSync(shimDir, { recursive: true, force: true }),
    };
}

test('setup --teams: writes teams_mode=true to state.json', () => {
    const sessionPath = runSetup(['--teams', '--task', 'teams-flag']);
    try {
        const state = JSON.parse(fs.readFileSync(path.join(sessionPath, 'state.json'), 'utf-8'));
        assert.equal(state.teams_mode, true);
    } finally { cleanup(sessionPath); }
});

test('setup --teams --max-parallel 7: persists max_parallel as 7', () => {
    const sessionPath = runSetup(['--teams', '--max-parallel', '7', '--task', 'mp-7']);
    try {
        const state = JSON.parse(fs.readFileSync(path.join(sessionPath, 'state.json'), 'utf-8'));
        assert.equal(state.teams_mode, true);
        assert.equal(state.max_parallel, 7);
    } finally { cleanup(sessionPath); }
});

test('setup --teams without --max-parallel: defaults max_parallel to 5', () => {
    const sessionPath = runSetup(['--teams', '--task', 'mp-default']);
    try {
        const state = JSON.parse(fs.readFileSync(path.join(sessionPath, 'state.json'), 'utf-8'));
        assert.equal(state.max_parallel, 5);
    } finally { cleanup(sessionPath); }
});

test('setup --teams --max-parallel 0: rejects with non-zero exit', () => {
    const r = runSetupExpectFail(['--teams', '--max-parallel', '0', '--task', 'mp-bad']);
    assert.notEqual(r.code, 0, 'expected non-zero exit');
    assert.match(r.stderr, /max-parallel/i);
});

test('setup --max-parallel without --teams: rejects with non-zero exit', () => {
    const r = runSetupExpectFail(['--max-parallel', '5', '--task', 'mp-orphan']);
    assert.notEqual(r.code, 0, 'expected non-zero exit');
    assert.match(r.stderr, /teams/i);
});

test('setup --teams --backend codex: rejects with non-zero exit', () => {
    const r = runSetupExpectFail(['--teams', '--backend', 'codex', '--task', 'codex-conflict']);
    assert.notEqual(r.code, 0, 'expected non-zero exit');
    assert.match(r.stderr, /codex|claude/i);
});

test('setup without --teams: teams_mode is falsy in state.json', () => {
    const sessionPath = runSetup(['--task', 'default-off']);
    try {
        const state = JSON.parse(fs.readFileSync(path.join(sessionPath, 'state.json'), 'utf-8'));
        assert.ok(!state.teams_mode, 'teams_mode should be undefined or false');
        assert.ok(!state.max_parallel, 'max_parallel should be undefined when teams_mode is off');
    } finally { cleanup(sessionPath); }
});

test('setup --teams --resume: preserves teams_mode and max_parallel', () => {
    const sessionPath = runSetup(['--teams', '--max-parallel', '8', '--task', 'resume-teams']);
    try {
        const statePath = path.join(sessionPath, 'state.json');
        let state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(state.teams_mode, true);
        assert.equal(state.max_parallel, 8);

        runSetup(['--resume', sessionPath]);
        state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(state.teams_mode, true, 'teams_mode should survive resume');
        assert.equal(state.max_parallel, 8, 'max_parallel should survive resume');
    } finally { cleanup(sessionPath); }
});

// Regression: P0-1 — codex/teams conflict must fire across resume in BOTH directions.

test('setup --resume + --teams against codex session: rejects, leaves state unchanged', () => {
    const codexEnv = makeCodexSmokeEnv();
    const sessionPath = runSetup(['--backend', 'codex', '--task', 'codex-base'], codexEnv.env);
    try {
        const statePath = path.join(sessionPath, 'state.json');
        const before = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(before.backend, 'codex');
        assert.ok(!before.teams_mode);

        const r = runSetupExpectFail(['--resume', sessionPath, '--teams']);
        assert.notEqual(r.code, 0, 'expected non-zero exit on codex+teams resume conflict');

        const after = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(after.backend, 'codex', 'backend should remain codex');
        assert.ok(!after.teams_mode, 'teams_mode must NOT be set on a codex session');
    } finally {
        codexEnv.cleanup();
        cleanup(sessionPath);
    }
});

test('setup --resume + --backend codex against teams session: rejects, leaves state unchanged', () => {
    const sessionPath = runSetup(['--teams', '--task', 'teams-base']);
    try {
        const statePath = path.join(sessionPath, 'state.json');
        const before = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(before.teams_mode, true);
        assert.ok(!before.backend || before.backend !== 'codex');

        const r = runSetupExpectFail(['--resume', sessionPath, '--backend', 'codex']);
        assert.notEqual(r.code, 0, 'expected non-zero exit on teams+codex resume conflict');

        const after = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(after.teams_mode, true, 'teams_mode must remain true');
        assert.notEqual(after.backend, 'codex', 'backend must NOT be set to codex on a teams session');
    } finally { cleanup(sessionPath); }
});

// Regression: P1-1 — --max-parallel must NOT silently consume the next flag when its value is missing.

test('setup --max-parallel at end of argv: rejects with clear error, no token swallow', () => {
    const r = runSetupExpectFail(['--teams', '--max-parallel']);
    assert.notEqual(r.code, 0, 'expected non-zero exit when value is missing at end of argv');
    assert.match(r.stderr, /max-parallel/i);
});

test('setup --max-parallel --teams (value missing, next token is a flag): rejects without swallowing --teams', () => {
    const r = runSetupExpectFail(['--max-parallel', '--teams']);
    assert.notEqual(r.code, 0, 'expected non-zero exit');
    // Must complain about max-parallel value, not about missing teams or some other downstream error.
    assert.match(r.stderr, /max-parallel/i);
});

test('setup --teams --max-parallel 5.5: rejects (integer required)', () => {
    const r = runSetupExpectFail(['--teams', '--max-parallel', '5.5']);
    assert.notEqual(r.code, 0, 'expected non-zero exit on fractional max-parallel');
});

test('setup --teams --max-parallel abc: rejects (NaN string)', () => {
    const r = runSetupExpectFail(['--teams', '--max-parallel', 'abc']);
    assert.notEqual(r.code, 0, 'expected non-zero exit on non-numeric max-parallel');
});

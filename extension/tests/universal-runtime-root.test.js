import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
    getCurrentSessionsMapPath,
    getDataRoot,
    getRuntimeRoot,
    getSessionsRoot,
} from '../services/pickle-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETUP = path.resolve(__dirname, '../bin/setup.js');
const GET_SESSION = path.resolve(__dirname, '../bin/get-session.js');

function withEnv(env, fn) {
    const saved = {};
    for (const key of Object.keys(env)) {
        saved[key] = process.env[key];
        if (env[key] === undefined) delete process.env[key];
        else process.env[key] = env[key];
    }
    try {
        return fn();
    } finally {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

function runNode(script, args, env, cwd) {
    const childEnv = { ...process.env, FORCE_COLOR: '0' };
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete childEnv[key];
        else childEnv[key] = value;
    }
    return execFileSync(process.execPath, [script, ...args], {
        cwd,
        encoding: 'utf-8',
        env: childEnv,
    });
}

test('runtime roots are host-specific while data/session roots stay shared by cwd', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-universal-runtime-'));
    const dataRoot = path.join(tmp, 'data');
    const cwd = path.join(tmp, 'repo');
    const claudeRuntime = path.join(tmp, 'claude-runtime');
    const codexRuntime = path.join(tmp, 'codex-runtime');
    const geminiRuntime = path.join(tmp, 'gemini-runtime');

    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(claudeRuntime, { recursive: true });
    fs.mkdirSync(codexRuntime, { recursive: true });
    fs.mkdirSync(geminiRuntime, { recursive: true });

    const baseEnv = {
        PICKLE_DATA_ROOT: dataRoot,
        PICKLE_DATA_DIR: undefined,
        PICKLE_EXTENSION_ROOT: undefined,
        PICKLE_RUNTIME_ROOT: undefined,
        PICKLE_RICK_ROOT: undefined,
        EXTENSION_DIR: undefined,
    };

    try {
        const setupOutput = runNode(SETUP, ['--task', 'universal runtime root'], {
            ...baseEnv,
            EXTENSION_DIR: claudeRuntime,
        }, cwd);
        const match = setupOutput.match(/SESSION_ROOT=(.+)/);
        assert.ok(match, `SESSION_ROOT not found in output:\n${setupOutput}`);
        const sessionRoot = match[1].trim();

        assert.equal(path.dirname(sessionRoot), path.join(dataRoot, 'sessions'));
        assert.equal(fs.existsSync(path.join(dataRoot, 'current_sessions.json')), true);

        for (const runtimeEnv of [
            { PICKLE_RICK_ROOT: codexRuntime },
            { PICKLE_RUNTIME_ROOT: geminiRuntime },
            { EXTENSION_DIR: claudeRuntime },
        ]) {
            const resolved = runNode(GET_SESSION, [], { ...baseEnv, ...runtimeEnv }, cwd).trim();
            assert.equal(resolved, sessionRoot);
        }

        withEnv({ ...baseEnv, PICKLE_RICK_ROOT: codexRuntime }, () => {
            assert.equal(getRuntimeRoot(), codexRuntime);
            assert.equal(getDataRoot(), dataRoot);
            assert.equal(getSessionsRoot(), path.join(dataRoot, 'sessions'));
            assert.equal(getCurrentSessionsMapPath(), path.join(dataRoot, 'current_sessions.json'));
        });
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

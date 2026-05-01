// Tests for classifyIterationExit timing param + timeout variant (ticket ff3a5ae3).
// Rate-limit still wins over timeout; existing completion early returns
// (inactive/error/success) still short-circuit before the timeout check.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { classifyIterationExit } from '../bin/mux-runner.js';

function writeLog(contents) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-ce-')));
    const logFile = path.join(dir, 'test.log');
    fs.writeFileSync(logFile, contents);
    return { dir, logFile };
}

test('classifyIterationExit::timing-param: didTimeout=true + clean log returns timeout variant', () => {
    const { dir, logFile } = writeLog('ordinary output, no rate limit\n');
    try {
        const result = classifyIterationExit('continue', logFile, {
            didTimeout: true,
            exitCode: null,
            wallSeconds: 42,
        });
        assert.equal(result.type, 'timeout');
        assert.equal(result.exitCode, null);
        assert.equal(result.wallSeconds, 42);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('classifyIterationExit: timeout variant threads exitCode integer', () => {
    const { dir, logFile } = writeLog('ordinary output\n');
    try {
        const result = classifyIterationExit('continue', logFile, {
            didTimeout: true,
            exitCode: 143,
            wallSeconds: 123.5,
        });
        assert.equal(result.type, 'timeout');
        assert.equal(result.exitCode, 143);
        assert.equal(result.wallSeconds, 123.5);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('classifyIterationExit: rate-limit beats timeout when both signals present', () => {
    const { dir, logFile } = writeLog(
        JSON.stringify({ type: 'rate_limit_event', status: 'rejected' }) + '\n'
    );
    try {
        const result = classifyIterationExit('continue', logFile, {
            didTimeout: true,
            exitCode: 143,
            wallSeconds: 42,
        });
        assert.equal(result.type, 'api_limit');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('classifyIterationExit: backward compatible — no timing arg still returns success for continue', () => {
    const { dir, logFile } = writeLog('no issues, clean log\n');
    try {
        const result = classifyIterationExit('continue', logFile);
        assert.equal(result.type, 'success');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('classifyIterationExit: timing with didTimeout=false does NOT return timeout', () => {
    const { dir, logFile } = writeLog('clean output\n');
    try {
        const result = classifyIterationExit('continue', logFile, {
            didTimeout: false,
            exitCode: 0,
            wallSeconds: 5,
        });
        assert.equal(result.type, 'success');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('classifyIterationExit: inactive completion short-circuits before timeout check', () => {
    const { dir, logFile } = writeLog('x\n');
    try {
        const result = classifyIterationExit('inactive', logFile, {
            didTimeout: true,
            exitCode: null,
            wallSeconds: 99,
        });
        assert.equal(result.type, 'inactive');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('classifyIterationExit: error completion short-circuits before timeout check', () => {
    const { dir, logFile } = writeLog('x\n');
    try {
        const result = classifyIterationExit('error', logFile, {
            didTimeout: true,
            exitCode: null,
            wallSeconds: 99,
        });
        assert.equal(result.type, 'error');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('classifyIterationExit: task_completed short-circuits before timeout check', () => {
    const { dir, logFile } = writeLog('x\n');
    try {
        const result = classifyIterationExit('task_completed', logFile, {
            didTimeout: true,
            exitCode: null,
            wallSeconds: 99,
        });
        assert.equal(result.type, 'success');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('classifyIterationExit: text-based rate limit still beats timeout', () => {
    const { dir, logFile } = writeLog("You're out of extra usage · resets Mar 6 at 11am\n");
    try {
        const result = classifyIterationExit('continue', logFile, {
            didTimeout: true,
            exitCode: null,
            wallSeconds: 12,
        });
        assert.equal(result.type, 'api_limit');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

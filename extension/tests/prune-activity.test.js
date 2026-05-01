import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { formatLocalDateKey } from '../services/pickle-utils.js';

// Import under test — getActivityDir reads EXTENSION_DIR at call time
import { pruneActivity } from '../services/activity-logger.js';

function withTempActivityDir(fn) {
    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-prune-'));
    const activityDir = path.join(extRoot, 'activity');
    fs.mkdirSync(activityDir, { recursive: true });
    const origEnv = process.env.EXTENSION_DIR;
    process.env.EXTENSION_DIR = extRoot;
    try {
        fn(activityDir, extRoot);
    } finally {
        process.env.EXTENSION_DIR = origEnv;
        if (origEnv === undefined) delete process.env.EXTENSION_DIR;
        fs.rmSync(extRoot, { recursive: true, force: true });
    }
}

function dateStr(daysAgo) {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    return formatLocalDateKey(d);
}

// --- pruneActivity function tests ---

test('pruneActivity: does nothing when activity dir does not exist', () => {
    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-prune-'));
    const origEnv = process.env.EXTENSION_DIR;
    process.env.EXTENSION_DIR = extRoot;
    try {
        // activity/ subdir does not exist
        const deleted = pruneActivity();
        assert.equal(deleted, 0);
    } finally {
        process.env.EXTENSION_DIR = origEnv;
        if (origEnv === undefined) delete process.env.EXTENSION_DIR;
        fs.rmSync(extRoot, { recursive: true, force: true });
    }
});

test('pruneActivity: deletes files older than 365 days', () => {
    withTempActivityDir((activityDir) => {
        const oldDate = dateStr(400);
        fs.writeFileSync(path.join(activityDir, `${oldDate}.jsonl`), '{"event":"test"}\n');
        const deleted = pruneActivity();
        assert.equal(deleted, 1);
        assert.equal(fs.existsSync(path.join(activityDir, `${oldDate}.jsonl`)), false);
    });
});

test('pruneActivity: preserves files within 365 days', () => {
    withTempActivityDir((activityDir) => {
        const recentDate = dateStr(100);
        const filepath = path.join(activityDir, `${recentDate}.jsonl`);
        fs.writeFileSync(filepath, '{"event":"test"}\n');
        const deleted = pruneActivity();
        assert.equal(deleted, 0);
        assert.ok(fs.existsSync(filepath));
    });
});

test('pruneActivity: preserves today\'s file', () => {
    withTempActivityDir((activityDir) => {
        const today = dateStr(0);
        const filepath = path.join(activityDir, `${today}.jsonl`);
        fs.writeFileSync(filepath, '{"event":"test"}\n');
        const deleted = pruneActivity();
        assert.equal(deleted, 0);
        assert.ok(fs.existsSync(filepath));
    });
});

test('pruneActivity: skips non-JSONL files', () => {
    withTempActivityDir((activityDir) => {
        const oldDate = dateStr(400);
        fs.writeFileSync(path.join(activityDir, `${oldDate}.txt`), 'not jsonl\n');
        const deleted = pruneActivity();
        assert.equal(deleted, 0);
        assert.ok(fs.existsSync(path.join(activityDir, `${oldDate}.txt`)));
    });
});

test('pruneActivity: skips JSONL files with non-date names', () => {
    withTempActivityDir((activityDir) => {
        fs.writeFileSync(path.join(activityDir, 'random-name.jsonl'), '{"event":"test"}\n');
        const deleted = pruneActivity();
        assert.equal(deleted, 0);
        assert.ok(fs.existsSync(path.join(activityDir, 'random-name.jsonl')));
    });
});

test('pruneActivity: handles ENOENT race gracefully', () => {
    withTempActivityDir((activityDir) => {
        const oldDate = dateStr(400);
        const filepath = path.join(activityDir, `${oldDate}.jsonl`);
        fs.writeFileSync(filepath, '{"event":"test"}\n');
        // Pre-delete to simulate race condition
        fs.unlinkSync(filepath);
        assert.doesNotThrow(() => pruneActivity());
    });
});

test('pruneActivity: custom maxAgeDays parameter works', () => {
    withTempActivityDir((activityDir) => {
        const date30 = dateStr(30);
        const date5 = dateStr(5);
        fs.writeFileSync(path.join(activityDir, `${date30}.jsonl`), '{"event":"old"}\n');
        fs.writeFileSync(path.join(activityDir, `${date5}.jsonl`), '{"event":"recent"}\n');
        const deleted = pruneActivity(20);
        assert.equal(deleted, 1);
        assert.equal(fs.existsSync(path.join(activityDir, `${date30}.jsonl`)), false);
        assert.ok(fs.existsSync(path.join(activityDir, `${date5}.jsonl`)));
    });
});

test('pruneActivity: returns correct count for multiple deletions', () => {
    withTempActivityDir((activityDir) => {
        const d1 = dateStr(400);
        const d2 = dateStr(500);
        const d3 = dateStr(50);
        fs.writeFileSync(path.join(activityDir, `${d1}.jsonl`), '{"event":"a"}\n');
        fs.writeFileSync(path.join(activityDir, `${d2}.jsonl`), '{"event":"b"}\n');
        fs.writeFileSync(path.join(activityDir, `${d3}.jsonl`), '{"event":"c"}\n');
        const deleted = pruneActivity();
        assert.equal(deleted, 2);
        assert.ok(fs.existsSync(path.join(activityDir, `${d3}.jsonl`)));
    });
});

test('pruneActivity: boundary — file exactly 365 days old is NOT deleted', () => {
    withTempActivityDir((activityDir) => {
        const boundary = dateStr(365);
        const filepath = path.join(activityDir, `${boundary}.jsonl`);
        fs.writeFileSync(filepath, '{"event":"boundary"}\n');
        const deleted = pruneActivity();
        assert.equal(deleted, 0);
        assert.ok(fs.existsSync(filepath));
    });
});

test('pruneActivity: handles large maxAgeDays across year boundaries', () => {
    withTempActivityDir((activityDir) => {
        // 800 days ago crosses multiple year boundaries — ms arithmetic handles this; setDate() was fragile
        const d = new Date();
        const targetMs = d.getTime() - 800 * 86_400_000;
        const target = new Date(targetMs);
        const dateStr = formatLocalDateKey(target);
        const filepath = path.join(activityDir, `${dateStr}.jsonl`);
        fs.writeFileSync(filepath, '{"event":"ancient"}\n');
        const deleted = pruneActivity(365);
        assert.equal(deleted, 1);
        assert.equal(fs.existsSync(filepath), false);
    });
});

test('pruneActivity: month boundary — file from prev month is correctly aged', () => {
    withTempActivityDir((activityDir) => {
        // Create file exactly 40 days ago (crosses month boundary for most months)
        const d = new Date();
        const targetMs = d.getTime() - 40 * 86_400_000;
        const target = new Date(targetMs);
        const dateStr = formatLocalDateKey(target);
        const filepath = path.join(activityDir, `${dateStr}.jsonl`);
        fs.writeFileSync(filepath, '{"event":"cross-month"}\n');
        // maxAge=30 should delete it, maxAge=50 should keep it
        assert.equal(pruneActivity(50), 0);
        assert.ok(fs.existsSync(filepath));
        assert.equal(pruneActivity(30), 1);
        assert.equal(fs.existsSync(filepath), false);
    });
});

test('pruneActivity: file 366 days old IS deleted', () => {
    withTempActivityDir((activityDir) => {
        const old = dateStr(366);
        const filepath = path.join(activityDir, `${old}.jsonl`);
        fs.writeFileSync(filepath, '{"event":"old"}\n');
        const deleted = pruneActivity();
        assert.equal(deleted, 1);
        assert.equal(fs.existsSync(filepath), false);
    });
});

// --- CLI guard ---

const CLI_PATH = path.join(import.meta.dirname, '..', 'bin', 'prune-activity.js');

test('CLI: runs standalone without error on empty activity dir', () => {
    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-prune-'));
    const activityDir = path.join(extRoot, 'activity');
    fs.mkdirSync(activityDir, { recursive: true });
    try {
        const result = spawnSync(process.execPath, [CLI_PATH], {
            encoding: 'utf-8',
            // 10s → 30s: budget for system load under concurrent test runs.
            timeout: 30000,
            env: { ...process.env, EXTENSION_DIR: extRoot },
        });
        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    } finally {
        fs.rmSync(extRoot, { recursive: true, force: true });
    }
});

test('CLI: reports pruned count', () => {
    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-prune-'));
    const activityDir = path.join(extRoot, 'activity');
    fs.mkdirSync(activityDir, { recursive: true });
    const oldDate = dateStr(400);
    fs.writeFileSync(path.join(activityDir, `${oldDate}.jsonl`), '{"event":"test"}\n');
    try {
        const result = spawnSync(process.execPath, [CLI_PATH], {
            encoding: 'utf-8',
            // 10s → 30s: budget for system load under concurrent test runs.
            timeout: 30000,
            env: { ...process.env, EXTENSION_DIR: extRoot },
        });
        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
        assert.match(result.stdout, /Pruned 1 old activity file\./);
    } finally {
        fs.rmSync(extRoot, { recursive: true, force: true });
    }
});

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
    parseVersion,
    compareSemver,
    readCache,
    writeCache,
    readSettings,
    isCacheStale,
    checkForUpdate,
    getLatestRelease,
    downloadRelease,
    extractAndInstall,
    performUpgrade,
} from '../bin/check-update.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STOP_HOOK = path.resolve(__dirname, '../hooks/handlers/stop-hook.js');
const CHECK_UPDATE = path.resolve(__dirname, '../bin/check-update.js');

function makeTmpDir() {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'check-update-test-')));
}

// ---------------------------------------------------------------------------
// parseVersion
// ---------------------------------------------------------------------------

describe('parseVersion', () => {
    test('strips v prefix', () => {
        assert.equal(parseVersion('v1.2.3'), '1.2.3');
    });

    test('accepts bare semver', () => {
        assert.equal(parseVersion('1.2.3'), '1.2.3');
    });

    test('rejects non-semver', () => {
        assert.equal(parseVersion('1.2'), null);
        assert.equal(parseVersion('abc'), null);
        assert.equal(parseVersion('v1.2.3-beta'), null);
    });

    test('rejects empty/null-ish', () => {
        assert.equal(parseVersion(''), null);
    });
});

// ---------------------------------------------------------------------------
// compareSemver
// ---------------------------------------------------------------------------

describe('compareSemver', () => {
    test('equal versions', () => {
        assert.equal(compareSemver('1.2.3', '1.2.3'), 0);
    });

    test('a < b (patch)', () => {
        assert.equal(compareSemver('1.2.3', '1.2.4'), -1);
    });

    test('a > b (minor)', () => {
        assert.equal(compareSemver('1.3.0', '1.2.9'), 1);
    });

    test('a < b (major)', () => {
        assert.equal(compareSemver('1.9.9', '2.0.0'), -1);
    });

    test('multi-digit versions', () => {
        assert.equal(compareSemver('1.10.0', '1.9.0'), 1);
    });
});

// ---------------------------------------------------------------------------
// readCache / writeCache
// ---------------------------------------------------------------------------

describe('readCache', () => {
    let tmpDir;
    let origEnv;

    beforeEach(() => {
        tmpDir = makeTmpDir();
        origEnv = process.env.EXTENSION_DIR;
        process.env.EXTENSION_DIR = tmpDir;
    });

    afterEach(() => {
        if (origEnv === undefined) delete process.env.EXTENSION_DIR;
        else process.env.EXTENSION_DIR = origEnv;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('returns defaults when file missing', () => {
        const cache = readCache();
        assert.equal(cache.last_check_epoch, 0);
        assert.equal(cache.latest_version, '');
        assert.equal(cache.current_version, '');
    });

    test('returns defaults when file corrupted', () => {
        fs.writeFileSync(path.join(tmpDir, 'update-check.json'), '{broken');
        const cache = readCache();
        assert.equal(cache.last_check_epoch, 0);
    });

    test('round-trips correctly', () => {
        const data = { last_check_epoch: 1000, latest_version: '2.0.0', current_version: '1.0.0' };
        writeCache(data);
        const result = readCache();
        assert.deepEqual(result, data);
    });

    test('checkForUpdate ignores malformed fresh cached versions and fetches release', () => {
        fs.mkdirSync(path.join(tmpDir, 'extension'), { recursive: true });
        fs.writeFileSync(
            path.join(tmpDir, 'extension', 'package.json'),
            JSON.stringify({ version: '1.7.0' }),
        );
        fs.writeFileSync(path.join(tmpDir, 'update-check.json'), JSON.stringify({
            last_check_epoch: Math.floor(Date.now() / 1000),
            latest_version: 'not-a-version',
            current_version: '1.7.0',
        }));

        const binDir = path.join(tmpDir, 'mock-bin');
        const callsPath = path.join(tmpDir, 'gh-calls.txt');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(
            path.join(binDir, 'gh'),
            `#!/bin/sh\necho called >> ${JSON.stringify(callsPath)}\nif [ "$1" = "api" ]; then echo '{"tag_name":"v2.0.0","assets":[]}'; exit 0; fi\nexit 1\n`,
            { mode: 0o755 },
        );
        const origPath = process.env.PATH;
        process.env.PATH = `${binDir}:${origPath}`;
        try {
            const result = checkForUpdate();
            assert.equal(result.status, 'update-available');
            assert.equal(result.latestVersion, '2.0.0');
            assert.match(fs.readFileSync(callsPath, 'utf-8'), /^called/m);
        } finally {
            process.env.PATH = origPath;
        }
    });

    test('checkForUpdate uses recovered newer cache tmp instead of refetching release', () => {
        fs.mkdirSync(path.join(tmpDir, 'extension'), { recursive: true });
        fs.writeFileSync(
            path.join(tmpDir, 'extension', 'package.json'),
            JSON.stringify({ version: '1.7.0' }),
        );
        const cachePath = path.join(tmpDir, 'update-check.json');
        fs.writeFileSync(cachePath, JSON.stringify({
            last_check_epoch: 0,
            latest_version: '1.7.0',
            current_version: '1.7.0',
        }));
        const tmpPath = `${cachePath}.tmp.99999999`;
        const now = Math.floor(Date.now() / 1000);
        fs.writeFileSync(tmpPath, JSON.stringify({
            last_check_epoch: now,
            latest_version: '2.0.0',
            current_version: '1.7.0',
        }));
        const oldTime = new Date(Date.now() - 10_000);
        const newTime = new Date();
        fs.utimesSync(cachePath, oldTime, oldTime);
        fs.utimesSync(tmpPath, newTime, newTime);

        const binDir = path.join(tmpDir, 'mock-bin');
        const callsPath = path.join(tmpDir, 'gh-calls.txt');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(
            path.join(binDir, 'gh'),
            `#!/bin/sh\necho called >> ${JSON.stringify(callsPath)}\nexit 99\n`,
            { mode: 0o755 },
        );
        const origPath = process.env.PATH;
        process.env.PATH = `${binDir}:${origPath}`;
        try {
            const result = checkForUpdate();
            assert.equal(result.status, 'update-available');
            assert.equal(result.latestVersion, '2.0.0');
            assert.equal(fs.existsSync(callsPath), false, 'fresh recovered cache should skip gh api');
            assert.equal(fs.existsSync(tmpPath), false, 'recovered tmp should be promoted');
            assert.equal(JSON.parse(fs.readFileSync(cachePath, 'utf-8')).latest_version, '2.0.0');
        } finally {
            process.env.PATH = origPath;
        }
    });
});

// ---------------------------------------------------------------------------
// readSettings
// ---------------------------------------------------------------------------

describe('readSettings', () => {
    let tmpDir;
    let origEnv;

    beforeEach(() => {
        tmpDir = makeTmpDir();
        origEnv = process.env.EXTENSION_DIR;
        process.env.EXTENSION_DIR = tmpDir;
    });

    afterEach(() => {
        if (origEnv === undefined) delete process.env.EXTENSION_DIR;
        else process.env.EXTENSION_DIR = origEnv;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('returns defaults when file missing', () => {
        const settings = readSettings();
        assert.equal(settings.auto_update_enabled, true);
        assert.equal(settings.update_check_interval_hours, 24);
    });

    test('respects overrides', () => {
        fs.writeFileSync(
            path.join(tmpDir, 'pickle_settings.json'),
            JSON.stringify({ auto_update_enabled: false, update_check_interval_hours: 12 }),
        );
        const settings = readSettings();
        assert.equal(settings.auto_update_enabled, false);
        assert.equal(settings.update_check_interval_hours, 12);
    });

    test('returns defaults on corrupt file', () => {
        fs.writeFileSync(path.join(tmpDir, 'pickle_settings.json'), 'not json');
        const settings = readSettings();
        assert.equal(settings.auto_update_enabled, true);
        assert.equal(settings.update_check_interval_hours, 24);
    });

    test('checkForUpdate uses recovered newer settings tmp before auto-update decision', () => {
        fs.mkdirSync(path.join(tmpDir, 'extension'), { recursive: true });
        fs.writeFileSync(
            path.join(tmpDir, 'extension', 'package.json'),
            JSON.stringify({ version: '1.7.0' }),
        );
        const settingsPath = path.join(tmpDir, 'pickle_settings.json');
        fs.writeFileSync(settingsPath, JSON.stringify({ auto_update_enabled: true }));
        const tmpPath = `${settingsPath}.tmp.99999999`;
        fs.writeFileSync(tmpPath, JSON.stringify({
            auto_update_enabled: false,
            update_check_interval_hours: 12,
        }));
        const oldTime = new Date(Date.now() - 10_000);
        const newTime = new Date();
        fs.utimesSync(settingsPath, oldTime, oldTime);
        fs.utimesSync(tmpPath, newTime, newTime);

        const binDir = path.join(tmpDir, 'mock-bin');
        const callsPath = path.join(tmpDir, 'gh-calls.txt');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(
            path.join(binDir, 'gh'),
            `#!/bin/sh\necho called >> ${JSON.stringify(callsPath)}\nexit 99\n`,
            { mode: 0o755 },
        );
        const origPath = process.env.PATH;
        process.env.PATH = `${binDir}:${origPath}`;
        try {
            const result = checkForUpdate();
            assert.equal(result.status, 'up-to-date');
            assert.equal(result.currentVersion, '1.7.0');
            assert.equal(fs.existsSync(callsPath), false, 'recovered disabled settings should skip gh api');
            assert.equal(fs.existsSync(tmpPath), false, 'recovered settings tmp should be promoted');
            assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf-8')).auto_update_enabled, false);
        } finally {
            process.env.PATH = origPath;
        }
    });

    test('ignores invalid interval', () => {
        fs.writeFileSync(
            path.join(tmpDir, 'pickle_settings.json'),
            JSON.stringify({ update_check_interval_hours: -5 }),
        );
        const settings = readSettings();
        assert.equal(settings.update_check_interval_hours, 24);
    });

    test('checkForUpdate defaults non-finite interval so stale cache still fetches release', () => {
        fs.mkdirSync(path.join(tmpDir, 'extension'), { recursive: true });
        fs.writeFileSync(
            path.join(tmpDir, 'extension', 'package.json'),
            JSON.stringify({ version: '1.7.0' }),
        );
        fs.writeFileSync(
            path.join(tmpDir, 'pickle_settings.json'),
            '{"update_check_interval_hours":1e309}',
        );
        writeCache({
            last_check_epoch: Math.floor(Date.now() / 1000) - 48 * 3600,
            latest_version: '1.7.0',
            current_version: '1.7.0',
        });

        const binDir = path.join(tmpDir, 'mock-bin');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(
            path.join(binDir, 'gh'),
            '#!/bin/sh\nif [ "$1" = "api" ]; then echo \'{"tag_name":"v2.0.0","assets":[]}\'; exit 0; fi\nexit 1\n',
            { mode: 0o755 },
        );
        const origPath = process.env.PATH;
        process.env.PATH = `${binDir}:${origPath}`;
        try {
            const result = checkForUpdate();
            assert.equal(result.status, 'update-available');
            assert.equal(result.latestVersion, '2.0.0');
        } finally {
            process.env.PATH = origPath;
        }
    });
});

// ---------------------------------------------------------------------------
// isCacheStale
// ---------------------------------------------------------------------------

describe('isCacheStale', () => {
    test('zero epoch is stale', () => {
        assert.equal(isCacheStale({ last_check_epoch: 0, latest_version: '', current_version: '' }, 24), true);
    });

    test('old cache is stale', () => {
        const twoDaysAgo = Math.floor(Date.now() / 1000) - 48 * 3600;
        assert.equal(isCacheStale({ last_check_epoch: twoDaysAgo, latest_version: '', current_version: '' }, 24), true);
    });

    test('recent cache is fresh', () => {
        const fiveMinAgo = Math.floor(Date.now() / 1000) - 300;
        assert.equal(isCacheStale({ last_check_epoch: fiveMinAgo, latest_version: '', current_version: '' }, 24), false);
    });

    test('future-dated cache is stale', () => {
        const future = Math.floor(Date.now() / 1000) + 48 * 3600;
        assert.equal(isCacheStale({ last_check_epoch: future, latest_version: '', current_version: '' }, 24), true);
    });
});

// ---------------------------------------------------------------------------
// checkForUpdate (integration-ish, using EXTENSION_DIR override)
// ---------------------------------------------------------------------------

describe('checkForUpdate', () => {
    let tmpDir;
    let origEnv;

    beforeEach(() => {
        tmpDir = makeTmpDir();
        origEnv = process.env.EXTENSION_DIR;
        process.env.EXTENSION_DIR = tmpDir;
        // Create a fake package.json so getCurrentVersion works
        fs.mkdirSync(path.join(tmpDir, 'extension'), { recursive: true });
        fs.writeFileSync(
            path.join(tmpDir, 'extension', 'package.json'),
            JSON.stringify({ version: '1.7.0' }),
        );
    });

    afterEach(() => {
        if (origEnv === undefined) delete process.env.EXTENSION_DIR;
        else process.env.EXTENSION_DIR = origEnv;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('returns up-to-date when auto_update disabled', () => {
        fs.writeFileSync(
            path.join(tmpDir, 'pickle_settings.json'),
            JSON.stringify({ auto_update_enabled: false }),
        );
        const result = checkForUpdate();
        assert.equal(result.status, 'up-to-date');
        assert.equal(result.currentVersion, '1.7.0');
    });

    test('uses cached result when fresh', () => {
        const now = Math.floor(Date.now() / 1000);
        writeCache({ last_check_epoch: now, latest_version: '2.0.0', current_version: '1.7.0' });
        const result = checkForUpdate();
        assert.equal(result.status, 'update-available');
        assert.equal(result.latestVersion, '2.0.0');
    });

    test('uses cached result showing up-to-date', () => {
        const now = Math.floor(Date.now() / 1000);
        writeCache({ last_check_epoch: now, latest_version: '1.7.0', current_version: '1.7.0' });
        const result = checkForUpdate();
        assert.equal(result.status, 'up-to-date');
    });

    test('future-dated cache does not suppress release discovery', () => {
        const binDir = path.join(tmpDir, 'mock-bin');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(
            path.join(binDir, 'gh'),
            '#!/bin/sh\nif [ "$1" = "api" ]; then echo \'{"tag_name":"v2.0.0","assets":[]}\'; exit 0; fi\nexit 1\n',
            { mode: 0o755 },
        );
        const origPath = process.env.PATH;
        process.env.PATH = `${binDir}:${origPath}`;
        try {
            const future = Math.floor(Date.now() / 1000) + 48 * 3600;
            writeCache({ last_check_epoch: future, latest_version: '1.7.0', current_version: '1.7.0' });
            const result = checkForUpdate();
            assert.equal(result.status, 'update-available');
            assert.equal(result.latestVersion, '2.0.0');
        } finally {
            process.env.PATH = origPath;
        }
    });

    test('force bypasses disabled setting', () => {
        fs.writeFileSync(
            path.join(tmpDir, 'pickle_settings.json'),
            JSON.stringify({ auto_update_enabled: false }),
        );
        // Force will try to call gh api which may fail, but should not crash
        const result = checkForUpdate({ force: true });
        // Either error (no gh/no network) or a valid result — never throws
        assert.ok(['up-to-date', 'update-available', 'error'].includes(result.status));
    });

    test('returns error status on API failure, never throws', () => {
        // Stale cache forces API call — may succeed or fail depending on env
        const result = checkForUpdate();
        assert.ok(['up-to-date', 'update-available', 'error'].includes(result.status));
        assert.ok(typeof result.currentVersion === 'string', 'currentVersion should be a string');
    });
});

// ---------------------------------------------------------------------------
// downloadRelease
// ---------------------------------------------------------------------------

describe('downloadRelease', () => {
    let tmpDir;
    let origEnv;

    beforeEach(() => {
        tmpDir = makeTmpDir();
        origEnv = process.env.EXTENSION_DIR;
        process.env.EXTENSION_DIR = tmpDir;
    });

    afterEach(() => {
        if (origEnv === undefined) delete process.env.EXTENSION_DIR;
        else process.env.EXTENSION_DIR = origEnv;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('returns null on invalid tag, never throws', () => {
        const result = downloadRelease('v999.999.999-nonexistent');
        assert.equal(result, null);
    });

    test('returns string path on valid release', () => {
        // Empty tag downloads latest release — gh treats it as "latest"
        // This validates the happy path when gh is available
        const result = downloadRelease('');
        if (result !== null) {
            assert.ok(result.endsWith('.tar.gz'));
            // Clean up downloaded file
            try { fs.rmSync(path.dirname(result), { recursive: true, force: true }); } catch { /* */ }
        }
    });
});

// ---------------------------------------------------------------------------
// extractAndInstall
// ---------------------------------------------------------------------------

describe('extractAndInstall', () => {
    let tmpDir;
    let origEnv;

    beforeEach(() => {
        tmpDir = makeTmpDir();
        origEnv = process.env.EXTENSION_DIR;
        process.env.EXTENSION_DIR = tmpDir;
    });

    afterEach(() => {
        if (origEnv === undefined) delete process.env.EXTENSION_DIR;
        else process.env.EXTENSION_DIR = origEnv;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('returns error for nonexistent tarball', () => {
        const result = extractAndInstall('/tmp/nonexistent-pickle-fakefile.tar.gz');
        assert.equal(result.success, false);
        assert.ok(result.error);
    });

    test('returns error for invalid tarball', () => {
        const fakeTarball = path.join(tmpDir, 'fake.tar.gz');
        fs.writeFileSync(fakeTarball, 'not a real tarball');
        const result = extractAndInstall(fakeTarball);
        assert.equal(result.success, false);
    });
});

// ---------------------------------------------------------------------------
// performUpgrade
// ---------------------------------------------------------------------------

describe('performUpgrade', () => {
    let tmpDir;
    let origEnv;

    beforeEach(() => {
        tmpDir = makeTmpDir();
        origEnv = process.env.EXTENSION_DIR;
        process.env.EXTENSION_DIR = tmpDir;
    });

    afterEach(() => {
        if (origEnv === undefined) delete process.env.EXTENSION_DIR;
        else process.env.EXTENSION_DIR = origEnv;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('fails gracefully when download fails', () => {
        const result = performUpgrade('1.0.0', '999.0.0', 'v999.0.0');
        assert.equal(result.success, false);
        assert.ok(result.error);
    });

    test('never throws', () => {
        assert.doesNotThrow(() => {
            performUpgrade('1.0.0', '999.0.0', 'v999.0.0');
        });
    });

    test('refuses upgrade when auto_update_enabled=false and does not download', () => {
        fs.writeFileSync(
            path.join(tmpDir, 'pickle_settings.json'),
            JSON.stringify({ auto_update_enabled: false }),
        );
        // Mock gh that records every call — we expect zero calls.
        const binDir = path.join(tmpDir, 'mock-bin');
        const callsPath = path.join(tmpDir, 'gh-calls.txt');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(
            path.join(binDir, 'gh'),
            `#!/bin/sh\necho called >> ${JSON.stringify(callsPath)}\nexit 0\n`,
            { mode: 0o755 },
        );
        const origPath = process.env.PATH;
        process.env.PATH = `${binDir}:${origPath}`;
        try {
            const result = performUpgrade('1.0.0', '2.0.0', 'v2.0.0');
            assert.equal(result.success, false);
            assert.match(result.error, /disabled/i);
            assert.equal(fs.existsSync(callsPath), false, 'must not invoke gh when kill-switch is on');
        } finally {
            process.env.PATH = origPath;
        }
    });

    test('proceeds past kill-switch when auto_update_enabled=true (download mocked)', () => {
        fs.writeFileSync(
            path.join(tmpDir, 'pickle_settings.json'),
            JSON.stringify({ auto_update_enabled: true }),
        );
        // Mock gh release download to fail cleanly so we don't hit the network.
        // The kill-switch must NOT short-circuit this — failure must come from download path.
        const binDir = path.join(tmpDir, 'mock-bin');
        const callsPath = path.join(tmpDir, 'gh-calls.txt');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(
            path.join(binDir, 'gh'),
            `#!/bin/sh\necho called >> ${JSON.stringify(callsPath)}\nexit 1\n`,
            { mode: 0o755 },
        );
        const origPath = process.env.PATH;
        process.env.PATH = `${binDir}:${origPath}`;
        try {
            const result = performUpgrade('1.0.0', '2.0.0', 'v2.0.0');
            assert.equal(result.success, false);
            // Must be the download error, not the kill-switch error.
            assert.match(result.error, /download/i);
            assert.ok(fs.existsSync(callsPath), 'gh must be invoked when kill-switch is off');
        } finally {
            process.env.PATH = origPath;
        }
    });

    test('force option overrides kill-switch and proceeds to download', () => {
        fs.writeFileSync(
            path.join(tmpDir, 'pickle_settings.json'),
            JSON.stringify({ auto_update_enabled: false }),
        );
        const binDir = path.join(tmpDir, 'mock-bin');
        const callsPath = path.join(tmpDir, 'gh-calls.txt');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(
            path.join(binDir, 'gh'),
            `#!/bin/sh\necho called >> ${JSON.stringify(callsPath)}\nexit 1\n`,
            { mode: 0o755 },
        );
        const origPath = process.env.PATH;
        process.env.PATH = `${binDir}:${origPath}`;
        try {
            const result = performUpgrade('1.0.0', '2.0.0', 'v2.0.0', { force: true });
            assert.equal(result.success, false);
            // Failure must be from download path, not kill-switch.
            assert.match(result.error, /download/i);
            assert.ok(fs.existsSync(callsPath), '--force must bypass kill-switch and call gh');
        } finally {
            process.env.PATH = origPath;
        }
    });
});

// ---------------------------------------------------------------------------
// getLatestRelease
// ---------------------------------------------------------------------------

describe('getLatestRelease', () => {
    test('returns null or valid ReleaseInfo, never throws', () => {
        const result = getLatestRelease();
        if (result !== null) {
            assert.ok(typeof result.tagName === 'string');
            assert.ok(Array.isArray(result.assets));
        }
    });
});

// ---------------------------------------------------------------------------
// Logging — debug.log gets [check-update] prefixed lines
// ---------------------------------------------------------------------------

describe('logging', () => {
    let tmpDir;
    let origEnv;

    beforeEach(() => {
        tmpDir = makeTmpDir();
        origEnv = process.env.EXTENSION_DIR;
        process.env.EXTENSION_DIR = tmpDir;
    });

    afterEach(() => {
        if (origEnv === undefined) delete process.env.EXTENSION_DIR;
        else process.env.EXTENSION_DIR = origEnv;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('writeCache produces [check-update] log entry in debug.log', () => {
        writeCache({ last_check_epoch: 1000, latest_version: '2.0.0', current_version: '1.0.0' });
        const logFile = path.join(tmpDir, 'debug.log');
        assert.ok(fs.existsSync(logFile), 'debug.log should exist');
        const content = fs.readFileSync(logFile, 'utf-8');
        assert.ok(content.includes('[check-update]'), 'debug.log should contain [check-update] prefix');
        assert.ok(content.includes('Cache written'), 'debug.log should mention cache write');
    });

    test('readCache on missing file produces log entry', () => {
        readCache();
        const logFile = path.join(tmpDir, 'debug.log');
        assert.ok(fs.existsSync(logFile), 'debug.log should exist');
        const content = fs.readFileSync(logFile, 'utf-8');
        assert.ok(content.includes('[check-update]'));
        assert.ok(content.includes('Cache missing or corrupted'));
    });

    test('log entries include ISO timestamp', () => {
        writeCache({ last_check_epoch: 1, latest_version: '1.0.0', current_version: '1.0.0' });
        const content = fs.readFileSync(path.join(tmpDir, 'debug.log'), 'utf-8');
        assert.match(content, /\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
});

// ---------------------------------------------------------------------------
// Detached spawn — stop-hook spawns check-update.js with detached: true
// ---------------------------------------------------------------------------

describe('detached spawn (stop-hook)', () => {
    function makeMaxIterState(overrides = {}) {
        return {
            active: true,
            working_dir: process.cwd(),
            step: 'implement',
            iteration: 3,
            max_iterations: 3,
            max_time_minutes: 60,
            worker_timeout_seconds: 1200,
            start_time_epoch: Math.floor(Date.now() / 1000) - 30,
            completion_promise: null,
            original_prompt: 'test',
            current_ticket: null,
            history: [],
            started_at: new Date().toISOString(),
            session_dir: '/tmp/test',
            tmux_mode: false,
            ...overrides,
        };
    }

    function runStopHook(opts = {}) {
        const { state = makeMaxIterState(), response = 'short', createCheckUpdate = true, extraFiles = {} } = opts;
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-test-'));
        const sessionDir = path.join(tmpDir, 'session');
        fs.mkdirSync(sessionDir);
        const stateFile = path.join(sessionDir, 'state.json');
        fs.writeFileSync(stateFile, JSON.stringify(state));
        fs.writeFileSync(
            path.join(tmpDir, 'current_sessions.json'),
            JSON.stringify({ [process.cwd()]: sessionDir }),
        );
        if (createCheckUpdate) {
            fs.mkdirSync(path.join(tmpDir, 'extension', 'bin'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'extension', 'bin', 'check-update.js'), '// noop');
        }
        for (const [relPath, content] of Object.entries(extraFiles)) {
            const full = path.join(tmpDir, relPath);
            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, content);
        }

        const env = { ...process.env, EXTENSION_DIR: tmpDir, FORCE_COLOR: '0' };
        delete env.PICKLE_ROLE;
        delete env.PICKLE_STATE_FILE;
        env.PICKLE_STATE_FILE = stateFile;

        try {
            execFileSync(process.execPath, [STOP_HOOK], {
                input: JSON.stringify({ last_assistant_message: response }),
                encoding: 'utf-8',
                env,
            });
            const debugLog = path.join(tmpDir, 'debug.log');
            return fs.existsSync(debugLog) ? fs.readFileSync(debugLog, 'utf-8') : '';
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    }

    test('spawns detached check-update on task completion', () => {
        const log = runStopHook({
            state: makeMaxIterState({ iteration: 1, max_iterations: 100 }),
            response: 'All done! <promise>TASK_COMPLETED</promise>',
        });
        assert.ok(log.includes('Spawning detached check-update process'),
            'stop-hook should log detached spawn on task completion');
    });

    test('does NOT spawn on max iterations (only on completion)', () => {
        const log = runStopHook({
            response: 'Some work output that is long enough to not be degenerate response detection threshold',
        });
        assert.ok(!log.includes('Spawning detached'),
            'stop-hook should NOT spawn update check on max iterations');
    });

    test('skips spawn when check-update.js is missing', () => {
        const log = runStopHook({
            state: makeMaxIterState({ iteration: 1, max_iterations: 100 }),
            response: 'All done! <promise>TASK_COMPLETED</promise>',
            createCheckUpdate: false,
        });
        assert.ok(log.includes('check-update.js not found'),
            'should log that check-update.js was not found');
        assert.ok(!log.includes('Spawning detached'),
            'should NOT spawn when file missing');
    });

    test('skips spawn when auto_update disabled', () => {
        const log = runStopHook({
            state: makeMaxIterState({ iteration: 1, max_iterations: 100 }),
            response: 'All done! <promise>TASK_COMPLETED</promise>',
            extraFiles: { 'pickle_settings.json': JSON.stringify({ auto_update_enabled: false }) },
        });
        assert.ok(log.includes('Auto-update disabled'),
            'should log auto-update disabled');
        assert.ok(!log.includes('Spawning detached'),
            'should NOT spawn when auto-update disabled');
    });
});

// ---------------------------------------------------------------------------
// Integration — end-to-end with mock gh
// ---------------------------------------------------------------------------

describe('integration with mock gh', () => {
    let tmpDir;
    let origEnv;
    let origPath;

    beforeEach(() => {
        tmpDir = makeTmpDir();
        origEnv = process.env.EXTENSION_DIR;
        origPath = process.env.PATH;
        process.env.EXTENSION_DIR = tmpDir;
        fs.mkdirSync(path.join(tmpDir, 'extension'), { recursive: true });
        fs.writeFileSync(
            path.join(tmpDir, 'extension', 'package.json'),
            JSON.stringify({ version: '1.7.0' }),
        );
    });

    afterEach(() => {
        if (origEnv === undefined) delete process.env.EXTENSION_DIR;
        else process.env.EXTENSION_DIR = origEnv;
        process.env.PATH = origPath;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeMockGh(responseJson) {
        const binDir = path.join(tmpDir, 'mock-bin');
        fs.mkdirSync(binDir, { recursive: true });
        const script = `#!/bin/sh\necho '${JSON.stringify(responseJson).replace(/'/g, "'\\''")}'`;
        fs.writeFileSync(path.join(binDir, 'gh'), script, { mode: 0o755 });
        process.env.PATH = `${binDir}:${origPath}`;
    }

    test('detects newer version from mock gh, updates cache', () => {
        writeMockGh({
            tag_name: 'v2.0.0',
            assets: [{ name: 'pickle-rick-claude-v2.0.0.tar.gz', url: 'https://example.com/fake.tar.gz' }],
        });
        const result = checkForUpdate({ force: true });
        // gh api returns valid JSON, so getLatestRelease succeeds
        // performUpgrade will fail at download step (mock gh doesn't do release download properly)
        // but cache should be updated with the new version
        assert.ok(['update-available', 'up-to-date'].includes(result.status));
        const cache = readCache();
        assert.equal(cache.latest_version, '2.0.0');
        assert.equal(cache.current_version, '1.7.0');
    });

    test('handles unexpected tag format from gh', () => {
        writeMockGh({
            tag_name: 'release-candidate-1',
            assets: [],
        });
        const result = checkForUpdate({ force: true });
        assert.equal(result.status, 'error');
        assert.ok(result.error.includes('Invalid release tag'));
    });

    test('handles gh returning invalid JSON', () => {
        const binDir = path.join(tmpDir, 'mock-bin');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(path.join(binDir, 'gh'), '#!/bin/sh\necho "not json at all"', { mode: 0o755 });
        process.env.PATH = `${binDir}:${origPath}`;
        const result = checkForUpdate({ force: true });
        assert.equal(result.status, 'error');
    });

    test('handles gh returning non-zero exit code', () => {
        const binDir = path.join(tmpDir, 'mock-bin');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(path.join(binDir, 'gh'), '#!/bin/sh\nexit 1', { mode: 0o755 });
        process.env.PATH = `${binDir}:${origPath}`;
        const result = checkForUpdate({ force: true });
        assert.equal(result.status, 'error');
    });

    test('process exit code is always 0 when run as subprocess', () => {
        const binDir = path.join(tmpDir, 'mock-bin');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(path.join(binDir, 'gh'), '#!/bin/sh\nexit 1', { mode: 0o755 });

        const env = { ...process.env, EXTENSION_DIR: tmpDir, PATH: `${binDir}:${origPath}` };
        // Run check-update.js as subprocess — should always exit 0 (no --upgrade flag)
        const result = execFileSync(process.execPath, [CHECK_UPDATE], {
            encoding: 'utf-8',
            env,
        });
        const parsed = JSON.parse(result.trim());
        assert.ok(['up-to-date', 'update-available', 'error'].includes(parsed.status));
    });
});

// ---------------------------------------------------------------------------
// Edge cases — extractAndInstall with missing install.sh, tarball edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
    let tmpDir;
    let origEnv;

    beforeEach(() => {
        tmpDir = makeTmpDir();
        origEnv = process.env.EXTENSION_DIR;
        process.env.EXTENSION_DIR = tmpDir;
    });

    afterEach(() => {
        if (origEnv === undefined) delete process.env.EXTENSION_DIR;
        else process.env.EXTENSION_DIR = origEnv;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('extractAndInstall fails when tarball has no install.sh', () => {
        const contentDir = path.join(tmpDir, 'content');
        fs.mkdirSync(contentDir);
        fs.writeFileSync(path.join(contentDir, 'README.md'), '# No install script here');
        const tarball = path.join(tmpDir, 'test-release.tar.gz');
        execFileSync('tar', ['czf', tarball, '-C', tmpDir, 'content']);
        const result = extractAndInstall(tarball);
        assert.equal(result.success, false);
        assert.ok(result.error.includes('install.sh'));
    });

    test('extractAndInstall fails when install.sh exits non-zero', () => {
        const contentDir = path.join(tmpDir, 'content');
        fs.mkdirSync(contentDir);
        fs.writeFileSync(path.join(contentDir, 'install.sh'), '#!/bin/sh\nexit 1', { mode: 0o755 });
        const tarball = path.join(tmpDir, 'test-release.tar.gz');
        execFileSync('tar', ['czf', tarball, '-C', tmpDir, 'content']);
        const result = extractAndInstall(tarball);
        assert.equal(result.success, false);
        assert.ok(result.error.includes('install.sh failed'));
    });

    test('compareSemver handles 0.0.0', () => {
        assert.equal(compareSemver('0.0.0', '0.0.1'), -1);
        assert.equal(compareSemver('0.0.0', '0.0.0'), 0);
    });

    test('parseVersion rejects pre-release suffixes', () => {
        assert.equal(parseVersion('v1.0.0-rc.1'), null);
        assert.equal(parseVersion('1.0.0-alpha'), null);
    });

    test('parseVersion rejects build metadata', () => {
        assert.equal(parseVersion('1.0.0+build.123'), null);
    });

    test('isCacheStale with exactly boundary epoch', () => {
        const exactBoundary = Math.floor(Date.now() / 1000) - 24 * 3600;
        assert.equal(
            isCacheStale({ last_check_epoch: exactBoundary, latest_version: '', current_version: '' }, 24),
            true,
        );
    });

    test('readSettings ignores zero interval (uses default)', () => {
        fs.writeFileSync(
            path.join(tmpDir, 'pickle_settings.json'),
            JSON.stringify({ update_check_interval_hours: 0 }),
        );
        const settings = readSettings();
        assert.equal(settings.update_check_interval_hours, 24);
    });

    test('writeCache handles non-writable dir gracefully', () => {
        // Point EXTENSION_DIR at a nonexistent nested dir — writeCache should not throw
        process.env.EXTENSION_DIR = path.join(tmpDir, 'no', 'such', 'deep', 'dir');
        assert.doesNotThrow(() => {
            writeCache({ last_check_epoch: 1, latest_version: '1.0.0', current_version: '1.0.0' });
        });
    });
});

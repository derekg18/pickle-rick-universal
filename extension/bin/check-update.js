#!/usr/bin/env node
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { getExtensionRoot, safeErrorMessage } from '../services/pickle-utils.js';
import { readRecoverableJsonObject } from '../services/microverse-state.js';
const CACHE_FILE = 'update-check.json';
const SETTINGS_FILE = 'pickle_settings.json';
const DEBUG_LOG = 'debug.log';
function log(message) {
    try {
        const extensionRoot = getExtensionRoot();
        const timestamp = new Date().toISOString();
        fs.appendFileSync(path.join(extensionRoot, DEBUG_LOG), `[${timestamp}] [check-update] ${message}\n`);
    }
    catch {
        /* fail-open */
    }
}
export function parseVersion(tag) {
    if (!tag)
        return null;
    const stripped = tag.startsWith('v') ? tag.slice(1) : tag;
    if (!/^\d+\.\d+\.\d+$/.test(stripped))
        return null;
    return stripped;
}
export function compareSemver(a, b) {
    const partsA = a.split('.').map(Number);
    const partsB = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if (partsA[i] < partsB[i])
            return -1;
        if (partsA[i] > partsB[i])
            return 1;
    }
    return 0;
}
function defaultCache() {
    return { last_check_epoch: 0, latest_version: '', current_version: '' };
}
export function readCache() {
    try {
        const filePath = path.join(getExtensionRoot(), CACHE_FILE);
        const raw = readRecoverableJsonObject(filePath);
        if (!raw) {
            log('Cache missing or corrupted, using defaults');
            return defaultCache();
        }
        const latestVersion = typeof raw.latest_version === 'string' && parseVersion(raw.latest_version)
            ? raw.latest_version
            : '';
        const currentVersion = typeof raw.current_version === 'string' && parseVersion(raw.current_version)
            ? raw.current_version
            : '';
        const cacheVersionsValid = latestVersion !== '' && currentVersion !== '';
        return {
            last_check_epoch: cacheVersionsValid && typeof raw.last_check_epoch === 'number' ? raw.last_check_epoch : 0,
            latest_version: latestVersion,
            current_version: currentVersion,
        };
    }
    catch {
        log('Cache missing or corrupted, using defaults');
        return defaultCache();
    }
}
export function writeCache(cache) {
    const filePath = path.join(getExtensionRoot(), CACHE_FILE);
    const tmpPath = `${filePath}.tmp.${process.pid}`;
    try {
        fs.writeFileSync(tmpPath, JSON.stringify(cache, null, 2) + '\n');
        fs.renameSync(tmpPath, filePath);
        log(`Cache written: ${cache.latest_version}`);
    }
    catch (err) {
        try {
            fs.unlinkSync(tmpPath);
        }
        catch { /* ignore cleanup failure */ }
        const msg = safeErrorMessage(err);
        log(`Failed to write cache: ${msg}`);
    }
}
export function readSettings() {
    const defaults = {
        auto_update_enabled: true,
        update_check_interval_hours: 24,
    };
    try {
        const filePath = path.join(getExtensionRoot(), SETTINGS_FILE);
        const raw = readRecoverableJsonObject(filePath);
        if (!raw)
            return defaults;
        if (typeof raw.auto_update_enabled === 'boolean') {
            defaults.auto_update_enabled = raw.auto_update_enabled;
        }
        if (typeof raw.update_check_interval_hours === 'number' && Number.isFinite(raw.update_check_interval_hours) && raw.update_check_interval_hours > 0) {
            defaults.update_check_interval_hours = raw.update_check_interval_hours;
        }
        return defaults;
    }
    catch {
        log('Settings missing or corrupted, using defaults');
        return defaults;
    }
}
export function isCacheStale(cache, intervalHours) {
    if (cache.last_check_epoch === 0)
        return true;
    const nowEpoch = Math.floor(Date.now() / 1000);
    if (cache.last_check_epoch > nowEpoch)
        return true;
    const intervalSeconds = intervalHours * 3600;
    return (nowEpoch - cache.last_check_epoch) >= intervalSeconds;
}
export function getLatestRelease() {
    try {
        const result = spawnSync('gh', [
            'api', 'repos/gregorydickson/pickle-rick-claude/releases/latest',
            '--jq', '{tag_name: .tag_name, assets: [.assets[] | {name: .name, url: .browser_download_url}]}',
        ], { encoding: 'utf-8', timeout: 15_000 });
        if (result.status !== 0) {
            log(`gh api failed: ${(result.stderr || '').trim()}`);
            return null;
        }
        const parsed = JSON.parse(result.stdout);
        return {
            tagName: parsed.tag_name,
            assets: Array.isArray(parsed.assets) ? parsed.assets : [],
        };
    }
    catch (err) {
        const msg = safeErrorMessage(err);
        log(`getLatestRelease error: ${msg}`);
        return null;
    }
}
export function getCurrentVersion() {
    try {
        const pkgPath = path.join(getExtensionRoot(), 'extension', 'package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
    }
    catch {
        log('Could not read package.json version');
        return '0.0.0';
    }
}
export function downloadRelease(tag) {
    let tmpDir = '';
    try {
        tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-update-')));
        log(`Downloading release ${tag} to ${tmpDir}`);
        const result = spawnSync('gh', [
            'release', 'download', tag,
            '-R', 'gregorydickson/pickle-rick-claude',
            '-A', 'tar.gz',
            '-D', tmpDir,
        ], { encoding: 'utf-8', timeout: 60_000 });
        if (result.status !== 0) {
            log(`gh release download failed: ${(result.stderr || '').trim()}`);
            fs.rmSync(tmpDir, { recursive: true, force: true });
            return null;
        }
        const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.tar.gz'));
        if (files.length === 0) {
            log('No .tar.gz asset found in downloaded release');
            fs.rmSync(tmpDir, { recursive: true, force: true });
            return null;
        }
        return path.join(tmpDir, files[0]);
    }
    catch (err) {
        const msg = safeErrorMessage(err);
        log(`downloadRelease error: ${msg}`);
        if (tmpDir) {
            try {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
            catch { /* best-effort */ }
        }
        return null;
    }
}
export function extractAndInstall(tarballPath) {
    const tarballDir = path.dirname(tarballPath);
    let extractDir = '';
    try {
        extractDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-extract-')));
        log(`Extracting ${tarballPath} to ${extractDir}`);
        const tar = spawnSync('tar', ['xzf', tarballPath, '-C', extractDir, '--strip-components=1'], {
            encoding: 'utf-8',
            timeout: 30_000,
        });
        if (tar.status !== 0) {
            const msg = (tar.stderr || '').trim();
            log(`tar extraction failed: ${msg}`);
            return { success: false, error: `Extraction failed: ${msg}` };
        }
        const installScript = path.join(extractDir, 'install.sh');
        if (!fs.existsSync(installScript)) {
            log('install.sh not found in extracted tarball');
            return { success: false, error: 'install.sh not found in release' };
        }
        log('Running install.sh');
        const install = spawnSync('bash', ['install.sh'], {
            cwd: extractDir,
            encoding: 'utf-8',
            timeout: 30_000,
        });
        if (install.status !== 0) {
            const msg = (install.stderr || '').trim();
            log(`install.sh failed (exit ${install.status}): ${msg}`);
            return { success: false, error: `install.sh failed (exit ${install.status})` };
        }
        log('install.sh completed successfully');
        return { success: true };
    }
    catch (err) {
        const msg = safeErrorMessage(err);
        log(`extractAndInstall error: ${msg}`);
        return { success: false, error: msg };
    }
    finally {
        try {
            fs.rmSync(tarballDir, { recursive: true, force: true });
        }
        catch { /* best-effort */ }
        if (extractDir) {
            try {
                fs.rmSync(extractDir, { recursive: true, force: true });
            }
            catch { /* best-effort */ }
        }
    }
}
export function performUpgrade(from, to, tag, options) {
    try {
        const settings = readSettings();
        if (!settings.auto_update_enabled && !options?.force) {
            log('Auto-update disabled in settings; refusing performUpgrade');
            return { success: false, error: 'Auto-update disabled in pickle_settings.json' };
        }
        log(`Starting upgrade: ${from} → ${to} (${tag})`);
        const tarballPath = downloadRelease(tag);
        if (!tarballPath) {
            return { success: false, error: 'Failed to download release' };
        }
        const result = extractAndInstall(tarballPath);
        if (!result.success) {
            return result;
        }
        // Only update cache after confirmed successful install
        const postInstallVersion = getCurrentVersion();
        writeCache({
            last_check_epoch: Math.floor(Date.now() / 1000),
            latest_version: to,
            current_version: postInstallVersion,
        });
        process.stderr.write(`🥒 Pickle Rick upgraded: v${from} → v${to}\n`);
        log(`Upgrade complete: ${from} → ${to}`);
        return { success: true };
    }
    catch (err) {
        const msg = safeErrorMessage(err);
        log(`performUpgrade error: ${msg}`);
        return { success: false, error: msg };
    }
}
export function checkForUpdate(options) {
    const currentVersion = getCurrentVersion();
    const errorResult = { status: 'error', currentVersion };
    try {
        const settings = readSettings();
        if (!settings.auto_update_enabled && !options?.force) {
            log('Auto-update disabled in settings');
            return { status: 'up-to-date', currentVersion };
        }
        const cache = readCache();
        if (!options?.force && !isCacheStale(cache, settings.update_check_interval_hours)) {
            log('Cache is fresh, using cached result');
            if (cache.latest_version && compareSemver(currentVersion, cache.latest_version) < 0) {
                return { status: 'update-available', currentVersion, latestVersion: cache.latest_version };
            }
            return { status: 'up-to-date', currentVersion };
        }
        log('Cache stale or forced, fetching latest release');
        const release = getLatestRelease();
        if (!release) {
            return { ...errorResult, error: 'Failed to fetch latest release' };
        }
        const latestVersion = parseVersion(release.tagName);
        if (!latestVersion) {
            return { ...errorResult, error: `Invalid release tag: ${release.tagName}` };
        }
        writeCache({
            last_check_epoch: Math.floor(Date.now() / 1000),
            latest_version: latestVersion,
            current_version: currentVersion,
        });
        if (compareSemver(currentVersion, latestVersion) < 0) {
            log(`Update available: ${currentVersion} → ${latestVersion}`);
            const upgrade = performUpgrade(currentVersion, latestVersion, release.tagName, { force: options?.force });
            if (upgrade.success) {
                return { status: 'up-to-date', currentVersion: latestVersion, latestVersion };
            }
            return { status: 'update-available', currentVersion, latestVersion };
        }
        log(`Up to date: ${currentVersion}`);
        return { status: 'up-to-date', currentVersion, latestVersion };
    }
    catch (err) {
        const msg = safeErrorMessage(err);
        log(`checkForUpdate error: ${msg}`);
        return { ...errorResult, error: msg };
    }
}
if (process.argv[1] && path.basename(process.argv[1]) === 'check-update.js') {
    const force = process.argv.includes('--force');
    if (process.argv.includes('--upgrade')) {
        const current = getCurrentVersion();
        const release = getLatestRelease();
        if (!release) {
            console.error('Failed to fetch latest release');
            process.exit(1);
        }
        const latest = parseVersion(release.tagName);
        if (!latest || compareSemver(current, latest) >= 0) {
            console.log(JSON.stringify({ status: 'up-to-date', currentVersion: current }));
        }
        else {
            const upgrade = performUpgrade(current, latest, release.tagName, { force });
            console.log(JSON.stringify(upgrade, null, 2));
            process.exit(upgrade.success ? 0 : 1);
        }
    }
    else {
        const result = checkForUpdate({ force });
        console.log(JSON.stringify(result, null, 2));
    }
}

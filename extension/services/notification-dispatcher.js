import { spawnSync } from 'child_process';
import { displayMacNotification, getExtensionRoot, NOTIFICATION_TIMEOUT_MS, safeErrorMessage, } from './pickle-utils.js';
import { loadPickleSettings } from './pickle-settings.js';
export const NOTIFICATION_KINDS = [
    'mux_session_end',
    'pipeline_session_end',
];
const DEFAULT_NOTIFICATION_SETTINGS = {
    os_enabled: true,
    terminal_fallback: true,
    dedup_window_ms: 60_000,
    kinds: {
        mux_session_end: true,
        pipeline_session_end: true,
    },
};
const severityRank = {
    info: 1,
    warning: 2,
    error: 3,
};
const dedupSeen = new Map();
function positiveIntegerOrDefault(value, fallback) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
function booleanOrDefault(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
}
function normalizeSettings(raw) {
    const settings = raw && typeof raw === 'object'
        ? raw
        : {};
    const kinds = settings.kinds && typeof settings.kinds === 'object'
        ? settings.kinds
        : {};
    return {
        os_enabled: booleanOrDefault(settings.os_enabled, DEFAULT_NOTIFICATION_SETTINGS.os_enabled),
        terminal_fallback: booleanOrDefault(settings.terminal_fallback, DEFAULT_NOTIFICATION_SETTINGS.terminal_fallback),
        dedup_window_ms: positiveIntegerOrDefault(settings.dedup_window_ms, DEFAULT_NOTIFICATION_SETTINGS.dedup_window_ms),
        kinds: {
            mux_session_end: booleanOrDefault(kinds.mux_session_end, DEFAULT_NOTIFICATION_SETTINGS.kinds.mux_session_end),
            pipeline_session_end: booleanOrDefault(kinds.pipeline_session_end, DEFAULT_NOTIFICATION_SETTINGS.kinds.pipeline_session_end),
        },
    };
}
export function loadNotificationSettings(settingsRoot = getExtensionRoot()) {
    const raw = loadPickleSettings({ extensionRoot: settingsRoot });
    return normalizeSettings(raw?.notifications);
}
function defaultOsProbe(forceDarwin) {
    const isDarwin = forceDarwin ?? process.platform === 'darwin';
    if (!isDarwin)
        return false;
    try {
        const result = spawnSync('command', ['-v', 'osascript'], {
            timeout: NOTIFICATION_TIMEOUT_MS,
            encoding: 'utf-8',
            shell: true,
        });
        return result.status === 0;
    }
    catch {
        return false;
    }
}
function defaultOsNotifier(event, timeoutMs, forceDarwin) {
    displayMacNotification(event.title, event.body, event.subtitle, {
        forceDarwin,
        timeoutMs,
    });
}
function dedupKey(event) {
    return `${event.kind}:${event.session ?? ''}`;
}
function checkDedup(event, nowMs, windowMs) {
    const key = dedupKey(event);
    const prior = dedupSeen.get(key);
    if (!prior || nowMs - prior.at > windowMs) {
        dedupSeen.set(key, { at: nowMs, severity: event.severity });
        return null;
    }
    if (severityRank[event.severity] <= severityRank[prior.severity]) {
        return { delivered: false, channel: 'suppressed', reason: 'duplicate' };
    }
    dedupSeen.set(key, { at: nowMs, severity: event.severity });
    return null;
}
function terminalFallback(event, reason, write) {
    try {
        const suffix = event.subtitle ? ` (${event.subtitle})` : '';
        write(`[pickle-notify] ${event.title}: ${event.body}${suffix}\n`);
        return { delivered: true, channel: 'terminal', reason };
    }
    catch (err) {
        return {
            delivered: false,
            channel: 'suppressed',
            reason: `terminal_failed:${safeErrorMessage(err)}`,
        };
    }
}
export function notifySessionEvent(event, opts = {}) {
    const settings = normalizeSettings(opts.settings ?? loadNotificationSettings(opts.settingsRoot));
    const nowMs = opts.nowMs ?? Date.now();
    const terminalWrite = opts.terminalWrite ?? ((line) => process.stderr.write(line));
    if (!settings.kinds[event.kind]) {
        return { delivered: false, channel: 'suppressed', reason: 'kind_disabled' };
    }
    const dedupResult = checkDedup(event, nowMs, settings.dedup_window_ms);
    if (dedupResult)
        return dedupResult;
    if (!settings.os_enabled) {
        return settings.terminal_fallback
            ? terminalFallback(event, 'os_disabled', terminalWrite)
            : { delivered: false, channel: 'suppressed', reason: 'os_disabled' };
    }
    const canUseOs = opts.osProbe ? opts.osProbe() : defaultOsProbe(opts.forceDarwin);
    if (!canUseOs) {
        return settings.terminal_fallback
            ? terminalFallback(event, 'os_unavailable', terminalWrite)
            : { delivered: false, channel: 'suppressed', reason: 'os_unavailable' };
    }
    try {
        const timeoutMs = opts.timeoutMs ?? NOTIFICATION_TIMEOUT_MS;
        const notifier = opts.osNotifier
            ?? ((notification, timeout) => defaultOsNotifier(notification, timeout, opts.forceDarwin));
        notifier(event, timeoutMs);
        return { delivered: true, channel: 'os' };
    }
    catch (err) {
        return settings.terminal_fallback
            ? terminalFallback(event, `os_failed:${safeErrorMessage(err)}`, terminalWrite)
            : { delivered: false, channel: 'suppressed', reason: `os_failed:${safeErrorMessage(err)}` };
    }
}
export function resetNotificationDedupForTests() {
    dedupSeen.clear();
}

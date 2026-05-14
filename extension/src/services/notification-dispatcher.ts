import { spawnSync, type SpawnSyncReturns } from 'child_process';
import {
  displayMacNotification,
  getExtensionRoot,
  NOTIFICATION_TIMEOUT_MS,
  safeErrorMessage,
} from './pickle-utils.js';
import { loadPickleSettings } from './pickle-settings.js';

export const NOTIFICATION_KINDS = [
  'mux_session_end',
  'pipeline_session_end',
  'token_accounting_ready',
] as const;

export type NotificationKind = typeof NOTIFICATION_KINDS[number];
export type NotificationSeverity = 'info' | 'warning' | 'error';
export type NotificationChannel = 'os' | 'terminal' | 'suppressed';

export interface NotificationEvent {
  kind: NotificationKind;
  session?: string;
  severity: NotificationSeverity;
  title: string;
  body: string;
  subtitle?: string;
}

export interface NotificationSettings {
  os_enabled: boolean;
  terminal_fallback: boolean;
  dedup_window_ms: number;
  kinds: Record<NotificationKind, boolean>;
}

export interface NotificationResult {
  delivered: boolean;
  channel: NotificationChannel;
  reason?: string;
}

export interface NotifySessionEventOptions {
  settingsRoot?: string;
  settings?: PartialNotificationSettings;
  nowMs?: number;
  forceDarwin?: boolean;
  timeoutMs?: number;
  osNotifier?: (event: NotificationEvent, timeoutMs: number) => void;
  osProbeSpawn?: typeof spawnSync;
  osProbe?: () => boolean;
  terminalWrite?: (line: string) => void;
}

type PartialNotificationSettings = Partial<Omit<NotificationSettings, 'kinds'>> & {
  kinds?: Partial<Record<NotificationKind, boolean>>;
};

interface DedupEntry {
  at: number;
  severity: NotificationSeverity;
}

const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  os_enabled: true,
  terminal_fallback: true,
  dedup_window_ms: 60_000,
  kinds: {
    mux_session_end: true,
    pipeline_session_end: true,
    token_accounting_ready: true,
  },
};

const severityRank: Record<NotificationSeverity, number> = {
  info: 1,
  warning: 2,
  error: 3,
};

const dedupSeen = new Map<string, DedupEntry>();

function positiveIntegerOrDefault(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function booleanOrDefault(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeSettings(raw: unknown): NotificationSettings {
  const settings = raw && typeof raw === 'object'
    ? raw as PartialNotificationSettings
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
      token_accounting_ready: booleanOrDefault(kinds.token_accounting_ready, DEFAULT_NOTIFICATION_SETTINGS.kinds.token_accounting_ready),
    },
  };
}

export function loadNotificationSettings(settingsRoot = getExtensionRoot()): NotificationSettings {
  const raw = loadPickleSettings({ extensionRoot: settingsRoot });
  return normalizeSettings(raw?.notifications);
}

function defaultOsProbe(forceDarwin?: boolean, spawnSyncFn: typeof spawnSync = spawnSync): boolean {
  const isDarwin = forceDarwin ?? process.platform === 'darwin';
  if (!isDarwin) return false;
  try {
    const result = spawnSyncFn('osascript', ['-e', 'return 0'], {
      timeout: NOTIFICATION_TIMEOUT_MS,
      encoding: 'utf-8',
    }) as SpawnSyncReturns<string>;
    return result.status === 0;
  } catch {
    return false;
  }
}

function defaultOsNotifier(event: NotificationEvent, timeoutMs: number, forceDarwin?: boolean): void {
  displayMacNotification(event.title, event.body, event.subtitle, {
    forceDarwin,
    timeoutMs,
  });
}

function dedupKey(event: NotificationEvent): string {
  return `${event.kind}:${event.session ?? ''}`;
}

function checkDedup(event: NotificationEvent, nowMs: number, windowMs: number): NotificationResult | null {
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

function terminalFallback(
  event: NotificationEvent,
  reason: string,
  write: (line: string) => void,
): NotificationResult {
  try {
    const suffix = event.subtitle ? ` (${event.subtitle})` : '';
    write(`[pickle-notify] ${event.title}: ${event.body}${suffix}\n`);
    return { delivered: true, channel: 'terminal', reason };
  } catch (err) {
    return {
      delivered: false,
      channel: 'suppressed',
      reason: `terminal_failed:${safeErrorMessage(err)}`,
    };
  }
}

export function notifySessionEvent(
  event: NotificationEvent,
  opts: NotifySessionEventOptions = {},
): NotificationResult {
  const settings = normalizeSettings(opts.settings ?? loadNotificationSettings(opts.settingsRoot));
  const nowMs = opts.nowMs ?? Date.now();
  const terminalWrite = opts.terminalWrite ?? ((line: string) => process.stderr.write(line));

  if (!settings.kinds[event.kind]) {
    return { delivered: false, channel: 'suppressed', reason: 'kind_disabled' };
  }

  const dedupResult = checkDedup(event, nowMs, settings.dedup_window_ms);
  if (dedupResult) return dedupResult;

  if (!settings.os_enabled) {
    return settings.terminal_fallback
      ? terminalFallback(event, 'os_disabled', terminalWrite)
      : { delivered: false, channel: 'suppressed', reason: 'os_disabled' };
  }

  const canUseOs = opts.osProbe ? opts.osProbe() : defaultOsProbe(opts.forceDarwin, opts.osProbeSpawn);
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
  } catch (err) {
    return settings.terminal_fallback
      ? terminalFallback(event, `os_failed:${safeErrorMessage(err)}`, terminalWrite)
      : { delivered: false, channel: 'suppressed', reason: `os_failed:${safeErrorMessage(err)}` };
  }
}

export function resetNotificationDedupForTests(): void {
  dedupSeen.clear();
}

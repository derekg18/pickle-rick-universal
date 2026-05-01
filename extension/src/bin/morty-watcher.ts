#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { Style, sleep, drainLog, MatrixStyle, matrixSeparator, safeErrorMessage } from '../services/pickle-utils.js';
import { StateManager } from '../services/state-manager.js';

interface WorkerLogEntry {
  ticketId: string;
  logPath: string;
  mtimeMs: number;
}

interface ArtifactEntry {
  ticketId: string;
  filePath: string;
  fileName: string;
}

const ARTIFACT_IGNORE = new Set(['state.json']);
const ARTIFACT_RECENCY_MS = 30000;
const sm = new StateManager();

/**
 * Classifies an artifact filename into a progress category.
 */
export function classifyArtifact(fileName: string): string {
  if (fileName.startsWith('research_') || fileName.startsWith('analysis_')) return '📖 Researching...';
  if (fileName.startsWith('plan_')) return '📐 Planning...';
  return '🔨 Implementing...';
}

/**
 * Scans ticket directories for recently created files (within 30s)
 * that aren't state.json or log files. Used as a fallback when
 * no worker logs exist (inline-processed tickets).
 */
export function discoverArtifacts(
  sessionDir: string,
  seenArtifacts: Set<string>,
): ArtifactEntry[] {
  const now = Date.now();
  const results: ArtifactEntry[] = [];
  try {
    for (const dir of fs.readdirSync(sessionDir)) {
      const dirPath = path.join(sessionDir, dir);
      let stat;
      try { stat = fs.lstatSync(dirPath); } catch { continue; }
      if (!stat.isDirectory()) continue;
      try {
        for (const file of fs.readdirSync(dirPath)) {
          if (ARTIFACT_IGNORE.has(file) || file.endsWith('.log')) continue;
          const filePath = path.join(dirPath, file);
          if (seenArtifacts.has(filePath)) continue;
          let fileStat;
          try { fileStat = fs.lstatSync(filePath); } catch { continue; }
          if (!fileStat.isFile()) continue;
          if (now - fileStat.mtimeMs > ARTIFACT_RECENCY_MS) continue;
          seenArtifacts.add(filePath);
          results.push({ ticketId: dir, filePath, fileName: file });
        }
      } catch { continue; }
    }
  } catch { /* ignore */ }
  return results;
}

function discoverWorkerLogs(sessionDir: string): WorkerLogEntry[] {
  try {
    const entries: WorkerLogEntry[] = [];
    for (const dir of fs.readdirSync(sessionDir)) {
      const dirPath = path.join(sessionDir, dir);
      let stat;
      try { stat = fs.lstatSync(dirPath); } catch { continue; }
      if (!stat.isDirectory()) continue;
      try {
        for (const file of fs.readdirSync(dirPath)) {
          if (file.startsWith('worker_session_') && file.endsWith('.log')) {
            const logPath = path.join(dirPath, file);
            let logStat;
            try { logStat = fs.lstatSync(logPath); } catch { continue; }
            if (!logStat.isFile()) continue;
            entries.push({ ticketId: dir, logPath, mtimeMs: logStat.mtimeMs });
          }
        }
      } catch { continue; }
    }
    return entries.sort((a, b) => a.mtimeMs - b.mtimeMs || a.logPath.localeCompare(b.logPath));
  } catch {
    return [];
  }
}

async function main() {
  const sessionDir = process.argv[2];
  // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
  if (!sessionDir || sessionDir.startsWith('--') || !fs.existsSync(sessionDir)) {
    console.error('Usage: node morty-watcher.js <session-dir>');
    process.exit(1);
  }

  process.on('SIGINT', () => {
    process.stdout.write('\nDetached.\n');
    process.exit(0);
  });

  const MX = MatrixStyle;
  const sep = () => matrixSeparator(Math.min((process.stdout.columns || 60) - 2, 60));

  process.stdout.write(`\n${MX.BRIGHT}◤ WORKER LOGS ◢${MX.R}\n${sep()}\n`);

  let currentLog: string | null = null;
  let currentTicket: string | null = null;
  let offset = 0;
  const seenArtifacts = new Set<string>();

  while (true) {
    const logs = discoverWorkerLogs(sessionDir);

    if (logs.length === 0) {
      // Fallback: check for artifacts from inline-processed tickets
      const artifacts = discoverArtifacts(sessionDir, seenArtifacts);
      if (artifacts.length > 0) {
        for (const art of artifacts) {
          const label = classifyArtifact(art.fileName);
          if (art.ticketId !== currentTicket) {
            currentTicket = art.ticketId;
            process.stdout.write(`\n${sep()}\n${MX.BRIGHT}▸ ${art.ticketId}${MX.R}\n${sep()}\n`);
          }
          process.stdout.write(`  ${label} ${MX.DIM}${art.fileName}${MX.R}\n`);
        }
      } else {
        try {
          const state = sm.read(path.join(sessionDir, 'state.json'));
          if (state.active !== true) {
            process.stdout.write(`\n${sep()}\n${MX.BRIGHT}◤ FEED TERMINATED ◢${MX.R}\n`);
            break;
          }
        } catch { /* ignore */ }
        process.stdout.write(`\r${MX.DIM}Awaiting worker signal...${MX.R}\x1b[K`);
      }
      await sleep(1000);
      continue;
    }

    const latest = logs[logs.length - 1];

    if (latest.logPath !== currentLog) {
      const isNewTicket = latest.ticketId !== currentTicket;
      currentLog = latest.logPath;
      currentTicket = latest.ticketId;
      offset = 0;

      if (isNewTicket) {
        process.stdout.write(`\n${sep()}\n${MX.BRIGHT}▸ ${latest.ticketId}${MX.R}\n${sep()}\n`);
      } else {
        const pid = path.basename(latest.logPath, '.log').replace('worker_session_', '');
        process.stdout.write(`\n${sep()}\n${MX.WARN}▸ RETRY (PID ${pid})${MX.R}\n${sep()}\n`);
      }
    }

    offset = drainLog(currentLog, offset);

    try {
      const state = sm.read(path.join(sessionDir, 'state.json'));
      if (state.active !== true) {
        await sleep(2000);
        drainLog(currentLog, offset);
        process.stdout.write(`\n${sep()}\n${MX.BRIGHT}◤ FEED TERMINATED ◢${MX.R}\n`);
        break;
      }
    } catch {
      /* ignore */
    }

    await sleep(500);
  }
}

if (process.argv[1] && path.basename(process.argv[1]) === 'morty-watcher.js') {
  main().catch((err) => {
    const msg = safeErrorMessage(err);
    console.error(`${Style.RED}[morty-watcher] ${msg}${Style.RESET}`);
    process.exit(1);
  });
}

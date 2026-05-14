#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { getExtensionRoot, extractFrontmatter, updateState, safeErrorMessage, findSessionPathForCwd, clearTicketResolutionTimestamps } from '../services/pickle-utils.js';
import { StateManager } from '../services/state-manager.js';
import { State, Defaults } from '../types/index.js';

const sm = new StateManager();

interface RetryTicketPaths {
  sessionDir: string;
  statePath: string;
  ticketDir: string;
  ticketFile: string;
}

function positiveIntegerOrDefault(value: unknown, fallback: number): number {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
  }
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

export function retryTicket(ticketId: string, cwd: string): void {
  const paths = resolveRetryTicketPaths(ticketId, cwd);
  archivePartialArtifacts(paths.ticketDir);
  resetTicketToTodo(paths.ticketFile);
  reactivateSession(paths.statePath, paths.sessionDir, ticketId);
  const finalState = readFinalState(paths.statePath, paths.sessionDir);
  const spawnCmd = buildSpawnCommand(finalState, paths.sessionDir, ticketId);
  console.log(`\n✅ Ticket ${ticketId} reset to Todo. Run this command to re-spawn Morty:\n\n${spawnCmd}\n`);
}

function resolveRetryTicketPaths(ticketId: string, cwd: string): RetryTicketPaths {
  validateTicketId(ticketId);
  const sessionDir = requireActiveSession(cwd);
  const statePath = path.join(sessionDir, 'state.json');
  readInitialState(statePath, sessionDir);
  const ticketDir = path.join(sessionDir, ticketId);
  const ticketFile = path.join(ticketDir, `linear_ticket_${ticketId}.md`);
  requireTicketFiles(ticketId, sessionDir, ticketDir, ticketFile);
  return { sessionDir, statePath, ticketDir, ticketFile };
}

function validateTicketId(ticketId: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(ticketId)) {
    throw new Error(`Invalid ticket ID: ${ticketId}`);
  }
}

function requireActiveSession(cwd: string): string {
  const sessionPath = findSessionPathForCwd(cwd);
  if (!sessionPath || !fs.existsSync(sessionPath)) {
    throw new Error('No active session found for this directory.');
  }
  return sessionPath;
}

function readInitialState(statePath: string, sessionDir: string): void {
  try {
    sm.read(statePath);
  } catch {
    throw new Error(`state.json is corrupt or unreadable in ${sessionDir}`);
  }
}

function requireTicketFiles(ticketId: string, sessionDir: string, ticketDir: string, ticketFile: string): void {
  if (!fs.existsSync(ticketDir) || !fs.existsSync(ticketFile)) {
    throw new Error(`Ticket ${ticketId} not found in session ${sessionDir}`);
  }
}

function archivePartialArtifacts(ticketDir: string): void {
  const artifacts = fs.readdirSync(ticketDir).filter(isRetryArtifact);
  if (artifacts.length > 0) {
    const archiveDir = path.join(ticketDir, `_retry_${Date.now()}`);
    fs.mkdirSync(archiveDir, { recursive: true });
    for (const artifact of artifacts) {
      fs.renameSync(path.join(ticketDir, artifact), path.join(archiveDir, artifact));
    }
    console.log(`📦 Archived ${artifacts.length} artifact(s) to ${path.basename(archiveDir)}/`);
  }
}

function isRetryArtifact(fileName: string): boolean {
  return /^research_.*\.md$/.test(fileName) || fileName === 'research_review.md' ||
    /^plan_.*\.md$/.test(fileName) || fileName === 'plan_review.md';
}

function resetTicketToTodo(ticketFile: string): void {
  const ticketContent = fs.readFileSync(ticketFile, 'utf-8');
  const updatedContent = resetTicketStatus(ticketContent);
  const tmpTicket = ticketFile + `.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmpTicket, updatedContent);
    fs.renameSync(tmpTicket, ticketFile);
  } catch (err) {
    try { fs.unlinkSync(tmpTicket); } catch { /* ignore cleanup failure */ }
    throw err;
  }
}

function resetTicketStatus(ticketContent: string): string {
  const fmResult = extractFrontmatter(ticketContent);
  if (!fmResult) {
    return ticketContent.replace(/^status:.*$/m, 'status: "Todo"');
  }
  const fmSection = ticketContent.slice(0, fmResult.end).replace(/^status:.*$/m, 'status: "Todo"');
  return clearTicketResolutionTimestamps(fmSection) + ticketContent.slice(fmResult.end);
}

function reactivateSession(statePath: string, sessionDir: string, ticketId: string): void {
  sm.update(statePath, s => {
    s.active = true;
    s.session_dir = sessionDir;
  });
  updateState('current_ticket', ticketId, sessionDir);
}

function readFinalState(statePath: string, sessionDir: string): State {
  try {
    return sm.read(statePath);
  } catch {
    throw new Error(`state.json became unreadable after update in ${sessionDir}`);
  }
}

function buildSpawnCommand(finalState: State, sessionDir: string, ticketId: string): string {
  const timeout = positiveIntegerOrDefault(finalState.worker_timeout_seconds, Defaults.WORKER_TIMEOUT_SECONDS);

  const safePrompt = (finalState.original_prompt || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/'/g, "'\\''");

  const safeSessionDir = sessionDir.replace(/'/g, "'\\''");
  return `node "${getExtensionRoot()}/extension/bin/spawn-morty.js" '${safePrompt}' --ticket-id '${ticketId}' --ticket-path '${safeSessionDir}/${ticketId}/' --ticket-file '${safeSessionDir}/${ticketId}/linear_ticket_${ticketId}.md' --timeout ${timeout}`;
}

if (process.argv[1] && path.basename(process.argv[1]) === 'retry-ticket.js') {
  const ticketId = process.argv[2];
  if (!ticketId) {
    console.error('Usage: node retry-ticket.js <ticket-id>');
    process.exit(1);
  }
  try {
    retryTicket(ticketId, process.cwd());
  } catch (err) {
    console.error(safeErrorMessage(err));
    process.exit(1);
  }
}

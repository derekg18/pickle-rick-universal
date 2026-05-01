#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { logActivity } from '../services/activity-logger.js';
import { listLinearTicketFiles } from '../services/artifact-validation.js';
import { computeOneHop } from '../services/scope-resolver.js';
import { formatLocalDateKey, safeErrorMessage } from '../services/pickle-utils.js';
import { StateManager } from '../services/state-manager.js';
import type { ReadinessCycleHistoryEntry } from '../types/index.js';

export interface ReadinessArgs {
  sessionDir: string;
  repoRoot: string;
  manifest?: string;
  machinabilityOnly: boolean;
  contractOnly: boolean;
  history: boolean;
  last: number;
}

export interface ReadinessFinding {
  ticket: string;
  kind: 'prd_map' | 'machinability' | 'file_path' | 'contract' | 'dependency';
  message: string;
  analyst: 'gaps' | 'codebase' | 'risk';
  detail: string;
}

interface TicketInfo {
  file: string;
  id: string;
  key?: string;
  sourcePrd?: string;
  sourceSection?: string;
  acIds: string[];
  dependencies: Array<{ ref: string; external: boolean }>;
}

interface ManifestTicket {
  id?: unknown;
  key?: unknown;
  ac_ids?: unknown;
  requirements?: unknown;
}

interface TicketSnapshot {
  ticketsVersion?: number;
  hashes: Record<string, string>;
}

interface ReadinessStateShape {
  readiness?: {
    cycle_history?: unknown[];
  };
  tickets_version?: unknown;
  activity?: Array<{ event?: unknown }>;
}

const SNAPSHOT_FILE = 'readiness_snapshot.json';
const READINESS_MAX_RECYCLE_CYCLES = 3;
const DEFAULT_HISTORY_LIMIT = 10;
const MACHINE_HINT_RE = /\b(\d+(?:\.\d+)?%?|exit\s+\d+|<\s*\d+|>\s*\d+|<=\s*\d+|>=\s*\d+|under\s+\d+|within\s+\d+|exact(?:ly)?|regex|matches?|JSON|field|file exists|writes?|emits?|test|describe\.each|node --test|npm test|tsc|eslint|table|input\/output)\b/i;
const PURE_PROSE_RE = /\b(must|should)\s+(?:be|feel)\s+(?:intuitive|performant|fast|easy|simple|clear|usable|nice|good|robust|reliable)\b/i;
const PATH_RE = /\b(?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|sh|py|css|scss|html)\b/g;
const SYMBOL_RE = /\b[A-Z][A-Za-z0-9]*(?:\.[A-Za-z_$][\w$]*)+\b|\b[A-Za-z_$][\w$]*\(\)/g;

function usage(): never {
  console.error('Usage: node check-readiness.js --session-dir <dir> [--repo-root <dir>] [--manifest <file>] [--machinability-only] [--contract-only] [--history [--last N]]');
  process.exit(1);
}

function parseArgs(argv: string[]): ReadinessArgs {
  const sessionIndex = argv.indexOf('--session-dir');
  const repoIndex = argv.indexOf('--repo-root');
  const manifestIndex = argv.indexOf('--manifest');
  const lastIndex = argv.indexOf('--last');
  const sessionDir = sessionIndex >= 0 ? argv[sessionIndex + 1] : undefined;
  if (!sessionDir || sessionDir.startsWith('--')) usage();
  let last = DEFAULT_HISTORY_LIMIT;
  if (lastIndex >= 0) {
    const rawLast = argv[lastIndex + 1];
    if (!rawLast || rawLast.startsWith('--')) usage();
    last = Number.parseInt(rawLast, 10);
    if (!Number.isInteger(last) || last < 1) usage();
  }
  const repoRoot = repoIndex >= 0 && argv[repoIndex + 1] && !argv[repoIndex + 1].startsWith('--')
    ? argv[repoIndex + 1]
    : process.cwd();
  const manifest = manifestIndex >= 0 && argv[manifestIndex + 1] && !argv[manifestIndex + 1].startsWith('--')
    ? argv[manifestIndex + 1]
    : undefined;
  return {
    sessionDir: path.resolve(sessionDir),
    repoRoot: path.resolve(repoRoot),
    manifest,
    machinabilityOnly: argv.includes('--machinability-only'),
    contractOnly: argv.includes('--contract-only'),
    history: argv.includes('--history'),
    last,
  };
}

export function extractAcceptanceCriteria(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const acs: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (/^##+\s+Acceptance Criteria\b/i.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##+\s+/.test(line)) break;
    if (!inSection) continue;
    const match = /^\s*[-*]\s+(?:\[[ xX]\]\s*)?(.+?)\s*$/.exec(line);
    if (match) acs.push(match[1]);
  }
  return acs;
}

export function isMachineCheckable(ac: string): boolean {
  if (PURE_PROSE_RE.test(ac) && !MACHINE_HINT_RE.test(ac)) return false;
  return MACHINE_HINT_RE.test(ac) || /\|.+\|/.test(ac) || /`[^`]+`/.test(ac);
}

export function extractContractReferences(content: string): string[] {
  const refs = new Set<string>();
  for (const match of content.matchAll(PATH_RE)) refs.add(match[0]);
  for (const match of content.matchAll(/`([^`]+)`/g)) {
    const value = match[1].trim();
    if (PATH_RE.test(value)) refs.add(value);
    PATH_RE.lastIndex = 0;
    if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+(?:\(\))?$/.test(value) || /^[A-Za-z_$][\w$]*\(\)$/.test(value)) refs.add(value);
  }
  for (const match of content.matchAll(SYMBOL_RE)) refs.add(match[0]);
  return [...refs]
    .filter((ref) => !ref.startsWith('AC-'))
    .filter((ref) => !refs.has(`${ref}()`))
    .sort();
}

function resolvePathRef(ref: string, repoRoot: string, ticketFile?: string, sessionDir?: string): boolean {
  if (path.isAbsolute(ref) && fs.existsSync(ref)) return true;
  const bases = [
    repoRoot,
    ticketFile ? path.dirname(ticketFile) : undefined,
    sessionDir,
  ].filter((base): base is string => typeof base === 'string');
  return bases.some((base) => fs.existsSync(path.resolve(base, ref)));
}

function gitTrackedFiles(repoRoot: string): string[] {
  const result = spawnSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf-8' });
  if (result.status !== 0) return [];
  return result.stdout.split('\n').filter(Boolean);
}

function resolveSymbolRef(ref: string, repoRoot: string): boolean {
  const normalized = ref.replace(/\(\)$/, '');
  const parts = normalized.split('.').filter(Boolean);
  if (parts.length === 0) return false;
  const tracked = gitTrackedFiles(repoRoot).filter((file) => /\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(file) && !/(^|\/)tests?\//.test(file));
  const partPatterns = parts.map((part) => new RegExp(`\\b${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`));
  const candidates = tracked.filter((file) => {
    try {
      const content = fs.readFileSync(path.join(repoRoot, file), 'utf-8');
      return partPatterns.every((pattern) => pattern.test(content));
    } catch {
      return false;
    }
  });
  if (candidates.length === 0) return false;
  try {
    computeOneHop(candidates.slice(0, 1), repoRoot, { findImportersTimeoutMs: 30_000 });
    return true;
  } catch {
    return false;
  }
}

export function findReadinessFindings(ticketFile: string, repoRoot: string, opts: { checkMachinability: boolean; checkContracts: boolean }): ReadinessFinding[] {
  const content = fs.readFileSync(ticketFile, 'utf-8');
  const findings: ReadinessFinding[] = [];
  if (opts.checkMachinability) {
    for (const ac of extractAcceptanceCriteria(content)) {
      if (!isMachineCheckable(ac)) {
        findings.push({
          ticket: ticketFile,
          kind: 'machinability',
          analyst: 'gaps',
          message: 'Acceptance criterion is not machine-checkable',
          detail: ac,
        });
      }
    }
  }
  if (opts.checkContracts) {
    for (const ref of extractContractReferences(content)) {
      if (ref.includes('/')) continue;
      const resolved = resolveSymbolRef(ref, repoRoot);
      if (!resolved) {
        findings.push({
          ticket: ticketFile,
          kind: 'contract',
          analyst: 'codebase',
          message: 'Referenced contract does not resolve',
          detail: ref,
        });
      }
    }
  }
  return findings;
}

function parseFrontmatter(content: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  return match ? match[1] : '';
}

function readScalar(frontmatter: string, key: string): string | undefined {
  const match = new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm').exec(frontmatter);
  if (!match) return undefined;
  const value = match[1].trim();
  if (value === '[]') return undefined;
  return value.replace(/^['"]|['"]$/g, '');
}

function readStringArray(frontmatter: string, key: string): string[] {
  const inline = new RegExp(`^${key}:\\s*\\[(.*?)\\]\\s*$`, 'm').exec(frontmatter);
  if (inline) {
    return inline[1].split(',').map((part) => part.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  }
  const lines = frontmatter.split(/\r?\n/);
  const index = lines.findIndex((line) => new RegExp(`^${key}:\\s*$`).test(line));
  if (index < 0) return [];
  const values: string[] = [];
  for (let i = index + 1; i < lines.length; i += 1) {
    const match = /^\s+-\s+(.+?)\s*$/.exec(lines[i]);
    if (!match) break;
    values.push(match[1].replace(/^['"]|['"]$/g, ''));
  }
  return values;
}

function dependencyRefs(content: string, frontmatter: string): Array<{ ref: string; external: boolean }> {
  const refs = new Map<string, boolean>();
  for (const dep of [...readStringArray(frontmatter, 'depends_on'), ...readStringArray(frontmatter, 'dependencies')]) {
    const external = /\bexternal\b/i.test(dep) || dep.startsWith('external:');
    refs.set(dep.replace(/^external:/, '').trim(), external);
  }
  for (const match of content.matchAll(/title:\s*["']?Depends on:\s*([^"'\n]+)["']?/gi)) {
    const raw = match[1].trim();
    const ref = raw.split(/\s+[—-]\s+|\s+\(/)[0]?.trim();
    if (!ref) continue;
    refs.set(ref, /\bexternal\b/i.test(raw));
  }
  return [...refs].map(([ref, external]) => ({ ref, external }));
}

function ticketInfo(ticketFile: string): TicketInfo {
  const content = fs.readFileSync(ticketFile, 'utf-8');
  const frontmatter = parseFrontmatter(content);
  const id = readScalar(frontmatter, 'id') ?? path.basename(path.dirname(ticketFile));
  const acIds = [
    ...readStringArray(frontmatter, 'ac_ids'),
    ...extractAcceptanceCriteria(content)
      .flatMap((ac) => [...ac.matchAll(/\b(?:AC-[A-Z0-9-]+|P\d+\.\d+|R\d+|T\d+)\b/g)].map((match) => match[0])),
  ];
  return {
    file: ticketFile,
    id,
    key: readScalar(frontmatter, 'key'),
    sourcePrd: readScalar(frontmatter, 'source_prd'),
    sourceSection: readScalar(frontmatter, 'source_section'),
    acIds: [...new Set(acIds)].sort(),
    dependencies: dependencyRefs(content, frontmatter),
  };
}

function readJsonFile(file: string | undefined): unknown {
  if (!file || !fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function manifestTickets(manifest: unknown): ManifestTicket[] {
  if (!isRecord(manifest) || !Array.isArray(manifest.tickets)) return [];
  return manifest.tickets.filter(isRecord);
}

function manifestRequirementIds(manifest: unknown): string[] {
  if (!isRecord(manifest)) return [];
  const ids = new Set<string>();
  for (const req of stringArray(manifest.requirements)) ids.add(req);
  if (isRecord(manifest.prd_requirements)) {
    for (const value of Object.values(manifest.prd_requirements)) {
      for (const req of stringArray(value)) ids.add(req);
    }
  }
  for (const ticket of manifestTickets(manifest)) {
    for (const req of stringArray(ticket.requirements)) ids.add(req);
  }
  return [...ids].sort();
}

function manifestRefs(manifest: unknown, tickets: TicketInfo[]): Set<string> {
  const refs = new Set<string>(tickets.flatMap((ticket) => [ticket.id, ticket.key].filter((value): value is string => Boolean(value))));
  for (const ticket of manifestTickets(manifest)) {
    if (typeof ticket.id === 'string') refs.add(ticket.id);
    if (typeof ticket.key === 'string') refs.add(ticket.key);
  }
  return refs;
}

function ticketRequirementIds(manifest: unknown, tickets: TicketInfo[]): Set<string> {
  const ids = new Set<string>(tickets.flatMap((ticket) => ticket.acIds));
  for (const ticket of manifestTickets(manifest)) {
    for (const ac of stringArray(ticket.ac_ids)) ids.add(ac);
    for (const req of stringArray(ticket.requirements)) ids.add(req);
  }
  return ids;
}

function findPrdMapFindings(tickets: TicketInfo[], manifest: unknown): ReadinessFinding[] {
  const mapped = ticketRequirementIds(manifest, tickets);
  return manifestRequirementIds(manifest)
    .filter((requirement) => !mapped.has(requirement))
    .map((requirement) => ({
      ticket: 'manifest',
      kind: 'prd_map' as const,
      analyst: 'gaps' as const,
      message: 'PRD requirement is not mapped to any ticket',
      detail: requirement,
    }));
}

function findPathFindings(ticket: TicketInfo, repoRoot: string, sessionDir: string): ReadinessFinding[] {
  const content = fs.readFileSync(ticket.file, 'utf-8');
  const refs = new Set<string>();
  for (const match of content.matchAll(PATH_RE)) refs.add(match[0]);
  return [...refs].sort()
    .filter((ref) => !resolvePathRef(ref, repoRoot, ticket.file, sessionDir))
    .map((ref) => ({
      ticket: ticket.file,
      kind: 'file_path' as const,
      analyst: 'codebase' as const,
      message: 'Referenced ticket file path does not resolve',
      detail: ref,
    }));
}

function findDependencyFindings(ticket: TicketInfo, refs: Set<string>): ReadinessFinding[] {
  return ticket.dependencies
    .filter((dep) => !dep.external && !refs.has(dep.ref))
    .map((dep) => ({
      ticket: ticket.file,
      kind: 'dependency' as const,
      analyst: 'risk' as const,
      message: 'Ticket dependency is not in the manifest and is not marked external',
      detail: dep.ref,
    }));
}

function displayTicketRef(sessionDir: string, ticket: string): string {
  return path.isAbsolute(ticket) ? path.relative(sessionDir, ticket) : ticket;
}

function readState(sessionDir: string): ReadinessStateShape {
  const statePath = path.join(sessionDir, 'state.json');
  if (!fs.existsSync(statePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf-8')) as ReadinessStateShape;
  } catch {
    return {};
  }
}

function writeState(sessionDir: string, state: ReadinessStateShape): void {
  const statePath = path.join(sessionDir, 'state.json');
  if (!fs.existsSync(statePath)) return;
  const sm = new StateManager();
  sm.update(statePath, (current) => {
    Object.assign(current, state);
  });
}

function readinessCycleHistory(state: ReadinessStateShape): ReadinessCycleHistoryEntry[] {
  const history = state.readiness?.cycle_history;
  if (!Array.isArray(history)) return [];
  return history.filter(isRecord).map((entry, index) => ({
    cycle: typeof entry.cycle === 'number' && Number.isFinite(entry.cycle) ? entry.cycle : index + 1,
    status: typeof entry.status === 'string' ? entry.status : '',
    suggested_analyst: typeof entry.suggested_analyst === 'string' ? entry.suggested_analyst : null,
    user_action: typeof entry.user_action === 'string' ? entry.user_action : null,
    timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : '',
  }));
}

function readinessCycleCount(sessionDir: string, state: ReadinessStateShape): number {
  if (Array.isArray(state.readiness?.cycle_history)) return state.readiness.cycle_history.length;
  return fs.readdirSync(sessionDir).filter((file) => /^readiness_\d{4}-\d{2}-\d{2}/.test(file)).length;
}

function appendReadinessCycle(sessionDir: string, state: ReadinessStateShape, findings: ReadinessFinding[], escalated: boolean): void {
  if (escalated) return;
  const existing = readinessCycleHistory(state);
  if (existing.length >= READINESS_MAX_RECYCLE_CYCLES) return;
  const next: ReadinessCycleHistoryEntry = {
    cycle: existing.length + 1,
    status: 'failed',
    suggested_analyst: findings[0]?.analyst ?? null,
    user_action: null,
    timestamp: new Date().toISOString(),
  };
  state.readiness = {
    ...(isRecord(state.readiness) ? state.readiness : {}),
    cycle_history: [...existing, next].slice(0, READINESS_MAX_RECYCLE_CYCLES),
  };
  writeState(sessionDir, state);
}

function hashFile(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readSnapshot(sessionDir: string): TicketSnapshot | undefined {
  const file = path.join(sessionDir, SNAPSHOT_FILE);
  if (!fs.existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as TicketSnapshot;
    return parsed && typeof parsed.hashes === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeSnapshot(sessionDir: string, ticketFiles: string[], ticketsVersion: number | undefined): void {
  const snapshot: TicketSnapshot = {
    ticketsVersion,
    hashes: Object.fromEntries(ticketFiles.map((file) => [path.relative(sessionDir, file), hashFile(file)])),
  };
  fs.writeFileSync(path.join(sessionDir, SNAPSHOT_FILE), JSON.stringify(snapshot, null, 2));
}

function getTicketsVersion(state: ReadinessStateShape): number | undefined {
  return typeof state.tickets_version === 'number' ? state.tickets_version : undefined;
}

function selectTicketFiles(sessionDir: string, state: ReadinessStateShape): { files: string[]; delta: boolean } {
  const allFiles = listLinearTicketFiles(sessionDir);
  const snapshot = readSnapshot(sessionDir);
  const ticketsVersion = getTicketsVersion(state);
  const hasCorrection = Array.isArray(state.activity) && state.activity.some((entry) => entry.event === 'course_corrected');
  const delta = Boolean(snapshot && ticketsVersion !== undefined && snapshot.ticketsVersion !== ticketsVersion && hasCorrection);
  if (!delta || !snapshot) return { files: allFiles, delta: false };
  return {
    files: allFiles.filter((file) => snapshot.hashes[path.relative(sessionDir, file)] !== hashFile(file)),
    delta: true,
  };
}

function writeReport(sessionDir: string, tickets: TicketInfo[], findings: ReadinessFinding[], escalation: boolean): string {
  const date = formatLocalDateKey(new Date());
  const filename = escalation ? `readiness_escalation_${date}.md` : `readiness_${date}.md`;
  const reportPath = path.join(sessionDir, filename);
  const prdMapRows = tickets.map((ticket) => `| ${ticket.id} | ${ticket.key ?? ''} | ${ticket.sourcePrd ?? ''} | ${ticket.sourceSection ?? ''} | ${ticket.acIds.join(', ')} |`);
  const acRows = tickets.flatMap((ticket) => extractAcceptanceCriteria(fs.readFileSync(ticket.file, 'utf-8')).map((ac) => `| ${path.relative(sessionDir, ticket.file)} | ${isMachineCheckable(ac) ? 'PASS' : 'FAIL'} | ${ac.replace(/\|/g, '\\|')} |`));
  const contractRows = findings
    .filter((finding) => finding.kind === 'contract')
    .map((finding) => `| ${displayTicketRef(sessionDir, finding.ticket)} | FAIL | ${finding.detail} | ${finding.analyst} |`);
  const lines = [
    `# ${escalation ? 'Readiness Escalation' : 'Readiness Failure'}`,
    '',
    `Date: ${date}`,
    '',
    '## PRD-ticket map',
    '',
    '| Ticket | Key | Source PRD | Source section | Mapped requirements |',
    '|---|---|---|---|---|',
    ...prdMapRows,
    ...findings.filter((finding) => finding.kind === 'prd_map').map((finding) => `| manifest |  |  |  | MISSING: ${finding.detail} |`),
    '',
    '## AC verifiability matrix',
    '',
    '| Ticket | Status | Criterion |',
    '|---|---|---|',
    ...acRows,
    '',
    '## Contract resolution table',
    '',
    '| Ticket | Status | Reference | Suggested analyst |',
    '|---|---|---|---|',
    ...(contractRows.length > 0 ? contractRows : ['| all | PASS |  |  |']),
    '',
    '## Findings',
    ...findings.map((finding) => [
      `- **${finding.kind}** in \`${displayTicketRef(sessionDir, finding.ticket)}\``,
      `  - suggested_analyst: ${finding.analyst}`,
      `  - ${finding.message}: \`${finding.detail}\``,
    ].join('\n')),
    '',
  ];
  fs.writeFileSync(reportPath, lines.join('\n'));
  return reportPath;
}

export function runReadiness(args: ReadinessArgs): { exitCode: number; findings: ReadinessFinding[]; reportPath?: string; delta: boolean; elapsed_ms: number } {
  const started = Date.now();
  const state = readState(args.sessionDir);
  const selected = selectTicketFiles(args.sessionDir, state);
  const checkMachinability = args.machinabilityOnly || !args.contractOnly;
  const checkContracts = args.contractOnly || !args.machinabilityOnly;
  const tickets = selected.files.map(ticketInfo);
  const manifestPath = args.manifest ? path.resolve(args.sessionDir, args.manifest) : path.join(args.sessionDir, 'decomposition_manifest.json');
  const manifest = readJsonFile(fs.existsSync(manifestPath) ? manifestPath : args.manifest);
  const refs = manifestRefs(manifest, tickets);
  const findings = [
    ...findPrdMapFindings(tickets, manifest),
    ...tickets.flatMap((ticket) => findPathFindings(ticket, args.repoRoot, args.sessionDir)),
    ...tickets.flatMap((ticket) => findDependencyFindings(ticket, refs)),
    ...selected.files.flatMap((file) => findReadinessFindings(file, args.repoRoot, { checkMachinability, checkContracts })),
  ];
  const ticketsVersion = getTicketsVersion(state);

  if (findings.length === 0) {
    writeSnapshot(args.sessionDir, listLinearTicketFiles(args.sessionDir), ticketsVersion);
    return { exitCode: 0, findings, delta: selected.delta, elapsed_ms: Date.now() - started };
  }

  const escalation = readinessCycleCount(args.sessionDir, state) >= READINESS_MAX_RECYCLE_CYCLES;
  const reportPath = writeReport(args.sessionDir, tickets, findings, escalation);
  appendReadinessCycle(args.sessionDir, state, findings, escalation);
  if (selected.delta) {
    logActivity({
      event: 'readiness_failed_post_correction',
      source: 'pickle',
      session: path.basename(args.sessionDir),
      gate_payload: { findings: findings.length, report: reportPath },
    });
  }
  return { exitCode: 2, findings, reportPath, delta: selected.delta, elapsed_ms: Date.now() - started };
}

export function runHistory(args: ReadinessArgs): string {
  const history = readinessCycleHistory(readState(args.sessionDir)).slice(-args.last);
  const rows = history.map((entry) => [
    entry.cycle,
    entry.status || '',
    entry.suggested_analyst ?? '',
    entry.user_action ?? '',
    entry.timestamp || '',
  ]);
  return [
    '| Cycle | Status | Suggested analyst | User action | Timestamp |',
    '|---:|---|---|---|---|',
    ...(rows.length > 0 ? rows.map((row) => `| ${row.join(' | ')} |`) : ['|  |  |  |  |  |']),
    '',
  ].join('\n');
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  try {
    if (args.history) {
      process.stdout.write(runHistory(args));
      process.exit(0);
    }
    const result = runReadiness(args);
    process.stdout.write(`${JSON.stringify({
      status: result.exitCode === 0 ? 'pass' : 'fail',
      findings: result.findings,
      elapsed_ms: result.elapsed_ms,
      report: result.reportPath,
      delta: result.delta,
    })}\n`);
    if (result.reportPath) process.stderr.write(`readiness failed: ${result.reportPath}\n`);
    process.exit(result.exitCode);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      status: 'error',
      findings: [],
      elapsed_ms: 0,
      error: safeErrorMessage(err),
    })}\n`);
    process.stderr.write(`check-readiness failed: ${safeErrorMessage(err)}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && path.basename(process.argv[1]) === 'check-readiness.js') {
  main();
}

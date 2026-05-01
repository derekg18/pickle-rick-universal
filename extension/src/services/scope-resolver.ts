// scope-resolver: parse CLI `--scope` flags, compute `allowed_paths`, and
// persist `scope.json` v1 at the session root. Pure parser + thin git-backed
// resolver. One-hop strategy is a stub here (A2 implements the expansion).
//
// SCOPE_LIMITATION: aliased-imports-not-detected
//   The one-hop strategy (ticket A2) walks single-level imports via grep over
//   raw import/require strings. TypeScript `paths` aliases, Webpack/Vite
//   resolver aliases, and runtime string concatenation are NOT traversed —
//   an aliased dependency will look import-free to the grep and be excluded
//   from the expanded set. Operators relying on path aliases must widen
//   scope manually with `--scope paths:<glob>`.

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { runGit, getHeadSha, getDiffFiles, getMergeBase } from './git-utils.js';
import { StateManager } from './state-manager.js';
import type { State } from '../types/index.js';

export type ScopeMode = 'branch' | 'diff' | 'paths';
export type ScopeStrategy = 'strict' | 'one-hop';

/** Max number of seed files permitted for one-hop expansion. Above this, throw SCOPE_ONE_HOP_TOO_LARGE. */
const ONE_HOP_FILE_CAP = 100;

/**
 * Per-subprocess timeout for the rg/grep importer-walk in {@link findImporters}.
 * Without this, a wedged ripgrep/grep (FIFO under repoRoot, stuck FUSE mount,
 * catastrophic regex backtracking) blocks scope resolution indefinitely with
 * no log output — the same silent-hang class as the council-publish `gh`
 * timeout gap. See `extension/CLAUDE.md` trap doors.
 */
const FIND_IMPORTERS_TIMEOUT_MS = 30_000;

export type ScopeErrorCode =
  | 'SCOPE_EMPTY_DIFF'
  | 'SCOPE_EMPTY_PATHS'
  | 'SCOPE_NOT_A_REPO'
  | 'SCOPE_BASE_MISSING'
  | 'SCOPE_BAD_FLAG'
  | 'SCOPE_ONE_HOP_TOO_LARGE'
  | 'SCOPE_EMPTY_POST_BUILD'
  | 'SCOPE_ARCHIVE_EXISTS';

export interface ScopeArgs {
  scopeFlag: string;
  scopeBase?: string;
  target?: string;
  sessionRoot: string;
  repoRoot: string;
}

export interface RefreshEntry {
  phase: string;
  head_sha: string | null;
  resolved_at: string;
}

export interface ScopeJson {
  version: 1;
  mode: ScopeMode;
  strategy: ScopeStrategy;
  base_ref: string | null;
  base_sha: string | null;
  head_sha: string | null;
  allowed_paths: string[];
  resolved_at: string;
  refresh_history: RefreshEntry[];
}

export interface ParsedScope {
  mode: ScopeMode;
  strategy: ScopeStrategy;
  base: string | null;
}

export class ScopeError extends Error {
  readonly code: ScopeErrorCode;
  constructor(code: ScopeErrorCode, message: string) {
    super(message);
    this.name = 'ScopeError';
    this.code = code;
  }
}

/**
 * Parse the raw `--scope <flag>` value into `{mode, strategy, base}`.
 * `base` carries the inline ref for `diff:<ref>` and the glob list for
 * `paths:<glob,glob>`; `null` for bare/strict branch forms.
 * Throws `ScopeError('SCOPE_BAD_FLAG', …)` on unknown input.
 */
export function parseScope(flag: string): ParsedScope {
  if (typeof flag !== 'string' || flag.length === 0) {
    throw new ScopeError('SCOPE_BAD_FLAG', `Unrecognized --scope value: ${JSON.stringify(flag)}`);
  }
  if (flag === 'branch' || flag === 'branch:strict') {
    return { mode: 'branch', strategy: 'strict', base: null };
  }
  if (flag === 'branch:one-hop') {
    return { mode: 'branch', strategy: 'one-hop', base: null };
  }
  if (flag.startsWith('diff:')) {
    const parts = flag.split(':');
    if (parts.length === 2 && parts[1].length > 0) {
      return { mode: 'diff', strategy: 'strict', base: parts[1] };
    }
    if (parts.length === 3 && parts[1].length > 0 && parts[2] === 'one-hop') {
      return { mode: 'diff', strategy: 'one-hop', base: parts[1] };
    }
    throw new ScopeError('SCOPE_BAD_FLAG', `Malformed --scope diff form: ${flag}`);
  }
  if (flag.startsWith('paths:')) {
    const rest = flag.slice('paths:'.length);
    if (rest.length === 0) {
      throw new ScopeError('SCOPE_BAD_FLAG', `--scope paths: requires at least one glob`);
    }
    return { mode: 'paths', strategy: 'strict', base: rest };
  }
  throw new ScopeError('SCOPE_BAD_FLAG', `Unrecognized --scope value: ${flag}`);
}

/**
 * Resolve `args` into a `ScopeJson` and persist it atomically to
 * `${sessionRoot}/scope.json`.
 *
 * Semantics:
 * - `branch` / `diff:<ref>`: diff base…HEAD, include A/M/R-new, exclude D/B.
 * - `paths:<glob,…>`: comma-split globs matched against `git ls-files -co
 *   --exclude-standard`. Zero match → `SCOPE_EMPTY_PATHS`.
 * - Base default for branch: `--scope-base` > upstream > `main`.
 * - `allowed_paths` sorted byte-order (FR-27, locale-independent).
 *
 * `strategy:'one-hop'` expands `allowed_paths` to include one-hop importers
 * via `computeOneHop`. See that function for grep-based limitations.
 */
export function resolveScope(args: ScopeArgs): ScopeJson {
  const { repoRoot, sessionRoot } = args;
  assertIsRepo(repoRoot);

  const parsed = parseScope(args.scopeFlag);
  const headSha = getHeadSha(repoRoot);

  const resolved = parsed.mode === 'paths'
    ? { allowed: resolveAllowedFromPaths(parsed.base, args.target, repoRoot), baseRef: null as string | null, baseSha: null as string | null }
    : resolveAllowedFromDiffMode(parsed, args, headSha, repoRoot);

  const base = Array.from(new Set(resolved.allowed.map(toPosix)));
  const expanded = parsed.strategy === 'one-hop' ? computeOneHop(base, repoRoot) : base;
  const normalized = expanded.sort(byteOrder);

  const scope: ScopeJson = {
    version: 1,
    mode: parsed.mode,
    strategy: parsed.strategy,
    base_ref: resolved.baseRef,
    base_sha: resolved.baseSha,
    head_sha: headSha,
    allowed_paths: normalized,
    resolved_at: new Date().toISOString(),
    refresh_history: [],
  };

  writeScopeJson(path.join(sessionRoot, 'scope.json'), scope);
  return scope;
}

function resolveAllowedFromPaths(
  globSpec: string | null,
  target: string | undefined,
  repoRoot: string,
): string[] {
  const globs = (globSpec ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (globs.length === 0) {
    throw new ScopeError('SCOPE_BAD_FLAG', `--scope paths: requires at least one non-empty glob`);
  }
  const tree = listTrackedAndUntracked(repoRoot);
  const matched = tree.filter((p) => globs.some((g) => globMatch(g, p)));
  const allowed = filterByTarget(matched, target, repoRoot);
  if (allowed.length === 0) {
    throw new ScopeError(
      'SCOPE_EMPTY_PATHS',
      `--scope paths:${globSpec} matched zero files under ${repoRoot}`,
    );
  }
  return allowed;
}

function resolveAllowedFromDiffMode(
  parsed: ParsedScope,
  args: ScopeArgs,
  headSha: string,
  repoRoot: string,
): { allowed: string[]; baseRef: string; baseSha: string } {
  const baseRef = parsed.mode === 'diff'
    ? parsed.base
    : (args.scopeBase ?? resolveDefaultBase(repoRoot));
  if (!baseRef) {
    throw new ScopeError('SCOPE_BAD_FLAG', `Malformed --scope diff form: expected diff:<ref>, got ${args.scopeFlag}`);
  }
  let baseSha: string;
  try {
    baseSha = getMergeBase(baseRef, 'HEAD', repoRoot);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ScopeError('SCOPE_BASE_MISSING', `Base ref "${baseRef}" not resolvable: ${msg}`);
  }
  let paths: string[];
  try {
    paths = computeAllowedFromDiff(baseSha, headSha, repoRoot);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ScopeError('SCOPE_BASE_MISSING', `Diff ${baseSha}...HEAD failed: ${msg}`);
  }
  const allowed = filterByTarget(paths, args.target, repoRoot);
  if (allowed.length === 0) {
    throw new ScopeError(
      'SCOPE_EMPTY_DIFF',
      `No files changed between ${baseRef} and HEAD for mode=${parsed.mode}`,
    );
  }
  return { allowed, baseRef, baseSha };
}

/**
 * Shared filter for the `base…head` diff: emit repo-relative POSIX paths for
 * A/M/R-new entries, with binary files removed. Used by both `resolveScope`
 * and `refreshScope` so future changes to the inclusion rules live in one
 * place. Throws the raw `getDiffFiles` error — callers add context.
 */
function computeAllowedFromDiff(baseSha: string, headSha: string, repoRoot: string): string[] {
  const diff = getDiffFiles(baseSha, headSha, repoRoot);
  const binaries = getBinaryPathSet(baseSha, headSha, repoRoot);
  return diff
    .filter((d) => d.status === 'A' || d.status === 'M' || d.status === 'R')
    .map((d) => d.path)
    .filter((p) => !binaries.has(toPosix(p)));
}

export interface RefreshScopeOpts {
  repoRoot?: string;
  target?: string;
  log?: (msg: string) => void;
}

/**
 * Per-phase scope refresh. Idempotent: if `phase` is already recorded in
 * `state.phases_entered`, returns the existing scope.json unchanged.
 *
 * Invariants:
 * - `base_sha` and `base_ref` are frozen from the setup-time scope.json.
 * - `head_sha` is recomputed via `getHeadSha(repoRoot)`.
 * - `allowed_paths` is recomputed against the new HEAD for diff modes; for
 *   `paths` mode the list is preserved (no HEAD dependency).
 * - A `RefreshEntry` is appended to `scope.json.refresh_history`.
 * - `archive/scope.<phase>.json` is written atomically and REFUSES to
 *   overwrite — a collision throws `SCOPE_ARCHIVE_EXISTS` since that indicates
 *   a bug (the idempotency gate should have caught it).
 * - `state.phases_entered` is extended with `phase` under state-manager lock.
 *
 * Emits `scope-refresh: phase=<p> head=<sha> allowed=<N>` via `opts.log`
 * (default: stderr).
 *
 * Returns `null` if the session is not scope-configured (no scope.json) or if
 * the phase has already been entered.
 *
 * Throws `SCOPE_EMPTY_POST_BUILD` when the diff collapses to zero files and
 * `phase === 'anatomy-park'` — the build phase produced no review surface.
 */
export function refreshScope(
  sessionRoot: string,
  phase: string,
  opts: RefreshScopeOpts = {},
): ScopeJson | null {
  const statePath = path.join(sessionRoot, 'state.json');
  const sm = new StateManager();
  if (isPhaseAlreadyEntered(sm, statePath, phase)) return null;

  const scopePath = path.join(sessionRoot, 'scope.json');
  const scope = readScopeJson(scopePath);
  if (!scope) return null;
  const repoRoot = opts.repoRoot ?? resolveRepoRootFromState(sm, statePath);
  const log = opts.log ?? ((msg: string) => { process.stderr.write(`${msg}\n`); });
  const newHead = getHeadSha(repoRoot);

  const newAllowed = computeRefreshedAllowed(scope, newHead, repoRoot, opts.target);
  if (newAllowed.length === 0 && phase === 'anatomy-park') {
    throw new ScopeError(
      'SCOPE_EMPTY_POST_BUILD',
      `refreshScope: diff ${scope.base_sha}...${newHead} is empty at phase=${phase}; the build phase produced no review surface`,
    );
  }

  const resolvedAt = new Date().toISOString();
  const refreshed: ScopeJson = {
    ...scope,
    head_sha: newHead,
    allowed_paths: newAllowed,
    resolved_at: resolvedAt,
    refresh_history: [...scope.refresh_history, { phase, head_sha: newHead, resolved_at: resolvedAt }],
  };

  persistRefreshedScope(sessionRoot, scopePath, refreshed, sm, statePath, phase);
  log(`scope-refresh: phase=${phase} head=${newHead} allowed=${newAllowed.length}`);
  return refreshed;
}

function isPhaseAlreadyEntered(sm: StateManager, statePath: string, phase: string): boolean {
  if (!fs.existsSync(statePath)) return false;
  try {
    const state = sm.read(statePath);
    return (state.phases_entered ?? []).includes(phase);
  } catch {
    return false;
  }
}

function resolveRepoRootFromState(sm: StateManager, statePath: string): string {
  if (!fs.existsSync(statePath)) {
    throw new ScopeError('SCOPE_NOT_A_REPO', `refreshScope: no repoRoot given and no state.json at ${statePath}`);
  }
  return sm.read(statePath).working_dir;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readScopeJson(scopePath: string): ScopeJson | null {
  let base: ScopeJson | null = null;
  let baseMtimeMs = 0;
  try {
    base = JSON.parse(fs.readFileSync(scopePath, 'utf-8')) as ScopeJson;
    baseMtimeMs = fs.statSync(scopePath).mtimeMs;
  } catch {
    // A killed initial writer may leave the only valid scope in a sibling tmp.
  }
  const dir = path.dirname(scopePath);
  const baseName = path.basename(scopePath);
  const tmpPattern = new RegExp(`^${baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.tmp\\.(\\d+)$`);
  let winner: { path: string; scope: ScopeJson; mtimeMs: number } | null = null;

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return base;
  }

  for (const entry of entries) {
    const match = entry.match(tmpPattern);
    if (!match) continue;
    const tmpPid = Number(match[1]);
    if (Number.isFinite(tmpPid) && isProcessAlive(tmpPid)) continue;

    const tmpPath = path.join(dir, entry);
    try {
      const scope = JSON.parse(fs.readFileSync(tmpPath, 'utf-8')) as ScopeJson;
      const mtimeMs = fs.statSync(tmpPath).mtimeMs;
      if (mtimeMs <= baseMtimeMs) {
        fs.unlinkSync(tmpPath);
        continue;
      }
      if (!winner || mtimeMs > winner.mtimeMs) {
        winner = { path: tmpPath, scope, mtimeMs };
      }
    } catch {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore invalid tmp cleanup failure */ }
    }
  }

  if (!winner) return base;
  try {
    fs.renameSync(winner.path, scopePath);
    return winner.scope;
  } catch {
    return base;
  }
}

function computeRefreshedAllowed(
  scope: ScopeJson,
  newHead: string,
  repoRoot: string,
  target: string | undefined,
): string[] {
  if (scope.mode === 'paths') return scope.allowed_paths.slice();
  if (!scope.base_sha) {
    throw new ScopeError('SCOPE_BASE_MISSING', `refreshScope: scope.json has no base_sha for mode=${scope.mode}`);
  }
  let base: string[];
  try {
    base = computeAllowedFromDiff(scope.base_sha, newHead, repoRoot);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ScopeError('SCOPE_BASE_MISSING', `refreshScope: diff ${scope.base_sha}...${newHead} failed: ${msg}`);
  }
  const narrowed = filterByTarget(base, target, repoRoot);
  const expanded = scope.strategy === 'one-hop' ? computeOneHop(narrowed, repoRoot) : narrowed;
  return Array.from(new Set(expanded.map(toPosix))).sort(byteOrder);
}

function persistRefreshedScope(
  sessionRoot: string,
  scopePath: string,
  refreshed: ScopeJson,
  sm: StateManager,
  statePath: string,
  phase: string,
): void {
  const archiveDir = path.join(sessionRoot, 'archive');
  fs.mkdirSync(archiveDir, { recursive: true });
  writeScopeArchive(path.join(archiveDir, `scope.${phase}.json`), refreshed);
  writeScopeJson(scopePath, refreshed);
  if (fs.existsSync(statePath)) {
    sm.update(statePath, (s: State) => {
      s.phases_entered = [...(s.phases_entered ?? []), phase];
    });
  }
}

/**
 * Narrow a subsystem-name list to those whose directory (resolved relative
 * to `target`) contains at least one `allowedPaths` entry.
 *
 * `subsystems` are names relative to `target`; `allowedPaths` are
 * repo-relative POSIX paths; `target` and `repoRoot` are absolute.
 * Returns sorted byte-order unique names.
 */
export function filterBySubsystem(
  subsystems: string[],
  allowedPaths: string[],
  target: string,
  repoRoot: string,
): string[] {
  if (subsystems.length === 0 || allowedPaths.length === 0) return [];
  const kept = new Set<string>();
  const allowedSet = new Set(allowedPaths.map(toPosix));
  for (const name of subsystems) {
    const absDir = path.resolve(target, name);
    const relDir = toPosix(path.relative(repoRoot, absDir));
    const prefix = relDir.length === 0 ? '' : relDir.endsWith('/') ? relDir : `${relDir}/`;
    for (const ap of allowedSet) {
      if (prefix === '' || ap === relDir || ap.startsWith(prefix)) {
        kept.add(name);
        break;
      }
    }
  }
  return Array.from(kept).sort(byteOrder);
}

/**
 * Filter `globbedFiles` (absolute) to those present in `allowedPaths`
 * (repo-relative POSIX). Preserves input order.
 */
export function filterByPaths(
  globbedFiles: string[],
  allowedPaths: string[],
  repoRoot: string,
): string[] {
  const allowed = new Set(allowedPaths.map(toPosix));
  return globbedFiles.filter((abs) => allowed.has(toPosix(path.relative(repoRoot, abs))));
}

/**
 * Canonical JSON Schema (Draft 2020-12) for `ScopeJson`. Single source of
 * truth for the committed `extension/schemas/scope-v1.json`; the parity
 * script re-derives and diffs against the committed file.
 */
export function buildScopeV1Schema(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://pickle-rick/schemas/scope-v1.json',
    title: 'ScopeJson',
    type: 'object',
    additionalProperties: false,
    required: [
      'version',
      'mode',
      'strategy',
      'base_ref',
      'base_sha',
      'head_sha',
      'allowed_paths',
      'resolved_at',
      'refresh_history',
    ],
    properties: {
      version: { const: 1 },
      mode: { type: 'string', enum: ['branch', 'diff', 'paths'] },
      strategy: { type: 'string', enum: ['strict', 'one-hop'] },
      base_ref: { type: ['string', 'null'] },
      base_sha: { type: ['string', 'null'] },
      head_sha: { type: ['string', 'null'] },
      allowed_paths: {
        type: 'array',
        items: { type: 'string' },
      },
      resolved_at: { type: 'string', format: 'date-time' },
      refresh_history: {
        type: 'array',
        maxItems: 16,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['phase', 'head_sha', 'resolved_at'],
          properties: {
            phase: { type: 'string' },
            head_sha: { type: ['string', 'null'] },
            resolved_at: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
  };
}

/**
 * Expand `diffFiles` to include files that import any export from the diffed
 * set — a single-level blast-radius walk using rg/grep over raw import
 * strings (language-agnostic, no AST).
 *
 * Limitation (SCOPE_LIMITATION: aliased-imports-not-detected): the grep
 * pattern requires the export name to be followed by `,` or `}` within the
 * import brace list. aliased imports (`import { foo as bar }`) are therefore
 * not detected — `foo` is followed by ` as`, which fails the `\s*[,}]` check.
 * Operators relying on aliased re-exports must widen scope manually with
 * `--scope paths:<glob>`.
 *
 * Throws `SCOPE_ONE_HOP_TOO_LARGE` if `diffFiles.length > ONE_HOP_FILE_CAP`.
 *
 * `options.findImportersTimeoutMs` caps the rg/grep subprocess wall-time used
 * by the importer walk. Defaults to {@link FIND_IMPORTERS_TIMEOUT_MS} (30s).
 * Tests inject small values to assert the hang-guard fires.
 */
export function computeOneHop(
  diffFiles: string[],
  repoRoot: string,
  options: { findImportersTimeoutMs?: number } = {},
): string[] {
  if (diffFiles.length > ONE_HOP_FILE_CAP) {
    throw new ScopeError(
      'SCOPE_ONE_HOP_TOO_LARGE',
      `--scope branch:one-hop diff has ${diffFiles.length} files (max ${ONE_HOP_FILE_CAP}). ` +
        `Use --scope paths:<glob> to narrow scope or omit :one-hop for strict mode.`,
    );
  }

  const timeoutMs = options.findImportersTimeoutMs ?? FIND_IMPORTERS_TIMEOUT_MS;
  const exportNames = extractExportNames(diffFiles, repoRoot);
  const importerSet = new Set<string>(diffFiles.map(toPosix));

  for (const name of exportNames) {
    for (const f of findImporters(name, repoRoot, timeoutMs)) {
      importerSet.add(f);
    }
  }

  return Array.from(importerSet).sort(byteOrder);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function assertIsRepo(repoRoot: string): void {
  const out = runGit(['rev-parse', '--git-dir'], repoRoot, false);
  if (!out || out.length === 0) {
    throw new ScopeError('SCOPE_NOT_A_REPO', `Not a git repository: ${repoRoot}`);
  }
}

function resolveDefaultBase(repoRoot: string): string {
  const upstream = runGit(['rev-parse', '--symbolic-full-name', '@{upstream}'], repoRoot, false);
  if (upstream && upstream.trim().length > 0) return upstream.trim();
  return 'main';
}

function listTrackedAndUntracked(repoRoot: string): string[] {
  const out = runGit(['ls-files', '-co', '--exclude-standard', '-z'], repoRoot, false);
  if (!out) return [];
  return out.split('\0').filter((p) => p.length > 0);
}

function getBinaryPathSet(baseSha: string, headSha: string, repoRoot: string): Set<string> {
  const out = runGit(['diff', '--numstat', `${baseSha}...${headSha}`], repoRoot, false);
  const binaries = new Set<string>();
  if (!out) return binaries;
  for (const line of out.split('\n')) {
    const m = /^-\t-\t(.+)/.exec(line);
    if (m) binaries.add(toPosix(m[1]));
  }
  return binaries;
}

function filterByTarget(paths: string[], target: string | undefined, repoRoot: string): string[] {
  if (!target) return paths;
  const relTarget = toPosix(path.relative(repoRoot, path.resolve(target)));
  if (relTarget.length === 0) return paths;
  const prefix = relTarget.endsWith('/') ? relTarget : `${relTarget}/`;
  return paths.filter((p) => {
    const posix = toPosix(p);
    return posix === relTarget || posix.startsWith(prefix);
  });
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function byteOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function globMatch(glob: string, candidate: string): boolean {
  const pattern = globToRegex(glob);
  return pattern.test(candidate);
}

function globToRegex(glob: string): RegExp {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i += 2;
        if (glob[i] === '/') i += 1;
        continue;
      }
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
    i += 1;
  }
  return new RegExp(`^${re}$`);
}

function writeScopeJson(filePath: string, scope: ScopeJson): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(scope, null, 2));
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore cleanup failure */ }
    throw err;
  }
}

/**
 * Atomic archive writer that refuses to overwrite. If `filePath` already
 * exists, throws `SCOPE_ARCHIVE_EXISTS` — the `phases_entered` idempotency
 * gate should have prevented this; collision signals a bug.
 */
function writeScopeArchive(filePath: string, scope: ScopeJson): void {
  if (fs.existsSync(filePath)) {
    throw new ScopeError('SCOPE_ARCHIVE_EXISTS', `refreshScope: archive already exists (refusing overwrite): ${filePath}`);
  }
  writeScopeJson(filePath, scope);
}

function extractExportNames(diffFiles: string[], repoRoot: string): Set<string> {
  const names = new Set<string>();
  for (const relPath of diffFiles) {
    let content: string;
    try {
      content = fs.readFileSync(path.resolve(repoRoot, relPath), 'utf-8');
    } catch {
      continue;
    }
    for (const m of content.matchAll(
      /^export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|class|const|let|var|type|interface|enum)\s+(\w+)/gm,
    )) {
      names.add(m[1]);
    }
    for (const m of content.matchAll(/^export\s+(?:type\s+)?\{([^}]+)\}/gm)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        if (/^\w+$/.test(name)) names.add(name);
      }
    }
    for (const m of content.matchAll(/^export\s+default\s+(\w+)/gm)) {
      names.add(m[1]);
    }
  }
  return names;
}

function findImporters(name: string, repoRoot: string, timeoutMs: number): string[] {
  // Matches default imports and named imports.
  // aliased imports (`{ foo as bar }`) are NOT matched: `\bfoo\b\s*[,}]`
  // requires , or } after foo — ` as` does not satisfy this (documented miss).
  const pattern = `import\\s+${name}\\b|import[^{;]*\\{[^}]*\\b${name}\\b\\s*[,}]`;
  const rgMatches = _runRgImportWalk(pattern, repoRoot, timeoutMs);
  if (rgMatches.length > 0) return rgMatches;
  return _runGrepImportWalk(pattern, repoRoot, timeoutMs);
}

function _runRgImportWalk(pattern: string, root: string, timeoutMs: number): string[] {
  // `timeout` guards against a wedged rg/grep (FIFO under repoRoot, stuck
  // FUSE mount, catastrophic backtracking) that would otherwise block the
  // entire scope-resolution phase indefinitely with no log output.
  const rg = spawnSync('rg', ['-l', '--glob', '*.{ts,tsx,js,jsx,mjs,cjs}', '-e', pattern, '.'], {
    cwd: root,
    encoding: 'utf-8',
    timeout: timeoutMs,
  });
  if (!rg.error && (rg.status === 0 || rg.status === 1)) {
    return (rg.stdout || '')
      .split('\n')
      .filter((f) => f.length > 0)
      .map((f) => toPosix(f.replace(/^\.\//, '')));
  }
  const errorCode = (rg.error as NodeJS.ErrnoException | undefined)?.code;
  console.warn(`scope-resolver import walk: rg ${errorCode === 'ETIMEDOUT' ? 'timeout' : 'fail'} status=${rg.status ?? 'null'} signal=${rg.signal ?? 'null'} error=${errorCode ?? 'none'}`);
  return [];
}

function _runGrepImportWalk(pattern: string, root: string, timeoutMs: number): string[] {
  const grep = spawnSync(
    'grep',
    ['-rl', '-E', '--include=*.ts', '--include=*.tsx', '--include=*.js', '--include=*.jsx',
      pattern, '.'],
    { cwd: root, encoding: 'utf-8', timeout: timeoutMs },
  );
  if (grep.status === 0 || grep.status === 1) {
    return (grep.stdout || '')
      .split('\n')
      .filter((f) => f.length > 0)
      .map((f) => toPosix(f.replace(/^\.\//, '')));
  }
  const errorCode = (grep.error as NodeJS.ErrnoException | undefined)?.code;
  console.warn(`scope-resolver import walk: grep ${errorCode === 'ETIMEDOUT' ? 'timeout' : 'fail'} status=${grep.status ?? 'null'} signal=${grep.signal ?? 'null'} error=${errorCode ?? 'none'}`);
  return [];
}

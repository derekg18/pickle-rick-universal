import * as fs from 'fs';
import * as path from 'path';
import { isoCompactStamp, safeErrorMessage } from '../services/pickle-utils.js';
import { readRecoverableJsonObject } from '../services/microverse-state.js';
import type { GateResult, GateFailure } from '../types/index.js';

const USAGE = 'Usage: spawn-gate-remediator --gate-result <path> --session-root <path> --reason strict|per-iteration';
const LOCKFILE_NAME = 'remediator.lockfile';
const MAX_FILE_BYTES = 50_000;
const VALID_REASONS = new Set(['strict', 'per-iteration']);

export interface SpawnGateRemediatorOpts {
  argv: string[];
  isoOverride?: string;
  extensionClaudeMdContent?: string;
  readFileFn?: (p: string, enc: 'utf-8') => string;
  openSyncFn?: (p: string, flags: number) => number;
  closeSyncFn?: (fd: number) => void;
  writeFileFn?: (p: string, data: string, enc: 'utf-8') => void;
  mkdirSyncFn?: (p: string, opts: { recursive: boolean }) => void;
  unlinkSyncFn?: (p: string) => void;
  existsSyncFn?: (p: string) => boolean;
  stdout?: (msg: string) => void;
  stderr?: (msg: string) => void;
}

type ReadFileFn = (p: string, enc: 'utf-8') => string;
type WriteFileFn = (p: string, data: string, enc: 'utf-8') => void;
type MkdirSyncFn = (p: string, opts: { recursive: boolean }) => void;
type OpenSyncFn = (p: string, flags: number) => number;
type CloseSyncFn = (fd: number) => void;
type UnlinkSyncFn = (p: string) => void;
type ExistsSyncFn = (p: string) => boolean;
type OutputFn = (msg: string) => void;

interface RemediatorDeps {
  readFile: ReadFileFn;
  writeFile: WriteFileFn;
  mkdirSync: MkdirSyncFn;
  openSync: OpenSyncFn;
  closeSync: CloseSyncFn;
  unlinkSync: UnlinkSyncFn;
  existsSync: ExistsSyncFn;
  stdout: OutputFn;
  stderr: OutputFn;
  hasInjectedReadFile: boolean;
}

interface ParsedArgs {
  gateResultPath: string;
  sessionRoot: string;
  reason: string;
}

function parseFlag(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}

function resolveDeps(opts: SpawnGateRemediatorOpts): RemediatorDeps {
  return {
    readFile: opts.readFileFn ?? ((p: string, enc: 'utf-8') => fs.readFileSync(p, enc)),
    writeFile: opts.writeFileFn ?? ((p: string, data: string, enc: 'utf-8') => fs.writeFileSync(p, data, enc)),
    mkdirSync: opts.mkdirSyncFn ?? ((p: string, o: { recursive: boolean }) => fs.mkdirSync(p, o)),
    openSync: opts.openSyncFn ?? ((p: string, flags: number) => fs.openSync(p, flags)),
    closeSync: opts.closeSyncFn ?? ((fd: number) => fs.closeSync(fd)),
    unlinkSync: opts.unlinkSyncFn ?? ((p: string) => fs.unlinkSync(p)),
    existsSync: opts.existsSyncFn ?? ((p: string) => fs.existsSync(p)),
    stdout: opts.stdout ?? ((msg: string) => process.stdout.write(msg + '\n')),
    stderr: opts.stderr ?? ((msg: string) => process.stderr.write(msg + '\n')),
    hasInjectedReadFile: typeof opts.readFileFn === 'function',
  };
}

function parseArgs(argv: string[], stderr: OutputFn): ParsedArgs | undefined {
  const gateResultPath = parseFlag(argv, '--gate-result');
  const sessionRoot = parseFlag(argv, '--session-root');
  const reason = parseFlag(argv, '--reason');

  if (!gateResultPath || !sessionRoot || !reason) {
    stderr(`Missing required flags.\n${USAGE}`);
    return undefined;
  }

  if (!VALID_REASONS.has(reason)) {
    stderr(`--reason must be strict|per-iteration, got: ${reason}`);
    return undefined;
  }

  return { gateResultPath, sessionRoot, reason };
}

const VALID_GATE_STATUSES = new Set<string>(['green', 'red', 'green-with-known-flake-warnings']);
const VALID_FAILURE_CHECKS = new Set<string>(['typecheck', 'lint', 'tests']);
const VALID_FAILURE_SEVERITIES = new Set<string>(['error', 'warning']);

function isGateFailure(v: unknown): v is GateFailure {
  if (!v || typeof v !== 'object') return false;
  const f = v as Record<string, unknown>;
  return (
    typeof f['check'] === 'string' && VALID_FAILURE_CHECKS.has(f['check']) &&
    typeof f['file'] === 'string' &&
    typeof f['line'] === 'number' &&
    typeof f['ruleOrCode'] === 'string' &&
    typeof f['message'] === 'string' &&
    typeof f['severity'] === 'string' && VALID_FAILURE_SEVERITIES.has(f['severity']) &&
    typeof f['occurrence_index'] === 'number'
  );
}

function isGateResult(v: unknown): v is GateResult {
  if (!v || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj['status'] === 'string' && VALID_GATE_STATUSES.has(obj['status']) &&
    Array.isArray(obj['failures']) && obj['failures'].every(isGateFailure) &&
    typeof obj['elapsed_ms'] === 'number'
  );
}

function readGateResult(args: ParsedArgs, deps: RemediatorDeps): GateResult | undefined {
  try {
    const raw = !deps.hasInjectedReadFile
      ? readRecoverableJsonObject(args.gateResultPath)
      : JSON.parse(deps.readFile(args.gateResultPath, 'utf-8'));
    if (raw === null) {
      throw new Error('gate-result JSON is missing, malformed, or not an object');
    }
    if (!isGateResult(raw)) {
      deps.stderr(`gate-result JSON at ${args.gateResultPath} is not a valid GateResult`);
      return undefined;
    }
    return raw;
  } catch (e) {
    deps.stderr(`Failed to read --gate-result ${args.gateResultPath}: ${safeErrorMessage(e)}`);
    return undefined;
  }
}

function createGateDir(sessionRoot: string, deps: RemediatorDeps): string | undefined {
  const gateDir = path.join(sessionRoot, 'gate');
  try {
    deps.mkdirSync(gateDir, { recursive: true });
    return gateDir;
  } catch (e) {
    deps.stderr(`Failed to create gate dir ${gateDir}: ${safeErrorMessage(e)}`);
    return undefined;
  }
}

function writeConcurrentLockout(opts: {
  gateDir: string;
  lockfilePath: string;
  sessionRoot: string;
  reason: string;
  iso: string;
  deps: RemediatorDeps;
}): void {
  const { gateDir, lockfilePath, sessionRoot, reason, iso, deps } = opts;
  const lockoutPath = path.join(gateDir, `remediator_concurrent_lockout_${iso}.md`);
  const lockoutContent = [
    `# Concurrent Remediator Lockout`,
    ``,
    `A remediator is already running (lockfile present at \`${lockfilePath}\`).`,
    ``,
    `**Timestamp**: ${iso}`,
    `**Session root**: ${sessionRoot}`,
    `**Reason requested**: ${reason}`,
    ``,
    `This invocation exited cleanly without performing any work. The active remediator will complete and release the lock.`,
  ].join('\n');

  try {
    deps.writeFile(lockoutPath, lockoutContent, 'utf-8');
    deps.stdout(`LOCKOUT_PATH=${lockoutPath}`);
  } catch { /* best-effort */ }
}

function acquireRemediatorLock(opts: {
  gateDir: string;
  sessionRoot: string;
  reason: string;
  iso: string;
  deps: RemediatorDeps;
}): { status: 'acquired'; lockfilePath: string } | { status: 'lockout' } | { status: 'error' } {
  const { gateDir, sessionRoot, reason, iso, deps } = opts;
  const lockfilePath = path.join(gateDir, LOCKFILE_NAME);

  try {
    const fd = deps.openSync(lockfilePath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
    deps.closeSync(fd);
    return { status: 'acquired', lockfilePath };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      writeConcurrentLockout({ gateDir, lockfilePath, sessionRoot, reason, iso, deps });
      return { status: 'lockout' };
    }
    deps.stderr(`Failed to acquire lockfile ${lockfilePath}: ${safeErrorMessage(e)}`);
    return { status: 'error' };
  }
}

function removeLockfile(lockfilePath: string, deps: RemediatorDeps): void {
  try {
    if (deps.existsSync(lockfilePath)) deps.unlinkSync(lockfilePath);
  } catch { /* already gone */ }
}

function collectFailingFileContents(gateResult: GateResult, readFile: ReadFileFn): Map<string, string> {
  const failingFileContents = new Map<string, string>();
  const failingFiles = [...new Set(gateResult.failures.map(f => f.file))];

  for (const filePath of failingFiles) {
    try {
      const raw = readFile(filePath, 'utf-8');
      failingFileContents.set(filePath, raw.length > MAX_FILE_BYTES ? '__OVERSIZED__' : raw);
    } catch {
      failingFileContents.set(filePath, '__UNREADABLE__');
    }
  }

  return failingFileContents;
}

function loadTrapDoorSection(extensionClaudeMdContent: string | undefined, readFile: ReadFileFn): string {
  if (extensionClaudeMdContent) return extensionClaudeMdContent;

  const claudeMdPath = path.join(
    path.dirname(path.dirname(new URL(import.meta.url).pathname)),
    'CLAUDE.md'
  );
  try {
    return readFile(claudeMdPath, 'utf-8');
  } catch {
    return '_CLAUDE.md trap-door section not available at brief-prep time. Read extension/CLAUDE.md before editing._';
  }
}

function writeRemediationBrief(opts: {
  gateDir: string;
  gateResult: GateResult;
  sessionRoot: string;
  reason: string;
  iso: string;
  extensionClaudeMdContent?: string;
  deps: RemediatorDeps;
}): void {
  const { gateDir, gateResult, sessionRoot, reason, iso, extensionClaudeMdContent, deps } = opts;
  const failingFileContents = collectFailingFileContents(gateResult, deps.readFile);
  const trapDoorSection = loadTrapDoorSection(extensionClaudeMdContent, deps.readFile);
  const briefContent = buildBriefContent({
    gateResult,
    sessionRoot,
    reason,
    iso,
    failingFileContents,
    trapDoorSection,
  });
  const briefPath = path.join(gateDir, `remediation_${iso}_brief.md`);

  deps.writeFile(briefPath, briefContent, 'utf-8');
  deps.stdout(`BRIEF_PATH=${briefPath}`);
}

function formatFailuresTable(failures: GateFailure[]): string {
  if (failures.length === 0) return '_No failures._\n';
  const rows = failures.map(f =>
    `| ${f.check} | ${f.file} | ${f.line} | ${f.ruleOrCode} | ${f.severity} | ${f.message.replace(/\|/g, '\\|')} |`
  );
  return [
    '| Check | File | Line | Rule/Code | Severity | Message |',
    '|:------|:-----|-----:|:----------|:---------|:--------|',
    ...rows,
  ].join('\n') + '\n';
}

function buildBriefContent(opts: {
  gateResult: GateResult;
  sessionRoot: string;
  reason: string;
  iso: string;
  failingFileContents: Map<string, string>;
  trapDoorSection: string;
}): string {
  const { gateResult, sessionRoot, reason, iso, failingFileContents, trapDoorSection } = opts;

  const sections: string[] = [];

  sections.push(`# Gate Remediation Brief`);
  sections.push(`\n**Generated**: ${iso}  \n**Session root**: ${sessionRoot}  \n**Reason**: ${reason}  \n**Gate status**: ${gateResult.status}  \n**Failures**: ${gateResult.failures.length}\n`);

  sections.push(`## Section 1: Gate Failures (verbatim)\n`);
  sections.push(formatFailuresTable(gateResult.failures));

  sections.push(`## Section 2: Failing File Contents\n`);
  if (failingFileContents.size === 0) {
    sections.push('_No failing files to display._\n');
  } else {
    for (const [filePath, content] of failingFileContents) {
      sections.push(`### \`${filePath}\`\n`);
      if (content === '__UNREADABLE__') {
        sections.push(`_Could not read file (unreadable or not found). Read it fresh before editing._\n`);
      } else if (content === '__OVERSIZED__') {
        sections.push(`_File exceeds ${MAX_FILE_BYTES} bytes. Read path directly: \`${filePath}\`_\n`);
      } else {
        const ext = path.extname(filePath).slice(1) || 'text';
        sections.push(`\`\`\`${ext}\n${content}\n\`\`\`\n`);
      }
    }
  }

  sections.push(`## Section 3: Relevant CLAUDE.md Trap Doors\n`);
  sections.push(trapDoorSection + '\n');

  sections.push(`## Section 4: Hard Rule and Abort Grammar\n`);
  sections.push(`### Hard Rule

**Fix ONLY the failures listed in Section 1. Do not edit any other lines. Do not change behavior.**

You may ONLY hand-edit for these four failure classes. Anything outside → abort immediately.

- **(a)** Regex character class ranges: \`\\xNN\` → \`\\uNNNN\`. Rule: \`no-control-regex\`. Character escape in range only — no logic changes.
- **(b)** async-generator require-await: \`async function*\` without \`await\` → wrap with typed \`AsyncIterable\` helper per trap-door section (see Section 3). No new behavior.
- **(c)** Unnecessary type assertions: Remove \`as Type\` where TypeScript already infers (\`no-unnecessary-type-assertion\`). Removal only.
- **(d)** Spec-file type-only mock alignment: Fix only for \`TS2741\`, \`TS2345\`, \`TS2352\`, \`TS2739\` where change is purely additive AND a production covering test exists.

### Abort Grammar

Write \`\${SESSION_ROOT}/gate/remediation_aborted_<reason>_<iso>.md\` and exit cleanly when:

- A fix outside classes (a)-(d) is required
- Class (d) fix but no covering test exists → filename: \`remediation_aborted_unverified_production_change_<iso>.md\`
- A fix would require changing behavior
- The brief is missing, malformed, or has no SESSION_ROOT
- The failing-files list is empty
- A concurrent remediator lockfile exists at \`\${SESSION_ROOT}/gate/remediator.lockfile\`

The abort file must contain: reason, affected file:line, what fix was requested, why it was refused.

### Invariants

- Edit ONLY files listed in Section 1's failing-files set. Zero exceptions.
- Do not change indentation, whitespace, or comments outside the failing line(s).
- Do not rename symbols, extract helpers, or reorganize imports.
- Do not run \`pnpm install\`, \`npm install\`, or any package manager mutation.
- Do not write to \`state.json\`, \`microverse.json\`, or any orchestrator-owned file.
- Write your outcome to \`\${SESSION_ROOT}/gate/remediation_<iso>_result.json\` only.
`);

  return sections.join('\n');
}

export async function spawnGateRemediatorMain(opts: SpawnGateRemediatorOpts): Promise<number> {
  const deps = resolveDeps(opts);
  const args = parseArgs(opts.argv, deps.stderr);
  if (!args) return 1;

  const gateResult = readGateResult(args, deps);
  if (!gateResult) return 1;

  const iso = opts.isoOverride ?? isoCompactStamp();
  const gateDir = createGateDir(args.sessionRoot, deps);
  if (!gateDir) return 1;

  const lock = acquireRemediatorLock({ gateDir, sessionRoot: args.sessionRoot, reason: args.reason, iso, deps });
  if (lock.status === 'lockout') return 0;
  if (lock.status === 'error') return 1;

  const cleanup = () => removeLockfile(lock.lockfilePath, deps);
  process.on('exit', cleanup);

  try {
    writeRemediationBrief({
      gateDir,
      gateResult,
      sessionRoot: args.sessionRoot,
      reason: args.reason,
      iso,
      extensionClaudeMdContent: opts.extensionClaudeMdContent,
      deps,
    });
    return 0;
  } catch (e) {
    deps.stderr(`spawn-gate-remediator error: ${safeErrorMessage(e)}`);
    return 1;
  } finally {
    cleanup();
    process.off('exit', cleanup);
  }
}

if (process.argv[1] && path.basename(process.argv[1]) === 'spawn-gate-remediator.js') {
  spawnGateRemediatorMain({ argv: process.argv.slice(2) })
    .then(code => process.exit(code))
    .catch(e => {
      process.stderr.write(`spawn-gate-remediator fatal: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    });
}

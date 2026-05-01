import * as fs from 'fs';
import * as path from 'path';
import { isoCompactStamp, safeErrorMessage } from '../services/pickle-utils.js';
import { readRecoverableJsonObject } from '../services/microverse-state.js';
const USAGE = 'Usage: spawn-gate-remediator --gate-result <path> --session-root <path> --reason strict|per-iteration';
const LOCKFILE_NAME = 'remediator.lockfile';
const MAX_FILE_BYTES = 50_000;
const VALID_REASONS = new Set(['strict', 'per-iteration']);
function parseFlag(argv, flag) {
    const idx = argv.indexOf(flag);
    if (idx === -1 || idx + 1 >= argv.length)
        return undefined;
    return argv[idx + 1];
}
const VALID_GATE_STATUSES = new Set(['green', 'red', 'green-with-known-flake-warnings']);
const VALID_FAILURE_CHECKS = new Set(['typecheck', 'lint', 'tests']);
const VALID_FAILURE_SEVERITIES = new Set(['error', 'warning']);
function isGateFailure(v) {
    if (!v || typeof v !== 'object')
        return false;
    const f = v;
    return (typeof f['check'] === 'string' && VALID_FAILURE_CHECKS.has(f['check']) &&
        typeof f['file'] === 'string' &&
        typeof f['line'] === 'number' &&
        typeof f['ruleOrCode'] === 'string' &&
        typeof f['message'] === 'string' &&
        typeof f['severity'] === 'string' && VALID_FAILURE_SEVERITIES.has(f['severity']) &&
        typeof f['occurrence_index'] === 'number');
}
function isGateResult(v) {
    if (!v || typeof v !== 'object')
        return false;
    const obj = v;
    return (typeof obj['status'] === 'string' && VALID_GATE_STATUSES.has(obj['status']) &&
        Array.isArray(obj['failures']) && obj['failures'].every(isGateFailure) &&
        typeof obj['elapsed_ms'] === 'number');
}
function formatFailuresTable(failures) {
    if (failures.length === 0)
        return '_No failures._\n';
    const rows = failures.map(f => `| ${f.check} | ${f.file} | ${f.line} | ${f.ruleOrCode} | ${f.severity} | ${f.message.replace(/\|/g, '\\|')} |`);
    return [
        '| Check | File | Line | Rule/Code | Severity | Message |',
        '|:------|:-----|-----:|:----------|:---------|:--------|',
        ...rows,
    ].join('\n') + '\n';
}
function buildBriefContent(opts) {
    const { gateResult, sessionRoot, reason, iso, failingFileContents, trapDoorSection } = opts;
    const sections = [];
    sections.push(`# Gate Remediation Brief`);
    sections.push(`\n**Generated**: ${iso}  \n**Session root**: ${sessionRoot}  \n**Reason**: ${reason}  \n**Gate status**: ${gateResult.status}  \n**Failures**: ${gateResult.failures.length}\n`);
    sections.push(`## Section 1: Gate Failures (verbatim)\n`);
    sections.push(formatFailuresTable(gateResult.failures));
    sections.push(`## Section 2: Failing File Contents\n`);
    if (failingFileContents.size === 0) {
        sections.push('_No failing files to display._\n');
    }
    else {
        for (const [filePath, content] of failingFileContents) {
            sections.push(`### \`${filePath}\`\n`);
            if (content === '__UNREADABLE__') {
                sections.push(`_Could not read file (unreadable or not found). Read it fresh before editing._\n`);
            }
            else if (content === '__OVERSIZED__') {
                sections.push(`_File exceeds ${MAX_FILE_BYTES} bytes. Read path directly: \`${filePath}\`_\n`);
            }
            else {
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
// eslint-disable-next-line complexity, max-lines-per-function -- pre-existing — outside T0–T15 god-fn refactor scope; defer to follow-up epic
export async function spawnGateRemediatorMain(opts) {
    const { argv, isoOverride, extensionClaudeMdContent, stdout = (msg) => process.stdout.write(msg + '\n'), stderr = (msg) => process.stderr.write(msg + '\n'), } = opts;
    const hasInjectedReadFile = typeof opts.readFileFn === 'function';
    const readFile = opts.readFileFn ?? ((p, enc) => fs.readFileSync(p, enc));
    const writeFile = opts.writeFileFn ?? ((p, data, enc) => fs.writeFileSync(p, data, enc));
    const mkdirSync = opts.mkdirSyncFn ?? ((p, o) => fs.mkdirSync(p, o));
    const openSync = opts.openSyncFn ?? ((p, flags) => fs.openSync(p, flags));
    const closeSync = opts.closeSyncFn ?? ((fd) => fs.closeSync(fd));
    const unlinkSync = opts.unlinkSyncFn ?? ((p) => fs.unlinkSync(p));
    const existsSync = opts.existsSyncFn ?? ((p) => fs.existsSync(p));
    const gateResultPath = parseFlag(argv, '--gate-result');
    const sessionRoot = parseFlag(argv, '--session-root');
    const reason = parseFlag(argv, '--reason');
    if (!gateResultPath || !sessionRoot || !reason) {
        stderr(`Missing required flags.\n${USAGE}`);
        return 1;
    }
    if (!VALID_REASONS.has(reason)) {
        stderr(`--reason must be strict|per-iteration, got: ${reason}`);
        return 1;
    }
    let gateResult;
    try {
        const raw = !hasInjectedReadFile
            ? readRecoverableJsonObject(gateResultPath)
            : JSON.parse(readFile(gateResultPath, 'utf-8'));
        if (raw === null) {
            throw new Error('gate-result JSON is missing, malformed, or not an object');
        }
        if (!isGateResult(raw)) {
            stderr(`gate-result JSON at ${gateResultPath} is not a valid GateResult`);
            return 1;
        }
        gateResult = raw;
    }
    catch (e) {
        stderr(`Failed to read --gate-result ${gateResultPath}: ${safeErrorMessage(e)}`);
        return 1;
    }
    const iso = isoOverride ?? isoCompactStamp();
    const gateDir = path.join(sessionRoot, 'gate');
    try {
        mkdirSync(gateDir, { recursive: true });
    }
    catch (e) {
        stderr(`Failed to create gate dir ${gateDir}: ${safeErrorMessage(e)}`);
        return 1;
    }
    const lockfilePath = path.join(gateDir, LOCKFILE_NAME);
    try {
        const fd = openSync(lockfilePath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
        closeSync(fd);
    }
    catch (e) {
        if (e.code === 'EEXIST') {
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
                writeFile(lockoutPath, lockoutContent, 'utf-8');
                stdout(`LOCKOUT_PATH=${lockoutPath}`);
            }
            catch { /* best-effort */ }
            return 0;
        }
        stderr(`Failed to acquire lockfile ${lockfilePath}: ${safeErrorMessage(e)}`);
        return 1;
    }
    const cleanup = () => {
        try {
            if (existsSync(lockfilePath))
                unlinkSync(lockfilePath);
        }
        catch { /* already gone */ }
    };
    process.on('exit', cleanup);
    try {
        const failingFiles = [...new Set(gateResult.failures.map(f => f.file))];
        const failingFileContents = new Map();
        for (const filePath of failingFiles) {
            try {
                const raw = readFile(filePath, 'utf-8');
                if (raw.length > MAX_FILE_BYTES) {
                    failingFileContents.set(filePath, '__OVERSIZED__');
                }
                else {
                    failingFileContents.set(filePath, raw);
                }
            }
            catch {
                failingFileContents.set(filePath, '__UNREADABLE__');
            }
        }
        let trapDoorSection = extensionClaudeMdContent ?? '';
        if (!trapDoorSection) {
            const claudeMdPath = path.join(path.dirname(path.dirname(new URL(import.meta.url).pathname)), 'CLAUDE.md');
            try {
                trapDoorSection = readFile(claudeMdPath, 'utf-8');
            }
            catch {
                trapDoorSection = '_CLAUDE.md trap-door section not available at brief-prep time. Read extension/CLAUDE.md before editing._';
            }
        }
        const briefContent = buildBriefContent({
            gateResult,
            sessionRoot,
            reason,
            iso,
            failingFileContents,
            trapDoorSection,
        });
        const briefFileName = `remediation_${iso}_brief.md`;
        const briefPath = path.join(gateDir, briefFileName);
        writeFile(briefPath, briefContent, 'utf-8');
        stdout(`BRIEF_PATH=${briefPath}`);
        return 0;
    }
    catch (e) {
        stderr(`spawn-gate-remediator error: ${safeErrorMessage(e)}`);
        return 1;
    }
    finally {
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

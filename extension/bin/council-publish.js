import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { safeErrorMessage } from '../services/pickle-utils.js';
import { validateDirective, CouncilSchemaError } from '../services/council-schema.js';
import { readRecoverableJsonObject } from '../services/recoverable-json.js';
export class CouncilPublishError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CouncilPublishError';
    }
}
function slugify(branch) {
    return branch.replace(/\//g, '__');
}
/**
 * Parse `gh pr list --json number,state,updatedAt` output tolerantly.
 * Accepts a JSON array (current shape) OR a bare integer on the first line
 * (legacy `--jq .[0].number` shape). Returns a discriminated result so the
 * caller can distinguish "well-formed but empty" from "unparseable" — the
 * latter must NOT masquerade as `skipped_no_pr`.
 */
export function parsePrList(stdout) {
    const trimmed = stdout.trim();
    if (!trimmed)
        return { ok: true, rows: [] };
    const tryParseArray = (text) => {
        try {
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed)) {
                return parsed
                    .filter((p) => !!p && typeof p === 'object')
                    .map(p => ({
                    number: Number(p.number),
                    state: typeof p.state === 'string' ? p.state : undefined,
                    updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : undefined,
                }))
                    .filter(r => Number.isFinite(r.number) && r.number > 0);
            }
        }
        catch {
            // not JSON
        }
        return null;
    };
    const direct = tryParseArray(trimmed);
    if (direct !== null)
        return { ok: true, rows: direct };
    // Some `gh` invocations emit a warning line (or several) before the JSON.
    // Walk from the top, skip lines until one begins with `[` or `{`, rejoin
    // and retry. If that fails, fall through to the bare-integer path.
    const lines = trimmed.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const head = lines[i].trimStart();
        if (head.startsWith('[') || head.startsWith('{')) {
            const rest = lines.slice(i).join('\n').trim();
            if (rest && rest !== trimmed) {
                const retried = tryParseArray(rest);
                if (retried !== null)
                    return { ok: true, rows: retried };
            }
            break;
        }
    }
    // Bare-integer legacy fallback: first non-empty line.
    const firstLine = (lines.find(l => l.trim().length > 0) || '').trim();
    const n = Number(firstLine);
    if (Number.isFinite(n) && n > 0) {
        return { ok: true, rows: [{ number: n, state: 'OPEN' }] };
    }
    const preview = trimmed.length > 120 ? trimmed.slice(0, 120) + '…' : trimmed;
    return { ok: false, reason: `unparseable gh pr list output: ${preview}` };
}
/**
 * Scans the council-of-ricks-summary.md for `## Round N:` headers and returns
 * a clean bullet list reflecting every round outcome this session — so reviewers
 * see the full rotation (clean / partial / issues), not just the final state.
 *
 * Ignores `## Round N:` lines that appear inside fenced code blocks or
 * block-quotes — the summary template itself shows literal `## Round ...`
 * examples, so a line-oriented scan without fence tracking would double-count.
 */
function extractRoundOutcomes(summaryPath) {
    if (!fs.existsSync(summaryPath))
        return [];
    try {
        const content = fs.readFileSync(summaryPath, 'utf-8');
        const lines = content.split('\n');
        const rounds = [];
        let inFence = false;
        for (const line of lines) {
            const trimmed = line.trim();
            if (/^(?:```|~~~)/.test(trimmed)) {
                inFence = !inFence;
                continue;
            }
            if (inFence)
                continue;
            if (trimmed.startsWith('>'))
                continue;
            const m = line.match(/^##\s+Round\s+(\d+)\s*:\s*(.+?)\s*$/i);
            if (m) {
                rounds.push(`- Round ${m[1]}: ${m[2].trim()}`);
            }
        }
        return rounds;
    }
    catch {
        return [];
    }
}
// council-directive.json is the machine-written directive consumed by this publisher (humans: see council-directive.md for the human-readable equivalent)
function readDirectiveJson(sessionRoot) {
    const jsonPath = path.join(sessionRoot, 'council-directive.json');
    let parsed;
    try {
        parsed = readRecoverableJsonObject(jsonPath);
        if (!parsed) {
            if (!fs.existsSync(jsonPath)) {
                throw new CouncilPublishError('council-directive.json missing');
            }
            throw new CouncilPublishError('council-directive.json invalid JSON');
        }
    }
    catch (err) {
        if (err instanceof CouncilPublishError)
            throw err;
        throw new CouncilPublishError(`council-directive.json invalid JSON: ${safeErrorMessage(err)}`);
    }
    try {
        return validateDirective(parsed);
    }
    catch (err) {
        const jsonPath = err instanceof CouncilSchemaError ? err.jsonPath : '$';
        throw new CouncilPublishError(`council-directive.json failed validation: ${jsonPath}: ${safeErrorMessage(err)}`);
    }
}
export function composeBody(params) {
    const { sessionRoot, branch: _branch, finalRound, codexEnabled, findings, trapDoors, roundOutcomes } = params;
    const sessionName = path.basename(sessionRoot);
    const codexLine = codexEnabled ? 'enabled: ran on this branch' : 'disabled: not available';
    let findingsBlock;
    if (findings.length === 0) {
        findingsBlock = '_No findings for this branch at session close._';
    }
    else {
        const header = '| Severity | Conf | Source | File | Issue | Rule | Recommendation |';
        const sep = '| --- | --- | --- | --- | --- | --- | --- |';
        const rows = findings.map(f => {
            const file = f.line_range != null
                ? `${f.file}:${f.line_range.replace(/-/g, '–')}`
                : `${f.file}:${f.line}`;
            return `| ${f.severity} | ${f.confidence} | [${f.source}] | ${file} | ${f.description} | ${f.rule} | ${f.recommendation} |`;
        });
        findingsBlock = [header, sep, ...rows].join('\n');
    }
    const trapBlock = trapDoors.length === 0
        ? '_None catalogued._'
        : trapDoors.map(td => `- \`${td.path}\` — ${td.constraint}; ${td.why_it_breaks}; ${td.what_must_hold}`).join('\n');
    const roundBlock = roundOutcomes.length > 0 ? roundOutcomes.join('\n') : '- (no rounds recorded)';
    return [
        '## Council of Ricks — Stack Review',
        '',
        '_Posted at session end. See the [Council skill](https://github.com/gregorydickson/pickle-rick-claude) for the parallel-round review protocol._',
        '',
        `**Session:** \`${sessionName}\``,
        `**Final round:** ${finalRound}`,
        `**Codex adversarial:** ${codexLine}`,
        '',
        '### Findings for this branch',
        '',
        findingsBlock,
        '',
        '### Trap Doors',
        '',
        trapBlock,
        '',
        '### Round outcomes (this session)',
        '',
        roundBlock,
        '',
    ].join('\n');
}
function appendPublishLog(fd, result) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...result }) + '\n';
    fs.writeSync(fd, Buffer.from(line));
}
function appendPublishLogRaw(fd, entry) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    fs.writeSync(fd, Buffer.from(line));
}
/**
 * A marker is only "published" if it exists AND has non-zero size. A prior
 * run can leave a zero-byte file behind (interrupted write, tmpfs eviction,
 * bad umask) — treating those as "already published" silently swallows the
 * outstanding comment for that branch forever. Size > 0 means a real ISO
 * timestamp was written.
 */
function isMarkerPublished(p) {
    try {
        return fs.existsSync(p) && fs.statSync(p).size > 0;
    }
    catch {
        return false;
    }
}
// eslint-disable-next-line complexity, max-lines-per-function -- pre-existing — outside T0–T15 god-fn refactor scope; defer to follow-up epic
export default function publishCouncilStack(sessionRoot, opts = {}) {
    const ghCommand = opts.ghCommand || 'gh';
    const dryRun = !!opts.dryRun;
    const ghTimeoutOverride = opts.ghTimeoutMs;
    const authTimeoutMs = ghTimeoutOverride ?? 15_000;
    const prListTimeoutMs = ghTimeoutOverride ?? 30_000;
    const prCommentTimeoutMs = ghTimeoutOverride ?? 30_000;
    if (!fs.existsSync(sessionRoot)) {
        throw new CouncilPublishError(`session_root does not exist: ${sessionRoot}`);
    }
    const stackPath = path.join(sessionRoot, 'council-stack.json');
    let stack;
    try {
        const parsedStack = readRecoverableJsonObject(stackPath);
        if (!parsedStack) {
            if (!fs.existsSync(stackPath)) {
                throw new CouncilPublishError(`not a council session: council-stack.json missing at ${stackPath}`);
            }
            throw new CouncilPublishError('failed to parse council-stack.json: invalid JSON');
        }
        stack = parsedStack;
    }
    catch (err) {
        if (err instanceof CouncilPublishError)
            throw err;
        throw new CouncilPublishError(`failed to parse council-stack.json: ${safeErrorMessage(err)}`);
    }
    const { branches, trunk, repo_path } = stack;
    if (!Array.isArray(branches) || typeof trunk !== 'string' || typeof repo_path !== 'string') {
        throw new CouncilPublishError('council-stack.json missing required fields (branches, trunk, repo_path)');
    }
    if (!branches.includes(trunk)) {
        throw new CouncilPublishError(`council-stack.json: trunk "${trunk}" not in branches list`);
    }
    let repoStat;
    try {
        repoStat = fs.statSync(repo_path);
    }
    catch {
        throw new CouncilPublishError(`council-stack.json: repo_path does not exist: ${repo_path}`);
    }
    if (!repoStat.isDirectory()) {
        throw new CouncilPublishError(`council-stack.json: repo_path is not a directory: ${repo_path}`);
    }
    const commentsDir = path.join(sessionRoot, 'council-comments');
    fs.mkdirSync(commentsDir, { recursive: true });
    const publishedDir = path.join(sessionRoot, '.published');
    fs.mkdirSync(publishedDir, { recursive: true });
    const logPath = path.join(sessionRoot, 'publish.log');
    // gh availability check. `timeout` guards against a hang on a machine where
    // `gh` is installed but wedged (stuck keyring prompt, dead network on first
    // auth-refresh attempt) — without it, the entire publisher blocks at session
    // end with no log output. Treated the same as any other auth failure.
    let ghAvailable = true;
    try {
        execFileSync(ghCommand, ['auth', 'status'], { stdio: 'pipe', timeout: authTimeoutMs });
    }
    catch {
        ghAvailable = false;
    }
    const roundOutcomes = extractRoundOutcomes(path.join(sessionRoot, 'council-of-ricks-summary.md'));
    const finalRound = roundOutcomes.length;
    const directive = readDirectiveJson(sessionRoot);
    const results = [];
    let posted = 0;
    let skipped = 0;
    let failed = 0;
    const logFd = fs.openSync(logPath, 'a');
    try {
        for (const branch of branches) {
            if (branch === trunk)
                continue;
            const slug = slugify(branch);
            const bodyPath = path.join(commentsDir, `${slug}.md`);
            const markerPath = path.join(publishedDir, slug);
            // Fail-fast on directive/stack parity drift. A branch present in
            // council-stack.json but absent from directive.branches means the
            // council agent's fan-out dropped it (shard timeout, write error,
            // sharded run skipped a branch). Silently defaulting to empty findings
            // would post a misleading "No findings for this branch at session
            // close." comment AND stamp the .published marker, permanently hiding
            // the drift — same silent-failure class as the spawnSync-no-timeout
            // trap doors (see extension/CLAUDE.md). Classify as failed so the
            // operator sees a real signal and a fixed-directive re-run can post.
            const branchEntry = directive.branches.find(b => b.name === branch);
            if (!branchEntry) {
                const r = {
                    branch,
                    outcome: 'failed',
                    error: 'council-directive.json has no entry for this branch — directive/stack mismatch',
                };
                results.push(r);
                failed++;
                appendPublishLog(logFd, r);
                continue;
            }
            const findings = branchEntry.findings;
            const body = composeBody({
                sessionRoot,
                branch,
                finalRound,
                codexEnabled: directive.codex_enabled,
                findings,
                trapDoors: directive.trap_doors,
                roundOutcomes,
            });
            fs.writeFileSync(bodyPath, body);
            if (!ghAvailable) {
                const r = { branch, outcome: 'skipped_no_gh', body_path: bodyPath };
                results.push(r);
                skipped++;
                appendPublishLog(logFd, r);
                continue;
            }
            if (isMarkerPublished(markerPath)) {
                const r = { branch, outcome: 'skipped_already_published', body_path: bodyPath };
                results.push(r);
                skipped++;
                appendPublishLog(logFd, r);
                continue;
            }
            // Resolve PR number. Query all states (OPEN + MERGED + CLOSED) so re-runs
            // on a merged stack still post. When multiple PRs share a head branch,
            // prefer OPEN, then most-recently-updated — deterministic tie-break.
            let prNumber;
            try {
                // `timeout` is required: without it, a stalled TLS handshake, DNS hang,
                // or hung GitHub API request blocks the publisher indefinitely — there
                // is no other signal surface (no parent watchdog calls into this loop).
                const out = execFileSync(ghCommand, ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,state,updatedAt'], { cwd: repo_path, stdio: 'pipe', encoding: 'utf8', timeout: prListTimeoutMs }).trim();
                const parsed = parsePrList(out);
                if (!parsed.ok) {
                    // Unparseable `gh` output must NOT masquerade as "no PR found".
                    // Classify as failure so the operator sees a real signal.
                    const r = {
                        branch,
                        outcome: 'failed',
                        error: `pr list parse: ${parsed.reason}`,
                        body_path: bodyPath,
                    };
                    results.push(r);
                    failed++;
                    appendPublishLog(logFd, r);
                    continue;
                }
                const prs = parsed.rows;
                if (prs.length === 0) {
                    const r = { branch, outcome: 'skipped_no_pr', body_path: bodyPath };
                    results.push(r);
                    skipped++;
                    appendPublishLog(logFd, r);
                    continue;
                }
                prs.sort((a, b) => {
                    if (a.state === 'OPEN' && b.state !== 'OPEN')
                        return -1;
                    if (b.state === 'OPEN' && a.state !== 'OPEN')
                        return 1;
                    return (b.updatedAt || '').localeCompare(a.updatedAt || '');
                });
                const picked = prs[0].number;
                if (!Number.isFinite(picked) || picked <= 0) {
                    const r = { branch, outcome: 'skipped_no_pr', body_path: bodyPath };
                    results.push(r);
                    skipped++;
                    appendPublishLog(logFd, r);
                    continue;
                }
                prNumber = picked;
            }
            catch (err) {
                const r = {
                    branch,
                    outcome: 'failed',
                    error: `pr list: ${safeErrorMessage(err)}`,
                    body_path: bodyPath,
                };
                results.push(r);
                failed++;
                appendPublishLog(logFd, r);
                continue;
            }
            if (dryRun) {
                const r = { branch, outcome: 'posted', pr_number: prNumber, body_path: bodyPath };
                results.push(r);
                posted++;
                appendPublishLog(logFd, r);
                continue;
            }
            // Post the comment. `timeout` matches pr-list: a stalled write must not
            // deadlock the session. Node raises on timeout; the catch below classifies
            // the outcome as `failed` with the underlying error message intact.
            try {
                execFileSync(ghCommand, ['pr', 'comment', String(prNumber), '--body-file', bodyPath], { cwd: repo_path, stdio: 'pipe', timeout: prCommentTimeoutMs });
                fs.writeFileSync(markerPath, new Date().toISOString());
                const r = { branch, outcome: 'posted', pr_number: prNumber, body_path: bodyPath };
                results.push(r);
                posted++;
                appendPublishLog(logFd, r);
            }
            catch (err) {
                const r = {
                    branch,
                    outcome: 'failed',
                    pr_number: prNumber,
                    error: `pr comment: ${safeErrorMessage(err)}`,
                    body_path: bodyPath,
                };
                results.push(r);
                failed++;
                appendPublishLog(logFd, r);
            }
        }
        const warnings = [];
        // Trunk-only stack: no non-trunk branches to publish to. Surface as a
        // warning so `posted=0/skipped=0/failed=0` doesn't look like success.
        if (results.length === 0) {
            const msg = 'council-stack.json has no non-trunk branches; nothing to publish';
            warnings.push(msg);
            appendPublishLogRaw(logFd, { level: 'warn', message: msg });
        }
        const report = { session_root: sessionRoot, results, posted, skipped, failed };
        if (warnings.length > 0)
            report.warnings = warnings;
        return report;
    }
    finally {
        fs.closeSync(logFd);
    }
}
if (process.argv[1] && path.basename(process.argv[1]) === 'council-publish.js') {
    const sessionRoot = process.argv[2];
    if (!sessionRoot) {
        console.error('Usage: council-publish <SESSION_ROOT> [--dry-run]');
        process.exit(1);
    }
    let dryRun = false;
    for (const arg of process.argv.slice(3)) {
        if (arg === '--dry-run') {
            dryRun = true;
        }
        else {
            console.error(`council-publish: unknown argument: ${arg}`);
            console.error('Usage: council-publish <SESSION_ROOT> [--dry-run]');
            process.exit(2);
        }
    }
    try {
        const report = publishCouncilStack(sessionRoot, { dryRun });
        console.log(JSON.stringify(report, null, 2));
    }
    catch (err) {
        console.error(`council-publish: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }
}

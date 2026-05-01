import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { formatLocalDateKey, safeErrorMessage } from './pickle-utils.js';
import { readRecoverableJsonObject } from './microverse-state.js';
// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------
export function formatNumber(n) {
    if (!Number.isFinite(n) || n === 0)
        return '0';
    const abs = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    if (abs >= 1_000_000_000)
        return sign + (abs / 1_000_000_000).toFixed(1) + 'B';
    if (abs >= 1_000_000)
        return sign + (abs / 1_000_000).toFixed(1) + 'M';
    if (abs >= 1_000)
        return sign + (abs / 1_000).toFixed(1) + 'K';
    return String(n);
}
export function shortenSlug(slug) {
    const username = os.userInfo().username;
    const escapedUser = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let result = slug.replace(new RegExp(`^-Users-${escapedUser}-`), '');
    result = result.replace(/^loanlight-/, 'l/');
    return result;
}
function projectSlugFromPath(projectPath) {
    return path.resolve(projectPath).replace(/[\\/]/g, '-');
}
function discoverGitRepos(repoRoot) {
    const repos = [];
    const pending = [path.resolve(repoRoot)];
    while (pending.length > 0) {
        const current = pending.pop();
        let entries;
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        }
        catch {
            continue;
        }
        if (entries.some((entry) => entry.name === '.git' && (entry.isDirectory() || entry.isFile()))) {
            repos.push(current);
            continue;
        }
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name === '.git' || entry.isSymbolicLink())
                continue;
            pending.push(path.join(current, entry.name));
        }
    }
    return repos;
}
/**
 * Worktrees share commit history with their main repo. Returns the main repo's
 * primary branch name so the worktree's `git log` can subtract it (`HEAD ^<ref>`)
 * and only count commits unique to the worktree's checkout. Returns null when
 * `repoPath` is not a worktree, or when the main HEAD is detached/unreadable.
 */
function getWorktreeBaseRef(repoPath) {
    const gitPath = path.join(repoPath, '.git');
    try {
        const stat = fs.statSync(gitPath);
        if (!stat.isFile())
            return null;
        const content = fs.readFileSync(gitPath, 'utf-8').trim();
        const match = content.match(/^gitdir:\s*(.+)$/);
        if (!match)
            return null;
        // gitdir target is `<main>/.git/worktrees/<name>` — main repo's .git is two levels up
        const mainGitDir = path.dirname(path.dirname(match[1]));
        const headPath = path.join(mainGitDir, 'HEAD');
        const head = fs.readFileSync(headPath, 'utf-8').trim();
        const refMatch = head.match(/^ref:\s*refs\/heads\/(.+)$/);
        return refMatch ? refMatch[1] : null;
    }
    catch {
        return null;
    }
}
export function parseSessionLine(line) {
    try {
        const obj = JSON.parse(line);
        if (obj.type !== 'assistant')
            return null;
        const ts = obj.timestamp;
        const usage = obj.message?.usage;
        if (typeof ts !== 'string' || !usage)
            return null;
        if (!Number.isFinite(new Date(ts).getTime()))
            return null;
        return {
            timestamp: ts,
            usage: {
                input: Number(usage.input_tokens) || 0,
                output: Number(usage.output_tokens) || 0,
                cache_read: Number(usage.cache_read_input_tokens) || 0,
                cache_create: Number(usage.cache_creation_input_tokens) || 0,
            },
        };
    }
    catch {
        return null;
    }
}
// ---------------------------------------------------------------------------
// Session File Scanner with Incremental Cache
// ---------------------------------------------------------------------------
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB guard
const CACHE_VERSION = 2;
function getMetricsTimeZone() {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';
}
function emptyCache() {
    return { version: CACHE_VERSION, time_zone: getMetricsTimeZone(), files: {} };
}
function emptyDailyTokens() {
    return { turns: 0, input: 0, output: 0, cache_read: 0, cache_create: 0 };
}
function addTokens(target, usage) {
    target.turns += 1;
    target.input += usage.input;
    target.output += usage.output;
    target.cache_read += usage.cache_read;
    target.cache_create += usage.cache_create;
}
function parseJsonlFile(filePath) {
    const result = {};
    const content = fs.readFileSync(filePath, 'utf-8');
    for (const rawLine of content.split('\n')) {
        const line = rawLine.trim();
        if (!line)
            continue;
        const parsed = parseSessionLine(line);
        if (!parsed)
            continue;
        const date = formatLocalDateKey(new Date(parsed.timestamp));
        if (!result[date])
            result[date] = emptyDailyTokens();
        addTokens(result[date], parsed.usage);
    }
    return result;
}
function loadCache(cachePath) {
    try {
        const parsed = readRecoverableJsonObject(cachePath);
        if (!parsed)
            return emptyCache();
        if (parsed.version !== CACHE_VERSION)
            return emptyCache();
        if (parsed.time_zone !== getMetricsTimeZone())
            return emptyCache();
        return parsed;
    }
    catch {
        return emptyCache();
    }
}
function saveCache(cachePath, cache) {
    try {
        const dir = path.dirname(cachePath);
        fs.mkdirSync(dir, { recursive: true });
        const tmp = `${cachePath}.tmp.${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify(cache));
        fs.renameSync(tmp, cachePath);
    }
    catch (err) {
        const msg = safeErrorMessage(err);
        process.stderr.write(`[metrics] Cache write failed (non-fatal): ${msg}\n`);
    }
}
// eslint-disable-next-line complexity -- pre-existing — outside T0–T15 god-fn refactor scope; defer to follow-up epic
export function scanSessionFiles(projectsDir, since, until, cachePath) {
    const result = new Map();
    const cache = loadCache(cachePath);
    let cacheChanged = false;
    const validPaths = new Set();
    let slugs;
    try {
        slugs = fs.readdirSync(projectsDir).filter((s) => !s.startsWith('-private-var-'));
    }
    catch {
        return result;
    }
    for (const slug of slugs) {
        const slugDir = path.join(projectsDir, slug);
        let stat;
        try {
            stat = fs.statSync(slugDir);
        }
        catch {
            continue;
        }
        if (!stat.isDirectory())
            continue;
        let files;
        try {
            files = fs.readdirSync(slugDir).filter((f) => f.endsWith('.jsonl'));
        }
        catch {
            continue;
        }
        for (const file of files) {
            const filePath = path.join(slugDir, file);
            validPaths.add(filePath);
            let fstat;
            try {
                fstat = fs.statSync(filePath);
            }
            catch {
                continue;
            }
            if (fstat.size > MAX_FILE_BYTES)
                continue;
            const cached = cache.files[filePath];
            let fileData;
            if (cached && cached.mtime === fstat.mtimeMs && cached.size === fstat.size) {
                fileData = cached.data;
            }
            else {
                try {
                    fileData = parseJsonlFile(filePath);
                }
                catch {
                    continue;
                }
                cache.files[filePath] = { mtime: fstat.mtimeMs, size: fstat.size, data: fileData };
                cacheChanged = true;
            }
            for (const [date, tokens] of Object.entries(fileData)) {
                if (date < since || date > until)
                    continue;
                if (!result.has(slug))
                    result.set(slug, new Map());
                const dateMap = result.get(slug);
                if (!dateMap.has(date))
                    dateMap.set(date, emptyDailyTokens());
                const target = dateMap.get(date);
                target.turns += tokens.turns;
                target.input += tokens.input;
                target.output += tokens.output;
                target.cache_read += tokens.cache_read;
                target.cache_create += tokens.cache_create;
            }
        }
    }
    // Prune stale cache entries
    for (const cachedPath of Object.keys(cache.files)) {
        if (!validPaths.has(cachedPath)) {
            delete cache.files[cachedPath];
            cacheChanged = true;
        }
    }
    if (cacheChanged)
        saveCache(cachePath, cache);
    return result;
}
// ---------------------------------------------------------------------------
// Git Log Parser
// ---------------------------------------------------------------------------
const STAT_RE = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T/;
export function parseGitLogOutput(output) {
    const result = new Map();
    let currentDate = null;
    for (const rawLine of output.split('\n')) {
        const line = rawLine.trim();
        if (!line)
            continue;
        if (ISO_DATE_RE.test(line)) {
            const d = new Date(line);
            if (isNaN(d.getTime()))
                continue;
            currentDate = formatLocalDateKey(d);
            if (!result.has(currentDate))
                result.set(currentDate, { commits: 0, added: 0, removed: 0 });
            result.get(currentDate).commits += 1;
            continue;
        }
        const m = STAT_RE.exec(line);
        if (m && currentDate) {
            const entry = result.get(currentDate);
            entry.added += parseInt(m[2] || '0', 10);
            entry.removed += parseInt(m[3] || '0', 10);
        }
    }
    return result;
}
export function scanGitRepos(repoRoot, since, until) {
    const result = new Map();
    for (const repoPath of discoverGitRepos(repoRoot)) {
        const repoSlug = projectSlugFromPath(repoPath);
        try {
            const baseRef = getWorktreeBaseRef(repoPath);
            const logArgs = [
                'log',
                `--since=${since} 00:00`,
                `--until=${until} 23:59:59`,
                '--format=%aI',
                '--shortstat',
            ];
            if (baseRef) {
                // Worktree: subtract main repo's branch so we only count commits unique
                // to this checkout. Without this, every commit in the shared history
                // gets attributed to the worktree slug too.
                logArgs.push('HEAD', `^${baseRef}`);
            }
            const proc = spawnSync('git', logArgs, {
                cwd: repoPath,
                encoding: 'utf-8',
                timeout: 30_000,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            if ((proc.status ?? 1) !== 0)
                continue;
            const locMap = parseGitLogOutput(proc.stdout || '');
            const boundedLocMap = new Map();
            for (const [date, totals] of locMap) {
                if (date < since || date > until)
                    continue;
                boundedLocMap.set(date, totals);
            }
            if (boundedLocMap.size > 0)
                result.set(repoSlug, boundedLocMap);
        }
        catch {
            // Individual repo failure is non-fatal
        }
    }
    return result;
}
// ---------------------------------------------------------------------------
// Report Builder
// ---------------------------------------------------------------------------
function emptyTotals() {
    return { turns: 0, input: 0, output: 0, cache_read: 0, cache_create: 0, commits: 0, added: 0, removed: 0 };
}
export function buildReport(tokens, loc, since, until, grouping) {
    const dateSet = new Set();
    for (const dateMap of tokens.values()) {
        for (const date of dateMap.keys())
            dateSet.add(date);
    }
    for (const dateMap of loc.values()) {
        for (const date of dateMap.keys())
            dateSet.add(date);
    }
    const dates = [...dateSet].sort();
    const rows = dates.map((date) => {
        const projects = {};
        for (const [slug, dateMap] of tokens) {
            const dt = dateMap.get(date);
            if (dt)
                projects[slug] = dt;
        }
        const locData = {};
        for (const [repo, dateMap] of loc) {
            const dl = dateMap.get(date);
            if (dl)
                locData[repo] = dl;
        }
        return { date, projects, loc: locData };
    });
    const projectTotals = new Map();
    for (const [slug, dateMap] of tokens) {
        const t = emptyTotals();
        for (const dt of dateMap.values()) {
            t.turns += dt.turns;
            t.input += dt.input;
            t.output += dt.output;
            t.cache_read += dt.cache_read;
            t.cache_create += dt.cache_create;
        }
        projectTotals.set(slug, t);
    }
    for (const [slug, dateMap] of loc) {
        if (!projectTotals.has(slug))
            projectTotals.set(slug, emptyTotals());
        const target = projectTotals.get(slug);
        for (const dl of dateMap.values()) {
            target.commits += dl.commits;
            target.added += dl.added;
            target.removed += dl.removed;
        }
    }
    const projects = [...projectTotals.entries()].map(([slug, totals]) => ({
        slug,
        label: shortenSlug(slug),
        totals,
    }));
    const totals = emptyTotals();
    for (const p of projects) {
        totals.turns += p.totals.turns;
        totals.input += p.totals.input;
        totals.output += p.totals.output;
        totals.cache_read += p.totals.cache_read;
        totals.cache_create += p.totals.cache_create;
        totals.commits += p.totals.commits;
        totals.added += p.totals.added;
        totals.removed += p.totals.removed;
    }
    return { since, until, grouping, rows, projects, totals };
}

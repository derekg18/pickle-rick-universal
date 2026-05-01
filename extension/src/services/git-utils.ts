import * as fs from 'fs';
import * as path from 'path';
import { runCmd, extractFrontmatter, formatLocalDateKey } from './pickle-utils.js';
import { syncLinearTicketStatus } from './linear-integration.js';

export function runGit(cmd: string[], cwd?: string, check: boolean = true): string {
  return runCmd(['git', ...cmd], { cwd, check });
}

export function getGithubUser(): string {
  try {
    return runCmd(['gh', 'api', 'user', '-q', '.login']);
  } catch {
    try {
      return runCmd(['git', 'config', 'user.name']).replace(/\s+/g, '');
    } catch {
      return 'pickle-rick';
    }
  }
}

export function getBranchName(taskId: string): string {
  const user = getGithubUser();
  const lowerId = taskId.toLowerCase();
  const type = ['fix', 'bug', 'patch', 'issue'].some((x) => lowerId.includes(x)) ? 'fix' : 'feat';
  return `${user}/${type}/${taskId}`;
}

const MAX_TICKET_SEARCH_DEPTH = 10;

function findTicketFile(sessionDir: string, ticketId: string): string | null {
  const fileName = `linear_ticket_${ticketId}.md`;
  const walk = (dir: string, depth: number): string | null => {
    if (depth > MAX_TICKET_SEARCH_DEPTH) return null; // symlink-cycle guard
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { return null; }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      let stat: fs.Stats;
      try { stat = fs.lstatSync(fullPath); } catch { continue; } // lstat: don't follow symlinks
      if (stat.isDirectory()) {
        const hit = walk(fullPath, depth + 1);
        if (hit) return hit;
      } else if (entry === fileName) {
        return fullPath;
      }
    }
    return null;
  };
  return walk(sessionDir, 0);
}

/**
 * Rewrite `status:` / `updated:` inside the YAML frontmatter (or, if the file
 * has no frontmatter, in the whole body). Returns the new content and a flag
 * for whether a `status:` line was found.
 */
function rewriteTicketFrontmatter(
  content: string,
  ticketId: string,
  newStatus: string,
  today: string,
): { content: string; statusReplaced: boolean } {
  let statusReplaced = false;
  const fm = extractFrontmatter(content);
  if (fm) {
    let fmSection = content.slice(0, fm.end);
    if (/^status:.*$/m.test(fmSection)) {
      fmSection = fmSection.replace(/^status:.*$/m, `status: "${newStatus}"`);
      statusReplaced = true;
    }
    if (/^updated:.*$/m.test(fmSection)) {
      fmSection = fmSection.replace(/^updated:.*$/m, `updated: "${today}"`);
    } else {
      fmSection = fmSection.replace(/\n---(\r?\n?)$/, `\nupdated: "${today}"\n---$1`);
    }
    return { content: fmSection + content.slice(fm.end), statusReplaced };
  }
  console.warn(`Warning: ticket ${ticketId} has no valid YAML frontmatter — status replacement may be imprecise`);
  let out = content;
  if (/^status:.*$/m.test(out)) {
    out = out.replace(/^status:.*$/m, `status: "${newStatus}"`);
    statusReplaced = true;
  }
  out = out.replace(/^updated:.*$/m, `updated: "${today}"`);
  return { content: out, statusReplaced };
}

export function updateTicketStatus(
  ticketId: string,
  newStatus: string,
  sessionDir: string
): void {
  if (/["\n\r]/.test(newStatus)) {
    throw new Error('Invalid status value: must not contain quotes or newlines');
  }

  const ticketPath = findTicketFile(sessionDir, ticketId);
  if (!ticketPath) {
    throw new Error(`Ticket linear_ticket_${ticketId}.md not found in ${sessionDir}`);
  }

  const original = fs.readFileSync(ticketPath, 'utf-8');
  const today = formatLocalDateKey(new Date());
  const { content, statusReplaced } = rewriteTicketFrontmatter(original, ticketId, newStatus, today);

  if (!statusReplaced) {
    console.warn(`Warning: no "status:" field found in ticket ${ticketId} — status not updated`);
  }

  const tmp = `${ticketPath}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, ticketPath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore cleanup failure */ }
    throw err;
  }
  if (statusReplaced) {
    console.log(`Successfully updated ticket ${ticketId} to status "${newStatus}"`);
  }
  syncLinearTicketStatus(sessionDir, ticketId, newStatus);
}

export function getHeadSha(cwd: string): string {
  return runGit(['rev-parse', 'HEAD'], cwd).trim();
}

export function resetToSha(sha: string, cwd: string): void {
  runGit(['reset', '--hard', sha], cwd);
  runGit(['clean', '-fd'], cwd);
}

export function isWorkingTreeDirty(cwd: string, excludePrefixes?: string[]): boolean {
  const args = ['status', '--porcelain'];
  if (excludePrefixes && excludePrefixes.length > 0) {
    args.push('--', '.');
    for (const prefix of excludePrefixes) {
      const cleaned = prefix.replace(/^\.?\/+/, '').replace(/\/+$/, '');
      if (cleaned.length === 0) continue;
      args.push(`:!${cleaned}`, `:!${cleaned}/**`);
    }
  }
  return runGit(args, cwd).trim().length > 0;
}

export type DiffStatus = 'A' | 'M' | 'D' | 'R' | 'B';
export interface DiffEntry {
  path: string;
  status: DiffStatus;
}

/**
 * Returns file-level diff between `base` and `head` for `repoRoot`.
 *
 * Uses `git diff <base>...<head> --name-status -M100 -z` so renames are
 * detected only when similarity is exactly 100% (no heuristic flake), and
 * paths containing whitespace/unicode/newlines survive the NUL-delimited
 * parse intact. Deleted files (`D`) are included — the caller decides
 * whether to exclude them from any "allowed paths" set.
 *
 * Rename entries report the **new** path with status `'R'`; the old path
 * is discarded (scope-resolver does not need it).
 */
export function getDiffFiles(base: string, head: string, repoRoot: string): DiffEntry[] {
  const out = runGit(
    ['diff', `${base}...${head}`, '--name-status', '-M100', '-z'],
    repoRoot,
  );
  if (!out) return [];
  const tokens = out.split('\0').filter((t) => t.length > 0);
  const entries: DiffEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const code = tokens[i];
    if (code.startsWith('R') || code.startsWith('C')) {
      const newPath = tokens[i + 2];
      if (newPath) entries.push({ path: newPath, status: 'R' });
      i += 2;
    } else if (code === 'A' || code === 'M' || code === 'D') {
      const p = tokens[i + 1];
      if (p) entries.push({ path: p, status: code });
      i += 1;
    } else {
      const p = tokens[i + 1];
      if (p) entries.push({ path: p, status: 'B' });
      i += 1;
    }
  }
  return entries;
}

/**
 * Returns the merge-base SHA between `ref1` and `ref2` for `repoRoot`.
 * Throws via `runGit` if either ref is unknown to the repository.
 */
export function getMergeBase(ref1: string, ref2: string, repoRoot: string): string {
  return runGit(['merge-base', ref1, ref2], repoRoot).trim();
}

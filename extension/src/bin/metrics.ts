#!/usr/bin/env node
import * as path from 'path';
import * as os from 'os';
import {
  scanSessionFiles,
  scanGitRepos,
  buildReport,
  formatNumber,
  shortenSlug,
  MetricsReport,
  MetricsRow,
  MetricsTotals,
} from '../services/metrics-utils.js';
import {
  printMinimalPanel,
  Style,
  formatLocalDateKey,
  getDataRoot,
} from '../services/pickle-utils.js';

// ---------------------------------------------------------------------------
// Arg Parsing
// ---------------------------------------------------------------------------

interface ParsedMetricsArgs {
  days: number;
  since: string | null;
  weekly: boolean;
  json: boolean;
}

function parseExactLocalDate(dateStr: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const [yearRaw, monthRaw, dayRaw] = dateStr.split('-');
  const year = Number(yearRaw);
  const monthIndex = Number(monthRaw) - 1;
  const day = Number(dayRaw);
  if (!Number.isInteger(year) || !Number.isInteger(monthIndex) || !Number.isInteger(day)) return null;
  const parsed = new Date(year, monthIndex, day);
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== monthIndex ||
    parsed.getDate() !== day
  ) {
    return null;
  }
  parsed.setHours(0, 0, 0, 0);
  return parsed;
}

function consumeArg(argv: string[], i: number, flag: string, hint: string): string {
  const val = argv[i + 1];
  if (val === undefined || val.startsWith('--')) {
    console.error(`Error: ${flag} requires ${hint}.`);
    process.exit(1);
  }
  return val;
}

export function parseMetricsArgs(argv: string[]): ParsedMetricsArgs {
  let days: number | null = null;
  let since: string | null = null;
  let weekly = false;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--days') {
      const val = consumeArg(argv, i, '--days', 'a numeric value');
      i++;
      days = Number(val);
      if (!Number.isFinite(days) || days < 0 || Math.floor(days) !== days) {
        console.error(`Error: --days must be a non-negative integer, got "${val}".`);
        process.exit(1);
      }
    } else if (arg === '--since') {
      since = consumeArg(argv, i, '--since', 'a YYYY-MM-DD date');
      i++;
    } else if (arg === '--weekly') {
      weekly = true;
    } else if (arg === '--json') {
      json = true;
    } else {
      console.error(`Error: unknown flag "${arg}".`);
      process.exit(1);
    }
  }

  // --weekly alone defaults to 28 days
  if (weekly && days === null && since === null) {
    days = 28;
  }

  return { days: days ?? 7, since, weekly, json };
}

// ---------------------------------------------------------------------------
// Date Computation
// ---------------------------------------------------------------------------

function toDateStr(d: Date): string {
  return formatLocalDateKey(d);
}

function computeDateRange(args: ParsedMetricsArgs): { since: string; until: string } {
  const now = new Date();
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const until = toDateStr(todayMidnight);

  if (args.since !== null) {
    const parsed = parseExactLocalDate(args.since);
    if (parsed === null) {
      console.error(`Error: invalid date "${args.since}". Use YYYY-MM-DD format.`);
      process.exit(1);
    }
    if (parsed > todayMidnight) {
      console.error(`Error: --since date "${args.since}" is in the future.`);
      process.exit(1);
    }
    return { since: toDateStr(parsed), until };
  }

  const sinceDate = new Date(todayMidnight);
  if (args.days === 0) {
    return { since: toDateStr(todayMidnight), until };
  }
  sinceDate.setDate(sinceDate.getDate() - args.days);
  return { since: toDateStr(sinceDate), until };
}

// ---------------------------------------------------------------------------
// Daily Table Formatter
// ---------------------------------------------------------------------------

interface TableColumn {
  header: string;
  align: 'left' | 'right';
  values: string[];
}

function printTable(columns: TableColumn[]): void {
  const widths = columns.map((col) => {
    const maxVal = Math.max(...col.values.map((v) => v.length), 0);
    return Math.max(col.header.length, maxVal);
  });

  const d = Style.DIM;
  const r = Style.RESET;
  const b = Style.BOLD;

  // Header
  const headerCells = columns.map((col, i) =>
    col.align === 'right' ? col.header.padStart(widths[i]) : col.header.padEnd(widths[i])
  );
  process.stdout.write(`  ${b}${headerCells.join('   ')}${r}\n`);

  // Separator
  const sep = widths.map((w) => '─'.repeat(w)).join('───');
  process.stdout.write(`  ${d}${sep}${r}\n`);

  // Rows
  const rowCount = columns[0]?.values.length ?? 0;
  for (let row = 0; row < rowCount; row++) {
    const cells = columns.map((col, i) => {
      const val = col.values[row] ?? '';
      return col.align === 'right' ? val.padStart(widths[i]) : val.padEnd(widths[i]);
    });
    process.stdout.write(`  ${cells.join('   ')}\n`);
  }
}

function printDailyTable(report: MetricsReport): void {
  printMinimalPanel(`Metrics — ${report.since} to ${report.until}`, {
    Projects: String(report.projects.length),
    Turns: formatNumber(report.totals.turns),
    'Output Tokens': formatNumber(report.totals.output),
    Commits: formatNumber(report.totals.commits),
    'Lines (+/-)': `+${formatNumber(report.totals.added)} / -${formatNumber(report.totals.removed)}`,
  }, 'CYAN', '📊');

  if (report.rows.length === 0) return;

  const dates: string[] = [];
  const turns: string[] = [];
  const input: string[] = [];
  const output: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  const net: string[] = [];

  for (const row of report.rows) {
    dates.push(row.date);
    const rowTotals = aggregateRow(row);
    turns.push(formatNumber(rowTotals.turns));
    input.push(formatNumber(rowTotals.input));
    output.push(formatNumber(rowTotals.output));
    added.push('+' + formatNumber(rowTotals.added));
    removed.push('-' + formatNumber(rowTotals.removed));
    net.push(formatNumber(rowTotals.added - rowTotals.removed));
  }

  printTable([
    { header: 'Date', align: 'left', values: dates },
    { header: 'Turns', align: 'right', values: turns },
    { header: 'Input', align: 'right', values: input },
    { header: 'Output', align: 'right', values: output },
    { header: '+Lines', align: 'right', values: added },
    { header: '-Lines', align: 'right', values: removed },
    { header: 'Net', align: 'right', values: net },
  ]);
  process.stdout.write('\n');
}

function aggregateRow(row: MetricsRow): MetricsTotals {
  const t: MetricsTotals = { turns: 0, input: 0, output: 0, cache_read: 0, cache_create: 0, commits: 0, added: 0, removed: 0 };
  for (const tokens of Object.values(row.projects)) {
    t.turns += tokens.turns;
    t.input += tokens.input;
    t.output += tokens.output;
    t.cache_read += tokens.cache_read;
    t.cache_create += tokens.cache_create;
  }
  for (const loc of Object.values(row.loc)) {
    t.commits += loc.commits;
    t.added += loc.added;
    t.removed += loc.removed;
  }
  return t;
}

// ---------------------------------------------------------------------------
// Weekly Table Formatter
// ---------------------------------------------------------------------------

interface WeekBucket {
  label: string;
  turns: number;
  output: number;
  added: number;
  removed: number;
  projectOutput: Map<string, number>;
}

function getISOWeekMonday(dateStr: string): Date {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day; // Monday = 1
  const monday = new Date(d);
  monday.setDate(d.getDate() + diff);
  return monday;
}

function formatWeekLabel(monday: Date): string {
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const mDay = monday.getDate();
  const sDay = sunday.getDate();
  const mMonth = months[monday.getMonth()];
  const sMonth = months[sunday.getMonth()];
  if (mMonth === sMonth) {
    return `${mMonth} ${mDay}-${sDay}`;
  }
  return `${mMonth} ${mDay}-${sMonth} ${sDay}`;
}

function buildWeekBuckets(report: MetricsReport): WeekBucket[] {
  const buckets = new Map<string, WeekBucket>();

  for (const row of report.rows) {
    const monday = getISOWeekMonday(row.date);
    const key = toDateStr(monday);

    if (!buckets.has(key)) {
      buckets.set(key, {
        label: formatWeekLabel(monday),
        turns: 0,
        output: 0,
        added: 0,
        removed: 0,
        projectOutput: new Map(),
      });
    }

    const bucket = buckets.get(key)!;
    const rowTotals = aggregateRow(row);
    bucket.turns += rowTotals.turns;
    bucket.output += rowTotals.output;
    bucket.added += rowTotals.added;
    bucket.removed += rowTotals.removed;

    for (const [slug, tokens] of Object.entries(row.projects)) {
      bucket.projectOutput.set(slug, (bucket.projectOutput.get(slug) ?? 0) + tokens.output);
    }
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, bucket]) => bucket);
}

function printWeeklyTable(report: MetricsReport): void {
  printMinimalPanel(`Metrics (Weekly) — ${report.since} to ${report.until}`, {
    Weeks: String(new Set(report.rows.map((r) => toDateStr(getISOWeekMonday(r.date)))).size),
    Turns: formatNumber(report.totals.turns),
    'Output Tokens': formatNumber(report.totals.output),
    Commits: formatNumber(report.totals.commits),
  }, 'CYAN', '📊');

  const weeks = buildWeekBuckets(report);
  if (weeks.length === 0) return;

  const labels: string[] = [];
  const turns: string[] = [];
  const output: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  const delta: string[] = [];
  const topProject: string[] = [];

  for (let i = 0; i < weeks.length; i++) {
    const w = weeks[i];
    labels.push(w.label);
    turns.push(formatNumber(w.turns));
    output.push(formatNumber(w.output));
    added.push('+' + formatNumber(w.added));
    removed.push('-' + formatNumber(w.removed));

    if (i === 0) {
      delta.push('—');
    } else {
      const prev = weeks[i - 1].output;
      const diff = w.output - prev;
      const sign = diff >= 0 ? '+' : '';
      delta.push(sign + formatNumber(diff));
    }

    let maxSlug = '';
    let maxOut = 0;
    for (const [slug, out] of w.projectOutput) {
      if (out > maxOut) {
        maxSlug = slug;
        maxOut = out;
      }
    }
    topProject.push(maxSlug ? shortenSlug(maxSlug) : '—');
  }

  printTable([
    { header: 'Week', align: 'left', values: labels },
    { header: 'Turns', align: 'right', values: turns },
    { header: 'Output', align: 'right', values: output },
    { header: '+Lines', align: 'right', values: added },
    { header: '-Lines', align: 'right', values: removed },
    { header: 'Δ Output', align: 'right', values: delta },
    { header: 'Top Project', align: 'left', values: topProject },
  ]);
  process.stdout.write('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const args = parseMetricsArgs(process.argv.slice(2));
  const { since, until } = computeDateRange(args);

  const projectsDir = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
  const repoRoot = process.env.METRICS_REPO_ROOT || path.join(os.homedir(), 'loanlight');
  const cachePath = path.join(getDataRoot(), 'metrics-cache.json');

  const tokens = scanSessionFiles(projectsDir, since, until, cachePath);
  const loc = scanGitRepos(repoRoot, since, until);
  const grouping = args.weekly ? 'weekly' : 'daily';
  const report = buildReport(tokens, loc, since, until, grouping);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (report.rows.length === 0) {
    console.log(`No metrics data found for ${since} to ${until}.`);
    return;
  }

  if (args.weekly) {
    printWeeklyTable(report);
  } else {
    printDailyTable(report);
  }
}

if (process.argv[1] && path.basename(process.argv[1]) === 'metrics.js') {
  main();
}

import * as fs from 'fs';
import * as path from 'path';
import type { Backend } from '../../types/index.js';
import { BACKENDS } from '../../types/index.js';
import { logActivity } from '../activity-logger.js';
import { notifySessionEvent, type NotifySessionEventOptions } from '../notification-dispatcher.js';
import { safeErrorMessage } from '../pickle-utils.js';
import { parseClaudeTokenUsageFile } from './claude-parser.js';
import { parseCodexTokenUsageFile } from './codex-parser.js';
import { parseGeminiTokenUsageFile } from './gemini-parser.js';
import { estimateRecordCost } from './pricing.js';
import { sumKnown, unknownRecord } from './parser-utils.js';
import type { TokenAccountingArtifacts, TokenCostConfidence, TokenUsageRecord, TokenUsageSummary, TokenUsageTotals } from './types.js';

const ARTIFACT_JSON = 'token-accounting.json';
const ARTIFACT_MARKDOWN = 'token-accounting.md';
const MAX_SCAN_DEPTH = 4;
const MAX_SCAN_BYTES = 10 * 1024 * 1024;
const CANDIDATE_EXTENSIONS = new Set(['.jsonl', '.log', '.txt', '.json']);

type Parser = (filePath: string) => { records: TokenUsageRecord[] };

const PARSERS: Record<Backend, Parser> = {
  claude: parseClaudeTokenUsageFile,
  codex: parseCodexTokenUsageFile,
  gemini: parseGeminiTokenUsageFile,
};

export interface WriteTokenAccountingOptions {
  backend?: Backend;
  now?: Date;
  notifyOptions?: NotifySessionEventOptions;
  emitNotification?: boolean;
  emitActivity?: boolean;
}

function listCandidateFiles(sessionDir: string): string[] {
  const files: string[] = [];
  function walk(dir: string, depth: number): void {
    if (depth > MAX_SCAN_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        walk(fullPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name === ARTIFACT_JSON || entry.name === ARTIFACT_MARKDOWN) continue;
      if (!CANDIDATE_EXTENSIONS.has(path.extname(entry.name))) continue;
      try {
        if (fs.statSync(fullPath).size > MAX_SCAN_BYTES) continue;
      } catch {
        continue;
      }
      files.push(fullPath);
    }
  }
  walk(sessionDir, 0);
  return files.sort();
}

function likelyBackendForPath(filePath: string, backend: Backend): boolean {
  return path.basename(filePath).toLowerCase().includes(backend);
}

function collectRecords(sessionDir: string, backend?: Backend): TokenUsageRecord[] {
  const candidates = listCandidateFiles(sessionDir);
  const backends = backend ? [backend] : [...BACKENDS];
  const records: TokenUsageRecord[] = [];
  for (const currentBackend of backends) {
    const backendFiles = backend ? candidates : candidates.filter((file) => likelyBackendForPath(file, currentBackend));
    for (const file of backendFiles) {
      const parsed = PARSERS[currentBackend](file).records.filter((record) => record.source !== 'unknown');
      records.push(...parsed);
    }
  }
  if (records.length > 0) return records;
  return [unknownRecord(backend, undefined, 'No backend token usage logs found')];
}

function confidenceRank(confidence: TokenCostConfidence): number {
  if (confidence === 'exact') return 3;
  if (confidence === 'estimated') return 2;
  return 1;
}

function summarizeConfidence(records: TokenUsageRecord[]): TokenCostConfidence {
  if (records.length === 0) return 'unknown';
  return records.reduce<TokenCostConfidence>((lowest, record) => (
    confidenceRank(record.cost_confidence) < confidenceRank(lowest) ? record.cost_confidence : lowest
  ), 'exact');
}

function summarizeTotals(records: TokenUsageRecord[]): TokenUsageTotals {
  return {
    input_tokens: sumKnown(records.map((record) => record.input_tokens)),
    output_tokens: sumKnown(records.map((record) => record.output_tokens)),
    cache_read_input_tokens: sumKnown(records.map((record) => record.cache_read_input_tokens)),
    cache_creation_input_tokens: sumKnown(records.map((record) => record.cache_creation_input_tokens)),
    total_tokens: sumKnown(records.map((record) => record.total_tokens)),
    cost_usd: sumKnown(records.map((record) => record.cost_usd)),
  };
}

function valueOrUnknown(value: number | null, digits?: number): string {
  if (value === null) return 'unknown';
  return typeof digits === 'number' ? value.toFixed(digits) : String(value);
}

export function renderTokenAccountingMarkdown(summary: TokenUsageSummary): string {
  const lines = [
    '# Token Accounting',
    '',
    `Generated: ${summary.generated_at}`,
    `Cost confidence: ${summary.cost_confidence}`,
    `Pricing table updated: ${summary.pricing_table_updated_at ?? 'unknown'}`,
    '',
    '## Totals',
    '',
    `- Input tokens: ${valueOrUnknown(summary.totals.input_tokens)}`,
    `- Output tokens: ${valueOrUnknown(summary.totals.output_tokens)}`,
    `- Cache read input tokens: ${valueOrUnknown(summary.totals.cache_read_input_tokens)}`,
    `- Cache creation input tokens: ${valueOrUnknown(summary.totals.cache_creation_input_tokens)}`,
    `- Total tokens: ${valueOrUnknown(summary.totals.total_tokens)}`,
    `- Estimated cost USD: ${valueOrUnknown(summary.totals.cost_usd, 6)}`,
    '',
    '## Records',
    '',
    '| Source | Model | Input | Output | Total | Cost USD | Confidence | File |',
    '|---|---|---:|---:|---:|---:|---|---|',
  ];
  for (const record of summary.records) {
    lines.push([
      record.source,
      record.model ?? 'unknown',
      valueOrUnknown(record.input_tokens),
      valueOrUnknown(record.output_tokens),
      valueOrUnknown(record.total_tokens),
      valueOrUnknown(record.cost_usd, 6),
      record.cost_confidence,
      record.source_path ? path.basename(record.source_path) : 'unknown',
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }
  return `${lines.join('\n')}\n`;
}

export function buildTokenUsageSummary(
  sessionDir: string,
  records: TokenUsageRecord[],
  jsonPath: string,
  markdownPath: string,
  now = new Date(),
): TokenUsageSummary {
  let pricingUpdatedAt: string | null = null;
  const pricedRecords = records.map((record) => {
    const pricing = estimateRecordCost(record, now);
    if (pricing.pricing_table_updated_at && !pricingUpdatedAt) pricingUpdatedAt = pricing.pricing_table_updated_at;
    return { ...record, cost_usd: pricing.cost_usd, cost_confidence: pricing.cost_confidence };
  });
  const totals = summarizeTotals(pricedRecords);
  return {
    generated_at: now.toISOString(),
    session_dir: sessionDir,
    records: pricedRecords,
    totals,
    cost_confidence: summarizeConfidence(pricedRecords),
    pricing_table_updated_at: pricingUpdatedAt,
    artifacts: {
      json: jsonPath,
      markdown: markdownPath,
    },
  };
}

export function writeTokenAccountingReports(sessionDir: string, opts: WriteTokenAccountingOptions = {}): TokenAccountingArtifacts {
  const memoryDir = path.join(sessionDir, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  const jsonPath = path.join(memoryDir, ARTIFACT_JSON);
  const markdownPath = path.join(memoryDir, ARTIFACT_MARKDOWN);
  const summary = buildTokenUsageSummary(sessionDir, collectRecords(sessionDir, opts.backend), jsonPath, markdownPath, opts.now);
  fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2));
  fs.writeFileSync(markdownPath, renderTokenAccountingMarkdown(summary));
  return { summary, jsonPath, markdownPath };
}

export function finalizeTokenAccounting(sessionDir: string, opts: WriteTokenAccountingOptions = {}): TokenAccountingArtifacts | null {
  try {
    const artifacts = writeTokenAccountingReports(sessionDir, opts);
    const session = path.basename(sessionDir);
    if (opts.emitActivity !== false) {
      logActivity({
        event: 'token_report',
        source: 'pickle',
        session,
        backend: opts.backend,
        tokens_in_estimated: artifacts.summary.totals.input_tokens ?? undefined,
        tokens_out_estimated: artifacts.summary.totals.output_tokens ?? undefined,
        model: artifacts.summary.records.find((record) => record.model)?.model,
      });
    }
    if (opts.emitNotification !== false) {
      notifySessionEvent({
        kind: 'token_accounting_ready',
        session,
        severity: artifacts.summary.cost_confidence === 'unknown' ? 'warning' : 'info',
        title: 'Token Accounting Ready',
        body: `${artifacts.summary.records.length} records, ${artifacts.summary.cost_confidence} cost confidence`,
        subtitle: path.relative(sessionDir, artifacts.markdownPath),
      }, opts.notifyOptions);
    }
    return artifacts;
  } catch (err) {
    process.stderr.write(`[token-accounting] Failed to write token accounting report: ${safeErrorMessage(err)}\n`);
    return null;
  }
}

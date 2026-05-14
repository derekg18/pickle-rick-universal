import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseClaudeTokenUsageFile } from '../services/token-accounting/claude-parser.js';
import { parseCodexTokenUsageFile } from '../services/token-accounting/codex-parser.js';
import { parseGeminiTokenUsageFile } from '../services/token-accounting/gemini-parser.js';
import {
  buildTokenUsageSummary,
  finalizeTokenAccounting,
  renderTokenAccountingMarkdown,
  writeTokenAccountingReports,
} from '../services/token-accounting/index.js';
import { estimateRecordCost } from '../services/token-accounting/pricing.js';
import { formatLocalDateKey } from '../services/pickle-utils.js';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const FIXTURES = path.join(__dirname, 'fixtures', 'token-accounting');

const parserCases = [
  {
    backend: 'claude',
    file: 'claude.jsonl',
    parse: parseClaudeTokenUsageFile,
    expected: { input_tokens: 1000, output_tokens: 250, total_tokens: 1250 },
  },
  {
    backend: 'codex',
    file: 'codex.log',
    parse: parseCodexTokenUsageFile,
    expected: { input_tokens: 1200, output_tokens: 300, total_tokens: 1500 },
  },
  {
    backend: 'gemini',
    file: 'gemini.jsonl',
    parse: parseGeminiTokenUsageFile,
    expected: { input_tokens: 900, output_tokens: 100, total_tokens: 1000 },
  },
];

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readActivityEvents(activityDir) {
  if (!fs.existsSync(activityDir)) return [];
  return fs.readdirSync(activityDir)
    .filter((file) => file.endsWith('.jsonl'))
    .flatMap((file) => fs.readFileSync(path.join(activityDir, file), 'utf-8').trim().split(/\r?\n/).filter(Boolean))
    .map((line) => JSON.parse(line));
}

describe('token accounting parsers', () => {
  for (const { backend, file, parse, expected } of parserCases) {
    test(`${backend}: exact fixture follows shared schema`, () => {
      const result = parse(path.join(FIXTURES, file));
      assert.equal(result.records.length, 1);
      assert.deepEqual(
        {
          source: result.records[0].source,
          backend: result.records[0].backend,
          input_tokens: result.records[0].input_tokens,
          output_tokens: result.records[0].output_tokens,
          total_tokens: result.records[0].total_tokens,
          cost_usd: result.records[0].cost_usd,
          cost_confidence: result.records[0].cost_confidence,
        },
        {
          source: backend,
          backend,
          ...expected,
          cost_usd: null,
          cost_confidence: 'unknown',
        },
      );
    });

    test(`${backend}: missing fixture produces unknown record`, () => {
      const result = parse(path.join(FIXTURES, `${backend}-missing.log`));
      assert.equal(result.records.length, 1);
      assert.equal(result.records[0].source, 'unknown');
      assert.equal(result.records[0].backend, backend);
      assert.equal(result.records[0].input_tokens, null);
      assert.equal(result.records[0].total_tokens, null);
    });
  }
});

test('renderTokenAccountingMarkdown: unknown numeric values are rendered as unknown', () => {
  const summary = buildTokenUsageSummary(
    '/tmp/session',
    [{
      source: 'unknown',
      input_tokens: null,
      output_tokens: null,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
      total_tokens: null,
      cost_usd: null,
      cost_confidence: 'unknown',
    }],
    '/tmp/session/memory/token-accounting.json',
    '/tmp/session/memory/token-accounting.md',
    new Date('2026-05-13T12:00:00Z'),
  );
  const markdown = renderTokenAccountingMarkdown(summary);
  assert.match(markdown, /Input tokens: unknown/);
  assert.match(markdown, /Estimated cost USD: unknown/);
  assert.equal(markdown.includes('Input tokens: 0'), false);
  assert.equal(markdown.includes('null'), false);
});

test('pricing: stale pricing table degrades confidence to unknown', () => {
  const result = estimateRecordCost(
    {
      source: 'claude',
      model: 'claude-3-5-sonnet',
      input_tokens: 1000,
      output_tokens: 2000,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
      total_tokens: 3000,
      cost_usd: null,
      cost_confidence: 'unknown',
    },
    new Date('2026-05-13T00:00:00Z'),
    [{ modelPattern: /claude/i, inputPerMillionUsd: 3, outputPerMillionUsd: 15, updatedAt: '2025-01-01' }],
  );
  assert.equal(result.cost_confidence, 'unknown');
  assert.equal(result.cost_usd, null);
});

test('writeTokenAccountingReports: writes JSON and markdown reports', () => {
  const sessionDir = mkTmp('pickle-token-accounting-');
  try {
    fs.copyFileSync(path.join(FIXTURES, 'claude.jsonl'), path.join(sessionDir, 'claude.jsonl'));
    const artifacts = writeTokenAccountingReports(sessionDir, {
      backend: 'claude',
      now: new Date('2026-05-13T12:00:00Z'),
    });
    assert.equal(fs.existsSync(artifacts.jsonPath), true);
    assert.equal(fs.existsSync(artifacts.markdownPath), true);
    const summary = JSON.parse(fs.readFileSync(artifacts.jsonPath, 'utf-8'));
    assert.equal(summary.totals.input_tokens, 1000);
    assert.equal(summary.artifacts.markdown, artifacts.markdownPath);
    assert.match(fs.readFileSync(artifacts.markdownPath, 'utf-8'), /# Token Accounting/);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('finalizeTokenAccounting: emits token report activity and notification after write success', () => {
  const sessionDir = mkTmp('pickle-token-finalize-');
  const dataRoot = mkTmp('pickle-token-data-');
  const previousExtensionDir = process.env.EXTENSION_DIR;
  const terminalLines = [];
  try {
    process.env.EXTENSION_DIR = dataRoot;
    fs.copyFileSync(path.join(FIXTURES, 'claude.jsonl'), path.join(sessionDir, 'claude.jsonl'));
    const artifacts = finalizeTokenAccounting(sessionDir, {
      backend: 'claude',
      now: new Date('2026-05-13T12:00:00Z'),
      notifyOptions: {
        settings: { os_enabled: false, terminal_fallback: true, dedup_window_ms: 1 },
        terminalWrite: (line) => terminalLines.push(line),
      },
    });
    assert.ok(artifacts);
    assert.equal(fs.existsSync(artifacts.jsonPath), true);
    assert.equal(fs.existsSync(artifacts.markdownPath), true);
    assert.equal(terminalLines.some((line) => line.includes('Token Accounting Ready')), true);
    const activityDir = path.join(dataRoot, 'activity');
    const events = readActivityEvents(activityDir);
    const event = events.find((entry) => entry.event === 'token_report');
    assert.ok(event);
    assert.equal(event.session, path.basename(sessionDir));
    assert.equal(event.backend, 'claude');
    assert.equal(event.tokens_in_estimated, 1000);
    assert.equal(fs.existsSync(path.join(activityDir, `${formatLocalDateKey(new Date())}.jsonl`)), true);
  } finally {
    if (previousExtensionDir === undefined) delete process.env.EXTENSION_DIR;
    else process.env.EXTENSION_DIR = previousExtensionDir;
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

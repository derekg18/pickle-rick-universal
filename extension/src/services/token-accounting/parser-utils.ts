import * as fs from 'fs';
import type { Backend } from '../../types/index.js';
import type { BackendParserResult, TokenUsageRecord } from './types.js';

export function unknownRecord(backend?: Backend, sourcePath?: string, note = 'No token usage data found'): TokenUsageRecord {
  return {
    source: 'unknown',
    backend,
    source_path: sourcePath,
    input_tokens: null,
    output_tokens: null,
    cache_read_input_tokens: null,
    cache_creation_input_tokens: null,
    total_tokens: null,
    cost_usd: null,
    cost_confidence: 'unknown',
    notes: [note],
  };
}

export function numberOrUnknown(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const normalized = value.replace(/,/g, '').trim();
    if (normalized.length === 0) return null;
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return null;
}

export function sumKnown(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => typeof value === 'number');
  if (known.length === 0) return null;
  return known.reduce((sum, value) => sum + value, 0);
}

export function readTextFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

export function parseJsonLines(content: string): unknown[] {
  const parsed: unknown[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      parsed.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return parsed;
}

export function resultWithUnknown(backend: Backend, sourcePath?: string, note?: string): BackendParserResult {
  return { records: [unknownRecord(backend, sourcePath, note)], warnings: note ? [note] : [] };
}

export function stableTotal(input: number | null, output: number | null, explicitTotal?: unknown): number | null {
  const parsedTotal = numberOrUnknown(explicitTotal);
  if (parsedTotal !== null) return parsedTotal;
  return sumKnown([input, output]);
}

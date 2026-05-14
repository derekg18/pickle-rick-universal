import type { BackendParserResult, TokenUsageRecord } from './types.js';
import { numberOrUnknown, parseJsonLines, readTextFile, resultWithUnknown, stableTotal } from './parser-utils.js';

const TOKENS_USED_RE = /tokens used\s*:?\s*(?:(?<input>[\d,]+)\s+input)?(?:[,\s]+)?(?:(?<output>[\d,]+)\s+output)?(?:[,\s]+)?(?:(?<total>[\d,]+)\s+total)?/i;

export function parseCodexTokenUsageFile(filePath: string): BackendParserResult {
  const content = readTextFile(filePath);
  if (content === null) return resultWithUnknown('codex', filePath, 'Codex log missing or unreadable');
  return parseCodexTokenUsage(content, filePath);
}

export function parseCodexTokenUsage(content: string, sourcePath?: string): BackendParserResult {
  const records: TokenUsageRecord[] = [];
  for (const obj of parseJsonLines(content)) {
    if (!obj || typeof obj !== 'object') continue;
    const event = obj as Record<string, unknown>;
    const usage = event.usage && typeof event.usage === 'object'
      ? event.usage as Record<string, unknown>
      : event.token_usage && typeof event.token_usage === 'object'
        ? event.token_usage as Record<string, unknown>
        : null;
    if (!usage) continue;
    const input = numberOrUnknown(usage.input_tokens ?? usage.prompt_tokens);
    const output = numberOrUnknown(usage.output_tokens ?? usage.completion_tokens);
    records.push({
      source: 'codex',
      backend: 'codex',
      source_path: sourcePath,
      timestamp: typeof event.timestamp === 'string' ? event.timestamp : undefined,
      model: typeof event.model === 'string' ? event.model : undefined,
      input_tokens: input,
      output_tokens: output,
      cache_read_input_tokens: numberOrUnknown(usage.cache_read_input_tokens),
      cache_creation_input_tokens: numberOrUnknown(usage.cache_creation_input_tokens),
      total_tokens: stableTotal(input, output, usage.total_tokens),
      cost_usd: null,
      cost_confidence: 'unknown',
    });
  }

  const textContent = typeof content === 'string' ? content : '';
  for (const rawLine of textContent.split(/\r?\n/)) {
    const match = rawLine.match(TOKENS_USED_RE);
    if (!match?.groups) continue;
    const input = numberOrUnknown(match.groups.input);
    const output = numberOrUnknown(match.groups.output);
    const total = stableTotal(input, output, match.groups.total);
    if (input === null && output === null && total === null) continue;
    records.push({
      source: 'codex',
      backend: 'codex',
      source_path: sourcePath,
      input_tokens: input,
      output_tokens: output,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
      total_tokens: total,
      cost_usd: null,
      cost_confidence: 'unknown',
    });
  }

  return records.length > 0
    ? { records, warnings: [] }
    : resultWithUnknown('codex', sourcePath, 'Codex log had no token usage records');
}

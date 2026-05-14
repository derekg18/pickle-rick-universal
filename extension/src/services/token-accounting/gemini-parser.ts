import type { BackendParserResult, TokenUsageRecord } from './types.js';
import { numberOrUnknown, parseJsonLines, readTextFile, resultWithUnknown, stableTotal } from './parser-utils.js';

export function parseGeminiTokenUsageFile(filePath: string): BackendParserResult {
  const content = readTextFile(filePath);
  if (content === null) return resultWithUnknown('gemini', filePath, 'Gemini log missing or unreadable');
  return parseGeminiTokenUsage(content, filePath);
}

export function parseGeminiTokenUsage(content: string, sourcePath?: string): BackendParserResult {
  const records: TokenUsageRecord[] = [];
  for (const obj of parseJsonLines(content)) {
    if (!obj || typeof obj !== 'object') continue;
    const event = obj as Record<string, unknown>;
    const usage = event.usageMetadata && typeof event.usageMetadata === 'object'
      ? event.usageMetadata as Record<string, unknown>
      : event.usage && typeof event.usage === 'object'
        ? event.usage as Record<string, unknown>
        : null;
    if (!usage) continue;
    const input = numberOrUnknown(usage.promptTokenCount ?? usage.input_tokens);
    const output = numberOrUnknown(usage.candidatesTokenCount ?? usage.output_tokens);
    records.push({
      source: 'gemini',
      backend: 'gemini',
      source_path: sourcePath,
      timestamp: typeof event.timestamp === 'string' ? event.timestamp : undefined,
      model: typeof event.model === 'string' ? event.model : undefined,
      input_tokens: input,
      output_tokens: output,
      cache_read_input_tokens: numberOrUnknown(usage.cachedContentTokenCount),
      cache_creation_input_tokens: null,
      total_tokens: stableTotal(input, output, usage.totalTokenCount ?? usage.total_tokens),
      cost_usd: null,
      cost_confidence: 'unknown',
    });
  }
  return records.length > 0
    ? { records, warnings: [] }
    : resultWithUnknown('gemini', sourcePath, 'Gemini log had no token usage records');
}

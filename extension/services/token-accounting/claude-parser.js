import { numberOrUnknown, parseJsonLines, readTextFile, resultWithUnknown, stableTotal } from './parser-utils.js';
export function parseClaudeTokenUsageFile(filePath) {
    const content = readTextFile(filePath);
    if (content === null)
        return resultWithUnknown('claude', filePath, 'Claude transcript missing or unreadable');
    return parseClaudeTokenUsage(content, filePath);
}
export function parseClaudeTokenUsage(content, sourcePath) {
    const records = [];
    for (const obj of parseJsonLines(content)) {
        if (!obj || typeof obj !== 'object')
            continue;
        const event = obj;
        const message = event.message && typeof event.message === 'object'
            ? event.message
            : {};
        const usage = message.usage && typeof message.usage === 'object'
            ? message.usage
            : event.usage && typeof event.usage === 'object'
                ? event.usage
                : null;
        if (!usage)
            continue;
        const input = numberOrUnknown(usage.input_tokens);
        const output = numberOrUnknown(usage.output_tokens);
        records.push({
            source: 'claude',
            backend: 'claude',
            source_path: sourcePath,
            timestamp: typeof event.timestamp === 'string' ? event.timestamp : undefined,
            model: typeof message.model === 'string' ? message.model : typeof event.model === 'string' ? event.model : undefined,
            input_tokens: input,
            output_tokens: output,
            cache_read_input_tokens: numberOrUnknown(usage.cache_read_input_tokens),
            cache_creation_input_tokens: numberOrUnknown(usage.cache_creation_input_tokens),
            total_tokens: stableTotal(input, output, usage.total_tokens),
            cost_usd: null,
            cost_confidence: 'unknown',
        });
    }
    return records.length > 0
        ? { records, warnings: [] }
        : resultWithUnknown('claude', sourcePath, 'Claude transcript had no assistant usage records');
}

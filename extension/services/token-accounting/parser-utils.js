import * as fs from 'fs';
export function unknownRecord(backend, sourcePath, note = 'No token usage data found') {
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
export function numberOrUnknown(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return Math.trunc(value);
    if (typeof value === 'string') {
        const normalized = value.replace(/,/g, '').trim();
        if (normalized.length === 0)
            return null;
        const parsed = Number(normalized);
        if (Number.isFinite(parsed))
            return Math.trunc(parsed);
    }
    return null;
}
export function sumKnown(values) {
    const known = values.filter((value) => typeof value === 'number');
    if (known.length === 0)
        return null;
    return known.reduce((sum, value) => sum + value, 0);
}
export function readTextFile(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf-8');
    }
    catch {
        return null;
    }
}
export function parseJsonLines(content) {
    if (typeof content !== 'string')
        return [];
    const parsed = [];
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line)
            continue;
        try {
            parsed.push(JSON.parse(line));
        }
        catch {
            continue;
        }
    }
    return parsed;
}
export function resultWithUnknown(backend, sourcePath, note) {
    return { records: [unknownRecord(backend, sourcePath, note)], warnings: note ? [note] : [] };
}
export function stableTotal(input, output, explicitTotal) {
    const parsedTotal = numberOrUnknown(explicitTotal);
    if (parsedTotal !== null)
        return parsedTotal;
    return sumKnown([input, output]);
}

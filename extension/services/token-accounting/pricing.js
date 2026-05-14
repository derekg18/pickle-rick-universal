export const PRICING_STALE_AFTER_DAYS = 90;
export const DEFAULT_PRICING_TABLE = [
    { modelPattern: /claude.*sonnet/i, inputPerMillionUsd: 3, outputPerMillionUsd: 15, updatedAt: '2026-05-01' },
    { modelPattern: /claude.*opus/i, inputPerMillionUsd: 15, outputPerMillionUsd: 75, updatedAt: '2026-05-01' },
    { modelPattern: /gpt-5|codex/i, inputPerMillionUsd: 1.25, outputPerMillionUsd: 10, updatedAt: '2026-05-01' },
    { modelPattern: /gemini/i, inputPerMillionUsd: 1.25, outputPerMillionUsd: 10, updatedAt: '2026-05-01' },
];
function daysBetween(a, b) {
    return Math.abs(a.getTime() - b.getTime()) / 86_400_000;
}
export function isPricingEntryStale(entry, now = new Date()) {
    const updated = new Date(`${entry.updatedAt}T00:00:00Z`);
    if (!Number.isFinite(updated.getTime()))
        return true;
    return daysBetween(now, updated) > PRICING_STALE_AFTER_DAYS;
}
export function estimateRecordCost(record, now = new Date(), table = DEFAULT_PRICING_TABLE) {
    if (!record.model) {
        return { cost_usd: null, cost_confidence: 'unknown', pricing_table_updated_at: null };
    }
    const entry = table.find((candidate) => candidate.modelPattern.test(record.model ?? ''));
    if (!entry || isPricingEntryStale(entry, now)) {
        return { cost_usd: null, cost_confidence: 'unknown', pricing_table_updated_at: entry?.updatedAt ?? null };
    }
    if (record.input_tokens === null || record.output_tokens === null) {
        return { cost_usd: null, cost_confidence: 'unknown', pricing_table_updated_at: entry.updatedAt };
    }
    const inputCost = (record.input_tokens / 1_000_000) * entry.inputPerMillionUsd;
    const outputCost = (record.output_tokens / 1_000_000) * entry.outputPerMillionUsd;
    return {
        cost_usd: Number((inputCost + outputCost).toFixed(6)),
        cost_confidence: 'estimated',
        pricing_table_updated_at: entry.updatedAt,
    };
}

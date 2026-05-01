const SEVERITY_ORDER = ['P0', 'P1', 'P2', 'P3', 'P4'];
export function maxSeverity(severities) {
    if (severities.length === 0) {
        throw new Error('maxSeverity requires at least one severity value');
    }
    let minIndex = Infinity;
    for (const s of severities) {
        const idx = SEVERITY_ORDER.indexOf(s);
        if (idx === -1) {
            throw new TypeError(`Unknown severity literal: ${s}`);
        }
        if (idx < minIndex)
            minIndex = idx;
    }
    return SEVERITY_ORDER[minIndex];
}

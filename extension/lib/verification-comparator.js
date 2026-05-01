export function structuralEqual(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b)) {
        throw new TypeError('structuralEqual requires two string arrays');
    }
    return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}

export function structuralEqual(a: string[], b: string[]): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) {
    throw new TypeError('structuralEqual requires two string arrays');
  }
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}

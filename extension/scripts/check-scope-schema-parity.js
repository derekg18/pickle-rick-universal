// CI parity check: the hand-maintained `extension/schemas/scope-v1.json`
// must match `buildScopeV1Schema()` byte-by-byte (via deep equality). Any
// TS type change without a schema update trips this and fails release.
import * as fs from 'fs';
import * as path from 'path';
import { buildScopeV1Schema } from '../services/scope-resolver.js';
// eslint-disable-next-line complexity -- pre-existing — outside T0–T15 god-fn refactor scope; defer to follow-up epic
function deepEqual(a, b) {
    if (a === b)
        return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object')
        return false;
    if (Array.isArray(a) !== Array.isArray(b))
        return false;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length)
            return false;
        for (let i = 0; i < a.length; i++)
            if (!deepEqual(a[i], b[i]))
                return false;
        return true;
    }
    const ao = a;
    const bo = b;
    const ak = Object.keys(ao).sort();
    const bk = Object.keys(bo).sort();
    if (ak.length !== bk.length)
        return false;
    for (let i = 0; i < ak.length; i++) {
        if (ak[i] !== bk[i])
            return false;
        if (!deepEqual(ao[ak[i]], bo[bk[i]]))
            return false;
    }
    return true;
}
export function runParityCheck(schemaPath) {
    const expected = buildScopeV1Schema();
    const committed = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
    if (deepEqual(expected, committed)) {
        return { ok: true, message: `scope-v1.json parity OK (${schemaPath})` };
    }
    return {
        ok: false,
        message: `scope-v1.json drift vs buildScopeV1Schema():\n` +
            `  expected: ${JSON.stringify(expected)}\n` +
            `  committed: ${JSON.stringify(committed)}`,
    };
}
if (process.argv[1] && path.basename(process.argv[1]) === 'check-scope-schema-parity.js') {
    const here = path.dirname(process.argv[1]);
    const schemaPath = path.resolve(here, '..', 'schemas', 'scope-v1.json');
    const result = runParityCheck(schemaPath);
    if (!result.ok) {
        console.error(result.message);
        process.exit(1);
    }
    console.log(result.message);
}

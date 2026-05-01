import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildScopeV1Schema } from '../services/scope-resolver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(__dirname, '..', 'schemas', 'scope-v1.json');

test('scope-v1.json matches buildScopeV1Schema() output', () => {
    const committed = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'));
    const expected = buildScopeV1Schema();
    assert.deepStrictEqual(
        committed,
        expected,
        `scope-v1.json at ${SCHEMA_PATH} has drifted from buildScopeV1Schema(). ` +
        `Regenerate with: node -e "import('./services/scope-resolver.js').then(m => ` +
        `process.stdout.write(JSON.stringify(m.buildScopeV1Schema(), null, 2) + '\\n'))" > schemas/scope-v1.json`,
    );
});

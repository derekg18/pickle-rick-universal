/**
 * AC-SSV-08 — deploy/source schema-version parity CI test.
 *
 * Asserts that the compiled `extension/types/index.js` reflects the same
 * schemaVersion constant as the source `extension/src/types/index.ts`.
 * Run `npx tsc` from `extension/` if this fails due to a stale compiled output.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_TYPES = path.resolve(__dirname, '..', 'src', 'types', 'index.ts');
const COMPILED_TYPES = path.resolve(__dirname, '..', 'types', 'index.js');

function extractSchemaVersion(content, label) {
  const m = content.match(/schemaVersion\s*[=:]\s*(\d+)/);
  if (!m) throw new Error(`Could not find schemaVersion in ${label}`);
  return m[1];
}

function extractLatestSchemaVersion(content, label) {
  const m = content.match(/LATEST_SCHEMA_VERSION\s*=\s*(\d+)/);
  if (!m) throw new Error(`Could not find LATEST_SCHEMA_VERSION in ${label}`);
  return m[1];
}

test('state-schema-version deploy/source parity: schemaVersion and LATEST_SCHEMA_VERSION match', () => {
  const src = readFileSync(SRC_TYPES, 'utf-8');
  const compiled = readFileSync(COMPILED_TYPES, 'utf-8');

  const srcSchemaVersion = extractSchemaVersion(src, 'src/types/index.ts');
  const compiledSchemaVersion = extractSchemaVersion(compiled, 'types/index.js');
  assert.equal(
    compiledSchemaVersion,
    srcSchemaVersion,
    `Compiled types/index.js schemaVersion=${compiledSchemaVersion} does not match ` +
    `src/types/index.ts schemaVersion=${srcSchemaVersion}. Run: npx tsc`,
  );

  const srcLatest = extractLatestSchemaVersion(src, 'src/types/index.ts');
  const compiledLatest = extractLatestSchemaVersion(compiled, 'types/index.js');
  assert.equal(
    compiledLatest,
    srcLatest,
    `Compiled types/index.js LATEST_SCHEMA_VERSION=${compiledLatest} does not match ` +
    `src/types/index.ts LATEST_SCHEMA_VERSION=${srcLatest}. Run: npx tsc`,
  );

  assert.equal(
    srcSchemaVersion,
    srcLatest,
    `src/types/index.ts schemaVersion=${srcSchemaVersion} must equal LATEST_SCHEMA_VERSION=${srcLatest}`,
  );
});

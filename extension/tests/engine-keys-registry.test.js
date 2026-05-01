import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadEngineKeysRegistry,
  isEngineWritten,
  isUserWritten,
} from '../lib/engine-keys-registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURE_DIR = path.join(__dirname, '__fixtures__', 'engine-keys-registry');
const REAL_REGISTRY = path.resolve(__dirname, '..', 'data', 'engine-injected-keys.json');

describe('loadEngineKeysRegistry', () => {
  test('rejects schema_version 2 with schema_version in message', () => {
    const fixturePath = path.join(FIXTURE_DIR, 'invalid-schema-version.json');
    assert.throws(
      () => loadEngineKeysRegistry(fixturePath),
      /schema_version/
    );
  });

  test('rejects schema_version 1 registry with malformed array fields', () => {
    const fixturePath = path.join(FIXTURE_DIR, 'malformed-arrays.json');
    assert.throws(
      () => loadEngineKeysRegistry(fixturePath),
      /engine_keys must be an array of strings/
    );
  });

  test('loads real registry without error', () => {
    const reg = loadEngineKeysRegistry(REAL_REGISTRY);
    assert.strictEqual(reg.schema_version, 1);
  });
});

describe('isEngineWritten', () => {
  test('outcome matches engine_keys literal', () => {
    const reg = loadEngineKeysRegistry(REAL_REGISTRY);
    assert.strictEqual(isEngineWritten('outcome', reg), true);
  });

  test('__pool_findings__ matches engine_key_patterns', () => {
    const reg = loadEngineKeysRegistry(REAL_REGISTRY);
    assert.strictEqual(isEngineWritten('__pool_findings__', reg), true);
  });

  test('artifact_foo is not engine-written', () => {
    const reg = loadEngineKeysRegistry(REAL_REGISTRY);
    assert.strictEqual(isEngineWritten('artifact_foo', reg), false);
  });
});

describe('isUserWritten', () => {
  test('artifact_api_controller matches artifact_* pattern', () => {
    const reg = loadEngineKeysRegistry(REAL_REGISTRY);
    assert.strictEqual(isUserWritten('artifact_api_controller', reg), true);
  });

  test('outcome does not match user_written_patterns', () => {
    const reg = loadEngineKeysRegistry(REAL_REGISTRY);
    assert.strictEqual(isUserWritten('outcome', reg), false);
  });

  test('artifact_foo is user-written', () => {
    const reg = loadEngineKeysRegistry(REAL_REGISTRY);
    assert.strictEqual(isUserWritten('artifact_foo', reg), true);
  });
});

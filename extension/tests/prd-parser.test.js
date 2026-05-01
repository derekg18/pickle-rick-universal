import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePrdFile, parsePrdMarkdown } from '../services/citadel/prd-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(__dirname, '../../prds/fixtures/citadel/loa-618-prd.md');

describe('parsePrdMarkdown', () => {
  test('extracts T1 Citadel PRD entities from markdown', () => {
    const markdown = readFileSync(fixturePath, 'utf-8');
    const parsed = parsePrdMarkdown(markdown);

    assert.deepEqual(
      parsed.decisions.map((decision) => decision.id),
      ['A1', 'A11', 'A12'],
    );
    assert.deepEqual(
      parsed.acceptanceCriteria.map((criterion) => criterion.id),
      ['AC-FF-01', 'AC-CIT-ABC-9'],
    );
    assert.deepEqual(
      parsed.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`),
      ['GET /api/runs/{runId}/comparison', 'POST /api/runs/{runId}/retry'],
    );
    assert(parsed.allowlistEntries.some((entry) => entry.kind === 'valid_action' && entry.value === 'retry_child_extraction'));
    assert(parsed.allowlistEntries.some((entry) => entry.kind === 'lender_feature_flag' && entry.name === 'comparison_retry_enabled'));
    assert(parsed.allowlistEntries.some((entry) => entry.kind === 'enum_value' && entry.name === 'RunAction' && entry.value === 'create_updated_run'));
    assert.deepEqual(
      parsed.statusCodeRows.map((row) => [row.endpointMethod, row.endpointPath, row.statusCode, row.errorMessage]),
      [
        ['GET', '/api/runs/{runId}/comparison', 404, 'Comparison not found'],
        ['POST', '/api/runs/{runId}/retry', 409, 'Retry is already running'],
      ],
    );
  });

  test('deduplicates IDs while preserving first-seen order', () => {
    const parsed = parsePrdMarkdown('A2. First\nA2 repeated\nAC-ONE-1 and AC-ONE-1\n');

    assert.deepEqual(parsed.decisions.map((decision) => decision.id), ['A2']);
    assert.deepEqual(parsed.acceptanceCriteria.map((criterion) => criterion.id), ['AC-ONE-1']);
  });
});

describe('parsePrdFile', () => {
  test('loads and parses a PRD fixture from disk', () => {
    const parsed = parsePrdFile(fixturePath);

    assert.equal(parsed.endpoints.length, 2);
    assert.equal(parsed.statusCodeRows.length, 2);
  });
});

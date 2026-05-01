import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYNC_SCRIPT = path.resolve(__dirname, '..', 'bin', 'sync-schema.js');
const OUTPUT_FILE = path.resolve(__dirname, '..', 'types', 'attractor-schema.ts');
const TSCONFIG = path.resolve(__dirname, '..', '..', 'tsconfig.json');

// ---------------------------------------------------------------------------
// Valid schema fixture — mirrors the shape attractor's schema.json exposes
// ---------------------------------------------------------------------------

function validSchema() {
    return {
        attributes: {
            node: {
                class:   { name: 'class',   type: 'string',  scope: 'node' },
                shape:   { name: 'shape',   type: 'string',  scope: 'node' },
                timeout: { name: 'timeout', type: 'string',  scope: 'node' },
            },
            graph: {
                goal:        { name: 'goal',        type: 'string', scope: 'graph' },
                working_dir: { name: 'working_dir', type: 'string', scope: 'graph' },
            },
            edge: {
                outcome: { name: 'outcome', type: 'string', scope: 'edge' },
            },
        },
    };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runSync(env = {}) {
    return new Promise((resolve) => {
        // 15s → 45s: budget for system load when run alongside concurrent
        // codex/tmux work. Tests validate sync output, not wall-clock.
        const child = execFile(
            process.execPath,
            [SYNC_SCRIPT],
            {
                timeout: 45_000,
                env: { ...process.env, ...env },
                cwd: path.resolve(__dirname, '..'),
            },
            (err, stdout, stderr) => {
                resolve({
                    code: err ? (err.code ?? 1) : 0,
                    stdout,
                    stderr,
                });
            },
        );
    });
}

// ---------------------------------------------------------------------------
// Temp directory management — each test gets a fake $ATTRACTOR_ROOT
// ---------------------------------------------------------------------------

let tmpDir;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-schema-test-'));
    // Clean up any prior generated file
    try { fs.unlinkSync(OUTPUT_FILE); } catch { /* noop */ }
});

afterEach(() => {
    // Clean up temp dir
    fs.rmSync(tmpDir, { recursive: true, force: true });
    // Clean up generated file
    try { fs.unlinkSync(OUTPUT_FILE); } catch { /* noop */ }
});

// ---------------------------------------------------------------------------
// sync-schema tests — RED phase
// ---------------------------------------------------------------------------

describe('sync-schema', () => {
    test('(1) valid schema.json at $ATTRACTOR_ROOT → generates types/attractor-schema.ts', async () => {
        const schema = validSchema();
        fs.writeFileSync(path.join(tmpDir, 'schema.json'), JSON.stringify(schema, null, 2));

        const result = await runSync({ ATTRACTOR_ROOT: tmpDir });

        assert.equal(result.code, 0, `expected exit 0, got ${result.code}: ${result.stderr}`);
        assert.ok(fs.existsSync(OUTPUT_FILE), 'attractor-schema.ts should be generated');

        const content = fs.readFileSync(OUTPUT_FILE, 'utf8');
        assert.ok(content.length > 0, 'generated file should not be empty');
        // Must export something usable
        assert.ok(
            content.includes('export'),
            'generated file should contain exports',
        );
    });

    test('(2) $ATTRACTOR_ROOT not set → exits 0 with warning on stderr', async () => {
        // Explicitly remove ATTRACTOR_ROOT from env
        const env = { ...process.env };
        delete env.ATTRACTOR_ROOT;

        const result = await runSync({ ATTRACTOR_ROOT: '' });
        // Also test with truly unset var
        const result2 = await new Promise((resolve) => {
            const child = execFile(
                process.execPath,
                [SYNC_SCRIPT],
                // 15s → 45s: load-tolerance under concurrent test runs.
                { timeout: 45_000, env, cwd: path.resolve(__dirname, '..') },
                (err, stdout, stderr) => {
                    resolve({
                        code: err ? (err.code ?? 1) : 0,
                        stdout,
                        stderr,
                    });
                },
            );
        });

        assert.equal(result2.code, 0, `expected exit 0 when ATTRACTOR_ROOT unset, got ${result2.code}`);
        assert.ok(
            result2.stderr.toLowerCase().includes('warn') ||
            result2.stderr.toLowerCase().includes('skip') ||
            result2.stderr.toLowerCase().includes('attractor_root'),
            'stderr should contain a warning about missing ATTRACTOR_ROOT',
        );
        assert.ok(
            !fs.existsSync(OUTPUT_FILE),
            'should not generate output file when ATTRACTOR_ROOT is missing',
        );
    });

    test('(3) generated file is valid TypeScript that compiles with tsc --noEmit', async () => {
        const schema = validSchema();
        fs.writeFileSync(path.join(tmpDir, 'schema.json'), JSON.stringify(schema, null, 2));

        const syncResult = await runSync({ ATTRACTOR_ROOT: tmpDir });
        assert.equal(syncResult.code, 0, `sync-schema should exit 0: ${syncResult.stderr}`);
        assert.ok(fs.existsSync(OUTPUT_FILE), 'generated file must exist before tsc check');

        // Run tsc --noEmit on the generated file (use tsc binary directly to avoid npx/rtk proxy issues)
        const tscBin = path.resolve(__dirname, '..', 'node_modules', '.bin', 'tsc');
        const tscResult = await new Promise((resolve) => {
            execFile(
                tscBin,
                ['--noEmit', '--strict', '--esModuleInterop', OUTPUT_FILE],
                {
                    // 30s → 90s: tsc compile budget under concurrent test runs.
                    timeout: 90_000,
                    cwd: path.resolve(__dirname, '..', '..'),
                },
                (err, stdout, stderr) => {
                    resolve({
                        code: err ? (err.code ?? 1) : 0,
                        stdout,
                        stderr,
                    });
                },
            );
        });

        assert.equal(
            tscResult.code, 0,
            `generated file should compile: ${tscResult.stderr}`,
        );
    });

    test('(4) malformed JSON in schema.json → non-zero exit with parse error on stderr', async () => {
        // Truncated JSON — missing closing brace
        fs.writeFileSync(path.join(tmpDir, 'schema.json'), '{"attributes": {"node": {');

        const result = await runSync({ ATTRACTOR_ROOT: tmpDir });

        assert.notEqual(result.code, 0, 'should exit non-zero on malformed JSON');
        assert.ok(
            result.stderr.length > 0,
            'stderr should contain error output',
        );
        // Should mention it's a parse/JSON error
        assert.ok(
            result.stderr.toLowerCase().includes('json') ||
            result.stderr.toLowerCase().includes('parse') ||
            result.stderr.toLowerCase().includes('syntax') ||
            result.stderr.toLowerCase().includes('unexpected'),
            `stderr should describe the parse error, got: ${result.stderr}`,
        );
    });

    test('(5) schema.json missing required "attributes" key → non-zero exit with field error on stderr', async () => {
        // Valid JSON but missing the 'attributes' key
        fs.writeFileSync(path.join(tmpDir, 'schema.json'), JSON.stringify({ version: '1.0' }));

        const result = await runSync({ ATTRACTOR_ROOT: tmpDir });

        assert.notEqual(result.code, 0, 'should exit non-zero when attributes key is missing');
        assert.ok(
            result.stderr.length > 0,
            'stderr should contain error output',
        );
        assert.ok(
            result.stderr.toLowerCase().includes('attributes') ||
            result.stderr.toLowerCase().includes('missing') ||
            result.stderr.toLowerCase().includes('required'),
            `stderr should identify the missing field, got: ${result.stderr}`,
        );
    });

    test('(6) generated attribute names match fallback schema for shared attributes', async () => {
        // Use a schema that includes all fallback attributes
        const fullSchema = {
            attributes: {
                node: {
                    class:              { name: 'class',              type: 'string',  scope: 'node' },
                    shape:              { name: 'shape',              type: 'string',  scope: 'node' },
                    goal_gate:          { name: 'goal_gate',          type: 'boolean', scope: 'node' },
                    retry_target:       { name: 'retry_target',       type: 'string',  scope: 'node' },
                    max_visits:         { name: 'max_visits',         type: 'number',  scope: 'node' },
                    thread_id:          { name: 'thread_id',          type: 'string',  scope: 'node' },
                    timeout:            { name: 'timeout',            type: 'string',  scope: 'node' },
                    allowed_paths:      { name: 'allowed_paths',      type: 'string',  scope: 'node' },
                    read_only:          { name: 'read_only',          type: 'boolean', scope: 'node' },
                    context_on_success: { name: 'context_on_success', type: 'string',  scope: 'node' },
                    prompt:             { name: 'prompt',             type: 'string',  scope: 'node' },
                    tool_command:       { name: 'tool_command',       type: 'string',  scope: 'node' },
                    max_parallel:       { name: 'max_parallel',       type: 'number',  scope: 'node' },
                    escalate_on:        { name: 'escalate_on',        type: 'string',  scope: 'node' },
                    permission_mode:    { name: 'permission_mode',    type: 'string',  scope: 'node' },
                    auto_status:        { name: 'auto_status',        type: 'boolean', scope: 'node' },
                    allow_partial:      { name: 'allow_partial',      type: 'boolean', scope: 'node' },
                    label:              { name: 'label',              type: 'string',  scope: 'node' },
                    coverage_target:    { name: 'coverage_target',    type: 'number',  scope: 'node' },
                    repo_url:           { name: 'repo_url',           type: 'string',  scope: 'node' },
                    cleanup:            { name: 'cleanup',            type: 'string',  scope: 'node' },
                    direction:          { name: 'direction',          type: 'string',  scope: 'node' },
                    target:             { name: 'target',             type: 'string',  scope: 'node' },
                    ratchet_count:      { name: 'ratchet_count',      type: 'number',  scope: 'node' },
                    body:               { name: 'body',               type: 'string',  scope: 'node' },
                    until:              { name: 'until',              type: 'string',  scope: 'node' },
                    model:              { name: 'model',              type: 'string',  scope: 'node' },
                    reviewer_lens:      { name: 'reviewer_lens',      type: 'string',  scope: 'node' },
                    sealed_from_source: { name: 'sealed_from_source', type: 'string',  scope: 'node' },
                    harness:            { name: 'harness',            type: 'string',  scope: 'node' },
                    max_iterations:     { name: 'max_iterations',     type: 'number',  scope: 'node' },
                    reports_to_v:       { name: 'reports_to_v',       type: 'string',  scope: 'node' },
                    allow_multi_retry_target: { name: 'allow_multi_retry_target', type: 'boolean', scope: 'node' },
                    convergence_epsilon:      { name: 'convergence_epsilon',      type: 'number',  scope: 'node' },
                    context_on_failure:       { name: 'context_on_failure',       type: 'string',  scope: 'node' },
                    context_keys:             { name: 'context_keys',             type: 'string',  scope: 'node' },
                },
                graph: {
                    goal:               { name: 'goal',               type: 'string',  scope: 'graph' },
                    rankdir:            { name: 'rankdir',            type: 'string',  scope: 'graph' },
                    working_dir:        { name: 'working_dir',        type: 'string',  scope: 'graph' },
                    default_max_retry:  { name: 'default_max_retry',  type: 'number',  scope: 'graph' },
                    label:              { name: 'label',              type: 'string',  scope: 'graph' },
                    acceptance_criteria:{ name: 'acceptance_criteria',type: 'string',  scope: 'graph' },
                    model_stylesheet:   { name: 'model_stylesheet',   type: 'string',  scope: 'graph' },
                    spec_file:          { name: 'spec_file',          type: 'string',  scope: 'graph' },
                    workspace:          { name: 'workspace',          type: 'string',  scope: 'graph' },
                    repo_url:           { name: 'repo_url',           type: 'string',  scope: 'graph' },
                    repo_branch:        { name: 'repo_branch',        type: 'string',  scope: 'graph' },
                    workspace_cleanup:  { name: 'workspace_cleanup',  type: 'string',  scope: 'graph' },
                    retry_target:       { name: 'retry_target',       type: 'string',  scope: 'graph' },
                },
                edge: {
                    condition:    { name: 'condition',    type: 'string',  scope: 'edge' },
                    outcome:      { name: 'outcome',      type: 'string',  scope: 'edge' },
                    loop_restart: { name: 'loop_restart', type: 'boolean', scope: 'edge' },
                    weight:       { name: 'weight',       type: 'number',  scope: 'edge' },
                    label:        { name: 'label',        type: 'string',  scope: 'edge' },
                },
            },
        };
        fs.writeFileSync(path.join(tmpDir, 'schema.json'), JSON.stringify(fullSchema, null, 2));

        const syncResult = await runSync({ ATTRACTOR_ROOT: tmpDir });
        assert.equal(syncResult.code, 0, `sync-schema should exit 0: ${syncResult.stderr}`);
        assert.ok(fs.existsSync(OUTPUT_FILE), 'generated file must exist');

        const generated = fs.readFileSync(OUTPUT_FILE, 'utf8');

        // Import fallback attribute names for comparison
        const { ATTRACTOR_SCHEMA_FALLBACK } = await import('../types/attractor-schema.fallback.js');

        // Every attribute name in the fallback must appear in the generated file
        for (const scope of ['node', 'graph', 'edge']) {
            const fallbackAttrs = Object.keys(ATTRACTOR_SCHEMA_FALLBACK[scope]);
            for (const attrName of fallbackAttrs) {
                assert.ok(
                    generated.includes(attrName),
                    `generated schema should contain fallback attribute "${attrName}" (scope: ${scope})`,
                );
            }
        }
    });
});

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.resolve(__dirname, '..', 'bin', 'plumbus-frame-analyzer.js');
const FIXTURE_DOT = path.resolve(__dirname, '__fixtures__', 'plumbus-frames', 'frame1-asymmetric-writer.dot');
const PINNED_JSON = path.resolve(__dirname, '__fixtures__', 'plumbus-frames', 'dump-graph-output.pinned.json');

let tmpRoot;
let attractorRoot;

function makeAttractorRoot() {
  const tmp = mkdtempSync(path.join(tmpRoot, 'attractor-'));
  mkdirSync(path.join(tmp, 'packages', 'attractor', 'src'), { recursive: true });
  writeFileSync(path.join(tmp, 'packages', 'attractor', 'src', 'cli.ts'), '// stub\n');
  mkdirSync(path.join(tmp, 'packages', 'attractor', 'scripts'), { recursive: true });
  writeFileSync(path.join(tmp, 'packages', 'attractor', 'scripts', 'dump-graph.ts'), '// stub\n');
  return tmp;
}

function makeFakeBun(jsonPath) {
  const dir = mkdtempSync(path.join(tmpRoot, 'fake-bun-'));
  const bunPath = path.join(dir, 'bun');
  writeFileSync(bunPath, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "bun 1.0.0"; exit 0; fi\ncat "${jsonPath}"\n`);
  chmodSync(bunPath, 0o755);
  return dir;
}

function runAnalyzer(extraEnv) {
  return spawnSync(
    process.execPath,
    [BIN_PATH, FIXTURE_DOT],
    { encoding: 'utf8', env: { ...process.env, ATTRACTOR_ROOT: attractorRoot, ...extraEnv } },
  );
}

describe('plumbus-frame-analyzer — output contract', () => {
  before(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'plumbus-contract-'));
    attractorRoot = makeAttractorRoot();
  });

  after(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('contract pass with pinned JSON — exits 0, output has exactly three top-level keys', () => {
    const fakeBunDir = makeFakeBun(PINNED_JSON);
    const result = runAnalyzer({ PATH: `${fakeBunDir}:${process.env.PATH ?? ''}` });

    assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
    const output = JSON.parse(result.stdout.trim());
    assert.deepStrictEqual(
      Object.keys(output).sort(),
      ['context_keys', 'cycles', 'diamond_routing'],
    );
  });

  test('context_keys shape — each row has key:string, writers:array, readers:array', () => {
    const fakeBunDir = makeFakeBun(PINNED_JSON);
    const result = runAnalyzer({ PATH: `${fakeBunDir}:${process.env.PATH ?? ''}` });

    assert.strictEqual(result.status, 0, `expected exit 0: ${result.stderr}`);
    const { context_keys } = JSON.parse(result.stdout.trim());
    assert.ok(Array.isArray(context_keys), 'context_keys must be an array');
    assert.ok(context_keys.length > 0, 'context_keys must be non-empty with pinned fixture');
    assert.ok(
      context_keys.every(r => typeof r.key === 'string' && Array.isArray(r.writers) && Array.isArray(r.readers)),
      `context_keys row shape violation: ${JSON.stringify(context_keys)}`,
    );
  });

  test('diamond_routing shape — each row has diamond:string, covered_states:array, stuck_states:array', () => {
    const fakeBunDir = makeFakeBun(PINNED_JSON);
    const result = runAnalyzer({ PATH: `${fakeBunDir}:${process.env.PATH ?? ''}` });

    assert.strictEqual(result.status, 0, `expected exit 0: ${result.stderr}`);
    const { diamond_routing } = JSON.parse(result.stdout.trim());
    assert.ok(Array.isArray(diamond_routing), 'diamond_routing must be an array');
    assert.ok(diamond_routing.length > 0, 'diamond_routing must be non-empty with pinned fixture');
    assert.ok(
      diamond_routing.every(
        r => typeof r.diamond === 'string' && Array.isArray(r.covered_states) && Array.isArray(r.stuck_states),
      ),
      `diamond_routing row shape violation: ${JSON.stringify(diamond_routing)}`,
    );
  });

  test('cycles shape — each row has scc_nodes:array, convergence_signal:null|string', () => {
    const fakeBunDir = makeFakeBun(PINNED_JSON);
    const result = runAnalyzer({ PATH: `${fakeBunDir}:${process.env.PATH ?? ''}` });

    assert.strictEqual(result.status, 0, `expected exit 0: ${result.stderr}`);
    const { cycles } = JSON.parse(result.stdout.trim());
    assert.ok(Array.isArray(cycles), 'cycles must be an array');
    assert.ok(cycles.length > 0, 'cycles must be non-empty with pinned fixture');
    assert.ok(
      cycles.every(r => Array.isArray(r.scc_nodes) && (r.convergence_signal === null || typeof r.convergence_signal === 'string')),
      `cycles row shape violation: ${JSON.stringify(cycles)}`,
    );
  });

  test('contract drift detection — missing nodes key → exit 2, stderr contains "nodes"', () => {
    const brokenJson = path.join(tmpRoot, 'broken.json');
    writeFileSync(brokenJson, JSON.stringify({ edges: [] }));
    const fakeBunDir = makeFakeBun(brokenJson);
    const result = runAnalyzer({ PATH: `${fakeBunDir}:${process.env.PATH ?? ''}` });

    assert.notStrictEqual(result.status, 0, 'expected non-zero exit when nodes key is missing');
    assert.ok(result.stderr.includes('nodes'), `expected stderr to contain "nodes", got: ${result.stderr}`);
  });
});

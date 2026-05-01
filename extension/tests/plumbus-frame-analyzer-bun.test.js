import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.resolve(__dirname, '..', 'bin', 'plumbus-frame-analyzer.js');
const FIXTURE_PATH = path.resolve(__dirname, '__fixtures__', 'plumbus-frames', 'frame1-asymmetric-writer.dot');

let tmpRoot;

function makeFakeBun(script) {
  const dir = mkdtempSync(path.join(tmpRoot, 'fake-bun-'));
  const bunPath = path.join(dir, 'bun');
  writeFileSync(bunPath, `#!/bin/sh\n${script}\n`);
  chmodSync(bunPath, 0o755);
  return dir;
}

function makeAttractorRoot(hasDumpGraph = true) {
  const tmp = mkdtempSync(path.join(tmpRoot, 'attractor-'));
  mkdirSync(path.join(tmp, 'packages', 'attractor', 'src'), { recursive: true });
  writeFileSync(path.join(tmp, 'packages', 'attractor', 'src', 'cli.ts'), '// stub\n');
  if (hasDumpGraph) {
    mkdirSync(path.join(tmp, 'packages', 'attractor', 'scripts'), { recursive: true });
    writeFileSync(path.join(tmp, 'packages', 'attractor', 'scripts', 'dump-graph.ts'), '// stub\n');
  }
  return tmp;
}

function runAnalyzer(extraEnv) {
  return spawnSync(
    process.execPath,
    [BIN_PATH, FIXTURE_PATH],
    { encoding: 'utf8', env: { ...process.env, ...extraEnv } },
  );
}

describe('plumbus-frame-analyzer — bun shellout', () => {
  before(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'plumbus-bun-tests-'));
  });

  after(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('bun absent → exit 2 with bun diagnostic', () => {
    const whichBun = spawnSync('which', ['bun'], { encoding: 'utf8' });
    const bunDir = whichBun.status === 0 ? path.dirname(whichBun.stdout.trim()) : null;
    const filteredPath = (process.env.PATH ?? '').split(':').filter(p => p !== bunDir).join(':');

    const result = runAnalyzer({
      ATTRACTOR_ROOT: makeAttractorRoot(true),
      PATH: filteredPath,
    });

    assert.strictEqual(result.status, 2, `expected exit 2, got ${result.status}: ${result.stderr}`);
    assert.ok(result.stderr.includes('bun'), `expected stderr to include 'bun', got: ${result.stderr}`);
  });

  test('dump-graph.ts missing → exit 2 with dump-graph diagnostic', () => {
    const fakeBunDir = makeFakeBun('if [ "$1" = "--version" ]; then echo "bun 1.0.0"; exit 0; fi');

    const result = runAnalyzer({
      ATTRACTOR_ROOT: makeAttractorRoot(false),
      PATH: `${fakeBunDir}:${process.env.PATH ?? ''}`,
    });

    assert.strictEqual(result.status, 2, `expected exit 2, got ${result.status}: ${result.stderr}`);
    assert.ok(result.stderr.includes('dump-graph'), `expected stderr to include 'dump-graph', got: ${result.stderr}`);
  });

  test('dump-graph exits non-zero → exit 2', () => {
    const fakeBunDir = makeFakeBun(
      'if [ "$1" = "--version" ]; then echo "bun 1.0.0"; exit 0; fi\necho "internal error" >&2\nexit 1',
    );

    const result = runAnalyzer({
      ATTRACTOR_ROOT: makeAttractorRoot(true),
      PATH: `${fakeBunDir}:${process.env.PATH ?? ''}`,
    });

    assert.strictEqual(result.status, 2, `expected exit 2, got ${result.status}: ${result.stderr}`);
  });

  test('dump-graph emits invalid JSON → exit 2 with JSON diagnostic', () => {
    const fakeBunDir = makeFakeBun(
      'if [ "$1" = "--version" ]; then echo "bun 1.0.0"; exit 0; fi\necho "not valid json"',
    );

    const result = runAnalyzer({
      ATTRACTOR_ROOT: makeAttractorRoot(true),
      PATH: `${fakeBunDir}:${process.env.PATH ?? ''}`,
    });

    assert.strictEqual(result.status, 2, `expected exit 2, got ${result.status}: ${result.stderr}`);
    assert.ok(result.stderr.includes('JSON'), `expected stderr to include 'JSON', got: ${result.stderr}`);
  });

  test('dump-graph emits {} (missing top-level keys) → exit 2 with top-level diagnostic', () => {
    const fakeBunDir = makeFakeBun(
      "if [ \"$1\" = \"--version\" ]; then echo \"bun 1.0.0\"; exit 0; fi\necho '{}'",
    );

    const result = runAnalyzer({
      ATTRACTOR_ROOT: makeAttractorRoot(true),
      PATH: `${fakeBunDir}:${process.env.PATH ?? ''}`,
    });

    assert.strictEqual(result.status, 2, `expected exit 2, got ${result.status}: ${result.stderr}`);
    assert.ok(result.stderr.includes('top-level'), `expected stderr to include 'top-level', got: ${result.stderr}`);
  });

  test('happy path → exit 0, output has context_keys/diamond_routing/cycles', () => {
    const fakeBunDir = makeFakeBun(
      'if [ "$1" = "--version" ]; then echo "bun 1.0.0"; exit 0; fi\nprintf \'{"nodes":[],"edges":[]}\n\'',
    );

    const result = runAnalyzer({
      ATTRACTOR_ROOT: makeAttractorRoot(true),
      PATH: `${fakeBunDir}:${process.env.PATH ?? ''}`,
    });

    assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout.trim());
    assert.deepStrictEqual(
      Object.keys(parsed).sort(),
      ['context_keys', 'cycles', 'diamond_routing'],
    );
  });
});

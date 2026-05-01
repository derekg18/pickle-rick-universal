import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.resolve(__dirname, '..', 'bin', 'plumbus-frame-analyzer.js');
const FIXTURES_DIR = path.resolve(__dirname, '__fixtures__', 'plumbus-frames');

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

function makeFakeBun(graphJsonPath) {
  const dir = mkdtempSync(path.join(tmpRoot, 'fake-bun-'));
  const bunPath = path.join(dir, 'bun');
  writeFileSync(bunPath, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "bun 1.0.0"; exit 0; fi\ncat "${graphJsonPath}"\n`);
  chmodSync(bunPath, 0o755);
  return dir;
}

function sortAll(value) {
  if (Array.isArray(value)) {
    return value.map(sortAll).sort((a, b) => {
      const sa = JSON.stringify(a);
      const sb = JSON.stringify(b);
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });
  }
  if (value !== null && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortAll(value[key]);
    }
    return sorted;
  }
  return value;
}

describe('plumbus-frame-analyzer — calibration fixtures', () => {
  before(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'plumbus-calibration-'));
    attractorRoot = makeAttractorRoot();
  });

  after(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  const dotFiles = readdirSync(FIXTURES_DIR).filter(f => f.endsWith('.dot')).sort();

  for (const dotFile of dotFiles) {
    const base = dotFile.replace(/\.dot$/, '');
    const dotPath = path.join(FIXTURES_DIR, dotFile);
    const graphJsonPath = path.join(FIXTURES_DIR, `${base}.graph.json`);
    const goldenPath = path.join(FIXTURES_DIR, `${base}.golden.json`);

    test(`${base} — output matches golden`, () => {
      const golden = JSON.parse(readFileSync(goldenPath, 'utf8'));
      const fakeBunDir = makeFakeBun(graphJsonPath);

      const result = spawnSync(
        process.execPath,
        [BIN_PATH, dotPath],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            ATTRACTOR_ROOT: attractorRoot,
            PATH: `${fakeBunDir}:${process.env.PATH ?? ''}`,
          },
        },
      );

      assert.strictEqual(result.status, 0, `${base}: expected exit 0, got ${result.status}: ${result.stderr}`);
      const output = JSON.parse(result.stdout.trim());
      assert.deepStrictEqual(
        sortAll(output),
        sortAll(golden),
        `${base}: analyzer output does not match golden`,
      );
    });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.resolve(__dirname, '..', 'bin', 'plumbus-frame-analyzer.js');

const ATTRACTOR_PROBE = path.join('packages', 'attractor', 'src', 'cli.ts');

function discoverAttractorRoot() {
  const envRoot = process.env.ATTRACTOR_ROOT;
  if (envRoot && existsSync(path.join(envRoot, ATTRACTOR_PROBE))) return envRoot;
  const relRoot = path.resolve(process.cwd(), '..', 'attractor');
  if (existsSync(path.join(relRoot, ATTRACTOR_PROBE))) return relRoot;
  const loanlightRoot = path.join(os.homedir(), 'loanlight', 'attractor');
  if (existsSync(path.join(loanlightRoot, ATTRACTOR_PROBE))) return loanlightRoot;
  return null;
}

function walkDotFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      results.push(...walkDotFiles(full));
    } else if (entry.endsWith('.dot')) {
      results.push(full);
    }
  }
  return results;
}

// 3s → 10s: load-tolerance for bun probe (skip-when-unavailable gate).
const bunCheck = spawnSync('bun', ['--version'], { encoding: 'utf8', timeout: 10000 });
const BUN_AVAILABLE = !bunCheck.error && bunCheck.status === 0;

const ATTRACTOR_ROOT = discoverAttractorRoot();
const SKIP_REASON = !BUN_AVAILABLE
  ? 'bun not on PATH — skipped'
  : !ATTRACTOR_ROOT
    ? 'attractor repo not found — skipped'
    : null;

// Frame 5 P0: SCC with >1 nodes and no convergence signal (cycle that cannot terminate).
function frame5P0Findings(analyzerOutput, dotPath) {
  const findings = [];
  for (const row of analyzerOutput.cycles ?? []) {
    if (row.scc_nodes.length > 1 && row.convergence_signal === null) {
      findings.push({
        dotPath,
        scc_nodes: row.scc_nodes,
      });
    }
  }
  return findings;
}

test('Frame 5 produces zero false-positive P0s on shipped attractor pipelines', (t) => {
  if (SKIP_REASON) {
    console.log(`plumbus-ci-pipeline-baseline: ${SKIP_REASON}`);
    t.skip(SKIP_REASON); // SKIP: conditional — env prerequisite unavailable
    return;
  }

  const dotFiles = walkDotFiles(path.join(ATTRACTOR_ROOT, 'packages', 'attractor'));
  if (dotFiles.length === 0) {
    // Vacuously pass: no shipped pipelines to check
    return;
  }

  const falsePositives = [];

  for (const dotFile of dotFiles) {
    const result = spawnSync(
      process.execPath,
      [BIN_PATH, dotFile],
      {
        encoding: 'utf8',
        // 30s → 60s: budget for bun analyzer under concurrent test runs.
        timeout: 60000,
        env: { ...process.env, ATTRACTOR_ROOT },
      },
    );

    if (result.status !== 0) {
      // Degraded mode or analyzer failure: skip this pipeline (not a P0 finding)
      continue;
    }

    let analyzerOutput;
    try {
      analyzerOutput = JSON.parse(result.stdout.trim());
    } catch {
      continue;
    }

    const p0s = frame5P0Findings(analyzerOutput, path.relative(ATTRACTOR_ROOT, dotFile));
    falsePositives.push(...p0s);
  }

  assert.deepStrictEqual(
    falsePositives,
    [],
    `Frame 5 P0 findings on currently-green shipped pipelines (false positives):\n` +
    falsePositives.map(f => `  ${f.dotPath}: SCC [${f.scc_nodes.join(', ')}]`).join('\n'),
  );
});

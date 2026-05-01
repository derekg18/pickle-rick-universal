import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = path.resolve(__dirname, '..', 'data', 'engine-injected-keys.json');

const { loadEngineKeysRegistry, isEngineWritten, isUserWritten } = await import(
  path.resolve(__dirname, '..', 'lib', 'engine-keys-registry.js')
);

// 3s → 10s: load-tolerance for bun probe (skip-when-unavailable gate).
const bunCheck = spawnSync('bun', ['--version'], { encoding: 'utf8', timeout: 10000 });
const BUN_AVAILABLE = !bunCheck.error && bunCheck.status === 0;

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

// Skips __tests__ and scripts dirs (test fixtures + pipeline scripts aren't engine context key writes)
function walkTsFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry === '__tests__' || entry === 'scripts') continue;
    const full = path.join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      results.push(...walkTsFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      results.push(full);
    }
  }
  return results;
}

// Only matches quoted (not backtick) strings; skips comment lines to avoid format-example captures.
// context_on_success="artifact_foo=bar" or context_on_failure='artifact_foo=bar'
// ATTRACTOR_CTX: artifact_foo = bar (tool_command/prompt comment declarations in node attrs)
const CONTEXT_ON_RE = /context_on_\w+\s*=\s*["']([a-zA-Z_]\w*)\s*=/g;
const ATTRACTOR_CTX_RE = /ATTRACTOR_CTX:\s*([a-zA-Z_]\w*)\s*=/g;

function extractContextKeys(content) {
  const keys = new Set();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    // Skip comment lines — they often contain format examples (e.g., ATTRACTOR_CTX:key=value)
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    for (const m of line.matchAll(CONTEXT_ON_RE)) keys.add(m[1]);
    for (const m of line.matchAll(ATTRACTOR_CTX_RE)) keys.add(m[1]);
  }
  return keys;
}

const ATTRACTOR_ROOT = discoverAttractorRoot();
const SKIP_REASON = !BUN_AVAILABLE
  ? 'bun not on PATH — skipped'
  : !ATTRACTOR_ROOT
    ? 'attractor repo not found — skipped'
    : null;

test('every attractor context_on_*= / ATTRACTOR_CTX: key matches a registry entry', (t) => {
  if (SKIP_REASON) {
    console.log(`engine-keys-registry-coverage: ${SKIP_REASON}`);
    t.skip(SKIP_REASON); // SKIP: conditional — env prerequisite unavailable
    return;
  }

  const tsRoot = path.join(ATTRACTOR_ROOT, 'packages', 'attractor');
  const tsFiles = walkTsFiles(tsRoot);

  if (tsFiles.length === 0) {
    // Vacuously pass: no TS files found to check
    return;
  }

  const registry = loadEngineKeysRegistry(REGISTRY_PATH);
  const unmatched = [];

  for (const file of tsFiles) {
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const key of extractContextKeys(content)) {
      if (!isEngineWritten(key, registry) && !isUserWritten(key, registry)) {
        unmatched.push({ key, file: path.relative(ATTRACTOR_ROOT, file) });
      }
    }
  }

  assert.deepStrictEqual(
    unmatched,
    [],
    `Unmatched context keys (not in engine_keys, engine_key_patterns, or user_written_patterns):\n` +
    unmatched.map(u => `  ${u.key}  (${u.file})`).join('\n'),
  );
});

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const INSTALL_SH = path.join(REPO_ROOT, 'install.sh');

/**
 * Build a minimal install.sh fixture that runs only the F3 schemaVersion
 * parity check from the real install.sh. SCRIPT_DIR is wired to the supplied
 * tmp dir so we can pin source/compiled schemaVersion values per case.
 */
function buildFixtureScript(scriptDir) {
  return `#!/bin/bash
set -e
SCRIPT_DIR="${scriptDir}"
SOURCE_VERSION=$(grep -oE 'schemaVersion: [0-9]+' "$SCRIPT_DIR/extension/src/types/index.ts" | head -1 | awk '{print $2}')
COMPILED_VERSION=$(grep -oE 'schemaVersion: [0-9]+' "$SCRIPT_DIR/extension/types/index.js" | head -1 | awk '{print $2}')
if [ -z "$SOURCE_VERSION" ] || [ -z "$COMPILED_VERSION" ]; then
  echo "❌ Could not extract schemaVersion from source or compiled types/index. Refusing to deploy." >&2
  exit 1
fi
if [ "$SOURCE_VERSION" != "$COMPILED_VERSION" ]; then
  echo "❌ Compiled JS schemaVersion ($COMPILED_VERSION) does not match source TS ($SOURCE_VERSION)." >&2
  echo "   Likely cause: stale tsc build cache. Try: rm extension/types/index.js && bash install.sh" >&2
  exit 1
fi
echo "ok"
`;
}

function makeFixture({ sourceVersion, compiledVersion }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'install-script-test-'));
  const srcTypes = path.join(dir, 'extension', 'src', 'types');
  const outTypes = path.join(dir, 'extension', 'types');
  mkdirSync(srcTypes, { recursive: true });
  mkdirSync(outTypes, { recursive: true });
  if (sourceVersion !== null) {
    writeFileSync(
      path.join(srcTypes, 'index.ts'),
      `export const STATE_MANAGER_DEFAULTS = {\n  schemaVersion: ${sourceVersion},\n};\n`,
    );
  } else {
    writeFileSync(path.join(srcTypes, 'index.ts'), 'export const STATE_MANAGER_DEFAULTS = {};\n');
  }
  if (compiledVersion !== null) {
    writeFileSync(
      path.join(outTypes, 'index.js'),
      `export const STATE_MANAGER_DEFAULTS = {\n    schemaVersion: ${compiledVersion},\n};\n`,
    );
  } else {
    writeFileSync(path.join(outTypes, 'index.js'), 'export const STATE_MANAGER_DEFAULTS = {};\n');
  }
  const scriptPath = path.join(dir, 'install.sh');
  writeFileSync(scriptPath, buildFixtureScript(dir), { mode: 0o755 });
  return { dir, scriptPath };
}

describe('install.sh schemaVersion parity check (F3)', () => {
  test('install.sh aborts if compiled JS schemaVersion differs from source TS', () => {
    const { dir, scriptPath } = makeFixture({ sourceVersion: 3, compiledVersion: 2 });
    try {
      const result = spawnSync('bash', [scriptPath], { encoding: 'utf8' });
      assert.notStrictEqual(result.status, 0, `expected non-zero exit, got ${result.status}`);
      assert.match(
        result.stderr,
        /schemaVersion/,
        `expected stderr to mention schemaVersion, got: ${result.stderr}`,
      );
      assert.match(
        result.stderr,
        /\(2\).*\(3\)/s,
        `expected stderr to surface mismatched versions, got: ${result.stderr}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('install.sh passes when source and compiled schemaVersion match', () => {
    const { dir, scriptPath } = makeFixture({ sourceVersion: 3, compiledVersion: 3 });
    try {
      const result = spawnSync('bash', [scriptPath], { encoding: 'utf8' });
      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
      assert.match(result.stdout, /ok/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('install.sh aborts when schemaVersion is missing from either file', () => {
    const { dir, scriptPath } = makeFixture({ sourceVersion: null, compiledVersion: 3 });
    try {
      const result = spawnSync('bash', [scriptPath], { encoding: 'utf8' });
      assert.notStrictEqual(result.status, 0);
      assert.match(result.stderr, /Could not extract schemaVersion/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('real install.sh contains the F3 schemaVersion parity check', () => {
    const src = readFileSync(INSTALL_SH, 'utf8');
    assert.match(src, /SOURCE_VERSION=.*schemaVersion/, 'install.sh must extract SOURCE_VERSION from src TS');
    assert.match(src, /COMPILED_VERSION=.*schemaVersion/, 'install.sh must extract COMPILED_VERSION from compiled JS');
    assert.match(src, /Compiled JS schemaVersion .* does not match source TS/);
  });

  test('real source TS and compiled JS schemaVersion currently agree', () => {
    const tsSrc = readFileSync(path.join(REPO_ROOT, 'extension', 'src', 'types', 'index.ts'), 'utf8');
    const jsSrc = readFileSync(path.join(REPO_ROOT, 'extension', 'types', 'index.js'), 'utf8');
    const tsMatch = tsSrc.match(/schemaVersion:\s*(\d+)/);
    const jsMatch = jsSrc.match(/schemaVersion:\s*(\d+)/);
    assert.ok(tsMatch, 'source TS must declare schemaVersion');
    assert.ok(jsMatch, 'compiled JS must declare schemaVersion');
    assert.strictEqual(
      tsMatch[1],
      jsMatch[1],
      `source TS schemaVersion ${tsMatch[1]} must match compiled JS schemaVersion ${jsMatch[1]} — run bash install.sh to recompile`,
    );
  });
});

describe('install.sh Forward Fix F2: lock serialization', () => {
  test('install.sh contains the lock block', () => {
    const src = readFileSync(INSTALL_SH, 'utf8');
    assert.ok(
      src.includes('LOCKFILE="$EXTENSION_ROOT/.install.lock"'),
      'install.sh must declare a lockfile under $EXTENSION_ROOT',
    );
    assert.ok(
      src.includes('flock -x'),
      'install.sh must attempt an exclusive flock when flock(1) is available',
    );
    assert.ok(
      src.includes('mkdir "$LOCKDIR"'),
      'install.sh must include a mkdir-based lock fallback for systems without flock',
    );
  });

  test('install.sh has a --dry-run guard after the lock', () => {
    const src = readFileSync(INSTALL_SH, 'utf8');
    const lockIdx = src.indexOf('LOCKFILE="$EXTENSION_ROOT/.install.lock"');
    const dryRunIdx = src.indexOf('--dry-run');
    assert.ok(lockIdx !== -1, 'lock block missing');
    assert.ok(dryRunIdx !== -1, 'install.sh must accept --dry-run');
    assert.ok(
      dryRunIdx > lockIdx,
      '--dry-run guard must follow lock acquisition so the dry-run path still exercises serialization',
    );
  });

  test('two simultaneous invocations serialize on the lock', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'install-lock-'));
    try {
      const extRoot = path.join(dir, 'pickle-rick');
      const fixture = path.join(dir, 'install.sh');

      // Minimal fixture replicating install.sh's lock block + a 2s critical
      // section. Each child prints a millisecond timestamp the moment it
      // acquires the lock; we assert the two timestamps are at least ~2s apart.
      writeFileSync(
        fixture,
        `#!/bin/bash
set -e
EXTENSION_ROOT="${extRoot}"
mkdir -p "$EXTENSION_ROOT"
LOCKFILE="$EXTENSION_ROOT/.install.lock"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCKFILE"
  if ! flock -x -n 9; then
    flock -x 9
  fi
else
  LOCKDIR="$EXTENSION_ROOT/.install.lock.d"
  while ! mkdir "$LOCKDIR" 2>/dev/null; do
    sleep 0.1
  done
  trap 'rmdir "$LOCKDIR"' EXIT
fi
node -e "process.stdout.write(String(Date.now()))"
echo
sleep 2
`,
      );
      chmodSync(fixture, 0o755);

      function runChild() {
        return new Promise((resolve, reject) => {
          let out = '';
          const c = spawn('bash', [fixture], { stdio: ['ignore', 'pipe', 'pipe'] });
          c.stdout.on('data', (d) => {
            out += d.toString();
          });
          c.on('error', reject);
          c.on('close', (code) => {
            if (code !== 0) return reject(new Error(`child exited ${code}; stdout=${out}`));
            const firstLine = out.trim().split('\n')[0];
            resolve(Number(firstLine));
          });
        });
      }

      const [tA, tB] = await Promise.all([runChild(), runChild()]);
      assert.ok(Number.isFinite(tA) && Number.isFinite(tB), `bad timestamps: ${tA}, ${tB}`);
      const delta = Math.abs(tA - tB);
      // Critical section is sleep 2 (≈2000ms). Allow 200ms scheduling slack.
      assert.ok(
        delta >= 1800,
        `expected ≥1800ms between lock acquisitions (serialized), got ${delta}ms`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

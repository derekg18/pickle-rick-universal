import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const INSTALL_SH = path.join(REPO_ROOT, 'install.sh');

function makeFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'pickle-install-manifest-'));
  const home = path.join(dir, 'home');
  const xdg = path.join(dir, 'xdg');
  const bin = path.join(dir, 'bin');
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  mkdirSync(path.join(home, '.codex'), { recursive: true });
  mkdirSync(xdg, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(home, '.claude', 'settings.json'), '{}');
  for (const name of ['claude', 'codex', 'gemini', 'bun']) {
    writeFileSync(path.join(bin, name), '#!/bin/sh\necho shim\n', { mode: 0o755 });
  }
  return { dir, home, xdg, bin };
}

test('install manifest records package, roots, checksums, host status, counts, files, and reasons', () => {
  const fixture = makeFixture();
  try {
    const result = spawnSync('bash', [INSTALL_SH], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: fixture.home,
        XDG_DATA_HOME: fixture.xdg,
        PICKLE_INSTALL_MODE: 'tarball',
        PATH: `${fixture.bin}${path.delimiter}${process.env.PATH}`,
        FORCE_COLOR: '0',
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const manifestPath = path.join(fixture.xdg, 'pickle-rick', 'install_manifest.json');
    assert.equal(existsSync(manifestPath), true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'extension', 'package.json'), 'utf8'));

    assert.equal(manifest.schema_version, 1);
    assert.equal(manifest.package_version, pkg.version);
    assert.match(manifest.installed_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(manifest.source_root, REPO_ROOT);
    assert.equal(manifest.runtime_root, path.join(fixture.xdg, 'pickle-rick', 'runtime'));
    assert.equal(manifest.data_root, path.join(fixture.xdg, 'pickle-rick'));
    assert.equal(manifest.manifest_file, manifestPath);
    assert.match(manifest.checksums['extension/package.json'], /^[a-f0-9]{64}$/);
    assert.match(manifest.checksums['pickle_settings.json'], /^[a-f0-9]{64}$/);
    assert.ok(manifest.runtime.files_written.some((file) => file.endsWith('/extension/package.json')));

    assert.equal(manifest.hosts.claude.status, 'installed');
    assert.equal(manifest.hosts.claude.command_count, 33);
    assert.equal(manifest.hosts.claude.agent_count, 14);
    assert.ok(manifest.hosts.claude.files_written.some((file) => file.endsWith('/commands/pickle.md')));
    assert.match(manifest.hosts.claude.file_checksums[
      manifest.hosts.claude.files_written.find((file) => file.endsWith('/commands/pickle.md'))
    ], /^[a-f0-9]{64}$/);
    assert.equal(manifest.hosts.claude.reason, null);

    assert.equal(manifest.hosts.codex.status, 'installed');
    assert.equal(manifest.hosts.codex.command_count, 33);
    assert.ok(manifest.hosts.codex.files_written.some((file) => file.endsWith('/prompts/pickle-rick/pickle.md')));
    assert.match(manifest.hosts.codex.file_checksums[
      manifest.hosts.codex.files_written.find((file) => file.endsWith('/prompts/pickle-rick/pickle.md'))
    ], /^[a-f0-9]{64}$/);

    assert.equal(manifest.hosts.gemini.status, 'skipped');
    assert.equal(manifest.hosts.gemini.reason, 'host root not found');
    assert.deepEqual(manifest.hosts.gemini.files_written, []);
    assert.deepEqual(manifest.hosts.gemini.file_checksums, {});
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

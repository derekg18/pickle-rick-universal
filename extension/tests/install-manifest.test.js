import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PICKLE_CODEX_AGENT_NAMES,
  canonicalCommandNames,
  commandsForHost,
  expectedAdapterRelativePaths,
} from '../services/host-command-registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const INSTALL_SH = path.join(REPO_ROOT, 'install.sh');
const COMMAND_NAMES = canonicalCommandNames();
const COMMAND_COUNT = COMMAND_NAMES.length;
const HOST_NAMES = ['claude', 'codex', 'gemini'];
const VALID_HOST_STATUSES = new Set(['installed', 'skipped', 'error']);

function makeFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'pickle-install-manifest-'));
  const home = path.join(dir, 'home');
  const xdg = path.join(dir, 'xdg');
  const bin = path.join(dir, 'bin');
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  mkdirSync(path.join(home, '.codex'), { recursive: true });
  mkdirSync(path.join(home, '.gemini'), { recursive: true });
  mkdirSync(xdg, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(home, '.claude', 'settings.json'), '{}');
  for (const name of ['claude', 'codex', 'gemini', 'bun']) {
    writeFileSync(path.join(bin, name), '#!/bin/sh\necho shim\n', { mode: 0o755 });
  }
  return { dir, home, xdg, bin };
}

function assertManifestIncludesCommands(files, suffixPrefix, host) {
  for (const command of COMMAND_NAMES) {
    assert.ok(
      files.some((file) => file.endsWith(`${suffixPrefix}${command}.md`)),
      `${host} manifest must include /${command}`,
    );
  }
}

function assertInstalledAdapterPaths(files, host) {
  const expectedPaths = expectedAdapterRelativePaths(host);
  for (const expectedPath of expectedPaths) {
    assert.ok(
      files.some((file) => file.endsWith(expectedPath)),
      `${host} manifest must include adapter path ${expectedPath}`,
    );
  }
}

function assertHostManifestContract(hostName, host) {
  assert.equal(host.host, hostName, `${hostName} manifest host field must match`);
  assert.equal(VALID_HOST_STATUSES.has(host.status), true, `${hostName} manifest status must be valid`);
  assert.equal(Array.isArray(host.files_written), true, `${hostName} manifest files_written must be an array`);
  assert.equal(Array.isArray(host.backups), true, `${hostName} manifest backups must be an array`);
  assert.equal(typeof host.file_checksums, 'object', `${hostName} manifest file_checksums must be an object`);
  assert.notEqual(host.file_checksums, null, `${hostName} manifest file_checksums must be present`);
  assert.equal(typeof host.command_count, 'number', `${hostName} manifest command_count must be numeric`);
  assert.equal(typeof host.agent_count, 'number', `${hostName} manifest agent_count must be numeric`);
  assert.equal(host.root === null || typeof host.root === 'string', true, `${hostName} manifest root must be string or null`);
  assert.equal(
    host.settings_file === null || typeof host.settings_file === 'string',
    true,
    `${hostName} manifest settings_file must be string or null`,
  );

  if (host.status === 'installed') {
    const checksums = Object.values(host.file_checksums);
    assert.equal(host.reason, null, `${hostName} installed host reason must be null`);
    assert.ok(host.files_written.length > 0, `${hostName} installed host must record managed files`);
    assert.ok(checksums.length > 0, `${hostName} installed host must record managed file checksums`);
    for (const checksum of checksums) {
      assert.match(checksum, /^[a-f0-9]{64}$/, `${hostName} managed file checksum must be sha256`);
    }
  } else {
    assert.equal(typeof host.reason, 'string', `${hostName} ${host.status} host reason must be a string`);
    assert.ok(host.reason.length > 0, `${hostName} ${host.status} host reason must be nonempty`);
  }
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
    assert.match(result.stdout, new RegExp(`Manifest: ${manifestPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(result.stdout, /Claude: installed/);
    assert.match(result.stdout, /Codex: installed/);
    assert.match(result.stdout, /Gemini: installed/);
    assert.equal(existsSync(manifestPath), true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'extension', 'package.json'), 'utf8'));

    assert.equal(pkg.name, 'pickle-rick-universal');
    assert.equal(manifest.schema_version, 1);
    assert.equal(manifest.package_version, pkg.version);
    assert.match(manifest.installed_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(manifest.source_root, REPO_ROOT);
    const runtimeRoot = path.join(fixture.xdg, 'pickle-rick', 'runtime');
    assert.equal(manifest.runtime_root, runtimeRoot);
    assert.equal(path.isAbsolute(manifest.runtime_root), true);
    assert.equal(manifest.runtime_root.startsWith(REPO_ROOT), false);
    assert.equal(manifest.data_root, path.join(fixture.xdg, 'pickle-rick'));
    assert.equal(manifest.manifest_file, manifestPath);
    assert.match(manifest.checksums['extension/package.json'], /^[a-f0-9]{64}$/);
    assert.match(manifest.checksums['pickle_settings.json'], /^[a-f0-9]{64}$/);
    assert.ok(manifest.runtime.files_written.some((file) => file.endsWith('/extension/package.json')));
    for (const hostName of HOST_NAMES) {
      assertHostManifestContract(hostName, manifest.hosts[hostName]);
    }

    assert.equal(manifest.hosts.claude.status, 'installed');
    assert.equal(manifest.hosts.claude.command_count, COMMAND_COUNT);
    assert.equal(manifest.hosts.claude.agent_count, 14);
    assertManifestIncludesCommands(manifest.hosts.claude.files_written, '/commands/', 'Claude');
    assertInstalledAdapterPaths(manifest.hosts.claude.files_written, 'claude');
    const claudeRuntimeMarker = manifest.hosts.claude.files_written.find((file) => file.endsWith('/runtime_root'));
    assert.equal(readFileSync(claudeRuntimeMarker, 'utf8').trim(), runtimeRoot);
    assert.match(manifest.hosts.claude.file_checksums[claudeRuntimeMarker], /^[a-f0-9]{64}$/);
    assert.match(manifest.hosts.claude.file_checksums[
      manifest.hosts.claude.files_written.find((file) => file.endsWith('/commands/pickle.md'))
    ], /^[a-f0-9]{64}$/);
    assert.equal(manifest.hosts.claude.reason, null);

    assert.equal(manifest.hosts.codex.status, 'installed');
    assert.equal(manifest.hosts.codex.command_count, COMMAND_COUNT);
    assert.equal(manifest.hosts.codex.agent_count, PICKLE_CODEX_AGENT_NAMES.length);
    assert.equal(manifest.hosts.codex.settings_file, path.join(fixture.home, '.codex', 'config.toml'));
    assertManifestIncludesCommands(manifest.hosts.codex.files_written, '/prompts/pickle-rick/', 'Codex');
    assertManifestIncludesCommands(
      manifest.hosts.codex.files_written,
      '/plugins/cache/pickle-rick/pickle-rick/local/commands/',
      'Codex plugin',
    );
    assertInstalledAdapterPaths(manifest.hosts.codex.files_written, 'codex');
    const codexRuntimeMarker = manifest.hosts.codex.files_written.find((file) => file.endsWith('/pickle-rick/runtime_root'));
    assert.equal(readFileSync(codexRuntimeMarker, 'utf8').trim(), runtimeRoot);
    assert.match(manifest.hosts.codex.file_checksums[codexRuntimeMarker], /^[a-f0-9]{64}$/);
    assert.match(manifest.hosts.codex.file_checksums[
      manifest.hosts.codex.files_written.find((file) => file.endsWith('/prompts/pickle-rick/pickle.md'))
    ], /^[a-f0-9]{64}$/);
    const codexFlatPrompt = manifest.hosts.codex.files_written.find((file) => file.endsWith('/.codex/prompts/pickle.md'));
    assert.equal(readFileSync(codexFlatPrompt, 'utf8').length > 0, true);
    assert.match(manifest.hosts.codex.file_checksums[codexFlatPrompt], /^[a-f0-9]{64}$/);
    const codexPluginManifest = manifest.hosts.codex.files_written.find((file) => file.endsWith('/plugins/cache/pickle-rick/pickle-rick/local/.codex-plugin/plugin.json'));
    const codexPluginSkill = manifest.hosts.codex.files_written.find((file) => file.endsWith('/plugins/cache/pickle-rick/pickle-rick/local/skills/pickle/SKILL.md'));
    const codexAgent = manifest.hosts.codex.files_written.find((file) => file.endsWith('/.codex/agents/morty-implementer.toml'));
    const codexPluginAgent = manifest.hosts.codex.files_written.find((file) => file.endsWith('/plugins/cache/pickle-rick/pickle-rick/local/agents/morty-implementer.toml'));
    assert.equal(JSON.parse(readFileSync(codexPluginManifest, 'utf8')).name, 'pickle-rick');
    assert.equal(JSON.parse(readFileSync(codexPluginManifest, 'utf8')).agents, './agents/');
    assert.match(readFileSync(codexPluginSkill, 'utf8'), /name: pickle/);
    assert.match(readFileSync(codexAgent, 'utf8'), /name = "morty-implementer"/);
    assert.match(readFileSync(codexPluginAgent, 'utf8'), /name = "morty-implementer"/);
    assert.match(manifest.hosts.codex.file_checksums[codexPluginManifest], /^[a-f0-9]{64}$/);
    assert.match(manifest.hosts.codex.file_checksums[codexPluginSkill], /^[a-f0-9]{64}$/);
    assert.match(manifest.hosts.codex.file_checksums[codexAgent], /^[a-f0-9]{64}$/);
    assert.match(manifest.hosts.codex.file_checksums[codexPluginAgent], /^[a-f0-9]{64}$/);
    const codexConfig = readFileSync(manifest.hosts.codex.settings_file, 'utf8');
    assert.match(codexConfig, /\[features\]\nplugins = true/);
    assert.match(codexConfig, /\[plugins\."pickle-rick@pickle-rick"\]\nenabled = true/);
    const codexMarketplacePath = path.join(fixture.home, '.agents', 'plugins', 'marketplace.json');
    const codexMarketplace = JSON.parse(readFileSync(codexMarketplacePath, 'utf8'));
    assert.deepEqual(codexMarketplace.plugins.find((plugin) => plugin.name === 'pickle-rick')?.source, {
      source: 'local',
      path: './plugins/pickle-rick',
    });

    assert.equal(manifest.hosts.gemini.status, 'installed');
    assert.equal(manifest.hosts.gemini.command_count, COMMAND_COUNT);
    assert.equal(manifest.hosts.gemini.agent_count, 0);
    assert.equal(manifest.hosts.gemini.settings_file, path.join(fixture.home, '.gemini', 'settings.json'));
    assertManifestIncludesCommands(manifest.hosts.gemini.files_written, '/extensions/pickle-rick/commands-md/', 'Gemini markdown');
    assertInstalledAdapterPaths(manifest.hosts.gemini.files_written, 'gemini');
    const geminiRuntimeMarker = manifest.hosts.gemini.files_written.find((file) => file.endsWith('/extensions/pickle-rick/runtime_root'));
    assert.equal(readFileSync(geminiRuntimeMarker, 'utf8').trim(), runtimeRoot);
    assert.match(manifest.hosts.gemini.file_checksums[geminiRuntimeMarker], /^[a-f0-9]{64}$/);
    const geminiToml = manifest.hosts.gemini.files_written.find((file) => file.endsWith('/extensions/pickle-rick/commands/pickle.toml'));
    assert.match(readFileSync(geminiToml, 'utf8'), /PICKLE_HOST_BACKEND=gemini/);
    assert.match(manifest.hosts.gemini.file_checksums[geminiToml], /^[a-f0-9]{64}$/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

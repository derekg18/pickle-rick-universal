import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalCommandNames } from '../services/host-command-registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const INSTALL_SH = path.join(REPO_ROOT, 'install.sh');
const OLD_CLAUDE_STOP_HOOK = 'node /Users/derekgreene/.gemini/extensions/pickle-rick/extension/hooks/dispatch.js stop-hook';
const OLD_CLAUDE_COMMIT_HOOK = 'node /Users/derekgreene/.gemini/extensions/pickle-rick/extension/bin/log-commit.js';
const COMMAND_NAMES = canonicalCommandNames();
const COMMAND_COUNT = COMMAND_NAMES.length;

function legacyClaudeRuntimeRoot(fixture) {
  return path.join(fixture.home, '.claude', 'pickle-rick');
}

function legacyRuntimeRootMarker(fixture) {
  return path.join(legacyClaudeRuntimeRoot(fixture), 'runtime_root');
}

function claudeStopHook(fixture) {
  return `sh -c 'exec node "$(cat ${legacyRuntimeRootMarker(fixture)})/extension/hooks/dispatch.js" stop-hook'`;
}

function claudeCommitHook(fixture) {
  return `sh -c 'exec node "$(cat ${legacyRuntimeRootMarker(fixture)})/extension/bin/log-commit.js"'`;
}

function makeFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'pickle-universal-install-'));
  const home = path.join(dir, 'home');
  const xdg = path.join(dir, 'xdg');
  const bin = path.join(dir, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(xdg, { recursive: true });
  mkdirSync(bin, { recursive: true });
  for (const name of ['claude', 'codex', 'gemini', 'bun']) {
    const shim = path.join(bin, name);
    writeFileSync(shim, '#!/bin/sh\necho shim\n', { mode: 0o755 });
  }
  return { dir, home, xdg, bin };
}

function runInstall(fixture) {
  return spawnSync('bash', [INSTALL_SH], {
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
}

function readManifest(fixture) {
  return JSON.parse(readFileSync(path.join(fixture.xdg, 'pickle-rick', 'install_manifest.json'), 'utf8'));
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
}

function settingsPath(fixture, host) {
  return path.join(fixture.home, `.${host}`, 'settings.json');
}

function runtimeMarker(file) {
  return readFileSync(file, 'utf8').trim();
}

function countFiles(dir, suffix) {
  return readdirSync(dir).filter((file) => file.endsWith(suffix)).length;
}

function commandSurfaceCounts(fixture) {
  return {
    claude: countFiles(path.join(fixture.home, '.claude', 'commands'), '.md'),
    codex: countFiles(path.join(fixture.home, '.codex', 'prompts', 'pickle-rick'), '.md'),
    geminiMarkdown: countFiles(path.join(fixture.home, '.gemini', 'extensions', 'pickle-rick', 'commands-md'), '.md'),
    geminiToml: countFiles(path.join(fixture.home, '.gemini', 'extensions', 'pickle-rick', 'commands'), '.toml'),
  };
}

function assertNoStaleRuntimeReference(content, fixture, runtimeRoot) {
  assert.equal(content.includes(REPO_ROOT), false, 'adapter content must not point at the source checkout');
  assert.equal(content.includes(fixture.dir) && !content.includes(runtimeRoot), false, 'adapter content must not point at fixture temp paths outside runtime_root');
}

function assertFixtureOwnedClaudeHook(content, fixture) {
  assert.equal(content.includes('/Users/derekgreene/.gemini/extensions/pickle-rick'), false, 'Claude hook must not point at the old hardcoded Gemini runtime');
  assert.equal(content.includes(legacyRuntimeRootMarker(fixture)), true, 'Claude hook must read the fixture-owned runtime marker');
}

function assertInstalledCommandSurfaces(fixture, runtimeRoot) {
  for (const command of COMMAND_NAMES) {
    assert.equal(existsSync(path.join(fixture.home, '.claude', 'commands', `${command}.md`)), true, `Claude must install /${command}`);
    assert.equal(existsSync(path.join(fixture.home, '.codex', 'prompts', 'pickle-rick', `${command}.md`)), true, `Codex must install /${command}`);
    assert.equal(
      existsSync(path.join(fixture.home, '.gemini', 'extensions', 'pickle-rick', 'commands-md', `${command}.md`)),
      true,
      `Gemini must install markdown for /${command}`,
    );
    const geminiToml = path.join(fixture.home, '.gemini', 'extensions', 'pickle-rick', 'commands', `${command}.toml`);
    assert.equal(existsSync(geminiToml), true, `Gemini must install TOML for /${command}`);
    const geminiTomlContent = readFileSync(geminiToml, 'utf8');
    assert.ok(geminiTomlContent.includes(`../commands-md/${command}.md`), `Gemini TOML must point at markdown for /${command}`);
    assert.ok(geminiTomlContent.includes('{{args}}'), `Gemini TOML must preserve args for /${command}`);
    assertNoStaleRuntimeReference(geminiTomlContent, fixture, runtimeRoot);
  }
}

describe('universal install.sh host adapters', () => {
  test('installs shared runtime and all present hosts', () => {
    const fixture = makeFixture();
    try {
      writeJson(settingsPath(fixture, 'claude'), {
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'third-party' }, { type: 'command', command: OLD_CLAUDE_STOP_HOOK }] }],
          PostToolUse: [{ hooks: [{ type: 'command', command: OLD_CLAUDE_COMMIT_HOOK }] }],
        },
      });
      mkdirSync(path.join(fixture.home, '.codex'), { recursive: true });
      writeJson(settingsPath(fixture, 'gemini'), {});

      const result = runInstall(fixture);

      assert.equal(result.status, 0, result.stderr);
      const manifest = readManifest(fixture);
      const runtimeRoot = path.join(fixture.xdg, 'pickle-rick', 'runtime');
      assert.equal(manifest.runtime_root, runtimeRoot);
      assert.equal(path.isAbsolute(manifest.runtime_root), true);
      assert.equal(manifest.hosts.claude.status, 'installed');
      assert.equal(manifest.hosts.codex.status, 'installed');
      assert.equal(manifest.hosts.gemini.status, 'installed');
      assert.equal(manifest.hosts.claude.command_count, COMMAND_COUNT);
      assert.equal(manifest.hosts.codex.command_count, COMMAND_COUNT);
      assert.equal(manifest.hosts.gemini.command_count, COMMAND_COUNT);

      assert.equal(existsSync(path.join(fixture.xdg, 'pickle-rick', 'runtime', 'extension', 'bin', 'setup.js')), true);
      assert.ok(manifest.hosts.claude.files_written.includes(legacyClaudeRuntimeRoot(fixture)));
      assert.ok(manifest.hosts.claude.files_written.includes(legacyRuntimeRootMarker(fixture)));
      assert.equal(runtimeMarker(legacyRuntimeRootMarker(fixture)), runtimeRoot);
      assert.equal(manifest.hosts.claude.file_checksums[legacyRuntimeRootMarker(fixture)].length, 64);
      const codexRuntimeMarker = path.join(fixture.home, '.codex', 'pickle-rick', 'runtime_root');
      const geminiRuntimeMarker = path.join(fixture.home, '.gemini', 'extensions', 'pickle-rick', 'runtime_root');
      assert.equal(runtimeMarker(codexRuntimeMarker), runtimeRoot);
      assert.equal(runtimeMarker(geminiRuntimeMarker), runtimeRoot);
      assertInstalledCommandSurfaces(fixture, runtimeRoot);
      const geminiTmuxRunner = path.join(fixture.home, '.gemini', 'extensions', 'pickle-rick', 'extension', 'bin', 'tmux-runner.js');
      assert.equal(existsSync(geminiTmuxRunner), true);
      assert.equal(lstatSync(geminiTmuxRunner).isSymbolicLink(), true);
      assert.equal(
        readlinkSync(geminiTmuxRunner),
        path.join(fixture.xdg, 'pickle-rick', 'runtime', 'extension', 'bin', 'mux-runner.js'),
      );
      assert.ok(manifest.hosts.gemini.files_written.includes(geminiTmuxRunner));
      assert.equal(manifest.hosts.gemini.file_checksums[geminiTmuxRunner].length, 64);

      const claudeSettings = JSON.parse(readFileSync(settingsPath(fixture, 'claude'), 'utf8'));
      const stopCommands = claudeSettings.hooks.Stop.flatMap((group) => group.hooks.map((hook) => hook.command));
      assert.ok(stopCommands.includes('third-party'));
      assert.ok(stopCommands.includes(claudeStopHook(fixture)));
      assert.equal(stopCommands.includes(OLD_CLAUDE_STOP_HOOK), false);
      assertFixtureOwnedClaudeHook(claudeStopHook(fixture), fixture);
      const postCommands = claudeSettings.hooks.PostToolUse.flatMap((group) => group.hooks.map((hook) => hook.command));
      assert.ok(postCommands.includes(claudeCommitHook(fixture)));
      assert.equal(postCommands.includes(OLD_CLAUDE_COMMIT_HOOK), false);
      assert.equal(readdirSync(path.join(fixture.home, '.claude', 'backups')).length, 1);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('skips one missing host without blocking other hosts', () => {
    const fixture = makeFixture();
    try {
      writeJson(settingsPath(fixture, 'claude'), {});
      writeJson(settingsPath(fixture, 'gemini'), {});

      const result = runInstall(fixture);

      assert.equal(result.status, 0, result.stderr);
      const manifest = readManifest(fixture);
      assert.equal(manifest.hosts.claude.status, 'installed');
      assert.equal(manifest.hosts.codex.status, 'skipped');
      assert.equal(manifest.hosts.codex.reason, 'host root not found');
      assert.equal(manifest.hosts.gemini.status, 'installed');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('records invalid host settings as a per-host error', () => {
    const fixture = makeFixture();
    try {
      writeJson(settingsPath(fixture, 'claude'), {});
      mkdirSync(path.join(fixture.home, '.codex'), { recursive: true });
      mkdirSync(path.join(fixture.home, '.gemini'), { recursive: true });
      writeFileSync(settingsPath(fixture, 'gemini'), '{not json');

      const result = runInstall(fixture);

      assert.equal(result.status, 0, result.stderr);
      const manifest = readManifest(fixture);
      assert.equal(manifest.hosts.claude.status, 'installed');
      assert.equal(manifest.hosts.codex.status, 'installed');
      assert.equal(manifest.hosts.gemini.status, 'error');
      assert.equal(manifest.hosts.gemini.reason, 'settings.json is not valid JSON');
      assert.equal(existsSync(path.join(fixture.home, '.gemini', 'extensions', 'pickle-rick')), false);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('repeated installs are idempotent for Claude hooks and still create backups', () => {
    const fixture = makeFixture();
    try {
      writeJson(settingsPath(fixture, 'claude'), {});
      mkdirSync(path.join(fixture.home, '.codex'), { recursive: true });
      writeJson(settingsPath(fixture, 'gemini'), {});

      const first = runInstall(fixture);
      assert.equal(first.status, 0, first.stderr);
      const firstCounts = commandSurfaceCounts(fixture);
      const second = runInstall(fixture);
      assert.equal(second.status, 0, second.stderr);
      assert.deepEqual(commandSurfaceCounts(fixture), firstCounts);
      assert.deepEqual(firstCounts, {
        claude: COMMAND_COUNT,
        codex: COMMAND_COUNT,
        geminiMarkdown: COMMAND_COUNT,
        geminiToml: COMMAND_COUNT,
      });
      const claudeSettings = JSON.parse(readFileSync(settingsPath(fixture, 'claude'), 'utf8'));
      const stopCommands = claudeSettings.hooks.Stop.flatMap((group) => group.hooks.map((hook) => hook.command));
      const pickleStops = stopCommands.filter((command) => command === claudeStopHook(fixture));
      assert.equal(pickleStops.length, 1);
      const postCommands = claudeSettings.hooks.PostToolUse.flatMap((group) => group.hooks.map((hook) => hook.command));
      assert.equal(postCommands.filter((command) => command === claudeCommitHook(fixture)).length, 1);
      assert.ok(readdirSync(path.join(fixture.home, '.claude', 'backups')).length >= 2);
      assert.equal(readManifest(fixture).hosts.claude.status, 'installed');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('reruns preserve unmanaged user files while deleting stale managed runtime files', () => {
    const fixture = makeFixture();
    try {
      writeJson(settingsPath(fixture, 'claude'), { userSetting: 'keep' });
      mkdirSync(path.join(fixture.home, '.codex'), { recursive: true });
      writeJson(settingsPath(fixture, 'gemini'), { userSetting: 'keep' });

      const first = runInstall(fixture);
      assert.equal(first.status, 0, first.stderr);

      const runtimeStale = path.join(fixture.xdg, 'pickle-rick', 'runtime', 'extension', 'bin', 'stale-managed.js');
      const geminiStale = path.join(fixture.home, '.gemini', 'extensions', 'pickle-rick', 'extension', 'bin', 'stale-managed.js');
      const claudeUserCommand = path.join(fixture.home, '.claude', 'commands', 'user-command.md');
      const codexUserCommand = path.join(fixture.home, '.codex', 'prompts', 'pickle-rick', 'user-command.md');
      const geminiUserCommand = path.join(fixture.home, '.gemini', 'extensions', 'pickle-rick', 'commands-md', 'user-command.md');
      const geminiUserToml = path.join(fixture.home, '.gemini', 'extensions', 'pickle-rick', 'commands', 'user-command.toml');

      writeFileSync(runtimeStale, 'stale runtime\n');
      writeFileSync(geminiStale, 'stale adapter runtime\n');
      writeFileSync(claudeUserCommand, '# user command\n');
      writeFileSync(codexUserCommand, '# user command\n');
      writeFileSync(geminiUserCommand, '# user command\n');
      writeFileSync(geminiUserToml, 'description = "user command"\n');

      const second = runInstall(fixture);

      assert.equal(second.status, 0, second.stderr);
      assert.equal(existsSync(runtimeStale), false);
      assert.equal(existsSync(geminiStale), false);
      assert.equal(existsSync(claudeUserCommand), true);
      assert.equal(existsSync(codexUserCommand), true);
      assert.equal(existsSync(geminiUserCommand), true);
      assert.equal(existsSync(geminiUserToml), true);
      assert.equal(JSON.parse(readFileSync(settingsPath(fixture, 'claude'), 'utf8')).userSetting, 'keep');
      assert.equal(JSON.parse(readFileSync(settingsPath(fixture, 'gemini'), 'utf8')).userSetting, 'keep');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('backup captures original Claude settings before hook merge', () => {
    const fixture = makeFixture();
    try {
      const original = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'existing-stop' }] }] } };
      writeJson(settingsPath(fixture, 'claude'), original);
      writeJson(path.join(fixture.xdg, 'pickle-rick', 'runtime', 'pickle_settings.json'), { custom_runtime_setting: true });

      const result = runInstall(fixture);

      assert.equal(result.status, 0, result.stderr);
      const backupDir = path.join(fixture.home, '.claude', 'backups');
      const backups = readdirSync(backupDir);
      assert.equal(backups.length, 1);
      assert.deepEqual(JSON.parse(readFileSync(path.join(backupDir, backups[0]), 'utf8')), original);
      assert.deepEqual(readManifest(fixture).hosts.claude.backups.map((file) => path.basename(file)), backups);
      assert.equal(
        JSON.parse(readFileSync(path.join(fixture.xdg, 'pickle-rick', 'runtime', 'pickle_settings.json'), 'utf8')).custom_runtime_setting,
        true,
      );
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});

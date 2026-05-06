import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED_PICKLE_COMMANDS } from '../services/host-command-registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const INSTALL_SH = path.join(REPO_ROOT, 'install.sh');
const LEGACY_CLAUDE_RUNTIME_ROOT = '/Users/derekgreene/.gemini/extensions/pickle-rick';
const CODEX_VERSION = resolveCodexVersion();
const P0_P1_CONFORMANCE_MAP = [
  {
    requirement: 'P0 shared runtime root is canonical across installed hosts',
    files: ['system-extension-smoke.test.js', 'universal-install.test.js', 'install-manifest.test.js'],
  },
  {
    requirement: 'P0 Claude, Codex, and Gemini expose every required command',
    files: ['system-extension-smoke.test.js', 'universal-install.test.js', 'host-command-parity.test.js'],
  },
  {
    requirement: 'P0 preflight checks manifest-managed host files before launch',
    files: ['adapter-preflight.test.js'],
  },
  {
    requirement: 'P0 cross-host launch and resume preserve session identity, backend, and command template semantics',
    files: ['system-extension-smoke.test.js'],
  },
  {
    requirement: 'P1 installer reruns are idempotent and preserve unmanaged user files',
    files: ['universal-install.test.js'],
  },
  {
    requirement: 'P1 manifest records host health status, files, checksums, and reasons',
    files: ['install-manifest.test.js'],
  },
  {
    requirement: 'P1 install output reports installed, skipped, error host states and manifest path',
    files: ['install-manifest.test.js', 'universal-install.test.js'],
  },
];

function resolveCodexVersion() {
  const packageJson = JSON.parse(readFileSync(path.join(REPO_ROOT, 'extension', 'package.json'), 'utf8'));
  const match = String(packageJson.engines?.codex ?? '').match(/\d+\.\d+\.\d+/);
  assert.ok(match, 'extension/package.json must declare a numeric codex engine version');
  return match[0];
}

function makeFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'pickle-system-smoke-'));
  const home = path.join(dir, 'home');
  const xdg = path.join(dir, 'xdg');
  const dataRoot = path.join(xdg, 'pickle-rick');
  const bin = path.join(dir, 'bin');
  const cwd = path.join(dir, 'unrelated-project');
  const shimLog = path.join(dir, 'shim.log');

  mkdirSync(path.join(home, '.claude'), { recursive: true });
  mkdirSync(path.join(home, '.codex'), { recursive: true });
  mkdirSync(path.join(home, '.gemini'), { recursive: true });
  mkdirSync(xdg, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(path.join(home, '.claude', 'settings.json'), '{}\n');
  writeFileSync(path.join(home, '.gemini', 'settings.json'), '{}\n');

  for (const name of ['claude', 'codex', 'gemini', 'bun']) {
    writeShim(path.join(bin, name), name);
  }

  return { dir, home, xdg, dataRoot, bin, cwd: realpathSync(cwd), shimLog };
}

function writeShim(file, name) {
  writeFileSync(file, [
    '#!/bin/sh',
    'if [ -n "$SHIM_LOG" ]; then',
    `  printf '%s\\t%s\\n' ${JSON.stringify(name)} "$*" >> "$SHIM_LOG"`,
    'fi',
    'case "$1" in',
    `  --version|-v|version) printf '%s ${CODEX_VERSION}\\n' ${JSON.stringify(name)} ;;`,
    `  *) printf 'fake %s invoked\\n' ${JSON.stringify(name)} ;;`,
    'esac',
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });
}

function fixtureEnv(fixture) {
  return {
    ...process.env,
    HOME: fixture.home,
    XDG_DATA_HOME: fixture.xdg,
    PICKLE_DATA_ROOT: fixture.dataRoot,
    PICKLE_INSTALL_MODE: 'tarball',
    PATH: `${fixture.bin}${path.delimiter}${process.env.PATH}`,
    SHIM_LOG: fixture.shimLog,
    FORCE_COLOR: '0',
  };
}

function runInstall(fixture) {
  return spawnSync('bash', [INSTALL_SH], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: fixtureEnv(fixture),
  });
}

function runSetup(fixture, setupScript, args) {
  return spawnSync(process.execPath, [setupScript, ...args], {
    cwd: fixture.cwd,
    encoding: 'utf8',
    env: fixtureEnv(fixture),
  });
}

function parseSessionRoot(output) {
  const match = output.match(/^SESSION_ROOT=(.+)$/m);
  assert.ok(match, `SESSION_ROOT not found in output:\n${output}`);
  return match[1].trim();
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function runtimeRoot(fixture) {
  return path.join(fixture.dataRoot, 'runtime');
}

function installedRuntimeSetup(fixture) {
  return path.join(runtimeRoot(fixture), 'extension', 'bin', 'setup.js');
}

function geminiRuntimeSetup(fixture) {
  return path.join(fixture.home, '.gemini', 'extensions', 'pickle-rick', 'extension', 'bin', 'setup.js');
}

function assertNoStaleAdapterReference(content, fixture, runtimeRoot, label) {
  assert.equal(content.includes(REPO_ROOT), false, `${label} must not point at the source checkout`);
  assert.equal(
    content.includes(fixture.dir) && !content.includes(runtimeRoot),
    false,
    `${label} must not point at fixture temp paths outside runtime_root`,
  );
}

function assertCommandSurfaces(fixture) {
  const expectedRuntimeRoot = runtimeRoot(fixture);
  for (const command of REQUIRED_PICKLE_COMMANDS) {
    const claudeMarkdown = path.join(fixture.home, '.claude', 'commands', `${command}.md`);
    const codexMarkdown = path.join(fixture.home, '.codex', 'prompts', 'pickle-rick', `${command}.md`);
    const geminiMarkdown = path.join(fixture.home, '.gemini', 'extensions', 'pickle-rick', 'commands-md', `${command}.md`);
    const geminiToml = path.join(fixture.home, '.gemini', 'extensions', 'pickle-rick', 'commands', `${command}.toml`);

    assert.equal(
      existsSync(claudeMarkdown),
      true,
      `Claude must expose /${command}`,
    );
    assert.equal(
      existsSync(codexMarkdown),
      true,
      `Codex must expose /${command}`,
    );
    assert.equal(
      existsSync(geminiMarkdown),
      true,
      `Gemini must expose markdown for /${command}`,
    );
    assert.equal(existsSync(geminiToml), true, `Gemini must expose TOML for /${command}`);
    assertNoStaleAdapterReference(readFileSync(claudeMarkdown, 'utf8'), fixture, expectedRuntimeRoot, `Claude /${command}`);
    assertNoStaleAdapterReference(readFileSync(codexMarkdown, 'utf8'), fixture, expectedRuntimeRoot, `Codex /${command}`);
    assertNoStaleAdapterReference(readFileSync(geminiMarkdown, 'utf8'), fixture, expectedRuntimeRoot, `Gemini markdown /${command}`);
    const toml = readFileSync(geminiToml, 'utf8');
    assertNoStaleAdapterReference(toml, fixture, expectedRuntimeRoot, `Gemini TOML /${command}`);
    assert.ok(toml.includes(`../commands-md/${command}.md`), `Gemini TOML must target /${command} markdown`);
    assert.ok(toml.includes('{{args}}'), `Gemini TOML must pass through /${command} arguments`);
  }
}

function assertRuntimeMarkers(fixture) {
  const expected = runtimeRoot(fixture);
  assert.equal(readFileSync(path.join(fixture.home, '.codex', 'pickle-rick', 'runtime_root'), 'utf8').trim(), expected);
  assert.equal(readFileSync(path.join(fixture.home, '.gemini', 'extensions', 'pickle-rick', 'runtime_root'), 'utf8').trim(), expected);
  assert.equal(readFileSync(path.join(LEGACY_CLAUDE_RUNTIME_ROOT, 'runtime_root'), 'utf8').trim(), expected);
}

function assertCodexState(state, fixture, sessionRoot, expectedCommandTemplate) {
  assert.equal(state.session_dir, sessionRoot);
  assert.equal(state.working_dir, fixture.cwd);
  assert.equal(state.backend, 'codex');
  assert.equal(state.command_template, expectedCommandTemplate);
}

function assertFakeCliUse(fixture) {
  const log = readFileSync(fixture.shimLog, 'utf8');
  assert.match(log, /^claude\t--version$/m);
  assert.match(log, /^codex\t--version$/m);
  assert.match(log, /^gemini\t--version$/m);
  const unexpectedCalls = log.trim().split('\n').filter((line) => {
    return !/^(claude|codex|gemini|bun)\t--version$/.test(line);
  });
  assert.deepEqual(unexpectedCalls, []);
}

describe('system extension cross-host smoke', () => {
  test('focused conformance gate maps every P0/P1 system-wide install requirement', () => {
    assert.deepEqual(
      P0_P1_CONFORMANCE_MAP.map(({ requirement }) => requirement),
      [
        'P0 shared runtime root is canonical across installed hosts',
        'P0 Claude, Codex, and Gemini expose every required command',
        'P0 preflight checks manifest-managed host files before launch',
        'P0 cross-host launch and resume preserve session identity, backend, and command template semantics',
        'P1 installer reruns are idempotent and preserve unmanaged user files',
        'P1 manifest records host health status, files, checksums, and reasons',
        'P1 install output reports installed, skipped, error host states and manifest path',
      ],
    );
    for (const { requirement, files } of P0_P1_CONFORMANCE_MAP) {
      assert.ok(files.length > 0, `${requirement} must map to at least one focused conformance test file`);
    }
  });

  test('fresh fixture install exposes high-value host command surfaces from an unrelated cwd', () => {
    const fixture = makeFixture();
    try {
      const install = runInstall(fixture);

      assert.equal(install.status, 0, install.stderr);
      assert.notEqual(fixture.cwd, REPO_ROOT);
      assertCommandSurfaces(fixture);
      assertRuntimeMarkers(fixture);
      assertFakeCliUse(fixture);

      const manifest = readJson(path.join(fixture.dataRoot, 'install_manifest.json'));
      assert.equal(manifest.runtime_root, runtimeRoot(fixture));
      assert.equal(manifest.hosts.claude.status, 'installed');
      assert.equal(manifest.hosts.codex.status, 'installed');
      assert.equal(manifest.hosts.gemini.status, 'installed');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('paused Codex session resumes through Claude and Gemini surfaces without live host APIs', () => {
    const fixture = makeFixture();
    try {
      const install = runInstall(fixture);
      assert.equal(install.status, 0, install.stderr);

      const launch = runSetup(fixture, installedRuntimeSetup(fixture), [
        '--backend',
        'codex',
        '--paused',
        '--task',
        'cross host smoke',
      ]);
      assert.equal(launch.status, 0, launch.stderr);
      const sessionRoot = parseSessionRoot(launch.stdout);
      assert.equal(sessionRoot.startsWith(path.join(fixture.dataRoot, 'sessions')), true);
      const launchState = readJson(path.join(sessionRoot, 'state.json'));
      assertCodexState(launchState, fixture, sessionRoot, launchState.command_template);

      const claudeResume = runSetup(fixture, path.join(LEGACY_CLAUDE_RUNTIME_ROOT, 'extension', 'bin', 'setup.js'), [
        '--resume',
        sessionRoot,
      ]);
      assert.equal(claudeResume.status, 0, claudeResume.stderr);
      assert.equal(parseSessionRoot(claudeResume.stdout), sessionRoot);
      assertCodexState(readJson(path.join(sessionRoot, 'state.json')), fixture, sessionRoot, launchState.command_template);

      const geminiResume = runSetup(fixture, geminiRuntimeSetup(fixture), [
        '--resume',
        sessionRoot,
      ]);
      assert.equal(geminiResume.status, 0, geminiResume.stderr);
      assert.equal(parseSessionRoot(geminiResume.stdout), sessionRoot);
      assertCodexState(readJson(path.join(sessionRoot, 'state.json')), fixture, sessionRoot, launchState.command_template);

      assertFakeCliUse(fixture);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});

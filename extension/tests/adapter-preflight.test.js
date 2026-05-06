import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertAdaptersFresh, AdapterPreflightError } from '../services/adapter-preflight.js';
import { renderGeminiToml } from '../services/host-command-registry.js';

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function makeFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'adapter-preflight-'));
  const sourceRoot = path.join(root, 'source');
  const runtimeRoot = path.join(root, 'runtime');
  const home = path.join(root, 'home');
  const commandSourceDir = path.join(sourceRoot, '.claude', 'commands');
  const codexPromptDir = path.join(home, '.codex', 'prompts', 'pickle-rick');
  const geminiMdDir = path.join(home, '.gemini', 'extensions', 'pickle-rick', 'commands-md');
  const geminiTomlDir = path.join(home, '.gemini', 'extensions', 'pickle-rick', 'commands');
  const runtimeBinDir = path.join(runtimeRoot, 'extension', 'bin');
  const geminiBinDir = path.join(home, '.gemini', 'extensions', 'pickle-rick', 'extension', 'bin');
  mkdirSync(commandSourceDir, { recursive: true });
  mkdirSync(codexPromptDir, { recursive: true });
  mkdirSync(geminiMdDir, { recursive: true });
  mkdirSync(geminiTomlDir, { recursive: true });
  mkdirSync(runtimeBinDir, { recursive: true });
  mkdirSync(geminiBinDir, { recursive: true });
  mkdirSync(path.join(home, '.codex', 'pickle-rick'), { recursive: true });
  mkdirSync(path.join(home, '.gemini', 'extensions', 'pickle-rick'), { recursive: true });
  mkdirSync(runtimeRoot, { recursive: true });

  const commandContent = 'Run pickle.\n';
  const personaContent = 'Persona.\n';
  const runtimeRootContent = `${runtimeRoot}\n`;
  const runtimeAdapterContent = 'console.log("runtime dispatch");\n';
  writeFileSync(path.join(commandSourceDir, 'pickle.md'), commandContent);
  writeFileSync(path.join(sourceRoot, 'persona.md'), personaContent);
  const runtimeAdapterSource = path.join(runtimeBinDir, 'dispatch.js');
  const runtimeMuxRunnerSource = path.join(runtimeBinDir, 'mux-runner.js');
  const runtimeTmuxRunnerSource = path.join(runtimeBinDir, 'tmux-runner.js');
  writeFileSync(runtimeAdapterSource, runtimeAdapterContent);
  writeFileSync(runtimeMuxRunnerSource, 'console.log("mux");\n');
  symlinkSync(runtimeMuxRunnerSource, runtimeTmuxRunnerSource);

  const codexPrompt = path.join(codexPromptDir, 'pickle.md');
  const codexPersona = path.join(home, '.codex', 'pickle-rick', 'persona.md');
  const codexRuntime = path.join(home, '.codex', 'pickle-rick', 'runtime_root');
  const geminiMd = path.join(geminiMdDir, 'pickle.md');
  const geminiToml = path.join(geminiTomlDir, 'pickle.toml');
  const geminiRuntime = path.join(home, '.gemini', 'extensions', 'pickle-rick', 'runtime_root');
  const geminiRuntimeAdapter = path.join(geminiBinDir, 'dispatch.js');
  const geminiRuntimeSymlink = path.join(geminiBinDir, 'tmux-runner.js');
  const geminiTomlContent = renderGeminiToml('pickle', '../commands-md/pickle.md');

  writeFileSync(codexPrompt, commandContent);
  writeFileSync(codexPersona, personaContent);
  writeFileSync(codexRuntime, runtimeRootContent);
  writeFileSync(geminiMd, commandContent);
  writeFileSync(geminiToml, geminiTomlContent);
  writeFileSync(geminiRuntime, runtimeRootContent);
  writeFileSync(geminiRuntimeAdapter, runtimeAdapterContent);
  symlinkSync(runtimeMuxRunnerSource, geminiRuntimeSymlink);

  const codexChecksums = {
    [codexPrompt]: sha256(commandContent),
    [codexPersona]: sha256(personaContent),
    [codexRuntime]: sha256(runtimeRootContent),
  };
  const geminiChecksums = {
    [geminiMd]: sha256(commandContent),
    [geminiToml]: sha256(geminiTomlContent),
    [geminiRuntime]: sha256(runtimeRootContent),
    [geminiRuntimeAdapter]: sha256(runtimeAdapterContent),
    [geminiRuntimeSymlink]: sha256(readFileSync(runtimeMuxRunnerSource)),
  };
  const codexFilesWritten = Object.keys(codexChecksums);
  const geminiFilesWritten = Object.keys(geminiChecksums);
  const manifestPath = path.join(root, 'install_manifest.json');
  const manifest = {
    source_root: sourceRoot,
    runtime_root: runtimeRoot,
    hosts: {
      claude: { status: 'skipped', reason: 'host root not found', files_written: [], file_checksums: {} },
      codex: { status: 'installed', files_written: codexFilesWritten, file_checksums: codexChecksums },
      gemini: { status: 'installed', files_written: geminiFilesWritten, file_checksums: geminiChecksums },
    },
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return {
    root,
    runtimeRoot,
    manifestPath,
    codexPrompt,
    codexRuntime,
    geminiRuntime,
    geminiToml,
    geminiRuntimeAdapter,
    geminiRuntimeSymlink,
    runtimeMuxRunnerSource,
    commandContent,
    geminiTomlContent,
    runtimeAdapterContent,
  };
}

describe('adapter preflight', () => {
  test('passes when installed adapter checksums match the manifest', () => {
    const fixture = makeFixture();
    try {
      const result = assertAdaptersFresh(fixture.manifestPath);
      assert.equal(result.checked, 8);
      assert.deepEqual(result.repaired, []);
      assert.deepEqual(result.skippedHosts, [{ host: 'claude', status: 'skipped', reason: 'host root not found' }]);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('auto-syncs stale managed Markdown adapters from source', () => {
    const fixture = makeFixture();
    try {
      writeFileSync(fixture.codexPrompt, 'stale\n');
      const result = assertAdaptersFresh(fixture.manifestPath);
      assert.ok(result.repaired.includes(fixture.codexPrompt));
      assert.equal(readFileSync(fixture.codexPrompt, 'utf8'), fixture.commandContent);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('auto-syncs stale Gemini TOML adapters through the registry renderer', () => {
    const fixture = makeFixture();
    try {
      writeFileSync(fixture.geminiToml, 'stale\n');
      const result = assertAdaptersFresh(fixture.manifestPath);
      assert.ok(result.repaired.includes(fixture.geminiToml));
      assert.equal(readFileSync(fixture.geminiToml, 'utf8'), fixture.geminiTomlContent);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('auto-syncs stale runtime-root markers from manifest runtime_root', () => {
    const fixture = makeFixture();
    try {
      writeFileSync(fixture.codexRuntime, '/tmp/stale-runtime\n');
      writeFileSync(fixture.geminiRuntime, '/var/folders/stale-runtime\n');
      const result = assertAdaptersFresh(fixture.manifestPath);
      assert.ok(result.repaired.includes(fixture.codexRuntime));
      assert.ok(result.repaired.includes(fixture.geminiRuntime));
      assert.equal(readFileSync(fixture.codexRuntime, 'utf8'), `${fixture.runtimeRoot}\n`);
      assert.equal(readFileSync(fixture.geminiRuntime, 'utf8'), `${fixture.runtimeRoot}\n`);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('auto-syncs stale runtime-managed adapter files from shared runtime', () => {
    const fixture = makeFixture();
    try {
      writeFileSync(fixture.geminiRuntimeAdapter, 'stale runtime adapter\n');
      const result = assertAdaptersFresh(fixture.manifestPath);
      assert.ok(result.repaired.includes(fixture.geminiRuntimeAdapter));
      assert.equal(readFileSync(fixture.geminiRuntimeAdapter, 'utf8'), fixture.runtimeAdapterContent);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('repairs deleted managed runtime symlinks from shared runtime', () => {
    const fixture = makeFixture();
    try {
      rmSync(fixture.geminiRuntimeSymlink, { force: true });
      const result = assertAdaptersFresh(fixture.manifestPath);
      assert.ok(result.repaired.includes(fixture.geminiRuntimeSymlink));
      assert.equal(lstatSync(fixture.geminiRuntimeSymlink).isSymbolicLink(), true);
      assert.equal(readlinkSync(fixture.geminiRuntimeSymlink), fixture.runtimeMuxRunnerSource);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('repairs retargeted managed runtime symlinks before launch', () => {
    const fixture = makeFixture();
    try {
      const wrongTarget = path.join(fixture.root, 'wrong-runner.js');
      writeFileSync(wrongTarget, 'wrong target\n');
      rmSync(fixture.geminiRuntimeSymlink, { force: true });
      symlinkSync(wrongTarget, fixture.geminiRuntimeSymlink);
      const result = assertAdaptersFresh(fixture.manifestPath);
      assert.ok(result.repaired.includes(fixture.geminiRuntimeSymlink));
      assert.equal(readlinkSync(fixture.geminiRuntimeSymlink), fixture.runtimeMuxRunnerSource);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('records skipped and error hosts without blocking healthy hosts', () => {
    const fixture = makeFixture();
    try {
      const manifest = JSON.parse(readFileSync(fixture.manifestPath, 'utf8'));
      manifest.hosts.codex = {
        status: 'error',
        reason: 'settings.json is not valid JSON',
        files_written: [],
        file_checksums: {},
      };
      writeFileSync(fixture.manifestPath, JSON.stringify(manifest, null, 2));
      const result = assertAdaptersFresh(fixture.manifestPath);
      assert.equal(result.checked, 5);
      assert.deepEqual(result.skippedHosts, [
        { host: 'claude', status: 'skipped', reason: 'host root not found' },
        { host: 'codex', status: 'error', reason: 'settings.json is not valid JSON' },
      ]);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('fails fast with install remediation when manifest checksums are missing', () => {
    const fixture = makeFixture();
    try {
      writeFileSync(fixture.manifestPath, JSON.stringify({
        hosts: { codex: { status: 'installed' } },
      }));
      assert.throws(
        () => assertAdaptersFresh(fixture.manifestPath),
        (err) => err instanceof AdapterPreflightError
          && /codex/.test(err.message)
          && /no file checksums/.test(err.message)
          && /Fix: bash install\.sh/.test(err.message),
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('fails fast with install remediation when a file cannot be repaired safely', () => {
    const fixture = makeFixture();
    try {
      const manifest = JSON.parse(readFileSync(fixture.manifestPath, 'utf8'));
      const unmanaged = path.join(fixture.root, 'unknown.txt');
      manifest.hosts.codex.file_checksums[unmanaged] = sha256('expected');
      writeFileSync(fixture.manifestPath, JSON.stringify(manifest, null, 2));
      assert.equal(existsSync(unmanaged), false);
      assert.throws(
        () => assertAdaptersFresh(fixture.manifestPath),
        (err) => err instanceof AdapterPreflightError
          && /codex/.test(err.message)
          && err.message.includes(unmanaged)
          && /missing/.test(err.message)
          && /unable to repair from managed source/.test(err.message)
          && /Fix: bash install\.sh/.test(err.message),
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

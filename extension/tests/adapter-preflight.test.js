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
  const codexPluginTemplateDir = path.join(sourceRoot, 'codex-plugin');
  const codexAgentSourceDir = path.join(sourceRoot, '.codex', 'agents');
  const codexPromptDir = path.join(home, '.codex', 'prompts', 'pickle-rick');
  const codexAgentDir = path.join(home, '.codex', 'agents');
  const codexPluginSourceRoot = path.join(home, 'plugins', 'pickle-rick');
  const codexPluginCacheRoot = path.join(home, '.codex', 'plugins', 'cache', 'pickle-rick', 'pickle-rick', 'local');
  const geminiMdDir = path.join(home, '.gemini', 'extensions', 'pickle-rick', 'commands-md');
  const geminiTomlDir = path.join(home, '.gemini', 'extensions', 'pickle-rick', 'commands');
  const runtimeBinDir = path.join(runtimeRoot, 'extension', 'bin');
  const geminiBinDir = path.join(home, '.gemini', 'extensions', 'pickle-rick', 'extension', 'bin');
  mkdirSync(commandSourceDir, { recursive: true });
  mkdirSync(path.join(codexPluginTemplateDir, '.codex-plugin'), { recursive: true });
  mkdirSync(path.join(codexPluginTemplateDir, 'agents'), { recursive: true });
  mkdirSync(path.join(codexPluginTemplateDir, 'skills', 'pickle'), { recursive: true });
  mkdirSync(codexAgentSourceDir, { recursive: true });
  mkdirSync(codexPromptDir, { recursive: true });
  mkdirSync(codexAgentDir, { recursive: true });
  for (const pluginRoot of [codexPluginSourceRoot, codexPluginCacheRoot]) {
    mkdirSync(path.join(pluginRoot, '.codex-plugin'), { recursive: true });
    mkdirSync(path.join(pluginRoot, 'agents'), { recursive: true });
    mkdirSync(path.join(pluginRoot, 'commands'), { recursive: true });
    mkdirSync(path.join(pluginRoot, 'skills', 'pickle'), { recursive: true });
  }
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
  const codexPluginManifestContent = `${JSON.stringify({ name: 'pickle-rick', agents: './agents/', skills: './skills/' }, null, 2)}\n`;
  const codexPluginSkillContent = '---\nname: pickle\n---\n\nRead ../../commands/pickle.md.\n';
  const codexAgentContent = 'name = "morty-implementer"\ndescription = "Implementation worker."\n';
  writeFileSync(path.join(commandSourceDir, 'pickle.md'), commandContent);
  writeFileSync(path.join(sourceRoot, 'persona.md'), personaContent);
  writeFileSync(path.join(codexPluginTemplateDir, '.codex-plugin', 'plugin.json'), codexPluginManifestContent);
  writeFileSync(path.join(codexPluginTemplateDir, 'agents', 'morty-implementer.toml'), codexAgentContent);
  writeFileSync(path.join(codexAgentSourceDir, 'morty-implementer.toml'), codexAgentContent);
  writeFileSync(path.join(codexPluginTemplateDir, 'skills', 'pickle', 'SKILL.md'), codexPluginSkillContent);
  const runtimeAdapterSource = path.join(runtimeBinDir, 'dispatch.js');
  const runtimeMuxRunnerSource = path.join(runtimeBinDir, 'mux-runner.js');
  const runtimeTmuxRunnerSource = path.join(runtimeBinDir, 'tmux-runner.js');
  writeFileSync(runtimeAdapterSource, runtimeAdapterContent);
  writeFileSync(runtimeMuxRunnerSource, 'console.log("mux");\n');
  symlinkSync(runtimeMuxRunnerSource, runtimeTmuxRunnerSource);

  const codexPrompt = path.join(codexPromptDir, 'pickle.md');
  const codexFlatPrompt = path.join(home, '.codex', 'prompts', 'pickle.md');
  const codexPersona = path.join(home, '.codex', 'pickle-rick', 'persona.md');
  const codexRuntime = path.join(home, '.codex', 'pickle-rick', 'runtime_root');
  const codexAgent = path.join(codexAgentDir, 'morty-implementer.toml');
  const codexPluginSourceAgent = path.join(codexPluginSourceRoot, 'agents', 'morty-implementer.toml');
  const codexPluginCacheAgent = path.join(codexPluginCacheRoot, 'agents', 'morty-implementer.toml');
  const codexPluginCacheSkill = path.join(codexPluginCacheRoot, 'skills', 'pickle', 'SKILL.md');
  const codexPluginCacheCommand = path.join(codexPluginCacheRoot, 'commands', 'pickle.md');
  const codexPluginCacheRuntime = path.join(codexPluginCacheRoot, 'runtime_root');
  const codexPluginSourceSkill = path.join(codexPluginSourceRoot, 'skills', 'pickle', 'SKILL.md');
  const geminiMd = path.join(geminiMdDir, 'pickle.md');
  const geminiToml = path.join(geminiTomlDir, 'pickle.toml');
  const geminiRuntime = path.join(home, '.gemini', 'extensions', 'pickle-rick', 'runtime_root');
  const geminiRuntimeAdapter = path.join(geminiBinDir, 'dispatch.js');
  const geminiRuntimeSymlink = path.join(geminiBinDir, 'tmux-runner.js');
  const geminiTomlContent = renderGeminiToml('pickle', '../commands-md/pickle.md');

  writeFileSync(codexPrompt, commandContent);
  writeFileSync(codexFlatPrompt, commandContent);
  writeFileSync(codexPersona, personaContent);
  writeFileSync(codexRuntime, runtimeRootContent);
  writeFileSync(codexAgent, codexAgentContent);
  for (const pluginRoot of [codexPluginSourceRoot, codexPluginCacheRoot]) {
    writeFileSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), codexPluginManifestContent);
    writeFileSync(path.join(pluginRoot, 'agents', 'morty-implementer.toml'), codexAgentContent);
    writeFileSync(path.join(pluginRoot, 'commands', 'pickle.md'), commandContent);
    writeFileSync(path.join(pluginRoot, 'skills', 'pickle', 'SKILL.md'), codexPluginSkillContent);
    writeFileSync(path.join(pluginRoot, 'persona.md'), personaContent);
    writeFileSync(path.join(pluginRoot, 'runtime_root'), runtimeRootContent);
  }
  writeFileSync(geminiMd, commandContent);
  writeFileSync(geminiToml, geminiTomlContent);
  writeFileSync(geminiRuntime, runtimeRootContent);
  writeFileSync(geminiRuntimeAdapter, runtimeAdapterContent);
  symlinkSync(runtimeMuxRunnerSource, geminiRuntimeSymlink);

  const codexChecksums = {
    [codexPrompt]: sha256(commandContent),
    [codexFlatPrompt]: sha256(commandContent),
    [codexPersona]: sha256(personaContent),
    [codexRuntime]: sha256(runtimeRootContent),
    [codexAgent]: sha256(codexAgentContent),
    [path.join(codexPluginSourceRoot, '.codex-plugin', 'plugin.json')]: sha256(codexPluginManifestContent),
    [codexPluginSourceAgent]: sha256(codexAgentContent),
    [path.join(codexPluginSourceRoot, 'commands', 'pickle.md')]: sha256(commandContent),
    [path.join(codexPluginSourceRoot, 'skills', 'pickle', 'SKILL.md')]: sha256(codexPluginSkillContent),
    [path.join(codexPluginSourceRoot, 'persona.md')]: sha256(personaContent),
    [path.join(codexPluginSourceRoot, 'runtime_root')]: sha256(runtimeRootContent),
    [path.join(codexPluginCacheRoot, '.codex-plugin', 'plugin.json')]: sha256(codexPluginManifestContent),
    [codexPluginCacheAgent]: sha256(codexAgentContent),
    [codexPluginCacheCommand]: sha256(commandContent),
    [codexPluginCacheSkill]: sha256(codexPluginSkillContent),
    [path.join(codexPluginCacheRoot, 'persona.md')]: sha256(personaContent),
    [codexPluginCacheRuntime]: sha256(runtimeRootContent),
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
    codexFlatPrompt,
    codexRuntime,
    codexAgent,
    codexAgentContent,
    codexPluginSourceAgent,
    codexPluginCacheAgent,
    codexPluginCacheCommand,
    codexPluginCacheRuntime,
    codexPluginCacheSkill,
    codexPluginSourceSkill,
    geminiRuntime,
    geminiToml,
    geminiRuntimeAdapter,
    geminiRuntimeSymlink,
    runtimeMuxRunnerSource,
    commandContent,
    codexPluginSkillContent,
    geminiTomlContent,
    runtimeAdapterContent,
  };
}

describe('adapter preflight', () => {
  test('passes when installed adapter checksums match the manifest', () => {
    const fixture = makeFixture();
    try {
      const result = assertAdaptersFresh(fixture.manifestPath);
      assert.equal(result.checked, 22);
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
      writeFileSync(fixture.codexFlatPrompt, 'stale\n');
      const result = assertAdaptersFresh(fixture.manifestPath);
      assert.ok(result.repaired.includes(fixture.codexPrompt));
      assert.ok(result.repaired.includes(fixture.codexFlatPrompt));
      assert.equal(readFileSync(fixture.codexPrompt, 'utf8'), fixture.commandContent);
      assert.equal(readFileSync(fixture.codexFlatPrompt, 'utf8'), fixture.commandContent);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('auto-syncs stale Codex plugin files from managed sources', () => {
    const fixture = makeFixture();
    try {
      writeFileSync(fixture.codexPluginCacheCommand, 'stale command\n');
      writeFileSync(fixture.codexPluginCacheSkill, 'stale skill\n');
      writeFileSync(fixture.codexPluginSourceSkill, 'stale source skill\n');
      const result = assertAdaptersFresh(fixture.manifestPath);
      assert.ok(result.repaired.includes(fixture.codexPluginCacheCommand));
      assert.ok(result.repaired.includes(fixture.codexPluginCacheSkill));
      assert.ok(result.repaired.includes(fixture.codexPluginSourceSkill));
      assert.equal(readFileSync(fixture.codexPluginCacheCommand, 'utf8'), fixture.commandContent);
      assert.equal(readFileSync(fixture.codexPluginCacheSkill, 'utf8'), fixture.codexPluginSkillContent);
      assert.equal(readFileSync(fixture.codexPluginSourceSkill, 'utf8'), fixture.codexPluginSkillContent);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('auto-syncs stale Codex agent definitions from managed sources', () => {
    const fixture = makeFixture();
    try {
      writeFileSync(fixture.codexAgent, 'stale global agent\n');
      writeFileSync(fixture.codexPluginCacheAgent, 'stale plugin agent\n');
      writeFileSync(fixture.codexPluginSourceAgent, 'stale source plugin agent\n');
      const result = assertAdaptersFresh(fixture.manifestPath);
      assert.ok(result.repaired.includes(fixture.codexAgent));
      assert.ok(result.repaired.includes(fixture.codexPluginCacheAgent));
      assert.ok(result.repaired.includes(fixture.codexPluginSourceAgent));
      assert.equal(readFileSync(fixture.codexAgent, 'utf8'), fixture.codexAgentContent);
      assert.equal(readFileSync(fixture.codexPluginCacheAgent, 'utf8'), fixture.codexAgentContent);
      assert.equal(readFileSync(fixture.codexPluginSourceAgent, 'utf8'), fixture.codexAgentContent);
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
      writeFileSync(fixture.codexPluginCacheRuntime, '/tmp/stale-plugin-runtime\n');
      writeFileSync(fixture.geminiRuntime, '/var/folders/stale-runtime\n');
      const result = assertAdaptersFresh(fixture.manifestPath);
      assert.ok(result.repaired.includes(fixture.codexRuntime));
      assert.ok(result.repaired.includes(fixture.codexPluginCacheRuntime));
      assert.ok(result.repaired.includes(fixture.geminiRuntime));
      assert.equal(readFileSync(fixture.codexRuntime, 'utf8'), `${fixture.runtimeRoot}\n`);
      assert.equal(readFileSync(fixture.codexPluginCacheRuntime, 'utf8'), `${fixture.runtimeRoot}\n`);
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

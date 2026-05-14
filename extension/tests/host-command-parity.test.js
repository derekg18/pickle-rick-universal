import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BACKENDS,
} from '../types/index.js';
import {
  PICKLE_COMMAND_SPECS,
  REQUIRED_PICKLE_COMMANDS,
  PICKLE_CODEX_AGENT_NAMES,
  assertCommandRegistryParity,
  canonicalCommandNames,
  commandsForHost,
  expectedAdapterRelativePaths,
  renderGeminiToml,
  validateCommandRegistry,
} from '../services/host-command-registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const COMMANDS_DIR = path.join(REPO_ROOT, '.claude', 'commands');
const CODEX_AGENTS_DIR = path.join(REPO_ROOT, 'codex-plugin', 'agents');
const CODEX_SKILL_PATH = path.join(REPO_ROOT, 'codex-plugin', 'skills', 'pickle', 'SKILL.md');
const CODEX_PLUGIN_ROOT = 'plugins/cache/pickle-rick/pickle-rick/local';
const HOST_CASES = BACKENDS.map((host) => [host]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function expectedCommandPaths(host, command) {
  const pathsByHost = {
    claude: [`commands/${command}.md`],
    codex: [
      `prompts/pickle-rick/${command}.md`,
      `${CODEX_PLUGIN_ROOT}/commands/${command}.md`,
    ],
    gemini: [
      `extensions/pickle-rick/commands-md/${command}.md`,
      `extensions/pickle-rick/commands/${command}.toml`,
    ],
  };
  return pathsByHost[host];
}

function sourceArtifactForAdapterPath(relativePath) {
  if (relativePath === 'pickle-rick/persona.md' || relativePath === `${CODEX_PLUGIN_ROOT}/persona.md`) {
    return { type: 'file', path: path.join(REPO_ROOT, 'persona.md') };
  }
  if (relativePath === 'pickle-rick/runtime_root' || relativePath === `${CODEX_PLUGIN_ROOT}/runtime_root`) {
    return { type: 'generated' };
  }
  if (relativePath === 'prompts/pickle.md') {
    return { type: 'file', path: path.join(COMMANDS_DIR, 'pickle.md') };
  }
  if (relativePath === `${CODEX_PLUGIN_ROOT}/.codex-plugin/plugin.json`) {
    return { type: 'file', path: path.join(REPO_ROOT, 'codex-plugin', '.codex-plugin', 'plugin.json') };
  }
  if (relativePath === `${CODEX_PLUGIN_ROOT}/skills/pickle/SKILL.md`) {
    return { type: 'file', path: CODEX_SKILL_PATH };
  }
  if (relativePath.startsWith('agents/') && relativePath.endsWith('.toml')) {
    return { type: 'file', path: path.join(REPO_ROOT, '.codex', relativePath) };
  }
  if (relativePath.startsWith(`${CODEX_PLUGIN_ROOT}/agents/`) && relativePath.endsWith('.toml')) {
    return { type: 'file', path: path.join(REPO_ROOT, 'codex-plugin', 'agents', path.basename(relativePath)) };
  }
  if (relativePath.startsWith('commands/') && relativePath.endsWith('.md')) {
    return { type: 'file', path: path.join(REPO_ROOT, '.claude', relativePath) };
  }
  if (relativePath.startsWith('prompts/pickle-rick/') && relativePath.endsWith('.md')) {
    return { type: 'file', path: path.join(COMMANDS_DIR, path.basename(relativePath)) };
  }
  if (relativePath.startsWith(`${CODEX_PLUGIN_ROOT}/commands/`) && relativePath.endsWith('.md')) {
    return { type: 'file', path: path.join(COMMANDS_DIR, path.basename(relativePath)) };
  }
  if (relativePath.startsWith('extensions/pickle-rick/commands-md/') && relativePath.endsWith('.md')) {
    return { type: 'file', path: path.join(COMMANDS_DIR, path.basename(relativePath)) };
  }
  if (relativePath.startsWith('extensions/pickle-rick/commands/') && relativePath.endsWith('.toml')) {
    return { type: 'generated' };
  }
  if (relativePath === 'extensions/pickle-rick/persona.md') {
    return { type: 'file', path: path.join(REPO_ROOT, 'persona.md') };
  }
  if (relativePath === 'extensions/pickle-rick/runtime_root') {
    return { type: 'generated' };
  }
  return { type: 'unknown' };
}

describe('host command registry parity', () => {
  test('canonical registry exactly matches Claude command markdown files', () => {
    const commandFiles = readdirSync(COMMANDS_DIR)
      .filter((file) => file.endsWith('.md'))
      .map((file) => path.basename(file, '.md'))
      .sort();
    assert.deepEqual(canonicalCommandNames().sort(), commandFiles);
    assert.doesNotThrow(() => assertCommandRegistryParity(COMMANDS_DIR));
  });

  test('required Pickle command surfaces are supported by each host', () => {
    for (const host of BACKENDS) {
      const hostCommands = new Set(commandsForHost(host).map((spec) => spec.name));
      for (const command of REQUIRED_PICKLE_COMMANDS) {
        assert.equal(hostCommands.has(command), true, `${host} must support /${command}`);
      }
    }
  });

  test('all command specs are supported by every host', () => {
    for (const { name, hosts } of PICKLE_COMMAND_SPECS) {
      assert.deepEqual([...hosts].sort(), [...BACKENDS].sort(), `/${name} must support all hosts`);
    }
  });

  test('registry validation reports no missing, unregistered, duplicate, or missing required commands', () => {
    const result = validateCommandRegistry(COMMANDS_DIR);
    assert.deepEqual(result.missingFiles, []);
    assert.deepEqual(result.unregisteredFiles, []);
    assert.deepEqual(result.duplicateRegistryCommands, []);
    assert.deepEqual(result.missingRequiredCommands, []);
  });

  test('adapter relative paths include host-specific command surfaces', () => {
    for (const host of BACKENDS) {
      const paths = new Set(expectedAdapterRelativePaths(host));
      for (const { name } of commandsForHost(host)) {
        for (const expectedPath of expectedCommandPaths(host, name)) {
          assert.equal(paths.has(expectedPath), true, `${host} must include ${expectedPath}`);
        }
      }
    }
  });

  for (const [host] of HOST_CASES) {
    describe(`${host} adapter artifact parity`, () => {
      test('every expected adapter path has a source artifact or generated contract', () => {
        for (const expectedPath of expectedAdapterRelativePaths(host)) {
          const artifact = sourceArtifactForAdapterPath(expectedPath);
          assert.notEqual(artifact.type, 'unknown', `${host} adapter path is not mapped: ${expectedPath}`);
          if (artifact.type === 'file') {
            assert.equal(existsSync(artifact.path), true, `${host} source artifact missing for ${expectedPath}: ${artifact.path}`);
          }
        }
      });

      test('every command spec has expected host adapter paths', () => {
        const paths = new Set(expectedAdapterRelativePaths(host));
        for (const { name } of commandsForHost(host)) {
          for (const expectedPath of expectedCommandPaths(host, name)) {
            assert.equal(paths.has(expectedPath), true, `${host} must include ${expectedPath}`);
          }
        }
      });
    });
  }

  test('Codex adapter relative paths include plugin and flat prompt surfaces', () => {
    const paths = new Set(expectedAdapterRelativePaths('codex'));
    assert.equal(paths.has('prompts/pickle.md'), true);
    assert.equal(paths.has(`${CODEX_PLUGIN_ROOT}/.codex-plugin/plugin.json`), true);
    assert.equal(paths.has(`${CODEX_PLUGIN_ROOT}/skills/pickle/SKILL.md`), true);
    assert.equal(paths.has(`${CODEX_PLUGIN_ROOT}/runtime_root`), true);
    for (const agent of PICKLE_CODEX_AGENT_NAMES) {
      assert.equal(paths.has(`agents/${agent}.toml`), true, `Codex must include global agent ${agent}`);
      assert.equal(paths.has(`${CODEX_PLUGIN_ROOT}/agents/${agent}.toml`), true, `Codex plugin must include agent ${agent}`);
    }
  });

  test('Codex agent definitions do not require Claude team primitives for completion', () => {
    const agentFiles = readdirSync(CODEX_AGENTS_DIR).filter((file) => file.endsWith('.toml'));
    assert.equal(agentFiles.length, PICKLE_CODEX_AGENT_NAMES.length);
    for (const file of agentFiles) {
      const text = readFileSync(path.join(CODEX_AGENTS_DIR, file), 'utf-8');
      assert.doesNotMatch(text, /TaskUpdate|SendMessage/, `${file} should finish with a Codex final response`);
    }
  });

  test('Codex skill marks Codex as the caller backend default', () => {
    const text = readFileSync(CODEX_SKILL_PATH, 'utf-8');
    assert.match(text, /PICKLE_HOST_BACKEND=codex/);
  });

  test('Codex skill can trigger PRD drafting and refinement commands', () => {
    const text = readFileSync(CODEX_SKILL_PATH, 'utf-8');
    assert.match(text, /\/pickle-prd/);
    assert.match(text, /\/pickle-refine-prd/);
  });

  test('PRD commands preserve caller-host backend defaults for downstream resume', () => {
    const prd = readFileSync(path.join(COMMANDS_DIR, 'pickle-prd.md'), 'utf-8');
    const refine = readFileSync(path.join(COMMANDS_DIR, 'pickle-refine-prd.md'), 'utf-8');
    assert.match(prd, /PICKLE_HOST_BACKEND/);
    assert.match(refine, /PICKLE_HOST_BACKEND/);
    assert.match(refine, /Refinement workers still force claude/);
  });

  test('Gemini TOML renderer uses registry descriptions, markdown targets, and args placeholder', () => {
    for (const { name, description } of commandsForHost('gemini')) {
      const markdownPath = `/tmp/commands-md/${name}.md`;
      const rendered = renderGeminiToml(name, markdownPath);
      assert.match(rendered, new RegExp(`description = ${escapeRegExp(JSON.stringify(description))}`));
      assert.match(rendered, new RegExp(escapeRegExp(markdownPath)));
      assert.match(rendered, /PICKLE_HOST_BACKEND=gemini/);
      assert.match(rendered, /\{\{args\}\}/);
    }
  });

  test('Gemini TOML renderer falls back for unknown commands', () => {
    const rendered = renderGeminiToml('unknown-command', '../commands-md/unknown-command.md');
    assert.match(rendered, /description = "Pickle Rick \/unknown-command"/);
    assert.match(rendered, /\.\.\/commands-md\/unknown-command\.md/);
    assert.match(rendered, /\{\{args\}\}/);
  });
});

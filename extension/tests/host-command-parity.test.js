import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BACKENDS,
} from '../types/index.js';
import {
  REQUIRED_PICKLE_COMMANDS,
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function expectedCommandPaths(host, command) {
  const pathsByHost = {
    claude: [`commands/${command}.md`],
    codex: [`prompts/pickle-rick/${command}.md`],
    gemini: [
      `extensions/pickle-rick/commands-md/${command}.md`,
      `extensions/pickle-rick/commands/${command}.toml`,
    ],
  };
  return pathsByHost[host];
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

  test('Gemini TOML renderer uses registry descriptions, markdown targets, and args placeholder', () => {
    for (const { name, description } of commandsForHost('gemini')) {
      const markdownPath = `/tmp/commands-md/${name}.md`;
      const rendered = renderGeminiToml(name, markdownPath);
      assert.match(rendered, new RegExp(`description = ${escapeRegExp(JSON.stringify(description))}`));
      assert.match(rendered, new RegExp(escapeRegExp(markdownPath)));
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

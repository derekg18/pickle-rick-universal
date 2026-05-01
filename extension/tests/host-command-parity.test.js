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
    assert.ok(expectedAdapterRelativePaths('claude').includes('commands/pickle.md'));
    assert.ok(expectedAdapterRelativePaths('codex').includes('prompts/pickle-rick/pickle-tmux.md'));
    assert.ok(expectedAdapterRelativePaths('gemini').includes('extensions/pickle-rick/commands/pickle-pipeline.toml'));
  });

  test('Gemini TOML renderer uses registry description and args placeholder', () => {
    const rendered = renderGeminiToml('pickle', '/tmp/commands-md/pickle.md');
    assert.match(rendered, /description = "Start the interactive Pickle Rick autonomous coding loop\."/);
    assert.match(rendered, /\/tmp\/commands-md\/pickle\.md/);
    assert.match(rendered, /\{\{args\}\}/);
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMMANDS_DIR = path.resolve(__dirname, '../../.claude/commands');

function readCommand(filename) {
  return fs.readFileSync(path.join(COMMANDS_DIR, filename), 'utf8');
}

test('pickle-debate command exists and documents helper invocation', () => {
  const command = readCommand('pickle-debate.md');

  assert.match(command, /^# \/pickle-debate$/m);
  assert.match(command, /extension\/bin\/debate\.js/);
  assert.match(command, /debate_<date>_brief\.md/);
  assert.match(command, /This command owns orchestration/);
});

test('pickle-debate command documents team lifecycle and persona agent dispatch', () => {
  const command = readCommand('pickle-debate.md');

  assert.match(command, /TeamCreate\(name: "pickle-debate"\)/);
  assert.match(command, /Agent\(subagent_type: "morty-debater-researcher"/);
  assert.match(command, /Agent\(subagent_type: "morty-debater-architect"/);
  assert.match(command, /Agent\(subagent_type: "morty-debater-implementer"/);
  assert.match(command, /Agent\(subagent_type: "morty-debater-skeptic"/);
  assert.match(command, /TeamDelete\(name: "pickle-debate"\)/);
  assert.match(command, /800 words/);
  assert.match(command, /600-word shared context/);
});

test('pickle-debate command preserves no-synthesis output shape', () => {
  const command = readCommand('pickle-debate.md');

  assert.match(command, /Do not synthesize a winner/);
  assert.match(command, /One `## <Persona>` section per selected persona/);
  assert.match(command, /## Disagreements with prior speakers/);
});

test('help-pickle lists pickle-debate and its flags', () => {
  const help = readCommand('help-pickle.md');

  assert.match(help, /\/pickle-debate "<question>"/);
  for (const flag of ['--personas r,a,i,s', '--n <2-6>', '--solo', '--strict-teams', '--no-strict-teams', '--continue', '--confirm-multi-round', '--accept-stale']) {
    assert.match(help, new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PICKLE_COMMAND_SPECS,
  canonicalCommandNames,
} from '../services/host-command-registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const COMMANDS_DIR = path.join(REPO_ROOT, '.claude', 'commands');
const COMMAND_CASES = PICKLE_COMMAND_SPECS.map((spec) => [spec.name, spec]);
const PLACEHOLDER_SMELL = /\b(TODO|TBD|FIXME)\b|\[(?:project-specific|feature|MODIFIED_FILES|AFFECTED_SUBSYSTEMS)[^\]]*\]|\{\{[^}]+\}\}/i;
const SETUP_OR_EXECUTION_SMELL = /```(?:bash|sh)?|^# |## Step|\b(Run|Launch|Execute|Start|Submit|Display|Show|Queue|Convert|Refine|Iterative|Internal)\b/im;

function readCommandMarkdown(name) {
  return readFileSync(path.join(COMMANDS_DIR, `${name}.md`), 'utf8');
}

describe('command suite markdown contract', () => {
  test('registry command names are unique', () => {
    const names = canonicalCommandNames();
    assert.equal(new Set(names).size, names.length);
  });

  for (const [name] of COMMAND_CASES) {
    test(`/${name} has a non-placeholder first line`, () => {
      const filePath = path.join(COMMANDS_DIR, `${name}.md`);
      assert.equal(existsSync(filePath), true, `/${name} markdown must exist`);
      const firstLine = readCommandMarkdown(name).split(/\r?\n/, 1)[0].trim();
      assert.notEqual(firstLine, '', `/${name} first line must be nonempty`);
      assert.doesNotMatch(firstLine, PLACEHOLDER_SMELL, `/${name} first line must not contain placeholders`);
    });

    test(`/${name} has setup or execution instructions`, () => {
      assert.match(
        readCommandMarkdown(name),
        SETUP_OR_EXECUTION_SMELL,
        `/${name} must contain setup or execution instructions`,
      );
    });
  }
});

describe('command result contract probes', () => {
  for (const [name, spec] of COMMAND_CASES) {
    test(`/${name} declares and satisfies its result contract`, () => {
      assert.equal(typeof spec.resultContract, 'object', `/${name} must declare a result contract`);
      assert.notEqual(spec.resultContract, null, `/${name} result contract must be non-null`);

      if (spec.resultContract.type === 'not_implemented') {
        assert.equal(typeof spec.resultContract.reason, 'string', `/${name} not_implemented reason must be typed`);
        assert.notEqual(spec.resultContract.reason.trim(), '', `/${name} not_implemented reason must be nonempty`);
        return;
      }

      assert.equal(spec.resultContract.type, 'implemented', `/${name} result contract type must be known`);
      assert.equal(spec.resultContract.probe, 'markdown', `/${name} implemented result contract must be markdown-probed`);
      assert.equal(
        Array.isArray(spec.resultContract.outputEvidence),
        true,
        `/${name} outputEvidence must be an array`,
      );
      assert.ok(spec.resultContract.outputEvidence.length > 0, `/${name} outputEvidence must not be empty`);

      const markdown = readCommandMarkdown(name);
      const evidencePattern = new RegExp(
        `\\b(${spec.resultContract.outputEvidence.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
        'i',
      );
      assert.match(markdown, evidencePattern, `/${name} markdown must include result/output evidence`);
    });
  }
});

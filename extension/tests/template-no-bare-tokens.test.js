import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PROMISE_TOKENS, FORBIDDEN_WORKER_TOKENS } from '../services/promise-tokens.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMMANDS_DIR = path.resolve(__dirname, '..', '..', '.claude', 'commands');

const TEMPLATES = [
  'pickle.md',
  'meeseeks.md',
  'szechuan-sauce.md',
  'microverse.md',
  'pickle-tmux.md',
];

// Per-ticket worker templates. The worker's only valid completion signal is
// `<promise>I AM DONE</promise>` — every other promise token is orchestrator-
// scoped. A worker that emits `EPIC_COMPLETED` (as codex did on the god-fn
// epic, killing a 74-minute pipeline run) trips mux-runner's pending-tickets
// fail-loud guard and aborts the whole pipeline.
const WORKER_TEMPLATES = [
  'send-to-morty.md',
  'send-to-morty-review.md',
];

function stripHtmlComments(content) {
  return content.replace(/<!--[\s\S]*?-->/g, '');
}

for (const filename of TEMPLATES) {
  test(`template-no-bare-tokens: ${filename}`, () => {
    const filePath = path.join(COMMANDS_DIR, filename);
    if (!existsSync(filePath)) {
      return;
    }
    const stripped = stripHtmlComments(readFileSync(filePath, 'utf8'));
    for (const token of PROMISE_TOKENS) {
      const literal = `<promise>${token}</promise>`;
      assert.ok(
        !stripped.includes(literal),
        `${filename}: bare promise token found — replace with substring-broken form: ${literal}`,
      );
    }
  });
}

for (const filename of WORKER_TEMPLATES) {
  test(`worker-template-no-orchestrator-tokens: ${filename}`, () => {
    const filePath = path.join(COMMANDS_DIR, filename);
    if (!existsSync(filePath)) {
      return;
    }
    const stripped = stripHtmlComments(readFileSync(filePath, 'utf8'));
    // Worker prompts MUST NOT contain a usable <promise>TOKEN</promise> form
    // for any orchestrator-only token. `I AM DONE` is the worker's legitimate
    // completion signal and is intentionally present, hence checking only the
    // forbidden subset.
    for (const token of FORBIDDEN_WORKER_TOKENS) {
      const literal = `<promise>${token}</promise>`;
      assert.ok(
        !stripped.includes(literal),
        `${filename}: contains usable orchestrator token ${literal}. ` +
        `A per-ticket worker has NO authority to emit this — it must emit only ` +
        `<promise>I AM DONE</promise>. Codex bleeding context across nearby ` +
        `instructions caused a 74-minute pipeline kill on the god-fn epic.`,
      );
    }
  });
}

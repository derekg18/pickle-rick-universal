import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const setupBin = path.resolve(__dirname, '../bin/setup.js');

function makeTempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeCodexShim(dir, body) {
  const shimPath = path.join(dir, 'codex');
  fs.writeFileSync(shimPath, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(shimPath, 0o755);
  return shimPath;
}

function setupEnv(dataRoot, shimDir) {
  return {
    ...process.env,
    EXTENSION_DIR: repoRoot,
    FORCE_COLOR: '0',
    PICKLE_DATA_ROOT: dataRoot,
    PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ''}`,
  };
}

function runSetup(args, env) {
  return execFileSync(process.execPath, [setupBin, ...args], {
    cwd: repoRoot,
    encoding: 'utf-8',
    env,
  });
}

function parseSessionRoot(output) {
  const match = output.match(/SESSION_ROOT=(.+)/);
  assert.ok(match, `SESSION_ROOT not found in output:\n${output}`);
  return match[1].trim();
}

function readState(sessionRoot) {
  return JSON.parse(fs.readFileSync(path.join(sessionRoot, 'state.json'), 'utf-8'));
}

test('codex backend records compatible codex --version output', () => {
  const dataRoot = makeTempRoot('pickle-codex-smoke-data-');
  const shimDir = makeTempRoot('pickle-codex-smoke-bin-');
  makeCodexShim(shimDir, 'echo "codex 0.42.1"');

  try {
    const output = runSetup(['--backend', 'codex', '--task', 'codex smoke pass'], setupEnv(dataRoot, shimDir));
    const state = readState(parseSessionRoot(output));

    assert.equal(state.backend, 'codex');
    assert.equal(state.codex_version_seen, 'codex 0.42.1');
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(shimDir, { recursive: true, force: true });
  }
});

test('codex backend rejects incompatible codex --version output', () => {
  const dataRoot = makeTempRoot('pickle-codex-smoke-data-');
  const shimDir = makeTempRoot('pickle-codex-smoke-bin-');
  makeCodexShim(shimDir, 'echo "codex 0.41.9"');

  try {
    const result = spawnSync(process.execPath, [setupBin, '--backend', 'codex', '--task', 'codex smoke mismatch'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      env: setupEnv(dataRoot, shimDir),
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /codex version mismatch/);
    assert.doesNotMatch(result.stdout, /SESSION_ROOT=/);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(shimDir, { recursive: true, force: true });
  }
});

test('default backend skips codex version smoke check', () => {
  const dataRoot = makeTempRoot('pickle-codex-smoke-data-');
  const shimDir = makeTempRoot('pickle-codex-smoke-bin-');
  makeCodexShim(shimDir, 'echo "codex shim should not run" >&2\nexit 70');

  try {
    const output = runSetup(['--task', 'default backend skip'], setupEnv(dataRoot, shimDir));
    const state = readState(parseSessionRoot(output));

    assert.equal(state.backend, undefined);
    assert.equal(state.codex_version_seen, null);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(shimDir, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const CLI_PATH = path.resolve(import.meta.dirname, '../bin/council-publish.js');
const SPAWN_TIMEOUT_MS = 15000;

/**
 * Writes a bash/node script that mocks the `gh` CLI. Duplicated from
 * council-publish.test.js intentionally — separate test file, no shared
 * helper module, zero coupling.
 */
function makeGhMock(scenario) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-gh-cli-')));
    const scenarioPath = path.join(dir, 'scenario.json');
    const callLog = path.join(dir, 'calls.log');
    const stateFile = path.join(dir, 'state.json');
    fs.writeFileSync(scenarioPath, JSON.stringify(scenario));
    fs.writeFileSync(stateFile, JSON.stringify({ prCommentCalls: 0 }));
    const ghPath = path.join(dir, 'gh');
    const script = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callLog)}, JSON.stringify(args) + '\\n');
const scenario = JSON.parse(fs.readFileSync(${JSON.stringify(scenarioPath)}, 'utf-8'));
const state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf-8'));

function writeState() { fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(state)); }

if (args[0] === 'auth' && args[1] === 'status') {
  process.exit(scenario.auth === 'fail' ? 1 : 0);
}
if (args[0] === 'pr' && args[1] === 'list') {
  const headIdx = args.indexOf('--head');
  const branch = headIdx >= 0 ? args[headIdx + 1] : '';
  const mapping = scenario.prList || {};
  if (mapping[branch] === undefined) { process.stdout.write(''); process.exit(0); }
  if (mapping[branch] === '__error__') { process.stderr.write('simulated list error'); process.exit(1); }
  process.stdout.write(String(mapping[branch]) + '\\n');
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'comment') {
  state.prCommentCalls = (state.prCommentCalls || 0) + 1;
  writeState();
  const rule = scenario.prComment || {};
  if (rule.failOnCall && rule.failOnCall.includes(state.prCommentCalls)) {
    process.stderr.write('simulated comment error');
    process.exit(1);
  }
  process.exit(0);
}
process.stderr.write('unexpected gh call: ' + args.join(' ') + '\\n');
process.exit(2);
`;
    fs.writeFileSync(ghPath, script);
    fs.chmodSync(ghPath, 0o755);
    return { ghPath, dir };
}

function cleanupGhMock(mock) {
    fs.rmSync(mock.dir, { recursive: true, force: true });
}

// --- 1. No args → exit 1, Usage printed to stderr ---

test('council-publish CLI: no args → exit 1 with Usage message', () => {
    const res = spawnSync(process.execPath, [CLI_PATH], {
        encoding: 'utf-8',
        timeout: SPAWN_TIMEOUT_MS,
    });
    assert.equal(res.status, 1, `expected exit 1, got ${res.status}; stderr=${res.stderr}`);
    assert.match(res.stderr, /Usage: council-publish/);
});

// --- 2. Missing session_root → exit 1, error message to stderr ---

test('council-publish CLI: missing session_root → exit 1 with does-not-exist error', () => {
    const missing = path.join(os.tmpdir(), 'definitely-not-a-session-cli-' + Date.now());
    const res = spawnSync(process.execPath, [CLI_PATH, missing], {
        encoding: 'utf-8',
        timeout: SPAWN_TIMEOUT_MS,
    });
    assert.equal(res.status, 1, `expected exit 1, got ${res.status}; stderr=${res.stderr}`);
    assert.match(res.stderr, /council-publish:.*does not exist/);
});

// --- 3. Happy path with --dry-run → exit 0, JSON report on stdout ---

test('council-publish CLI: --dry-run happy path → exit 0, prints JSON report', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-cp-cli-')));
    const mock = makeGhMock({
        auth: 'ok',
        prList: { 'feat/cli-test': 42 },
        prComment: {},
    });
    try {
        fs.writeFileSync(
            path.join(tmpDir, 'council-stack.json'),
            JSON.stringify({
                branches: ['feat/cli-test', 'main'],
                trunk: 'main',
                repo_path: tmpDir,
                codex_enabled: false,
            }, null, 2),
        );
        fs.writeFileSync(
            path.join(tmpDir, 'council-directive.json'),
            JSON.stringify({
                schema_version: 1,
                round: 1,
                codex_enabled: false,
                branches: [{ name: 'feat/cli-test', findings: [] }],
                trap_doors: [],
            }, null, 2),
        );

        // Inject mock's dir at front of PATH so `gh` resolves to the mock.
        const mockDir = path.dirname(mock.ghPath);
        const env = {
            ...process.env,
            PATH: `${mockDir}${path.delimiter}${process.env.PATH || ''}`,
        };

        const res = spawnSync(process.execPath, [CLI_PATH, tmpDir, '--dry-run'], {
            encoding: 'utf-8',
            timeout: SPAWN_TIMEOUT_MS,
            env,
        });

        assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr=${res.stderr}`);
        let report;
        try {
            report = JSON.parse(res.stdout);
        } catch (err) {
            assert.fail(`stdout not valid JSON: ${err.message}\nstdout=${res.stdout}`);
        }
        assert.equal(report.session_root, tmpDir);
        assert.equal(report.results.length, 1, 'trunk excluded — only feat/cli-test');
        const r = report.results[0];
        assert.equal(r.outcome, 'posted');
        assert.equal(r.pr_number, 42);
    } finally {
        cleanupGhMock(mock);
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// --- 4. Unknown flag → exit 2 (no silent ignore of typo'd --dry-run) ---

test('council-publish CLI: unknown flag → exit 2 with clear message', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-cp-cli-unknown-')));
    try {
        fs.writeFileSync(
            path.join(tmpDir, 'council-stack.json'),
            JSON.stringify({
                branches: ['feat/cli-test', 'main'],
                trunk: 'main',
                repo_path: tmpDir,
                codex_enabled: false,
            }, null, 2),
        );
        const res = spawnSync(process.execPath, [CLI_PATH, tmpDir, '--dryrun'], {
            encoding: 'utf-8',
            timeout: SPAWN_TIMEOUT_MS,
        });
        assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stderr=${res.stderr}`);
        assert.match(res.stderr, /unknown argument: --dryrun/);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

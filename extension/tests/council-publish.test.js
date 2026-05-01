import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import publishCouncilStack, { CouncilPublishError, composeBody } from '../bin/council-publish.js';

function minimalFinding(overrides = {}) {
    return {
        severity: 'P0',
        confidence: 90,
        source: 'COUNCIL',
        file: 'src/foo.ts',
        line: 42,
        line_range: null,
        rule: 'no-bare-throw',
        description: 'bare throw detected',
        recommendation: 'wrap in Error',
        data_flow: null,
        scenario: null,
        snippet_before: null,
        snippet_after: null,
        ...overrides,
    };
}

function minimalDirective(branchNames = ['feat/one', 'feat/two'], overrides = {}) {
    return {
        schema_version: 1,
        round: 1,
        codex_enabled: false,
        branches: branchNames.map(name => ({ name, findings: [] })),
        trap_doors: [],
        ...overrides,
    };
}

/**
 * withSession(fn) — mirrors withExtensionDir from get-session.test.js.
 * Creates a tmp session dir with a minimal council-stack.json (2 branches +
 * trunk, repo_path pointing at the tmp dir itself), invokes fn(sessionDir),
 * then cleans up.
 */
async function withSession(fn, { stack, summary, directiveJson, skipStack } = {}) {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-cp-')));
    try {
        if (!skipStack) {
            const defaultStack = {
                branches: ['feat/one', 'feat/two', 'main'],
                trunk: 'main',
                repo_path: tmpDir,
                codex_enabled: true,
            };
            fs.writeFileSync(
                path.join(tmpDir, 'council-stack.json'),
                JSON.stringify(stack || defaultStack, null, 2),
            );
        }
        if (summary !== undefined) {
            fs.writeFileSync(path.join(tmpDir, 'council-of-ricks-summary.md'), summary);
        }
        if (directiveJson !== undefined) {
            fs.writeFileSync(
                path.join(tmpDir, 'council-directive.json'),
                JSON.stringify(directiveJson, null, 2),
            );
        }
        return await fn(tmpDir);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

/**
 * Writes a bash script that mocks the `gh` CLI. Behavior is driven by a JSON
 * control file — each invocation appends its argv to a log and returns stdout
 * / exit code based on a per-subcommand scenario.
 */
function makeGhMock(scenario) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-gh-')));
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

// __hang__ sentinel: keep the event loop alive long enough that execFileSync's
// timeout fires first. The parent sends SIGTERM; Node's default handler exits.
function hang() { setTimeout(() => process.exit(0), 60_000); }
if (args[0] === 'auth' && args[1] === 'status') {
  if (scenario.auth === 'hang') return hang();
  process.exit(scenario.auth === 'fail' ? 1 : 0);
}
if (args[0] === 'pr' && args[1] === 'list') {
  const headIdx = args.indexOf('--head');
  const branch = headIdx >= 0 ? args[headIdx + 1] : '';
  const mapping = scenario.prList || {};
  if (mapping[branch] === undefined) { process.stdout.write(''); process.exit(0); }
  if (mapping[branch] === '__error__') { process.stderr.write('simulated list error'); process.exit(1); }
  if (mapping[branch] === '__hang__') return hang();
  process.stdout.write(String(mapping[branch]) + '\\n');
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'comment') {
  state.prCommentCalls = (state.prCommentCalls || 0) + 1;
  writeState();
  const rule = scenario.prComment || {};
  if (rule.hangOnCall && rule.hangOnCall.includes(state.prCommentCalls)) return hang();
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
    return { ghPath, dir, callLog, stateFile };
}

function cleanupGhMock(mock) {
    fs.rmSync(mock.dir, { recursive: true, force: true });
}

// --- 1. Missing session_root throws ---

test('publishCouncilStack: throws CouncilPublishError for missing session_root', () => {
    const missing = path.join(os.tmpdir(), 'definitely-not-a-session-xyz-' + Date.now());
    assert.throws(
        () => publishCouncilStack(missing),
        (err) => err instanceof CouncilPublishError && /does not exist/.test(err.message),
    );
});

// --- 2. Missing council-stack.json throws ---

test('publishCouncilStack: throws when council-stack.json missing', async () => {
    await withSession((sessionDir) => {
        assert.throws(
            () => publishCouncilStack(sessionDir),
            (err) => err instanceof CouncilPublishError && /council-stack\.json/.test(err.message),
        );
    }, { skipStack: true });
});

// --- 3. gh unavailable → all branches skipped_no_gh ---

test('publishCouncilStack: gh auth fails → all branches skipped_no_gh, bodies still written', async () => {
    const mock = makeGhMock({ auth: 'fail' });
    try {
        await withSession(async (sessionDir) => {
            const report = await publishCouncilStack(sessionDir, { ghCommand: mock.ghPath });
            assert.equal(report.posted, 0);
            assert.equal(report.results.length, 2); // trunk excluded
            for (const r of report.results) {
                assert.equal(r.outcome, 'skipped_no_gh');
                assert.ok(r.body_path && fs.existsSync(r.body_path), 'body file written');
            }
            assert.equal(report.skipped, 2);
        }, { directiveJson: minimalDirective() });
    } finally {
        cleanupGhMock(mock);
    }
});

// --- 4. Happy path ---

test('publishCouncilStack: happy path posts each branch exactly once', async () => {
    const mock = makeGhMock({
        auth: 'ok',
        prList: { 'feat/one': 42, 'feat/two': 99 },
        prComment: {},
    });
    try {
        await withSession(async (sessionDir) => {
            const report = await publishCouncilStack(sessionDir, { ghCommand: mock.ghPath });
            assert.equal(report.posted, 2);
            assert.equal(report.failed, 0);
            assert.equal(report.skipped, 0);
            const pubDir = path.join(sessionDir, '.published');
            assert.ok(fs.existsSync(path.join(pubDir, 'feat__one')));
            assert.ok(fs.existsSync(path.join(pubDir, 'feat__two')));
            const log = fs.readFileSync(path.join(sessionDir, 'publish.log'), 'utf-8').trim().split('\n');
            assert.equal(log.length, 2);
            for (const line of log) {
                const entry = JSON.parse(line);
                assert.equal(entry.outcome, 'posted');
                assert.ok(entry.ts);
            }
        }, {
            summary: '## Round 1: ISSUES\n| Branch |\n| --- |\n| feat/one |\n\n## Round 2: CLEAN\n',
            directiveJson: minimalDirective(),
        });
    } finally {
        cleanupGhMock(mock);
    }
});

// --- 5. Idempotency ---

test('publishCouncilStack: second run skips already-published branches', async () => {
    const mock = makeGhMock({
        auth: 'ok',
        prList: { 'feat/one': 42, 'feat/two': 99 },
        prComment: {},
    });
    try {
        await withSession(async (sessionDir) => {
            await publishCouncilStack(sessionDir, { ghCommand: mock.ghPath });
            const second = await publishCouncilStack(sessionDir, { ghCommand: mock.ghPath });
            assert.equal(second.posted, 0);
            assert.equal(second.skipped, 2);
            for (const r of second.results) {
                assert.equal(r.outcome, 'skipped_already_published');
                assert.ok(r.body_path && fs.existsSync(r.body_path));
            }
        }, { directiveJson: minimalDirective() });
    } finally {
        cleanupGhMock(mock);
    }
});

// --- 6. No PR for a branch ---

test('publishCouncilStack: empty pr list → skipped_no_pr, no marker touched', async () => {
    const mock = makeGhMock({
        auth: 'ok',
        prList: {}, // every branch returns empty string
        prComment: {},
    });
    try {
        await withSession(async (sessionDir) => {
            const report = await publishCouncilStack(sessionDir, { ghCommand: mock.ghPath });
            assert.equal(report.posted, 0);
            assert.equal(report.skipped, 2);
            for (const r of report.results) {
                assert.equal(r.outcome, 'skipped_no_pr');
                assert.ok(r.body_path && fs.existsSync(r.body_path));
            }
            const pubDir = path.join(sessionDir, '.published');
            const markers = fs.existsSync(pubDir) ? fs.readdirSync(pubDir) : [];
            assert.equal(markers.length, 0, 'no markers should be created');
        }, { directiveJson: minimalDirective() });
    } finally {
        cleanupGhMock(mock);
    }
});

// --- 7. Prefer OPEN PR over MERGED when multiple share a head branch ---

test('publishCouncilStack: picks OPEN PR over MERGED when both exist for same head', async () => {
    const mock = makeGhMock({
        auth: 'ok',
        prList: {
            // JSON array response — MERGED first, OPEN second. Publisher must
            // prefer OPEN regardless of ordering. Also covers a closed PR
            // re-run scenario where the merged one would be silently skipped
            // under the old --state=open default.
            'feat/one': JSON.stringify([
                { number: 101, state: 'MERGED', updatedAt: '2026-04-23T10:00:00Z' },
                { number: 202, state: 'OPEN', updatedAt: '2026-04-20T10:00:00Z' },
            ]),
            'feat/two': JSON.stringify([
                { number: 303, state: 'MERGED', updatedAt: '2026-04-23T10:00:00Z' },
            ]),
        },
        prComment: {},
    });
    try {
        await withSession(async (sessionDir) => {
            const report = await publishCouncilStack(sessionDir, { ghCommand: mock.ghPath });
            assert.equal(report.posted, 2);
            const one = report.results.find(r => r.branch === 'feat/one');
            const two = report.results.find(r => r.branch === 'feat/two');
            assert.equal(one.pr_number, 202, 'OPEN beats MERGED on same head');
            assert.equal(two.pr_number, 303, 'MERGED-only still posts (no --state=open filter)');
        }, { directiveJson: minimalDirective() });
    } finally {
        cleanupGhMock(mock);
    }
});

// --- 8. One branch fails, others succeed ---

test('publishCouncilStack: one pr comment failure does not abort sweep', async () => {
    const mock = makeGhMock({
        auth: 'ok',
        prList: { 'feat/one': 42, 'feat/two': 99 },
        prComment: { failOnCall: [2] }, // second pr comment invocation throws
    });
    try {
        await withSession(async (sessionDir) => {
            const report = await publishCouncilStack(sessionDir, { ghCommand: mock.ghPath });
            assert.equal(report.posted, 1);
            assert.equal(report.failed, 1);
            const posted = report.results.find(r => r.outcome === 'posted');
            const failed = report.results.find(r => r.outcome === 'failed');
            assert.ok(posted && posted.pr_number);
            assert.ok(failed && /pr comment/.test(failed.error || ''));
            assert.ok(posted.body_path && fs.existsSync(posted.body_path));
            assert.ok(failed.body_path && fs.existsSync(failed.body_path));
            // Only the posted branch gets a marker
            const pubDir = path.join(sessionDir, '.published');
            const markers = fs.readdirSync(pubDir);
            assert.equal(markers.length, 1);
        }, { directiveJson: minimalDirective() });
    } finally {
        cleanupGhMock(mock);
    }
});

// --- 9. Hardening: trunk must be in branches list ---

test('publishCouncilStack: throws when trunk is not in branches list', async () => {
    await withSession((sessionDir) => {
        assert.throws(
            () => publishCouncilStack(sessionDir),
            (err) => err instanceof CouncilPublishError && /trunk.*not in branches/.test(err.message),
        );
    }, {
        stack: {
            branches: ['feat/a', 'feat/b'], // no `main`
            trunk: 'main',
            repo_path: os.tmpdir(),
            codex_enabled: false,
        },
    });
});

// --- 10. Hardening: zero-byte marker file is rejected as "not published" ---

test('publishCouncilStack: zero-byte .published marker is NOT treated as published', async () => {
    const mock = makeGhMock({
        auth: 'ok',
        prList: { 'feat/one': 42, 'feat/two': 99 },
        prComment: {},
    });
    try {
        await withSession(async (sessionDir) => {
            // Pre-create a zero-byte marker for feat/one.
            const pubDir = path.join(sessionDir, '.published');
            fs.mkdirSync(pubDir, { recursive: true });
            const fd = fs.openSync(path.join(pubDir, 'feat__one'), 'w');
            fs.closeSync(fd); // zero bytes
            assert.equal(fs.statSync(path.join(pubDir, 'feat__one')).size, 0);

            const report = await publishCouncilStack(sessionDir, { ghCommand: mock.ghPath });
            const one = report.results.find(r => r.branch === 'feat/one');
            assert.equal(one.outcome, 'posted', 'zero-byte marker must not skip');
            // After posting, marker should be a real timestamp (non-zero size).
            assert.ok(fs.statSync(path.join(pubDir, 'feat__one')).size > 0);
        }, { directiveJson: minimalDirective() });
    } finally {
        cleanupGhMock(mock);
    }
});

// --- 11. Hardening: parsePrList strips non-JSON warning prefix lines ---

test('publishCouncilStack: warning line before JSON array is tolerated', async () => {
    const mock = makeGhMock({
        auth: 'ok',
        prList: {
            'feat/one': 'warning: something happened\n[{"number":42,"state":"OPEN","updatedAt":"2026-04-23T00:00:00Z"}]',
            'feat/two': 99,
        },
        prComment: {},
    });
    try {
        await withSession(async (sessionDir) => {
            const report = await publishCouncilStack(sessionDir, { ghCommand: mock.ghPath });
            const one = report.results.find(r => r.branch === 'feat/one');
            assert.equal(one.outcome, 'posted');
            assert.equal(one.pr_number, 42, 'prefix-stripped JSON parsed correctly');
        }, { directiveJson: minimalDirective() });
    } finally {
        cleanupGhMock(mock);
    }
});

// --- 12. Hardening: extractRoundOutcomes ignores `## Round N:` inside code fences ---

test('publishCouncilStack: Round headers inside fenced code blocks are not counted', async () => {
    const mock = makeGhMock({
        auth: 'ok',
        prList: { 'feat/one': 42, 'feat/two': 99 },
        prComment: {},
    });
    const summary = [
        '## Round 1: — clean round.',
        '',
        '```md',
        '## Round 99: — clean round.  <!-- example inside a fence; must be ignored -->',
        '```',
        '',
        '## Round 2: — clean round.',
        '',
    ].join('\n');
    try {
        await withSession(async (sessionDir) => {
            await publishCouncilStack(sessionDir, { ghCommand: mock.ghPath });
            const body = fs.readFileSync(
                path.join(sessionDir, 'council-comments', 'feat__one.md'), 'utf-8',
            );
            assert.ok(/- Round 1:/.test(body));
            assert.ok(/- Round 2:/.test(body));
            assert.ok(!/Round 99/.test(body), 'fenced Round 99 must not leak into outcomes');
            // Final round = 2, not 3.
            assert.ok(/\*\*Final round:\*\* 2/.test(body));
        }, { summary, directiveJson: minimalDirective() });
    } finally {
        cleanupGhMock(mock);
    }
});

// --- 13. Hardening: unparseable gh pr list output → `failed`, not `skipped_no_pr` ---

test('publishCouncilStack: garbage gh pr list output classifies as failed, not skipped_no_pr', async () => {
    const mock = makeGhMock({
        auth: 'ok',
        prList: {
            'feat/one': 'HTTP/2 401\nauthentication required — token expired',
            'feat/two': 99,
        },
        prComment: {},
    });
    try {
        await withSession(async (sessionDir) => {
            const report = await publishCouncilStack(sessionDir, { ghCommand: mock.ghPath });
            const one = report.results.find(r => r.branch === 'feat/one');
            assert.equal(one.outcome, 'failed', 'garbage stdout must not become skipped_no_pr');
            assert.ok(/pr list parse/.test(one.error), 'error mentions pr list parse');
            // feat/two unaffected — single-branch garbage does not kill the sweep.
            const two = report.results.find(r => r.branch === 'feat/two');
            assert.equal(two.outcome, 'posted');
        }, { directiveJson: minimalDirective() });
    } finally {
        cleanupGhMock(mock);
    }
});

// --- 14. Hardening: invalid repo_path throws a clear CouncilPublishError ---

test('publishCouncilStack: throws when repo_path does not exist', async () => {
    await withSession((sessionDir) => {
        assert.throws(
            () => publishCouncilStack(sessionDir),
            (err) => err instanceof CouncilPublishError && /repo_path does not exist/.test(err.message),
        );
    }, {
        stack: {
            branches: ['feat/one', 'main'],
            trunk: 'main',
            repo_path: path.join(os.tmpdir(), 'definitely-not-a-real-repo-xyz-' + Date.now()),
            codex_enabled: false,
        },
    });
});

// --- 15. Hardening: trunk-only stack surfaces a warning instead of silent zero ---

test('publishCouncilStack: trunk-only stack warns that there is nothing to publish', async () => {
    await withSession(async (sessionDir) => {
        const report = await publishCouncilStack(sessionDir, { dryRun: true });
        assert.equal(report.posted, 0);
        assert.equal(report.results.length, 0);
        assert.ok(Array.isArray(report.warnings));
        assert.ok(
            report.warnings.some(w => /no non-trunk branches/.test(w)),
            'warns operator that there is nothing to publish',
        );
    }, {
        stack: { branches: ['main'], trunk: 'main', repo_path: os.tmpdir(), codex_enabled: false },
        directiveJson: minimalDirective(['main']),
    });
});

// --- 16. Hardening: real Step 17 terminal suffixes produce Round bullets ---

test('publishCouncilStack: extractRoundOutcomes handles real terminal-suffix formats', async () => {
    const mock = makeGhMock({
        auth: 'ok',
        prList: { 'feat/one': 42, 'feat/two': 99 },
        prComment: {},
    });
    const summary = [
        '## Round 1: — clean round.',
        '',
        '## Round 2: — partial round (skipped: B2 CLAUDE.md Compliance, C_correctness:feat/bar).',
        '',
        '## Round 3: — 4 issues (1/2/1/0/0)',
        '',
    ].join('\n');
    try {
        await withSession(async (sessionDir) => {
            await publishCouncilStack(sessionDir, { ghCommand: mock.ghPath });
            const body = fs.readFileSync(
                path.join(sessionDir, 'council-comments', 'feat__one.md'),
                'utf-8',
            );
            // Three round bullets rendered, in order, from the three real suffixes.
            const r1 = body.indexOf('- Round 1:');
            const r2 = body.indexOf('- Round 2:');
            const r3 = body.indexOf('- Round 3:');
            assert.ok(r1 >= 0 && r2 > r1 && r3 > r2, 'three round bullets in order');
            assert.ok(/clean round/.test(body));
            assert.ok(/partial round \(skipped/.test(body));
            assert.ok(/4 issues \(1\/2\/1\/0\/0\)/.test(body));
        }, { summary, directiveJson: minimalDirective() });
    } finally {
        cleanupGhMock(mock);
    }
});

// === NEW TESTS: JSON directive contract ===

// --- 17. Missing council-directive.json throws ---

test('publishCouncilStack: throws CouncilPublishError when council-directive.json is missing', async () => {
    const mock = makeGhMock({ auth: 'ok', prList: {}, prComment: {} });
    try {
        await withSession(async (sessionDir) => {
            // No directiveJson provided — file absent
            assert.throws(
                () => publishCouncilStack(sessionDir, { ghCommand: mock.ghPath }),
                (err) => err instanceof CouncilPublishError && /council-directive\.json missing/.test(err.message),
            );
        });
    } finally {
        cleanupGhMock(mock);
    }
});

// --- 18. Invalid JSON in council-directive.json throws ---

test('publishCouncilStack: throws when council-directive.json contains invalid JSON', async () => {
    const mock = makeGhMock({ auth: 'ok', prList: {}, prComment: {} });
    try {
        await withSession(async (sessionDir) => {
            fs.writeFileSync(path.join(sessionDir, 'council-directive.json'), '{ not valid json }');
            assert.throws(
                () => publishCouncilStack(sessionDir, { ghCommand: mock.ghPath }),
                (err) => err instanceof CouncilPublishError && /invalid JSON/.test(err.message),
            );
        });
    } finally {
        cleanupGhMock(mock);
    }
});

test('publishCouncilStack: promotes newer dead-writer council-directive tmp before publishing', async () => {
    const mock = makeGhMock({
        auth: 'ok',
        prList: { 'feat/one': 42, 'feat/two': 99 },
        prComment: {},
    });
    try {
        await withSession(async (sessionDir) => {
            const directivePath = path.join(sessionDir, 'council-directive.json');
            const tmpDirectivePath = `${directivePath}.tmp.99999999`;
            fs.writeFileSync(directivePath, JSON.stringify(minimalDirective(['feat/one'])));
            fs.writeFileSync(tmpDirectivePath, JSON.stringify(minimalDirective()));
            const newer = new Date(Date.now() + 1000);
            fs.utimesSync(tmpDirectivePath, newer, newer);

            const report = await publishCouncilStack(sessionDir, { ghCommand: mock.ghPath });

            assert.equal(report.failed, 0, 'recovered directive has entries for every stack branch');
            assert.equal(report.posted, 2);
            assert.equal(fs.existsSync(tmpDirectivePath), false, 'dead directive tmp should be consumed');
            assert.ok(fs.existsSync(path.join(sessionDir, '.published', 'feat__two')));
        });
    } finally {
        cleanupGhMock(mock);
    }
});

test('publishCouncilStack: promotes newer dead-writer council-stack tmp before branch loop', async () => {
    const mock = makeGhMock({
        auth: 'ok',
        prList: { 'feat/one': 42, 'feat/two': 99 },
        prComment: {},
    });
    try {
        await withSession(async (sessionDir) => {
            const stackPath = path.join(sessionDir, 'council-stack.json');
            const tmpStackPath = `${stackPath}.tmp.99999999`;
            fs.writeFileSync(stackPath, JSON.stringify({
                branches: ['feat/one', 'main'],
                trunk: 'main',
                repo_path: sessionDir,
                codex_enabled: true,
            }));
            fs.writeFileSync(tmpStackPath, JSON.stringify({
                branches: ['feat/one', 'feat/two', 'main'],
                trunk: 'main',
                repo_path: sessionDir,
                codex_enabled: true,
            }));
            fs.writeFileSync(path.join(sessionDir, 'council-directive.json'), JSON.stringify(minimalDirective()));
            const newer = new Date(Date.now() + 1000);
            fs.utimesSync(tmpStackPath, newer, newer);

            const report = await publishCouncilStack(sessionDir, { ghCommand: mock.ghPath });

            assert.equal(report.failed, 0);
            assert.deepEqual(report.results.map(r => r.branch).sort(), ['feat/one', 'feat/two']);
            assert.equal(report.posted, 2);
            assert.equal(fs.existsSync(tmpStackPath), false, 'dead stack tmp should be consumed');
        });
    } finally {
        cleanupGhMock(mock);
    }
});

test('publishCouncilStack: recovers council stack and directive when only dead-writer tmps exist', async () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-cp-missing-base-')));
    const mock = makeGhMock({
        auth: 'ok',
        prList: { 'feat/one': 42 },
        prComment: {},
    });
    try {
        fs.writeFileSync(`${path.join(tmpDir, 'council-stack.json')}.tmp.99999999`, JSON.stringify({
            branches: ['feat/one', 'main'],
            trunk: 'main',
            repo_path: tmpDir,
            codex_enabled: true,
        }));
        fs.writeFileSync(`${path.join(tmpDir, 'council-directive.json')}.tmp.99999999`, JSON.stringify(
            minimalDirective(['feat/one']),
        ));
        const newer = new Date(Date.now() + 1000);
        fs.utimesSync(`${path.join(tmpDir, 'council-stack.json')}.tmp.99999999`, newer, newer);
        fs.utimesSync(`${path.join(tmpDir, 'council-directive.json')}.tmp.99999999`, newer, newer);

        const report = await publishCouncilStack(tmpDir, { ghCommand: mock.ghPath });

        assert.equal(report.failed, 0);
        assert.equal(report.posted, 1);
        assert.equal(fs.existsSync(path.join(tmpDir, 'council-stack.json')), true);
        assert.equal(fs.existsSync(path.join(tmpDir, 'council-directive.json')), true);
    } finally {
        cleanupGhMock(mock);
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// --- 19. Wrong schema_version throws with schema_version in message ---

test('publishCouncilStack: throws when schema_version !== 1, message contains schema_version', async () => {
    const mock = makeGhMock({ auth: 'ok', prList: {}, prComment: {} });
    try {
        await withSession(async (sessionDir) => {
            const bad = { ...minimalDirective(), schema_version: 99 };
            fs.writeFileSync(path.join(sessionDir, 'council-directive.json'), JSON.stringify(bad));
            assert.throws(
                () => publishCouncilStack(sessionDir, { ghCommand: mock.ghPath }),
                (err) => err instanceof CouncilPublishError && /schema_version/.test(err.message),
            );
        });
    } finally {
        cleanupGhMock(mock);
    }
});

// --- 20. Missing required top-level field (branches) throws with jsonPath in message ---

test('publishCouncilStack: throws when required top-level field is missing, message contains jsonPath', async () => {
    const mock = makeGhMock({ auth: 'ok', prList: {}, prComment: {} });
    try {
        await withSession(async (sessionDir) => {
            const { branches: _unused, ...bad } = minimalDirective();
            fs.writeFileSync(path.join(sessionDir, 'council-directive.json'), JSON.stringify(bad));
            assert.throws(
                () => publishCouncilStack(sessionDir, { ghCommand: mock.ghPath }),
                (err) => err instanceof CouncilPublishError && /branches/.test(err.message),
            );
        });
    } finally {
        cleanupGhMock(mock);
    }
});

// --- 21. Missing required finding field throws ---

test('publishCouncilStack: throws when a required finding field is missing', async () => {
    const mock = makeGhMock({ auth: 'ok', prList: {}, prComment: {} });
    try {
        await withSession(async (sessionDir) => {
            const finding = minimalFinding();
            delete finding.severity; // drop required field
            const directive = {
                ...minimalDirective(),
                branches: [
                    { name: 'feat/one', findings: [finding] },
                    { name: 'feat/two', findings: [] },
                ],
            };
            fs.writeFileSync(path.join(sessionDir, 'council-directive.json'), JSON.stringify(directive));
            assert.throws(
                () => publishCouncilStack(sessionDir, { ghCommand: mock.ghPath }),
                (err) => err instanceof CouncilPublishError && /severity/.test(err.message),
            );
        });
    } finally {
        cleanupGhMock(mock);
    }
});

// --- 22. Branch in stack but missing from directive.branches → failed, no misleading comment, no marker ---

test('publishCouncilStack: stack branch absent from directive → outcome=failed, no body, no marker', async () => {
    const mock = makeGhMock({
        auth: 'ok',
        prList: { 'feat/one': 42, 'feat/two': 99 },
        prComment: {},
    });
    try {
        await withSession(async (sessionDir) => {
            const report = await publishCouncilStack(sessionDir, { ghCommand: mock.ghPath });

            const two = report.results.find(r => r.branch === 'feat/two');
            assert.ok(two, 'result for dropped branch feat/two is present');
            assert.equal(two.outcome, 'failed', 'dropped branch must not post "No findings" silently');
            assert.match(two.error, /directive\/stack mismatch/);
            assert.equal(two.body_path, undefined, 'no body_path when the branch never had an entry');

            // The misleading "No findings" comment body must NOT be written.
            const bodyFile = path.join(sessionDir, 'council-comments', 'feat__two.md');
            assert.equal(fs.existsSync(bodyFile), false, 'dropped branch body file must not be written');

            // The .published marker must NOT be stamped — a corrected-directive re-run must succeed.
            const markerFile = path.join(sessionDir, '.published', 'feat__two');
            assert.equal(fs.existsSync(markerFile), false, 'dropped branch marker must not be stamped');

            // `gh pr comment` must not have fired for the dropped branch.
            const calls = fs.readFileSync(mock.callLog, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
            const commentCalls = calls.filter(a => a[0] === 'pr' && a[1] === 'comment');
            assert.equal(commentCalls.length, 1, 'only the branch with a directive entry should post');

            // The intact branch still publishes normally.
            const one = report.results.find(r => r.branch === 'feat/one');
            assert.equal(one.outcome, 'posted');
            assert.equal(report.posted, 1);
            assert.equal(report.failed, 1);
        }, {
            // Directive is missing feat/two — the fan-out dropped that shard.
            directiveJson: minimalDirective(['feat/one']),
        });
    } finally {
        cleanupGhMock(mock);
    }
});

// === NEW TESTS: composeBody rendering ===

// --- 22. composeBody with one finding renders expected fields ---

test('composeBody: one finding renders severity, rule, recommendation, and Trap Doors block', () => {
    const finding = minimalFinding({ severity: 'P0', rule: 'MY_RULE', recommendation: 'do the thing' });
    const body = composeBody({
        sessionRoot: '/tmp/council-abc123',
        branch: 'feat/one',
        finalRound: 3,
        codexEnabled: false,
        findings: [finding],
        trapDoors: [],
        roundOutcomes: [],
    });
    assert.ok(/P0/.test(body), 'severity P0 present');
    assert.ok(/MY_RULE/.test(body), 'rule name present');
    assert.ok(/do the thing/.test(body), 'recommendation present');
    assert.ok(/### Trap Doors/.test(body), 'Trap Doors section present');
    assert.ok(/_None catalogued\._/.test(body), 'empty trap doors placeholder present');
});

// --- 23. composeBody with empty findings renders placeholder ---

test('composeBody: empty findings renders _No findings for this branch at session close._', () => {
    const body = composeBody({
        sessionRoot: '/tmp/council-abc123',
        branch: 'feat/one',
        finalRound: 1,
        codexEnabled: false,
        findings: [],
        trapDoors: [],
        roundOutcomes: [],
    });
    assert.ok(/_No findings for this branch at session close\._/.test(body));
});

// --- 24. composeBody with empty trapDoors renders placeholder ---

test('composeBody: empty trapDoors renders _None catalogued._', () => {
    const body = composeBody({
        sessionRoot: '/tmp/council-abc123',
        branch: 'feat/one',
        finalRound: 1,
        codexEnabled: false,
        findings: [],
        trapDoors: [],
        roundOutcomes: [],
    });
    assert.ok(/_None catalogued\._/.test(body));
});

// --- Hardening: every `gh` subprocess call is timeout-bounded ---
//
// Regression guard for a silent-failure class that survived four "silent-
// failure hardening" passes (v1.49.1/.2/.3, v1.50.0): `execFileSync` with no
// `timeout` option blocks forever when `gh` hangs (network partition, hung
// TLS handshake, stuck corp-proxy). Publisher runs at session end — a hang
// there deadlocks the entire Council run with no log signal.
//
// The test injects `ghTimeoutMs: 2000` and a mock that holds the event loop
// open for 60s. Node must SIGTERM the child on timeout and surface the error
// through the existing failure classification path.
// NOTE: 2000ms > subprocess-spawn latency under parallel-test load (was 500ms,
// which auth-preflight with `auth: 'ok'` could miss under heavy concurrency →
// false classification as skipped_no_gh instead of failed). Still << the 60s
// mock hang, so the hang-detection path fires as intended.

test('publishCouncilStack: hung `gh pr list` is aborted by timeout, classified as failed', async () => {
    const mock = makeGhMock({
        auth: 'ok',
        // feat/one hangs; feat/two returns normally — one hang must not kill the sweep
        prList: { 'feat/one': '__hang__', 'feat/two': 99 },
        prComment: {},
    });
    try {
        await withSession(async (sessionDir) => {
            const startedAt = Date.now();
            const report = await publishCouncilStack(sessionDir, {
                ghCommand: mock.ghPath,
                ghTimeoutMs: 2000,
            });
            const elapsedMs = Date.now() - startedAt;
            // Publisher must return promptly after timeout fires — well under
            // the 60s mock hang window. Generous ceiling covers CI jitter.
            assert.ok(elapsedMs < 10_000, `elapsed ${elapsedMs}ms should be < 10s; timeout did not fire`);

            const one = report.results.find(r => r.branch === 'feat/one');
            assert.equal(one.outcome, 'failed', 'hung pr list must classify as failed, not skipped_no_pr');
            assert.ok(/pr list/.test(one.error || ''), `error should mention pr list, got: ${one.error}`);

            // Sweep continues: feat/two still posts.
            const two = report.results.find(r => r.branch === 'feat/two');
            assert.equal(two.outcome, 'posted');
        }, { directiveJson: minimalDirective() });
    } finally {
        cleanupGhMock(mock);
    }
});

test('publishCouncilStack: hung `gh pr comment` is aborted by timeout, classified as failed', async () => {
    const mock = makeGhMock({
        auth: 'ok',
        prList: { 'feat/one': 42, 'feat/two': 99 },
        // First comment invocation hangs; second returns normally.
        prComment: { hangOnCall: [1] },
    });
    try {
        await withSession(async (sessionDir) => {
            const startedAt = Date.now();
            const report = await publishCouncilStack(sessionDir, {
                ghCommand: mock.ghPath,
                ghTimeoutMs: 2000,
            });
            const elapsedMs = Date.now() - startedAt;
            assert.ok(elapsedMs < 10_000, `elapsed ${elapsedMs}ms should be < 10s; timeout did not fire`);

            // Exactly one failed, exactly one posted — timeout does not abort the sweep.
            assert.equal(report.failed, 1);
            assert.equal(report.posted, 1);
            const failed = report.results.find(r => r.outcome === 'failed');
            assert.ok(/pr comment/.test(failed.error || ''), `error should mention pr comment, got: ${failed.error}`);

            // No .published marker for the failed branch.
            const pubDir = path.join(sessionDir, '.published');
            const markers = fs.existsSync(pubDir) ? fs.readdirSync(pubDir) : [];
            assert.equal(markers.length, 1, 'only the posted branch gets a marker');
        }, { directiveJson: minimalDirective() });
    } finally {
        cleanupGhMock(mock);
    }
});

test('publishCouncilStack: hung `gh auth status` is aborted, falls back to skipped_no_gh', async () => {
    const mock = makeGhMock({ auth: 'hang' });
    try {
        await withSession(async (sessionDir) => {
            const startedAt = Date.now();
            const report = await publishCouncilStack(sessionDir, {
                ghCommand: mock.ghPath,
                ghTimeoutMs: 2000,
            });
            const elapsedMs = Date.now() - startedAt;
            assert.ok(elapsedMs < 10_000, `elapsed ${elapsedMs}ms should be < 10s; auth timeout did not fire`);

            // Hung auth is indistinguishable from failed auth: both routes produce
            // skipped_no_gh for every branch (no pr list/comment is ever issued).
            assert.equal(report.posted, 0);
            for (const r of report.results) {
                assert.equal(r.outcome, 'skipped_no_gh');
            }
        }, { directiveJson: minimalDirective() });
    } finally {
        cleanupGhMock(mock);
    }
});

// --- 25. composeBody with non-empty trapDoors renders - bullets with path + constraint ---

test('composeBody: non-empty trapDoors renders dash bullets with path and constraint', () => {
    const trapDoors = [
        {
            path: 'src/auth/session.ts',
            constraint: 'token must be rotated on login',
            why_it_breaks: 'stale token allows replay',
            what_must_hold: 'rotation must be atomic',
        },
    ];
    const body = composeBody({
        sessionRoot: '/tmp/council-abc123',
        branch: 'feat/one',
        finalRound: 1,
        codexEnabled: false,
        findings: [],
        trapDoors,
        roundOutcomes: [],
    });
    assert.ok(/- `src\/auth\/session\.ts`/.test(body), 'bullet with path present');
    assert.ok(/token must be rotated on login/.test(body), 'constraint present');
    assert.ok(!/None catalogued/.test(body), 'placeholder must not appear when trapDoors non-empty');
});

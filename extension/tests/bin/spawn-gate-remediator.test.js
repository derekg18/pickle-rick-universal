import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnGateRemediatorMain } from '../../bin/spawn-gate-remediator.js';

function makeTmpDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sgr-test-')));
}

function makeGateResult(overrides = {}) {
  return {
    status: 'red',
    failures: [
      { check: 'lint', file: 'src/foo.ts', line: 10, ruleOrCode: 'no-control-regex', message: 'use \\u form', severity: 'error', occurrence_index: 0 },
    ],
    baseline_used: false,
    allowed_paths_used: false,
    elapsed_ms: 500,
    total_raw_failure_count: 1,
    new_failures_vs_baseline: 1,
    ...overrides,
  };
}

describe('spawn-gate-remediator', () => {
  // ---------------------------------------------------------------------------
  // no-subprocess: child_process is never imported in the bin
  // ---------------------------------------------------------------------------

  test('bin module does not import child_process', async () => {
    const binSrc = fs.readFileSync(
      new URL('../../bin/spawn-gate-remediator.js', import.meta.url).pathname,
      'utf-8'
    );
    assert.ok(
      !binSrc.includes('child_process'),
      'child_process must never be imported in spawn-gate-remediator'
    );
  });

  // ---------------------------------------------------------------------------
  // Missing required flags
  // ---------------------------------------------------------------------------

  test('missing --gate-result → exit 1', async () => {
    const lines = [];
    const code = await spawnGateRemediatorMain({
      argv: ['--session-root', '/tmp/sr', '--reason', 'strict'],
      isoOverride: '2026-01-01T00-00-00Z',
      stderr: (m) => lines.push(m),
      stdout: () => {},
    });
    assert.equal(code, 1);
    assert.ok(lines.some(l => l.includes('Missing required flags')));
  });

  test('missing --session-root → exit 1', async () => {
    const code = await spawnGateRemediatorMain({
      argv: ['--gate-result', '/tmp/gr.json', '--reason', 'strict'],
      isoOverride: '2026-01-01T00-00-00Z',
      stderr: () => {},
      stdout: () => {},
    });
    assert.equal(code, 1);
  });

  test('missing --reason → exit 1', async () => {
    const code = await spawnGateRemediatorMain({
      argv: ['--gate-result', '/tmp/gr.json', '--session-root', '/tmp/sr'],
      isoOverride: '2026-01-01T00-00-00Z',
      stderr: () => {},
      stdout: () => {},
    });
    assert.equal(code, 1);
  });

  test('invalid --reason → exit 1', async () => {
    const lines = [];
    const code = await spawnGateRemediatorMain({
      argv: ['--gate-result', '/tmp/gr.json', '--session-root', '/tmp/sr', '--reason', 'bad-value'],
      isoOverride: '2026-01-01T00-00-00Z',
      stderr: (m) => lines.push(m),
      stdout: () => {},
    });
    assert.equal(code, 1);
    assert.ok(lines.some(l => l.includes('strict|per-iteration')));
  });

  // ---------------------------------------------------------------------------
  // Invalid gate-result JSON
  // ---------------------------------------------------------------------------

  test('invalid JSON in gate-result → exit 1', async () => {
    const tmpDir = makeTmpDir();
    const grPath = path.join(tmpDir, 'gate-result.json');
    fs.writeFileSync(grPath, 'not-json', 'utf-8');

    const sessionRoot = path.join(tmpDir, 'session');
    fs.mkdirSync(sessionRoot, { recursive: true });

    const lines = [];
    const code = await spawnGateRemediatorMain({
      argv: ['--gate-result', grPath, '--session-root', sessionRoot, '--reason', 'strict'],
      isoOverride: '2026-01-01T00-00-00Z',
      extensionClaudeMdContent: '## Trap Doors\nNone.',
      stderr: (m) => lines.push(m),
      stdout: () => {},
    });
    assert.equal(code, 1);
    assert.ok(lines.some(l => l.includes('Failed to read')));
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('gate-result missing required fields → exit 1', async () => {
    const tmpDir = makeTmpDir();
    const grPath = path.join(tmpDir, 'gate-result.json');
    fs.writeFileSync(grPath, JSON.stringify({ status: 'red' }), 'utf-8');

    const sessionRoot = path.join(tmpDir, 'session');
    fs.mkdirSync(sessionRoot, { recursive: true });

    const lines = [];
    const code = await spawnGateRemediatorMain({
      argv: ['--gate-result', grPath, '--session-root', sessionRoot, '--reason', 'strict'],
      isoOverride: '2026-01-01T00-00-00Z',
      extensionClaudeMdContent: '## Trap Doors\nNone.',
      stderr: (m) => lines.push(m),
      stdout: () => {},
    });
    assert.equal(code, 1);
    assert.ok(lines.some(l => l.includes('not a valid GateResult')));
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('gate-result with malformed failure entries → exit 1, no brief', async () => {
    const tmpDir = makeTmpDir();
    const grPath = path.join(tmpDir, 'gate-result.json');
    // failures[] present but each entry is missing required GateFailure fields
    fs.writeFileSync(
      grPath,
      JSON.stringify({ status: 'red', failures: [{ check: 'lint' }], elapsed_ms: 0 }),
      'utf-8'
    );

    const sessionRoot = path.join(tmpDir, 'session');
    fs.mkdirSync(sessionRoot, { recursive: true });

    const errLines = [];
    const outLines = [];
    const code = await spawnGateRemediatorMain({
      argv: ['--gate-result', grPath, '--session-root', sessionRoot, '--reason', 'strict'],
      isoOverride: '2026-01-01T00-00-00Z',
      extensionClaudeMdContent: '## Trap Doors\nNone.',
      stderr: (m) => errLines.push(m),
      stdout: (m) => outLines.push(m),
    });

    assert.equal(code, 1, 'malformed failure entry must reject at validator');
    assert.ok(errLines.some(l => l.includes('not a valid GateResult')), 'stderr must explain rejection');
    assert.ok(!outLines.some(l => l.startsWith('BRIEF_PATH=')), 'no BRIEF_PATH must be emitted');

    const gateDir = path.join(sessionRoot, 'gate');
    if (fs.existsSync(gateDir)) {
      const briefs = fs.readdirSync(gateDir).filter(f => /^remediation_.*_brief\.md$/.test(f));
      assert.equal(briefs.length, 0, 'no brief file must be written when validator rejects');
    }

    fs.rmSync(tmpDir, { recursive: true });
  });

  test('gate-result reader promotes newer dead tmp snapshot before brief generation', async () => {
    const tmpDir = makeTmpDir();
    const grPath = path.join(tmpDir, 'gate-result.json');
    const tmpPath = `${grPath}.tmp.99999999`;
    fs.writeFileSync(grPath, '{', 'utf-8');
    fs.writeFileSync(tmpPath, JSON.stringify(makeGateResult()), 'utf-8');
    const baseTime = new Date('2026-01-01T00:00:00Z');
    const tmpTime = new Date('2026-01-01T00:00:10Z');
    fs.utimesSync(grPath, baseTime, baseTime);
    fs.utimesSync(tmpPath, tmpTime, tmpTime);

    const sessionRoot = path.join(tmpDir, 'session');
    fs.mkdirSync(sessionRoot, { recursive: true });

    const stdoutLines = [];
    const code = await spawnGateRemediatorMain({
      argv: ['--gate-result', grPath, '--session-root', sessionRoot, '--reason', 'strict'],
      isoOverride: '2026-01-01T00-00-00Z',
      extensionClaudeMdContent: '## Trap Doors\nNone.',
      stdout: (m) => stdoutLines.push(m),
      stderr: () => {},
    });

    assert.equal(code, 0);
    assert.ok(stdoutLines.some(l => l.startsWith('BRIEF_PATH=')), 'brief path must be emitted after tmp promotion');
    assert.equal(JSON.parse(fs.readFileSync(grPath, 'utf-8')).status, 'red');
    assert.equal(fs.existsSync(tmpPath), false, 'promoted tmp must be renamed over base gate result');

    fs.rmSync(tmpDir, { recursive: true });
  });

  test('gate-result with invalid status enum → exit 1', async () => {
    const tmpDir = makeTmpDir();
    const grPath = path.join(tmpDir, 'gate-result.json');
    fs.writeFileSync(
      grPath,
      JSON.stringify({ status: 'maybe', failures: [], elapsed_ms: 0 }),
      'utf-8'
    );

    const sessionRoot = path.join(tmpDir, 'session');
    fs.mkdirSync(sessionRoot, { recursive: true });

    const errLines = [];
    const code = await spawnGateRemediatorMain({
      argv: ['--gate-result', grPath, '--session-root', sessionRoot, '--reason', 'strict'],
      isoOverride: '2026-01-01T00-00-00Z',
      extensionClaudeMdContent: '## Trap Doors\nNone.',
      stderr: (m) => errLines.push(m),
      stdout: () => {},
    });

    assert.equal(code, 1, 'invalid status enum must reject');
    assert.ok(errLines.some(l => l.includes('not a valid GateResult')), 'stderr must explain rejection');
    fs.rmSync(tmpDir, { recursive: true });
  });

  // ---------------------------------------------------------------------------
  // Successful brief write
  // ---------------------------------------------------------------------------

  test('brief written to expected path + BRIEF_PATH echoed', async () => {
    const tmpDir = makeTmpDir();
    const grPath = path.join(tmpDir, 'gate-result.json');
    fs.writeFileSync(grPath, JSON.stringify(makeGateResult()), 'utf-8');

    const sessionRoot = path.join(tmpDir, 'session');
    fs.mkdirSync(sessionRoot, { recursive: true });

    const iso = '2026-04-27T13-42-01Z';
    const stdoutLines = [];
    const code = await spawnGateRemediatorMain({
      argv: ['--gate-result', grPath, '--session-root', sessionRoot, '--reason', 'strict'],
      isoOverride: iso,
      extensionClaudeMdContent: '## Trap Doors\nFake trap door content.',
      stdout: (m) => stdoutLines.push(m),
      stderr: () => {},
    });

    assert.equal(code, 0);

    const expectedPath = path.join(sessionRoot, 'gate', `remediation_${iso}_brief.md`);
    assert.ok(stdoutLines.some(l => l === `BRIEF_PATH=${expectedPath}`), `Expected BRIEF_PATH line, got: ${JSON.stringify(stdoutLines)}`);
    assert.ok(fs.existsSync(expectedPath), 'Brief file must exist');

    fs.rmSync(tmpDir, { recursive: true });
  });

  // ---------------------------------------------------------------------------
  // Brief content — all 4 sections present
  // ---------------------------------------------------------------------------

  test('brief contains all 4 required sections', async () => {
    const tmpDir = makeTmpDir();
    const grPath = path.join(tmpDir, 'gate-result.json');
    fs.writeFileSync(grPath, JSON.stringify(makeGateResult()), 'utf-8');

    const sessionRoot = path.join(tmpDir, 'session');
    const failingFile = path.join(tmpDir, 'src', 'foo.ts');
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(failingFile, 'const x = /[\\x01-\\x1F]/;', 'utf-8');

    // Gate result references the actual file
    const gateResult = makeGateResult({ failures: [
      { check: 'lint', file: failingFile, line: 1, ruleOrCode: 'no-control-regex', message: 'use \\u form', severity: 'error', occurrence_index: 0 },
    ]});
    fs.writeFileSync(grPath, JSON.stringify(gateResult), 'utf-8');

    const iso = '2026-04-27T13-42-01Z';
    const code = await spawnGateRemediatorMain({
      argv: ['--gate-result', grPath, '--session-root', sessionRoot, '--reason', 'per-iteration'],
      isoOverride: iso,
      extensionClaudeMdContent: '## Trap Doors\nFake trap door content.',
      stdout: () => {},
      stderr: () => {},
    });

    assert.equal(code, 0);

    const briefPath = path.join(sessionRoot, 'gate', `remediation_${iso}_brief.md`);
    const content = fs.readFileSync(briefPath, 'utf-8');
    const lines = content.split('\n');

    assert.ok(content.includes('## Section 1: Gate Failures'), 'Section 1 missing');
    assert.ok(content.includes('## Section 2: Failing File Contents'), 'Section 2 missing');
    assert.ok(content.includes('## Section 3: Relevant CLAUDE.md Trap Doors'), 'Section 3 missing');
    assert.ok(content.includes('## Section 4: Hard Rule and Abort Grammar'), 'Section 4 missing');

    const failureHeaderIndex = lines.indexOf('| Check | File | Line | Rule/Code | Severity | Message |');
    assert.ok(failureHeaderIndex >= 0, 'Failure table header missing');
    assert.equal(
      lines[failureHeaderIndex + 2],
      `| lint | ${failingFile} | 1 | no-control-regex | error | use \\u form |`,
      'Failure table row must preserve the exact GateFailure fields'
    );

    const fileSectionIndex = lines.indexOf(`### \`${failingFile}\``);
    assert.ok(fileSectionIndex >= 0, 'Failing file heading missing');

    // Section 3: trap doors
    assert.ok(content.includes('Fake trap door content'), 'Trap door content missing');

    // Section 4: hard rule
    assert.ok(content.includes('Fix ONLY the failures'), 'Hard rule missing');
    assert.ok(content.includes('Abort Grammar'), 'Abort grammar missing');

    fs.rmSync(tmpDir, { recursive: true });
  });

  // ---------------------------------------------------------------------------
  // Determinism — same input produces same brief path (iso fixed)
  // ---------------------------------------------------------------------------

  test('brief is deterministic given same iso override', async () => {
    const tmpDir = makeTmpDir();
    const grPath = path.join(tmpDir, 'gate-result.json');
    fs.writeFileSync(grPath, JSON.stringify(makeGateResult()), 'utf-8');

    const sessionRoot1 = path.join(tmpDir, 'session1');
    const sessionRoot2 = path.join(tmpDir, 'session2');
    const iso = '2026-04-27T00-00-00Z';

    for (const sr of [sessionRoot1, sessionRoot2]) {
      fs.mkdirSync(sr, { recursive: true });
      await spawnGateRemediatorMain({
        argv: ['--gate-result', grPath, '--session-root', sr, '--reason', 'strict'],
        isoOverride: iso,
        extensionClaudeMdContent: '## Trap Doors\nSame.',
        stdout: () => {},
        stderr: () => {},
      });
    }

    const brief1 = fs.readFileSync(path.join(sessionRoot1, 'gate', `remediation_${iso}_brief.md`), 'utf-8');
    const brief2 = fs.readFileSync(path.join(sessionRoot2, 'gate', `remediation_${iso}_brief.md`), 'utf-8');
    // Contents differ only by session root path — strip it and compare structure
    assert.equal(brief1.replace(sessionRoot1, 'SESSION').replace(grPath, 'GRPATH'),
      brief2.replace(sessionRoot2, 'SESSION').replace(grPath, 'GRPATH'));

    fs.rmSync(tmpDir, { recursive: true });
  });

  // ---------------------------------------------------------------------------
  // Lockfile cleanup after success
  // ---------------------------------------------------------------------------

  test('lockfile is released after successful run', async () => {
    const tmpDir = makeTmpDir();
    const grPath = path.join(tmpDir, 'gate-result.json');
    fs.writeFileSync(grPath, JSON.stringify(makeGateResult()), 'utf-8');
    const sessionRoot = path.join(tmpDir, 'session');
    const iso = '2026-04-27T00-00-00Z';

    await spawnGateRemediatorMain({
      argv: ['--gate-result', grPath, '--session-root', sessionRoot, '--reason', 'strict'],
      isoOverride: iso,
      extensionClaudeMdContent: '## Trap Doors\nNone.',
      stdout: () => {},
      stderr: () => {},
    });

    const lockfilePath = path.join(sessionRoot, 'gate', 'remediator.lockfile');
    assert.ok(!fs.existsSync(lockfilePath), 'Lockfile must be released after run');

    fs.rmSync(tmpDir, { recursive: true });
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VALIDATOR = path.resolve(__dirname, '../bin/validate-teams-ticket.js');

function run(args) {
    return spawnSync(process.execPath, [VALIDATOR, ...args], {
        encoding: 'utf-8',
        env: { ...process.env, FORCE_COLOR: '0' },
    });
}

function mktmp(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(p) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}

test('validate-teams-ticket: implementation role with all 4 prefixes → exit 0', () => {
    const dir = mktmp('vtt-impl-pass-');
    try {
        for (const f of ['research_2026.md', 'plan_x.md', 'conformance_y.md', 'code_review_z.md']) {
            fs.writeFileSync(path.join(dir, f), '# stub\n');
        }
        const r = run(['--ticket-path', dir, '--role', 'implementation']);
        assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
    } finally { cleanup(dir); }
});

test('validate-teams-ticket: implementation role with empty dir → exit 1, stderr lists missing prefixes', () => {
    const dir = mktmp('vtt-impl-empty-');
    try {
        const r = run(['--ticket-path', dir, '--role', 'implementation']);
        assert.notEqual(r.status, 0, 'expected non-zero exit');
        for (const prefix of ['research', 'plan', 'conformance', 'code_review']) {
            assert.match(r.stderr, new RegExp(prefix), `stderr should mention missing "${prefix}"`);
        }
    } finally { cleanup(dir); }
});

test('validate-teams-ticket: review role with all 3 prefixes → exit 0', () => {
    const dir = mktmp('vtt-rev-pass-');
    try {
        for (const f of ['review_scope.md', 'review_findings.md', 'spec_conformance.md']) {
            fs.writeFileSync(path.join(dir, f), '# stub\n');
        }
        const r = run(['--ticket-path', dir, '--role', 'review']);
        assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
    } finally { cleanup(dir); }
});

test('validate-teams-ticket: nonexistent path → exit 1', () => {
    const r = run(['--ticket-path', '/nonexistent/path/zzz', '--role', 'implementation']);
    assert.notEqual(r.status, 0, 'expected non-zero exit');
    assert.ok(r.stderr.length > 0, 'stderr should explain the path issue');
});

test('validate-teams-ticket: invalid --role → exit 1', () => {
    const dir = mktmp('vtt-role-bad-');
    try {
        const r = run(['--ticket-path', dir, '--role', 'nonsense']);
        assert.notEqual(r.status, 0, 'expected non-zero exit on invalid role');
    } finally { cleanup(dir); }
});

test('validate-teams-ticket: missing --ticket-path → exit 1', () => {
    const r = run(['--role', 'implementation']);
    assert.notEqual(r.status, 0, 'expected non-zero exit when --ticket-path is missing');
});

test('validate-teams-ticket: implementation role with only research_x.md (1 of 4 prefixes) → exit 1, lists missing', () => {
    // Strict all-of semantics: every prefix must have at least one matching file.
    // Stricter than `hasLifecycleArtifact` (any-of) because teams mode lacks the
    // WORKER_DONE token + log-size signals the legacy spawn-morty path uses.
    const dir = mktmp('vtt-impl-partial-');
    try {
        fs.writeFileSync(path.join(dir, 'research_x.md'), '# stub\n');
        const r = run(['--ticket-path', dir, '--role', 'implementation']);
        assert.notEqual(r.status, 0, 'expected non-zero exit when only 1 of 4 prefixes is present');
        for (const prefix of ['plan', 'conformance', 'code_review']) {
            assert.match(r.stderr, new RegExp(prefix), `stderr should list missing "${prefix}"`);
        }
        assert.doesNotMatch(r.stderr, /\bresearch\b/, 'present "research" prefix should NOT be in the missing list');
    } finally { cleanup(dir); }
});

test('validate-teams-ticket: defaults to implementation role when --role omitted', () => {
    const dir = mktmp('vtt-default-role-');
    try {
        for (const f of ['research_x.md', 'plan_x.md', 'conformance_x.md', 'code_review_x.md']) {
            fs.writeFileSync(path.join(dir, f), '# stub\n');
        }
        const r = run(['--ticket-path', dir]);
        assert.equal(r.status, 0, `expected exit 0 with default role; stderr=${r.stderr}`);
    } finally { cleanup(dir); }
});

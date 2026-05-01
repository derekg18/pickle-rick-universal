import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '../bin/check-readiness.js');

function tmpDir(prefix = 'pickle-readiness-p0-') {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeTicket(sessionDir, id, options = {}) {
    const ticketDir = path.join(sessionDir, id);
    fs.mkdirSync(ticketDir, { recursive: true });
    const ticketPath = path.join(ticketDir, `linear_ticket_${id}.md`);
    const acIds = options.acIds ? `[${options.acIds.join(', ')}]` : '[]';
    const deps = options.dependencies ? `dependencies: [${options.dependencies.join(', ')}]\n` : '';
    fs.writeFileSync(ticketPath, [
        '---',
        `id: ${id}`,
        `key: ${options.key ?? id}`,
        `ac_ids: ${acIds}`,
        deps.trimEnd(),
        '---',
        '',
        '# Ticket',
        '',
        '## Acceptance Criteria',
        `- [ ] ${options.ac ?? 'Command exits 0 exactly.'}`,
        '',
        options.extra ?? '',
    ].filter((line) => line !== '').join('\n'));
    return ticketPath;
}

function writeManifest(sessionDir, body) {
    const manifestPath = path.join(sessionDir, 'decomposition_manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(body, null, 2));
    return manifestPath;
}

function runReadiness(sessionDir, repoRoot = process.cwd()) {
    return spawnSync(process.execPath, [
        BIN,
        '--session-dir', sessionDir,
        '--repo-root', repoRoot,
    ], {
        encoding: 'utf-8',
        timeout: 10000,
    });
}

function runFixture(callback) {
    const sessionDir = tmpDir();
    try {
        callback(sessionDir);
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
}

test('check-readiness: PRD requirement without ticket mapping fails independently', () => runFixture((sessionDir) => {
    writeTicket(sessionDir, 'map001', { acIds: ['REQ-2'] });
    writeManifest(sessionDir, {
        requirements: ['REQ-1'],
        tickets: [{ id: 'map001', key: 'MAP-1', ac_ids: ['REQ-2'] }],
    });

    const result = runReadiness(sessionDir);
    assert.equal(result.status, 2);
    const out = JSON.parse(result.stdout);
    assert.equal(out.status, 'fail');
    assert.ok(out.findings.some((finding) => finding.kind === 'prd_map' && finding.detail === 'REQ-1'));
}));

test('check-readiness: prose-only acceptance criterion fails independently', () => runFixture((sessionDir) => {
    writeTicket(sessionDir, 'ac0001', { ac: 'The workflow should feel intuitive.' });
    writeManifest(sessionDir, { tickets: [{ id: 'ac0001', key: 'AC-1' }] });

    const result = runReadiness(sessionDir);
    assert.equal(result.status, 2);
    const out = JSON.parse(result.stdout);
    assert.ok(out.findings.some((finding) => finding.kind === 'machinability'));
}));

test('check-readiness: missing file path fails independently', () => runFixture((sessionDir) => {
    writeTicket(sessionDir, 'path01', { extra: '## Files\n\n- `missing/path-contract.ts`\n' });
    writeManifest(sessionDir, { tickets: [{ id: 'path01', key: 'PATH-1' }] });

    const result = runReadiness(sessionDir);
    assert.equal(result.status, 2);
    const out = JSON.parse(result.stdout);
    assert.ok(out.findings.some((finding) => finding.kind === 'file_path' && finding.detail === 'missing/path-contract.ts'));
}));

test('check-readiness: missing contract fails independently', () => runFixture((sessionDir) => {
    writeTicket(sessionDir, 'ctr001', { extra: '## Interface Contracts\n\n- `NoSuchReadinessContract.resolve()` must exist.\n' });
    writeManifest(sessionDir, { tickets: [{ id: 'ctr001', key: 'CTR-1' }] });

    const result = runReadiness(sessionDir);
    assert.equal(result.status, 2);
    const out = JSON.parse(result.stdout);
    assert.ok(out.findings.some((finding) => finding.kind === 'contract' && finding.detail === 'NoSuchReadinessContract.resolve()'));
}));

test('check-readiness: missing dependency fails independently', () => runFixture((sessionDir) => {
    writeTicket(sessionDir, 'dep001', { dependencies: ['DEP-MISSING'] });
    writeManifest(sessionDir, { tickets: [{ id: 'dep001', key: 'DEP-1' }] });

    const result = runReadiness(sessionDir);
    assert.equal(result.status, 2);
    const out = JSON.parse(result.stdout);
    assert.ok(out.findings.some((finding) => finding.kind === 'dependency' && finding.detail === 'DEP-MISSING'));
}));

test('check-readiness: aligned fixture exits 0 with structured JSON stdout', () => runFixture((sessionDir) => {
    writeTicket(sessionDir, 'ok0001', { key: 'OK-1', acIds: ['REQ-1'] });
    writeManifest(sessionDir, {
        requirements: ['REQ-1'],
        tickets: [{ id: 'ok0001', key: 'OK-1', ac_ids: ['REQ-1'] }],
    });

    const result = runReadiness(sessionDir);
    assert.equal(result.status, 0);
    const out = JSON.parse(result.stdout);
    assert.equal(out.status, 'pass');
    assert.deepEqual(out.findings, []);
    assert.equal(typeof out.elapsed_ms, 'number');
}));

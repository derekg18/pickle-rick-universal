import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

// 750ms → 2500ms → 5000ms: under heavy full-suite concurrency (3340 tests, 222
// suites), the SUT's findImportersTimeoutMs needs enough wall-clock to actually
// fire the SIGKILL on a hanging shim and execute the grep fallback. 2500ms was
// occasionally tight enough that the fallback ran but the SUT still returned
// only the seed file. The HANG_SCRIPT sleeps 60s so any value < 60_000 still
// validates the timeout-bound contract — bumping just absorbs scheduler jitter.
const HANG_TIMEOUT_MS = 5_000;

const FAIL_SCRIPT = (code) => `#!/bin/sh
exit ${code}
`;

const SUCCESS_SCRIPT = `#!/bin/sh
printf './b.ts\\n'
exit 0
`;

const HANG_SCRIPT = `#!/bin/sh
/bin/sleep 60
`;

function makeRepo() {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scope-import-walk-')));
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export function foo() {}\n');
    fs.writeFileSync(path.join(repo, 'b.ts'), "import { foo } from './a';\n");
    return repo;
}

function withToolShims(scripts, fn) {
    const shimDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scope-import-tools-')));
    try {
        for (const [tool, script] of Object.entries(scripts)) {
            const shimPath = path.join(shimDir, tool);
            fs.writeFileSync(shimPath, script);
            fs.chmodSync(shimPath, 0o755);
        }
        return fn(shimDir);
    } finally {
        fs.rmSync(shimDir, { recursive: true, force: true });
    }
}

function runComputeOneHop(repo, scripts) {
    return withToolShims(scripts, (shimDir) => {
        const script = `
import { computeOneHop } from './services/scope-resolver.js';
const warnings = [];
console.warn = (message) => warnings.push(String(message));
const result = computeOneHop(['a.ts'], ${JSON.stringify(repo)}, { findImportersTimeoutMs: ${HANG_TIMEOUT_MS} });
process.stdout.write(JSON.stringify({ result, warnings }));
`;
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
            cwd: path.resolve(import.meta.dirname, '..'),
            encoding: 'utf-8',
            env: {
                ...process.env,
                PATH: shimDir,
            },
            timeout: HANG_TIMEOUT_MS + 7_500,
        });

        assert.equal(result.status, 0, result.stderr || result.stdout);
        return JSON.parse(result.stdout);
    });
}

function runTimedComputeOneHop(repo, scripts) {
    const start = Date.now();
    const output = runComputeOneHop(repo, scripts);
    return {
        ...output,
        elapsed: Date.now() - start,
    };
}

function hasWarning(warnings, tool, category) {
    const pattern = new RegExp(`\\b${tool}\\b[^\\n]*\\b${category}\\b`);
    return warnings.some((line) => pattern.test(line));
}

function warningCategoryCount(warnings, category) {
    const pattern = new RegExp(`\\b${category}\\b`);
    return warnings.filter((line) => pattern.test(line)).length;
}

function assertFinishedWithin(elapsed, label) {
    assert.ok(elapsed < HANG_TIMEOUT_MS + 5_000, `${label} took ${elapsed}ms`);
}

function runInRepo(scripts) {
    const repo = makeRepo();
    try {
        return runTimedComputeOneHop(repo, scripts);
    } finally {
        cleanup(repo);
    }
}

function cleanup(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
}

test('computeOneHop import walks', async (t) => {
    await t.test('rg fails and grep recovers', () => {
        const output = runInRepo({ rg: FAIL_SCRIPT(2), grep: SUCCESS_SCRIPT });
        assert.deepStrictEqual(output.result, ['a.ts', 'b.ts']);
        assert.equal(hasWarning(output.warnings, 'rg', 'fail'), true);
        assert.equal(hasWarning(output.warnings, 'grep', 'fail'), false);
    });

    await t.test('grep failure is logged distinctly', () => {
        const output = runInRepo({ rg: FAIL_SCRIPT(2), grep: FAIL_SCRIPT(3) });
        assert.deepStrictEqual(output.result, ['a.ts']);
        assert.equal(hasWarning(output.warnings, 'rg', 'fail'), true);
        assert.equal(hasWarning(output.warnings, 'grep', 'fail'), true);
    });

    await t.test('both tools fail and importer expansion is empty', () => {
        const output = runInRepo({ rg: FAIL_SCRIPT(4), grep: FAIL_SCRIPT(5) });
        assert.deepStrictEqual(output.result, ['a.ts']);
        assert.equal(warningCategoryCount(output.warnings, 'fail'), 2);
    });

    await t.test('rg hang is bounded by findImportersTimeoutMs', () => {
        const output = runInRepo({ rg: HANG_SCRIPT, grep: SUCCESS_SCRIPT });
        assert.deepStrictEqual(output.result, ['a.ts', 'b.ts']);
        assertFinishedWithin(output.elapsed, 'rg hang');
        assert.equal(hasWarning(output.warnings, 'rg', 'timeout'), true);
    });

    await t.test('grep hang is bounded by findImportersTimeoutMs', () => {
        const output = runInRepo({ rg: FAIL_SCRIPT(2), grep: HANG_SCRIPT });
        assert.deepStrictEqual(output.result, ['a.ts']);
        assertFinishedWithin(output.elapsed, 'grep hang');
        assert.equal(hasWarning(output.warnings, 'rg', 'fail'), true);
        assert.equal(hasWarning(output.warnings, 'grep', 'timeout'), true);
    });
});

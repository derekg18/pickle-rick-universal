// Regression test for anatomy-park iteration 2: findImporters (invoked via
// computeOneHop → resolveScope) must not block indefinitely on a wedged
// ripgrep/grep subprocess. A FIFO pipe, stuck FUSE mount, or catastrophic
// regex backtracking can hang rg/grep forever; without a per-call `timeout`
// option on spawnSync, the entire scope-resolution phase stalls with no
// log signal — same silent-hang class as the council-publish `gh` gap
// addressed in iteration 1.
//
// Strategy: prepend a tmp dir containing a fake `rg` script (sleeps 60s) to
// PATH and call computeOneHop with a small findImportersTimeoutMs. Assert
// wall time is bounded by the injected timeout + slack, and never close to
// the 60s hang. This exercises the real spawnSync timeout path, not a mock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { computeOneHop } from '../services/scope-resolver.js';

const HANG_TIMEOUT_MS = 500;
const HANG_SCRIPT = `#!/usr/bin/env node
// Keep the event loop alive past the parent's spawnSync timeout.
// Parent sends SIGTERM on timeout; default Node handler exits cleanly.
setTimeout(() => process.exit(0), 60_000);
`;

function withHangingToolsOnPath(fn) {
    const shimDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scope-hang-')));
    try {
        for (const tool of ['rg', 'grep']) {
            const shimPath = path.join(shimDir, tool);
            fs.writeFileSync(shimPath, HANG_SCRIPT);
            fs.chmodSync(shimPath, 0o755);
        }
        const originalPath = process.env.PATH ?? '';
        process.env.PATH = `${shimDir}${path.delimiter}${originalPath}`;
        try {
            return fn(shimDir);
        } finally {
            process.env.PATH = originalPath;
        }
    } finally {
        fs.rmSync(shimDir, { recursive: true, force: true });
    }
}

test('computeOneHop: hung rg/grep is bounded by findImportersTimeoutMs', () => {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scope-hang-repo-')));
    try {
        // a.ts exports foo — triggers the one-hop importer walk.
        fs.writeFileSync(path.join(repo, 'a.ts'), 'export function foo() {}\n');
        fs.writeFileSync(path.join(repo, 'b.ts'), "import { foo } from './a';\n");

        withHangingToolsOnPath(() => {
            const start = Date.now();
            // Should not throw — findImporters swallows both branches and
            // returns [] after each hangs and is killed by the timeout. The
            // diff file a.ts still comes back as the seed.
            const result = computeOneHop(['a.ts'], repo, {
                findImportersTimeoutMs: HANG_TIMEOUT_MS,
            });
            const elapsed = Date.now() - start;

            assert.ok(result.includes('a.ts'), 'diff file a.ts returned as seed');
            // Two spawnSync calls (rg then grep) × HANG_TIMEOUT_MS + slack for
            // process startup / test runner jitter. 60s hang would trip > 5×.
            assert.ok(
                elapsed < HANG_TIMEOUT_MS * 2 + 2_000,
                `elapsed ${elapsed}ms exceeds bound; hang guard not firing`,
            );
        });
    } finally {
        fs.rmSync(repo, { recursive: true, force: true });
    }
});


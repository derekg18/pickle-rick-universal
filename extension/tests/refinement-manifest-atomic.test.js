import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { writeManifestAtomic } = await import('../bin/spawn-refinement-team.js');

function makeTmpDir(prefix = 'refinement-manifest-') {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function makeManifest(tmp) {
    return {
        prd_path: path.join(tmp, 'prd.md'),
        refinement_dir: path.join(tmp, 'refinement'),
        all_success: false,
        cycles_requested: 1,
        cycles_completed: 1,
        max_turns_per_worker: 15,
        workers: [{
            role: 'requirements',
            success: false,
            output_file: path.join(tmp, 'refinement', 'analysis_requirements.md'),
            exists: false,
            log_file: path.join(tmp, 'refinement', 'worker_requirements_c1.log'),
            cycle: 1,
        }],
        completed_at: new Date(0).toISOString(),
    };
}

test('writeManifestAtomic: failed temp write leaves no partial manifest at target path', async () => {
    const tmp = makeTmpDir();
    const manifestPath = path.join(tmp, 'refinement_manifest.json');
    const originalWriteFile = fs.promises.writeFile;
    try {
        fs.promises.writeFile = async (target) => {
            assert.equal(String(target), `${manifestPath}.tmp.${process.pid}`, 'manifest must be written through the recoverable temp path');
            throw new Error('simulated write failure');
        };

        await assert.rejects(
            writeManifestAtomic(manifestPath, makeManifest(tmp)),
            /simulated write failure/
        );
        assert.equal(fs.existsSync(manifestPath), false, 'target manifest must not be partially written');
    } finally {
        fs.promises.writeFile = originalWriteFile;
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

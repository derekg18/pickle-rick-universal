import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createPR } from '../services/pr-factory.js';

test('createPR throws when state.json does not exist', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-factory-'));
    try {
        assert.throws(() => createPR(tmp), { message: 'state.json not found' });
    } finally {
        fs.rmSync(tmp, { recursive: true });
    }
});

test('createPR throws when state.json is corrupt JSON', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-factory-'));
    try {
        fs.writeFileSync(path.join(tmp, 'state.json'), '{not valid json!!!');
        assert.throws(() => createPR(tmp), { message: 'state.json is corrupt or unreadable' });
    } finally {
        fs.rmSync(tmp, { recursive: true });
    }
});

test('createPR throws when state.json is missing working_dir', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-factory-'));
    try {
        fs.writeFileSync(path.join(tmp, 'state.json'), JSON.stringify({ original_prompt: 'test' }));
        assert.throws(() => createPR(tmp), {
            message: 'state.json is missing working_dir — cannot determine target repository',
        });
    } finally {
        fs.rmSync(tmp, { recursive: true });
    }
});

test('createPR truncates long prompts to 50 chars in the PR title', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-factory-'));
    try {
        const longPrompt = 'A'.repeat(120);
        fs.writeFileSync(
            path.join(tmp, 'state.json'),
            JSON.stringify({ working_dir: tmp, original_prompt: longPrompt })
        );
        // gh will fail because tmp is not a git repo — inspect the error to verify title construction
        let caught;
        try {
            createPR(tmp);
        } catch (err) {
            caught = err;
        }
        assert.ok(caught, 'expected createPR to throw');
        const msg = caught.message;
        // Title should contain first 50 chars of the prompt followed by "..."
        const expectedTitleFragment = `Pickle Rick: ${'A'.repeat(50)}...`;
        assert.ok(
            msg.includes(expectedTitleFragment),
            `Error message should include the truncated title.\nExpected fragment: ${expectedTitleFragment}\nGot: ${msg}`
        );
        // Title must NOT contain the full 120-char prompt (it was truncated)
        assert.ok(
            !msg.includes(`Pickle Rick: ${'A'.repeat(120)}`),
            'Title should not contain the full un-truncated prompt'
        );
    } finally {
        fs.rmSync(tmp, { recursive: true });
    }
});

test('createPR includes session ID (basename of sessionDir) in the PR body', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-factory-session-id-'));
    try {
        fs.writeFileSync(
            path.join(tmp, 'state.json'),
            JSON.stringify({ working_dir: tmp, original_prompt: 'add widget' })
        );
        let caught;
        try {
            createPR(tmp);
        } catch (err) {
            caught = err;
        }
        assert.ok(caught, 'expected createPR to throw');
        const msg = caught.message;
        const sessionId = path.basename(tmp);
        assert.ok(
            msg.includes(`Session: ${sessionId}`),
            `Error message should include "Session: ${sessionId}" from the PR body.\nGot: ${msg}`
        );
    } finally {
        fs.rmSync(tmp, { recursive: true });
    }
});

test('createPR includes the full original prompt in the PR body', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-factory-'));
    try {
        const prompt = 'Refactor the authentication module to use OAuth2 with PKCE flow';
        fs.writeFileSync(
            path.join(tmp, 'state.json'),
            JSON.stringify({ working_dir: tmp, original_prompt: prompt })
        );
        let caught;
        try {
            createPR(tmp);
        } catch (err) {
            caught = err;
        }
        assert.ok(caught, 'expected createPR to throw');
        const msg = caught.message;
        assert.ok(
            msg.includes(`Prompt: ${prompt}`),
            `Error message should include "Prompt: ${prompt}" from the PR body.\nGot: ${msg}`
        );
    } finally {
        fs.rmSync(tmp, { recursive: true });
    }
});

test('createPR recovers orphan tmp state before deriving repo path and prompt', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-factory-recovery-'));
    try {
        const staleRepo = path.join(tmp, 'stale-repo');
        const liveRepo = path.join(tmp, 'live-repo');
        fs.mkdirSync(staleRepo, { recursive: true });
        fs.mkdirSync(liveRepo, { recursive: true });

        const statePath = path.join(tmp, 'state.json');
        fs.writeFileSync(
            statePath,
            JSON.stringify({
                working_dir: staleRepo,
                original_prompt: 'stale prompt',
                iteration: 1,
                schema_version: 1,
            })
        );
        fs.writeFileSync(
            `${statePath}.tmp.99999999`,
            JSON.stringify({
                working_dir: liveRepo,
                original_prompt: 'fresh prompt',
                iteration: 2,
                schema_version: 1,
            })
        );

        let caught;
        try {
            createPR(tmp);
        } catch (err) {
            caught = err;
        }

        assert.ok(caught instanceof Error, 'expected createPR to throw');
        assert.ok(
            caught.message.includes('Prompt: fresh prompt'),
            `Recovered state should drive the PR body.\nGot: ${caught.message}`
        );

        const promotedState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(promotedState.working_dir, liveRepo, 'StateManager recovery should promote the newer tmp state');
        assert.equal(promotedState.original_prompt, 'fresh prompt');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('createPR recovers from a corrupt base state.json when a newer orphan tmp exists', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-factory-corrupt-recovery-'));
    try {
        const liveRepo = path.join(tmp, 'live-repo');
        fs.mkdirSync(liveRepo, { recursive: true });

        const statePath = path.join(tmp, 'state.json');
        fs.writeFileSync(statePath, '{broken json');
        fs.writeFileSync(
            `${statePath}.tmp.99999999`,
            JSON.stringify({
                working_dir: liveRepo,
                original_prompt: 'recovered prompt',
                iteration: 4,
                schema_version: 1,
            })
        );

        let caught;
        try {
            createPR(tmp);
        } catch (err) {
            caught = err;
        }

        assert.ok(caught instanceof Error, 'expected createPR to throw');
        assert.ok(
            caught.message.includes('Prompt: recovered prompt'),
            `Recovered tmp state should drive the PR body even when the base file is corrupt.\nGot: ${caught.message}`
        );

        const promotedState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(promotedState.working_dir, liveRepo, 'recovered tmp should replace the corrupt base file');
        assert.equal(promotedState.original_prompt, 'recovered prompt');
        assert.equal(fs.existsSync(`${statePath}.tmp.99999999`), false, 'recovered tmp should be consumed');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('createPR does not append "..." for short prompts', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-factory-'));
    try {
        const shortPrompt = 'fix login bug';
        fs.writeFileSync(
            path.join(tmp, 'state.json'),
            JSON.stringify({ working_dir: tmp, original_prompt: shortPrompt })
        );
        let caught;
        try {
            createPR(tmp);
        } catch (err) {
            caught = err;
        }
        assert.ok(caught, 'expected createPR to throw');
        const msg = caught.message;
        // Title should contain the full short prompt WITHOUT trailing "..."
        assert.ok(
            msg.includes(`Pickle Rick: ${shortPrompt}`),
            `Error message should include the full short title.\nGot: ${msg}`
        );
        assert.ok(
            !msg.includes(`Pickle Rick: ${shortPrompt}...`),
            `Short title should NOT have trailing "..."\nGot: ${msg}`
        );
    } finally {
        fs.rmSync(tmp, { recursive: true });
    }
});

test('createPR sanitizes newlines in original_prompt for PR title', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-factory-'));
    try {
        const multilinePrompt = 'Fix the\nlogin\r\nbug';
        fs.writeFileSync(
            path.join(tmp, 'state.json'),
            JSON.stringify({ working_dir: tmp, original_prompt: multilinePrompt })
        );
        let caught;
        try {
            createPR(tmp);
        } catch (err) {
            caught = err;
        }
        assert.ok(caught, 'expected createPR to throw');
        const msg = caught.message;
        // Title should have newlines replaced with spaces — the --title arg is sanitized
        assert.ok(
            msg.includes('Pickle Rick: Fix the login bug'),
            `Title should have newlines replaced with spaces.\nGot: ${msg}`
        );
    } finally {
        fs.rmSync(tmp, { recursive: true });
    }
});

// ---------------------------------------------------------------------------
// Edge cases: empty working_dir, double-newline collapse (pass 9)
// ---------------------------------------------------------------------------

test('createPR throws when working_dir is empty string (falsy)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-factory-'));
    try {
        fs.writeFileSync(
            path.join(tmp, 'state.json'),
            JSON.stringify({ working_dir: '', original_prompt: 'test' })
        );
        assert.throws(() => createPR(tmp), {
            message: 'state.json is missing working_dir — cannot determine target repository',
        });
    } finally {
        fs.rmSync(tmp, { recursive: true });
    }
});

test('createPR collapses consecutive newlines to single space in title', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-factory-'));
    try {
        // Double \r\n\r\n should collapse to single space, not double
        const prompt = 'Fix the\r\n\r\nlogin bug';
        fs.writeFileSync(
            path.join(tmp, 'state.json'),
            JSON.stringify({ working_dir: tmp, original_prompt: prompt })
        );
        let caught;
        try {
            createPR(tmp);
        } catch (err) {
            caught = err;
        }
        assert.ok(caught, 'expected createPR to throw');
        const msg = caught.message;
        // The regex [\r\n]+ matches the entire \r\n\r\n sequence at once → single space
        assert.ok(
            msg.includes('Pickle Rick: Fix the login bug'),
            `Double newlines should collapse to single space.\nGot: ${msg}`
        );
    } finally {
        fs.rmSync(tmp, { recursive: true });
    }
});

test('createPR uses "(none)" when original_prompt is missing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-factory-'));
    try {
        fs.writeFileSync(
            path.join(tmp, 'state.json'),
            JSON.stringify({ working_dir: tmp })
        );
        let caught;
        try {
            createPR(tmp);
        } catch (err) {
            caught = err;
        }
        assert.ok(caught, 'expected createPR to throw');
        const msg = caught.message;
        assert.ok(
            msg.includes('Prompt: (none)'),
            `Missing prompt should show "(none)" in body.\nGot: ${msg}`
        );
    } finally {
        fs.rmSync(tmp, { recursive: true });
    }
});

test('createPR propagates gh errors wrapped in "Failed to create PR"', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-factory-'));
    try {
        fs.writeFileSync(
            path.join(tmp, 'state.json'),
            JSON.stringify({ working_dir: tmp, original_prompt: 'test prompt' })
        );
        // gh will fail (no git repo) — createPR must wrap the error
        assert.throws(() => createPR(tmp), (err) => {
            assert.ok(err instanceof Error, 'thrown value should be an Error');
            assert.ok(
                err.message.startsWith('Failed to create PR:'),
                `Error message should start with "Failed to create PR:", got: ${err.message}`
            );
            // The wrapped message should mention the gh command that failed
            assert.ok(
                err.message.includes('gh'),
                `Wrapped error should reference the gh command, got: ${err.message}`
            );
            return true;
        });
    } finally {
        fs.rmSync(tmp, { recursive: true });
    }
});

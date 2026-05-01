import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PICKLE_MD = path.resolve(__dirname, '../../.claude/commands/pickle.md');

const text = fs.readFileSync(PICKLE_MD, 'utf-8');

test('pickle.md: contains teams_mode branch selector', () => {
    assert.match(text, /teams_mode/, 'pickle.md should branch on state.teams_mode');
});

test('pickle.md: references TeamCreate, TeamDelete, and Agent primitives', () => {
    assert.match(text, /TeamCreate/, 'should call TeamCreate');
    assert.match(text, /TeamDelete/, 'should call TeamDelete');
    assert.match(text, /\bAgent\b/, 'should mention the Agent tool');
});

test('pickle.md: dispatches all six phase subagents', () => {
    for (const subagent of [
        'morty-phase-researcher',
        'morty-phase-planner',
        'morty-phase-implementer',
        'morty-phase-verifier',
        'morty-phase-reviewer',
        'morty-phase-simplifier',
    ]) {
        assert.match(text, new RegExp(subagent), `should spawn ${subagent}`);
    }
});

test('pickle.md: preflights phase persona config and installed agent files', () => {
    const phaseStart = text.indexOf('## Phase 3.B');
    const preflight = text.indexOf('**Phase dispatch preflight**', phaseStart);
    const spawn = text.indexOf('3. **Spawn**: make six distinct sequential `Agent` calls', phaseStart);

    assert.ok(preflight > phaseStart, 'should include phase dispatch preflight');
    assert.ok(spawn > preflight, 'preflight should happen before phase Agent calls');
    assert.match(text.slice(preflight, spawn), /phase-personas\.json/);
    assert.match(text.slice(preflight, spawn), /version >= 1/);
    assert.match(text.slice(preflight, spawn), /~\/\.claude\/agents\/\.pickle-managed\/<subagent_type>\.md/);
    assert.match(text.slice(preflight, spawn), /phase_dispatch_preflight_failed/);
    assert.match(text.slice(preflight, spawn), /bash install\.sh && \/pickle-retry T<id>/);
});

test('pickle.md: phase Agent calls are ordered before validation', () => {
    const phaseStart = text.indexOf('## Phase 3.B');
    const validate = text.indexOf('validate-teams-ticket', phaseStart);
    let cursor = phaseStart;

    for (const phase of ['research', 'plan', 'implement', 'verify', 'review', 'refactor']) {
        const index = text.indexOf(`\`${phase}\` \u2192`, cursor);
        assert.ok(index > cursor, `${phase} phase dispatch should appear in order`);
        assert.ok(index < validate, `${phase} phase dispatch should appear before validation`);
        cursor = index;
    }
});

test('pickle.md: drives completion via TaskUpdate notifications', () => {
    assert.match(text, /TaskUpdate/, 'should mention TaskUpdate completion signal');
});

test('pickle.md: invokes validate-teams-ticket validator', () => {
    assert.match(text, /validate-teams-ticket/, 'should invoke the validator CLI');
});

test('pickle.md: teams brief injects project context before lifecycle guidance', () => {
    const phaseStart = text.indexOf('## Phase 3.B');
    const contextPath = text.indexOf('${SESSION_ROOT}/project-context.md', phaseStart);
    const contextBlock = text.indexOf('## Project Context', phaseStart);
    const placement = text.indexOf('before the phase instructions / 8-phase lifecycle guidance', phaseStart);

    assert.ok(phaseStart >= 0, 'should include Phase 3.B');
    assert.ok(contextPath > phaseStart, 'teams brief should reference project-context.md');
    assert.ok(contextBlock > contextPath, 'teams brief should name the Project Context block');
    assert.ok(placement > contextBlock, 'teams brief should require placement before lifecycle guidance');
});

test('pickle.md: legacy spawn-morty.js path remains for non-teams mode', () => {
    assert.match(text, /spawn-morty\.js/, 'legacy spawn-morty.js path should remain');
});

test('pickle.md: under 300 lines', () => {
    const lines = text.split('\n').length;
    assert.ok(lines < 300, `pickle.md is ${lines} lines, must stay under 300`);
});

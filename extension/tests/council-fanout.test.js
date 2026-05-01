import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planFanOut } from '../services/council-fanout.js';
import { validateSubagentPayload } from '../services/council-schema.js';

// T1: 3-branch s tier codex-off no-journal → 11 specs
test('T1: 3-branch s tier codex-off no-journal → 11 specs', () => {
    const branches = ['feat/alpha', 'feat/beta', 'feat/gamma'];
    const result = planFanOut({ stackTier: 's', branches, codexEnabled: false, hasMigrationJournal: false });
    assert.equal(result.length, 11);
    const bCats = result.filter(s => s.category.startsWith('B'));
    const cCorrectness = result.filter(s => s.category === 'C_correctness');
    const cCodex = result.filter(s => s.category === 'C_codex');
    assert.equal(bCats.length, 8);
    assert.equal(cCorrectness.length, 3);
    assert.equal(cCodex.length, 0);
    for (const s of bCats) assert.equal(s.branch, null);
});

// T2: 3-branch s tier codex-on journal → 13 specs
test('T2: 3-branch s tier codex-on journal → 13 specs', () => {
    const branches = ['feat/alpha', 'feat/beta', 'feat/gamma'];
    const result = planFanOut({ stackTier: 's', branches, codexEnabled: true, hasMigrationJournal: true });
    assert.equal(result.length, 13);
    const b7 = result.filter(s => s.category === 'B7_migration_hygiene');
    const cCodex = result.filter(s => s.category === 'C_codex');
    assert.equal(b7.length, 1);
    assert.equal(b7[0].branch, null);
    assert.equal(cCodex.length, 1);
    assert.equal(cCodex[0].branch, null);
});

// T3: 5-branch xl tier codex-on journal → 47 specs
test('T3: 5-branch xl tier codex-on journal → 47 specs', () => {
    const branches = ['feat/a', 'feat/b', 'feat/c', 'feat/d', 'feat/e'];
    const result = planFanOut({ stackTier: 'xl', branches, codexEnabled: true, hasMigrationJournal: true });
    assert.equal(result.length, 47);
    const shardedB = result.filter(s => s.category.startsWith('B') && s.category !== 'B7_migration_hygiene');
    assert.equal(shardedB.length, 40);
    for (const s of shardedB) assert.notEqual(s.branch, null);
    assert.equal(result.filter(s => s.category === 'B7_migration_hygiene').length, 1);
    assert.equal(result.filter(s => s.category === 'C_correctness').length, 5);
    assert.equal(result.filter(s => s.category === 'C_codex').length, 1);
});

// T4: 1-branch xxl tier codex-off no-journal → 9 specs
test('T4: 1-branch xxl tier codex-off no-journal → 9 specs', () => {
    const branches = ['feat/main-feature'];
    const result = planFanOut({ stackTier: 'xxl', branches, codexEnabled: false, hasMigrationJournal: false });
    assert.equal(result.length, 9);
    const bCats = result.filter(s => s.category.startsWith('B'));
    const cCorrectness = result.filter(s => s.category === 'C_correctness');
    assert.equal(bCats.length, 8);
    assert.equal(cCorrectness.length, 1);
    assert.equal(cCorrectness[0].branch, 'feat/main-feature');
    assert.equal(result.filter(s => s.category === 'C_codex').length, 0);
});

// T5: order assertion — first 8 specs at tier s are B-categories in stated order; last is C_codex
test('T5: order — B-categories first in stated order, C_codex last when enabled', () => {
    const branches = ['feat/one'];
    const result = planFanOut({ stackTier: 's', branches, codexEnabled: true, hasMigrationJournal: false });
    const expectedOrder = [
        'B1_stack_structure',
        'B2_claude_md',
        'B3_contract_discovery',
        'B4_cross_branch',
        'B5_test_coverage',
        'B6_security',
        'B8_szechuan',
        'B9_polish',
    ];
    for (let i = 0; i < 8; i++) {
        assert.equal(result[i].category, expectedOrder[i], `position ${i}: expected ${expectedOrder[i]}`);
    }
    assert.equal(result[result.length - 1].category, 'C_codex');
});

// T6: cross-validator — all returned categories accepted by validateSubagentPayload
test('T6: all returned categories accepted by validateSubagentPayload', () => {
    const branches = ['feat/x', 'feat/y'];
    const result = planFanOut({ stackTier: 'm', branches, codexEnabled: true, hasMigrationJournal: true });
    for (const spec of result) {
        assert.doesNotThrow(() => validateSubagentPayload({
            category: spec.category,
            branch: spec.branch,
            status: 'ok',
            skip_reason: null,
            findings: [],
            trap_door_candidates: [],
            codex_per_branch: null,
        }), `category ${spec.category} rejected by validateSubagentPayload`);
    }
});

// T7: C_correctness specs are alphabetically sorted by branch
test('T7: C_correctness specs alphabetical by branch', () => {
    const branches = ['feat/zebra', 'feat/apple', 'feat/mango'];
    const result = planFanOut({ stackTier: 's', branches, codexEnabled: false, hasMigrationJournal: false });
    const cCorrectness = result.filter(s => s.category === 'C_correctness');
    assert.deepEqual(
        cCorrectness.map(s => s.branch),
        ['feat/apple', 'feat/mango', 'feat/zebra'],
    );
});

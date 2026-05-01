import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMissingPrefixes } from '../services/artifact-validation.js';

test('findMissingPrefixes: returns no missing prefixes when exact and dated artifacts exist', () => {
    const files = ['research.md', 'plan_2026-04-30.md', 'notes.md'];
    const prefixes = ['research', 'plan'];

    assert.deepEqual(findMissingPrefixes(files, prefixes), []);
});

test('findMissingPrefixes: returns prefixes without exact or underscored file matches', () => {
    const files = ['research_2026-04-30.md', 'code_review.md'];
    const prefixes = ['research', 'plan', 'conformance', 'code_review'];

    assert.deepEqual(findMissingPrefixes(files, prefixes), ['plan', 'conformance']);
});

test('findMissingPrefixes: ignores prefix-adjacent filenames', () => {
    const files = ['researchy_notes.md', 'planning.md', 'code_reviewed.md'];
    const prefixes = ['research', 'plan', 'code_review'];

    assert.deepEqual(findMissingPrefixes(files, prefixes), ['research', 'plan', 'code_review']);
});

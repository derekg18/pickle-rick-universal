// Verifies parity between ScopeErrorCode type definition and thrown codes in
// scope-resolver.ts, and that command docs accurately reflect SCOPE_DRYRUN_CONFLICT
// as a prompt-level message (not a ScopeError code).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCOPE_RESOLVER_TS = path.resolve(__dirname, '../src/services/scope-resolver.ts');
const ANATOMY_PARK_MD = path.resolve(__dirname, '../../.claude/commands/anatomy-park.md');
const SZECHUAN_MD = path.resolve(__dirname, '../../.claude/commands/szechuan-sauce.md');

function extractTypeMembers(src) {
    const match = src.match(/export type ScopeErrorCode\s*=([\s\S]*?);/);
    if (!match) throw new Error('ScopeErrorCode type not found in scope-resolver.ts');
    return new Set([...match[1].matchAll(/'(SCOPE_[A-Z_]+)'/g)].map(m => m[1]));
}

function extractThrownCodes(src) {
    return new Set([...src.matchAll(/new ScopeError\(\s*'(SCOPE_[A-Z_]+)'/g)].map(m => m[1]));
}

const NON_CODE_REFS = new Set(['SCOPE_FLAG', 'SCOPE_BASE', 'SCOPE_LIMITATION']);
function extractDocCodes(content) {
    return new Set(
        [...content.matchAll(/\b(SCOPE_[A-Z_]+)\b/g)]
            .map(m => m[1])
            .filter(c => !NON_CODE_REFS.has(c)),
    );
}

test('ScopeErrorCode type members match thrown codes — no phantom types, no undeclared throws', () => {
    const src = fs.readFileSync(SCOPE_RESOLVER_TS, 'utf-8');
    const typeCodes = extractTypeMembers(src);
    const thrownCodes = extractThrownCodes(src);

    assert.ok(typeCodes.size > 0, 'ScopeErrorCode type must define at least one code');

    const phantomInType = [...typeCodes].filter(c => !thrownCodes.has(c));
    assert.deepStrictEqual(phantomInType, [],
        `ScopeErrorCode members never thrown: ${phantomInType.join(', ')}`);

    const thrownNotDeclared = [...thrownCodes].filter(c => !typeCodes.has(c));
    assert.deepStrictEqual(thrownNotDeclared, [],
        `Codes thrown but missing from ScopeErrorCode: ${thrownNotDeclared.join(', ')}`);
});

test('SCOPE_DRYRUN_CONFLICT in docs is prompt-level only — must not appear in ScopeErrorCode', () => {
    const src = fs.readFileSync(SCOPE_RESOLVER_TS, 'utf-8');
    const typeCodes = extractTypeMembers(src);
    const anatomyRefs = extractDocCodes(fs.readFileSync(ANATOMY_PARK_MD, 'utf-8'));
    const szechuanRefs = extractDocCodes(fs.readFileSync(SZECHUAN_MD, 'utf-8'));

    assert.ok(anatomyRefs.has('SCOPE_DRYRUN_CONFLICT'),
        'anatomy-park.md must document SCOPE_DRYRUN_CONFLICT as the prompt-level --scope + --dry-run error');
    assert.ok(szechuanRefs.has('SCOPE_DRYRUN_CONFLICT'),
        'szechuan-sauce.md must document SCOPE_DRYRUN_CONFLICT as the prompt-level --scope + --dry-run error');
    assert.ok(!typeCodes.has('SCOPE_DRYRUN_CONFLICT'),
        'SCOPE_DRYRUN_CONFLICT must NOT be in ScopeErrorCode — it is a prompt-level message, not a thrown ScopeError');
});

test('no unknown SCOPE_* codes in command docs — all must be in ScopeErrorCode or be SCOPE_DRYRUN_CONFLICT', () => {
    const src = fs.readFileSync(SCOPE_RESOLVER_TS, 'utf-8');
    const typeCodes = extractTypeMembers(src);
    const allDocCodes = new Set([
        ...extractDocCodes(fs.readFileSync(ANATOMY_PARK_MD, 'utf-8')),
        ...extractDocCodes(fs.readFileSync(SZECHUAN_MD, 'utf-8')),
    ]);

    const phantom = [...allDocCodes].filter(c => c !== 'SCOPE_DRYRUN_CONFLICT' && !typeCodes.has(c));
    assert.deepStrictEqual(phantom, [],
        `Docs reference SCOPE_* codes absent from ScopeErrorCode: ${phantom.join(', ')}`);
});

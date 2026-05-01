import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const COMMAND_PATH = path.resolve(import.meta.dirname, '../../../.claude/commands/szechuan-sauce.md');

function readCommand() {
    return fs.readFileSync(COMMAND_PATH, 'utf-8');
}

test('szechuan-sauce tmux chain invokes finalize-gate.js', () => {
    const content = readCommand();
    assert.ok(
        content.includes('finalize-gate.js'),
        'tmux send-keys chain must reference finalize-gate.js'
    );
    const gateLineIdx = content.indexOf('finalize-gate.js');
    const chainStart = content.lastIndexOf('tmux send-keys', gateLineIdx);
    assert.ok(chainStart !== -1, 'finalize-gate.js must appear inside a tmux send-keys block');
    const chainRegion = content.slice(chainStart, gateLineIdx + 50);
    assert.ok(
        chainRegion.includes('microverse-runner.js') && chainRegion.includes('&&'),
        'microverse-runner.js must precede finalize-gate.js with && operator'
    );
});

test('szechuan-sauce principle-filter preceded by GATE LAYERING comment block', () => {
    const content = readCommand();
    const commentMarker = '<!-- \nPRINCIPLE FILTER vs GATE LAYERING';
    const altMarker = '<!--\nPRINCIPLE FILTER vs GATE LAYERING';
    const hasComment = content.includes(commentMarker) || content.includes(altMarker);
    assert.ok(hasComment, 'PRINCIPLE FILTER vs GATE LAYERING comment block must be present');

    const stepMarker = '2.5. **Apply the false-positives filter';
    const commentPos = content.indexOf('PRINCIPLE FILTER vs GATE LAYERING');
    const stepPos = content.indexOf(stepMarker);
    assert.ok(commentPos !== -1, 'comment block must exist');
    assert.ok(stepPos !== -1, '2.5 step must exist');
    assert.ok(
        commentPos < stepPos,
        'PRINCIPLE FILTER comment must precede the 2.5 step'
    );
});

test('szechuan-sauce worker-internal print unchanged', () => {
    const content = readCommand();
    assert.ok(
        content.includes('If no violations found: print "The sauce is obtained." and exit cleanly'),
        'worker-internal print line must be unchanged'
    );
    assert.ok(
        !content.includes('If no violations found: print "The sauce is obtained. Gate green."'),
        'worker-internal print must NOT include gate messaging'
    );
});

test('szechuan-sauce trap-door sweep pins AC-CIT-17 missing negative spec behavior', () => {
    const content = readCommand();
    const start = content.indexOf('### Override 5: Trap-Door-as-Test Enforcement');
    const end = content.indexOf('### Override 6:', start);
    assert.ok(start !== -1, 'trap-door enforcement override must exist');
    assert.ok(end !== -1, 'trap-door enforcement override must be followed by Override 6');

    const section = content.slice(start, end);
    assert.ok(section.includes('AC-CIT-17 fixture behavior'), 'AC-CIT-17 fixture behavior must be explicit');
    assert.ok(section.includes('S3-key structural trap door'), 'S3-key fixture class must be named');
    assert.ok(section.includes('receiving-side validation spec is missing'), 'missing negative validation spec condition must be named');
    assert.ok(section.includes('P0 `trap door documented but not enforced` finding'), 'missing test must produce P0 exact-message finding');
});

test('szechuan-sauce trap-door findings carry Citadel T6 dedupe fields unchanged', () => {
    const content = readCommand();
    const start = content.indexOf('### Override 5: Trap-Door-as-Test Enforcement');
    const end = content.indexOf('### Override 6:', start);
    assert.ok(start !== -1, 'trap-door enforcement override must exist');
    assert.ok(end !== -1, 'trap-door enforcement override must be followed by Override 6');

    const section = content.slice(start, end);
    assert.ok(section.includes('claude_md_file'), 'finding must include claude_md_file');
    assert.ok(section.includes('bullet_text'), 'finding must include bullet_text');
    assert.ok(section.includes('(claude_md_file, bullet_text)'), 'dedupe tuple must be documented');
    assert.ok(section.includes('Do not alter either field for display formatting'), 'dedupe fields must remain stable');
});

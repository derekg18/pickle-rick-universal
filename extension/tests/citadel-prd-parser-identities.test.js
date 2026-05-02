import test from 'node:test';
import assert from 'node:assert';
import { parsePrdIdentities, parsePrdMarkdown } from '../services/citadel/prd-parser.js';

test('parsePrdIdentities extracts AC IDs and Section IDs', () => {
  const markdown = `
# Main Title
## Section 1
AC-FF-01 validates something.
### Subsection A
AC-CIT-02 is here.
## Section 2
- A1. Decision 1
AC-ID-1234
`;

  const identities = parsePrdIdentities(markdown);
  
  assert.deepStrictEqual(identities.acIds, ['AC-FF-01', 'AC-CIT-02', 'AC-ID-1234']);
  assert.deepStrictEqual(identities.sectionIds, ['Main Title', 'Section 1', 'Subsection A', 'Section 2']);
});

test('parsePrdMarkdown extracts sections', () => {
  const markdown = `
# Title
## Intro
Some text
### Details
More text
`;

  const parsed = parsePrdMarkdown(markdown);
  
  assert.strictEqual(parsed.sections.length, 3);
  assert.strictEqual(parsed.sections[0].id, 'Title');
  assert.strictEqual(parsed.sections[0].level, 1);
  assert.strictEqual(parsed.sections[1].id, 'Intro');
  assert.strictEqual(parsed.sections[1].level, 2);
  assert.strictEqual(parsed.sections[2].id, 'Details');
  assert.strictEqual(parsed.sections[2].level, 3);
});

test('parsePrdIdentities handles complex AC IDs', () => {
  const markdown = `
AC-FF-01-02-3
AC-GATE-HARD-1
AC-1
`;
  const identities = parsePrdIdentities(markdown);
  assert.deepStrictEqual(identities.acIds, ['AC-FF-01-02-3', 'AC-GATE-HARD-1', 'AC-1']);
});

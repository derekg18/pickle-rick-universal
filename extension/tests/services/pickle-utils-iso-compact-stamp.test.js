// SPDX-License-Identifier: MIT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isoCompactStamp } from '../../services/pickle-utils.js';

test('isoCompactStamp: deterministic on a fixed Date', () => {
  const fixed = new Date('2026-04-27T20:15:30.123Z');
  assert.equal(isoCompactStamp(fixed), '2026-04-27T20-15-30Z');
});

test('isoCompactStamp: default arg returns filename-safe stamp', () => {
  const out = isoCompactStamp();
  assert.match(
    out,
    /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/,
    `expected YYYY-MM-DDTHH-MM-SSZ, got: ${out}`
  );
});

test('isoCompactStamp: strips fractional seconds (no dots in output)', () => {
  const fixed = new Date('2026-04-27T00:00:00.999Z');
  const out = isoCompactStamp(fixed);
  assert.ok(!out.includes('.'), `expected no '.' in output, got: ${out}`);
  assert.ok(!out.includes(':'), `expected no ':' in output, got: ${out}`);
});

test('isoCompactStamp: handles year boundaries without dots/colons', () => {
  const fixed = new Date('2099-12-31T23:59:59.001Z');
  assert.equal(isoCompactStamp(fixed), '2099-12-31T23-59-59Z');
});

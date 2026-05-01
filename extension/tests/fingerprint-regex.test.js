import { test } from 'node:test';
import assert from 'node:assert/strict';

const RE = /^<!-- graph-fingerprint: ([a-f0-9]{64}) -->$/;

const valid64 = '0123456789abcdef'.repeat(4);

test('accepts valid 64-char lowercase hex fingerprint', () => {
  const m = RE.exec(`<!-- graph-fingerprint: ${valid64} -->`);
  assert.ok(m, 'should match');
  assert.equal(m[1], valid64);
});

test('rejects leading whitespace', () => {
  assert.equal(RE.exec(` <!-- graph-fingerprint: ${valid64} -->`), null);
});

test('rejects uppercase hex', () => {
  const upper = valid64.toUpperCase();
  assert.equal(RE.exec(`<!-- graph-fingerprint: ${upper} -->`), null);
});

test('rejects 63-char hex (too short)', () => {
  assert.equal(RE.exec(`<!-- graph-fingerprint: ${valid64.slice(0, 63)} -->`), null);
});

test('rejects 65-char hex (too long)', () => {
  assert.equal(RE.exec(`<!-- graph-fingerprint: ${valid64}a -->`), null);
});

test('rejects non-hex characters', () => {
  const withG = valid64.slice(0, 63) + 'g';
  assert.equal(RE.exec(`<!-- graph-fingerprint: ${withG} -->`), null);
});

test('rejects missing closing arrow', () => {
  assert.equal(RE.exec(`<!-- graph-fingerprint: ${valid64} --`), null);
});

test('rejects trailing content after marker', () => {
  assert.equal(RE.exec(`<!-- graph-fingerprint: ${valid64} --> extra`), null);
});

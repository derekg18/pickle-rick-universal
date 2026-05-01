import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DotBuilder } from '../services/dot-builder.js';
import { parseDot } from './__helpers__/dot-parse.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.join(__dirname, 'fixtures', 'dot-builder');

function buildDot(spec) {
  return DotBuilder.fromSpec(spec).build().dot;
}

function phase(name, overrides = {}) {
  return {
    name,
    prompt: `implement ${name}`,
    allowedPaths: [`src/${name}/`],
    timeout: '30m',
    ...overrides,
  };
}

function baseSpec(overrides = {}) {
  return {
    slug: 'emit-helper',
    goal: 'exercise extracted emit helper topology',
    phases: [],
    acceptanceCriteria: {},
    ...overrides,
  };
}

function convergenceSpec(overrides = {}) {
  return baseSpec({
    slug: 'emit-helper-convergence',
    phases: [phase('core')],
    acceptanceCriteria: {},
    convergence: {
      until: 'V_total == 0 && fixed_point && reproducibility',
      impl: { harness: 'claude-code', prompt: 'Implement convergence fixture' },
    },
    ...overrides,
  });
}

const goldenCases = {
  'fan-out': baseSpec({
    slug: 'emit-helper-fanout',
    phases: [phase('auth'), phase('api')],
    acceptanceCriteria: { auth_done: 'true', api_done: 'true' },
  }),
  competing: baseSpec({
    slug: 'emit-helper-competing',
    phases: [phase('solver', { competing: true })],
  }),
  convergence: convergenceSpec(),
  sequential: baseSpec({
    slug: 'emit-helper-sequential',
    phases: [phase('core')],
    acceptanceCriteria: { core_done: 'true' },
  }),
  microverse: baseSpec({
    slug: 'emit-helper-microverse',
    phases: [],
    microverse: {
      name: 'latency',
      opts: {
        prompt: 'reduce latency',
        measureCommand: 'npm run bench',
        target: 50,
        direction: 'reduce',
        allowedPaths: ['src/'],
        maxVisits: 8,
      },
    },
  }),
  'review-ratchet': baseSpec({
    slug: 'emit-helper-ratchet',
    phases: [phase('reviewed')],
    reviewRatchet: 3,
  }),
};

describe('DotBuilder emit helper topology snapshots', () => {
  for (const [name, spec] of Object.entries(goldenCases)) {
    it(`${name} topology matches golden DOT`, () => {
      const actual = buildDot(spec);
      const expected = fs.readFileSync(path.join(fixturesDir, `golden-${name}.dot`), 'utf8');
      assert.strictEqual(actual, expected);
    });
  }
});

describe('DotBuilder inline post-pass invariants', () => {
  it('P25 catastrophic recovery link remains inline after topology emission', () => {
    const dot = buildDot(baseSpec({
      slug: 'emit-helper-p25',
      phases: [phase('core')],
      acceptanceCriteria: { core_done: 'true' },
    }));
    const { edges } = parseDot(dot);
    const restartEdge = edges.find(e => e.from === 'regression_check' && e.to === 'setup_deps');
    assert.deepEqual(restartEdge, {
      from: 'regression_check',
      to: 'setup_deps',
      attrs: { loop_restart: 'true' },
    });
  });

  it('P0 isolated workspace splice rewires convergence terminal edge', () => {
    const dot = buildDot(convergenceSpec({ workspace: 'isolated' }));
    const { edges } = parseDot(dot);
    assert.ok(edges.some(e => e.from === 'repro_verify' && e.to === 'commit_and_push'));
    assert.ok(edges.some(e => e.from === 'commit_and_push' && e.to === 'done'));
    assert.ok(!edges.some(e => e.from === 'repro_verify' && e.to === 'done'));
  });
});

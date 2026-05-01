import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { _parseConvergenceSpec, _parsePhases } from '../services/dot-builder.js';

function phase(name, overrides = {}) {
  return {
    name,
    prompt: `implement ${name}`,
    allowedPaths: [`src/${name}/`],
    ...overrides,
  };
}

describe('DotBuilder fromSpec helper parsers', () => {
  it('parses valid phases without rewriting phase specs', () => {
    const phases = [
      phase('api', { timeout: '30m', dependsOn: ['model'] }),
      phase('ui', { competing: true, maxVisits: 4 }),
    ];

    assert.deepEqual(_parsePhases(phases), phases);
  });

  it('parses an empty phases array', () => {
    assert.deepEqual(_parsePhases([]), []);
  });

  it('returns null when convergence is missing or not a record', () => {
    assert.equal(_parseConvergenceSpec(undefined), null);
    assert.equal(_parseConvergenceSpec(null), null);
    assert.equal(_parseConvergenceSpec([]), null);
  });

  it('parses convergence with all handled fields present', () => {
    const convergence = {
      until: 'V_total == 0 && fixed_point && reproducibility',
      maxVisits: 9,
      timeout: '120m',
      impl: { harness: 'hermes', prompt: 'implement' },
      sealedFromSource: 'spec/prd.md',
      fixBackend: { model: 'backend-model', harness: 'claude-code', prompt: 'fix backend' },
      fixFrontend: { model: 'frontend-model', harness: 'claude-code', prompt: 'fix frontend' },
      mechanicalGates: { buildApi: 'npm run build:api', testsApi: 'npm test' },
      reviewers: { be: { model: 'be-review', harness: 'claude-code', prompt: 'review backend' } },
      adversary: { model: 'red', harness: 'claude-code', prompt: 'break it' },
      fpVerify: { command: 'npm run fp' },
      reproVerify: { command: 'npm run repro' },
      convergenceEpsilon: 0.01,
      maxIterations: 5,
    };

    assert.deepEqual(_parseConvergenceSpec(convergence), convergence);
  });

  it('tolerates null and undefined convergence fields like fromSpec inline parsing did', () => {
    const parsed = _parseConvergenceSpec({
      until: null,
      maxVisits: null,
      timeout: undefined,
      impl: { harness: undefined, prompt: null },
      sealedFromSource: undefined,
      fixBackend: null,
      fixFrontend: undefined,
      mechanicalGates: null,
      reviewers: undefined,
      adversary: null,
      fpVerify: undefined,
      reproVerify: null,
      convergenceEpsilon: undefined,
      maxIterations: null,
    });

    assert.deepEqual(parsed, {
      until: null,
      impl: { harness: 'claude-code', prompt: '' },
    });
  });

  it('rejects malformed phase shapes', () => {
    assert.throws(
      () => _parsePhases([{ prompt: 'missing name', allowedPaths: ['src/'] }]),
      (err) => err.name === 'BuildError' && err.code === 'INVALID_SPEC'
    );
  });
});

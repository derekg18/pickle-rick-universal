// Type contract tests — verify BuilderSpec, PhaseSpec, BuildError, Diagnostic,
// BuildResult, DefenseMatrix, ValidationResult, BuildErrorCode, MicroverseOpts,
// WorkspaceOpts, and StylesheetConfig match the PRD spec.
// Red phase: these fail until production type contracts are complete.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BuilderSpec, PhaseSpec, BuildError, Diagnostic,
  BuildResult, DefenseMatrix, ValidationResult,
  BuildErrorCode, MicroverseOpts, WorkspaceOpts,
  StylesheetConfig, DotBuilder,
} from '../services/dot-builder.js';

// ---------------------------------------------------------------------------
// (1) BuilderSpec — 13 fields: slug, goal, phases, acceptanceCriteria,
//     workingDir, label, defaultMaxRetry, workspace, workspaceOpts,
//     microverse, reviewRatchet, modelStylesheet, specFile
// ---------------------------------------------------------------------------
describe('BuilderSpec type contract', () => {
  it('validates a minimal valid spec (3 required fields + acceptanceCriteria)', () => {
    const spec = {
      slug: 'test-spec',
      goal: 'test goal',
      phases: [{ name: 'impl', prompt: 'do it', allowedPaths: ['src/'] }],
      acceptanceCriteria: { ac1: 'test' },
    };
    const result = BuilderSpec.validate(spec);
    assert.equal(result.valid, true);
    assert.equal(Array.isArray(result.diagnostics), true);
    assert.equal(result.diagnostics.length, 0);
  });

  it('rejects missing slug (EMPTY_SLUG)', () => {
    const spec = {
      goal: 'test',
      phases: [],
      acceptanceCriteria: {},
    };
    const result = BuilderSpec.validate(spec);
    assert.equal(result.valid, false);
    assert.ok(result.diagnostics.some(d => d.rule === 'EMPTY_SLUG'), 'should have EMPTY_SLUG diagnostic');
  });

  it('rejects missing goal (EMPTY_GOAL)', () => {
    const spec = {
      slug: 'test',
      phases: [],
      acceptanceCriteria: {},
    };
    const result = BuilderSpec.validate(spec);
    assert.equal(result.valid, false);
    assert.ok(result.diagnostics.some(d => d.rule === 'EMPTY_GOAL'), 'should have EMPTY_GOAL diagnostic');
  });

  it('rejects missing phases (INVALID_SPEC)', () => {
    const spec = { slug: 'test', goal: 'test', acceptanceCriteria: {} };
    const result = BuilderSpec.validate(spec);
    assert.equal(result.valid, false);
    assert.ok(result.diagnostics.some(d => d.rule === 'INVALID_SPEC'), 'should have INVALID_SPEC diagnostic');
  });

  it('rejects non-array phases (INVALID_SPEC)', () => {
    const spec = { slug: 'test', goal: 'test', phases: 'not-array', acceptanceCriteria: {} };
    const result = BuilderSpec.validate(spec);
    assert.equal(result.valid, false);
    assert.ok(result.diagnostics.some(d => d.rule === 'INVALID_SPEC'), 'should catch non-array phases');
  });

  it('rejects workspace value other than "isolated"', () => {
    const spec = {
      slug: 'test', goal: 'test', phases: [],
      acceptanceCriteria: {}, workspace: 'shared',
    };
    const result = BuilderSpec.validate(spec);
    assert.equal(result.valid, false);
    assert.ok(result.diagnostics.some(d => d.rule === 'INVALID_SPEC' && d.message.includes('workspace')), 'should reject workspace=shared');
  });

  it('accepts workspace = "isolated"', () => {
    const spec = {
      slug: 'test', goal: 'test', phases: [],
      acceptanceCriteria: {}, workspace: 'isolated',
    };
    const result = BuilderSpec.validate(spec);
    assert.equal(result.valid, true);
  });

  it('rejects reviewRatchet < 2 (INVALID_RATCHET)', () => {
    const spec = {
      slug: 'test', goal: 'test', phases: [],
      acceptanceCriteria: {}, reviewRatchet: 1,
    };
    const result = BuilderSpec.validate(spec);
    assert.equal(result.valid, false);
    assert.ok(result.diagnostics.some(d => d.rule === 'INVALID_RATCHET'), 'should have INVALID_RATCHET');
  });

  it('accepts reviewRatchet >= 2', () => {
    const spec = {
      slug: 'test', goal: 'test', phases: [],
      acceptanceCriteria: {}, reviewRatchet: 3,
    };
    const result = BuilderSpec.validate(spec);
    assert.equal(result.valid, true);
  });

  it('accepts all 13 optional fields', () => {
    const spec = {
      slug: 'full-spec',
      goal: 'build all the things',
      phases: [{ name: 'impl', prompt: 'do it', allowedPaths: ['src/'] }],
      acceptanceCriteria: { ac1: 'tests pass' },
      workingDir: '/tmp/test',
      label: 'full-pipeline',
      defaultMaxRetry: 5,
      workspace: 'isolated',
      workspaceOpts: { repoUrl: 'https://example.com', cleanup: 'preserve' },
      microverse: { name: 'perf', opts: { prompt: 'optimize', measureCommand: 'echo 42', target: 50, direction: 'reduce', allowedPaths: ['src/'] } },
      reviewRatchet: 2,
      modelStylesheet: { defaultModel: 'claude-sonnet-4-20250514' },
      specFile: 'spec/prd.md',
    };
    const result = BuilderSpec.validate(spec);
    assert.equal(result.valid, true, 'full BuilderSpec with all 13 optional fields should pass');
  });

  it('DotBuilder.fromSpec rejects non-object input', () => {
    assert.throws(() => DotBuilder.fromSpec(null), { name: 'BuildError' });
  });

  it('DotBuilder.fromSpec rejects missing phases array', () => {
    assert.throws(
      () => DotBuilder.fromSpec({ slug: 'x', goal: 'y' }),
      (err) => err.code === 'INVALID_SPEC'
    );
  });
});

// ---------------------------------------------------------------------------
// (2) PhaseSpec — required: name, prompt, allowedPaths
//     optional: dependsOn, contextOnSuccess, escalateOn, specFirst, goalGate,
//     retryTarget, timeout, threadId, securityScan, coverageTarget, competing,
//     redTeam, bddScenarios, docOnly
// ---------------------------------------------------------------------------
describe('PhaseSpec type contract', () => {
  it('validates a minimal phase (3 required fields)', () => {
    const phase = { name: 'impl', prompt: 'implement feature', allowedPaths: ['src/'] };
    const result = PhaseSpec.validate(phase);
    assert.equal(result.valid, true);
  });

  it('rejects missing name', () => {
    const phase = { prompt: 'do it', allowedPaths: ['src/'] };
    const result = PhaseSpec.validate(phase);
    assert.equal(result.valid, false);
    assert.ok(result.diagnostics.some(d => d.message === 'name is required'));
  });

  it('rejects empty name', () => {
    const phase = { name: '', prompt: 'do it', allowedPaths: ['src/'] };
    const result = PhaseSpec.validate(phase);
    assert.equal(result.valid, false);
  });

  it('rejects missing prompt', () => {
    const phase = { name: 'impl', allowedPaths: ['src/'] };
    const result = PhaseSpec.validate(phase);
    assert.equal(result.valid, false);
    assert.ok(result.diagnostics.some(d => d.message === 'prompt is required'));
  });

  it('accepts missing allowedPaths — preflight enforces this at build() time', () => {
    // PhaseSpec.validate deliberately does not flag missing allowedPaths —
    // the MISSING_ALLOWED_PATHS check is owned by DotBuilder.build() preflight
    // (services/dot-builder.js: "allowedPaths validated by preflight"),
    // so a fix/impl/refactor node without allowedPaths fails at build time, not validate time.
    const phase = { name: 'impl', prompt: 'do it' };
    const result = PhaseSpec.validate(phase);
    assert.equal(result.valid, true);
  });

  it('accepts dependsOn as string array', () => {
    const phase = {
      name: 'impl', prompt: 'do it', allowedPaths: ['src/'],
      dependsOn: ['setup', 'config'],
    };
    const result = PhaseSpec.validate(phase);
    assert.equal(result.valid, true);
  });

  it('rejects invalid dependsOn (not array)', () => {
    const phase = {
      name: 'impl', prompt: 'do it', allowedPaths: ['src/'],
      dependsOn: 'setup',
    };
    const result = PhaseSpec.validate(phase);
    assert.equal(result.valid, false);
    assert.ok(result.diagnostics.some(d => d.message.includes('dependsOn')), 'rejects non-array dependsOn');
  });

  it('rejects dependsOn with non-string elements', () => {
    const phase = {
      name: 'impl', prompt: 'do it', allowedPaths: ['src/'],
      dependsOn: ['setup', 42],
    };
    const result = PhaseSpec.validate(phase);
    assert.equal(result.valid, false);
  });

  it('accepts contextOnSuccess as Record<string,string>', () => {
    const phase = {
      name: 'impl', prompt: 'do it', allowedPaths: ['src/'],
      contextOnSuccess: { 'exit_code': '0', 'output': 'success' },
    };
    const result = PhaseSpec.validate(phase);
    assert.equal(result.valid, true);
  });

  it('accepts docOnly: true and sets docOnly on result', () => {
    const phase = {
      name: 'docs', prompt: 'write docs', allowedPaths: ['docs/'],
      docOnly: true,
    };
    const result = PhaseSpec.validate(phase);
    assert.equal(result.valid, true);
    assert.equal(result.docOnly, true, 'docOnly should propagate to validate result');
  });

  it('does not set docOnly when docOnly is false', () => {
    const phase = {
      name: 'impl', prompt: 'do it', allowedPaths: ['src/'],
      docOnly: false,
    };
    const result = PhaseSpec.validate(phase);
    assert.equal(result.valid, true);
    assert.equal(result.docOnly, undefined, 'docOnly should not be set when false');
  });

  it('accepts all optional fields together', () => {
    const phase = {
      name: 'full-phase',
      prompt: 'implement everything',
      allowedPaths: ['src/', 'tests/'],
      dependsOn: ['setup'],
      contextOnSuccess: { code: '0' },
      escalateOn: ['package.json'],
      specFirst: true,
      goalGate: true,
      retryTarget: 'fix_full_phase',
      timeout: '45m',
      threadId: 'phase_1',
      securityScan: true,
      coverageTarget: 80,
      competing: true,
      redTeam: true,
      bddScenarios: true,
      docOnly: false,
    };
    const result = PhaseSpec.validate(phase);
    assert.equal(result.valid, true, 'PhaseSpec with all optional fields should be valid');
  });

  it('accepts timeout as string', () => {
    const phase = { name: 'impl', prompt: 'do it', allowedPaths: ['src/'], timeout: '30m' };
    const result = PhaseSpec.validate(phase);
    assert.equal(result.valid, true);
  });

  it('accepts coverageTarget as number', () => {
    const phase = { name: 'impl', prompt: 'do it', allowedPaths: ['src/'], coverageTarget: 90 };
    const result = PhaseSpec.validate(phase);
    assert.equal(result.valid, true);
  });
});

// ---------------------------------------------------------------------------
// (3) BuildError extends Error with code and diagnostics
// ---------------------------------------------------------------------------
describe('BuildError type contract', () => {
  it('extends Error', () => {
    const err = new BuildError('EMPTY_SLUG', 'slug is required');
    assert.ok(err instanceof Error, 'BuildError should be instanceof Error');
    assert.equal(err.name, 'BuildError');
    assert.equal(err.message, 'slug is required');
  });

  it('has code field matching BuildErrorCode', () => {
    const err = new BuildError('EMPTY_GOAL', 'goal is required');
    assert.equal(err.code, 'EMPTY_GOAL');
  });

  it('has diagnostics field defaulting to empty array', () => {
    const err = new BuildError('INVALID_SPEC', 'bad spec');
    assert.ok(Array.isArray(err.diagnostics), 'diagnostics should be an array');
    assert.equal(err.diagnostics.length, 0, 'default diagnostics should be empty');
  });

  it('accepts custom diagnostics array', () => {
    const diag = { rule: 'test', severity: 'error', message: 'test diag' };
    const err = new BuildError('DUPLICATE_PHASE', 'duplicate', [diag]);
    assert.equal(err.diagnostics.length, 1);
    assert.equal(err.diagnostics[0].rule, 'test');
  });

  it('stack trace is available (Error behavior)', () => {
    const err = new BuildError('PLAN_MODE_DEADLOCK', 'stuck');
    assert.ok(typeof err.stack === 'string', 'stack should be a string');
    assert.ok(err.stack.includes('BuildError'), 'stack should mention BuildError');
  });

  it('is throwable and catchable', () => {
    assert.throws(
      () => { throw new BuildError('WORKSPACE_NO_HTTPS', 'bad url'); },
      { name: 'BuildError', code: 'WORKSPACE_NO_HTTPS' }
    );
  });
});

// ---------------------------------------------------------------------------
// (4) Diagnostic has rule/severity/message/nodeId/edge/fix
// ---------------------------------------------------------------------------
describe('Diagnostic type contract', () => {
  it('creates a minimal diagnostic (required fields only)', () => {
    const diag = Diagnostic.create({ rule: 'test-rule', severity: 'error', message: 'oops' });
    assert.equal(diag.rule, 'test-rule');
    assert.equal(diag.severity, 'error');
    assert.equal(diag.message, 'oops');
    assert.equal(diag.nodeId, undefined);
    assert.equal(diag.edge, undefined);
    assert.equal(diag.fix, undefined);
  });

  it('creates a full diagnostic with all fields', () => {
    const diag = Diagnostic.create({
      rule: 'DUPLICATE_PHASE',
      severity: 'warning',
      message: 'Phase "auth" duplicated',
      nodeId: 'auth',
      edge: ['start', 'auth'],
      fix: 'Rename one of the phases',
    });
    assert.equal(diag.rule, 'DUPLICATE_PHASE');
    assert.equal(diag.severity, 'warning');
    assert.equal(diag.message, 'Phase "auth" duplicated');
    assert.equal(diag.nodeId, 'auth');
    assert.deepStrictEqual(diag.edge, ['start', 'auth']);
    assert.equal(diag.fix, 'Rename one of the phases');
  });

  it('accepts severity "info"', () => {
    const diag = Diagnostic.create({ rule: 'info-rule', severity: 'info', message: 'just a note' });
    assert.equal(diag.severity, 'info');
  });

  it('throws on missing rule', () => {
    assert.throws(
      () => Diagnostic.create({ severity: 'error', message: 'no rule' }),
      /rule/i
    );
  });

  it('throws on empty rule', () => {
    assert.throws(
      () => Diagnostic.create({ rule: '', severity: 'error', message: 'no rule' }),
      /rule/i
    );
  });

  it('throws on invalid severity', () => {
    assert.throws(
      () => Diagnostic.create({ rule: 'test', severity: 'critical', message: 'bad' }),
      /severity/i
    );
  });

  it('throws on missing message', () => {
    assert.throws(
      () => Diagnostic.create({ rule: 'test', severity: 'error' }),
      /message/i
    );
  });

  it('throws on invalid edge (not array)', () => {
    assert.throws(
      () => Diagnostic.create({ rule: 'test', severity: 'error', message: 'bad edge', edge: 'start->impl' }),
      /edge/i
    );
  });

  it('throws on edge with wrong length', () => {
    assert.throws(
      () => Diagnostic.create({ rule: 'test', severity: 'error', message: 'bad edge', edge: ['a', 'b', 'c'] }),
      /edge/i
    );
  });

  it('throws on edge with non-string elements', () => {
    assert.throws(
      () => Diagnostic.create({ rule: 'test', severity: 'error', message: 'bad edge', edge: [1, 2] }),
      /edge/i
    );
  });

  it('throws when given non-object input', () => {
    assert.throws(
      () => Diagnostic.create('not an object'),
      /object/i
    );
  });
});

// ---------------------------------------------------------------------------
// (5) BuildResult has dot/slug/patternsApplied/defenseMatrix/diagnostics
// ---------------------------------------------------------------------------
describe('BuildResult type contract', () => {
  it('validates a correct BuildResult', () => {
    const result = BuildResult.validate({
      dot: 'digraph test {}',
      slug: 'test-pipeline',
      patternsApplied: ['P0a'],
      defenseMatrix: {
        competitive: false,
        guardrails: ['max_visits'],
        specDriven: 'conformance',
        permissions: ['allowed_paths'],
        adversarial: false,
      },
      diagnostics: [],
    });
    assert.equal(result.valid, true);
  });

  it('rejects missing dot', () => {
    const result = BuildResult.validate({
      slug: 'test', patternsApplied: [], defenseMatrix: {
        competitive: false, guardrails: [], specDriven: 'NONE',
        permissions: [], adversarial: false,
      },
      diagnostics: [],
    });
    assert.equal(result.valid, false);
    assert.ok(result.diagnostics.some(d => d.message.includes('dot')));
  });

  it('rejects empty dot', () => {
    const result = BuildResult.validate({
      dot: '', slug: 'test', patternsApplied: [], defenseMatrix: {
        competitive: false, guardrails: [], specDriven: 'NONE',
        permissions: [], adversarial: false,
      },
      diagnostics: [],
    });
    assert.equal(result.valid, false);
  });

  it('rejects missing slug', () => {
    const result = BuildResult.validate({
      dot: 'digraph {}', patternsApplied: [], defenseMatrix: {
        competitive: false, guardrails: [], specDriven: 'NONE',
        permissions: [], adversarial: false,
      },
      diagnostics: [],
    });
    assert.equal(result.valid, false);
  });

  it('rejects non-array patternsApplied', () => {
    const result = BuildResult.validate({
      dot: 'digraph {}', slug: 'test', patternsApplied: 'P0a', defenseMatrix: {
        competitive: false, guardrails: [], specDriven: 'NONE',
        permissions: [], adversarial: false,
      },
      diagnostics: [],
    });
    assert.equal(result.valid, false);
  });

  it('rejects missing defenseMatrix', () => {
    const result = BuildResult.validate({
      dot: 'digraph {}', slug: 'test', patternsApplied: [], diagnostics: [],
    });
    // Should fail because defenseMatrix is missing — but the current validate
    // doesn't check defenseMatrix. If this test fails to detect the missing
    // field, the production code needs to be updated.
    assert.equal(result.valid, false, 'BuildResult.validate should reject missing defenseMatrix');
  });

  it('rejects non-array diagnostics', () => {
    const result = BuildResult.validate({
      dot: 'digraph {}', slug: 'test', patternsApplied: [], defenseMatrix: {
        competitive: false, guardrails: [], specDriven: 'NONE',
        permissions: [], adversarial: false,
      },
      diagnostics: 'not-array',
    });
    assert.equal(result.valid, false);
  });
});

// ---------------------------------------------------------------------------
// (6) DefenseMatrix has competitive/guardrails/specDriven/permissions/adversarial
// ---------------------------------------------------------------------------
describe('DefenseMatrix type contract', () => {
  it('validates a correct DefenseMatrix', () => {
    const result = DefenseMatrix.validate({
      competitive: true,
      guardrails: ['max_visits', 'no-op'],
      specDriven: 'spec_file + BDD + conformance',
      permissions: ['allowed_paths', 'escalate_on'],
      adversarial: true,
    });
    assert.equal(result.valid, true);
  });

  it('rejects missing competitive', () => {
    const result = DefenseMatrix.validate({
      guardrails: [], specDriven: 'NONE', permissions: [], adversarial: false,
    });
    assert.equal(result.valid, false);
    assert.ok(result.diagnostics.some(d => d.message.includes('competitive')));
  });

  it('rejects missing adversarial', () => {
    const result = DefenseMatrix.validate({
      competitive: false, guardrails: [], specDriven: 'NONE', permissions: [],
    });
    assert.equal(result.valid, false);
    assert.ok(result.diagnostics.some(d => d.message.includes('adversarial')));
  });

  it('rejects non-array guardrails', () => {
    const result = DefenseMatrix.validate({
      competitive: false, guardrails: 'max_visits', specDriven: 'NONE',
      permissions: [], adversarial: false,
    });
    assert.equal(result.valid, false);
  });

  it('rejects non-array permissions', () => {
    const result = DefenseMatrix.validate({
      competitive: false, guardrails: [], specDriven: 'NONE',
      permissions: 'allowed_paths', adversarial: false,
    });
    assert.equal(result.valid, false);
  });

  it('rejects invalid specDriven value', () => {
    const result = DefenseMatrix.validate({
      competitive: false, guardrails: [], specDriven: 'agile',
      permissions: [], adversarial: false,
    });
    assert.equal(result.valid, false);
    assert.ok(result.diagnostics.some(d => d.message.includes('specDriven')));
  });

  it('accepts all valid specDriven values', () => {
    const validSpecDriven = ['NONE', 'conformance', 'BDD + conformance', 'spec_file + conformance', 'spec_file + BDD + conformance'];
    for (const sd of validSpecDriven) {
      const result = DefenseMatrix.validate({
        competitive: false, guardrails: [], specDriven: sd,
        permissions: [], adversarial: false,
      });
      assert.equal(result.valid, true, `specDriven="${sd}" should be valid`);
    }
  });
});

// ---------------------------------------------------------------------------
// (7) ValidationResult has valid/diagnostics
// ---------------------------------------------------------------------------
describe('ValidationResult type contract', () => {
  it('validates a correct ValidationResult', () => {
    const result = ValidationResult.validate({
      valid: true,
      diagnostics: [],
    });
    assert.equal(result.valid, true);
  });

  it('validates ValidationResult with diagnostics', () => {
    const result = ValidationResult.validate({
      valid: false,
      diagnostics: [{ rule: 'test', severity: 'error', message: 'fail' }],
    });
    assert.equal(result.valid, true, 'Validate a ValidationResult object');
    assert.equal(result.diagnostics.length, 0, 'No structural errors in that ValidationResult');
  });

  it('rejects missing valid field', () => {
    const result = ValidationResult.validate({ diagnostics: [] });
    assert.equal(result.valid, false);
    assert.ok(result.diagnostics.some(d => d.message.includes('valid')));
  });

  it('rejects non-array diagnostics', () => {
    const result = ValidationResult.validate({ valid: true, diagnostics: 'bad' });
    assert.equal(result.valid, false);
    assert.ok(result.diagnostics.some(d => d.message.includes('diagnostics')));
  });

  it('rejects non-object input', () => {
    const result = ValidationResult.validate('not-object');
    assert.equal(result.valid, false);
  });
});

// ---------------------------------------------------------------------------
// (8) BuildErrorCode is a union of string literals
// ---------------------------------------------------------------------------
describe('BuildErrorCode type contract', () => {
  const expectedCodes = [
    'EMPTY_SLUG', 'EMPTY_GOAL', 'DUPLICATE_PHASE', 'INVALID_RATCHET',
    'NON_NUMERIC_TARGET', 'ALREADY_BUILT', 'INVALID_STRUCTURE', 'START_HAS_INCOMING',
    'UNREACHABLE_NODE', 'DIAMOND_MISSING_EDGES', 'GOAL_GATE_NO_MAX_VISITS',
    'MISSING_AC_MAPPING', 'MISSING_TIMEOUT', 'PROMPT_PATH_MISMATCH',
    'REVIEW_MISSING_READONLY', 'COMPONENT_NO_MERGE', 'FAN_OUT_SCOPE_LEAK',
    'WORKSPACE_NO_HTTPS', 'WORKSPACE_NO_PUSH', 'PLAN_MODE_DEADLOCK',
    'MISSING_ALLOWED_PATHS', 'INVALID_SPEC',
    'INVALID_TIMEOUT', 'INVALID_ALLOWED_PATHS',
    'DUPLICATE_MODEL', 'INVALID_CONVERGENCE_SPEC',
  ];

  it('BuildErrorCode export exists and is an array', () => {
    assert.ok(Array.isArray(BuildErrorCode), 'BuildErrorCode should be an array');
  });

  it('contains exactly 26 error codes', () => {
    assert.equal(BuildErrorCode.length, 26, `expected 26 codes, got ${BuildErrorCode.length}`);
  });

  it('contains all expected codes', () => {
    for (const code of expectedCodes) {
      assert.ok(BuildErrorCode.includes(code), `missing code: ${code}`);
    }
  });

  it('BUILD_ERROR_CODES is identical to BuildErrorCode', async () => {
    const { BUILD_ERROR_CODES } = await import('../services/dot-builder.js');
    assert.deepStrictEqual(BUILD_ERROR_CODES, BuildErrorCode,
      'BUILD_ERROR_CODES and BuildErrorCode should be identical');
  });
});

// ---------------------------------------------------------------------------
// (9) MicroverseOpts / WorkspaceOpts / StylesheetConfig shapes
// ---------------------------------------------------------------------------
describe('MicroverseOpts type contract', () => {
  it('validates a minimal MicroverseOpts', () => {
    const opts = {
      prompt: 'optimize latency',
      measureCommand: 'echo 42',
      target: 50,
      direction: 'reduce',
      allowedPaths: ['src/'],
    };
    const result = MicroverseOpts.validate(opts);
    assert.equal(result.valid, true);
  });

  it('rejects missing prompt', () => {
    const opts = {
      measureCommand: 'echo 42', target: 50,
      direction: 'reduce', allowedPaths: ['src/'],
    };
    const result = MicroverseOpts.validate(opts);
    assert.equal(result.valid, false);
    assert.ok(result.diagnostics.some(d => d.message === 'prompt is required'));
  });

  it('rejects missing measureCommand', () => {
    const opts = {
      prompt: 'optimize', target: 50,
      direction: 'reduce', allowedPaths: ['src/'],
    };
    const result = MicroverseOpts.validate(opts);
    assert.equal(result.valid, false);
    assert.ok(result.diagnostics.some(d => d.message === 'measureCommand is required'));
  });

  it('rejects non-numeric target (NON_NUMERIC_TARGET)', () => {
    const opts = {
      prompt: 'optimize', measureCommand: 'echo 42',
      target: 'fifty', direction: 'reduce', allowedPaths: ['src/'],
    };
    const result = MicroverseOpts.validate(opts);
    assert.equal(result.valid, false);
    assert.ok(result.diagnostics.some(d => d.rule === 'NON_NUMERIC_TARGET'));
  });

  it('rejects invalid direction', () => {
    const opts = {
      prompt: 'optimize', measureCommand: 'echo 42',
      target: 50, direction: 'explode', allowedPaths: ['src/'],
    };
    const result = MicroverseOpts.validate(opts);
    assert.equal(result.valid, false);
  });

  it('accepts both direction values', () => {
    const base = { prompt: 'opt', measureCommand: 'echo 1', target: 1, allowedPaths: ['src/'] };
    assert.equal(MicroverseOpts.validate({ ...base, direction: 'reduce' }).valid, true);
    assert.equal(MicroverseOpts.validate({ ...base, direction: 'improve' }).valid, true);
  });

  it('rejects missing allowedPaths (MISSING_ALLOWED_PATHS)', () => {
    const opts = {
      prompt: 'optimize', measureCommand: 'echo 42',
      target: 50, direction: 'reduce',
    };
    const result = MicroverseOpts.validate(opts);
    assert.equal(result.valid, false);
    assert.ok(result.diagnostics.some(d => d.rule === 'MISSING_ALLOWED_PATHS'));
  });

  it('accepts optional timeout', () => {
    const opts = {
      prompt: 'optimize', measureCommand: 'echo 42',
      target: 50, direction: 'reduce', allowedPaths: ['src/'],
      timeout: '60m',
    };
    const result = MicroverseOpts.validate(opts);
    assert.equal(result.valid, true);
  });

  it('accepts valid maxVisits (positive integer >= 1)', () => {
    const base = { prompt: 'opt', measureCommand: 'echo 1', target: 1, direction: 'reduce', allowedPaths: ['src/'] };
    assert.equal(MicroverseOpts.validate({ ...base, maxVisits: 1 }).valid, true);
    assert.equal(MicroverseOpts.validate({ ...base, maxVisits: 8 }).valid, true);
    assert.equal(MicroverseOpts.validate({ ...base, maxVisits: 100 }).valid, true);
  });

  it('rejects non-positive maxVisits', () => {
    const opts = {
      prompt: 'optimize', measureCommand: 'echo 42',
      target: 50, direction: 'reduce', allowedPaths: ['src/'],
      maxVisits: 0,
    };
    const result = MicroverseOpts.validate(opts);
    assert.equal(result.valid, false);
  });

  it('rejects float maxVisits', () => {
    const opts = {
      prompt: 'optimize', measureCommand: 'echo 42',
      target: 50, direction: 'reduce', allowedPaths: ['src/'],
      maxVisits: 3.5,
    };
    const result = MicroverseOpts.validate(opts);
    assert.equal(result.valid, false);
  });
});

describe('WorkspaceOpts type contract', () => {
  it('validates minimal WorkspaceOpts (empty object)', () => {
    const result = WorkspaceOpts.validate({});
    assert.equal(result.valid, true);
  });

  it('accepts valid cleanup values', () => {
    assert.equal(WorkspaceOpts.validate({ cleanup: 'delete' }).valid, true);
    assert.equal(WorkspaceOpts.validate({ cleanup: 'preserve' }).valid, true);
  });

  it('rejects invalid cleanup value', () => {
    const result = WorkspaceOpts.validate({ cleanup: 'archive' });
    assert.equal(result.valid, false);
    assert.ok(result.diagnostics.some(d => d.message.includes('cleanup')));
  });

  it('accepts repoUrl and repoBranch', () => {
    const result = WorkspaceOpts.validate({
      repoUrl: 'https://github.com/user/repo.git',
      repoBranch: 'main',
    });
    assert.equal(result.valid, true);
  });
});

describe('StylesheetConfig type contract', () => {
  it('validates minimal StylesheetConfig', () => {
    const result = StylesheetConfig.validate({ defaultModel: 'claude-sonnet-4' });
    assert.equal(result.valid, true);
  });

  it('rejects missing defaultModel', () => {
    const result = StylesheetConfig.validate({});
    assert.equal(result.valid, false);
    assert.ok(result.diagnostics.some(d => d.message === 'defaultModel is required'));
  });

  it('accepts all optional fields', () => {
    const result = StylesheetConfig.validate({
      defaultModel: 'claude-sonnet-4',
      defaultProvider: 'anthropic',
      criticalModel: 'claude-opus-4',
      criticalProvider: 'anthropic',
      reviewModel: 'claude-sonnet-4',
      reviewProvider: 'anthropic',
      reasoningEffort: 'high',
    });
    assert.equal(result.valid, true);
  });
});

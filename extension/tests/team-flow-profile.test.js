import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  evaluateTeamFlowGate,
  hasDeterministicNoSensitivePathsClassifier,
  resolveTeamFlowProfile,
} from '../services/team-flow-profile.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'team-flow-profile-'));
}

function writeArtifact(root, relativePath, body = 'ok') {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, body);
}

function fullProfile(root) {
  return resolveTeamFlowProfile({
    mode: 'full',
    backend: 'codex',
    sessionRoot: root,
    workingDir: root,
  });
}

describe('team-flow profile', () => {
  test('builds the full profile in PRD order', () => {
    const root = tmpDir();
    const profile = fullProfile(root);

    assert.equal(profile.mode, 'full');
    assert.deepEqual(profile.phases.map((phase) => phase.id), [
      'product_intake',
      'ready_gate',
      'architecture_review',
      'implementation',
      'test_engineering',
      'ci_simulation',
      'code_review',
      'security_risk_review',
      'qa_acceptance',
      'release_management',
      'retrospective',
    ]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('declares every required PRD artifact', () => {
    const root = tmpDir();
    const profile = fullProfile(root);
    const artifacts = profile.artifacts.map((artifact) => artifact.path);

    for (const expected of [
      'team-flow/product_brief.md',
      'team-flow/ready_gate_report.json',
      'team-flow/ready_gate_report.md',
      'team-flow/architecture_review.md',
      'team-flow/implementation_log.md',
      'team-flow/test_plan.md',
      'team-flow/ci_report.json',
      'team-flow/ci_report.md',
      'team-flow/review_comments.json',
      'team-flow/review_comments.md',
      'team-flow/security_risk_report.md',
      'team-flow/qa_acceptance.md',
      'team-flow/release_notes.md',
      'team-flow/rollback_plan.md',
      'team-flow/retro.md',
    ]) {
      assert.ok(artifacts.includes(expected), `missing ${expected}`);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('fails a gate when required inputs are missing', () => {
    const root = tmpDir();
    const profile = fullProfile(root);

    const gate = evaluateTeamFlowGate(profile, 'ready_gate', root);

    assert.equal(gate.phaseId, 'ready_gate');
    assert.equal(gate.status, 'fail');
    assert.deepEqual(gate.missingArtifacts, ['team-flow/product_brief.md']);
    assert.match(gate.remediation, /team-flow\/product_brief\.md/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('passes a gate when required inputs exist', () => {
    const root = tmpDir();
    const profile = fullProfile(root);
    writeArtifact(root, 'team-flow/product_brief.md');

    const gate = evaluateTeamFlowGate(profile, 'ready_gate', root);

    assert.equal(gate.status, 'pass');
    assert.deepEqual(gate.missingArtifacts, []);
    assert.equal(gate.remediation, null);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('security skip is accepted only for deterministic no-sensitive-path classifier', () => {
    const root = tmpDir();
    const profile = fullProfile(root);
    writeArtifact(root, 'team-flow/review_comments.json', '{}');
    writeArtifact(root, 'team-flow/review_comments.md');

    let gate = evaluateTeamFlowGate(profile, 'security_risk_review', root);
    assert.equal(gate.status, 'pass');

    fs.rmSync(path.join(root, 'team-flow'), { recursive: true, force: true });
    writeArtifact(root, 'team-flow/review_comments.json', '{}');
    writeArtifact(root, 'team-flow/review_comments.md');
    writeArtifact(root, 'team-flow/security_classifier.json', JSON.stringify({
      classifier: 'deterministic_no_sensitive_paths',
      sensitivePathChanges: false,
    }));
    gate = evaluateTeamFlowGate(profile, 'security_risk_review', root);
    assert.equal(gate.status, 'skipped');
    assert.equal(hasDeterministicNoSensitivePathsClassifier(root), true);

    fs.rmSync(path.join(root, 'team-flow'), { recursive: true, force: true });
    writeArtifact(root, 'team-flow/security_classifier.json', JSON.stringify({
      classifier: 'manual_low_risk',
      sensitivePathChanges: false,
    }));
    gate = evaluateTeamFlowGate(profile, 'security_risk_review', root);
    assert.equal(gate.status, 'fail');
    assert.equal(hasDeterministicNoSensitivePathsClassifier(root), false);

    fs.rmSync(root, { recursive: true, force: true });
  });

  test('security skip still requires review artifacts from the previous phase', () => {
    const root = tmpDir();
    const profile = fullProfile(root);
    writeArtifact(root, 'team-flow/security_classifier.json', JSON.stringify({
      classifier: 'deterministic_no_sensitive_paths',
      sensitivePathChanges: false,
    }));

    const gate = evaluateTeamFlowGate(profile, 'security_risk_review', root);

    assert.equal(gate.status, 'fail');
    assert.deepEqual(gate.missingArtifacts, [
      'team-flow/review_comments.json',
      'team-flow/review_comments.md',
    ]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('qa gate requires review artifacts when deterministic classifier replaces security output', () => {
    const root = tmpDir();
    const profile = fullProfile(root);
    writeArtifact(root, 'team-flow/security_classifier.json', JSON.stringify({
      classifier: 'deterministic_no_sensitive_paths',
      sensitivePathChanges: false,
    }));

    const gate = evaluateTeamFlowGate(profile, 'qa_acceptance', root);

    assert.equal(gate.status, 'fail');
    assert.deepEqual(gate.missingArtifacts, [
      'team-flow/review_comments.json',
      'team-flow/review_comments.md',
    ]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('qa gate accepts deterministic security skip only after review artifacts exist', () => {
    const root = tmpDir();
    const profile = fullProfile(root);
    writeArtifact(root, 'team-flow/review_comments.json', '{}');
    writeArtifact(root, 'team-flow/review_comments.md');
    writeArtifact(root, 'team-flow/security_classifier.json', JSON.stringify({
      classifier: 'deterministic_no_sensitive_paths',
      sensitivePathChanges: false,
    }));

    const gate = evaluateTeamFlowGate(profile, 'qa_acceptance', root);

    assert.equal(gate.status, 'pass');
    assert.deepEqual(gate.missingArtifacts, []);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

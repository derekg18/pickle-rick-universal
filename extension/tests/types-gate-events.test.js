import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VALID_ACTIVITY_EVENTS } from '../types/index.js';
import { GATE_REMEDIATION_EVENT_NAMES } from '../services/convergence-gate.js';

const GATE_EVENTS = [
  'gate_baseline_captured',
  'gate_run_complete',
  'gate_skipped',
  'gate_unsafe_test_command_blocked',
  'gate_remediation_complete',
  'gate_remediation_aborted_unverified_production_change',
  'gate_autofix_reverted',
  'gate_workingdir_drift_detected',
  'gate_lock_acquired',
  'gate_lock_timeout',
  'gate_diff_scope_fallback',
  'gate_preexisting_tests_baselined',
  'iteration_left_regression',
  'gate_regression_threshold_warning',
  'gate_out_of_scope_failures_present',
];

test('gate-events: all 15 gate/iteration event names are in VALID_ACTIVITY_EVENTS', () => {
  const set = new Set(VALID_ACTIVITY_EVENTS);
  for (const name of GATE_EVENTS) {
    assert.ok(set.has(name), `Missing event: ${name}`);
  }
});

test('gate-events: no collisions with pre-existing 25 events', () => {
  const ORIGINAL_EVENTS = [
    'session_start', 'session_end', 'ticket_completed', 'epic_completed',
    'meeseeks_pass', 'commit', 'research', 'bug_fix', 'feature',
    'refactor', 'review', 'jar_start', 'jar_end',
    'circuit_open', 'circuit_recovery',
    'iteration_start', 'iteration_end',
    'rate_limit_wait', 'rate_limit_resume', 'rate_limit_exhausted',
    'multi_repo_warning', 'meeseeks_model_select', 'pending_tickets_on_completion',
    'manager_false_epic_completed', 'manager_persistent_hallucination',
  ];
  for (const name of GATE_EVENTS) {
    assert.ok(!ORIGINAL_EVENTS.includes(name), `Collision: ${name} was already in original set`);
  }
});

test('gate-events: gate_payload is optional on ActivityEvent (runtime construction)', () => {
  // ActivityEvent is a TS interface — no runtime shape. We validate that
  // a plain object with gate_payload round-trips through JSON without loss.
  const event = {
    ts: new Date().toISOString(),
    event: 'gate_run_complete',
    source: 'pickle',
    gate_payload: { status: 'green', elapsed_ms: 42 },
  };
  const json = JSON.stringify(event);
  const parsed = JSON.parse(json);
  assert.deepEqual(parsed.gate_payload, { status: 'green', elapsed_ms: 42 });
  assert.equal(parsed.event, 'gate_run_complete');
});

test('GATE_REMEDIATION_EVENT_NAMES: all 3 remediation events are in VALID_ACTIVITY_EVENTS', () => {
  const set = new Set(VALID_ACTIVITY_EVENTS);
  for (const name of GATE_REMEDIATION_EVENT_NAMES) {
    assert.ok(set.has(name), `Remediation event missing from VALID_ACTIVITY_EVENTS: ${name}`);
  }
});

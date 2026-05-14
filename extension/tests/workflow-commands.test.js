import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  getCommandSpec,
} from '../services/host-command-registry.js';
import {
  runDeprecatedMeeseeksRouting,
  runVindicatorWorkflow,
  runWorkflowCommand,
} from '../services/workflow-commands.js';

describe('workflow command group', () => {
  test('/vindicators creates N solver plans and one judge result from fixtures', () => {
    const result = runVindicatorWorkflow({
      problem: 'Choose a cache backend',
      solverCount: 3,
      solverFixtures: [
        { id: 'solver-a', strategy: 'redis', summary: 'Use Redis for shared cache.' },
        { id: 'solver-b', strategy: 'sqlite', summary: 'Use SQLite for local cache.' },
        { id: 'solver-c', strategy: 'memory', summary: 'Use process memory.' },
      ],
      judgeFixture: [
        { solver_id: 'solver-a', score: 7 },
        { solver_id: 'solver-b', score: 9 },
        { solver_id: 'solver-c', score: 3 },
      ],
    });

    assert.equal(result.status, 'success');
    assert.equal(result.command, 'vindicators');
    assert.equal(result.solver_plans?.length, 3);
    assert.equal(result.judge_result?.status, 'selected');
    assert.equal(result.judge_result?.winner_id, 'solver-b');
    assert.equal(result.judge_result?.selected_solution_summary, 'Use SQLite for local cache.');
    assert.equal(result.judge_result?.scores.length, 3);
  });

  test('judge tie returns needs_followup with tied solver ids', () => {
    const result = runVindicatorWorkflow({
      problem: 'Pick a deployment path',
      solverFixtures: [
        { id: 'alpha', summary: 'Blue-green deploy.' },
        { id: 'beta', summary: 'Canary deploy.' },
        { id: 'gamma', summary: 'Rolling deploy.' },
      ],
      judgeFixture: [
        { solver_id: 'alpha', score: 10 },
        { solver_id: 'beta', score: 10 },
        { solver_id: 'gamma', score: 4 },
      ],
    });

    assert.equal(result.status, 'needs_followup');
    assert.equal(result.judge_result?.status, 'needs_followup');
    assert.equal(result.judge_result?.code, 'JUDGE_TIE');
    assert.deepEqual(result.judge_result?.tied_solver_ids, ['alpha', 'beta']);
  });

  test('/two-brothers, /story-train, and delivery analytics probes return valid command results', () => {
    const commands = ['two-brothers', 'story-train', 'wubba-lubba-dub-dub'];
    for (const command of commands) {
      const result = runWorkflowCommand(command, {
        problem: 'Probe command result',
        solverCount: command === 'two-brothers' ? 2 : 3,
      });

      assert.equal(result.command, command);
      assert.equal(result.status, 'success');
      assert.equal(typeof result.summary, 'string');
      assert.equal(result.workflow?.kind, 'workflow-probe');
      assert.ok(result.workflow?.analytics.solver_count);
    }

    const delivery = runWorkflowCommand('wubba-lubba-dub-dub', { problem: 'Probe delivery' });
    assert.equal(delivery.workflow?.analytics.delivery_probe, 'delivery-analytics');
  });

  test('/meeseeks* remain registered and emit deprecation routing to /vindicators', () => {
    for (const command of ['meeseeks', 'meeseeks-zellij']) {
      assert.notEqual(getCommandSpec(command), null);
      const result = runDeprecatedMeeseeksRouting(command, 'Review this change');
      assert.equal(result.status, 'success');
      assert.equal(result.deprecation?.deprecated, true);
      assert.equal(result.deprecation?.replacement, '/vindicators');
      assert.equal(result.deprecation?.routed_command, 'vindicators');
      assert.match(result.summary, /\/vindicators/);
    }
  });
});

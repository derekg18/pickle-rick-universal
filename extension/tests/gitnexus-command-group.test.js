import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runGitNexusCommandGroup,
  runGitNexusCommandGroupByName,
} from '../services/gitnexus-command-group.js';

const fixedContext = {
  workspaceDir: '/repo',
  now: new Date('2026-05-13T00:00:00.000Z'),
};

test('/death-crystal constructs GitNexus impact and query requests from a symbol fixture', () => {
  const result = runGitNexusCommandGroup('death-crystal', ['validateUser', '--format=markdown'], fixedContext);

  assert.equal(result.status, 'success');
  assert.equal(result.command, 'death-crystal');
  assert.equal(result.artifact.kind, 'gitnexus-command-summary');
  assert.equal(result.artifact.target, 'validateUser');
  assert.equal(result.artifact.format, 'markdown');
  assert.equal(result.artifact.skeleton, false);
  assert.deepEqual(result.artifact.requests, [
    {
      tool: 'gitnexus_impact',
      args: {
        target: 'validateUser',
        direction: 'upstream',
        maxDepth: 3,
      },
    },
    {
      tool: 'gitnexus_query',
      args: {
        query: 'execution flows and dependencies for validateUser',
      },
    },
  ]);
});

test('/death-crystal stale GitNexus index produces typed remediation without predictive output', () => {
  const result = runGitNexusCommandGroup('death-crystal', ['validateUser'], {
    ...fixedContext,
    gitnexusResponse: {
      warning: 'Index is stale. Run npx gitnexus analyze before querying.',
    },
  });

  assert.equal(result.status, 'needs_followup');
  assert.match(result.summary, /not produced/);
  assert.match(result.remediation, /npx gitnexus analyze/);
  assert.equal(result.artifact.skeleton, true);
  assert.equal(result.artifact.requests[0].tool, 'gitnexus_impact');
});

test('/death-crystal reports missing symbol target as failed result JSON', () => {
  const result = runGitNexusCommandGroup('death-crystal', [], fixedContext);

  assert.equal(result.status, 'failed');
  assert.match(result.summary, /No symbol target/);
  assert.equal(result.artifact.target, null);
});

test('dependency, clone, and coverage commands return valid result artifacts or typed skeletons', () => {
  const commands = [
    ['portal-fluid', 'dependency graph'],
    ['operation-phoenix', 'clone candidates'],
    ['blips-and-chitz', 'coverage gaps'],
  ];

  for (const [command, queryFragment] of commands) {
    const result = runGitNexusCommandGroupByName(command, ['src/services', '--format', 'json'], fixedContext);

    assert.equal(result.status, 'success');
    assert.equal(result.command, command);
    assert.equal(result.artifact.kind, 'gitnexus-command-summary');
    assert.equal(result.artifact.target, 'src/services');
    assert.equal(result.artifact.skeleton, true);
    assert.equal(result.artifact.requests[0].tool, 'gitnexus_query');
    assert.match(String(result.artifact.requests[0].args.query), new RegExp(queryFragment));
  }
});

test('group commands return stale-index followup remediation from warning fixtures', () => {
  const result = runGitNexusCommandGroup('portal-fluid', ['src/services'], {
    ...fixedContext,
    gitnexusResponse: 'missing GitNexus index for repository',
  });

  assert.equal(result.status, 'needs_followup');
  assert.match(result.remediation, /npx gitnexus analyze/);
  assert.equal(result.artifact.skeleton, true);
});

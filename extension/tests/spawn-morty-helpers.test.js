import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildWorkerPrompt,
  isPhasePersonasEnabled,
  resolveEffectiveTimeout,
  resolvePhasePersonaModel,
  resolveWorkerModelFromTierAndPersona,
} from '../bin/spawn-morty.js';

const GITNEXUS_MARKER = '# GITNEXUS CODE INTELLIGENCE (auto-detected)';

function makeTmpDir(prefix = 'pickle-spawn-morty-helpers-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function baseTicket(repoRoot) {
  return {
    task: 'implement helper tests',
    ticketContent: '# Ticket',
    ticketId: 'ticket-helper',
    ticketPath: path.join(repoRoot, 'ticket-helper'),
    sessionRoot: repoRoot,
    backend: 'claude',
    isReviewTicket: false,
  };
}

function writePhasePersonaFixture(extensionRoot, agentsDir, step = 'implement') {
  fs.mkdirSync(path.join(extensionRoot, 'extension', 'data'), { recursive: true });
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(extensionRoot, 'persona.md'), 'Base Rick voice.');
  fs.writeFileSync(path.join(extensionRoot, 'extension', 'data', 'phase-personas.json'), JSON.stringify({
    version: 1,
    [step]: {
      subagent_type: 'morty-phase-implementer',
      complexity_tier_default: 'large',
      model: 'opus',
    },
  }, null, 2));
  fs.writeFileSync(path.join(agentsDir, 'morty-phase-implementer.md'), [
    '---',
    'name: morty-phase-implementer',
    'description: Implementer',
    'tools: Read, Edit, Write, Bash, Glob, Grep',
    'model: opus',
    'role: phase-implementer',
    'identity: Apply the plan.',
    'communication_style: terse',
    'principles[]: ["Do the work."]',
    '---',
    '',
    'Phase implementer specialization.',
    '',
  ].join('\n'));
}

function withPhasePersonaEnv(value, fn) {
  const previous = process.env.PICKLE_PHASE_PERSONAS;
  if (value === undefined) delete process.env.PICKLE_PHASE_PERSONAS;
  else process.env.PICKLE_PHASE_PERSONAS = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.PICKLE_PHASE_PERSONAS;
    else process.env.PICKLE_PHASE_PERSONAS = previous;
  }
}

test('buildWorkerPrompt: injects GitNexus instructions when .gitnexus is a directory', () => {
  const repoRoot = makeTmpDir();
  try {
    fs.mkdirSync(path.join(repoRoot, '.gitnexus'));
    const prompt = buildWorkerPrompt({ ticket: baseTicket(repoRoot), model: 'sonnet', repoRoot });
    assert.ok(prompt.includes(GITNEXUS_MARKER));
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('buildWorkerPrompt: omits GitNexus instructions when .gitnexus is absent', () => {
  const repoRoot = makeTmpDir();
  try {
    const prompt = buildWorkerPrompt({ ticket: baseTicket(repoRoot), model: 'sonnet', repoRoot });
    assert.equal(prompt.includes(GITNEXUS_MARKER), false);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('buildWorkerPrompt: omits GitNexus instructions when .gitnexus is a file', () => {
  const repoRoot = makeTmpDir();
  try {
    fs.writeFileSync(path.join(repoRoot, '.gitnexus'), 'not a directory');
    const prompt = buildWorkerPrompt({ ticket: baseTicket(repoRoot), model: 'sonnet', repoRoot });
    assert.equal(prompt.includes(GITNEXUS_MARKER), false);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('buildWorkerPrompt: injects project context before ticket content when available', () => {
  const repoRoot = makeTmpDir();
  try {
    fs.writeFileSync(path.join(repoRoot, 'project-context.md'), 'Architecture\n- Existing shape');
    const prompt = buildWorkerPrompt({ ticket: baseTicket(repoRoot), model: 'sonnet', repoRoot });

    const contextIndex = prompt.indexOf('## Project Context\nArchitecture\n- Existing shape');
    const ticketIndex = prompt.indexOf('# TARGET TICKET CONTENT');
    const executionIndex = prompt.indexOf('# EXECUTION CONTEXT');

    assert.ok(contextIndex > -1, 'should include project context block');
    assert.ok(contextIndex < ticketIndex, 'project context should precede target ticket content');
    assert.ok(ticketIndex < executionIndex, 'target ticket content should precede execution context');
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('buildWorkerPrompt: injects active persona between template and project context when enabled', () => {
  const repoRoot = makeTmpDir();
  const extensionRoot = makeTmpDir('pickle-spawn-morty-extension-');
  const agentsDir = makeTmpDir('pickle-spawn-morty-agents-');
  try {
    writePhasePersonaFixture(extensionRoot, agentsDir);
    fs.writeFileSync(path.join(repoRoot, 'state.json'), JSON.stringify({ step: 'implement' }, null, 2));
    fs.writeFileSync(path.join(repoRoot, 'project-context.md'), 'Architecture\n- Existing shape');
    const prompt = withPhasePersonaEnv('on', () => {
      return buildWorkerPrompt({
        ticket: baseTicket(repoRoot),
        model: 'opus',
        repoRoot,
        extensionRoot,
        agentsDir,
      });
    });

    const templateIndex = prompt.indexOf('implement helper tests');
    const personaIndex = prompt.indexOf('## Active Persona\nBase Rick voice.');
    const phaseIndex = prompt.indexOf('Phase implementer specialization.');
    const contextIndex = prompt.indexOf('## Project Context\nArchitecture\n- Existing shape');
    const ticketIndex = prompt.indexOf('# TARGET TICKET CONTENT');
    const executionIndex = prompt.indexOf('# EXECUTION CONTEXT');
    const tailIndex = prompt.indexOf('**IMPORTANT**: You are a localized worker.');

    assert.ok(templateIndex > -1, 'should include template body');
    assert.ok(personaIndex > templateIndex, 'active persona should follow template body');
    assert.ok(phaseIndex > personaIndex, 'phase body should be inside active persona block');
    assert.ok(contextIndex > phaseIndex, 'project context should follow active persona');
    assert.ok(ticketIndex > contextIndex, 'target ticket content should follow project context');
    assert.ok(executionIndex > ticketIndex, 'execution context should follow target ticket content');
    assert.ok(tailIndex > executionIndex, 'localized-worker tail should follow execution context');
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
    fs.rmSync(agentsDir, { recursive: true, force: true });
  }
});

test('buildWorkerPrompt: phase personas default off and record disabled event once', () => {
  const repoRoot = makeTmpDir();
  const extensionRoot = makeTmpDir('pickle-spawn-morty-extension-');
  const agentsDir = makeTmpDir('pickle-spawn-morty-agents-');
  const logs = [];
  const originalLog = console.log;
  try {
    writePhasePersonaFixture(extensionRoot, agentsDir);
    fs.writeFileSync(path.join(repoRoot, 'state.json'), JSON.stringify({ step: 'implement' }, null, 2));
    console.log = (message) => { logs.push(String(message)); };

    const firstPrompt = withPhasePersonaEnv(undefined, () => buildWorkerPrompt({
      ticket: baseTicket(repoRoot),
      model: 'sonnet',
      repoRoot,
      extensionRoot,
      agentsDir,
    }));
    const secondPrompt = withPhasePersonaEnv(undefined, () => buildWorkerPrompt({
      ticket: baseTicket(repoRoot),
      model: 'sonnet',
      repoRoot,
      extensionRoot,
      agentsDir,
    }));

    assert.equal(firstPrompt.includes('## Active Persona'), false);
    assert.equal(secondPrompt.includes('## Active Persona'), false);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /feature available but disabled/);

    const state = JSON.parse(fs.readFileSync(path.join(repoRoot, 'state.json'), 'utf-8'));
    const disabledEvents = state.activity.filter((entry) => entry.event === 'phase_personas_disabled_seen');
    assert.equal(disabledEvents.length, 1);
  } finally {
    console.log = originalLog;
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
    fs.rmSync(agentsDir, { recursive: true, force: true });
  }
});

test('phase persona enablement: env and settings opt in, model is gated', () => {
  const repoRoot = makeTmpDir();
  const extensionRoot = makeTmpDir('pickle-spawn-morty-extension-');
  const agentsDir = makeTmpDir('pickle-spawn-morty-agents-');
  try {
    writePhasePersonaFixture(extensionRoot, agentsDir);
    fs.writeFileSync(path.join(repoRoot, 'state.json'), JSON.stringify({ step: 'implement' }, null, 2));

    assert.equal(withPhasePersonaEnv(undefined, () => isPhasePersonasEnabled(extensionRoot)), false);
    assert.equal(withPhasePersonaEnv(undefined, () => resolvePhasePersonaModel(repoRoot, extensionRoot)), undefined);
    assert.equal(withPhasePersonaEnv('on', () => isPhasePersonasEnabled(extensionRoot)), true);
    assert.equal(withPhasePersonaEnv('on', () => resolvePhasePersonaModel(repoRoot, extensionRoot)), 'opus');
    assert.equal(withPhasePersonaEnv('off', () => isPhasePersonasEnabled(extensionRoot)), false);

    fs.writeFileSync(path.join(extensionRoot, 'pickle_settings.json'), JSON.stringify({
      bmad_hardening: { phase_personas_enabled: true },
    }, null, 2));
    assert.equal(withPhasePersonaEnv(undefined, () => isPhasePersonasEnabled(extensionRoot)), true);
    assert.equal(withPhasePersonaEnv('off', () => isPhasePersonasEnabled(extensionRoot)), false);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
    fs.rmSync(agentsDir, { recursive: true, force: true });
  }
});

test('buildWorkerPrompt: omits active persona when phase mapping is absent', () => {
  const repoRoot = makeTmpDir();
  const extensionRoot = makeTmpDir('pickle-spawn-morty-extension-');
  const agentsDir = makeTmpDir('pickle-spawn-morty-agents-');
  try {
    writePhasePersonaFixture(extensionRoot, agentsDir, 'research');
    fs.writeFileSync(path.join(repoRoot, 'state.json'), JSON.stringify({ step: 'implement' }, null, 2));
    const prompt = buildWorkerPrompt({
      ticket: baseTicket(repoRoot),
      model: 'sonnet',
      repoRoot,
      extensionRoot,
      agentsDir,
    });

    assert.equal(prompt.includes('## Active Persona'), false);
    assert.equal(prompt.includes('Phase implementer specialization.'), false);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
    fs.rmSync(agentsDir, { recursive: true, force: true });
  }
});

test('buildWorkerPrompt: omits project context when session disables archaeology', () => {
  const repoRoot = makeTmpDir();
  try {
    fs.writeFileSync(path.join(repoRoot, 'project-context.md'), 'Architecture\n- Existing shape');
    fs.writeFileSync(path.join(repoRoot, 'state.json'), JSON.stringify({
      flags: { no_archaeology: true },
    }, null, 2));
    const prompt = buildWorkerPrompt({ ticket: baseTicket(repoRoot), model: 'sonnet', repoRoot });

    assert.equal(prompt.includes('## Project Context'), false);
    assert.equal(prompt.includes('- Existing shape'), false);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('resolveEffectiveTimeout: clamps configured timeout to remaining wall-clock budget', () => {
  const startEpoch = 1_700_000_000;
  const nowMs = (startEpoch + 555) * 1000;
  const state = {
    max_time_minutes: 10,
    start_time_epoch: startEpoch,
  };

  assert.equal(resolveEffectiveTimeout(300, state, nowMs), 45);
});

test('resolveWorkerModelFromTierAndPersona: ticket tier precedes persona default', () => {
  assert.equal(resolveWorkerModelFromTierAndPersona('large', 'sonnet'), 'opus');
  assert.equal(resolveWorkerModelFromTierAndPersona(undefined, 'opus'), 'opus');
  assert.equal(resolveWorkerModelFromTierAndPersona(undefined, undefined), 'sonnet');
});

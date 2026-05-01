#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAgentMd } from '../services/agent-md-loader.js';
import { logActivity } from '../services/activity-logger.js';
import { resolveBackend } from '../services/backend-spawn.js';
import { getExtensionRoot, isoCompactStamp } from '../services/pickle-utils.js';
import { readRecoverableJsonObject } from '../services/recoverable-json.js';
import { StateManager } from '../services/state-manager.js';
import type { Backend, State } from '../types/index.js';
import { DEBATE_PERSONAS, type DebatePersonaName } from './generate-debate-personas.js';

const DEFAULT_PERSONAS: DebatePersonaName[] = ['researcher', 'architect', 'implementer', 'skeptic'];
const MIN_PERSONA_COUNT = 2;
const MAX_PERSONA_COUNT = 6;
const SHARED_CONTEXT_WORD_CAP = 600;
const RESPONSE_WORD_CAP = 800;
const REQUIRED_TOOLS = ['Read', 'Glob', 'Grep'];
const AUTO_PROMOTE_BANNER = '[debate] codex backend detected — auto-promoting to --solo (use --strict-teams to require parallel subagents and fail-fast on codex). Sequential debate starting; estimated cost: $0.40, est. wall-clock: 90s. Continue? [Y/n]';
const STRICT_TEAMS_CODEX_ERROR = 'debate: --strict-teams requires claude backend; current: codex; remove --strict-teams to allow auto-promote, or switch backend';
const PRIOR_CONTEXT_BYTE_CAP = 12_000;

const DEFAULT_DEBATE_SETTINGS: DebateSettings = {
  debateMaxRounds: 5,
  debateCodexSoloMaxRounds: 2,
  debateMinRoundsConfirm: 3,
};

export interface DebateArgs {
  sessionDir: string;
  repoRoot: string;
  question: string;
  personas: DebatePersonaName[];
  n: number;
  solo: boolean;
  strictTeams: boolean;
  noStrictTeams: boolean;
  continueDebate: boolean;
  confirmMultiRound: boolean;
  acceptStale: boolean;
  dryRun: boolean;
  agentsDir?: string;
}

export interface DebateSettings {
  debateMaxRounds: number;
  debateCodexSoloMaxRounds: number;
  debateMinRoundsConfirm: number;
}

export interface DebateRunOptions {
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
  now?: () => Date;
  stateManager?: StateManager;
  logActivityFn?: typeof logActivity;
  confirmAutoPromote?: (banner: string) => boolean;
  settings?: Partial<DebateSettings>;
  extensionRoot?: string;
}

export interface DebateRunResult {
  exitCode: number;
  briefPath: string;
  brief: string;
  mode: DebateMode;
}

type DebateMode = 'teams' | 'solo' | 'solo (auto)';

interface ResolvedDebateRun {
  args: DebateArgs;
  backend: Backend;
  mode: DebateMode;
  declinedAutoPromote: boolean;
}

interface LoadedDebateState {
  state: State | null;
  statePath: string;
}

interface DebateStateFlag {
  question: string;
  round: number;
  round1_tickets_version: number;
  round1_personas: DebatePersonaName[];
  brief_paths: string[];
  last_generated_at: string;
}

interface PreparedDebateRound {
  round: number;
  round1TicketsVersion: number;
  newPersonas: DebatePersonaName[];
  priorContext: string;
  truncatedBytes: number;
  previousBriefPaths: string[];
}

interface DebateRoundError {
  error: string;
  exitCode: number;
}

interface ValidatedDebateAgent {
  persona: DebatePersonaName;
  agentName: string;
  sourcePath: string;
}

function usage(): never {
  process.stderr.write('Usage: node debate.js "<question>" --session-dir <dir> [--repo-root <dir>] [--personas r,a,i,s] [--n <2-6>] [--solo] [--strict-teams] [--no-strict-teams] [--continue] [--confirm-multi-round] [--accept-stale] [--dry-run]\n');
  process.exit(1);
}

export function parseArgs(argv: string[]): DebateArgs {
  const sessionDir = readFlag(argv, '--session-dir');
  if (!sessionDir) usage();

  const nValue = readFlag(argv, '--n');
  const n = nValue ? parseCount(nValue) : DEFAULT_PERSONAS.length;
  const personas = resolvePersonas(readFlag(argv, '--personas'), n);
  const question = readQuestion(argv);
  validateQuestion(question);

  return {
    sessionDir: path.resolve(sessionDir),
    repoRoot: path.resolve(readFlag(argv, '--repo-root') ?? process.cwd()),
    question,
    personas,
    n,
    solo: argv.includes('--solo'),
    strictTeams: argv.includes('--strict-teams'),
    noStrictTeams: argv.includes('--no-strict-teams'),
    continueDebate: argv.includes('--continue'),
    confirmMultiRound: argv.includes('--confirm-multi-round'),
    acceptStale: argv.includes('--accept-stale'),
    dryRun: argv.includes('--dry-run'),
    agentsDir: readFlag(argv, '--agents-dir'),
  };
}

function readFlag(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) usage();
  return value;
}

function flagTakesValue(flag: string): boolean {
  return ['--session-dir', '--repo-root', '--personas', '--n', '--agents-dir'].includes(flag);
}

function readQuestion(argv: string[]): string {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value.startsWith('--')) {
      if (flagTakesValue(value)) index += 1;
      continue;
    }
    values.push(value);
  }
  return values.join(' ').trim();
}

function parseCount(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error('--n must be an integer from 2 to 6.');
  const count = Number(value);
  if (count < MIN_PERSONA_COUNT || count > MAX_PERSONA_COUNT) {
    throw new Error('--n must be an integer from 2 to 6.');
  }
  return count;
}

function validateQuestion(question: string): void {
  if (question.length === 0) throw new Error('Debate question is required.');
}

function resolvePersonas(csv: string | undefined, n: number): DebatePersonaName[] {
  if (!csv) {
    if (n > DEFAULT_PERSONAS.length) {
      throw new Error(`Only ${DEFAULT_PERSONAS.length} debate personas are available in this build.`);
    }
    return DEFAULT_PERSONAS.slice(0, n);
  }

  const aliases = new Map<string, DebatePersonaName>([
    ['r', 'researcher'],
    ['a', 'architect'],
    ['i', 'implementer'],
    ['s', 'skeptic'],
    ['researcher', 'researcher'],
    ['architect', 'architect'],
    ['implementer', 'implementer'],
    ['skeptic', 'skeptic'],
  ]);
  const seen = new Set<DebatePersonaName>();
  const personas: DebatePersonaName[] = [];
  for (const item of csv.split(',')) {
    const persona = aliases.get(item.trim().toLowerCase());
    if (!persona) throw new Error(`Unknown debate persona: ${item.trim()}`);
    if (!seen.has(persona)) {
      seen.add(persona);
      personas.push(persona);
    }
  }
  if (personas.length < MIN_PERSONA_COUNT) {
    throw new Error(`At least ${MIN_PERSONA_COUNT} debate personas are required.`);
  }
  if (personas.length > n) {
    throw new Error('--personas cannot select more entries than --n.');
  }
  return personas;
}

function boundedInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback;
  if (value < min || value > max) return fallback;
  return value;
}

function loadDebateSettings(extensionRoot: string, overrides?: Partial<DebateSettings>): DebateSettings {
  const settingsPath = path.join(extensionRoot, 'pickle_settings.json');
  const raw = readRecoverableJsonObject(settingsPath) as Record<string, unknown> | null;
  const hardening = raw?.bmad_hardening;
  const bag = hardening && typeof hardening === 'object' && !Array.isArray(hardening)
    ? hardening as Record<string, unknown>
    : {};
  return {
    debateMaxRounds: overrides?.debateMaxRounds ?? boundedInt(
      bag.debate_max_rounds,
      1,
      10,
      DEFAULT_DEBATE_SETTINGS.debateMaxRounds,
    ),
    debateCodexSoloMaxRounds: overrides?.debateCodexSoloMaxRounds ?? boundedInt(
      bag.debate_codex_solo_max_rounds,
      1,
      5,
      DEFAULT_DEBATE_SETTINGS.debateCodexSoloMaxRounds,
    ),
    debateMinRoundsConfirm: overrides?.debateMinRoundsConfirm ?? boundedInt(
      bag.debate_min_rounds_confirm,
      1,
      10,
      DEFAULT_DEBATE_SETTINGS.debateMinRoundsConfirm,
    ),
  };
}

function validateDebateAgents(args: DebateArgs): ValidatedDebateAgent[] {
  return args.personas.map((persona) => {
    const agentName = `morty-debater-${persona}`;
    const loaded = loadAgentMd(agentName, { agentsDir: args.agentsDir });
    if (!loaded) throw new Error(`Missing debate agent markdown: ${agentName}.md`);
    if (loaded.frontmatter.name !== agentName) {
      throw new Error(`Debate agent ${loaded.path} frontmatter name must be ${agentName}.`);
    }
    if (loaded.frontmatter.tools.join(',') !== REQUIRED_TOOLS.join(',')) {
      throw new Error(`Debate agent ${loaded.path} tools must be exactly Read, Glob, Grep.`);
    }
    return { persona, agentName, sourcePath: loaded.path };
  });
}

function renderPriorContext(prepared?: PreparedDebateRound): string[] {
  if (!prepared) return [];
  const lines = [
    '## Round Context',
    '',
    `- round: ${prepared.round}`,
    `- round1_tickets_version: ${prepared.round1TicketsVersion}`,
    `- prior_briefs: ${prepared.previousBriefPaths.length}`,
    `- prior_context_truncated_bytes: ${prepared.truncatedBytes}`,
  ];
  if (prepared.newPersonas.length > 0) {
    lines.push(
      `- New round-${prepared.round} personas: ${prepared.newPersonas.join(', ')} weren't in round 1, read for context.`,
    );
  }
  if (prepared.priorContext) {
    lines.push('', '### Prior Debate Context', '', prepared.priorContext);
  }
  return [...lines, ''];
}

export function buildDebateBrief(args: DebateArgs, createdAt: Date, agents = validateDebateAgents(args), mode: DebateMode = args.solo ? 'solo' : 'teams', prepared?: PreparedDebateRound): string {
  validateQuestion(args.question);
  const personaRows = agents.map((agent) => `- ${agent.persona}: ${agent.agentName} (${agent.sourcePath})`);
  const personaTitles = args.personas
    .map((persona) => DEBATE_PERSONAS.find((definition) => definition.name === persona)?.title ?? persona)
    .join(', ');

  return [
    '# Debate Brief',
    '',
    `Generated: ${createdAt.toISOString()}`,
    `Session root: ${args.sessionDir}`,
    `Repository root: ${args.repoRoot}`,
    '',
    '## Question',
    '',
    args.question,
    '',
    '## Mode Flags',
    '',
    `- mode: ${mode}`,
    `- solo: ${args.solo}`,
    `- strict_teams: ${args.strictTeams}`,
    `- no_strict_teams: ${args.noStrictTeams}`,
    `- continue: ${args.continueDebate}`,
    `- confirm_multi_round: ${args.confirmMultiRound}`,
    `- accept_stale: ${args.acceptStale}`,
    `- round: ${prepared?.round ?? 1}`,
    `- n: ${args.n}`,
    '',
    ...renderPriorContext(prepared),
    '## Persona Agents',
    '',
    ...personaRows,
    '',
    '## Shared Context Budget',
    '',
    `- Cap shared context sent to each subagent at ${SHARED_CONTEXT_WORD_CAP} words.`,
    `- Cap each persona response at ${RESPONSE_WORD_CAP} words.`,
    '- Include the debate question, current repository/session paths, selected personas, and relevant prior debate context when continuing.',
    '',
    '## Orchestrator Contract',
    '',
    '- This helper only prepares the brief. It must not spawn agents, create teams, edit state, or synthesize a verdict.',
    '- The command prompt creates a debate team, dispatches selected persona agents in parallel, deletes the team, and writes the final debate markdown.',
    `- Selected personas: ${personaTitles}.`,
    '- Final output keeps one full section per persona. Synthesis is out of scope for this helper.',
    '',
  ].join('\n');
}

function loadDebateState(sessionDir: string, stateManager: StateManager): LoadedDebateState {
  const statePath = path.join(sessionDir, 'state.json');
  try {
    return { state: stateManager.read(statePath), statePath };
  } catch {
    return { state: null, statePath };
  }
}

function persistStrictTeamsFlag(statePath: string, stateManager: StateManager): void {
  stateManager.update(statePath, (state) => {
    state.flags ??= {};
    state.flags.strict_teams = true;
  });
}

function readTicketsVersion(state: State | null): number {
  return typeof state?.tickets_version === 'number' && Number.isFinite(state.tickets_version)
    ? state.tickets_version
    : 0;
}

function isDebateStateFlag(value: unknown): value is DebateStateFlag {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.question === 'string'
    && typeof record.round === 'number'
    && Number.isInteger(record.round)
    && typeof record.round1_tickets_version === 'number'
    && Number.isInteger(record.round1_tickets_version)
    && Array.isArray(record.round1_personas)
    && record.round1_personas.every((item) => typeof item === 'string')
    && Array.isArray(record.brief_paths)
    && record.brief_paths.every((item) => typeof item === 'string')
    && typeof record.last_generated_at === 'string';
}

function readDebateFlag(state: State | null): DebateStateFlag | null {
  const value = state?.flags?.debate;
  return isDebateStateFlag(value) ? value : null;
}

function listDebateResultFiles(sessionDir: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(sessionDir);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => /^debate_.*\.md$/.test(entry) && !entry.endsWith('_brief.md'))
    .sort()
    .reverse()
    .map((entry) => path.join(sessionDir, entry));
}

function readPriorContext(sessionDir: string, previousBriefPaths: string[]): { text: string; truncatedBytes: number } {
  const candidates = [...listDebateResultFiles(sessionDir), ...previousBriefPaths.slice().reverse()];
  const seen = new Set<string>();
  let remaining = PRIOR_CONTEXT_BYTE_CAP;
  let truncatedBytes = 0;
  const chunks: string[] = [];

  for (const filePath of candidates) {
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    const header = `--- ${filePath} ---\n`;
    const block = `${header}${content.trim()}\n`;
    const bytes = Buffer.byteLength(block, 'utf8');
    if (remaining <= 0) {
      truncatedBytes += bytes;
      continue;
    }
    if (bytes <= remaining) {
      chunks.push(block);
      remaining -= bytes;
      continue;
    }
    const slice = Buffer.from(block, 'utf8').subarray(0, remaining).toString('utf8');
    chunks.push(slice);
    truncatedBytes += bytes - Buffer.byteLength(slice, 'utf8');
    remaining = 0;
  }

  return { text: chunks.join('\n').trim(), truncatedBytes };
}

function debateRoundError(exitCode: number, error: string): DebateRoundError {
  return { exitCode, error };
}

function rejectMissingPrior(args: DebateArgs, prior: DebateStateFlag | null): DebateRoundError | null {
  if (!args.continueDebate || prior) return null;
  return debateRoundError(1, 'debate: --continue requires prior debate state in state.json.flags.debate.');
}

function rejectRoundLimit(round: number, settings: DebateSettings): DebateRoundError | null {
  if (round <= settings.debateMaxRounds) return null;
  return debateRoundError(1, `debate: round ${round} exceeds debate_max_rounds=${settings.debateMaxRounds}.`);
}

function rejectMissingRoundConfirmation(args: DebateArgs, round: number, settings: DebateSettings): DebateRoundError | null {
  if (round < settings.debateMinRoundsConfirm || args.confirmMultiRound) return null;
  return debateRoundError(1, `debate: round ${round} requires --continue --confirm-multi-round.`);
}

function rejectStaleTicketsVersion(
  args: DebateArgs,
  round: number,
  currentTicketsVersion: number,
  round1TicketsVersion: number,
  emitActivity: typeof logActivity,
): DebateRoundError | null {
  if (!args.continueDebate || args.acceptStale || currentTicketsVersion === round1TicketsVersion) return null;
  emitActivity({
    event: 'debate_invalidated_by_correction',
    source: 'pickle',
    session: path.basename(args.sessionDir),
    expected_tickets_version: round1TicketsVersion,
    actual_tickets_version: currentTicketsVersion,
    round,
  });
  return debateRoundError(
    1,
    `debate: tickets_version changed from ${round1TicketsVersion} to ${currentTicketsVersion}; rerun with --accept-stale to continue anyway.`,
  );
}

function rejectCodexSoloRoundCap(
  backend: Backend,
  mode: DebateMode,
  round: number,
  settings: DebateSettings,
): DebateRoundError | null {
  const soloLike = mode === 'solo' || mode === 'solo (auto)';
  if (backend !== 'codex' || !soloLike || round <= settings.debateCodexSoloMaxRounds) return null;
  return debateRoundError(
    7,
    `debate: codex solo supports at most ${settings.debateCodexSoloMaxRounds} rounds; round ${round} requires claude teams backend or a smaller debate.`,
  );
}

function logPriorContextTruncation(
  args: DebateArgs,
  round: number,
  truncatedBytes: number,
  emitActivity: typeof logActivity,
): void {
  if (truncatedBytes <= 0) return;
  emitActivity({
    event: 'debate_round_truncated',
    source: 'pickle',
    session: path.basename(args.sessionDir),
    round,
    bytes_dropped: truncatedBytes,
  });
}

function loadPreparedPriorContext(
  args: DebateArgs,
  previousBriefPaths: string[],
  round: number,
  emitActivity: typeof logActivity,
): { text: string; truncatedBytes: number } {
  if (!args.continueDebate) return { text: '', truncatedBytes: 0 };
  const priorContext = readPriorContext(args.sessionDir, previousBriefPaths);
  logPriorContextTruncation(args, round, priorContext.truncatedBytes, emitActivity);
  return priorContext;
}

function prepareDebateRound(
  args: DebateArgs,
  state: State | null,
  mode: DebateMode,
  backend: Backend,
  settings: DebateSettings,
  emitActivity: typeof logActivity,
): PreparedDebateRound | { error: string; exitCode: number } {
  const currentTicketsVersion = readTicketsVersion(state);
  const prior = readDebateFlag(state);
  const round = args.continueDebate ? (prior?.round ?? 0) + 1 : 1;
  const missingPrior = rejectMissingPrior(args, prior);
  if (missingPrior) return missingPrior;

  const capError = rejectRoundLimit(round, settings)
    ?? rejectMissingRoundConfirmation(args, round, settings)
    ?? rejectCodexSoloRoundCap(backend, mode, round, settings);
  if (capError) return capError;

  const round1TicketsVersion = prior?.round1_tickets_version ?? currentTicketsVersion;
  const staleError = rejectStaleTicketsVersion(args, round, currentTicketsVersion, round1TicketsVersion, emitActivity);
  if (staleError) return staleError;

  const previousBriefPaths = prior?.brief_paths ?? [];
  const priorContext = loadPreparedPriorContext(args, previousBriefPaths, round, emitActivity);

  const round1Personas = new Set(prior?.round1_personas ?? args.personas);
  return {
    round,
    round1TicketsVersion,
    newPersonas: args.personas.filter((persona) => !round1Personas.has(persona)),
    priorContext: priorContext.text,
    truncatedBytes: priorContext.truncatedBytes,
    previousBriefPaths,
  };
}

function writeDebateBrief(
  args: DebateArgs,
  briefPath: string,
  brief: string,
  prepared: PreparedDebateRound,
  stateInfo: LoadedDebateState,
  stateManager: StateManager,
  createdAt: Date,
  out: (message: string) => void,
): void {
  fs.mkdirSync(path.dirname(briefPath), { recursive: true });
  fs.writeFileSync(briefPath, brief, 'utf8');
  if (stateInfo.state) {
    persistDebateRound(stateInfo.statePath, stateManager, args, prepared, briefPath, createdAt);
  }
  out(`BRIEF_PATH=${briefPath}`);
}

function finishResolvedPreflight(
  input: DebateArgs,
  resolved: ResolvedDebateRun,
  opts: DebateRunOptions,
  err: (message: string) => void,
): DebateRunResult | null {
  if (resolved.backend === 'codex' && resolved.args.strictTeams) {
    err(STRICT_TEAMS_CODEX_ERROR);
    return { exitCode: 7, briefPath: '', brief: '', mode: resolved.mode };
  }
  if (resolved.declinedAutoPromote) {
    opts.logActivityFn?.({ event: 'debate_user_declined_auto_promote', source: 'pickle', session: path.basename(input.sessionDir) });
    return { exitCode: 1, briefPath: '', brief: '', mode: resolved.mode };
  }
  if (resolved.mode === 'solo (auto)') {
    (opts.logActivityFn ?? logActivity)({ event: 'debate_solo_auto', source: 'pickle', session: path.basename(input.sessionDir), mode: resolved.mode });
  }
  return null;
}

function persistDebateRound(
  statePath: string,
  stateManager: StateManager,
  args: DebateArgs,
  prepared: PreparedDebateRound,
  briefPath: string,
  generatedAt: Date,
): void {
  stateManager.update(statePath, (state) => {
    state.flags ??= {};
    const prior = readDebateFlag(state);
    state.flags.debate = {
      question: args.question,
      round: prepared.round,
      round1_tickets_version: prepared.round1TicketsVersion,
      round1_personas: prior?.round1_personas ?? args.personas,
      brief_paths: [...prepared.previousBriefPaths, briefPath],
      last_generated_at: generatedAt.toISOString(),
    };
  });
}

function defaultConfirmAutoPromote(banner: string): boolean {
  void banner;
  if (process.stdin.isTTY) return true;
  try {
    const answer = fs.readFileSync(0, 'utf8').trim().toLowerCase();
    return answer === '' || answer.startsWith('y');
  } catch {
    return true;
  }
}

function resolveDebateRun(input: DebateArgs, opts: DebateRunOptions, out: (message: string) => void): ResolvedDebateRun {
  const stateManager = opts.stateManager ?? new StateManager();
  const { state, statePath } = loadDebateState(input.sessionDir, stateManager);
  const backend = resolveBackend(state);
  const inheritedStrictTeams = state?.flags?.strict_teams === true;
  const strictTeams = input.noStrictTeams ? false : input.strictTeams || inheritedStrictTeams;
  const args = { ...input, strictTeams };

  if (input.strictTeams && state) {
    persistStrictTeamsFlag(statePath, stateManager);
  }

  if (backend === 'codex' && strictTeams) {
    return { args, backend, mode: 'teams', declinedAutoPromote: false };
  }

  if (backend === 'codex' && !args.solo) {
    const confirm = opts.confirmAutoPromote ?? defaultConfirmAutoPromote;
    out(AUTO_PROMOTE_BANNER);
    const accepted = confirm(AUTO_PROMOTE_BANNER);
    if (!accepted) return { args, backend, mode: 'teams', declinedAutoPromote: true };
    const autoArgs = { ...args, solo: true };
    return { args: autoArgs, backend, mode: 'solo (auto)', declinedAutoPromote: false };
  }

  return { args, backend, mode: args.solo ? 'solo' : 'teams', declinedAutoPromote: false };
}

export function runDebate(input: DebateArgs, opts: DebateRunOptions = {}): DebateRunResult {
  const now = opts.now ?? (() => new Date());
  const out = opts.stdout ?? ((message: string) => process.stdout.write(`${message}\n`));
  const err = opts.stderr ?? ((message: string) => process.stderr.write(`${message}\n`));
  const stateManager = opts.stateManager ?? new StateManager();
  const resolved = resolveDebateRun(input, opts, out);
  const preflightResult = finishResolvedPreflight(input, resolved, opts, err);
  if (preflightResult) return preflightResult;

  const createdAt = now();
  const briefPath = path.join(input.sessionDir, `debate_${isoCompactStamp(createdAt)}_brief.md`);
  const stateInfo = loadDebateState(input.sessionDir, stateManager);
  const settings = loadDebateSettings(opts.extensionRoot ?? getExtensionRoot(), opts.settings);
  const prepared = prepareDebateRound(
    resolved.args,
    stateInfo.state,
    resolved.mode,
    resolved.backend,
    settings,
    opts.logActivityFn ?? logActivity,
  );
  if ('error' in prepared) {
    err(prepared.error);
    return { exitCode: prepared.exitCode, briefPath: '', brief: '', mode: resolved.mode };
  }
  const agents = validateDebateAgents(resolved.args);
  const brief = buildDebateBrief(resolved.args, createdAt, agents, resolved.mode, prepared);

  if (resolved.args.dryRun) {
    out(JSON.stringify({
      brief_path: briefPath,
      personas: resolved.args.personas,
      mode: resolved.mode,
      brief,
    }, null, 2));
    return { exitCode: 0, briefPath, brief, mode: resolved.mode };
  }

  writeDebateBrief(resolved.args, briefPath, brief, prepared, stateInfo, stateManager, createdAt, out);
  return { exitCode: 0, briefPath, brief, mode: resolved.mode };
}

export function main(argv = process.argv.slice(2)): void {
  try {
    const result = runDebate(parseArgs(argv));
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}

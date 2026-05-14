import * as fs from 'fs';
import * as path from 'path';
import { Backend, BACKENDS } from '../types/index.js';

export interface HostCommandSpec {
  name: string;
  description: string;
  hosts: readonly Backend[];
  unsupportedHosts?: readonly Backend[];
  resultContract: PickleCommandResultContract;
}

export type PickleCommandResultContract =
  | {
    type: 'implemented';
    probe: 'markdown';
    outputEvidence: readonly string[];
  }
  | {
    type: 'not_implemented';
    reason: string;
  };

const MARKDOWN_RESULT_CONTRACT: PickleCommandResultContract = {
  type: 'implemented',
  probe: 'markdown',
  outputEvidence: ['success', 'fails', 'error', 'report', 'show', 'output', 'emit', 'write', 'display', 'summarize', 'return', 'done', 'execute', 'run', 'enabled', 'disabled'],
};

export const REQUIRED_PICKLE_COMMANDS = [
  'pickle',
  'pickle-tmux',
  'pickle-prd',
  'pickle-refine-prd',
  'anatomy-park',
  'szechuan-sauce',
  'pickle-pipeline',
] as const;

export const PICKLE_CODEX_AGENT_NAMES = [
  'morty-course-corrector',
  'morty-debater-architect',
  'morty-debater-implementer',
  'morty-debater-researcher',
  'morty-debater-skeptic',
  'morty-gate-remediator',
  'morty-implementer',
  'morty-phase-implementer',
  'morty-phase-planner',
  'morty-phase-researcher',
  'morty-phase-reviewer',
  'morty-phase-simplifier',
  'morty-phase-verifier',
  'morty-reviewer',
] as const;

export const PICKLE_COMMAND_SPECS: readonly HostCommandSpec[] = [
  { name: 'add-to-pickle-jar', description: 'Queue a PRD for later batch execution.', hosts: BACKENDS, resultContract: MARKDOWN_RESULT_CONTRACT },
  { name: 'anatomy-park', description: 'Run the Anatomy Park subsystem review loop.', hosts: BACKENDS, resultContract: MARKDOWN_RESULT_CONTRACT },
  { name: 'attract', description: 'Submit a DOT pipeline to the attractor server.', hosts: BACKENDS, resultContract: MARKDOWN_RESULT_CONTRACT },
  { name: 'citadel', description: 'Run post-implementation conformance audit.', hosts: BACKENDS, resultContract: MARKDOWN_RESULT_CONTRACT },
  { name: 'council-of-ricks', description: 'Run the Council of Ricks stack review.', hosts: BACKENDS, resultContract: MARKDOWN_RESULT_CONTRACT },
  { name: 'cronenberg', description: 'Route a task through the meta-command decision matrix.', hosts: BACKENDS, resultContract: MARKDOWN_RESULT_CONTRACT },
  { name: 'disable-pickle', description: 'Disable Pickle Rick hooks.', hosts: BACKENDS, resultContract: MARKDOWN_RESULT_CONTRACT },
  { name: 'eat-pickle', description: 'Cancel the current Pickle Rick loop.', hosts: BACKENDS, resultContract: MARKDOWN_RESULT_CONTRACT },
  { name: 'enable-pickle', description: 'Enable Pickle Rick hooks.', hosts: BACKENDS, resultContract: MARKDOWN_RESULT_CONTRACT },
  { name: 'help-pickle', description: 'Show Pickle Rick command help.', hosts: BACKENDS, resultContract: MARKDOWN_RESULT_CONTRACT },
  { name: 'meeseeks', description: 'Deprecated review command retained for compatibility.', hosts: BACKENDS, resultContract: MARKDOWN_RESULT_CONTRACT },
  { name: 'meeseeks-zellij', description: 'Deprecated Zellij review command retained for compatibility.', hosts: BACKENDS, resultContract: MARKDOWN_RESULT_CONTRACT },
  { name: 'pickle', description: 'Start the interactive Pickle Rick autonomous coding loop.', hosts: BACKENDS, resultContract: MARKDOWN_RESULT_CONTRACT },
  { name: 'pickle-debate', description: 'Run a multi-agent implementation debate.', hosts: BACKENDS, resultContract: MARKDOWN_RESULT_CONTRACT },
  { name: 'pickle-dot', description: 'Convert a PRD to a DOT digraph.', hosts: BACKENDS, resultContract: MARKDOWN_RESULT_CONTRACT },
  { name: 'pickle-dot-patterns', description: 'Inspect DOT builder patterns.', hosts: BACKENDS, resultContract: MARKDOWN_RESULT_CONTRACT },
  { name: 'pickle-jar-open', description: 'Run queued jar tasks.', hosts: BACKENDS, resultContract: MARKDOWN_RESULT_CONTRACT },
  { name: 'pickle-metrics', description: 'Show Pickle Rick metrics.', hosts: BACKENDS, resultContract: MARKDOWN_RESULT_CONTRACT },
  { name: 'pickle-microverse', description: 'Run a Microverse convergence loop.', hosts: BACKENDS, resultContract: MARKDOWN_RESULT_CONTRACT },
  { name: 'pickle-pipeline', description: 'Run build, review, and cleanup pipeline.', hosts: BACKENDS, resultContract: MARKDOWN_RESULT_CONTRACT },
  { name: 'pickle-prd', description: 'Draft a PRD for a requested feature.', hosts: BACKENDS, resultContract: MARKDOWN_RESULT_CONTRACT },
  { name: 'pickle-refine-prd', description: 'Refine a PRD and decompose it into tickets.', hosts: BACKENDS, resultContract: MARKDOWN_RESULT_CONTRACT },
  { name: 'pickle-retry', description: 'Retry a failed ticket.', hosts: BACKENDS, resultContract: MARKDOWN_RESULT_CONTRACT },
  { name: 'pickle-standup', description: 'Summarize recent Pickle Rick activity.', hosts: BACKENDS, resultContract: MARKDOWN_RESULT_CONTRACT },
  { name: 'pickle-status', description: 'Show current Pickle Rick session status.', hosts: BACKENDS, resultContract: MARKDOWN_RESULT_CONTRACT },
  { name: 'pickle-tmux', description: 'Launch the tmux-backed Pickle Rick loop.', hosts: BACKENDS, resultContract: MARKDOWN_RESULT_CONTRACT },
  { name: 'pickle-zellij', description: 'Launch the Zellij-backed Pickle Rick loop.', hosts: BACKENDS, resultContract: MARKDOWN_RESULT_CONTRACT },
  { name: 'plumbus', description: 'Run Plumbus audit helpers.', hosts: BACKENDS, resultContract: MARKDOWN_RESULT_CONTRACT },
  { name: 'portal-gun', description: 'Run migration inventory and execution workflow.', hosts: BACKENDS, resultContract: MARKDOWN_RESULT_CONTRACT },
  { name: 'project-mayhem', description: 'Run chaos engineering workflow.', hosts: BACKENDS, resultContract: MARKDOWN_RESULT_CONTRACT },
  { name: 'send-to-morty', description: 'Internal implementation worker prompt.', hosts: BACKENDS, resultContract: MARKDOWN_RESULT_CONTRACT },
  { name: 'send-to-morty-review', description: 'Internal review worker prompt.', hosts: BACKENDS, resultContract: MARKDOWN_RESULT_CONTRACT },
  { name: 'szechuan-sauce', description: 'Run the Szechuan Sauce code-quality loop.', hosts: BACKENDS, resultContract: MARKDOWN_RESULT_CONTRACT },
] as const;

const SPEC_BY_NAME = new Map(PICKLE_COMMAND_SPECS.map((spec) => [spec.name, spec]));

export function canonicalCommandNames(): string[] {
  return PICKLE_COMMAND_SPECS.map((spec) => spec.name);
}

export function getCommandSpec(name: string): HostCommandSpec | null {
  return SPEC_BY_NAME.get(name) ?? null;
}

export function commandsForHost(host: Backend): HostCommandSpec[] {
  return PICKLE_COMMAND_SPECS.filter((spec) => spec.hosts.includes(host));
}

export function renderGeminiToml(commandName: string, commandMarkdownPath: string): string {
  const spec = getCommandSpec(commandName);
  const description = spec?.description ?? `Pickle Rick /${commandName}`;
  return [
    `description = ${JSON.stringify(description)}`,
    'prompt = """',
    'Read the Pickle Rick command source at:',
    commandMarkdownPath,
    '',
    'Before running any setup command, set PICKLE_HOST_BACKEND=gemini unless the user explicitly passes --backend.',
    '',
    "Then execute it with the user's arguments:",
    '{{args}}',
    '"""',
    '',
  ].join('\n');
}

export interface RegistryValidationResult {
  commandFiles: string[];
  registryCommands: string[];
  missingFiles: string[];
  unregisteredFiles: string[];
  duplicateRegistryCommands: string[];
  missingRequiredCommands: string[];
}

export function validateCommandRegistry(commandDir: string): RegistryValidationResult {
  const commandFiles = fs.existsSync(commandDir)
    ? fs.readdirSync(commandDir)
      .filter((file) => file.endsWith('.md'))
      .map((file) => path.basename(file, '.md'))
      .sort()
    : [];
  const registryCommands = canonicalCommandNames().sort();
  const fileSet = new Set(commandFiles);
  const registrySet = new Set(registryCommands);
  const seen = new Set<string>();
  const duplicateRegistryCommands: string[] = [];
  for (const command of canonicalCommandNames()) {
    if (seen.has(command)) duplicateRegistryCommands.push(command);
    seen.add(command);
  }
  return {
    commandFiles,
    registryCommands,
    missingFiles: registryCommands.filter((command) => !fileSet.has(command)),
    unregisteredFiles: commandFiles.filter((command) => !registrySet.has(command)),
    duplicateRegistryCommands,
    missingRequiredCommands: REQUIRED_PICKLE_COMMANDS.filter((command) => !registrySet.has(command)),
  };
}

export function assertCommandRegistryParity(commandDir: string): void {
  const result = validateCommandRegistry(commandDir);
  const failures = [
    result.missingFiles.length ? `missing command files: ${result.missingFiles.join(', ')}` : null,
    result.unregisteredFiles.length ? `unregistered command files: ${result.unregisteredFiles.join(', ')}` : null,
    result.duplicateRegistryCommands.length ? `duplicate registry commands: ${result.duplicateRegistryCommands.join(', ')}` : null,
    result.missingRequiredCommands.length ? `missing required commands: ${result.missingRequiredCommands.join(', ')}` : null,
  ].filter((msg): msg is string => msg !== null);
  if (failures.length > 0) {
    throw new Error(`Pickle command registry parity failed: ${failures.join('; ')}`);
  }
}

export function expectedAdapterRelativePaths(host: Backend): string[] {
  const commands = commandsForHost(host).map((spec) => spec.name);
  if (host === 'claude') {
    return commands.map((name) => `commands/${name}.md`);
  }
  if (host === 'codex') {
    const pluginRoot = 'plugins/cache/pickle-rick/pickle-rick/local';
    return [
      'pickle-rick/persona.md',
      'pickle-rick/runtime_root',
      'prompts/pickle.md',
      `${pluginRoot}/.codex-plugin/plugin.json`,
      `${pluginRoot}/skills/pickle/SKILL.md`,
      `${pluginRoot}/persona.md`,
      `${pluginRoot}/runtime_root`,
      ...PICKLE_CODEX_AGENT_NAMES.map((name) => `agents/${name}.toml`),
      ...commands.map((name) => `prompts/pickle-rick/${name}.md`),
      ...PICKLE_CODEX_AGENT_NAMES.map((name) => `${pluginRoot}/agents/${name}.toml`),
      ...commands.map((name) => `${pluginRoot}/commands/${name}.md`),
    ];
  }
  return [
    'extensions/pickle-rick/persona.md',
    'extensions/pickle-rick/runtime_root',
    ...commands.map((name) => `extensions/pickle-rick/commands-md/${name}.md`),
    ...commands.map((name) => `extensions/pickle-rick/commands/${name}.toml`),
  ];
}

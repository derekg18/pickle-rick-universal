import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { extractFrontmatter } from './pickle-utils.js';

export type AgentModel = 'sonnet' | 'opus' | 'haiku';

export interface AgentMdFrontmatter {
  name: string;
  description: string;
  tools: string[];
  model?: AgentModel;
  role?: string;
  identity?: string;
  communicationStyle?: string;
  principles?: string[];
  raw: Record<string, string>;
}

export interface LoadedAgentMd {
  name: string;
  path: string;
  source: 'user' | 'managed';
  frontmatter: AgentMdFrontmatter;
  body: string;
  content: string;
}

export interface LoadAgentMdOptions {
  agentsDir?: string;
}

const VALID_MODELS = new Set<AgentModel>(['sonnet', 'opus', 'haiku']);

export function defaultAgentsDir(): string {
  return path.join(os.homedir(), '.claude', 'agents');
}

export function resolveAgentMdPath(
  agentName: string,
  options: LoadAgentMdOptions = {}
): { path: string; source: 'user' | 'managed' } | null {
  const filename = agentFilename(agentName);
  const agentsDir = options.agentsDir ?? defaultAgentsDir();
  const userPath = path.join(agentsDir, filename);
  if (fs.existsSync(userPath)) return { path: userPath, source: 'user' };
  const managedPath = path.join(agentsDir, '.pickle-managed', filename);
  if (fs.existsSync(managedPath)) return { path: managedPath, source: 'managed' };
  return null;
}

export function loadAgentMd(agentName: string, options: LoadAgentMdOptions = {}): LoadedAgentMd | null {
  const resolved = resolveAgentMdPath(agentName, options);
  if (!resolved) return null;
  const content = fs.readFileSync(resolved.path, 'utf8');
  const fm = extractFrontmatter(content);
  if (!fm) {
    throw new Error(`Agent markdown has no valid frontmatter: ${resolved.path}`);
  }
  const frontmatter = parseAgentMdFrontmatter(fm.body, resolved.path);
  return {
    name: frontmatter.name,
    path: resolved.path,
    source: resolved.source,
    frontmatter,
    body: content.slice(fm.end),
    content,
  };
}

export function parseAgentMdFrontmatter(frontmatter: string, sourcePath = '<agent-md>'): AgentMdFrontmatter {
  const raw = parseFlatFrontmatter(frontmatter);
  const name = required(raw, 'name', sourcePath);
  const description = required(raw, 'description', sourcePath);
  const tools = splitCsv(required(raw, 'tools', sourcePath));
  if (tools.length === 0) {
    throw new Error(`Agent markdown frontmatter key "tools" must contain at least one tool: ${sourcePath}`);
  }
  const model = raw.model ? parseModel(raw.model, sourcePath) : undefined;
  return {
    name,
    description,
    tools,
    ...(model ? { model } : {}),
    ...(raw.role ? { role: raw.role } : {}),
    ...(raw.identity ? { identity: raw.identity } : {}),
    ...(raw.communication_style ? { communicationStyle: raw.communication_style } : {}),
    ...(raw['principles[]'] ? { principles: parseInlineArray(raw['principles[]']) } : {}),
    raw,
  };
}

function agentFilename(agentName: string): string {
  if (agentName.includes('/') || agentName.includes('\\') || agentName === '.' || agentName === '..') {
    throw new Error(`Invalid agent name: ${agentName}`);
  }
  return agentName.endsWith('.md') ? agentName : `${agentName}.md`;
}

function parseFlatFrontmatter(frontmatter: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of frontmatter.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key) result[key] = stripQuotes(value);
  }
  return result;
}

function required(raw: Record<string, string>, key: string, sourcePath: string): string {
  const value = raw[key];
  if (!value) {
    throw new Error(`Agent markdown frontmatter missing required key "${key}": ${sourcePath}`);
  }
  return value;
}

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseModel(value: string, sourcePath: string): AgentModel {
  if (VALID_MODELS.has(value as AgentModel)) return value as AgentModel;
  throw new Error(`Agent markdown frontmatter model "${value}" is invalid in ${sourcePath}`);
}

function parseInlineArray(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return splitCsv(trimmed);
  const body = trimmed.slice(1, -1).trim();
  if (!body) return [];
  return body.split(',').map((item) => stripQuotes(item.trim())).filter(Boolean);
}

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

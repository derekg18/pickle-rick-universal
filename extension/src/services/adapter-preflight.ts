import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Backend, BACKENDS } from '../types/index.js';
import { getDataRoot, safeErrorMessage } from './pickle-utils.js';
import { getCommandSpec, renderGeminiToml } from './host-command-registry.js';

const REMEDIATION = 'bash install.sh';

interface HostManifest {
  status?: string;
  root?: string | null;
  files_written?: string[];
  file_checksums?: Record<string, string>;
}

interface InstallManifest {
  source_root?: string;
  runtime_root?: string;
  hosts?: Partial<Record<Backend, HostManifest>>;
}

export class AdapterPreflightError extends Error {
  constructor(message: string) {
    super(`${message}\nFix: ${REMEDIATION}`);
    this.name = 'AdapterPreflightError';
  }
}

export interface AdapterPreflightResult {
  checked: number;
  repaired: string[];
  skippedHosts: Backend[];
}

function sha256Content(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function sha256File(filePath: string): string {
  return sha256Content(fs.readFileSync(filePath));
}

function readManifest(manifestPath = path.join(getDataRoot(), 'install_manifest.json')): InstallManifest | null {
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as InstallManifest;
  } catch (err) {
    throw new AdapterPreflightError(`Pickle Rick install manifest is unreadable: ${safeErrorMessage(err)}`);
  }
}

function commandFromMarkdownTarget(filePath: string): string | null {
  const name = path.basename(filePath, '.md');
  return getCommandSpec(name) ? name : null;
}

function commandFromTomlTarget(filePath: string): string | null {
  const name = path.basename(filePath, '.toml');
  return getCommandSpec(name) ? name : null;
}

function sourceForManagedFile(filePath: string, manifest: InstallManifest): { content?: string; sourcePath?: string } | null {
  const sourceRoot = manifest.source_root;
  if (!sourceRoot) return null;

  if (filePath.endsWith(`${path.sep}persona.md`)) {
    const sourcePath = path.join(sourceRoot, 'persona.md');
    return fs.existsSync(sourcePath) ? { sourcePath } : null;
  }

  if (filePath.endsWith(`${path.sep}runtime_root`)) {
    return typeof manifest.runtime_root === 'string'
      ? { content: `${manifest.runtime_root}\n` }
      : null;
  }

  if (filePath.includes(`${path.sep}commands${path.sep}`) && filePath.endsWith('.md')) {
    const command = commandFromMarkdownTarget(filePath);
    if (!command) return null;
    const sourcePath = path.join(sourceRoot, '.claude', 'commands', `${command}.md`);
    return fs.existsSync(sourcePath) ? { sourcePath } : null;
  }

  if (filePath.includes(`${path.sep}prompts${path.sep}pickle-rick${path.sep}`) && filePath.endsWith('.md')) {
    const command = commandFromMarkdownTarget(filePath);
    if (!command) return null;
    const sourcePath = path.join(sourceRoot, '.claude', 'commands', `${command}.md`);
    return fs.existsSync(sourcePath) ? { sourcePath } : null;
  }

  if (filePath.includes(`${path.sep}commands-md${path.sep}`) && filePath.endsWith('.md')) {
    const command = commandFromMarkdownTarget(filePath);
    if (!command) return null;
    const sourcePath = path.join(sourceRoot, '.claude', 'commands', `${command}.md`);
    return fs.existsSync(sourcePath) ? { sourcePath } : null;
  }

  if (filePath.includes(`${path.sep}extensions${path.sep}pickle-rick${path.sep}commands${path.sep}`) && filePath.endsWith('.toml')) {
    const command = commandFromTomlTarget(filePath);
    if (!command) return null;
    const mdTarget = path.join(path.dirname(path.dirname(filePath)), 'commands-md', `${command}.md`);
    return { content: renderGeminiToml(command, mdTarget) };
  }

  return null;
}

function repairManagedFile(filePath: string, expectedHash: string, manifest: InstallManifest): boolean {
  const source = sourceForManagedFile(filePath, manifest);
  if (!source) return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (source.sourcePath) {
    fs.copyFileSync(source.sourcePath, filePath);
  } else if (typeof source.content === 'string') {
    fs.writeFileSync(filePath, source.content);
  } else {
    return false;
  }
  return fs.existsSync(filePath) && sha256File(filePath) === expectedHash;
}

function normalizeExistingPath(filePath: string): string {
  if (filePath.startsWith('~')) return path.join(os.homedir(), filePath.slice(1));
  return filePath;
}

export function assertAdaptersFresh(manifestPath?: string): AdapterPreflightResult {
  const manifest = readManifest(manifestPath);
  if (!manifest) return { checked: 0, repaired: [], skippedHosts: [...BACKENDS] };
  const repaired: string[] = [];
  const skippedHosts: Backend[] = [];
  let checked = 0;

  for (const host of BACKENDS) {
    const hostManifest = manifest.hosts?.[host];
    if (!hostManifest || hostManifest.status !== 'installed') {
      skippedHosts.push(host);
      continue;
    }
    const checksums = hostManifest.file_checksums;
    if (!checksums || Object.keys(checksums).length === 0) {
      throw new AdapterPreflightError(`Pickle Rick ${host} adapter manifest has no file checksums`);
    }
    for (const [rawFilePath, expectedHash] of Object.entries(checksums)) {
      const filePath = normalizeExistingPath(rawFilePath);
      checked += 1;
      if (fs.existsSync(filePath) && sha256File(filePath) === expectedHash) continue;
      if (repairManagedFile(filePath, expectedHash, manifest)) {
        repaired.push(filePath);
        continue;
      }
      throw new AdapterPreflightError(`Pickle Rick ${host} adapter is stale or missing: ${filePath}`);
    }
  }

  return { checked, repaired, skippedHosts };
}

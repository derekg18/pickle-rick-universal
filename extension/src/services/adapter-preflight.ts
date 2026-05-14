import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Backend, BACKENDS } from '../types/index.js';
import { getDataRoot, safeErrorMessage } from './pickle-utils.js';
import { getCommandSpec, renderGeminiToml } from './host-command-registry.js';

const REMEDIATION = 'bash install.sh';
const CODEX_HOME_SEGMENT = `${path.sep}.${'codex'}${path.sep}`;
const CODEX_PLUGIN_CACHE_SEGMENT = `${CODEX_HOME_SEGMENT}plugins${path.sep}cache${path.sep}pickle-rick${path.sep}pickle-rick${path.sep}local${path.sep}`;
const CODEX_PLUGIN_SOURCE_SEGMENT = `${path.sep}plugins${path.sep}pickle-rick${path.sep}`;
const GEMINI_HOME_SEGMENT = `${path.sep}.${'gemini'}${path.sep}`;

interface HostManifest {
  status?: string;
  reason?: string | null;
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
  skippedHosts: Array<{ host: Backend; status: string; reason: string | null }>;
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

interface ManagedFileSource {
  content?: string;
  sourcePath?: string;
}

function isHostManifestFile(filePath: string, hostManifest: HostManifest): boolean {
  if (!hostManifest.files_written || hostManifest.files_written.length === 0) {
    return true;
  }
  return hostManifest.files_written.some((managedPath) => normalizeExistingPath(managedPath) === filePath);
}

function sourceFromRuntimeRoot(filePath: string, manifest: InstallManifest, host: Backend): ManagedFileSource | null {
  const runtimeRoot = manifest.runtime_root;
  if (!runtimeRoot) return null;

  const runtimeAdapterSegments: Partial<Record<Backend, string>> = {
    codex: `${path.sep}.codex${path.sep}pickle-rick${path.sep}`,
    gemini: `${GEMINI_HOME_SEGMENT}extensions${path.sep}pickle-rick${path.sep}`,
  };
  const segment = runtimeAdapterSegments[host];
  if (!segment) return null;

  const segmentIndex = filePath.indexOf(segment);
  if (segmentIndex === -1) return null;

  const relativePath = filePath.slice(segmentIndex + segment.length);
  const sourcePath = path.join(runtimeRoot, relativePath);
  return fs.existsSync(sourcePath) ? { sourcePath } : null;
}

function sourceFromCodexPluginFile(filePath: string, sourceRoot: string, manifest: InstallManifest): ManagedFileSource | null {
  for (const segment of [CODEX_PLUGIN_CACHE_SEGMENT, CODEX_PLUGIN_SOURCE_SEGMENT]) {
    const segmentIndex = filePath.indexOf(segment);
    if (segmentIndex === -1) continue;

    const relativePath = filePath.slice(segmentIndex + segment.length);
    if (relativePath === 'runtime_root') {
      return typeof manifest.runtime_root === 'string'
        ? { content: `${manifest.runtime_root}\n` }
        : null;
    }
    if (relativePath === 'persona.md') {
      const sourcePath = path.join(sourceRoot, 'persona.md');
      return fs.existsSync(sourcePath) ? { sourcePath } : null;
    }
    if (relativePath.startsWith(`commands${path.sep}`) && relativePath.endsWith('.md')) {
      const command = commandFromMarkdownTarget(relativePath);
      if (!command) return null;
      const sourcePath = path.join(sourceRoot, '.claude', 'commands', `${command}.md`);
      return fs.existsSync(sourcePath) ? { sourcePath } : null;
    }

    const sourcePath = path.join(sourceRoot, 'codex-plugin', relativePath);
    return fs.existsSync(sourcePath) ? { sourcePath } : null;
  }
  return null;
}

function sourceForManagedFile(filePath: string, manifest: InstallManifest, host: Backend, hostManifest: HostManifest): ManagedFileSource | null {
  if (!isHostManifestFile(filePath, hostManifest)) return null;

  const sourceRoot = manifest.source_root;

  if (sourceRoot && filePath.endsWith(`${path.sep}persona.md`)) {
    const sourcePath = path.join(sourceRoot, 'persona.md');
    return fs.existsSync(sourcePath) ? { sourcePath } : null;
  }

  if (filePath.endsWith(`${path.sep}runtime_root`)) {
    return typeof manifest.runtime_root === 'string'
      ? { content: `${manifest.runtime_root}\n` }
      : null;
  }

  if (host === 'codex' && sourceRoot) {
    const source = sourceFromCodexPluginFile(filePath, sourceRoot, manifest);
    if (source) return source;
  }

  if (sourceRoot && filePath.includes(`${path.sep}commands${path.sep}`) && filePath.endsWith('.md')) {
    const command = commandFromMarkdownTarget(filePath);
    if (!command) return null;
    const sourcePath = path.join(sourceRoot, '.claude', 'commands', `${command}.md`);
    return fs.existsSync(sourcePath) ? { sourcePath } : null;
  }

  if (sourceRoot && filePath.includes(`${path.sep}prompts${path.sep}pickle-rick${path.sep}`) && filePath.endsWith('.md')) {
    const command = commandFromMarkdownTarget(filePath);
    if (!command) return null;
    const sourcePath = path.join(sourceRoot, '.claude', 'commands', `${command}.md`);
    return fs.existsSync(sourcePath) ? { sourcePath } : null;
  }

  if (sourceRoot && filePath.includes(`${CODEX_HOME_SEGMENT}prompts${path.sep}`) && filePath.endsWith('.md')) {
    const command = commandFromMarkdownTarget(filePath);
    if (!command) return null;
    const sourcePath = path.join(sourceRoot, '.claude', 'commands', `${command}.md`);
    return fs.existsSync(sourcePath) ? { sourcePath } : null;
  }

  if (sourceRoot && filePath.includes(`${CODEX_HOME_SEGMENT}agents${path.sep}`) && filePath.endsWith('.toml')) {
    const sourcePath = path.join(sourceRoot, '.codex', 'agents', path.basename(filePath));
    if (fs.existsSync(sourcePath)) return { sourcePath };
    const pluginSourcePath = path.join(sourceRoot, 'codex-plugin', 'agents', path.basename(filePath));
    return fs.existsSync(pluginSourcePath) ? { sourcePath: pluginSourcePath } : null;
  }

  if (sourceRoot && filePath.includes(`${path.sep}commands-md${path.sep}`) && filePath.endsWith('.md')) {
    const command = commandFromMarkdownTarget(filePath);
    if (!command) return null;
    const sourcePath = path.join(sourceRoot, '.claude', 'commands', `${command}.md`);
    return fs.existsSync(sourcePath) ? { sourcePath } : null;
  }

  if (filePath.includes(`${path.sep}extensions${path.sep}pickle-rick${path.sep}commands${path.sep}`) && filePath.endsWith('.toml')) {
    const command = commandFromTomlTarget(filePath);
    if (!command) return null;
    const mdTarget = path.join('..', 'commands-md', `${command}.md`);
    return { content: renderGeminiToml(command, mdTarget) };
  }

  return sourceFromRuntimeRoot(filePath, manifest, host);
}

function sourceIsSymlink(source: ManagedFileSource | null): boolean {
  return Boolean(source?.sourcePath && fs.lstatSync(source.sourcePath).isSymbolicLink());
}

function symlinkMatchesSource(filePath: string, source: ManagedFileSource | null): boolean {
  if (!source?.sourcePath || !sourceIsSymlink(source)) return true;
  try {
    return fs.lstatSync(filePath).isSymbolicLink()
      && fs.readlinkSync(filePath) === fs.readlinkSync(source.sourcePath);
  } catch {
    return false;
  }
}

function repairManagedFile(filePath: string, expectedHash: string, source: ManagedFileSource | null): boolean {
  if (!source) return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (source.sourcePath) {
    fs.rmSync(filePath, { force: true });
    if (fs.lstatSync(source.sourcePath).isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(source.sourcePath), filePath);
    } else {
      fs.copyFileSync(source.sourcePath, filePath);
    }
  } else if (typeof source.content === 'string') {
    fs.rmSync(filePath, { force: true });
    fs.writeFileSync(filePath, source.content);
  } else {
    return false;
  }
  return fs.existsSync(filePath) && sha256File(filePath) === expectedHash && symlinkMatchesSource(filePath, source);
}

function normalizeExistingPath(filePath: string): string {
  if (filePath.startsWith('~')) return path.join(os.homedir(), filePath.slice(1));
  return filePath;
}

export function assertAdaptersFresh(manifestPath?: string): AdapterPreflightResult {
  const manifest = readManifest(manifestPath);
  if (!manifest) {
    return {
      checked: 0,
      repaired: [],
      skippedHosts: BACKENDS.map((host) => ({ host, status: 'missing-manifest', reason: 'install manifest not found' })),
    };
  }
  const repaired: string[] = [];
  const skippedHosts: AdapterPreflightResult['skippedHosts'] = [];
  let checked = 0;

  for (const host of BACKENDS) {
    const hostManifest = manifest.hosts?.[host];
    if (!hostManifest || hostManifest.status !== 'installed') {
      skippedHosts.push({
        host,
        status: hostManifest?.status ?? 'missing',
        reason: hostManifest?.reason ?? null,
      });
      continue;
    }
    const checksums = hostManifest.file_checksums;
    if (!checksums || Object.keys(checksums).length === 0) {
      throw new AdapterPreflightError(`Pickle Rick ${host} adapter manifest has no file checksums`);
    }
    for (const [rawFilePath, expectedHash] of Object.entries(checksums)) {
      const filePath = normalizeExistingPath(rawFilePath);
      checked += 1;
      const source = sourceForManagedFile(filePath, manifest, host, hostManifest);
      const reason = fs.existsSync(filePath)
        ? (sha256File(filePath) === expectedHash ? 'symlink target mismatch' : 'checksum mismatch')
        : 'missing';
      if (fs.existsSync(filePath) && sha256File(filePath) === expectedHash && symlinkMatchesSource(filePath, source)) continue;
      if (repairManagedFile(filePath, expectedHash, source)) {
        repaired.push(filePath);
        continue;
      }
      throw new AdapterPreflightError(`Pickle Rick ${host} adapter ${reason}: ${filePath}; unable to repair from managed source`);
    }
  }

  return { checked, repaired, skippedHosts };
}

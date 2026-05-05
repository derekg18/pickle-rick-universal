#!/usr/bin/env node
import { spawn } from 'child_process';
import { existsSync, appendFileSync } from 'fs';
import { join } from 'path';
import * as os from 'os';
import { safeErrorMessage } from '../services/pickle-utils.js';

const EXTENSION_DIR = process.env.EXTENSION_DIR || join(os.homedir(), '.claude/pickle-rick');
const HANDLERS_DIR = join(EXTENSION_DIR, 'extension', 'hooks', 'handlers');
const LOG_PATH = join(EXTENSION_DIR, 'debug.log');

interface HandlerCommand {
  scriptPath: string;
  cmd: string;
  cmdArgs: string[];
}

interface HookDecision {
  decision: 'approve' | 'block';
  [key: string]: unknown;
}

type HookVerdict = HookDecision['decision'];

// Prevent EPIPE errors from crashing the dispatcher when Claude Code closes the pipe
const handleEpipe = (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
};
process.stdout.on('error', handleEpipe);
process.stderr.on('error', handleEpipe);

function log(message: string) {
  try {
    const timestamp = new Date().toISOString();
    appendFileSync(LOG_PATH, `[${timestamp}] [dispatcher] ${message}\n`);
  } catch {
    /* ignore */
  }
}

function logError(message: string) {
  console.error(`Dispatcher Error: ${message}`);
  log(`ERROR: ${message}`);
}

function approve() {
  console.log(JSON.stringify({ decision: 'approve' }));
}

function findExecutable(name: string): string | null {
  const pathEnv = process.env.PATH || '';
  const paths = pathEnv.split(process.platform === 'win32' ? ';' : ':');
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', '.ps1', ''] : [''];

  for (const p of paths) {
    for (const ext of extensions) {
      const fullPath = join(p, name + ext);
      if (existsSync(fullPath)) return fullPath;
    }
  }
  return null;
}

function startWatchdog(): NodeJS.Timeout {
  const WATCHDOG_MS = Number(process.env.PICKLE_DISPATCH_TIMEOUT_MS) || 10_000;
  const watchdog = setTimeout(() => {
    log('Watchdog timeout — approving and exiting');
    approve();
    process.exit(0);
  }, WATCHDOG_MS);
  watchdog.unref();
  return watchdog;
}

function isInvalidHookName(hookName: string): boolean {
  return hookName.includes('/') || hookName.includes('\\') || hookName.includes('..');
}

function resolveHandlerCommand(hookName: string, extraArgs: string[]): HandlerCommand | null {
  const jsPath = join(HANDLERS_DIR, `${hookName}.js`);
  if (existsSync(jsPath)) {
    return { scriptPath: jsPath, cmd: 'node', cmdArgs: [jsPath, ...extraArgs] };
  }

  if (process.platform === 'win32') {
    const scriptPath = join(HANDLERS_DIR, `${hookName}.ps1`);
    const exe = findExecutable('pwsh') || findExecutable('powershell');
    if (!exe) return null;
    return {
      scriptPath,
      cmd: exe,
      cmdArgs: ['-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...extraArgs],
    };
  }

  const scriptPath = join(HANDLERS_DIR, `${hookName}.sh`);
  return { scriptPath, cmd: 'bash', cmdArgs: [scriptPath, ...extraArgs] };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';

  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const inputData = Buffer.concat(chunks).toString();
    log(`Input received: ${inputData.length} bytes`);
    return inputData;
  } catch (e) {
    log(`Error reading stdin: ${safeErrorMessage(e)}`);
    return '';
  }
}

function parseDecision(stdout: string, hookName: string): HookDecision | null {
  const lines = stdout.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]) as Partial<HookDecision>;
      const decision = normalizeHookDecision(obj);
      if (decision) return decision;
    } catch { /* not JSON, try previous line */ }
  }

  if (lines.length > 0) {
    log(`Hook ${hookName} stdout contained no valid decision JSON — falling back to approve`);
  }
  return null;
}

function isSupportedVerdict(value: unknown): value is HookVerdict {
  return value === 'approve' || value === 'block';
}

function normalizeHookDecision(obj: Partial<HookDecision> & { verdict?: unknown }): HookDecision | null {
  if (isSupportedVerdict(obj.decision)) return obj as HookDecision;
  if (!isSupportedVerdict(obj.verdict)) return null;

  const { verdict: _verdict, ...rest } = obj;
  return { ...rest, decision: obj.verdict };
}

function writeChildInput(
  child: ReturnType<typeof spawn>,
  inputData: string,
): void {
  child.stdin?.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') {
      child.kill('SIGKILL');
      return;
    }
    logError(`Child stdin error: ${safeErrorMessage(err)}`);
  });

  if (inputData) {
    try {
      child.stdin?.write(inputData);
    } catch (err) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'EPIPE') {
        child.kill('SIGKILL');
      } else {
        throw err;
      }
    }
  }
  child.stdin?.end();
}

function handleChildClose(hookName: string, code: number | null, stdout: string, stderr: string): number {
  if (stderr) process.stderr.write(stderr);
  if (stderr.trim()) log(`Hook ${hookName} stderr: ${stderr.trim()}`);

  if (!stdout.trim()) {
    if (code !== 0 && code !== null) {
      logError(`Hook ${hookName} exited with code ${code} and no output. stderr: ${stderr.trim() || '(none)'}`);
    }
    approve();
    return code ?? 0;
  }

  const parsed = parseDecision(stdout, hookName);
  if (parsed) console.log(JSON.stringify(parsed));
  else approve();
  return code ?? 0;
}

function runHandler(command: HandlerCommand, hookName: string, inputData: string): Promise<number> {
  try {
    const child = spawn(command.cmd, command.cmdArgs, {
      env: { ...process.env, EXTENSION_DIR },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    writeChildInput(child, inputData);

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => (stdout += data.toString()));
    child.stderr?.on('data', (data) => (stderr += data.toString()));

    return new Promise((resolve) => {
      child.on('close', (code) => resolve(handleChildClose(hookName, code, stdout, stderr)));
      child.on('error', (err) => {
        logError(`Failed to start child process: ${safeErrorMessage(err)}`);
        approve();
        resolve(0);
      });
    });
  } catch (e) {
    logError(`Unexpected execution error: ${safeErrorMessage(e)}`);
    approve();
    return Promise.resolve(0);
  }
}

async function main() {
  startWatchdog();

  const args = process.argv.slice(2);
  if (args.length < 1) {
    approve();
    process.exit(0);
  }

  const [hookName, ...extraArgs] = args;
  if (isInvalidHookName(hookName)) {
    logError(`Invalid hook name (path traversal rejected): ${hookName}`);
    approve();
    process.exit(0);
  }

  log(`Dispatching hook: ${hookName} (cwd: ${process.cwd()})`);
  const command = resolveHandlerCommand(hookName, extraArgs);
  if (!command) {
    logError('PowerShell not found.');
    approve();
    process.exit(0);
  }

  if (!existsSync(command.scriptPath)) {
    logError(`Hook script not found: ${command.scriptPath}`);
    approve();
    process.exit(0);
  }

  const inputData = await readStdin();
  const exitCode = await runHandler(command, hookName, inputData);
  process.exit(exitCode);
}

main().catch((err) => {
  try {
    log(`FATAL: ${err instanceof Error ? err.stack || err.message : String(err)}`);
  } catch { /* ignore */ }
  approve();
  process.exit(0);
});

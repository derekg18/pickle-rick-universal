#!/usr/bin/env node
import { spawn } from 'child_process';
import { existsSync, appendFileSync } from 'fs';
import { join } from 'path';
import * as os from 'os';
import { safeErrorMessage } from '../services/pickle-utils.js';

const EXTENSION_DIR = process.env.EXTENSION_DIR || join(os.homedir(), '.claude/pickle-rick');
const HANDLERS_DIR = join(EXTENSION_DIR, 'extension', 'hooks', 'handlers');
const LOG_PATH = join(EXTENSION_DIR, 'debug.log');

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

// eslint-disable-next-line complexity, max-lines-per-function -- pre-existing — outside T0–T15 god-fn refactor scope; defer to follow-up epic
async function main() {
  // Watchdog: if the hook hangs for any reason, approve and exit.
  // This prevents Claude Code from deadlocking on a stuck handler.
  const WATCHDOG_MS = Number(process.env.PICKLE_DISPATCH_TIMEOUT_MS) || 10_000;
  const watchdog = setTimeout(() => {
    log('Watchdog timeout — approving and exiting');
    approve();
    process.exit(0);
  }, WATCHDOG_MS);
  watchdog.unref();

  const args = process.argv.slice(2);
  if (args.length < 1) {
    approve();
    process.exit(0);
  }

  const [hookName, ...extraArgs] = args;
  if (hookName.includes('/') || hookName.includes('\\') || hookName.includes('..')) {
    logError(`Invalid hook name (path traversal rejected): ${hookName}`);
    approve();
    process.exit(0);
  }
  log(`Dispatching hook: ${hookName} (cwd: ${process.cwd()})`);
  const isWindows = process.platform === 'win32';

  let scriptPath: string;
  let cmd: string;
  let cmdArgs: string[];

  const jsPath = join(HANDLERS_DIR, `${hookName}.js`);
  if (existsSync(jsPath)) {
    scriptPath = jsPath;
    cmd = 'node';
    cmdArgs = [scriptPath, ...extraArgs];
  } else if (isWindows) {
    scriptPath = join(HANDLERS_DIR, `${hookName}.ps1`);
    const exe = findExecutable('pwsh') || findExecutable('powershell');
    if (!exe) {
      logError('PowerShell not found.');
      approve();
      process.exit(0);
    }
    cmd = exe;
    cmdArgs = ['-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...extraArgs];
  } else {
    scriptPath = join(HANDLERS_DIR, `${hookName}.sh`);
    cmd = 'bash';
    cmdArgs = [scriptPath, ...extraArgs];
  }

  if (!existsSync(scriptPath)) {
    logError(`Hook script not found: ${scriptPath}`);
    approve();
    process.exit(0);
  }

  let inputData = '';
  if (!process.stdin.isTTY) {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
      }
      inputData = Buffer.concat(chunks).toString();
      log(`Input received: ${inputData.length} bytes`);
    } catch (e) {
      log(`Error reading stdin: ${safeErrorMessage(e)}`);
    }
  }

  try {
    const child = spawn(cmd, cmdArgs, {
      env: { ...process.env, EXTENSION_DIR },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

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

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => (stdout += data.toString()));
    child.stderr?.on('data', (data) => (stderr += data.toString()));

    child.on('close', (code) => {
      if (stderr) process.stderr.write(stderr);

      if (stderr.trim()) {
        log(`Hook ${hookName} stderr: ${stderr.trim()}`);
      }

      if (!stdout.trim()) {
        if (code !== 0 && code !== null) {
          logError(`Hook ${hookName} exited with code ${code} and no output. stderr: ${stderr.trim() || '(none)'}`);
        }
        approve();
      } else {
        // Parse the LAST non-empty line as the decision JSON.
        // Handlers may accidentally emit debug output before the decision;
        // only the final line matters.
        let parsed: { decision: string } | null = null;
        const lines = stdout.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const obj = JSON.parse(lines[i]);
            if (obj.decision === 'approve' || obj.decision === 'block') {
              parsed = obj;
              break;
            }
          } catch { /* not JSON, try previous line */ }
        }
        if (!parsed && lines.length > 0) {
          log(`Hook ${hookName} stdout contained no valid decision JSON — falling back to approve`);
        }
        if (parsed) {
          console.log(JSON.stringify(parsed));
        } else {
          approve();
        }
      }
      process.exit(code ?? 0);
    });

    child.on('error', (err) => {
      logError(`Failed to start child process: ${safeErrorMessage(err)}`);
      approve();
      process.exit(0);
    });
  } catch (e) {
    logError(`Unexpected execution error: ${safeErrorMessage(e)}`);
    approve();
    process.exit(0);
  }
}

main().catch((err) => {
  try {
    log(`FATAL: ${err instanceof Error ? err.stack || err.message : String(err)}`);
  } catch { /* ignore */ }
  approve();
  process.exit(0);
});

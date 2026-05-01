#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { findSessionPathForCwd } from '../services/pickle-utils.js';

export function getSessionPath(cwd: string): string | null {
  const sessionPath = findSessionPathForCwd(cwd);

  if (!sessionPath || !fs.existsSync(sessionPath)) {
    return null;
  }

  return sessionPath;
}

if (process.argv[1] && path.basename(process.argv[1]) === 'get-session.js') {
  const sessionPath = getSessionPath(process.cwd());
  if (sessionPath) {
    process.stdout.write(sessionPath);
  } else {
    process.exit(1);
  }
}

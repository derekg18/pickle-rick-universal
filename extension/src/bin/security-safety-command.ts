#!/usr/bin/env node
import * as path from 'path';
import {
  runSecuritySafetyCommandByName,
  type SecuritySafetyContext,
} from '../services/security-safety-commands.js';

function main(): void {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    console.error('Usage: node security-safety-command.js <command> [args...]');
    process.exit(1);
  }

  const ctx: SecuritySafetyContext = {
    workspaceDir: process.cwd(),
  };
  const result = runSecuritySafetyCommandByName(command, args, ctx);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status === 'failed') process.exit(1);
}

if (process.argv[1] && path.basename(process.argv[1]) === 'security-safety-command.js') {
  main();
}

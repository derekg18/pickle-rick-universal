#!/usr/bin/env node
import * as path from 'path';
import {
  runQualityRefactorCommandByName,
  type QualityRefactorContext,
} from '../services/quality-refactor-commands.js';

function main(): void {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    console.error('Usage: node quality-refactor-command.js <command> [args...]');
    process.exit(1);
  }

  const ctx: QualityRefactorContext = {
    workspaceDir: process.cwd(),
  };
  const result = runQualityRefactorCommandByName(command, args, ctx);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status === 'failed') process.exit(1);
}

if (process.argv[1] && path.basename(process.argv[1]) === 'quality-refactor-command.js') {
  main();
}

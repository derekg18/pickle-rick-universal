#!/usr/bin/env node
import * as path from 'path';
import {
  runGitNexusCommandGroupByName,
  type GitNexusCommandContext,
} from '../services/gitnexus-command-group.js';

function main(): void {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    console.error('Usage: node gitnexus-command-group.js <command> [args...]');
    process.exit(1);
  }

  const ctx: GitNexusCommandContext = {
    workspaceDir: process.cwd(),
  };
  const result = runGitNexusCommandGroupByName(command, args, ctx);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status === 'failed') process.exit(1);
}

if (process.argv[1] && path.basename(process.argv[1]) === 'gitnexus-command-group.js') {
  main();
}

#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { printMinimalPanel, collectTickets, statusSymbol, findSessionPathForCwd } from '../services/pickle-utils.js';
import { StateManager } from '../services/state-manager.js';
import { State } from '../types/index.js';

const sm = new StateManager();

// eslint-disable-next-line complexity -- pre-existing — outside T0–T15 god-fn refactor scope; defer to follow-up epic
export function showStatus(cwd: string): void {
  const sessionPath = findSessionPathForCwd(cwd);

  if (!sessionPath || !fs.existsSync(sessionPath)) {
    console.log('🥒 No active Pickle Rick session for this directory.');
    return;
  }

  let state: State;
  try {
    state = sm.read(path.join(sessionPath, 'state.json'));
  } catch {
    console.log('🥒 Session state is unreadable.');
    process.exit(1);
  }

  const maxIter = Number(state.max_iterations) || 0;
  const curIter = Number(state.iteration) || 0;
  const iterationStr = maxIter > 0
    ? `${curIter} of ${maxIter}`
    : String(curIter);

  const raw: string = state.original_prompt || '';
  const taskStr = raw.length > 80 ? raw.slice(0, 80) + '…' : raw;

  const isActive = state.active === true;
  const mode = state.tmux_mode === true ? 'tmux' : 'inline';

  printMinimalPanel('Pickle Rick — Session Status', {
    Active: isActive ? 'Yes' : 'No',
    Mode: mode,
    Phase: state.step || 'unknown',
    Iteration: iterationStr,
    Ticket: state.current_ticket || 'none',
    Task: taskStr,
  }, isActive ? 'GREEN' : 'RED', '🥒');

  const tickets = collectTickets(sessionPath);
  if (tickets.length > 0) {
    console.log('Tickets:');
    for (const ticket of tickets) {
      console.log(`  ${statusSymbol(ticket.status)} ${ticket.id}: ${ticket.title}`);
    }
    console.log('');
  }
}

if (process.argv[1] && path.basename(process.argv[1]) === 'status.js') {
  showStatus(process.cwd());
}

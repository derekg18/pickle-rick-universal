#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { printMinimalPanel } from '../services/pickle-utils.js';
import { readCircuitBreakerState, resetCircuitBreaker, type CircuitBreakerState } from '../services/circuit-breaker.js';

function main(): void {
  const sessionDir = process.argv[2];

  if (!sessionDir) {
    console.error('Usage: node circuit-reset.js <session-dir> [--reason "your reason"]');
    process.exit(1);
  }

  if (!fs.existsSync(sessionDir)) {
    console.error(`Error: session directory does not exist: ${sessionDir}`);
    process.exit(1);
  }

  const cbPath = path.join(sessionDir, 'circuit_breaker.json');

  const recovered = readCircuitBreakerState(sessionDir);
  if (!recovered) {
    console.error(`Error: cannot read ${cbPath}`);
    process.exit(1);
  }
  const current: CircuitBreakerState = recovered;

  if (!current.state || !['CLOSED', 'HALF_OPEN', 'OPEN'].includes(current.state)) {
    console.error(`Error: invalid circuit state in ${cbPath}`);
    process.exit(1);
  }

  if (current.state === 'CLOSED') {
    printMinimalPanel('Circuit Breaker', {
      State: 'CLOSED',
      Action: 'No reset needed — circuit already CLOSED',
    }, 'GREEN', '🔌');
    process.exit(0);
  }

  let reason = 'Manual CLI reset';
  const reasonIdx = process.argv.indexOf('--reason');
  if (reasonIdx !== -1 && process.argv[reasonIdx + 1]) {
    reason = process.argv[reasonIdx + 1];
  }

  const previousState = current.state;
  resetCircuitBreaker(sessionDir, reason);

  printMinimalPanel('Circuit Breaker Reset', {
    Previous: previousState,
    Current: 'CLOSED',
    Reason: reason,
  }, 'GREEN', '🔌');

  console.log('Restart mux-runner to resume: node mux-runner.js <session-dir>');
}

if (process.argv[1] && path.basename(process.argv[1]) === 'circuit-reset.js') {
  main();
}

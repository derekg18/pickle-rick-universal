import * as fs from 'fs';
import * as path from 'path';
import { readMicroverseState } from '../services/microverse-state.js';

if (process.argv[1] && path.basename(process.argv[1]) === 'read-microverse.js') {
  const [sessionRoot, field] = process.argv.slice(2);
  if (!sessionRoot || !field) {
    process.stderr.write('Usage: read-microverse <session-root> <field>\n');
    process.exit(1);
  }
  const mvPath = path.join(sessionRoot, 'microverse.json');
  try {
    if (!fs.existsSync(mvPath)) {
      process.stdout.write('0\n');
      process.exit(0);
    }
    const raw = readMicroverseState(sessionRoot) as Record<string, unknown> | null;
    if (!raw) {
      process.stdout.write('0\n');
      process.exit(0);
    }
    const val = raw[field] ?? 0;
    process.stdout.write(String(val) + '\n');
  } catch {
    process.stdout.write('0\n');
  }
}

import * as fs from 'fs';
import * as path from 'path';

export function findMissingPrefixes(files: readonly string[], prefixes: readonly string[]): string[] {
  return prefixes.filter((prefix) => !files.some((file) => file === `${prefix}.md` || file.startsWith(`${prefix}_`)));
}

export function listLinearTicketFiles(sessionDir: string): string[] {
  if (!fs.existsSync(sessionDir)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(sessionDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const ticketPath = path.join(sessionDir, entry.name, `linear_ticket_${entry.name}.md`);
    if (fs.existsSync(ticketPath)) files.push(ticketPath);
  }
  return files.sort();
}

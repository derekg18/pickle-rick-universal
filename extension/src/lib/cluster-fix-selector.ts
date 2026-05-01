import { maxSeverity, Severity } from './severity.js';

export type FrameId = 'F1' | 'F2' | 'F3' | 'F4' | 'F5' | 'F6';

export interface Finding {
  frame: FrameId;
  post_verification_severity: Severity;
  [key: string]: unknown;
}

// PRD A5 fix-selection precedence table (prd_refined.md:166-179).
// Keys are sorted, comma-joined frame sets.
const PRECEDENCE: Record<string, FrameId> = {
  'F1': 'F1',
  'F2': 'F2',
  'F3': 'F3',
  'F4': 'F4',
  'F5': 'F5',
  'F6': 'F6',
  'F1,F2': 'F2',
  'F1,F2,F6': 'F2',
  'F2,F4': 'F4',
  'F1,F3': 'F3',
  'F3,F5': 'F5',
};

export function selectFix(
  frameSet: string[],
  members: Finding[],
): { winner: Finding; warn: boolean } {
  if (members.length === 0) {
    throw new Error('selectFix requires at least one finding');
  }

  const key = [...frameSet].sort().join(',');
  const winningFrame = PRECEDENCE[key];

  if (winningFrame !== undefined) {
    const winner = members.find(m => m.frame === winningFrame);
    if (winner !== undefined) {
      return { winner, warn: false };
    }
  }

  const maxSev = maxSeverity(members.map(m => m.post_verification_severity));
  const winner = members.find(m => m.post_verification_severity === maxSev)!;
  return { winner, warn: true };
}

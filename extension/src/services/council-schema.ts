export class CouncilSchemaError extends Error {
  jsonPath: string;
  constructor(message: string, jsonPath: string) {
    super(message);
    this.name = 'CouncilSchemaError';
    this.jsonPath = jsonPath;
  }
}

export interface Finding {
  severity: 'P0' | 'P1' | 'P2' | 'P3' | 'P4';
  confidence: number;
  source: 'COUNCIL' | 'CODEX' | 'COUNCIL+CODEX';
  file: string;
  line: number;
  line_range: string | null;
  rule: string;
  description: string;
  recommendation: string;
  data_flow: string | null;
  scenario: string | null;
  snippet_before: string | null;
  snippet_after: string | null;
}

export interface TrapDoor {
  path: string;
  constraint: string;
  why_it_breaks: string;
  what_must_hold: string;
}

export interface StackOverview {
  trunk: string;
  branches: string[];
  issue_counts: Record<string, number>;
  codex_verdicts: Record<string, string>;
}

export interface BranchEntry {
  name: string;
  pr_purpose?: string | null;
  findings: Finding[];
}

export interface Directive {
  schema_version: 1;
  round: number;
  codex_enabled: boolean;
  project_rules_ref?: string;
  stack_overview?: StackOverview;
  branches: BranchEntry[];
  trap_doors: TrapDoor[];
}

export type CodexVerdictValue = 'approve' | 'needs-attention' | 'failed' | 'timeout';

export interface CodexBranchResult {
  verdict: CodexVerdictValue;
  reason: string;
}

export const KNOWN_CATEGORIES = [
  'B1_stack_structure',
  'B2_claude_md',
  'B3_contract_discovery',
  'B4_cross_branch',
  'B5_test_coverage',
  'B6_security',
  'B7_migration_hygiene',
  'B8_szechuan',
  'B9_polish',
  'C_correctness',
  'C_codex',
] as const;

export type KnownCategory = (typeof KNOWN_CATEGORIES)[number];

export interface SubagentPayload {
  category: KnownCategory;
  branch: string | null;
  status: 'ok' | 'skipped';
  skip_reason: string | null;
  findings: Finding[];
  trap_door_candidates: TrapDoor[];
  codex_per_branch: Record<string, CodexBranchResult> | null;
}

const SEVERITY_VALUES = new Set(['P0', 'P1', 'P2', 'P3', 'P4']);
const SOURCE_VALUES = new Set(['COUNCIL', 'CODEX', 'COUNCIL+CODEX']);
const CODEX_VERDICT_VALUES = new Set(['approve', 'needs-attention', 'failed', 'timeout']);

function fail(message: string, jsonPath: string): never {
  throw new CouncilSchemaError(message, jsonPath);
}

function requireString(obj: Record<string, unknown>, key: string, path: string): string {
  if (!(key in obj)) fail(`missing required field "${key}"`, `${path}.${key}`);
  const v = obj[key];
  if (typeof v !== 'string') fail(`"${key}" must be a string`, `${path}.${key}`);
  return v as string;
}

function requireNonEmptyString(obj: Record<string, unknown>, key: string, path: string): string {
  const v = requireString(obj, key, path);
  if (v.length === 0) fail(`"${key}" must be a non-empty string`, `${path}.${key}`);
  return v;
}

function requireInteger(obj: Record<string, unknown>, key: string, path: string): number {
  if (!(key in obj)) fail(`missing required field "${key}"`, `${path}.${key}`);
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isInteger(v)) fail(`"${key}" must be an integer`, `${path}.${key}`);
  return v as number;
}

function asRecord(v: unknown, path: string): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    fail(`expected object`, path);
  }
  return v as Record<string, unknown>;
}

function requireNullableString(obj: Record<string, unknown>, key: string, path: string): string | null {
  if (!(key in obj)) fail(`missing required field "${key}" (must be null when absent)`, `${path}.${key}`);
  const v = obj[key];
  if (v !== null && typeof v !== 'string') fail(`"${key}" must be a string or null`, `${path}.${key}`);
  return v as string | null;
}

function validateFinding(obj: unknown, path: string): Finding {
  const r = asRecord(obj, path);

  const severity = requireString(r, 'severity', path);
  if (!SEVERITY_VALUES.has(severity)) {
    fail(`"severity" must be one of P0-P4, got "${severity}"`, `${path}.severity`);
  }

  const confidence = requireInteger(r, 'confidence', path);
  if (confidence < 0 || confidence > 100) {
    fail(`"confidence" must be in [0,100], got ${confidence}`, `${path}.confidence`);
  }

  const source = requireString(r, 'source', path);
  if (!SOURCE_VALUES.has(source)) {
    fail(`"source" must be COUNCIL, CODEX, or COUNCIL+CODEX, got "${source}"`, `${path}.source`);
  }

  const file = requireNonEmptyString(r, 'file', path);
  const line = requireInteger(r, 'line', path);
  if (line < 1) fail(`"line" must be ≥ 1, got ${line}`, `${path}.line`);

  const rule = requireString(r, 'rule', path);
  const description = requireString(r, 'description', path);
  const recommendation = requireString(r, 'recommendation', path);

  const line_range = requireNullableString(r, 'line_range', path);
  const data_flow = requireNullableString(r, 'data_flow', path);
  const scenario = requireNullableString(r, 'scenario', path);
  const snippet_before = requireNullableString(r, 'snippet_before', path);
  const snippet_after = requireNullableString(r, 'snippet_after', path);

  return {
    severity: severity as Finding['severity'],
    confidence,
    source: source as Finding['source'],
    file,
    line,
    line_range,
    rule,
    description,
    recommendation,
    data_flow,
    scenario,
    snippet_before,
    snippet_after,
  };
}

function validateTrapDoor(obj: unknown, path: string): TrapDoor {
  const r = asRecord(obj, path);
  return {
    path: requireNonEmptyString(r, 'path', path),
    constraint: requireNonEmptyString(r, 'constraint', path),
    why_it_breaks: requireNonEmptyString(r, 'why_it_breaks', path),
    what_must_hold: requireNonEmptyString(r, 'what_must_hold', path),
  };
}

function validateFindings(arr: unknown, path: string): Finding[] {
  if (!Array.isArray(arr)) fail(`"findings" must be an array`, path);
  return (arr as unknown[]).map((item, i) => validateFinding(item, `${path}[${i}]`));
}

function validateTrapDoors(arr: unknown, path: string): TrapDoor[] {
  if (!Array.isArray(arr)) fail(`"trap_doors" must be an array`, path);
  return (arr as unknown[]).map((item, i) => validateTrapDoor(item, `${path}[${i}]`));
}

export function validateDirective(obj: unknown): Directive {
  const r = asRecord(obj, '$');

  if (!('schema_version' in r)) fail('missing required field "schema_version"', '$.schema_version');
  const sv = r['schema_version'];
  if (sv !== 1) fail(`unsupported directive schema_version: ${String(sv)}`, '$.schema_version');

  if (!('round' in r)) fail('missing required field "round"', '$.round');
  const round = r['round'];
  if (typeof round !== 'number' || !Number.isInteger(round)) fail('"round" must be an integer', '$.round');

  if (!('codex_enabled' in r)) fail('missing required field "codex_enabled"', '$.codex_enabled');
  const codex_enabled = r['codex_enabled'];
  if (typeof codex_enabled !== 'boolean') fail('"codex_enabled" must be a boolean', '$.codex_enabled');

  if (!('branches' in r)) fail('missing required field "branches"', '$.branches');
  const branchesRaw = r['branches'];
  if (!Array.isArray(branchesRaw)) fail('"branches" must be an array', '$.branches');
  const branches: BranchEntry[] = (branchesRaw as unknown[]).map((b, i) => {
    const br = asRecord(b, `$.branches[${i}]`);
    if (!('name' in br)) fail('missing required field "name"', `$.branches[${i}].name`);
    const name = br['name'];
    if (typeof name !== 'string') fail('"name" must be a string', `$.branches[${i}].name`);
    if (!('findings' in br)) fail('missing required field "findings"', `$.branches[${i}].findings`);
    const findings = validateFindings(br['findings'], `$.branches[${i}].findings`);
    return { name, findings } as BranchEntry;
  });

  if (!('trap_doors' in r)) fail('missing required field "trap_doors"', '$.trap_doors');
  const trap_doors = validateTrapDoors(r['trap_doors'], '$.trap_doors');

  return {
    schema_version: 1,
    round: round as number,
    codex_enabled: codex_enabled as boolean,
    branches,
    trap_doors,
  };
}

// eslint-disable-next-line complexity -- pre-existing — outside T0–T15 god-fn refactor scope; defer to follow-up epic
export function validateSubagentPayload(obj: unknown): SubagentPayload {
  const r = asRecord(obj, '$');

  const category = requireNonEmptyString(r, 'category', '$');
  if (!(KNOWN_CATEGORIES as readonly string[]).includes(category)) {
    fail(`unknown category "${category}"`, '$.category');
  }

  if (!('branch' in r)) fail('missing required field "branch"', '$.branch');
  const branch = r['branch'];
  if (branch !== null && typeof branch !== 'string') fail('"branch" must be a string or null', '$.branch');

  if (!('status' in r)) fail('missing required field "status"', '$.status');
  const status = r['status'];
  if (status !== 'ok' && status !== 'skipped') fail('"status" must be "ok" or "skipped"', '$.status');

  if (!('skip_reason' in r)) fail('missing required field "skip_reason"', '$.skip_reason');
  const skip_reason = r['skip_reason'];
  if (status === 'skipped') {
    if (typeof skip_reason !== 'string' || skip_reason.length === 0) {
      fail('"skip_reason" must be a non-empty string when status is "skipped"', '$.skip_reason');
    }
  } else {
    if (skip_reason !== null) fail('"skip_reason" must be null when status is "ok"', '$.skip_reason');
  }

  if (!('findings' in r)) fail('missing required field "findings"', '$.findings');
  const findings = validateFindings(r['findings'], '$.findings');

  if (!('trap_door_candidates' in r)) fail('missing required field "trap_door_candidates"', '$.trap_door_candidates');
  const trap_door_candidates = validateTrapDoors(r['trap_door_candidates'], '$.trap_door_candidates');

  if (!('codex_per_branch' in r)) fail('missing required field "codex_per_branch"', '$.codex_per_branch');
  const cpb = r['codex_per_branch'];
  let codex_per_branch: Record<string, CodexBranchResult> | null = null;
  if (cpb !== null) {
    const cpbR = asRecord(cpb, '$.codex_per_branch');
    codex_per_branch = {};
    for (const [k, v] of Object.entries(cpbR)) {
      const entry = asRecord(v, `$.codex_per_branch.${k}`);
      const verdict = requireString(entry, 'verdict', `$.codex_per_branch.${k}`);
      if (!CODEX_VERDICT_VALUES.has(verdict)) {
        fail(`"verdict" must be one of approve/needs-attention/failed/timeout`, `$.codex_per_branch.${k}.verdict`);
      }
      const reason = requireString(entry, 'reason', `$.codex_per_branch.${k}`);
      codex_per_branch[k] = { verdict: verdict as CodexVerdictValue, reason };
    }
  }

  return {
    category: category as KnownCategory,
    branch: branch as string | null,
    status: status as 'ok' | 'skipped',
    skip_reason: skip_reason as string | null,
    findings,
    trap_door_candidates,
    codex_per_branch,
  };
}

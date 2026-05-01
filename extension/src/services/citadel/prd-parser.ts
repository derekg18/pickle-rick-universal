import { readFileSync } from 'node:fs';

export interface Decision {
  id: string;
  line: number;
  text: string;
}

export interface AcceptanceCriterion {
  id: string;
  line: number;
  text: string;
}

export interface Endpoint {
  method: string;
  path: string;
  line: number;
  text: string;
}

export interface AllowlistEntry {
  name: string;
  value: string;
  line: number;
  kind: 'valid_action' | 'lender_feature_flag' | 'enum_value';
  text: string;
}

export interface StatusCodeRow {
  endpointMethod?: string;
  endpointPath?: string;
  statusCode: number;
  errorMessage?: string;
  line: number;
  text: string;
}

export interface TransitionAuditRow {
  transition: string;
  auditAction: string;
  expectedCallSite?: string;
  line: number;
  text: string;
}

export interface ParsedPrd {
  decisions: Decision[];
  acceptanceCriteria: AcceptanceCriterion[];
  endpoints: Endpoint[];
  allowlistEntries: AllowlistEntry[];
  statusCodeRows: StatusCodeRow[];
  transitionAuditRows: TransitionAuditRow[];
}

type Seen = Set<string>;
type TableContext = 'valid_actions' | 'lender_feature_flags' | 'enum_values' | 'status_codes' | undefined;

interface ScanState {
  tableContext: TableContext;
  currentEndpoint?: Endpoint;
  transitionTable?: TransitionTableColumns;
}

interface TransitionTableColumns {
  transition: number;
  audit: number;
  expectedCallSite?: number;
}

const AC_ID_PATTERN = /\bAC-[A-Z0-9]+(?:-[A-Z0-9]+)*(?:-\d+)?\b/g;
const DECISION_PATTERN = /(?:^|[^\w-])(A(?:[1-9]|[1-9][0-9]))\.?(?=$|[^\w-])/g;
const ENDPOINT_CELL_PATTERN = /^\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+((?:\/|\{)[^\s|`]*)/i;
const STATUS_CODE_PATTERN = /\b([1-5][0-9]{2})\b/;
const ERROR_MESSAGE_PATTERN = /(?:error message|message|error)\s*[:=]\s*["'`]?([^"'`|]+)["'`]?/i;

export function parsePrdFile(filePath: string): ParsedPrd {
  return parsePrdMarkdown(readFileSync(filePath, 'utf-8'));
}

export function parsePrdMarkdown(markdown: string): ParsedPrd {
  const result: ParsedPrd = {
    decisions: [],
    acceptanceCriteria: [],
    endpoints: [],
    allowlistEntries: [],
    statusCodeRows: [],
    transitionAuditRows: [],
  };
  const seen = {
    decisions: new Set<string>(),
    acceptanceCriteria: new Set<string>(),
    endpoints: new Set<string>(),
    allowlistEntries: new Set<string>(),
    statusCodeRows: new Set<string>(),
    transitionAuditRows: new Set<string>(),
  };
  const state: ScanState = { tableContext: undefined };

  markdown.split(/\r?\n/).forEach((line, index) => {
    const lineNumber = index + 1;
    scanLine(line, lineNumber, result, seen, state);
  });

  return result;
}

function scanLine(
  line: string,
  lineNumber: number,
  result: ParsedPrd,
  seen: Record<keyof ParsedPrd, Seen>,
  state: ScanState,
): void {
  updateContext(line, state);
  scanDecisions(line, lineNumber, result.decisions, seen.decisions);
  scanAcceptanceCriteria(line, lineNumber, result.acceptanceCriteria, seen.acceptanceCriteria);
  scanEndpoint(line, lineNumber, result, seen.endpoints, state);
  scanAllowlistEntries(line, lineNumber, result.allowlistEntries, seen.allowlistEntries, state.tableContext);
  scanStatusCodeRow(line, lineNumber, result.statusCodeRows, seen.statusCodeRows, state);
  scanTransitionAuditRow(line, lineNumber, result.transitionAuditRows, seen.transitionAuditRows, state);
}

function updateContext(line: string, state: ScanState): void {
  const normalized = line.toLowerCase();
  if (isHeading(line)) {
    state.tableContext = contextFromText(normalized);
    return;
  }
  if (isMarkdownTableRow(line)) {
    state.tableContext = state.tableContext ?? contextFromText(normalized);
    return;
  }
  if (line.trim() === '') {
    return;
  }
  state.tableContext = contextFromText(normalized);
}

function contextFromText(text: string): TableContext {
  if (text.includes('valid_actions')) return 'valid_actions';
  if (text.includes('lender_feature_flags')) return 'lender_feature_flags';
  if (text.includes('status') && (text.includes('code') || text.includes('error'))) return 'status_codes';
  if (text.includes('enum')) return 'enum_values';
  return undefined;
}

function scanDecisions(line: string, lineNumber: number, decisions: Decision[], seen: Seen): void {
  for (const match of line.matchAll(DECISION_PATTERN)) {
    const id = match[1];
    const key = id;
    if (!id || seen.has(key)) continue;
    seen.add(key);
    decisions.push({ id, line: lineNumber, text: line.trim() });
  }
}

function scanAcceptanceCriteria(
  line: string,
  lineNumber: number,
  acceptanceCriteria: AcceptanceCriterion[],
  seen: Seen,
): void {
  for (const match of line.matchAll(AC_ID_PATTERN)) {
    const id = match[0];
    if (seen.has(id)) continue;
    seen.add(id);
    acceptanceCriteria.push({ id, line: lineNumber, text: line.trim() });
  }
}

function scanEndpoint(
  line: string,
  lineNumber: number,
  result: ParsedPrd,
  seen: Seen,
  state: ScanState,
): void {
  const cells = tableCells(line);
  const endpointCell = cells.find((cell) => ENDPOINT_CELL_PATTERN.test(cell));
  if (!endpointCell) return;
  const match = endpointCell.match(ENDPOINT_CELL_PATTERN);
  if (!match) return;
  const endpoint = {
    method: match[1].toUpperCase(),
    path: match[2],
    line: lineNumber,
    text: line.trim(),
  };
  state.currentEndpoint = endpoint;
  const key = `${endpoint.method} ${endpoint.path}`;
  if (seen.has(key)) return;
  seen.add(key);
  result.endpoints.push(endpoint);
}

function scanAllowlistEntries(
  line: string,
  lineNumber: number,
  entries: AllowlistEntry[],
  seen: Seen,
  tableContext: TableContext,
): void {
  scanNamedAllowlist(line, lineNumber, entries, seen, 'VALID_ACTIONS', 'valid_action');
  scanNamedAllowlist(line, lineNumber, entries, seen, 'lender_feature_flags', 'lender_feature_flag');
  if (tableContext) scanContextualTableEntries(line, lineNumber, entries, seen, tableContext);
}

function scanNamedAllowlist(
  line: string,
  lineNumber: number,
  entries: AllowlistEntry[],
  seen: Seen,
  name: string,
  kind: AllowlistEntry['kind'],
): void {
  if (!line.includes(name)) return;
  const valueMatches = line.matchAll(/["'`]([A-Za-z0-9_.:-]+)["'`]/g);
  for (const match of valueMatches) {
    pushAllowlistEntry(entries, seen, { name, value: match[1], line: lineNumber, kind, text: line.trim() });
  }
}

function scanContextualTableEntries(
  line: string,
  lineNumber: number,
  entries: AllowlistEntry[],
  seen: Seen,
  tableContext: Exclude<TableContext, undefined>,
): void {
  const cells = tableCells(line);
  if (cells.length < 2 || isSeparatorRow(cells)) return;
  const [nameCell, valueCell] = cells;
  if (looksLikeHeader(nameCell, valueCell)) return;
  const kind = tableContext === 'lender_feature_flags' ? 'lender_feature_flag' : tableContext === 'valid_actions' ? 'valid_action' : 'enum_value';
  pushAllowlistEntry(entries, seen, {
    name: cleanCell(nameCell),
    value: cleanCell(valueCell),
    line: lineNumber,
    kind,
    text: line.trim(),
  });
}

function scanStatusCodeRow(
  line: string,
  lineNumber: number,
  rows: StatusCodeRow[],
  seen: Seen,
  state: ScanState,
): void {
  const cells = tableCells(line);
  const statusCode = statusCodeFromCells(cells);
  if (statusCode === undefined) return;
  const errorMessage = extractErrorMessage(cells);
  const endpoint = endpointFromCells(cells) ?? state.currentEndpoint;
  const key = `${endpoint?.method ?? ''}|${endpoint?.path ?? ''}|${statusCode}|${errorMessage ?? ''}|${lineNumber}`;
  if (seen.has(key)) return;
  seen.add(key);
  rows.push({
    endpointMethod: endpoint?.method,
    endpointPath: endpoint?.path,
    statusCode,
    errorMessage,
    line: lineNumber,
    text: line.trim(),
  });
}

function scanTransitionAuditRow(
  line: string,
  lineNumber: number,
  rows: TransitionAuditRow[],
  seen: Seen,
  state: ScanState,
): void {
  const cells = tableCells(line);
  if (cells.length === 0) {
    state.transitionTable = undefined;
    return;
  }
  const header = transitionTableHeader(cells);
  if (header) {
    state.transitionTable = header;
    return;
  }
  if (isSeparatorRow(cells)) return;
  if (looksLikeHeader(...cells)) {
    state.transitionTable = undefined;
    return;
  }
  if (!state.transitionTable) return;

  const transition = cells[state.transitionTable.transition];
  const auditAction = cells[state.transitionTable.audit];
  if (!transition || !auditAction) return;

  const expectedCallSite =
    state.transitionTable.expectedCallSite === undefined ? undefined : cells[state.transitionTable.expectedCallSite];
  const key = `${transition}|${auditAction}|${lineNumber}`;
  if (seen.has(key)) return;
  seen.add(key);
  rows.push({
    transition,
    auditAction,
    expectedCallSite: expectedCallSite || undefined,
    line: lineNumber,
    text: line.trim(),
  });
}

function transitionTableHeader(cells: string[]): TransitionTableColumns | undefined {
  const normalized = cells.map((cell) => cleanCell(cell).toLowerCase());
  const transition = normalized.findIndex((cell) => cell === 'transition');
  const audit = normalized.findIndex((cell) => cell === 'audit');
  if (transition === -1 || audit === -1) return undefined;
  const expectedCallSite = normalized.findIndex((cell) => /^(expected\s+)?call\s*site$/.test(cell));
  return {
    transition,
    audit,
    expectedCallSite: expectedCallSite === -1 ? undefined : expectedCallSite,
  };
}

function statusCodeFromCells(cells: string[]): number | undefined {
  if (cells.length === 0 || isSeparatorRow(cells) || looksLikeHeader(...cells)) return undefined;
  const statusCell = cells.find((cell) => STATUS_CODE_PATTERN.test(cell));
  const statusCode = Number(statusCell?.match(STATUS_CODE_PATTERN)?.[1]);
  return Number.isInteger(statusCode) ? statusCode : undefined;
}

function extractErrorMessage(cells: string[]): string | undefined {
  const errorCell = cells.find((cell) => ERROR_MESSAGE_PATTERN.test(cell));
  if (errorCell) return cleanCell(errorCell.match(ERROR_MESSAGE_PATTERN)?.[1] ?? errorCell);
  const quoted = cells.join(' | ').match(/["'`]([^"'`]+)["'`]/);
  if (quoted) return cleanCell(quoted[1]);
  return cells.findLast((cell) => !STATUS_CODE_PATTERN.test(cell) && !ENDPOINT_CELL_PATTERN.test(cell));
}

function endpointFromCells(cells: string[]): Pick<Endpoint, 'method' | 'path'> | undefined {
  for (const cell of cells) {
    const match = cell.match(ENDPOINT_CELL_PATTERN);
    if (match) return { method: match[1].toUpperCase(), path: match[2] };
  }
  return undefined;
}

function tableCells(line: string): string[] {
  if (!isMarkdownTableRow(line)) return [];
  return line.split('|').slice(1, -1).map(cleanCell);
}

function cleanCell(value: string): string {
  return value.trim().replace(/^`|`$/g, '').replace(/^["']|["']$/g, '').trim();
}

function isMarkdownTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line);
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function looksLikeHeader(...cells: string[]): boolean {
  return cells.some((cell) => /^(method|endpoint|path|status|code|message|value|enum|key|action|name)$/i.test(cleanCell(cell)));
}

function isHeading(line: string): boolean {
  return /^\s{0,3}#{1,6}\s+/.test(line);
}

function pushAllowlistEntry(entries: AllowlistEntry[], seen: Seen, entry: AllowlistEntry): void {
  if (!entry.name || !entry.value) return;
  const key = `${entry.kind}|${entry.name}|${entry.value}`;
  if (seen.has(key)) return;
  seen.add(key);
  entries.push(entry);
}

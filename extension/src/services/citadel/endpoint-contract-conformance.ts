import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { Endpoint, StatusCodeRow } from './prd-parser.js';

export type EndpointContractSeverity = 'High' | 'Medium';

export interface EndpointContractEvidence {
  file: string;
  line: number;
  text: string;
}

export interface ControllerMethodEvidence {
  file: string;
  line: number;
  controllerPath: string;
  method: string;
  methodPath: string;
  fullPath: string;
  body: string[];
}

export interface EndpointContractRow {
  endpoint: Endpoint;
  statusCodeRow: StatusCodeRow;
  controller?: Omit<ControllerMethodEvidence, 'body'>;
  statusEvidence?: EndpointContractEvidence;
  messageEvidence?: EndpointContractEvidence;
}

export interface EndpointContractFinding {
  id: string;
  severity: EndpointContractSeverity;
  message: string;
  endpoint: Endpoint;
  statusCodeRow: StatusCodeRow;
  evidence: EndpointContractEvidence[];
}

export interface EndpointContractConformanceReport {
  rows: EndpointContractRow[];
  findings: EndpointContractFinding[];
  summary: {
    totalRows: number;
    missingControllers: number;
    missingStatusCodes: number;
    missingMessages: number;
  };
}

export interface CheckEndpointContractConformanceOptions {
  repoRoot?: string;
}

interface SourceFile {
  path: string;
  lines: string[];
}

const SKIPPED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage']);
const SOURCE_FILE_PATTERN = /\.[cm]?tsx?$/i;
const TEST_FILE_PATTERN = /(?:^|\/)(?:__tests__|tests?|specs?)(?:\/|$)|(?:\.|-)test\.[cm]?[jt]sx?$|(?:\.|-)spec\.[cm]?[jt]sx?$/i;
const HTTP_DECORATOR_PATTERN = /^\s*@(Get|Post|Put|Patch|Delete|Head|Options)\s*\(([^)]*)\)/i;
const CONTROLLER_DECORATOR_PATTERN = /^\s*@Controller\s*\(([^)]*)\)/;
const EXCEPTION_BY_STATUS: Record<number, string[]> = {
  400: ['BadRequestException'],
  401: ['UnauthorizedException'],
  403: ['ForbiddenException'],
  404: ['NotFoundException'],
  409: ['ConflictException'],
};
const HTTP_STATUS_BY_CODE: Record<number, string[]> = {
  400: ['BAD_REQUEST'],
  401: ['UNAUTHORIZED'],
  403: ['FORBIDDEN'],
  404: ['NOT_FOUND'],
  409: ['CONFLICT'],
};

export function checkEndpointContractConformance(
  endpoints: Endpoint[],
  statusCodeRows: StatusCodeRow[],
  options: CheckEndpointContractConformanceOptions = {},
): EndpointContractConformanceReport {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const sourceFiles = collectSourceFiles(repoRoot);
  const controllerMethods = sourceFiles.flatMap(parseControllerMethods);
  const rows = statusCodeRows.flatMap((statusCodeRow) => {
    const endpoint = endpointForStatusRow(statusCodeRow, endpoints);
    if (!endpoint) return [];
    return [buildRow(endpoint, statusCodeRow, controllerMethods)];
  });
  const findings = rows.flatMap(buildFindings);

  return {
    rows,
    findings,
    summary: {
      totalRows: rows.length,
      missingControllers: rows.filter((row) => !row.controller).length,
      missingStatusCodes: rows.filter((row) => !row.statusEvidence).length,
      missingMessages: rows.filter((row) => row.statusCodeRow.errorMessage && !row.messageEvidence).length,
    },
  };
}

function buildRow(
  endpoint: Endpoint,
  statusCodeRow: StatusCodeRow,
  controllerMethods: ControllerMethodEvidence[],
): EndpointContractRow {
  const controller = controllerMethods.find((method) => endpointMatchesMethod(endpoint, method));
  if (!controller) {
    return { endpoint, statusCodeRow };
  }

  return {
    endpoint,
    statusCodeRow,
    controller: controllerSummary(controller),
    statusEvidence: findStatusEvidence(statusCodeRow.statusCode, controller),
    messageEvidence: statusCodeRow.errorMessage
      ? findMessageEvidence(statusCodeRow.errorMessage, controller)
      : undefined,
  };
}

function buildFindings(row: EndpointContractRow): EndpointContractFinding[] {
  const findings: EndpointContractFinding[] = [];
  if (!row.controller) {
    findings.push(toFinding(row, 'status', `No controller method found for ${formatEndpoint(row.endpoint)}.`));
    return findings;
  }
  if (!row.statusEvidence) {
    findings.push(toFinding(row, 'status', `${formatEndpoint(row.endpoint)} is missing documented ${row.statusCodeRow.statusCode}.`));
  }
  if (row.statusCodeRow.errorMessage && !row.messageEvidence) {
    findings.push(toFinding(row, 'message', `${formatEndpoint(row.endpoint)} is missing documented error message "${row.statusCodeRow.errorMessage}".`));
  }
  return findings;
}

function toFinding(row: EndpointContractRow, kind: 'status' | 'message', message: string): EndpointContractFinding {
  return {
    id: `citadel-endpoint-contract-${slug(formatEndpoint(row.endpoint))}-${row.statusCodeRow.statusCode}-${kind}`,
    severity: severityForStatus(row.statusCodeRow.statusCode),
    message,
    endpoint: row.endpoint,
    statusCodeRow: row.statusCodeRow,
    evidence: [row.statusEvidence, row.messageEvidence].filter((evidence): evidence is EndpointContractEvidence => Boolean(evidence)),
  };
}

function severityForStatus(statusCode: number): EndpointContractSeverity {
  return statusCode === 403 ? 'High' : 'Medium';
}

function endpointForStatusRow(statusCodeRow: StatusCodeRow, endpoints: Endpoint[]): Endpoint | undefined {
  if (statusCodeRow.endpointMethod && statusCodeRow.endpointPath) {
    return endpoints.find(
      (endpoint) =>
        endpoint.method === statusCodeRow.endpointMethod &&
        normalizeEndpointPath(endpoint.path) === normalizeEndpointPath(statusCodeRow.endpointPath ?? ''),
    );
  }
  return undefined;
}

function parseControllerMethods(file: SourceFile): ControllerMethodEvidence[] {
  const methods: ControllerMethodEvidence[] = [];
  let controllerPath: string | undefined;
  for (let index = 0; index < file.lines.length; index += 1) {
    const line = file.lines[index];
    const controllerMatch = line.match(CONTROLLER_DECORATOR_PATTERN);
    if (controllerMatch) {
      controllerPath = decoratorPath(controllerMatch[1]);
      continue;
    }
    if (!controllerPath) continue;
    const methodMatch = line.match(HTTP_DECORATOR_PATTERN);
    if (!methodMatch) continue;
    methods.push({
      file: file.path,
      line: index + 1,
      controllerPath,
      method: methodMatch[1].toUpperCase(),
      methodPath: decoratorPath(methodMatch[2]),
      fullPath: joinEndpointPaths(controllerPath, decoratorPath(methodMatch[2])),
      body: methodBody(file.lines, index + 1),
    });
  }
  return methods;
}

function methodBody(lines: string[], startIndex: number): string[] {
  const body: string[] = [];
  let depth = 0;
  let opened = false;
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    body.push(line);
    depth += countChar(line, '{') - countChar(line, '}');
    if (line.includes('{')) opened = true;
    if (opened && depth <= 0) break;
  }
  return body;
}

function findStatusEvidence(statusCode: number, controller: ControllerMethodEvidence): EndpointContractEvidence | undefined {
  const exceptionNames = EXCEPTION_BY_STATUS[statusCode] ?? [];
  const httpStatusNames = HTTP_STATUS_BY_CODE[statusCode] ?? [];
  const patterns = [
    new RegExp(`\\bstatus\\s*\\(\\s*${statusCode}\\s*\\)`),
    new RegExp(`\\bstatusCode\\s*[:=]\\s*${statusCode}\\b`),
    ...httpStatusNames.map((name) => new RegExp(`\\bHttpStatus\\.${name}\\b`)),
    ...exceptionNames.map((name) => new RegExp(`\\b${name}\\b`)),
  ];
  return findBodyEvidence(controller, (line) => patterns.some((pattern) => pattern.test(line)));
}

function findMessageEvidence(message: string, controller: ControllerMethodEvidence): EndpointContractEvidence | undefined {
  return findBodyEvidence(controller, (line) => line.includes(message));
}

function findBodyEvidence(
  controller: ControllerMethodEvidence,
  predicate: (line: string) => boolean,
): EndpointContractEvidence | undefined {
  const index = controller.body.findIndex(predicate);
  if (index === -1) return undefined;
  return {
    file: controller.file,
    line: controller.line + index + 1,
    text: controller.body[index].trim(),
  };
}

function endpointMatchesMethod(endpoint: Endpoint, method: ControllerMethodEvidence): boolean {
  return endpoint.method === method.method && normalizeEndpointPath(endpoint.path) === normalizeEndpointPath(method.fullPath);
}

function normalizeEndpointPath(value: string): string {
  const normalized = value
    .replace(/^['"`]|['"`]$/g, '')
    .replace(/\{([^}]+)\}/g, ':$1')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
  return normalized.startsWith('/') ? normalized || '/' : `/${normalized}`;
}

function joinEndpointPaths(basePath: string, methodPath: string): string {
  return [basePath, methodPath]
    .map((part) => part.trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
}

function decoratorPath(args: string): string {
  const match = args.match(/['"`]([^'"`]*)['"`]/);
  return match?.[1] ?? '';
}

function controllerSummary(controller: ControllerMethodEvidence): Omit<ControllerMethodEvidence, 'body'> {
  const { body: _body, ...summary } = controller;
  return summary;
}

function collectSourceFiles(repoRoot: string): SourceFile[] {
  const files: SourceFile[] = [];
  collectSourceFilesInto(repoRoot, repoRoot, files);
  return files;
}

function collectSourceFilesInto(directory: string, repoRoot: string, files: SourceFile[]): void {
  let entries;
  try {
    entries = readdirSync(directory);
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(directory, entry);
    const relative = toPosixPath(path.relative(repoRoot, fullPath));
    let stats;
    try {
      stats = statSync(fullPath);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry)) collectSourceFilesInto(fullPath, repoRoot, files);
    } else if (stats.isFile() && SOURCE_FILE_PATTERN.test(entry) && !TEST_FILE_PATTERN.test(relative)) {
      files.push({ path: relative, lines: readFileSync(fullPath, 'utf-8').split(/\r?\n/) });
    }
  }
}

function countChar(value: string, char: string): number {
  return value.split(char).length - 1;
}

function formatEndpoint(endpoint: Endpoint): string {
  return `${endpoint.method} ${endpoint.path}`;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

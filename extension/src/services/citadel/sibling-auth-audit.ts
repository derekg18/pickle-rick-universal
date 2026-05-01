import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { ChangedFileSummary, DiffSummary } from './diff-walker.js';

export type SiblingAuthSeverity = 'Critical' | 'High' | 'Medium';

export interface SiblingAuthEvidence {
  file: string;
  line: number;
  text: string;
}

export interface ControllerRoute {
  file: string;
  line: number;
  controllerPath: string;
  methodName: string;
  httpMethod: string;
  methodPath: string;
  fullPath: string;
  resourcePrefix: string;
  guardPrefix: string[];
  roles: string[];
  destructive: boolean;
}

export interface GuardParityFinding {
  id: string;
  severity: 'Medium';
  message: string;
  controller: string;
  resourcePrefix: string;
  methods: string[];
  missingGuards: string[];
  evidence: SiblingAuthEvidence[];
}

export interface DestructiveRoleFinding {
  id: string;
  severity: 'Critical' | 'High';
  message: string;
  controller: string;
  methods: string[];
  roleAllowlists: Array<{
    method: string;
    roles: string[];
  }>;
  evidence: SiblingAuthEvidence[];
}

export interface SiblingAuthAuditReport {
  routes: ControllerRoute[];
  guardParityFindings: GuardParityFinding[];
  destructiveRoleFindings: DestructiveRoleFinding[];
  findings: Array<GuardParityFinding | DestructiveRoleFinding>;
  destructiveRoleDriftTable: string;
  summary: {
    controllers: number;
    routes: number;
    guardParityFindings: number;
    destructiveRoleFindings: number;
  };
}

interface SourceFile {
  path: string;
  lines: string[];
}

interface DecoratorEvidence {
  name: string;
  args: string;
  line: number;
  text: string;
}

interface ControllerClass {
  file: string;
  line: number;
  controllerPath: string;
  classDecorators: DecoratorEvidence[];
  methods: ControllerRoute[];
}

const CODE_FILE_PATTERN = /\.[cm]?tsx?$/i;
const DECORATOR_PATTERN = /^\s*@([A-Za-z_][\w.]*)\s*\((.*)\)\s*$/;
const HTTP_DECORATOR_PATTERN = /^(Get|Post|Put|Patch|Delete|Head|Options)$/i;
const METHOD_DECL_PATTERN = /^\s*(?:public|private|protected|async|static|\s)*([A-Za-z_]\w*)\s*\(/;
const DESTRUCTIVE_NAME_PATTERN = /(delete|revert|override|cancel|purge|destroy)/i;
const DESTRUCTIVE_ROUTE_PATTERN = /(revert|override|cancel|purge)-/i;

export function auditSiblingAuthPreconditions(diff: DiffSummary): SiblingAuthAuditReport {
  const controllers = loadControllerFiles(diff.changedFiles, diff.repoRoot).flatMap(parseControllers);
  const routes = stableRoutes(controllers.flatMap((controller) => controller.methods));
  const guardParityFindings = findGuardParityFindings(routes);
  const destructiveRoleFindings = findDestructiveRoleFindings(routes);
  const findings = [...guardParityFindings, ...destructiveRoleFindings].sort(compareFindings);

  return {
    routes,
    guardParityFindings,
    destructiveRoleFindings,
    findings,
    destructiveRoleDriftTable: renderDestructiveRoleDriftTable(destructiveRoleFindings),
    summary: {
      controllers: controllers.length,
      routes: routes.length,
      guardParityFindings: guardParityFindings.length,
      destructiveRoleFindings: destructiveRoleFindings.length,
    },
  };
}

function loadControllerFiles(changedFiles: ChangedFileSummary[], repoRoot: string): SourceFile[] {
  return changedFiles.flatMap((summary) => {
    if (summary.kind !== 'production' || summary.status === 'D' || !CODE_FILE_PATTERN.test(summary.path)) return [];
    try {
      return [{
        path: summary.path,
        lines: readFileSync(path.join(repoRoot, summary.path), 'utf-8').split(/\r?\n/),
      }];
    } catch {
      return [];
    }
  });
}

function parseControllers(file: SourceFile): ControllerClass[] {
  const controllers: ControllerClass[] = [];
  let pendingDecorators: DecoratorEvidence[] = [];
  let current: ControllerClass | undefined;

  for (let index = 0; index < file.lines.length; index += 1) {
    const line = file.lines[index];
    const decorator = parseDecorator(line, index + 1);
    if (decorator) {
      pendingDecorators.push(decorator);
      continue;
    }

    const controllerDecorator = pendingDecorators.find((entry) => entry.name === 'Controller');
    if (controllerDecorator && /\bclass\s+[A-Za-z_]\w*/.test(line)) {
      current = {
        file: file.path,
        line: index + 1,
        controllerPath: decoratorPath(controllerDecorator.args),
        classDecorators: pendingDecorators,
        methods: [],
      };
      controllers.push(current);
      pendingDecorators = [];
      continue;
    }

    if (!current) {
      pendingDecorators = [];
      continue;
    }

    const httpDecorator = pendingDecorators.find((entry) => HTTP_DECORATOR_PATTERN.test(entry.name));
    const methodMatch = line.match(METHOD_DECL_PATTERN);
    if (httpDecorator && methodMatch) {
      current.methods.push(toRoute(file, current, pendingDecorators, httpDecorator, methodMatch[1], index + 1));
    }
    pendingDecorators = [];
  }

  return controllers;
}

function parseDecorator(line: string, lineNumber: number): DecoratorEvidence | undefined {
  const match = line.match(DECORATOR_PATTERN);
  if (!match) return undefined;
  return {
    name: match[1].split('.').at(-1) ?? match[1],
    args: match[2],
    line: lineNumber,
    text: line.trim(),
  };
}

function toRoute(
  file: SourceFile,
  controller: ControllerClass,
  methodDecorators: DecoratorEvidence[],
  httpDecorator: DecoratorEvidence,
  methodName: string,
  methodLine: number,
): ControllerRoute {
  const methodPath = decoratorPath(httpDecorator.args);
  const fullPath = normalizePath(joinEndpointPaths(controller.controllerPath, methodPath));
  const body = methodBody(file.lines, methodLine);
  const allDecorators = [...controller.classDecorators, ...methodDecorators];
  const roles = uniqueSortedStrings(allDecorators.filter((entry) => entry.name === 'Roles').flatMap((entry) => roleArgs(entry.args)));
  return {
    file: file.path,
    line: httpDecorator.line,
    controllerPath: normalizePath(controller.controllerPath),
    methodName,
    httpMethod: httpDecorator.name.toUpperCase(),
    methodPath: normalizePath(methodPath),
    fullPath,
    resourcePrefix: resourcePrefix(fullPath),
    guardPrefix: guardPrefix(allDecorators, body),
    roles,
    destructive: isDestructiveRoute(httpDecorator, methodName, methodPath),
  };
}

function methodBody(lines: string[], startLine: number): string[] {
  const body: string[] = [];
  let depth = 0;
  let opened = false;
  for (let index = startLine - 1; index < lines.length; index += 1) {
    const line = lines[index];
    body.push(line);
    depth += countChar(line, '{') - countChar(line, '}');
    if (line.includes('{')) opened = true;
    if (opened && depth <= 0) break;
  }
  return body;
}

function guardPrefix(decorators: DecoratorEvidence[], body: string[]): string[] {
  const tokens = decorators.flatMap(decoratorGuardTokens);
  if (body.some((line) => /featureFlag|flagGate|isFeatureEnabled|requireFeature/i.test(line))) tokens.push('flag-check');
  if (body.some((line) => /ownership|owner|ownedBy|assertOwner|requireOwner/i.test(line))) tokens.push('ownership-lookup');
  if (body.some((line) => /status|state|assertStatus|validateStatus|requireStatus/i.test(line))) tokens.push('status-validation');
  return uniqueSortedStrings(tokens);
}

function decoratorGuardTokens(decorator: DecoratorEvidence): string[] {
  if (decorator.name === 'Roles') return [`roles(${roleArgs(decorator.args).join(',')})`];
  if (decorator.name === 'UseGuards') return [`guards(${argumentTokens(decorator.args).join(',')})`];
  return [];
}

function findGuardParityFindings(routes: ControllerRoute[]): GuardParityFinding[] {
  const groups = groupBy(routes, (route) => `${route.file}|${route.resourcePrefix}`);
  return [...groups.values()].flatMap((group) => {
    if (group.length < 2) return [];
    const signatures = new Set(group.map((route) => route.guardPrefix.join('|')));
    if (signatures.size <= 1) return [];
    const expected = uniqueSortedStrings(group.flatMap((route) => route.guardPrefix));
    const missingGuards = uniqueSortedStrings(group.flatMap((route) => expected.filter((token) => !route.guardPrefix.includes(token))));
    const first = group[0];
    return [{
      id: `citadel-sibling-guard-parity-${slug(first.file)}-${slug(first.resourcePrefix)}`,
      severity: 'Medium' as const,
      message: `Sibling guard/precondition drift under ${first.resourcePrefix}.`,
      controller: first.file,
      resourcePrefix: first.resourcePrefix,
      methods: group.map(formatRouteMethod).sort((a, b) => a.localeCompare(b)),
      missingGuards,
      evidence: group.map(routeEvidence),
    }];
  }).sort(compareFindings);
}

function findDestructiveRoleFindings(routes: ControllerRoute[]): DestructiveRoleFinding[] {
  const destructiveRoutes = routes.filter((route) => route.destructive);
  const missingRoleFindings = destructiveRoutes
    .filter((route) => route.roles.length === 0)
    .map(missingRoleFinding);
  const driftFindings = [...groupBy(destructiveRoutes, (route) => route.file).values()]
    .filter((group) => group.length > 1 && new Set(group.map((route) => route.roles.join('|'))).size > 1)
    .map(destructiveRoleDriftFinding);
  return [...missingRoleFindings, ...driftFindings].sort(compareFindings);
}

function missingRoleFinding(route: ControllerRoute): DestructiveRoleFinding {
  return {
    id: `citadel-destructive-role-missing-${slug(route.file)}-${slug(route.methodName)}`,
    severity: 'Critical',
    message: `Destructive route ${route.methodName} has no effective @Roles allowlist.`,
    controller: route.file,
    methods: [formatRouteMethod(route)],
    roleAllowlists: [{ method: formatRouteMethod(route), roles: [] }],
    evidence: [routeEvidence(route)],
  };
}

function destructiveRoleDriftFinding(routes: ControllerRoute[]): DestructiveRoleFinding {
  const first = routes[0];
  const methods = routes.map(formatRouteMethod).sort((a, b) => a.localeCompare(b));
  return {
    id: `citadel-destructive-role-drift-${slug(first.file)}`,
    severity: 'High',
    message: `destructive-role drift in ${first.file}.`,
    controller: first.file,
    methods,
    roleAllowlists: routes
      .map((route) => ({ method: formatRouteMethod(route), roles: route.roles }))
      .sort((a, b) => a.method.localeCompare(b.method)),
    evidence: routes.map(routeEvidence),
  };
}

function renderDestructiveRoleDriftTable(findings: DestructiveRoleFinding[]): string {
  const driftFindings = findings.filter((finding) => finding.severity === 'High');
  return [
    '| Controller | Method | Roles |',
    '|---|---|---|',
    ...driftFindings.flatMap((finding) =>
      finding.roleAllowlists.map((row) => `| ${escapeTableCell(finding.controller)} | ${escapeTableCell(row.method)} | ${escapeTableCell(row.roles.join(', ') || '(none)')} |`),
    ),
  ].join('\n');
}

function isDestructiveRoute(httpDecorator: DecoratorEvidence, methodName: string, methodPath: string): boolean {
  return httpDecorator.name.toLowerCase() === 'delete' ||
    DESTRUCTIVE_NAME_PATTERN.test(methodName) ||
    DESTRUCTIVE_ROUTE_PATTERN.test(methodPath);
}

function routeEvidence(route: ControllerRoute): SiblingAuthEvidence {
  return {
    file: route.file,
    line: route.line,
    text: `${route.httpMethod} ${route.fullPath} ${route.methodName}`,
  };
}

function formatRouteMethod(route: ControllerRoute): string {
  return `${route.methodName} (${route.httpMethod} ${route.fullPath})`;
}

function resourcePrefix(fullPath: string): string {
  const segments = fullPath.split('/').filter(Boolean);
  if (segments.length <= 1) return fullPath;
  return `/${segments.slice(0, -1).join('/')}`;
}

function decoratorPath(args: string): string {
  const match = args.match(/['"`]([^'"`]*)['"`]/);
  return match?.[1] ?? '';
}

function roleArgs(args: string): string[] {
  return argumentTokens(args).map((role) => role.replace(/^Roles?\./, ''));
}

function argumentTokens(args: string): string[] {
  return args
    .split(',')
    .map((arg) => arg.trim().replace(/^['"`]|['"`]$/g, ''))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

function joinEndpointPaths(basePath: string, methodPath: string): string {
  return [basePath, methodPath]
    .map((part) => part.trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
}

function normalizePath(value: string): string {
  const normalized = value
    .replace(/^['"`]|['"`]$/g, '')
    .replace(/\{([^}]+)\}/g, ':$1')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
  return normalized.startsWith('/') ? normalized || '/' : `/${normalized}`;
}

function stableRoutes(routes: ControllerRoute[]): ControllerRoute[] {
  return [...routes].sort((a, b) =>
    a.file.localeCompare(b.file) ||
    a.line - b.line ||
    a.methodName.localeCompare(b.methodName));
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return groups;
}

function compareFindings(a: { id: string; severity: string }, b: { id: string; severity: string }): number {
  return severityRank(a.severity) - severityRank(b.severity) || a.id.localeCompare(b.id);
}

function severityRank(severity: string): number {
  if (severity === 'Critical') return 0;
  if (severity === 'High') return 1;
  return 2;
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function uniqueSortedStrings(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function countChar(value: string, char: string): number {
  return value.split(char).length - 1;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'unknown';
}

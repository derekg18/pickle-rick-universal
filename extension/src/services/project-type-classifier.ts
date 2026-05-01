import * as fs from 'node:fs';
import * as path from 'node:path';

export const PROJECT_TYPE_CATEGORIES = [
  'web',
  'mobile',
  'backend',
  'cli',
  'library',
  'desktop',
  'game',
  'data',
  'extension',
  'infra/embedded',
] as const;

export type ProjectTypeCategory = typeof PROJECT_TYPE_CATEGORIES[number];
export type ProjectTypeConfidence = 'high' | 'medium' | 'low';

export interface ProjectTypeDefinition {
  category: ProjectTypeCategory;
  label: string;
  description: string;
  filePatterns: string[];
  directoryPatterns: string[];
  packageKeywords: string[];
}

export interface ProjectTypeScore {
  category: ProjectTypeCategory;
  score: number;
  matchedFiles: string[];
  matchedDirectories: string[];
  matchedPackages: string[];
}

export interface ProjectTypeClassification {
  category: ProjectTypeCategory;
  confidence: ProjectTypeConfidence;
  reason: string;
  registryPath: string;
  scores: ProjectTypeScore[];
}

export interface ClassifyProjectTypeOptions {
  extensionRoot: string;
  maxFiles?: number;
}

const CSV_COLUMNS = [
  'category',
  'label',
  'description',
  'file_patterns',
  'directory_patterns',
  'package_keywords',
];

const IGNORED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  'vendor',
]);

export function getProjectTypesCsvPath(extensionRoot: string): string {
  return path.join(extensionRoot, 'extension', 'data', 'project-types.csv');
}

export function loadProjectTypeDefinitions(extensionRoot: string): ProjectTypeDefinition[] {
  const registryPath = getProjectTypesCsvPath(extensionRoot);
  const rows = parseCsv(fs.readFileSync(registryPath, 'utf8'));
  return rows.map(definitionFromRow);
}

export function classifyProjectType(projectRoot: string, options: ClassifyProjectTypeOptions): ProjectTypeClassification {
  const registryPath = getProjectTypesCsvPath(options.extensionRoot);
  const definitions = loadProjectTypeDefinitions(options.extensionRoot);
  const files = listProjectFiles(projectRoot, options.maxFiles ?? 2_000);
  const packageKeywords = readPackageKeywords(projectRoot);
  const scores = definitions
    .map((definition) => scoreDefinition(definition, files, packageKeywords))
    .sort((a, b) => b.score - a.score || a.category.localeCompare(b.category));
  const best = scores[0] ?? emptyScore('library');
  return {
    category: best.category,
    confidence: confidenceFor(best, scores[1]),
    reason: reasonFor(best),
    registryPath,
    scores,
  };
}

function definitionFromRow(row: Record<string, string>): ProjectTypeDefinition {
  const category = row.category;
  if (!isProjectTypeCategory(category)) {
    throw new Error(`Unknown project type category in project-types.csv: ${category}`);
  }
  return {
    category,
    label: row.label,
    description: row.description,
    filePatterns: splitCell(row.file_patterns),
    directoryPatterns: splitCell(row.directory_patterns),
    packageKeywords: splitCell(row.package_keywords).map((keyword) => keyword.toLowerCase()),
  };
}

function scoreDefinition(
  definition: ProjectTypeDefinition,
  files: string[],
  packageKeywords: Set<string>
): ProjectTypeScore {
  const matchedFiles = unique(files.filter((file) => definition.filePatterns.some((pattern) => matchesPattern(file, pattern))));
  const matchedDirectories = unique(files.flatMap((file) => matchingDirectories(file, definition.directoryPatterns)));
  const matchedPackages = definition.packageKeywords.filter((keyword) => packageKeywords.has(keyword));
  return {
    category: definition.category,
    score: matchedFiles.length * 5 + matchedDirectories.length * 2 + matchedPackages.length * 8,
    matchedFiles,
    matchedDirectories,
    matchedPackages,
  };
}

function listProjectFiles(projectRoot: string, maxFiles: number): string[] {
  const files: string[] = [];
  const stack = [''];
  while (stack.length > 0 && files.length < maxFiles) {
    const relativeDir = stack.pop() ?? '';
    const absoluteDir = path.join(projectRoot, relativeDir);
    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
      const relativePath = path.posix.join(relativeDir.split(path.sep).join(path.posix.sep), entry.name);
      collectEntry(entry, relativePath, stack, files);
      if (files.length >= maxFiles) break;
    }
  }
  return files;
}

function collectEntry(entry: fs.Dirent, relativePath: string, stack: string[], files: string[]): void {
  if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name.toLowerCase())) {
    stack.push(relativePath);
    return;
  }
  if (entry.isFile()) files.push(relativePath);
}

function readPackageKeywords(projectRoot: string): Set<string> {
  const packagePath = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(packagePath)) return new Set();
  try {
    const manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      keywords?: string[];
    };
    return new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
      ...(manifest.keywords ?? []),
    ].map((keyword) => keyword.toLowerCase()));
  } catch {
    return new Set();
  }
}

function matchingDirectories(file: string, patterns: string[]): string[] {
  const parts = file.split('/').slice(0, -1).map((part) => part.toLowerCase());
  return patterns.filter((pattern) => parts.includes(pattern.toLowerCase()));
}

function matchesPattern(file: string, pattern: string): boolean {
  const normalizedFile = file.toLowerCase();
  const normalizedPattern = pattern.toLowerCase().replaceAll('\\', '/');
  if (normalizedPattern.includes('*')) return globLikeMatch(normalizedFile, normalizedPattern);
  if (normalizedPattern.includes('/')) return normalizedFile === normalizedPattern || normalizedFile.startsWith(`${normalizedPattern}/`);
  return path.posix.basename(normalizedFile) === normalizedPattern || normalizedFile.includes(normalizedPattern);
}

function globLikeMatch(file: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`).test(file);
}

function confidenceFor(best: ProjectTypeScore, runnerUp?: ProjectTypeScore): ProjectTypeConfidence {
  if (best.score >= 30 && (!runnerUp || best.score >= runnerUp.score + 10)) return 'high';
  if (best.score >= 15) return 'medium';
  return 'low';
}

function reasonFor(score: ProjectTypeScore): string {
  const parts = [
    `${score.matchedFiles.length} file-pattern matches`,
    `${score.matchedDirectories.length} directory matches`,
    `${score.matchedPackages.length} package matches`,
  ];
  return parts.join(', ');
}

function splitCell(value: string): string[] {
  return value.split(';').map((part) => part.trim()).filter(Boolean);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function emptyScore(category: ProjectTypeCategory): ProjectTypeScore {
  return { category, score: 0, matchedFiles: [], matchedDirectories: [], matchedPackages: [] };
}

function isProjectTypeCategory(value: string): value is ProjectTypeCategory {
  return PROJECT_TYPE_CATEGORIES.includes(value as ProjectTypeCategory);
}

function parseCsv(input: string): Record<string, string>[] {
  const rows = input.trim().split(/\r?\n/).map(parseCsvLine);
  const header = rows.shift();
  if (!header || header.join(',') !== CSV_COLUMNS.join(',')) {
    throw new Error(`project-types.csv header must be: ${CSV_COLUMNS.join(',')}`);
  }
  return rows.map((row) => Object.fromEntries(header.map((column, index) => [column, row[index] ?? ''])));
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

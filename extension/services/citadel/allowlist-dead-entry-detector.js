import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
const DEFAULT_MAX_CALLERS = 3;
const CODE_FILE_PATTERN = /\.[cm]?[jt]sx?$/i;
const TEST_FILE_PATTERN = /(?:^|\/)(?:__tests__|tests?|specs?)(?:\/|$)|(?:\.|-)test\.[cm]?[jt]sx?$|(?:\.|-)spec\.[cm]?[jt]sx?$/i;
const SKIPPED_DIRS = new Set(['.git', 'node_modules']);
const STRING_LITERAL_PATTERN = /["'`]([A-Za-z0-9_.:-]+)["'`]/g;
const QUOTED_KEY_PATTERN = /(?:^|[,{\s])\s*["'`]([A-Za-z0-9_.:-]+)["'`]\s*:/g;
const IDENTIFIER_KEY_PATTERN = /(?:^|[,{\s])\s*([A-Za-z_$][\w$]*)\s*:/g;
const ENUM_VALUE_PATTERN = /^\s*([A-Za-z_$][\w$]*)\s*(?:=\s*["'`]([^"'`]+)["'`])?\s*,?/;
export function detectAllowlistDeadEntries(diff, options = {}) {
    const repoRoot = path.resolve(options.repoRoot ?? diff.repoRoot);
    const maxCallers = options.maxCallersPerEntry ?? DEFAULT_MAX_CALLERS;
    const entries = extractAllowlistDeclarations(diff, repoRoot);
    const productionFiles = collectProductionFiles(repoRoot);
    const liveEntries = entries
        .map((entry) => ({
        entry,
        callers: findCallers(entry, productionFiles, maxCallers),
    }))
        .filter((result) => result.callers.length > 0);
    const findings = entries
        .filter((entry) => !liveEntries.some((liveEntry) => sameDeclaration(liveEntry.entry, entry)))
        .map(toFinding);
    return {
        entries,
        liveEntries,
        findings,
    };
}
function extractAllowlistDeclarations(diff, repoRoot) {
    const declarations = new Map();
    for (const file of loadChangedProductionFiles(diff.changedFiles, repoRoot)) {
        const state = { validActionsDepth: 0, featureFlagsDepth: 0, enumDepth: 0 };
        file.lines.forEach((line, index) => {
            const lineNumber = index + 1;
            const before = { ...state };
            enterContexts(line, state);
            if (file.changedLines.has(lineNumber)) {
                for (const declaration of declarationsFromLine(file.summary.path, line, lineNumber, state, before)) {
                    declarations.set(declarationKey(declaration), declaration);
                }
            }
            exitContexts(line, state);
        });
    }
    return [...declarations.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.value.localeCompare(b.value));
}
function loadChangedProductionFiles(changedFiles, repoRoot) {
    return changedFiles.flatMap((summary) => {
        if (summary.status === 'D' || summary.kind !== 'production' || !CODE_FILE_PATTERN.test(summary.path))
            return [];
        try {
            const content = readFileSync(path.join(repoRoot, summary.path), 'utf-8');
            return [
                {
                    summary,
                    lines: content.split(/\r?\n/),
                    changedLines: changedLineNumbers(summary),
                },
            ];
        }
        catch {
            return [];
        }
    });
}
function changedLineNumbers(summary) {
    const lines = new Set();
    for (const range of summary.changedLines) {
        for (let line = range.start; line <= range.end; line += 1) {
            lines.add(line);
        }
    }
    return lines;
}
function enterContexts(line, state) {
    if (state.validActionsDepth === 0 && /\bVALID_ACTIONS\b/.test(line)) {
        state.validActionsDepth = braceDepth(line);
    }
    else if (state.validActionsDepth > 0) {
        state.validActionsDepth += braceDepth(line);
    }
    if (state.featureFlagsDepth === 0 && /\blender_feature_flags\b/.test(line)) {
        state.featureFlagsDepth = braceDepth(line);
    }
    else if (state.featureFlagsDepth > 0) {
        state.featureFlagsDepth += braceDepth(line);
    }
    if (state.enumDepth === 0) {
        const enumMatch = line.match(/\benum\s+([A-Za-z_$][\w$]*)\b/);
        if (enumMatch) {
            state.enumName = enumMatch[1];
            state.enumDepth = braceDepth(line);
        }
    }
    else {
        state.enumDepth += braceDepth(line);
    }
}
function exitContexts(line, state) {
    if (state.validActionsDepth <= 0 && !/\bVALID_ACTIONS\b/.test(line)) {
        state.validActionsDepth = 0;
    }
    if (state.featureFlagsDepth <= 0 && !/\blender_feature_flags\b/.test(line)) {
        state.featureFlagsDepth = 0;
    }
    if (state.enumDepth <= 0 && !/\benum\s+/.test(line)) {
        state.enumDepth = 0;
        state.enumName = undefined;
    }
}
function declarationsFromLine(file, line, lineNumber, state, before) {
    return [
        ...validActionDeclarations(file, line, lineNumber, state, before),
        ...featureFlagDeclarations(file, line, lineNumber, state, before),
        ...enumValueDeclarations(file, line, lineNumber, state, before),
    ];
}
function validActionDeclarations(file, line, lineNumber, state, before) {
    if (state.validActionsDepth <= 0 && before.validActionsDepth <= 0 && !/\bVALID_ACTIONS\b/.test(line))
        return [];
    return stringLiterals(line).map((value) => ({
        file,
        name: 'VALID_ACTIONS',
        value,
        line: lineNumber,
        kind: 'valid_action',
        text: line.trim(),
    }));
}
function featureFlagDeclarations(file, line, lineNumber, state, before) {
    if (state.featureFlagsDepth <= 0 && before.featureFlagsDepth <= 0 && !/\blender_feature_flags\b/.test(line))
        return [];
    const values = featureFlagKeys(line);
    return uniqueSortedStrings(values).map((value) => ({
        file,
        name: 'lender_feature_flags',
        value,
        line: lineNumber,
        kind: 'lender_feature_flag',
        text: line.trim(),
    }));
}
function featureFlagKeys(line) {
    const values = [];
    for (const match of line.matchAll(QUOTED_KEY_PATTERN)) {
        values.push(match[1]);
    }
    for (const match of line.matchAll(IDENTIFIER_KEY_PATTERN)) {
        const identifierKey = match[1];
        if (identifierKey && identifierKey !== 'lender_feature_flags')
            values.push(identifierKey);
    }
    return values;
}
function enumValueDeclarations(file, line, lineNumber, state, before) {
    if (state.enumDepth <= 0 && before.enumDepth <= 0)
        return [];
    const match = line.match(ENUM_VALUE_PATTERN);
    if (!match || line.includes('enum '))
        return [];
    const value = match[2] ?? match[1];
    if (!value || value === 'export' || value === 'const')
        return [];
    return [
        {
            file,
            name: state.enumName ?? before.enumName ?? 'enum',
            value,
            line: lineNumber,
            kind: 'enum_value',
            text: line.trim(),
        },
    ];
}
function collectProductionFiles(repoRoot) {
    const files = [];
    collectProductionFilesFromDirectory(repoRoot, repoRoot, files);
    return files.sort((a, b) => a.path.localeCompare(b.path));
}
function collectProductionFilesFromDirectory(directory, repoRoot, files) {
    let entries;
    try {
        entries = readdirSync(directory, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);
        const relativePath = toPosixPath(path.relative(repoRoot, fullPath));
        if (entry.isDirectory()) {
            if (!SKIPPED_DIRS.has(entry.name))
                collectProductionFilesFromDirectory(fullPath, repoRoot, files);
            continue;
        }
        if (!entry.isFile() || !CODE_FILE_PATTERN.test(relativePath) || isTestFile(relativePath))
            continue;
        try {
            if (!statSync(fullPath).isFile())
                continue;
            files.push({ path: relativePath, lines: readFileSync(fullPath, 'utf-8').split(/\r?\n/) });
        }
        catch {
            // Ignore unreadable files; callers are evidence, not required inputs.
        }
    }
}
function findCallers(entry, files, maxCallers) {
    const callers = [];
    for (const file of files) {
        file.lines.forEach((line, index) => {
            const lineNumber = index + 1;
            if (file.path === entry.file && lineNumber === entry.line)
                return;
            if (!line.includes(entry.value))
                return;
            callers.push({ file: file.path, line: lineNumber, text: line.trim() });
        });
        if (callers.length >= maxCallers)
            break;
    }
    return callers.slice(0, maxCallers);
}
function toFinding(entry) {
    return {
        id: `citadel-dead-allowlist-${entry.kind}-${slug(entry.value)}-${entry.line}`,
        severity: 'High',
        message: `${entry.kind} '${entry.value}' has no production caller; dead allowlist; deploy-ordering smell.`,
        entry,
        declaration: {
            file: entry.file,
            line: entry.line,
            text: entry.text,
        },
    };
}
function stringLiterals(line) {
    const values = [];
    for (const match of line.matchAll(STRING_LITERAL_PATTERN)) {
        values.push(match[1]);
    }
    return values;
}
function braceDepth(line) {
    let depth = 0;
    for (const char of line) {
        if (char === '[' || char === '{')
            depth += 1;
        if (char === ']' || char === '}')
            depth -= 1;
    }
    return depth;
}
function sameDeclaration(a, b) {
    return a.file === b.file && a.line === b.line && a.kind === b.kind && a.value === b.value;
}
function declarationKey(entry) {
    return `${entry.file}:${entry.line}:${entry.kind}:${entry.name}:${entry.value}`;
}
function slug(value) {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'entry';
}
function isTestFile(filePath) {
    return TEST_FILE_PATTERN.test(toPosixPath(filePath));
}
function uniqueSortedStrings(values) {
    return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}
function toPosixPath(filePath) {
    return filePath.split(path.sep).join('/');
}

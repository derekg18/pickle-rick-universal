import * as fs from 'fs';
import * as path from 'path';
const COMMANDS = [
    'squanch',
    'simple-rick',
    'memory-parasites',
    'jerry-detector',
    'detoxifier',
    'doofus-rick',
];
const COMMAND_SUMMARIES = {
    'simple-rick': 'Simplicity analysis preview is ready.',
    'memory-parasites': 'Dead-code analysis preview is ready.',
    'jerry-detector': 'Technical-debt analysis preview is ready.',
    detoxifier: 'Cleanup analysis preview is ready.',
    'doofus-rick': 'Explainer analysis preview is ready.',
};
export function isQualityRefactorCommand(value) {
    return COMMANDS.includes(value);
}
function optionValue(args, index, name) {
    const arg = args[index];
    if (arg === name)
        return args[index + 1];
    if (arg.startsWith(`${name}=`))
        return arg.slice(name.length + 1);
    return undefined;
}
export function parseQualityRefactorArgs(args) {
    const parsed = {
        apply: false,
        confirmApply: false,
    };
    const positional = [];
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === '--apply') {
            parsed.apply = true;
            continue;
        }
        if (arg === '--confirm-apply') {
            parsed.confirmApply = true;
            continue;
        }
        const target = optionValue(args, index, '--target') ?? optionValue(args, index, '--path');
        if (target !== undefined) {
            parsed.target = target;
            if (arg === '--target' || arg === '--path')
                index++;
            continue;
        }
        const pattern = optionValue(args, index, '--pattern') ?? optionValue(args, index, '--regex');
        if (pattern !== undefined) {
            parsed.pattern = pattern;
            if (arg === '--pattern' || arg === '--regex')
                index++;
            continue;
        }
        const replacement = optionValue(args, index, '--replacement') ?? optionValue(args, index, '--replace');
        if (replacement !== undefined) {
            parsed.replacement = replacement;
            if (arg === '--replacement' || arg === '--replace')
                index++;
            continue;
        }
        if (!arg.startsWith('--'))
            positional.push(arg);
    }
    if (!parsed.target && positional.length > 0)
        parsed.target = positional[0];
    if (!parsed.pattern && positional.length > 1)
        parsed.pattern = positional[1];
    if (parsed.replacement === undefined && positional.length > 2)
        parsed.replacement = positional[2];
    return parsed;
}
function failed(command, summary, remediation) {
    return {
        command,
        status: 'failed',
        summary,
        remediation,
    };
}
function ensurePreviewMode(command, parsed) {
    if (parsed.apply && !parsed.confirmApply) {
        return failed(command, 'Destructive apply was requested without confirmation.', 'Re-run without --apply for a preview, or pass both --apply and --confirm-apply after reviewing the preview and rollback artifact.');
    }
    return null;
}
function safeStamp(ctx) {
    return (ctx.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
}
function resolveTarget(command, parsed, ctx) {
    const rawTarget = parsed.target?.trim();
    if (!rawTarget) {
        return failed(command, 'No target path was provided.', 'Pass --target <file-or-directory> so the command can produce a bounded preview.');
    }
    const workspace = ctx.workspaceDir ?? process.cwd();
    const absolutePath = path.resolve(workspace, rawTarget);
    const exists = ctx.fileExists ?? fs.existsSync;
    if (!exists(absolutePath)) {
        return failed(command, `Target path does not exist: ${rawTarget}`, 'Pass an existing file or directory path. Preview mode never creates missing targets.');
    }
    return {
        absolutePath,
        files: collectFiles(absolutePath),
    };
}
function collectFiles(targetPath) {
    const stat = fs.statSync(targetPath);
    if (stat.isFile())
        return [targetPath];
    if (!stat.isDirectory())
        return [];
    const ignored = new Set(['.git', 'node_modules', '.pickle']);
    const files = [];
    const stack = [targetPath];
    while (stack.length > 0) {
        const current = stack.pop();
        if (!current)
            continue;
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            if (ignored.has(entry.name))
                continue;
            const entryPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(entryPath);
            }
            else if (entry.isFile()) {
                files.push(entryPath);
            }
        }
    }
    return files.sort();
}
function readText(filePath, ctx) {
    const text = ctx.readTextFile ? ctx.readTextFile(filePath) : fs.readFileSync(filePath, 'utf-8');
    return text.includes('\u0000') ? null : text;
}
function makeRegex(command, pattern) {
    const trimmed = pattern?.trim();
    if (!trimmed) {
        return failed(command, 'No search regex was provided.', 'Pass --pattern <regex> and --replacement <text> to generate a search/replace preview.');
    }
    if (trimmed === '.*' || trimmed === '.+' || trimmed === '^' || trimmed === '$') {
        return failed(command, `Unsafe search regex rejected: ${trimmed}`, 'Use a narrower regex that cannot match every line or a zero-width position.');
    }
    try {
        const regex = new RegExp(trimmed, 'g');
        if (regex.test('')) {
            return failed(command, `Unsafe search regex rejected: ${trimmed}`, 'Use a regex that cannot match empty strings.');
        }
        return new RegExp(trimmed, 'g');
    }
    catch (err) {
        return failed(command, `Invalid search regex: ${String(err instanceof Error ? err.message : err)}`, 'Fix the regular expression syntax and re-run in preview mode.');
    }
}
function lineNumberForIndex(text, index) {
    return text.slice(0, index).split(/\r?\n/).length;
}
function artifactDir(ctx) {
    return path.join(ctx.workspaceDir ?? process.cwd(), '.pickle', 'quality-refactor');
}
function writeArtifacts(command, target, preview, rollbackEntries, ctx) {
    const dir = artifactDir(ctx);
    const mkdir = ctx.mkdir ?? ((dirPath) => fs.mkdirSync(dirPath, { recursive: true }));
    const write = ctx.writeTextFile ?? ((filePath, text) => fs.writeFileSync(filePath, text));
    mkdir(dir);
    const stamp = safeStamp(ctx);
    const basename = `${command}-${stamp}`;
    const previewPath = path.join(dir, `${basename}.preview.json`);
    const rollbackPath = path.join(dir, `${basename}.rollback.json`);
    const generatedAt = (ctx.now ?? new Date()).toISOString();
    const artifact = {
        kind: 'quality-refactor-preview',
        command,
        target: target.absolutePath,
        preview_only: true,
        preview_path: previewPath,
        rollback_path: rollbackPath,
        generated_at: generatedAt,
    };
    write(previewPath, `${JSON.stringify({ artifact, preview }, null, 2)}\n`);
    write(rollbackPath, `${JSON.stringify({
        command,
        target: target.absolutePath,
        generated_at: generatedAt,
        entries: rollbackEntries,
    }, null, 2)}\n`);
    return artifact;
}
function runSquanch(parsed, ctx) {
    const regex = makeRegex('squanch', parsed.pattern);
    if (!(regex instanceof RegExp))
        return regex;
    const target = resolveTarget('squanch', parsed, ctx);
    if ('status' in target)
        return target;
    const replacement = parsed.replacement ?? '';
    const suggestedChanges = [];
    const rollbackEntries = {};
    for (const file of target.files) {
        const text = readText(file, ctx);
        if (text === null)
            continue;
        regex.lastIndex = 0;
        let match = regex.exec(text);
        while (match) {
            const before = match[0];
            const after = before.replace(new RegExp(regex.source), replacement);
            suggestedChanges.push({
                file,
                line: lineNumberForIndex(text, match.index),
                summary: `Replace ${JSON.stringify(before)} with ${JSON.stringify(after)}.`,
                before,
                after,
            });
            rollbackEntries[file] = text;
            match = regex.exec(text);
        }
    }
    const preview = {
        mode: 'preview',
        dry_run: true,
        apply_requested: parsed.apply,
        suggested_changes: suggestedChanges,
    };
    const artifact = writeArtifacts('squanch', target, preview, rollbackEntries, ctx);
    return {
        command: 'squanch',
        status: 'success',
        summary: `Search/replace preview generated with ${suggestedChanges.length} suggested change${suggestedChanges.length === 1 ? '' : 's'}.`,
        preview,
        artifact,
    };
}
function runAnalysisCommand(command, parsed, ctx) {
    const target = resolveTarget(command, parsed, ctx);
    if ('status' in target)
        return target;
    const suggestedChanges = target.files.slice(0, 25).map((file) => ({
        file,
        summary: analysisSummaryFor(command, file),
    }));
    const preview = {
        mode: 'preview',
        dry_run: true,
        apply_requested: parsed.apply,
        suggested_changes: suggestedChanges,
    };
    const artifact = writeArtifacts(command, target, preview, {}, ctx);
    return {
        command,
        status: 'success',
        summary: COMMAND_SUMMARIES[command],
        preview,
        artifact,
    };
}
function analysisSummaryFor(command, file) {
    switch (command) {
        case 'simple-rick':
            return `Review ${file} for simpler control flow and smaller responsibilities.`;
        case 'memory-parasites':
            return `Review ${file} for unused exports, dead branches, and stale fixtures.`;
        case 'jerry-detector':
            return `Review ${file} for debt markers, fragile coupling, and unclear ownership.`;
        case 'detoxifier':
            return `Review ${file} for cleanup candidates that can be changed safely after preview.`;
        case 'doofus-rick':
            return `Prepare an explainer outline for ${file} without modifying it.`;
        case 'squanch':
            return `Preview regex replacements in ${file}.`;
    }
}
export function runQualityRefactorCommand(command, args = [], ctx = {}) {
    const parsed = parseQualityRefactorArgs(args);
    const applyError = ensurePreviewMode(command, parsed);
    if (applyError)
        return applyError;
    if (command === 'squanch')
        return runSquanch(parsed, ctx);
    return runAnalysisCommand(command, parsed, ctx);
}
export function runQualityRefactorCommandByName(command, args = [], ctx = {}) {
    if (!isQualityRefactorCommand(command)) {
        return failed('doofus-rick', `Unknown quality/refactor command: ${command}`, `Use one of: ${COMMANDS.join(', ')}.`);
    }
    return runQualityRefactorCommand(command, args, ctx);
}

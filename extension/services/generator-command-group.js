import * as fs from 'fs';
import * as path from 'path';
const COMMANDS = [
    'ricks-flask',
    'morty-smith-database',
    'unity',
    'gazorpazorp',
    'butter-robot',
    'snake-jazz',
];
const UNSAFE_FLAGS = new Set([
    '--apply',
    '--execute',
    '--install',
    '--migrate',
    '--no-preview',
    '--run',
    '--write',
]);
function isGeneratorCommand(value) {
    return COMMANDS.includes(value);
}
function defaultSchema(name = 'fixture') {
    return {
        name,
        tables: [
            {
                name: 'users',
                columns: {
                    id: 'string',
                    email: 'string',
                    active: 'boolean',
                },
            },
            {
                name: 'posts',
                columns: {
                    id: 'string',
                    user_id: 'string',
                    title: 'string',
                },
            },
        ],
    };
}
function parseArgs(args) {
    const parsed = {
        targetDir: null,
        name: null,
        task: null,
        schema: null,
        oldSchema: null,
        newSchema: null,
        force: false,
        confirmed: false,
        unsafeRequested: false,
        attempts: 3,
    };
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        const flag = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
        const inlineValue = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : null;
        const next = args[index + 1];
        if (UNSAFE_FLAGS.has(flag)) {
            parsed.unsafeRequested = true;
            continue;
        }
        if (arg === '--force') {
            parsed.force = true;
            parsed.confirmed = true;
            continue;
        }
        if (arg === '--confirm') {
            parsed.confirmed = true;
            continue;
        }
        if ((arg === '--target' || arg === '--target-dir' || arg === '--out') && next) {
            parsed.targetDir = next;
            index++;
            continue;
        }
        if (arg.startsWith('--target=') || arg.startsWith('--target-dir=') || arg.startsWith('--out=')) {
            parsed.targetDir = inlineValue;
            continue;
        }
        if ((arg === '--name' || arg === '--package') && next) {
            parsed.name = next;
            index++;
            continue;
        }
        if (arg.startsWith('--name=') || arg.startsWith('--package=')) {
            parsed.name = inlineValue;
            continue;
        }
        if ((arg === '--task' || arg === '--description') && next) {
            parsed.task = next;
            index++;
            continue;
        }
        if (arg.startsWith('--task=') || arg.startsWith('--description=')) {
            parsed.task = inlineValue;
            continue;
        }
        if (arg === '--schema' && next) {
            parsed.schema = next;
            index++;
            continue;
        }
        if (arg.startsWith('--schema=')) {
            parsed.schema = inlineValue;
            continue;
        }
        if (arg === '--old-schema' && next) {
            parsed.oldSchema = next;
            index++;
            continue;
        }
        if (arg.startsWith('--old-schema=')) {
            parsed.oldSchema = inlineValue;
            continue;
        }
        if (arg === '--new-schema' && next) {
            parsed.newSchema = next;
            index++;
            continue;
        }
        if (arg.startsWith('--new-schema=')) {
            parsed.newSchema = inlineValue;
            continue;
        }
        if (arg === '--attempts' && next) {
            parsed.attempts = parseAttempts(next);
            index++;
            continue;
        }
        if (arg.startsWith('--attempts=')) {
            parsed.attempts = parseAttempts(inlineValue ?? '');
            continue;
        }
        if (!arg.startsWith('--') && parsed.targetDir === null) {
            parsed.targetDir = arg;
        }
    }
    return parsed;
}
function parseAttempts(value) {
    const attempts = Number(value);
    if (!Number.isSafeInteger(attempts) || attempts < 1)
        return 3;
    return Math.min(attempts, 10);
}
function slug(value) {
    return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'generated';
}
function targetDir(parsed, ctx, fallbackName) {
    return parsed.targetDir ?? path.join(ctx.workspaceDir ?? 'workspace', fallbackName);
}
function previewDir(ctx, command) {
    const root = ctx.tempDir ?? path.join(ctx.workspaceDir ?? 'workspace', '.pickle-preview');
    return path.join(root, command);
}
function planPath(artifact) {
    return path.join(artifact.preview_dir, `${artifact.command}-plan.json`);
}
function baseArtifact(command, parsed, ctx, fallbackName) {
    const artifact = {
        kind: 'generator-command-result',
        command,
        generated_at: (ctx.now ?? new Date()).toISOString(),
        workspace_dir: ctx.workspaceDir ?? null,
        target_dir: targetDir(parsed, ctx, fallbackName),
        preview_dir: previewDir(ctx, command),
        preview_only: true,
        force: parsed.force,
        confirmed: parsed.confirmed,
        executed_actions: [],
    };
    return {
        ...artifact,
        plan_path: planPath(artifact),
    };
}
function failed(command, parsed, ctx, fallbackName, code, summary, remediation) {
    return {
        command,
        status: 'failed',
        code,
        summary,
        remediation,
        artifact: baseArtifact(command, parsed, ctx, fallbackName),
    };
}
function confirmationRequired(command, parsed, ctx, fallbackName) {
    if (!parsed.unsafeRequested || parsed.confirmed)
        return null;
    return {
        command,
        status: 'needs_followup',
        code: 'ACTION_REQUIRES_CONFIRMATION',
        summary: `/${command} requires explicit confirmation before writing packages, applying migrations, or running generated code.`,
        remediation: 'Re-run with --confirm or --force after reviewing the emitted preview plan.',
        artifact: baseArtifact(command, parsed, ctx, fallbackName),
    };
}
function targetDirFailure(command, parsed, ctx, fallbackName) {
    const target = targetDir(parsed, ctx, fallbackName);
    if (parsed.force || !fs.existsSync(target))
        return null;
    const stat = fs.statSync(target);
    if (stat.isDirectory() && fs.readdirSync(target).length === 0)
        return null;
    return failed(command, parsed, ctx, fallbackName, 'TARGET_DIR_NOT_EMPTY', `/${command} refused to scaffold into a non-empty target directory.`, 'Choose an empty target directory, omit the target to use preview output, or re-run with --force after reviewing the plan.');
}
function success(command, parsed, ctx, fallbackName, summary, plan) {
    return {
        command,
        status: 'success',
        summary,
        artifact: baseArtifact(command, parsed, ctx, fallbackName),
        plan,
    };
}
function readSchemaInput(input, fallbackName) {
    if (!input)
        return defaultSchema(fallbackName);
    const raw = fs.existsSync(input) ? fs.readFileSync(input, 'utf8') : input;
    const value = JSON.parse(raw);
    return normalizeSchema(value, fallbackName);
}
function normalizeSchema(value, fallbackName) {
    if (!isRecord(value))
        throw new Error('schema root must be an object');
    const name = typeof value.name === 'string' ? value.name : fallbackName;
    if (Array.isArray(value.tables)) {
        return {
            name,
            tables: value.tables.map((table) => normalizeTable(table)),
        };
    }
    if (isRecord(value.properties)) {
        return {
            name,
            tables: Object.entries(value.properties).map(([tableName, tableValue]) => {
                if (!isRecord(tableValue))
                    return { name: tableName, columns: { id: 'string' } };
                const properties = isRecord(tableValue.properties) ? tableValue.properties : {};
                return {
                    name: tableName,
                    columns: normalizeColumns(properties),
                };
            }),
        };
    }
    return defaultSchema(name);
}
function normalizeTable(value) {
    if (!isRecord(value) || typeof value.name !== 'string')
        throw new Error('table entries require a string name');
    const columns = isRecord(value.columns)
        ? normalizeColumns(value.columns)
        : normalizeColumns(isRecord(value.properties) ? value.properties : {});
    return {
        name: value.name,
        columns: Object.keys(columns).length > 0 ? columns : { id: 'string' },
    };
}
function normalizeColumns(columns) {
    return Object.fromEntries(Object.entries(columns).map(([name, value]) => [name, columnType(value)]));
}
function columnType(value) {
    if (typeof value === 'string')
        return value;
    if (isRecord(value) && typeof value.type === 'string')
        return value.type;
    return 'string';
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function schemaFailure(command, parsed, ctx, fallbackName, error) {
    return failed(command, parsed, ctx, fallbackName, 'INVALID_SCHEMA', `/${command} could not parse the supplied schema fixture.`, error instanceof Error ? error.message : 'Provide JSON schema input or a readable schema file path.');
}
function buildMockRows(schema) {
    return schema.tables.map((table) => ({
        table: table.name,
        values: Object.fromEntries(Object.entries(table.columns).map(([column, type]) => [column, sampleValue(column, type)])),
    }));
}
function sampleValue(column, type) {
    if (column === 'id')
        return `${column}-1`;
    if (column.endsWith('_id'))
        return `${column.slice(0, -3)}-1`;
    if (type === 'number' || type === 'integer')
        return 1;
    if (type === 'boolean')
        return true;
    if (type === 'null')
        return null;
    return `${column}-sample`;
}
function diffSchemas(oldSchema, newSchema) {
    const operations = [];
    const oldTables = new Map(oldSchema.tables.map((table) => [table.name, table]));
    const newTables = new Map(newSchema.tables.map((table) => [table.name, table]));
    for (const [name] of newTables) {
        if (!oldTables.has(name))
            operations.push({ action: 'create_table', table: name, detail: `Create table ${name}.` });
    }
    for (const [name] of oldTables) {
        if (!newTables.has(name))
            operations.push({ action: 'drop_table', table: name, detail: `Drop table ${name}.` });
    }
    for (const [name, next] of newTables) {
        const previous = oldTables.get(name);
        if (!previous)
            continue;
        for (const [column, type] of Object.entries(next.columns)) {
            if (!(column in previous.columns)) {
                operations.push({ action: 'add_column', table: name, column, detail: `Add ${name}.${column} as ${type}.` });
            }
            else if (previous.columns[column] !== type) {
                operations.push({ action: 'alter_column', table: name, column, detail: `Alter ${name}.${column} from ${previous.columns[column]} to ${type}.` });
            }
        }
        for (const column of Object.keys(previous.columns)) {
            if (!(column in next.columns)) {
                operations.push({ action: 'drop_column', table: name, column, detail: `Drop ${name}.${column}.` });
            }
        }
    }
    return operations;
}
function scaffoldResult(command, parsed, ctx, fallbackName, kind, files) {
    const targetFailure = targetDirFailure(command, parsed, ctx, fallbackName);
    if (targetFailure)
        return targetFailure;
    const followup = confirmationRequired(command, parsed, ctx, fallbackName);
    if (followup)
        return followup;
    const name = parsed.name ?? path.basename(targetDir(parsed, ctx, fallbackName));
    return success(command, parsed, ctx, fallbackName, `Prepared ${kind} preview for ${name}.`, {
        role: 'scaffold-plan',
        kind,
        name,
        files,
        writes_package: false,
    });
}
function runRicksFlask(args, ctx) {
    const parsed = parseArgs(args);
    try {
        const schema = readSchemaInput(parsed.schema, 'mock-schema');
        return success('ricks-flask', parsed, ctx, 'mock-seed-preview', `Prepared referential mock seed preview for ${schema.name}.`, {
            role: 'mock-seed-preview',
            schema_name: schema.name,
            rows: buildMockRows(schema),
            referential_checks: ['foreign-key-like *_id fields point at deterministic preview ids'],
        });
    }
    catch (error) {
        return schemaFailure('ricks-flask', parsed, ctx, 'mock-seed-preview', error);
    }
}
function runMortySmithDatabase(args, ctx) {
    const parsed = parseArgs(args);
    const followup = confirmationRequired('morty-smith-database', parsed, ctx, 'migration-plan');
    if (followup)
        return followup;
    try {
        const oldSchema = readSchemaInput(parsed.oldSchema, 'old-schema');
        const newSchema = readSchemaInput(parsed.newSchema ?? parsed.schema, 'new-schema');
        return success('morty-smith-database', parsed, ctx, 'migration-plan', `Prepared migration plan from ${oldSchema.name} to ${newSchema.name}.`, {
            role: 'migration-plan',
            from_schema: oldSchema.name,
            to_schema: newSchema.name,
            operations: diffSchemas(oldSchema, newSchema),
            apply_migration: false,
        });
    }
    catch (error) {
        return schemaFailure('morty-smith-database', parsed, ctx, 'migration-plan', error);
    }
}
function runUnity(args, ctx) {
    const parsed = parseArgs(args);
    return scaffoldResult('unity', parsed, ctx, 'package-preview', 'package-scaffold-plan', [
        { path: 'package.json', description: 'package manifest preview with scripts and exports' },
        { path: 'src/index.ts', description: 'typed package entrypoint preview' },
        { path: 'README.md', description: 'usage notes for the generated package plan' },
    ]);
}
function runGazorpazorp(args, ctx) {
    const parsed = parseArgs(args);
    return scaffoldResult('gazorpazorp', parsed, ctx, 'monorepo-preview', 'monorepo-scaffold-plan', [
        { path: 'package.json', description: 'root workspace manifest preview' },
        { path: 'pnpm-workspace.yaml', description: 'workspace package glob preview' },
        { path: 'packages/app/package.json', description: 'app package manifest preview' },
        { path: 'packages/lib/package.json', description: 'library package manifest preview' },
    ]);
}
function runButterRobot(args, ctx) {
    const parsed = parseArgs(args);
    const task = parsed.task ?? 'run one scheduled task';
    return scaffoldResult('butter-robot', parsed, ctx, 'daemon-preview', 'daemon-scaffold-plan', [
        { path: 'package.json', description: 'daemon package manifest preview' },
        { path: 'src/daemon.ts', description: `minimal daemon loop for task: ${task}` },
        { path: `src/tasks/${slug(task)}.ts`, description: 'one-task handler preview' },
        { path: 'README.md', description: 'daemon runbook and confirmation instructions' },
    ]);
}
function runSnakeJazz(args, ctx) {
    const parsed = parseArgs(args);
    const task = parsed.task ?? parsed.name ?? 'retry failed operation';
    const followup = confirmationRequired('snake-jazz', parsed, ctx, 'retry-plan');
    if (followup)
        return followup;
    return success('snake-jazz', parsed, ctx, 'retry-plan', `Prepared retry plan for ${task}.`, {
        role: 'retry-plan',
        task,
        attempts: parsed.attempts,
        steps: [
            'capture original failure input and output',
            'classify retryable versus terminal failure',
            'schedule bounded retry attempts with backoff',
            'emit follow-up artifact instead of starting processes by default',
        ],
        starts_processes: false,
    });
}
export function runGeneratorCommandGroup(command, args = [], ctx = {}) {
    switch (command) {
        case 'ricks-flask':
            return runRicksFlask(args, ctx);
        case 'morty-smith-database':
            return runMortySmithDatabase(args, ctx);
        case 'unity':
            return runUnity(args, ctx);
        case 'gazorpazorp':
            return runGazorpazorp(args, ctx);
        case 'butter-robot':
            return runButterRobot(args, ctx);
        case 'snake-jazz':
            return runSnakeJazz(args, ctx);
    }
}
export function runGeneratorCommandGroupByName(command, args = [], ctx = {}) {
    if (!isGeneratorCommand(command)) {
        const parsed = parseArgs(args);
        return failed('butter-robot', parsed, ctx, 'generator-preview', 'UNKNOWN_COMMAND', `Unknown generator command: ${command}`, `Use one of: ${COMMANDS.join(', ')}.`);
    }
    return runGeneratorCommandGroup(command, args, ctx);
}

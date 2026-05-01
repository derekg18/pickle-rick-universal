import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
const SKIPPED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage']);
const SOURCE_FILE_PATTERN = /\.[cm]?tsx?$/i;
const TEST_FILE_PATTERN = /(?:^|\/)(?:__tests__|tests?|specs?)(?:\/|$)|(?:\.|-)test\.[cm]?[jt]sx?$|(?:\.|-)spec\.[cm]?[jt]sx?$/i;
const HTTP_DECORATOR_PATTERN = /^\s*@(Get|Post|Put|Patch|Delete|Head|Options)\s*\(([^)]*)\)/i;
const CONTROLLER_DECORATOR_PATTERN = /^\s*@Controller\s*\(([^)]*)\)/;
const EXCEPTION_BY_STATUS = {
    400: ['BadRequestException'],
    401: ['UnauthorizedException'],
    403: ['ForbiddenException'],
    404: ['NotFoundException'],
    409: ['ConflictException'],
};
const HTTP_STATUS_BY_CODE = {
    400: ['BAD_REQUEST'],
    401: ['UNAUTHORIZED'],
    403: ['FORBIDDEN'],
    404: ['NOT_FOUND'],
    409: ['CONFLICT'],
};
export function checkEndpointContractConformance(endpoints, statusCodeRows, options = {}) {
    const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
    const sourceFiles = collectSourceFiles(repoRoot);
    const controllerMethods = sourceFiles.flatMap(parseControllerMethods);
    const rows = statusCodeRows.flatMap((statusCodeRow) => {
        const endpoint = endpointForStatusRow(statusCodeRow, endpoints);
        if (!endpoint)
            return [];
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
function buildRow(endpoint, statusCodeRow, controllerMethods) {
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
function buildFindings(row) {
    const findings = [];
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
function toFinding(row, kind, message) {
    return {
        id: `citadel-endpoint-contract-${slug(formatEndpoint(row.endpoint))}-${row.statusCodeRow.statusCode}-${kind}`,
        severity: severityForStatus(row.statusCodeRow.statusCode),
        message,
        endpoint: row.endpoint,
        statusCodeRow: row.statusCodeRow,
        evidence: [row.statusEvidence, row.messageEvidence].filter((evidence) => Boolean(evidence)),
    };
}
function severityForStatus(statusCode) {
    return statusCode === 403 ? 'High' : 'Medium';
}
function endpointForStatusRow(statusCodeRow, endpoints) {
    if (statusCodeRow.endpointMethod && statusCodeRow.endpointPath) {
        return endpoints.find((endpoint) => endpoint.method === statusCodeRow.endpointMethod &&
            normalizeEndpointPath(endpoint.path) === normalizeEndpointPath(statusCodeRow.endpointPath ?? ''));
    }
    return undefined;
}
function parseControllerMethods(file) {
    const methods = [];
    let controllerPath;
    for (let index = 0; index < file.lines.length; index += 1) {
        const line = file.lines[index];
        const controllerMatch = line.match(CONTROLLER_DECORATOR_PATTERN);
        if (controllerMatch) {
            controllerPath = decoratorPath(controllerMatch[1]);
            continue;
        }
        if (!controllerPath)
            continue;
        const methodMatch = line.match(HTTP_DECORATOR_PATTERN);
        if (!methodMatch)
            continue;
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
function methodBody(lines, startIndex) {
    const body = [];
    let depth = 0;
    let opened = false;
    for (let index = startIndex; index < lines.length; index += 1) {
        const line = lines[index];
        body.push(line);
        depth += countChar(line, '{') - countChar(line, '}');
        if (line.includes('{'))
            opened = true;
        if (opened && depth <= 0)
            break;
    }
    return body;
}
function findStatusEvidence(statusCode, controller) {
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
function findMessageEvidence(message, controller) {
    return findBodyEvidence(controller, (line) => line.includes(message));
}
function findBodyEvidence(controller, predicate) {
    const index = controller.body.findIndex(predicate);
    if (index === -1)
        return undefined;
    return {
        file: controller.file,
        line: controller.line + index + 1,
        text: controller.body[index].trim(),
    };
}
function endpointMatchesMethod(endpoint, method) {
    return endpoint.method === method.method && normalizeEndpointPath(endpoint.path) === normalizeEndpointPath(method.fullPath);
}
function normalizeEndpointPath(value) {
    const normalized = value
        .replace(/^['"`]|['"`]$/g, '')
        .replace(/\{([^}]+)\}/g, ':$1')
        .replace(/\/+/g, '/')
        .replace(/\/$/, '');
    return normalized.startsWith('/') ? normalized || '/' : `/${normalized}`;
}
function joinEndpointPaths(basePath, methodPath) {
    return [basePath, methodPath]
        .map((part) => part.trim().replace(/^\/+|\/+$/g, ''))
        .filter(Boolean)
        .join('/');
}
function decoratorPath(args) {
    const match = args.match(/['"`]([^'"`]*)['"`]/);
    return match?.[1] ?? '';
}
function controllerSummary(controller) {
    const { body: _body, ...summary } = controller;
    return summary;
}
function collectSourceFiles(repoRoot) {
    const files = [];
    collectSourceFilesInto(repoRoot, repoRoot, files);
    return files;
}
function collectSourceFilesInto(directory, repoRoot, files) {
    let entries;
    try {
        entries = readdirSync(directory);
    }
    catch {
        return;
    }
    for (const entry of entries) {
        const fullPath = path.join(directory, entry);
        const relative = toPosixPath(path.relative(repoRoot, fullPath));
        let stats;
        try {
            stats = statSync(fullPath);
        }
        catch {
            continue;
        }
        if (stats.isDirectory()) {
            if (!SKIPPED_DIRS.has(entry))
                collectSourceFilesInto(fullPath, repoRoot, files);
        }
        else if (stats.isFile() && SOURCE_FILE_PATTERN.test(entry) && !TEST_FILE_PATTERN.test(relative)) {
            files.push({ path: relative, lines: readFileSync(fullPath, 'utf-8').split(/\r?\n/) });
        }
    }
}
function countChar(value, char) {
    return value.split(char).length - 1;
}
function formatEndpoint(endpoint) {
    return `${endpoint.method} ${endpoint.path}`;
}
function slug(value) {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
function toPosixPath(filePath) {
    return filePath.split(path.sep).join('/');
}

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { extractFrontmatter, safeErrorMessage } from './pickle-utils.js';
const LINEAR_FIELD_NAMES = [
    'linear_issue_id',
    'linear_issue_key',
    'linear_issue_url',
    'linear_bundle_comment_at',
];
function getLinearCommand() {
    const command = process.env.PICKLE_LINEAR_COMMAND?.trim();
    return command ? command : undefined;
}
function findTicketFile(sessionDir, ticketId) {
    const ticketPath = path.join(sessionDir, ticketId, `linear_ticket_${ticketId}.md`);
    if (fs.existsSync(ticketPath))
        return ticketPath;
    return null;
}
function readFrontmatterField(body, field) {
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = body.match(new RegExp(`^${escaped}:\\s*(.+)$`, 'm'));
    return match ? match[1].trim().replace(/^["']|["']$/g, '') : undefined;
}
function parseTicketRecord(ticketPath, fallbackId, fallbackStatus) {
    const content = fs.readFileSync(ticketPath, 'utf-8');
    const fm = extractFrontmatter(content);
    if (!fm)
        return null;
    return {
        id: readFrontmatterField(fm.body, 'id') ?? fallbackId,
        title: readFrontmatterField(fm.body, 'title') ?? fallbackId,
        status: readFrontmatterField(fm.body, 'status') ?? fallbackStatus,
        path: ticketPath,
        linear_issue_id: readFrontmatterField(fm.body, 'linear_issue_id'),
        linear_issue_key: readFrontmatterField(fm.body, 'linear_issue_key'),
        linear_issue_url: readFrontmatterField(fm.body, 'linear_issue_url'),
        linear_bundle_comment_at: readFrontmatterField(fm.body, 'linear_bundle_comment_at'),
    };
}
function quoteYaml(value) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
function setFrontmatterFields(ticketPath, fields) {
    const content = fs.readFileSync(ticketPath, 'utf-8');
    const fm = extractFrontmatter(content);
    if (!fm)
        return;
    let body = fm.body;
    for (const name of LINEAR_FIELD_NAMES) {
        const value = fields[name];
        if (!value)
            continue;
        const line = `${name}: ${quoteYaml(value)}`;
        const pattern = new RegExp(`^${name}:.*$`, 'm');
        body = pattern.test(body) ? body.replace(pattern, line) : `${body.replace(/\s*$/, '')}\n${line}\n`;
    }
    const updated = content.slice(0, fm.start) + `---\n${body.replace(/\s*$/, '')}\n---\n` + content.slice(fm.end);
    const tmp = `${ticketPath}.linear.${process.pid}`;
    fs.writeFileSync(tmp, updated);
    fs.renameSync(tmp, ticketPath);
}
function callBridge(payload) {
    const command = getLinearCommand();
    if (!command)
        return null;
    const output = execFileSync(command, [], {
        input: JSON.stringify(payload),
        encoding: 'utf-8',
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
    }).trim();
    if (!output)
        return null;
    const parsed = JSON.parse(output);
    return typeof parsed.id === 'string' && parsed.id.length > 0
        ? { id: parsed.id, key: parsed.key, url: parsed.url }
        : null;
}
function warnLinear(message, err) {
    const suffix = err ? `: ${safeErrorMessage(err)}` : '';
    process.stderr.write(`[linear-integration] ${message}${suffix}\n`);
}
export function syncLinearTicketStatus(sessionDir, ticketId, newStatus) {
    if (!getLinearCommand())
        return;
    try {
        const ticketPath = findTicketFile(sessionDir, ticketId);
        if (!ticketPath)
            return;
        const ticket = parseTicketRecord(ticketPath, ticketId, newStatus);
        if (!ticket)
            return;
        const session = { id: path.basename(sessionDir), dir: sessionDir };
        let issue = ticket.linear_issue_id
            ? { id: ticket.linear_issue_id, key: ticket.linear_issue_key, url: ticket.linear_issue_url }
            : null;
        if (!issue) {
            issue = callBridge({ action: 'createTicket', session, ticket: { ...ticket, status: newStatus } });
            if (!issue)
                return;
            setFrontmatterFields(ticketPath, {
                linear_issue_id: issue.id,
                linear_issue_key: issue.key,
                linear_issue_url: issue.url,
            });
        }
        callBridge({
            action: 'transitionTicket',
            session,
            ticket: { ...ticket, status: newStatus },
            issue,
        });
    }
    catch (err) {
        warnLinear(`ticket ${ticketId} sync failed`, err);
    }
}
export function emitBundleLinearComments(sessionDir, sessionLogPath) {
    if (!getLinearCommand())
        return;
    let entries;
    try {
        entries = fs.readdirSync(sessionDir, { withFileTypes: true });
    }
    catch (err) {
        warnLinear('cannot scan session tickets for bundle comments', err);
        return;
    }
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const ticketId = entry.name;
        const ticketPath = findTicketFile(sessionDir, ticketId);
        if (!ticketPath)
            continue;
        try {
            const ticket = parseTicketRecord(ticketPath, ticketId, 'Done');
            if (!ticket?.linear_issue_id || ticket.linear_bundle_comment_at)
                continue;
            const issue = {
                id: ticket.linear_issue_id,
                key: ticket.linear_issue_key,
                url: ticket.linear_issue_url,
            };
            const body = [
                `Pickle Rick bundle finished for ticket ${ticket.id}.`,
                '',
                `Session log: ${sessionLogPath}`,
            ].join('\n');
            callBridge({
                action: 'commentTicket',
                session: { id: path.basename(sessionDir), dir: sessionDir, logPath: sessionLogPath },
                ticket,
                issue,
                comment: { body, sessionLogPath },
            });
            setFrontmatterFields(ticketPath, { linear_bundle_comment_at: new Date().toISOString() });
        }
        catch (err) {
            warnLinear(`bundle comment failed for ticket ${ticketId}`, err);
        }
    }
}

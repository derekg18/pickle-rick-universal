#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync, spawn, spawnSync } from 'child_process';
import { printMinimalPanel, Style, formatTime, getExtensionRoot, getDataRoot, safeErrorMessage, } from '../services/pickle-utils.js';
import { StateManager } from '../services/state-manager.js';
import { buildWorkerInvocation } from '../services/backend-spawn.js';
import { PromiseTokens, hasToken, Defaults } from '../types/index.js';
import { readRecoverableJsonObject } from '../services/microverse-state.js';
import { runAcPhaseGate } from '../services/ac-phase-gate.js';
// PRD refinement is planning, not implementation. Codex is reserved for
// implementation loops only — if the parent session opted into codex, we
// still force claude here so analysis stays on the Claude model family.
const REFINEMENT_BACKEND = 'claude';
const sm = new StateManager();
// Emit the codex-override warning at most once per process.
let _codexOverrideWarned = false;
export function __resetRefinementBackendWarning() {
    _codexOverrideWarned = false;
}
/**
 * Log a one-shot stderr warning if the parent session or env opted into codex.
 * Refinement always downgrades to claude regardless.
 *
 * Exported for tests; callers pass an explicit stateBackend (e.g. read from
 * state.json) so the check is deterministic and doesn't depend on test-run env.
 */
export function warnIfCodexRequested(stateBackend, envBackend) {
    if (_codexOverrideWarned)
        return;
    if (stateBackend === 'codex' || envBackend === 'codex') {
        _codexOverrideWarned = true;
        process.stderr.write('[pickle-rick] PRD refinement forces backend=claude (ignoring session/env preference "codex"). Refinement is planning, not implementation.\n');
    }
}
/**
 * Build the spawn invocation for a single refinement worker. Hardcoded to
 * claude — NEVER resolveBackend — because refinement is planning, not
 * implementation.
 *
 * Exported for tests.
 */
export function buildRefinementWorkerInvocation(opts) {
    const invocation = buildWorkerInvocation(REFINEMENT_BACKEND, {
        prompt: opts.prompt,
        addDirs: opts.addDirs,
    });
    // buildWorkerInvocation doesn't take max-turns for workers; splice it in
    // before the `-p <prompt>` trailer so the flag applies to the claude CLI.
    if (opts.maxTurns > 0) {
        const promptIdx = invocation.args.lastIndexOf('-p');
        const insertAt = promptIdx === -1 ? invocation.args.length : promptIdx;
        invocation.args.splice(insertAt, 0, '--max-turns', String(opts.maxTurns));
    }
    return invocation;
}
/**
 * Build the child-process env for a refinement worker. Explicitly sets
 * PICKLE_BACKEND=claude so any grandchild spawn also stays on claude even if
 * the parent session opted into codex. Do NOT spread backendEnvOverrides —
 * this helper is the single source of truth for the refinement env.
 *
 * Exported for tests.
 */
export function buildRefinementEnv(base = process.env) {
    const env = {
        ...base,
        PICKLE_BACKEND: REFINEMENT_BACKEND,
        // Sentinel lock: short-circuits resolveBackend / resolveBackendFromStateFile
        // in every grandchild to 'claude', even if state.json says codex. Prevents
        // a downstream loadBackendFromSession(sessionDir) read from bypassing the
        // env lock. See services/backend-spawn.ts resolveBackend() for details.
        PICKLE_REFINEMENT_LOCK: '1',
        PICKLE_ROLE: 'refinement-worker',
        PYTHONUNBUFFERED: '1',
    };
    delete env['CLAUDECODE'];
    return env;
}
// Tracks all active worker subprocesses so the signal handler can kill them.
const activeWorkerProcs = new Set();
const AC_SHAPE_PROMPT_SECTION = `## AC-Shape Smell Pass

Before finalizing your analysis, inspect every acceptance criterion for endpoint-enumeration shape:
- The AC headline lacks a universal quantifier: "all", "every", or "for any".
- The AC body has 3 or more bullets naming distinct endpoints, handlers, or methods.
- Those bullets repeat the same predicate.

For every matching AC, either collapse the decomposition to one parametrized ticket or justify why multiple tickets are necessary.

Emit a machine-readable section exactly named \`## ac_shape_smells\`. If no smells exist, emit empty arrays. The JSON shape is:
\`\`\`json
{
  "ac_shape_smells": [
    {
      "ac_id": "AC-EXAMPLE-01",
      "headline": "Original AC headline",
      "evidence": ["bullet or PRD reference"],
      "targets": ["endpointOrHandlerA", "endpointOrHandlerB", "endpointOrHandlerC"],
      "repeated_predicate": "same predicate repeated across targets",
      "ticket_ids": ["ticket-id-if-known"]
    }
  ],
  "tickets": [
    {
      "id": "ticket-id",
      "title": "All handlers enforce the shared invariant",
      "source_ac_ids": ["AC-EXAMPLE-01"],
      "acceptance_test": "describe.each([...]) covers every enumerated target",
      "justification": "// JUSTIFICATION: Required only when this smelly AC intentionally fans out into multiple tickets."
    }
  ]
}
\`\`\``;
const TICKET_COMPLEXITY_PROMPT_SECTION = `## Ticket Complexity Classification

For each ticket, assign a complexity_tier in the frontmatter:
- trivial: Single-file text change, no logic, no tests needed (prompt edits, config tweaks)
- small: 1-2 files, straightforward logic, type-only or minimal tests
- medium: 2-4 files, moderate logic, requires unit tests
- large: 4+ files, complex integration, multiple test files, cross-cutting concerns
`;
const WORKER_ROLES = [
    { id: 'requirements' },
    { id: 'codebase' },
    { id: 'risk-scope' },
];
export function runReadinessGate(sessionDir, workingDir, manifestPath) {
    const binPath = path.join(getExtensionRoot(), 'bin', 'check-readiness.js');
    if (!fs.existsSync(binPath))
        return 0;
    const result = spawnSync(process.execPath, [
        binPath,
        '--session-dir', sessionDir,
        '--repo-root', workingDir,
        '--manifest', manifestPath,
        '--machinability-only',
        '--contract-only',
    ], {
        cwd: workingDir,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.stdout)
        process.stdout.write(result.stdout);
    if (result.stderr)
        process.stderr.write(result.stderr);
    return result.status ?? 1;
}
const CITATION_RE = /(?<![\w./-])((?:\.{1,2}\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|sh|py|css|scss|html)):(\d+)\b/g;
export function extractAnchorCitations(prdContent) {
    const citations = [];
    const seen = new Set();
    const lines = prdContent.split(/\r?\n/);
    lines.forEach((line, index) => {
        CITATION_RE.lastIndex = 0;
        let match;
        while ((match = CITATION_RE.exec(line)) !== null) {
            const filePath = normalizeCitationPath(match[1]);
            const rawLineNumber = Number(match[2]);
            const lineNumber = Number.isFinite(rawLineNumber) ? rawLineNumber : 0;
            if (!Number.isSafeInteger(lineNumber) || lineNumber <= 0)
                continue;
            const key = `${filePath}:${lineNumber}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            citations.push({
                sourceLine: index + 1,
                filePath,
                lineNumber,
                raw: match[0],
            });
        }
    });
    return citations;
}
function normalizeCitationPath(filePath) {
    return filePath.replace(/^\.\//, '').replace(/\\/g, '/');
}
function readHeadFile(workingDir, filePath) {
    try {
        return execFileSync('git', ['show', `HEAD:${filePath}`], {
            cwd: workingDir,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
            maxBuffer: 20 * 1024 * 1024,
        });
    }
    catch {
        return undefined;
    }
}
export function findStaleAnchorWarnings(prdContent, workingDir) {
    return extractAnchorCitations(prdContent).flatMap((citation) => {
        const headContent = readHeadFile(workingDir, citation.filePath);
        if (headContent === undefined) {
            return [{
                    citation,
                    reason: 'missing-file',
                    detail: `not found at HEAD:${citation.filePath}`,
                }];
        }
        const lineCount = headContent === '' ? 0 : headContent.split(/\r?\n/).length;
        if (citation.lineNumber > lineCount) {
            return [{
                    citation,
                    reason: 'line-out-of-range',
                    detail: `line ${citation.lineNumber} exceeds HEAD line count ${lineCount}`,
                }];
        }
        return [];
    });
}
export function emitStaleAnchorWarnings(warnings) {
    if (warnings.length === 0)
        return;
    process.stderr.write(`[pickle-rick] stale-anchor warning: ${warnings.length} PRD citation(s) no longer resolve against HEAD.\n`);
    for (const warning of warnings) {
        const { citation } = warning;
        process.stderr.write(`[pickle-rick] stale-anchor ${citation.raw} (PRD line ${citation.sourceLine}): ${warning.detail}\n`);
    }
}
export function buildWorkerPrompt(roleId, prdContent, outputFile, workingDir, cycle, previousAnalyses, portalContext) {
    const persona = `You are Pickle Rick — hyper-competent, arrogant, ruthlessly thorough.
*Belch.* You are FORBIDDEN from being a Jerry. Jerries write vague analysis. You write SPECIFIC, ACTIONABLE findings with evidence.
CRITICAL RULE: You MUST output a text explanation ("brain dump") before every single tool call.`;
    const roleInstructions = {
        requirements: `## Your Role: Requirements Analyst Morty

Analyze the PRD EXCLUSIVELY for requirements completeness:
1. **Critical User Journeys (CUJs)**: Are all major user flows documented? Are they step-by-step enough for engineering to implement without guessing?
2. **Functional Requirements Table**: Are P0/P1/P2 requirements complete? Are there obvious missing use cases, alternate flows, or error scenarios?
3. **Acceptance Criteria**: Can each requirement be tested? Are success states and failure states defined?
4. **Edge Cases & Boundary Conditions**: What empty states, error states, race conditions, or limits are missing?
5. **User Stories**: Are "As a user, I want..." stories specific enough to code against, or are they vague aspirations?

DO NOT analyze risks, scope, technical architecture, or codebase. That's other Mortys' territory.`,
        codebase: `## Your Role: Codebase Context Analyst Morty

Analyze alignment between the PRD and the actual codebase at: \`${workingDir}\`

1. **Research the codebase** — use Glob/Grep/Read to find relevant files. Map existing patterns.
2. **PRD Assumptions**: Does the PRD assume components that don't exist? Does it ignore existing patterns it should follow?
3. **Technical Constraints**: What existing APIs, data models, or architectural decisions affect this PRD? Are they documented in the PRD?
4. **Integration Points**: What existing components will this feature touch? Are those interactions specified?
5. **Missing Technical Context**: What technical decisions does the PRD leave unspecified that engineering will have to guess at?

Use file:line references for every codebase claim. If the codebase is empty/irrelevant, say so explicitly and note what the PRD should specify instead.`
            + (portalContext && roleId === 'codebase' ? `

## Portal Artifacts

This PRD was generated by portal-gun from a donor codebase. The following portal artifacts are available for cross-reference:
- Pattern analysis: \`${portalContext.portalDir}/pattern_analysis.md\`
- Target analysis: \`${portalContext.portalDir}/target_analysis.md\`
- Donor source: \`${portalContext.portalDir}/donor/\`

Read these artifacts to validate PRD claims against the actual donor code and target analysis.` : ''),
        'risk-scope': `## Your Role: Risk & Scope Auditor Morty

Analyze the PRD EXCLUSIVELY for risks, scope, and assumptions:
1. **Scope Clarity**: Is "In-scope" specific enough? Can you tell exactly what will and won't be built? Grade each item on specificity (vague/clear/precise).
2. **Non-Goals / Scope Creep**: Are non-goals clearly stated? Is there scope creep hiding in vague requirements?
3. **Risk Completeness**: Are all major technical, product, and operational risks identified? Is "Risks: None" a lie?
4. **Mitigation Quality**: For each risk, is the mitigation concrete or hand-wavy ("we'll monitor it")?
5. **Assumptions**: Are all key assumptions documented? What hidden assumptions are baked into the PRD that could blow up if wrong?
6. **External Dependencies**: What APIs, third-party services, or other teams are mentioned but under-specified?

DO NOT analyze feature completeness or codebase patterns. That's other Mortys' jobs.`,
    };
    // Build the cross-reference section for cycle 2+
    let crossRefSection = '';
    if (cycle > 1 && previousAnalyses && previousAnalyses.size > 0) {
        const roleLabels = {
            requirements: 'Requirements Analyst',
            codebase: 'Codebase Context Analyst',
            'risk-scope': 'Risk & Scope Auditor',
        };
        crossRefSection = `\n## Previous Cycle Analyses (Cycle ${cycle - 1} — Cross-Reference These)

Your team already ran a previous analysis pass. You have access to ALL analysts' findings below.

**Your mission for this deeper pass:**
1. **Go DEEPER** on issues that were identified but under-explored — add specifics, evidence, examples
2. **CROSS-REFERENCE** findings from other analysts that affect your domain
3. **CHALLENGE** your own previous analysis — did you miss anything? Were severity ratings accurate?
4. **ELIMINATE DUPLICATES** — if another analyst covered something in your domain, acknowledge it rather than repeating
5. **RAISE NEW ISSUES** discovered only by seeing the full picture across all analyses

`;
        for (const [id, content] of previousAnalyses) {
            const label = roleLabels[id] || id;
            const isOwn = id === roleId;
            crossRefSection += `### ${label}'s Previous Findings${isOwn ? ' (YOUR OWN — improve on this)' : ''}:
\`\`\`markdown
${content}
\`\`\`

`;
        }
    }
    const cycleNote = cycle > 1
        ? `\n**THIS IS CYCLE ${cycle}** — you are deepening a previous analysis. Your output should be MORE SPECIFIC, MORE EVIDENCE-BACKED, and CROSS-REFERENCED with other analysts' findings.\n`
        : '';
    const outputInstructions = `${TICKET_COMPLEXITY_PROMPT_SECTION}
${AC_SHAPE_PROMPT_SECTION}

## Your Output

Write ALL findings to this file: ${outputFile}
${cycleNote}
Use this EXACT structure:

\`\`\`markdown
# PRD Analysis: [Your Role Name]${cycle > 1 ? ` (Cycle ${cycle})` : ''}

**Date**: [Today's date]
**Analyst**: [Your Role Name]
**Cycle**: ${cycle}

## Executive Summary
[2-3 sentence overview of the PRD's quality in your domain. Be specific — not "needs improvement" but "missing 3 P0 CUJs and acceptance criteria for all requirements".]

## Critical Gaps (P0 — Must Fix)
- **[Gap Title]**: [Specific description with PRD section reference]. [Why this is critical.]

## Important Gaps (P1 — Should Fix)
- **[Gap Title]**: [Specific description]. [Impact if ignored.]

## Minor Issues (P2 — Nice to Fix)
- [Brief description]

## ac_shape_smells
\`\`\`json
{ "ac_shape_smells": [], "tickets": [] }
\`\`\`

## Specific Recommendations
[Concrete, actionable suggestions. For P0 gaps, provide example language the PRD author can paste in.]${cycle > 1 ? `

## Cross-Reference Notes
[What you found by reading other analysts' work that affects your domain]` : ''}
\`\`\`

After writing the file, output: <promise>${PromiseTokens.ANALYSIS_DONE}</promise>
Then STOP IMMEDIATELY. Do not attempt to rewrite the PRD.`;
    return `${persona}

${roleInstructions[roleId]}
${crossRefSection}
---

## The PRD You Are Analyzing

\`\`\`markdown
${prdContent}
\`\`\`

---

${outputInstructions}`;
}
function spawnWorker(roleId, prompt, refinementDir, extensionRoot, timeout, workingDir, maxTurns, cycle, onComplete, sessionDir) {
    const logPath = path.join(refinementDir, `worker_${roleId}_c${cycle}.log`);
    const logStream = fs.createWriteStream(logPath, { flags: 'w' });
    logStream.on('error', (err) => {
        const msg = safeErrorMessage(err);
        console.error(`${Style.RED}❌ Log stream error (${roleId}): ${msg}${Style.RESET}`);
    });
    // Mirror spawn-morty.ts: include extensionRoot, data root, and workingDir.
    // buildRefinementWorkerInvocation filters out non-existent dirs internally.
    const includes = [extensionRoot, getDataRoot(), workingDir];
    if (sessionDir)
        includes.push(sessionDir);
    const invocation = buildRefinementWorkerInvocation({
        prompt,
        addDirs: includes,
        maxTurns,
    });
    const env = buildRefinementEnv(process.env);
    const proc = spawn(invocation.cmd, invocation.args, {
        cwd: workingDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeWorkerProcs.add(proc);
    // Use { end: false } so that when stdout ends first it doesn't call
    // logStream.end(), which would discard any stderr data still in-flight.
    // logStream.end() is called explicitly in the 'close' and 'error' handlers.
    proc.stdout?.pipe(logStream, { end: false });
    proc.stderr?.pipe(logStream, { end: false });
    // SIGTERM first, escalate to SIGKILL after 2s if still alive
    let workerTimedOut = false;
    let killEscalation = null;
    const timeoutHandle = setTimeout(() => {
        workerTimedOut = true;
        try {
            proc.kill('SIGTERM');
        }
        catch { /* already dead */ }
        killEscalation = setTimeout(() => {
            try {
                proc.kill('SIGKILL');
            }
            catch { /* already dead */ }
        }, 2000);
    }, timeout * 1000);
    return new Promise((resolve) => {
        let settled = false;
        let workerExitCode = null;
        function settleWith(result) {
            if (settled)
                return;
            settled = true;
            activeWorkerProcs.delete(proc);
            clearTimeout(timeoutHandle);
            if (killEscalation)
                clearTimeout(killEscalation);
            clearTimeout(hangGuard);
            onComplete(result);
            resolve(result);
        }
        // Safety net: force-resolve if the process hangs (mirrors spawn-morty.ts)
        const hangGuard = setTimeout(() => {
            settleWith({ roleId, success: false, logPath, cycle, exitCode: null });
        }, (timeout + 30) * 1000);
        hangGuard.unref();
        proc.on('error', (err) => {
            const msg = safeErrorMessage(err);
            console.error(`${Style.RED}Failed to spawn ${invocation.cmd} (${roleId}): ${msg}${Style.RESET}`);
            logStream.end();
            settleWith({ roleId, success: false, logPath, cycle, exitCode: null });
        });
        proc.on('close', (code) => {
            workerExitCode = code ?? null;
            if (settled)
                return; // error handler already resolved
            clearTimeout(timeoutHandle);
            if (killEscalation)
                clearTimeout(killEscalation);
            clearTimeout(hangGuard);
            // Register finish listener BEFORE calling end() to avoid missing synchronous completion.
            // Guard against logStream.finish never firing (e.g., disk I/O failure)
            const flushTimeout = setTimeout(() => finalize(), 5000);
            logStream.on('finish', () => {
                clearTimeout(flushTimeout);
                finalize();
            });
            logStream.end();
            function finalize() {
                let logContent = '';
                try {
                    logContent = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '';
                }
                catch { /* */ }
                const success = !workerTimedOut && hasToken(logContent, PromiseTokens.ANALYSIS_DONE);
                settleWith({ roleId, success, logPath, cycle, exitCode: workerExitCode });
            }
        });
    });
}
function usageAndExit() {
    console.error(`${Style.RED}❌ Usage: node spawn-refinement-team.js --prd <path> --session-dir <dir> [--timeout <sec>] [--cycles <n>] [--max-turns <n>]${Style.RESET}`);
    process.exit(1);
}
function parsePositiveIntegerValue(raw) {
    if (typeof raw === 'number') {
        return Number.isInteger(raw) && raw > 0 ? raw : undefined;
    }
    if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) {
        return undefined;
    }
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : undefined;
}
function parsePositiveFlag(argv, index, flag) {
    if (index === -1)
        return undefined;
    const raw = argv[index + 1];
    const value = parsePositiveIntegerValue(raw);
    if (value === undefined) {
        console.error(`${Style.RED}❌ ${flag} requires a positive integer, got: ${raw}${Style.RESET}`);
        process.exit(1);
    }
    return value;
}
function parseTimeoutFlag(argv) {
    const timeoutIndex = argv.indexOf('--timeout');
    return parsePositiveFlag(argv, timeoutIndex, '--timeout');
}
export function parseAndValidateArgs(argv) {
    const prdIndex = argv.indexOf('--prd');
    const sessionIndex = argv.indexOf('--session-dir');
    const prdPath = prdIndex !== -1 ? argv[prdIndex + 1] : undefined;
    const sessionDir = sessionIndex !== -1 ? argv[sessionIndex + 1] : undefined;
    if (!prdPath || !sessionDir || prdPath.startsWith('--') || sessionDir.startsWith('--')) {
        usageAndExit();
    }
    if (!fs.existsSync(prdPath)) {
        console.error(`${Style.RED}❌ PRD not found: ${prdPath}${Style.RESET}`);
        process.exit(1);
    }
    return {
        prdPath,
        sessionDir,
        timeout: parseTimeoutFlag(argv),
        cycles: parsePositiveFlag(argv, argv.indexOf('--cycles'), '--cycles'),
        maxTurns: parsePositiveFlag(argv, argv.indexOf('--max-turns'), '--max-turns'),
    };
}
export function loadRefinementSettings(settingsPath = path.join(getExtensionRoot(), 'pickle_settings.json')) {
    const settings = {
        defaultCycles: 3,
        defaultMaxTurns: 100,
        defaultWorkerTimeout: Defaults.WORKER_TIMEOUT_SECONDS,
    };
    if (!fs.existsSync(settingsPath))
        return settings;
    try {
        const loaded = readRecoverableJsonObject(settingsPath);
        if (!loaded)
            return settings;
        const cycles = parsePositiveIntegerValue(loaded.default_refinement_cycles);
        const maxTurns = parsePositiveIntegerValue(loaded.default_refinement_max_turns);
        const workerTimeout = parsePositiveIntegerValue(loaded.default_worker_timeout_seconds);
        if (cycles !== undefined)
            settings.defaultCycles = cycles;
        if (maxTurns !== undefined)
            settings.defaultMaxTurns = maxTurns;
        if (workerTimeout !== undefined)
            settings.defaultWorkerTimeout = workerTimeout;
    }
    catch { /* use hardcoded defaults */ }
    return settings;
}
function resolveRuntime(args, settings) {
    let timeout = args.timeout ?? settings.defaultWorkerTimeout;
    let workingDir = process.cwd();
    let stateBackend = undefined;
    let sessionEffort;
    const statePath = path.join(args.sessionDir, 'state.json');
    if (fs.existsSync(statePath)) {
        try {
            const state = sm.read(statePath);
            stateBackend = state.backend;
            if (typeof state.working_dir === 'string' && state.working_dir.trim())
                workingDir = state.working_dir;
            if (state.effort === 'low' || state.effort === 'medium' || state.effort === 'high')
                sessionEffort = state.effort;
            if (args.timeout === undefined) {
                const stateTimeout = parsePositiveIntegerValue(state.worker_timeout_seconds);
                if (stateTimeout !== undefined)
                    timeout = stateTimeout;
            }
            timeout = clampTimeoutToSession(timeout, state);
        }
        catch {
            // Ignore — use parsed/default timeout.
        }
    }
    warnIfCodexRequested(stateBackend, process.env.PICKLE_BACKEND);
    return {
        cycles: args.cycles ?? settings.defaultCycles,
        maxTurns: args.maxTurns ?? settings.defaultMaxTurns,
        timeout,
        workingDir,
        sessionEffort,
    };
}
function clampTimeoutToSession(timeout, state) {
    const maxMins = Number(state.max_time_minutes);
    const startEpoch = Number(state.start_time_epoch);
    if (!Number.isFinite(maxMins) || maxMins <= 0 || !Number.isFinite(startEpoch) || startEpoch <= 0) {
        return timeout;
    }
    const remaining = Math.floor(maxMins * 60 - (Math.floor(Date.now() / 1000) - startEpoch));
    if (remaining <= 0) {
        console.log(`${Style.YELLOW}⚠️  Session time already elapsed; running with requested timeout.${Style.RESET}`);
    }
    else if (remaining < timeout) {
        console.log(`${Style.YELLOW}⚠️  Worker timeout clamped to ${remaining}s (session wall-clock)${Style.RESET}`);
        return remaining;
    }
    return timeout;
}
function registerShutdownHandlers() {
    const handleShutdownSignal = (signal) => {
        console.error(`\n${Style.YELLOW}⚠️  Received ${signal} — killing ${activeWorkerProcs.size} active worker(s)${Style.RESET}`);
        for (const wp of activeWorkerProcs) {
            try {
                wp.kill('SIGTERM');
            }
            catch { /* already dead */ }
        }
        process.exit(0);
    };
    process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'));
    process.on('SIGINT', () => handleShutdownSignal('SIGINT'));
}
function ensureRefinementDir(refinementDir) {
    try {
        fs.mkdirSync(refinementDir, { recursive: true });
    }
    catch (err) {
        const msg = safeErrorMessage(err);
        console.error(`${Style.RED}❌ Failed to create ${refinementDir}: ${msg}${Style.RESET}`);
        process.exit(1);
    }
}
function detectPortalContext(sessionDir) {
    const portalDir = path.join(sessionDir, 'portal');
    return fs.existsSync(portalDir) ? { portalDir, patternSummaryLines: 50 } : undefined;
}
function printDeploymentPanel(args, refinementDir, cycles, maxTurns, timeout, sessionEffort) {
    printMinimalPanel('PRD Refinement Team Deploying', {
        PRD: path.basename(args.prdPath),
        Workers: WORKER_ROLES.map((r) => r.id).join(' | '),
        Cycles: cycles,
        'Max Turns': `${maxTurns}/worker`,
        Timeout: `${timeout}s each`,
        Output: refinementDir,
        ...(sessionEffort ? { Effort: `${sessionEffort} (claude no-op)` } : {}),
    }, 'MAGENTA', '🥒');
}
function loadPreviousAnalyses(refinementDir, cycle) {
    if (cycle <= 1)
        return undefined;
    const previousAnalyses = new Map();
    for (const { id } of WORKER_ROLES) {
        const prevFile = path.join(refinementDir, `analysis_${id}.md`);
        if (fs.existsSync(prevFile)) {
            try {
                previousAnalyses.set(id, fs.readFileSync(prevFile, 'utf-8'));
            }
            catch { /* skip unreadable */ }
        }
    }
    if (previousAnalyses.size === 0) {
        console.log(`${Style.YELLOW}⚠️  No previous analyses found — cycle ${cycle} will run as independent analysis.${Style.RESET}`);
    }
    return previousAnalyses;
}
function startCycleSpinner(statuses, cycles, cycle) {
    const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let spinIdx = 0;
    const startTime = Date.now();
    return setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const spinChar = spinner[spinIdx % spinner.length];
        const statusParts = WORKER_ROLES.map((r) => `${statuses.get(r.id)} ${r.id}`).join(' | ');
        const cycleLabel = cycles > 1 ? ` C${cycle}` : '';
        process.stdout.write(`\r   ${Style.CYAN}${spinChar}${Style.RESET} ${statusParts} ${Style.DIM}[${formatTime(elapsed)}${cycleLabel}]${Style.RESET}\x1b[K`);
        spinIdx++;
    }, 200);
}
async function runCycle(opts) {
    const statuses = new Map(WORKER_ROLES.map((r) => [r.id, '⏳']));
    const interval = startCycleSpinner(statuses, opts.cycles, opts.cycle);
    try {
        const workerPromises = WORKER_ROLES.map(({ id }) => {
            const outputFile = path.join(opts.refinementDir, `analysis_${id}.md`);
            const prompt = buildWorkerPrompt(id, opts.prd, outputFile, opts.workingDir, opts.cycle, opts.previousAnalyses, opts.portalContext);
            return spawnWorker(id, prompt, opts.refinementDir, opts.extensionRoot, opts.timeout, opts.workingDir, opts.maxTurns, opts.cycle, (result) => {
                statuses.set(id, result.success ? '✅' : '❌');
                if (result.exitCode !== null && result.exitCode !== 0)
                    killSiblingWorkers(result);
            }, opts.sessionDir);
        });
        return await Promise.all(workerPromises);
    }
    finally {
        clearInterval(interval);
        process.stdout.write('\r\x1b[K\n');
    }
}
function killSiblingWorkers(result) {
    const siblings = [...activeWorkerProcs];
    if (siblings.length === 0)
        return;
    console.error(`\n${Style.RED}⚠️  Worker ${result.roleId} crashed (exit ${result.exitCode}) — killing ${siblings.length} sibling(s)${Style.RESET}`);
    for (const sibling of siblings) {
        try {
            sibling.kill('SIGTERM');
        }
        catch { /* already dead */ }
    }
}
function archiveCycleResults(refinementDir, cycles, cycle) {
    if (cycles <= 1)
        return;
    for (const { id } of WORKER_ROLES) {
        const canonical = path.join(refinementDir, `analysis_${id}.md`);
        const cycleArchive = path.join(refinementDir, `analysis_${id}_c${cycle}.md`);
        if (fs.existsSync(canonical)) {
            try {
                fs.copyFileSync(canonical, cycleArchive);
            }
            catch { /* best-effort */ }
        }
    }
}
export async function orchestrateCycles(args, settings, prd) {
    const runtime = resolveRuntime(args, settings);
    const refinementDir = path.join(args.sessionDir, 'refinement');
    const extensionRoot = getExtensionRoot();
    ensureRefinementDir(refinementDir);
    registerShutdownHandlers();
    printDeploymentPanel(args, refinementDir, runtime.cycles, runtime.maxTurns, runtime.timeout, runtime.sessionEffort);
    const preRefinementGate = runAcPhaseGate({
        sessionDir: args.sessionDir,
        evaluationPhase: 'pre-refinement',
        cwd: runtime.workingDir,
        stdout: (msg) => console.log(msg),
        stderr: (msg) => console.error(msg),
    });
    if (preRefinementGate.status !== 'pass') {
        throw new Error('pre-refinement AC phase gate failed');
    }
    emitStaleAnchorWarnings(findStaleAnchorWarnings(prd, runtime.workingDir));
    const allCycleResults = [];
    const portalContext = detectPortalContext(args.sessionDir);
    for (let cycle = 1; cycle <= runtime.cycles; cycle++) {
        if (runtime.cycles > 1)
            printCyclePanel(cycle, runtime.cycles);
        const results = await runCycle({
            cycle,
            cycles: runtime.cycles,
            prd,
            refinementDir,
            extensionRoot,
            timeout: runtime.timeout,
            workingDir: runtime.workingDir,
            maxTurns: runtime.maxTurns,
            previousAnalyses: loadPreviousAnalyses(refinementDir, cycle),
            portalContext,
            sessionDir: args.sessionDir,
        });
        archiveCycleResults(refinementDir, runtime.cycles, cycle);
        allCycleResults.push(results);
        printCycleSummary(results, runtime.cycles, cycle);
        if (results.every((r) => !r.success))
            break;
    }
    if (allCycleResults.length === 0) {
        console.error(`${Style.RED}❌ No cycles completed${Style.RESET}`);
        process.exit(1);
    }
    const finalResults = allCycleResults[allCycleResults.length - 1];
    const allSuccess = finalResults.every((r) => r.success);
    printCompletionPanel(finalResults, allSuccess);
    return { refinementDir, cyclesRequested: runtime.cycles, maxTurns: runtime.maxTurns, allCycleResults, finalResults, allSuccess };
}
function printCyclePanel(cycle, cycles) {
    printMinimalPanel(`Cycle ${cycle} of ${cycles}`, {
        Phase: cycle === 1 ? 'Initial Analysis' : 'Deep-Dive (cross-referencing previous findings)',
        Workers: WORKER_ROLES.map((r) => r.id).join(' | '),
    }, 'CYAN', '🔄');
}
function printCycleSummary(results, cycles, cycle) {
    if (cycles > 1) {
        const statusLine = results.map((r) => `${r.roleId}: ${r.success ? '✅' : '❌'}`).join(' | ');
        console.log(`   ${Style.DIM}Cycle ${cycle}: ${statusLine}${Style.RESET}`);
    }
    if (results.every((r) => !r.success)) {
        console.log(`${Style.YELLOW}⚠️  All workers failed in cycle ${cycle} — skipping remaining cycles.${Style.RESET}`);
    }
}
function printCompletionPanel(finalResults, allSuccess) {
    printMinimalPanel('Refinement Team Complete', Object.fromEntries(finalResults.map((r) => [r.roleId, r.success ? '✅ analysis written' : '❌ failed — check log'])), allSuccess ? 'GREEN' : 'YELLOW', '🥒');
}
const AC_SHAPE_SECTION_RE = /^##+\s+ac_shape_smells\s*$/im;
const UNIVERSAL_QUANTIFIER_RE = /\b(?:all|every|for any|each)\b/i;
const JUSTIFICATION_RE = /\/\/\s*JUSTIFICATION:/i;
const DESCRIBE_EACH_RE = /describe\.each\s*\(\s*\[/s;
function asString(value) {
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
function asStringArray(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((item) => typeof item === 'string' && item.trim() !== '');
}
function normalizeAcShapeSmell(value, source_worker, source_file) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const record = value;
    const ac_id = asString(record.ac_id);
    if (!ac_id)
        return undefined;
    return {
        ac_id,
        headline: asString(record.headline),
        evidence: asStringArray(record.evidence),
        targets: asStringArray(record.targets),
        repeated_predicate: asString(record.repeated_predicate),
        ticket_ids: asStringArray(record.ticket_ids),
        source_worker,
        source_file,
    };
}
function normalizeTicketEntry(value, source_worker, source_file) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const record = value;
    const id = asString(record.id);
    const title = asString(record.title);
    if (!id || !title)
        return undefined;
    return {
        id,
        title,
        source_ac_ids: asStringArray(record.source_ac_ids),
        acceptance_test: asString(record.acceptance_test),
        justification: asString(record.justification),
        source_worker,
        source_file,
    };
}
function extractAcShapeJson(content) {
    const sectionMatch = AC_SHAPE_SECTION_RE.exec(content);
    if (!sectionMatch)
        return undefined;
    const afterHeading = content.slice(sectionMatch.index + sectionMatch[0].length);
    const nextHeading = afterHeading.search(/\n##+\s+/);
    const section = nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading);
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(section);
    const jsonText = fenced ? fenced[1] : section.trim();
    if (!jsonText)
        return undefined;
    try {
        return JSON.parse(jsonText);
    }
    catch {
        return undefined;
    }
}
export function parseAcShapeSection(content, source_worker, source_file) {
    const parsed = extractAcShapeJson(content);
    if (typeof parsed !== 'object' || parsed === null)
        return { acShapeSmells: [], tickets: [] };
    const record = parsed;
    return {
        acShapeSmells: Array.isArray(record.ac_shape_smells)
            ? record.ac_shape_smells
                .map((item) => normalizeAcShapeSmell(item, source_worker, source_file))
                .filter((item) => item !== undefined)
            : [],
        tickets: Array.isArray(record.tickets)
            ? record.tickets
                .map((item) => normalizeTicketEntry(item, source_worker, source_file))
                .filter((item) => item !== undefined)
            : [],
    };
}
function collectAcShapeData(results) {
    const acShapeSmells = [];
    const tickets = [];
    for (const result of results.finalResults) {
        const outputFile = path.join(results.refinementDir, `analysis_${result.roleId}.md`);
        if (!fs.existsSync(outputFile))
            continue;
        const parsed = parseAcShapeSection(fs.readFileSync(outputFile, 'utf-8'), result.roleId, outputFile);
        acShapeSmells.push(...parsed.acShapeSmells);
        tickets.push(...parsed.tickets);
    }
    return { acShapeSmells, tickets };
}
function ticketsForSmell(smell, tickets) {
    const explicitIds = new Set((smell.ticket_ids ?? []).filter((id) => id.trim() !== ''));
    return tickets.filter((ticket) => {
        if (explicitIds.size > 0 && explicitIds.has(ticket.id))
            return true;
        return ticket.source_ac_ids.includes(smell.ac_id);
    });
}
function hasJustificationBlock(ticket) {
    return ticket.justification !== undefined && JUSTIFICATION_RE.test(ticket.justification);
}
function isParametrizedTicket(ticket) {
    return UNIVERSAL_QUANTIFIER_RE.test(ticket.title) && DESCRIBE_EACH_RE.test(ticket.acceptance_test ?? '');
}
export function evaluateAcShapeEnforcement(manifest) {
    const violations = [];
    for (const smell of manifest.ac_shape_smells) {
        const matchingTickets = ticketsForSmell(smell, manifest.tickets);
        if (matchingTickets.length === 0) {
            violations.push({
                ac_id: smell.ac_id,
                reason: 'tagged as an AC-shape smell but no matching ticket entries were emitted',
                ticket_ids: [],
            });
            continue;
        }
        if (matchingTickets.length === 1) {
            const [ticket] = matchingTickets;
            if (!isParametrizedTicket(ticket)) {
                violations.push({
                    ac_id: smell.ac_id,
                    reason: 'single-ticket collapse lacks a universal-quantifier title or describe.each([...]) acceptance test',
                    ticket_ids: [ticket.id],
                });
            }
            continue;
        }
        const unjustified = matchingTickets.filter((ticket) => !hasJustificationBlock(ticket));
        if (unjustified.length > 0) {
            violations.push({
                ac_id: smell.ac_id,
                reason: 'multi-ticket decomposition lacks // JUSTIFICATION: blocks on every matching ticket',
                ticket_ids: unjustified.map((ticket) => ticket.id),
            });
        }
    }
    return violations;
}
function runAcShapeEnforcement(manifest) {
    const violations = evaluateAcShapeEnforcement(manifest);
    if (violations.length === 0)
        return 0;
    process.stderr.write('[pickle-rick] AC-shape collapse-or-justify gate failed.\n');
    process.stderr.write('[pickle-rick] Rewrite each AC as one invariant-shaped acceptance criterion, or add // JUSTIFICATION: blocks to every intentionally split ticket.\n');
    for (const violation of violations) {
        const tickets = violation.ticket_ids.length > 0 ? ` tickets=${violation.ticket_ids.join(',')}` : '';
        process.stderr.write(`[pickle-rick] ${violation.ac_id}: ${violation.reason}${tickets}\n`);
    }
    return 2;
}
export function buildRefinementManifest(args, results) {
    const shapeData = collectAcShapeData(results);
    return {
        prd_path: args.prdPath,
        refinement_dir: results.refinementDir,
        all_success: results.allSuccess,
        cycles_requested: results.cyclesRequested,
        cycles_completed: results.allCycleResults.length,
        max_turns_per_worker: results.maxTurns,
        ac_shape_smells: shapeData.acShapeSmells,
        tickets: shapeData.tickets,
        workers: results.finalResults.map((r) => {
            const outputFile = path.join(results.refinementDir, `analysis_${r.roleId}.md`);
            return {
                role: r.roleId,
                success: r.success,
                output_file: outputFile,
                exists: fs.existsSync(outputFile),
                log_file: r.logPath,
                cycle: r.cycle,
            };
        }),
        completed_at: new Date().toISOString(),
    };
}
export async function writeManifestAtomic(manifestPath, manifest) {
    const manifestTmp = `${manifestPath}.tmp.${process.pid}`;
    try {
        await fs.promises.writeFile(manifestTmp, JSON.stringify(manifest, null, 2));
        await fs.promises.rename(manifestTmp, manifestPath);
    }
    catch (err) {
        try {
            await fs.promises.unlink(manifestTmp);
        }
        catch { /* ignore cleanup failure */ }
        throw err;
    }
}
async function main() {
    const args = parseAndValidateArgs(process.argv.slice(2));
    const settings = loadRefinementSettings();
    const prdContent = await fs.promises.readFile(args.prdPath, 'utf-8');
    const cycleResults = await orchestrateCycles(args, settings, prdContent);
    const manifestPath = path.join(args.sessionDir, 'refinement_manifest.json');
    const manifest = buildRefinementManifest(args, cycleResults);
    await writeManifestAtomic(manifestPath, manifest);
    const acShapeStatus = runAcShapeEnforcement(manifest);
    if (acShapeStatus !== 0)
        process.exit(acShapeStatus);
    const runtime = resolveRuntime(args, settings);
    const postRefinementGate = runAcPhaseGate({
        sessionDir: args.sessionDir,
        evaluationPhase: 'post-refinement',
        cwd: runtime.workingDir,
        stdout: (msg) => console.log(msg),
        stderr: (msg) => console.error(msg),
    });
    if (postRefinementGate.status !== 'pass')
        process.exit(2);
    const readinessStatus = runReadinessGate(args.sessionDir, runtime.workingDir, manifestPath);
    if (readinessStatus !== 0)
        process.exit(readinessStatus);
    if (!cycleResults.allSuccess) {
        const failed = cycleResults.finalResults.filter((r) => !r.success).map((r) => r.roleId);
        console.log(`${Style.YELLOW}⚠️  Workers failed: ${failed.join(', ')}. Synthesis will proceed with available analyses.${Style.RESET}`);
    }
    process.stdout.write(`REFINEMENT_DIR=${cycleResults.refinementDir}\n`);
    process.stdout.write(`MANIFEST=${manifestPath}\n`);
}
if (process.argv[1] && path.basename(process.argv[1]) === 'spawn-refinement-team.js') {
    main().catch((err) => {
        const msg = safeErrorMessage(err);
        console.error(`${Style.RED}❌ Fatal: ${msg}${Style.RESET}`);
        process.exit(1);
    });
}

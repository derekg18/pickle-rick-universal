#!/usr/bin/env node
/**
 * pipeline-runner — Sequential phase orchestrator.
 *
 * Phases (in order):
 *   1. pickle       → mux-runner.js        (build/implement)
 *   2. citadel      → in-process audit     (pipeline risk gate)
 *   3. anatomy-park → microverse-runner.js  (deep subsystem review)
 *   4. szechuan-sauce → microverse-runner.js (principle-driven deslopping)
 *
 * Each phase runs as a child process. Between phases the runner resets
 * state.json, creates required config files, and spawns the next runner.
 *
 * Usage: node pipeline-runner.js <session-dir>
 * Expects: pipeline.json in session-dir with phase configuration.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync, spawn } from 'child_process';
import { BACKENDS } from '../types/index.js';
import { StateManager, safeDeactivate, assertSchemaVersionDeployParity, SchemaVersionDeployDriftError } from '../services/state-manager.js';
import { backendEnvOverrides, isBackend } from '../services/backend-spawn.js';
import { getExtensionRoot, Style, formatTime, printMinimalPanel, safeErrorMessage, ensureMonitorWindow, displayMacNotification, writeStateFile, } from '../services/pickle-utils.js';
import { isWorkingTreeDirty } from '../services/git-utils.js';
import { logActivity } from '../services/activity-logger.js';
import { emitBundleLinearComments } from '../services/linear-integration.js';
import { readRecoverableJsonObject } from '../services/microverse-state.js';
import { runAcPhaseGate } from '../services/ac-phase-gate.js';
import { resolveScope, refreshScope, filterBySubsystem, ScopeError, } from '../services/scope-resolver.js';
import { runCitadelAudit } from '../services/citadel/audit-runner.js';
const sm = new StateManager();
const DEFAULT_IGNORE_DIRTY_PATHS = ['prds', 'docs'];
const CODEX_REQUIRED_BACKEND = 'codex-required';
// ---------------------------------------------------------------------------
// Config Parsing
// ---------------------------------------------------------------------------
/** Parse and validate pipeline.json with safe defaults for all integer limit fields. */
function parsePositiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
export function parsePipelineConfig(raw) {
    const rawBackend = raw.backend;
    const backend = typeof rawBackend === 'string' && BACKENDS.includes(rawBackend)
        ? rawBackend
        : undefined;
    const rawIgnore = raw.ignore_dirty_paths;
    const ignore_dirty_paths = Array.isArray(rawIgnore) && rawIgnore.every((p) => typeof p === 'string')
        ? rawIgnore
        : [...DEFAULT_IGNORE_DIRTY_PATHS];
    return {
        phases: normalizePipelinePhases(raw.phases),
        target: raw.target || '',
        szechuan_domain: raw.szechuan_domain,
        szechuan_focus: raw.szechuan_focus,
        anatomy_stall_limit: parsePositiveInteger(raw.anatomy_stall_limit, 3),
        szechuan_stall_limit: parsePositiveInteger(raw.szechuan_stall_limit, 5),
        anatomy_max_iterations: parsePositiveInteger(raw.anatomy_max_iterations, 100),
        szechuan_max_iterations: parsePositiveInteger(raw.szechuan_max_iterations, 50),
        citadel_strict: raw.citadel_strict === true || raw.strict === true,
        backend,
        ignore_dirty_paths,
    };
}
function normalizePipelinePhases(rawPhases) {
    if (!Array.isArray(rawPhases))
        return [];
    const phases = [...rawPhases];
    if (phases.includes('citadel'))
        return phases;
    const pickleIndex = phases.indexOf('pickle');
    const anatomyIndex = phases.indexOf('anatomy-park');
    if (pickleIndex !== -1 && anatomyIndex !== -1 && pickleIndex < anatomyIndex) {
        phases.splice(pickleIndex + 1, 0, 'citadel');
    }
    return phases;
}
/**
 * Resolve the effective backend and the source of that value.
 *
 * Precedence (resume must honor user's new --backend):
 *   state.backend (setup.js --backend, authoritative on resume)
 *     → pipeline.json.backend (original launch flag)
 *       → PICKLE_BACKEND env
 *         → 'claude'
 *
 * setup.js writes state.backend whenever --backend is passed, including on
 * resume. pipeline.json is frozen at first launch, so letting it win would
 * pin the old backend forever even after the user explicitly switched.
 */
export function resolveBackendWithSource(state, pipelineBackend, envBackend) {
    const stateBackend = state ? state.backend : undefined;
    if (isBackend(stateBackend))
        return { backend: stateBackend, source: 'state.json' };
    if (pipelineBackend)
        return { backend: pipelineBackend, source: 'pipeline.json' };
    if (isBackend(envBackend))
        return { backend: envBackend, source: 'env' };
    return { backend: 'claude', source: 'default' };
}
function readYamlLikeField(body, field) {
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = body.match(new RegExp(`^${escaped}:\\s*(.+?)\\s*$`, 'm'));
    return match ? match[1].trim().replace(/^["']|["']$/g, '') : undefined;
}
function extractLeadingYamlFrontmatter(content) {
    const openLen = content.startsWith('---\r\n') ? 5 : content.startsWith('---\n') ? 4 : 0;
    if (openLen === 0)
        return undefined;
    const closeIdx = content.indexOf('\n---', openLen);
    return closeIdx === -1 ? undefined : content.slice(openLen, closeIdx);
}
function extractBundleFrontmatterBlock(content) {
    const marker = content.match(/^frontmatter:\s*[\r\n]+```[^\r\n]*[\r\n]/m);
    if (!marker || marker.index == null)
        return undefined;
    const bodyStart = marker.index + marker[0].length;
    const closeIdx = content.indexOf('\n```', bodyStart);
    return closeIdx === -1 ? undefined : content.slice(bodyStart, closeIdx);
}
export function readBundlePrdBackend(content) {
    const bundleBlock = extractBundleFrontmatterBlock(content);
    const bundleBackend = bundleBlock ? readYamlLikeField(bundleBlock, 'backend') : undefined;
    if (bundleBackend)
        return bundleBackend;
    const yamlBlock = extractLeadingYamlFrontmatter(content);
    return yamlBlock ? readYamlLikeField(yamlBlock, 'backend') : undefined;
}
export function assertCodexRequiredBackend(sessionDir, backend, source) {
    const prdPath = path.join(sessionDir, 'prd.md');
    if (!fs.existsSync(prdPath))
        return;
    const requiredBackend = readBundlePrdBackend(fs.readFileSync(prdPath, 'utf-8'));
    if (requiredBackend !== CODEX_REQUIRED_BACKEND || backend === 'codex')
        return;
    throw new Error(`Bundle PRD declares backend: ${CODEX_REQUIRED_BACKEND}, but pipeline-runner resolved backend ` +
        `${backend} from ${source}. Restart with /pickle-pipeline --backend codex.`);
}
// ---------------------------------------------------------------------------
// Subsystem Discovery (mirrors anatomy-park.md Step 3)
// ---------------------------------------------------------------------------
const SOURCE_EXTS = new Set(['.ts', '.js', '.py', '.go', '.rs', '.java', '.tsx', '.jsx']);
const EXCLUDED_DIRS = new Set([
    'node_modules', 'dist', 'build', '.next', 'coverage',
    '__pycache__', '.git', '.turbo', '.vercel',
]);
const TEST_PATTERNS = ['.test.', '.spec.', '__test__', '__spec__'];
export function isTestFile(name) {
    const lower = name.toLowerCase();
    return TEST_PATTERNS.some(p => lower.includes(p));
}
export function discoverSubsystems(target) {
    let entries;
    try {
        entries = fs.readdirSync(target, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const subsystems = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith('.'))
            continue;
        const fullPath = path.join(target, entry.name);
        let sourceCount = 0;
        let testCount = 0;
        const visited = new Set();
        const walk = (p) => {
            // Resolve real path to detect symlink loops
            let realP;
            try {
                realP = fs.realpathSync(p);
            }
            catch {
                return;
            }
            if (visited.has(realP))
                return;
            visited.add(realP);
            let children;
            try {
                children = fs.readdirSync(p, { withFileTypes: true });
            }
            catch {
                return;
            }
            for (const child of children) {
                if (child.isDirectory() && !EXCLUDED_DIRS.has(child.name)) {
                    walk(path.join(p, child.name));
                }
                else if (child.isFile() && SOURCE_EXTS.has(path.extname(child.name))) {
                    sourceCount++;
                    if (isTestFile(child.name))
                        testCount++;
                }
            }
        };
        walk(fullPath);
        // Exclude test-only directories (>80% test files) per anatomy-park spec
        if (sourceCount >= 3 && testCount / sourceCount <= 0.8) {
            subsystems.push({ name: entry.name, fileCount: sourceCount });
        }
    }
    return subsystems.sort((a, b) => a.name.localeCompare(b.name));
}
// ---------------------------------------------------------------------------
// Pre-flight: Clean Working Tree
// ---------------------------------------------------------------------------
/**
 * Pipelines run long and span multiple phases. Starting with a dirty tree
 * masks which phase introduced which change — downstream microverse phases
 * would otherwise auto-commit the user's pre-existing work under a generic
 * message. Fail fast so the user makes that call deliberately.
 *
 * `ignoreDirtyPaths` excludes those path prefixes (typically docs/prds) from
 * the dirty check — frequent doc edits during a long-running epic shouldn't
 * block resume. Defaults to ['prds', 'docs'] when omitted.
 */
export function assertCleanWorkingTree(workingDir, ignoreDirtyPaths) {
    const ignore = ignoreDirtyPaths ?? [...DEFAULT_IGNORE_DIRTY_PATHS];
    if (!isWorkingTreeDirty(workingDir, ignore))
        return;
    const suffix = ignore.length > 0 ? ` (ignored prefixes: ${ignore.join(', ')})` : '';
    throw new Error(`Working tree at ${workingDir} is dirty${suffix}. Commit, stash, or discard changes before starting the pipeline (git status).`);
}
// ---------------------------------------------------------------------------
// Child Process Management
// ---------------------------------------------------------------------------
let activeChild = null;
let spawnRunnerOverride = null;
let phaseRunnerContext = null;
function spawnRunner(cmd, args, env) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const child = spawn(cmd, args, { stdio: 'inherit', env: env ?? process.env });
        activeChild = child;
        child.on('exit', (code) => { if (!settled) {
            settled = true;
            activeChild = null;
            resolve(code ?? 1);
        } });
        child.on('error', (err) => { if (!settled) {
            settled = true;
            activeChild = null;
            reject(err);
        } });
    });
}
function runSpawnRunner(cmd, args, env) {
    return (spawnRunnerOverride ?? spawnRunner)(cmd, args, env);
}
export function __setSpawnRunnerForTests(fn) {
    spawnRunnerOverride = fn;
}
export function writePipelineStatus(sessionDir, status, details = {}) {
    const payload = {
        status,
        current_phase: details.current_phase ?? null,
        completed_phases: details.completed_phases ?? 0,
        skipped_phases: details.skipped_phases ?? 0,
        total_phases: details.total_phases ?? 0,
        updated_at: new Date().toISOString(),
    };
    const statusPath = path.join(sessionDir, 'pipeline-status.json');
    const tmpPath = `${statusPath}.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
    fs.renameSync(tmpPath, statusPath);
}
// ---------------------------------------------------------------------------
// State Transitions
// ---------------------------------------------------------------------------
export function resetStateForPhase(statePath, template, maxIterations) {
    sm.update(statePath, (s) => {
        // Set inactive — the runner takes ownership and activates on start.
        s.active = false;
        s.iteration = 0;
        s.current_ticket = null;
        s.start_time_epoch = Math.floor(Date.now() / 1000);
        s.max_iterations = maxIterations;
        s.command_template = template;
        s.step = 'review';
        s.chain_meeseeks = false;
        s.tmux_mode = true;
    });
}
/**
 * AC-LPB-05: when pipeline-runner re-attaches to a session that already has
 * prior progress (iteration > 0 OR phases_entered non-empty), this is a
 * reconstruction — reset start_time_epoch so wall-clock cap-checks measure
 * from the resume time, not the original launch. Emits a telemetry event
 * (`session_reconstructed_epoch_reset`) for monitor/standup consumers. Fresh
 * launches (iteration === 0 and no phases entered) keep the setup-supplied
 * epoch and this helper is a no-op.
 *
 * Mutates the passed `state` in place AND writes through StateManager so
 * subsequent reads see the new epoch. Returns the {originalEpoch, newEpoch}
 * pair when a reset happened, otherwise null.
 */
export function applyEpochResetOnReconstruction(state, statePath, sessionDir) {
    const isReconstruction = (typeof state.iteration === 'number' && state.iteration > 0) ||
        (Array.isArray(state.phases_entered) && state.phases_entered.length > 0);
    if (!isReconstruction)
        return null;
    const originalEpoch = typeof state.start_time_epoch === 'number' ? state.start_time_epoch : null;
    const newEpoch = Math.floor(Date.now() / 1000);
    sm.update(statePath, (s) => { s.start_time_epoch = newEpoch; });
    state.start_time_epoch = newEpoch;
    try {
        logActivity({
            event: 'session_reconstructed_epoch_reset',
            source: 'pickle',
            session: path.basename(sessionDir),
            original_epoch: originalEpoch ?? undefined,
            new_epoch: newEpoch,
        });
    }
    catch { /* telemetry best-effort */ }
    return { originalEpoch, newEpoch };
}
function archiveFile(sessionDir, filename, phase) {
    const src = path.join(sessionDir, filename);
    if (!fs.existsSync(src))
        return;
    try {
        fs.copyFileSync(src, path.join(sessionDir, `${path.basename(filename, path.extname(filename))}-${phase}${path.extname(filename)}`));
    }
    catch { /* best effort */ }
}
/** Archive and remove inter-phase artifacts that could confuse the next phase. */
// TASK_NOTES.md lifecycle: intra-phase only by design. Pipeline-mode timeout stubs from one phase
// are archived (to TASK_NOTES-<phase>.md) and removed from canonical path before the next phase's
// setup. This prevents stale notes from contaminating downstream phases. See PRD FR-B16.
// Do NOT add cross-phase propagation without updating the PRD.
export function cleanPhaseArtifacts(sessionDir, phase) {
    // TASK_NOTES.md — stale notes from previous phase
    const notesPath = path.join(sessionDir, 'TASK_NOTES.md');
    if (fs.existsSync(notesPath)) {
        archiveFile(sessionDir, 'TASK_NOTES.md', phase);
        try {
            fs.unlinkSync(notesPath);
        }
        catch { /* best effort */ }
    }
    // gap_analysis.md — stale findings could cause szechuan-sauce to skip Phase 0
    const gapPath = path.join(sessionDir, 'gap_analysis.md');
    if (fs.existsSync(gapPath)) {
        archiveFile(sessionDir, 'gap_analysis.md', phase);
        try {
            fs.unlinkSync(gapPath);
        }
        catch { /* best effort */ }
    }
    // handoff.txt — stale handoff from previous runner
    const handoffPath = path.join(sessionDir, 'handoff.txt');
    if (fs.existsSync(handoffPath)) {
        try {
            fs.unlinkSync(handoffPath);
        }
        catch { /* best effort */ }
    }
}
export function readCitadelReport(sessionDir) {
    const reportPath = path.join(sessionDir, 'citadel_report.json');
    if (!fs.existsSync(reportPath))
        return null;
    try {
        const parsed = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
        if (!isCitadelReport(parsed))
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
function isCitadelReport(value) {
    if (!value || typeof value !== 'object')
        return false;
    const record = value;
    return Array.isArray(record.findings)
        && typeof record.summary === 'object'
        && record.summary !== null
        && (typeof record.exitCode === 'number' || typeof record.exit_code === 'number');
}
function findingText(finding) {
    const citation = typeof finding.file === 'string'
        ? `${finding.file}:${typeof finding.line === 'number' ? finding.line : 0}`
        : undefined;
    const message = typeof finding.message === 'string' ? finding.message : finding.id;
    return citation
        ? `- [${finding.severity}] ${finding.id} ${citation} - ${message}`
        : `- [${finding.severity}] ${finding.id} - ${message}`;
}
function isUnguardedTrapDoorFinding(finding) {
    const id = finding.id.toLowerCase();
    const message = typeof finding.message === 'string' ? finding.message.toLowerCase() : '';
    return id.includes('trap-door') || message.includes('unguarded trap door');
}
function isDivergenceFinding(finding) {
    const id = finding.id.toLowerCase();
    const source = typeof finding.source === 'string' ? finding.source.toLowerCase() : '';
    return id.includes('divergence') || source.includes('divergence');
}
function buildCitadelAnatomyContext(report) {
    if (!report)
        return [];
    const trapDoors = report.findings.filter(isUnguardedTrapDoorFinding);
    return [
        '',
        '## Citadel Report',
        `Read: ${path.basename('citadel_report.json')}`,
        trapDoors.length > 0
            ? 'Prioritize these unguarded trap-door findings during catalog review:'
            : 'No unguarded trap-door findings were reported by Citadel.',
        ...trapDoors.map(findingText),
    ];
}
function buildCitadelSzechuanContext(report) {
    if (!report)
        return [];
    const divergences = report.findings.filter(isDivergenceFinding);
    return [
        '',
        '## Citadel Report',
        `Read: ${path.basename('citadel_report.json')}`,
        divergences.length > 0
            ? 'Treat these divergence findings as known Citadel inputs; do not double-count intentional divergence:'
            : 'No divergence findings were reported by Citadel.',
        ...divergences.map(findingText),
    ];
}
/**
 * Pickle phase entry: pin command_template and scrub stale phase configs.
 *
 * Two failure modes this guards against on resume:
 *   1. command_template drift: a prior run advanced into anatomy-park or
 *      szechuan-sauce and persisted its template. Without re-pinning, mux-runner
 *      would spawn the pickle worker with the wrong prompt — worker runs the
 *      wrong phase, commits with the wrong prefix, emits EPIC_COMPLETED for the
 *      wrong reason. Always overwrite to 'pickle.md' on entry.
 *   2. Stale phase config files (anatomy-park.json, szechuan-sauce.json) left
 *      in the session dir from a previous run. A worker that scans the session
 *      dir might infer wrong context even with the right template. Remove them.
 *
 * Intentionally does NOT touch current_ticket / step / iteration /
 * start_time_epoch — pickle is the only phase that resumes mid-flight, and
 * those pointers must survive an interrupted run.
 */
export function enterPicklePhase(sessionDir, statePath, backend) {
    // Fix A — pin command_template. Stale value from a previous anatomy-park or
    // szechuan-sauce run would otherwise misroute the pickle worker.
    sm.update(statePath, (s) => {
        s.chain_meeseeks = false;
        s.command_template = 'pickle.md';
        if (s.backend !== backend)
            s.backend = backend;
    });
    // Fix B — scrub stale foreign-phase residue left behind by a previous
    // pipeline run. cleanPhaseArtifacts archives TASK_NOTES.md / gap_analysis.md
    // and removes handoff.txt for the named phase; the explicit unlinkSync of
    // <phase>.json catches the microverse-runner convergence state files
    // (anatomy-park.json, szechuan-sauce.json) which cleanPhaseArtifacts does
    // not handle. Either residue can misroute a resumed pickle worker even
    // after command_template is pinned.
    cleanPhaseArtifacts(sessionDir, 'anatomy-park');
    cleanPhaseArtifacts(sessionDir, 'szechuan-sauce');
    for (const stalePhase of ['anatomy-park', 'szechuan-sauce']) {
        const stalePath = path.join(sessionDir, `${stalePhase}.json`);
        if (fs.existsSync(stalePath)) {
            try {
                fs.unlinkSync(stalePath);
            }
            catch { /* best effort */ }
        }
    }
}
/**
 * Setup-time scope resolution. Writes `scope.json` and initializes
 * `state.phases_entered = []`. SCOPE_EMPTY_DIFF is demoted to a WARN (CUJ-6a):
 * a scope-configured session with no diff at setup should not kill the
 * pipeline — the build phase may still produce one. Returns the resolved
 * scope, or `null` when the scope is empty at setup (warning path).
 */
export function setupScope(args) {
    const { sessionDir, workingDir, target, scopeFlag, scopeBase, log } = args;
    const statePath = path.join(sessionDir, 'state.json');
    try {
        const scope = resolveScope({
            scopeFlag,
            scopeBase,
            target,
            sessionRoot: sessionDir,
            repoRoot: workingDir,
        });
        sm.update(statePath, (s) => { s.phases_entered = []; });
        log(`scope-setup: mode=${scope.mode} strategy=${scope.strategy} base=${scope.base_ref ?? '-'} allowed=${scope.allowed_paths.length}`);
        return scope;
    }
    catch (err) {
        if (err instanceof Error && err instanceof ScopeError && err.code === 'SCOPE_EMPTY_DIFF') {
            log(`scope-setup WARN: SCOPE_EMPTY_DIFF — ${err.message} (continuing; build phase may produce diff)`);
            sm.update(statePath, (s) => { s.phases_entered = []; });
            return null;
        }
        throw err;
    }
}
/**
 * Write `archive/skipped_by_scope.<phase>.json` — an observability record of
 * what scope filtered out for `phase`. Pure audit file; worker-side filters
 * (A6/A7) are out of scope for this ticket.
 */
export function writeSkippedByScope(sessionDir, scopePhase, scope, target, workingDir) {
    const archiveDir = path.join(sessionDir, 'archive');
    fs.mkdirSync(archiveDir, { recursive: true });
    const outPath = path.join(archiveDir, `skipped_by_scope.${scopePhase}.json`);
    let payload;
    if (scopePhase === 'anatomy-park') {
        const discovered = discoverSubsystems(target).map((s) => s.name);
        const kept = filterBySubsystem(discovered, scope.allowed_paths, target, workingDir);
        const keptSet = new Set(kept);
        const skipped = discovered.filter((n) => !keptSet.has(n));
        payload = {
            phase: scopePhase,
            head_sha: scope.head_sha,
            allowed_paths: scope.allowed_paths,
            subsystems_discovered: discovered,
            subsystems_kept: kept,
            subsystems_skipped: skipped,
        };
    }
    else {
        payload = {
            phase: scopePhase,
            head_sha: scope.head_sha,
            allowed_paths: scope.allowed_paths,
        };
    }
    const tmp = `${outPath}.tmp.${process.pid}`;
    try {
        fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
        fs.renameSync(tmp, outPath);
    }
    catch (err) {
        try {
            fs.unlinkSync(tmp);
        }
        catch { /* ignore */ }
        throw err;
    }
}
function readPersistedAllowedPaths(sessionDir) {
    const scopePath = path.join(sessionDir, 'scope.json');
    if (!fs.existsSync(scopePath))
        return undefined;
    try {
        const raw = readRecoverableJsonObject(scopePath);
        if (!raw)
            return undefined;
        const field = raw.allowed_paths;
        if (!Array.isArray(field) || field.length === 0 || !field.every((value) => typeof value === 'string')) {
            return undefined;
        }
        return field;
    }
    catch {
        return undefined;
    }
}
function readWorkingDirFromState(sessionDir, fallback) {
    const statePath = path.join(sessionDir, 'state.json');
    if (!fs.existsSync(statePath))
        return fallback;
    try {
        const workingDir = sm.read(statePath).working_dir;
        return typeof workingDir === 'string' && workingDir.length > 0 ? workingDir : fallback;
    }
    catch {
        return fallback;
    }
}
// ---------------------------------------------------------------------------
// Phase Setup: Anatomy Park
// ---------------------------------------------------------------------------
function buildAnatomyPrd(target, subsystems, stallLimit, runnerStallLimit, citadelReport) {
    return [
        '# Anatomy Park: Deep Subsystem Review',
        '',
        '## Objective',
        `Systematically review and fix all subsystems in ${target} through phased review-fix-verify cycles. Catalog structural weaknesses as trap doors in subsystem CLAUDE.md files.`,
        '',
        '## Target',
        target,
        '',
        '## Subsystems',
        ...subsystems.map((s, i) => `${i + 1}. ${s.name} (${s.fileCount} files)`),
        '',
        '## Key Metric',
        '- **Type**: none (worker-managed convergence)',
        `- **Stall Limit**: ${stallLimit} per subsystem | ${runnerStallLimit} total (runner ceiling)`,
        '- **Target**: All subsystems pass clean for 2 consecutive passes',
        '',
        '## Process (each iteration)',
        '1. Select next subsystem from rotation',
        '2. Phase 1: Read-only review — trace data flows, rate all findings',
        '3. Phase 2: Fix the single highest-severity finding + write regression test',
        '4. Phase 3: Read-only self-review of the diff, revert if broken',
        '5. Catalog trap doors in subsystem CLAUDE.md',
        '6. Rotate to next subsystem',
        '',
        '## Rules',
        '- One subsystem per iteration, one fix per iteration',
        '- Three phases per iteration — never combine',
        '- Phase 1 and Phase 3 are READ-ONLY',
        '- Revert on regression, defer to next iteration',
        `- Skip subsystem after ${stallLimit} consecutive failed fixes`,
        ...buildCitadelAnatomyContext(citadelReport),
    ].join('\n');
}
function resolveAnatomySubsystems(target, scope, log) {
    const discovered = discoverSubsystems(target);
    if (discovered.length === 0) {
        log('No subsystems discovered — skipping anatomy-park phase');
        return null;
    }
    if (!scope || scope.allowedPaths.length === 0) {
        log(`Discovered ${discovered.length} subsystems: ${discovered.map(s => s.name).join(', ')}`);
        return discovered;
    }
    const kept = new Set(filterBySubsystem(discovered.map(s => s.name), scope.allowedPaths, target, scope.repoRoot));
    if (kept.size === 0) {
        log('anatomy-park: scope filter excluded all subsystems — skipping phase');
        return null;
    }
    const filtered = discovered.filter(s => kept.has(s.name));
    log(`anatomy-park: scope filtered ${discovered.length} → ${filtered.length} subsystems: ${filtered.map(s => s.name).join(', ')}`);
    return filtered;
}
function writeAnatomyConfig(sessionDir, subsystems, stallLimit) {
    const apState = {
        subsystems: subsystems.map(s => s.name),
        current_index: 0,
        pass_counts: {},
        consecutive_clean: {},
        stall_counts: {},
        stall_limit: stallLimit,
        findings_history: {},
        trap_doors_added: [],
        trap_doors_committed: [],
    };
    writeStateFile(path.join(sessionDir, 'anatomy-park.json'), apState);
}
export function setupAnatomyPark(sessionDir, target, stallLimit, extensionRoot, log, scope) {
    const persistedAllowedPaths = !scope || scope.allowedPaths.length === 0
        ? readPersistedAllowedPaths(sessionDir)
        : undefined;
    const effectiveScope = scope && scope.allowedPaths.length > 0
        ? scope
        : persistedAllowedPaths && persistedAllowedPaths.length > 0
            ? {
                allowedPaths: persistedAllowedPaths,
                repoRoot: readWorkingDirFromState(sessionDir, target),
            }
            : undefined;
    if (!scope && effectiveScope) {
        log(`anatomy-park: reusing persisted scope.json with ${effectiveScope.allowedPaths.length} allowed path(s)`);
    }
    const subsystems = resolveAnatomySubsystems(target, effectiveScope, log);
    if (!subsystems)
        return false;
    const citadelReport = readCitadelReport(sessionDir);
    if (citadelReport)
        log(`anatomy-park: read citadel_report.json with ${citadelReport.findings.length} finding(s)`);
    writeAnatomyConfig(sessionDir, subsystems, stallLimit);
    const runnerStallLimit = subsystems.length * 10;
    const metricJson = JSON.stringify({
        description: 'none', validation: 'none', type: 'none',
        timeout_seconds: 0, tolerance: 0, direction: 'lower',
    });
    const initArgs = [
        path.join(extensionRoot, 'extension', 'bin', 'init-microverse.js'),
        sessionDir, target,
        '--stall-limit', String(runnerStallLimit),
        '--convergence-mode', 'worker',
        '--convergence-file', 'anatomy-park.json',
        '--metric-json', metricJson,
    ];
    const scopePath = path.join(sessionDir, 'scope.json');
    if (effectiveScope && effectiveScope.allowedPaths.length > 0 && fs.existsSync(scopePath)) {
        initArgs.push('--allowed-paths-file', scopePath);
    }
    try {
        execFileSync('node', initArgs, { timeout: 30_000, encoding: 'utf-8' });
    }
    catch (err) {
        log(`init-microverse.js failed: ${safeErrorMessage(err)}`);
        return false;
    }
    archiveFile(sessionDir, 'prd.md', 'pickle');
    fs.writeFileSync(path.join(sessionDir, 'prd.md'), buildAnatomyPrd(target, subsystems, stallLimit, runnerStallLimit, citadelReport));
    log('Anatomy Park setup complete');
    return true;
}
// ---------------------------------------------------------------------------
// Phase Setup: Szechuan Sauce
// ---------------------------------------------------------------------------
function buildSzechuanJudgeContext(sessionDir, principlesPath, extensionRoot, domain, focus, log) {
    if (!domain && !focus) {
        return fs.existsSync(principlesPath) ? principlesPath : undefined;
    }
    const parts = [];
    try {
        parts.push(fs.readFileSync(principlesPath, 'utf-8'));
    }
    catch { /* base missing */ }
    if (domain) {
        const domainPath = path.join(extensionRoot, `szechuan-sauce-${domain}-principles.md`);
        try {
            parts.push(fs.readFileSync(domainPath, 'utf-8'));
        }
        catch {
            log(`Domain principles not found: ${domainPath}`);
        }
    }
    if (focus) {
        parts.push(`\n## Focus Directive\n\n${focus}\n\nViolations matching this focus are elevated by one priority level.`);
    }
    const contextPath = path.join(sessionDir, 'judge-context.md');
    fs.writeFileSync(contextPath, parts.join('\n\n'));
    return contextPath;
}
function buildSzechuanPrd(target, stallLimit, principlesPath, extensionRoot, domain, focus, citadelReport) {
    const prdParts = [
        '# Szechuan Sauce: Iterative Deslopping',
        '',
        '## Objective',
        `Eliminate all coding principle violations in ${target} through iterative review and fix cycles.`,
        '',
        '## Target',
        target,
        '',
        '## Principles Reference',
        `Read: ${principlesPath}`,
    ];
    if (domain)
        prdParts.push(`Read: ${path.join(extensionRoot, `szechuan-sauce-${domain}-principles.md`)}`);
    if (focus)
        prdParts.push('', '## Focus', focus);
    prdParts.push('', '## Key Metric', '- **Type**: llm (LLM judge scoring)', '- **Direction**: lower', '- **Convergence Target**: 0', `- **Stall Limit**: ${stallLimit}`, '', '## Process', '### Iteration 1: Contract Discovery + Gap Analysis', '1. Extract all exports from target files', '2. Grep the entire codebase for importers — build contract map', '3. Flag cross-module mismatches as P1', '4. Catalog all violations into gap_analysis.md', '', '### Each subsequent iteration', '1. Read the principles reference and target code', '2. Identify the highest-priority violation (P0 > P1 > P2 > P3 > P4)', '3. Fix it — one logical change per iteration', '4. Run tests — ensure green', '5. Commit', '', '## Rules', '- One fix per iteration (atomic, revertible)', '- Never repeat a failed approach', '- P0 before P1 before P2 before P3 before P4', ...buildCitadelSzechuanContext(citadelReport));
    return prdParts.join('\n');
}
export function setupSzechuanSauce(sessionDir, target, stallLimit, extensionRoot, domain, focus, log, scope) {
    const principlesPath = path.join(extensionRoot, 'szechuan-sauce-principles.md');
    const judgeContextArg = buildSzechuanJudgeContext(sessionDir, principlesPath, extensionRoot, domain, focus, log);
    const citadelReport = readCitadelReport(sessionDir);
    if (citadelReport)
        log(`szechuan-sauce: read citadel_report.json with ${citadelReport.findings.length} finding(s)`);
    const effectiveAllowedPaths = scope?.allowedPaths?.length
        ? scope.allowedPaths
        : readPersistedAllowedPaths(sessionDir);
    if ((!scope || scope.allowedPaths.length === 0) && effectiveAllowedPaths && effectiveAllowedPaths.length > 0) {
        log(`szechuan-sauce: reusing persisted scope.json with ${effectiveAllowedPaths.length} allowed path(s)`);
    }
    archiveFile(sessionDir, 'microverse.json', 'pre-szechuan');
    const initArgs = [
        path.join(extensionRoot, 'extension', 'bin', 'init-microverse.js'),
        sessionDir, target,
        '--stall-limit', String(stallLimit),
        '--convergence-target', '0',
    ];
    if (judgeContextArg)
        initArgs.push('--judge-context', judgeContextArg);
    const scopePath = path.join(sessionDir, 'scope.json');
    if (effectiveAllowedPaths && effectiveAllowedPaths.length > 0 && fs.existsSync(scopePath)) {
        initArgs.push('--allowed-paths-file', scopePath);
    }
    try {
        execFileSync('node', initArgs, { timeout: 30_000, encoding: 'utf-8' });
    }
    catch (err) {
        log(`init-microverse.js failed: ${safeErrorMessage(err)}`);
        return false;
    }
    archiveFile(sessionDir, 'prd.md', 'anatomy-park');
    fs.writeFileSync(path.join(sessionDir, 'prd.md'), buildSzechuanPrd(target, stallLimit, principlesPath, extensionRoot, domain, focus, citadelReport));
    log('Szechuan Sauce setup complete');
    return true;
}
const PHASE_NAMES = ['pickle', 'citadel', 'anatomy-park', 'szechuan-sauce'];
function isPhaseName(phase) {
    return typeof phase === 'string' && PHASE_NAMES.includes(phase);
}
export function setupPhase(phase, config) {
    const phaseConfigs = {
        pickle: {
            name: 'pickle',
            prevPhase: null,
            runnerScript: 'mux-runner.js',
            setup: null,
            refreshScope: false,
            throwOnEmptyScope: false,
            preSpawnStateMutation: (s) => { s.chain_meeseeks = false; },
        },
        citadel: {
            name: 'citadel',
            prevPhase: 'pickle',
            runnerScript: null,
            setup: null,
            refreshScope: false,
            throwOnEmptyScope: false,
            preSpawnStateMutation: null,
        },
        'anatomy-park': {
            name: 'anatomy-park',
            prevPhase: 'citadel',
            runnerScript: 'microverse-runner.js',
            setup: (args) => setupAnatomyPark(args.sessionDir, args.target, config.anatomy_stall_limit, args.extensionRoot, args.log, args.scope ? { allowedPaths: args.scope.allowed_paths, repoRoot: args.workingDir } : undefined),
            refreshScope: true,
            throwOnEmptyScope: true,
            preSpawnStateMutation: null,
        },
        'szechuan-sauce': {
            name: 'szechuan-sauce',
            prevPhase: 'anatomy-park',
            runnerScript: 'microverse-runner.js',
            setup: (args) => setupSzechuanSauce(args.sessionDir, args.target, config.szechuan_stall_limit, args.extensionRoot, config.szechuan_domain, config.szechuan_focus, args.log, args.scope ? { allowedPaths: args.scope.allowed_paths } : undefined),
            setupExtraArgs: { domain: config.szechuan_domain, focus: config.szechuan_focus },
            refreshScope: true,
            throwOnEmptyScope: false,
            preSpawnStateMutation: null,
        },
    };
    return phaseConfigs[phase];
}
export async function executePhaseRunner(phaseConfig, env) {
    if (!phaseRunnerContext)
        throw new Error('phase runner context not initialized');
    if (!phaseConfig.runnerScript)
        throw new Error(`phase ${phaseConfig.name} does not use a child runner`);
    const exitCode = await runSpawnRunner('node', [
        path.join(phaseRunnerContext.extensionRoot, 'extension', 'bin', phaseConfig.runnerScript),
        phaseRunnerContext.sessionDir,
    ], env);
    return { exitCode };
}
async function executeCitadelPhase(runtime) {
    const state = sm.read(runtime.statePath);
    if (!state.prd_path || !state.start_commit) {
        runtime.log('citadel: missing state.prd_path or state.start_commit — failing phase');
        return { exitCode: 1 };
    }
    const reportPath = path.join(runtime.sessionDir, 'citadel_report.json');
    const result = await runCitadelAudit({
        prdPath: state.prd_path,
        diffRange: `${state.start_commit}..HEAD`,
        repoRoot: runtime.workingDir,
        sessionDir: runtime.sessionDir,
        reportPath,
        strict: runtime.config.citadel_strict,
    });
    runtime.log(`citadel: wrote ${reportPath} with ${result.findings.length} finding(s), exit ${result.exitCode}`);
    return { exitCode: result.exitCode };
}
const SEVERITY_RANK = {
    Critical: 0,
    High: 1,
    Medium: 2,
    Low: 3,
};
function findingMeetsThreshold(finding, threshold) {
    return SEVERITY_RANK[finding.severity] <= SEVERITY_RANK[threshold];
}
function shouldHaltAfterPhase(phase, exitCode, runtime) {
    if (exitCode === 0)
        return false;
    if (phase !== 'citadel')
        return true;
    const report = readCitadelReport(runtime.sessionDir);
    if (!report)
        return true;
    const threshold = runtime.config.citadel_strict ? 'High' : 'Critical';
    const shouldHalt = report.findings.some(finding => findingMeetsThreshold(finding, threshold));
    if (!shouldHalt) {
        runtime.log(`citadel: non-zero audit result did not meet ${threshold} halt threshold — continuing`);
    }
    return shouldHalt;
}
export async function postPhaseCleanup(phase, sessionDir) {
    const prevPhaseByPhase = {
        pickle: null,
        citadel: 'pickle',
        'anatomy-park': 'citadel',
        'szechuan-sauce': 'anatomy-park',
    };
    const prevPhase = prevPhaseByPhase[phase];
    if (prevPhase)
        cleanPhaseArtifacts(sessionDir, prevPhase);
}
function restampBackendIfNeeded(statePath, backend) {
    const cur = sm.read(statePath);
    if (cur.backend !== backend)
        sm.update(statePath, s => { s.backend = backend; });
}
function preparePhaseState(phaseConfig, runtime) {
    const resetByPhase = {
        'anatomy-park': {
            template: 'anatomy-park.md',
            maxIterations: runtime.config.anatomy_max_iterations,
        },
        'szechuan-sauce': {
            template: 'szechuan-sauce.md',
            maxIterations: runtime.config.szechuan_max_iterations,
        },
    };
    const reset = resetByPhase[phaseConfig.name];
    if (phaseConfig.name === 'pickle') {
        enterPicklePhase(runtime.sessionDir, runtime.statePath, runtime.backend);
    }
    else if (reset) {
        resetStateForPhase(runtime.statePath, reset.template, reset.maxIterations);
        restampBackendIfNeeded(runtime.statePath, runtime.backend);
    }
    if (phaseConfig.preSpawnStateMutation) {
        sm.update(runtime.statePath, phaseConfig.preSpawnStateMutation);
    }
}
function refreshPhaseScope(phaseConfig, runtime, counters) {
    if (!phaseConfig.refreshScope)
        return undefined;
    try {
        const refreshed = refreshScope(runtime.sessionDir, phaseConfig.name, {
            repoRoot: runtime.workingDir,
            target: runtime.target,
            log: runtime.log,
        });
        if (refreshed) {
            writeSkippedByScope(runtime.sessionDir, phaseConfig.name, refreshed, runtime.target, runtime.workingDir);
        }
        return refreshed ?? undefined;
    }
    catch (err) {
        if (phaseConfig.throwOnEmptyScope && err instanceof Error && err instanceof ScopeError && err.code === 'SCOPE_EMPTY_POST_BUILD') {
            runtime.log(`SCOPE_EMPTY_POST_BUILD at ${phaseConfig.name} — ${err.message}`);
            writePipelineStatus(runtime.sessionDir, 'failed', {
                current_phase: phaseConfig.name,
                completed_phases: counters.completed,
                skipped_phases: counters.skipped,
                total_phases: runtime.config.phases.length,
            });
            throw err;
        }
        throw err;
    }
}
async function runConfiguredPhase(runtime, phaseConfig, counters) {
    await postPhaseCleanup(phaseConfig.name, runtime.sessionDir);
    preparePhaseState(phaseConfig, runtime);
    const scope = refreshPhaseScope(phaseConfig, runtime, counters);
    const setupOk = phaseConfig.setup ? phaseConfig.setup({
        sessionDir: runtime.sessionDir,
        target: runtime.target,
        workingDir: runtime.workingDir,
        extensionRoot: runtime.extensionRoot,
        log: runtime.log,
        scope,
    }) : true;
    if (!setupOk)
        return { skipped: true, exitCode: null };
    if (phaseConfig.name === 'citadel')
        return { skipped: false, exitCode: (await executeCitadelPhase(runtime)).exitCode };
    return { skipped: false, exitCode: (await executePhaseRunner(phaseConfig, runtime.phaseEnv)).exitCode };
}
function createPipelineLog(sessionDir) {
    const runnerLog = path.join(sessionDir, 'pipeline-runner.log');
    return (msg) => {
        const line = `[${new Date().toISOString()}] ${msg}\n`;
        fs.appendFileSync(runnerLog, line);
        process.stderr.write(line);
    };
}
// eslint-disable-next-line complexity -- pre-existing — outside T0–T15 god-fn refactor scope; defer to follow-up epic
function loadPipelineRuntime(sessionDir, opts, log) {
    const extensionRoot = getExtensionRoot();
    const statePath = path.join(sessionDir, 'state.json');
    const pipelinePath = path.join(sessionDir, 'pipeline.json');
    // Auto-spawn the 4-pane monitor window. Matches mux-runner behaviour —
    // skill prompts no longer need a manual tmux-monitor.sh step.
    try {
        const result = ensureMonitorWindow({ sessionDir, extensionRoot, log });
        log(`ensureMonitorWindow: ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
    }
    catch (err) {
        log(`ensureMonitorWindow: threw (ignored): ${safeErrorMessage(err)}`);
    }
    let config;
    let pipelineRaw;
    try {
        const recoveredPipeline = readRecoverableJsonObject(pipelinePath);
        if (!recoveredPipeline)
            throw new Error('pipeline.json did not contain an object');
        pipelineRaw = recoveredPipeline;
        config = parsePipelineConfig(pipelineRaw);
    }
    catch (err) {
        throw new Error(`Cannot read pipeline.json: ${safeErrorMessage(err)}`);
    }
    // Validate state.json exists
    if (!fs.existsSync(statePath)) {
        throw new Error('state.json not found — run setup.js first');
    }
    let state;
    try {
        state = sm.read(statePath);
    }
    catch (err) {
        throw new Error(`Cannot read state.json: ${safeErrorMessage(err)}`);
    }
    const workingDir = state.working_dir || process.cwd();
    // AC-LPB-05: detect reconstruction and reset start_time_epoch.
    const reset = applyEpochResetOnReconstruction(state, statePath, sessionDir);
    if (reset) {
        log(`reconstruction detected (iteration=${state.iteration ?? 0}) — start_time_epoch reset ${reset.originalEpoch ?? '?'} → ${reset.newEpoch}`);
    }
    // Backend resolution — see resolveBackendWithSource. Capture source BEFORE
    // any state write so the log reflects the actual resolution path.
    const { backend, source } = resolveBackendWithSource(state, config.backend, process.env.PICKLE_BACKEND);
    assertCodexRequiredBackend(sessionDir, backend, source);
    // Only write when the value actually changes — avoids a lock round-trip on
    // every phase when state already matches (fresh-run and steady-state case).
    if (state.backend !== backend) {
        sm.update(statePath, s => { s.backend = backend; });
    }
    const phaseEnv = {
        ...process.env,
        ...backendEnvOverrides(backend),
    };
    log(`backend resolved: ${backend} (source: ${source})`);
    // Pre-flight: refuse to start on a dirty tree. Downstream phases auto-commit
    // on their own, which would roll the user's unrelated WIP into a pipeline
    // commit and obscure which phase changed what. `ignore_dirty_paths` (default
    // ['prds', 'docs']) carves out doc dirs that get edited during long epics.
    assertCleanWorkingTree(workingDir, config.ignore_dirty_paths);
    // Scope resolution (optional). argv > pipeline.json. Omitted → no scope.json,
    // no phases_entered — pipeline-runner behaves as it did pre-change.
    const scopeFlag = opts.scopeFlag ?? (typeof pipelineRaw.scope === 'string' ? pipelineRaw.scope : undefined);
    const scopeBase = opts.scopeBase ?? (typeof pipelineRaw.scope_base === 'string' ? pipelineRaw.scope_base : undefined);
    if (scopeFlag) {
        setupScope({
            sessionDir,
            workingDir,
            target: config.target || workingDir,
            scopeFlag,
            scopeBase,
            log,
        });
    }
    return {
        sessionDir,
        extensionRoot,
        statePath,
        config,
        target: config.target || workingDir,
        workingDir,
        backend,
        phaseEnv,
        log,
    };
}
export function installShutdownHandlers(runtime, counters, cancelMarker) {
    const handleShutdown = (signal) => {
        runtime.log(`Received ${signal} — shutting down pipeline`);
        try {
            fs.writeFileSync(cancelMarker, signal);
        }
        catch { /* best effort */ }
        try {
            writePipelineStatus(runtime.sessionDir, 'cancelled', {
                current_phase: null,
                completed_phases: counters.completed,
                skipped_phases: counters.skipped,
                total_phases: runtime.config.phases.length,
            });
        }
        catch { /* best effort */ }
        if (activeChild && !activeChild.killed)
            activeChild.kill('SIGTERM');
        safeDeactivate(runtime.statePath);
        logActivity({ event: 'session_end', source: 'pickle', session: path.basename(runtime.sessionDir), mode: 'tmux' });
        process.exit(1);
    };
    const handlers = {
        SIGTERM: () => handleShutdown('SIGTERM'),
        SIGINT: () => handleShutdown('SIGINT'),
        SIGHUP: () => handleShutdown('SIGHUP'),
    };
    process.on('SIGTERM', handlers.SIGTERM);
    process.on('SIGINT', handlers.SIGINT);
    process.on('SIGHUP', handlers.SIGHUP);
    return () => {
        process.off('SIGTERM', handlers.SIGTERM);
        process.off('SIGINT', handlers.SIGINT);
        process.off('SIGHUP', handlers.SIGHUP);
    };
}
function writeRunningStatus(runtime, counters, currentPhase) {
    writePipelineStatus(runtime.sessionDir, 'running', {
        current_phase: currentPhase,
        completed_phases: counters.completed,
        skipped_phases: counters.skipped,
        total_phases: runtime.config.phases.length,
    });
}
function logPhaseStart(runtime, phase, index) {
    const phaseLabel = `${index + 1}/${runtime.config.phases.length}`;
    runtime.log(`\n${'═'.repeat(60)}`);
    runtime.log(`PHASE ${phaseLabel}: ${phase.toUpperCase()} (backend=${runtime.backend})`);
    runtime.log(`${'═'.repeat(60)}`);
    printMinimalPanel(`Pipeline Phase: ${phase}`, {
        Phase: phaseLabel,
        Target: runtime.target,
    }, 'CYAN', '🧪');
}
function finalizePipeline(runtime, counters, cancelMarker, startTime) {
    const totalElapsed = Math.floor((Date.now() - startTime) / 1000);
    safeDeactivate(runtime.statePath);
    const phasesSummary = counters.skipped > 0
        ? `${counters.completed}/${runtime.config.phases.length} (${counters.skipped} skipped)`
        : `${counters.completed}/${runtime.config.phases.length}`;
    printMinimalPanel('Pipeline Complete', {
        Phases: phasesSummary,
        Elapsed: formatTime(totalElapsed),
    }, 'GREEN', '🧪');
    runtime.log(`Pipeline finished: ${phasesSummary} phases, ${formatTime(totalElapsed)}`);
    emitBundleLinearComments(runtime.sessionDir, path.join(runtime.sessionDir, 'pipeline-runner.log'));
    logActivity({
        event: 'session_end', source: 'pickle',
        session: path.basename(runtime.sessionDir),
        duration_min: Math.round(totalElapsed / 60),
        mode: 'tmux',
    });
    // macOS notification — helper applies NOTIFICATION_TIMEOUT_MS and swallows
    // errors so a wedged UI server cannot block the exit path.
    const allDone = (counters.completed + counters.skipped) === runtime.config.phases.length;
    displayMacNotification(allDone ? '🧪 Pipeline Complete' : '🧪 Pipeline Stopped', `${phasesSummary} phases, ${formatTime(totalElapsed)}`);
    // Clean up cancel marker
    try {
        fs.unlinkSync(cancelMarker);
    }
    catch { /* may not exist */ }
    // Explicit exit code so callers can detect pipeline failure.
    // Skipped phases (e.g. no subsystems for anatomy-park) are not failures.
    const pipelineFailed = (counters.completed + counters.skipped) < runtime.config.phases.length;
    writePipelineStatus(runtime.sessionDir, pipelineFailed ? 'failed' : 'completed', {
        current_phase: null,
        completed_phases: counters.completed,
        skipped_phases: counters.skipped,
        total_phases: runtime.config.phases.length,
    });
    process.exit(pipelineFailed ? 1 : 0);
}
export async function main(sessionDir, opts = {}) {
    try {
        assertSchemaVersionDeployParity();
    }
    catch (err) {
        if (err instanceof SchemaVersionDeployDriftError) {
            process.stderr.write(`${safeErrorMessage(err)}\n`);
            process.exit(1);
        }
        throw err;
    }
    const log = createPipelineLog(sessionDir);
    log('pipeline-runner started');
    const runtime = loadPipelineRuntime(sessionDir, opts, log);
    const counters = { completed: 0, skipped: 0 };
    const cancelMarker = path.join(sessionDir, 'pipeline-cancel');
    const cleanupShutdownHandlers = installShutdownHandlers(runtime, counters, cancelMarker);
    const startTime = Date.now();
    phaseRunnerContext = { sessionDir, extensionRoot: runtime.extensionRoot };
    writeRunningStatus(runtime, counters, null);
    try {
        for (let i = 0; i < runtime.config.phases.length; i++) {
            const rawPhase = runtime.config.phases[i];
            if (!isPhaseName(rawPhase)) {
                log(`Unknown phase: ${String(rawPhase)} — skipping`);
                continue;
            }
            logPhaseStart(runtime, rawPhase, i);
            writeRunningStatus(runtime, counters, rawPhase);
            const result = await runConfiguredPhase(runtime, setupPhase(rawPhase, runtime.config), counters);
            if (result.skipped) {
                counters.skipped++;
                writeRunningStatus(runtime, counters, null);
                log(`Phase ${rawPhase} skipped (setup returned false)`);
                continue;
            }
            const exitCode = result.exitCode ?? 1;
            log(`Phase ${rawPhase} exited with code ${exitCode}`);
            if (shouldHaltAfterPhase(rawPhase, exitCode, runtime)) {
                log(`Phase ${rawPhase} failed (exit ${exitCode}) — stopping pipeline`);
                break;
            }
            const acGate = runAcPhaseGate({
                sessionDir: runtime.sessionDir,
                evaluationPhase: 'per-phase',
                pipelinePhase: rawPhase,
                cwd: runtime.workingDir,
                stdout: (msg) => log(msg),
                stderr: (msg) => log(msg),
            });
            if (acGate.status !== 'pass') {
                log(`Phase ${rawPhase} AC gate failed — stopping pipeline`);
                break;
            }
            counters.completed++;
            writeRunningStatus(runtime, counters, null);
            // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
            if (fs.existsSync(cancelMarker)) {
                log('Pipeline cancelled (cancel marker found) — stopping');
                break;
            }
            log(`Phase ${rawPhase} completed successfully`);
        }
    }
    finally {
        phaseRunnerContext = null;
        cleanupShutdownHandlers();
    }
    finalizePipeline(runtime, counters, cancelMarker, startTime);
}
/** Extract the value following `flag` in argv, or `undefined` if absent. */
function parseArgvFlag(argv, flag) {
    const idx = argv.indexOf(flag);
    if (idx === -1 || idx + 1 >= argv.length)
        return undefined;
    return argv[idx + 1];
}
/** First argv token that's not a flag and not the value of a preceding flag. */
function findPositional(argv, valuedFlags) {
    for (let i = 0; i < argv.length; i++) {
        const prev = i > 0 ? argv[i - 1] : '';
        if (argv[i].startsWith('--'))
            continue;
        if (valuedFlags.has(prev))
            continue;
        return argv[i];
    }
    return undefined;
}
if (process.argv[1] && path.basename(process.argv[1]) === 'pipeline-runner.js') {
    const argv = process.argv.slice(2);
    const valuedFlags = new Set(['--scope', '--scope-base']);
    const sessionDir = findPositional(argv, valuedFlags);
    if (!sessionDir || !fs.existsSync(path.join(sessionDir, 'state.json'))) {
        console.error('Usage: node pipeline-runner.js <session-dir> [--scope <flag>] [--scope-base <ref>]');
        process.exit(1);
    }
    const scopeFlag = parseArgvFlag(argv, '--scope');
    const scopeBase = parseArgvFlag(argv, '--scope-base');
    main(sessionDir, { scopeFlag, scopeBase }).catch((err) => {
        try {
            writePipelineStatus(sessionDir, 'failed');
        }
        catch { /* best effort */ }
        const msg = safeErrorMessage(err);
        console.error(`${Style.RED}[FATAL] ${msg}${Style.RESET}`);
        process.exit(1);
    });
}

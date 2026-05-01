import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { runGate, filterByScope } from '../services/convergence-gate.js';
import { spawnGateRemediatorMain } from './spawn-gate-remediator.js';
import { readMicroverseState, readRecoverableJsonObject } from '../services/microverse-state.js';
import { logActivity } from '../services/activity-logger.js';
import { getExtensionRoot, isoCompactStamp, safeErrorMessage, writeStateFile } from '../services/pickle-utils.js';
import { StateManager } from '../services/state-manager.js';
import { runAcPhaseGate } from '../services/ac-phase-gate.js';
import { buildWorkerInvocation, backendEnvOverrides, resolveBackend, } from '../services/backend-spawn.js';
const VALID_SKILLS = new Set(['szechuan', 'anatomy-park']);
const sm = new StateManager();
function positiveIntegerOrDefault(value, fallback) {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}
function normalizeFinalizeGateSettings(raw) {
    const defaults = {
        szechuan_max_remediation_cycles: 3,
        anatomy_park_max_remediation_cycles: 5,
        remediator_timeout_s: 600,
    };
    return {
        szechuan_max_remediation_cycles: positiveIntegerOrDefault(raw?.szechuan_max_remediation_cycles, defaults.szechuan_max_remediation_cycles),
        anatomy_park_max_remediation_cycles: positiveIntegerOrDefault(raw?.anatomy_park_max_remediation_cycles, defaults.anatomy_park_max_remediation_cycles),
        remediator_timeout_s: positiveIntegerOrDefault(raw?.remediator_timeout_s, defaults.remediator_timeout_s),
    };
}
function loadFinalizeGateSettings(extRoot) {
    const defaults = {
        szechuan_max_remediation_cycles: 3,
        anatomy_park_max_remediation_cycles: 5,
        remediator_timeout_s: 600,
    };
    try {
        const raw = readRecoverableJsonObject(path.join(extRoot, 'pickle_settings.json'));
        if (!raw)
            return defaults;
        const cg = raw.convergence_gate;
        if (!cg || typeof cg !== 'object')
            return defaults;
        return normalizeFinalizeGateSettings(cg);
    }
    catch {
        return defaults;
    }
}
function splitByScope(failures, allowedPaths, workingDir) {
    if (!allowedPaths || allowedPaths.length === 0) {
        return { inScope: failures, outOfScope: [] };
    }
    const inScope = [];
    const scopeCandidates = [];
    for (const failure of failures) {
        if (/^<[^>]+>$/.test(failure.file) || !path.isAbsolute(failure.file)) {
            inScope.push(failure);
            continue;
        }
        scopeCandidates.push({
            failure,
            relFile: path.relative(workingDir, failure.file),
        });
    }
    const inScopeRel = new Set(filterByScope(scopeCandidates.map(({ relFile }) => relFile), { scope: 'full', allowedPaths }));
    for (const candidate of scopeCandidates) {
        if (inScopeRel.has(candidate.relFile)) {
            inScope.push(candidate.failure);
        }
    }
    const outOfScope = scopeCandidates
        .filter(candidate => !inScopeRel.has(candidate.relFile))
        .map(candidate => candidate.failure);
    return { inScope, outOfScope };
}
function defaultReadStateForWorkingDir(sessionRoot) {
    const statePath = path.join(sessionRoot, 'state.json');
    try {
        const state = sm.read(statePath);
        const workingDir = typeof state.working_dir === 'string' ? state.working_dir : process.cwd();
        const backend = resolveBackend(state);
        return { workingDir, backend };
    }
    catch {
        return null;
    }
}
// eslint-disable-next-line complexity, max-lines-per-function -- pre-existing — outside T0–T15 god-fn refactor scope; defer to follow-up epic
export async function finalizeGateMain(opts) {
    const env = opts.env ?? process.env;
    const out = opts.stdout ?? ((msg) => process.stdout.write(msg + '\n'));
    const err = opts.stderr ?? ((msg) => process.stderr.write(msg + '\n'));
    const doLogActivity = opts.logActivityFn ?? logActivity;
    const iso = opts.isoFn ?? isoCompactStamp;
    const [sessionRoot, skill] = opts.argv;
    if (!sessionRoot || !skill) {
        err('Usage: finalize-gate <session-root> <skill>');
        err('  skill: szechuan | anatomy-park');
        return 1;
    }
    if (!VALID_SKILLS.has(skill)) {
        err(`Invalid skill "${skill}". Must be: ${[...VALID_SKILLS].join(' | ')}`);
        return 1;
    }
    if (env.PICKLE_GATE_DISABLED === '1') {
        doLogActivity({ event: 'gate_skipped', source: 'pickle', gate_payload: { reason: 'kill_switch' } });
        out('[finalize-gate] PICKLE_GATE_DISABLED=1 — skipping post-runner gate');
        return 0;
    }
    const mvState = (opts.readMicroverseStateFn ?? readMicroverseState)(sessionRoot);
    if (!mvState) {
        err(`[finalize-gate] microverse.json not found in ${sessionRoot}`);
        return 1;
    }
    const allowedPaths = mvState.allowed_paths;
    const stateInfo = (opts.readStateForWorkingDirFn ?? defaultReadStateForWorkingDir)(sessionRoot);
    if (!stateInfo) {
        err(`[finalize-gate] state.json not found or unreadable in ${sessionRoot}`);
        return 1;
    }
    const { workingDir, backend } = stateInfo;
    const settings = normalizeFinalizeGateSettings(opts.loadSettingsFn
        ? opts.loadSettingsFn()
        : loadFinalizeGateSettings(getExtensionRoot()));
    const skillKey = skill.replace(/-/g, '_');
    const cap = skillKey === 'szechuan'
        ? settings.szechuan_max_remediation_cycles
        : settings.anatomy_park_max_remediation_cycles;
    const remediatorTimeoutMs = settings.remediator_timeout_s * 1000;
    const gateDir = path.join(sessionRoot, 'gate');
    const mkdir = opts.mkdirSyncFn ?? ((p) => fs.mkdirSync(p, { recursive: true }));
    const writeFile = opts.writeFileFn ?? ((p, data) => fs.writeFileSync(p, data, 'utf-8'));
    mkdir(gateDir);
    const runGateFn = opts.runGateFn ?? runGate;
    const spawnBriefPrep = opts.spawnGateRemediatorMainFn ?? spawnGateRemediatorMain;
    const spawnRemediator = opts.spawnRemediatorFn ?? defaultSpawnRemediator;
    const bundleEndGate = runAcPhaseGate({
        sessionDir: sessionRoot,
        evaluationPhase: 'bundle-end',
        cwd: workingDir,
        stdout: out,
        stderr: err,
    });
    if (bundleEndGate.status !== 'pass')
        return 2;
    let lastResult;
    for (let cycle = 0; cycle < cap; cycle++) {
        out(`[finalize-gate] cycle ${cycle + 1}/${cap} — running strict gate`);
        let result;
        try {
            result = await runGateFn({
                workingDir,
                mode: 'strict',
                scope: 'full',
                checks: ['typecheck', 'lint', 'tests'],
                allowedPaths,
                onEvent: (event, data) => doLogActivity({ event: event, source: 'pickle', gate_payload: data }),
            });
        }
        catch (e) {
            err(`[finalize-gate] gate threw on cycle ${cycle + 1}: ${safeErrorMessage(e)}`);
            return 1;
        }
        lastResult = result;
        if (result.status === 'green' || result.status === 'green-with-known-flake-warnings') {
            out(`[finalize-gate] gate green on cycle ${cycle + 1} — exit 0`);
            return 0;
        }
        const { inScope, outOfScope } = splitByScope(result.failures, allowedPaths, workingDir);
        if (outOfScope.length > 0) {
            const oosPath = path.join(gateDir, `out_of_scope_failures_${iso()}.md`);
            const oosLines = outOfScope.map(f => `- \`${f.file}\` [${f.check}] ${f.ruleOrCode}: ${f.message.slice(0, 200)}`);
            writeFile(oosPath, `# Out-of-Scope Gate Failures\n\nCycle: ${cycle + 1}\nSkill: ${skill}\nTimestamp: ${new Date().toISOString()}\n\n${oosLines.join('\n')}\n`);
            doLogActivity({
                event: 'gate_out_of_scope_failures_present',
                source: 'pickle',
                gate_payload: { count: outOfScope.length, cycle: cycle + 1 },
            });
            out(`[finalize-gate] ${outOfScope.length} out-of-scope failure(s) — written to ${oosPath}`);
        }
        if (inScope.length === 0) {
            out('[finalize-gate] all failures are out-of-scope — exit 0 (closed within scope)');
            return 0;
        }
        const gateResultPath = path.join(gateDir, `gate_result_cycle_${iso()}.json`);
        const inScopeResult = { ...result, failures: inScope };
        writeStateFile(gateResultPath, inScopeResult);
        const briefLines = [];
        let briefCode;
        try {
            briefCode = await spawnBriefPrep({
                argv: ['--gate-result', gateResultPath, '--session-root', sessionRoot, '--reason', 'strict'],
                stdout: (msg) => briefLines.push(msg),
                stderr: (msg) => err(`[gate-remediator] ${msg}`),
            });
        }
        catch (e) {
            err(`[finalize-gate] brief-prep threw on cycle ${cycle + 1}: ${safeErrorMessage(e)}`);
            continue;
        }
        if (briefCode !== 0) {
            err(`[finalize-gate] brief-prep exited ${briefCode} on cycle ${cycle + 1} — skipping remediator`);
            continue;
        }
        const briefPathLine = briefLines.find(l => l.startsWith('BRIEF_PATH='));
        if (!briefPathLine) {
            err(`[finalize-gate] no BRIEF_PATH from brief-prep on cycle ${cycle + 1}`);
            continue;
        }
        const briefPath = briefPathLine.slice('BRIEF_PATH='.length);
        let briefContent;
        try {
            // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
            briefContent = fs.readFileSync(briefPath, 'utf-8');
        }
        catch (e) {
            err(`[finalize-gate] cannot read brief at ${briefPath}: ${safeErrorMessage(e)}`);
            continue;
        }
        const invocation = buildWorkerInvocation(backend, {
            prompt: briefContent,
            addDirs: [workingDir],
        });
        out(`[finalize-gate] spawning remediator (cycle ${cycle + 1})`);
        try {
            spawnRemediator(invocation.cmd, invocation.args, {
                cwd: workingDir,
                timeout: remediatorTimeoutMs,
                env: { ...process.env, ...backendEnvOverrides(invocation.backend) },
            });
        }
        catch (e) {
            err(`[finalize-gate] remediator exited non-zero or timed out: ${safeErrorMessage(e)}`);
        }
    }
    const escalationPath = path.join(gateDir, `escalation_${iso()}.md`);
    const failureLines = (lastResult?.failures ?? []).map(f => `- \`${f.file}\` [${f.check}] ${f.ruleOrCode}: ${f.message.slice(0, 200)}`);
    writeFile(escalationPath, [
        `# Gate Escalation: Cap Exhausted`,
        ``,
        `Skill: ${skill}`,
        `Cap: ${cap} cycles`,
        `Timestamp: ${new Date().toISOString()}`,
        `Remaining failures: ${lastResult?.failures.length ?? 0}`,
        ``,
        `## Failures`,
        ``,
        ...failureLines,
        ``,
        `Manual remediation required. Check gate/ for per-cycle result files.`,
    ].join('\n'));
    err(`[finalize-gate] cap exhausted after ${cap} cycles — exit 2 (escalation: ${escalationPath})`);
    return 2;
}
function defaultSpawnRemediator(cmd, args, spawnOpts) {
    execFileSync(cmd, args, {
        cwd: spawnOpts.cwd,
        timeout: spawnOpts.timeout,
        stdio: 'pipe',
        env: spawnOpts.env,
    });
}
if (process.argv[1] && path.basename(process.argv[1]) === 'finalize-gate.js') {
    finalizeGateMain({ argv: process.argv.slice(2) })
        .then(code => process.exit(code))
        .catch(e => {
        process.stderr.write(`finalize-gate fatal: ${e instanceof Error ? e.message : String(e)}\n`);
        process.exit(1);
    });
}

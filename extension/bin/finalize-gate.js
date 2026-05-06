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
export async function finalizeGateMain(opts) {
    const env = opts.env ?? process.env;
    const out = opts.stdout ?? ((msg) => process.stdout.write(msg + '\n'));
    const err = opts.stderr ?? ((msg) => process.stderr.write(msg + '\n'));
    const doLogActivity = opts.logActivityFn ?? logActivity;
    const iso = opts.isoFn ?? isoCompactStamp;
    const args = parseFinalizeGateArgs(opts.argv, err);
    if (!args)
        return 1;
    if (env.PICKLE_GATE_DISABLED === '1') {
        doLogActivity({ event: 'gate_skipped', source: 'pickle', gate_payload: { reason: 'kill_switch' } });
        out('[finalize-gate] PICKLE_GATE_DISABLED=1 — skipping post-runner gate');
        return 0;
    }
    const bootstrap = buildFinalizeGateRuntime(opts, args, doLogActivity, iso, out, err);
    if ('exitCode' in bootstrap)
        return bootstrap.exitCode;
    const bundleEndGate = runAcPhaseGate({
        sessionDir: args.sessionRoot,
        evaluationPhase: 'bundle-end',
        cwd: bootstrap.runtime.workingDir,
        stdout: out,
        stderr: err,
    });
    if (bundleEndGate.status !== 'pass')
        return 2;
    const cycleResult = await runStrictGateCycles(bootstrap.runtime);
    if (cycleResult.exitCode !== 2)
        return cycleResult.exitCode;
    writeEscalation(bootstrap.runtime, cycleResult.lastResult);
    return 2;
}
function parseFinalizeGateArgs(argv, err) {
    const [sessionRoot, skill] = argv;
    if (!sessionRoot || !skill) {
        err('Usage: finalize-gate <session-root> <skill>');
        err('  skill: szechuan | anatomy-park');
        return null;
    }
    if (!VALID_SKILLS.has(skill)) {
        err(`Invalid skill "${skill}". Must be: ${[...VALID_SKILLS].join(' | ')}`);
        return null;
    }
    return { sessionRoot, skill: skill };
}
function buildFinalizeGateRuntime(opts, args, doLogActivity, iso, out, err) {
    const { sessionRoot, skill } = args;
    const state = readFinalizeGateState(opts, sessionRoot, err);
    if ('exitCode' in state)
        return state;
    const settings = normalizeFinalizeGateSettings(opts.loadSettingsFn
        ? opts.loadSettingsFn()
        : loadFinalizeGateSettings(finalizeGateSettingsRoot()));
    const cap = remediationCycleCap(skill, settings);
    const remediatorTimeoutMs = settings.remediator_timeout_s * 1000;
    const gateDir = path.join(sessionRoot, 'gate');
    const mkdir = opts.mkdirSyncFn ?? ((p) => fs.mkdirSync(p, { recursive: true }));
    const writeFile = opts.writeFileFn ?? ((p, data) => fs.writeFileSync(p, data, 'utf-8'));
    mkdir(gateDir);
    const runGateFn = opts.runGateFn ?? runGate;
    const spawnBriefPrep = opts.spawnGateRemediatorMainFn ?? spawnGateRemediatorMain;
    const spawnRemediator = opts.spawnRemediatorFn ?? defaultSpawnRemediator;
    return {
        runtime: {
            sessionRoot,
            skill,
            allowedPaths: state.allowedPaths,
            workingDir: state.workingDir,
            backend: state.backend,
            cap,
            remediatorTimeoutMs,
            gateDir,
            runGateFn,
            spawnBriefPrep,
            spawnRemediator,
            writeFile,
            doLogActivity,
            iso,
            out,
            err,
        },
    };
}
function remediationCycleCap(skill, settings) {
    return skill === 'szechuan'
        ? settings.szechuan_max_remediation_cycles
        : settings.anatomy_park_max_remediation_cycles;
}
function finalizeGateSettingsRoot() {
    return process.env.EXTENSION_DIR || getExtensionRoot();
}
function readFinalizeGateState(opts, sessionRoot, err) {
    const mvState = (opts.readMicroverseStateFn ?? readMicroverseState)(sessionRoot);
    if (!mvState) {
        err(`[finalize-gate] microverse.json not found in ${sessionRoot}`);
        return { exitCode: 1 };
    }
    const stateInfo = (opts.readStateForWorkingDirFn ?? defaultReadStateForWorkingDir)(sessionRoot);
    if (!stateInfo) {
        err(`[finalize-gate] state.json not found or unreadable in ${sessionRoot}`);
        return { exitCode: 1 };
    }
    return {
        allowedPaths: mvState.allowed_paths,
        workingDir: stateInfo.workingDir,
        backend: stateInfo.backend,
    };
}
async function runStrictGateCycles(runtime) {
    let lastResult;
    for (let cycle = 0; cycle < runtime.cap; cycle++) {
        const cycleResult = await runStrictGateCycle(runtime, cycle);
        lastResult = cycleResult.lastResult ?? lastResult;
        if (cycleResult.action === 'exit')
            return { exitCode: cycleResult.exitCode, lastResult };
    }
    return { exitCode: 2, lastResult };
}
async function runStrictGateCycle(runtime, cycle) {
    runtime.out(`[finalize-gate] cycle ${cycle + 1}/${runtime.cap} — running strict gate`);
    const gateResult = await runStrictGateCheck(runtime, cycle);
    if (!gateResult)
        return { action: 'exit', exitCode: 1 };
    if (gateResult.status === 'green' || gateResult.status === 'green-with-known-flake-warnings') {
        runtime.out(`[finalize-gate] gate green on cycle ${cycle + 1} — exit 0`);
        return { action: 'exit', exitCode: 0, lastResult: gateResult };
    }
    const { inScope, outOfScope } = splitByScope(gateResult.failures, runtime.allowedPaths, runtime.workingDir);
    writeOutOfScopeFailures(runtime, outOfScope, cycle);
    if (inScope.length === 0) {
        runtime.out('[finalize-gate] all failures are out-of-scope — exit 0 (closed within scope)');
        return { action: 'exit', exitCode: 0, lastResult: gateResult };
    }
    const gateResultPath = path.join(runtime.gateDir, `gate_result_cycle_${runtime.iso()}.json`);
    writeStateFile(gateResultPath, { ...gateResult, failures: inScope });
    const briefContent = await readRemediatorBrief(runtime, gateResultPath, cycle);
    if (briefContent)
        spawnRemediatorForBrief(runtime, briefContent, cycle);
    return { action: 'continue', lastResult: gateResult };
}
async function runStrictGateCheck(runtime, cycle) {
    try {
        return await runtime.runGateFn({
            workingDir: runtime.workingDir,
            mode: 'strict',
            scope: 'full',
            checks: ['typecheck', 'lint', 'tests'],
            allowedPaths: runtime.allowedPaths,
            onEvent: (event, data) => runtime.doLogActivity({ event: event, source: 'pickle', gate_payload: data }),
        });
    }
    catch (e) {
        runtime.err(`[finalize-gate] gate threw on cycle ${cycle + 1}: ${safeErrorMessage(e)}`);
        return null;
    }
}
function writeOutOfScopeFailures(runtime, outOfScope, cycle) {
    if (outOfScope.length === 0)
        return;
    const oosPath = path.join(runtime.gateDir, `out_of_scope_failures_${runtime.iso()}.md`);
    const oosLines = outOfScope.map(f => `- \`${f.file}\` [${f.check}] ${f.ruleOrCode}: ${f.message.slice(0, 200)}`);
    runtime.writeFile(oosPath, `# Out-of-Scope Gate Failures\n\nCycle: ${cycle + 1}\nSkill: ${runtime.skill}\nTimestamp: ${new Date().toISOString()}\n\n${oosLines.join('\n')}\n`);
    runtime.doLogActivity({
        event: 'gate_out_of_scope_failures_present',
        source: 'pickle',
        gate_payload: { count: outOfScope.length, cycle: cycle + 1 },
    });
    runtime.out(`[finalize-gate] ${outOfScope.length} out-of-scope failure(s) — written to ${oosPath}`);
}
async function readRemediatorBrief(runtime, gateResultPath, cycle) {
    const briefPath = await prepareRemediatorBrief(runtime, gateResultPath, cycle);
    if (!briefPath)
        return null;
    try {
        // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
        return fs.readFileSync(briefPath, 'utf-8');
    }
    catch (e) {
        runtime.err(`[finalize-gate] cannot read brief at ${briefPath}: ${safeErrorMessage(e)}`);
        return null;
    }
}
async function prepareRemediatorBrief(runtime, gateResultPath, cycle) {
    const briefLines = [];
    let briefCode;
    try {
        briefCode = await runtime.spawnBriefPrep({
            argv: ['--gate-result', gateResultPath, '--session-root', runtime.sessionRoot, '--reason', 'strict'],
            stdout: (msg) => briefLines.push(msg),
            stderr: (msg) => runtime.err(`[gate-remediator] ${msg}`),
        });
    }
    catch (e) {
        runtime.err(`[finalize-gate] brief-prep threw on cycle ${cycle + 1}: ${safeErrorMessage(e)}`);
        return null;
    }
    if (briefCode !== 0) {
        runtime.err(`[finalize-gate] brief-prep exited ${briefCode} on cycle ${cycle + 1} — skipping remediator`);
        return null;
    }
    const briefPathLine = briefLines.find(l => l.startsWith('BRIEF_PATH='));
    if (!briefPathLine) {
        runtime.err(`[finalize-gate] no BRIEF_PATH from brief-prep on cycle ${cycle + 1}`);
        return null;
    }
    return briefPathLine.slice('BRIEF_PATH='.length);
}
function spawnRemediatorForBrief(runtime, briefContent, cycle) {
    const invocation = buildWorkerInvocation(runtime.backend, {
        prompt: briefContent,
        addDirs: [runtime.workingDir],
    });
    runtime.out(`[finalize-gate] spawning remediator (cycle ${cycle + 1})`);
    try {
        runtime.spawnRemediator(invocation.cmd, invocation.args, {
            cwd: runtime.workingDir,
            timeout: runtime.remediatorTimeoutMs,
            env: { ...process.env, ...backendEnvOverrides(invocation.backend) },
        });
    }
    catch (e) {
        runtime.err(`[finalize-gate] remediator exited non-zero or timed out: ${safeErrorMessage(e)}`);
    }
}
function writeEscalation(runtime, lastResult) {
    const escalationPath = path.join(runtime.gateDir, `escalation_${runtime.iso()}.md`);
    const failureLines = (lastResult?.failures ?? []).map(f => `- \`${f.file}\` [${f.check}] ${f.ruleOrCode}: ${f.message.slice(0, 200)}`);
    runtime.writeFile(escalationPath, [
        `# Gate Escalation: Cap Exhausted`,
        ``,
        `Skill: ${runtime.skill}`,
        `Cap: ${runtime.cap} cycles`,
        `Timestamp: ${new Date().toISOString()}`,
        `Remaining failures: ${lastResult?.failures.length ?? 0}`,
        ``,
        `## Failures`,
        ``,
        ...failureLines,
        ``,
        `Manual remediation required. Check gate/ for per-cycle result files.`,
    ].join('\n'));
    runtime.err(`[finalize-gate] cap exhausted after ${runtime.cap} cycles — exit 2 (escalation: ${escalationPath})`);
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

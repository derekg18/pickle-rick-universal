import * as fs from 'fs';
import * as path from 'path';
import { BACKENDS } from '../types/index.js';
import { StateManager } from './state-manager.js';
export function isBackend(value) {
    return typeof value === 'string' && BACKENDS.includes(value);
}
// Dedupe by (source, value) so a bad state.json or typo'd env var warns once
// per process rather than N times per call site. Same silent-fallback trap-door
// class as the spawnSync-no-timeout cluster: a downgrade to 'claude' that should
// have been 'codex' wastes a whole Morty spawn with no signal.
const _warnedBackends = new Set();
const _sm = new StateManager();
export function __resetBackendWarnings() {
    _warnedBackends.clear();
}
function warnBadBackend(sourceLabel, value) {
    const key = `${sourceLabel}:${value}`;
    if (_warnedBackends.has(key))
        return;
    _warnedBackends.add(key);
    process.stderr.write(`[pickle-rick] unrecognized backend ${JSON.stringify(value)} from ${sourceLabel} — falling back to 'claude' (valid: ${BACKENDS.join(', ')})\n`);
}
export function resolveBackend(source) {
    // Refinement lock sentinel: PRD refinement is planning, not implementation.
    // Codex is reserved for implementation. This sentinel is set by
    // spawn-refinement-team and propagates to every grandchild via env
    // inheritance, so any downstream caller that reads state.json (e.g.
    // loadBackendFromSession) cannot leak codex back into the refinement phase.
    // Silent force — no warning, no log.
    if (process.env.PICKLE_REFINEMENT_LOCK === '1')
        return 'claude';
    const raw = source ? source.backend : undefined;
    if (isBackend(raw))
        return raw;
    if (typeof raw === 'string' && raw.length > 0)
        warnBadBackend('state', raw);
    const env = process.env.PICKLE_BACKEND;
    if (isBackend(env))
        return env;
    if (typeof env === 'string' && env.length > 0)
        warnBadBackend('PICKLE_BACKEND env', env);
    return 'claude';
}
export function resolveBackendFromStateFile(statePath) {
    // Refinement lock sentinel: short-circuit before any disk I/O so a stale or
    // codex-stamped state.json cannot override the parent's locked-in claude.
    // Mirrors resolveBackend — see comment above for the full rationale.
    if (process.env.PICKLE_REFINEMENT_LOCK === '1')
        return 'claude';
    try {
        const parsed = _sm.read(statePath);
        return resolveBackend(parsed);
    }
    catch {
        return resolveBackend(null);
    }
}
export function buildWorkerInvocation(backend, opts) {
    return backendAdapters[backend].buildWorkerInvocation(opts);
}
export function buildManagerInvocation(backend, opts) {
    return backendAdapters[backend].buildManagerInvocation(opts);
}
export function backendSupportsTeamsMode(backend) {
    return backendAdapters[backend].supportsTeamsMode();
}
export function backendSupportsDefaultClaudeModels(backend) {
    return backendAdapters[backend].supportsDefaultClaudeModels();
}
export function backendSupportsCommitPendingProbe(backend) {
    return backendAdapters[backend].supportsCommitPendingProbe();
}
export function backendSupportsManagerErrorRelaunch(backend) {
    return backendAdapters[backend].supportsManagerErrorRelaunch();
}
export function backendSupportsWorkerRoutingHeuristic(backend) {
    return backendAdapters[backend].supportsWorkerRoutingHeuristic();
}
export function backendWorkerPromptAddendum(backend, doneToken) {
    return backendAdapters[backend].workerPromptAddendum(doneToken);
}
export function backendMissingCliHint(backend) {
    return backendAdapters[backend].missingCliHint();
}
export function backendSetupVersionCheck(backend) {
    return backendAdapters[backend].setupVersionCheck();
}
function buildClaudeWorkerInvocation(opts) {
    const args = ['--dangerously-skip-permissions'];
    for (const dir of opts.addDirs) {
        if (dir && existsSilently(dir))
            args.push('--add-dir', dir);
    }
    if (opts.outputFormat && opts.outputFormat !== 'text') {
        args.push('--output-format', opts.outputFormat);
    }
    if (opts.model)
        args.push('--model', opts.model);
    // NOTE: claude CLI has no public reasoning-effort flag for `claude -p`; opts.effort
    // is intentionally ignored here. Don't inject --append-system-prompt or env vars
    // as a workaround — the value still survives in state.json for future logging/use.
    args.push('-p', opts.prompt);
    return { cmd: 'claude', args, backend: 'claude' };
}
function buildClaudeManagerInvocation(opts) {
    const args = ['--dangerously-skip-permissions'];
    for (const dir of opts.addDirs) {
        if (dir)
            args.push('--add-dir', dir);
    }
    if (opts.noSessionPersistence)
        args.push('--no-session-persistence');
    if (opts.streamJson)
        args.push('--output-format', 'stream-json', '--verbose');
    if (typeof opts.maxTurns === 'number' && opts.maxTurns > 0) {
        args.push('--max-turns', String(opts.maxTurns));
    }
    if (opts.model)
        args.push('--model', opts.model);
    args.push('-p', opts.prompt);
    return { cmd: 'claude', args, backend: 'claude' };
}
function buildCodexInvocation(prompt, addDirs, model, effort) {
    const args = [
        'exec',
        '--dangerously-bypass-approvals-and-sandbox',
        '--skip-git-repo-check',
        '--ephemeral',
        // Bypass user-level rule files (`~/.codex/AGENTS.md`, `~/.codex/CLAUDE.md`,
        // `~/.codex/skills/*/SKILL.md`). A stale or parallel-universe codex
        // installation can otherwise misdirect the manager into chasing
        // non-existent paths mid-iteration. Pickle-rick's prompts already carry
        // every contract codex needs — letting `~/.codex/` rules override them
        // produces FM-4 (stall-on-imaginary-worker) where codex narrates a worker
        // that doesn't exist instead of invoking spawn-morty.js.
        '--ignore-rules',
        '--ignore-user-config',
    ];
    for (const dir of addDirs) {
        if (dir && existsSilently(dir))
            args.push('--add-dir', dir);
    }
    if (model)
        args.push('-m', model);
    // Codex `-c key=value` is the documented config-override syntax. Must come
    // BEFORE the `--` prompt separator or codex parses it as part of the prompt.
    if (effort)
        args.push('-c', `reasoning.effort=${effort}`);
    args.push('--', prompt);
    return { cmd: 'codex', args, backend: 'codex' };
}
/**
 * Build a read-only judge invocation.
 *
 * The LLM judge scores candidate diffs — it MUST NOT write files, commit, or
 * shell out. Backend-specific judge paths are explicitly locked down:
 *
 * - claude: `--allowedTools Read,Glob,Grep` + `--no-session-persistence`,
 *   threads `--system-prompt` and `-p <prompt>`. No Bash/Edit/Write tools.
 * - codex: `codex exec -s read-only` (codex's built-in read-only sandbox;
 *   see `codex exec --help`). Also passes `--ignore-rules` and
 *   `--ignore-user-config` so the judge cannot be biased by user- or
 *   project-level execpolicy / config TOML. `--ephemeral` keeps the session
 *   off disk. Crucially the bypass flag is DROPPED — the judge never gets
 *   full FS access.
 *
 * codex exec does NOT expose `--system-prompt` / `--allowedTools` /
 * `--no-session-persistence`. The system prompt is inlined as a prefix to the
 * user prompt; the read-only sandbox replaces the tool allowlist.
 */
export function buildJudgeInvocation(backend, opts) {
    return backendAdapters[backend].buildJudgeInvocation(opts);
}
function buildClaudeJudgeInvocation(opts) {
    const args = ['--dangerously-skip-permissions'];
    for (const dir of opts.addDirs) {
        if (dir && existsSilently(dir))
            args.push('--add-dir', dir);
    }
    if (opts.model)
        args.push('--model', opts.model);
    if (opts.systemPrompt)
        args.push('--system-prompt', opts.systemPrompt);
    // Read-only tool allowlist — judge MUST NOT write, edit, or execute.
    args.push('--allowedTools', 'Read,Glob,Grep');
    args.push('--no-session-persistence');
    args.push('-p', opts.prompt);
    return { cmd: 'claude', args, backend: 'claude' };
}
function buildCodexJudgeInvocation(opts) {
    // Inline the system prompt as a prefix since `codex exec` has no
    // --system-prompt flag. The read-only sandbox enforces the actual safety
    // guarantee; the system prompt only shapes the scoring contract.
    const composedPrompt = opts.systemPrompt
        ? `${opts.systemPrompt}\n\n${opts.prompt}`
        : opts.prompt;
    const args = [
        'exec',
        // Read-only sandbox — no file writes, no shell exec, no network.
        // Replaces --dangerously-bypass-approvals-and-sandbox; DO NOT add that
        // flag back into the judge path.
        '-s', 'read-only',
        // Ignore user CLAUDE.md / AGENTS.md / .rules files so project-specific
        // rules cannot bias the judge's scoring contract.
        '--ignore-rules',
        '--ignore-user-config',
        '--skip-git-repo-check',
        '--ephemeral',
    ];
    for (const dir of opts.addDirs) {
        if (dir && existsSilently(dir))
            args.push('--add-dir', dir);
    }
    if (opts.model)
        args.push('-m', opts.model);
    args.push('--', composedPrompt);
    return { cmd: 'codex', args, backend: 'codex' };
}
function buildGeminiWriteInvocation(prompt, addDirs, model) {
    const args = ['--yolo'];
    for (const dir of addDirs) {
        if (dir && existsSilently(dir))
            args.push('--include-directories', dir);
    }
    if (model)
        args.push('-m', model);
    args.push('-p', prompt);
    return { cmd: 'gemini', args, backend: 'gemini' };
}
function buildGeminiWorkerInvocation(opts) {
    return buildGeminiWriteInvocation(opts.prompt, opts.addDirs, opts.model);
}
function buildGeminiManagerInvocation(opts) {
    return buildGeminiWriteInvocation(opts.prompt, opts.addDirs, opts.model);
}
function buildGeminiJudgeInvocation(opts) {
    const composedPrompt = opts.systemPrompt
        ? `${opts.systemPrompt}\n\n${opts.prompt}`
        : opts.prompt;
    const args = ['--approval-mode', 'plan'];
    for (const dir of opts.addDirs) {
        if (dir && existsSilently(dir))
            args.push('--include-directories', dir);
    }
    if (opts.model)
        args.push('-m', opts.model);
    args.push('-p', composedPrompt);
    return { cmd: 'gemini', args, backend: 'gemini' };
}
function existsSilently(p) {
    try {
        return fs.existsSync(p);
    }
    catch {
        return false;
    }
}
function codexWorkerPromptAddendum(doneToken) {
    return `

**Codex-specific contract additions:**
- You MUST run \`git add <files>\` and \`git commit -m "<msg>"\` before emitting \`<promise>${doneToken}</promise>\`. The orchestrator does NOT commit for you.
- If an acceptance criterion contradicts reality (e.g. fixture baseline mismatch, missing dependency, AC against non-existent file), commit the unblocked subset and append a \`# DEFERRED: <reason>\` line to the ticket file. DO NOT loop indefinitely trying to satisfy a contradicted AC.
- DO NOT explore harness internals (\`pickle.md\`, \`setup.js\`, \`send-to-morty.md\`, \`mux-runner.js\`). Those are orchestrator-level. Your scope is exclusively the files listed in the ticket's "Files to modify" / "Files to create" sections.`;
}
export const backendAdapters = {
    claude: {
        backend: 'claude',
        buildWorkerInvocation: buildClaudeWorkerInvocation,
        buildManagerInvocation: buildClaudeManagerInvocation,
        buildJudgeInvocation: buildClaudeJudgeInvocation,
        supportsTeamsMode: () => true,
        supportsDefaultClaudeModels: () => true,
        supportsCommitPendingProbe: () => false,
        supportsManagerErrorRelaunch: () => false,
        supportsWorkerRoutingHeuristic: () => false,
        workerPromptAddendum: () => null,
        missingCliHint: () => 'claude CLI not found on PATH — install claude and re-run /pickle-jar-open',
        setupVersionCheck: () => null,
    },
    codex: {
        backend: 'codex',
        buildWorkerInvocation: (opts) => buildCodexInvocation(opts.prompt, opts.addDirs, opts.model, opts.effort),
        buildManagerInvocation: (opts) => buildCodexInvocation(opts.prompt, opts.addDirs, opts.model),
        buildJudgeInvocation: buildCodexJudgeInvocation,
        supportsTeamsMode: () => false,
        supportsDefaultClaudeModels: () => false,
        supportsCommitPendingProbe: () => true,
        supportsManagerErrorRelaunch: () => true,
        supportsWorkerRoutingHeuristic: () => true,
        workerPromptAddendum: codexWorkerPromptAddendum,
        missingCliHint: () => 'codex CLI not found on PATH — install codex and re-run /pickle-jar-open, or re-jar these tasks with --backend claude',
        setupVersionCheck: () => ({ command: 'codex', packageEngine: 'codex' }),
    },
    gemini: {
        backend: 'gemini',
        buildWorkerInvocation: buildGeminiWorkerInvocation,
        buildManagerInvocation: buildGeminiManagerInvocation,
        buildJudgeInvocation: buildGeminiJudgeInvocation,
        supportsTeamsMode: () => false,
        supportsDefaultClaudeModels: () => false,
        supportsCommitPendingProbe: () => false,
        supportsManagerErrorRelaunch: () => false,
        supportsWorkerRoutingHeuristic: () => false,
        workerPromptAddendum: () => null,
        missingCliHint: () => 'gemini CLI not found on PATH — install gemini and re-run /pickle-jar-open, or re-jar these tasks with --backend claude',
        setupVersionCheck: () => null,
    },
};
export function backendEnvOverrides(backend) {
    const env = { PICKLE_BACKEND: backend };
    return env;
}
export function loadBackendFromSession(sessionDir) {
    return resolveBackendFromStateFile(path.join(sessionDir, 'state.json'));
}

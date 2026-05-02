import * as path from 'path';
import { Defaults } from '../types/index.js';
import { safeErrorMessage } from './pickle-utils.js';
import { StateManager } from './state-manager.js';
import { logActivity } from './activity-logger.js';
import { backendSupportsManagerErrorRelaunch, resolveBackend } from './backend-spawn.js';
const sm = new StateManager();
/**
 * Codex tmux_mode runs ONE long-lived manager subprocess that internally
 * loops across many tickets. The 4h `Defaults.MAX_ITERATION_SECONDS`
 * hang-guard SIGTERMs that subprocess and resolves the iteration with
 * `{ completion: 'error', timedOut: true }`. The legacy error branch
 * unconditionally deactivates the session, stranding any tickets that
 * the manager had not yet picked up.
 *
 * This helper computes whether a runner should relaunch the codex
 * manager (next outer-loop iteration spawns a fresh subprocess that
 * resumes the remaining ticket queue) instead of exiting.
 *
 * Conditions (ALL must hold):
 *   - backend === 'codex' (claude is per-ticket; an error there is terminal)
 *   - tickets remain (Todo or In Progress, status normalized lower-case
 *     and quote-stripped)
 *   - relaunch counter is below `Defaults.CODEX_MANAGER_RELAUNCH_CAP`
 *   - circuit breaker is not OPEN (a tripped CB is the real failure mode
 *     and must surface; relaunch cannot heal it)
 */
export function evaluateCodexManagerRelaunch(state, tickets, cbState) {
    const backend = resolveBackend(state);
    if (!backendSupportsManagerErrorRelaunch(backend)) {
        return { shouldRelaunch: false, pendingCount: 0, nextRelaunchCount: 0, reason: 'not_codex' };
    }
    // AC-LPB-03: Hard wall-clock cap — relaunching after the time budget is
    // exhausted only burns API turns the user already opted out of. Mirror the
    // cap-gate in shouldExitForLimits() so codex relaunches honor the same
    // budget as the main loop. Runs BEFORE every other decision branch so the
    // budget cannot be papered over by pending tickets or a closed CB.
    const startEpoch = Number.isFinite(Number(state.start_time_epoch)) ? Number(state.start_time_epoch) : 0;
    const maxTimeMins = Number.isFinite(Number(state.max_time_minutes)) ? Number(state.max_time_minutes) : 0;
    if (maxTimeMins > 0 && startEpoch > 0) {
        const elapsedSec = Math.max(0, Math.floor(Date.now() / 1000) - startEpoch);
        if (elapsedSec > maxTimeMins * 60) {
            return { shouldRelaunch: false, pendingCount: 0, nextRelaunchCount: 0, reason: 'time_limit' };
        }
    }
    // Tripped circuit breaker → real backend failure, do not paper over it.
    if (cbState && cbState.state === 'OPEN') {
        return { shouldRelaunch: false, pendingCount: 0, nextRelaunchCount: 0, reason: 'circuit_open' };
    }
    const norm = (s) => (s || '').toLowerCase().replace(/["']/g, '').trim();
    const pending = tickets.filter(t => {
        if (!t.id)
            return false;
        const s = norm(t.status);
        return s !== 'done' && s !== 'skipped';
    });
    if (pending.length === 0) {
        return { shouldRelaunch: false, pendingCount: 0, nextRelaunchCount: 0, reason: 'no_pending' };
    }
    const prior = Number(state.codex_manager_relaunch_count) || 0;
    const cap = Defaults.CODEX_MANAGER_RELAUNCH_CAP;
    if (prior >= cap) {
        return { shouldRelaunch: false, pendingCount: pending.length, nextRelaunchCount: prior, reason: 'cap_exceeded' };
    }
    return { shouldRelaunch: true, pendingCount: pending.length, nextRelaunchCount: prior + 1, reason: 'eligible' };
}
/**
 * Persists the codex-manager relaunch decision: bumps
 * `state.codex_manager_relaunch_count` via the StateManager so concurrent
 * readers see the update, and emits a `codex_manager_relaunch` activity
 * event so standup/metrics surface it. Best-effort — caller already
 * decided to relaunch; a state-write failure logs a warning but still
 * lets the next iteration spawn a fresh manager.
 */
export function recordCodexManagerRelaunch(statePath, sessionDir, decision, iteration, log) {
    try {
        sm.update(statePath, s => {
            s.codex_manager_relaunch_count = decision.nextRelaunchCount;
        });
    }
    catch (err) {
        log(`WARN: failed to persist codex_manager_relaunch_count: ${safeErrorMessage(err)}`);
    }
    logActivity({
        event: 'codex_manager_relaunch',
        source: 'pickle',
        session: path.basename(sessionDir),
        iteration,
    });
}

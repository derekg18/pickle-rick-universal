# Tool Error Retry Tracking PRD
| Tool Error Retry Tracking PRD | | Intra-session tool failure tracking with escalating pivot guidance, inspired by OMC's Ralph mode |
|:---|:---|:---|
| **Author**: Gregory Dickson **Contributors**: Claude (Pickle Rick) | **Status**: Draft **Created**: 2026-03-31 | **Visibility**: Internal |

## Completion Checklist
- [x] Introduction - [x] Problem - [x] Scope - [x] CUJs - [x] Requirements - [x] Contracts - [x] Verification - [x] Tests - [x] Assumptions - [x] Risks - [x] Impact - [x] Stakeholders

## Introduction

Add intra-session tool error retry tracking to Pickle Rick. When a Claude worker hits the same tool failure repeatedly within a single session, inject escalating guidance: first "analyze and fix before retrying," then "STOP — try a completely different approach." Mirrors OMC's `last-tool-error.json` pattern, adapted to our hook architecture using the `PostToolUseFailure` hook event.

## Problem Statement

**Current Process**: When a Morty worker or loop runner (tmux, microverse, szechuan-sauce, anatomy-park) encounters a tool failure — bad bash command, failed edit, broken test — Claude will often retry the exact same failing approach multiple times within a single iteration. Our circuit breaker only operates at the iteration boundary (post-hoc NDJSON log analysis in mux-runner), so by the time it detects repeated failures, we've burned entire iteration budgets on identical retries.

**Users**: Pickle Rick loop runners and their spawned workers.

**Pain Points**: Wasted tokens/time on identical retries within a single Claude session. A Morty worker can `npm test` the same broken test 5+ times before the iteration ends and the circuit breaker gets a chance to see it.

**Importance**: Token cost scales linearly with retries. A 5-retry waste per iteration across 10 iterations = 50 wasted tool calls.

## Objective & Scope

**Objective**: Detect repeated tool failures within a Claude session and inject behavioral nudges that escalate from "retry smarter" to "pivot your approach."

**Ideal Outcome**: Workers self-correct after 1-2 retries instead of 5+. The outer-loop circuit breaker trips less often because inner-loop nudges resolve the issue first.

### In-scope

- New `PostToolUseFailure` hook handler that tracks tool errors per-session
- Error state file (`last_tool_error.json`) written per-ticket directory
- Escalating guidance injected via hook response `additionalContext`
- Staleness guard (60s) to prevent cross-session bleed
- Integration with existing dispatch.ts hook routing
- Registration in `settings.json` hook config

### Not-in-scope

- Changes to the circuit breaker (stays as outer-loop kill switch)
- Changes to mux-runner, microverse-runner, spawn-morty (they don't need modification — the hook fires at the Claude Code level, not the runner level)
- Tracking tool successes (only failures)
- Per-runner threshold tuning (use OMC's defaults, tune later from production data)

## Product Requirements

### Critical User Journeys (CUJs)

**CUJ-1: Worker hits same bash error 3 times**
A Morty worker runs `npm test`, gets a compilation error, retries twice more without fixing the root cause. On the 3rd failure, the hook injects: "You've hit this error 3 times. Analyze the root cause before retrying."

**CUJ-2: Worker hits same error 5+ times**
After 5 identical failures, the hook escalates: "STOP RETRYING. Try a completely different approach, check dependencies, or break down the task differently."

**CUJ-3: Worker hits a different error**
Worker fails `npm test` (compilation), then fails `npm test` (runtime error). The count resets because the error changed. No escalation.

**CUJ-4: Stale error file from previous session**
A `last_tool_error.json` exists from 2 minutes ago. The hook ignores it (>60s staleness) and starts fresh.

### Functional Requirements

| Priority | Requirement | User Story | Verification |
|:---|:---|:---|:---|
| P0 | Write `last_tool_error.json` on PostToolUseFailure | As a hook, I capture tool failures for downstream nudging | `node --test` — unit test writes file with correct schema on simulated failure |
| P0 | Track retry count per tool_name | As a hook, I increment count when same tool fails with same error signature | Unit test: 3 sequential same-error calls → count=3 |
| P0 | Reset count on error change | As a hook, I reset count when error signature changes | Unit test: error A then error B → count=1 |
| P0 | Inject "retry smarter" guidance at count < 5 | As a hook, I return additionalContext nudging the LLM to analyze before retrying | Unit test: count=3 → response contains "analyze why" |
| P0 | Inject "pivot approach" guidance at count >= 5 | As a hook, I return additionalContext telling LLM to stop retrying | Unit test: count=5 → response contains "STOP RETRYING" |
| P1 | Staleness guard (60s) | As a hook, I ignore error files older than 60 seconds | Unit test: error file with old timestamp → treated as fresh start |
| P1 | Normalize error signatures | As a hook, I strip paths, timestamps, UUIDs from errors before comparison | Unit test: same error with different paths → same signature |
| P1 | Register hook in settings.json install | As install.sh, I add PostToolUseFailure hook config | `bash install.sh` adds hook entry; `jq` verifies |

## Interface Contracts

### Hook Input Contract (PostToolUseFailure)

Claude Code sends this JSON on stdin:

```typescript
interface PostToolUseFailureInput {
  session_id: string;
  hook_event_name: 'PostToolUseFailure';
  tool_name: string;           // e.g. "Bash", "Edit", "Write"
  tool_input: Record<string, unknown>;  // tool arguments
  error: string;               // e.g. "Command exited with non-zero status code 1"
  is_interrupt?: boolean;
  tool_use_id: string;
  cwd: string;
  transcript_path?: string;
}
```

### Hook Output Contract

```typescript
// On error tracking (non-blocking — always approve, inject guidance)
interface ToolErrorHookResponse {
  decision: 'approve';
  additionalContext?: string;  // Injected into Claude's next turn
}
```

### Error State File Contract (`last_tool_error.json`)

Written to ticket directory (if active session) or session directory.

```typescript
interface ToolErrorState {
  tool_name: string;
  error_signature: string;     // Normalized error (paths/timestamps stripped)
  raw_error: string;           // Original error string
  retry_count: number;
  timestamp: string;           // ISO 8601
}
```

### State Transitions

| From | Event | To | Side Effects | Invariants |
|:---|:---|:---|:---|:---|
| No file | PostToolUseFailure | count=1 | Write last_tool_error.json | File has valid schema |
| count=N, same sig | PostToolUseFailure (same sig) | count=N+1 | Update file, inject guidance if N+1 >= 3 | Count monotonically increases for same sig |
| count=N, diff sig | PostToolUseFailure (new sig) | count=1 | Overwrite file with new sig | Old signature discarded |
| count=N, age > 60s | PostToolUseFailure | count=1 | Overwrite stale file | Staleness = Date.now() - timestamp > 60000 |

## Verification Strategy

- **Type**: `npx tsc --noEmit` passes, no new type escapes
- **Lint**: `npx eslint src/ --max-warnings=-1` passes
- **Test**: All new + existing tests pass via `npm test` from `extension/`
- **Contract**: Hook input/output shapes match Claude Code's PostToolUseFailure schema

### Verification Commands

| Check | Command | Expected |
|:---|:---|:---|
| Type check | `cd extension && npx tsc --noEmit` | Exit 0, no errors |
| Lint | `cd extension && npx eslint src/ --max-warnings=-1` | Exit 0 |
| Unit tests | `cd extension && npm test` | All tests pass |
| Hook registration | `jq '.hooks.PostToolUseFailure' ~/.claude/settings.json` | Contains tool-error-tracker entry |
| Build | `cd extension && npx tsc` | Compiles to extension/hooks/handlers/tool-error-tracker.js |

## Test Expectations

### Unit Tests

Test file: `extension/tests/tool-error-tracker.test.js`

| Requirement | Test File | Description | Assertion |
|:---|:---|:---|:---|
| Write error file | tool-error-tracker.test.js | First failure writes last_tool_error.json | File exists, schema matches ToolErrorState |
| Increment count | tool-error-tracker.test.js | Same tool+signature → count increments | count === previous + 1 |
| Reset on new sig | tool-error-tracker.test.js | Different error signature → count resets to 1 | count === 1, new signature stored |
| Staleness guard | tool-error-tracker.test.js | File with timestamp > 60s ago treated as fresh | count === 1 regardless of previous count |
| Guidance < 5 | tool-error-tracker.test.js | count 3 → additionalContext contains retry guidance | Response includes "analyze why" |
| Guidance >= 5 | tool-error-tracker.test.js | count 5 → additionalContext contains pivot guidance | Response includes "STOP RETRYING" |
| Signature normalization | tool-error-tracker.test.js | Errors differing only in paths/timestamps → same signature | normalizeErrorSignature(a) === normalizeErrorSignature(b) |
| No session → no-op | tool-error-tracker.test.js | No active Pickle session → approve with no side effects | No file written, decision: approve |
| Always approves | tool-error-tracker.test.js | Hook never blocks tool execution | decision === 'approve' in all cases |

### Edge Cases

| Condition | Behavior | Test |
|:---|:---|:---|
| Corrupt last_tool_error.json | Treat as fresh (count=1) | Parse failure → fresh file |
| Empty error string | Use "unknown" as signature | Normalize empty → "unknown" |
| is_interrupt: true | Skip tracking (user cancelled) | No file write on interrupt |
| File write fails (permissions) | Log warning, approve with no guidance | try-catch, non-fatal |
| Concurrent writes (parallel agents) | Last-writer-wins (acceptable — per-ticket dirs isolate) | N/A — no locking needed |

## Assumptions

- Claude Code fires PostToolUseFailure for Bash non-zero exits, Edit failures, and Write failures
- The `error` field contains enough information to create a meaningful signature
- PostToolUseFailure hook responses support `additionalContext` field (same as other hooks)
- 60-second staleness threshold is appropriate (matches OMC's value)
- Threshold of 5 before "pivot" guidance is appropriate (matches OMC's value, tunable later via pickle_settings.json)

## Risks & Mitigations

| Risk | Impact | Mitigation |
|:---|:---|:---|
| PostToolUseFailure doesn't support additionalContext | Guidance can't be injected | Verify with a test hook first; fall back to logging only |
| Hook adds latency to every tool failure | Slows down Claude sessions | File I/O only, no network. Watchdog timeout in dispatch.ts already covers hangs |
| False signature matches (different errors normalize to same) | Premature pivot guidance | Use circuit-breaker's proven normalizeErrorSignature (paths, timestamps, UUIDs stripped, exit codes preserved) |
| Error file left on disk across sessions | Stale guidance on next session | 60s staleness guard handles this |

## Tradeoffs

| Decision | Alternative | Why |
|:---|:---|:---|
| Reuse circuit-breaker's normalizeErrorSignature | Write new normalizer | Proven, tested, handles paths/timestamps/UUIDs. DRY. |
| Per-ticket directory for error file | Per-session directory | Isolates parallel workers on different tickets |
| Always approve (advisory, not blocking) | Block on repeated failures | Blocking tool execution is dangerous — could prevent recovery. Advisory nudges are safer. |
| Copy OMC's thresholds (5 retries) | Custom thresholds | No production data to justify different values. Start with OMC's battle-tested defaults. |

## Business Impact

| Metric | Current | Target | Impact |
|:---|:---|:---|:---|
| Wasted tool calls per iteration | ~5 (on failure loops) | ~2 | 60% reduction in retry waste |
| Circuit breaker trips per epic | Variable | Fewer | Inner-loop nudges resolve before outer-loop kills |
| Token cost per failed iteration | High (full retries) | Lower | Earlier pivot = fewer tokens burned |

## Stakeholders

| Name | Team | Role | Note |
|:---|:---|:---|:---|
| Gregory Dickson | Pickle Rick | Author/Maintainer | Final approval |

## Implementation Notes

### New Files
- `extension/src/hooks/handlers/tool-error-tracker.ts` — PostToolUseFailure handler
- `extension/tests/tool-error-tracker.test.js` — Unit tests

### Modified Files
- `extension/src/types/index.ts` — Add `ToolErrorState` and `PostToolUseFailureInput` interfaces
- `install.sh` — Register PostToolUseFailure hook in settings.json

### Reused
- `normalizeErrorSignature` from `extension/src/services/circuit-breaker.ts` — export already exists
- `resolveStateFile` / `loadActiveState` from `extension/src/hooks/resolve-state.ts`
- `safeErrorMessage` from `extension/src/services/pickle-utils.ts`

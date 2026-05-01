# Refactor Feasibility

Date: 2026-04-28
Analyst: Pickle Worker (Morty / Codex)

## Scope

This document records the post-refactor feasibility state for the two ticketed
hotspots from the god-function remediation PRD. It is a cross-reference snapshot:
helper names and line ranges below are the current implementation in
`extension/src/`, not the historical scratch files from T0.

## DotBuilder `_emitDot`

Current source range: `extension/src/services/dot-builder.ts:2318-2422`

| Helper | Source range | Role | Feasibility status |
| --- | --- | --- | --- |
| `_resetEmitState` | `1316-1344` | Clear per-build mutable buffers before emission | PASS |
| `_initializeEmitContext` | `1347-1435` | Compute topology flags, defense matrix, graph attrs, and baseline nodes | PASS |
| `_emit` / `_link` / `_linkEdge` / `_emitSubgraph` | `1437-1478` | Shared node, edge, and subgraph primitives | PASS |
| `_emitEndgameChain` | `1480-1606` | Disaggregated verify/fix endgame chain | PASS |
| `_emitFanOutTopology` | `1608-1645` | Fan-out topology emission | PASS |
| `_emitCompetingTopology` | `1647-1664` | Competing-topology emission | PASS |
| `_emitConvergenceTopology` | `1667-1845` | Convergence topology and post-chain setup | PASS with 200-LOC topology carve-out |
| `_emitSequentialPhases` | `1848-2249` | Sequential phase emission and diagnostics | PASS with 200-LOC topology carve-out |
| `_emitMicroverseLoop` | `2251-2289` | Microverse standalone loop nodes | PASS |
| `_emitReviewRatchet` | `2291-2315` | Review ratchet standalone nodes | PASS |
| `_emitDot` | `2318-2422` | Topology dispatch, P25 recovery link, isolated-workspace splice, final render | PASS |

Post-pass invariants retained in `_emitDot`:

- P25 catastrophic recovery is emitted at `2335-2339`.
- P0 isolated-workspace commit-and-push insertion is emitted at `2344-2385`.
- The final terminal and render block is emitted at `2387-2421`.

Conclusion: the original monolithic `_emitDot` is split into named helpers that
match the implementation. The remaining long helpers are topology emitters covered
by the PRD's 200-LOC carve-out.

## `mux-runner.ts` Outer Loop

Current runner source range: `extension/src/bin/mux-runner.ts:1508-2226`

| Helper | Source range | Role | Feasibility status |
| --- | --- | --- | --- |
| `validateStartupState` | `1115-1129` | Validate persisted runner state before loop startup | PASS |
| `setupSignalHandlers` | `1131-1142` | Install shutdown handlers | PASS |
| `shouldExitMainLoop` | `1144-1163` | Guard inactive, limit, circuit-open, and stall exits | PASS |
| `processRateLimitCycle` | `1183-1197` | Rate-limit state-machine entrypoint | PASS |
| `processIterationOutcome` | `1252-1260` | Coordinate timeout, circuit-breaker, and completion branches | PASS |
| `processCompletionBranch` | `1417-1454` | Route completion outcomes to task/review/error handlers | PASS |
| `processTaskCompleted` | `1456-1484` | Handle task completion and ticket advancement | PASS |
| `processReviewClean` | `1486-1501` | Handle clean-review completion with minimum-iteration gate | PASS |
| `runMuxRunnerMain` | `1508-2226` | Remaining outer orchestration loop | PASS |

Conclusion: the outer loop now exposes independently testable helpers for the
rate-limit cycle and post-iteration outcome handling. The exported helpers are
covered by `extension/tests/process-iteration-outcome.test.js`.

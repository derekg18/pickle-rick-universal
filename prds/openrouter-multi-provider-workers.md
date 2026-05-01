# OpenRouter Multi-Provider Workers PRD
| OpenRouter Multi-Provider Workers PRD | | Route Morty workers and mux-runner iterations through OpenRouter to leverage best-fit models per task type |
|:---|:---|:---|
| **Author**: Gregory Dickson **Contributors**: Claude (Pickle Rick) | **Status**: Draft **Created**: 2026-04-01 | **Visibility**: Internal |

## Completion Checklist
- [x] Introduction - [x] Problem - [x] Scope - [x] CUJs - [x] Requirements - [x] Contracts - [x] Verification - [x] Tests - [x] Assumptions - [x] Risks - [x] Impact - [x] Stakeholders

## Introduction

Add multi-provider support to Pickle Rick via OpenRouter, enabling worker processes to use any model (DeepSeek, Gemini, GPT, Llama, Mistral, etc.) through a single API key. This enables cost-optimized task routing: cheap/fast models for rote work, premium models for complex reasoning.

Inspired by [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode)'s multi-provider team system (`src/team/runtime.ts`, `src/team/worker-bootstrap.ts`, `skills/omc-teams/SKILL.md`) which spawns Claude/Codex/Gemini CLI processes in tmux panes. Our approach differs: instead of requiring separate CLI installations per provider, we use OpenRouter as a unified gateway — one API key, all providers.

### Reference: OMC's Approach

OMC's multi-provider system (`omc team N:codex "task"`) spawns real CLI processes (`@openai/codex`, `@google/gemini-cli`) in tmux panes. Key patterns:
- Provider-specific launch modes: Claude (interactive/tmux send-keys), Codex (prompt mode/CLI flag), Gemini (interactive + trust gate confirmation)
- Round-robin agent type assignment: `agentTypes[workerIndex % agentTypes.length]`
- Unified task coordination via `done.json` signal files — provider-agnostic
- Provider-appropriate behavioral guidance (not different APIs, different prompts)
- CCG tri-model synthesis: Codex + Gemini artifacts → Claude synthesizes disagreements

Our key insight: OMC's approach requires 3 CLI installations, 3 auth flows, and provider-specific launch code. OpenRouter eliminates all of that with a single HTTP endpoint.

## Problem Statement

**Current Process**: All Pickle Rick workers (`spawn-morty.ts:210`, `mux-runner.ts:458`) spawn `claude` CLI exclusively. Every ticket — whether it's a trivial file rename or a complex architectural refactor — runs on the same model at the same cost.

**Users**: Pickle Rick loop runners (mux-runner, microverse-runner, jar-runner) and their Morty workers.

**Pain Points**:
- Rote implementation tickets (test writing, boilerplate, simple refactors) consume premium Opus tokens unnecessarily
- No way to leverage Gemini's 1M+ context for research-heavy tickets
- No way to use DeepSeek/GPT for cheap parallel grunt work
- Cost scales linearly regardless of task complexity

**Importance**: Token cost is the primary constraint on session length and ticket count. A 10-ticket epic where 6 tickets are rote work could cost 50-80% less with model routing.

## Objective & Scope

**Objective**: Enable Pickle Rick workers to execute via any OpenRouter-accessible model while preserving existing Claude CLI behavior as the default.

**Ideal Outcome**: Ticket-level or step-level model routing where research uses Gemini (big context), implementation uses DeepSeek (cheap/fast), and review/refactor stays on Claude Opus (best reasoning). Cost drops 40-60% on typical epics without quality loss on complex tickets.

### In-scope

- OpenRouter chat completions client (thin wrapper, streaming support)
- `--provider` flag on `spawn-morty.ts` (e.g., `--provider openrouter/deepseek/deepseek-coder`)
- `--provider` support in `mux-runner.ts` `runIteration()` for manager model override
- Provider routing config in `pickle_settings.json` (step → model mapping)
- Per-ticket provider override via ticket metadata
- Prompt adaptation layer (Claude-specific tokens → provider-neutral format)
- Graceful fallback to Claude CLI when OpenRouter is unavailable

### Not-in-scope

- Direct CLI integration with Codex/Gemini CLIs (OMC's approach — too many moving parts)
- Provider-specific tool use (OpenRouter normalizes this)
- Model fine-tuning or custom endpoints
- Changes to stop-hook, dispatch, or circuit-breaker (provider-agnostic)
- Automatic model selection based on ticket complexity analysis (future feature — start with explicit routing)

## Product Requirements

### Critical User Journeys (CUJs)

**CUJ-1: Explicit provider on spawn-morty**
User runs `/pickle-tmux` with a ticket marked `provider: openrouter/deepseek/deepseek-coder`. Morty spawns, sends the prompt to DeepSeek via OpenRouter, streams the response, writes the same NDJSON log, emits the same promise tokens. Circuit breaker, stop hook, and mux-runner see no difference.

**CUJ-2: Step-based routing via settings**
User configures `pickle_settings.json`:
```json
{
  "provider_routing": {
    "research": "openrouter/google/gemini-2.5-pro",
    "implement": "openrouter/deepseek/deepseek-coder",
    "review": "claude"
  }
}
```
When mux-runner reaches the `research` step, it passes `--provider openrouter/google/gemini-2.5-pro` to the iteration. Research runs on Gemini (huge context for codebase scanning). Implementation runs on DeepSeek (cheap). Review stays on Claude Opus.

**CUJ-3: OpenRouter unavailable — graceful fallback**
`OPENROUTER_API_KEY` is unset or OpenRouter returns 5xx. Worker falls back to `claude` CLI with a logged warning. No crash, no stuck session.

**CUJ-4: Per-ticket override**
A ticket's markdown frontmatter includes `provider: openrouter/anthropic/claude-sonnet-4-6`. That ticket runs on Sonnet regardless of the step-based routing config.

**CUJ-5: CCG-style cross-model validation (future)**
User runs `/pickle-refine-prd` with 3 refinement workers — one on Claude, one on Gemini, one on DeepSeek. Each produces independent analysis. Claude synthesizes the three perspectives into the final refined PRD. (Builds on OMC's CCG pattern.)

### Functional Requirements

| Priority | Requirement | User Story | Verification |
|:---|:---|:---|:---|
| P0 | OpenRouter chat client with streaming | As a worker, I send prompts to any OpenRouter model and stream responses | Unit test: mock HTTP, verify streaming chunks parsed correctly |
| P0 | `--provider` flag on spawn-morty | As a runner, I specify which model a worker uses | Unit test: `--provider openrouter/deepseek/deepseek-coder` → OpenRouter client invoked |
| P0 | NDJSON-compatible output from OpenRouter workers | As mux-runner, I parse worker output identically regardless of provider | Unit test: OpenRouter response → same NDJSON format as Claude CLI |
| P0 | Promise token detection works across providers | As stop-hook, I detect WORKER_DONE/TASK_COMPLETED from any provider | Unit test: OpenRouter response containing promise tokens → detected |
| P0 | Fallback to Claude CLI when OpenRouter unavailable | As a worker, I degrade gracefully when OpenRouter is down | Unit test: no API key → spawn claude CLI, log warning |
| P1 | Step-based routing in pickle_settings.json | As a user, I map pipeline steps to providers | Integration test: settings with routing → correct provider per step |
| P1 | Per-ticket provider override via frontmatter | As a user, I override the default provider for specific tickets | Unit test: ticket with `provider:` field → that provider used |
| P1 | Provider in mux-runner runIteration() | As mux-runner, I pass provider config to spawned iterations | Unit test: `--provider` flows through to claude spawn args or OpenRouter client |
| P2 | Cost tracking per provider | As a user, I see per-provider token costs in /pickle-metrics | metrics-utils reads provider from iteration logs |
| P2 | CCG cross-model refinement | As refinement-team, I spawn workers on different providers and synthesize | Integration test: 3 providers → merged output |

## Interface Contracts

### OpenRouter Client

```typescript
// New file: extension/src/services/openrouter-client.ts

interface OpenRouterConfig {
  apiKey: string;           // from OPENROUTER_API_KEY env
  model: string;            // e.g. "deepseek/deepseek-coder"
  baseUrl?: string;         // default: "https://openrouter.ai/api/v1"
}

interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OpenRouterStreamChunk {
  choices: Array<{
    delta: { content?: string };
    finish_reason: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

/**
 * Sends a chat completion request to OpenRouter.
 * Streams response chunks via callback.
 * Returns full response text and token usage.
 */
function streamCompletion(
  config: OpenRouterConfig,
  messages: OpenRouterMessage[],
  onChunk: (text: string) => void
): Promise<{ text: string; usage: { prompt: number; completion: number } }>;
```

### Provider Resolution

```typescript
// Addition to: extension/src/types/index.ts

type ProviderSpec = 
  | 'claude'                              // Default: spawn claude CLI
  | `openrouter/${string}`;               // OpenRouter model path

interface ProviderRoutingConfig {
  research?: ProviderSpec;
  plan?: ProviderSpec;
  implement?: ProviderSpec;
  refactor?: ProviderSpec;
  review?: ProviderSpec;
  default?: ProviderSpec;                 // Fallback for unmapped steps
}
```

### Spawn Contract Changes

```typescript
// spawn-morty.ts — new flag
// --provider <spec>     Provider for this worker (default: "claude")

// mux-runner.ts runIteration() — new parameter
function runIteration(
  sessionDir: string,
  iterationNum: number,
  extensionRoot: string,
  meeseeksModel: string,
  provider?: ProviderSpec            // NEW — defaults to 'claude'
): Promise<string>;
```

### NDJSON Output Compatibility

OpenRouter workers MUST produce output compatible with existing consumers:
- `extractErrorSignature()` in circuit-breaker.ts
- `classifyIterationExit()` in mux-runner.ts
- Promise token scanning in stop-hook.ts
- Log format consumed by log-watcher.ts and monitor.ts

For Claude CLI workers: no change (spawn `claude` as today).
For OpenRouter workers: the client wraps responses in the same NDJSON envelope:

```jsonl
{"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
{"type":"result","subtype":"success"}
```

### Ticket Frontmatter Extension

```yaml
---
id: TICKET-001
title: Implement auth middleware
provider: openrouter/deepseek/deepseek-coder    # Optional override
---
```

### Settings Extension

```jsonc
// pickle_settings.json
{
  "provider_routing": {
    "research": "openrouter/google/gemini-2.5-pro",
    "implement": "openrouter/deepseek/deepseek-coder",
    "refactor": "claude",
    "review": "claude",
    "default": "claude"
  }
}
```

### State Transitions

| From | Event | To | Side Effects | Invariants |
|:---|:---|:---|:---|:---|
| No provider config | Worker spawn | Use `claude` CLI | No change to existing behavior | Backward compatible |
| `--provider openrouter/X` | Worker spawn | OpenRouter client | NDJSON log written in compatible format | Same log schema |
| OpenRouter 5xx/timeout | Worker spawn | Fallback to `claude` CLI | Warning logged to hooks.log | Never crash on provider failure |
| Step changes in state.json | runIteration() | Resolve provider from routing config | Provider may change between iterations | Each iteration is independent |

## Verification Strategy

- **Type**: `npx tsc --noEmit` passes with new types
- **Lint**: `npx eslint src/ --max-warnings=-1` passes
- **Test**: All new + existing tests pass via `npm test`
- **Contract**: NDJSON output from OpenRouter workers parseable by all existing consumers
- **Integration**: End-to-end test with OpenRouter mock server verifying full spawn→stream→log→complete cycle

### Verification Commands

| Check | Command | Expected |
|:---|:---|:---|
| Type check | `cd extension && npx tsc --noEmit` | Exit 0 |
| Lint | `cd extension && npx eslint src/ --max-warnings=-1` | Exit 0 |
| Unit tests | `cd extension && npm test` | All pass |
| Build | `cd extension && npx tsc` | Compiles cleanly |
| Existing tests unbroken | `cd extension && npm test` | Zero regressions |
| Provider routing | Unit test: step→provider resolution | Correct model per step |
| NDJSON compat | Unit test: OpenRouter output → extractErrorSignature | Parses correctly |

## Test Expectations

### Unit Tests

| Requirement | Test File | Description | Assertion |
|:---|:---|:---|:---|
| OpenRouter streaming | openrouter-client.test.js | Mock HTTP → stream chunks → assembled response | Full text matches, usage reported |
| Provider resolution | provider-routing.test.js | Settings + step → correct ProviderSpec | Each step maps to configured provider |
| Ticket override | provider-routing.test.js | Ticket frontmatter provider → overrides step routing | Ticket provider wins |
| Fallback on no API key | provider-routing.test.js | No OPENROUTER_API_KEY → ProviderSpec 'claude' | Always resolves to claude |
| NDJSON envelope | openrouter-client.test.js | OpenRouter response → NDJSON lines | Parseable by extractErrorSignature |
| Promise token passthrough | openrouter-client.test.js | Response containing "I AM DONE" → detected by hasToken | Token found in output |
| spawn-morty --provider | spawn-morty-provider.test.js | --provider flag parsed and routed | OpenRouter client called, not claude CLI |
| Error handling | openrouter-client.test.js | 429/5xx/timeout from OpenRouter | Throws typed error, caller falls back |

### Edge Cases

| Condition | Behavior | Test |
|:---|:---|:---|
| Invalid model path | OpenRouter returns 404 → fall back to claude | Error caught, warning logged |
| Rate limited by OpenRouter (429) | Retry with backoff, then fall back | Respects Retry-After header |
| Response exceeds token limit | OpenRouter truncates → partial response logged | No crash, iteration marked as error |
| Model doesn't support system prompts | Merge system into first user message | Transparent to caller |
| Empty OPENROUTER_API_KEY (set but empty) | Treated as unset → fall back to claude | No API call attempted |
| Provider routing config missing steps | Unmapped steps use `default`, then `claude` | Resolution chain tested |

## Assumptions

- OpenRouter's `/api/v1/chat/completions` endpoint is stable and compatible with OpenAI's schema
- Models available via OpenRouter support system + user message format (most do)
- OpenRouter streaming uses `text/event-stream` SSE format (standard)
- Non-Claude models will follow prompt instructions sufficiently well to emit promise tokens (WORKER_DONE, TASK_COMPLETED) — this is the biggest assumption and may require prompt adaptation
- `OPENROUTER_API_KEY` as the env var name (matches OpenRouter's convention)

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|:---|:---|:---|:---|
| Non-Claude models ignore promise tokens | Workers never signal completion, iterations hang | Medium | Wrap prompt with explicit "you MUST output exactly `I AM DONE` when finished" instruction. Add timeout-based completion detection as fallback. |
| Non-Claude models produce lower quality code | Tickets fail verification, waste iterations | Medium | Start with conservative routing: only rote steps (research, simple implement) on non-Claude. Keep review/refactor on Claude. |
| OpenRouter adds latency vs direct Claude CLI | Slower iterations | Low | OpenRouter is a thin proxy. Measure and compare. |
| OpenRouter pricing changes | Cost savings evaporate | Low | Provider routing is optional — disable = back to Claude CLI |
| NDJSON format mismatch | Circuit breaker, log watchers break | Medium | Extensive NDJSON compatibility tests. The client is responsible for wrapping responses in the correct envelope. |
| Tool use not supported via OpenRouter | Workers can't call tools (Bash, Edit, etc.) | High | This is the critical gap. Claude CLI has native tool use. OpenRouter chat completions do NOT have access to Claude Code's tool system. See Tradeoffs section. |

## Tradeoffs

| Decision | Alternative | Why |
|:---|:---|:---|
| **OpenRouter gateway** | Direct CLI per provider (OMC's approach) | One API key, one auth flow, one HTTP client. OMC requires 3 CLI installations and provider-specific launch code. |
| **HTTP client, not CLI spawn** for OpenRouter | Spawn `openrouter` CLI if one existed | No OpenRouter CLI exists. HTTP is the only option. This means OpenRouter workers are fundamentally different from Claude workers — they can't use Claude Code's tool system. |
| **Hybrid: Claude CLI + OpenRouter** | All-OpenRouter | Claude CLI workers retain full tool use (Bash, Edit, Read, etc.). OpenRouter workers are prompt-in/text-out only. This limits OpenRouter workers to advisory/research roles initially. |
| **Start with research + refinement only** | Full provider routing for all steps | Implementation/refactor steps NEED tool use. Research and PRD refinement are text-in/text-out — perfect for OpenRouter models. Expand to tool-using steps once OpenRouter supports tool use or we build a tool proxy. |
| **NDJSON wrapping in client** | New log format for non-Claude workers | All downstream consumers (circuit breaker, log watcher, monitor) expect NDJSON. Cheaper to wrap than to fork every consumer. |

### Critical Architecture Note: Tool Use Gap

Claude CLI workers have access to the full Claude Code tool system (Bash, Edit, Read, Write, Grep, Glob, Agent). OpenRouter chat completion workers do NOT — they're pure text-in/text-out.

This means OpenRouter workers are immediately useful for:
- **Research phase**: Analyze codebase, produce findings document (text output)
- **PRD refinement**: Produce analysis/critique of PRD (text output)
- **CCG synthesis**: Provide alternative perspectives for Claude to merge (text output)

They are NOT immediately useful for:
- **Implementation**: Needs Edit, Write, Bash tools
- **Refactor**: Needs Edit tools
- **Review with fixes**: Needs Edit tools

**Phase 1**: OpenRouter for research + refinement workers only. Claude CLI for all tool-using steps.
**Phase 2** (future): Build a tool proxy that lets OpenRouter models call tools via function calling → local execution. This is a significant effort and may warrant its own PRD.

## Business Impact

| Metric | Current | Target | Impact |
|:---|:---|:---|:---|
| Research phase cost per ticket | ~$0.50-2.00 (Opus) | ~$0.05-0.20 (Gemini/DeepSeek) | 80-90% reduction on research |
| Refinement team cost (3 analysts) | ~$3-6 (3x Opus) | ~$0.30-1.00 (3x mixed models) | 70-85% reduction |
| Overall epic cost (10 tickets) | ~$15-30 | ~$8-18 | 30-50% reduction (tool-using steps stay on Claude) |
| Research quality with Gemini | N/A (Claude only) | Better for large codebases | Gemini's 1M+ context sees more code |

## Stakeholders

| Name | Team | Role | Note |
|:---|:---|:---|:---|
| Gregory Dickson | Pickle Rick | Author/Maintainer | Final approval |

## Implementation Notes

### New Files
- `extension/src/services/openrouter-client.ts` — Streaming chat completions client
- `extension/src/services/provider-routing.ts` — Step→provider resolution logic
- `extension/tests/openrouter-client.test.js` — Client unit tests
- `extension/tests/provider-routing.test.js` — Routing unit tests

### Modified Files
- `extension/src/types/index.ts` — `ProviderSpec`, `ProviderRoutingConfig` types
- `extension/src/bin/spawn-morty.ts` — `--provider` flag, conditional spawn (claude CLI vs OpenRouter client)
- `extension/src/bin/mux-runner.ts` — Provider resolution per iteration, pass to `runIteration()`
- `extension/src/bin/spawn-refinement-team.ts` — Provider support for refinement workers
- `extension/src/services/pickle-utils.ts` — Helper to parse `ProviderSpec` strings

### Reference: OMC Implementation
- Provider detection: `bridge/team.js` → `isBedrock()`, `resolveClaudeFamily()`
- Worker spawning: `src/team/runtime.ts` → `spawnWorkerForTask()`, provider-specific launch modes
- Worker bootstrap: `src/team/worker-bootstrap.ts` → `agentTypeGuidance()`, unified CLI surface
- CCG synthesis: `skills/ccg/SKILL.md` → Codex + Gemini artifacts → Claude merge
- Provider advisor: `skills/ask/SKILL.md` → `omc ask <provider>` routing

### Phase 1 Scope (this PRD)
1. OpenRouter streaming client
2. Provider routing config + resolution
3. `--provider` on spawn-morty (OpenRouter workers for text-only tasks)
4. Research + refinement worker routing
5. Fallback to Claude CLI

### Phase 2 (future PRD)
1. Tool proxy for OpenRouter models (function calling → local tool execution)
2. Full implementation/refactor step routing to non-Claude models
3. Automatic complexity-based model selection
4. CCG cross-model PRD refinement

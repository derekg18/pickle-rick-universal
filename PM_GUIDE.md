# Product Manager's Guide to Pickle Rick

![Product Manager's Guide to Pickle Rick](images/prd-guide.png)

A practical guide for PMs who want to define work, refine it with AI analysis, and optionally launch autonomous implementation — without needing to understand the internals.

---

## How It Works: Just Tell It What You Want

You don't need to memorize commands, learn syntax, or write a formal document to get started. Open a Claude Code session in your project and just say what you want in plain language:

> "Help me create a PRD for caching the loan status API responses in Redis."

> "I have a prd.md — can you refine it?"

> "I want to build a feature that lets underwriters bulk-approve loans. Help me write the requirements."

That's it. The system recognizes your intent and **automatically activates the right workflow** — PRD drafting, refinement, implementation — without you needing to type a specific command. Behind the scenes there are slash commands like `/pickle-prd` and `/pickle-refine-prd`, but you never need to use them directly. Just describe what you need and the system figures out which tool to use.

Some examples of natural language that triggers the right workflow:

| What you say | What the system does |
|:-------------|:---------------------|
| "Help me create a PRD for X" | Starts the PRD drafting interview |
| "Write requirements for X" | Starts the PRD drafting interview |
| "Refine this PRD" / "Improve my prd.md" | Launches parallel refinement analysts |
| "Build X" / "Implement X" | Drafts a PRD, decomposes, and implements |
| "Refine and implement this PRD" | Refines, decomposes, and launches autonomous implementation |

You can also use the slash commands directly if you prefer — `/pickle-prd`, `/pickle-refine-prd`, `/pickle` — but natural language works just as well.

### The System Explores Your Project For You

Once you describe your intent, the system **automatically explores your codebase** to understand what already exists. It reads your source files, finds relevant patterns, traces how data flows through the system, and identifies the exact files and functions your feature will touch. You don't need to know file paths or function names — the system discovers them.

This exploration happens at two key moments:

1. **During PRD drafting** (`/pickle-prd`) — while interviewing you about requirements, the system reads your code to ground the conversation in reality. It might say: *"I see you already have a Redis client at `src/services/redis.ts` — should we use that, or do you need a separate cache layer?"*

2. **During refinement** (`/pickle-refine-prd`) — three AI analysts run in parallel, each deeply exploring your codebase from a different angle (requirements gaps, code integration points, risk/scope). They cross-reference each other's findings across 3 cycles.

### The Conversation That Builds Your PRD

The system doesn't just accept your description and run — it **interrogates you** to fill gaps. This is a back-and-forth conversation:

- You say what you want to build
- It asks **why** — what problem does this solve, who's affected, why now?
- It asks about **scope** — what's in, what's explicitly out?
- It pushes on **verification** — for *every* requirement, it asks: **"How will we know this works?"**

That last question is the key difference from a traditional PRD. The system needs machine-checkable acceptance criteria — a test to run, a command to execute, a condition to assert. It won't let you get away with "should work correctly." It'll push until you have something like `npm test -- cache-invalidation.test.ts` or `curl -w '%{time_total}' /api/status returns under 100ms`.

This might feel annoying. It's the most valuable part. Requirements that can't be verified automatically can't be implemented reliably.

### What You Get Out

The system produces a structured PRD with:

- Problem statement grounded in your codebase (not abstract)
- Scope boundaries that prevent gold-plating
- Requirements with machine-checkable verification for each one
- Interface contracts with exact data shapes (discovered from your code)
- Test expectations — what tests should exist, what they should assert
- Codebase context — specific file paths, existing patterns to follow

Then, if you choose to refine and implement:

```
Your description  →  Interactive PRD drafting  →  AI Refinement (3 analysts x 3 cycles)
                                                          ↓
                                               Atomic Tickets  →  Autonomous Implementation  →  Code Review
```

---

## Getting Started: Three Approaches

In all cases, start by opening a Claude Code session in your project directory. From there, just talk.

### Approach 1: Guided conversation (recommended)

Best for: First-timers, complex features, when you're not sure about scope.

1. Say something like: *"Help me create a PRD for bulk loan approvals"*
2. The system starts the PRD interview automatically — no command needed
3. Have the conversation — answer questions, push back, iterate
4. Review the generated `prd.md`
5. Say *"Refine this PRD"* — the system launches 3 parallel analysts to improve it
6. Say *"Implement it"* — autonomous execution begins

The interview covers:
- **What** you're building (feature)
- **Why** it matters (problem, value, urgency)
- **Who** it's for (audience, user journeys)
- **How** to verify it (the hard question — automated checks for each requirement)
- **What's out of scope** (prevents the AI from building things you didn't ask for)
- **What exists already** (the system reads your codebase and asks about relevant code it finds)

### Approach 2: Write your own PRD, let the system refine it

Best for: PMs who already have a draft or are comfortable writing requirements.

1. Write a `prd.md` (see template below)
2. *(Optional)* Add a `context/` directory with customer signals — call summaries, feedback themes, support issues. The refinement team reads this to ground analysis in real user needs rather than abstract requirements.
3. Say *"Refine my prd.md"* — the system finds it and launches refinement
4. It checks your PRD for verification readiness — if it's thin, it interviews you
5. Three analysts explore your codebase and refine the PRD in parallel
6. Atomic tickets are generated
7. Review, then say *"Implement it"* or *"Resume"*

### Approach 3: One sentence, full automation

Best for: Small, well-understood changes. Risky for anything complex.

1. Say *"Build rate limiting for the status API"*
2. The system drafts a PRD from your sentence, explores the codebase, decomposes into tickets, and implements
3. All in one loop, no hand-holding

---

## Writing a Better PRD (optional — the system helps you)

You don't *need* to write a formal PRD — the guided conversation produces one for you. But if you prefer to write your own, or want to understand what makes a good one, here's the template:

### The Minimum Viable PRD

```markdown
# [Feature Name] PRD

## Problem
What's broken, who's affected, why it matters now.

## Goal
One sentence describing what "done" looks like.

## Scope
### In-scope
- What to build (be specific)

### Out of scope
- What NOT to build (be explicit — this prevents the AI from gold-plating)

## Requirements
| Priority | Requirement | Verification |
|:---------|:------------|:-------------|
| P0       | [Must have] | [How to verify automatically] |
| P1       | [Should have] | [How to verify automatically] |
```

Five sections. The refinement process fills in everything else — interface contracts, test expectations, codebase context, implementation details. But the more you provide, the better the output.

### The Verification Column

This is the single most important thing that separates a Pickle Rick PRD from a traditional PRD. Every requirement needs a **machine-checkable** way to verify it.

**Good verification examples:**
- `npm test -- loan-status.test.ts` (run a specific test)
- `curl -w '%{time_total}' localhost:3000/api/status` returns under 200ms
- `npx tsc --noEmit` passes with zero errors
- `grep -r "TODO" src/auth/` returns no results
- LLM reads implementation and confirms behavior matches spec (for UX/behavioral requirements)

**Bad verification examples:**
- "Should work correctly" (not testable)
- "Looks good" (subjective)
- "QA will verify" (not automated)
- "Meets requirements" (circular)

If you can't think of how to verify a requirement automatically, that's a signal the requirement is too vague. Rewrite it until you can.

### Priority Levels

| Priority | Meaning | Guidance |
|:---------|:--------|:---------|
| **P0** | Must ship | Blocks the feature. If any P0 fails verification, the implementation is incomplete. |
| **P1** | Should ship | Important but the feature works without it. Can be a follow-up ticket. |
| **P2** | Nice to have | Only if time allows. Often better as a separate PRD. |

### Sections That Improve Output Quality

Beyond the minimum, these sections significantly improve what the system produces:

**User Journeys** — Step-by-step flows become acceptance tests:

```markdown
### CUJ: Approve a Loan
1. User opens loan detail page (`/loans/:id`)
2. Clicks "Approve" button
3. Confirmation modal appears with reason field
4. User enters reason, clicks "Confirm"
5. Status updates to "Approved" in the UI
6. Audit log entry created
7. Notification sent to borrower
```

**Customer context (`context/` directory)** — Drop a `context/` folder in your repo root with curated customer signals. The refinement team reads these files and uses them to prioritize requirements and identify gaps you might miss from code alone:

```
context/
  call-themes-q1.md          # Themes from customer/prospect calls
  top-support-issues.md       # Most common support tickets
  feature-requests.md         # Aggregated feedback and requests
  sales-objections.md         # Why deals stall or are lost
```

Keep these curated and concise — a 2-page summary of call themes is more useful than 50 raw transcripts. The refinement analysts will reference specific customer feedback when they find gaps in your PRD.

**Not-in-scope** — Explicitly listing what you're NOT building prevents the AI from over-engineering:

```markdown
### Not in scope
- Bulk approval (separate feature)
- Email notifications (existing system handles this)
- Approval workflow with multiple reviewers (v2)
- Mobile-specific UI changes
```

---

## Common PRD Mistakes

| Mistake | Why It's Bad | Fix |
|:--------|:-------------|:----|
| No scope boundaries | AI adds features you didn't ask for | Write explicit "Not in scope" section |
| Vague requirements ("improve performance") | Can't verify, can't decompose into tickets | Make measurable: "API response time under 200ms at p95" |
| Implementation details as requirements | Constrains the solution unnecessarily | Describe the **what**, not the **how** |
| Multiple unrelated features | Tickets get tangled, verification becomes unclear | One PRD per feature |
| No codebase context | Refinement team has to guess where things go | Point at existing files and patterns |
| Subjective acceptance criteria | "Looks professional" can't be automated | Rewrite as observable behavior |
| Time estimates | The system ignores them; they add noise | Focus on scope and priority instead |

---

## Example: Minimal PRD That Works

```markdown
# Loan Status Caching PRD

## Problem
The loan status API (`GET /api/loans/:id/status`) hits the database on every request.
At current volume (500 req/min), this adds unnecessary load and increases p95 latency to 800ms.
Operations team has flagged this as a scaling concern before Q3 volume increase.

## Goal
Cache loan status responses in Redis with intelligent invalidation,
reducing p95 latency to under 100ms for cache hits.

## Scope
### In-scope
- Redis cache layer for loan status endpoint
- Cache invalidation when loan status changes
- Cache TTL configuration
- Cache hit/miss metrics logging

### Out of scope
- Caching other endpoints (separate PRD per endpoint)
- Redis cluster setup (ops team handles infrastructure)
- Cache warming on deployment

## Requirements
| Priority | Requirement | Verification |
|:---------|:------------|:-------------|
| P0 | Cached responses return in <100ms at p95 | `npm run bench -- loan-status --p95` |
| P0 | Cache invalidates when status changes via PUT /api/loans/:id/status | `npm test -- cache-invalidation.test.ts` |
| P0 | Cache TTL is configurable via environment variable | `CACHE_TTL=60 npm test -- cache-ttl.test.ts` |
| P1 | Cache hit/miss ratio logged to application metrics | `grep "cache.hit\|cache.miss" src/api/routes/loan-status.ts` |
| P1 | Graceful degradation — DB fallback if Redis is unavailable | `npm test -- cache-fallback.test.ts` |

## Context
- Endpoint: `src/api/routes/loan-status.ts`
- Redis client: `src/services/redis.ts` (already configured)
- Test pattern: see `tests/api/loan-notes.test.ts`
- Status update handler: `src/api/routes/loan-mutations.ts:updateStatus()`
```

This is ~40 lines. Refinement expands it to ~200 with contracts, test expectations, and implementation details. The tickets practically write themselves.

---

## What Happens After Your PRD Is Ready

### Refinement (automatic)

When you say *"refine this PRD"* (or run `/pickle-refine-prd`), the system first checks your PRD for **verification readiness** — interface contracts with exact types, verification commands that can actually run, test expectations with file paths, and machine-checkable acceptance criteria. If anything is missing or vague, it pauses and asks you to fill gaps.

Then three AI analysts explore your project in parallel:

| Analyst | What It Does |
|:--------|:-------------|
| **Requirements** | Finds gaps, ambiguities, missing acceptance criteria, untestable requirements |
| **Codebase** | Maps requirements to existing code — finds file paths, patterns to follow, integration points, potential conflicts |
| **Risk & Scope** | Identifies scope creep potential, dependency risks, ordering concerns, missing edge cases |

They run 3 cycles, cross-referencing each other's findings. Changes are attributed — `*(refined: requirements analyst)*` — so you can trace what changed.

The output is:
- `prd_refined.md` — your PRD with refinement additions, concrete file paths, and interface contracts
- `linear_ticket_parent.md` — the epic
- `<hash>/linear_ticket_<hash>.md` — one per ticket, ordered

Each ticket is decomposed to be atomic:
- < 30 minutes of coding work
- Touches < 5 files
- < 4 acceptance criteria
- Self-contained (the worker doesn't need the full PRD)
- Embedded research seeds (file paths, patterns, APIs to look at)

### Implementation (autonomous)

After refinement, the system executes autonomously. Each ticket goes through 8 phases:

1. **Research** — reads the codebase to understand context
2. **Review research** — validates understanding before planning
3. **Plan** — architects the solution
4. **Review plan** — catches design issues before coding
5. **Implement** — writes the code
6. **Spec conformance** — runs every acceptance criterion automatically
7. **Code review** — security, correctness, architecture audit
8. **Simplify** — removes dead code, cleans up

You don't need to be involved. But review the PRD carefully before launching — it's the source of truth for everything downstream.

---

## Reviewing Tickets Before Implementation

Before saying *"implement it"* (or running `/pickle --resume`), check the tickets:

- **Order**: Do dependencies make sense? Ticket 10 shouldn't depend on Ticket 30.
- **Scope**: Is each ticket doing one thing? Split if it's doing two.
- **Acceptance criteria**: Could you manually verify each criterion? If not, rewrite it.
- **File paths**: Do the referenced files actually exist? Refinement usually gets this right, but check.
- **Not-in-scope**: Does any ticket exceed the PRD's scope boundaries?

You can edit tickets directly — they're markdown files in the session directory.

---

## Monitoring Progress

You can check on things at any time by asking in natural language:

| What you say | What you get |
|:-------------|:-------------|
| *"What's the status?"* | Current phase, iteration, ticket status (todo/in-progress/done) |
| *"Give me a standup summary"* | Formatted summary of recent activity |
| *"How many tokens have we used?"* | Token usage, commits, lines changed |
| *"Stop"* / *"Cancel"* | Stops the loop |
| *"Retry ticket abc123"* | Re-attempts a failed ticket |

For power users, these also work as slash commands: `/pickle-status`, `/pickle-standup`, `/pickle-metrics`, `/eat-pickle`, `/pickle-retry <id>`.

In long-running mode, you can attach to a live dashboard:
- Top-left: ticket status, phase, elapsed time
- Top-right: iteration log
- Bottom: live worker output

---

## FAQ for Product Managers

**Q: Do I need to know how to code?**
No. You need to understand your product requirements well enough to make them specific and verifiable. The system handles implementation.

**Q: How specific should my PRD be?**
As specific as possible on the *what* and *why*. Leave the *how* to the system unless you have strong constraints (e.g., "must use the existing Redis instance, not a new one").

**Q: What if the system builds the wrong thing?**
It built exactly what your PRD specified. Refine the PRD, re-run. The PRD is the source of truth — there's no separate "feedback" mechanism.

**Q: Can I change requirements mid-implementation?**
Say *"stop"* to cancel the loop, update the PRD, then say *"refine and implement this PRD."* Don't edit tickets while the system is running.

**Q: How long does implementation take?**
Depends on complexity. A 3-ticket feature might take 30 minutes. A 15-ticket epic might take several hours. The system runs unattended — you don't need to watch it.

**Q: What if a ticket fails?**
Say *"retry ticket abc123"* to re-attempt it. If it keeps failing, the acceptance criteria or scope may need adjustment.

**Q: Do I need to memorize slash commands?**
No. Just describe what you want in plain language — *"create a PRD," "refine my PRD," "implement it," "what's the status?"* — and the system activates the right workflow automatically. Slash commands exist for power users but are never required.

**Q: What's the difference between the interview and just writing a markdown file?**
The interview pushes on verification, contracts, and scope — questions you might not think to answer on your own. If you're comfortable writing PRDs with machine-checkable criteria, writing your own is fine. If you're new to this, the interview helps.

**Q: Do I need to include time estimates?**
No. The system ignores them. Focus on scope, acceptance criteria, and priority.

---

## Advanced: Beyond Linear Execution

The standard Pickle Rick workflow — PRD → tickets → sequential execution — works well for most features. But some problems don't fit a linear ticket queue. This section covers two advanced modes for when you need something different.

### Microverse: Optimizing a Metric

Sometimes you don't want to build a feature — you want to **improve a number**. Response time. Test coverage. Bundle size. Error rate. The microverse is a convergence loop: it makes a change, measures the metric, keeps improvements, rolls back regressions, and repeats until the metric stops improving.

**When to use it:**
- Performance optimization ("reduce API p95 from 800ms to 100ms")
- Code quality improvement ("increase test coverage from 60% to 85%")
- Size reduction ("shrink the Docker image from 2GB to under 500MB")
- Any goal that can be expressed as a single number going up or down

**How to start it:**

Just describe what you want to optimize:

> "Optimize the loan status API response time. The metric command is `npm run bench -- loan-status --p95` and I want it lower."

Or with a natural-language goal instead of a numeric command:

> "Improve the test coverage of the auth module. Judge it by how thorough the tests are."

The system runs in a loop:
1. Analyze the current state and propose a targeted change
2. Implement the change
3. Measure the metric (or have an LLM judge score it)
4. If improved → keep the change, commit it
5. If regressed → roll back automatically
6. If stalled (no improvement for N iterations) → declare convergence
7. Repeat

**What you control:**
- **metric** or **goal** — what to optimize (a shell command that outputs a number, or a natural-language goal for LLM scoring)
- **direction** — higher or lower is better
- **stall-limit** — how many flat iterations before stopping (default: 5)
- **tolerance** — score delta within which changes count as "held" (default: 0)

**What makes it different from regular implementation:**
The microverse doesn't follow a ticket queue. It has *autonomy* to choose what to change each iteration. It might optimize an algorithm, then refactor a hot path, then add caching — whatever moves the metric. You define the destination, it finds the path.

**Example — reduce bundle size:**

> "Use the microverse to reduce the production bundle size. Metric: `npm run build && du -sb dist | cut -f1`. Direction: lower. Stop after 5 iterations with no improvement."

The system might tree-shake unused imports in iteration 1, replace a heavy library with a lighter one in iteration 2, split a large module in iteration 3 — each time measuring, keeping wins, rolling back losses.

### Szechuan Sauce: Grinding Out Code Quality

Sometimes the code works but it's *messy*. Tech debt, copy-pasted logic, missing error handling, dead code, inconsistent naming. Szechuan Sauce is a convergence loop that reviews code against 30+ coding principles (KISS, DRY, SOLID, dependency health, test quality, migration hygiene) and fixes violations one at a time until there are zero left.

**When to use it:**
- Post-feature polish before merging a PR
- Inherited codebase cleanup ("clean up the services directory")
- Pre-release hardening pass (security and data-loss violations are fixed first)
- Dependency health audit ("are there CVEs, unused packages, lockfile drift?")

**How to start it:**

> "Run szechuan sauce on the services directory"

> "Deslop src/api/ — focus on error handling"

> "Do a dry run on src/ to see what violations exist without fixing anything"

The system reads every file, scores against a priority matrix (P0 security/data-loss → P4 style), fixes the highest-priority violation each iteration, runs tests, commits, and re-scores. Regressions are auto-reverted. When the count hits zero, it stops.

**What you control:**
- **target** — file or directory to review
- **dry-run** — catalog violations without fixing (useful for scoping)
- **focus** — narrow the review to a specific concern ("error handling", "accessibility", "rounding logic")
- **domain** — load domain-specific principles (e.g., `financial` adds monetary precision, regulatory compliance rules)

### Anatomy Park: Deep Subsystem Bug Hunting

Anatomy Park goes deeper than code quality — it traces **data flows** through your subsystems looking for runtime bugs: data corruption, timezone issues, financial rounding errors, schema drift. It's the tool you reach for when something keeps breaking and you don't know why.

**When to use it:**
- Stabilizing a subsystem that keeps regressing
- Pre-release hardening across multiple subsystems
- Onboarding to an unfamiliar codebase with hidden invariants
- Finding bugs that static analysis and linters miss

**How to start it:**

> "Run anatomy park on src/"

> "Do a dry run of anatomy park to see what it finds"

The system auto-discovers subsystems, rotates through them, and applies a strict three-phase protocol per iteration: **review** (read-only data flow tracing), **fix** (targeted edit + regression test), and **verify** (self-review with revert on regression). When it finds files that keep breaking — structural invariants that aren't enforced by types or tests — it catalogs them as **trap doors** in `CLAUDE.md` files so future engineers know where the landmines are.

**What makes it different from Szechuan Sauce:**
Szechuan Sauce asks *"Is this code well-designed?"* — it catches DRY violations, dead code, missing error handling. Anatomy Park asks *"Is this code correct?"* — it traces data from input to output and finds where values go wrong. Use Szechuan Sauce for quality; use Anatomy Park for correctness.

### Pipeline Mode: Self-Correcting DAGs

For complex epics with parallel workstreams, conditional logic, and multiple quality gates, you can define the work as a **convergence graph** — a DAG (directed acyclic graph) where failures automatically route back for correction instead of stopping the pipeline.

This is fundamentally different from a ticket queue:
- **Ticket queue**: do task 1, then task 2, then task 3. If task 2 fails, everything stops.
- **Convergence graph**: do tasks 1-3 in parallel, verify each one, route failures back to retry, run security scanning and code review as separate gates, and only proceed to the next phase when all gates pass.

**When to use it:**
- Multi-phase epics with 10+ tickets across independent workstreams
- Work that benefits from parallel execution (multiple features that don't conflict)
- Projects requiring multiple quality gates (security, coverage, scope audit, code review)
- Situations where you want automated retry and self-correction, not manual intervention

**How it works:**

1. Start with a PRD (written or generated through the normal process)
2. Say *"Create a pipeline from my PRD"* — this generates a `.dot` file
3. The system asks about your project structure and automatically figures out paths
4. Say *"Run the pipeline"* — submits it to the attractor server for execution

**What the pipeline gives you that tickets don't:**

| Capability | Ticket Queue | Pipeline |
|:-----------|:-------------|:---------|
| Parallel execution | Sequential only | Fan-out with configurable parallelism |
| Failure handling | Stop and wait for human | Auto-retry, route back to implementation |
| Quality gates | Single test pass | Separate gates: tests, security, coverage, scope, drift |
| Code review | End of ticket | Per-phase review→simplify→re-verify cycles |
| Complex phases | Manual ordering | Conditional routing, diamond decision nodes |
| High-complexity tasks | Single attempt | Multi-pass: competing implementations, best selected |

**The 12 quality gates built into every pipeline:**

1. **Test-fix loops** — every implementation retries on test failure
2. **Goal gates** — critical steps must pass acceptance criteria or the whole graph retries
3. **Conditional routing** — diamond decision nodes route based on outcomes
4. **Parallel fan-out/in** — independent tasks run simultaneously
5. **Human gates** — optional approval points (hexagon nodes)
6. **Max visits** — bounded retries prevent infinite loops
7. **Review-simplify cycles** — per-phase: AI reviews code quality, simplifies, re-verifies
8. **Security scanning** — separate SAST/audit gate with distinct failure routing
9. **Coverage qualification** — verifies test coverage on new/changed code
10. **Scope creep detection** — audits changes against the original prompt
11. **Drift detection** — prevents oscillation in review-simplify cycles
12. **Multi-pass complexity** — competing implementations for hard problems

**Example — what a pipeline phase looks like:**

```
Phase 2 (Atomic State Manager):
  ┌─ Implement StateManager class
  │     ↓
  │  Verify (tsc + tests)  ──fail──→  Re-implement
  │     ↓ pass
  │  ┌─ Fan-out: Migrate writers ──┐
  │  └─ Fan-out: Harden locks ─────┘
  │     ↓ merge
  │  Verify (tsc + tests)  ──fail──→  Re-implement
  │     ↓ pass
  │  Security scan  ──fail──→  Fix security issues
  │     ↓ pass
  │  Scope check  ──fail──→  Revert out-of-scope changes
  │     ↓ pass
  │  Review (Opus)  →  Simplify (Sonnet)  →  Re-verify
  │     ↓ pass                                  │ fail → re-simplify (with drift detection)
  │  Next phase
```

Every arrow labeled "fail" is an automatic retry path. No human intervention needed — the system self-corrects until convergence or until retry limits are reached.

**What you need to run pipelines:**
- An [attractor](https://github.com/strongdm/attractor) server running (local Docker or remote)
- A PRD to convert into a `.dot` file
- That's it — the system handles validation, submission, and monitoring

**Starting simple:**

You don't need to understand DAG theory or DOT syntax. Just say:

> "Create a pipeline from my PRD and run it."

The system generates the convergence graph, validates it, and submits it. You can inspect the `.dot` file if you're curious, but you don't have to.

### Choosing the Right Mode

| Situation | Use |
|:----------|:----|
| Single feature, < 5 files | Standard: *"Build X"* |
| Feature with clear tickets, sequential work | Standard with refinement: *"Refine and implement"* |
| Optimize a measurable metric | Microverse: *"Optimize X, metric is Y"* |
| Clean up tech debt, polish before merge | Szechuan Sauce: *"Deslop src/services/"* |
| Find data flow bugs, stabilize flaky subsystems | Anatomy Park: *"Run anatomy park on src/"* |
| Multi-phase epic, parallel workstreams | Pipeline: *"Create a pipeline from my PRD"* |
| High-risk changes needing multiple quality gates | Pipeline (security, coverage, scope, drift gates) |
| Hard problems where multiple approaches might work | Pipeline with multi-pass (competing implementations) |

All three modes start the same way: describe what you want in plain language. The system helps you choose the right tool, or you can be explicit.

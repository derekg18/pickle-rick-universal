# PRD — Citadel (Conformance Audit) + Cross-Skill Hardening

> **Scope note**: This PRD is the new `/citadel` command (post-implementation conformance audit — the Citadel of Ricks judges your branch against the PRD it was built from) **plus** the matched updates to `/pickle-refine-prd`, anatomy-park, and szechuan-sauce that the LOA-618 post-mortem identified. One PRD, three sibling skills updated, one new skill added — the gaps don't cleanly partition by skill, so the fixes ship together.

> **Merge note (2026-04-29)**: This PRD absorbs `bmad-inspired-hardening.md` (deleted 2026-04-29). The conformance overlap (BMAD P0's AC-machine-checkability and contract-resolution checks) is integrated into the core audit as new task T17 (refinement-time hard gate that pairs with T20's enforcement and T11.7's safety net). The remaining BMAD capabilities — `/pickle-readiness` skill itself, `/pickle-archaeology`, phase-specialized Morty personas, `/pickle-correct-course`, `/pickle-debate`, codex-version smoke, schema v2→v3 migration, hang guards, behavioral test framework, CUJs, expanded risk register, and implementation task breakdown — are preserved verbatim in the **Appendix: Additional BMAD-inspired hardening (non-conformance)**. No genuine contradictions found between the two PRDs; both reference LOA-618 and v1.55.0 baseline coherently.

## Background

After running `/pickle-pipeline` end-to-end on a 22k-line feature (LOA-618 Updated Appraisal Comparison, 41 tickets) a manual 5-agent audit found 8 real issues the pipeline missed:

- 2 AC violations (audit action allowlisted but never emitted; feature flag not gating mutation endpoints per AC-FF-05).
- 5 trap-door-documented behaviors with zero regression tests.
- 1 cross-cutting bug (3 of 4 sibling proxy routes lost a structured error-body field on the same code path).

None of these are anatomy-park's job (data-flow regression) or szechuan-sauce's job (DRY/simplification). They are whole-feature conformance issues invisible to per-ticket review.

This PRD specifies a new Pickle Rick slash command that runs as a post-implementation phase between build (pickle / pickle-tmux) and quality (anatomy-park / szechuan-sauce). It validates an entire branch's diff against the PRD it was built from, plus surfaces unguarded trap doors and sibling-pattern divergence.

## Persona / Style

Pickle Rick voice. Cynical, terse, builds tools instead of complaining. Belch occasionally. Output should be scannable — tables, file:line citations, no prose padding.

## Skill Venn (overlap is intentional)

The three post-implementation skills share a Venn-diagram model. Each owns a primary domain; the overlaps are deliberate, not duplication:

```
            ┌────────────────────────┐
            │   anatomy-park         │
            │  (subsystem depth,     │
            │   data flow, trap-door │
            │   discovery)           │
            │                        │
            │       ┌──── pattern    │
            │       │     replay,    │
            │       │     trap-door  │
            │       │     coverage   │
            │       ▼                │
            │   ┌───────────────┐    │
            │   │ conformance-  │    │
            │   │ audit (PRD ↔  │    │
            │   │ implementation│    │
            │   │ invariants)   │    │
            │   └───────────────┘    │
            │       ▲                │
            │       │     dead       │
            │       │     code,      │
            │       │     hygiene,   │
            │       │     diff-shape │
            │       │                │
            │   szechuan-sauce       │
            │   (DRY, simplify,      │
            │   delete waste)        │
            └────────────────────────┘
```

**Primary domain of conformance-audit**: does the branch satisfy the PRD it was built from? AC coverage, endpoint contract, sibling guard parity, rule-set invariants. Whole-feature scope.

**Intentional overlaps**:
- *with anatomy-park*: trap-door enforcement (T6) and pattern-replay (T10.7). anatomy-park goes deep on a subsystem; citadel walks the whole branch and verifies anatomy-park's findings are enforced everywhere.
- *with szechuan-sauce*: dead allowlists (T4) and diff hygiene (T10.9). szechuan-sauce optimizes for fewer lines; citadel catches the conformance variant — "this entry exists but nothing references it" reads as a PRD-vs-impl gap, not just dead code.
- *with `/pickle-refine-prd`*: AC-shape smell (T11.7). Refinement should enforce invariant-shaped ACs at fan-out time; citadel is the safety net for ACs that slipped through.

A small amount of duplicated detection across skills is acceptable. The cost of missing a bug is much higher than the cost of two skills both reporting it.

## Reuse Reality Check

The first cut of this PRD claimed reuse from `pickle-refine-prd`, anatomy-park, and szechuan-sauce. After auditing the codebase that turned out to be fiction at the *TypeScript module* level:

- `pickle-refine-prd` is LLM-driven (`extension/src/bin/spawn-refinement-team.ts`); no markdown→entity parser exists.
- anatomy-park and szechuan-sauce are slash-command prompts (`.claude/commands/*.md`), not TypeScript modules. There is no extractable `Logger`, `Reporter`, trap-door parser, or diff-walker to import.
- `extension/src/skills/` does not exist. The repo layout is `extension/src/{bin,services,lib,types,hooks,scripts}/`.

The only existing primitive that maps to this PRD is `getDiffFiles(base, head, repoRoot)` in `extension/src/services/git-utils.ts:163`. Everything else is **build from scratch** for the citadel core (T1–T16).

**However**, the cross-skill tasks T20–T23 do edit real files: `.claude/commands/pickle-refine-prd.md`, `.claude/commands/anatomy-park.md`, `.claude/commands/szechuan-sauce.md` (prompt updates), plus `extension/src/bin/spawn-refinement-team.ts` (manifest schema) and a new shared `extension/src/services/citadel/diff-hygiene.ts`. Schema changes (anatomy-park.json `pattern_shape`, refinement_manifest.json `ac_shape_smells` + `justification`, szechuan output `category: 'hygiene'`) are real interface contracts and must ship together for T10.7 / T10.9 / T11.7's safety-net dedupe to work.

## Command Surface

`/citadel` — new top-level slash command.

Inputs:
- `--prd <path>` (required) — path to PRD markdown file.
- `--diff <range>` (optional, default `main..HEAD`) — git diff range to audit.
- `--strict` (optional) — exit non-zero on any High finding (default: only on Critical).
- `--report <path>` (optional) — write JSON report to path; otherwise stdout.
- `--no-block` (optional) — never block the pipeline regardless of severity.
- `--print-stubs` (optional) — emit `node:test` skeletons inline for unguarded trap doors.

When invoked from `/pickle-pipeline`, all inputs come from session state. See **Pipeline Integration** below for the schema fields this requires; T0 wires them.

Outputs:
1. **Console** — ranked findings list (Critical → High → Medium → Low), each with severity tag, AC / trap-door ID, file:line citation, one-sentence description.
2. **JSON report** — written to `--report <path>` (or `<session>/citadel_report.json` when invoked from pipeline). Schema versioned with `schema: "1.0"`.
3. **End-of-run summary line:**
   ```
   Conformance audit: <total> findings (CRITICAL=N, HIGH=N, MEDIUM=N, LOW=N)
                      <decisions> decisions required
                      <unguarded> unguarded trap doors
                      exit <code>
   ```

Exit code:
- `0` if no Critical (or no High when `--strict`).
- `1` otherwise.

## Repo Conventions (Non-Negotiable)

This PRD must conform to the existing extension conventions:

- **Source path**: New code lives at `extension/src/services/citadel/` (TypeScript). NOT `extension/src/skills/...` — that path doesn't exist and introducing it is out of scope.
- **CLI entry point**: If a binary is needed, it goes in `extension/src/bin/` and follows the CLAUDE.md guard pattern: `if (process.argv[1] && path.basename(process.argv[1]) === 'foo.js') { ... }`.
- **Tests**: `extension/tests/citadel-*.test.js` via `node --test`. NOT Vitest. NOT `.test.ts`. Run with `npm test` from `extension/`.
- **Build gate**: `npx tsc --noEmit && npx tsc && npm test` from `extension/`.
- **AST parsing**: Prefer `node --test` + regex/grep over heavy AST deps. If AST is required for T7/T9/T10, declare `ts-morph` explicitly in `extension/package.json` devDependencies before T7 starts; otherwise use the TypeScript compiler API which is already a transitive dep.
- **Fixture path**: `prds/fixtures/citadel/` (top-level, alongside the PRD). NOT under `extension/` — CLAUDE.md forbids `.md` artifacts there.

## Tasks

### T0 — Session-state schema migration

Pre-requisite for T13. The current `State` interface in `extension/src/types/index.ts:1-43` does not have `prd_path` or `start_commit`. (It does have `prd_path` on `MicroverseSessionState`, but not on the main pipeline state.)

Steps:
- Add optional `prd_path?: string` and `start_commit?: string` to the main `State` interface.
- Update `setup.js` (canonical: `extension/src/bin/setup.ts`) to populate both fields when `pipeline.json` is written.
- Bump state schema version + add migration in `state-manager.ts`.

Exit: state.json on a fresh pipeline session contains both fields; tests in `extension/tests/state-schema-*.test.js` cover the migration.

### T1 — PRD ID parser

Build a parser at `extension/src/services/citadel/prd-parser.ts` that walks a PRD markdown file and extracts:
- Architectural decisions (`A1` … `A99`, including dotted forms like `A11.`).
- Acceptance criteria IDs matching `AC-[A-Z0-9]+(-[A-Z0-9]+)*(-\d+)?`.
- API endpoints from tables shaped `| <METHOD> /path |`.
- Audit / enum allowlist additions (`VALID_ACTIONS`, lender_feature_flags keys, enum value tables).
- Per-endpoint status-code tables and documented error-message strings.

Multi-paragraph PRD sections may bury an AC in prose; do not require a table. Test on the LOA-618 PRD fixture committed under `prds/fixtures/citadel/loa-618-prd.md`.

This parser does **not** exist anywhere — `pickle-refine-prd` is LLM-driven and produces prose, not typed entities. Build from scratch.

Exit: parser exposes typed entities (`Decision`, `AcceptanceCriterion`, `Endpoint`, `AllowlistEntry`, `StatusCodeRow`).

### T2 — Diff walker

Build a helper at `extension/src/services/citadel/diff-walker.ts` that takes a git diff range and returns:
- Set of changed files (production + tests, classified).
- Set of CLAUDE.md files in or under any changed-file's directory.
- Per-file blame summary for changed lines (so findings can name an authoring commit).

Wrap `getDiffFiles` from `extension/src/services/git-utils.ts:163` for the file-set; add the CLAUDE.md walk and blame summary on top.

Exit: helper exposes `walkDiff(range): DiffSummary` with deterministic ordering.

### T3 — AC coverage scorecard

For each ID from T1:
- Grep production-code files in T2's changed set for at least one match (ID in a comment OR an implementing symbol whose name contains a keyword anchor extracted from the AC's title).
- Grep test files in T2's changed set for at least one test that names the ID or implementing symbol.

Produce a markdown table:
```
| ID         | Implemented | Tested | File:line evidence       |
|------------|:-----------:|:------:|--------------------------|
| AC-FF-01   | ✓           | ✓      | service.ts:2619 + spec   |
| AC-FF-05   | ✗           | ✗      | (no enforcement found)   |
```

**Known limitation**: This is a keyword-anchor heuristic, not semantic name-matching. Recall ceiling is bounded by AC-comment discipline + keyword overlap. Expect ~60-70% recall on real branches without LLM assistance. T11.5 (optional) adds an LLM-assisted entity-extraction pass to lift that ceiling.

Severity:
- `✗ Implemented` → Critical.
- `✓ Implemented, ✗ Tested` → High.

Exit: scorecard generator produces the table + structured findings; tests assert keyword-anchor matching against the LOA-618 fixture.

### T4 — Allowlist dead-entry detector

For every `VALID_ACTIONS` entry, lender_feature_flags key, or enum value added in the diff range:
- Grep production code (excluding `*.spec.ts` / `*.test.tsx` / `*.test.js`) for at least one caller.
- Allowlist entry with zero production callers → High finding ("dead allowlist; deploy-ordering smell").

Catches the `appraisal.updated_run_failed` class.

Exit: detector returns a list of dead allowlist entries with file:line of the allowlist declaration.

### T5 — Endpoint contract conformance

For every endpoint in T1's endpoint list:
- Locate the controller method (NestJS `@Controller`/`@Get`/`@Post` decorator parse).
- Confirm the implementation throws or returns each documented status code at least once. Use grep for `throw new (Forbidden|BadRequest|NotFound|Conflict)Exception` patterns; escalate to `ts-morph` only if grep recall drops below 80% on the fixture.
- Confirm documented error-message strings appear verbatim somewhere in the implementation.

Severity:
- Missing 4xx → Medium.
- Missing 403 / auth path → High.

Exit: endpoint conformance report listing all missing-code rows.

### T6 — Trap door coverage gate (presence + enforcement)

Build the trap-door parser at `extension/src/services/citadel/trap-door-parser.ts`. anatomy-park does **not** have an extractable parser to share — it is a slash-command prompt; build from scratch.

For every trap-door bullet in CLAUDE.md files identified in T2:
- Resolve the symbol the bullet cites (e.g. `service::reExtract`, `processor` step number, file path) via regex anchors over named entities: file paths, rule codes (`DIFF_005`), schema fields (`subject.property_address`), numeric thresholds (`50MB`, `10MB`).
- Find that symbol's spec file (e.g. `service.spec.ts`).
- **Presence check**: Grep the spec for at least one `it()` / `describe()` whose body references the trap door's specific failure mode using the named-entity anchors.
- **Enforcement check** (added to close the LOA-618 S3-key gap): For trap doors that document a structural INVARIANT (regex shape, segment count, allowlist membership, range bound, ordering), assert the spec contains a negative test — i.e. an assertion that violating inputs are rejected. Trap doors written as "X must match shape Y" without a corresponding "rejects when not Y" test → High finding even if a positive-path test exists.
- Bullet with zero matching tests → High finding.
- Bullet with positive-only tests against an invariant trap door → High finding ("trap door documented but not enforced").

**Known limitation**: Free-text bullet parsing without an LLM gives keyword-level coverage only. Tests that parameterize thresholds (e.g. computed dates instead of literal `2026-03-02`) will silently miss. Document the limitation in the report header so reviewers understand the recall floor.

Output an unguarded list as a markdown checklist:
```
- [ ] `service::reExtract` — date-roundtrip guard (no test for 2026-02-30 case)
- [ ] `compute-differences` — condo legacy "false" string normalize
```

When `--print-stubs` is set, emit `node:test` skeletons inline so a human can flesh them out.

Exit: unguarded checklist + structured findings.

### T7 — Sibling proxy-route divergence audit

Group `*/route.ts` files in T2's changed set into sibling cohorts. **Sibling definition**: same immediate-parent directory pattern AND same HTTP method handler exports. (Just-parent-pattern grouping false-positives in Next.js app-router where `app/api/foo/[id]/route.ts` and `app/api/bar/[id]/route.ts` are unrelated.)

For each cohort of ≥2 routes:
- Parse the catch-block AST of each route.
- Diff the error-handling shape across siblings.
- Divergence (e.g. one route returns `err.body ?? { error: err.message }`, others return only `{ error: err.message }`) → High finding.

Catches the LOA-618 proxy `err.body` bug.

Exit: divergence pairs reported with file:line of the inconsistent siblings.

### T8 — State-machine transition audit

Parse the PRD for tables shaped "Transition | Audit | …". For each transition row:
- Confirm a corresponding audit emit exists in production code (string match the audit action, then walk to the call site).

Missing audit emit → High finding.

Exit: transition coverage report; each missing emit cites the PRD row + the expected call site.

### T9 — Sibling auth/precondition audit + destructive-role lint

Two passes on the same controller cohort:

**Pass A — guard-prefix parity.** For all controller methods on the same resource path prefix (e.g. `/foo/:id/X`, `/foo/:id/Y`, `/foo/:id/Z`):
- Compare the prefix of guards each method runs (`@Roles`, `@UseGuards`, flag check, ownership lookup, status validation), accounting for class-level vs method-level decorator inheritance.
- Divergence (e.g. method A flag-checks but B does not) → Medium finding.

Catches the cross-method flag inconsistency variant of AC-FF-05.

**Pass B — destructive-role lint** (added to close the LOA-618 `client_user could DELETE` gap). For every controller in T2's changed set:
- Identify destructive routes by handler shape: `@Delete(...)` decorators, route names matching `revert-*` / `override-*` / `cancel-*` / `purge-*`, or method names matching `/(delete|revert|override|cancel|purge|destroy)/i`.
- Collect the `@Roles(...)` allowlist for each.
- If destructive routes in the same controller have non-equal role allowlists → High finding ("destructive-role drift").
- If a destructive route has no `@Roles` decorator at all → Critical finding.

Exit: divergence report with method names + missing guard list + destructive-role drift table.

### T10 — Frontend prop drift audit

For every component invocation in `.tsx` files in T2's changed set:
- Parse the JSX attributes passed.
- Parse the receiver component's declared props.
- Passed-but-not-declared (and not spread) → High finding.

**Known blind spot**: Spread props (`<Foo {...rest} />`) defeat this heuristic, and spread is ubiquitous in modern React. Report header must call out that any sibling using spread is not analyzed. Future enhancement: trace spread-source types if `ts-morph` is in play.

Catches the `comparisonData` dead-prop case.

Exit: prop-drift report.

### T10.5 — Resource-module guard parity (cross-route)

This is broader than T9's path-prefix grouping. **LOA-618 lesson**: AC-FF-05 was decomposed into four endpoint tickets and `getComparison` was simply not on the list. T9 catches drift between path-prefix siblings; this catches drift across **all routes touching the same resource module**, even when paths don't share a prefix.

Steps:
- Identify the "resource module" for each changed controller method by walking imports: a method belongs to module M if its handler reads/writes a service exported from `M/*.service.ts` or a Drizzle schema from `M/*.schema.ts`.
- For each module, enumerate every controller route (read + write paths) that touches it.
- For each guard observed on **any** route in the module (`@UseGuards(FlagGuard)`, `isXEnabled` calls, `@Roles`, ownership lookups), check it is also applied to **every other** route in the module — unless the route is explicitly tagged `@Public()` or annotated `// CONFORMANCE-EXEMPT: <reason>`.
- Missing guard on a sibling read endpoint → High finding. Missing guard on a sibling write endpoint → Critical finding.

Catches the LOA-618 `getComparison` flag-gate miss directly.

Exit: per-module guard-coverage matrix; rows are routes, columns are guards, missing cells are findings.

### T10.7 — Pattern-replay enforcement (overlap with anatomy-park)

**Primary owner**: anatomy-park (deep pattern discovery + per-subsystem replay; see CSF-2 for the deep version).
**This task's slice**: branch-wide regex/AST replay of anatomy-park findings the audit can read from session state. Light overlap, intentional — anatomy-park looks deep at one subsystem, citadel walks the whole branch.

**LOA-618 lesson**: anatomy-park found the `BullMQ enqueue inside try/catch with rollback update().set({status})` CRITICAL pattern in `createUpdatedRun`, added a CLAUDE.md trap door, but the same pattern in `retryChildExtraction` shipped without the CAS guard.

Steps:
- Read `<session>/anatomy-park.json` for findings tagged `severity: CRITICAL` AND `category: pattern`. (Soft-skip with a Low informational finding when the file is absent — audit may run standalone.)
- For each such finding, extract the structural shape (anatomy-park records its detection regex/anchor in the finding payload).
- Re-grep the entire diff for matches of that shape.
- For every match, assert the documented mitigation is present (e.g. CAS guard, retry-idempotency). Missing mitigation → Critical finding ("pattern-replay miss"), citing the original anatomy-park finding ID.

When anatomy-park ships its own CSF-2 phase-2 sweep, this task becomes the redundant safety net at branch scope — kept on purpose. Two skills catching the same bug is cheaper than missing it.

Exit: pattern-replay sweep report; each finding cites the original anatomy-park finding ID + the un-guarded site.

### T10.8 — Rule-set / state-machine invariant checker

**LOA-618 lesson**: `DIFF_001`, `DIFF_002`, `DIFF_003` were tested in isolation; nothing asserted "exactly one fires per single-field change." The bug encoded itself into the multi-rule test's expected output.

Steps:
- Detect rule-set or enum-set declarations in the diff: `const RULES = [...]`, exported `enum DifferenceCode { ... }`, `VALID_ACTIONS` arrays, status-machine const objects with ≥3 members.
- Look for an accompanying invariant assertion in spec files: a test that names ≥2 members of the set together AND asserts a relationship — `expect(fired.length).toBe(1)`, `expect(fired).toEqual([...])`, `for.each` over the set with mutual-exclusion check, etc.
- A rule-set declaration of size ≥3 with no invariant assertion → Medium finding ("rule-set lacks interaction test").
- Optionally, when the PRD contains an explicit invariant clause (lines matching `exactly one of {…}`, `at most one of {…}`, `mutually exclusive`, `partition of`), promote to High.

Exit: rule-set inventory + invariant-coverage table.

### T10.9 — Diff-shape / orphan-file gate (overlap with szechuan-sauce)

**Primary owner**: szechuan-sauce or a future `/pickle-prepr-lint` (see CSF-3).
**This task's slice**: orphan files are also a *conformance* problem — they're committed but not part of the documented change. Light overlap, kept intentionally.

**LOA-618 lesson**: `continuation_plan.md` got accidentally tracked at the repo root. Cheap to catch.

Steps:
- For every file added by the diff (`status: 'A'`), apply rules:
  - Top-level `*.md` not in `{CLAUDE.md, README.md, AGENTS.md, LICENSE.md, CHANGELOG.md}` → Medium finding.
  - Top-level `*.txt`, `*.log`, `*.tmp`, `scratch*`, `notes*`, `WIP*`, `tmp*` → Medium finding.
  - Files matching `.env*` (except `.env.example`) → Critical finding.
  - Files >1 MB not gitignored → High finding (binary leak).
- Suppress findings already flagged by szechuan-sauce on the same diff (read `<session>/szechuan-sauce.json` if present) so the two skills don't double-count in the user-facing report.

Exit: hygiene findings list, deduped against szechuan-sauce output when available.

### T11 — Divergence reconciliation reporter

Some PRD violations are not bugs — they are product / UX deviations the team shipped on purpose. Detect by scanning for:
- ✓ Implemented but ✗ Tests-locked-against-PRD (tests assert something contradicting the PRD; team chose differently).
- Trap doors that contradict the PRD (LOA-618 case where the trap door said "stay live across rollback" while AC-FF-05 said "403 when off").

Report these as `DECISION REQUIRED`, not findings. Suggest which document to amend. Do not auto-fix.

Exit: decision-required list, separate from findings.

### T11.7 — AC-shape smell (overlap with `/pickle-refine-prd`)

**Primary owner**: `/pickle-refine-prd` (see CSF-1) — must enforce at fan-out time.
**This task's slice**: safety-net detector for ACs that slipped through refinement, plus echo on dog-food / fixture runs. Light overlap, intentional.

**LOA-618 lesson**: AC-FF-05 was authored as four bullet points (one per endpoint), refinement decomposed it into four parallel tickets, the missing fifth endpoint (`getComparison`) was never on the list. The load-bearing fix has to be at refinement time, but citadel catches whatever still slips through.

Steps:
- For each AC extracted by T1, count bullet/sub-bullet structure under it.
- Flag as `DECISION REQUIRED` (Medium severity, contributes to exit code under `--strict`) when: ≥3 bullets each name a distinct endpoint / handler / method, AND all bullets repeat the same predicate, AND the AC headline has no universal quantifier.
- Cross-check against the refined ticket manifest (when `<session>/prd_refined.md` exists): if the smelly AC produced ≥3 separate tickets and none of them carry a `// JUSTIFICATION:` block, escalate to High.
- Suggest the rewrite: "Rewrite as 'every <resource> endpoint <predicate>' with a parametrized test."

Exit: AC-shape findings in both `DECISION REQUIRED` and (when the refinement manifest is available) in the High-severity findings stream.

### T11.5 — (Optional) LLM-assisted entity extraction

T3 and T6 have known recall ceilings because grep can't do semantic name matching or free-text entity extraction. Optional sub-task: when `--llm-assist` is set, run a single Claude pass over the PRD to extract `(AC ID → expected symbols / call sites)` and `(trap-door bullet → expected test anchors)` mappings. Feed the mappings back into T3/T6 grep. Token cost should be bounded (<10k input tokens per audit).

Exit: when `--llm-assist` is enabled, T3/T6 recall on the LOA-618 fixture lifts above the keyword-only baseline by a measurable delta (target: ≥10 percentage points).

### T12 — Findings ranker + JSON reporter

Aggregate all findings from T3–T11. Rank by severity (Critical → High → Medium → Low). Emit:
- Console output (ranked markdown).
- JSON report (typed schema versioned with `schema: "1.0"`).
- End-of-run summary line.
- Correct exit code.

Build a small `Reporter` class — no shareable Logger/Reporter exists in szechuan-sauce; it's a prompt skill.

Exit: single entry-point function `runCitadelAudit(opts): Promise<{ exitCode, findings, decisions, json }>`.

### T13 — pipeline-runner integration

Update `extension/src/bin/pipeline-runner.ts` so `/pickle-pipeline` runs:
```
pickle → citadel → anatomy-park → szechuan-sauce
```

(Note: `meeseeks` is **not** in the active chain — `pipeline-runner.ts` explicitly sets `chain_meeseeks = false` and the deprecation comments at lines 268, 329, 844-845 confirm the loop is retired. Earlier draft of this PRD wrongly listed meeseeks; it has been removed.)

Steps:
- Extend the `PipelinePhase` type union (currently `'pickle' | 'anatomy-park' | 'szechuan-sauce'` at `pipeline-runner.ts:50`) to include `'citadel'`.
- Add a phase branch alongside the existing `else if` blocks (lines 843, 857, 906) that reads `state.prd_path` + `state.start_commit` (populated by T0), invokes `runCitadelAudit`, and writes `<session>/citadel_report.json`.
- Replace the binary "halt on any non-zero exit" semantics (`pipeline-runner.ts:952-954`) with severity-gated halt: read the JSON report, halt only when `findings[].severity === 'Critical'` (or `>= High` under `--strict`); otherwise continue to anatomy-park.
- Specify the read protocol: anatomy-park and szechuan-sauce phases gain an explicit `readCitadelReport(sessionDir)` helper. anatomy-park uses the unguarded-trap-door list to prioritize its catalog phase; szechuan-sauce treats the divergence list as known/intentional. **Wire those readers explicitly — do not assume implicit handoff.**

Exit: pipeline-runner integration tested against the LOA-618 fixture branch.

### T13.5 — `/cronenberg` integration

`/cronenberg` is the meta-router that picks a metaphor + followup chain from request signals (`.claude/commands/cronenberg.md`). It currently routes to `/pickle`, `/pickle-tmux`, `/pickle-pipeline`, `/pickle-microverse`, `/council-of-ricks`, plus followups `/anatomy-park` and `/szechuan-sauce`. It does **not** know about `/citadel`.

Wire citadel into cronenberg as a followup, gated on signals where a whole-feature audit pays off:

Steps:
- Add a new signal `CITADEL_RISK` to Step 2: true when any of (`PRD_PRESENT` AND `TICKET_COUNT ≥ 3`) OR (TASK mentions "conformance / acceptance criteria / spec compliance / audit against PRD") OR (`SUBSYSTEM_TOUCHES ≥ 2` AND `PRD_PRESENT`).
- Add a Step 4 followup row: when `CITADEL_RISK` is true → append `/citadel --prd <prd_path>` **before** `/anatomy-park` in the followup chain. Rationale: anatomy-park can prioritize unguarded trap doors surfaced by the audit (matches the pipeline-runner ordering from T13).
- Update the skip-followups rule: `/pickle-pipeline` already chains citadel internally (per T13), so cronenberg must not double-append it when `/pickle-pipeline` is the chosen metaphor. Extend the existing skip clause for `/pickle-pipeline`.
- Update Step 5's printed plan template so the signals line includes `conformance=<y/n>`.
- For tmux-launching metaphors (which can't auto-chain — see Step 6), the printed copy-paste followup list must include the citadel invocation in the right slot.

Exit: `/cronenberg --dry-run` on a multi-ticket PRD task prints a plan that includes `/citadel` before `/anatomy-park`; `/cronenberg --dry-run` on a single-file fix does not include it; `/cronenberg` (default execute) on a `/pickle`-routed task chains citadel at the correct position.

### T14 — Slash command + help

Author `.claude/commands/citadel.md` (the command prompt the harness invokes). Update `/help-pickle` to mention the new phase. Update `.claude/commands/cronenberg.md` per T13.5. Update `README.md` and any PRD guide docs to document the task surface area, the JSON report schema, and the cronenberg routing entry.

Exit: command discoverable via `/help-pickle`; running `/citadel --help` prints usage; `/cronenberg` lists citadel in its followup table.

### T15 — Self-test fixtures

Bundle three fixture branches under `prds/fixtures/citadel/`:

1. **LOA-618 regression positive** (commit `d51dda2b` of `gregory/loa-618-updated-appraisal-comparison-epic` in the loanlight-api repo) — captured as a PRD + diff blob. Each of the 8 manual-audit issues is tagged with a stable ID (`LOA-618-ISSUE-001` through `LOA-618-ISSUE-008`) in `prds/fixtures/citadel/loa-618-issues.json`. The audit MUST surface ≥6 of those 8 IDs at severity ≥ High, matched by ID.
2. **Noise floor negative** — a clean already-merged epic from the same repo. Audit MUST produce <5 Low findings and zero Critical/High.
3. **Random-sample cohort** (≥5 additional closed epics, hand-picked but not cherry-picked-for-coverage) — captured as PRD + diff blobs. Used to measure aggregate recall and false-positive rate. No hard threshold; measurement only, results recorded in `prds/fixtures/citadel/recall-baseline.json`. This guards against overfitting to LOA-618.

Tests don't depend on live repo access — fixtures are committed.

Exit: `npm test` covers all three fixture cohorts with deterministic assertions.

### T16 — Pipeline regression smoke test

When the build finishes, run `/citadel` against the **LOA-618 fixture diff** (NOT this PRD's own diff — this PRD has zero `AC-*` IDs, zero endpoints, zero `VALID_ACTIONS`, so a self-audit trivially passes and measures nothing).

Smoke test passes when: LOA-618 fixture audit surfaces ≥6 of 8 tagged issues at severity ≥ High, exits non-zero under `--strict`, and the noise-floor fixture stays clean.

Exit: pipeline regression smoke test passes deterministically.

### T17 — Refinement-time AC-verifiability + contract-resolution hard gate (folded from BMAD P0)

**Source**: `bmad-inspired-hardening.md` P0 `/pickle-readiness`. The pre-implementation alignment gate's two conformance-shaped checks — "every AC is machine-checkable" (P0.2) and "every contract referenced exists" (P0.2 via `scope-resolver.computeOneHop`) — are folded into citadel's conformance umbrella here. The wider `/pickle-readiness` skill itself (with PRD↔ticket map, recycle cycles, history flags, multi-repo, codex-version smoke, delta-mode post-correction) is preserved as Appendix Section 1; this task is the conformance subset that lives in citadel's authority.

**Why citadel and not just BMAD's P0**: T20 (refinement-time AC-shape collapse-or-justify) already enforces *shape*. T11.7 (audit-time safety net) already catches what slips through. T17 adds the missing *machinability* check between them — a refined ticket whose AC says "the system should be intuitive" passes T20's shape filter and T11.7's enumeration filter but fails machinability. That's the conformance gap.

Steps:
- After `/pickle-refine-prd --run` mints the ticket tree but BEFORE `setup.ts` writes `state.json`, run a verifier over each `${SESSION_ROOT}/<hash>/linear_ticket_<hash>.md`:
  - **AC machinability**: each AC must be (a) a measurable threshold (numeric, exact-string match, regex), (b) an observable artifact (file exists, JSON field present), (c) an enumerable input/output table, or (d) a test name. Pure-prose ACs ("must be performant", "should feel intuitive") → fail.
  - **Contract resolution**: every symbol/path/file the ticket references resolves via `scope-resolver.computeOneHop({findImportersTimeoutMs: 30_000})`. Unresolved → fail.
- Failure routes back to refinement with the failing AC list and a suggested analyst (`gaps` for missing-machinability, `codebase` for missing-contract).
- Hard cap: `state.json.readiness.cycle_history.length ≤ 3`. After 3 cycles the gate halts with `readiness_escalation_<date>.md` (preserves BMAD R33 mitigation).
- After `course_corrected` events bump `tickets_version`, re-run T17 in DELTA mode on added/modified tickets only (preserves BMAD R30 / P0.12).

This task **cooperates** with T20: T20 enforces shape and `// JUSTIFICATION:` blocks at the analyst level; T17 enforces machinability and contract resolution at the manifest level. Both must pass for refinement to hand off to setup.

**Files**:
- `extension/src/bin/check-readiness.ts` (NEW — shared with Appendix Section 1; this task uses only the AC-machinability + contract-resolution checks).
- `extension/src/services/artifact-validation.ts` (reuse `findMissingPrefixes` per BMAD P0.8).
- `extension/src/bin/spawn-refinement-team.ts` (T17 hook: invoke `check-readiness --machinability-only --contract-only` after manifest aggregation; halt with `exit 2` on fail).
- `tests/check-readiness-machinability.test.js` (NEW — fixtures with prose-only ACs, missing-symbol references).

Exit: refinement on a fixture PRD with a prose-only AC halts with `exit 2` and a suggested-analyst hint; refinement on a fixture PRD with an unresolvable contract reference halts with `exit 2`; both surfaced in `readiness_<date>.md`. Cycle 4 halts with escalation file.

## Post-Mortem Gap Coverage (LOA-618)

The LOA-618 pipeline run produced 7 issues that reached code review. Each maps to a primary owner with an intentional safety-net overlap from one of the other two skills:

| Issue | Primary owner | Safety net |
|---|---|---|
| `getComparison` skipped feature flag | **T20** (`/pickle-refine-prd` AC-shape enforcement) + **T10.5** (resource-module guard parity) | **T11.7** (AC-shape echo at audit time) |
| `retryChildExtraction` rollback raced with worker | **T21** (anatomy-park phase-2 pattern-replay sweep) | **T10.7** (branch-scope replay against anatomy-park output) |
| `DIFF_001` co-firing with `DIFF_002`/`DIFF_003` | **T10.8** (rule-set invariant) | none needed |
| `client_user` could DELETE (role drift) | **T9 Pass B** (destructive-role lint) | none needed |
| S3 key UUID structural validation missing | **T23** (szechuan trap-door-as-test sweep) + **T6** (AC-cited subset) | T21 sets `pattern_shape` so future replays catch new violations |
| `differenceSummary` Drizzle cast | **OUT OF SCOPE** | ergonomic, not correctness |
| `continuation_plan.md` orphan file | **T22** (szechuan-sauce diff-hygiene gate) | **T10.9** (deduped against szechuan output) |

**Two structural takeaways:**

1. *PRD ACs need machine-checkable invariants, not endpoint enumerations.* T20 enforces at refinement time (load-bearing fix); T11.7 is the audit-time safety net; T10.5 catches the runtime consequence.
2. *Trap doors are knowledge, not enforcement.* T21 makes anatomy-park record `pattern_shape` and replay it within its own run; T23 makes szechuan-sauce assert every new trap door has a corresponding negative test; T6 covers the AC-cited subset; T10.7 is the branch-scope safety net.

## Cross-Skill Tasks (this PRD updates three sibling skills)

The LOA-618 post-mortem's load-bearing fixes don't all live in citadel. T20–T23 update the three sibling skills so the Venn-overlap model in the diagram above actually has primary owners doing primary work:

### T20 — `/pickle-refine-prd`: AC-shape collapse-or-justify

**Files**: `.claude/commands/pickle-refine-prd.md` (worker prompt) + `extension/src/bin/spawn-refinement-team.ts` (orchestration).

The refinement skill already runs 3 parallel analyst workers per cycle. Add an AC-shape smell pass to each worker's prompt and a manifest-level enforcement step in `spawn-refinement-team.ts`:

1. **Worker prompt update** (`pickle-refine-prd.md`): instruct the worker to flag every AC where (a) the headline lacks a universal quantifier ("all", "every", "for any"), AND (b) the body has ≥3 bullets each naming a distinct endpoint/handler/method, AND (c) all bullets repeat the same predicate. Worker emits these in a new `ac_shape_smells` section of its analysis output.
2. **Manifest enforcement** (`spawn-refinement-team.ts`): when the manifest aggregator merges worker outputs into `refinement_manifest.json`, every AC tagged as a smell must produce **exactly one** of:
   - A single parametrized ticket whose title contains a universal quantifier and whose acceptance test is `describe.each([...])` over the enumerated cases, OR
   - A multi-ticket decomposition where each ticket carries an explicit `// JUSTIFICATION:` block in the manifest entry.
3. **Halt condition**: if any smelly AC produced ≥2 tickets without justification, refinement halts with `exit 2` and surfaces the AC list. The `pickle-refine-prd` skill prompt is updated to instruct the user how to either rewrite the AC or add justifications.
4. **Manifest schema bump**: `refinement_manifest.json` gains `ac_shape_smells: AcShapeSmell[]` and per-ticket `justification?: string`.

This is the load-bearing fix for the `getComparison` class of misses. T11.7 in citadel is the safety net.

Exit: refinement on a fixture PRD containing an enumerated AC produces a parametrized ticket OR halts demanding justification; manifest schema test asserts `ac_shape_smells` field.

### T21 — anatomy-park: phase-2 pattern-replay sweep

**Files**: `.claude/commands/anatomy-park.md` (skill prompt — anatomy-park is prompt-driven, no TS module to edit).

anatomy-park's three phases (data-flow trace → fix without regression → catalog trap doors) are extended with a **phase-2.5 pattern-replay sweep** between fix and catalog:

1. **Prompt update** (`anatomy-park.md`): add a phase-2.5 section instructing the agent that, for every finding produced in phase 2 with `severity: CRITICAL` AND `category: pattern`, it must:
   - Articulate the structural shape of the pattern in unambiguous terms (file shape, AST shape, or grep regex).
   - Re-grep / re-walk the full diff scope for matches of that shape.
   - For every additional match, verify the documented mitigation is present.
   - Emit any un-guarded match as a new CRITICAL finding in `anatomy-park.json`, tagged `phase: replay` and citing the original finding ID.
2. **Output schema bump**: `anatomy-park.json` findings gain `phase?: 'discovery' | 'replay'` and `original_finding_id?: string`. Trap-door entries gain a `pattern_shape` field (regex or AST description) consumed by both anatomy-park's own replay and citadel's T10.7 safety-net.
3. **Catalog phase update**: every trap door added in phase 3 must include the `pattern_shape` so future runs can replay against it deterministically.

Catches the `retryChildExtraction` class. T10.7 in citadel becomes the branch-scope safety net that runs even when anatomy-park is skipped.

Exit: on the LOA-618 fixture, anatomy-park surfaces both `createUpdatedRun` (discovery) and `retryChildExtraction` (replay) as CRITICAL findings; the trap-door entry in CLAUDE.md carries a `pattern_shape` regex.

### T22 — szechuan-sauce: diff-hygiene gate

**Files**: `.claude/commands/szechuan-sauce.md` (skill prompt) + optional helper at `extension/src/services/citadel/diff-hygiene.ts` (shared with T10.9).

Add a hygiene pass to szechuan-sauce's existing principle-driven sweep:

1. **Prompt update** (`szechuan-sauce.md`): add a "diff hygiene" principle section. For every file with `status: 'A'` in the diff:
   - Top-level `*.md` not in `{CLAUDE.md, README.md, AGENTS.md, LICENSE.md, CHANGELOG.md}` → emit P1 finding ("orphan planning doc — move to `docs/` or `prds/` or delete").
   - New `.env*` (except `.env.example`) → P0 ("secret leak risk").
   - New top-level `*.txt`, `*.log`, `*.tmp`, `scratch*`, `notes*`, `WIP*`, `tmp*` → P1.
   - New >1 MB files not gitignored → P2 ("binary leak").
2. **Shared helper** (`diff-hygiene.ts`): the rules live in a small typed module so both szechuan-sauce (via the prompt's reference) and citadel's T10.9 use the same allowlist constants. Single source of truth.
3. **Output bump**: szechuan-sauce's findings JSON gains `category: 'hygiene'` for these entries so T10.9 can dedupe against them.

Catches the `continuation_plan.md` class. T10.9 in citadel dedupes against szechuan output when run together.

Exit: szechuan-sauce on a diff that adds a top-level `notes.md` produces a P1 hygiene finding; the shared `diff-hygiene.ts` helper has unit tests asserting the allowlist constants.

### T23 — szechuan-sauce: trap-door-as-test enforcement sweep

**Files**: `.claude/commands/szechuan-sauce.md`.

The post-mortem's second structural takeaway: *"for each CLAUDE.md trap door added in this branch, is there a spec that fails if the trap door is violated?"* This is broader than T6's per-AC enforcement — it operates on every trap door anatomy-park (or a hand-edit) added in the diff, regardless of whether the AC explicitly cites it.

1. **Prompt update**: szechuan-sauce gains a sweep instruction. For every trap-door bullet added to a CLAUDE.md file in the diff (read directly from `git diff` of CLAUDE.md files), with a `pattern_shape` field present (set by T21):
   - Confirm at least one spec file in the diff contains a test whose body asserts the negative case (input violating the pattern is rejected / throws / fails).
   - Trap door without a corresponding negative test → P0 finding ("trap door documented but not enforced").
2. **Coordination with T6**: T6 in citadel handles the AC-cited subset. T23 handles the un-cited remainder. Both write findings; citadel's reporter dedupes by `(claude_md_file, bullet_text)` tuple.

Catches the S3-key class deeper than T6 alone. The trap door is now a contract, not a comment.

Exit: szechuan-sauce on the LOA-618 fixture flags the S3-key trap door as un-enforced (P0) when the receiving-side validation test is missing; dedupes correctly when citadel also reports it.

## Acceptance Criteria

- [ ] **AC-CIT-01**: `/citadel --prd <loa-618-prd> --diff main..HEAD --strict` exits non-zero on the LOA-618 fixture and surfaces ≥6 of the 8 tagged issues from `loa-618-issues.json`, matched by stable ID, all severity ≥ High.
- [ ] **AC-CIT-02**: All tasks T3–T11 produce findings under their own clearly labelled console section.
- [ ] **AC-CIT-03**: JSON report writes to `<session>/citadel_report.json` when invoked from `/pickle-pipeline`; schema is versioned `"1.0"`.
- [ ] **AC-CIT-04**: `pipeline-runner.ts` integrates the phase between `pickle` and `anatomy-park`, blocking only on Critical (or High with `--strict`); anatomy-park and szechuan-sauce explicitly call `readCitadelReport(sessionDir)`.
- [ ] **AC-CIT-05**: Noise-floor fixture (clean merged epic) produces <5 Low findings and zero Critical/High.
- [ ] **AC-CIT-06**: Random-sample cohort (T15 #3) recall/precision baseline is recorded in `recall-baseline.json` and surfaces no regressions on subsequent runs (>5pp recall drop fails CI).
- [ ] **AC-CIT-07**: `.claude/commands/citadel.md` slash command exists; `/help-pickle` mentions the new phase; `/cronenberg` routes to `/citadel` as a followup when `CITADEL_RISK` is true and skips it when `/pickle-pipeline` is the chosen metaphor.
- [ ] **AC-CIT-08**: `state.prd_path` and `state.start_commit` are populated by `setup.ts` and visible in `state.json` on a fresh pipeline session.
- [ ] **AC-CIT-09**: Audit run on a 22k-line diff completes in <120 s wall-clock on a developer laptop (perf budget).
- [ ] **AC-CIT-10**: Re-running the audit on an unchanged diff is idempotent — same JSON report, same exit code; concurrent invocations on the same session dir are guarded by `state-manager.ts` locks.
- [ ] **AC-CIT-11** (LOA-618 post-mortem regression): On the LOA-618 fixture, the audit surfaces all six in-scope gaps — `getComparison` flag-gate miss (T10.5), `retryChildExtraction` pattern-replay miss (T10.7, given a populated `anatomy-park.json`), rule-set interaction gap (T10.8), destructive-role drift (T9 Pass B), S3-key invariant non-enforcement (T6), and `continuation_plan.md` orphan (T10.9). At least 5 of 6 fire at severity ≥ High; the 6th may fire at Medium.
- [ ] **AC-CIT-12**: T11.7 (AC-shape) on the LOA-618 PRD surfaces AC-FF-05 in `DECISION REQUIRED` with a suggested rewrite. When the refinement manifest shows AC-FF-05 fanned out into ≥3 tickets without a `// JUSTIFICATION:` block, T11.7 escalates to High.
- [ ] **AC-CIT-13** (overlap behavior): When `<session>/szechuan-sauce.json` exists, T10.9 dedupes findings against it (no double-count). When `<session>/anatomy-park.json` is absent, T10.7 emits a Low informational finding instead of failing.
- [ ] **AC-CIT-14** (T20 — refinement enforcement): Refinement on a fixture PRD whose AC is enumerated across ≥3 endpoints either produces one parametrized ticket OR halts with `exit 2`; `refinement_manifest.json` carries `ac_shape_smells` and per-ticket `justification?` fields; existing refinement runs without smells are unaffected.
- [ ] **AC-CIT-15** (T21 — anatomy-park replay): On the LOA-618 fixture, anatomy-park surfaces both `createUpdatedRun` (phase: discovery) and `retryChildExtraction` (phase: replay) as CRITICAL findings; every new trap door written to CLAUDE.md carries a `pattern_shape` field.
- [ ] **AC-CIT-16** (T22 — szechuan hygiene): szechuan-sauce on a diff that adds `notes.md` at repo root produces a P1 hygiene finding tagged `category: 'hygiene'`; the shared `diff-hygiene.ts` allowlist constants have unit-test coverage.
- [ ] **AC-CIT-17** (T23 — trap-door enforcement): szechuan-sauce on the LOA-618 fixture flags the S3-key trap door as un-enforced (P0) when the negative test is missing; citadel's T6 dedupes correctly when both fire on the same trap door.
- [ ] **AC-CIT-18** (T17 — refinement-time machinability + contract-resolution hard gate, folded from BMAD P0.2 / P0.5 / P0.12 / P0.7 / R33): refinement on a fixture PRD with a prose-only AC ("must be intuitive") halts with `exit 2`, suggests `gaps` analyst, writes `readiness_<date>.md`. Refinement on a fixture PRD with an unresolvable contract reference halts with `exit 2`, suggests `codebase` analyst. Cycle 4 halts with `readiness_escalation_<date>.md` (cap of 3 enforced). After `course_corrected` events bump `tickets_version`, T17 re-runs in DELTA mode on added/modified tickets only and emits `readiness_failed_post_correction` on regression. Gate runs in <10s on the 25-ticket manifest fixture.

## Out of Scope

- Auto-fixing findings. Surface only.
- Generating tests for unguarded trap doors (stub-printing only via `--print-stubs`; full generation is a future `/pickle-trap-door-test-gen` skill).
- Visual regression / pixel diffing of frontend.
- License / dependency audits.
- Security scanning beyond what `/security-review` already covers.
- Non-TypeScript repos. Heuristics assume NestJS-shaped backends + React frontends. Other stacks are future work.
- Non-Pickle PRDs. T1's parser is tuned for the Pickle PRD shape. Other markdown shapes may parse partially or not at all.

## Implementation Guidance

**Build path**: `extension/src/services/citadel/` (TypeScript). All new files. No reuse from `pickle-refine-prd`, anatomy-park, or szechuan-sauce — those are prompt skills, not callable libraries.

**Existing primitive to wrap**: `getDiffFiles(base, head, repoRoot)` from `extension/src/services/git-utils.ts:163`. Everything else is from scratch.

**Heuristic load-bearing**:
- AC IDs use letter-number patterns (`AC-FF-05`, `AC-DIFF-SUPP-01`); regex must support multi-segment dashes.
- Architectural decisions can be `A1` through `A99` plus dotted forms (`A11.`).
- Multi-paragraph PRD sections may bury an AC in prose; do not require a table.
- T3 and T6 have a recall ceiling without LLM assist. Document the limit; offer T11.5 as a paid upgrade.

**Performance budget**: 120 s wall-clock on a 22k-line diff. T2 diff-walker should cache the file list per session. T3-T6 grep passes should run in parallel where possible.

**Concurrency**: All session-state writes route through `state-manager.ts` locks. Do not write `citadel_report.json` outside that fence.

**Telemetry**: Per-heuristic timing + parse-error counts written to `<session>/citadel_telemetry.json`. Helps tune heuristics without re-running the whole audit.

## Dependency DAG

```
T0 ─┬─→ T13
    └─→ (everything else can read state)
T1 ─┬─→ T3, T5, T8, T11
    └─→ T15
T2 ─┬─→ T3, T4, T5, T6, T7, T8, T9, T10, T10.5, T10.7, T10.8, T10.9, T11
    └─→ T15
anatomy-park output (with T21 schema) ─→ T10.7 (pattern-replay safety-net; soft-skip if absent)
szechuan-sauce output (with T22 schema) ─→ T10.9 (dedupe; no-op if absent)
T1 + refinement manifest (with T20 schema) ─→ T11.7 (AC-shape safety-net for T20)
T3..T11.7 ─→ T12 ─→ T13
T11.5 (optional) ─→ T3, T6
T13 ─→ T13.5 (cronenberg routing) ─→ T14
T13 ─→ T16 (smoke test)
T14, T15 parallelizable with T1-T12

Cross-skill (parallelizable with the citadel core):
T20 (refine-prd) — schema bump + worker-prompt update + manifest enforcement
T21 (anatomy-park) — phase-2.5 prompt addition + schema bump (pattern_shape, phase, original_finding_id)
T22 (szechuan diff-hygiene) ─→ shares diff-hygiene.ts with T10.9
T23 (szechuan trap-door-as-test) ─→ depends on T21's pattern_shape field

Schema-coupled ordering: T21 must merge before T10.7 / T23 can rely on pattern_shape; T22 must merge before T10.9 dedupe assertion holds; T20 must merge before T11.7 escalation logic activates.
```

## How to Ship This

Use the standard pickle pipeline on this PRD. Refine first (`/pickle-refine-prd`), then build with `/pickle-tmux` (this is multi-file, multi-stage, multi-skill — interactive `/pickle` would underutilize). Backend / agent code in TypeScript; tests in `node --test`. Default backend is fine.

**Recommended ticket ordering** (after refinement decomposes into atomic tickets):
1. T0 (state schema) and T20–T22 (cross-skill schema bumps) **first** — every other task either reads or writes against these contracts. Skipping ahead means rework when the schemas change.
2. T1, T2, then T3–T11 in parallel.
3. T10.5, T10.7, T10.8, T10.9, T11.7 — depend on the schema bumps from step 1.
4. T23 — depends on T21's `pattern_shape`.
5. T12, T13, T13.5, T14, T15.
6. T16 smoke test runs against the **LOA-618 fixture diff**, not against this PRD's own diff (would be tautological).

**Cross-skill commit hygiene**: T20–T23 touch sibling skills' command prompts. Bump `extension/package.json` minor version (new commands + new schema fields = minor bump per CLAUDE.md). Run `bash install.sh` after editing `.claude/commands/*.md` so the deployed copies match source. The full release gate (`npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && npm test`) must pass.

— Pickle Rick out. *belch*

---

## Appendix: Additional BMAD-inspired hardening (non-conformance)

> **Provenance**: Absorbed verbatim from `prds/bmad-inspired-hardening.md` (deleted 2026-04-29) — refined 2026-04-26, post 3-cycle 3-analyst refinement. Source: code-level deep dive on `bmad-code-org/BMAD-METHOD@v6.4.0`. These capabilities are independent of the post-implementation conformance audit; they harden the engineering loop in other dimensions (pre-impl alignment gate, persistent project context, phase specialization, mid-execution adaptation, multi-agent debate, codex format pin, schema migration, hang guards, behavioral testing). The conformance overlap from BMAD's P0 (AC machinability + contract resolution) was folded into core task **T17** above; everything else lives here.
>
> AC IDs from this appendix retain their `P0.N` / `P1.N` / `P2.N` / `P3.N` / `P4.N` / `R##` / `T0##` numbering — they do NOT collide with `AC-CIT-NN` and remain authoritative for the Appendix scope.

### Appendix Prerequisites *(refined: risk C3 R28)*

This section inherits a known gap from `prds/codex-classifier-prompt-leak.md`: codex output format drift can silently re-expose prompt-leak. **In-scope mitigation chosen**: P0 gate adds session-boot codex-version smoke check (P0.10 below). Hard-prerequisite alternative (`prds/codex-format-pin-smoke.md`) deferred to follow-up.

### Appendix Problem

A code-level investigation of BMAD-METHOD v6.4 surfaced five capabilities Pickle Rick is missing. They sit on three different points of the lifecycle: upstream of execution, structural at execution boundaries, and adaptive during execution.

**Concrete pain we feel today:**

1. **Decisions converge before they're debated.** When PRD drafting hits a real fork, one Morty's prior wins by default. We have no primitive for genuinely-independent multi-agent debate at decision points.
2. **No structural gate between refinement and tmux launch.** `/pickle-refine-prd --run` hands the manifest to `mux-runner.js` and goes. If refinement produced misaligned tickets, Morty workers eat the whole epic before we notice.
3. **Every fresh context re-discovers the codebase.** Context clearing is our signature move. The cost: every iteration re-runs grep/read to figure out what library is used, where auth lives. We pay re-discovery tax forever.
4. **One Morty wears every hat.** Researcher-Morty and Implementer-Morty are the same prompt with phase instructions slapped on top. BMAD's evidence: prompt diversity from genuinely distinct agent priors changes what gets found.
5. **Long runs have no resilience to mid-execution discovery.** When ticket 12 of 25 reveals tickets 13–25 are wrong, options are: push through, circuit breaker stops, or manual restart.

**What changed since the prior draft (v1.54.x → v1.55.0):**

Two parallel workstreams shipped that this section must ride on:

- **`--teams` agent-teams mode (v1.55.0, SHA `a4662df`)** introduces harness-native subagent spawning via `Agent` tool with `subagent_type`, `team_name`, and `TaskUpdate` completion semantics. `--teams` is **claude-backend-only by hard guard**, re-checked across `--resume`. *(refined: codebase C3 — `Agent`/`TeamCreate` are orchestrator-only tools, not Node-callable; bin scripts MUST be brief-prep only, skill prompts drive spawning)*
- **Codex hardening chain (6 commits, `ba8744d` → `4b1f784`)** establishes canonical `PROMISE_TOKENS`, codex-aware `extractAssistantContent`, refinement/judge isolation via `PICKLE_REFINEMENT_LOCK=1`, and `buildJudgeInvocation()` for read-only sandboxes.

**Implication**: Pickle Rick now has two coexisting spawning paths (subprocess via `spawn-morty.ts`/`buildWorkerInvocation`, and Agent-tool via `pickle.md` Phase 3.B brief). New skills must declare which path(s) they use.

### Appendix Goal

Land five capabilities that rewire the lifecycle:

```
                                           ┌─→ /pickle-debate at decision forks (P4)
PRD ───────────────────────────────────────┤
                                           └─→ /pickle-refine-prd
                                                     ↓
                                            /pickle-readiness (GATE) (P0) ← also re-runs on tickets_version bump
                                                     ↓
                                            /pickle-archaeology (once, persistent) (P1)
                                                     ↓
                                  ┌─────────────────────────────────────┐
                                  │ Two execution paths:                │
                                  │  • teams: orchestrator dispatches   │
                                  │    subagent_type per phase via      │  (P2)
                                  │    Agent tool                       │
                                  │  • legacy: spawn-morty.ts injects   │
                                  │    persona block per phase          │  (P2)
                                  └─────────────────────────────────────┘
                                                     ↓
                                  /pickle-correct-course on discovery (P3)
                                  *P4 also invokable mid-loop and at any stage; on codex backend, defaults to --solo with banner.*
```

**Non-goal:** porting BMAD's runtime model. Pickle Rick keeps its runtime moat.

### Appendix Compatibility with `--teams` Mode *(refined: requirements C2/C3)*

| Skill | Subprocess (codex+claude) | Agent-tool (claude-only) | Notes |
|---|:---:|:---:|---|
| P0 `/pickle-readiness` | n/a — pure structural | n/a — pure structural | No LLM call. Backend-agnostic. |
| P1 `/pickle-archaeology` | yes | yes | Dual-path injection: preamble in `spawn-morty.ts`, brief block in `pickle.md` Phase 3.B. |
| P2 phase personas | yes (persona injection) | yes (`subagent_type` dispatch) | Six agent-md files single source of truth. |
| P3 `/pickle-correct-course` | yes | yes | Uses `buildJudgeInvocation()` (read-only sandbox). |
| P4 `/pickle-debate` | `--solo` (auto on codex) | **primary path** | Real parallel subagents are the architectural point. Codex auto-promoted to `--solo` per CUJ-7. |

### Appendix Configuration Reference *(refined: requirements C3 P0 #1)*

Every user-facing knob lives in exactly one of three surfaces. Anything not in this table is out-of-spec.

#### CLI flags

| Skill | Flag | Type | Default | Description |
|---|---|---|---|---|
| `/pickle-readiness` | `--skip-readiness "<reason>"` | string ≤200 chars | (none) | Bypass gate; reason required, logged |
| `/pickle-readiness` | `--repo-root <path>` (repeatable) | path | `process.cwd()` | Multi-repo workspace targeting |
| `/pickle-readiness` | `--history [--last N]` | int | 10 | Show readiness cycle history |
| `/pickle-archaeology` | `--refresh` | bool | false | Force re-archaeology |
| `/pickle-archaeology` | `--no-archaeology` | bool | false | Disable injection for session |
| `/pickle-archaeology` | `--project-type <category>` | enum | (auto) | Override classifier |
| `/pickle-correct-course` | `--auto-apply` | bool | false | Skip approval prompt |
| `/pickle-correct-course` | `--force` | bool | false | Override low-confidence gate (advisory only; structural predicates non-overridable) |
| `/pickle-correct-course` | `--dry-run` | bool | false | Emit proposal without apply |
| `/pickle-correct-course` | `--recover-from-ledger` | bool | false | Replay-reverse partial apply |
| `/pickle-correct-course` | `--recover --force` | bool | false | Forward-replay partial apply |
| `/pickle-debate` | `--solo` | bool | (auto on codex) | Sequential single-context |
| `/pickle-debate` | `--strict-teams` | bool | false | Disable codex auto-promote (persisted in `state.json.flags.strict_teams`) |
| `/pickle-debate` | `--continue [--personas <subset>]` | bool/csv | (off) | Continue prior debate; round-N fences against `tickets_version` snapshot |
| `/pickle-debate` | `--n <count>` | int 2..6 | 4 | Number of personas |
| `/pickle-debate` | `--personas <csv>` | csv | r,a,i,s | Persona selection |
| `/pickle-debate` | `--accept-stale` | bool | false | Round-N override after `tickets_version` change |

#### Environment variables

| Variable | Type | Default | Effect |
|---|---|---|---|
| `PICKLE_PHASE_PERSONAS` | `on\|off` | `off` (until P2.7 baseline checked in) | P2 dispatcher kill-switch |
| `PICKLE_ARCHAEOLOGY_AUTO_REFRESH` | `on\|off` | `on` | P1.6 auto-trigger kill-switch |
| `BEHAVIORAL` | `0\|1` | `0` | Gate behavioral tests |
| `CI` | `0\|1` | `0` | Suppress confirmation prompts; strict budget |

#### Settings (`~/.claude/pickle-rick/pickle_settings.json:bmad_hardening`)

| Key | Type | Default | Used by |
|---|---|---|---|
| `archaeology_refresh_threshold_pct` | int 0-100 | 10 | P1.6 |
| `debate_max_rounds` | int 1-10 | 5 | P4.7 |
| `debate_codex_solo_max_rounds` | int 1-5 | 2 | P4 R26 |
| `debate_min_rounds_confirm` | int 1-10 | 3 | P4.7 |
| `readiness_skip_reasons_max_len` | int | 200 | P0.6 |
| `readiness_max_recycle_cycles` | int | 3 | P0 R33 |
| `phase_personas_enabled` | bool | false | P2 dispatcher |
| `phase_personas.model_override` | object<phase, "sonnet"\|"opus"\|"haiku"> | `{}` | P2 R31 |
| `behavioral_test_max_usd_per_test` | float | 0.50 | Behavioral framework |
| `behavioral_test_max_wall_s` | int | 120 | Behavioral framework |
| `calibration.drift_threshold_pct` | int | 5 | R22 |

#### Discoverability surface

- `/help-pickle` lists all skills + their primary flags.
- `/pickle-status --config` prints the resolved configuration table for the current session (CLI args + env + settings, with provenance).
- `/pickle-readiness --history` shows readiness cycle log.
- `PRD_GUIDE.md` "Configuration Reference" section mirrors this table.

### Appendix Flag Interaction Matrix *(refined: risk C3)*

| PICKLE_PHASE_PERSONAS | PICKLE_REFINEMENT_LOCK | strict_teams | --auto-apply | --skip-readiness | Status |
|---|---|---|---|---|---|
| off | * | * | * | * | Default v1 ship; matches v1.55.0 |
| on | 0 | false | false | false | "Full feature" mode; behavioral baseline must exist |
| on | 1 | * | * | * | Illegal: refinement-lock implies pre-implementation; rejected at session boot |
| on | 0 | true | * | * | Codex sessions explicitly fail per R16/R27 |
| on | 0 | * | true | true | Logged WARN; structural predicates of R5 still must pass |
| off | * | * | true | * | Auto-correct works without phase-personas |

`tests/flag-interaction-matrix.test.js` enumerates every legal combo. Untested combos default-fail.

### Appendix Schema Migration (v2 → v3) *(refined: codebase C3 P1 #11)*

`STATE_MANAGER_DEFAULTS.schemaVersion` bumps from 2 to 3. New optional fields, default-emitted at session boot:

| Field | Type | Default | Source |
|---|---|---|---|
| `archaeology` | `{ project_context_path: string, last_run_iso: string, file_count: number, project_type: string } \| null` | `null` | P1 |
| `tickets_version` | `number` (monotonic counter, bumped under transaction lock on ticket-tree mutations) | `0` | R13 |
| `last_course_correction` | `{ proposal_path, applied_iso, restart_ticket_id \| null, before_count, after_count } \| null` | `null` | P3 |
| `phase_personas_active` | `boolean` (controlled by `PICKLE_PHASE_PERSONAS`) | `false` | P2 |
| `flags` | `{ strict_teams?: boolean, [key: string]: unknown }` | `{}` | R27 |
| `readiness.cycle_history` | `Array<{cycle, status, suggested_analyst, user_action, timestamp}>` | `[]` | P0 |
| `codex_version_seen` | `string \| null` | `null` | R28 |

`tests/state-manager.test.js` MUST round-trip v1→v2→v3 migrations. State-manager `transaction()` MUST detect schema-version mismatch on read-after-write; refuse write if on-disk version > cached version; throw `SchemaVersionMismatchError`; mux-runner aborts iteration on catch *(refined: risk C3 R32)*.

### Appendix Hang Guards *(refined: codebase C3 P0 #8)*

Every external-process spawn introduced by this section passes an explicit timeout option. Mirrors `extension/CLAUDE.md` trap-door enumeration (council-publish gh, scope-resolver rg/grep, plumbus bun, pickle-utils osascript) — the four new bins constitute the **fifth silent-hang class**.

| Const | Default | Used by |
|---|---|---|
| `READINESS_GREP_TIMEOUT_MS` | `30_000` | P0 contract-resolution via `scope-resolver.computeOneHop()` |
| `ARCHAEOLOGY_WORKER_TIMEOUT_S` | `600` | P1 worker spawn via `buildWorkerInvocation()` |
| `CORRECTOR_TIMEOUT_S` | `300` | P3 corrector spawn via `buildJudgeInvocation()` |
| `DEBATER_TIMEOUT_S` | `240` | P4 per-persona; cap × N |

Each new bin includes `tests/<bin-name>-hang-guard.test.js` covering wedged-spawn with a fake-tool shim on `PATH` (mirrors `scope-one-hop-hang-guard.test.js`).

### Appendix Section 1 — `/pickle-readiness` Implementation Readiness Gate (P0)

> **Citadel coordination**: T17 in core uses this section's `check-readiness.ts` bin and reuses P0.2 / P0.5 / P0.7 / P0.8 / P0.12. The full skill (with `--history`, `--repo-root`, `--skip-readiness`, codex-version smoke at P0.10, recycle-cycle history) is non-conformance hardening and lives here.

| ID | Requirement | Verification |
|:---|:---|:---|
| P0.1 | New script `extension/src/bin/check-readiness.ts` exits 0 on pass, 2 on structural failure, 1 on internal error; emits structured JSON to stdout | `node ~/.claude/pickle-rick/extension/bin/check-readiness.js --session-dir $SESSION_DIR` returns `{ status, findings, elapsed_ms }` |
| P0.2 | Gate enforces five alignment checks reading from ticket dirs `${SESSION_ROOT}/<hash>/linear_ticket_<hash>.md` (NOT `refinement_manifest.json`, which is metadata-only) *(refined: codebase C3 P0 #1)*: every PRD requirement maps to ≥1 ticket; every AC is machine-checkable; every ticket file path resolves; every contract referenced exists (via `scope-resolver.computeOneHop({findImportersTimeoutMs: 30_000})` *(refined: codebase C3 P1 #7)*); every ticket dependency is in the manifest or marked external | `tests/check-readiness.test.js` covers each check independently |
| P0.3 | `/pickle-readiness` is invokable manually AND auto-invoked at THREE execution points *(refined: codebase C3 P0 #6)*: (i) end of `/pickle-refine-prd --run` BEFORE `setup.ts` mints state.json; (ii) inside `mux-runner.ts` at iteration 0 BEFORE first spawn (legacy resume); (iii) inside `pickle.md` Phase 3.B BEFORE first `Agent` call (teams resume) | Integration test exercises all three with misaligned-fixture |
| P0.4 | Findings written to `${SESSION_DIR}/readiness_<date>.md` with three sections: PRD↔ticket map, AC verifiability matrix, contract resolution table | Schema validator |
| P0.5 | Failure routes back to refinement: gate suggests which analyst (gaps / codebase / risk) should re-cycle based on finding category. Hard cap `state.json.readiness.cycle_history.length ≤ 3` *(refined: risk C3 R33)*; after 3 cycles, halt with `readiness_escalation_<date>.md` | Test: contract failures → codebase analyst; AC failures → gaps analyst; cycle 4 halts |
| P0.6 | `--skip-readiness "<reason>"` (≤200 chars, required) bypasses; logs `event: 'readiness_skipped'` with reason | Test: flag without reason rejects via `die()` |
| P0.7 | Gate runs in <10s on 25-ticket manifest fixture at `tests/__fixtures__/readiness-timing/large-manifest/` *(refined: requirements C3 P2)* | `time` measurement |
| P0.8 | Reuses `findMissingPrefixes` from `extension/src/services/artifact-validation.ts` (promoted from `validate-teams-ticket.ts:53-58`) with refactored signature `findMissingPrefixes(files, prefixes: readonly string[]) => string[]` *(refined: codebase C3 P0 #5)*; `validate-teams-ticket.ts:86` becomes `findMissingPrefixes(files, ARTIFACT_PREFIXES[role])`; `WorkerRole` enum NOT extended | New `tests/artifact-validation.test.js` |
| P0.9 | `/pickle-readiness --history [--last N]` prints cycle table with status, suggested-analyst, user-action, timestamp *(refined: requirements C3)* | Manual review of stdout format |
| P0.10 | Session boot writes `state.json.codex_version_seen` from `codex --version` (when codex is the resolved backend); setup.ts asserts version against `extension/package.json:engines.codex` (semver `^0.42.0`); mismatch fails session entry *(refined: risk C3 R28)* | `tests/codex-version-smoke.test.js` |
| P0.11 | `--repo-root <path>` (repeatable) for multi-repo workspaces; output sectioned per repo *(refined: requirements C3 P1)* | Test: 3 repos, mixed pass/fail |
| P0.12 | P0 auto-runs in DELTA MODE on `tickets_version` bump (after `course_corrected` event); validates only added/modified tickets; failures emit `readiness_failed_post_correction`; halt next iteration with banner *(refined: risk C3 R30 Critical)* | Integration test: course-correct adds malformed ticket → next iteration halts |

### Appendix Section 2 — `/pickle-archaeology` Persistent Project Context (P1)

| ID | Requirement | Verification |
|:---|:---|:---|
| P1.1 | New skill `/pickle-archaeology` invokable manually; auto-invoked once per session by `/pickle-refine-prd --run` after gate passes (idempotent unless `--force`) | Test: invoking twice is no-op |
| P1.2 | `extension/data/project-types.csv` registry with 10 categories (web, mobile, backend, CLI, library, desktop, game, data, extension, infra/embedded). Resolved via `path.join(getExtensionRoot(), 'extension', 'data', 'project-types.csv')` — NOT `getDataRoot()` *(refined: codebase C3 P0 #3)*. New service `extension/src/services/project-type-classifier.ts` takes `extensionRoot` injectable parameter | Test: 10 fixture projects each correctly classified, ≥90% accuracy. Each fixture is ≥5 files matching category archetype *(refined: risk C3 P1)* |
| P1.3 | New script `extension/src/bin/archaeology.ts` runs worker (subprocess via `buildWorkerInvocation()` honoring backend) with archaeology prompt | Backend stub tests for codex + claude |
| P1.4 | Produces `${SESSION_ROOT}/project-context.md` with sections in load-bearing order: Architecture, Trap Doors, Unobvious Constraints, Key Entry Points, Conventions, Data Model *(refined: requirements C3 P2)*. First line: `> Project type: <category> — see ${EXTENSION}/data/project-types.csv for category definition` | Schema validator on output |
| P1.5 | **Subprocess preamble injection**: `spawn-morty.ts` injects `project-context.md` content as `## Project Context` block (the P2 persona block follows). Insertion point spec'd in P2.5 below | Spawned worker prompt diff |
| P1.6 | **Agent-tool brief injection**: `pickle.md` Phase 3.B brief includes `## Project Context` block before phase instructions | Greppable static assertion + integration test |
| P1.7 | Re-runs automatically when files in tracked directories change beyond threshold (default 10%, configurable). Override: `PICKLE_ARCHAEOLOGY_AUTO_REFRESH=off` | Test: simulate >10% change → re-run; below → no-op |
| P1.8 | `--refresh` forces new pass; `--no-archaeology` disables injection for session in BOTH paths; `--project-type <category>` overrides classifier | Test: each flag honored, activity events emitted |
| P1.9 | Token cost recorded in `state.json.activity` as `event: 'archaeology_complete'` with `bytes_out_utf8`, `tokens_in_estimated`, `tokens_out_estimated`, `duration_ms`, `project_type`, `backend` *(refined: requirements C2 P2)* | Activity log assertion |
| P1.10 | Stdout on completion: `[archaeology] complete — project type: <category> (confidence: high, file-pattern match); duration: 45s; bytes: 12,400; written: ${SESSION_ROOT}/project-context.md` *(refined: requirements C3 P1)* | stdout match |
| P1.11 | Gracefully degrades on archaeology failure — both paths proceed without `project-context.md`; `event: 'archaeology_skipped'` records failure mode | Test: simulate crash → mux-runner and teams flow continue |

### Appendix Section 3 — Phase-Specialized Morty Subagent Definitions (P2) *(refined: codebase C3 P0 #4 — agent-md `tools:` is CSV STRING; drop `allowed_tools[]`)*

| ID | Requirement | Verification |
|:---|:---|:---|
| P2.1 | Six agent-md files added under `.claude/agents/`: `morty-phase-researcher.md`, `morty-phase-planner.md`, `morty-phase-implementer.md`, `morty-phase-verifier.md`, `morty-phase-reviewer.md`, `morty-phase-simplifier.md` *(refined: requirements C3 — naming locked)*. Each has YAML frontmatter with `name`, `description`, `tools` (CSV STRING matching harness contract — same shape as `morty-implementer.md:4`), `model`, `role`, `identity`, `communication_style`, `principles[]` | Schema check `tests/agent-md-schema.test.js` |
| P2.2 | Per-phase `model` defaults specified in agent-md frontmatter AND in `extension/data/phase-personas.json` (single source of truth) *(refined: risk C3 R31 Critical)*: researcher=sonnet, planner=sonnet, **phase-implementer=opus** (matches v1.55.0 baseline), **verifier=opus**, phase-reviewer=sonnet, simplifier=sonnet. Override via `pickle_settings.json:bmad_hardening.phase_personas.model_override.<phase>` | `tests/phase-personas-model-defaults.test.js` |
| P2.3 | Distinct phase priors: Researcher *what exists*; Planner *what's needed*; Phase-Implementer *exactness and brevity*; Verifier *adversarial test coverage*; Phase-Reviewer *contract conformance*; Simplifier *removal* | Manual review documented in PRD_GUIDE.md |
| P2.4 | `extension/data/phase-personas.json` mapping table *(refined: codebase C3 P1 #8)*. Schema: `{ "<phase>": { "subagent_type": "morty-phase-<role>", "complexity_tier_default": "small\|medium\|large", "model": "sonnet\|opus\|haiku" }, "version": <int> }`. `pickle.md` Phase 3.B asserts `version >= <pinned>` at start; mismatch is hard failure | `tests/phase-personas-json-schema.test.js` |
| P2.5 | **Legacy/subprocess persona injection** *(refined: codebase C3 P1 #2 — insertion order locked)*: `spawn-morty.ts` constructs prompt as: (1) template body from `send-to-morty.md`, (2) `## Active Persona` block (NEW), (3) `## Project Context` block (P1.5), (4) `# TARGET TICKET CONTENT`, (5) `# EXECUTION CONTEXT`, (6) FORBIDDEN tail. Persona resolved from `phase-personas.json[state.step]`; loaded via new `extension/src/services/agent-md-loader.ts` reusing `extractFrontmatter()` from `pickle-utils.ts:204-214` *(refined: codebase C3 P1 #6 — no new YAML deps)*. Precedence: ticket-tier > persona-default > 'sonnet' *(refined: codebase C3 P1 #1)* | `tests/spawn-morty.test.js` byte-orders 6 sections + tier precedence |
| P2.6 | **Teams-mode dispatcher**: `pickle.md` Phase 3.B updated so per-ticket loop dispatches `subagent_type` per phase (not single-implementer-all-8-phases). Pre-flight check at ticket entry verifies all 6 agent-md files exist; missing files emit `phase_dispatch_preflight_failed` with `[ticket T<id>] missing: morty-phase-verifier.md, ...; install path: ~/.claude/agents/.pickle-managed/; recovery: bash install.sh && /pickle-retry T<id>` | Greppable static assertion + integration test observes 6 distinct Agent calls per ticket |
| P2.7 | **Falsifiability check** *(refined: requirements C2 + risk C3 R23)*: same input through six personas produces measurably different outputs (Jaccard token-set distinctness ≥30%). If <15%, P2 is theater and gets cut. **Flag-flip from off→on requires committed `tests/behavioral/phase-personas/baseline.json` with measured distinctness; PR cannot land without baseline update** *(refined: risk C3 R23)* | `tests/feature-flag-baseline.test.js` |
| P2.8 | All eight agent-md files (6 new + existing morty-implementer.md, morty-reviewer.md) pass `tests/agent-md-schema.test.js`. Existing `tools` field shape preserved | New test |
| P2.9 | install.sh agent rsync target moves to `~/.claude/agents/.pickle-managed/` *(refined: codebase C3 P1 #3)*. agent-md-loader resolution: (1) `~/.claude/agents/<name>.md` (user override); (2) `~/.claude/agents/.pickle-managed/<name>.md` (canonical). install.sh migrates existing pickle-canonical files to `.pickle-managed/` on first run post-bump; emits notice on legacy-path conflicts (mtime + size heuristic) | `tests/install-agent-overlay.test.js` |
| P2.10 | `PICKLE_PHASE_PERSONAS=off` default until P2.7 baseline checked in *(refined: requirements C3 + risk C3 R3)*. One-time-per-session stdout when off and feature would apply: `[phase-personas] feature available but disabled (calibration in progress); enable with: pickle settings set bmad_hardening.phase_personas_enabled true OR PICKLE_PHASE_PERSONAS=on`. Activity event `phase_personas_disabled_seen` once per session | Test: stdout emitted once; second invocation no-op |
| P2.11 | Existing `persona.md` content (Rick voice) prepended to every persona's worker prompt as base layer; per-phase blocks layer specialization on top | Smoke test: clean install, every persona prompt contains Rick voice |
| P2.12 | Schema-version bump for `state.json.phase_personas_active` covered by Schema Migration v3 above | Round-trip test |

### Appendix Section 4 — `/pickle-correct-course` Mid-Execution Adaptive Skill (P3)

| ID | Requirement | Verification |
|:---|:---|:---|
| P3.1 | New skill `/pickle-correct-course "<discovery>"` invokable manually; surfaced by circuit breaker as suggested recovery when no-progress signature matches "constraint discovery" patterns | Test: matching CB signature emits suggestion |
| P3.2 | New agent-md `.claude/agents/morty-course-corrector.md`: read-only role (`tools: Read, Glob, Grep`), produces proposal artifact only. Manager performs the actual restructure. Mirrors `morty-implementer.md:13` forbidden-state-mutation note *(refined: codebase C3 P2)* | Schema check; `tools` excludes Edit/Write/Bash |
| P3.3 | New script `extension/src/bin/correct-course.ts` is **brief-prep helper only** *(refined: codebase C3 P0 #2)* — resolves session context, validates discovery statement, writes `${SESSION_ROOT}/change_proposal_<date>_brief.md`. Actual subagent spawning happens in `.claude/commands/pickle-correct-course.md` orchestrator skill prompt via `buildJudgeInvocation(backend, ...)` (read-only sandbox: codex `-s read-only --ignore-rules --ephemeral`, claude `--allowedTools Read,Glob,Grep --no-session-persistence`) | Test asserts `--dangerously-bypass-approvals-and-sandbox` never on codex; no Edit/Write tools on claude |
| P3.4 | Produces `${SESSION_ROOT}/change_proposal_<date>.md` with five sections: Discovery Summary, Impact Map, Artifact Diffs, Restart Point, **Confidence Metadata** (renamed from Confidence Score) *(refined: risk C3 R5 reconciliation)*. Plus `change_proposal_<date>_trace.md` with full reasoning trace *(refined: risk C2 R19)*. Artifact set validated via `findMissingPrefixes(files, ['discovery_summary', 'impact_map', 'artifact_diffs', 'restart_point', 'confidence_metadata'])` | Schema validator |
| P3.5 | **Atomic restructure with current_ticket invariants** *(refined: codebase C3 P0 #1 + risk C3)*. After approval, MANAGER atomically applies under composite lock (state.json transaction + restructure.lock). Within transaction: (1) resolve `current_ticket` membership: killed-set → `current_ticket = last_course_correction.restart_ticket_id` (null if absent, force re-pick); kept-set → no-op; added-set (corner) → `current_ticket = <new_hash>` + `current_ticket_redirected_to_new` event; (2) apply ticket-tree mutations per ledger (kill via `markTicketKilled`, add via dir+linear_ticket write — kills+adds only, no in-place rename); (3) bump `tickets_version` (R13 monotonic counter); (4) append `course_corrected` event with before/after sets + branch ('a'\|'b'\|'c'); (5) trigger P0 delta-mode re-run (R30 → P0.12); (6) release locks LIFO. Partial-failure → replay-reverse via apply-ledger at `${SESSION_ROOT}/change_proposal_<date>_apply.log` | `tests/integration/course-correct-hot-swap.test.js` covers all 3 branches; partial-failure replay-reverse tested |
| P3.6 | `--auto-apply` waits for next iteration boundary before acquiring state lock *(refined: risk C3 R24)*; activity event `course_correct_pending_iteration_boundary` records wait. Mid-iteration aborts on `tickets_version` mismatch print: `[iteration ABORTED] manifest swapped during iteration <N>; resuming on next iteration with restructured plan`. 3+ aborts in single epic emit warning *(refined: requirements C3 P1)* | Race test |
| P3.7 | `--dry-run` emits proposal without writing changes; `--auto-apply` skips approval prompt | Both flags tested |
| P3.8 | **Confidence is structural, not numeric** *(refined: risk C3 R5 reconciliation)*. Four structural predicates: (a) impact-map enumerates ≥1 ticket; (b) every referenced ticket-id resolves to a current `${SESSION_ROOT}/<hash>/` directory OR is in killed-set; (c) discovery_summary contains user statement verbatim or documented derivation; (d) restart_point resolves to current ticket-id OR null with documented reason. Auto-apply requires ALL four to pass. `--force` overrides only the *advisory* portion; structural predicates are non-overridable *(refined: requirements C3)* | Unit tests with passing+failing fixtures per predicate |
| P3.9 | `--recover-from-ledger` reads `change_proposal_<date>_apply.log`, identifies last successful step, replays-reverse from that point under fresh composite lock; on success writes `course_correct_recovered` *(refined: requirements C3)*. `--recover --force` allows forward-replay (transient-cause case) | Tests for both modes |
| P3.10 | Partial-failure under `--auto-apply` writes `${SESSION_ROOT}/HALT_<date>.md` with failed step, ledger path, three recovery options. mux-runner halts at next iteration boundary; activity event `course_correct_apply_failed` *(refined: requirements C3 P0 + P1)*. On user attach, tmux pane top banner shows HALT contents (CUJ-6) | Integration test |
| P3.11 | New service `extension/src/services/transaction-ticket-ops.ts` *(refined: codebase C3 P1 #5)*: `updateTicketStatusInTransaction(ticketId, newStatus, sessionDir, txCtx) => {path, content}` returns planned write; manager replays inside transaction. Existing `updateTicketStatus` becomes thin wrapper. Same pattern for `materializeNewTicket(spec) => {dirPath, files: [{path, content}]}` and `replayReverseLedger(ledgerPath, sessionRoot)` helpers | `tests/transaction-ticket-ops.test.js` |
| P3.12 | Backend works under both `--backend claude` and `--backend codex` in legacy mode; teams mode is claude-only by inheritance | Backend-stub tests |
| P3.13 | Detects `PICKLE_REFINEMENT_LOCK=1` if invoked during refinement; logs `course_correct_during_refinement`; forces claude backend with user-visible note *(refined: risk C3 R25)* | Test |

### Appendix Section 5 — `/pickle-debate` Multi-Agent Decision Primitive (P4)

| ID | Requirement | Verification |
|:---|:---|:---|
| P4.1 | New skill `/pickle-debate "<question>" [--personas r,a,i,s] [--n 4]` invokable at any lifecycle stage; default personas: Researcher, Architect, Implementer, Skeptic | `/help-pickle` lists; flag parsing tested |
| P4.2 | **Per-persona agent-md files** *(refined: risk C3 P1)*: `morty-debater-researcher.md`, `morty-debater-architect.md`, `morty-debater-implementer.md`, `morty-debater-skeptic.md`. Generation script `extension/src/bin/generate-debate-personas.ts` produces all 4 from common template + per-persona overlay (DRY at build-time). `tests/debate-persona-generation.test.js` asserts no drift between template and committed copies | Generation test |
| P4.3 | New script `extension/src/bin/debate.ts` is **brief-prep helper only** *(refined: codebase C3 P0 #2 + risk C3)*: resolves personas, validates frontmatter, writes `${SESSION_ROOT}/debate_<date>_brief.md`. **Orchestrator-driven path** in `.claude/commands/pickle-debate.md` calls `TeamCreate`, N parallel `Agent` invocations with `subagent_type: "morty-debater-<persona>"`, then `TeamDelete` | Integration test: 4 parallel Agent spawns; team teardown |
| P4.4 | Each subagent's prompt capped at 600 words shared context; per-persona response capped at 800 words BPE *(refined: requirements C2 + risk C2)* | Token-budget assertion |
| P4.5 | Each persona instructed to "respond authentically as <persona>" with explicit disagreement permission. Subagent's `tools` field contains `Read, Glob, Grep` only (no Edit/Write/Bash) | Schema check |
| P4.6 | Each persona signals completion via `TaskUpdate(status="completed")` (NOT `<promise>` token) | Greppable assertion; template-no-bare-tokens passes |
| P4.7 | **Multi-round debate with caps** *(refined: risk C3 R29 + R26)*: max rounds 5 (`debate_max_rounds`); **codex `--solo` hard cap 2** (`debate_codex_solo_max_rounds`); rounds 3+ on codex fail with migration suggestion. Round-N entry pre-flight: assert `state.json.tickets_version` == round-1 snapshot; mismatch halts unless `--accept-stale`. New persona at round-N receives full round-1 priors with note "weren't in round 1, read for context". Latest-first truncation when prompt > round-budget; `debate_round_truncated` event records bytes-dropped. 3+ rounds requires `--continue --confirm-multi-round` | Round-3 codex test fails; mid-debate course-correct test halts round-2 |
| P4.8 | Output `${SESSION_ROOT}/debate_<date>.md`: one section per persona (full unabridged), no synthesis. Optional Orchestrator note flagging disagreement points (regex-deterministic header `^## Disagreements with prior speakers$`) *(refined: risk C2 minor)* | Output schema check |
| P4.9 | `--solo` falls back to single-context sequential roleplay when teams unavailable (codex). `--strict-teams` *(refined: risk C3 R27)* persisted in `state.json.flags.strict_teams`; resumed sessions inherit; per-invocation `--no-strict-teams` overrides | Resume test |
| P4.10 | Activity log records `debate_complete` with `personas`, `rounds`, `tokens_in`, `tokens_out`, `wall_clock_ms`, `mode: 'teams'\|'solo'\|'solo (auto)'` | Integration test |
| P4.11 | Backend gating *(refined: requirements C3)*: codex without `--solo` and without `--strict-teams` triggers CUJ-7 auto-promote with cost banner: `[debate] codex backend detected — auto-promoting to --solo (use --strict-teams to require parallel subagents and fail-fast on codex). Sequential debate starting; estimated cost: $0.40, est. wall-clock: 90s. Continue? [Y/n]`. Activity event `debate_solo_auto`. `--strict-teams` on codex exits 7: `debate: --strict-teams requires claude backend; current: codex; remove --strict-teams to allow auto-promote, or switch backend` | Test: codex prompt + auto-promote; --strict-teams fail-fast |
| P4.12 | Mid-debate course-correct invalidation: `tickets_version` mismatch at round-N entry halts debate; activity event `debate_invalidated_by_correction` *(refined: risk C3 R29)* | Test |

### Appendix Behavioral Test User-Flow *(refined: requirements C3 P0 #4)*

`npm run test:behavioral` is interactive by default and CI-safe via env:

1. Discovers tests via `tests/behavioral/**/*.test.js` glob.
2. Reads `// COST_CEILING: $X.XX` and `// WALL_CEILING: Ns` from each test header.
3. Prints: `[behavioral] N tests will run; estimated cost: $X.XX (max budget cap: $Y.YY); estimated wall-clock: Z minutes; continue? [Y/n]`.
4. On `Y` (or `CI=1`), runs each test serially with per-test stdout: `[behavioral i/N] <name>: cost $A.AA / cap $0.50, wall <s>s / cap 120s, status: PASS|FAIL|BUDGET_EXCEEDED`.
5. Final summary: `[behavioral] N tests, M passed, K failed, X budget-exceeded; total cost: $T.TT; log: tests/behavioral/.last-run.json`.
6. CI runs (`BEHAVIORAL=1 CI=1`) skip prompt; **fail-closed default**: PR cannot land if any test was skipped due to budget *(refined: risk C3)*. Override via `BEHAVIORAL_BUDGET_OVERRIDE=1`.

### Appendix Cross-Cutting User Journeys (CUJs)

#### CUJ-3 (revised): Course-correction restructure approval

User reviews proposal at `change_proposal_<date>.md`; sees four-pane preview *(refined: requirements C3 P0 #8)*: (a) ticket directory tree (renames/removals/adds), (b) per-ticket frontmatter changes, (c) `state.json` diff, (d) **projected apply ledger** with recovery class per step. Step 7 of CUJ-3: MANAGER acquires composite lock, applies operations in order, writes apply-ledger entry per operation, logs `course_corrected`.

#### CUJ-6: Partial-failure recovery on `/pickle-correct-course --auto-apply` *(refined: requirements C3 P0 #2)*

Unattended runner; corrector writes proposal at 03:14; manager begins composite-lock apply. Step 4 fails (disk/FS/permission). Apply-ledger writes `step_4: FAILED`. Replay-reverse runs. Manager writes `${SESSION_ROOT}/HALT_<date>.md` with failed step, cause, ledger path, three recovery options, "if you do nothing" outcome. mux-runner halts at next iteration boundary. User attaches at 09:00; tmux pane top banner shows HALT summary. Recovery: `--recover-from-ledger`, `--recover --force`, or `/pickle-status --reset-current-ticket`.

#### CUJ-7: Codex auto-promote-to-`--solo` *(refined: requirements C3 P0 #3)*

Codex-backed user invokes `/pickle-debate "Postgres or DuckDB?"` without `--solo` and without `--strict-teams`. Skill detects `state.json.backend == "codex"`. Stdout: `[debate] codex backend detected — auto-promoting to --solo ...`. On `Y`, runs sequentially. Each persona response prefixed `### <icon> <name>`. Output `debate_<date>.md` with header `mode: solo (auto)`. Activity event `debate_solo_auto`.

### Appendix Codebase Context

#### Files this section touches *(refined: codebase C3 path-resolution corrections)*

| Path | Why |
|:---|:---|
| `extension/src/bin/check-readiness.ts` | NEW — P0 gate script (also used by core T17) |
| `extension/src/bin/archaeology.ts` | NEW — P1 reverse-engineering bin (subprocess worker spawn) |
| `extension/src/bin/correct-course.ts` | NEW — P3 brief-prep helper (NOT spawning) |
| `extension/src/bin/debate.ts` | NEW — P4 brief-prep helper (NOT spawning) |
| `extension/src/bin/generate-debate-personas.ts` | NEW — P4 codegen for 4 debater agent-md files |
| `extension/src/bin/spawn-refinement-team.ts` | P0 gate invocation in `--run` flow; P1 archaeology auto-trigger |
| `extension/src/bin/spawn-morty.ts` | P1 project-context preamble injection (subprocess); P2 phase persona injection (insertion order P2.5); tier precedence rule |
| `extension/src/bin/mux-runner.ts` | P0 abort on gate failure (iter 0); P3 manifest hot-swap; circuit-breaker integration |
| `extension/src/bin/setup.ts` | Schema migration v3; codex version smoke (P0.10); flag persistence (state.json.flags) |
| `extension/src/services/state-manager.ts` | Schema v3 migration; SchemaVersionMismatchError; transaction lock for ticket-tree |
| `extension/src/services/circuit-breaker.ts` | P3 constraint-discovery signature → suggest correct-course |
| `extension/src/services/backend-spawn.ts` | Reuse `buildJudgeInvocation()` for P3/P4; document new skills' usage |
| `extension/src/services/promise-tokens.ts` | (no changes) — new skills MUST import from here |
| `extension/src/services/agent-md-loader.ts` | NEW — P2 reads agent-md frontmatter via `extractFrontmatter()`; `agentsDir` injectable; `.pickle-managed/` overlay precedence |
| `extension/src/services/classifier-utils.ts` | NEW — `extractAssistantContent` moved here from `mux-runner.ts:181-225`; `mux-runner.ts:181` re-exports for backwards compat *(refined: codebase C3 P0 #7 LOCK)* |
| `extension/src/services/artifact-validation.ts` | NEW — `findMissingPrefixes(files, prefixes)` moved from `validate-teams-ticket.ts:53-58` with refactored signature; `validate-teams-ticket.ts:86` becomes wrapper |
| `extension/src/services/transaction-ticket-ops.ts` | NEW — P3 `updateTicketStatusInTransaction`, `materializeNewTicket`, `replayReverseLedger` |
| `extension/src/services/project-type-classifier.ts` | NEW — P1 file-pattern heuristic classifier; `extensionRoot` injectable |
| `extension/src/types/index.ts` | Schema v3 fields; `ProjectContext`; `PhasePersona`; `ChangeProposal`; `DebateRound`; rename `PromiseTokens` → `PROMISE_TOKEN_VALUES` *(refined: codebase C3 P1 #10)* |
| `extension/src/hooks/handlers/stop-hook.ts` | P3 detect course-correction tokens |
| `extension/data/project-types.csv` | NEW — P1 registry; deployed via `install.sh:56-62` rsync to `~/.claude/pickle-rick/extension/data/`; resolved via `getExtensionRoot()` (NOT getDataRoot); 10 categories; per-category fixture at `tests/__fixtures__/archaeology/<category>/` |
| `extension/data/phase-personas.json` | NEW — P2 phase → subagent_type → model mapping; deployed same path; consumed by `pickle.md` Phase 3.B (Read tool, absolute path); schema includes `version` field |
| `.claude/agents/morty-phase-researcher.md` | NEW — P2 |
| `.claude/agents/morty-phase-planner.md` | NEW — P2 |
| `.claude/agents/morty-phase-implementer.md` | NEW — P2 (model: opus) |
| `.claude/agents/morty-phase-verifier.md` | NEW — P2 (model: opus) |
| `.claude/agents/morty-phase-reviewer.md` | NEW — P2 |
| `.claude/agents/morty-phase-simplifier.md` | NEW — P2 |
| `.claude/agents/morty-course-corrector.md` | NEW — P3 read-only |
| `.claude/agents/morty-debater-{researcher,architect,implementer,skeptic}.md` | NEW — P4; generated by `generate-debate-personas.ts` |
| `.claude/commands/pickle-readiness.md` | NEW — P0 skill (orchestrator path also calls bin) |
| `.claude/commands/pickle-archaeology.md` | NEW — P1 skill |
| `.claude/commands/pickle-correct-course.md` | NEW — P3 skill (orchestrator drives Agent spawn for corrector; bin writes brief) |
| `.claude/commands/pickle-debate.md` | NEW — P4 skill (orchestrator drives `TeamCreate` + N `Agent` calls; bin writes brief) |
| `.claude/commands/pickle-refine-prd.md` | Document new flags; auto-invoke gate at end (P0.3 path i) |
| `.claude/commands/pickle.md` | P2 update Phase 3.B per-phase `subagent_type` dispatch; P1 brief block injection; P0 gate invocation (path iii) |
| `.claude/commands/pickle-tmux.md` | P1 brief injection notes; P2 phase-aware persona injection notes |
| `.claude/commands/send-to-morty.md` | P1 + P2 injection points (insertion order P2.5) |
| `.claude/commands/help-pickle.md` | Surface new skills + flags |
| `install.sh` | Agents rsync target → `~/.claude/agents/.pickle-managed/`; migration to move existing pickle-canonical files; legacy-path conflict notice |
| `extension/eslint-plugin-pickle/index.js` | (no changes — allowlist already covers `services/promise-tokens.ts` and `types/index.ts` per `4b1f784`) |
| `extension/package.json` | `engines.codex: ^0.42.0` for P0.10 smoke check |
| `pickle_settings.json` | `bmad_hardening` block per Configuration Reference |
| `tests/check-readiness.test.js` | NEW — P0 |
| `tests/check-readiness-hang-guard.test.js` | NEW — P0 hang guard |
| `tests/archaeology.test.js` | NEW — P1 |
| `tests/archaeology-hang-guard.test.js` | NEW — P1 hang guard |
| `tests/agent-md-schema.test.js` | NEW — P2 schema check |
| `tests/correct-course.test.js` | NEW — P3 |
| `tests/correct-course-hang-guard.test.js` | NEW — P3 hang guard |
| `tests/debate.test.js` | NEW — P4 |
| `tests/debate-hang-guard.test.js` | NEW — P4 hang guard |
| `tests/debate-persona-generation.test.js` | NEW — P4 generation drift |
| `tests/integration/readiness-gate.test.js` | NEW — P0 three integration points |
| `tests/integration/archaeology-injection.test.js` | NEW — P1 dual-path |
| `tests/integration/phase-persona-dispatch.test.js` | NEW — P2 dispatch + injection |
| `tests/integration/course-correct-hot-swap.test.js` | NEW — P3 atomic restructure |
| `tests/integration/codex-version-smoke.test.js` | NEW — P0.10 |
| `tests/behavioral/phase-personas/harness.test.js` | NEW — P2.7 distinctness |
| `tests/behavioral/phase-personas/quality-vs-baseline.test.js` | NEW — R31 quality regression |
| `tests/behavioral/phase-personas/baseline.json` | NEW — flag-flip gate file |
| `tests/feature-flag-baseline.test.js` | NEW — R23 |
| `tests/flag-interaction-matrix.test.js` | NEW — flag combos |
| `tests/state-manager.test.js` | UPDATE — v2→v3 migration round-trip |
| `tests/install-agent-overlay.test.js` | NEW — `.pickle-managed/` overlay |
| `tests/transaction-ticket-ops.test.js` | NEW — P3 |
| `tests/artifact-validation.test.js` | NEW — P0.8 |
| `tests/calibration-baseline-drift.test.js` | NEW — R22 |

#### Patterns to follow

- **Promise tokens**: import from `extension/src/services/promise-tokens.ts`. Broken-substring in templates. Use `extractAssistantContent()` (now `services/classifier-utils.ts`) before scanning.
- **Backend spawning**: workers via `buildWorkerInvocation`; managers via `buildManagerInvocation`; **judges/correctors/debaters via `buildJudgeInvocation`** (read-only sandbox). Refinement uses `buildRefinementEnv()` + `'claude'`.
- **Artifact validation**: `findMissingPrefixes(files, prefixes)` from `services/artifact-validation.ts`.
- **Schema migration**: state-manager `migrate*` pattern. ONE bump (v2→v3) covers all P1–P4 fields.
- **Hang guards**: every external-process spawn passes explicit timeout; corresponding `tests/<bin>-hang-guard.test.js`.
- **Activity logging**: emit via `services/activity-logger.ts`. New events: `readiness_skipped`, `readiness_failed`, `readiness_failed_post_correction`, `archaeology_complete`, `archaeology_skipped`, `archaeology_truncated`, `course_corrected`, `course_correct_apply_failed`, `course_correct_pending_iteration_boundary`, `course_correct_during_refinement`, `course_correct_recovered`, `current_ticket_redirected_to_new`, `iteration_aborted_manifest_swap`, `phase_dispatch_preflight_failed`, `phase_personas_disabled_seen`, `debate_complete`, `debate_solo_auto`, `debate_user_declined_auto_promote`, `debate_invalidated_by_correction`, `debate_solo_round_capped`, `debate_round_truncated`. **All MUST be added to `VALID_ACTIVITY_EVENTS as const`** *(refined: codebase C2/C3)*.
- **Agent-md schema**: every `.claude/agents/*.md` has frontmatter with `name`, `description`, `tools` (CSV STRING), `model`, plus pickle-extension fields `role`, `identity`, `communication_style`, `principles[]`. Schema enforced by `tests/agent-md-schema.test.js`.

### Appendix Updated Risk Register *(refined: risk C2/C3 — R5 reconciled, R21–R33 added)*

| ID | Risk | Severity | Mitigation | Verification |
|:---|:---|:---|:---|:---|
| R5 (revised) | P3 confidence is structural, not numeric | High | 4 structural predicates per P3.8; no threshold; band display optional | Unit tests per predicate |
| R9 | Atomic restructure across heterogeneous file ops | High | Apply-ledger replay-reverse via `change_proposal_<date>_apply.log` | Integration test for partial-failure |
| R12 | Schema migration mid-session | Med | v3 forward-compat-only; SchemaVersionMismatchError | Round-trip tests |
| R13 | Mid-iteration manifest swap race | High | `tickets_version` monotonic counter; iteration boundary fence | Race test |
| R16 | Codex auto-promote-to-`--solo` | Med | CUJ-7; `--strict-teams` opt-out | Test |
| R20 | Multi-round debate token amplification | Med | Latest-first truncation; 600w/800w caps; round confirm | Token-budget assertion |
| R21 (NEW) | Compound orchestrator-turn cost (~155 turns/25-ticket epic) | High | Per-ticket and per-epic `orchestrator_turn_count` telemetry; alert >180/epic | `/pickle-metrics` surfaces; alert fixture |
| R22 (NEW) | Calibration corpus governance | Med | Versioned baselines; recalibration triggers; drift >5% blocks merge | `tests/calibration-baseline-drift.test.js` |
| R23 (NEW) | P2.7 flag-flip is unauditable | Med | Flag-flip requires committed baseline; CI test asserts baseline-before-flip | `tests/feature-flag-baseline.test.js` |
| R24 (NEW) | Unattended `--auto-apply` mid-iteration data-loss | Med | `--auto-apply` waits for next iteration boundary; activity event records wait | Race test |
| R25 (NEW) | `/pickle-correct-course` during refinement | Low | Detect `PICKLE_REFINEMENT_LOCK=1`; force claude with note | Test |
| R26 (NEW) | P4 codex `--solo` round amplification (5200+ words) | High | Codex `--solo` round cap = 2 hard | Round-3 codex test fails |
| R27 (NEW) | `--strict-teams` flag persistence across `--resume` | High | Stored in `state.json.flags.strict_teams` | Resume test |
| R28 (NEW) | Codex format drift detection | High | P0.10 session-boot version smoke check | `tests/codex-version-smoke.test.js` |
| R29 (NEW) | Mid-debate course-correct orphans round-2 priors | High | Round-N entry pre-flight on `tickets_version`; halt unless `--accept-stale` | Test |
| R30 (NEW) | P0 doesn't re-run after `course_corrected` | Critical | Delta-mode P0 invoke on `tickets_version` bump; `readiness_failed_post_correction` halts | Integration test |
| R31 (NEW) | Per-phase `model` defaults silently sonnet | Critical | Per-phase model defaults explicit (phase-implementer/verifier=opus); behavioral A/B vs v1.55.0 baseline | `tests/behavioral/phase-personas/quality-vs-baseline.test.js` |
| R32 (NEW) | install.sh during session corrupts schema migration | High | SchemaVersionMismatchError on read-after-write | Test: simulate mid-session bump |
| R33 (NEW) | P0.5 recycle-hint infinite loop | Med | Hard cap `cycle_history.length ≤ 3`; halt with escalation file | Test |

### Appendix Verification Strategy

- **Type**: `npx tsc --noEmit` clean.
- **Lint**: `npx eslint src/ --max-warnings=-1` clean. `pickle/promise-token-format` zero errors.
- **Test**: `npm test` passes. All P0/P1/P2/P3/P4 unit tests in default suite. `tests/template-no-bare-tokens.test.js` passes against new templates.
- **Behavioral**: `npm run test:behavioral` runs P2.7 distinctness, P3 confidence-stability, R31 quality-vs-baseline. Manual or nightly. Fail-closed on budget.
- **Schema**: `tests/agent-md-schema.test.js` passes against all 14 deployed agent-md files (8 phase + 1 corrector + 4 debater + 1 review). State.json v3 round-trip.
- **Calibration**: `npm run calibrate:readiness`, `npm run calibrate:correct-course`, `npm run calibrate:archaeology` documented; required pre-PR for heuristic file changes; drift gate `tests/calibration-baseline-drift.test.js`.
- **Dual-path integration**: P0 three integration points; P1 dual injection; P2 6 distinct Agent calls per ticket (teams) + persona block in worker prompt (legacy); P3 `buildJudgeInvocation` in both modes; P4 teams parallel + codex `--solo` + `--strict-teams` fail-fast.
- **End-to-end**: Full epic on fixture project; both `/pickle` (legacy) and `/pickle --teams` paths.

### Appendix Hidden Assumptions

- A11: `model` frontmatter defaults documented per-phase (R31).
- A12: Calibration corpora versioned under `tests/__fixtures__/` (R22).
- A13: `state.json.flags` documented schema field; new flags add own keys (R12 + R27).
- A14: `--auto-apply` is iteration-boundary-aware, not instantaneous (R24).
- A15: Codex format drift detection in-scope via P0.10 (R28).
- A16: Per-phase `model` documented in agent-md frontmatter AND `phase-personas.json` AND PRD_GUIDE.md (R31 + Codebase C3).

### Appendix Source Material

- BMAD checkout: `/tmp/bmad-dive/BMAD-METHOD` (v6.4.0, SHA `1197122`)
- Pickle Rick foundations: `prds/pickle-agent-teams.md` (P2/P4 spawning), `prds/codex-classifier-prompt-leak.md` (token discipline), `services/promise-tokens.ts`, `services/backend-spawn.ts` `buildJudgeInvocation()`, `validate-teams-ticket.ts` `findMissingPrefixes` pattern, v1.55.0 SHA `a4662df`
- 3-cycle 3-analyst refinement transcripts at `${SESSION_ROOT}/refinement/`

### Appendix Implementation Task Breakdown

| Order | ID | Title | Priority | Entry | Exit | Files |
|---|---|---|---|---|---|---|
| 10 | (T01) | Promote findMissingPrefixes to artifact-validation.ts | High | v1.55.0 | service exists, validate-teams-ticket.ts wraps | 4 |
| 20 | (T02) | Promote extractAssistantContent to classifier-utils.ts | High | v1.55.0 | service exists, mux-runner re-exports | 3 |
| 30 | (T03) | Schema migration v2→v3 (all new fields) | High | T01,T02 | state-manager v3 round-trips | 3 |
| 40 | (T04) | check-readiness.ts with 5 alignment checks | High | T01,T03 | bin exits 0/1/2; readiness_<date>.md | 4 |
| 50 | (T05) | Wire P0 into 3 integration points + delta-mode | High | T04 | refinement, mux-runner, pickle.md call gate | 4 |
| 60 | (T06) | /pickle-readiness --history + cycle cap | Med | T03,T04 | --history prints; cycle 4 halts | 3 |
| 70 | (T07) | project-types.csv + project-type-classifier service | High | T03 | 10 fixtures classify ≥90% | 4 |
| 80 | (T08) | archaeology.ts bin + project-context.md schema | High | T07,T02 | bin produces context file | 4 |
| 90 | (T09) | Archaeology dual-path injection (subprocess + brief) | High | T08 | spawn-morty preamble; pickle.md brief | 4 |
| 100 | (T10) | Archaeology auto-refresh + flags | Med | T08 | --refresh, --no-archaeology, --project-type honored | 3 |
| 110 | (T11) | phase-personas.json + 6 agent-md files | High | T03 | 6 files exist; phase-personas.json schema | 4 |
| 120 | (T12) | agent-md-loader service + .pickle-managed overlay + install migration | High | T11 | loader resolves overlay; install.sh migrates | 4 |
| 130 | (T13) | spawn-morty.ts persona injection (insertion order) | High | T12 | 6 sections byte-ordered | 3 |
| 140 | (T14) | pickle.md Phase 3.B per-phase dispatcher | High | T11,T12 | 6 distinct Agent calls per ticket | 3 |
| 150 | (T15) | PICKLE_PHASE_PERSONAS env flag + behavioral falsifiability | High | T13,T14 | flag default off; baseline.json gate | 4 |
| 160 | (T16) | morty-course-corrector.md + correct-course.ts brief-prep | High | T03 | corrector agent-md; bin writes brief | 4 |
| 170 | (T17) | transaction-ticket-ops service | High | T03 | updateTicketStatusInTransaction, materializeNewTicket, replayReverseLedger | 3 |
| 180 | (T18) | Composite lock + tickets_version fence + apply-ledger | High | T17 | atomic restructure; ledger format | 4 |
| 190 | (T19) | --recover-from-ledger + --recover --force + CUJ-6 | High | T18 | both flags work; HALT file | 4 |
| 200 | (T20) | Structural confidence (4 predicates) + current_ticket invariants + circuit breaker | High | T18 | 4 predicates; 3 branches; CB suggestion | 4 |
| 210 | (T21) | 4 debater agent-md files + generation script | High | T03 | 4 files committed; gen script | 3 |
| 220 | (T22) | debate.ts brief-prep + pickle-debate.md orchestrator | High | T21 | bin writes brief; skill spawns | 4 |
| 230 | (T23) | --solo + --strict-teams persistence + auto-promote | High | T22 | CUJ-7; flags persist; codex fail-fast | 4 |
| 240 | (T24) | --continue multi-round + R29/R26 caps | High | T22,T18 | round fence; codex round cap=2 | 4 |
| 250 | (T25) | Hang guards (4 hang-guard tests) + Configuration Reference docs | Med | T04,T08,T16,T22 | 4 hang-guard tests; PRD_GUIDE updated | 5 |
| 260 | (T26) | Codex format pin smoke check (P0.10) | High | T03 | session boot logs codex_version_seen | 3 |
| 270 | (T27) | Calibration corpus governance + drift detection | Med | T07 | 3 baseline.json; drift test | 3 |
| 280 | (T28) | Flag interaction matrix test | Med | T15,T18,T22 | matrix enumerated; combos asserted | 2 |
| 290 | (W) | Wire: integrate all modules into working pickle-rick-claude | High | T01-T28 | full epic runs both paths | many |
| 300 | (H1) | Harden: code quality review of feature area | High | W | zero P0-P1 violations | many |
| 310 | (H2) | Audit: data flow integrity for feature area | High | H1 | zero CRITICAL/HIGH findings | many |
| 320 | (H3) | Harden: test quality review of feature area | High | H2 | every AC has test | many |
| 330 | (H4) | Audit: cross-reference consistency for feature area | High | H3 | zero CRITICAL/HIGH cross-ref | many |

> **Appendix task-ID note**: This Appendix section's `(T01)`–`(T28)` numbering is BMAD-internal and does NOT collide with citadel core tasks T0–T17 / T20–T23. They are namespaced — Appendix `(T17)` refers to `transaction-ticket-ops service`, citadel core `T17` refers to the refinement-time machinability gate. Refer to Appendix tasks as `BMAD-T01` … `BMAD-T28` when discussed in PR descriptions to disambiguate.

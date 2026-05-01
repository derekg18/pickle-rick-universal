# BDD Scenarios for Pickle-Dot Auto-Patterns
# Generated from pipeline author's perspective for 18 auto patterns

## Pattern 0a: Dependency Setup (setup_deps)

### Scenario 0a.1: Basic dependency installation
Given a pipeline author who defines any spec with at least one phase
When the builder generates the pipeline
Then it automatically includes a setup_deps node for dependency installation
And setup_deps appears after start and before the first phase's impl node
And setup_deps has no incoming edges from non-start nodes

### Scenario 0a.2: Package manager detection
Given a pipeline author who defines a spec in a project with package-lock.json
When the builder generates the pipeline
Then setup_deps.tool_command attempts npm install first, then pnpm, then yarn

### Scenario 0a.3: No duplicate setup_deps
Given a multi-phase pipeline
When the builder generates the pipeline
Then exactly one setup_deps node exists (shared across all phases)

---

## Pattern 0b: Parallel Limit (max_parallel=1)

### Scenario 0b.1: Fan-out parallel limit
Given a pipeline author who uses component fan-out (two or more independent phases)
When the pipeline is generated
Then each component node has max_parallel=1 to prevent resource conflicts
And split_phases node has shape=component with max_parallel="1"

### Scenario 0b.2: No fan-out, no max_parallel injection
Given a pipeline author who defines sequential phases (all have dependsOn)
When the pipeline is generated
Then no max_parallel attribute is injected on any node
And no split_phases/merge_phases nodes appear in the output

---

## Pattern 0c: Baseline Snapshot (capture_baseline)

### Scenario 0c.1: Baseline capture on every pipeline
Given any spec with at least one phase
When the builder generates the pipeline
Then it includes a capture_baseline node that snapshots lint and typecheck error counts
And capture_baseline appears after setup_deps and before the first impl node

### Scenario 0c.2: Baseline capture content
Given capture_baseline node exists
When the builder generates it
Then its tool_command captures TypeScript error count to /tmp/baseline_ts_errors.txt
And its tool_command captures ESLint error count to /tmp/baseline_lint_errors.txt
And fallback echo 0 is used if grep fails

### Scenario 0c.3: Zero-phase pipeline baseline
Given a zero-phase spec (phases=[])
When the builder generates the pipeline
Then capture_baseline is NOT emitted (no phases to verify)

---

## Pattern 0d: Delta-Aware Verify

### Scenario 0d.1: Delta-aware lint verification
Given a pipeline author who defines phases
When verify_lint nodes are generated
Then they compare against the baseline to detect regressions (delta-aware)
And command prepends: BASELINE=$(cat /tmp/baseline_lint_errors.txt 2>/dev/null || echo 0) &&
And command appends: && CURRENT=$(...) && [ $CURRENT -le $BASELINE ]

### Scenario 0d.2: Delta-aware typecheck verification
Given a pipeline author who defines phases
When verify_types nodes are generated
Then they compare against the baseline to detect regressions (delta-aware)
And command prepends: BASELINE=$(cat /tmp/baseline_ts_errors.txt 2>/dev/null || echo 0) &&
And command appends: && CURRENT=$(...) && [ $CURRENT -le $BASELINE ]

### Scenario 0d.3: Zero-phase no delta verify
Given a zero-phase spec
When the builder generates the pipeline
Then no verify_lint or verify_types nodes are emitted

---

## Pattern 0e: Progress Gate (check_progress)

### Scenario 0e.1: Progress gate after each impl
Given a pipeline author who defines phases
When the builder generates the pipeline
Then each phase gets a check_progress node to detect stalled implementations
And check_progress appears after impl and before verify_lint

### Scenario 0e.2: Git status command
Given check_progress node exists for a phase
When the builder generates it
Then its tool_command is: cd ${WORKING_DIR} && [ $(git status --porcelain | wc -l) -gt 0 ] && echo 'STATUS: SUCCESS' || echo 'STATUS: FAIL'

### Scenario 0e.3: Read-only with max_visits
Given check_progress node exists
When the builder generates it
Then it has read_only=true
And it has max_visits=3

### Scenario 0e.4: Non-git directory behavior
Given a spec in a non-git directory
When check_progress runs
Then it exits non-zero (git status fails) and outputs STATUS: FAIL
This correctly flags no progress detection

---

## Pattern 1: Test-Fix Loops (diamond gate)

### Scenario 1.1: Test-fix loop per phase
Given a pipeline author who defines a phase
When the builder generates the pipeline
Then it creates a test-fix loop with diamond gate for iterative correction
And topology: verify_types → test_${phase} (diamond) → fix_${phase} → impl_${phase}

### Scenario 1.2: Diamond edge coverage
Given test diamond node exists for a phase
When the builder validates
Then it has at least 2 outgoing edges: success→next, fail→fix_${phase}

### Scenario 1.3: Max visits on fix loop
Given nodes in test-fix loop
When the builder finalizes the pipeline
Then fix_${phase} and impl_${phase} get max_visits=5 to prevent infinite loops

---

## Pattern 3: Conditional Routing (diamond nodes)

### Scenario 3.1: Diamond edge requirement
Given any generated diamond node
When the builder validates
Then it ensures at least 2 outgoing edges covering success/fail outcomes

### Scenario 3.2: Diamond outcome labels
Given a diamond node in a retry loop
When the builder generates it
Then edges have outcome attributes: [outcome="success"], [outcome="fail"], etc.

---

## Pattern 4: Parallel Fan-Out/Fan-In

### Scenario 4.1: Independent phase fan-out
Given a pipeline author who defines 2+ phases with no dependencies between them
When the builder generates the pipeline
Then it creates a fan-out topology with split/merge nodes for parallel execution
And topology: start→...→split_phases→phase1, phase2...→merge_phases→...

### Scenario 4.2: Mixed dependency topology
Given phases A (no deps), B (no deps), C (dependsOn: ["A"])
When the builder generates the pipeline
Then split_phases→A, B in parallel→merge_phases→C (C waits for merge)

### Scenario 4.3: All-dependent phases (no fan-out)
Given phases A, B, C where all have dependsOn chains and no independent phases
When the builder generates the pipeline
Then no split_phases/merge_phases nodes are emitted
And phases are serialized with direct edges following dependency order

---

## Pattern 6: Max Visits (retry loop protection)

### Scenario 6.1: Max visits injection on retry edges
Given nodes with incoming retry edges
When the builder finalizes the pipeline
Then it injects max_visits to prevent infinite loops
And default max_visits=5 (unless already set by another pattern)

### Scenario 6.2: Pattern 0e takes precedence
Given a check_progress node (max_visits=3 from Pattern 0e)
When the builder applies Pattern 6
Then it does NOT overwrite the existing max_visits value

### Scenario 6.3: Trigger condition
Given a node has incoming edge from diamond non-success outcome
When the builder finalizes
Then it injects max_visits (pattern 6 triggers)

---

## Pattern 6b: Read-Only + STATUS

### Scenario 6b.1: Read-only on review nodes
Given review nodes exist (conformance, scope_check, security_scan, etc.)
When the builder finalizes
Then it ensures read_only=true and STATUS markers in prompts

### Scenario 6b.2: STATUS marker injection
Given a review node prompt exists
When the builder finalizes
Then it appends: "\\nOutput STATUS: SUCCESS or STATUS: FAIL on its own line."

### Scenario 6b.3: Review node classification
Given nodes with class="review"
When the builder validates
Then all such nodes have read_only=true

---

## Pattern 10: Scope Creep (scope_check)

### Scenario 10.1: Scope check after impl
Given each implementation phase
When the builder generates the pipeline
Then it adds a scope_check node after impl to verify file changes are in-scope
And topology: impl → check_progress → scope_check → conformance

### Scenario 10.2: Scope check attributes
Given scope_check node exists
When the builder generates it
Then it has class="review", read_only=true
And its prompt compares git diff against allowed_paths

### Scenario 10.3: Failure routing
Given scope_check detects out-of-scope files
When it fails
Then it routes to fix_${phase} (retry loop)

---

## Pattern 13: Lint Gate

### Scenario 13.1: Lint gate in verify chain
Given the verify chain
When generated, Then it includes a lint gate to catch style regressions
And topology: check_progress → verify_lint → verify_types → test

### Scenario 13.2: Delta-aware lint
Given verify_lint node exists
When the builder generates it
Then it uses delta-aware command (compares against baseline)

---

## Pattern 14: Type-Check Gate

### Scenario 14.1: Typecheck gate in verify chain
Given the verify chain
When generated, Then it includes a typecheck gate to catch type regressions
And topology: verify_lint → verify_types → test

### Scenario 14.2: Delta-aware typecheck
Given verify_types node exists
When the builder generates it
Then it uses delta-aware command (compares against baseline)

---

## Pattern 15: Conformance Audit

### Scenario 15.1: Conformance node per phase
Given each phase
When the builder generates the pipeline
Then it adds a conformance audit node to verify spec compliance
And topology: scope_check → conformance_${phase}

### Scenario 15.2: Conformance attributes
Given conformance_${phase} node exists
When the builder generates it
Then it has class="review", read_only=true, timeout="15m"
And its prompt reviews implementation against phase spec and PRD requirements

### Scenario 15.3: AC key placement
Given conformance_${phase} sets context_on_success
When the builder validates
Then Tier 1 explicit keys from PhaseSpec.contextOnSuccess appear here

---

## Pattern 21: Fix All

### Scenario 21.1: Fix all before verify final
Given the final pipeline structure
When generated, Then fix_all precedes verify_final as a last-resort repair step
And topology: fix_all → verify_final (direct, no ratchet re-entry)

### Scenario 21.2: Cross-phase attributes
Given fix_all node exists
When the builder generates it
Then it has class="codergen", timeout="30m", shape="box"
And allowed_paths = union of all phase allowedPaths
And escalate_on = union of all phase escalateOn values

### Scenario 21.3: Graph-level retry_target
Given the pipeline graph
When generated
Then graph-level retry_target="fix_all"
And verify_final has retry_target="fix_all"

---

## Pattern 22: Permission Scoping

### Scenario 22.1: Allowed paths on impl nodes
Given code-generation nodes (per-phase and cross-phase)
When the builder generates the pipeline
Then it injects allowed_paths and permission scoping for safety

### Scenario 22.2: Per-phase allowed_paths
Given per-phase impl node exists
When the builder generates it
Then allowed_paths comes from PhaseSpec.allowedPaths
And test directories are included (heuristic: tests/, __tests__/)

### Scenario 22.3: Cross-phase inheritance
Given fix_all, fix_review, verify_final nodes exist
When the builder generates them
Then allowed_paths = union of all phase allowedPaths
And escalate_on = union of all phase escalateOn values
And permission_mode="auto"

---

## Pattern 23: Defense Matrix

### Scenario 23.1: Comment block generation
Given any generated pipeline
When .build() completes
Then it includes a defense matrix comment block documenting which safety layers are active
And block format: /* DEFENSE MATRIX\n * competitive: ... */

### Scenario 23.2: specDriven computation
Given the pipeline has phases
When defense matrix is computed
Then specDriven reflects active patterns: "conformance" | "BDD + conformance" | "spec_file + conformance" | "spec_file + BDD + conformance"

### Scenario 23.3: Guardrails collection
Given the pipeline has retry loops and read_only nodes
When defense matrix is computed
Then guardrails includes: "max_visits", "no-op", "read_only" (as applicable)

---

## Pattern 25: Catastrophic Recovery

### Scenario 25.1: Loop restart edge
Given a pipeline with retry loops
When the builder generates the pipeline
Then it adds a catastrophic recovery edge to prevent infinite retry cascades
And edge: verify_final → setup_deps with loop_restart=true

### Scenario 25.2: Trigger condition
Given the pipeline has retry loops (nodes with incoming retry edges)
When .build() completes
Then catastrophic recovery edge is emitted

### Scenario 25.3: Zero-phase carve-out
Given a zero-phase pipeline
When .build() completes
Then catastrophic recovery edge is NOT emitted (explicit exception)

---

## Summary Statistics

- Total auto patterns covered: 18 (0a, 0b, 0c, 0d, 0e, 1, 3, 4, 6, 6b, 10, 13, 14, 15, 21, 22, 23, 25)
- Total scenarios: 47
- Zero-phase edge cases: 4 (0c, 0d, 25, implicit in Pattern 4)
- Pattern preconditions: 5 (0b fan-out, 4 parallel phases, 6/6b/25 retry loops, 25 non-zero-phase)

STATUS: SUCCESS
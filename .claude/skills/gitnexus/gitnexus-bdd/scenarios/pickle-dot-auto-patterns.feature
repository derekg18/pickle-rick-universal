# Pickle-Dot Codegen Builder - Auto-Pattern BDD Scenarios
# From pipeline author's perspective
# Generated: 2026-04-05

Feature: Pickle-Dot Codegen Builder Auto-Patterns
  As a pipeline author,
  I want the DOT builder to automatically include safety and structure patterns
  So that I don't have to remember every composition rule

  Background:
    Given a pipeline author defines a valid BuilderSpec
    When the builder generates the pipeline via .build()
    Then the output DOT file includes all applicable auto-patterns

  # Pattern 0a: Dependency Setup - Always included
  Scenario: 0a - Dependency Setup node is automatically included
    Given a pipeline author defines any spec with at least one phase
    When the builder generates the pipeline
    Then it automatically includes a setup_deps node for dependency installation
    And setup_deps has tool_command that detects package manager (npm/pnpm/yarn)

  # Pattern 0b: Parallel Limit - Only when fan-out active
  Scenario: 0b - Parallel Limit on fan-out nodes
    Given a pipeline author uses component fan-out (Pattern 4 - ≥2 independent phases)
    When the pipeline is generated
    Then each component node has max_parallel=1 to prevent resource conflicts
    And the builder records Pattern 0b in patternsApplied

  # Pattern 0c: Baseline Snapshot - Always included
  Scenario: 0c - Baseline Snapshot captures error counts
    Given any spec with at least one phase
    When the builder generates the pipeline
    Then it includes a capture_baseline node that snapshots lint and typecheck error counts
    And capture_baseline writes baseline counts to /tmp/baseline_lint_errors.txt and /tmp/baseline_ts_errors.txt

  # Pattern 0d: Delta-Aware Verify - Always included
  Scenario: 0d - Delta-aware verify nodes compare against baseline
    Given a pipeline author defines phases with verify_lint and verify_types
    When verify nodes are generated
    Then they compare against the baseline to detect regressions (delta-aware)
    And the verify commands are wrapped with BASELINE=$(cat /tmp/baseline_*.txt 2>/dev/null || echo 0) && ... && CURRENT=$(...) && [ $CURRENT -le $BASELINE ]

  # Pattern 0e: Progress Gate - Always included per phase
  Scenario: 0e - Progress Gate detects stalled implementations
    Given a pipeline author defines phases
    When the builder generates the pipeline
    Then each phase gets a check_progress node to detect stalled implementations
    And check_progress has read_only=true and max_visits=3

  # Pattern 1: Test-Fix Loops - Always included per phase
  Scenario: 1 - Test-Fix loop with diamond gate for iterative correction
    Given a pipeline author defines a phase (not docOnly)
    When the builder generates the pipeline
    Then it creates a test-fix loop with diamond gate for iterative correction
    And the diamond has edges: outcome=success → next, outcome=fail → fix → back to impl

  # Pattern 3: Conditional Routing - Diamond edges
  Scenario: 3 - Diamond nodes always have at least 2 outgoing edges
    Given any generated diamond node
    When the builder validates
    Then it ensures at least 2 outgoing edges covering success/fail outcomes
    And the builder throws BuildError if any diamond has <2 outgoing edges

  # Pattern 4: Fan-Out Topology - Parallel execution
  Scenario: 4 - Fan-out topology for independent phases
    Given a pipeline author defines 2+ phases with no dependencies between them
    When the builder generates the pipeline
    Then it creates a fan-out topology with split_phases/merge_phases nodes for parallel execution
    And split_phases has shape=component, max_parallel=1
    And merge_phases has shape=tripleoctagon

  # Pattern 6: Max Visits - Loop bound injection
  Scenario: 6 - Max Visits prevents infinite loops
    Given nodes with incoming retry edges (diamond fail branches or retry_target references)
    When the builder finalizes the pipeline
    Then it injects max_visits=5 to prevent infinite loops
    And nodes that already have max_visits (e.g., Pattern 0e sets 3) retain their value

  # Pattern 6b: Read-Only + STATUS - Review safety
  Scenario: 6b - Read-Only nodes have STATUS markers
    Given review nodes (class="review")
    When the builder finalizes
    Then it ensures read_only=true and STATUS markers in prompts
    And the builder appends "Output STATUS: SUCCESS or STATUS: FAIL on its own line." to review prompts

  # Pattern 10: Scope Creep - In-scope verification
  Scenario: 10 - Scope check after implementation verifies file changes
    Given each implementation phase
    When the builder generates the pipeline
    Then it adds a scope_check node after impl to verify file changes are in-scope
    And scope_check has class="review", read_only=true, and checks git diff against allowed_paths

  # Pattern 13: Lint Gate - Style regression detection
  Scenario: 13 - Lint gate in verify chain catches style regressions
    Given the verify chain for a phase
    When generated
    Then it includes a verify_lint_${phase} node to catch style regressions
    And verify_lint uses the delta-aware BASELINE+CURRENT comparison pattern

  # Pattern 14: Type-Check Gate - Type regression detection
  Scenario: 14 - Type-check gate in verify chain catches type regressions
    Given the verify chain for a phase
    When generated
    Then it includes a verify_types_${phase} node to catch type regressions
    And verify_types uses the delta-aware BASELINE+CURRENT comparison pattern

  # Pattern 15: Conformance Audit - Spec compliance
  Scenario: 15 - Conformance audit verifies spec compliance
    Given each phase
    When the builder generates the pipeline
    Then it adds a conformance_${phase} node to verify spec compliance
    And conformance has class="review", read_only=true, and checks files modified, API contracts, regressions

  # Pattern 21: Fix All - Last-resort repair
  Scenario: 21 - Fix All precedes verify_final as last-resort repair
    Given the final pipeline structure
    When generated
    Then fix_all precedes verify_final as a last-resort repair step
    And fix_all is a cross-phase codergen node with union of all phase allowed_paths
    And graph-level retry_target points to fix_all

  # Pattern 22: Permission Scoping - Safety boundaries
  Scenario: 22 - Permission scoping injects allowed_paths and escalate_on
    Given code-generation nodes (class="codergen")
    When the builder generates the pipeline
    Then it injects allowed_paths and permission scoping for safety
    And per-phase nodes get allowed_paths from PhaseSpec.allowedPaths (with test dir heuristic)
    And cross-phase nodes (fix_all, verify_final) get union of all phase allowed_paths

  # Pattern 23: Defense Matrix - Safety layer documentation
  Scenario: 23 - Defense matrix comment block documents active safety layers
    Given any generated pipeline
    When .build() completes
    Then it includes a defense matrix comment block documenting which safety layers are active
    And the block includes: competitive, guardrails, specDriven, permissions, adversarial

  # Pattern 25: Catastrophic Recovery - Infinite retry cascade prevention
  Scenario: 25 - Catastrophic recovery edge prevents infinite retry cascades
    Given a pipeline with retry loops (nodes with incoming diamond fail edges or retry_target)
    When the builder generates the pipeline
    Then it adds a loop_restart edge from verify_final to setup_deps
    And the edge is annotated with loop_restart=true
    And zero-phase pipelines do NOT get catastrophic recovery (explicit carve-out)

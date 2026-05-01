# BDD Validation Scenarios for Pickle-Dot Codegen Builder

Generated from pipeline author perspective for all 15 structural rules.

## Rule 1: INVALID_STRUCTURE (single start/exit)

### Scenario 1.1: Missing start node (Mdiamond)
```
Given a pipeline author who omits the start node (Mdiamond shape)
When the builder validates the DOT output
Then it reports INVALID_STRUCTURE with severity 'error'
And diagnostic includes: "Pipeline must have exactly one start node (Mdiamond)"
```

### Scenario 1.2: Missing exit node (Msquare)
```
Given a pipeline author who omits the exit node (Msquare shape)
When the builder validates the DOT output
Then it reports INVALID_STRUCTURE with severity 'error'
And diagnostic includes: "Pipeline must have exactly one exit node (Msquare)"
```

### Scenario 1.3: Multiple start nodes
```
Given a pipeline author who creates two nodes with shape=Mdiamond
When the builder validates the DOT output
Then it reports INVALID_STRUCTURE with severity 'error'
And diagnostic includes: "Pipeline must have exactly one start node (Mdiamond)"
```

### Scenario 1.4: Multiple exit nodes
```
Given a pipeline author who creates two nodes with shape=Msquare
When the builder validates the DOT output
Then it reports INVALID_STRUCTURE with severity 'error'
And diagnostic includes: "Pipeline must have exactly one exit node (Msquare)"
```

## Rule 2: START_HAS_INCOMING

### Scenario 2.1: Edge points to start node
```
Given a pipeline author who routes an edge into the start node
When the builder validates the DOT output
Then it reports START_HAS_INCOMING with severity 'error'
And diagnostic includes: "Start node must have no incoming edges"
And diagnostic references the source node ID and target='start'
```

### Scenario 2.2: Edge from setup_deps to start
```
Given a pipeline author who incorrectly places setup_deps before start
When the builder validates the DOT output
Then it reports START_HAS_INCOMING with severity 'error'
And diagnostic includes: "Start node must have no incoming edges"
```

## Rule 3: UNREACHABLE_NODE

### Scenario 3.1: Node not reachable from start
```
Given a pipeline author who creates a node with no path from start
When the builder validates the DOT output
Then it reports UNREACHABLE_NODE with severity 'error'
And diagnostic includes: "Node 'X' is unreachable from start"
And diagnostic references the unreachable node ID
```

### Scenario 3.2: Isolated phase due to missing merge_phases
```
Given a pipeline author who creates parallel phases without merge_phases
When the builder validates the DOT output
Then it reports UNREACHABLE_NODE with severity 'error'
And diagnostic references nodes after the split but before the merge
```

## Rule 4: DIAMOND_MISSING_EDGES

### Scenario 4.1: Diamond with only one outgoing edge
```
Given a pipeline author who creates a diamond gate with only one outgoing edge
When the builder validates the DOT output
Then it reports DIAMOND_MISSING_EDGES with severity 'error'
And diagnostic includes: "Diamond node must have at least 2 outgoing edges"
And diagnostic references the diamond node ID
```

### Scenario 4.2: Diamond with no outgoing edges
```
Given a pipeline author who creates a diamond with zero outgoing edges
When the builder validates the DOT output
Then it reports DIAMOND_MISSING_EDGES with severity 'error'
And diagnostic includes: "Diamond node must have at least 2 outgoing edges"
```

### Scenario 4.3: Conditional routing diamond
```
Given a pipeline author who creates a check_${name} diamond with only success edge
When the builder validates the DOT output
Then it reports DIAMOND_MISSING_EDGES with severity 'error'
And diagnostic includes: "Diamond node must have at least 2 outgoing edges"
```

## Rule 5: GOAL_GATE_NO_MAX_VISITS

### Scenario 5.1: goal_gate node without max_visits
```
Given a pipeline author who sets goal_gate=true without max_visits
When the builder validates the DOT output
Then it reports GOAL_GATE_NO_MAX_VISITS with severity 'error'
And diagnostic includes: "Node with goal_gate=true must have max_visits attribute"
And diagnostic references the goal-gated node ID
```

### Scenario 5.2: goal_gate node with zero max_visits
```
Given a pipeline author who sets goal_gate=true with max_visits=0
When the builder validates the DOT output
Then it reports GOAL_GATE_NO_MAX_VISITS with severity 'error'
And diagnostic includes: "max_visits must be > 0 for goal_gate nodes"
```

## Rule 6: MISSING_AC_MAPPING

### Scenario 6.1: Acceptance criteria key with no context_on_success source
```
Given a pipeline author whose acceptance_criteria references a key with no context_on_success source
When the builder validates the DOT output
Then it reports MISSING_AC_MAPPING with severity 'error'
And diagnostic includes: "AC key \"X\" has no context_on_success source"
And diagnostic lists the missing key
```

### Scenario 6.2: Custom acceptance criteria key
```
Given a pipeline author with acceptance_criteria: { "auth_secure": "true" }
And no phase has contextOnSuccess: { "auth_secure": "..." }
When the builder validates the DOT output
Then it reports MISSING_AC_MAPPING with severity 'error'
And diagnostic references: "auth_secure"
```

### Scenario 6.3: Tier 2 key not set anywhere
```
Given a pipeline author with acceptance_criteria containing types_compile=true
And verify_final does not have types_compile in context_on_success
When the builder validates the DOT output
Then it reports MISSING_AC_MAPPING with severity 'error'
And diagnostic references: "types_compile"
```

## Rule 7: MISSING_TIMEOUT

### Scenario 7.1: Code-generation node without timeout
```
Given a pipeline author who omits timeout on a code-generation node (class=codergen)
When the builder validates the DOT output
Then it reports MISSING_TIMEOUT with severity 'error'
And diagnostic includes: "Node 'X' is class=codergen but lacks timeout attribute"
And diagnostic references the node ID
```

### Scenario 7.2: Impl node without timeout
```
Given a pipeline author who creates impl_${phase} without timeout
When the builder validates the DOT output
Then it reports MISSING_TIMEOUT with severity 'error'
And diagnostic references: "impl_${phase}"
```

### Scenario 7.3: Fix node without timeout
```
Given a pipeline author who creates fix_${phase} without timeout
When the builder validates the DOT output
Then it reports MISSING_TIMEOUT with severity 'error'
And diagnostic references: "fix_${phase}"
```

## Rule 8: PROMPT_PATH_MISMATCH

### Scenario 8.1: Prompt references file outside allowed_paths
```
Given a pipeline author whose prompt references a file outside allowed_paths
When the builder validates the DOT output
Then it reports PROMPT_PATH_MISMATCH with severity 'warning'
And diagnostic includes: "Prompt references path outside allowed_paths"
And diagnostic lists the disallowed path
```

### Scenario 8.2: Prompt references /etc/hosts when allowedPaths is ['src/**']
```
Given a pipeline author with allowedPaths: ["src/**"]
And prompt contains reference to "/etc/hosts"
When the builder validates the DOT output
Then it reports PROMPT_PATH_MISMATCH with severity 'warning'
And diagnostic references: "/etc/hosts"
```

## Rule 9: REVIEW_MISSING_READONLY

### Scenario 9.1: Review node without read_only=true
```
Given a pipeline author who creates a review node without read_only=true
When the builder validates the DOT output
Then it reports REVIEW_MISSING_READONLY with severity 'error'
And diagnostic includes: "Node 'X' is class=review but missing read_only=true"
And diagnostic references the review node ID
```

### Scenario 9.2: Review node missing STATUS marker
```
Given a pipeline author who creates a review node with read_only=true but no STATUS marker in prompt
When the builder validates the DOT output
Then it reports REVIEW_MISSING_READONLY with severity 'error'
And diagnostic includes: "Node 'X' class=review must have STATUS marker in prompt"
And diagnostic references the review node ID
```

### Scenario 9.3: Security scan node without defenses
```
Given a pipeline author who creates security_scan_${phase} without read_only=true
When the builder validates the DOT output
Then it reports REVIEW_MISSING_READONLY with severity 'error'
And diagnostic references: "security_scan_${phase}"
```

## Rule 10: COMPONENT_NO_MERGE

### Scenario 10.1: Component node without matching tripleoctagon
```
Given a pipeline author who creates a shape=component node without a matching shape=tripleoctagon
When the builder validates the DOT output
Then it reports COMPONENT_NO_MERGE with severity 'error'
And diagnostic includes: "Component node 'X' has no matching tripleoctagon merge node"
And diagnostic references the component node ID
```

### Scenario 10.2: Fan-out without merge
```
Given a pipeline author who creates split_phases node but omits merge_phases
When the builder validates the DOT output
Then it reports COMPONENT_NO_MERGE with severity 'error'
And diagnostic references: "split_phases"
```

## Rule 11: FAN_OUT_SCOPE_LEAK

### Scenario 11.1: retry_target escapes component boundary
```
Given a pipeline author who sets retry_target to escape the component boundary
When the builder validates the DOT output
Then it reports FAN_OUT_SCOPE_LEAK with severity 'error'
And diagnostic includes: "retry_target escapes component boundary"
And diagnostic references both the retry_target and component scope
```

### Scenario 11.2: Component retry_target pointing to external node
```
Given a pipeline author with retry_target="fix_all" inside a component's retry loop
When the builder validates the DOT output
Then it reports FAN_OUT_SCOPE_LEAK with severity 'error'
And diagnostic includes: "retry_target escapes component boundary"
```

## Rule 12: WORKSPACE_NO_HTTPS

### Scenario 12.1: Isolated workspace with HTTP repo URL
```
Given a pipeline author who configures workspace isolation with HTTP repo URL
When the builder validates the DOT output
Then it reports WORKSPACE_NO_HTTPS with severity 'error'
And diagnostic includes: "workspace='isolated' requires HTTPS repo_url"
And diagnostic references the non-HTTPS URL
```

### Scenario 12.2: Isolated workspace with git:// URL
```
Given a pipeline author with workspaceOpts.repoUrl: "git://github.com/org/repo.git"
When the builder validates the DOT output
Then it reports WORKSPACE_NO_HTTPS with severity 'error'
And diagnostic references: "git://github.com/org/repo.git"
```

### Scenario 12.3: Workspace without repoUrl is valid
```
Given a pipeline author who sets workspace='isolated' without repoUrl
When the builder validates the DOT output
Then it does NOT report WORKSPACE_NO_HTTPS
And the workspace attribute is emitted without repo_url
```

## Rule 13: WORKSPACE_NO_PUSH

### Scenario 13.1: Isolated workspace without commit_and_push
```
Given a pipeline author who configures workspace='isolated' without commit_and_push node
When the builder validates the DOT output
Then it reports WORKSPACE_NO_PUSH with severity 'error'
And diagnostic includes: "workspace='isolated' requires commit_and_push node"
```

### Scenario 13.2: Missing commit_and_push on success path
```
Given a pipeline author with isolated workspace but commit_and_push placed incorrectly
When the builder validates the DOT output
Then it reports WORKSPACE_NO_PUSH with severity 'error'
And diagnostic includes: "workspace='isolated' requires commit_and_push node"
```

## Rule 14: PLAN_MODE_DEADLOCK

### Scenario 14.1: permission_mode='plan' in headless pipeline
```
Given a pipeline author who sets permission_mode='plan' in a headless pipeline
When the builder validates the DOT output
Then it reports PLAN_MODE_DEADLOCK with severity 'error'
And diagnostic includes: "permission_mode='plan' deadlocks headless pipelines"
And diagnostic notes: "Use permission_mode='auto' or 'escalate_on' for headless mode"
```

### Scenario 14.2: CI/CD execution with plan mode
```
Given a pipeline configured for CI/CD execution with permission_mode='plan'
When the builder validates the DOT output
Then it reports PLAN_MODE_DEADLOCK with severity 'error'
And diagnostic includes: "permission_mode='plan' deadlocks headless pipelines"
```

## Rule 15: MISSING_ALLOWED_PATHS

### Scenario 15.1: Per-phase impl node without allowed_paths
```
Given a pipeline author who creates an impl node without allowed_paths
When the builder validates the DOT output
Then it reports MISSING_ALLOWED_PATHS with severity 'error'
And diagnostic includes: "Per-phase codergen impl node 'X' lacks allowed_paths"
And diagnostic references the impl node ID
```

### Scenario 15.2: Fix node without allowed_paths
```
Given a pipeline author who creates fix_${phase} without allowed_paths
When the builder validates the DOT output
Then it reports MISSING_ALLOWED_PATHS with severity 'error'
And diagnostic references: "fix_${phase}"
```

### Scenario 15.3: Cross-phase nodes get warning (not error)
```
Given a pipeline author with empty allowedPaths across all phases
When the builder validates the DOT output
Then it does NOT report MISSING_ALLOWED_PATHS for cross-phase nodes
And it emits a warning diagnostic for fix_all and verify_final
```

---

## Validation Rule Summary Table

| Rule Code | Severity | Trigger | Node/Component Affected |
|-----------|----------|---------|------------------------|
| INVALID_STRUCTURE | error | start/exit count ≠ 1 | Pipeline-level |
| START_HAS_INCOMING | error | start node has incoming edges | start node |
| UNREACHABLE_NODE | error | node not reachable from start | Any node |
| DIAMOND_MISSING_EDGES | error | diamond has <2 outgoing edges | Diamond nodes |
| GOAL_GATE_NO_MAX_VISITS | error | goal_gate without max_visits | goal-gated nodes |
| MISSING_AC_MAPPING | error | AC key has no context_on_success | Graph-level AC |
| MISSING_TIMEOUT | error | codergen node lacks timeout | class=codergen nodes |
| PROMPT_PATH_MISMATCH | warning | prompt refs outside allowed_paths | Any node |
| REVIEW_MISSING_READONLY | error | review node lacks read_only+STATUS | class=review nodes |
| COMPONENT_NO_MERGE | error | component lacks tripleoctagon | shape=component nodes |
| FAN_OUT_SCOPE_LEAK | error | retry_target escapes component | Component boundary |
| WORKSPACE_NO_HTTPS | error | isolated workspace + non-HTTPS URL | Workspace config |
| WORKSPACE_NO_PUSH | error | isolated workspace without commit_and_push | Isolated workspace |
| PLAN_MODE_DEADLOCK | error | permission_mode='plan' in headless | Headless pipeline |
| MISSING_ALLOWED_PATHS | error | per-phase impl lacks allowed_paths | Per-phase impl nodes |

## Notes for Pipeline Authors

1. **Validation is comprehensive**: The builder enforces all 15 rules before generating DOT output
2. **Fix loop support**: If validation fails, the fix loop (max 3 attempts) allows automatic correction
3. **Warning vs Error**: Warnings (PROMPT_PATH_MISMATCH) don't block build; errors block build and require fix
4. **Diagnostic format**: Each diagnostic includes `rule`, `severity`, `message`, and optional `nodeId`/`edge`/`fix` fields
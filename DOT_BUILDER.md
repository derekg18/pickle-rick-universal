# 🏗️ DotBuilder — Programmatic DOT Codegen for /pickle-dot

`/pickle-dot` builds DOT pipelines by default via the `DotBuilder` TypeScript class — a schema-validated codegen path that enforces 32 active patterns and 15 structural validation rules and produces deterministic output. Use `--builder` to explicitly opt into the builder (e.g., when a global config overrides it), or `--legacy` to fall back to prompt-only generation for a specific run.

```bash
/pickle-dot my-prd.md              # Builder codegen path (default)
/pickle-dot --builder my-prd.md    # Explicit opt-in to builder (same as default)
/pickle-dot --legacy my-prd.md     # Prompt-only fallback — rollback for a single run
```

## Builder API

```typescript
import { DotBuilder } from '~/.claude/pickle-rick/extension/services/dot-builder.js';

// Static factory — validates and parses the spec, then returns a builder instance
const builder = DotBuilder.fromSpec(spec);  // throws BuildError on invalid spec

// Fluent chain — call build() once; calling it again throws ALREADY_BUILT
const result = builder.build();
// result: BuildResult {
//   dot: string,              — the complete DOT digraph string
//   slug: string,             — URL-safe pipeline identifier
//   patternsApplied: string[] — Tier 1/2 patterns auto-applied (e.g. ["test_fix_loop","fan_out"])
//   defenseMatrix: {          — Layer coverage summary
//     competitive: boolean,   — Pattern 18 (competing impls) applied
//     specDriven: string,     — "ALL" | "PARTIAL" | "NONE" (conformance nodes present)
//     adversarial: boolean,   — Pattern 17 (red team) applied
//   },
//   diagnostics: Diagnostic[] — warnings/infos from validation (non-blocking)
// }
```

## BuilderSpec JSON

```jsonc
{
  "slug": "auth_refactor",              // required — URL-safe, lowercase underscores
  "goal": "Refactor auth module",       // required — single-sentence goal
  "phases": [                           // required — list of implementation phases (may be [] for microverse-only)
    {
      "name": "implement",              // required — lowercase underscores; must be unique
      "prompt": "...",                  // required — full impl instruction; agent has NO access to the PRD
      "allowedPaths": ["src/auth/"],    // required — glob patterns for permission scoping
      "dependsOn": ["research"],        // optional — phase names this phase depends on; omit for parallel fan-out
      "goalGate": true,                 // optional — Pattern 2: verify progress before continuing
      "timeout": "30m",                 // optional — per-phase duration string (default: "30m")
      "securityScan": true,             // optional — Pattern 8: npm audit node after progress gate
      "coverageTarget": 80,             // optional — Pattern 9: numeric coverage % gate
      "competing": true,                // optional — Pattern 18: fan-out to two competing impls
      "redTeam": true,                  // optional — Pattern 17: adversarial review after conformance
      "bddScenarios": true,             // optional — Pattern 16b: Given/When/Then scenario generation
      "specFirst": true,                // optional — Pattern 16: write tests before impl (default: true when goalGate)
      "docOnly": false,                 // optional — suppress verify chain for doc-only phases
      "escalateOn": ["package.json"],   // optional — files that trigger escalation (default: ["package.json","*.lock","*.config.*"])
      "contextOnSuccess": {             // optional — custom AC keys emitted by this phase's conformance node
        "auth_secure": "true"
      }
    }
  ],
  "acceptanceCriteria": {               // required — exit gate conditions
    "tests_pass": "true",               //   Tier 2 keys (auto-sourced): tests_pass, lint_clean, types_compile,
    "lint_clean": "true",               //     cli_contract, determinism, validation_rules
    "auth_secure": "true"               //   Tier 1 keys (custom): must appear in a phase's contextOnSuccess
  },
  "workingDir": "${WORKING_DIR}",       // optional — attractor resolves at runtime
  "specFile": "/repos/myapp/prd.md",    // optional — path to PRD; interpolated as $spec_file in node prompts
  "reviewRatchet": 2,                   // optional — min consecutive clean review passes (must be ≥ 2)
  "workspace": "isolated",             // optional — omit for shared (default)
  "workspaceOpts": {                    // required when workspace: "isolated"
    "repoUrl": "https://github.com/org/repo.git",  // HTTPS required (not SSH)
    "repoBranch": "main",
    "cleanup": "preserve"              // "preserve" (default) | "delete"
  },
  "microverse": {                       // optional — numeric optimization loop (replaces impl/verify chain)
    "name": "bundle_opt",
    "opts": {
      "prompt": "...",
      "measureCommand": "npm run build 2>/dev/null && wc -c < dist/bundle.js",
      "target": 819200,
      "direction": "reduce",            // "reduce" | "improve"
      "allowedPaths": ["src/**"]
    }
  },
  "modelStylesheet": {                  // optional — model tier overrides
    "defaultModel": "claude-sonnet-4-6",
    "criticalModel": "claude-opus-4-6",
    "reviewModel": "claude-opus-4-6"
  },
  "convergence": {                      // optional — Pattern 32 iterative convergence loop (replaces phases)
    "until": "V_total == 0 && fixed_point && reproducibility",  // predicate from canonical set
    "impl": { "harness": "hermes" },    // required — default harness for fix nodes
    "maxIterations": 6,                 // default: 6 — max body executions before non-convergence declared
    "maxVisits": 5,                     // default: 5 — per-converge-node visit budget
    "timeout": "21600s",                // default: 21600s — overall converge node timeout
    "convergenceEpsilon": 100,          // default: 100 — V_total threshold for convergence declaration
    "fixBackend": {                     // optional — override fix_backend node
      "model": "provider/model-id",
      "harness": "hermes",
      "prompt": "...",
      "timeout": "3600s",
      "maxVisits": 10
    },
    "fixFrontend": {                    // optional — override fix_frontend node (same shape as fixBackend)
      "model": "provider/model-id",
      "harness": "hermes",
      "prompt": "..."
    },
    "mechanicalGates": {                // optional — override mechanical gate tool_commands
      "buildApi": "cd /repos/app/packages/api && npx tsc --noEmit 2>&1 && echo 'api typecheck pass'",
      "testsApi": "cd /repos/app/packages/api && npm test --silent 2>&1 && echo 'api tests pass'",
      "buildUi": "cd /repos/app/packages/ui && npx tsc --noEmit 2>&1 && echo 'ui typecheck pass'",
      "lint": "cd /repos/app && npx eslint packages/api/src --max-warnings=0 2>&1 && echo 'lint pass'"
    },
    "reviewers": {                      // optional — override reviewer node attrs
      "be": { "model": "provider/model-id", "harness": "hermes", "prompt": "..." },
      "fe": { "model": "provider/model-id", "harness": "hermes", "prompt": "..." },
      "int": { "model": "provider/model-id", "harness": "hermes", "prompt": "..." }
    },
    "adversary": {                      // optional — override adversary node
      "model": "provider/model-id",
      "harness": "hermes",
      "prompt": "...",
      "sealedFromSource": "packages/api/src/**,packages/ui/app/**"
    },
    "fpVerify": {                       // optional — override fp_verify goal gate
      "command": "set -o pipefail; cd /repos/app && npm install 2>&1 | tail -3 && cd packages/api && npx tsc --noEmit && npm test && cd ../ui && npx tsc --noEmit && echo 'fixed-point verified'",
      "timeout": "900s",
      "maxVisits": 5
    },
    "reproVerify": {                    // optional — override repro_verify goal gate
      "command": "set -o pipefail; cd /repos/app && rm -rf packages/api/node_modules packages/ui/node_modules && npm install 2>&1 | tail -3 && cd packages/api && npx tsc --noEmit && npm test && cd ../ui && npx tsc --noEmit && echo 'reproducibility verified'",
      "timeout": "900s",
      "maxVisits": 5
    }
  }
}
```

## CLI Contract

The builder binary reads `BuilderSpec` JSON from stdin and writes to stdout/stderr:

```bash
echo '<BuilderSpec JSON>' | node ~/.claude/pickle-rick/extension/bin/dot-builder.js
```

| Exit | Stream | Payload |
|---|---|---|
| `0` | stdout | `BuildResult` JSON — `{ dot, slug, patternsApplied, defenseMatrix, diagnostics }` |
| `1` | stderr | `BuildError` JSON — `{ error: BuildErrorCode, message, diagnostics }` — validation failure, recoverable |
| `2` | stderr | `{ error: "UNEXPECTED_ERROR", message }` — I/O or parse failure, not recoverable |

## Fix-Loop and `.dot.draft` Files

When the builder exits 1, `/pickle-dot` enters an automatic fix loop. It reads the `diagnostics` array from stderr, applies minimum-scope fixes to the `BuilderSpec`, and re-invokes the CLI. The loop tracks the best attempt (fewest errors) and reverts to it after 2 consecutive non-improvements. After 3 total failed iterations without improvement:

1. The best `BuilderSpec` output is saved as `./<slug>.dot.draft`
2. All remaining diagnostics with their `.fix` hints are listed
3. The loop stops — manual intervention required

Re-run after fixing: `/pickle-dot <prd>`. The `.dot.draft` file is not a valid pipeline — do not submit it to `/attract` until errors are resolved.

**Legacy (prompt-only) path:** `/pickle-dot --legacy` also runs a post-save validate-fix loop with the same convergence guard, invoking the attractor validator CLI (`bun packages/attractor/src/cli.ts validate`) on the emitted raw DOT. On exhaustion it saves the best attempt as `./<slug>.dot.draft`. If the validator CLI is unavailable (attractor root not detected), the loop is skipped and the initial DOT is saved as-is with a warning.

**Validation error codes:** `EMPTY_SLUG`, `EMPTY_GOAL`, `DUPLICATE_PHASE`, `INVALID_SPEC`, `MISSING_AC_MAPPING`, `MISSING_TIMEOUT`, `INVALID_TIMEOUT`, `MISSING_ALLOWED_PATHS`, `INVALID_ALLOWED_PATHS`, `PROMPT_PATH_MISMATCH`, `INVALID_STRUCTURE`, `START_HAS_INCOMING`, `UNREACHABLE_NODE`, `DIAMOND_MISSING_EDGES`, `FAN_OUT_SCOPE_LEAK`, `GOAL_GATE_NO_MAX_VISITS`, `REVIEW_MISSING_READONLY`, `WORKSPACE_NO_HTTPS`, `WORKSPACE_NO_PUSH`, `PLAN_MODE_DEADLOCK`, `COMPONENT_NO_MERGE`, `INVALID_RATCHET`, `NON_NUMERIC_TARGET`, `ALREADY_BUILT`, `DUPLICATE_MODEL`, `INVALID_CONVERGENCE_SPEC`

See also: [Pickle Rick README](README.md), [PRD Writing Guide](PRD_GUIDE.md).

---
name: gitnexus-bdd
description: "Use when authoring, reviewing, or validating BDD scenarios for pickle-dot auto-patterns and codegen builder behavior. Examples: \"Write a Given/When/Then scenario for Pattern 4 fan-out\", \"Verify the auto-pattern scenarios match builder behavior\", \"Generate BDD scenarios for a new builder pattern\""
---

# BDD Scenarios for Pickle-Dot Auto-Patterns

## When to Use

- Authoring new Given/When/Then scenarios for pickle-dot builder auto-patterns
- Reviewing existing scenarios against current `dot-builder.ts` behavior
- Cross-checking whether a builder change breaks documented pattern contracts
- Generating scenarios from the pipeline-author perspective for a new opt-in feature

## Reference Material

Three coordinated BDD scenario artifacts describe the builder's auto-pattern behavior:

| File | Format | Perspective |
|---|---|---|
| `prds/bdd-scenarios-auto-patterns.md` | Markdown | Implementation detail (node attrs, builder internals) |
| `.claude/bdd-scenarios/auto-patterns.md` | Markdown | Pipeline author (observable behavior) |
| `.claude/skills/gitnexus/gitnexus-bdd/scenarios/pickle-dot-auto-patterns.feature` | Gherkin `.feature` | Machine-readable, pipeline author |

Always reconcile all three when modifying scenarios — drift between them hides builder regressions.

## Workflow

```
1. READ the relevant PRD in prds/ (source of truth for what the pattern does)
2. READ the current scenario files (all three above)
3. READ extension/src/services/dot-builder.ts to find the pattern's emission code
4. WRITE the scenario in all three formats if adding new, or update each if changing
5. VERIFY by tracing a sample BuilderSpec through the pattern mentally
```

## Scenario Authoring Conventions

- **Pattern numbering**: Match the builder's `patternsApplied` set (0a, 0b, 0c, ..., 1, 2, 3, ..., 20, 21, 22, 23, 25)
- **Given**: describe the BuilderSpec input precondition (phase count, flags, attributes)
- **When**: always `the builder generates the pipeline` or `.build()` completes
- **Then**: describe exactly one observable node, edge, or attribute — one scenario per assertion
- **And**: stack related assertions below the primary `Then`

## Anti-Patterns

- Scenarios that test `dot-builder.ts` internals (private methods, intermediate state) — use unit tests instead
- Scenarios that depend on attractor runtime behavior — those belong in attractor's test suite
- Scenarios without a specific pattern number — every scenario must map to a numbered pattern in the PRD
- Multiple assertions compressed into one `Then` with `And` over 5 levels — decompose into separate scenarios

## Related

- `prds/pickle-dot-codegen-builder.md` — source PRD describing all patterns
- `extension/tests/auto-pattern-bdd-scenarios.test.js` — executable test coverage for these scenarios
- `.claude/commands/pickle-dot-patterns.md` — pattern reference used at runtime by `/pickle-dot`

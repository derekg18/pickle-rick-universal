Return the skeleton-only deploy rollback safety contract.

# /phoenix-person

Return a typed JSON-style skeleton for deploy rollback planning. v1 is intentionally skeleton-only: it returns `status: not_implemented`, `artifact`, and `skeleton`, with `skeleton.started: false` and an empty `artifact.executed_actions` list.

## Usage

```bash
/phoenix-person [workspace] [--env <name>] [--rollback]
```

Rollback, destructive, or execution flags return `status: needs_followup` unless explicitly confirmed. Confirmation does not run a rollback in v1; it only acknowledges that the caller has reviewed the typed safety boundary.

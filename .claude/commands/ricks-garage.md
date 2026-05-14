Prepare a deterministic local dev bootstrap environment plan.

# /ricks-garage

Build a plan-first local development bootstrap artifact and return a JSON-style command result with `status`, `summary`, `artifact`, and `plan`. The plan includes services, environment variables, seed steps, validation checks, and planned actions derived from the workspace fixture and command flags.

## Usage

```bash
/ricks-garage [workspace] [--env <name>] [--service <name>] [--env-var KEY=VALUE] [--seed <name>]
```

Destructive or execution flags such as `--run`, `--apply`, `--destroy`, or `--no-dry-run` return `status: needs_followup` unless the caller explicitly confirms the risk with `--confirm` or `--force`. The default path writes a plan artifact only and starts no services.

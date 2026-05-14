Prepare a nested-container devstack validation plan without starting containers.

# /microverse-battery

Validate a requested nested-container or service-graph setup and return a JSON-style command result with `status`, `summary`, `artifact`, and `plan`. The command is plan-first: it emits services, environment variables, seed steps, validation checks, and planned actions, but it does not start Docker, nested containers, or external processes by default.

## Usage

```bash
/microverse-battery [workspace] [--env <name>] [--service <name>] [--env-var KEY=VALUE] [--seed <name>] [--nested-container]
```

Unsafe execution flags such as `--run`, `--container`, `--apply`, `--destroy`, or `--no-dry-run` return `status: needs_followup` unless the caller explicitly passes `--confirm` or `--force`. Even with confirmation, v1 records nested-container intent as validation-only and keeps `artifact.executed_actions` empty.

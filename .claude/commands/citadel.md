Post-implementation conformance audit against the PRD, branch diff, and known trap doors.

# /citadel

Run Citadel after implementation and before deeper review phases. The command audits the current branch against a PRD and reports branch-wide conformance findings.

## Usage

```bash
/citadel --prd <prd_path> [--diff <base..head>] [--strict] [--report <path>] [--print-stubs]
```

## Arguments

- `--prd <prd_path>`: Required unless invoked by a pipeline session with `state.prd_path`.
- `--diff <base..head>`: Diff range to audit. Defaults to `state.start_commit..HEAD` when available.
- `--strict`: Exit non-zero on High findings as well as Critical findings.
- `--report <path>`: Write the JSON report to this path. Pipeline invocations write `<session>/citadel_report.json`.
- `--print-stubs`: Print `node:test` skeletons for unguarded trap doors without modifying files.

## Audit Surface

Citadel reads the PRD, changed files, command/session state, and sibling phase artifacts when present. It reports labelled findings for PRD acceptance coverage, endpoint contract drift, trap-door coverage, sibling route divergence, state-machine drift, frontend prop drift, cross-phase findings, and diff-shape hygiene.

Reports are versioned JSON with `schema: "1.0"` plus a console summary grouped by Citadel section. The command surfaces findings only; it does not auto-edit source files.

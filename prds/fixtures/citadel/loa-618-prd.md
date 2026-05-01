# LOA-618 Fixture

## Architectural Decisions

- A1. Gate destructive retry actions behind a server-side allowlist.
- A11. Treat lender flag drift as an audit finding.
- The replay path keeps A12 active for parity checks.

## Acceptance Criteria

AC-FF-01 validates the happy path.

Nested prose says AC-CIT-ABC-9 must still be discovered outside a table.

## API Endpoints

| Endpoint | Purpose |
|---|---|
| GET /api/runs/{runId}/comparison | fetch comparison |
| POST /api/runs/{runId}/retry | retry failed extraction |

## VALID_ACTIONS

Add `retry_child_extraction` and `create_updated_run` to VALID_ACTIONS.

## lender_feature_flags

| key | value |
|---|---|
| comparison_retry_enabled | true |
| destructive_retry_guard | enforced |

## Enum Values

| enum | value |
|---|---|
| RunAction | retry_child_extraction |
| RunAction | create_updated_run |

## Status Codes

| Endpoint | Status | Error message |
|---|---|---|
| GET /api/runs/{runId}/comparison | 404 | "Comparison not found" |
| POST /api/runs/{runId}/retry | 409 | error message: Retry is already running |

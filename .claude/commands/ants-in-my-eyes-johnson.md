Prepare an accessibility audit report plan.

Run this command when the user needs deterministic accessibility checks across target pages and viewport fixtures.

The command returns a JSON-style command result with `status`, `summary`, `artifact.report_path`, and `audit.matrix` rows for accessibility, keyboard, and contrast checks. Missing accessibility tooling returns `status: needs_followup` with an install remediation command, and the command reports planned checks rather than launching external audits by default.

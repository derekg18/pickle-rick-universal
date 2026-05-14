Prepare a benchmark and load-profile report plan.

Run this command when the user needs benchmark metrics, load-profile planning, or performance report artifacts without starting live load tests by default.

The command returns a JSON-style command result with `status`, `summary`, `artifact.report_path`, deterministic metric rows, and a benchmark plan. Missing benchmark tools return `status: needs_followup` with an install remediation command. External URL load targets must be passed explicitly with `--target` or `--url`; otherwise the command reports follow-up instead of starting a load test.

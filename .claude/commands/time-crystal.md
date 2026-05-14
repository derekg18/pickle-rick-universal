Prepare a bundle and build timing report plan.

Run this command when the user needs deterministic bundle metrics, build timing shape, or skipped/build scope output from fixtures.

The command returns a JSON-style command result with `status`, `summary`, `artifact.report_path`, metric rows, and build-scope fields. Missing package tooling returns `status: needs_followup` with remediation, and report generation stays fixture-driven unless a later executor explicitly runs the emitted plan.

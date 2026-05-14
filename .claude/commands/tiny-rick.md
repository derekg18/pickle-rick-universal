Prepare a build optimization report plan.

Run this command when the user needs a deterministic build-scope report from changed-file fixtures.

The command returns a JSON-style command result with `status`, `summary`, `artifact.report_path`, `build.build_set`, and `build.skipped`. Missing build tools return `status: needs_followup` with install or environment remediation, and the command writes report artifacts instead of running a live production build by default.

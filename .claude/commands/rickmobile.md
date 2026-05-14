Prepare a responsive frontend audit matrix.

Run this command when the user needs mobile or responsive frontend audit coverage across viewport fixtures.

The command returns a JSON-style command result with `status`, `summary`, `artifact.report_path`, and `audit.matrix` rows for each viewport. Invalid viewport arguments return a typed failure with remediation, and missing audit tools return `status: needs_followup` with an install command.

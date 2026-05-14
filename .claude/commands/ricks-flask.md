/ricks-flask prepares schema-driven mock seed previews and returns a command result.

Run `/ricks-flask --schema <json-or-file>` to parse a fixture schema and emit a preview-only seed artifact with `status`, `summary`, `artifact.plan_path`, rows, and referential checks.

The command writes no seed files by default. It returns deterministic output suitable for review before a later confirmed executor writes data.

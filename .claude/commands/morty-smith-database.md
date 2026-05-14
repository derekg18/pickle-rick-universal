/morty-smith-database prepares schema migration plan artifacts and returns a command result.

Run `/morty-smith-database --old-schema <json-or-file> --new-schema <json-or-file>` to emit a migration plan artifact with create, drop, add, remove, or alter operations.

The command does not apply migrations by default. Requests such as `--apply`, `--migrate`, or `--write` require explicit confirmation and otherwise return follow-up output.

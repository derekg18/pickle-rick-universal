/unity prepares package scaffold previews and returns a command result.

Run `/unity --target <dir> --name <package-name>` to emit a package scaffold plan artifact with manifest, source entrypoint, and README file entries.

The command does not write package files by default. A non-empty target fails with `TARGET_DIR_NOT_EMPTY` unless `--force` is explicit, and package writes require confirmation.

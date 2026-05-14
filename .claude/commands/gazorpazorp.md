/gazorpazorp prepares monorepo scaffold previews and returns a command result.

Run `/gazorpazorp --target <dir> --name <workspace-name>` to emit a monorepo plan artifact with root manifest, workspace config, and package manifest entries.

The command is preview-only by default. It returns `TARGET_DIR_NOT_EMPTY` for non-empty targets without `--force` and writes no packages unless a later confirmed executor is used.

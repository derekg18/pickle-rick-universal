/butter-robot prepares a minimal daemon scaffold preview and returns a command result.

Run `/butter-robot --target <dir> --task "<one task>"` to emit a preview-only daemon scaffold plan with `status`, `summary`, `artifact.plan_path`, and planned files such as `package.json`, `src/daemon.ts`, one task handler, and `README.md`.

The command is non-destructive by default. It writes no package files, starts no daemon, and returns `code: TARGET_DIR_NOT_EMPTY` when the target directory is non-empty unless `--force` is explicit.

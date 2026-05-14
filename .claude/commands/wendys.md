Return the skeleton-only destructive rollback safety contract.

Run the shared security/safety helper:

```bash
node "/Users/derekgreene/.gemini/extensions/pickle-rick/extension/bin/security-safety-command.js" wendys $ARGUMENTS
```

The command prints a JSON result with `status`, `summary`, `skeleton`, and `artifact`. In v1 it returns `skeleton_only: true`, `action: "none"`, and never applies destructive rollback or starts container, secret rotation, or syscall paths.

Return the skeleton-only secret rotation safety contract.

Run the shared security/safety helper:

```bash
node "/Users/derekgreene/.gemini/extensions/pickle-rick/extension/bin/security-safety-command.js" fleeb-juice $ARGUMENTS
```

The command prints a JSON result with `status`, `summary`, `skeleton`, and `artifact`. In v1 it returns `skeleton_only: true`, `action: "none"`, and never rotates secrets or starts container, rollback, or syscall paths.

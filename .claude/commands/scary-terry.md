Prepare a non-destructive API fuzz plan.

Run the shared security/safety helper:

```bash
node "/Users/derekgreene/.gemini/extensions/pickle-rick/extension/bin/security-safety-command.js" scary-terry $ARGUMENTS
```

The command prints a JSON result with `status`, `summary`, `fuzz.payload_matrix`, and `artifact`. It only returns a payload matrix plan and does not execute requests, containers, secret rotation, rollback actions, or syscalls.

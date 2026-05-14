Return the skeleton-only sandbox safety contract.

Run the shared security/safety helper:

```bash
node "/Users/derekgreene/.gemini/extensions/pickle-rick/extension/bin/security-safety-command.js" froopyland $ARGUMENTS
```

The command prints a JSON result with `status`, `summary`, `skeleton`, and `artifact`. In v1 it returns `reason: "SANDBOX_NOT_IMPLEMENTED"`, `skeleton_only: true`, `action: "none"`, and never starts sandbox containers or syscall paths.

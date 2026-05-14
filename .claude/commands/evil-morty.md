Prepare a non-destructive security review plan.

Run the shared security/safety helper:

```bash
node "/Users/derekgreene/.gemini/extensions/pickle-rick/extension/bin/security-safety-command.js" evil-morty $ARGUMENTS
```

The command prints a JSON result with `status`, `summary`, `review`, and `artifact`. It only returns a static review plan and does not execute containers, rotate secrets, apply rollback actions, or invoke syscalls.

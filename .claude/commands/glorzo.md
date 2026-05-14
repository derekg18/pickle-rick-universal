Prepare a focused runtime observability view.

Run the shared runtime observability helper:

```bash
node "/Users/derekgreene/.gemini/extensions/pickle-rick/extension/bin/runtime-observability.js" glorzo $ARGUMENTS
```

The command prints a JSON result with `status`, `summary`, `focus`, and `artifact`; missing workspace sources return `failed` with remediation.

Run runtime observability audit skeleton.

Run the shared runtime observability helper:

```bash
node "/Users/derekgreene/.gemini/extensions/pickle-rick/extension/bin/runtime-observability.js" galactic-federation $ARGUMENTS
```

The command prints a JSON result with `status`, `summary`, `audit`, and `artifact`; missing workspace sources return `failed` with remediation.

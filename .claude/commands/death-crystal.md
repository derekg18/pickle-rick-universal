Prepare a GitNexus impact-analysis artifact for a symbol.

Run the shared GitNexus command helper:

```bash
node "/Users/derekgreene/.gemini/extensions/pickle-rick/extension/bin/gitnexus-command-group.js" death-crystal $ARGUMENTS
```

The command prints a JSON result with `status`, `summary`, impact/query `artifact` requests, and stale-index remediation. A stale or missing GitNexus index returns `needs_followup` with `npx gitnexus analyze` guidance instead of predictive output.

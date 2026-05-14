Prepare a GitNexus dependency graph artifact.

Run the shared GitNexus command helper:

```bash
node "/Users/derekgreene/.gemini/extensions/pickle-rick/extension/bin/gitnexus-command-group.js" portal-fluid $ARGUMENTS
```

The command prints a JSON result with `status`, `summary`, dependency-query `artifact` data, and stale-index remediation when GitNexus must be refreshed.

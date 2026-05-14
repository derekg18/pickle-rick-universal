Prepare a GitNexus clone-analysis artifact skeleton.

Run the shared GitNexus command helper:

```bash
node "/Users/derekgreene/.gemini/extensions/pickle-rick/extension/bin/gitnexus-command-group.js" operation-phoenix $ARGUMENTS
```

The command prints a JSON result with `status`, `summary`, clone-query `artifact` data, and stale-index remediation when GitNexus must be refreshed.

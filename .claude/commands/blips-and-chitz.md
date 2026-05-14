Prepare a GitNexus coverage-analysis artifact skeleton.

Run the shared GitNexus command helper:

```bash
node "/Users/derekgreene/.gemini/extensions/pickle-rick/extension/bin/gitnexus-command-group.js" blips-and-chitz $ARGUMENTS
```

The command prints a JSON result with `status`, `summary`, coverage-query `artifact` data, and stale-index remediation when GitNexus must be refreshed.

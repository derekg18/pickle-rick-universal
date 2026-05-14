Supervise service log streams and return pane config.

Run the shared runtime observability helper:

```bash
node "/Users/derekgreene/.gemini/extensions/pickle-rick/extension/bin/runtime-observability.js" interdimensional-cable $ARGUMENTS
```

Pass one or more log specs as `service=/path/to/log`, separated by spaces or commas. The command prints a JSON result with `status`, `summary`, `pane_config`, and `artifact`; missing log sources return `failed` with remediation.

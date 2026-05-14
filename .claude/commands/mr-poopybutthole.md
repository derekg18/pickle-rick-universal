Return companion runtime session state.

Run the shared runtime observability helper:

```bash
PICKLE_SESSION_DIR="${PICKLE_SESSION_DIR:-$PWD}" node "/Users/derekgreene/.gemini/extensions/pickle-rick/extension/bin/runtime-observability.js" mr-poopybutthole $ARGUMENTS
```

The command prints a JSON result with `status`, `summary`, `companion`, and `artifact`; missing session sources return `failed` with remediation.

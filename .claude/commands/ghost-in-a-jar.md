Show skeleton-only runtime persistence contract.

Run the shared runtime observability helper:

```bash
node "/Users/derekgreene/.gemini/extensions/pickle-rick/extension/bin/runtime-observability.js" ghost-in-a-jar $ARGUMENTS
```

The command prints a JSON result with `status`, `summary`, `persistence`, and `artifact`. In v1 it returns `skeleton_only: true`, `action: "none"`, and does not start persistent containers.

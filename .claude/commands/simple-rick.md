Preview simplicity-focused refactor suggestions.

Run the shared quality/refactor helper:

```bash
node "/Users/derekgreene/.gemini/extensions/pickle-rick/extension/bin/quality-refactor-command.js" simple-rick $ARGUMENTS
```

The command prints a JSON result with `status`, `summary`, `preview`, and `artifact`. Default mode is preview-only; unsafe or missing targets return `failed` with remediation.

Preview regex search/replace changes with rollback artifacts.

Run the shared quality/refactor helper:

```bash
node "/Users/derekgreene/.gemini/extensions/pickle-rick/extension/bin/quality-refactor-command.js" squanch $ARGUMENTS
```

The command prints a JSON result with `status`, `summary`, `preview`, and `artifact`. Default mode is preview-only; apply requests fail unless explicitly confirmed after reviewing the preview and rollback artifact.

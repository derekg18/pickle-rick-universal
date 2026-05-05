Queue the current Pickle Rick session's PRD into the Pickle Jar for batch execution later.

```bash
SESSION_ROOT=$(node "/Users/derekgreene/.gemini/extensions/pickle-rick/extension/bin/get-session.js")
node "/Users/derekgreene/.gemini/extensions/pickle-rick/extension/services/jar-utils.js" add --session "$SESSION_ROOT"
```

If fails: report error. If succeeds: "Task jarred. Run `/pickle-jar-open` to execute later."

Queue the current Pickle Rick session's PRD into the Pickle Jar for batch execution later.

```bash
SESSION_ROOT=$(node "$HOME/.claude/pickle-rick/extension/bin/get-session.js")
node "$HOME/.claude/pickle-rick/extension/services/jar-utils.js" add --session "$SESSION_ROOT"
```

If fails: report error. If succeeds: "Task jarred. Run `/pickle-jar-open` to execute later."

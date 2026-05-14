---
name: pickle
description: Use when the user asks Codex to run Pickle Rick, /pickle, /pickle-tmux, /pickle-prd, /pickle-refine-prd, or the autonomous Pickle Rick coding loop.
---

# Pickle Rick Codex Bridge

This skill is the Codex plugin bridge for Pickle Rick. Treat the user's request as the arguments for the Pickle Rick command.

1. Read `../../commands/pickle.md` relative to this file and follow it as the authoritative command source.
2. If the request names another Pickle command, read the matching `../../commands/<command>.md` file and follow that command source instead.
3. Resolve the installed runtime by reading `../../runtime_root`. Runtime scripts and shared helpers live under that path.
4. Preserve the user's exact task text as the command arguments unless the user explicitly asks to modify it.
5. Before running any setup command, set `PICKLE_HOST_BACKEND=codex` unless the user explicitly passes `--backend`.

The `commands/` directory is installed beside this skill so Codex plugin and prompt surfaces can resolve the same command source.

For `/pickle-pipeline --team-flow full`, follow the installed command source and preserve the opt-in flag. Full SDLC Team Flow uses the ordered phases `product_intake`, `ready_gate`, `architecture_review`, `implementation`, `test_engineering`, `ci_simulation`, `code_review`, `security_risk_review`, `qa_acceptance`, `release_management`, and `retrospective`, with durable artifacts under `${SESSION_ROOT}/team-flow/`.

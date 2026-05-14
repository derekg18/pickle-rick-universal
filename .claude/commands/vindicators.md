Run fixture-driven multi-agent solver and judge workflow selection.

# /vindicators

Run `/vindicators "<problem>" [--solvers N] [--strategies name,name]` to create solver plans, emit one judge result, and return either the selected solution summary or a follow-up request.

## Result

Return a command result with `status: success` when the judge selects one solver. If the judge fixtures tie, return `status: needs_followup`, `code: JUDGE_TIE`, and the tied solver ids.

## Compatibility

Deprecated `/meeseeks` command surfaces route review-style requests here.

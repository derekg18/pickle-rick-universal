Show a Linear-keyed standup from Pickle Rick activity + Linear MCP cross-reference.

Persona active via CLAUDE.md. **SPEAK BEFORE ACTING**.

## Instructions

### Step 1: Run the activity helper

```bash
node ~/.claude/pickle-rick/extension/bin/standup.js $ARGUMENTS
```

If no arguments provided, defaults to `--days 1` (yesterday's activity). Save the output mentally — the user does NOT see it; you must surface findings yourself.

### Step 2: Pull Linear ground truth (parallel with Step 3)

The Linear team is `Loanlight-eng` (prefix `LOA-`). Use the Linear MCP — do NOT regex commits as your primary source.

```
mcp__plugin_linear_linear__list_issues
  assignee: "me"
  updatedAt: "-P{N+1}D"   // N = the --days value, +1 day of slack
  orderBy: "updatedAt"
  limit: 50
```

For each returned issue, capture: `identifier` (`LOA-NNN`), `title`, `state.name`, `completedAt`, `gitBranchName`, `updatedAt`.

### Step 3: Pull merged PRs (parallel with Step 2)

```bash
gh pr list --author "@me" --state merged --search "merged:>=$(date -v-{N}d +%Y-%m-%d)" --json number,title,headRefName,mergedAt --limit 30
```

(Run this in each loanlight repo directory the helper output references — typically `loanlight-api`, `loanlight-integrations`, `loanlight-app`. Skip `pickle-rick-claude` for the standup proper; its activity is internal churn.)

### Step 4: Join — Linear-first algorithm

For each Linear issue from Step 2, find its activity in priority order:
1. **Branch match**: any commit/session in the helper output with `branch === issue.gitBranchName` (strongest)
2. **PR title/headRef match**: any merged PR whose title or `headRefName` contains `issue.identifier`
3. **Commit-subject match**: any commit subject containing `issue.identifier`

A ticket with at least one match → goes in **Y:**. A ticket with no match but with `state in (Todo, In Progress)` → goes in **T:**.

Anything in helper output that doesn't map to a Linear ticket → drop, unless the user asked for raw output.

### Step 5: Format

Match the user's preferred style exactly. Plain text, no markdown headers, no project tags, no timestamp line:

```
Y:
 LOA-### — One terse sentence describing the user-visible outcome.
 LOA-### — One terse sentence.

T:
 LOA-### — Brief scope note in plain prose.
 LOA-### — Brief scope note (parenthetical only when useful, e.g. "infra").
```

**Rules:**
1. Lead each line with the Linear ticket ID. Em-dash separator preferred (` — `), but hyphen or no separator are both acceptable.
2. One short sentence per ticket. User-impact language (what changed for a user / admin / operator), not internal component names.
3. NO `**[project-tag]**` prefix. NO bold. NO timestamp header (`Gregory Dickson [8:14 AM]`). NO date range header.
4. Skip internal Pickle Rick churn (anatomy-park trap doors, szechuan decompositions, gate plumbing, microverse internals) — these don't belong in the team standup. They surface only if the user explicitly asks for `--raw` or "full output".
5. **Y:** = tickets with shipped activity in the window (commits/PRs/sessions matched). Use the Linear `state` to disambiguate done vs. in-flight.
6. **T:** = concrete next tickets (Todo / In Progress, assigned to user, recently updated). 3-6 items max — pick the ones most likely to be worked next.
7. Drift signal: if a ticket's code clearly shipped but the Linear status is still Todo/In Progress, mention it in the Y: line ("LOA-656 — UI Unit Details + Income Approach cards shipped (Linear still Todo)") so the user can update Linear.
8. **Translate jargon before writing.** If a PR title is jargon (matches `/szechuan|anatomy-park|trap door|microverse|plumbus|meeseeks|pickle|morty|council of ricks/i`, is shorter than 25 chars, or is a bare kebab-slug), run `gh pr view <N> --json title,body` and rewrite in user-impact language.
9. Teammate PRs (`## Teammate PRs merged` from the helper) are informational only. Never attribute to the user. Default: omit. If notable, append one footer line after **T:**: `Team shipped: <one-liner each, with author>`.
10. If the user asks for raw / full output, print the helper output verbatim instead of this format.

### Example

```
Y:
 LOA-618 — Appraisal Comparison hardened and rebased, PR reviewed/fixed/merged.
 LOA-697 — Fixed appraisal images.
 LOA-656 — 1025 Appraisal Extraction started.

T:
 LOA-692 — Migrate CLAUDE.md → AGENTS.md, point Claude at the agents files (infra)
 LOA-701 — Reducto bounding boxes to show field locations in doc viewer
 LOA-708 — Max Rules 100 on new client onboarding issue.
```

### Common usage
- `/pickle-standup` — yesterday's activity
- `/pickle-standup --days 0` — today's activity
- `/pickle-standup --days 3` — last 3 days
- `/pickle-standup --since 2026-02-25` — everything since Feb 25
- `/pickle-standup --raw` — bypass Linear cross-reference, print helper output verbatim

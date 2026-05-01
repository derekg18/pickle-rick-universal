# /pickle-debate

Run a Pickle Rick debate for a decision question.

Usage:

`/pickle-debate "<question>" [--personas r,a,i,s] [--n 4] [--solo] [--strict-teams] [--no-strict-teams] [--continue] [--confirm-multi-round] [--accept-stale]`

## Contract

- Use `extension/bin/debate.js` only as a brief-prep helper.
- The helper writes `${SESSION_ROOT}/debate_<date>_brief.md`.
- This command owns orchestration: create the team, launch debater agents, delete the team, and write `${SESSION_ROOT}/debate_<date>.md`.
- Do not edit `state.json`, `active`, or `completion_promise`.
- Do not synthesize a winner. Preserve one full section per persona.

## Steps

1. Resolve the active Pickle Rick session root and repository root.
2. Run:

   `node "$HOME/.claude/pickle-rick/extension/bin/debate.js" "<question>" --session-dir "$SESSION_ROOT" --repo-root "$PWD" [flags]`

3. Read the emitted brief path.
4. Create a debate team:

   `TeamCreate(name: "pickle-debate")`

5. Launch one parallel agent per selected persona from the brief:

   `Agent(subagent_type: "morty-debater-researcher", team_name: "pickle-debate", prompt: <600-word shared context + researcher task>)`

   `Agent(subagent_type: "morty-debater-architect", team_name: "pickle-debate", prompt: <600-word shared context + architect task>)`

   `Agent(subagent_type: "morty-debater-implementer", team_name: "pickle-debate", prompt: <600-word shared context + implementer task>)`

   `Agent(subagent_type: "morty-debater-skeptic", team_name: "pickle-debate", prompt: <600-word shared context + skeptic task>)`

   Only launch personas selected by the helper brief. Each prompt must instruct the persona to respond authentically, disagree when warranted, use only Read/Glob/Grep, and cap its response at 800 words.

6. After all agents complete, delete the team:

   `TeamDelete(name: "pickle-debate")`

7. Write `${SESSION_ROOT}/debate_<date>.md` with:

   - Header fields: question, mode, personas, brief path, generated timestamp.
   - One `## <Persona>` section per selected persona containing the unabridged response.
   - Optional deterministic header `## Disagreements with prior speakers` only when disagreement points are explicitly present.

## Solo Mode

When `--solo` is set, do not create a team. Roleplay the selected personas sequentially in the current context using the same section format and response caps.

On codex backend, when neither `--solo` nor `--strict-teams` is set, the helper auto-promotes to solo mode after printing the codex cost banner. Treat brief mode `solo (auto)` the same as explicit solo mode.

`--strict-teams` persists in `state.json.flags.strict_teams` for resumed sessions. `--no-strict-teams` overrides that persisted preference for the current invocation only.

## Continuation Rounds

When `--continue` is set, the helper fences entry against the round-1 `tickets_version` snapshot stored in `state.json.flags.debate`. If tickets changed, stop unless `--accept-stale` is present.

Round 3 and later require `--continue --confirm-multi-round`. Codex solo mode is capped at 2 rounds; switch to claude teams mode for deeper debates.

Use prior debate context from the helper brief. New personas added after round 1 receive the full round-1 priors with the note that they were not in round 1 and should read for context.

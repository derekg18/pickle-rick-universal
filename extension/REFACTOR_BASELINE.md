# Refactor Baseline

Date: 2026-04-26  
Analyst: Pickle Worker (Morty / Codex)

## Environment

- Git SHA: `aa18e5c13469db73bcdddde43a8ec325f24a819f`
- Claude CLI: `2.1.119 (Claude Code)`

## Baseline Checks

- `cd extension && npx eslint src/ 2>&1 | grep -c 'warning'`: `60`
- `cd extension && npx eslint src/ --max-warnings=-1`: exit `0` with `59` warnings and `0` errors
- `cd extension && npx tsc --noEmit`: exit `0`

## npm test

Commands:

```bash
cd extension && npm test 2>&1 | tail -12
cd extension && npm test 2>&1 | tail -1
```

Observed clean rerun facts:

- Full suite completed successfully at this SHA.
- Reporter summary recorded `2675` tests, `2675` passes, `0` failures.
- On this Node 25 reporter, the literal final line is `duration_ms`; the parseable pass count is still present in the same terminal summary.

Captured `tail -12` from the passing run:

```text
✔ worker-setup: exits with code 1 when cwd is not in sessions map (37.655833ms)
✔ worker-setup: --resume path takes priority over sessions map (38.262417ms)
✔ worker-setup: --resume with flag-like value falls through to sessions map (39.702208ms)
✔ worker-setup: exits with code 1 when mapped session dir does not exist on disk (39.106917ms)
ℹ tests 2675
ℹ suites 189
ℹ pass 2675
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 121504.289625
```

Captured `tail -1` from the same command form:

```text
ℹ duration_ms 120839.303125
```

Baseline verdict: `PASS` at `aa18e5c13469db73bcdddde43a8ec325f24a819f`. The suite is green and the pass count is recorded in this document for downstream ticket baselines.

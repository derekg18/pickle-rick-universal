# LOA-618 Replay Fixture

Synthesized minimal fixture for `tests/integration/loa-618-replay.test.js`.

## What it contains

A single-package pnpm workspace (`packages/api`) with fake toolchain scripts that
emit the exact error pattern found in the LOA-618 post-mortem:

| File | Pattern | Count |
|------|---------|-------|
| `test/image-extraction.service.spec.ts` | TS2352 (mock missing `transformToByteArray`) | 1 |
| `test/portal-appraisal.service.spec.ts` | `prettier/prettier` formatting drift | 60 |
| `test/audit-log.controller.ts` | `no-control-regex` | 2 |
| `test/processor.spec.ts` | `require-await` | 3 |
| `test/type-asserts.ts` | `@typescript-eslint/no-unnecessary-type-assertion` | 2 |

**Total**: 1 typecheck (TS2352) + 67 lint = 68 gate failures.

## How it works

The `typecheck` and `lint:quiet` scripts in `packages/api/package.json` are
Node CJS files (`scripts/fake-typecheck.cjs`, `scripts/fake-lint.cjs`) that
write canned output matching real tsc/ESLint text format and exit non-zero.
No `pnpm install` or internet access required — the scripts use only
`process.stderr`, `process.stdout`, and `process.exit`.

## Rebuilding the tarball

```bash
bash extension/tests/fixtures/loa-618-replay/build.sh
```

Run from the repo root. The script is deterministic (fixed mtime via
`--mtime` or equivalent on the target platform).

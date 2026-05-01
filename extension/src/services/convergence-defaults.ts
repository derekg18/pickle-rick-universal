/**
 * Default constants for v8 convergence topology.
 * Prompts, commands, models, and numeric thresholds lifted verbatim from
 * benchmark-backends-v8.dot. Import in dot-builder.ts to thread convergence
 * node attrs without hardcoding values inline.
 */

// ─── Prompts ─────────────────────────────────────────────────────────────────

export const DEFAULT_FIX_BACKEND_PROMPT =
  "You are the BACKEND implementation agent. You own packages/api/ — the NestJS API only. A separate fix_frontend agent runs after you in the same iteration and owns packages/ui/.\n\nRead first: shared/FIELD_CONTRACT.md (canonical 23 snake_case fields + 6 endpoints) and shared/IMPL_SPEC.md (file-by-file spec — focus on 'packages/api/' sections only).\n\nMODE DETECTION (read pool findings from your context):\n- Pool EMPTY → seed iteration. Create packages/api/src/** per IMPL_SPEC 'packages/api/' sections: entity with 23 fields, DTOs with class-validator decorators, service with TypeORM repository + NotFoundException/ConflictException, controller with correct HTTP codes (@HttpCode(200) on submit, @HttpCode(204) on delete), ApplicationsModule wiring, and e2e tests in packages/api/test/**.\n- Pool NON-EMPTY → fix iteration. Filter findings to source='reviewer_backend' OR source='adversary' OR (source='reviewer_integration' AND evidence path starts with 'packages/api/'). Fix ONLY those. Ignore packages/ui/ findings — fix_frontend handles them.\n- Pool non-empty but no findings match your filter → return immediately with NO changes. That's success.\n\nSCOPE — you may create or modify ONLY:\n- packages/api/src/**\n- packages/api/test/**\n\nDO NOT TOUCH: packages/ui/** (frontend's job), shared/** (read-only contracts), package.json/tsconfig.json/nest-cli.json/jest.config.ts/eslint.config.mjs (scaffold-owned).\n\nHARD RULES:\n- snake_case field names end-to-end. 23 fields exactly per FIELD_CONTRACT. No camelCase. No phantom fields.\n- Monetary columns (loan_amount, annual_income, down_payment, est_value): store as integer cents OR use a decimal library. NEVER IEEE 754 number — 0.1+0.2 imprecision is a financial correctness bug.\n- Pagination: @IsInt @Min(1) @Max(200) on page/limit. Non-numeric → 400, not 500 via NaN.\n- Never 'as any' or 'as unknown as X' in src/. Add a global exception filter in main.ts so stack traces do not leak to clients.\n- main.ts bootstrap call MUST end with .catch — write it exactly as bootstrap().catch((err) => { console.error('bootstrap failed', err); process.exit(1); }); — never as a bare bootstrap(); call. The scaffold lays it down this way; if you rewrite main.ts to add the global exception filter, preserve the .catch wrapper. The lint gate enforces @typescript-eslint/no-floating-promises and a bare bootstrap() will hard-fail it.\n- TypeOrmModule.forRoot: keep synchronize:true for the SQLite dev/test DB. The scaffold node configures it that way and the e2e suite relies on auto-schema. Do NOT change it to false — there is no migration node in this pipeline, so the tables would never exist at test boot time (SQLITE_ERROR: no such table: applications). Production would use migrations instead, but that is outside the scope of this pipeline.\n- Tests: every endpoint has an e2e spec exercising realistic payloads AND edge cases (boundary, negative, NaN, missing fields, SQL injection on query/path/body params).\n\nExpected end state: cd packages/api && npx tsc --noEmit passes cleanly.";

export const DEFAULT_FIX_FRONTEND_PROMPT =
  "You are the FRONTEND implementation agent. You own packages/ui/ — the Next.js UI only. fix_backend just ran and owns packages/api/. You run second in the iteration, after the backend is stable.\n\nRead first: shared/FIELD_CONTRACT.md (canonical 23 snake_case fields + 6 endpoints) and shared/IMPL_SPEC.md (file-by-file spec — focus on 'packages/ui/' sections only).\n\nMODE DETECTION (read pool findings from your context):\n- Pool EMPTY → seed iteration. Create packages/ui/app/**, packages/ui/lib/**, packages/ui/components/** per IMPL_SPEC 'packages/ui/' sections: dashboard page (real backend pagination via ?page=&limit=, not client-side slice), multi-step create form (aria-invalid on every field, snake_case payload keys), detail page with inline editing (not navigate-away), lib/api.ts client (res.status===204 guard before res.json), app/error.tsx + app/not-found.tsx, and a MortgageApplication type matching the field contract byte-for-byte.\n- Pool NON-EMPTY → fix iteration. Filter findings to source='reviewer_frontend' OR (source='reviewer_integration' AND evidence path starts with 'packages/ui/'). Fix ONLY those.\n- Pool non-empty but no findings match your filter → return with NO changes.\n\nSCOPE — you may create or modify ONLY:\n- packages/ui/app/**\n- packages/ui/lib/**\n- packages/ui/components/**\n\nDO NOT TOUCH: packages/api/** (backend's job), shared/** (read-only contracts), package.json/tsconfig.json/next.config.js/tailwind.config.js/eslint.config.mjs.\n\nHARD RULES:\n- snake_case in all payload keys, type interfaces, form controls. 23 fields per FIELD_CONTRACT.\n- Dashboard pagination: MUST pass ?page=&limit= to the backend and render controls. Client-side array.slice() as 'pagination' is a defect.\n- NEXT_PUBLIC_API_URL: never default to empty string (UI would hit its own origin). Default to 'http://localhost:3000' when unset.\n- Use Next.js Link for internal nav, not bare <a href> (full page reloads). Dead nav links pointing at routes that don't exist are defects.\n- Error messages must surface the actual cause, not 'Save failed'. Check res.status===204 before res.json() in lib/api.ts.\n- Form validation: validators defined MUST be called. aria-invalid on every field. Inline editing on detail page, not navigate-away.\n\nExpected end state: cd packages/ui && npx tsc --noEmit passes cleanly.";

export const DEFAULT_REVIEW_BE_PROMPT =
  "Review the NestJS API code in packages/api/src/ against shared/FIELD_CONTRACT.md and shared/IMPL_SPEC.md. Focus on: entity field alignment (23 snake_case fields, correct types, ApplicationStatus as text not TypeORM enum), DTO class-validator decorators, service correctness (NotFoundException/ConflictException, zero 'as any' casts), controller HTTP codes (@HttpCode(200) on submit, @HttpCode(204) on delete), and module wiring. Test-quality audit — for every test in packages/api/test/, identify any test that would NOT fail if the code under test were silently wrong. A test that cannot fail on the thing it names is a defect finding, not a passing finding. Specifically: SQL injection test must actually probe query params AND path params (not only body fields) AND verify the table still exists after the attack; boundary tests must read back what they wrote to verify storage; nonexistent-id tests must use a real UUID format not an arbitrary string; tests that couple assertions to internal error message strings should be flagged as brittle. Gotchas audit — flag any of these: dead code, unreachable branches, type unions that cannot be narrowed by TypeScript, 'as unknown as X' casts, ad-hoc inline shell in package.json scripts, ValidationPipe config drift between main.ts and test setup files, Object.assign updates without transaction protection on concurrent-safe endpoints.";

export const DEFAULT_REVIEW_FE_PROMPT =
  "Review the Next.js UI code in packages/ui/ against shared/FIELD_CONTRACT.md and shared/IMPL_SPEC.md. Focus on: MortgageApplication type fields (23 snake_case, no camelCase, no phantom fields like applicantName or monthlyDebt or creditScore), dashboard field access and USD formatting, real vs fake pagination, multi-step form (aria-invalid on every field enumerated, snake_case payload keys), detail page with inline editing not navigate-away. Verify lib/api.ts guards res.status===204 before calling res.json. Verify nav links in layout point to routes that actually exist — a dead /applications/new link is a failing finding. Gotchas audit — flag any of these in the UI: client-side array.slice() masquerading as backend pagination (fake pagination), hardcoded API URLs that should be env-var driven, NEXT_PUBLIC_API_URL defaulting to empty string (UI would hit its own origin not the API), validator functions defined but never called in their consuming forms, dead nav links, a href tags where Next.js Link should be used (causes full-page reloads), error messages that swallow the actual cause ('Save failed' without the server response), enum values rendered literally without user-friendly formatting (single_family rendered as-is instead of Single Family).";

export const DEFAULT_REVIEW_INT_PROMPT =
  "Review the cross-package integration between packages/api and packages/ui against shared/FIELD_CONTRACT.md. Focus on: field-name alignment (API entity field set must be byte-identical to UI MortgageApplication type field set, no drift, no extras on either side), package.json correctness (root workspaces, individual package deps), TypeScript strict on both sides, HTTP contract (lib/api.ts calls the same routes the controller exposes), NEXT_PUBLIC_API_URL default works without an .env file, ValidationPipe config consistent between main.ts and test setup. Verify both npx tsc --noEmit commands pass cleanly. Docs accuracy audit — if README files or package.json descriptions exist in either package, verify their claims match what the code actually does. A description that promises capabilities not in the source (e.g. 'supports pagination' when pagination is a client-side slice) is a defect finding. Gotchas audit — flag cross-package defects: DTO types in packages/api not mirrored by UI MortgageApplication Partial/Omit types (callers can pass id or status into create payloads), ApplicationStatus values used as bare strings in one package and typed enum in the other, Next.js rewrite proxy path mismatched against actual API base URL, test files in packages/api using different ValidationPipe config than production main.ts.";

export const DEFAULT_ADVERSARY_PROMPT =
  "Attack the mortgage app. You can read shared/FIELD_CONTRACT.md and shared/IMPL_SPEC.md (the public specs) but not the implementation source. Find: SQL injection surfaces on query params and path params (not just body fields), validation bypasses (negative numbers on unsigned fields, Unicode normalization, oversized payloads, prototype pollution via __proto__), HTTP contract violations (wrong status codes, missing 409 on non-draft update, 500 instead of 400 on malformed input), concurrent-submit races, type confusion (string where number expected, coerced silently), and any endpoint that accepts arbitrary ids without ownership check. Produce counterexamples with exact curl reproductions.";

// ─── Commands ─────────────────────────────────────────────────────────────────

export const DEFAULT_BUILD_API_CMD =
  "cd /repos/benchmark/packages/api && npx tsc --noEmit 2>&1 && echo 'api typecheck pass'";

export const DEFAULT_TESTS_API_CMD =
  "cd /repos/benchmark/packages/api && npm test --silent 2>&1 && echo 'api tests pass'";

export const DEFAULT_BUILD_UI_CMD =
  "cd /repos/benchmark/packages/ui && npx tsc --noEmit 2>&1 && echo 'ui typecheck pass'";

export const DEFAULT_LINT_CMD =
  "cd /repos/benchmark && npx eslint packages/api/src --max-warnings=0 2>&1 && echo 'lint pass'";

export const DEFAULT_FP_VERIFY_CMD =
  "set -o pipefail; cd /repos/benchmark && npm install 2>&1 | tail -3 && cd /repos/benchmark/packages/api && npx tsc --noEmit 2>&1 && npm test 2>&1 && cd /repos/benchmark/packages/ui && npx tsc --noEmit 2>&1 && echo 'fixed-point verified'";

export const DEFAULT_REPRO_VERIFY_CMD =
  "set -o pipefail; cd /repos/benchmark && rm -rf packages/api/node_modules packages/ui/node_modules packages/api/dist && npm install 2>&1 | tail -3 && cd /repos/benchmark/packages/api && npx tsc --noEmit 2>&1 && npm test 2>&1 && cd /repos/benchmark/packages/ui && npx tsc --noEmit 2>&1 && echo 'reproducibility verified'";

// ─── Models ───────────────────────────────────────────────────────────────────

export const DEFAULT_FIX_BACKEND_MODEL = 'minimax/minimax-m2.7';
export const DEFAULT_FIX_FRONTEND_MODEL = 'minimax/minimax-m2.7';
export const DEFAULT_REVIEW_BE_MODEL = 'z-ai/glm-5.1';
export const DEFAULT_REVIEW_FE_MODEL = 'qwen/qwen3.6-plus';
export const DEFAULT_REVIEW_INT_MODEL = 'xiaomi/mimo-v2-pro';
export const DEFAULT_ADVERSARY_MODEL = 'x-ai/grok-4.20';

// ─── Harnesses ───────────────────────────────────────────────────────────────

export const DEFAULT_FIX_BACKEND_HARNESS = 'hermes' as const;
export const DEFAULT_FIX_FRONTEND_HARNESS = 'hermes' as const;

// ─── Adversary sealed paths ───────────────────────────────────────────────────

export const DEFAULT_ADVERSARY_SEALED_FROM_SOURCE =
  'packages/api/src/**,packages/api/test/**,packages/ui/app/**,packages/ui/lib/**,packages/ui/components/**';

// ─── Numeric thresholds ───────────────────────────────────────────────────────

/** Sum of V_* findings at which convergence is declared; see attractor validator V_total definition. */
export const DEFAULT_CONVERGENCE_EPSILON = 100;

/** Per-iterate-loop count — max body executions before engine declares non-convergence. */
export const DEFAULT_MAX_ITERATIONS = 6;

/** Per-node visit budget — enforced independently of iterate semantics. */
export const DEFAULT_CONVERGE_MAX_VISITS = 5;

export const DEFAULT_CONVERGE_TIMEOUT = '21600s';

// ─── Per-node timeouts / visit caps for the v8 body pipeline ─────────────────
// These values previously lived as inline literals inside _emitDot's
// convergence branch. Lifted here so test harnesses and downstream
// inspectors share a single source of truth.

/** fix_backend / fix_frontend agent timeout (large LLM operation). */
export const DEFAULT_FIX_TIMEOUT = '3600s';

/** run_build_api / run_build_ui / run_lint mechanical gate timeout. */
export const DEFAULT_MECHANICAL_BUILD_TIMEOUT = '180s';

/** run_tests_api mechanical gate timeout (tests take longer than builds). */
export const DEFAULT_MECHANICAL_TESTS_TIMEOUT = '300s';

/** review_be / review_fe / review_int / adversary_node timeout. */
export const DEFAULT_REVIEW_TIMEOUT = '2400s';

/** fp_verify / repro_verify goal-gate timeout. */
export const DEFAULT_GOAL_GATE_TIMEOUT = '900s';

/** commit_and_push terminal-chain timeout. */
export const DEFAULT_COMMIT_PUSH_TIMEOUT = '120s';

/** Fallback visit budget for body-pipeline nodes (fix_*, reviewer_*, adversary). */
export const DEFAULT_BODY_MAX_VISITS = 10;

/** Fallback visit budget for fp_verify / repro_verify goal gates. */
export const DEFAULT_GOAL_GATE_MAX_VISITS = 5;

/** Visit budget for mechanical-gate nodes (run_build_api, run_tests_api, run_build_ui, run_lint). */
export const DEFAULT_MECHANICAL_MAX_VISITS = 5;

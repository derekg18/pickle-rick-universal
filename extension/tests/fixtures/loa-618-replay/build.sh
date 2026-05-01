#!/usr/bin/env bash
# Deterministic build script for loa-618-replay.tar.gz
# Run from repo root: bash extension/tests/fixtures/loa-618-replay/build.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE_NAME="loa-618-replay"
OUT="$SCRIPT_DIR/$FIXTURE_NAME.tar.gz"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

ROOT="$TMP/$FIXTURE_NAME"
API="$ROOT/packages/api"
SCRIPTS="$API/scripts"
SRC="$API/src"
TEST="$API/test"

mkdir -p "$SCRIPTS" "$SRC" "$TEST"

# ── workspace root ───────────────────────────────────────────────────
cat > "$ROOT/package.json" <<'EOF'
{
  "name": "loa-618-replay",
  "private": true
}
EOF

cat > "$ROOT/pnpm-workspace.yaml" <<'EOF'
packages:
  - 'packages/*'
EOF

cat > "$ROOT/pnpm-lock.yaml" <<'EOF'
lockfileVersion: '9.0'
EOF

# ── packages/api/package.json ─────────────────────────────────────────
cat > "$API/package.json" <<'EOF'
{
  "name": "@loa-618-replay/api",
  "private": true,
  "scripts": {
    "typecheck": "node scripts/fake-typecheck.cjs",
    "lint:quiet": "node scripts/fake-lint.cjs",
    "test": "node scripts/fake-test.cjs"
  }
}
EOF

# ── scripts/fake-typecheck.cjs ─────────────────────────────────────────
# Emits 1 TS2352 error (real tsc format) to stderr, exits 1.
cat > "$SCRIPTS/fake-typecheck.cjs" <<'EOF'
'use strict';
process.stderr.write(
  'src/test/image-extraction.service.spec.ts(95,11): error TS2352: ' +
  "Conversion of type 'typeof MockImageExtractionService' to type " +
  "'ImageExtractionService' may be a mistake because neither type " +
  'sufficiently overlaps with the other.\n' +
  'Found 1 error.\n'
);
process.exit(1);
EOF

# ── scripts/fake-lint.cjs ──────────────────────────────────────────────
# Emits 67 ESLint errors in stylish format to stdout, exits 1.
# 60 prettier + 2 no-control-regex + 3 require-await + 2 no-unnecessary-type-assertion
node - <<'NODESCRIPT' > "$SCRIPTS/fake-lint.cjs"
const lines = [];
lines.push("'use strict';");
lines.push('const cwd = process.cwd();');
lines.push('const out = [];');

// helper to add a file section
lines.push('');
// portal-appraisal.service.spec.ts: 60 prettier errors
lines.push('out.push(cwd + "/test/portal-appraisal.service.spec.ts");');
for (let i = 1; i <= 60; i++) {
  lines.push(`out.push('  ${i}:1  error  Replace \`import_${i}\` with \`↵import_${i}\`  prettier/prettier');`);
}

// audit-log.controller.ts: 2 no-control-regex
lines.push('out.push(cwd + "/test/audit-log.controller.ts");');
lines.push("out.push('  12:11  error  Unexpected control character(s) in regular expression  no-control-regex');");
lines.push("out.push('  18:8   error  Unexpected control character(s) in regular expression  no-control-regex');");

// processor.spec.ts: 3 require-await
lines.push('out.push(cwd + "/test/processor.spec.ts");');
lines.push("out.push('  5:1   error  Async function \\\"getFoo\\\" has no \\'await\\' expression  require-await');");
lines.push("out.push('  12:1  error  Async function \\\"getBar\\\" has no \\'await\\' expression  require-await');");
lines.push("out.push('  19:1  error  Async function \\\"getBaz\\\" has no \\'await\\' expression  require-await');");

// type-asserts.ts: 2 no-unnecessary-type-assertion
lines.push('out.push(cwd + "/test/type-asserts.ts");');
lines.push("out.push('  8:22   error  Unnecessary type assertion  @typescript-eslint/no-unnecessary-type-assertion');");
lines.push("out.push('  15:10  error  Unnecessary type assertion  @typescript-eslint/no-unnecessary-type-assertion');");

lines.push('out.push("");');
lines.push('out.push("✖ 67 problems (67 errors, 0 warnings)");');
lines.push('process.stdout.write(out.join("\\n") + "\\n");');
lines.push('process.exit(1);');

process.stdout.write(lines.join('\n') + '\n');
NODESCRIPT

# ── scripts/fake-test.cjs ──────────────────────────────────────────────
cat > "$SCRIPTS/fake-test.cjs" <<'EOF'
'use strict';
process.stdout.write('All tests passed (synthesized fixture).\n');
process.exit(0);
EOF

# ── src/image-extraction.service.ts ───────────────────────────────────
cat > "$SRC/image-extraction.service.ts" <<'EOF'
export class ImageExtractionService {
  transformToByteArray(input: string): Uint8Array {
    return new TextEncoder().encode(input);
  }
}
EOF

# ── test files (source content for brief-prep to read) ─────────────────

cat > "$TEST/image-extraction.service.spec.ts" <<'EOF'
// TS2352 fixture: mock missing transformToByteArray
import type { ImageExtractionService } from '../src/image-extraction.service';

class MockImageExtractionService {
  // transformToByteArray intentionally omitted
}

const service = new MockImageExtractionService() as unknown as ImageExtractionService;
export { service };
EOF

cat > "$TEST/portal-appraisal.service.spec.ts" <<'EOF'
// prettier/prettier × 60 fixture — formatting drift (synthesized)
import{describe,it,expect}from'jest'
import{PortalAppraisalService}from'../src/portal-appraisal.service'
describe('PortalAppraisalService',()=>{it('should work',()=>{expect(true).toBe(true)})})
// Lines 4-63: intentional style drift (no trailing newline, missing spaces)
EOF

cat > "$TEST/audit-log.controller.ts" <<'EOF'
// no-control-regex × 2 fixture
export function validateInput(s: string): boolean {
  // \x01 in character class range — no-control-regex
  return /[\x01-\x1f]/.test(s) || /[\x80-\x9f]/.test(s);
}
EOF

cat > "$TEST/processor.spec.ts" <<'EOF'
// require-await × 3 fixture
export async function getFoo(): Promise<string> {
  return 'foo';
}
export async function getBar(): Promise<string> {
  return 'bar';
}
export async function getBaz(): Promise<string> {
  return 'baz';
}
EOF

cat > "$TEST/type-asserts.ts" <<'EOF'
// @typescript-eslint/no-unnecessary-type-assertion × 2 fixture
const x: string = 'hello';
const y = x as string;  // unnecessary assertion
const z = x as string;  // unnecessary assertion
export { y, z };
EOF

# ── build tarball (deterministic mtime) ───────────────────────────────
# Normalize mtimes so tarball is reproducible across runs
find "$ROOT" -exec touch -t 202604270000.00 {} \;

cd "$TMP"
tar -czf "$OUT" "$FIXTURE_NAME"

echo "Built: $OUT"
echo "Contents:"
tar -tzf "$OUT"

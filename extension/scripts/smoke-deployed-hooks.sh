#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXTURE_DIR="$REPO_ROOT/tests/fixtures/stop-hook"
DISPATCH_JS="$HOME/.claude/pickle-rick/extension/hooks/dispatch.js"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

if [[ ! -f "$DISPATCH_JS" ]]; then
  echo "Deployed stop-hook dispatcher not found at $DISPATCH_JS" >&2
  exit 1
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

cd "$REPO_ROOT"

timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
epoch_now="$(date +%s)"
base_state_file="$tmpdir/base-state.json"
cat >"$base_state_file" <<EOF
{
  "active": true,
  "working_dir": "$REPO_ROOT",
  "step": "prd",
  "iteration": 0,
  "max_iterations": 5,
  "max_time_minutes": 60,
  "worker_timeout_seconds": 1200,
  "start_time_epoch": $epoch_now,
  "completion_promise": null,
  "original_prompt": "T0 smoke deployed hooks",
  "current_ticket": null,
  "history": [],
  "started_at": "$timestamp",
  "session_dir": "$tmpdir/session",
  "tmux_mode": false
}
EOF

canonical_json() {
  jq -cS . <<<"$1"
}

run_dispatch() {
  local state_file="$1"
  local transcript="$2"
  local role="${3:-}"
  local input
  input="$(jq -nc --arg message "$transcript" '{last_assistant_message: $message}')"
  if [[ -n "$role" ]]; then
    PICKLE_STATE_FILE="$state_file" PICKLE_ROLE="$role" FORCE_COLOR=0 \
      node "$DISPATCH_JS" stop-hook <<<"$input"
  else
    env -u PICKLE_ROLE PICKLE_STATE_FILE="$state_file" FORCE_COLOR=0 \
      node "$DISPATCH_JS" stop-hook <<<"$input"
  fi
}

assert_fixture() {
  local fixture="$1"
  local stem
  local state_file
  local expected_output
  local expected_decision
  local transcript
  local role
  local actual
  local actual_canon
  local expected_canon

  stem="$(basename "$fixture" .json)"
  state_file="$tmpdir/${stem}.state.json"
  jq -s '.[0] * (.[1].state // {})' "$base_state_file" "$fixture" >"$state_file"
  expected_output="$(jq -c '.expected_output' "$fixture")"
  expected_decision="$(jq -r '.expected_decision' "$fixture")"
  transcript="$(jq -r '.transcript' "$fixture")"
  role="$(jq -r '.role // empty' "$fixture")"
  actual="$(run_dispatch "$state_file" "$transcript" "$role")"
  actual_canon="$(canonical_json "$actual")"
  expected_canon="$(canonical_json "$expected_output")"

  if [[ "$actual_canon" != "$expected_canon" ]]; then
    echo "Fixture failed: $fixture" >&2
    echo "Expected: $expected_canon" >&2
    echo "Actual:   $actual_canon" >&2
    exit 1
  fi

  if [[ "$(jq -r '.decision' <<<"$actual")" != "$expected_decision" ]]; then
    echo "Decision mismatch for $fixture" >&2
    exit 1
  fi

  echo "verified $(basename "$fixture")"
}

assert_alias_fixture() {
  local fixture="$1"
  local state_file="$tmpdir/token-alias-equivalence.state.json"
  local expected_output
  local expected_canon
  local actual_a
  local actual_b
  local actual_a_canon
  local actual_b_canon
  local transcript_a
  local transcript_b

  jq -s '.[0] * (.[1].state // {})' "$base_state_file" "$fixture" >"$state_file"
  expected_output="$(jq -c '.expected_output' "$fixture")"
  expected_canon="$(canonical_json "$expected_output")"
  transcript_a="$(jq -r '.transcripts[0]' "$fixture")"
  transcript_b="$(jq -r '.transcripts[1]' "$fixture")"
  actual_a="$(run_dispatch "$state_file" "$transcript_a")"
  actual_b="$(run_dispatch "$state_file" "$transcript_b")"
  actual_a_canon="$(canonical_json "$actual_a")"
  actual_b_canon="$(canonical_json "$actual_b")"

  if [[ "$actual_a_canon" != "$expected_canon" || "$actual_b_canon" != "$expected_canon" ]]; then
    echo "Alias equivalence fixture failed: $fixture" >&2
    echo "Expected: $expected_canon" >&2
    echo "Actual A: $actual_a_canon" >&2
    echo "Actual B: $actual_b_canon" >&2
    exit 1
  fi

  if [[ "$actual_a_canon" != "$actual_b_canon" ]]; then
    echo "Alias transcripts do not produce identical output: $fixture" >&2
    exit 1
  fi

  echo "verified $(basename "$fixture")"
}

for fixture in \
  "$FIXTURE_DIR/token-1.json" \
  "$FIXTURE_DIR/token-2.json" \
  "$FIXTURE_DIR/token-3.json" \
  "$FIXTURE_DIR/token-4.json" \
  "$FIXTURE_DIR/token-5.json" \
  "$FIXTURE_DIR/token-6.json" \
  "$FIXTURE_DIR/token-7.json" \
  "$FIXTURE_DIR/token-8.json"; do
  assert_fixture "$fixture"
done

assert_alias_fixture "$FIXTURE_DIR/token-alias-equivalence.json"

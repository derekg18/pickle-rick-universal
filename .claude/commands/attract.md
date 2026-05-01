Submit a `.dot` pipeline to the attractor server for execution.

Persona active via CLAUDE.md. **SPEAK BEFORE ACTING**.

> **Tip:** Need a `.dot` file from a PRD? Run `/pickle-dot` first.

## Step 1: Acquire Pipeline

From `$ARGUMENTS`:
- File path (contains `/` or `.dot`) → use as DOT file
- `--detach` flag → submit pipeline and exit immediately without polling (fire-and-forget mode)
- Empty → look for the most recently modified `.dot` file in the current directory and Pickle Rick session root. If multiple found, present choices. If none, ask user.

Parse flags:
```bash
DETACH=false
BACKEND="claude-code"
for arg in $ARGUMENTS; do
  case "$arg" in
    --detach) DETACH=true ;;
    --backend) shift; BACKEND="$1" ;;
    --backend=*) BACKEND="${arg#*=}" ;;
  esac
done
```

Resolve to absolute path. Verify it exists:
```bash
test -f "$DOT_FILE" && echo "OK: $DOT_FILE" || echo "ERROR: not found"
```

## Step 2: Validate Locally

Find attractor and validate before submitting.

**Root detection** checks three locations in order:
1. `$ATTRACTOR_ROOT` env var (explicit override)
2. `../attractor/` relative to the working directory (common monorepo layout)
3. Auto-detect via `find` under `~/loanlight`

If all three fail, stop with a clear error — do not proceed with an empty path.

```bash
if [ -n "$ATTRACTOR_ROOT" ] && [ -d "$ATTRACTOR_ROOT/packages/attractor" ]; then
  echo "ATTRACTOR_ROOT=$ATTRACTOR_ROOT (from env)"
elif [ -d "../attractor/packages/attractor" ]; then
  ATTRACTOR_ROOT="$(cd ../attractor && pwd)"
  echo "ATTRACTOR_ROOT=$ATTRACTOR_ROOT (from ../attractor/)"
else
  ATTRACTOR_ROOT="$(find ~/loanlight -maxdepth 2 -type f -name "cli.ts" -path "*/packages/attractor/src/cli.ts" 2>/dev/null | head -1 | sed 's|/packages/attractor/src/cli.ts||')"
  if [ -z "$ATTRACTOR_ROOT" ]; then
    echo "ERROR: attractor auto-detect failed. ATTRACTOR_ROOT is not set and ../attractor/ does not exist."
    echo "Fix: export ATTRACTOR_ROOT=/path/to/attractor   OR   clone attractor next to this repo."
    exit 1
  fi
  echo "ATTRACTOR_ROOT=$ATTRACTOR_ROOT (auto-detected)"
fi
```

```bash
cd "$ATTRACTOR_ROOT" && bun packages/attractor/src/cli.ts validate "$DOT_FILE"
```

- Errors → show diagnostics, reference **`attractor/DOT_SCHEMA.md`** for schema details (shapes, attributes, condition syntax, validator rules), **stop**.
- Warnings → show them, continue.

## Step 3: Check Server

```bash
ATTRACTOR_URL="${ATTRACTOR_URL:-http://localhost:7777}"
curl -sf "$ATTRACTOR_URL/health" | jq .
```

If the server is unreachable:
1. Check if Docker is running: `docker compose -f "$ATTRACTOR_ROOT/docker-compose.yml" ps`
2. Offer to start it: `cd "$ATTRACTOR_ROOT" && docker compose up -d`
3. Wait up to 15s for health check to pass, polling every 2s
4. If still unreachable after 15s, report error and suggest running locally with `/pickle-portal`

## Step 4: Submit Pipeline

Read the DOT file and submit via HTTP:

```bash
DOT_CONTENT=$(cat "$DOT_FILE")
SUBMIT_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$ATTRACTOR_URL/pipelines" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${ATTRACTOR_API_KEY:-}" \
  -d "$(jq -n --arg dot "$DOT_CONTENT" --arg backend "${BACKEND:-claude-code}" '{dot: $dot, backend: $backend}')")
SUBMIT_HTTP_CODE=$(echo "$SUBMIT_RESPONSE" | tail -1)
SUBMIT_BODY=$(echo "$SUBMIT_RESPONSE" | sed '$d')
echo "HTTP $SUBMIT_HTTP_CODE"
```

**HTTP error classification** for submission:
| HTTP Code | Meaning | Action |
|-----------|---------|--------|
| `200`/`201` | Success | Extract pipeline ID, continue |
| `400` | Bad request — malformed DOT | Show error body, fix DOT syntax, re-validate with `/pickle-dot`, **stop** |
| `429` | Rate limited | Show `Retry-After` header if present, wait and retry |
| `500`+ | Server error | Show error body, retry once after 5s, then **stop** |
| `0` / network error | Server unreachable | Check server health (Step 3), **stop** |

On success:
```bash
PIPELINE_ID=$(echo "$SUBMIT_BODY" | jq -r '.id')
echo "PIPELINE_ID=$PIPELINE_ID"
```

If submission fails, show the HTTP status code, error response body, and stop.

Track the pipeline ID for the monitor dashboard:
```bash
echo "$PIPELINE_ID" >> /tmp/attractor-monitor-pipelines.txt
```

**Checkpoint save**: persist pipeline state for session recovery. If `SESSION_ROOT` is set (Pickle Rick sessions), save the checkpoint there; otherwise use `/tmp`.
```bash
CHECKPOINT_DIR="${SESSION_ROOT:-/tmp}"
cat > "$CHECKPOINT_DIR/attractor-checkpoint.json" <<CKPT
{
  "pipelineId": "$PIPELINE_ID",
  "dotFile": "$DOT_FILE",
  "url": "$ATTRACTOR_URL",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
CKPT
echo "Checkpoint saved: $CHECKPOINT_DIR/attractor-checkpoint.json"
```

**`--detach` mode**: if the `--detach` flag was passed, print the pipeline ID and resume command, then stop without polling.
```bash
if [ "$DETACH" = "true" ]; then
  echo "Pipeline submitted in detach mode."
  echo "  Pipeline ID: $PIPELINE_ID"
  echo "  Resume: curl -sf $ATTRACTOR_URL/pipelines/$PIPELINE_ID | jq ."
  echo "  Checkpoint: $CHECKPOINT_DIR/attractor-checkpoint.json"
  exit 0
fi
```

## Step 5: Monitor Execution

Report the submission, then poll for status until completion with exponential backoff.

**Signal handling**: trap Ctrl+C so the pipeline ID is always printed before exit:
```bash
trap 'echo ""; echo "⚠ Interrupted. Pipeline still running server-side."; echo "  Pipeline ID: $PIPELINE_ID"; echo "  Resume: curl -sf $ATTRACTOR_URL/pipelines/$PIPELINE_ID | jq ."; exit 130' INT TERM
```

```bash
POLL_TIMEOUT="${POLLING_TIMEOUT:-3600}"
BACKOFF=5
POLL_START=$(date +%s)
PREV_STATUS=""
while true; do
  POLL_RESPONSE=$(curl -s -w "\n%{http_code}" "$ATTRACTOR_URL/pipelines/$PIPELINE_ID" -H "x-api-key: ${ATTRACTOR_API_KEY:-}")
  POLL_HTTP_CODE=$(echo "$POLL_RESPONSE" | tail -1)
  POLL_BODY=$(echo "$POLL_RESPONSE" | sed '$d')

  # HTTP error classification for polling
  if [ "$POLL_HTTP_CODE" -eq 0 ] 2>/dev/null || [ "$POLL_HTTP_CODE" = "000" ]; then
    echo "$(date +%H:%M:%S) ⚠ Network error — server unreachable. Retrying in ${BACKOFF}s..."
    sleep "$BACKOFF"
    BACKOFF=$(( BACKOFF * 2 > 30 ? 30 : BACKOFF * 2 ))
    continue
  elif [ "$POLL_HTTP_CODE" -ge 500 ]; then
    echo "$(date +%H:%M:%S) ⚠ HTTP $POLL_HTTP_CODE server error. Retrying in ${BACKOFF}s..."
    sleep "$BACKOFF"
    BACKOFF=$(( BACKOFF * 2 > 30 ? 30 : BACKOFF * 2 ))
    continue
  elif [ "$POLL_HTTP_CODE" -eq 429 ]; then
    echo "$(date +%H:%M:%S) ⚠ HTTP 429 rate limited. Waiting ${BACKOFF}s..."
    sleep "$BACKOFF"
    BACKOFF=$(( BACKOFF * 2 > 30 ? 30 : BACKOFF * 2 ))
    continue
  elif [ "$POLL_HTTP_CODE" -ge 400 ]; then
    echo "$(date +%H:%M:%S) ✗ HTTP $POLL_HTTP_CODE client error:"
    echo "$POLL_BODY" | jq . 2>/dev/null || echo "$POLL_BODY"
    break
  fi

  STATUS=$(echo "$POLL_BODY" | jq -r '.status')
  ELAPSED=$(( $(date +%s) - POLL_START ))
  echo "$(date +%H:%M:%S) Status: $STATUS (${ELAPSED}s elapsed)"

  # Terminal states: completed, failed, cancelled, timeout, paused
  case "$STATUS" in
    completed|failed|cancelled|timeout|paused)
      echo "$POLL_BODY" | jq .
      break
      ;;
  esac

  # Check for pending human gate questions on each non-terminal iteration
  QUESTION=$(curl -sf "$ATTRACTOR_URL/pipelines/$PIPELINE_ID/question" -H "x-api-key: ${ATTRACTOR_API_KEY:-}")
  if echo "$QUESTION" | jq -e '.questionId' > /dev/null 2>&1; then
    QID=$(echo "$QUESTION" | jq -r '.questionId')
    PROMPT=$(echo "$QUESTION" | jq -r '.prompt // .label // "Approve?"')
    OPTIONS=$(echo "$QUESTION" | jq -r '.options // empty')
    # Present to user and ask for their answer
  fi

  if [ "$POLL_TIMEOUT" -gt 0 ] && [ "$ELAPSED" -ge "$POLL_TIMEOUT" ]; then
    echo "⏱ Polling timeout (${POLL_TIMEOUT}s) exceeded. Pipeline ID: $PIPELINE_ID"
    echo "Resume monitoring: curl -sf $ATTRACTOR_URL/pipelines/$PIPELINE_ID | jq ."
    break
  fi

  # Exponential backoff: 5s start, 30s cap, reset on state change
  if [ "$STATUS" != "$PREV_STATUS" ] && [ -n "$PREV_STATUS" ]; then
    BACKOFF=5
  fi
  PREV_STATUS="$STATUS"
  sleep "$BACKOFF"
  BACKOFF=$(( BACKOFF * 2 > 30 ? 30 : BACKOFF * 2 ))
done
```

When a human gate is detected:
1. Show the gate prompt and options to the user
2. Ask for their response
3. Submit the answer:
```bash
curl -sf -X POST "$ATTRACTOR_URL/pipelines/$PIPELINE_ID/questions/$QID/answer" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${ATTRACTOR_API_KEY:-}" \
  -d "$(jq -n --arg value "$ANSWER" '{value: $value}')"
```

## Step 6: Report Results

When the pipeline reaches a terminal state:

1. **Status**: `completed`, `failed`, `cancelled`, `timeout`, or `paused`
2. **Pipeline ID**: full UUID + short form
3. **Duration**: from submission to completion
4. Fetch final context: `curl -sf "$ATTRACTOR_URL/pipelines/$PIPELINE_ID/context" -H "x-api-key: ${ATTRACTOR_API_KEY:-}" | jq .`

If `cancelled` or `paused`, suggest resuming: `curl -sf -X POST $ATTRACTOR_URL/pipelines/$PIPELINE_ID/resume`
If `timeout`, suggest checking server load and resubmitting the pipeline.

If `failed`, suggest:
- Check logs in the monitor: `./scripts/monitor.sh`
- View events: `curl -sN $ATTRACTOR_URL/pipelines/$PIPELINE_ID/events`
- Resume from checkpoint (if available): `curl -sf $ATTRACTOR_URL/pipelines/$PIPELINE_ID/checkpoint`

## API Key Security

- **NEVER** log, print, or echo API keys in output. Use `${ATTRACTOR_API_KEY:-}` in headers only — never interpolate into `echo` or debug statements.
- Store keys in a `.env` file at the project root. Load with `source .env` or `export $(grep -v '^#' .env | xargs)`.
- **NEVER** commit `.env` or any file containing secrets. Ensure `.env` is in `.gitignore`.
- If an API error includes the key in the response body, mask it before displaying: `echo "$RESPONSE" | sed "s/$ATTRACTOR_API_KEY/***REDACTED***/g"`
- For CI/CD, use environment variables or secret managers — never hardcode keys in pipelines.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ATTRACTOR_URL` | `http://localhost:7777` | Server URL |
| `ATTRACTOR_API_KEY` | _(unset)_ | API key if server auth is enabled |
| `ATTRACTOR_ROOT` | _(auto-detected)_ | Path to attractor repo root |
| `POLLING_TIMEOUT` | `3600` | Polling timeout in seconds (0 = unlimited) |
| `BACKEND` | `claude-code` | Execution backend: `claude-code`, `llm`, `mastra`, `qwen-code`, `none` |

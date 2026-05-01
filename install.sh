#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_ROOT="$HOME/.claude/pickle-rick"
COMMANDS_DIR="$HOME/.claude/commands"
SETTINGS_FILE="$HOME/.claude/settings.json"
# IMPORTANT: $HOME is intentionally a literal here — it gets expanded at runtime
# by the shell when Claude Code executes the hook command. Do NOT expand it at install time.
HOOK_CMD_LITERAL='node $HOME/.claude/pickle-rick/extension/hooks/dispatch.js stop-hook'

# --- LOCK (Forward Fix F2: serialize concurrent install.sh invocations) ---
# Cross-skill workers can run install.sh simultaneously, racing on settings.json
# backup + jq-merge and producing paired backups seconds apart. Acquire an
# exclusive lock for the lifetime of the script.
mkdir -p "$EXTENSION_ROOT"
LOCKFILE="$EXTENSION_ROOT/.install.lock"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCKFILE"
  if ! flock -x -n 9; then
    echo "⏳ Another install.sh is running; waiting for lock..."
    flock -x 9
  fi
else
  # Portable fallback for systems without flock(1) (e.g. stock macOS):
  # mkdir is atomic on POSIX filesystems, so it doubles as a lock primitive.
  LOCKDIR="$EXTENSION_ROOT/.install.lock.d"
  while ! mkdir "$LOCKDIR" 2>/dev/null; do
    echo "⏳ Another install.sh is running; waiting..."
    sleep 1
  done
  trap 'rmdir "$LOCKDIR"' EXIT
fi

# --- DRY RUN ---
# Test hook: exits cleanly after lock acquisition so concurrent-invocation
# tests can verify serialization without performing any deploy actions.
if [ "${1:-}" = "--dry-run" ]; then
  echo "dry run, skipping"
  exit 0
fi

echo "🥒 Installing Pickle Rick for Claude Code..."

# --- VALIDATION ---
node --version >/dev/null 2>&1    || { echo "❌ node not found on PATH"; exit 1; }
jq --version >/dev/null 2>&1     || { echo "❌ jq not found on PATH"; exit 1; }
rsync --version >/dev/null 2>&1  || { echo "❌ rsync not found on PATH"; exit 1; }
claude --version >/dev/null 2>&1 || echo "⚠️  claude CLI not on PATH (needed at runtime for worker spawning)"
bun --version >/dev/null 2>&1    || echo "WARNING: bun not found. Plumbus generative audit is running in degraded mode. Install bun for full analysis."
[ -f "$SETTINGS_FILE" ]          || { echo "❌ ~/.claude/settings.json not found. Run 'claude' at least once first."; exit 1; }
jq . "$SETTINGS_FILE" >/dev/null 2>&1 || { echo "❌ settings.json is not valid JSON"; exit 1; }
[ -d "$SCRIPT_DIR/extension" ]   || { echo "❌ extension/ not found. Are you running from the repo root?"; exit 1; }
[ -d "$SCRIPT_DIR/.claude/commands" ] || { echo "❌ .claude/commands/ not found. Are you running from the repo root?"; exit 1; }

# --- MODE DETECTION ---
if [ -d "$SCRIPT_DIR/.git" ]; then
  INSTALL_MODE="git"
else
  INSTALL_MODE="tarball"
fi
echo "[install.sh] Mode: $INSTALL_MODE" >&2

# --- COMPILE (git mode only) ---
if [ "$INSTALL_MODE" = "git" ]; then
  echo "📦 Installing dependencies..."
  (cd "$SCRIPT_DIR/extension" && npm install --no-fund --no-audit)
  echo "🔨 Compiling TypeScript..."
  (cd "$SCRIPT_DIR/extension" && npx tsc)
  # Sanity check: compiled JS schemaVersion must match source TS
  SOURCE_VERSION=$(grep -oE 'schemaVersion: [0-9]+' "$SCRIPT_DIR/extension/src/types/index.ts" | head -1 | awk '{print $2}')
  COMPILED_VERSION=$(grep -oE 'schemaVersion: [0-9]+' "$SCRIPT_DIR/extension/types/index.js" | head -1 | awk '{print $2}')
  if [ -z "$SOURCE_VERSION" ] || [ -z "$COMPILED_VERSION" ]; then
    echo "❌ Could not extract schemaVersion from source or compiled types/index. Refusing to deploy." >&2
    exit 1
  fi
  if [ "$SOURCE_VERSION" != "$COMPILED_VERSION" ]; then
    echo "❌ Compiled JS schemaVersion ($COMPILED_VERSION) does not match source TS ($SOURCE_VERSION)." >&2
    echo "   Likely cause: stale tsc build cache. Try: rm extension/types/index.js && bash install.sh" >&2
    exit 1
  fi
else
  echo "[install.sh] Skipping compilation (pre-built tarball)" >&2
fi

# --- BACKUP ---
mkdir -p "$HOME/.claude/backups"
cp "$SETTINGS_FILE" "$HOME/.claude/backups/settings.json.pickle-backup.$(date +%s)"
echo "✅ Backed up settings.json to ~/.claude/backups/"

# --- DIRECTORIES ---
mkdir -p "$EXTENSION_ROOT" "$COMMANDS_DIR" "$EXTENSION_ROOT/activity" "$EXTENSION_ROOT/templates"
chmod 700 "$EXTENSION_ROOT/activity"

# --- EXTENSION SCRIPTS ---
# rsync compiled JS runtime files; exclude TS sources, tests, and dev-only files.
# --delete removes stale files from the destination (e.g. deleted scripts).
# package.json is included — required for ESM "type":"module".
rsync -a --delete --delete-excluded \
  --exclude='node_modules' \
  --exclude='src' \
  --exclude='tests' \
  --exclude='tsconfig.json' \
  --exclude='package-lock.json' \
  "$SCRIPT_DIR/extension/" "$EXTENSION_ROOT/extension/"

# --- RUNTIME DEPS ---
# Some compiled JS modules (e.g. citadel/frontend-prop-drift-audit.js) import
# packages from extension/node_modules at module-load. Since rsync excludes
# node_modules, symlink the specific runtime deps the deployed code needs.
# Recreated each install.sh run because --delete-excluded above blows them away.
mkdir -p "$EXTENSION_ROOT/extension/node_modules"
for dep in typescript; do
  if [ -d "$SCRIPT_DIR/extension/node_modules/$dep" ]; then
    ln -sfn "$SCRIPT_DIR/extension/node_modules/$dep" "$EXTENSION_ROOT/extension/node_modules/$dep"
  fi
done
# Merge pickle_settings: repo defaults as base, user values overlaid (preserves customizations)
if [ -f "$EXTENSION_ROOT/pickle_settings.json" ]; then
  TMPFILE="$(mktemp)"
  jq -s '.[0] * .[1]' "$SCRIPT_DIR/pickle_settings.json" "$EXTENSION_ROOT/pickle_settings.json" > "$TMPFILE" \
    && mv "$TMPFILE" "$EXTENSION_ROOT/pickle_settings.json"
else
  cp "$SCRIPT_DIR/pickle_settings.json" "$EXTENSION_ROOT/"
fi
# Store persona snippet — append this to your project's CLAUDE.md
cp "$SCRIPT_DIR/persona.md" "$EXTENSION_ROOT/persona.md"
# Szechuan Sauce principles references — used by /szechuan-sauce command
for f in "$SCRIPT_DIR"/extension/szechuan-sauce-*-principles.md "$SCRIPT_DIR/extension/szechuan-sauce-principles.md"; do
  [ -f "$f" ] && cp "$f" "$EXTENSION_ROOT/$(basename "$f")"
done

# --- PERMISSIONS (files with shebangs that may be invoked directly) ---
chmod +x "$EXTENSION_ROOT/extension/hooks/dispatch.js"
chmod +x "$EXTENSION_ROOT/extension/bin/setup.js"
chmod +x "$EXTENSION_ROOT/extension/bin/cancel.js"
chmod +x "$EXTENSION_ROOT/extension/bin/spawn-morty.js"
chmod +x "$EXTENSION_ROOT/extension/bin/worker-setup.js"
chmod +x "$EXTENSION_ROOT/extension/bin/jar-runner.js"
chmod +x "$EXTENSION_ROOT/extension/bin/status.js"
chmod +x "$EXTENSION_ROOT/extension/bin/retry-ticket.js"
chmod +x "$EXTENSION_ROOT/extension/bin/mux-runner.js"
chmod +x "$EXTENSION_ROOT/extension/bin/microverse-runner.js"
chmod +x "$EXTENSION_ROOT/extension/bin/init-microverse.js"
chmod +x "$EXTENSION_ROOT/extension/bin/resolve-scope.js"
ln -sf "$EXTENSION_ROOT/extension/bin/mux-runner.js" "$EXTENSION_ROOT/extension/bin/tmux-runner.js"
chmod +x "$EXTENSION_ROOT/extension/bin/monitor.js"
chmod +x "$EXTENSION_ROOT/extension/bin/log-watcher.js"
chmod +x "$EXTENSION_ROOT/extension/bin/morty-watcher.js"
chmod +x "$EXTENSION_ROOT/extension/bin/spawn-refinement-team.js"
chmod +x "$EXTENSION_ROOT/extension/bin/get-session.js"
chmod +x "$EXTENSION_ROOT/extension/bin/update-state.js"
[ -f "$EXTENSION_ROOT/extension/bin/validate-teams-ticket.js" ] && chmod +x "$EXTENSION_ROOT/extension/bin/validate-teams-ticket.js"
chmod +x "$EXTENSION_ROOT/extension/bin/log-activity.js"
chmod +x "$EXTENSION_ROOT/extension/bin/log-commit.js"
chmod +x "$EXTENSION_ROOT/extension/bin/prune-activity.js"
chmod +x "$EXTENSION_ROOT/extension/bin/standup.js"
chmod +x "$EXTENSION_ROOT/extension/bin/metrics.js"
chmod +x "$EXTENSION_ROOT/extension/bin/circuit-reset.js"
chmod +x "$EXTENSION_ROOT/extension/bin/sync-schema.js"
# Make tsc resolvable from the repo root for sync-schema validation (npx tsc from parent dir)
mkdir -p "$SCRIPT_DIR/node_modules/.bin"
ln -sf "$SCRIPT_DIR/extension/node_modules/.bin/tsc" "$SCRIPT_DIR/node_modules/.bin/tsc"
chmod +x "$EXTENSION_ROOT/extension/bin/dot-builder-cli.js"
chmod +x "$EXTENSION_ROOT/extension/bin/dot-builder.js"
chmod +x "$EXTENSION_ROOT/extension/bin/plumbus-frame-analyzer.js"
chmod +x "$EXTENSION_ROOT/extension/bin/check-gate.js"
chmod +x "$EXTENSION_ROOT/extension/bin/finalize-gate.js"
chmod +x "$EXTENSION_ROOT/extension/bin/spawn-gate-remediator.js"
chmod +x "$EXTENSION_ROOT/extension/scripts/tmux-monitor.sh"

# --- INTERNAL TEMPLATES (hidden from slash command list) ---
if [ -d "$SCRIPT_DIR/templates" ]; then
  rsync -a "$SCRIPT_DIR/templates/" "$EXTENSION_ROOT/templates/"
fi

# --- AGENTS ---
# Subagent definitions for /pickle --teams.
# Canonical Pickle agents install under .pickle-managed so top-level files remain user overrides.
# No --delete: preserve locally-added managed agents from newer/experimental installs.
AGENTS_DIR="$HOME/.claude/agents"
MANAGED_AGENTS_DIR="$AGENTS_DIR/.pickle-managed"
file_size() {
  stat -f '%z' "$1" 2>/dev/null || stat -c '%s' "$1"
}
file_mtime() {
  stat -f '%m' "$1" 2>/dev/null || stat -c '%Y' "$1"
}
same_size_and_mtime() {
  [ "$(file_size "$1")" = "$(file_size "$2")" ] && [ "$(file_mtime "$1")" = "$(file_mtime "$2")" ]
}
if [ -d "$SCRIPT_DIR/.claude/agents" ]; then
  mkdir -p "$AGENTS_DIR" "$MANAGED_AGENTS_DIR"
  for src_agent in "$SCRIPT_DIR"/.claude/agents/*.md; do
    [ -e "$src_agent" ] || continue
    agent_file="$(basename "$src_agent")"
    legacy_agent="$AGENTS_DIR/$agent_file"
    managed_agent="$MANAGED_AGENTS_DIR/$agent_file"
    if [ -f "$legacy_agent" ]; then
      if same_size_and_mtime "$legacy_agent" "$src_agent"; then
        if [ -e "$managed_agent" ]; then
          rm -f "$legacy_agent"
          echo "ℹ️  Removed legacy duplicate agent $legacy_agent; managed copy already exists."
        else
          mv "$legacy_agent" "$managed_agent"
          echo "ℹ️  Migrated legacy Pickle agent $agent_file to $MANAGED_AGENTS_DIR/"
        fi
      else
        echo "⚠️  Legacy agent conflict preserved at $legacy_agent; canonical Pickle copy installs to $MANAGED_AGENTS_DIR/$agent_file"
      fi
    fi
  done
  rsync -a "$SCRIPT_DIR/.claude/agents/" "$MANAGED_AGENTS_DIR/"
  echo "✅ Agent definitions installed to $MANAGED_AGENTS_DIR/"
fi

# --- COMMANDS ---
# rsync all commands from .claude/commands/; no --delete to preserve user commands.
rsync -a "$SCRIPT_DIR/.claude/commands/" "$COMMANDS_DIR/"

# Clean up legacy commands AFTER rsync (so they're removed even if source still had them)
rm -f "$COMMANDS_DIR/microverse.md"
rm -f "$COMMANDS_DIR/pickle-microverse-tmux.md"

# --- STOP HOOK (idempotent jq merge, $HOME stays LITERAL in JSON) ---
if jq -e '.hooks.Stop // [] | map(.hooks // [] | map(.command)) | flatten | any(. == "node $HOME/.claude/pickle-rick/extension/hooks/dispatch.js stop-hook")' \
    "$SETTINGS_FILE" >/dev/null 2>&1; then
  echo "⚠️  Stop hook already registered — skipping"
else
  TMPFILE="$(mktemp)"
  jq '
    "node $HOME/.claude/pickle-rick/extension/hooks/dispatch.js stop-hook" as $cmd |
    {"type": "command", "command": $cmd} as $entry |
    if .hooks == null then
      .hooks = {"Stop": [{"hooks": [$entry]}]}
    elif .hooks.Stop == null then
      .hooks.Stop = [{"hooks": [$entry]}]
    else
      .hooks.Stop += [{"hooks": [$entry]}]
    end
  ' "$SETTINGS_FILE" > "$TMPFILE" \
    && mv "$TMPFILE" "$SETTINGS_FILE"
  echo "✅ Registered Stop hook in $SETTINGS_FILE"
fi

# --- POST-TOOL-USE HOOK (git commit activity logger, idempotent) ---
COMMIT_HOOK_CMD='node $HOME/.claude/pickle-rick/extension/bin/log-commit.js'
if jq -e --arg cmd "$COMMIT_HOOK_CMD" \
    '.hooks.PostToolUse // [] | map(.hooks // [] | map(.command)) | flatten | any(. == $cmd)' \
    "$SETTINGS_FILE" >/dev/null 2>&1; then
  echo "⚠️  PostToolUse hook already registered — skipping"
else
  TMPFILE="$(mktemp)"
  jq --arg cmd "$COMMIT_HOOK_CMD" '
    {"type": "command", "command": $cmd, "async": true, "timeout": 5} as $entry |
    {"matcher": "Bash", "hooks": [$entry]} as $group |
    if .hooks == null then
      .hooks = {"PostToolUse": [$group]}
    elif .hooks.PostToolUse == null then
      .hooks.PostToolUse = [$group]
    else
      .hooks.PostToolUse += [$group]
    end
  ' "$SETTINGS_FILE" > "$TMPFILE" \
    && mv "$TMPFILE" "$SETTINGS_FILE"
  echo "✅ Registered PostToolUse hook in $SETTINGS_FILE"
fi

# --- PRE-TOOL-USE HOOKS (merge from source settings, preserving existing entries) ---
SOURCE_SETTINGS="$SCRIPT_DIR/.claude/settings.json"
SOURCE_PTU_COUNT=$(jq '.hooks.PreToolUse // [] | length' "$SOURCE_SETTINGS" 2>/dev/null || echo "0")
if [ "$SOURCE_PTU_COUNT" -gt 0 ]; then
  echo "🔧 Merging $SOURCE_PTU_COUNT PreToolUse hook group(s) from source..."
  for i in $(seq 0 $((SOURCE_PTU_COUNT - 1))); do
    # Extract the command from the source hook group
    SRC_CMD=$(jq -r ".hooks.PreToolUse[$i].hooks[0].command" "$SOURCE_SETTINGS")
    # Check if this command already exists in deployed settings
    if jq -e --arg cmd "$SRC_CMD" \
        '.hooks.PreToolUse // [] | map(.hooks // [] | map(.command)) | flatten | any(. == $cmd)' \
        "$SETTINGS_FILE" >/dev/null 2>&1; then
      echo "⚠️  PreToolUse hook already registered ($SRC_CMD) — skipping"
    else
      # Extract the full hook group from source and merge into deployed
      TMPFILE="$(mktemp)"
      SRC_GROUP=$(jq ".hooks.PreToolUse[$i]" "$SOURCE_SETTINGS")
      jq --argjson group "$SRC_GROUP" '
        if .hooks == null then
          .hooks = {"PreToolUse": [$group]}
        elif .hooks.PreToolUse == null then
          .hooks.PreToolUse = [$group]
        else
          .hooks.PreToolUse += [$group]
        end
      ' "$SETTINGS_FILE" > "$TMPFILE" \
        && mv "$TMPFILE" "$SETTINGS_FILE"
      echo "✅ Registered PreToolUse hook: $SRC_CMD"
    fi
  done
else
  echo "ℹ️  No PreToolUse hooks in source settings — existing hooks preserved"
fi

# --- VALIDATE result ---
jq . "$SETTINGS_FILE" >/dev/null 2>&1 || { echo "❌ settings.json corrupted after merge — restore from backup"; exit 1; }

echo ""
echo "✅ Pickle Rick for Claude Code installed!"
echo ""
echo "📝 Persona setup — add the Pickle Rick persona to your project's CLAUDE.md:"
echo ""
echo "   # If your project already has a CLAUDE.md:"
echo "   cat $EXTENSION_ROOT/persona.md >> /path/to/project/.claude/CLAUDE.md"
echo ""
echo "   # If starting fresh:"
echo "   mkdir -p /path/to/project/.claude"
echo "   cp $EXTENSION_ROOT/persona.md /path/to/project/.claude/CLAUDE.md"
echo ""
echo "Get started in any project: /pickle \"your task here\""
echo "Queue tasks for later:      /add-to-pickle-jar  then  /pickle-jar-open"

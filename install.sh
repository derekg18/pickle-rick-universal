#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
DATA_ROOT="$XDG_DATA_HOME/pickle-rick"
RUNTIME_ROOT="$DATA_ROOT/runtime"
EXTENSION_ROOT="$RUNTIME_ROOT"
LEGACY_CLAUDE_RUNTIME_ROOT="$HOME/.claude/pickle-rick"
MANIFEST_FILE="$DATA_ROOT/install_manifest.json"
COMMANDS_SOURCE_DIR="$SCRIPT_DIR/.claude/commands"
AGENTS_SOURCE_DIR="$SCRIPT_DIR/.claude/agents"
SOURCE_SETTINGS="$SCRIPT_DIR/.claude/settings.json"
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

echo "🥒 Installing Pickle Rick universal runtime..."

# --- VALIDATION ---
node --version >/dev/null 2>&1    || { echo "❌ node not found on PATH"; exit 1; }
jq --version >/dev/null 2>&1     || { echo "❌ jq not found on PATH"; exit 1; }
rsync --version >/dev/null 2>&1  || { echo "❌ rsync not found on PATH"; exit 1; }
claude --version >/dev/null 2>&1 || echo "⚠️  claude CLI not on PATH (needed at runtime for worker spawning)"
codex --version >/dev/null 2>&1  || echo "⚠️  codex CLI not on PATH (needed for codex backend)"
gemini --version >/dev/null 2>&1 || echo "⚠️  gemini CLI not on PATH (needed for gemini backend)"
bun --version >/dev/null 2>&1    || echo "WARNING: bun not found. Plumbus generative audit is running in degraded mode. Install bun for full analysis."
[ -d "$SCRIPT_DIR/extension" ]   || { echo "❌ extension/ not found. Are you running from the repo root?"; exit 1; }
[ -d "$COMMANDS_SOURCE_DIR" ]    || { echo "❌ .claude/commands/ not found. Are you running from the repo root?"; exit 1; }

PACKAGE_VERSION="$(node -e "const p=require('$SCRIPT_DIR/extension/package.json'); process.stdout.write(p.version)")"
COMMAND_SOURCE_COUNT="$(find "$COMMANDS_SOURCE_DIR" -maxdepth 1 -type f -name '*.md' | wc -l | tr -d ' ')"
AGENT_SOURCE_COUNT="0"
if [ -d "$AGENTS_SOURCE_DIR" ]; then
  AGENT_SOURCE_COUNT="$(find "$AGENTS_SOURCE_DIR" -maxdepth 1 -type f -name '*.md' | wc -l | tr -d ' ')"
fi

# --- MODE DETECTION ---
if [ -n "${PICKLE_INSTALL_MODE:-}" ]; then
  INSTALL_MODE="$PICKLE_INSTALL_MODE"
elif [ -d "$SCRIPT_DIR/.git" ]; then
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

json_array_from_find() {
  local root="$1"
  if [ -d "$root" ]; then
    find "$root" \( -type f -o -type l \) ! -name "*.log" -print | sort | jq -R . | jq -s .
  else
    printf '[]\n'
  fi
}

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

checksums_json_from_files() {
  local files_json="$1"
  node --input-type=module -e '
    import fs from "fs";
    import crypto from "crypto";
    const files = JSON.parse(process.argv[1]);
    const out = {};
    for (const file of files) {
      try {
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
        out[file] = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      } catch {
        // Ignore paths that disappear during manifest collection.
      }
    }
    process.stdout.write(JSON.stringify(out));
  ' "$files_json"
}

assert_command_registry_parity() {
  node --input-type=module -e '
    import { pathToFileURL } from "url";
    const mod = await import(pathToFileURL(process.argv[1]).href);
    mod.assertCommandRegistryParity(process.argv[2]);
  ' "$SCRIPT_DIR/extension/services/host-command-registry.js" "$COMMANDS_SOURCE_DIR"
}

render_gemini_toml() {
  local command_name="$1"
  local command_target="$2"
  node --input-type=module -e '
    import { pathToFileURL } from "url";
    const mod = await import(pathToFileURL(process.argv[1]).href);
    process.stdout.write(mod.renderGeminiToml(process.argv[2], process.argv[3]));
  ' "$SCRIPT_DIR/extension/services/host-command-registry.js" "$command_name" "$command_target"
}

write_host_json() {
  local file="$1"
  local host="$2"
  local status="$3"
  local root="$4"
  local settings="$5"
  local commands="$6"
  local agents="$7"
  local files_json="$8"
  local backups_json="$9"
  local checksums_json="${10}"
  local reason="${11}"
  jq -n \
    --arg host "$host" \
    --arg status "$status" \
    --arg root "$root" \
    --arg settings "$settings" \
    --arg reason "$reason" \
    --argjson commands "$commands" \
    --argjson agents "$agents" \
    --argjson files "$files_json" \
    --argjson backups "$backups_json" \
    --argjson checksums "$checksums_json" \
    '{
      host: $host,
      status: $status,
      root: (if $root == "" then null else $root end),
      settings_file: (if $settings == "" then null else $settings end),
      command_count: $commands,
      agent_count: $agents,
      files_written: $files,
      file_checksums: $checksums,
      backups: $backups,
      reason: (if $reason == "" then null else $reason end)
    }' > "$file"
}

assert_command_registry_parity

echo "📦 Installing shared runtime to $RUNTIME_ROOT..."
mkdir -p "$RUNTIME_ROOT" "$DATA_ROOT/activity" "$RUNTIME_ROOT/activity" "$RUNTIME_ROOT/templates"
chmod 700 "$DATA_ROOT/activity" "$RUNTIME_ROOT/activity"

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
  "$SCRIPT_DIR/extension/" "$RUNTIME_ROOT/extension/"

# --- RUNTIME DEPS ---
# Some compiled JS modules (e.g. citadel/frontend-prop-drift-audit.js) import
# packages from extension/node_modules at module-load. Since rsync excludes
# node_modules, symlink the specific runtime deps the deployed code needs.
# Recreated each install.sh run because --delete-excluded above blows them away.
mkdir -p "$RUNTIME_ROOT/extension/node_modules"
for dep in typescript; do
  if [ -d "$SCRIPT_DIR/extension/node_modules/$dep" ]; then
    ln -sfn "$SCRIPT_DIR/extension/node_modules/$dep" "$RUNTIME_ROOT/extension/node_modules/$dep"
  fi
done

# Merge pickle_settings: repo defaults as base, user values overlaid (preserves customizations)
if [ -f "$RUNTIME_ROOT/pickle_settings.json" ]; then
  TMPFILE="$(mktemp)"
  jq -s '.[0] * .[1]' "$SCRIPT_DIR/pickle_settings.json" "$RUNTIME_ROOT/pickle_settings.json" > "$TMPFILE" \
    && mv "$TMPFILE" "$RUNTIME_ROOT/pickle_settings.json"
elif [ -f "$LEGACY_CLAUDE_RUNTIME_ROOT/pickle_settings.json" ]; then
  TMPFILE="$(mktemp)"
  jq -s '.[0] * .[1]' "$SCRIPT_DIR/pickle_settings.json" "$LEGACY_CLAUDE_RUNTIME_ROOT/pickle_settings.json" > "$TMPFILE" \
    && mv "$TMPFILE" "$RUNTIME_ROOT/pickle_settings.json"
else
  cp "$SCRIPT_DIR/pickle_settings.json" "$RUNTIME_ROOT/"
fi
# Store persona snippet — append this to your project's AGENTS.md/CLAUDE.md/GEMINI.md.
cp "$SCRIPT_DIR/persona.md" "$RUNTIME_ROOT/persona.md"
# Szechuan Sauce principles references — used by /szechuan-sauce command
for f in "$SCRIPT_DIR"/extension/szechuan-sauce-*-principles.md "$SCRIPT_DIR/extension/szechuan-sauce-principles.md"; do
  [ -f "$f" ] && cp "$f" "$RUNTIME_ROOT/$(basename "$f")"
done

# --- PERMISSIONS (files with shebangs that may be invoked directly) ---
chmod +x "$RUNTIME_ROOT/extension/hooks/dispatch.js"
chmod +x "$RUNTIME_ROOT/extension/bin/setup.js"
chmod +x "$RUNTIME_ROOT/extension/bin/cancel.js"
chmod +x "$RUNTIME_ROOT/extension/bin/spawn-morty.js"
chmod +x "$RUNTIME_ROOT/extension/bin/worker-setup.js"
chmod +x "$RUNTIME_ROOT/extension/bin/jar-runner.js"
chmod +x "$RUNTIME_ROOT/extension/bin/status.js"
chmod +x "$RUNTIME_ROOT/extension/bin/retry-ticket.js"
chmod +x "$RUNTIME_ROOT/extension/bin/mux-runner.js"
chmod +x "$RUNTIME_ROOT/extension/bin/microverse-runner.js"
chmod +x "$RUNTIME_ROOT/extension/bin/init-microverse.js"
chmod +x "$RUNTIME_ROOT/extension/bin/resolve-scope.js"
ln -sf "$RUNTIME_ROOT/extension/bin/mux-runner.js" "$RUNTIME_ROOT/extension/bin/tmux-runner.js"
chmod +x "$RUNTIME_ROOT/extension/bin/monitor.js"
chmod +x "$RUNTIME_ROOT/extension/bin/log-watcher.js"
chmod +x "$RUNTIME_ROOT/extension/bin/morty-watcher.js"
chmod +x "$RUNTIME_ROOT/extension/bin/spawn-refinement-team.js"
chmod +x "$RUNTIME_ROOT/extension/bin/get-session.js"
chmod +x "$RUNTIME_ROOT/extension/bin/update-state.js"
[ -f "$RUNTIME_ROOT/extension/bin/validate-teams-ticket.js" ] && chmod +x "$RUNTIME_ROOT/extension/bin/validate-teams-ticket.js"
chmod +x "$RUNTIME_ROOT/extension/bin/log-activity.js"
chmod +x "$RUNTIME_ROOT/extension/bin/log-commit.js"
chmod +x "$RUNTIME_ROOT/extension/bin/prune-activity.js"
chmod +x "$RUNTIME_ROOT/extension/bin/standup.js"
chmod +x "$RUNTIME_ROOT/extension/bin/metrics.js"
chmod +x "$RUNTIME_ROOT/extension/bin/circuit-reset.js"
chmod +x "$RUNTIME_ROOT/extension/bin/sync-schema.js"
# Make tsc resolvable from the repo root for sync-schema validation (npx tsc from parent dir)
mkdir -p "$SCRIPT_DIR/node_modules/.bin"
ln -sf "$SCRIPT_DIR/extension/node_modules/.bin/tsc" "$SCRIPT_DIR/node_modules/.bin/tsc"
chmod +x "$RUNTIME_ROOT/extension/bin/dot-builder-cli.js"
chmod +x "$RUNTIME_ROOT/extension/bin/dot-builder.js"
chmod +x "$RUNTIME_ROOT/extension/bin/plumbus-frame-analyzer.js"
chmod +x "$RUNTIME_ROOT/extension/bin/check-gate.js"
chmod +x "$RUNTIME_ROOT/extension/bin/finalize-gate.js"
chmod +x "$RUNTIME_ROOT/extension/bin/spawn-gate-remediator.js"
chmod +x "$RUNTIME_ROOT/extension/scripts/tmux-monitor.sh"

# --- INTERNAL TEMPLATES (hidden from slash command list) ---
if [ -d "$SCRIPT_DIR/templates" ]; then
  rsync -a "$SCRIPT_DIR/templates/" "$RUNTIME_ROOT/templates/"
fi

file_size() {
  stat -f '%z' "$1" 2>/dev/null || stat -c '%s' "$1"
}
file_mtime() {
  stat -f '%m' "$1" 2>/dev/null || stat -c '%Y' "$1"
}
same_size_and_mtime() {
  [ "$(file_size "$1")" = "$(file_size "$2")" ] && [ "$(file_mtime "$1")" = "$(file_mtime "$2")" ]
}

install_claude_adapter() {
  local host_json="$1"
  local claude_root="$HOME/.claude"
  local settings_file="$claude_root/settings.json"
  local commands_dir="$claude_root/commands"
  local agents_dir="$claude_root/agents"
  local managed_agents_dir="$agents_dir/.pickle-managed"
  local backup_path=""

  if [ ! -d "$claude_root" ]; then
    write_host_json "$host_json" "claude" "skipped" "$claude_root" "$settings_file" 0 0 "[]" "[]" "{}" "host root not found"
    echo "ℹ️  Claude host not found — skipping Claude adapter"
    return 0
  fi
  if [ ! -f "$settings_file" ]; then
    write_host_json "$host_json" "claude" "skipped" "$claude_root" "$settings_file" 0 0 "[]" "[]" "{}" "settings.json not found"
    echo "ℹ️  Claude settings not found — skipping Claude adapter"
    return 0
  fi
  if ! jq . "$settings_file" >/dev/null 2>&1; then
    write_host_json "$host_json" "claude" "error" "$claude_root" "$settings_file" 0 0 "[]" "[]" "{}" "settings.json is not valid JSON"
    echo "❌ Claude settings.json is not valid JSON — Claude adapter skipped"
    return 0
  fi

  # Keep legacy Claude hook path usable while shared runtime is the canonical install.
  mkdir -p "$LEGACY_CLAUDE_RUNTIME_ROOT"
  rsync -a --delete "$RUNTIME_ROOT/" "$LEGACY_CLAUDE_RUNTIME_ROOT/"

  mkdir -p "$claude_root/backups"
  backup_path="$claude_root/backups/settings.json.pickle-backup.$(date +%s).$$"
  cp "$settings_file" "$backup_path"
  echo "✅ Backed up Claude settings.json to $backup_path"

  # --- AGENTS ---
  # Subagent definitions for /pickle --teams.
  # Canonical Pickle agents install under .pickle-managed so top-level files remain user overrides.
  # No --delete: preserve locally-added managed agents from newer/experimental installs.
  if [ -d "$AGENTS_SOURCE_DIR" ]; then
    mkdir -p "$agents_dir" "$managed_agents_dir"
    for src_agent in "$AGENTS_SOURCE_DIR"/*.md; do
      [ -e "$src_agent" ] || continue
      agent_file="$(basename "$src_agent")"
      legacy_agent="$agents_dir/$agent_file"
      managed_agent="$managed_agents_dir/$agent_file"
      if [ -f "$legacy_agent" ]; then
        if same_size_and_mtime "$legacy_agent" "$src_agent"; then
          if [ -e "$managed_agent" ]; then
            rm -f "$legacy_agent"
            echo "ℹ️  Removed legacy duplicate agent $legacy_agent; managed copy already exists."
          else
            mv "$legacy_agent" "$managed_agent"
            echo "ℹ️  Migrated legacy Pickle agent $agent_file to $managed_agents_dir/"
          fi
        else
          echo "⚠️  Legacy agent conflict preserved at $legacy_agent; canonical Pickle copy installs to $managed_agents_dir/$agent_file"
        fi
      fi
    done
    rsync -a "$AGENTS_SOURCE_DIR/" "$managed_agents_dir/"
    echo "✅ Agent definitions installed to $managed_agents_dir/"
  fi

  # --- COMMANDS ---
  # rsync all commands from .claude/commands/; no --delete to preserve user commands.
  mkdir -p "$commands_dir"
  rsync -a "$COMMANDS_SOURCE_DIR/" "$commands_dir/"

  # Clean up legacy commands AFTER rsync (so they're removed even if source still had them)
  rm -f "$commands_dir/microverse.md"
  rm -f "$commands_dir/pickle-microverse-tmux.md"

  # --- STOP HOOK (idempotent jq merge, $HOME stays LITERAL in JSON) ---
  if jq -e '.hooks.Stop // [] | map(.hooks // [] | map(.command)) | flatten | any(. == "node $HOME/.claude/pickle-rick/extension/hooks/dispatch.js stop-hook")' \
      "$settings_file" >/dev/null 2>&1; then
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
    ' "$settings_file" > "$TMPFILE" \
      && mv "$TMPFILE" "$settings_file"
    echo "✅ Registered Stop hook in $settings_file"
  fi

  # --- POST-TOOL-USE HOOK (git commit activity logger, idempotent) ---
  COMMIT_HOOK_CMD='node $HOME/.claude/pickle-rick/extension/bin/log-commit.js'
  if jq -e --arg cmd "$COMMIT_HOOK_CMD" \
      '.hooks.PostToolUse // [] | map(.hooks // [] | map(.command)) | flatten | any(. == $cmd)' \
      "$settings_file" >/dev/null 2>&1; then
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
    ' "$settings_file" > "$TMPFILE" \
      && mv "$TMPFILE" "$settings_file"
    echo "✅ Registered PostToolUse hook in $settings_file"
  fi

  # --- PRE-TOOL-USE HOOKS (merge from source settings, preserving existing entries) ---
  SOURCE_PTU_COUNT=$(jq '.hooks.PreToolUse // [] | length' "$SOURCE_SETTINGS" 2>/dev/null || echo "0")
  if [ "$SOURCE_PTU_COUNT" -gt 0 ]; then
    echo "🔧 Merging $SOURCE_PTU_COUNT PreToolUse hook group(s) from source..."
    for i in $(seq 0 $((SOURCE_PTU_COUNT - 1))); do
      # Extract the command from the source hook group
      SRC_CMD=$(jq -r ".hooks.PreToolUse[$i].hooks[0].command" "$SOURCE_SETTINGS")
      # Check if this command already exists in deployed settings
      if jq -e --arg cmd "$SRC_CMD" \
          '.hooks.PreToolUse // [] | map(.hooks // [] | map(.command)) | flatten | any(. == $cmd)' \
          "$settings_file" >/dev/null 2>&1; then
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
        ' "$settings_file" > "$TMPFILE" \
          && mv "$TMPFILE" "$settings_file"
        echo "✅ Registered PreToolUse hook: $SRC_CMD"
      fi
    done
  else
    echo "ℹ️  No PreToolUse hooks in source settings — existing hooks preserved"
  fi

  # --- VALIDATE result ---
  if ! jq . "$settings_file" >/dev/null 2>&1; then
    write_host_json "$host_json" "claude" "error" "$claude_root" "$settings_file" "$COMMAND_SOURCE_COUNT" "$AGENT_SOURCE_COUNT" "[]" "$(printf '%s\n' "$backup_path" | jq -R . | jq -s .)" "{}" "settings.json corrupted after merge; restore from backup"
    echo "❌ Claude settings.json corrupted after merge — restore from backup"
    return 0
  fi

  local files_json
  local backups_json
  files_json="$(json_array_from_find "$commands_dir")"
  local agent_files_json
  agent_files_json="$(json_array_from_find "$managed_agents_dir")"
  files_json="$(jq -n --argjson a "$files_json" --argjson b "$agent_files_json" '$a + $b')"
  files_json="$(jq -n --arg legacy "$LEGACY_CLAUDE_RUNTIME_ROOT" --argjson files "$files_json" '$files + [$legacy]')"
  backups_json="$(printf '%s\n' "$backup_path" | jq -R . | jq -s .)"
  local checksums_json
  checksums_json="$(checksums_json_from_files "$files_json")"
  write_host_json "$host_json" "claude" "installed" "$claude_root" "$settings_file" "$COMMAND_SOURCE_COUNT" "$AGENT_SOURCE_COUNT" "$files_json" "$backups_json" "$checksums_json" ""
}

install_codex_adapter() {
  local host_json="$1"
  local codex_root="$HOME/.codex"
  local adapter_root="$codex_root/pickle-rick"
  local prompts_dir="$codex_root/prompts/pickle-rick"

  if [ ! -d "$codex_root" ]; then
    write_host_json "$host_json" "codex" "skipped" "$codex_root" "" 0 0 "[]" "[]" "{}" "host root not found"
    echo "ℹ️  Codex host not found — skipping Codex adapter"
    return 0
  fi

  mkdir -p "$adapter_root" "$prompts_dir"
  cp "$RUNTIME_ROOT/persona.md" "$adapter_root/persona.md"
  printf '%s\n' "$RUNTIME_ROOT" > "$adapter_root/runtime_root"
  rsync -a "$COMMANDS_SOURCE_DIR/" "$prompts_dir/"
  echo "✅ Codex adapter installed to $adapter_root and $prompts_dir/"

  local files_json
  local adapter_files_json
  files_json="$(json_array_from_find "$prompts_dir")"
  adapter_files_json="$(json_array_from_find "$adapter_root")"
  files_json="$(jq -n --argjson a "$files_json" --argjson b "$adapter_files_json" '$a + $b')"
  local checksums_json
  checksums_json="$(checksums_json_from_files "$files_json")"
  write_host_json "$host_json" "codex" "installed" "$codex_root" "" "$COMMAND_SOURCE_COUNT" 0 "$files_json" "[]" "$checksums_json" ""
}

install_gemini_adapter() {
  local host_json="$1"
  local gemini_root="$HOME/.gemini"
  local settings_file="$gemini_root/settings.json"
  local adapter_root="$gemini_root/extensions/pickle-rick"
  local command_md_dir="$adapter_root/commands-md"
  local command_toml_dir="$adapter_root/commands"

  if [ ! -d "$gemini_root" ]; then
    write_host_json "$host_json" "gemini" "skipped" "$gemini_root" "$settings_file" 0 0 "[]" "[]" "{}" "host root not found"
    echo "ℹ️  Gemini host not found — skipping Gemini adapter"
    return 0
  fi
  if [ -f "$settings_file" ] && ! jq . "$settings_file" >/dev/null 2>&1; then
    write_host_json "$host_json" "gemini" "error" "$gemini_root" "$settings_file" 0 0 "[]" "[]" "{}" "settings.json is not valid JSON"
    echo "❌ Gemini settings.json is not valid JSON — Gemini adapter skipped"
    return 0
  fi

  mkdir -p "$adapter_root" "$command_md_dir" "$command_toml_dir"
  cp "$RUNTIME_ROOT/persona.md" "$adapter_root/persona.md"
  printf '%s\n' "$RUNTIME_ROOT" > "$adapter_root/runtime_root"
  rsync -a "$COMMANDS_SOURCE_DIR/" "$command_md_dir/"

  for command_md in "$COMMANDS_SOURCE_DIR"/*.md; do
    [ -e "$command_md" ] || continue
    command_name="$(basename "$command_md" .md)"
    command_target="$command_md_dir/$(basename "$command_md")"
    render_gemini_toml "$command_name" "$command_target" > "$command_toml_dir/$command_name.toml"
  done
  echo "✅ Gemini adapter installed to $adapter_root/"

  local files_json
  local toml_files_json
  local adapter_files_json
  files_json="$(json_array_from_find "$command_md_dir")"
  toml_files_json="$(json_array_from_find "$command_toml_dir")"
  adapter_files_json="$(json_array_from_find "$adapter_root")"
  files_json="$(jq -n --argjson a "$files_json" --argjson b "$toml_files_json" --argjson c "$adapter_files_json" '$a + $b + $c | unique')"
  local checksums_json
  checksums_json="$(checksums_json_from_files "$files_json")"
  write_host_json "$host_json" "gemini" "installed" "$gemini_root" "$settings_file" "$COMMAND_SOURCE_COUNT" 0 "$files_json" "[]" "$checksums_json" ""
}

HOST_TMPDIR="$(mktemp -d)"
trap 'rm -rf "$HOST_TMPDIR"; if [ -n "${LOCKDIR:-}" ]; then rmdir "$LOCKDIR" 2>/dev/null || true; fi' EXIT
CLAUDE_HOST_JSON="$HOST_TMPDIR/claude.json"
CODEX_HOST_JSON="$HOST_TMPDIR/codex.json"
GEMINI_HOST_JSON="$HOST_TMPDIR/gemini.json"

install_claude_adapter "$CLAUDE_HOST_JSON"
install_codex_adapter "$CODEX_HOST_JSON"
install_gemini_adapter "$GEMINI_HOST_JSON"

RUNTIME_FILES_JSON="$(json_array_from_find "$RUNTIME_ROOT")"
PACKAGE_JSON_SHA256="$(sha256_file "$SCRIPT_DIR/extension/package.json")"
PICKLE_SETTINGS_SHA256="$(sha256_file "$SCRIPT_DIR/pickle_settings.json")"
INSTALLED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

TMP_MANIFEST="$(mktemp)"
jq -n \
  --arg schema_version "1" \
  --arg package_version "$PACKAGE_VERSION" \
  --arg installed_at "$INSTALLED_AT" \
  --arg runtime_root "$RUNTIME_ROOT" \
  --arg data_root "$DATA_ROOT" \
  --arg source_root "$SCRIPT_DIR" \
  --arg manifest_file "$MANIFEST_FILE" \
  --arg package_json_sha256 "$PACKAGE_JSON_SHA256" \
  --arg pickle_settings_sha256 "$PICKLE_SETTINGS_SHA256" \
  --argjson runtime_files "$RUNTIME_FILES_JSON" \
  --slurpfile claude "$CLAUDE_HOST_JSON" \
  --slurpfile codex "$CODEX_HOST_JSON" \
  --slurpfile gemini "$GEMINI_HOST_JSON" \
  '{
    schema_version: ($schema_version | tonumber),
    package_version: $package_version,
    installed_at: $installed_at,
    runtime_root: $runtime_root,
    data_root: $data_root,
    source_root: $source_root,
    manifest_file: $manifest_file,
    checksums: {
      "extension/package.json": $package_json_sha256,
      "pickle_settings.json": $pickle_settings_sha256
    },
    runtime: {
      files_written: $runtime_files
    },
    hosts: {
      claude: $claude[0],
      codex: $codex[0],
      gemini: $gemini[0]
    }
  }' > "$TMP_MANIFEST" \
  && mv "$TMP_MANIFEST" "$MANIFEST_FILE"

echo ""
echo "✅ Pickle Rick universal installer finished!"
echo "🧾 Manifest: $MANIFEST_FILE"
echo ""
echo "📝 Persona setup — add the Pickle Rick persona to your project's AGENTS.md/CLAUDE.md/GEMINI.md:"
echo ""
echo "   cat $RUNTIME_ROOT/persona.md >> /path/to/project/AGENTS.md"
echo ""
echo "Get started in Claude Code: /pickle \"your task here\""
echo "Queue tasks for later:      /add-to-pickle-jar  then  /pickle-jar-open"

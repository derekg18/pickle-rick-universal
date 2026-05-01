#!/bin/bash
set -e

# uninstall-hooks.sh — Remove Pickle Rick hooks from ~/.claude/settings.json
# without touching extension files or slash commands.
#
# Use this when you want to disable pickle-rick's automatic behavior
# (Stop hook enforcement, commit logging, config protection) but keep
# the /pickle, /pickle-dot, etc. slash commands available for manual use.
#
# To re-enable hooks later, run install.sh again. Commands are preserved.

SETTINGS_FILE="$HOME/.claude/settings.json"

echo "🥒 Removing Pickle Rick hooks from settings.json..."

# --- VALIDATION ---
if [ -z "$HOME" ]; then echo "❌ \$HOME is not set — aborting."; exit 1; fi
jq --version >/dev/null 2>&1 || { echo "❌ jq not found on PATH"; exit 1; }
[ -f "$SETTINGS_FILE" ] || { echo "ℹ️  No settings.json at $SETTINGS_FILE — nothing to do."; exit 0; }
jq . "$SETTINGS_FILE" >/dev/null 2>&1 || { echo "❌ settings.json is not valid JSON — aborting."; exit 1; }

# --- BACKUP ---
mkdir -p "$HOME/.claude/backups"
BACKUP_FILE="$HOME/.claude/backups/settings.json.pickle-uninstall-hooks.$(date +%s)"
cp "$SETTINGS_FILE" "$BACKUP_FILE"
echo "✅ Backed up settings.json to $BACKUP_FILE"

# --- HOOK COMMANDS TO REMOVE ---
# These are the literal command strings install.sh registers.
# $HOME is intentionally LITERAL in the JSON — matches install.sh behavior.
STOP_CMD='node $HOME/.claude/pickle-rick/extension/hooks/dispatch.js stop-hook'
POST_CMD='node $HOME/.claude/pickle-rick/extension/bin/log-commit.js'
PRE_CMD='node $HOME/.claude/pickle-rick/extension/hooks/dispatch.js config-protection'

# --- REMOVE HOOKS BY COMMAND MATCH ---
# For each event, filter out any hook group whose .hooks[].command matches
# our target command. Then prune empty groups and empty event arrays.
remove_hook() {
  local event="$1"
  local cmd="$2"
  local tmp
  tmp="$(mktemp)"
  jq --arg event "$event" --arg cmd "$cmd" '
    if .hooks[$event] then
      .hooks[$event] = [
        .hooks[$event][] |
        .hooks = (.hooks // [] | map(select(.command != $cmd))) |
        select((.hooks // []) | length > 0)
      ] |
      if (.hooks[$event] | length) == 0 then del(.hooks[$event]) else . end |
      if (.hooks | length) == 0 then del(.hooks) else . end
    else . end
  ' "$SETTINGS_FILE" > "$tmp" && mv "$tmp" "$SETTINGS_FILE"
}

remove_hook "Stop"        "$STOP_CMD" && echo "✅ Removed Stop hook (stop-hook)"
remove_hook "PostToolUse" "$POST_CMD" && echo "✅ Removed PostToolUse hook (log-commit)"
remove_hook "PreToolUse"  "$PRE_CMD"  && echo "✅ Removed PreToolUse hook (config-protection)"

# --- VALIDATE result ---
jq . "$SETTINGS_FILE" >/dev/null 2>&1 || {
  echo "❌ settings.json corrupted — restoring from backup"
  cp "$BACKUP_FILE" "$SETTINGS_FILE"
  exit 1
}

echo ""
echo "✅ Pickle Rick hooks removed."
echo "📝 Extension files at ~/.claude/pickle-rick/ and slash commands at ~/.claude/commands/ are preserved."
echo "📝 To fully uninstall, run: bash uninstall.sh"
echo "📝 To reinstall hooks, run: bash install.sh"

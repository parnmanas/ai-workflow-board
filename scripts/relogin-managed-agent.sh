#!/usr/bin/env bash
# Re-login a managed agent's claude CLI.
#
# Linux/macOS counterpart of scripts/relogin-managed-agent.ps1. See that
# file for the full rationale; the short version: agent-manager isolates
# each agent's claude CLI state under
#   $AWB_AGENT_MANAGER_HOME/agents/<agent_id>/cli-home/
# (default $AWB_AGENT_MANAGER_HOME = $XDG_CONFIG_HOME/awb-agent-manager
#  or ~/.config/awb-agent-manager). A normal `claude /login` writes to
# ~/.claude/.credentials.json — the wrong place. This script redirects
# CLAUDE_CONFIG_DIR to the per-agent dir, runs the OAuth flow, and
# verifies the resulting token.
#
# Two follow-up paths after this script succeeds:
#   A. Direct injection (what this script does): restart the agent in AWB
#      UI; the file is re-read on every subagent spawn.
#   B. Remote injection: pass --show-credential to print the new file
#      content, paste into AWB Admin -> Credentials -> Claude (Subscription),
#      attach to the agent. Future renewals can be done from the AWB UI.
#
# Usage:
#   scripts/relogin-managed-agent.sh                      # auto-pick single agent
#   scripts/relogin-managed-agent.sh --agent-id <uuid>
#   scripts/relogin-managed-agent.sh --list
#   scripts/relogin-managed-agent.sh --agent-id <uuid> --show-credential

set -euo pipefail

AGENT_ID=""
MANAGER_HOME=""
CLAUDE_BIN=""
LIST=0
SHOW_CRED=0
FORCE=0

usage() {
  sed -n '2,30p' "$0"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --agent-id)        AGENT_ID="$2"; shift 2 ;;
    --manager-home)    MANAGER_HOME="$2"; shift 2 ;;
    --claude-bin)      CLAUDE_BIN="$2"; shift 2 ;;
    --list)            LIST=1; shift ;;
    --show-credential) SHOW_CRED=1; shift ;;
    --force|-f)        FORCE=1; shift ;;
    -h|--help)         usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage; exit 1 ;;
  esac
done

resolve_manager_home() {
  if [ -n "${MANAGER_HOME}" ]; then echo "${MANAGER_HOME}"; return; fi
  if [ -n "${AWB_AGENT_MANAGER_HOME:-}" ]; then echo "${AWB_AGENT_MANAGER_HOME}"; return; fi
  if [ -n "${XDG_CONFIG_HOME:-}" ]; then echo "${XDG_CONFIG_HOME}/awb-agent-manager"; return; fi
  echo "${HOME}/.config/awb-agent-manager"
}

# Best-effort JSON field extraction without requiring jq. Looks for
#   "field": "value"   or   "field": <number>
# and returns the value (string unwrapped, number as-is).
json_field() {
  local file="$1" path="$2"
  python3 - "$file" "$path" <<'PY' 2>/dev/null || true
import json, sys
try:
    with open(sys.argv[1]) as f:
        obj = json.load(f)
    for k in sys.argv[2].split('.'):
        obj = obj.get(k) if isinstance(obj, dict) else None
        if obj is None:
            sys.exit(0)
    print(obj)
except Exception:
    sys.exit(0)
PY
}

show_summary() {
  local label="$1" file="$2"
  if [ ! -f "$file" ]; then
    echo "$label : (not present)"
    return
  fi
  local exp rt sub
  exp="$(json_field "$file" claudeAiOauth.expiresAt || true)"
  rt="$(json_field "$file" claudeAiOauth.refreshToken || true)"
  sub="$(json_field "$file" claudeAiOauth.subscriptionType || true)"
  if [ -z "$exp" ]; then
    echo "$label : (file present but no claudeAiOauth.expiresAt — perhaps another auth shape)"
    return
  fi
  local now_ms
  now_ms="$(($(date +%s) * 1000))"
  local state="valid"
  if [ "$exp" -le "$now_ms" ]; then state="EXPIRED"; fi
  local rt_state="present"
  if [ -z "$rt" ]; then rt_state="EMPTY (no auto-refresh)"; fi
  local exp_iso
  exp_iso="$(date -u -d "@$((exp / 1000))" +%FT%TZ 2>/dev/null || python3 -c "import datetime,sys;print(datetime.datetime.utcfromtimestamp(int(sys.argv[1])//1000).isoformat()+'Z')" "$exp")"
  echo "$label : expiresAt=$exp_iso ($state), refreshToken=$rt_state, subscription=$sub"
}

HOME_DIR="$(resolve_manager_home)"
AGENTS_DIR="$HOME_DIR/agents"
echo "agent-manager home : $HOME_DIR"
echo "agents dir         : $AGENTS_DIR"

if [ ! -d "$AGENTS_DIR" ]; then
  echo "No agents dir at $AGENTS_DIR" >&2
  exit 1
fi

mapfile -t AGENT_DIRS < <(find "$AGENTS_DIR" -mindepth 1 -maxdepth 1 -type d | sort)

list_agents() {
  for d in "${AGENT_DIRS[@]}"; do
    local id name cli ws
    id="$(basename "$d")"
    name="$(json_field "$d/config.json" name || echo '?')"
    cli="$(json_field "$d/config.json" cli || echo '?')"
    ws="$(json_field "$d/config.json" workspace_id || echo '?')"
    echo "  - $id  name=$name  cli=$cli  workspace=$ws"
  done
}

if [ "$LIST" -eq 1 ] || [ -z "$AGENT_ID" ]; then
  if [ "${#AGENT_DIRS[@]}" -eq 0 ]; then
    echo "No agents found under $AGENTS_DIR" >&2
    exit 1
  fi
  echo
  echo "Agents:"
  list_agents
  if [ "$LIST" -eq 1 ]; then exit 0; fi
  if [ "${#AGENT_DIRS[@]}" -eq 1 ]; then
    AGENT_ID="$(basename "${AGENT_DIRS[0]}")"
    echo
    echo "(auto-selecting the only agent: $AGENT_ID)"
  else
    echo
    echo "Multiple agents present — pass --agent-id <uuid> to pick one." >&2
    exit 1
  fi
fi

AGENT_DIR="$AGENTS_DIR/$AGENT_ID"
if [ ! -d "$AGENT_DIR" ]; then
  echo "Agent dir not found: $AGENT_DIR" >&2
  exit 1
fi
CLI_TYPE="$(json_field "$AGENT_DIR/config.json" cli || echo '?')"
if [ "$CLI_TYPE" != "claude" ] && [ "$CLI_TYPE" != "?" ]; then
  echo "Agent uses CLI '$CLI_TYPE', not claude — this script is claude-only." >&2
  exit 1
fi
AGENT_NAME="$(json_field "$AGENT_DIR/config.json" name || echo '?')"
WS_ID="$(json_field "$AGENT_DIR/config.json" workspace_id || echo '?')"

CLI_HOME="$AGENT_DIR/cli-home"
CRED_PATH="$CLI_HOME/.credentials.json"

echo
echo "Selected agent     : $AGENT_NAME  ($AGENT_ID)"
echo "Workspace          : $WS_ID"
echo "CLAUDE_CONFIG_DIR  : $CLI_HOME"
echo

mkdir -p "$CLI_HOME"

show_summary 'BEFORE' "$CRED_PATH"

if [ "$FORCE" -ne 1 ]; then
  echo
  read -r -p 'Proceed with `claude /login` against the per-agent cli-home? [y/N] ' reply
  case "$reply" in
    [Yy]*) ;;
    *) echo 'Aborted by user.'; exit 0 ;;
  esac
fi

if [ -z "$CLAUDE_BIN" ]; then
  if ! CLAUDE_BIN="$(command -v claude)"; then
    echo "claude CLI not found on PATH. Pass --claude-bin <path> or install @anthropic-ai/claude-code." >&2
    exit 1
  fi
fi

echo "claude bin         : $CLAUDE_BIN"
echo
echo 'Launching `claude /login` — complete OAuth in your browser, then return here.'

CLAUDE_CONFIG_DIR="$CLI_HOME" "$CLAUDE_BIN" /login || true

echo
show_summary 'AFTER ' "$CRED_PATH"
echo

if [ ! -f "$CRED_PATH" ]; then
  echo "No .credentials.json was written. Login likely failed." >&2
  exit 1
fi
EXP="$(json_field "$CRED_PATH" claudeAiOauth.expiresAt || true)"
RT="$(json_field "$CRED_PATH" claudeAiOauth.refreshToken || true)"
NOW_MS="$(($(date +%s) * 1000))"
if [ -z "$EXP" ] || [ "$EXP" -le "$NOW_MS" ]; then
  echo "New token missing or already expired. Aborting." >&2
  exit 1
fi
if [ -z "$RT" ]; then
  echo "WARNING: refreshToken is empty. The CLI cannot auto-renew this token; it will expire silently. Track the expiry above or use a Claude (API Key) credential for unattended agents."
fi

echo
echo "Direct method (Method A) — done."
echo "Restart the agent in AWB so the next subagent spawn picks up the new token:"
echo "  AWB Admin -> Agent Manager -> $AGENT_NAME -> Restart"
echo

if [ "$SHOW_CRED" -eq 1 ]; then
  echo 'Remote-injection payload (Method B) — paste into AWB Admin -> Credentials -> Claude (Subscription) -> credentials_json:'
  echo
  echo '----- BEGIN credentials_json -----'
  cat "$CRED_PATH"
  echo
  echo '----- END credentials_json -----'
  echo
  echo "After saving the credential, attach it to agent '$AGENT_NAME' in AWB Admin -> Agent Manager -> Edit -> CLI credential, then Restart."
else
  echo '(re-run with --show-credential to also print the JSON for AWB Admin -> Credentials remote injection.)'
fi

#!/usr/bin/env bash
# Claude2GrokBot executor client (bash + curl + jq 1.6+). Same commands as relay.py:
#   relay.sh ping | next | heartbeat ["note"] | block "why" | attach FILE... | done completed|failed RESULT_FILE|- ["error"]
# Config: RELAY_URL, RELAY_EXECUTOR_KEY, optional RELAY_EXECUTOR, from env or ~/.config/claude2grokbot/executor.env
# The executor key is passed to curl via stdin (-K -), so it never appears in the process list.
set -euo pipefail

CONF="${CLAUDE2GROKBOT_CONFIG:-$HOME/.config/claude2grokbot/executor.env}"
STATE_DIR="$HOME/.claude2grokbot"
STATE="$STATE_DIR/current.json"

die() { echo "claude2grokbot: $*" >&2; exit "${2:-1}"; }
# 403 = token no longer valid; 409 with a terminal state = canceled/finished elsewhere
task_gone() { [[ "$1" == 403 ]] || { [[ "$1" == 409 ]] && jq -e '.state | IN("completed","failed","canceled","rejected")' "$2" >/dev/null 2>&1; }; }
command -v curl >/dev/null || die "curl is required" 2
command -v jq >/dev/null || die "jq is required (or use relay.py)" 2

# Read KEY=VALUE lines from the config file; environment variables win.
if [[ -f "$CONF" ]]; then
  while IFS='=' read -r k v || [[ -n "${k:-}" ]]; do
    k="${k//[[:space:]]/}"; [[ "$k" =~ ^RELAY_[A-Z_]+$ ]] || continue
    v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
    [[ -z "${!k:-}" ]] && export "$k=$v"
  done < "$CONF"
fi

need_conf() { [[ -n "${RELAY_URL:-}" && -n "${RELAY_EXECUTOR_KEY:-}" ]] || die "set RELAY_URL and RELAY_EXECUTOR_KEY (env or $CONF)" 2; }

# curl with the executor key from stdin; prints body to $2, returns HTTP code
authed() { # method url body_file_or_empty out_file
  local method="$1" url="$2" body="$3" out="$4"
  local args=(-sS -X "$method" -o "$out" -w '%{http_code}' -H 'Content-Type: application/json' --max-time 60)
  [[ -n "$body" ]] && args+=(--data-binary "@$body")
  printf 'header = "Authorization: Bearer %s"\n' "$RELAY_EXECUTOR_KEY" | curl -K - "${args[@]}" "$url"
}
plain() { # method url body_file out_file
  curl -sS -X "$1" -o "$4" -w '%{http_code}' -H 'Content-Type: application/json' --max-time 60 --data-binary "@$3" "$2"
}

TMP="$(mktemp)"; BODY="$(mktemp)"; trap 'rm -f "$TMP" "$BODY"' EXIT
cmd="${1:-help}"; shift || true

case "$cmd" in
  ping)
    need_conf
    code=$(authed GET "${RELAY_URL%/}/executor/ping" "" "$TMP")
    [[ "$code" == 200 ]] || die "ping failed: HTTP $code $(cat "$TMP")"
    jq . "$TMP" ;;

  next)
    need_conf
    [[ -f "$STATE" ]] && echo "claude2grokbot: note: task $(jq -r .task_id "$STATE") was never finished; claiming a new one anyway" >&2
    jq -n --arg e "${RELAY_EXECUTOR:-}" 'if $e == "" then {} else {executor: $e} end' > "$BODY"
    code=$(authed POST "${RELAY_URL%/}/executor/claim" "$BODY" "$TMP")
    if [[ "$code" == 204 ]]; then echo "NO_TASK"; exit 3; fi
    [[ "$code" == 200 ]] || die "claim failed: HTTP $code $(cat "$TMP")"
    mkdir -p -m 700 "$STATE_DIR"
    (umask 077; jq '{task_id: .task.id, result_token, result_url, heartbeat_url, attachment_url}' "$TMP" > "$STATE")
    jq '.task + {lease_expires_at, rules}' "$TMP" ;;

  heartbeat)
    [[ -f "$STATE" ]] || die "no current task" 2
    jq --arg n "${*:-}" '{task_id, result_token, note: (if $n == "" then null else $n end)}' "$STATE" > "$BODY"
    code=$(plain POST "$(jq -r .heartbeat_url "$STATE")" "$BODY" "$TMP")
    if task_gone "$code" "$TMP"; then rm -f "$STATE"; die "heartbeat rejected (stop working on this task): $(cat "$TMP")"; fi
    [[ "$code" == 200 ]] || die "heartbeat failed: HTTP $code $(cat "$TMP")"
    jq . "$TMP" ;;

  attach)
    [[ -f "$STATE" ]] || die "no current task" 2
    (( $# )) || die "usage: relay.sh attach FILE [FILE...]" 2
    url="$(jq -r '.attachment_url // (.result_url | sub("/executor/result$"; "/executor/attachment"))' "$STATE")"
    for f in "$@"; do
      [[ -f "$f" ]] || die "not a file: $f" 2
      ctype="$(file --brief --mime-type "$f" 2>/dev/null || echo application/octet-stream)"
      name="$(basename "$f" | jq -Rr @uri)"
      code=$(jq -r '"header = \"X-Task-Id: \(.task_id)\"\nheader = \"X-Result-Token: \(.result_token)\""' "$STATE" \
        | curl -K - -sS -X POST -o "$TMP" -w '%{http_code}' --max-time 300 -H "Content-Type: $ctype" -H "X-Filename: $name" --data-binary "@$f" "$url")
      if task_gone "$code" "$TMP"; then rm -f "$STATE"; die "attach rejected: $(cat "$TMP")"; fi
      [[ "$code" == 200 ]] || die "attach failed for $f: HTTP $code $(cat "$TMP")"
      jq -c . "$TMP"
    done ;;

  block|done)
    [[ -f "$STATE" ]] || die "no current task" 2
    if [[ "$cmd" == block ]]; then
      jq --arg n "${*:-waiting for user}" '{task_id, result_token, status: "blocked", note: $n}' "$STATE" > "$BODY"
    else
      status="${1:-}"; file="${2:-}"; if (( $# >= 2 )); then shift 2; else shift $#; fi
      [[ "$status" == completed || "$status" == failed ]] || die "usage: relay.sh done completed|failed RESULT_FILE|- [error]" 2
      if [[ "$file" == "-" ]]; then file="$(mktemp)"; cat > "$file"; fi
      if [[ -n "$file" ]]; then
        jq --arg s "$status" --rawfile r "$file" --arg e "${*:-}" \
          '{task_id, result_token, status: $s, result: $r} + (if $s == "failed" and $e != "" then {error: $e} else {} end)' "$STATE" > "$BODY"
      else
        jq --arg s "$status" --arg e "${*:-}" '{task_id, result_token, status: $s} + (if $e != "" then {error: $e} else {} end)' "$STATE" > "$BODY"
      fi
    fi
    code=$(plain POST "$(jq -r .result_url "$STATE")" "$BODY" "$TMP")
    if task_gone "$code" "$TMP"; then rm -f "$STATE"; die "result rejected: $(cat "$TMP")"; fi
    [[ "$code" == 200 ]] || die "result failed: HTTP $code $(cat "$TMP")"
    [[ "$cmd" == done ]] && rm -f "$STATE"
    jq . "$TMP" ;;

  *)
    sed -n '2,5p' "$0" ;;
esac

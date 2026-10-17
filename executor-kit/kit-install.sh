#!/usr/bin/env bash
# Claude2GrokBot executor kit, served by the relay itself so it always matches the deployed version:
#   curl -fsSL <RELAY_URL>/kit/install.sh | RELAY_EXECUTOR_KEY=<key> SKILL_LANG=zh-CN bash
# Installs ~/claude2grokbot/relay.py and ~/claude2grokbot/SKILL.md, writes ~/.config/claude2grokbot/executor.env when a
# key is given (re-running without a key keeps the existing one), then checks the connection.
set -euo pipefail

RELAY_URL="${RELAY_URL:-__RELAY_URL__}"
DIR="$HOME/claude2grokbot"
CONF_DIR="$HOME/.config/claude2grokbot"

mkdir -p "$DIR/out" "$CONF_DIR"
curl -fsSLo "$DIR/relay.py" "$RELAY_URL/kit/relay.py"
chmod +x "$DIR/relay.py"
curl -fsSLo "$DIR/SKILL.md" "$RELAY_URL/kit/SKILL.md?lang=${SKILL_LANG:-en}"

if [[ -n "${RELAY_EXECUTOR_KEY:-}" ]]; then
  (umask 077; printf 'RELAY_URL=%s\nRELAY_EXECUTOR_KEY=%s\n' "$RELAY_URL" "$RELAY_EXECUTOR_KEY" > "$CONF_DIR/executor.env")
fi
[[ -f "$CONF_DIR/executor.env" ]] || { echo "claude2grokbot: set RELAY_EXECUTOR_KEY (first install)" >&2; exit 2; }

python3 "$DIR/relay.py" ping
echo "Installed $DIR/relay.py and $DIR/SKILL.md."
echo "Next: install $DIR/SKILL.md as the skill named \"claude2grokbot\" (replace it if it exists)."

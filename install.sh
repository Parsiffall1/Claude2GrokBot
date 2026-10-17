#!/usr/bin/env bash
# Install the Claude2GrokBot skill for Claude:
#   curl -fsSL https://raw.githubusercontent.com/Parsiffall1/Claude2GrokBot/main/install.sh | bash
# Installs to ~/.claude/skills/claude2grokbot (override with CLAUDE_SKILLS_DIR); re-running updates it in place.
# Without Node.js 20+, installs the official Node.js build to ~/.local/share/claude2grokbot/node (no sudo, no shell
# config changes; scripts/setup.sh picks it up). Settings and keys live in ~/.config/claude2grokbot and are not touched.
set -euo pipefail

ZIP_URL="${CLAUDE2GROKBOT_ZIP:-https://github.com/Parsiffall1/Claude2GrokBot/releases/latest/download/claude2grokbot-skill.zip}"
SKILLS_DIR="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
DEST="$SKILLS_DIR/claude2grokbot"
NODE_DIR="$HOME/.local/share/claude2grokbot/node"
NODE_DIST="https://nodejs.org/dist/latest-v22.x"

die() { echo "claude2grokbot: $*" >&2; exit 1; }
for c in curl unzip tar; do command -v "$c" >/dev/null || die "$c is required"; done

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

node_ok() { command -v node >/dev/null && node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)'; }
if ! node_ok && [[ ! -x "$NODE_DIR/bin/node" ]]; then
  case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) die "unsupported system $(uname -s); use macOS, Linux or WSL" ;; esac
  case "$(uname -m)" in x86_64 | amd64) arch=x64 ;; arm64 | aarch64) arch=arm64 ;; *) die "unsupported CPU $(uname -m)" ;; esac
  echo "Installing Node.js to $NODE_DIR ..."
  curl -fsSL "$NODE_DIST/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
  line="$(grep -E " node-v[0-9.]+-$os-$arch\.tar\.gz$" "$TMP/SHASUMS256.txt" | head -1)"
  [[ -n "$line" ]] || die "no Node.js build for $os-$arch"
  file="${line##* }"
  curl -fsSL "$NODE_DIST/$file" -o "$TMP/$file"
  if command -v shasum >/dev/null; then check=(shasum -a 256 -c -s); else check=(sha256sum -c --status); fi
  (cd "$TMP" && "${check[@]}" <<<"$line") || die "Node.js download failed its checksum"
  mkdir -p "$NODE_DIR"
  tar -xzf "$TMP/$file" -C "$NODE_DIR" --strip-components 1
  echo "Node.js $("$NODE_DIR/bin/node" -v) installed."
fi

curl -fsSL "$ZIP_URL" -o "$TMP/skill.zip"
unzip -q "$TMP/skill.zip" -d "$TMP"
[[ -f "$TMP/claude2grokbot/SKILL.md" ]] || die "unexpected archive layout"

mkdir -p "$SKILLS_DIR"
[[ -d "$DEST/node_modules" ]] && mv "$DEST/node_modules" "$TMP/claude2grokbot/node_modules"
rm -rf "$DEST"
mv "$TMP/claude2grokbot" "$DEST"

echo "Installed: $DEST/SKILL.md"
echo "Next: read $DEST/SKILL.md and follow its Setup section."

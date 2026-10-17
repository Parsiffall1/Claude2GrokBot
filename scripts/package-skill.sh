#!/usr/bin/env bash
# Build dist/claude2grokbot-skill.zip: one folder with SKILL.md at its root and everything setup needs next to it.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist"; STAGE="$(mktemp -d)/claude2grokbot"
mkdir -p "$STAGE" "$OUT"
cd "$ROOT"
git ls-files | grep -vE '^(skills/|test/|\.github/|bunfig\.toml$)' | while read -r f; do
  mkdir -p "$STAGE/$(dirname "$f")"; cp -p "$f" "$STAGE/$f"
done
cp skills/claude2grokbot/SKILL.md "$STAGE/SKILL.md"
rm -f "$OUT/claude2grokbot-skill.zip"
(cd "$(dirname "$STAGE")" && zip -qrX "$OUT/claude2grokbot-skill.zip" claude2grokbot)
rm -rf "$(dirname "$STAGE")"
echo "$OUT/claude2grokbot-skill.zip"

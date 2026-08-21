#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_SOURCE="$REPO_DIR/bin/mokku.mjs"
SKILL_SOURCE="$REPO_DIR/skill/mock-network"
SKILLS_DIR="$HOME/.claude/skills"

chmod +x "$CLI_SOURCE"

if [ -w /usr/local/bin ]; then
  BIN_DIR="/usr/local/bin"
else
  BIN_DIR="$HOME/.local/bin"
  mkdir -p "$BIN_DIR"
fi

ln -sfn "$CLI_SOURCE" "$BIN_DIR/mokku"
echo "CLI instalado en $BIN_DIR/mokku"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "AVISO: $BIN_DIR no está en tu PATH. Añade: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

mkdir -p "$SKILLS_DIR"
ln -sfn "$SKILL_SOURCE" "$SKILLS_DIR/mock-network"
echo "Skill instalada en $SKILLS_DIR/mock-network"

echo "Listo. Prueba: mokku project list"

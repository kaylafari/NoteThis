#!/bin/zsh
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  if [ -s "$HOME/.nvm/nvm.sh" ]; then source "$HOME/.nvm/nvm.sh"; fi
fi
if [ ! -d "release/mac-arm64/NoteThis.app" ]; then
  npm run build || exit 1
fi
node scripts/launch.mjs --packaged

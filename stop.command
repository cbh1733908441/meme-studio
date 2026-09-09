#!/bin/zsh
cd "${0:A:h}" || exit 1
if ! command -v node >/dev/null 2>&1; then
  for runtime in "$HOME"/.nvm/versions/node/*/bin; do
    [[ -x "$runtime/node" ]] && export PATH="$runtime:$PATH"
  done
fi
node scripts/local-server.mjs stop

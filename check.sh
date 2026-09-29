#!/usr/bin/env bash
# Typecheck di pi-anti-amnesia contro i tipi globali dell'installazione Pi.
# I tipi (@earendil-works/pi-coding-agent, typebox) sono risolti via `paths`
# in tsconfig.check.json, quindi non serve un node_modules locale.
set -euo pipefail
cd "$(dirname "$0")"

TSC="${TSC:-}"
if [ -z "$TSC" ]; then
  if command -v tsc >/dev/null 2>&1; then
    TSC="$(command -v tsc)"
  else
    for c in \
      /home/riccardo/PiAgent/plugins/*/node_modules/.bin/tsc \
      /home/riccardo/.hermes/node/lib/node_modules/typescript/bin/tsc; do
      if [ -x "$c" ]; then TSC="$c"; break; fi
    done
  fi
fi

if [ -z "$TSC" ] || [ ! -x "$TSC" ]; then
  echo "tsc non trovato. Imposta TSC=/percorso/tsc oppure installa typescript." >&2
  exit 1
fi

"$TSC" -p tsconfig.check.json "$@"
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v
node --test tests/topic-scope.test.mjs tests/extension-flow.test.mjs

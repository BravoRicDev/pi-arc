#!/usr/bin/env bash
# Typecheck + smoke load for pi-arc.
# The Pi types (@earendil-works/pi-coding-agent, typebox) are resolved through
# the `paths` mapping in tsconfig.json, so no local node_modules is needed.
set -euo pipefail
cd "$(dirname "$0")"

TSC="${TSC:-}"
if [ -z "$TSC" ]; then
  if command -v tsc >/dev/null 2>&1; then
    TSC="$(command -v tsc)"
  else
    for c in \
      /home/riccardo/.hermes/lsp/node_modules/typescript/bin/tsc \
      /home/riccardo/PiAgent/plugins/*/node_modules/.bin/tsc \
      /home/riccardo/.hermes/node/lib/node_modules/typescript/bin/tsc; do
      if [ -x "$c" ]; then TSC="$c"; break; fi
    done
  fi
fi

if [ -z "$TSC" ] || [ ! -x "$TSC" ]; then
  echo "tsc not found. Set TSC=/path/to/tsc or install typescript." >&2
  exit 1
fi

"$TSC" -p tsconfig.check.json "$@"

# Loads the REAL module. The typecheck cannot see a runtime failure during
# module evaluation (a temporal dead zone, an uninitialised binding, a broken
# import), and such a failure kills the extension silently: no tools
# registered, no message to the user, and a green typecheck.
node --test tests/smoke-load.test.mjs
